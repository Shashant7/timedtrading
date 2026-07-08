// Guard: when event-risk would partial-trim a position already past the
// per-trade HARD_LOSS_CAP, skip the trim and let the caller full-exit once.

const DEFAULT_MIN_HOLD_MS = 15 * 60 * 1000;

/**
 * True when trade P&L breaches the hard loss cap and min-hold has elapsed.
 * Mirrors the HARD_LOSS_CAP gate in processTradeSimulation (pct + dollar).
 */
export function isPastHardLossCap({
  pnlPct,
  pnlDollar,
  capPct = 4,
  capDollar = 250,
  entryAgeMs = Infinity,
  minHoldMs = DEFAULT_MIN_HOLD_MS,
} = {}) {
  if (!(Number.isFinite(entryAgeMs) && entryAgeMs >= minHoldMs)) return false;
  if (capPct > 0 && Number.isFinite(pnlPct) && pnlPct <= -Math.abs(capPct)) return true;
  if (capDollar > 0 && Number.isFinite(pnlDollar) && pnlDollar <= -Math.abs(capDollar)) return true;
  return false;
}
