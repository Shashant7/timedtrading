import { describe, it, expect } from "vitest";
import {
  isUpticksPublication,
  parseUpticksChanges,
} from "./upticks-sync.js";

const JUNE_2026_EXCERPT = `
Upticks Additions Delta Air Lines ($DAL – $93.66) Allstate ($ALL – $237.94)
Iron Mountain Inc. ($IRM – $126.31) Upticks Deletions Gilead Sciences ($GILD – $126.34)
Oracle ($ORCL- $146.55) UPTICKS Total Return vs. SPY, Year to Date
Three additions: $DAL, $ALL, $IRM, two subtractions: $GILD, and $ORCL
`;

describe("isUpticksPublication", () => {
  it("matches Upticks monthly title", () => {
    expect(isUpticksPublication("Upticks – June 2026", "")).toBe(true);
  });

  it("matches body with additions/deletions sections", () => {
    expect(isUpticksPublication("Some note", JUNE_2026_EXCERPT)).toBe(true);
  });
});

describe("parseUpticksChanges", () => {
  it("parses June 2026 Upticks additions and deletions", () => {
    const r = parseUpticksChanges(JUNE_2026_EXCERPT);
    expect(r.added.sort()).toEqual(["ALL", "DAL", "IRM"]);
    expect(r.removed.sort()).toEqual(["GILD", "ORCL"]);
  });

  it("returns empty for unrelated text", () => {
    const r = parseUpticksChanges("SPY rallied on CPI beat.");
    expect(r.added).toEqual([]);
    expect(r.removed).toEqual([]);
  });
});
