// Reconcile prev_close / daily change when vendor quote fields disagree
// after a stock split (KLAC 2026-06-11: previous_close split-adjusted but
// close still on pre-split scale → bogus +1029% day change).

/**
 * @returns {{ pc: number, dc: number, dp: number }}
 */
export function reconcileDailyChange(displayPrice, pc, nativeDc, nativeDp) {
  const price = Number(displayPrice);
  let adjPc = Number(pc);
  let dc = Number(nativeDc);
  let dp = Number(nativeDp);

  if (!(price > 0 && adjPc > 0)) {
    return { pc: adjPc, dc, dp };
  }

  const computedDp = ((price - adjPc) / adjPc) * 100;

  // Trust native percent when sane and it disagrees with price/pc math.
  if (Number.isFinite(dp) && dp !== 0 && Math.abs(dp) < 35 && Math.abs(computedDp) > 40) {
    const derivedPc = price / (1 + dp / 100);
    if (derivedPc > 0) {
      adjPc = Math.round(derivedPc * 100) / 100;
      dc = Math.round((price - adjPc) * 100) / 100;
      dp = Math.round(dp * 100) / 100;
      return { pc: adjPc, dc, dp };
    }
  }

  // Split mismatch: prev_close ~10x too small vs display price (forward split day).
  const ratio = price / adjPc;
  if (Math.abs(computedDp) > 40 && ratio > 8 && ratio < 15) {
    const scaledPc = adjPc * 10;
    const scaledDp = ((price - scaledPc) / scaledPc) * 100;
    if (Math.abs(scaledDp) < 30) {
      adjPc = Math.round(scaledPc * 100) / 100;
      dc = Math.round((price - adjPc) * 100) / 100;
      dp = Math.round(scaledDp * 100) / 100;
      return { pc: adjPc, dc, dp };
    }
  }

  // Inverse: display price split-adjusted but prev_close still pre-split.
  if (Math.abs(computedDp) > 40 && ratio > 0.06 && ratio < 0.15) {
    const scaledPc = adjPc / 10;
    const scaledDp = ((price - scaledPc) / scaledPc) * 100;
    if (Math.abs(scaledDp) < 30) {
      adjPc = Math.round(scaledPc * 100) / 100;
      dc = Math.round((price - adjPc) * 100) / 100;
      dp = Math.round(scaledDp * 100) / 100;
      return { pc: adjPc, dc, dp };
    }
  }

  return { pc: adjPc, dc, dp };
}
