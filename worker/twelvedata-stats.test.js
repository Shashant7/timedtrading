import { describe, it, expect } from "vitest";
import { normalizeTdStatisticsPercent } from "./twelvedata.js";

describe("normalizeTdStatisticsPercent", () => {
  it("scales decimal fractions to percent (TwelveData docs shape)", () => {
    expect(normalizeTdStatisticsPercent(0.375625)).toBe(37.56);
    expect(normalizeTdStatisticsPercent(-0.12)).toBe(-12);
  });

  it("passes through values already in percent form", () => {
    expect(normalizeTdStatisticsPercent(53.358)).toBe(53.36);
  });

  it("handles large fractional multi-bagger returns", () => {
    expect(normalizeTdStatisticsPercent(5.5)).toBe(550);
    expect(normalizeTdStatisticsPercent(15)).toBe(1500);
  });

  it("returns null for non-finite input", () => {
    expect(normalizeTdStatisticsPercent(null)).toBeNull();
    expect(normalizeTdStatisticsPercent("n/a")).toBeNull();
  });
});
