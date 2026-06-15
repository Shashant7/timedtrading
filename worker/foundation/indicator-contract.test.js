// worker/foundation/indicator-contract.test.js
import { describe, it, expect } from "vitest";
import { defineIndicator, runIndicator } from "./indicator-contract.js";
import { buildSeriesView } from "./series-contract.js";

const FIVE = 5 * 60_000;
const grid = (n) => Array.from({ length: n }, (_, i) => i * FIVE);
const bar = (ts, c, finalized = true) => ({ ts, o: c, h: c, l: c, c, v: 1, finalized });

// A simple SMA(period) indicator written to the contract.
function smaSpec(period) {
  return defineIndicator({
    name: `sma${period}`,
    version: "1.0.0",
    requires: { tf: "5", minBars: period },
    compute: (bars) => {
      const last = bars.slice(-period);
      return last.reduce((s, b) => s + b.c, 0) / last.length;
    },
  });
}

function viewOf(closes, { complete = true, formingLast = false } = {}) {
  const g = grid(closes.length);
  const bars = closes.map((c, i) => bar(g[i], c, !(formingLast && i === closes.length - 1)));
  return buildSeriesView({
    ticker: "X", tf: "5", bars,
    expectedTimestamps: complete ? g : null,
    asOf: 1,
  });
}

describe("indicator-contract", () => {
  it("computes on a complete, sufficiently-long series", () => {
    const r = runIndicator(smaSpec(3), viewOf([2, 4, 6]));
    expect(r.available).toBe(true);
    expect(r.value).toBe(4);
    expect(r.version).toBe("1.0.0");
  });

  it("refuses on an incomplete series (the anti-divergence guarantee)", () => {
    const r = runIndicator(smaSpec(3), viewOf([2, 4, 6], { complete: false }));
    expect(r.available).toBe(false);
    expect(r.reason).toBe("series_incomplete");
    expect(r.value).toBeNull();
  });

  it("refuses on insufficient lookback rather than computing on a short window", () => {
    const r = runIndicator(smaSpec(10), viewOf([2, 4, 6]));
    expect(r.available).toBe(false);
    expect(r.reason).toMatch(/insufficient_lookback/);
  });

  it("excludes the forming bar by default (finalizedOnly)", () => {
    // 4 closes, last is forming → only 3 finalized; SMA(4) must refuse.
    const r = runIndicator(smaSpec(4), viewOf([2, 4, 6, 100], { formingLast: true }));
    expect(r.available).toBe(false);
    expect(r.reason).toMatch(/insufficient_lookback:3\/4/);
  });

  it("flags a tf mismatch", () => {
    const view = { ...viewOf([1, 2, 3]), tf: "30" };
    const r = runIndicator(smaSpec(3), view);
    expect(r.available).toBe(false);
    expect(r.reason).toMatch(/tf_mismatch/);
  });

  it("never throws — a compute error becomes available:false", () => {
    const boom = defineIndicator({
      name: "boom", version: "1.0.0", requires: { tf: "5", minBars: 1 },
      compute: () => { throw new Error("kaboom"); },
    });
    const r = runIndicator(boom, viewOf([1]));
    expect(r.available).toBe(false);
    expect(r.reason).toMatch(/compute_error:kaboom/);
  });

  it("rejects malformed specs at definition time", () => {
    expect(() => defineIndicator({ name: "x", requires: { tf: "5", minBars: 1 } })).toThrow(/version/);
    expect(() => defineIndicator({ name: "x", version: "1", compute: () => 1, requires: { tf: "5", minBars: 0 } })).toThrow(/minBars/);
  });
});
