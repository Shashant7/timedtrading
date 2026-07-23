// worker/trade-trim-display.js — trim size labels + realized P&L economics.
//
// qty_pct_delta / qty_pct_total are stored as FRACTIONS (0.10 = 10%), but
// several UIs were rendering Math.round(fraction) → "0%" / "1%". Exit emails
// also summed trade_events.pnl_realized blindly, which included phantom rows
// from corrupted entry_price (SNDK/NFLX May 2026 — see tasks/lessons.md).

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Normalize a trim size to whole percentage points for display.
 *
 * Live TRADE_TRIM alerts pass 0–1 fractions (`0.5` = 50%). Some samples /
 * legacy callers already pass 0–100 points (`50`). Treating a fraction as
 * points produced the RTX bug: Math.round(0.5) → "Trimmed 1%" and
 * Math.round(100 - 0.5) → "Remaining 100%".
 *
 * Convention: values in [0, 1] are fractions; values > 1 are already points.
 * Exactly `1` means fully trimmed (100%), not "1%".
 */
export function toTrimPctPoints(value) {
  const v = Number(value);
  if (!Number.isFinite(v) || v < 0) return null;
  if (v <= 1) return Math.round(v * 100);
  return Math.round(v);
}

/** Display a trim step size stored as a 0–1 fraction (or legacy points). */
export function formatTrimDeltaPct(fraction) {
  const pct = toTrimPctPoints(fraction);
  if (pct == null || pct <= 0) return null;
  return `${pct}%`;
}

/** Display cumulative trimmed fraction ("to 50%"). */
export function formatTrimTotalPct(fraction) {
  const pct = toTrimPctPoints(fraction);
  if (pct == null || pct <= 0) return null;
  return `to ${pct}%`;
}

/** Resolve entry share count from trade row or alert payload. */
export function resolveEntryShares({ entryShares, trimmedPct, remainingShares } = {}) {
  const rem = Number(remainingShares);
  const trimmed = clamp(Number(trimmedPct) || 0, 0, 0.9999);
  if (Number.isFinite(rem) && rem > 0 && trimmed > 0 && trimmed < 1) {
    return rem / (1 - trimmed);
  }
  const direct = Number(entryShares);
  if (Number.isFinite(direct) && direct > 0) return direct;
  return null;
}

/** Expected realized $ for one trim fill. */
export function computeTrimRealized({
  trimPrice,
  entryPrice,
  deltaFrac,
  entryShares,
  direction,
}) {
  const px = Number(trimPrice);
  const entry = Number(entryPrice);
  const delta = Number(deltaFrac);
  const shares = Number(entryShares);
  if (!Number.isFinite(px) || !Number.isFinite(entry) || entry <= 0) return null;
  if (!Number.isFinite(delta) || delta <= 0) return null;
  if (!Number.isFinite(shares) || shares <= 0) return null;
  const isLong = String(direction || "").toUpperCase() !== "SHORT";
  const trimShares = shares * delta;
  return trimShares * (px - entry) * (isLong ? 1 : -1);
}

/** Detect ledger rows written against a bogus entry_price or wild mismatch. */
export function isPhantomTrimRealized({
  storedRealized,
  trimPrice,
  entryPrice,
  deltaFrac,
  entryShares,
  direction,
}) {
  const stored = Number(storedRealized);
  if (!Number.isFinite(stored) || stored === 0) return false;

  const entry = Number(entryPrice);
  const px = Number(trimPrice);
  if (!Number.isFinite(entry) || entry < 0.5) return true;
  if (Number.isFinite(px) && px > 10 && entry / px < 0.2) return true;

  const expected = computeTrimRealized({
    trimPrice,
    entryPrice: entry,
    deltaFrac,
    entryShares,
    direction,
  });

  if (expected == null) {
    return Math.abs(stored) > 500;
  }

  const tolerance = Math.max(50, Math.abs(expected) * 3);
  return Math.abs(stored - expected) > tolerance;
}

/** Drop no-op churn rows (0% delta, ~$0 realized). */
export function filterMeaningfulTrims(trims) {
  if (!Array.isArray(trims)) return [];
  return trims.filter((t) => {
    const delta = Number(t.deltaPct);
    const realized = Number(t.realized);
    const hasSize = Number.isFinite(delta) && delta >= 0.005;
    const hasPnl = Number.isFinite(realized) && Math.abs(realized) >= 1;
    return hasSize || hasPnl;
  });
}

/**
 * Normalize trim rows for display: correct % labels, sanitize phantom P&L,
 * optionally drop no-op events.
 */
export function buildTrimEconomicsSummary({
  trims,
  entryPrice,
  entryShares,
  direction,
  dropNoOps = true,
}) {
  const entryPx = Number(entryPrice);
  const shares = Number(entryShares);
  const hasEntry = Number.isFinite(entryPx) && entryPx > 0;
  const hasShares = Number.isFinite(shares) && shares > 0;
  const isLong = String(direction || "").toUpperCase() !== "SHORT";

  let totalRealized = 0;
  let anyRealized = false;

  const normalized = (trims || []).map((t) => {
    const px = Number(t.price);
    const deltaFrac = Number(t.deltaPct);
    const stored = t.realized != null ? Number(t.realized) : null;

    let gainPct = t.gainPct != null ? Number(t.gainPct) : null;
    if (gainPct == null && hasEntry && Number.isFinite(px) && px > 0) {
      gainPct = ((px - entryPx) / entryPx) * 100 * (isLong ? 1 : -1);
    }

    let realized = stored;
    if (hasEntry && hasShares && Number.isFinite(px) && px > 0) {
      const expected = computeTrimRealized({
        trimPrice: px,
        entryPrice: entryPx,
        deltaFrac,
        entryShares: shares,
        direction,
      });
      if (expected != null) {
        const phantom = stored != null && isPhantomTrimRealized({
          storedRealized: stored,
          trimPrice: px,
          entryPrice: entryPx,
          deltaFrac,
          entryShares: shares,
          direction,
        });
        realized = phantom ? expected : (Number.isFinite(stored) ? stored : expected);
      }
    }

    if (Number.isFinite(realized)) {
      totalRealized += realized;
      anyRealized = true;
    }

    return {
      ...t,
      deltaPct: Number.isFinite(deltaFrac) ? deltaFrac : t.deltaPct,
      gainPct,
      realized: Number.isFinite(realized) ? realized : null,
      deltaPctLabel: formatTrimDeltaPct(deltaFrac),
      totalPctLabel: formatTrimTotalPct(t.totalPct),
    };
  });

  const displayTrims = dropNoOps ? filterMeaningfulTrims(normalized) : normalized;

  return {
    trims: displayTrims,
    totalRealized: anyRealized ? totalRealized : null,
  };
}
