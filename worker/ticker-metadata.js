// worker/ticker-metadata.js
//
// 2026-05-29 — Ticker metadata hydration (Name / Sector / Industry /
// MCap). Primary source: TwelveData `/profile` and `/quote` (for
// market_cap). Fallback chain handles Alpaca + Finnhub.
//
// User report: "Tickers Page has a lot of tickers missing Name,
// Sector, Industry, MCap. We should easily be able to hydrate these
// values for each ticker and keep them. Minus MCap, the other things
// don't change."
//
// Storage: D1 table `ticker_metadata` (created lazily on first
// hydrate). Read path: GET /timed/admin/ticker-metadata?ticker=SYM
// or batch via /timed/admin/ticker-metadata/all.
//
// Hydration policy:
//   - Static fields (name, sector, industry, country, currency,
//     exchange) — fetched ONCE per ticker, persisted forever.
//   - MCap — refreshed weekly (Sunday at 23 UTC), persisted with
//     timestamp so the UI can show "as of YYYY-MM-DD".

const TD_PROFILE_BASE = "https://api.twelvedata.com/profile";
const TD_STATS_BASE = "https://api.twelvedata.com/statistics";
const FINNHUB_PROFILE_BASE = "https://finnhub.io/api/v1/stock/profile2";

const REQUEST_TIMEOUT_MS = 8_000;

export async function ensureTickerMetadataSchema(env) {
  const db = env?.DB;
  if (!db) return;
  try {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS ticker_metadata (
        ticker          TEXT PRIMARY KEY,
        name            TEXT,
        sector          TEXT,
        industry        TEXT,
        country         TEXT,
        currency        TEXT,
        exchange        TEXT,
        market_cap      REAL,
        shares_out      REAL,
        pe              REAL,
        beta            REAL,
        dividend_yield  REAL,
        source          TEXT,
        fetched_at      INTEGER NOT NULL,
        mcap_fetched_at INTEGER,
        updated_at      INTEGER NOT NULL
      )
    `).run();
    await db.prepare(
      `CREATE INDEX IF NOT EXISTS idx_ticker_metadata_sector ON ticker_metadata (sector)`,
    ).run();
    await db.prepare(
      `CREATE INDEX IF NOT EXISTS idx_ticker_metadata_fetched ON ticker_metadata (fetched_at DESC)`,
    ).run();
  } catch (e) {
    console.warn("[META] schema ensure failed:", String(e?.message || e).slice(0, 200));
  }
}

async function _fetchJson(url, headers = {}) {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: controller.signal, headers });
    if (!r.ok) return null;
    return await r.json().catch(() => null);
  } catch (_) {
    return null;
  } finally { clearTimeout(tid); }
}

// TwelveData /profile — name, sector, industry, country, exchange.
async function fetchTwelvedataProfile(env, ticker) {
  const apiKey = env?.TWELVEDATA_API_KEY;
  if (!apiKey) return null;
  const data = await _fetchJson(
    `${TD_PROFILE_BASE}?symbol=${encodeURIComponent(ticker)}&apikey=${encodeURIComponent(apiKey)}`,
  );
  if (!data || data.status === "error" || data.code) return null;
  return {
    name: data.name || null,
    sector: data.sector || null,
    industry: data.industry || null,
    country: data.country || null,
    currency: data.currency || null,
    exchange: data.exchange || null,
    source: "twelvedata",
  };
}

// TwelveData /statistics — market_cap, shares_out, pe, beta, div_yield.
async function fetchTwelvedataStatistics(env, ticker) {
  const apiKey = env?.TWELVEDATA_API_KEY;
  if (!apiKey) return null;
  const data = await _fetchJson(
    `${TD_STATS_BASE}?symbol=${encodeURIComponent(ticker)}&apikey=${encodeURIComponent(apiKey)}`,
  );
  if (!data || data.status === "error" || data.code) return null;
  const stats = data.statistics || data;
  const v = stats?.valuations_metrics || stats;
  const f = stats?.financials || stats;
  return {
    market_cap: Number(v?.market_capitalization) || null,
    shares_out: Number(v?.shares_outstanding || f?.shares_outstanding) || null,
    pe: Number(v?.trailing_pe || v?.pe_ratio) || null,
    beta: Number(stats?.stock_price_summary?.beta) || null,
    dividend_yield: Number(stats?.dividends_and_splits?.forward_annual_dividend_yield) || null,
  };
}

// Finnhub fallback — same shape, used if TwelveData returns nothing
// (which happens for some thinly-traded ETFs).
async function fetchFinnhubProfile(env, ticker) {
  const apiKey = env?.FINNHUB_API_KEY;
  if (!apiKey) return null;
  const data = await _fetchJson(
    `${FINNHUB_PROFILE_BASE}?symbol=${encodeURIComponent(ticker)}&token=${encodeURIComponent(apiKey)}`,
  );
  if (!data || !data.name) return null;
  return {
    name: data.name || null,
    sector: data.finnhubIndustry || null,    // finnhub uses "industry" naming
    industry: data.finnhubIndustry || null,
    country: data.country || null,
    currency: data.currency || null,
    exchange: data.exchange || null,
    market_cap: Number(data.marketCapitalization)
      ? Number(data.marketCapitalization) * 1_000_000   // finnhub returns in millions
      : null,
    shares_out: Number(data.shareOutstanding)
      ? Number(data.shareOutstanding) * 1_000_000
      : null,
    source: "finnhub",
  };
}

// Hydrate a single ticker — TwelveData first, Finnhub fallback.
// Returns the metadata row that was persisted (or null on failure).
export async function hydrateTicker(env, ticker, opts = {}) {
  const t = String(ticker || "").toUpperCase();
  if (!t) return null;
  await ensureTickerMetadataSchema(env);

  // Step 1: try TwelveData /profile for static fields.
  let profile = await fetchTwelvedataProfile(env, t);

  // Step 2: try TwelveData /statistics for MCap + financials.
  let stats = await fetchTwelvedataStatistics(env, t);

  // Step 3: Finnhub fallback when TD returned nothing useful.
  if (!profile && !stats) {
    const fh = await fetchFinnhubProfile(env, t);
    if (fh) {
      profile = { name: fh.name, sector: fh.sector, industry: fh.industry, country: fh.country, currency: fh.currency, exchange: fh.exchange, source: "finnhub" };
      stats = { market_cap: fh.market_cap, shares_out: fh.shares_out, pe: null, beta: null, dividend_yield: null };
    }
  }
  if (!profile && !stats) return null;

  const row = {
    ticker: t,
    name: profile?.name || null,
    sector: profile?.sector || null,
    industry: profile?.industry || null,
    country: profile?.country || null,
    currency: profile?.currency || "USD",
    exchange: profile?.exchange || null,
    market_cap: stats?.market_cap || null,
    shares_out: stats?.shares_out || null,
    pe: stats?.pe || null,
    beta: stats?.beta || null,
    dividend_yield: stats?.dividend_yield || null,
    source: profile?.source || (stats ? "twelvedata" : "unknown"),
    fetched_at: Date.now(),
    mcap_fetched_at: stats?.market_cap ? Date.now() : null,
  };

  try {
    await env.DB.prepare(`
      INSERT OR REPLACE INTO ticker_metadata
        (ticker, name, sector, industry, country, currency, exchange,
         market_cap, shares_out, pe, beta, dividend_yield, source,
         fetched_at, mcap_fetched_at, updated_at)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)
    `).bind(
      row.ticker, row.name, row.sector, row.industry, row.country,
      row.currency, row.exchange, row.market_cap, row.shares_out,
      row.pe, row.beta, row.dividend_yield, row.source,
      row.fetched_at, row.mcap_fetched_at, Date.now(),
    ).run();
  } catch (e) {
    console.warn(`[META] persist failed for ${t}:`, String(e?.message || e).slice(0, 200));
    return null;
  }
  return row;
}

// Hydrate all tickers missing metadata. Used by the cron + admin
// endpoint. Polite 250ms delay between calls (TD free tier = ~8
// req/min, paid is higher).
export async function hydrateMissing(env, opts = {}) {
  await ensureTickerMetadataSchema(env);
  const KV = env?.KV_TIMED;
  const max = Math.max(1, Math.min(500, Number(opts.max) || 100));
  const delayMs = Math.max(50, Number(opts.delayMs) || 250);
  const onlyMissing = opts.onlyMissing !== false;

  // Universe = SECTOR_MAP keys + timed:tickers user-added.
  const SectorMap = await import("./sector-mapping.js");
  const canonical = Object.keys(SectorMap.SECTOR_MAP || {});
  const userAdded = (KV ? ((await KV.get("timed:tickers", "json")) || []) : []).filter(Boolean);
  const universe = [...new Set([...canonical, ...userAdded].map((s) => String(s).toUpperCase()))];

  // Pull existing metadata to find which tickers are missing fields.
  let existing = {};
  try {
    const rows = (await env.DB.prepare(
      `SELECT ticker, name, sector, industry, market_cap FROM ticker_metadata`,
    ).all().catch(() => ({ results: [] })))?.results || [];
    for (const r of rows) existing[String(r.ticker).toUpperCase()] = r;
  } catch (_) {}

  // Pick tickers needing hydration (name/sector/industry missing) — capped.
  const needing = [];
  for (const t of universe) {
    if (!onlyMissing) { needing.push(t); continue; }
    const ex = existing[t];
    if (!ex) { needing.push(t); continue; }
    if (!ex.name || !ex.sector || !ex.industry) needing.push(t);
    if (needing.length >= max) break;
  }

  let hydrated = 0;
  const failures = [];
  for (let i = 0; i < needing.length; i++) {
    const t = needing[i];
    const row = await hydrateTicker(env, t);
    if (row) hydrated++; else failures.push(t);
    if (delayMs > 0 && i < needing.length - 1) {
      await new Promise((res) => setTimeout(res, delayMs));
    }
  }
  return {
    ok: true,
    universe_size: universe.length,
    existing: Object.keys(existing).length,
    needing: needing.length,
    hydrated,
    failures: failures.length,
    failure_sample: failures.slice(0, 10),
  };
}

// Refresh MCap for all tickers that already have metadata. Cheap because
// it skips the static profile lookup and only hits /statistics.
export async function refreshMarketCaps(env, opts = {}) {
  await ensureTickerMetadataSchema(env);
  const max = Math.max(1, Math.min(500, Number(opts.max) || 500));
  const delayMs = Math.max(50, Number(opts.delayMs) || 200);
  const rows = (await env.DB.prepare(
    `SELECT ticker FROM ticker_metadata WHERE name IS NOT NULL ORDER BY ticker LIMIT ?1`,
  ).bind(max).all().catch(() => ({ results: [] })))?.results || [];
  let updated = 0;
  for (let i = 0; i < rows.length; i++) {
    const t = String(rows[i].ticker).toUpperCase();
    const stats = await fetchTwelvedataStatistics(env, t);
    if (stats?.market_cap) {
      try {
        await env.DB.prepare(`
          UPDATE ticker_metadata
             SET market_cap = ?2, shares_out = COALESCE(?3, shares_out),
                 pe = COALESCE(?4, pe), beta = COALESCE(?5, beta),
                 dividend_yield = COALESCE(?6, dividend_yield),
                 mcap_fetched_at = ?7, updated_at = ?7
           WHERE ticker = ?1
        `).bind(t, stats.market_cap, stats.shares_out, stats.pe, stats.beta, stats.dividend_yield, Date.now()).run();
        updated++;
      } catch (_) {}
    }
    if (delayMs > 0 && i < rows.length - 1) {
      await new Promise((res) => setTimeout(res, delayMs));
    }
  }
  return { ok: true, attempted: rows.length, updated };
}

// Batch read for the Tickers admin page.
export async function loadAllMetadata(env) {
  await ensureTickerMetadataSchema(env);
  const rows = (await env.DB.prepare(
    `SELECT ticker, name, sector, industry, country, currency, exchange,
            market_cap, shares_out, pe, beta, dividend_yield, source,
            fetched_at, mcap_fetched_at, updated_at
       FROM ticker_metadata`,
  ).all().catch(() => ({ results: [] })))?.results || [];
  const byTicker = {};
  for (const r of rows) byTicker[String(r.ticker).toUpperCase()] = r;
  return { ok: true, count: rows.length, by_ticker: byTicker };
}
