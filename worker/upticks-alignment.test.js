import { describe, it, expect } from "vitest";
import { TT_SELECTED_DEFAULT } from "./focus-tier.js";
import { diffUpticksAlignment, normalizeTickerList } from "./upticks-alignment.js";

// Live KV timed:admin:upticks after Upticks – September 2026 (pub 1555299).
const SEP_2026_UPTICKS = [
  "ALL", "AMGN", "AMZN", "APLD", "BA", "BABA", "BG", "BRK-B", "CRS", "CRWV",
  "CSX", "CVX", "DAL", "DBA", "DDOG", "ETHA", "GEV", "GOOGL", "GS", "JCI",
  "LITE", "MRK", "NVDA", "PH", "PWR", "TSLA", "WMT",
];

describe("upticks alignment", () => {
  it("keeps TT_SELECTED_DEFAULT equal to the September 2026 live list", () => {
    const diff = diffUpticksAlignment(SEP_2026_UPTICKS, [...TT_SELECTED_DEFAULT]);
    expect(diff).toEqual({
      aligned: true,
      live_count: 27,
      code_count: 27,
      missingInCode: [],
      extraInCode: [],
    });
  });

  it("flags a stale August hardcoded set", () => {
    const august = SEP_2026_UPTICKS.filter((t) => !["DDOG", "LITE", "NVDA"].includes(t))
      .concat(["IRM", "MAR", "VLO", "VST"]);
    const diff = diffUpticksAlignment(SEP_2026_UPTICKS, august);
    expect(diff.aligned).toBe(false);
    expect(diff.missingInCode).toEqual(["DDOG", "LITE", "NVDA"]);
    expect(diff.extraInCode).toEqual(["IRM", "MAR", "VLO", "VST"]);
  });

  it("normalizes case and blanks", () => {
    expect(normalizeTickerList([" ddog ", "DDOG", ""])).toEqual(["DDOG"]);
  });
});
