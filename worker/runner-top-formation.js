// worker/runner-top-formation.js — 1H top-formation exit for trimmed runners.
//
// User feedback (SNDK Jul 2026): after the first trim, SNDK printed a lower
// second top above $2000 with bear RSI divergence + TD prep on the 1H, then
// broke below the 1H 5/12 cloud and the 1H 21 EMA. Those are textbook
// double-top / exhaustion warnings and the runner should have exited at the
// warning bar instead of drifting into RUNNER_STALE hours later.
//
// This module reads the same 1H fields the entry engine and rail already
// consume (tf_tech.1H, rsi_divergence.1H, td_sequential.per_tf.1H) and
// returns an action ({trim | close | hold}) plus the confluence reasons.

const DEFAULT_CFG = Object.freeze({
  minMfePct: 5.0,          // require the runner to have actually run
  minPnlPct: 0.5,          // must still be net green
  minTrimmedPct: 0.01,     // only trimmed runners
  minTdPrep: 7,            // 1H TD prep count that counts as exhaustion warning
  minDivStrength: 2,       // RSI divergence strength floor
  minPeakDropPct: 3.0,     // "lower second top" — dropped this much from post-trim peak
  peakDropPct: 3.0,        // alias for compatibility
  ema21TolPct: 0.15,       // hysteresis around 1H 21 EMA (price must actually break)
  minSignals: 2,           // require confluence (any 2 of 5)
  finalTrimPct: 0.85,      // scale runner down to this on top-formation
  closeAtTrimmedPct: 0.85, // if already >= this trimmed, close remainder
});

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function loadTopFormationCfg(daCfg) {
  const cfg = { ...DEFAULT_CFG };
  if (!daCfg || typeof daCfg !== "object") return cfg;
  const map = {
    deep_audit_runner_top_min_mfe_pct: "minMfePct",
    deep_audit_runner_top_min_pnl_pct: "minPnlPct",
    deep_audit_runner_top_min_td_prep: "minTdPrep",
    deep_audit_runner_top_min_div_strength: "minDivStrength",
    deep_audit_runner_top_peak_drop_pct: "minPeakDropPct",
    deep_audit_runner_top_ema21_tol_pct: "ema21TolPct",
    deep_audit_runner_top_min_signals: "minSignals",
    deep_audit_runner_top_final_trim_pct: "finalTrimPct",
    deep_audit_runner_top_close_at_trimmed_pct: "closeAtTrimmedPct",
  };
  for (const [k, target] of Object.entries(map)) {
    const raw = daCfg[k];
    if (raw == null || raw === "") continue;
    const num = Number(raw);
    if (Number.isFinite(num) && num >= 0) cfg[target] = num;
  }
  return cfg;
}

/**
 * @returns {null | {
 *   action: "close" | "trim" | "hold",
 *   reason: string,
 *   signals: string[],
 *   confluence: number,
 *   pnlPct: number,
 *   mfePct: number,
 *   peakDropPct: number,
 *   newTargetTrimPct: number | null,
 * }}
 */
export function assessRunnerTopFormation(opts = {}) {
  const cfg = { ...DEFAULT_CFG, ...loadTopFormationCfg(opts.daCfg) };
  const openTrade = opts.openTrade || {};
  const execState = opts.execState || {};
  const tickerData = opts.tickerData || {};
  const pxNow = Number(opts.pxNow);
  const entryPx = Number(opts.entryPx || openTrade.entryPrice || openTrade.entry_price);
  const isLong = String(opts.direction || openTrade.direction || "LONG").toUpperCase() !== "SHORT";
  const trimmedPct = clamp(Number(openTrade.trimmedPct ?? openTrade.trimmed_pct ?? 0), 0, 1);

  if (trimmedPct < cfg.minTrimmedPct) return null;
  if (!Number.isFinite(pxNow) || !Number.isFinite(entryPx) || pxNow <= 0 || entryPx <= 0) return null;

  const pnlPct = isLong
    ? ((pxNow - entryPx) / entryPx) * 100
    : ((entryPx - pxNow) / entryPx) * 100;
  if (pnlPct < cfg.minPnlPct) return null;

  const mfeAbs = Math.abs(Number(
    openTrade.maxFavorableExcursion
    ?? openTrade.max_favorable_excursion
    ?? openTrade.mfePct
    ?? 0,
  ));
  if (mfeAbs < cfg.minMfePct) return null;

  // Signal 1 — bearish RSI divergence on 1H (opposite side for shorts)
  const divRow = tickerData?.rsi_divergence?.["1H"] || tickerData?.tf_tech?.["1H"]?.rsiDiv;
  const opposingDiv = isLong ? (divRow?.bear || divRow?.bearish) : (divRow?.bull || divRow?.bullish);
  const divActive = !!opposingDiv?.active && (Number(opposingDiv.strength) || cfg.minDivStrength) >= cfg.minDivStrength;

  // Signal 2 — TD sequential exhaustion on 1H
  const tdRow = tickerData?.td_sequential?.per_tf?.["1H"]
    || tickerData?.td_sequential?.per_tf?.["60"]
    || {};
  const prepCount = isLong
    ? (Number(tdRow.bearish_prep_count) || 0)
    : (Number(tdRow.bullish_prep_count) || 0);
  const td9Done = isLong ? !!tdRow.td9_bearish : !!tdRow.td9_bullish;
  const tdActive = prepCount >= cfg.minTdPrep || td9Done;

  // Signal 3 — 1H 5/12 cloud break
  const c5_12_1H = tickerData?.tf_tech?.["1H"]?.ripster?.c5_12;
  const c512Break = isLong
    ? !!(c5_12_1H?.crossDn || (c5_12_1H?.bear && c5_12_1H?.below))
    : !!(c5_12_1H?.crossUp || (c5_12_1H?.bull && c5_12_1H?.above));

  // Signal 4 — 1H 21 EMA break (price closes on wrong side)
  const tf1H = tickerData?.tf_tech?.["1H"] || tickerData?.tf_tech?.["60"] || {};
  const ema21_1H = Number(
    tf1H?.ema?.ema21
    ?? tf1H?.ema21
    ?? tf1H?.e21,
  );
  const emaTol = ema21_1H > 0 ? ema21_1H * (cfg.ema21TolPct / 100) : 0;
  const ema21Break = Number.isFinite(ema21_1H) && ema21_1H > 0 && (
    isLong ? pxNow < (ema21_1H - emaTol) : pxNow > (ema21_1H + emaTol)
  );

  // Signal 5 — post-trim runner peak lower-high / double-top drop
  const runnerPeak = Number(execState.runnerPeakPrice)
    || Number(openTrade.runnerPeakPrice)
    || Number(execState.lastPeakTrimPx)
    || 0;
  const peakDropPct = runnerPeak > 0
    ? (isLong ? ((runnerPeak - pxNow) / runnerPeak) * 100 : ((pxNow - runnerPeak) / runnerPeak) * 100)
    : 0;
  const peakDrop = runnerPeak > 0 && peakDropPct >= cfg.minPeakDropPct;

  const signals = [];
  if (divActive) signals.push("1h_bear_divergence");
  if (tdActive) signals.push(td9Done ? "1h_td9_sell_setup" : `1h_td_prep_${prepCount}`);
  if (c512Break) signals.push("1h_5_12_cloud_break");
  if (ema21Break) signals.push("1h_21ema_break");
  if (peakDrop) signals.push(`peak_drop_${peakDropPct.toFixed(1)}pct`);

  const confluence = signals.length;
  if (confluence < cfg.minSignals) {
    return { action: "hold", reason: "insufficient_confluence", signals, confluence, pnlPct, mfePct: mfeAbs, peakDropPct, newTargetTrimPct: null };
  }

  const shouldClose = trimmedPct + 1e-6 >= cfg.closeAtTrimmedPct;
  return {
    action: shouldClose ? "close" : "trim",
    reason: "RUNNER_TOP_FORMATION_1H",
    signals,
    confluence,
    pnlPct,
    mfePct: mfeAbs,
    peakDropPct,
    newTargetTrimPct: shouldClose ? null : Math.max(trimmedPct + 0.05, cfg.finalTrimPct),
  };
}

export const RUNNER_TOP_FORMATION_DEFAULTS = DEFAULT_CFG;
