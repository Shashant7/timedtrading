// worker/ticker-metadata.js
//
// Ticker metadata hydration (Name / Sector / Industry / MCap).
// Primary source: TwelveData `/profile` + `/statistics`. Finnhub fallback.
//
// Static fields (name, sector, industry) are fetched once and persisted.
// MCap is refreshed on demand / weekly cron.

const TD_PROFILE_BASE = "https://api.twelvedata.com/profile";
const TD_STATS_BASE = "https://api.twelvedata.com/statistics";
const FINNHUB_PROFILE_BASE = "https://finnhub.io/api/v1/stock/profile2";

const REQUEST_TIMEOUT_MS = 8_000;
const CONTEXT_TTL_SEC = 90 * 24 * 60 * 60;

async function kvPutJSON(KV, key, val, ttlSec) {
  if (!KV) return;
  try {
    const opts = ttlSec ? { expirationTtl: ttlSec } : undefined;
    await KV.put(key, JSON.stringify(val), opts);
  } catch (_) {}
}

async function kvGetJSON(KV, key) {
  if (!KV) return null;
  try {
    const raw = await KV.get(key, "text");
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

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

async function fetchFinnhubProfile(env, ticker) {
  const apiKey = env?.FINNHUB_API_KEY;
  if (!apiKey) return null;
  const data = await _fetchJson(
    `${FINNHUB_PROFILE_BASE}?symbol=${encodeURIComponent(ticker)}&token=${encodeURIComponent(apiKey)}`,
  );
  if (!data || !data.name) return null;
  return {
    name: data.name || null,
    sector: data.finnhubIndustry || null,
    industry: data.finnhubIndustry || null,
    country: data.country || null,
    currency: data.currency || null,
    exchange: data.exchange || null,
    market_cap: Number(data.marketCapitalization)
      ? Number(data.marketCapitalization) * 1_000_000
      : null,
    shares_out: Number(data.shareOutstanding)
      ? Number(data.shareOutstanding) * 1_000_000
      : null,
    source: "finnhub",
  };
}

export function metadataRowToContext(row) {
  if (!row || typeof row !== "object") return null;
  const out = {};
  if (row.name) out.name = String(row.name);
  if (row.sector) out.sector = String(row.sector);
  if (row.industry) out.industry = String(row.industry);
  if (row.country) out.country = String(row.country);
  if (row.exchange) out.exchange = String(row.exchange);
  if (row.market_cap != null && Number(row.market_cap) > 0) {
    out.market_cap = Number(row.market_cap);
  }
  if (Object.keys(out).length === 0) return null;
  out._enriched_at = Date.now();
  out._source = row.source || "ticker_metadata";
  return out;
}

export async function syncMetadataToContext(env, row, opts = {}) {
  const sym = String(row?.ticker || "").toUpperCase();
  const ctx = metadataRowToContext(row);
  if (!sym || !ctx) return false;
  const KV = env?.KV_TIMED || env?.KV;
  const existing = await kvGetJSON(KV, `timed:context:${sym}`);
  const merged = { ...(existing || {}), ...ctx };
  await kvPutJSON(KV, `timed:context:${sym}`, merged, CONTEXT_TTL_SEC);

  if (opts.patchSectorMap !== false && ctx.sector) {
    try {
      const SectorMap = await import("./sector-mapping.js");
      if (SectorMap.SECTOR_MAP?.[sym] === "Unknown" || !SectorMap.SECTOR_MAP?.[sym]) {
        SectorMap.SECTOR_MAP[sym] = ctx.sector;
        if (KV) await KV.put(`timed:sector_map:${sym}`, ctx.sector);
      }
    } catch (_) {}
  }

  try {
    if (env?.DB) {
      const d1Row = await env.DB.prepare(
        `SELECT payload_json FROM ticker_latest WHERE ticker = ?`,
      ).bind(sym).first();
      if (d1Row?.payload_json) {
        const payload = JSON.parse(d1Row.payload_json);
        payload.context = { ...(payload.context || {}), ...ctx };
        if (!payload.companyName && ctx.name) payload.companyName = ctx.name;
        if (!payload.name && ctx.name) payload.name = ctx.name;
        await env.DB.prepare(
          `UPDATE ticker_latest SET payload_json = ? WHERE ticker = ?`,
        ).bind(JSON.stringify(payload), sym).run();
      }
    }
  } catch (_) {}

  return true;
}

async function persistMetadataRow(env, row) {
  await env.DB.prepare(`
    INSERT INTO ticker_metadata
      (ticker, name, sector, industry, country, currency, exchange,
       market_cap, shares_out, pe, beta, dividend_yield, source,
       fetched_at, mcap_fetched_at, updated_at)
    VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)
    ON CONFLICT(ticker) DO UPDATE SET
      name = COALESCE(excluded.name, ticker_metadata.name),
      sector = COALESCE(excluded.sector, ticker_metadata.sector),
      industry = COALESCE(excluded.industry, ticker_metadata.industry),
      country = COALESCE(excluded.country, ticker_metadata.country),
      currency = COALESCE(excluded.currency, ticker_metadata.currency),
      exchange = COALESCE(excluded.exchange, ticker_metadata.exchange),
      market_cap = COALESCE(excluded.market_cap, ticker_metadata.market_cap),
      shares_out = COALESCE(excluded.shares_out, ticker_metadata.shares_out),
      pe = COALESCE(excluded.pe, ticker_metadata.pe),
      beta = COALESCE(excluded.beta, ticker_metadata.beta),
      dividend_yield = COALESCE(excluded.dividend_yield, ticker_metadata.dividend_yield),
      source = COALESCE(excluded.source, ticker_metadata.source),
      fetched_at = COALESCE(ticker_metadata.fetched_at, excluded.fetched_at),
      mcap_fetched_at = COALESCE(excluded.mcap_fetched_at, ticker_metadata.mcap_fetched_at),
      updated_at = excluded.updated_at
  `).bind(
    row.ticker, row.name, row.sector, row.industry, row.country,
    row.currency, row.exchange, row.market_cap, row.shares_out,
    row.pe, row.beta, row.dividend_yield, row.source,
    row.fetched_at, row.mcap_fetched_at, Date.now(),
  ).run();
}

export async function resolveMetadataUniverse(env) {
  const SectorMap = await import("./sector-mapping.js");
  const { resolveScoringUniverse } = await import("./universe.js");
  const KV = env?.KV_TIMED || env?.KV;
  const kvTickers = KV ? ((await KV.get("timed:tickers", "json")) || []) : [];
  const removed = KV ? ((await KV.get("timed:removed", "json")) || []) : [];
  let d1IndexTickers = [];
  if (env?.DB) {
    try {
      const idxRows = await env.DB.prepare(
        `SELECT ticker FROM ticker_index ORDER BY ticker ASC`,
      ).all();
      d1IndexTickers = (idxRows?.results || [])
        .map((r) => String(r.ticker || "").toUpperCase())
        .filter(Boolean);
    } catch (_) {}
  }
  return resolveScoringUniverse({
    sectorMapKeys: Object.keys(SectorMap.SECTOR_MAP || {}),
    userTickers: [],
    kvTickers: [...(Array.isArray(kvTickers) ? kvTickers : []), ...d1IndexTickers],
    removed,
  });
}

export async function hydrateTicker(env, ticker, opts = {}) {
  const t = String(ticker || "").toUpperCase();
  if (!t) return null;
  await ensureTickerMetadataSchema(env);

  let profile = await fetchTwelvedataProfile(env, t);
  let stats = await fetchTwelvedataStatistics(env, t);

  if (!profile && !stats) {
    const fh = await fetchFinnhubProfile(env, t);
    if (fh) {
      profile = {
        name: fh.name,
        sector: fh.sector,
        industry: fh.industry,
        country: fh.country,
        currency: fh.currency,
        exchange: fh.exchange,
        source: "finnhub",
      };
      stats = {
        market_cap: fh.market_cap,
        shares_out: fh.shares_out,
        pe: null,
        beta: null,
        dividend_yield: null,
      };
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
    await persistMetadataRow(env, row);
  } catch (e) {
    console.warn(`[META] persist failed for ${t}:`, String(e?.message || e).slice(0, 200));
    return null;
  }

  if (opts.syncContext !== false) {
    await syncMetadataToContext(env, row);
  }
  return row;
}

export async function hydrateMissing(env, opts = {}) {
  await ensureTickerMetadataSchema(env);
  const max = Math.max(1, Math.min(500, Number(opts.max) || 100));
  const delayMs = Math.max(50, Number(opts.delayMs) || 250);
  const onlyMissing = opts.onlyMissing !== false;
  const universe = await resolveMetadataUniverse(env);

  let existing = {};
  try {
    const rows = (await env.DB.prepare(
      `SELECT ticker, name, sector, industry, market_cap FROM ticker_metadata`,
    ).all().catch(() => ({ results: [] })))?.results || [];
    for (const r of rows) existing[String(r.ticker).toUpperCase()] = r;
  } catch (_) {}

  const needing = [];
  for (const t of universe) {
    if (!onlyMissing) {
      needing.push(t);
    } else {
      const ex = existing[t];
      if (!ex) {
        needing.push(t);
      } else if (!ex.name || !ex.sector || !ex.industry || !ex.market_cap) {
        needing.push(t);
      }
    }
    if (needing.length >= max) break;
  }

  let hydrated = 0;
  const failures = [];
  for (let i = 0; i < needing.length; i++) {
    const t = needing[i];
    const row = await hydrateTicker(env, t);
    if (row) hydrated++;
    else failures.push(t);
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
    remaining_estimate: Math.max(0, universe.filter((t) => {
      const ex = existing[t];
      return !ex || !ex.name || !ex.sector || !ex.industry || !ex.market_cap;
    }).length - hydrated),
  };
}

export async function syncAllMetadataToContext(env, opts = {}) {
  await ensureTickerMetadataSchema(env);
  const max = Math.max(1, Math.min(500, Number(opts.max) || 500));
  const rows = (await env.DB.prepare(
    `SELECT ticker, name, sector, industry, country, exchange, market_cap, source
       FROM ticker_metadata
      WHERE name IS NOT NULL
      ORDER BY ticker
      LIMIT ?1`,
  ).bind(max).all().catch(() => ({ results: [] })))?.results || [];
  let synced = 0;
  for (const r of rows) {
    if (await syncMetadataToContext(env, r, { patchSectorMap: opts.patchSectorMap })) synced++;
  }
  return { ok: true, synced, attempted: rows.length };
}

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
        await syncMetadataToContext(env, {
          ticker: t,
          market_cap: stats.market_cap,
          source: "twelvedata",
        });
        updated++;
      } catch (_) {}
    }
    if (delayMs > 0 && i < rows.length - 1) {
      await new Promise((res) => setTimeout(res, delayMs));
    }
  }
  return { ok: true, attempted: rows.length, updated };
}

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
