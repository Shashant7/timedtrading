// VIX level resolution — VX1! when fresh, Yahoo ^VIX cash fallback.
// VIXY is intentionally excluded from level resolution (directional / HMM only).

import { kvGetJSON, kvPutJSON } from "./storage.js";

export const VIX_CANONICAL = "VIX";
export const VIX_FUTURES_SOURCE = "VX1!";
export const YAHOO_VIX_SYMBOL = "^VIX";
export const VIX_YAHOO_CACHE_KEY = "macro:vix_cash_quote";
export const VIX_YAHOO_CACHE_TTL_SEC = 300;
/** Match futures-proxy TV freshness bar — VIX futures tick ~23h/day. */
export const VIX_VX1_FRESH_MS = 10 * 60 * 1000;
const HISTORICAL_VIX_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function roundPct(n) {
  return Math.round(Number(n) * 10000) / 100;
}

function nearestHistoricalLevel(rows, targetTs, maxAgeMs = HISTORICAL_VIX_MAX_AGE_MS) {
  if (!Array.isArray(rows) || !(Number(targetTs) > 0)) return null;
  let closest = null;
  let distance = Infinity;
  for (const row of rows) {
    const ts = Number(row?.ts) || 0;
    const level = Number(row?.level);
    if (!(ts > 0) || !(level > 0)) continue;
    const d = Math.abs(ts - Number(targetTs));
    if (d < distance) {
      closest = { ts, level, source: row.source || null };
      distance = d;
    }
  }
  return closest && distance <= maxAgeMs ? closest : null;
}

/**
 * Load the same VIX history hierarchy Market Pulse relies on:
 * daily Market Pulse snapshots first, then cash-index/VX1! candles.
 * VIXY is deliberately excluded: it is a directional ETF, not a VIX level.
 */
export async function loadHistoricalVixSeries(db) {
  if (!db) return { snapshots: [], candles: [] };
  const [snapshotRes, candleRes] = await Promise.all([
    db.prepare(
      `SELECT date, vix_close
         FROM daily_market_snapshots
        WHERE vix_close IS NOT NULL AND vix_close > 0
        ORDER BY date`,
    ).all().catch(() => ({ results: [] })),
    db.prepare(
      `SELECT ticker, ts, c
         FROM ticker_candles
        WHERE tf = 'D' AND ticker IN ('VIX', '$VIX', 'VIX.X', 'VX1!')
        ORDER BY ts`,
    ).all().catch(() => ({ results: [] })),
  ]);
  const snapshots = (snapshotRes?.results || []).map((r) => ({
    // Snapshot date records the completed US session. Noon UTC avoids a
    // midnight boundary choosing the prior trading day for US entries.
    ts: Date.parse(`${String(r.date).slice(0, 10)}T12:00:00Z`),
    level: Number(r.vix_close),
    source: "market_pulse_snapshot",
  }));
  const candles = (candleRes?.results || []).map((r) => ({
    ts: Number(r.ts),
    level: Number(r.c),
    source: String(r.ticker || "").toUpperCase() === "VX1!" ? "vx1_daily" : "vix_daily",
  }));
  return { snapshots, candles };
}

/**
 * Resolve VIX at a historical entry timestamp. A recorded entry value wins;
 * otherwise use the Market Pulse daily snapshot, then cash/VX1! history.
 */
export function resolveHistoricalVixAtTs(entryTs, series = {}, entryVix = null) {
  const recorded = Number(entryVix);
  if (Number.isFinite(recorded) && recorded > 0) {
    return { level: round2(recorded), source: "entry_lineage" };
  }
  const snapshot = nearestHistoricalLevel(series.snapshots, entryTs);
  if (snapshot) return { level: round2(snapshot.level), source: snapshot.source };
  const candle = nearestHistoricalLevel(series.candles, entryTs);
  if (candle) return { level: round2(candle.level), source: candle.source };
  return { level: null, source: "missing" };
}

function kvPriceRow(sym, price, prevClose, ts, source) {
  const p = round2(price);
  const pc = prevClose > 0 ? round2(prevClose) : 0;
  const dc = pc > 0 ? round2(p - pc) : null;
  const dp = pc > 0 ? roundPct(((p - pc) / pc) * 100) : null;
  return {
    p,
    pc,
    dc,
    dp,
    t: Number(ts) || Date.now(),
    _macro_source: source,
  };
}

function readVx1Candidate(prices = {}, KV, getJson = kvGetJSON) {
  const fromPrices = prices[VIX_FUTURES_SOURCE];
  if (fromPrices && Number(fromPrices.p) > 0) {
    return {
      price: Number(fromPrices.p),
      prev_close: Number(fromPrices.pc) || 0,
      ts: Number(fromPrices.t) || 0,
      source: "prices",
    };
  }
  return null;
}

export async function readVx1FromKv(KV, prices = {}, getJson = kvGetJSON) {
  const fromPrices = readVx1Candidate(prices, KV, getJson);
  if (fromPrices) return fromPrices;

  if (!KV) return null;
  for (const key of [`timed:heartbeat:${VIX_FUTURES_SOURCE}`, `timed:latest:${VIX_FUTURES_SOURCE}`]) {
    try {
      const stub = await getJson(KV, key);
      const price = Number(stub?.price);
      if (!(price > 0)) continue;
      return {
        price,
        prev_close: Number(stub.prev_close || stub.previous_close || 0),
        ts: Number(stub.ingest_ts || stub.ts || 0),
        source: key.includes("heartbeat") ? "heartbeat" : "latest",
      };
    } catch (_) { /* best-effort */ }
  }
  return null;
}

export function isVx1Fresh(vx1, nowMs = Date.now()) {
  if (!vx1 || !(Number(vx1.price) > 0)) return false;
  const ts = Number(vx1.ts) || 0;
  if (!(ts > 0)) return false;
  return (nowMs - ts) <= VIX_VX1_FRESH_MS;
}

/** Best-effort CBOE VIX cash index via Yahoo ^VIX. */
export async function fetchYahooVixCashQuote(env, getJson = kvGetJSON, putJson = kvPutJSON) {
  const kv = env?.KV_TIMED || env?.KV;
  try {
    if (kv) {
      const cached = await getJson(kv, VIX_YAHOO_CACHE_KEY).catch(() => null);
      if (cached?.price > 0 && cached?.fetched_at && Date.now() - cached.fetched_at < VIX_YAHOO_CACHE_TTL_SEC * 1000) {
        return {
          price: Number(cached.price),
          prev_close: Number(cached.prev_close) || 0,
          ts: Number(cached.fetched_at),
          source: "yahoo_vix_cached",
        };
      }
    }
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(YAHOO_VIX_SYMBOL)}?interval=1d&range=1d`;
    const resp = await fetch(url, {
      headers: { "User-Agent": "TimedTrading/1.0 (vix-level)" },
      signal: AbortSignal.timeout(8000),
    }).catch(() => null);
    if (!resp?.ok) return null;
    const data = await resp.json().catch(() => null);
    const meta = data?.chart?.result?.[0]?.meta;
    const price = Number(meta?.regularMarketPrice ?? meta?.chartPreviousClose);
    if (!Number.isFinite(price) || price <= 0) return null;
    const prevClose = Number(meta?.chartPreviousClose ?? meta?.previousClose ?? 0);
    const fetchedAt = Date.now();
    const out = {
      price,
      prev_close: prevClose > 0 ? prevClose : 0,
      ts: fetchedAt,
      source: "yahoo_vix",
    };
    if (kv) {
      await putJson(kv, VIX_YAHOO_CACHE_KEY, {
        price: out.price,
        prev_close: out.prev_close,
        fetched_at: fetchedAt,
      }, VIX_YAHOO_CACHE_TTL_SEC).catch(() => {});
    }
    return out;
  } catch (_) {
    return null;
  }
}

/**
 * Resolve live VIX level. Priority: fresh VX1! → Yahoo ^VIX cash.
 * Never uses VIXY (reserved for directional features).
 */
export async function resolveVixLevel(env, options = {}) {
  const KV = env?.KV_TIMED || env?.KV;
  const prices = options.prices || {};
  const nowMs = Number(options.nowMs) || Date.now();
  const getJson = options.getJson || kvGetJSON;

  const vx1 = await readVx1FromKv(KV, prices, getJson);
  if (isVx1Fresh(vx1, nowMs)) {
    return {
      ok: true,
      ticker: VIX_CANONICAL,
      price: vx1.price,
      prev_close: vx1.prev_close,
      ts: vx1.ts,
      source: VIX_FUTURES_SOURCE,
      _via: vx1.source,
    };
  }

  const yahoo = await fetchYahooVixCashQuote(env, getJson, options.putJson || kvPutJSON);
  if (yahoo?.price > 0) {
    return {
      ok: true,
      ticker: VIX_CANONICAL,
      price: yahoo.price,
      prev_close: yahoo.prev_close,
      ts: yahoo.ts,
      source: yahoo.source,
      _via: "yahoo",
      _vx1_stale: vx1 ? { ts: vx1.ts, age_ms: vx1.ts ? nowMs - vx1.ts : null } : null,
    };
  }

  // Last resort: stale VX1! beats nothing (better than blank UI).
  if (vx1?.price > 0) {
    return {
      ok: true,
      ticker: VIX_CANONICAL,
      price: vx1.price,
      prev_close: vx1.prev_close,
      ts: vx1.ts,
      source: VIX_FUTURES_SOURCE,
      _via: vx1.source,
      _stale: true,
    };
  }

  return { ok: false, ticker: VIX_CANONICAL, error: "no_vix_source" };
}

/** Write resolved VIX into timed:prices map (canonical VIX key). */
export function applyVixToPrices(prices, resolved) {
  if (!prices || typeof prices !== "object" || !resolved?.ok) return prices;
  const prev = prices[VIX_CANONICAL] || {};
  const row = kvPriceRow(
    VIX_CANONICAL,
    resolved.price,
    resolved.prev_close,
    resolved.ts,
    resolved.source,
  );
  const resolvedTs = Number(resolved.ts) || 0;
  const prevTs = Number(prev.t) || 0;
  if (!prices[VIX_CANONICAL] || resolvedTs >= prevTs || resolved._stale !== true) {
    prices[VIX_CANONICAL] = row;
  }
  return prices;
}

/** Mirror resolved VIX into timed:latest:VIX for scoring / brief paths. */
export async function syncVixLatestStub(KV, resolved, getJson = kvGetJSON, putJson = kvPutJSON) {
  if (!KV || !resolved?.ok || !(Number(resolved.price) > 0)) return { synced: false };
  try {
    const existing = await getJson(KV, `timed:latest:${VIX_CANONICAL}`);
    const sourceTs = Number(resolved.ts) || Date.now();
    const existingTs = Number(existing?.ingest_ts || existing?.ts || 0);
    if (existing && existingTs > sourceTs && !resolved._stale) return { synced: false, reason: "newer_exists" };
    await putJson(KV, `timed:latest:${VIX_CANONICAL}`, {
      ticker: VIX_CANONICAL,
      price: round2(resolved.price),
      prev_close: resolved.prev_close > 0 ? round2(resolved.prev_close) : undefined,
      day_change: resolved.prev_close > 0 ? round2(resolved.price - resolved.prev_close) : undefined,
      day_change_pct: resolved.prev_close > 0
        ? roundPct(((resolved.price - resolved.prev_close) / resolved.prev_close) * 100)
        : undefined,
      ts: sourceTs,
      ingest_ts: sourceTs,
      _macro_source: resolved.source,
      _vix_via: resolved._via,
      _stale: resolved._stale || false,
    });
    return { synced: true, source: resolved.source };
  } catch (_) {
    return { synced: false, reason: "write_failed" };
  }
}

/** Price-feed hook: resolve VIX and write to prices + timed:latest stub. */
export async function ensureVixLevel(env, prices, options = {}) {
  const resolved = await resolveVixLevel(env, { ...options, prices });
  applyVixToPrices(prices, resolved);
  const KV = env?.KV_TIMED || env?.KV;
  const stub = await syncVixLatestStub(KV, resolved, options.getJson, options.putJson);
  return { resolved, stub };
}
