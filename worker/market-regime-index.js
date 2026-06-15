// worker/market-regime-index.js
// ─────────────────────────────────────────────────────────────────────────────
//  MARKET CYCLE + PER-INDEX BENCHMARK MAPPING
//
//  Three related pieces, all pure + testable:
//
//  (1) cycleFromRegime() — the SINGLE source of the market-cycle label
//      ("uptrend" | "downtrend" | "transitional") from an index's daily EMA
//      regime + HTF score. This MIRRORS the replay derivation in
//      worker/replay-candle-batches.js so live ≡ backtest (the live cron never
//      computed a cycle before, so the h3 entry gate always defaulted to the
//      strict "transitional" rank floor — even in a clear uptrend).
//
//  (2) breadthAwareMarketCycle() — a market backdrop that blends the major
//      indices (SPY/QQQ/IWM/DIA/RSP) instead of SPY alone, so a breadth-led
//      advance (small/value/equal-weight strong while cap-weighted SPY lags) is
//      not masked by the cap-weighted index.
//
//  (3) resolveTickerCycle() — route a ticker to its HOME index's cycle using a
//      data-driven (trailing-beta) ticker→index map, falling back to the breadth
//      composite. A cyclical/industrial that tracks IWM/DIA should be judged
//      against IWM/DIA's regime, not SPY's.
// ─────────────────────────────────────────────────────────────────────────────

/** The benchmark indices we classify + map tickers onto. */
export const CYCLE_INDEXES = ["SPY", "QQQ", "IWM", "DIA", "RSP"];

/**
 * Replay-parity cycle label from an index's daily EMA regime + HTF score.
 * Mirrors worker/replay-candle-batches.js exactly:
 *   ema_regime_daily >=  2  OR  htf_score >= +15  -> "uptrend"
 *   ema_regime_daily <= -2  OR  htf_score <= -15  -> "downtrend"
 *   otherwise                                     -> "transitional"
 * Returns null when neither input is usable (no data).
 */
export function cycleFromRegime(emaRegimeDaily, htfScore) {
  const edr = Number(emaRegimeDaily);
  const htf = Number(htfScore);
  const hasEdr = emaRegimeDaily != null && Number.isFinite(edr);
  const hasHtf = htfScore != null && Number.isFinite(htf);
  if (!hasEdr && !hasHtf) return null;
  if ((hasEdr && edr >= 2) || (hasHtf && htf >= 15)) return "uptrend";
  if ((hasEdr && edr <= -2) || (hasHtf && htf <= -15)) return "downtrend";
  return "transitional";
}

/**
 * Build {index: cycle} from a map of {index: {ema_regime_daily, htf_score}}.
 * Skips indices with no usable data.
 */
export function indexCyclesFromRegimes(regimesByIndex = {}) {
  const out = {};
  for (const idx of CYCLE_INDEXES) {
    const r = regimesByIndex[idx];
    if (!r) continue;
    const c = cycleFromRegime(r.ema_regime_daily, r.htf_score);
    if (c) out[idx] = c;
  }
  return out;
}

const _CYCLE_VAL = { uptrend: 1, transitional: 0, downtrend: -1 };

/**
 * Breadth-aware market cycle from the per-index cycles. Sums uptrend(+1)/
 * transitional(0)/downtrend(-1) across the available indices; >0 -> uptrend,
 * <0 -> downtrend, tie -> transitional. SPY gets a light extra weight so a
 * lone-SPY read still resolves, but breadth (4 of 5 indices) can outvote it.
 * Returns null with no data.
 */
export function breadthAwareMarketCycle(cyclesByIndex = {}, opts = {}) {
  const spyWeight = Number(opts.spyWeight) || 1.5;
  let score = 0;
  let n = 0;
  for (const idx of CYCLE_INDEXES) {
    const c = cyclesByIndex[idx];
    if (!c || !(c in _CYCLE_VAL)) continue;
    const w = idx === "SPY" ? spyWeight : 1;
    score += _CYCLE_VAL[c] * w;
    n++;
  }
  if (n === 0) return null;
  if (score > 0) return "uptrend";
  if (score < 0) return "downtrend";
  return "transitional";
}

/**
 * Resolve a single ticker's effective cycle:
 *   home index (from indexMap) -> its cycle, else the breadth composite fallback.
 * indexMap: { TICKER: "IWM"|"DIA"|"QQQ"|"SPY"|... }
 */
export function resolveTickerCycle(ticker, indexMap, cyclesByIndex = {}, fallbackCycle = null) {
  const sym = String(ticker || "").toUpperCase();
  const home = indexMap && indexMap[sym];
  if (home && cyclesByIndex[home]) {
    return { cycle: cyclesByIndex[home], index: home, source: "home_index" };
  }
  return { cycle: fallbackCycle, index: null, source: fallbackCycle ? "breadth_fallback" : "none" };
}

// ── Trailing-beta ticker→index mapping ──────────────────────────────────────

/** Pearson correlation of two equal-length numeric arrays (null if degenerate). */
export function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 20) return null;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
  mx /= n; my /= n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  if (sxx <= 0 || syy <= 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

/** Log-returns keyed by timestamp from sorted [ts, close] pairs. */
export function logReturnsByTs(sortedTsClose) {
  const r = {};
  for (let i = 1; i < sortedTsClose.length; i++) {
    const p0 = sortedTsClose[i - 1][1], p1 = sortedTsClose[i][1];
    if (p0 > 0 && p1 > 0) r[sortedTsClose[i][0]] = Math.log(p1 / p0);
  }
  return r;
}

/**
 * Pick the best-correlated index for a ticker's returns. Requires the winner to
 * beat SPY by `minEdge` AND clear `minCorr`, else defaults to SPY (so weakly /
 * idiosyncratically correlated names stay on the broad benchmark).
 *
 * @param {Object} tickerRet  {ts: logReturn}
 * @param {Object} indexRet   {INDEX: {ts: logReturn}}
 */
export function bestIndexForTicker(tickerRet, indexRet, opts = {}) {
  const minCorr = opts.minCorr != null ? opts.minCorr : 0.2;
  const minEdge = opts.minEdge != null ? opts.minEdge : 0.03;
  const tsKeys = Object.keys(tickerRet);
  const corrs = {};
  for (const idx of CYCLE_INDEXES) {
    const ir = indexRet[idx];
    if (!ir) continue;
    const common = tsKeys.filter((k) => k in ir);
    const c = pearson(common.map((k) => tickerRet[k]), common.map((k) => ir[k]));
    if (c != null) corrs[idx] = +c.toFixed(3);
  }
  const entries = Object.entries(corrs);
  if (!entries.length) return { index: "SPY", corr: null, corrs };
  entries.sort((a, b) => b[1] - a[1]);
  const [bestIdx, bestCorr] = entries[0];
  const spyCorr = corrs.SPY != null ? corrs.SPY : -Infinity;
  if (bestIdx === "SPY" || bestCorr < minCorr || (bestCorr - spyCorr) < minEdge) {
    return { index: "SPY", corr: corrs.SPY ?? bestCorr, corrs };
  }
  return { index: bestIdx, corr: bestCorr, corrs };
}
