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

import {
  buildTransitionMatrix,
  buildExpandedTransitionMatrix,
  summarizeMatrix,
  DEFAULT_WINDOW_DAYS,
  REGIME_STATES,
  EXPANDED_REGIME_STATES,
} from "./regime-markov.js";

const KV_KEY = "timed:regime:matrix:global";
// 2026-05-27 (PR #311 — improvement 2): expanded 12-state matrix.
// Stored separately so the 4-state matrix (universe-wide and
// per-ticker, the existing reads) is never affected.
const EXPANDED_KV_KEY = "timed:regime:matrix:expanded:global";
const KV_TTL_SECONDS = 14 * 24 * 3600; // 14 days — daily refresh should always be fresher than this
const READ_BATCH_LIMIT = 5000; // page size for trail_5m_facts SELECTs

// 2026-05-27 (PR #309 — improvement 3): per-ticker matrices for the
// top-N most active tickers. Stored at
//   timed:regime:matrix:ticker:{TICKER}
// alongside the universe-wide matrix. The forecast read path prefers
// the per-ticker variant when available; falls back to the universe
// matrix for the long tail. Cap on N to bound KV write cost: a 90d
// per-ticker matrix is ~3 KB so 50 = ~150 KB of KV writes per day.
const PER_TICKER_KV_PREFIX = "timed:regime:matrix:ticker:";
const PER_TICKER_DEFAULT_TOP_N = 50;
const PER_TICKER_MIN_OBS_PER_CELL = 10; // looser than universe; per-ticker sample is smaller

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
    //
    // 2026-05-27 (PR #311 — improvement 2): also SELECT the completion so
    // the expanded 12-state matrix builder can assign each row to its
    // completion band (EARLY/MID/LATE). The 4-state builder ignores the
    // extra column.
    //
    // 2026-06-10 BUGFIX — the table column is `completion` (end-of-bucket
    // value; see worker/migrations/add-trail-5m-fact-table.sql).
    // `max_completion` exists ONLY as a SELECT alias inside the
    // aggregation WRITER (trail-facts-light.js: `MAX(completion) AS
    // max_completion` feeding the `completion` column). PR #311 queried
    // the alias as if it were a column, so every matrix compute since
    // 2026-05-27 failed with `D1_ERROR: no such column: max_completion`
    // (bootstrap, nightly refresh, and admin recompute alike) and the
    // Markov matrix stopped rebuilding. Verified against the production
    // schema via pragma_table_info before this fix. Alias kept so the
    // row-mapping below stays unchanged.
    const sql = tickersFilter
      ? `SELECT ticker, bucket_ts, state, completion AS max_completion
           FROM trail_5m_facts
          WHERE bucket_ts >= ?1
            AND state IS NOT NULL
            AND ticker IN (${tickersFilter.map((_, i) => `?${i + 2}`).join(",")})
          ORDER BY ticker, bucket_ts
          LIMIT ${READ_BATCH_LIMIT}
         OFFSET ?${tickersFilter.length + 2}`
      : `SELECT ticker, bucket_ts, state, completion AS max_completion
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
      buckets.push({
        ticker: r.ticker,
        bucket_ts: Number(r.bucket_ts),
        state: String(r.state),
        // completion is null/missing on tickers/buckets that don't have
        // a tracked move; expandedStateFor() defaults to "MID" in that
        // case so nothing disappears from the count.
        completion: Number(r.max_completion),
      });
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

  // 2026-05-27 (PR #311 — improvement 2): build + persist the EXPANDED
  // 12-state matrix from the same buckets in parallel. Same reads, same
  // window — just a different state encoding. Non-fatal if it fails:
  // the 4-state matrix is already persisted at this point.
  try {
    const expandedReport = buildExpandedTransitionMatrix(buckets, { minObs: 8 });
    const expandedPayload = {
      schema_version: 1,
      scope: "expanded_global",
      states: EXPANDED_REGIME_STATES.slice(),
      n_states: expandedReport.n_states,
      P: expandedReport.P,
      counts: expandedReport.counts,
      total_transitions: expandedReport.total_transitions,
      low_obs_cells: expandedReport.low_obs_cells,
      min_obs: expandedReport.min_obs,
      window_days: windowDays,
      distinct_tickers: tickerSet.size,
      rows_read: totalRows,
      computed_at: expandedReport.computed_at,
    };
    await KV.put(EXPANDED_KV_KEY, JSON.stringify(expandedPayload), { expirationTtl: KV_TTL_SECONDS });
    console.log(`[REGIME MATRIX] Expanded 12-state matrix built: ${expandedReport.total_transitions} transitions, ${expandedReport.low_obs_cells.length} low-obs cells`);
  } catch (expErr) {
    console.warn("[REGIME MATRIX] Expanded matrix build failed (non-fatal):", String(expErr?.message || expErr).slice(0, 200));
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
 * ticker in the every-5-minute scoring loop. KV reads are free but the round-trip
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

// ═══════════════════════════════════════════════════════════════════════
// 2026-05-27 — Per-ticker matrices (PR #309, improvement 3)
// ═══════════════════════════════════════════════════════════════════════
//
// Universe-wide matrices have great sample-size statistical power
// (~1.2M transitions across 250 tickers × 90d) but lose ticker-specific
// behavior. Volatile semiconductors transition differently from utility
// ETFs. For the top-N most-active tickers we have enough per-ticker
// observations (~5K transitions per ticker per 90d) to build a per-
// ticker matrix with reasonable confidence. For the long tail of
// infrequently-scored tickers we fall back to the universe matrix.
//
// Top-N selection: ranked by trail_5m_facts row count in the window.

/**
 * computeAndPersistPerTickerMatrices
 *
 * @param {object} env
 * @param {object} [opts]
 * @param {number} [opts.topN=50]
 * @param {number} [opts.windowDays=90]
 * @param {number} [opts.minObs=10]
 * @returns {Promise<{ok, count, tickers, errors, elapsed_ms}>}
 */
export async function computeAndPersistPerTickerMatrices(env, opts = {}) {
  const db = env?.DB;
  const KV = env?.KV_TIMED;
  if (!db) return { ok: false, error: "no_d1_binding" };
  if (!KV) return { ok: false, error: "no_kv_binding" };

  const t0 = Date.now();
  const topN = Number.isFinite(opts.topN) ? Math.max(1, Math.min(200, opts.topN)) : PER_TICKER_DEFAULT_TOP_N;
  const windowDays = Number.isFinite(opts.windowDays) ? Math.max(7, opts.windowDays) : DEFAULT_WINDOW_DAYS;
  const minObs = Number.isFinite(opts.minObs) ? opts.minObs : PER_TICKER_MIN_OBS_PER_CELL;
  const cutoff = Date.now() - windowDays * 86400000;

  // 1) Pick the top-N most active tickers (row count in window).
  let topTickers;
  try {
    const res = await db.prepare(
      `SELECT ticker, COUNT(*) AS n
         FROM trail_5m_facts
        WHERE bucket_ts >= ?1 AND state IS NOT NULL
        GROUP BY ticker
        ORDER BY n DESC
        LIMIT ?2`,
    ).bind(cutoff, topN).all();
    topTickers = (res?.results || []).map(r => ({ ticker: String(r.ticker), n: Number(r.n) }));
  } catch (e) {
    return { ok: false, error: "topN_query_failed", details: String(e?.message || e).slice(0, 200) };
  }
  if (topTickers.length === 0) {
    return { ok: false, error: "no_data", window_days: windowDays };
  }

  // 2) For each top ticker, pull its rows + build matrix + write KV.
  const tickerSummaries = [];
  let errors = 0;
  for (const { ticker, n: rowCount } of topTickers) {
    try {
      const rows = await _fetchTickerBuckets(db, ticker, cutoff);
      if (rows.length < 50) {
        // Too few observations even for a per-ticker matrix; skip
        // (forecast will fall back to universe).
        tickerSummaries.push({ ticker, rows: rows.length, written: false, reason: "below_min_rows" });
        continue;
      }
      const report = buildTransitionMatrix(rows, { minObs });
      const payload = {
        schema_version: 1,
        scope: "per_ticker",
        ticker,
        states: REGIME_STATES.slice(),
        P: report.P,
        counts: report.counts,
        effective_counts: report.effective_counts,
        stationary: report.stationary,
        mean_dwell: report.mean_dwell,
        dwell_std: report.dwell_std,
        suspicious_pct: report.suspicious_pct,
        suspicious_count: report.suspicious_count,
        total_transitions: report.total_transitions,
        low_obs_cells: report.low_obs_cells,
        min_obs: minObs,
        window_days: windowDays,
        config: report.config,
        dropped_gap_transitions: report.dropped_gap_transitions,
        avg_effective_weight: report.avg_effective_weight,
        rows_read: rows.length,
        computed_at: report.computed_at,
        summary: summarizeMatrix(report),
      };
      await KV.put(`${PER_TICKER_KV_PREFIX}${ticker}`, JSON.stringify(payload), { expirationTtl: KV_TTL_SECONDS });
      tickerSummaries.push({
        ticker,
        rows: rows.length,
        written: true,
        total_transitions: report.total_transitions,
        low_obs_count: report.low_obs_cells.length,
      });
    } catch (e) {
      errors++;
      tickerSummaries.push({ ticker, written: false, error: String(e?.message || e).slice(0, 200) });
    }
  }

  // 3) Persist a manifest listing the tickers with per-ticker matrices,
  // so the forecast read path can fast-check without N KV lookups.
  const manifest = {
    schema_version: 1,
    computed_at: Date.now(),
    window_days: windowDays,
    min_obs: minObs,
    top_n_requested: topN,
    tickers: tickerSummaries.filter(t => t.written).map(t => t.ticker),
  };
  try {
    await KV.put(`${PER_TICKER_KV_PREFIX}_manifest`, JSON.stringify(manifest), { expirationTtl: KV_TTL_SECONDS });
  } catch (_) { /* non-fatal */ }

  const elapsed = Date.now() - t0;
  console.log(`[REGIME MATRIX] Per-ticker: ${manifest.tickers.length}/${topTickers.length} written, ${errors} errors, ${elapsed}ms`);

  return {
    ok: true,
    count: manifest.tickers.length,
    errors,
    elapsed_ms: elapsed,
    tickers: tickerSummaries,
  };
}

async function _fetchTickerBuckets(db, ticker, cutoff) {
  const out = [];
  let offset = 0;
  for (;;) {
    const res = await db.prepare(
      `SELECT ticker, bucket_ts, state
         FROM trail_5m_facts
        WHERE ticker = ?1 AND bucket_ts >= ?2 AND state IS NOT NULL
        ORDER BY bucket_ts
        LIMIT ${READ_BATCH_LIMIT}
        OFFSET ?3`,
    ).bind(ticker, cutoff, offset).all();
    const rows = res?.results || [];
    if (!rows.length) break;
    for (const r of rows) out.push({ ticker: r.ticker, bucket_ts: Number(r.bucket_ts), state: String(r.state) });
    if (rows.length < READ_BATCH_LIMIT) break;
    offset += rows.length;
    if (offset >= 200_000) break; // hard safety cap per ticker
  }
  return out;
}

// Per-isolate cache so the every-5-min scoring path doesn't re-fetch
// the manifest + N per-ticker entries from KV on every tick.
let _perTickerManifest = null;
let _perTickerManifestAt = 0;
const _perTickerCache = new Map(); // ticker -> { matrix, fetchedAt }
const PER_TICKER_CACHE_TTL_MS = 30 * 60 * 1000; // 30 min

export async function loadPerTickerMatrix(env, ticker) {
  const KV = env?.KV_TIMED;
  if (!KV || !ticker) return null;
  const sym = String(ticker).toUpperCase();
  const now = Date.now();

  // Manifest first — cheap O(1) check whether we have a per-ticker
  // matrix for this symbol at all. Avoids 200+ "key not found" KV
  // reads per cron tick for the long-tail tickers.
  if (!_perTickerManifest || (now - _perTickerManifestAt) > PER_TICKER_CACHE_TTL_MS) {
    try {
      _perTickerManifest = (await KV.get(`${PER_TICKER_KV_PREFIX}_manifest`, "json")) || { tickers: [] };
      _perTickerManifestAt = now;
    } catch (_) {
      _perTickerManifest = { tickers: [] };
      _perTickerManifestAt = now;
    }
  }
  if (!Array.isArray(_perTickerManifest.tickers) || !_perTickerManifest.tickers.includes(sym)) return null;

  const cached = _perTickerCache.get(sym);
  if (cached && (now - cached.fetchedAt) < PER_TICKER_CACHE_TTL_MS) return cached.matrix;
  try {
    const m = await KV.get(`${PER_TICKER_KV_PREFIX}${sym}`, "json");
    if (m && m.P) {
      _perTickerCache.set(sym, { matrix: m, fetchedAt: now });
      return m;
    }
  } catch (_) { /* non-fatal */ }
  return null;
}

export const PER_TICKER_MATRIX_KV_PREFIX = PER_TICKER_KV_PREFIX;

// ═══════════════════════════════════════════════════════════════════════
// 2026-05-27 (PR #311 — improvement 2): expanded 12-state matrix loader
// ═══════════════════════════════════════════════════════════════════════
//
// Built + persisted by the modified computeAndPersistRegimeMatrix above
// (writes BOTH 4-state and 12-state matrices in the same daily pass).
// Stored under EXPANDED_KV_KEY ("timed:regime:matrix:expanded:global")
// with the same 14-day TTL as the 4-state matrix.

export { EXPANDED_KV_KEY as EXPANDED_REGIME_MATRIX_KV_KEY };

// Per-isolate cache for the expanded 12-state matrix. Same 5-min TTL
// as the 4-state matrix since it's refreshed by the same daily cron.
let _cachedExpanded = null;
let _cachedExpandedAt = 0;

export async function loadExpandedRegimeMatrix(env, opts = {}) {
  const force = !!opts.force;
  const now = Date.now();
  if (!force && _cachedExpanded && (now - _cachedExpandedAt) < CACHE_TTL_MS) {
    return _cachedExpanded;
  }
  const KV = env?.KV_TIMED;
  if (!KV) return null;
  try {
    const v = await KV.get(EXPANDED_KV_KEY, "json");
    if (v && v.P) {
      _cachedExpanded = v;
      _cachedExpandedAt = now;
      return v;
    }
  } catch (e) {
    console.warn("[REGIME MATRIX] loadExpandedRegimeMatrix failed:", String(e?.message || e).slice(0, 200));
  }
  return null;
}
