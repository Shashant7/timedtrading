import { describe, it, expect } from "vitest";
import {
  formatTrimDeltaPct,
  formatTrimTotalPct,
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
