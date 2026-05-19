// ═══════════════════════════════════════════════════════════════════════════
// random-walk-null.js — Simple Random Walk null hypothesis (S3)
// ═══════════════════════════════════════════════════════════════════════════
//
// Phase 3 of the trajectory research program
// (tasks/2026-05-18-stochastic-research-program.md §0.6).
//
// PURPOSE
// -------
// Answer owner Q4 directly: "Simple Random Walk." For each setup (or the
// whole engine), test whether the actual strategy's returns are
// distinguishable from a random-walk null built on the same ticker
// universe + same hold-time distribution.
//
// The null model is the SIMPLE Random Walk (per owner directive):
// random entry timestamps drawn from the SAME valid-bar pool the live
// engine sees, exited at the SAME hold-time distribution as the actual
// trades. If the actual strategy's net PnL doesn't beat the 95th
// percentile of the null distribution (the owner-locked threshold), we
// don't have edge — we have luck / regime fit.
//
// METHOD
// ------
//  1. Load actual closed trades in window (filtered by setup if given).
//     Capture: { ticker, entry_ts, exit_ts, pnl_pct, hold_ms }.
//  2. Load the "valid-bar pool" — every (ticker, bucket_ts, price_close)
//     in trail_5m_facts in the same window for the same ticker universe.
//     Filter to RTH-equivalent buckets (just NY hour 9..16) to match the
//     entry conditions live trades face.
//  3. For each of K simulations:
//       a. Sample N entries uniformly at random from the valid-bar pool
//          (N = same trade count as actual).
//       b. For each sampled entry, sample a hold duration from the
//          actual hold-distribution and find the bar at entry_ts + hold.
//       c. Compute simulated_pnl_pct = (exit_price - entry_price) /
//          entry_price * 100. Direction = LONG (single side; SHORT
//          version possible but not v1 since we have no short trades).
//       d. Aggregate the K simulated PnL series.
//  4. Compare actual against the K-distribution: percentile rank, p-value
//     approximation. Verdict per owner-locked 95th-percentile threshold:
//       - ABOVE_RANDOM_95TH   — percentile >= 95: real edge
//       - INDISTINGUISHABLE   — 5 <= percentile < 95: no detectable edge
//       - BELOW_RANDOM_5TH    — percentile < 5: actively worse than random
//
// PERFORMANCE
// -----------
// K=1000 sims × ~30 trades/sim = ~30K random samples. Each sample is an
// O(1) array index + a binary search on the ticker's bar series for the
// exit price. Pre-fetched into memory once; each sim is JS-only and
// completes in ~10ms. Total: ~10s per request.
//
// All read-only. No live admission / exit behavior change.
// ═══════════════════════════════════════════════════════════════════════════

const FIVE_MIN_MS = 5 * 60 * 1000;

const DEFAULTS = Object.freeze({
  lookbackDays: 90,
  nSimulations: 1000,
  rthOnly: true,
  minActualTrades: 5,
});

// ── PRNG (mulberry32) — deterministic for reproducibility when seeded ──

function mulberry32(seed) {
  let t = seed >>> 0;
  return function rand() {
    t = (t + 0x6D2B79F5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

// ── NY-hour bucket helper (RTH = 9:30..16:00 NY) ──

function nyHourOfBucket(bucketTs) {
  try {
    const d = new Date(Number(bucketTs));
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(d);
    const h = Number(parts.find(p => p.type === "hour")?.value || 0);
    const m = Number(parts.find(p => p.type === "minute")?.value || 0);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return -1;
    return h + m / 60;
  } catch { return -1; }
}

function isRthFractional(h) {
  return h >= 9.5 && h < 16.0;
}

// ── Simple percentile from a numeric array ──

function percentiles(arr, ps) {
  if (arr.length === 0) return Object.fromEntries(ps.map(p => [String(Math.round(p * 100)), null]));
  const sorted = arr.slice().sort((a, b) => a - b);
  const at = (p) => {
    const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
    return sorted[i];
  };
  return Object.fromEntries(ps.map(p => [String(Math.round(p * 100)), Number(at(p).toFixed(4))]));
}

function percentileRank(arr, value) {
  if (!Array.isArray(arr) || arr.length === 0 || !Number.isFinite(value)) return null;
  let countBelow = 0;
  for (const v of arr) if (v < value) countBelow += 1;
  return Number((countBelow / arr.length).toFixed(4));
}

// ═══════════════════════════════════════════════════════════════════════════
// Main: simulateRandomWalkNull
// ═══════════════════════════════════════════════════════════════════════════

/**
 * @param {object} env worker env (uses env.DB)
 * @param {object} [opts]
 * @param {string} [opts.setupFilter]   Filter actual trades to one setup_name.
 * @param {string} [opts.directionFilter] LONG / SHORT (default LONG only).
 * @param {number} [opts.lookbackDays]  Default 90.
 * @param {number} [opts.nSimulations]  Default 1000.
 * @param {boolean} [opts.rthOnly]      Restrict valid-bar pool to NY 9:30-16:00. Default true.
 * @param {number} [opts.seed]          PRNG seed. Default Date.now().
 * @returns {Promise<{
 *   ok, window, config,
 *   actual: { n, net_pnl_pct, win_rate, avg_R, pf },
 *   null_distribution: {
 *     net_pnl_pct: { p5, p25, p50, p75, p95 },
 *     win_rate:    { p5, p25, p50, p75, p95 },
 *     avg_R:       { p5, p25, p50, p75, p95 },
 *     pf:          { p5, p25, p50, p75, p95 }
 *   },
 *   percentile_of_actual: { net_pnl_pct, win_rate, avg_R, pf },
 *   verdict: 'ABOVE_RANDOM_95TH' | 'INDISTINGUISHABLE' | 'BELOW_RANDOM_5TH',
 *   counts: { actual_trades, valid_bars, simulations, unique_tickers_in_pool },
 *   elapsed_ms
 * }>}
 */
export async function simulateRandomWalkNull(env, opts = {}) {
  const t0 = Date.now();
  const db = env?.DB;
  if (!db) return { ok: false, error: "no_db", elapsed_ms: 0 };

  const lookbackDays  = Math.max(7, Math.min(720, Number(opts.lookbackDays) || DEFAULTS.lookbackDays));
  const nSimulations  = Math.max(50, Math.min(10000, Number(opts.nSimulations) || DEFAULTS.nSimulations));
  const rthOnly       = opts.rthOnly !== false;
  const setupFilter   = opts.setupFilter ? String(opts.setupFilter) : null;
  const directionFilter = (opts.directionFilter || "LONG").toUpperCase();
  const seed          = Number.isFinite(opts.seed) ? Number(opts.seed) : Date.now();
  const rand          = mulberry32(seed);

  const nowMs = Date.now();
  const sinceMs = nowMs - lookbackDays * 86400000;

  // 1) Load actual trades.
  const whereActual = [
    `status IN ('WIN','LOSS','FLAT')`,
    `entry_ts >= ?`,
    `direction = ?`,
  ];
  const paramsActual = [sinceMs, directionFilter];
  if (setupFilter) { whereActual.push(`setup_name = ?`); paramsActual.push(setupFilter); }
  let actualTrades;
  try {
    const res = await db.prepare(
      `SELECT ticker, entry_ts, exit_ts, pnl_pct
       FROM trades
       WHERE ${whereActual.join(" AND ")}
       ORDER BY entry_ts`,
    ).bind(...paramsActual).all();
    actualTrades = (res?.results || []).filter(t => t.entry_ts && t.exit_ts);
  } catch (err) {
    return { ok: false, error: String(err?.message || err).slice(0, 300) };
  }

  if (actualTrades.length < DEFAULTS.minActualTrades) {
    return {
      ok: false,
      error: `insufficient_actual_trades n=${actualTrades.length} (need >= ${DEFAULTS.minActualTrades})`,
      counts: { actual_trades: actualTrades.length },
      elapsed_ms: Date.now() - t0,
    };
  }

  // Actual metrics
  const actualMetrics = computeMetricsFromTrades(actualTrades);
  const holdTimesMs = actualTrades
    .map(t => Number(t.exit_ts) - Number(t.entry_ts))
    .filter(h => Number.isFinite(h) && h > 0);

  // 2) Load the valid-bar pool: per ticker, all (bucket_ts, price_close) in
  // the window. Restrict to the universe of tickers the actual trades
  // operated on (this is the apples-to-apples comparison — random entries
  // on the SAME tickers, not the universe).
  const universe = Array.from(new Set(actualTrades.map(t => t.ticker)));
  const universePlaceholders = universe.map((_, i) => `?${i + 2}`).join(",");
  let barsRes;
  try {
    barsRes = await db.prepare(
      `SELECT ticker, bucket_ts, price_close
       FROM trail_5m_facts
       WHERE bucket_ts >= ?1 AND ticker IN (${universePlaceholders})
       ORDER BY ticker, bucket_ts`,
    ).bind(sinceMs, ...universe).all();
  } catch (err) {
    return { ok: false, error: String(err?.message || err).slice(0, 300) };
  }
  const allBars = (barsRes?.results || []).filter(r => Number.isFinite(Number(r.price_close)) && Number(r.price_close) > 0);

  // Build per-ticker sorted bar arrays for fast hold-time exit lookup.
  const byTicker = new Map();
  for (const b of allBars) {
    let arr = byTicker.get(b.ticker);
    if (!arr) { arr = []; byTicker.set(b.ticker, arr); }
    arr.push({ ts: Number(b.bucket_ts), price: Number(b.price_close) });
  }
  // Build the RTH-only sampling pool (entry candidates).
  const samplingPool = [];
  for (const [tk, arr] of byTicker.entries()) {
    for (const b of arr) {
      if (rthOnly) {
        const h = nyHourOfBucket(b.ts);
        if (!isRthFractional(h)) continue;
      }
      samplingPool.push({ ticker: tk, ts: b.ts, price: b.price });
    }
  }

  if (samplingPool.length < actualTrades.length * 2) {
    return {
      ok: false,
      error: `insufficient_valid_bars pool=${samplingPool.length}; need at least 2x actual trades`,
      counts: { actual_trades: actualTrades.length, valid_bars: samplingPool.length },
      elapsed_ms: Date.now() - t0,
    };
  }

  // 3) Run K simulations.
  const simNetPnl = new Float64Array(nSimulations);
  const simWinRate = new Float64Array(nSimulations);
  const simAvgR = new Float64Array(nSimulations);
  const simPf = new Float64Array(nSimulations);

  const N = actualTrades.length;
  const poolLen = samplingPool.length;
  const holdLen = holdTimesMs.length;

  for (let s = 0; s < nSimulations; s++) {
    let sumPnl = 0, wins = 0, losses = 0, sumWin = 0, sumLoss = 0;
    for (let i = 0; i < N; i++) {
      const entry = samplingPool[Math.floor(rand() * poolLen)];
      const holdMs = holdTimesMs[Math.floor(rand() * holdLen)];
      const exitTsTarget = entry.ts + holdMs;
      const exitPrice = lookupClosestPrice(byTicker.get(entry.ticker), exitTsTarget);
      if (exitPrice == null || !(exitPrice > 0)) continue;
      const pnlPct = ((exitPrice - entry.price) / entry.price) * 100;
      sumPnl += pnlPct;
      if (pnlPct > 0) { wins += 1; sumWin += pnlPct; }
      else if (pnlPct < 0) { losses += 1; sumLoss += pnlPct; }
    }
    const decided = wins + losses;
    simNetPnl[s] = sumPnl;
    simWinRate[s] = decided > 0 ? wins / decided : 0;
    simAvgR[s] = N > 0 ? sumPnl / N : 0;
    simPf[s] = sumLoss < 0 ? sumWin / Math.abs(sumLoss) : (sumWin > 0 ? 99 : 0);
  }

  // 4) Build the response.
  const simNetPnlArr = Array.from(simNetPnl);
  const simWinRateArr = Array.from(simWinRate);
  const simAvgRArr = Array.from(simAvgR);
  const simPfArr = Array.from(simPf);

  const nullDist = {
    net_pnl_pct: percentiles(simNetPnlArr, [0.05, 0.25, 0.5, 0.75, 0.95]),
    win_rate:    percentiles(simWinRateArr, [0.05, 0.25, 0.5, 0.75, 0.95]),
    avg_R:       percentiles(simAvgRArr,    [0.05, 0.25, 0.5, 0.75, 0.95]),
    pf:          percentiles(simPfArr,      [0.05, 0.25, 0.5, 0.75, 0.95]),
  };

  const percentileOfActual = {
    net_pnl_pct: percentileRank(simNetPnlArr,  actualMetrics.net_pnl_pct),
    win_rate:    percentileRank(simWinRateArr, actualMetrics.win_rate),
    avg_R:       percentileRank(simAvgRArr,    actualMetrics.avg_R),
    pf:          percentileRank(simPfArr,      actualMetrics.pf),
  };

  // Verdict gated on net_pnl_pct (the primary metric per the program).
  // Owner-locked threshold: 95th percentile.
  let verdict = "INDISTINGUISHABLE";
  const p = percentileOfActual.net_pnl_pct;
  if (p != null) {
    if (p >= 0.95) verdict = "ABOVE_RANDOM_95TH";
    else if (p <= 0.05) verdict = "BELOW_RANDOM_5TH";
  }

  return {
    ok: true,
    window: { since_ms: sinceMs, until_ms: nowMs },
    config: {
      setup_filter: setupFilter,
      direction_filter: directionFilter,
      lookback_days: lookbackDays,
      n_simulations: nSimulations,
      rth_only: rthOnly,
      seed,
      threshold_percentile: 0.95,
    },
    actual: actualMetrics,
    null_distribution: nullDist,
    percentile_of_actual: percentileOfActual,
    verdict,
    verdict_reason: percentileOfActual.net_pnl_pct == null
      ? "null_net_pnl_percentile"
      : `actual_net_pnl_pct_percentile=${(percentileOfActual.net_pnl_pct * 100).toFixed(1)}% (threshold 95.0%)`,
    counts: {
      actual_trades: actualTrades.length,
      valid_bars: samplingPool.length,
      simulations: nSimulations,
      unique_tickers_in_pool: universe.length,
      hold_time_samples: holdLen,
    },
    elapsed_ms: Date.now() - t0,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function computeMetricsFromTrades(trades) {
  let sumPnl = 0, wins = 0, losses = 0, sumWin = 0, sumLoss = 0;
  for (const t of trades) {
    const p = Number(t.pnl_pct);
    if (!Number.isFinite(p)) continue;
    sumPnl += p;
    if (p > 0) { wins += 1; sumWin += p; }
    else if (p < 0) { losses += 1; sumLoss += p; }
  }
  const decided = wins + losses;
  const N = trades.length;
  return {
    n: N,
    net_pnl_pct: Number(sumPnl.toFixed(4)),
    win_rate: decided > 0 ? Number((wins / decided).toFixed(4)) : null,
    avg_R: N > 0 ? Number((sumPnl / N).toFixed(4)) : null,
    pf: sumLoss < 0 ? Number((sumWin / Math.abs(sumLoss)).toFixed(3)) : (sumWin > 0 ? 99 : null),
  };
}

// Binary search for the bar with the closest bucket_ts <= targetTs.
// Returns price_close or null. Tolerates up to 60min slip (12 buckets).
function lookupClosestPrice(barArr, targetTs) {
  if (!Array.isArray(barArr) || barArr.length === 0) return null;
  let lo = 0, hi = barArr.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (barArr[mid].ts <= targetTs) lo = mid; else hi = mid - 1;
  }
  const cand = barArr[lo];
  if (!cand) return null;
  const slip = Math.abs(targetTs - cand.ts);
  if (slip > 60 * 60 * 1000) return null;
  return cand.price;
}
