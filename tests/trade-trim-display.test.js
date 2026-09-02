import { describe, it, expect } from "vitest";
import {
  formatTrimDeltaPct,
  formatTrimTotalPct,
  toTrimPctPoints,
  computeTrimRealized,
  isPhantomTrimRealized,
  buildTrimEconomicsSummary,
  filterMeaningfulTrims,
  resolveRemainingShares,
  resolveTrimmedShares,
  shouldSkipDuplicateTrimLedger,
  humanizeReceiptReason,
  reconcileReceiptEvents,
} from "../worker/trade-trim-display.js";

describe("trade-trim-display", () => {
  it("formats fraction trim sizes as whole percents", () => {
    expect(formatTrimDeltaPct(0.1)).toBe("10%");
    expect(formatTrimDeltaPct(0.5)).toBe("50%");
    expect(formatTrimDeltaPct(0.004)).toBeNull();
  });

  it("formats cumulative trim total", () => {
    expect(formatTrimTotalPct(0.5)).toBe("to 50%");
  });

  it("toTrimPctPoints accepts fractions and legacy percent points (RTX email bug)", () => {
    // Live TRADE_TRIM payload: cumulative trim as 0–1 fraction
    expect(toTrimPctPoints(0.5)).toBe(50);
    expect(toTrimPctPoints(0.01)).toBe(1);
    expect(toTrimPctPoints(1)).toBe(100);
    expect(toTrimPctPoints(0)).toBe(0);
    // Legacy / sample emails already pass 0–100 points
    expect(toTrimPctPoints(50)).toBe(50);
    expect(toTrimPctPoints(1.5)).toBe(2);
    // Remaining display: 100 - points (never 100 - fraction)
    const trimmed = toTrimPctPoints(0.5);
    expect(100 - trimmed).toBe(50);
    // The bug: Math.round(0.5) === 1 and Math.round(100 - 0.5) === 100
    expect(Math.round(0.5)).toBe(1);
    expect(Math.round(100 - 0.5)).toBe(100);
  });

  it("computes SNDK-like trim economics", () => {
    const realized = computeTrimRealized({
      trimPrice: 1447.31,
      entryPrice: 1346,
      deltaFrac: 0.5,
      entryShares: 7,
      direction: "LONG",
    });
    expect(realized).toBeGreaterThan(340);
    expect(realized).toBeLessThan(360);
  });

  it("flags phantom SNDK trim from corrupted entry_price", () => {
    expect(isPhantomTrimRealized({
      storedRealized: 14365.15,
      trimPrice: 1447.31,
      entryPrice: 64.87,
      deltaFrac: 0.5,
      entryShares: 7,
      direction: "LONG",
    })).toBe(true);
  });

  it("buildTrimEconomicsSummary replaces phantom rows and drops no-ops", () => {
    const summary = buildTrimEconomicsSummary({
      entryPrice: 1346,
      entryShares: 7,
      direction: "LONG",
      trims: [
        { ts: 1, price: 1445.63, deltaPct: 0, realized: 0 },
        { ts: 2, price: 1447.31, deltaPct: 0.5, realized: 14365.15 },
        { ts: 3, price: 1452.05, deltaPct: 0.002, realized: 1.74 },
      ],
    });
    expect(filterMeaningfulTrims(summary.trims).length).toBe(2);
    expect(summary.totalRealized).toBeGreaterThan(340);
    expect(summary.totalRealized).toBeLessThan(370);
    const mainTrim = summary.trims.find((t) => t.deltaPct >= 0.1);
    expect(mainTrim.realized).toBeLessThan(360);
  });

  it("remaining shares uses exact math, never integer-round subtract (DKNG)", () => {
    const entry = 40.6038;
    const trimPct = 0.5;
    // The bug: Math.round(40.60) - Math.round(40.60 * 0.5) → 41 - 20 = 21
    expect(Math.round(entry) - Math.round(entry * trimPct)).toBe(21);
    expect(resolveRemainingShares({ entryShares: entry, trimmedPct: trimPct })).toBeCloseTo(20.3019, 4);
    expect(resolveRemainingShares({
      entryShares: entry,
      trimmedPct: trimPct,
      remainingShares: 20.3019,
    })).toBeCloseTo(20.3019, 4);
    expect(resolveTrimmedShares({ entryShares: entry, trimmedPct: trimPct })).toBeCloseTo(20.3019, 4);
  });

  it("skips a second 50% trim when the book is already at target remaining", () => {
    expect(shouldSkipDuplicateTrimLedger({
      liveQty: 20.3019,
      expectedRemaining: 20.3019,
      trimShares: 20.3019,
      entryShares: 40.6038,
    })).toBe(true);
    expect(shouldSkipDuplicateTrimLedger({
      liveQty: 40.6038,
      expectedRemaining: 20.3019,
      trimShares: 20.3019,
      entryShares: 40.6038,
    })).toBe(false);
    expect(shouldSkipDuplicateTrimLedger({
      liveQty: 20.3019,
      expectedRemaining: 8.12,
      trimShares: 12.18,
      entryShares: 40.6038,
    })).toBe(false);
  });

  it("humanizes ledger fill notes instead of repeating qty/price", () => {
    expect(humanizeReceiptReason("MFE_SAFETY_TRIM")).toBe("Profit lock trim");
    expect(humanizeReceiptReason("Trim DKNG 20.3sh @$25.06 PnL=$13.60")).toBe("Partial trim");
    expect(humanizeReceiptReason("Entry SHORT DKNG [Shares] 40.60sh @$25.73")).toBe("Entry");
  });

  it("marks a second original-size trim as a duplicate when the book is still open", () => {
    const rows = reconcileReceiptEvents([
      { type: "ENTRY", shares: 40.60, ts: 1 },
      { type: "TRIM", shares: 20.30, ts: 2 },
      { type: "TRIM", shares: 20.30, ts: 3 },
    ], { bookRemaining: 20.30, isOpen: true });
    expect(rows[1].duplicate).toBe(false);
    expect(rows[1].running_shares).toBeCloseTo(20.30, 2);
    expect(rows[2].duplicate).toBe(true);
    expect(rows[2].running_shares).toBeCloseTo(20.30, 2);
  });
});
