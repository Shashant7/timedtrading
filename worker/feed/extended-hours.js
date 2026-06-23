// Extended-hours (pre-market / after-hours) field builder for timed:prices.
// Prefers TwelveData native extended_* quote fields; applies drift sanity
// before accepting a computed extended print vs today's RTH close.

/** Reject cached extended_price that disagrees with today's RTH move. */
export function extendedQuoteLooksStale(displayPrice, useDp, nativeExtP) {
  if (!(displayPrice > 0) || !(nativeExtP > 0)) return true;
  const driftPct = ((nativeExtP - displayPrice) / displayPrice) * 100;
  const absDrift = Math.abs(driftPct);
  const dirDisagree = Math.abs(useDp) > 1.5
    && Math.sign(useDp) !== Math.sign(driftPct);
  return absDrift > 8 || (absDrift > 3 && dirDisagree);
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
    if (extendedQuoteLooksStale(displayPrice, useDp, nativeExtP)) {
      return { extP: 0, extDc: 0, extDp: 0 };
    }
    const extP = Math.round(nativeExtP * 100) / 100;
    const extDc = Number.isFinite(nativeExtDc) && nativeExtDc !== 0
      ? Math.round(nativeExtDc * 100) / 100
      : Math.round((nativeExtP - displayPrice) * 100) / 100;
    const extDp = Number.isFinite(nativeExtDp) && nativeExtDp !== 0
      ? Math.round(nativeExtDp * 100) / 100
      : Math.round(((nativeExtP - displayPrice) / displayPrice) * 10000) / 100;
    return { extP, extDc, extDp };
  }

  return { extP: 0, extDc: 0, extDp: 0 };
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
