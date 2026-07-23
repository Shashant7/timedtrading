// worker/runner-peak-trim-ladder.js — progressive trims on post-trim new highs.
//
// SNDK Jul 2026: one 50% trim near +7%, then structure-deferral held the runner
// through a +35% MFE peak and RUNNER_STALE closed well below the high. When price
// makes a new high above the last trim/peak anchor, lock another slice without
// waiting for phase-decline or stale fuse.
//
// RTX Jul 23 2026: ladder fired +15% nine seconds after ripster_pdz_mfe_trim
// at the SAME fill ($207.98). Cause: anchor fell through to entry (or a stale
// lower execState.runnerPeakPrice from a prior trade on the symbol) because
// getOpenPositionAsTrade omitted trim_price and entry was an allowed fallback.
// Never treat "already +5% from entry" as a post-trim new high.

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function positiveNum(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Best post-trim reference price (last fill / peak). No entry fallback. */
export function resolveRunnerPeakTrimAnchor({ openTrade, execState, isLong = true } = {}) {
  const trimAnchors = [
    execState?.lastPeakTrimPx,
    openTrade?.trim_price,
    openTrade?.trimPrice,
  ].map(positiveNum).filter((n) => n != null);

  // Last TRIM fill from history (live openTrade from getOpenPositionAsTrade).
  const history = Array.isArray(openTrade?.history) ? openTrade.history : [];
  for (let i = history.length - 1; i >= 0; i--) {
    const ev = history[i];
    if (String(ev?.type || "").toUpperCase() !== "TRIM") continue;
    const px = positiveNum(ev.price);
    if (px != null) {
      trimAnchors.push(px);
      break;
    }
  }

  const peakAnchors = [
    execState?.runnerPeakPrice,
    openTrade?.runnerPeakPrice,
  ].map(positiveNum).filter((n) => n != null);

  if (!trimAnchors.length && !peakAnchors.length) return null;

  // For LONG, a "new high" must clear the highest known post-trim mark.
  // For SHORT, it must undercut the lowest mark. Mixing in a stale LOW peak
  // from a prior trade on the same symbol must not win just because it
  // appears first in an || chain (RTX).
  if (isLong) {
    return Math.max(...trimAnchors, ...peakAnchors);
  }
  return Math.min(...trimAnchors, ...peakAnchors);
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
  const isLong = opts.isLong !== false;

  const trimmedPct = clamp(Number(openTrade?.trimmedPct ?? openTrade?.trimmed_pct ?? 0), 0, 1);
  if (trimmedPct < 0.01 || !Number.isFinite(pxNow) || pxNow <= 0) return null;

  // Cooldown: do not stack on the same print as the first trim (RTX: 8.5s).
  const nowMs = Number(opts.nowMs);
  const lastTrimMs = Number(
    execState.lastTrimMs
    ?? openTrade?.trim_ts
    ?? openTrade?.trimTs
    ?? 0,
  );
  const minMsSinceTrim = Number(
    cfg.deep_audit_runner_peak_trim_min_ms_since_trim
    ?? opts.minMsSinceTrim
    ?? 5 * 60 * 1000,
  );
  if (
    Number.isFinite(nowMs)
    && Number.isFinite(lastTrimMs)
    && lastTrimMs > 0
    && Number.isFinite(minMsSinceTrim)
    && minMsSinceTrim > 0
    && nowMs - lastTrimMs < minMsSinceTrim
  ) {
    return null;
  }

  const minBumpPct = Number(cfg.deep_audit_runner_peak_trim_bump_pct ?? 5.0);
  const addTrimPct = clamp(Number(cfg.deep_audit_runner_peak_trim_add_pct ?? 0.15), 0.05, 0.35);
  const maxTrimPct = clamp(Number(cfg.deep_audit_runner_peak_trim_max_pct ?? 0.85), 0.55, 0.95);

  const anchorPx = resolveRunnerPeakTrimAnchor({ openTrade, execState, isLong });
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
