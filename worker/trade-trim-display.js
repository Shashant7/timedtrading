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

/**
 * Remaining (runner) shares for an open or trimmed trade.
 *
 * Prefer the live book (`positions.total_qty` / `remaining_qty`). Fall back
 * to entry * (1 - trimmed_pct). Never integer-round then subtract:
 *   Math.round(40.60) - Math.round(40.60 * 0.5) → 41 - 20 = 21
 * while the book is 20.30.
 */
export function resolveRemainingShares({
  entryShares,
  trimmedPct,
  remainingShares,
} = {}) {
  const book = Number(remainingShares);
  if (Number.isFinite(book) && book >= 0) return book;
  const entry = Number(entryShares);
  if (!Number.isFinite(entry) || entry <= 0) return null;
  const trim = clamp(Number(trimmedPct) || 0, 0, 1);
  return Math.max(0, entry * (1 - trim));
}

/** Shares already taken off: entry minus remaining. */
export function resolveTrimmedShares({
  entryShares,
  trimmedPct,
  remainingShares,
} = {}) {
  const entry = Number(entryShares);
  const rem = resolveRemainingShares({ entryShares, trimmedPct, remainingShares });
  if (!Number.isFinite(entry) || entry <= 0 || rem == null) return null;
  return Math.max(0, entry - rem);
}

/**
 * Skip a second TRIM ledger write when the position is already at the
 * target remaining size, or the cut is larger than what is still held.
 * DKNG 2026-08-26: two MFE_SAFETY_TRIM rows of original*50% while
 * positions.total_qty stayed at 20.30.
 */
export function shouldSkipDuplicateTrimLedger({
  liveQty,
  expectedRemaining,
  trimShares,
  entryShares,
} = {}) {
  const live = Number(liveQty);
  const shares = Number(entryShares);
  if (!Number.isFinite(live) || live < 0) return false;
  if (!Number.isFinite(shares) || shares <= 0) return false;
  const tol = Math.max(0.05, shares * 0.02);
  const exp = Number(expectedRemaining);
  if (Number.isFinite(exp) && Math.abs(live - exp) <= tol) return true;
  const cut = Number(trimShares);
  if (Number.isFinite(cut) && cut > 0 && live + 1e-6 < cut) return true;
  return false;
}

const RECEIPT_REASON_LABELS = {
  PRE_CPI_RISK_REDUCTION: "Pre-CPI risk reduction",
  PRE_PPI_RISK_REDUCTION: "Pre-PPI risk reduction",
  PRE_FOMC_RISK_REDUCTION: "Pre-FOMC risk reduction",
  PRE_FOMC_RISK_REDUCTION_MATERIAL: "Pre-FOMC risk reduction",
  PRE_PCE_RISK_REDUCTION: "Pre-PCE risk reduction",
  PRE_NFP_RISK_REDUCTION: "Pre-NFP risk reduction",
  PRE_EARNINGS_RISK_REDUCTION: "Pre-earnings risk reduction",
  MFE_SAFETY_TRIM: "Profit lock trim",
  PHASE_LEAVE_100: "Momentum fade trim",
  RUNNER_PEAK_TRAIL: "Peak trail trim",
  PROFIT_PROTECT_TRIM: "Profit protect trim",
  SOFT_FUSE_TRIM: "Momentum weaken trim",
  SOFT_FUSE_CLOUD_TRIM: "Cloud-hold partial trim",
  FAILED_ENTRY_RECLAIM: "Failed entry reclaim",
  MFE_EXTENSION_TRIM: "Extension profit trim",
  REFERENCE_TRIM: "Reference trim",
  Investor_Sell_Accumulate: "Investor sell accumulate",
  investor_sell_accumulate: "Investor sell accumulate",
  auto_entry_accumulate: "Initial accumulate entry",
  dca_pullback: "DCA on pullback",
  replay_dca: "DCA add",
};

/**
 * Receipt / History reason line. Prefer a known engine code. Ledger notes
 * like "Trim DKNG 20.3sh @$25.06 PnL=$13.60" repeat the Shares/Price
 * columns — collapse those to a short verb.
 */
export function humanizeReceiptReason(reason, opts) {
  const raw0 = String(reason || "").trim();
  if (!raw0) return "";
  if (RECEIPT_REASON_LABELS[raw0]) return RECEIPT_REASON_LABELS[raw0];
  if (/^(trim|exit|entry)\b/i.test(raw0) && /(?:\d|sh|shares)\b/i.test(raw0) && /@\s*\$/i.test(raw0)) {
    if (/^trim\b/i.test(raw0)) return "Partial trim";
    if (/^exit\b/i.test(raw0)) return "Exit";
    if (/^entry\b/i.test(raw0)) return "Entry";
  }
  const raw = raw0.replace(/(\d+\.\d{3,})\s*sh\b/gi, (_m, n) => `${Number(n).toFixed(2)}sh`);
  const titled = raw
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
  const max = Number(opts?.max) || 0;
  if (max > 0 && titled.length > max) return titled.slice(0, max - 1) + "…";
  return titled;
}

/**
 * Walk ENTRY/TRIM/EXIT rows and keep running held aligned with the
 * live book. A second TRIM of original*50% that would print held=0
 * while the book is still ~50% is a duplicate receipt, not a flatten.
 */
export function reconcileReceiptEvents(events, {
  bookRemaining,
  isOpen = false,
} = {}) {
  const book = Number(bookRemaining);
  const hasBook = Number.isFinite(book) && book >= 0;
  let running = 0;
  const out = [];
  for (const ev of events || []) {
    const type = String(ev.type || "").toUpperCase();
    const sh = Number(ev.shares) || 0;
    let duplicate = !!ev.duplicate;
    if (Number.isFinite(Number(ev.held_after))) {
      running = Number(ev.held_after);
    } else if (type === "ENTRY" || type === "ADD") {
      running += sh;
    } else if (type === "TRIM" || type === "EXIT") {
      const next = Math.max(0, running - sh);
      if (
        isOpen
        && hasBook
        && book > 0.05
        && type === "TRIM"
        && next + 0.05 < book
      ) {
        duplicate = true;
      } else {
        running = next;
      }
    }
    out.push({
      ...ev,
      running_shares: running,
      duplicate,
    });
  }
  if (hasBook && isOpen && out.length && Math.abs(running - book) > 0.05) {
    running = book;
    out[out.length - 1] = { ...out[out.length - 1], running_shares: book };
  }
  return out;
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
