// worker/runner-stale-policy.js — RUNNER_STALE_FORCE_CLOSE anchor + hot defer.
//
// Trimmed runners used to linger indefinitely (pullback support shield).
// RUNNER_STALE_FORCE_CLOSE added a 120 market-hour fuse from lastTrimMs, but
// SNDK Jul 2026 showed two gaps:
//   1. runnerPeakTs was tracked later in the tick than the fuse — new highs
//      did not reset the stale clock before force-close fired.
//   2. Hot-sector / momentum-elite runners with strong MFE had no defer path.

/** Ratchet post-trim peak price + timestamp (call BEFORE stale fuse). */
export function ratchetRunnerPeak(execState, openTrade, mark, direction, now) {
  const dir = String(direction || "").toUpperCase();
  const trimmedPct = Number(openTrade?.trimmedPct ?? openTrade?.trimmed_pct ?? 0);
  if (!(trimmedPct > 0) || !Number.isFinite(mark) || mark <= 0) {
    return { updated: false, execState, openTrade };
  }

  const prevPeak = Number(execState?.runnerPeakPrice) || Number(openTrade?.runnerPeakPrice) || 0;
  const newPeak = dir === "LONG"
    ? Math.max(prevPeak, mark)
    : (prevPeak > 0 ? Math.min(prevPeak, mark) : mark);

  if (newPeak === prevPeak && Number(execState?.runnerPeakTs || openTrade?.runnerPeakTs)) {
    return { updated: false, execState, openTrade };
  }

  const nextExec = { ...(execState || {}) };
  const nextTrade = openTrade || {};
  if (newPeak !== prevPeak && newPeak > 0) {
    nextExec.runnerPeakPrice = newPeak;
    nextTrade.runnerPeakPrice = newPeak;
    nextExec.runnerPeakTs = now;
    nextTrade.runnerPeakTs = now;
  } else if (!nextExec.runnerPeakTs) {
    nextExec.runnerPeakTs = now;
    nextTrade.runnerPeakTs = now;
  }

  return { updated: true, execState: nextExec, openTrade: nextTrade };
}

/** Normalize epoch seconds or ms to ms. */
function toEpochMs(ts) {
  const n = Number(ts) || 0;
  if (n <= 0) return 0;
  return n >= 1e11 ? n : n * 1000;
}

/** Millisecond anchor for stale-runner clock — extends on new highs via runnerPeakTs. */
export function runnerStaleAnchorMs(execState, openTrade) {
  const trimMs = toEpochMs(execState?.lastTrimMs || openTrade?.trim_ts || openTrade?.entry_ts || 0);
  const peakMs = toEpochMs(execState?.runnerPeakTs || openTrade?.runnerPeakTs || 0);
  return Math.max(trimMs || 0, peakMs || 0);
}

/**
 * Defer RUNNER_STALE when sector/theme is hot, MFE strong, runner still green,
 * and HTF trend intact. Capped so deferral cannot revive multi-month zombies.
 */
export function assessRunnerStaleDefer({
  openTrade,
  tickerData,
  pxNow,
  entryPx,
  isLong,
  holdHours,
  limitHours,
  htfIntact = false,
}) {
  const cfg = tickerData?._env?._deepAuditConfig || {};
  if (String(cfg.deep_audit_runner_stale_hot_defer_enabled ?? "true") === "false") {
    return { defer: false };
  }

  const mfePct = Number(
    openTrade?.maxFavorableExcursion
    ?? openTrade?.max_favorable_excursion
    ?? openTrade?.mfePct,
  ) || 0;
  const minMfe = Number(cfg.deep_audit_runner_stale_hot_mfe_min_pct) || 15;
  const minUnreal = Number(cfg.deep_audit_runner_stale_hot_unreal_min_pct) || 5;
  const minTilt = Number(cfg.deep_audit_runner_stale_hot_theme_tilt_min) || 2;
  const maxDeferHours = Number(cfg.deep_audit_runner_stale_hot_max_defer_hours) || limitHours;

  const themeTilt = Number(tickerData?._theme_tilt) || 0;
  const momentumElite = !!tickerData?.flags?.momentum_elite;
  const sectorRiskOn = tickerData?.market_internals?.sector_rotation?.state === "risk_on";
  const hotSector = momentumElite || themeTilt >= minTilt || sectorRiskOn;

  const unrealPct = entryPx > 0 && Number.isFinite(pxNow)
    ? ((pxNow - entryPx) / entryPx * 100 * (isLong ? 1 : -1))
    : 0;

  if (!hotSector || mfePct < minMfe || unrealPct < minUnreal || !htfIntact) {
    return { defer: false };
  }

  if (Number.isFinite(holdHours) && Number.isFinite(limitHours)
      && holdHours >= limitHours + maxDeferHours) {
    return { defer: false, reason: "hot_defer_cap_reached" };
  }

  return {
    defer: true,
    reason: `hot_runner mfe=${mfePct.toFixed(0)}% unreal=${unrealPct.toFixed(0)}% elite=${momentumElite ? 1 : 0} tilt=${themeTilt.toFixed(1)}`,
  };
}
