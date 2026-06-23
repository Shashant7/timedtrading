// worker/discovery/news-tracker.js
//
// 2026-05-28 — Discovery Phase 2: per-ticker news ingest + sentiment scoring.
//
// Data flow:
//   Cron → fetchAndStoreNewsForTickers(env, tickers)
//     → Finnhub /company-news?symbol=…&from=&to= per ticker
//     → D1 INSERT OR IGNORE into ticker_news (UNIQUE on ticker+url)
//   Cron → scoreUnscoredNews(env)
//     → Pull unscored rows (sentiment IS NULL)
//     → Batch 20 headlines per gpt-4o-mini call → JSON sentiment + catalyst
//     → UPDATE rows with sentiment / catalyst_strength / scored_at
//   CIO eval cycle → loadRecentNewsSummary(env, sym)
//
// headlineMentionsTicker — filter cross-ticker pollution (Finnhub sector
// articles stored under wrong symbols). Same idea as publicationMentionsTicker
// in worker/cro/fsd-ingestion.js.
//     → returns compact summary for memory L14
//   Promotion Queue → loadRecentNewsSummary(env, sym)
//     → contributes NEWS_CATALYST scoring component

const FINNHUB_BASE = "https://finnhub.io/api/v1";
const SENTIMENT_MODEL_FALLBACK = "gpt-4o-mini";
const SENTIMENT_BATCH_SIZE = 20;

/** True when headline/summary text plausibly references the ticker symbol. */
export function headlineMentionsTicker(headline, summary, ticker) {
  const sym = String(ticker || "").toUpperCase().trim();
  if (!sym) return false;
  const blob = `${headline || ""}\n${summary || ""}`;
  if (!blob.trim()) return false;
  const re = new RegExp(`(?:\\$${sym}\\b|\\(${sym}\\)|\\b${sym}\\b)`, "i");
  return re.test(blob);
}
const SENTIMENT_TIMEOUT_MS = 30000;

const SENTIMENT_SYSTEM_PROMPT = `You are a financial-news sentiment + catalyst classifier. For each headline, return:

1. sentiment: "bullish" | "bearish" | "neutral" — strict trader interpretation of the headline alone
2. catalyst_strength: 0-10 integer — how much this single headline alone could move the stock
   - 10 = blockbuster (M&A announcement, FDA approval, major contract win, 100% guidance raise)
   - 7-9 = strong catalyst (earnings beat with raise, large institutional fund disclosure, key product launch)
   - 4-6 = moderate (analyst upgrade with PT raise, partnership announcement)
   - 1-3 = minor (routine analyst note, minor product update)
   - 0 = pure noise / repetition / generic market commentary
3. is_catalyst: boolean — true ONLY when this is a discrete event-driven catalyst, not generic news

You MUST respond with valid JSON only. Output exactly:
{
  "scores": [
    { "id": "h0", "sentiment": "...", "catalyst_strength": N, "is_catalyst": bool },
    ...
  ]
}

Order MUST match input order. Use the id field provided.`;

export async function ensureTickerNewsSchema(env) {
  const db = env?.DB;
  if (!db) return;
  try {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS ticker_news (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticker TEXT NOT NULL,
        headline TEXT NOT NULL,
        source TEXT,
        url TEXT NOT NULL,
        summary TEXT,
        datetime_utc TEXT,
        sentiment TEXT,
        catalyst_strength INTEGER,
        is_catalyst INTEGER,
        scored_at INTEGER,
        scored_by TEXT,
        created_at INTEGER,
        UNIQUE(ticker, url)
      )
    `).run();
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_news_ticker_date ON ticker_news (ticker, datetime_utc DESC)`).run();
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_news_unscored ON ticker_news (sentiment, created_at DESC) WHERE sentiment IS NULL`).run();
  } catch (e) {
    console.warn("[NEWS] schema ensure failed:", String(e?.message || e).slice(0, 200));
  }
}

async function fetchNewsForTicker(env, ticker, opts = {}) {
  const token = env?.FINNHUB_API_KEY;
  if (!token) return { ok: false, error: "no_finnhub_api_key" };
  const lookbackDays = Math.max(1, Math.min(30, Number(opts.lookbackDays) || 5));
  const to = new Date();
  const from = new Date(Date.now() - lookbackDays * 86400000);
  const fromStr = from.toISOString().slice(0, 10);
  const toStr = to.toISOString().slice(0, 10);
  const url = `${FINNHUB_BASE}/company-news?symbol=${encodeURIComponent(ticker)}&from=${fromStr}&to=${toStr}&token=${token}`;
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!resp.ok) {
      return { ok: false, error: `finnhub_${resp.status}`, ticker };
    }
    const json = await resp.json();
    const rows = Array.isArray(json) ? json : [];
    return { ok: true, ticker, rows };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 200), ticker };
  }
}

export async function fetchAndStoreNewsForTickers(env, tickers, opts = {}) {
  if (!Array.isArray(tickers) || tickers.length === 0) {
    return { ok: false, error: "tickers_required" };
  }
  await ensureTickerNewsSchema(env);
  const db = env?.DB;
  if (!db) return { ok: false, error: "no_db" };
  const throttleMs = Math.max(0, Number(opts.throttleMs) || 1100);
  const lookbackDays = Math.max(1, Math.min(30, Number(opts.lookbackDays) || 5));
  const maxPerTicker = Math.max(1, Math.min(50, Number(opts.maxPerTicker) || 15));
  let upserted = 0, errors = 0;
  const perTicker = {};
  const now = Date.now();
  for (let i = 0; i < tickers.length; i++) {
    const t = String(tickers[i] || "").toUpperCase();
    if (!t) continue;
    const r = await fetchNewsForTicker(env, t, { lookbackDays });
    if (!r.ok) {
      errors++;
      perTicker[t] = { error: r.error };
      if (i + 1 < tickers.length) await new Promise(r => setTimeout(r, throttleMs));
      continue;
    }
    let tickerUpserted = 0;
    // Sort newest-first, cap.
    const rows = r.rows
      .slice()
      .sort((a, b) => Number(b.datetime || 0) - Number(a.datetime || 0))
      .slice(0, maxPerTicker);
    for (const row of rows) {
      const headline = String(row.headline || "").trim().slice(0, 500);
      const url = String(row.url || "").trim().slice(0, 1000);
      if (!headline || !url) continue;
      const source = String(row.source || "").slice(0, 100);
      const summary = String(row.summary || "").slice(0, 1500);
      const dtMs = Number(row.datetime) > 0 ? Number(row.datetime) * 1000 : null;
      const dtIso = dtMs ? new Date(dtMs).toISOString() : null;
      try {
        await db.prepare(`
          INSERT OR IGNORE INTO ticker_news
            (ticker, headline, source, url, summary, datetime_utc,
             sentiment, catalyst_strength, is_catalyst, scored_at, scored_by, created_at)
          VALUES (?1,?2,?3,?4,?5,?6, NULL,NULL,NULL,NULL,NULL,?7)
        `).bind(t, headline, source, url, summary, dtIso, now).run();
        tickerUpserted++;
      } catch (_) {
        // UNIQUE collision
      }
    }
    upserted += tickerUpserted;
    perTicker[t] = { fetched: rows.length, upserted: tickerUpserted };
    if (i + 1 < tickers.length) await new Promise(r => setTimeout(r, throttleMs));
  }
  return { ok: true, tickers: tickers.length, upserted, errors, per_ticker: perTicker };
}

// Pull unscored rows, batch-score via gpt-4o-mini, UPDATE rows.
export async function scoreUnscoredNews(env, opts = {}) {
  const db = env?.DB;
  if (!db) return { ok: false, error: "no_db" };
  const apiKey = env?.OPENAI_API_KEY;
  if (!apiKey) return { ok: false, error: "no_openai_api_key" };
  const limit = Math.max(1, Math.min(500, Number(opts.limit) || 100));
  const model = String(opts.model || env?.AI_NEWS_SENTIMENT_MODEL || SENTIMENT_MODEL_FALLBACK);
  await ensureTickerNewsSchema(env);

  const rows = (await db.prepare(`
    SELECT id, ticker, headline, source, summary FROM ticker_news
     WHERE sentiment IS NULL
     ORDER BY created_at DESC
     LIMIT ?1
  `).bind(limit).all().catch(() => ({ results: [] })))?.results || [];
  if (rows.length === 0) {
    return { ok: true, scored: 0, message: "no_unscored_rows" };
  }

  let totalScored = 0, batches = 0;
  for (let i = 0; i < rows.length; i += SENTIMENT_BATCH_SIZE) {
    const batch = rows.slice(i, i + SENTIMENT_BATCH_SIZE);
    const userText = batch.map((r, idx) => {
      const id = `h${idx}`;
      const txt = `${id} [${r.ticker}] ${r.headline}${r.summary ? " — " + String(r.summary).slice(0, 200) : ""}`;
      return txt;
    }).join("\n");
    try {
      const isGpt5 = String(model || "").toLowerCase().startsWith("gpt-5");
      const body = {
        model,
        messages: [
          { role: "system", content: SENTIMENT_SYSTEM_PROMPT },
          { role: "user", content: `Score these ${batch.length} headlines:\n\n${userText}` },
        ],
        max_completion_tokens: 800,
        response_format: { type: "json_object" },
      };
      if (!isGpt5) body.temperature = 0.0;
      const resp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(SENTIMENT_TIMEOUT_MS),
      });
      if (!resp.ok) {
        console.warn(`[NEWS_SCORE] OpenAI ${resp.status} batch ${batches}`);
        batches++;
        continue;
      }
      const json = await resp.json();
      const raw = json.choices?.[0]?.message?.content || "";
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch (_) { /* invalid */ }
      const scores = Array.isArray(parsed?.scores) ? parsed.scores : [];
      // Map by id back to batch rows.
      const scoreById = {};
      for (const s of scores) {
        if (s?.id) scoreById[s.id] = s;
      }
      const scoredAt = Date.now();
      for (let j = 0; j < batch.length; j++) {
        const s = scoreById[`h${j}`];
        if (!s) continue;
        const sentiment = ["bullish", "bearish", "neutral"].includes(String(s.sentiment).toLowerCase())
          ? String(s.sentiment).toLowerCase() : "neutral";
        const cs = Math.max(0, Math.min(10, Math.round(Number(s.catalyst_strength) || 0)));
        const ic = s.is_catalyst === true ? 1 : 0;
        try {
          await db.prepare(`
            UPDATE ticker_news
               SET sentiment = ?2, catalyst_strength = ?3, is_catalyst = ?4,
                   scored_at = ?5, scored_by = ?6
             WHERE id = ?1
          `).bind(batch[j].id, sentiment, cs, ic, scoredAt, model).run();
          totalScored++;
        } catch (_) {}
      }
    } catch (e) {
      console.warn(`[NEWS_SCORE] Batch ${batches} failed:`, String(e?.message || e).slice(0, 150));
    }
    batches++;
  }
  return { ok: true, scored: totalScored, rows: rows.length, batches };
}

// Compact summary for CIO memory L14 + Promotion Queue NEWS_CATALYST.
export async function loadRecentNewsSummary(env, ticker, opts = {}) {
  const db = env?.DB;
  const sym = String(ticker || "").toUpperCase();
  if (!db || !sym) return null;
  const lookbackDays = Math.max(1, Math.min(30, Number(opts.lookbackDays) || 5));
  try {
    const cutoffIso = new Date(Date.now() - lookbackDays * 86400000).toISOString();
    const rows = (await db.prepare(`
      SELECT headline, source, url, datetime_utc, sentiment, catalyst_strength, is_catalyst
        FROM ticker_news
       WHERE ticker = ?1 AND datetime_utc >= ?2
       ORDER BY datetime_utc DESC
       LIMIT 25
    `).bind(sym, cutoffIso).all().catch(() => ({ results: [] })))?.results || [];
    const filtered = rows.filter((r) => headlineMentionsTicker(r.headline, null, sym));
    if (filtered.length === 0) {
      return { ticker: sym, has_data: false, count: 0, filtered_out: rows.length };
    }
    // Aggregate.
    let bull = 0, bear = 0, neutral = 0, unscored = 0;
    let topCatalyst = null;
    let bullishCatalystCount = 0;
    let bearishCatalystCount = 0;
    for (const r of filtered) {
      const sent = r.sentiment || null;
      const cs = Number(r.catalyst_strength) || 0;
      const ic = r.is_catalyst === 1;
      if (sent === "bullish") bull++;
      else if (sent === "bearish") bear++;
      else if (sent === "neutral") neutral++;
      else unscored++;
      if (ic && (!topCatalyst || cs > topCatalyst.catalyst_strength)) {
        topCatalyst = {
          headline: r.headline,
          source: r.source,
          datetime: r.datetime_utc,
          sentiment: sent,
          catalyst_strength: cs,
        };
      }
      if (ic && sent === "bullish") bullishCatalystCount++;
      if (ic && sent === "bearish") bearishCatalystCount++;
    }
    const dominant = (bull > bear && bull > neutral) ? "bullish"
                   : (bear > bull && bear > neutral) ? "bearish"
                   : "neutral";
    return {
      ticker: sym,
      has_data: true,
      lookback_days: lookbackDays,
      count: filtered.length,
      bull, bear, neutral, unscored,
      dominant_sentiment: dominant,
      bullish_catalyst_count: bullishCatalystCount,
      bearish_catalyst_count: bearishCatalystCount,
      top_catalyst: topCatalyst,
      latest_3: filtered.slice(0, 3).map((r) => ({
        headline: r.headline,
        source: r.source,
        sentiment: r.sentiment,
        catalyst_strength: r.catalyst_strength,
        datetime: r.datetime_utc,
      })),
    };
  } catch (e) {
    console.warn(`[NEWS] loadRecentNewsSummary failed for ${sym}:`, String(e?.message || e).slice(0, 150));
    return null;
  }
}

// Batch load for promotion queue scoring.
export async function loadNewsSummariesBatch(env, tickers, opts = {}) {
  const db = env?.DB;
  if (!db || !Array.isArray(tickers) || tickers.length === 0) return {};
  const lookbackDays = Math.max(1, Math.min(30, Number(opts.lookbackDays) || 5));
  const cutoffIso = new Date(Date.now() - lookbackDays * 86400000).toISOString();
  const symSet = new Set(tickers.map((t) => String(t || "").toUpperCase()).filter(Boolean));
  try {
    const rows = (await db.prepare(`
      SELECT ticker, sentiment, catalyst_strength, is_catalyst, headline, datetime_utc
        FROM ticker_news
       WHERE datetime_utc >= ?1
       ORDER BY datetime_utc DESC
       LIMIT 5000
    `).bind(cutoffIso).all().catch(() => ({ results: [] })))?.results || [];
    const out = {};
    for (const t of symSet) out[t] = { ticker: t, count: 0, bull: 0, bear: 0, max_catalyst: 0, bullish_catalyst_count: 0, top_catalyst_headline: null };
    for (const r of rows) {
      const t = String(r.ticker || "").toUpperCase();
      if (!symSet.has(t)) continue;
      if (!headlineMentionsTicker(r.headline, null, t)) continue;
      out[t].count++;
      const cs = Number(r.catalyst_strength) || 0;
      const ic = r.is_catalyst === 1;
      if (r.sentiment === "bullish") out[t].bull++;
      if (r.sentiment === "bearish") out[t].bear++;
      if (ic && r.sentiment === "bullish") out[t].bullish_catalyst_count++;
      if (ic && cs > out[t].max_catalyst) {
        out[t].max_catalyst = cs;
        out[t].top_catalyst_headline = String(r.headline || "").slice(0, 200);
      }
    }
    for (const t of Object.keys(out)) {
      if (out[t].count === 0) delete out[t];
    }
    return out;
  } catch (e) {
    console.warn("[NEWS] loadNewsSummariesBatch failed:", String(e?.message || e).slice(0, 150));
    return {};
  }
}
