// worker/lib/regime-markov-compute.js
//
// Compute job that runs daily (and manually via the admin endpoint).
// Reads the last N days of per-ticker state from trail_5m_facts,
// builds the universe-wide transition matrix + stationary distribution
// + mean dwell stats, and persists the result to KV at
//   timed:regime:matrix:global
//
// Persistence rationale (D1 cost):
// - The matrix is one small JSON object (~3 KB). KV is the right
//   primitive — free reads, cheap writes, fast access from the */5
//   scoring path that attaches forecasts to every ticker payload.
// - We do NOT persist to D1. The source (trail_5m_facts) lives in D1
//   already and our compute reads SELECT-only.

import { buildTransitionMatrix, summarizeMatrix, DEFAULT_WINDOW_DAYS, REGIME_STATES } from "./regime-markov.js";

const KV_KEY = "timed:regime:matrix:global";
const KV_TTL_SECONDS = 14 * 24 * 3600; // 14 days — daily refresh should always be fresher than this
const READ_BATCH_LIMIT = 5000; // page size for trail_5m_facts SELECTs

/**
 * computeAndPersistRegimeMatrix
 *
 * @param {object} env - worker env with DB + KV_TIMED bindings
 * @param {object} [opts]
 * @param {number} [opts.windowDays=90]   - rolling window
 * @param {number} [opts.minObs=20]        - min observations per cell guard
 * @param {string[]} [opts.tickers]        - optional restrict (defaults: all in window)
 *
 * @returns {Promise<{ ok, summary, written_kv, rows_read, distinct_tickers, ... }>}
 */
export async function computeAndPersistRegimeMatrix(env, opts = {}) {
  const db = env?.DB;
  const KV = env?.KV_TIMED;
  if (!db) return { ok: false, error: "no_d1_binding" };
  if (!KV) return { ok: false, error: "no_kv_binding" };

  const windowDays = Number.isFinite(opts.windowDays) ? Math.max(7, Math.floor(opts.windowDays)) : DEFAULT_WINDOW_DAYS;
  const minObs = Number.isFinite(opts.minObs) ? Math.max(0, Math.floor(opts.minObs)) : 20;
  const tickersFilter = Array.isArray(opts.tickers) && opts.tickers.length > 0
    ? opts.tickers.map(t => String(t).toUpperCase())
    : null;

  const now = Date.now();
  const cutoff = now - windowDays * 24 * 60 * 60 * 1000;

  // Stream rows in pages of READ_BATCH_LIMIT so memory stays bounded for
  // the larger 1M+ row case. Total expected rows per 90d: ~1.2M for the
  // full ~250-ticker universe (see exploration report 2026-05-22).
  let totalRows = 0;
  const buckets = []; // we'll collect everything to feed buildTransitionMatrix once
  const tickerSet = new Set();
  let lastTs = cutoff - 1;
  let lastTicker = "";

  for (;;) {
    // Cursor by (bucket_ts, ticker) so subsequent pages start strictly
    // after the last row of the previous page. trail_5m_facts PK is
    // (ticker, bucket_ts) so ORDER BY ticker, bucket_ts is the cheap
    // index walk.
    const sql = tickersFilter
      ? `SELECT ticker, bucket_ts, state
           FROM trail_5m_facts
          WHERE bucket_ts >= ?1
            AND state IS NOT NULL
            AND ticker IN (${tickersFilter.map((_, i) => `?${i + 2}`).join(",")})
          ORDER BY ticker, bucket_ts
          LIMIT ${READ_BATCH_LIMIT}
         OFFSET ?${tickersFilter.length + 2}`
      : `SELECT ticker, bucket_ts, state
           FROM trail_5m_facts
          WHERE bucket_ts >= ?1
            AND state IS NOT NULL
          ORDER BY ticker, bucket_ts
          LIMIT ${READ_BATCH_LIMIT}
         OFFSET ?2`;
    const binds = tickersFilter
      ? [cutoff, ...tickersFilter, totalRows]
      : [cutoff, totalRows];

    let rows;
    try {
      const res = await db.prepare(sql).bind(...binds).all();
      rows = res?.results || [];
    } catch (e) {
      return { ok: false, error: "d1_select_failed", details: String(e?.message || e).slice(0, 300) };
    }
    if (!rows.length) break;
    for (const r of rows) {
      buckets.push({ ticker: r.ticker, bucket_ts: Number(r.bucket_ts), state: String(r.state) });
      tickerSet.add(String(r.ticker || "").toUpperCase());
    }
    totalRows += rows.length;
    if (rows.length < READ_BATCH_LIMIT) break;
    // Guard against runaway: cap at ~5M rows for safety.
    if (totalRows >= 5_000_000) break;
  }

  if (totalRows === 0) {
    return { ok: false, error: "no_data", window_days: windowDays, cutoff };
  }

  const report = buildTransitionMatrix(buckets, { minObs });

  const payload = {
    schema_version: 1,
    states: REGIME_STATES.slice(),
    P: report.P,
    counts: report.counts,
    stationary: report.stationary,
    mean_dwell: report.mean_dwell,
    dwell_std: report.dwell_std,
    suspicious_pct: report.suspicious_pct,
    suspicious_count: report.suspicious_count,
    suspicious_samples: report.suspicious.slice(0, 10),
    total_transitions: report.total_transitions,
    low_obs_cells: report.low_obs_cells,
    min_obs: minObs,
    window_days: windowDays,
    distinct_tickers: tickerSet.size,
    rows_read: totalRows,
    computed_at: report.computed_at,
    summary: summarizeMatrix(report),
  };

  try {
    await KV.put(KV_KEY, JSON.stringify(payload), { expirationTtl: KV_TTL_SECONDS });
  } catch (e) {
    return { ok: false, error: "kv_put_failed", details: String(e?.message || e).slice(0, 300) };
  }

  console.log(`[REGIME MATRIX] Built from ${totalRows} rows / ${tickerSet.size} tickers / ${windowDays}d window. ${payload.summary}`);

  return {
    ok: true,
    rows_read: totalRows,
    distinct_tickers: tickerSet.size,
    total_transitions: report.total_transitions,
    suspicious_pct: report.suspicious_pct,
    low_obs_cells: report.low_obs_cells.length,
    summary: payload.summary,
    kv_key: KV_KEY,
    written_at: payload.computed_at,
  };
}

/**
 * loadRegimeMatrix — convenience read used by the scoring path.
 *
 * Cached in module scope per-isolate to avoid hitting KV on every
 * ticker in the */5 scoring loop. KV reads are free but the round-trip
 * adds latency; one read per cron tick is plenty since the matrix
 * itself only refreshes daily.
 */
let _cachedMatrix = null;
let _cachedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min — well below the daily refresh cadence

export async function loadRegimeMatrix(env, opts = {}) {
  const force = !!opts.force;
  const now = Date.now();
  if (!force && _cachedMatrix && (now - _cachedAt) < CACHE_TTL_MS) {
    return _cachedMatrix;
  }
  const KV = env?.KV_TIMED;
  if (!KV) return null;
  try {
    const v = await KV.get(KV_KEY, "json");
    if (v && v.P) {
      _cachedMatrix = v;
      _cachedAt = now;
      return v;
    }
  } catch (e) {
    console.warn("[REGIME MATRIX] loadRegimeMatrix failed:", String(e?.message || e).slice(0, 200));
  }
  return null;
}

export { KV_KEY as REGIME_MATRIX_KV_KEY };
