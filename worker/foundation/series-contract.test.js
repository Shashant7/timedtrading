// worker/foundation/series-contract.test.js
import { describe, it, expect } from "vitest";
import {
  intervalMsForTf,
  normalizeBars,
  computeCoverage,
  buildSeriesView,
  checkSeries,
} from "./series-contract.js";

const FIVE_MIN = 5 * 60_000;
function grid(start, n, step = FIVE_MIN) {
  return Array.from({ length: n }, (_, i) => start + i * step);
}
function bar(ts, finalized = true) {
  return { ts, o: 1, h: 2, l: 0.5, c: 1.5, v: 100, finalized };
}

describe("series-contract: intervals + normalize", () => {
  it("maps known intraday TFs and returns null for calendar TFs", () => {
    expect(intervalMsForTf("5")).toBe(FIVE_MIN);
    expect(intervalMsForTf("60")).toBe(60 * 60_000);
    expect(intervalMsForTf("D")).toBeNull();
  });
  it("sorts ascending and de-dupes ts (last write wins)", () => {
    const out = normalizeBars([bar(20), { ...bar(10), c: 9 }, { ...bar(10), c: 5 }]);
    expect(out.map((b) => b.ts)).toEqual([10, 20]);
    expect(out[0].c).toBe(5);
  });
});

describe("series-contract: coverage", () => {
  it("reports full coverage with no gaps", () => {
    const g = grid(0, 5);
    const cov = computeCoverage(g.map((ts) => bar(ts)), g);
    expect(cov).toEqual({ expected: 5, present: 5, gaps: [] });
  });
  it("collapses missing expected bars into contiguous gaps", () => {
    const g = grid(0, 6); // ts 0,5m,10m,15m,20m,25m
    const present = [g[0], g[1], g[4], g[5]].map((ts) => bar(ts)); // missing g[2],g[3]
    const cov = computeCoverage(present, g);
    expect(cov.expected).toBe(6);
    expect(cov.present).toBe(4);
    expect(cov.gaps).toEqual([[g[2], g[3]]]);
  });
  it("returns unknown coverage when no expected grid supplied", () => {
    const cov = computeCoverage([bar(0), bar(5)], null);
    expect(cov.expected).toBeNull();
  });
});

describe("series-contract: buildSeriesView", () => {
  it("is complete only when every expected bar is present", () => {
    const g = grid(0, 4);
    const full = buildSeriesView({ ticker: "aapl", tf: "5", bars: g.map((ts) => bar(ts)), expectedTimestamps: g, asOf: 1000 });
    expect(full.complete).toBe(true);
    expect(full.ticker).toBe("AAPL");
    expect(full.source).toBe("live");

    const gappy = buildSeriesView({ ticker: "AAPL", tf: "5", bars: [bar(g[0]), bar(g[2]), bar(g[3])], expectedTimestamps: g, asOf: 1000 });
    expect(gappy.complete).toBe(false);
  });
  it("is never complete without an expected grid (cannot verify)", () => {
    const v = buildSeriesView({ ticker: "AAPL", tf: "5", bars: [bar(0), bar(5)], asOf: 1 });
    expect(v.complete).toBe(false);
  });
  it("last_finalized_ts ignores the forming bar", () => {
    const g = grid(0, 3);
    const v = buildSeriesView({
      ticker: "AAPL", tf: "5",
      bars: [bar(g[0]), bar(g[1]), bar(g[2], false)],
      expectedTimestamps: g, asOf: 1,
    });
    expect(v.last_finalized_ts).toBe(g[1]);
  });
});

describe("series-contract: checkSeries (consumer guard)", () => {
  const g = grid(0, 10);
  const complete = buildSeriesView({ ticker: "X", tf: "5", bars: g.map((ts) => bar(ts)), expectedTimestamps: g, asOf: 1 });

  it("ok when complete and enough finalized bars", () => {
    expect(checkSeries(complete, { minBars: 10 })).toEqual({ ok: true, reason: null });
  });
  it("blocks on incomplete series", () => {
    const gappy = buildSeriesView({ ticker: "X", tf: "5", bars: [bar(g[0])], expectedTimestamps: g, asOf: 1 });
    expect(checkSeries(gappy, { minBars: 1 }).reason).toBe("series_incomplete");
  });
  it("blocks on insufficient lookback", () => {
    const r = checkSeries(complete, { minBars: 50 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/insufficient_lookback:10\/50/);
  });
  it("excludes the forming bar from the count unless allowForming", () => {
    const g3 = grid(0, 3);
    const v = buildSeriesView({ ticker: "X", tf: "5", bars: [bar(g3[0]), bar(g3[1]), bar(g3[2], false)], expectedTimestamps: g3, asOf: 1 });
    expect(checkSeries(v, { minBars: 3 }).ok).toBe(false);            // only 2 finalized
    expect(checkSeries(v, { minBars: 3, allowForming: true }).ok).toBe(true);
  });
});
