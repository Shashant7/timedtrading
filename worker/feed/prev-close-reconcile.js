// Reconcile prev_close / daily change when vendor quote fields disagree
// after a stock split (KLAC 2026-06-11 10:1, MLI 2026-07-01 2:1).

/** Common split ratios: forward (price/pc > 1) and reverse (price/pc < 1). */
export const SPLIT_RATIOS = [10, 5, 4, 3, 2, 1.5, 0.5, 1 / 3, 0.25, 0.2, 0.1];

/** True when price/prevClose is within 4% of a known split ratio. Returns the ratio or 0. */
export function matchSplitRatio(price, prevClose) {
  const p = Number(price);
  const pc = Number(prevClose);
  if (!(p > 0 && pc > 0)) return 0;
  const ratio = p / pc;
  for (const r of SPLIT_RATIOS) {
    if (Math.abs(ratio - r) / r < 0.04) return r;
  }
  return 0;
}

/**
 * When vendor prev_close is on the wrong side of a split, rescale to split-adjusted pc.
 * @returns {{ pc: number, dc: number, dp: number } | null}
 */
export function adjustPrevCloseForSplit(price, prevClose, maxDayPct = 25) {
  const p = Number(price);
  const pc = Number(prevClose);
  if (!(p > 0 && pc > 0)) return null;

  const ratio = p / pc;

  // KLAC-style decade band: vendor pc one order of magnitude low (ratio ~8–15×).
  if (ratio > 8 && ratio < 15) {
    const scaledPc = pc * 10;
    const scaledDp = ((p - scaledPc) / scaledPc) * 100;
    if (Math.abs(scaledDp) < maxDayPct) {
      const adjPc = Math.round(scaledPc * 100) / 100;
      return {
        pc: adjPc,
        dc: Math.round((p - adjPc) * 100) / 100,
        dp: Math.round(scaledDp * 100) / 100,
      };
    }
  }

  const r = matchSplitRatio(p, pc);
  if (!r) return null;
  const scaledPc = pc * r;
  if (!(scaledPc > 0)) return null;
  const scaledDp = ((p - scaledPc) / scaledPc) * 100;
  if (Math.abs(scaledDp) >= maxDayPct) return null;
  const adjPc = Math.round(scaledPc * 100) / 100;
  const dc = Math.round((p - adjPc) * 100) / 100;
  const dp = Math.round(scaledDp * 100) / 100;
  return { pc: adjPc, dc, dp };
}

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

  // Stock split: vendor prev_close on wrong scale (2:1, 3:1, 10:1, reverse, …).
  if (Math.abs(computedDp) > 40) {
    const splitAdj = adjustPrevCloseForSplit(price, adjPc);
    if (splitAdj) return splitAdj;
  }

  return { pc: adjPc, dc, dp };
}
