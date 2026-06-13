// worker/focus-tier.test.js
// Covers the 2026-06-13 conviction-signal repair (Part 4, finding 1):
// missing-input components must surface `input_missing` in the breakdown
// instead of silently scoring neutral, and the env-backed ctx.sectorRating
// fallback must be honored.
import { describe, it, expect } from "vitest";
import { computeConvictionScore } from "./focus-tier.js";

function baseTicker(overrides = {}) {
  return {
    ticker: "TEST",
    _ticker_type: "large_cap",
    daily_structure: { e21: 100, e48: 95, e200: 90, pct_above_e21: 2 },
    ...overrides,
  };
}

describe("conviction sector component (Part 4 missing-input repair)", () => {
  it("flags input_missing when no sector data is resolvable anywhere", () => {
    const conv = computeConvictionScore({
      tickerData: baseTicker(),
      ctx: {},
      historyStats: null,
      ttSelected: new Set(),
      currentGrannyEtfHoldings: null,
      currentUpticks: null,
    });
    expect(conv.breakdown.sector.reason).toBe("no_sector_data");
    expect(conv.breakdown.sector.input_missing).toBe(true);
  });

  it("honors the env-backed ctx.sectorRating fallback when _sector_rating is absent", () => {
    const conv = computeConvictionScore({
      tickerData: baseTicker(),
      ctx: { sectorRating: "overweight" },
      historyStats: null,
      ttSelected: new Set(),
      currentGrannyEtfHoldings: null,
      currentUpticks: null,
    });
    expect(conv.breakdown.sector.reason).toBe("sector_overweight");
    expect(conv.breakdown.sector.pts).toBe(15);
    expect(conv.breakdown.sector.input_missing).toBeUndefined();
  });

  it("prefers the per-ticker _sector_rating stamp over ctx", () => {
    const conv = computeConvictionScore({
      tickerData: baseTicker({ _sector_rating: "underweight" }),
      ctx: { sectorRating: "overweight" },
      historyStats: null,
      ttSelected: new Set(),
      currentGrannyEtfHoldings: null,
      currentUpticks: null,
    });
    expect(conv.breakdown.sector.reason).toBe("sector_underweight");
    expect(conv.breakdown.sector.pts).toBe(0);
  });
});

describe("conviction relative-strength component (Part 4 missing-input repair)", () => {
  it("flags input_missing + spy_baseline_missing on the no-data path", () => {
    const conv = computeConvictionScore({
      tickerData: baseTicker({ daily_structure: { e21: 100, e48: 95, e200: 90 } }),
      ctx: {},
      historyStats: null,
      ttSelected: new Set(),
      currentGrannyEtfHoldings: null,
      currentUpticks: null,
    });
    expect(conv.breakdown.relative_strength.input_missing).toBe(true);
    expect(conv.breakdown.relative_strength.spy_baseline_missing).toBe(true);
  });
});
