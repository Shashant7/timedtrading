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
// PHASE 2 (deferred): Reddit (r/wallstreetbets, r/stocks, r/investing)
//   mention counter via pullpush.io / Pushshift mirror.
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
const FETCH_TIMEOUT_MS = 6_000;
const PER_TICKER_LIMIT = 30; // most recent N messages — ample for sentiment ratio

// Ensure schema. Cheap idempotent CREATE.
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

// Batch load social summaries for the promotion-queue scorer. Mirrors
// loadNewsSummariesBatch in news-tracker.js. Returns object keyed by ticker.
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
    };
  }
  try {
    const rows = (await db.prepare(`
      SELECT ticker, snapshot_date, watchlist_count, message_count,
             bullish_count, bearish_count, bull_ratio_pct,
             top_post_body, top_post_user, top_post_url, fetched_at
        FROM ticker_social
       WHERE source = 'stocktwits' AND snapshot_date >= ?1
       ORDER BY snapshot_date DESC, fetched_at DESC
       LIMIT 5000
    `).bind(cutoffDate).all().catch(() => ({ results: [] })))?.results || [];
    // Keep only the most recent snapshot per ticker (rows are pre-sorted).
    const seen = new Set();
    for (const r of rows) {
      const t = String(r.ticker || "").toUpperCase();
      if (!symSet.has(t) || seen.has(t)) continue;
      seen.add(t);
      out[t] = {
        ticker: t,
        has_data: true,
        snapshot_date: r.snapshot_date,
        message_count_24h: Number(r.message_count) || 0,
        bullish_count: Number(r.bullish_count) || 0,
        bearish_count: Number(r.bearish_count) || 0,
        bull_ratio_pct: r.bull_ratio_pct == null ? null : Number(r.bull_ratio_pct),
        watchlist_count: r.watchlist_count == null ? null : Number(r.watchlist_count),
        top_post_body: r.top_post_body,
        top_post_user: r.top_post_user,
        top_post_url: r.top_post_url,
      };
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
