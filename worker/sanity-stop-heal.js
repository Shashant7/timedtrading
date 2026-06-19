/** Stop-distance helpers for sanity-sweep + COO self-heal. */

/** Max drawdown from current price before a protective stop is considered sane. */
export const DEFAULT_MAX_SL_DRAWDOWN_PCT = 20;

/**
 * Compute a tightened protective stop that caps drawdown from current price.
 * Only moves stops in the protective direction (up for LONG, down for SHORT).
 */
export function computeProtectiveStopTighten(direction, price, currentSl, maxDrawdownPct = DEFAULT_MAX_SL_DRAWDOWN_PCT) {
  const px = Number(price);
  if (!(px > 0)) return null;
  const maxDd = Number(maxDrawdownPct) / 100;
  if (!(maxDd > 0 && maxDd < 1)) return null;
  const isLong = String(direction || "").toUpperCase() === "LONG";
  const target = isLong ? px * (1 - maxDd) : px * (1 + maxDd);
  const old = Number(currentSl);
  if (!Number.isFinite(old) || old <= 0) return Math.round(target * 100) / 100;
  if (isLong) return Math.round(Math.max(old, target) * 100) / 100;
  return Math.round(Math.min(old, target) * 100) / 100;
}

/** Drawdown % from current price to stop (positive = distance to trigger). */
export function slDrawdownPct(direction, price, stopLoss) {
  const px = Number(price);
  const sl = Number(stopLoss);
  if (!(px > 0) || !(sl > 0)) return null;
  const isLong = String(direction || "").toUpperCase() === "LONG";
  return isLong ? ((px - sl) / px) * 100 : ((sl - px) / px) * 100;
}

/** Prefer the tighter stop between D1 positions row and live KV trade object. */
export function resolveEffectiveStopLoss(direction, positionSl, tradeSl) {
  const pSl = Number(positionSl);
  const tSl = Number(tradeSl);
  const isLong = String(direction || "").toUpperCase() === "LONG";
  if (Number.isFinite(pSl) && pSl > 0 && Number.isFinite(tSl) && tSl > 0) {
    return isLong ? Math.max(pSl, tSl) : Math.min(pSl, tSl);
  }
  if (Number.isFinite(tSl) && tSl > 0) return tSl;
  if (Number.isFinite(pSl) && pSl > 0) return pSl;
  return null;
}
