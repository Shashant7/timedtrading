import { describe, it, expect } from "vitest";
import {
  liveSpotFromPriceFeedRow,
  liveDayPctFromPriceFeedRow,
  liveDayChgFromPriceFeedRow,
} from "./daily-brief.js";

describe("daily-brief premarket price helpers", () => {
  const now = Date.now();
  const row = { p: 600.12, pc: 590.0, ahp: 610.5, ahdp: 1.78, ahdc: 10.38, p_ts: now };

  it("uses ahp when market is closed", () => {
    expect(liveSpotFromPriceFeedRow(row, false)).toBe(610.5);
    expect(liveSpotFromPriceFeedRow(row, true)).toBe(600.12);
  });

  it("uses extended day change when market is closed", () => {
    expect(liveDayPctFromPriceFeedRow(row, false)).toBe(1.78);
    expect(liveDayChgFromPriceFeedRow(row, false)).toBe(10.38);
  });

  it("computes gap from ahp and pc when ahdp missing", () => {
    const sparse = { p: 600, pc: 590, ahp: 610, p_ts: now };
    expect(liveDayPctFromPriceFeedRow(sparse, false)).toBeCloseTo(3.39, 2);
    expect(liveDayChgFromPriceFeedRow(sparse, false)).toBe(20);
  });

  it("falls back to RTH fields when market is open", () => {
    const rth = { p: 602, pc: 590, dp: 2.03, dc: 12, ahp: 610, p_ts: now };
    expect(liveSpotFromPriceFeedRow(rth, true)).toBe(602);
    expect(liveDayPctFromPriceFeedRow(rth, true)).toBe(2.03);
    expect(liveDayChgFromPriceFeedRow(rth, true)).toBe(12);
  });

  it("returns null for stale rows without p_ts", () => {
    const stale = { p: 602, pc: 590, dp: 2.03, dc: 12 };
    expect(liveSpotFromPriceFeedRow(stale, true)).toBeNull();
    expect(liveDayPctFromPriceFeedRow(stale, true)).toBeNull();
    expect(liveDayChgFromPriceFeedRow(stale, true)).toBeNull();
  });
});
