import { describe, it, expect } from "vitest";
import {
  breakoutWatchLookForEntryCopy,
  breakoutWatchSetupReason,
  detectSwingPoints,
  detectTrendlineBreak,
  evaluateBreakoutWatch,
  fitTrendline,
  shouldPromoteBreakoutWatchToSetup,
  stampBreakoutWatchOnTicker,
} from "./breakout-watch.js";

const DAY = 86400000;
const START = Date.UTC(2026, 0, 2);

function bar(i, { o, h, l, c, v = 1_000_000 } = {}) {
  return { ts: START + i * DAY, o, h, l, c, v };
}

/**
 * Descending resistance: swing highs at 7 / 16 / 25 of 120, 114, 108.
 * Regression is exactly slope -0.6667, intercept ~124.67, line at 31 ~104.00.
 */
function descendingResistanceBars({ lastClose, prevClose = 102.2, n = 32 } = {}) {
  const swingIdx = new Map([[7, 120], [16, 114], [25, 108]]);
  const bars = [];
  for (let i = 0; i < n; i++) {
    let c = 100 - i * 0.04;
    let h = c + 0.7;
    let l = c - 0.7;
    if (swingIdx.has(i)) {
      h = swingIdx.get(i);
      c = h - 1.4;
      l = c - 1.2;
    }
    if (i === n - 2) {
      c = prevClose;
      h = prevClose + 0.4;
      l = prevClose - 0.8;
    }
    if (i === n - 1) {
      c = lastClose;
      h = lastClose + 0.5;
      l = lastClose - 1.2;
    }
    bars.push(bar(i, { o: c, h, l, c }));
  }
  return bars;
}

/**
 * Ascending support: swing lows at 7 / 16 / 25 of 80, 86, 92.
 * Mirror of the resistance fixture.
 */
function ascendingSupportBars({ lastClose, prevClose = 101.5, n = 32 } = {}) {
  const swingIdx = new Map([[7, 80], [16, 86], [25, 92]]);
  const bars = [];
  for (let i = 0; i < n; i++) {
    let c = 104 + i * 0.04;
    let h = c + 0.7;
    let l = c - 0.7;
    if (swingIdx.has(i)) {
      l = swingIdx.get(i);
      c = l + 1.4;
      h = c + 1.2;
    }
    if (i === n - 2) {
      c = prevClose;
      h = prevClose + 0.8;
      l = prevClose - 0.4;
    }
    if (i === n - 1) {
      c = lastClose;
      h = lastClose + 1.2;
      l = lastClose - 0.5;
    }
    bars.push(bar(i, { o: c, h, l, c }));
  }
  return bars;
}

function quietGrindBars(n = 24) {
  const bars = [];
  for (let i = 0; i < n; i++) {
    const c = 50 + i * 0.02;
    bars.push(bar(i, { o: c, h: c + 0.15, l: c - 0.15, c }));
  }
  return bars;
}

describe("swing + regression (rail parity)", () => {
  it("fits a two-point descending line", () => {
    const fit = fitTrendline([
      { idx: 7, price: 120 },
      { idx: 25, price: 108 },
    ]);
    expect(fit.slope).toBeCloseTo(-12 / 18, 6);
    expect(fit.intercept + fit.slope * 7).toBeCloseTo(120, 6);
  });

  it("marks the planted swing highs", () => {
    const bars = descendingResistanceBars({ lastClose: 102 });
    const { highs } = detectSwingPoints(bars, 2);
    const idxs = highs.map((h) => h.idx);
    expect(idxs).toContain(7);
    expect(idxs).toContain(16);
    expect(idxs).toContain(25);
  });
});

describe("detectTrendlineBreak", () => {
  it("fires LONG when the close breaks a descending resistance line", () => {
    const bars = descendingResistanceBars({ lastClose: 106.4, prevClose: 102.2 });
    const hit = detectTrendlineBreak(bars, { price: 106.4, atr14: 2.2 });
    expect(hit).toBeTruthy();
    expect(hit.active).toBe(true);
    expect(hit.approaching).toBe(false);
    expect(hit.dir).toBe("LONG");
    expect(hit.kind).toBe("trendline");
    expect(hit.reason).toBe("descending_resistance_tl_broke");
    expect(hit.touches).toBeGreaterThanOrEqual(2);
    expect(hit.line).toBeGreaterThan(100);
    expect(hit.line).toBeLessThan(106.4);
  });

  it("stays approaching when price is under the resistance line", () => {
    const bars = descendingResistanceBars({ lastClose: 103.6, prevClose: 102.8 });
    const hit = detectTrendlineBreak(bars, { price: 103.6, atr14: 2.2 });
    expect(hit).toBeTruthy();
    expect(hit.active).toBe(false);
    expect(hit.approaching).toBe(true);
    expect(hit.dir).toBe("LONG");
    expect(hit.reason).toBe("approaching_resistance_tl");
  });

  it("does not fire when the break is already several ATR late", () => {
    const bars = descendingResistanceBars({ lastClose: 118, prevClose: 102.2 });
    const hit = detectTrendlineBreak(bars, { price: 118, atr14: 2.2 });
    expect(hit?.active).not.toBe(true);
  });

  it("does not fire when the prior close was already through the line", () => {
    const bars = descendingResistanceBars({ lastClose: 106.4, prevClose: 106.1 });
    const hit = detectTrendlineBreak(bars, { price: 106.4, atr14: 2.2 });
    expect(hit?.active).not.toBe(true);
  });

  it("fires SHORT when the close breaks an ascending support line", () => {
    const bars = ascendingSupportBars({ lastClose: 94.8, prevClose: 101.6 });
    const hit = detectTrendlineBreak(bars, { price: 94.8, atr14: 2.2 });
    expect(hit).toBeTruthy();
    expect(hit.active).toBe(true);
    expect(hit.dir).toBe("SHORT");
    expect(hit.kind).toBe("trendline");
    expect(hit.reason).toBe("ascending_support_tl_broke");
  });

  it("returns null on a quiet grind with no structured swings", () => {
    expect(detectTrendlineBreak(quietGrindBars(), { price: 50.5, atr14: 0.4 })).toBeNull();
  });

  it("returns null without enough bars", () => {
    expect(detectTrendlineBreak(quietGrindBars(8), { price: 50 })).toBeNull();
  });
});

describe("evaluateBreakoutWatch", () => {
  it("uses an existing daily-level breakout as a fired watch", () => {
    const watch = evaluateBreakoutWatch({
      dailyBars: quietGrindBars(),
      price: 50.5,
      existingBreakout: { type: "daily_level", dir: "LONG", level: 49.8, rvol: 1.6 },
      atr14: 0.8,
    });
    expect(watch.active).toBe(true);
    expect(watch.kind).toBe("daily_level");
    expect(watch.dir).toBe("LONG");
    expect(watch.reason).toBe("level_breakout:daily_level");
    expect(watch.also_trendline).toBe(false);
  });

  it("keeps the level kind and notes a simultaneous trendline break", () => {
    const bars = descendingResistanceBars({ lastClose: 106.4, prevClose: 102.2 });
    const watch = evaluateBreakoutWatch({
      dailyBars: bars,
      price: 106.4,
      existingBreakout: { type: "atr_breakout", dir: "LONG", rvol: 1.4 },
      atr14: 2.2,
    });
    expect(watch.active).toBe(true);
    expect(watch.kind).toBe("atr_breakout");
    expect(watch.also_trendline).toBe(true);
    expect(watch.trendline.reason).toBe("descending_resistance_tl_broke");
  });

  it("returns a trendline-only watch when detectBreakout is null", () => {
    const bars = descendingResistanceBars({ lastClose: 106.4, prevClose: 102.2 });
    const watch = evaluateBreakoutWatch({
      dailyBars: bars,
      price: 106.4,
      existingBreakout: null,
      atr14: 2.2,
    });
    expect(watch.kind).toBe("trendline");
    expect(watch.active).toBe(true);
  });
});

describe("setup promotion (watch only — not an entry path)", () => {
  it("promotes a fired watch and stamps flags", () => {
    const ticker = { ticker: "CRDO", price: 106.4, state: "HTF_BEAR_LTF_BEAR", flags: {} };
    const watch = evaluateBreakoutWatch({
      dailyBars: descendingResistanceBars({ lastClose: 106.4, prevClose: 102.2 }),
      price: 106.4,
      atr14: 2.2,
    });
    stampBreakoutWatchOnTicker(ticker, watch);
    expect(shouldPromoteBreakoutWatchToSetup(ticker)).toBe(true);
    expect(breakoutWatchSetupReason(ticker)).toBe("breakout_watch:trendline:LONG");
    expect(ticker.flags.breakout_watch).toBe(true);
    expect(breakoutWatchLookForEntryCopy(watch)).toMatch(/look for a good entry/i);
    expect(breakoutWatchLookForEntryCopy(watch)).not.toMatch(/\byour\b/i);
  });

  it("does not promote an approaching line", () => {
    const ticker = { ticker: "CRDO", price: 103.6, flags: {} };
    const watch = evaluateBreakoutWatch({
      dailyBars: descendingResistanceBars({ lastClose: 103.6, prevClose: 102.8 }),
      price: 103.6,
      atr14: 2.2,
    });
    stampBreakoutWatchOnTicker(ticker, watch);
    expect(watch.approaching).toBe(true);
    expect(shouldPromoteBreakoutWatchToSetup(ticker)).toBe(false);
    expect(breakoutWatchSetupReason(ticker)).toBeNull();
    expect(ticker.flags.breakout_watch).toBe(false);
  });

  it("promotes when only flags.breakout_watch is set", () => {
    expect(shouldPromoteBreakoutWatchToSetup({
      ticker: "CRDO",
      flags: { breakout_watch: true },
    })).toBe(true);
  });

  it("does not invent a qualifyEntry / tt_* path name", () => {
    const reason = breakoutWatchSetupReason({
      _breakout_watch: { active: true, dir: "LONG", kind: "trendline" },
    });
    expect(reason.startsWith("breakout_watch:")).toBe(true);
    expect(reason).not.toMatch(/tt_/);
  });
});
