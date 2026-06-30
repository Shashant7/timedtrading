import { describe, it, expect } from "vitest";
import {
  buildPremarketGapContext,
  liveSpotFromPriceFeedRow,
  liveDayPctFromPriceFeedRow,
} from "./daily-brief.js";

describe("buildPremarketGapContext session window", () => {
  const pf = {
    SPY: { p: 600, pc: 590, ahp: 600.1, ahdp: 1.71, p_ts: Date.now() },
  };

  it("returns gap context during pre-market (before 9:30 ET)", () => {
    const ctx = buildPremarketGapContext(pf, false, Date.parse("2026-06-30T13:00:00.000Z")); // 9:00 ET
    expect(ctx).toMatch(/pre-market/i);
    expect(ctx).toMatch(/1\.71/);
  });

  it("returns null after the open — ahp vs pc is not a pre-market gap", () => {
    const ctx = buildPremarketGapContext(pf, false, Date.parse("2026-06-30T21:00:00.000Z")); // 5:00 PM ET
    expect(ctx).toBeNull();
  });
});

describe("evening brief RTH session semantics", () => {
  const row = { p: 600.12, pc: 590, dp: 0.19, dc: 1.14, ahp: 610.5, ahdp: 1.71, p_ts: Date.now() };

  it("uses RTH close and dp when sessionOpen=true (evening gather path)", () => {
    expect(liveSpotFromPriceFeedRow(row, true)).toBe(600.12);
    expect(liveDayPctFromPriceFeedRow(row, true)).toBe(0.19);
  });

  it("uses extended print when sessionOpen=false (morning after-hours path)", () => {
    expect(liveSpotFromPriceFeedRow(row, false)).toBe(610.5);
    expect(liveDayPctFromPriceFeedRow(row, false)).toBe(1.71);
  });
});
