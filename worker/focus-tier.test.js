// worker/focus-tier.test.js
// Covers the 2026-06-13 conviction-signal repair (Part 4, finding 1):
// missing-input components must surface `input_missing` in the breakdown
// instead of silently scoring neutral, and the env-backed ctx.sectorRating
// fallback must be honored.
import { describe, it, expect } from "vitest";
import {
  computeConvictionScore,
  attachFocusListEnv,
  stampFocusConvictionFields,
  TT_SELECTED_DEFAULT,
} from "./focus-tier.js";

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

describe("conviction context overlay", () => {
  it("adds independent quality/theme context on the play side", () => {
    const conv = computeConvictionScore({
      tickerData: {
        ticker: "BE",
        _ticker_type: "growth",
        htf_score: -2.5,
        _cloud_pivot_detect: { fires: true, direction: "LONG" },
        _fair_value: { quality_grade: "A", growth_detected: true, tilt: 1 },
        _compounder: { tier: "growth_elite", eligible: true },
        daily_structure: { e21: 100, e48: 95, e200: 90, pct_above_e21: 2 },
      },
      ctx: { direction: "LONG" },
      historyStats: null,
      ttSelected: new Set(),
      currentGrannyEtfHoldings: null,
      currentUpticks: null,
    });
    expect(conv.breakdown.context.pts).toBe(18);
    expect(conv.breakdown.context.parts.quality).toBe(8);
    expect(conv.breakdown.context.parts.theme_member).toBe(4);
  });
});

describe("conviction overlay lists", () => {
  it("adds +15 curated and +10 live Upticks when lists are attached", () => {
    const conv = computeConvictionScore({
      tickerData: baseTicker({ ticker: "DDOG" }),
      ctx: {},
      historyStats: null,
      ttSelected: TT_SELECTED_DEFAULT,
      currentGrannyEtfHoldings: new Set(["NVDA"]),
      currentUpticks: new Set(["DDOG"]),
    });
    expect(conv.breakdown.bonuses.tt_selected).toBe(15);
    expect(conv.breakdown.bonuses.upticks).toBe(10);
    expect(conv.breakdown.bonuses.granny_etf).toBe(0);
  });

  it("stamps public + internal focus fields after attachFocusListEnv", () => {
    const row = baseTicker({ ticker: "DDOG" });
    attachFocusListEnv(row, {
      _currentUpticks: new Set(["DDOG"]),
      _currentGrannyHoldings: new Set(),
    });
    expect(row._env._currentUpticks.has("DDOG")).toBe(true);
    const conv = computeConvictionScore({
      tickerData: row,
      ctx: {},
      historyStats: null,
      ttSelected: TT_SELECTED_DEFAULT,
      currentGrannyEtfHoldings: row._env._currentGrannyHoldings,
      currentUpticks: row._env._currentUpticks,
    });
    stampFocusConvictionFields(row, conv);
    expect(row.focus_conviction_score).toBe(conv.score);
    expect(row.__focus_conviction_breakdown.bonuses.upticks).toBe(10);
    expect(row.__focus_tier).toBe(conv.tier);
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
