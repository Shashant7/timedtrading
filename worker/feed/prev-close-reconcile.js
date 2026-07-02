// Reconcile prev_close / daily change when vendor quote fields disagree
// after a stock split (KLAC 2026-06-11 10:1, MLI 2026-07-01 2:1, CRWD 2026-07-02 4:1).

/** Common split ratios: forward (price/pc > 1) and reverse (price/pc < 1). */
export const SPLIT_RATIOS = [10, 5, 4, 3, 2, 1.5, 0.5, 1 / 3, 0.25, 0.2, 0.1];

/** Wider than 4% — split-day drift can push price a few % off the exact ratio (MLI Jul 2026). */
export const SPLIT_RATIO_MATCH_TOL = 0.10;

/** True when price/prevClose is within tol of a known split ratio. Returns the ratio or 0. */
export function matchSplitRatio(price, prevClose, tol = SPLIT_RATIO_MATCH_TOL) {
  const p = Number(price);
  const pc = Number(prevClose);
  if (!(p > 0 && pc > 0)) return 0;
  const ratio = p / pc;
  for (const r of SPLIT_RATIOS) {
    if (Math.abs(ratio - r) / r < tol) return r;
  }
  return 0;
}

/**
 * Today's open near the live print but far from vendor prev_close — classic
 * split-day pc scale mismatch. Avoids treating a real ~50% crash as a split.
 */
export function isOpenSplitArtifact(price, prevClose, dailyOpen) {
  const p = Number(price);
  const pc = Number(prevClose);
  const open = Number(dailyOpen);
  if (!(p > 0 && pc > 0 && open > 0)) return false;
  return Math.abs(p - pc) / pc > 0.35
    && Math.abs(open - p) / p < 0.08
    && Math.abs(open - pc) / pc > 0.35;
}

function roundSplitResult(scaledPc, p) {
  const adjPc = Math.round(scaledPc * 100) / 100;
  const dc = Math.round((p - adjPc) * 100) / 100;
  const dp = Math.round(((p - adjPc) / adjPc) * 10000) / 100;
  return { pc: adjPc, dc, dp };
}

/**
 * When vendor prev_close is on the wrong side of a split, rescale to split-adjusted pc.
 * @param {number} price
 * @param {number} prevClose
 * @param {{ maxDayPct?: number, dailyOpen?: number }} [opts]
 * @returns {{ pc: number, dc: number, dp: number } | null}
 */
export function adjustPrevCloseForSplit(price, prevClose, opts = {}) {
  const p = Number(price);
  const pc = Number(prevClose);
  const maxDayPct = Number(opts.maxDayPct) > 0 ? Number(opts.maxDayPct) : 25;
  const dailyOpen = Number(opts.dailyOpen);
  const openArtifact = isOpenSplitArtifact(p, pc, dailyOpen);
  if (!(p > 0 && pc > 0)) return null;

  const rawDpAbs = Math.abs(((p - pc) / pc) * 100);
  if (rawDpAbs < 35) return null;

  const ratio = p / pc;

  // KLAC-style decade band: vendor pc one order of magnitude low (ratio ~8–15×).
  if (ratio > 8 && ratio < 15) {
    const scaledPc = pc * 10;
    const scaledDp = ((p - scaledPc) / scaledPc) * 100;
    if (Math.abs(scaledDp) < maxDayPct) {
      return roundSplitResult(scaledPc, p);
    }
  }

  let best = null;
  let bestAbsDp = Infinity;

  const consider = (r) => {
    if (!(r > 0)) return;
    const scaledPc = pc * r;
    if (!(scaledPc > 0)) return;
    const scaledDp = ((p - scaledPc) / scaledPc) * 100;
    const absDp = Math.abs(scaledDp);
    if (absDp >= maxDayPct) return;
    const ratioNear = Math.abs(ratio - r) / r < SPLIT_RATIO_MATCH_TOL;
    if (!ratioNear && !openArtifact) return;
    // Flat ~50% crash matches 0.5× — only reject zero residual on sub-unity ratios.
    if (absDp < 0.5 && !openArtifact && ratio < 1.2) return;
    if (absDp < bestAbsDp) {
      bestAbsDp = absDp;
      best = roundSplitResult(scaledPc, p);
    }
  };

  if (ratio > 8 && ratio < 15) consider(10);
  for (const r of SPLIT_RATIOS) {
    if (r === 10) continue;
    consider(r);
  }

  return best;
}

/**
 * @param {number} displayPrice
 * @param {number} pc
 * @param {number} nativeDc
 * @param {number} nativeDp
 * @param {{ dailyOpen?: number, maxDayPct?: number }} [opts]
 * @returns {{ pc: number, dc: number, dp: number }}
 */
export function reconcileDailyChange(displayPrice, pc, nativeDc, nativeDp, opts = {}) {
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

  // Stock split: vendor prev_close on wrong scale (2:1, 3:1, 4:1, 10:1, reverse, …).
  if (Math.abs(computedDp) > 40) {
    const splitAdj = adjustPrevCloseForSplit(price, adjPc, opts);
    if (splitAdj) return splitAdj;
  }

  return { pc: adjPc, dc, dp };
}
