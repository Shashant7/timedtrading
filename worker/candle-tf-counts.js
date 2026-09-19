/**
 * Cached ticker × timeframe candle counts.
 *
 * `d1FindTickersNeedingOnboard` used to run
 *   SELECT ticker, tf, COUNT(*) FROM ticker_candles GROUP BY ticker, tf
 * on every call. That scan reads ~6M rows. The orphan snapshot called it
 * twice, and the hourly heal called it again — ~6B rows/week (Sep 2026).
 *
 * Candle counts change when a backfill/onboard writes. Cache in KV for
 * one hour and share the blob across hard + soft + heal callers.
 * Bust the key wherever ingestion-status is busted.
 */

export const CANDLE_TF_COUNTS_KEY = "timed:cache:candle-tf-counts";
export const CANDLE_TF_COUNTS_TTL_SEC = 3600;
export const CANDLE_TF_COUNTS_SQL =
  "SELECT ticker, tf, COUNT(*) as cnt FROM ticker_candles GROUP BY ticker, tf";

export function rowsToTickerTfCounts(rows) {
  const byTicker = {};
  for (const r of rows || []) {
    const sym = String(r.ticker || "").toUpperCase();
    if (!sym) continue;
    if (!byTicker[sym]) byTicker[sym] = {};
    byTicker[sym][r.tf] = Number(r.cnt) || 0;
  }
  return byTicker;
}

export async function bustCandleTfCountsCache(env) {
  try { await env?.KV_TIMED?.delete(CANDLE_TF_COUNTS_KEY); } catch (_) { /* best-effort */ }
}

export async function loadCandleTfCounts(env, { force = false, now = Date.now() } = {}) {
  const db = env?.DB;
  if (!db?.prepare) return { byTicker: {}, source: "none" };

  if (!force) {
    try {
      const cached = await env?.KV_TIMED?.get(CANDLE_TF_COUNTS_KEY, "json");
      const ts = Number(cached?.ts) || 0;
      if (cached?.byTicker && ts > 0 && (now - ts) < CANDLE_TF_COUNTS_TTL_SEC * 1000) {
        return { byTicker: cached.byTicker, source: "kv", ts };
      }
    } catch (_) { /* fall through to D1 */ }
  }

  let rows = [];
  try {
    rows = (await db.prepare(CANDLE_TF_COUNTS_SQL).all())?.results || [];
  } catch (_) {
    return { byTicker: {}, source: "d1_failed" };
  }
  const byTicker = rowsToTickerTfCounts(rows);
  const ts = now;
  try {
    await env?.KV_TIMED?.put(
      CANDLE_TF_COUNTS_KEY,
      JSON.stringify({ ts, byTicker }),
      { expirationTtl: CANDLE_TF_COUNTS_TTL_SEC + 300 },
    );
  } catch (_) { /* best-effort */ }
  return { byTicker, source: "d1", ts };
}
