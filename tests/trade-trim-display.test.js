import { describe, it, expect } from "vitest";
import {
  formatTrimDeltaPct,
  formatTrimTotalPct,
  toTrimPctPoints,
  computeTrimRealized,
  isPhantomTrimRealized,
  buildTrimEconomicsSummary,
  filterMeaningfulTrims,
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
});
