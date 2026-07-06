// worker/runner-peak-trim-ladder.js — progressive trims on post-trim new highs.
//
// SNDK Jul 2026: one 50% trim near +7%, then structure-deferral held the runner
// through a +35% MFE peak and RUNNER_STALE closed well below the high. When price
// makes a new high above the last trim/peak anchor, lock another slice without
// waiting for phase-decline or stale fuse.

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * @returns {null | { newTargetTrimPct: number, bumpPct: number, anchorPx: number, reason: string }}
 */
export function assessRunnerPeakTrimLadder(opts = {}) {
  const cfg = opts.cfg || {};
  const enabled = String(cfg.deep_audit_runner_peak_trim_enabled ?? "true") === "true";
  if (!enabled) return null;

  const openTrade = opts.openTrade;
  const execState = opts.execState || {};
  const pxNow = Number(opts.pxNow);
  const entryPx = Number(opts.entryPx);
  const isLong = opts.isLong !== false;

  const trimmedPct = clamp(Number(openTrade?.trimmedPct ?? openTrade?.trimmed_pct ?? 0), 0, 1);
  if (trimmedPct < 0.01 || !Number.isFinite(pxNow) || pxNow <= 0) return null;

  const minBumpPct = Number(cfg.deep_audit_runner_peak_trim_bump_pct ?? 5.0);
  const addTrimPct = clamp(Number(cfg.deep_audit_runner_peak_trim_add_pct ?? 0.15), 0.05, 0.35);
  const maxTrimPct = clamp(Number(cfg.deep_audit_runner_peak_trim_max_pct ?? 0.85), 0.55, 0.95);

  const anchorPx = Number(execState.lastPeakTrimPx)
    || Number(execState.runnerPeakPrice)
    || Number(openTrade.runnerPeakPrice)
    || Number(openTrade.trim_price)
    || Number(openTrade.trimPrice)
    || entryPx;
  if (!Number.isFinite(anchorPx) || anchorPx <= 0) return null;

  const bumpPct = isLong
    ? ((pxNow - anchorPx) / anchorPx) * 100
    : ((anchorPx - pxNow) / anchorPx) * 100;
  if (bumpPct < minBumpPct) return null;

  const newTargetTrimPct = Math.min(maxTrimPct, trimmedPct + addTrimPct);
  if (newTargetTrimPct <= trimmedPct + 0.005) return null;

  return {
    newTargetTrimPct,
    bumpPct,
    anchorPx,
    reason: "RUNNER_PEAK_TRIM_LADDER",
  };
}
