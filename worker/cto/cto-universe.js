// worker/cto/cto-universe.js
// Scored-universe resolution + tiered refresh lists for CTO.

import { SECTOR_MAP } from "../sector-mapping.js";

/** Index ETFs surfaced first in the level map / feed. */
export const INDEX_FOCUS = new Set(["SPY", "QQQ", "IWM", "DIA", "RSP", "MAGS", "IGV", "SMH"]);

export const KV_LAST_FULL_REFRESH = "timed:cto:last_full_refresh";

export const CACHE_TTL_PRIORITY_SEC = 60 * 60;          // 1h — indices + open positions
export const CACHE_TTL_DAILY_SEC = 24 * 60 * 60;        // 24h — rest of scored universe

/** Wall-clock guards — keep hourly pass cheap; cap daily recompute budget. */
export const MAX_ELAPSED_MS_PRIORITY = 45_000;
export const MAX_ELAPSED_MS_FULL = 240_000;
export const MAX_TICKERS_PRIORITY = 48;

async function loadRemovedTickers(env) {
  const kv = env?.KV_TIMED || env?.KV;
  if (!kv) return new Set();
  try {
    const raw = await kv.get("timed:removed");
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    const arr = Array.isArray(parsed) ? parsed : [];
    return new Set(arr.map((t) => String(t || "").toUpperCase()).filter(Boolean));
  } catch (_) {
    return new Set();
  }
}

async function loadActiveUserTickers(env) {
  const db = env?.DB;
  if (!db) return [];
  try {
    const rows = await db.prepare(
      `SELECT DISTINCT ticker FROM user_tickers WHERE deleted_at IS NULL`,
    ).all();
    return (rows?.results || [])
      .map((r) => String(r.ticker || "").toUpperCase())
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

export async function loadOpenPositionTickers(env) {
  const db = env?.DB;
  if (!db) return [];
  try {
    const rows = await db.prepare(
      `SELECT DISTINCT ticker FROM positions WHERE status='OPEN'`,
    ).all();
    return (rows?.results || [])
      .map((r) => String(r.ticker || "").toUpperCase())
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

/** Same union the scoring cron uses: core SECTOR_MAP + active user slots. */
export async function resolveScoredUniverseTickers(env) {
  const removed = await loadRemovedTickers(env);
  const userAdded = await loadActiveUserTickers(env);
  const core = Object.keys(SECTOR_MAP || {}).map((t) => String(t).toUpperCase());
  const merged = [...new Set([...core, ...userAdded])]
    .filter((t) => t && !removed.has(t))
    .sort();
  return merged;
}

export function isPriorityTicker(sym, { openPositions = null } = {}) {
  const s = String(sym || "").toUpperCase();
  if (INDEX_FOCUS.has(s)) return true;
  if (openPositions && openPositions.has(s)) return true;
  return false;
}

export function cacheTtlForTicker(sym, { openPositions = null } = {}) {
  return isPriorityTicker(sym, { openPositions })
    ? CACHE_TTL_PRIORITY_SEC
    : CACHE_TTL_DAILY_SEC;
}

/**
 * Build the ticker list for a refresh pass.
 * @param {"priority"|"full"|"all"} mode
 *   priority — indices + open positions (hourly)
 *   full     — scored universe minus priority (daily)
 *   all      — entire scored universe (admin / first run)
 */
export async function buildCTORefreshTickers(env, { mode = "all", limit = null } = {}) {
  const scored = await resolveScoredUniverseTickers(env);
  const openList = await loadOpenPositionTickers(env);
  const openPositions = new Set(openList);

  const priority = [...new Set([...INDEX_FOCUS, ...openList])]
    .filter((t) => scored.includes(t) || INDEX_FOCUS.has(t) || openPositions.has(t))
    .sort((a, b) => {
      const ai = INDEX_FOCUS.has(a) ? 0 : 1;
      const bi = INDEX_FOCUS.has(b) ? 0 : 1;
      if (ai !== bi) return ai - bi;
      return a.localeCompare(b);
    });

  let tickers;
  if (mode === "priority") {
    tickers = priority;
  } else if (mode === "full") {
    const priSet = new Set(priority);
    tickers = scored.filter((t) => !priSet.has(t));
  } else {
    tickers = [...new Set([...priority, ...scored])].sort((a, b) => {
      const ai = isPriorityTicker(a, { openPositions }) ? 0 : 1;
      const bi = isPriorityTicker(b, { openPositions }) ? 0 : 1;
      if (ai !== bi) return ai - bi;
      return a.localeCompare(b);
    });
  }

  const cap = mode === "priority"
    ? Math.min(limit || MAX_TICKERS_PRIORITY, MAX_TICKERS_PRIORITY)
    : limit;

  if (cap && cap > 0) tickers = tickers.slice(0, cap);

  return {
    mode,
    tickers,
    scored,
    priority,
    openPositions: openList,
    openPositionsSet: openPositions,
  };
}

/** Slim rollup row from a cached per-ticker KV blob. */
export function rollupRowFromCachedPayload(sym, cached) {
  if (!cached || !cached.top_upside) return null;
  return {
    ticker: sym,
    ok: true,
    from_cache: true,
    error_kind: null,
    bars: cached.bars || null,
    as_of_date: cached.as_of_date || null,
    bar_as_of_ms: cached.bar_as_of_ms || null,
    anchor_price: cached.current_price ?? null,
    narrative: cached.narrative || null,
    top_upside: (cached.top_upside || []).slice(0, 1),
    top_downside: (cached.top_downside || []).slice(0, 1),
    low_sample: !!cached.low_sample,
  };
}

/**
 * Merge newly processed rows with the previous rollup so hourly priority
 * passes do not drop the rest of the scored universe from the feed.
 */
export function mergeRollupResults(rollupUniverse, processed, previousRollup = null) {
  const prevBy = new Map((previousRollup?.results || []).map((r) => [String(r.ticker || "").toUpperCase(), r]));
  const newBy = new Map(processed.map((r) => [String(r.ticker || "").toUpperCase(), r]));
  const merged = [];
  for (const sym of rollupUniverse) {
    if (newBy.has(sym)) merged.push(newBy.get(sym));
    else if (prevBy.has(sym)) merged.push(prevBy.get(sym));
  }
  return merged;
}
