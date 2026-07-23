// Extended-hours (pre-market / after-hours) field builder for timed:prices.
// Prefers TwelveData native extended_* quote fields; applies drift sanity
// before accepting a computed extended print vs today's RTH close.

/** Rescale extended print when vendor leaves a pre/post-split scale mismatch. */
export function reconcileExtendedPrice(displayPrice, nativeExtP) {
  const price = Number(displayPrice);
  const ext = Number(nativeExtP);
  if (!(price > 0 && ext > 0)) return ext;

  const ratio = ext / price;
  const candidates = [ext];
  if (ratio > 8 && ratio < 15) candidates.push(ext / 10);
  if (ratio > 0.06 && ratio < 0.15) candidates.push(ext * 10);

  let best = ext;
  let bestDrift = Math.abs(ext - price) / price;
  for (const c of candidates) {
    if (!(c > 0)) continue;
    const drift = Math.abs(c - price) / price;
    if (drift < bestDrift) {
      best = c;
      bestDrift = drift;
    }
  }
  if (best !== ext && bestDrift <= 0.2) return best;
  return ext;
}

/**
 * Reject obviously unusable extended prints (missing / non-positive).
 * Premarket reversals vs RTH (NOW bounce after a red day) are valid — do not
 * treat opposite-direction AH as stale. Split-scale mismatches are handled by
 * reconcileExtendedPrice(); GS zombies by resolveAhPersistence(pChanged).
 */
export function extendedQuoteLooksStale(displayPrice, useDp, nativeExtP) {
  void useDp;
  if (!(displayPrice > 0) || !(nativeExtP > 0)) return true;
  return false;
}

/**
 * Build ahp/ahdc/ahdp from a vendor snapshot during extended session.
 * Returns zeros when market is open, crypto, or quote fails sanity checks.
 */
export function buildExtendedHoursFields(snap, displayPrice, useDp, marketClosed, isCrypto) {
  if (!marketClosed || isCrypto) return { extP: 0, extDc: 0, extDp: 0 };
  if (!(displayPrice > 0)) return { extP: 0, extDc: 0, extDp: 0 };

  const nativeExtP = Number(snap?.extendedPrice);
  const nativeExtDc = Number(snap?.extendedChange);
  const nativeExtDp = Number(snap?.extendedPercentChange);

  const hasNativeExt = Number.isFinite(nativeExtP) && nativeExtP > 0
    && ((Number.isFinite(nativeExtDc) && nativeExtDc !== 0)
      || (Number.isFinite(nativeExtDp) && nativeExtDp !== 0)
      || Math.abs(nativeExtP - displayPrice) > 0.001);

  if (hasNativeExt) {
    const adjustedExtP = reconcileExtendedPrice(displayPrice, nativeExtP);
    if (Math.abs(adjustedExtP - displayPrice) / displayPrice <= 0.0005) {
      return { extP: 0, extDc: 0, extDp: 0 };
    }
    if (extendedQuoteLooksStale(displayPrice, useDp, adjustedExtP)) {
      return { extP: 0, extDc: 0, extDp: 0 };
    }
    const extP = Math.round(adjustedExtP * 100) / 100;
    const extDc = Math.round((adjustedExtP - displayPrice) * 100) / 100;
    const nativeExtDpUsable = Number.isFinite(nativeExtDp) && nativeExtDp !== 0
      && Math.abs(nativeExtDp) <= 25
      && Math.sign(nativeExtDp) === Math.sign(extDc);
    const extDp = nativeExtDpUsable
      ? Math.round(nativeExtDp * 100) / 100
      : Math.round(((adjustedExtP - displayPrice) / displayPrice) * 10000) / 100;
    return { extP, extDc, extDp };
  }

  return { extP: 0, extDc: 0, extDp: 0 };
}

/** True when timed:prices `p` moved enough to refresh p_ts. */
export function priceFeedPriceChanged(prevP, nextP) {
  const a = Number(prevP);
  const b = Number(nextP);
  if (!(a > 0 && b > 0)) return true;
  return Math.abs(a - b) / a > 0.0005;
}

/** Cached ahp disagrees with today's RTH close by more than 1.5%. */
export function cachedAhpLooksStale(displayPrice, prevAhp) {
  const p = Number(displayPrice);
  const a = Number(prevAhp);
  if (!(p > 0 && a > 0)) return false;
  return Math.abs(p - a) / p > 0.015;
}

/**
 * Decide whether to publish, preserve, or drop ahp/ahdc/ahdp on a KV row.
 * GS @ 1090: when RTH close rolls forward but TwelveData sends no fresh
 * extended tick, blindly keeping prev.ahp leaves last session's close on the
 * EXT line — drop cached AH when `p` moved. When the session close is
 * unchanged, preserve prior AH (including large reverse premkt moves) so a
 * quiet vendor poll does not wipe a live stream print.
 */
export function resolveAhPersistence(prev, ext, displayPrice, marketClosed, pChanged) {
  void displayPrice;
  const { extP = 0, extDc = 0, extDp = 0 } = ext || {};
  if (extDc !== 0 && extP > 0) {
    return { ahp: extP, ahdc: extDc, ahdp: extDp };
  }
  if (!marketClosed || pChanged) {
    return {};
  }
  const out = {};
  if (prev?.ahp !== undefined) out.ahp = prev.ahp;
  if (prev?.ahdc !== undefined) out.ahdc = prev.ahdc;
  if (prev?.ahdp !== undefined) out.ahdp = prev.ahdp;
  return out;
}

/** Strip prior AH keys before merging resolveAhPersistence() output. */
export function stripAhFields(row) {
  if (!row || typeof row !== "object") return {};
  const { ahp, ahdc, ahdp, ...rest } = row;
  return rest;
}

/** True during weekday extended session (4 AM–8 PM ET, market closed). */
export function isExtendedOperatingSession(marketClosed, isWithinOperatingHours) {
  return marketClosed
    && typeof isWithinOperatingHours === "function"
    && isWithinOperatingHours();
}

/** Lightweight overnight REST cadence — 5 min during extended session, else 30 min. */
export function lightweightRestRefreshDue({ utcMinute, nonZeroCount, hasAhData, extendedSession }) {
  if (extendedSession) {
    return nonZeroCount < 10 || !hasAhData || (Number(utcMinute) % 5 === 0);
  }
  return nonZeroCount < 10 || !hasAhData || (Number(utcMinute) % 30 === 0);
}
