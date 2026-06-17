import { describe, expect, it } from "vitest";
import { computeTDSequential } from "./indicators.js";

const DAY = 24 * 60 * 60 * 1000;

function bar(i, close, low = close - 1, high = close + 1) {
  return { ts: i * DAY, o: close, h: high, l: low, c: close, v: 1000 };
}

describe("TD Sequential LuxAlgo lead-up parity", () => {
  it("starts bullish lead-up at 1 on bullish preparation completion", () => {
    const closes = [20, 20, 20, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11];
    const bars = closes.map((c, i) => bar(i, c, c - 2, c + 1));
    const td = computeTDSequential(bars, "D");

    expect(td.bullish_prep_count).toBe(9);
    expect(td.td9_bullish).toBe(true);
    expect(td.bullish_leadup_count).toBe(1);
  });

  it("persists bullish lead-up across non-qualifying bars", () => {
    const closes = [20, 20, 20, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 15];
    const bars = closes.map((c, i) => bar(i, c, c - 2, c + 1));
    const td = computeTDSequential(bars, "D");

    expect(td.bullish_prep_count).toBe(0);
    expect(td.bullish_leadup_count).toBe(1);
  });

  it("starts bearish lead-up at 1 on bearish preparation completion", () => {
    const closes = [10, 10, 10, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19];
    const bars = closes.map((c, i) => bar(i, c, c - 1, c + 2));
    const td = computeTDSequential(bars, "D");

    expect(td.bearish_prep_count).toBe(9);
    expect(td.td9_bearish).toBe(true);
    expect(td.bearish_leadup_count).toBe(1);
  });
});
