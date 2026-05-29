// worker/discovery/social-tracker.js
//
// 2026-05-29 — Social-buzz signal capture.
//
// User feedback: "SNOW has been getting a lot of mention on X and by other
// traders. Not sure how we factor in a broader reach of news."
//
// Diagnosis — our existing news-tracker.js only ingests Finnhub headlines.
// That misses the entire trader-chatter / X-Twitter / retail-buzz dimension
// where moves often originate hours-to-days before mainstream wire pickup.
// SNOW today: zero Finnhub catalyst → news component = 0 → total score = 3
// → rejected. Meanwhile on StockTwits SNOW shows 14 bullish / 0 bearish
// in the last 30 messages, 57k watchlist count, and active X-Twitter
// crosslinks.
//
// PHASE 1 (this module): StockTwits public stream endpoint. Free, no key,
//   ticker-native, user-tagged Bullish/Bearish flags, message count proxy,
//   watchlist count proxy. Polled per-ticker daily by the discovery cron.
//
// PHASE 2 (this update): Reddit mention counter via apewisdom.io. Reddit
//   killed unauthenticated JSON API access in 2024 and pullpush.io is
//   degraded as of 2026-05. Apewisdom is free, no key, ticker-native,
//   aggregates r/wallstreetbets + r/stocks + r/options + r/investing
//   + r/StockMarket + r/pennystocks, and returns mention count, 24h
//   comparison, rank, and upvote totals in a single batched call
//   (one HTTP per page, ~14 pages = ALL ranked tickers in <2 sec).
//
//   Strongest signal: ratio of current mentions vs 24h-ago mentions.
//   A 3x+ spike on a name like SMCI (today: 118 vs 39) or DELL (411
//   vs 29) is a high-conviction early indicator of trader interest.
//
// PHASE 3 (deferred): X/Twitter via paid TwitterAPI.io or grok-search
//   (~$50-100/mo) once we have evidence Phase 1+2 isn't enough.
//
// PHASE 4 (deferred): OpenAI summarization of broader web search (Brave
//   Search News API) to distill noise → signal.
//
// PERSISTENCE — daily snapshot per ticker in D1 `ticker_social` so the
// promotion-queue scoring + right-rail Catalysts tab can read it without
// re-fetching. Cron runs at 22 UTC (same daily-discovery slot) and the
// 24h cache prevents StockTwits rate-limit issues.

const STOCKTWITS_BASE = "https://api.stocktwits.com/api/2/streams/symbol";
const APEWISDOM_BASE = "https://apewisdom.io/api/v1.0/filter/all-stocks/page";
const APEWISDOM_MAX_PAGES = 20;    // covers ~1000 tickers (50/page)
const FETCH_TIMEOUT_MS = 6_000;
const PER_TICKER_LIMIT = 30; // most recent N messages — ample for sentiment ratio

// Ensure schema. Cheap idempotent CREATE. Adds reddit-specific columns
// via ALTER TABLE for backward compat with pre-Phase-2 rows.
export async function ensureSocialSchema(env) {
  const db = env?.DB;
  if (!db) return;
  try {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS ticker_social (
        ticker             TEXT NOT NULL,
        source             TEXT NOT NULL,
        snapshot_date      TEXT NOT NULL,
        watchlist_count    INTEGER,
        message_count      INTEGER,
        bullish_count      INTEGER,
        bearish_count      INTEGER,
        bull_ratio_pct     INTEGER,
        top_post_body      TEXT,
        top_post_user      TEXT,
        top_post_url       TEXT,
        raw_summary_json   TEXT,
        fetched_at         INTEGER NOT NULL,
        PRIMARY KEY (ticker, source, snapshot_date)
      )
    `).run();
    await db.prepare(
      `CREATE INDEX IF NOT EXISTS idx_social_ticker_date ON ticker_social (ticker, snapshot_date DESC)`,
    ).run();
    // 2026-05-29 — Reddit-specific columns added in Phase 2. ALTER TABLE
    // ADD COLUMN is idempotent-safe via try/catch since SQLite throws on
    // duplicate. Safe to run on every cron tick.
    for (const col of [
      "reddit_rank          INTEGER",
      "reddit_mentions_24h  INTEGER",
      "reddit_mentions_prev INTEGER",
      "reddit_upvotes_24h   INTEGER",
      "reddit_spike_ratio   REAL",
    ]) {
      try { await db.prepare(`ALTER TABLE ticker_social ADD COLUMN ${col}`).run(); } catch (_) { /* exists */ }
    }
  } catch (e) {
    console.warn("[SOCIAL] schema ensure failed:", String(e?.message || e).slice(0, 200));
  }
}

// Single-ticker fetch from StockTwits. Returns null on any failure (network,
// 429, parse) so the batch caller can continue gracefully.
async function fetchStocktwits(sym) {
  const url = `${STOCKTWITS_BASE}/${encodeURIComponent(sym)}.json?limit=${PER_TICKER_LIMIT}`;
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      signal: controller.signal,
      headers: {
        // StockTwits' API rate-limits aggressive bots harder than browser
        // UAs. Match Chrome to stay under the radar.
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/json",
      },
    });
    if (!r.ok) return null;
    const data = await r.json().catch(() => null);
    if (!data || !Array.isArray(data?.messages)) return null;
    return data;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(tid);
  }
}

// Parse one StockTwits response into a structured snapshot row.
function parseStocktwitsSnapshot(sym, data) {
  const symMeta = data?.symbol || {};
  const messages = Array.isArray(data?.messages) ? data.messages : [];
  let bull = 0, bear = 0;
  let topMsg = null;
  for (const m of messages) {
    const sent = ((m?.entities || {}).sentiment || {}).basic;
    if (sent === "Bullish") bull++;
    else if (sent === "Bearish") bear++;
    if (!topMsg && sent === "Bullish") topMsg = m; // first bullish for snippet
  }
  // Fallback: first message of any kind.
  if (!topMsg && messages.length > 0) topMsg = messages[0];
  const tagged = bull + bear;
  const bullRatioPct = tagged > 0 ? Math.round((bull / tagged) * 100) : null;
  return {
    ticker: String(sym).toUpperCase(),
    source: "stocktwits",
    snapshot_date: new Date().toISOString().slice(0, 10),
    watchlist_count: Number(symMeta.watchlist_count) || null,
    message_count: messages.length,
    bullish_count: bull,
    bearish_count: bear,
    bull_ratio_pct: bullRatioPct,
    top_post_body: topMsg ? String(topMsg.body || "").slice(0, 280) : null,
    top_post_user: topMsg ? String(topMsg.user?.username || "") : null,
    top_post_url: topMsg ? `https://stocktwits.com/${topMsg.user?.username || ""}/message/${topMsg.id || ""}` : null,
    raw_summary_json: JSON.stringify({
      tagged_count: tagged,
      sample_message_ids: messages.slice(0, 5).map((m) => m.id).filter(Boolean),
    }),
    fetched_at: Date.now(),
  };
}

// Persist one snapshot. INSERT OR REPLACE keyed by (ticker, source, date).
async function persistSnapshot(env, snap) {
  const db = env?.DB;
  if (!db || !snap) return false;
  try {
    await db.prepare(`
      INSERT OR REPLACE INTO ticker_social
        (ticker, source, snapshot_date, watchlist_count, message_count,
         bullish_count, bearish_count, bull_ratio_pct, top_post_body,
         top_post_user, top_post_url, raw_summary_json, fetched_at)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)
    `).bind(
      snap.ticker, snap.source, snap.snapshot_date,
      snap.watchlist_count, snap.message_count,
      snap.bullish_count, snap.bearish_count, snap.bull_ratio_pct,
      snap.top_post_body, snap.top_post_user, snap.top_post_url,
      snap.raw_summary_json, snap.fetched_at,
    ).run();
    return true;
  } catch (e) {
    console.warn(`[SOCIAL] persist failed for ${snap.ticker}:`, String(e?.message || e).slice(0, 200));
    return false;
  }
}

// ── Reddit (Apewisdom Phase 2) ────────────────────────────────────────────
// Fetches ALL ranked Reddit tickers via Apewisdom in a single bulk
// crawl (~14-20 pages, ~50 tickers each). Returns a map keyed by ticker
// symbol. Designed to be called once per cron tick — no per-ticker
// fetches needed, much friendlier on rate limits than per-symbol APIs.
async function fetchAllRedditMentions(opts = {}) {
  const maxPages = Math.max(1, Math.min(40, Number(opts.maxPages) || APEWISDOM_MAX_PAGES));
  const interPageDelayMs = Math.max(0, Number(opts.pageDelayMs) || 200);
  const byTicker = {};
  let totalPagesFetched = 0;
  for (let page = 1; page <= maxPages; page++) {
    const url = `${APEWISDOM_BASE}/${page}`;
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let data = null;
    try {
      const r = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "application/json",
        },
      });
      if (r.ok) data = await r.json().catch(() => null);
    } catch (_) {
      // best-effort; continue with the pages we got
    } finally {
      clearTimeout(tid);
    }
    if (!data || !Array.isArray(data.results)) break;
    totalPagesFetched++;
    for (const row of data.results) {
      const sym = String(row.ticker || "").toUpperCase();
      if (!sym) continue;
      const m24 = Number(row.mentions) || 0;
      const mPrev = Number(row.mentions_24h_ago) || 0;
      const spike = mPrev > 0 ? m24 / mPrev : (m24 > 0 ? 999 : null);
      byTicker[sym] = {
        ticker: sym,
        rank: Number(row.rank) || null,
        rank_24h_ago: Number(row.rank_24h_ago) || null,
        mentions_24h: m24,
        mentions_prev: mPrev,
        upvotes_24h: Number(row.upvotes) || 0,
        spike_ratio: spike,
        name: row.name || null,
      };
    }
    const totalPages = Number(data.pages) || 1;
    if (page >= totalPages) break;
    if (interPageDelayMs > 0 && page < maxPages) {
      await new Promise((res) => setTimeout(res, interPageDelayMs));
    }
  }
  return { byTicker, totalPagesFetched };
}

// Persist one Reddit snapshot row for a ticker. Same source='reddit'
// in the unified ticker_social table — keeps the schema source-agnostic
// so the right rail / promotion-queue scorer can read either.
async function persistRedditSnapshot(env, sym, row) {
  const db = env?.DB;
  if (!db || !row) return false;
  const snap = {
    ticker: sym,
    source: "reddit",
    snapshot_date: new Date().toISOString().slice(0, 10),
    message_count: row.mentions_24h,
    raw_summary_json: JSON.stringify({
      apewisdom_rank: row.rank,
      rank_24h_ago: row.rank_24h_ago,
      mentions_prev: row.mentions_prev,
      name: row.name,
    }),
    fetched_at: Date.now(),
  };
  try {
    await db.prepare(`
      INSERT OR REPLACE INTO ticker_social
        (ticker, source, snapshot_date, message_count, raw_summary_json, fetched_at,
         reddit_rank, reddit_mentions_24h, reddit_mentions_prev, reddit_upvotes_24h, reddit_spike_ratio)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)
    `).bind(
      snap.ticker, snap.source, snap.snapshot_date,
      snap.message_count, snap.raw_summary_json, snap.fetched_at,
      row.rank,
      row.mentions_24h,
      row.mentions_prev,
      row.upvotes_24h,
      row.spike_ratio,
    ).run();
    return true;
  } catch (e) {
    console.warn(`[SOCIAL/REDDIT] persist failed for ${sym}:`, String(e?.message || e).slice(0, 200));
    return false;
  }
}

// Main entry point for Reddit. Pulls Apewisdom bulk + writes snapshots
// for the tickers we care about (open positions + screener) AND for
// any ticker whose 24h spike ratio is >= 2x (early-discovery signal,
// even if the ticker isn't in our screener yet).
export async function fetchRedditDataForTickers(env, tickers, opts = {}) {
  await ensureSocialSchema(env);
  const symSet = new Set((tickers || []).map((t) => String(t || "").toUpperCase()).filter(Boolean));
  const { byTicker, totalPagesFetched } = await fetchAllRedditMentions(opts);
  let persisted = 0;
  const spikes = [];
  for (const [sym, row] of Object.entries(byTicker)) {
    const isInteresting = symSet.has(sym)
      || (row.spike_ratio != null && row.spike_ratio >= 2 && row.mentions_24h >= 25)
      || (row.rank != null && row.rank <= 25);
    if (!isInteresting) continue;
    if (await persistRedditSnapshot(env, sym, row)) persisted++;
    if (row.spike_ratio != null && row.spike_ratio >= 2 && row.mentions_24h >= 25) {
      spikes.push({ ticker: sym, mentions: row.mentions_24h, spike: Math.round(row.spike_ratio * 10) / 10 });
    }
  }
  spikes.sort((a, b) => b.spike - a.spike);
  return {
    ok: true,
    source: "reddit",
    pages_fetched: totalPagesFetched,
    tickers_seen: Object.keys(byTicker).length,
    persisted,
    spikes_top10: spikes.slice(0, 10),
    fetched_at: Date.now(),
  };
}

// Main entry point. Pulls StockTwits for each ticker with a polite delay
// to avoid 429s. Designed to run from a cron job.
export async function fetchSocialDataForTickers(env, tickers, opts = {}) {
  await ensureSocialSchema(env);
  if (!Array.isArray(tickers) || tickers.length === 0) {
    return { ok: true, attempted: 0, fetched: 0, persisted: 0 };
  }
  const interTickerDelayMs = Math.max(0, Number(opts.delayMs) || 150);
  const maxTickers = Math.min(tickers.length, Number(opts.max) || 500);
  let fetched = 0, persisted = 0, errors = 0;
  for (let i = 0; i < maxTickers; i++) {
    const sym = String(tickers[i] || "").toUpperCase();
    if (!sym) continue;
    const data = await fetchStocktwits(sym);
    if (!data) { errors++; continue; }
    fetched++;
    const snap = parseStocktwitsSnapshot(sym, data);
    if (await persistSnapshot(env, snap)) persisted++;
    if (interTickerDelayMs > 0 && i < maxTickers - 1) {
      await new Promise((res) => setTimeout(res, interTickerDelayMs));
    }
  }
  return {
    ok: true,
    attempted: maxTickers,
    fetched,
    persisted,
    errors,
    source: "stocktwits",
    fetched_at: Date.now(),
  };
}

// Batch load social summaries for the promotion-queue scorer.
//
// 2026-05-29 Phase 2 — merges StockTwits + Reddit (Apewisdom) into one
// summary per ticker. Reddit fields nest under `reddit` so the scorer
// can weight them independently. has_data is true if EITHER source has
// a fresh snapshot.
export async function loadSocialSummariesBatch(env, tickers, opts = {}) {
  const db = env?.DB;
  if (!db || !Array.isArray(tickers) || tickers.length === 0) return {};
  const lookbackDays = Math.max(1, Math.min(7, Number(opts.lookbackDays) || 3));
  const cutoffDate = new Date(Date.now() - lookbackDays * 86400000).toISOString().slice(0, 10);
  const symSet = new Set(tickers.map((t) => String(t || "").toUpperCase()).filter(Boolean));
  const out = {};
  for (const t of symSet) {
    out[t] = {
      ticker: t,
      has_data: false,
      message_count_24h: 0,
      bullish_count: 0,
      bearish_count: 0,
      bull_ratio_pct: null,
      watchlist_count: null,
      top_post_body: null,
      top_post_user: null,
      top_post_url: null,
      reddit: null,
    };
  }
  try {
    const rows = (await db.prepare(`
      SELECT ticker, source, snapshot_date, watchlist_count, message_count,
             bullish_count, bearish_count, bull_ratio_pct,
             top_post_body, top_post_user, top_post_url,
             reddit_rank, reddit_mentions_24h, reddit_mentions_prev,
             reddit_upvotes_24h, reddit_spike_ratio, fetched_at
        FROM ticker_social
       WHERE source IN ('stocktwits','reddit') AND snapshot_date >= ?1
       ORDER BY snapshot_date DESC, fetched_at DESC
       LIMIT 8000
    `).bind(cutoffDate).all().catch(() => ({ results: [] })))?.results || [];
    // Keep most-recent snapshot per (ticker, source).
    const seen = new Set(); // key: `${ticker}:${source}`
    for (const r of rows) {
      const t = String(r.ticker || "").toUpperCase();
      if (!symSet.has(t)) continue;
      const key = `${t}:${r.source}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (r.source === "stocktwits") {
        out[t] = {
          ...out[t],
          ticker: t,
          has_data: true,
          stocktwits_snapshot_date: r.snapshot_date,
          message_count_24h: Number(r.message_count) || 0,
          bullish_count: Number(r.bullish_count) || 0,
          bearish_count: Number(r.bearish_count) || 0,
          bull_ratio_pct: r.bull_ratio_pct == null ? null : Number(r.bull_ratio_pct),
          watchlist_count: r.watchlist_count == null ? null : Number(r.watchlist_count),
          top_post_body: r.top_post_body,
          top_post_user: r.top_post_user,
          top_post_url: r.top_post_url,
        };
      } else if (r.source === "reddit") {
        const m24 = Number(r.reddit_mentions_24h) || 0;
        const mPrev = Number(r.reddit_mentions_prev) || 0;
        const spike = r.reddit_spike_ratio != null
          ? Number(r.reddit_spike_ratio)
          : (mPrev > 0 ? m24 / mPrev : (m24 > 0 ? 999 : null));
        out[t] = {
          ...out[t],
          ticker: t,
          has_data: true,
          reddit: {
            snapshot_date: r.snapshot_date,
            rank: r.reddit_rank == null ? null : Number(r.reddit_rank),
            mentions_24h: m24,
            mentions_prev: mPrev,
            upvotes_24h: Number(r.reddit_upvotes_24h) || 0,
            spike_ratio: spike,
          },
        };
      }
    }
  } catch (e) {
    console.warn("[SOCIAL] loadSocialSummariesBatch failed:", String(e?.message || e).slice(0, 200));
  }
  return out;
}

// Convenience for the per-ticker right-rail Catalysts tab.
export async function loadSocialSummary(env, sym, opts = {}) {
  const map = await loadSocialSummariesBatch(env, [sym], opts);
  return map[String(sym).toUpperCase()] || null;
}
