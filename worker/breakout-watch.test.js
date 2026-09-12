import { describe, it, expect } from "vitest";
import {
  SETUP_BREAKOUT_KINDS,
  TRENDLINE_FIRE_MIN_RVOL,
  breakoutWatchDeskBadge,
  breakoutWatchLookForEntryCopy,
  breakoutWatchSetupReason,
  computeBarRvol,
  detectSwingPoints,
  detectTrendlineBreak,
  evaluateBreakoutWatch,
  fitVisualTrendline,
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
 * 2-point 7→25 is slope -2/3, line at 31 = 104. Colinear third touch at 16.
 */
function descendingResistanceBars({
  lastClose,
  prevClose = 102.2,
  n = 32,
  lastVol = 1_000_000,
  throughIdx = null,
  throughClose = 106.4,
} = {}) {
  const swingIdx = new Map([[7, 120], [16, 114], [25, 108]]);
  const bars = [];
  for (let i = 0; i < n; i++) {
    let c = 100 - i * 0.04;
    let h = c + 0.7;
    let l = c - 0.7;
    let v = 1_000_000;
    if (swingIdx.has(i)) {
      h = swingIdx.get(i);
      c = h - 1.4;
      l = c - 1.2;
    }
    if (throughIdx != null && i === throughIdx) {
      c = throughClose;
      h = Math.min(throughClose + 0.25, 107.4);
      l = throughClose - 1.2;
      v = 1_500_000;
    }
    if (i === n - 2 && throughIdx !== i) {
      c = prevClose;
      h = prevClose + 0.4;
      l = prevClose - 0.8;
    }
    if (i === n - 1) {
      c = lastClose;
      h = lastClose + 0.5;
      l = lastClose - 1.2;
      v = lastVol;
    }
    bars.push(bar(i, { o: c, h, l, c, v }));
  }
  return bars;
}

function ascendingSupportBars({
  lastClose,
  prevClose = 101.5,
  n = 32,
  lastVol = 1_400_000,
} = {}) {
  const swingIdx = new Map([[7, 80], [16, 86], [25, 92]]);
  const bars = [];
  for (let i = 0; i < n; i++) {
    let c = 104 + i * 0.04;
    let h = c + 0.7;
    let l = c - 0.7;
    let v = 1_000_000;
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
      v = lastVol;
    }
    bars.push(bar(i, { o: c, h, l, c, v }));
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

describe("visual 2-3 touch line", () => {
  it("fits the three colinear descending highs as a 3-touch line", () => {
    const bars = descendingResistanceBars({ lastClose: 102 });
    const { highs } = detectSwingPoints(bars, 2);
    const fit = fitVisualTrendline(highs, {
      side: "resistance",
      lastIdx: bars.length - 1,
      price: 102,
      atr14: 2.2,
    });
    expect(fit).toBeTruthy();
    expect(fit.touches).toBeGreaterThanOrEqual(3);
    expect(fit.line).toBeCloseTo(104, 0);
    expect(fit.slope).toBeLessThan(0);
  });

  it("rejects a pair that another swing pierces", () => {
    const highs = [
      { idx: 6, price: 100 },
      { idx: 12, price: 118 },
      { idx: 20, price: 96 },
    ];
    const fit = fitVisualTrendline(highs, {
      side: "resistance",
      lastIdx: 28,
      price: 95,
      atr14: 2,
    });
    expect(fit).toBeTruthy();
    // 6→20 is pierced by 118, so the visual line is 12→20.
    expect(fit.intercept + fit.slope * 12).toBeCloseTo(118, 0);
  });
});

describe("detectTrendlineBreak", () => {
  it("fires LONG when a volume close breaks the visual resistance line", () => {
    const bars = descendingResistanceBars({
      lastClose: 106.4,
      prevClose: 102.2,
      lastVol: 1_500_000,
    });
    expect(computeBarRvol(bars)).toBeGreaterThan(TRENDLINE_FIRE_MIN_RVOL);
    const hit = detectTrendlineBreak(bars, { price: 106.4, atr14: 2.2 });
    expect(hit).toBeTruthy();
    expect(hit.active).toBe(true);
    expect(hit.promotes_setup).toBe(true);
    expect(hit.dir).toBe("LONG");
    expect(hit.kind).toBe("trendline");
    expect(hit.touches).toBeGreaterThanOrEqual(2);
    expect(hit.reason).toBe("descending_resistance_tl_broke");
  });

  it("does not promote a dead close through the line", () => {
    const bars = descendingResistanceBars({
      lastClose: 106.4,
      prevClose: 102.2,
      lastVol: 400_000,
    });
    const hit = detectTrendlineBreak(bars, { price: 106.4, atr14: 2.2 });
    expect(hit?.active).not.toBe(true);
    expect(hit?.promotes_setup).not.toBe(true);
    expect(hit?.approaching).toBe(true);
    expect(hit?.reason).toBe("tl_through_low_rvol");
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
    const bars = descendingResistanceBars({
      lastClose: 118,
      prevClose: 102.2,
      lastVol: 1_500_000,
    });
    const hit = detectTrendlineBreak(bars, { price: 118, atr14: 2.2 });
    expect(hit?.active).not.toBe(true);
    expect(hit?.promotes_setup).not.toBe(true);
  });

  it("does not fire when the prior close was already through the line", () => {
    const bars = descendingResistanceBars({
      lastClose: 106.4,
      prevClose: 106.1,
      lastVol: 1_500_000,
    });
    const hit = detectTrendlineBreak(bars, { price: 106.4, atr14: 2.2 });
    expect(hit?.active).not.toBe(true);
  });

  it("fires SHORT when a volume close breaks the visual support line", () => {
    const bars = ascendingSupportBars({ lastClose: 94.8, prevClose: 101.6 });
    const hit = detectTrendlineBreak(bars, { price: 94.8, atr14: 2.2 });
    expect(hit).toBeTruthy();
    expect(hit.active).toBe(true);
    expect(hit.dir).toBe("SHORT");
    expect(hit.reason).toBe("ascending_support_tl_broke");
  });

  it("marks a retest after a prior close-through", () => {
    const bars = descendingResistanceBars({
        lastClose: 104.05,
      prevClose: 104.4,
      lastVol: 900_000,
      throughIdx: 27,
      throughClose: 107.1,
    });
    const hit = detectTrendlineBreak(bars, { price: 104.05, atr14: 2.2 });
    expect(hit).toBeTruthy();
    expect(hit.retest).toBe(true);
    expect(hit.promotes_setup).toBe(true);
    expect(hit.active).toBe(false);
    expect(hit.reason).toBe("broken_resistance_retest");
  });

  it("uses a prior broken-line stamp for the retest", () => {
    const bars = descendingResistanceBars({ lastClose: 104.05, prevClose: 104.4 });
    const prior = {
      broken: true,
      dir: "LONG",
      kind: "trendline",
      slope: -2 / 3,
      intercept: 120 - (-2 / 3) * 7,
    };
    const hit = detectTrendlineBreak(bars, {
      price: 104.05,
      atr14: 2.2,
      priorWatch: prior,
    });
    expect(hit?.retest).toBe(true);
    expect(hit?.promotes_setup).toBe(true);
  });

  it("returns null on a quiet grind with no structured swings", () => {
    expect(detectTrendlineBreak(quietGrindBars(), { price: 50.5, atr14: 0.4 })).toBeNull();
  });
});

describe("evaluateBreakoutWatch promotion", () => {
  it("promotes an existing daily-level breakout", () => {
    const watch = evaluateBreakoutWatch({
      dailyBars: quietGrindBars(),
      price: 50.5,
      existingBreakout: { type: "daily_level", dir: "LONG", level: 49.8, rvol: 1.6 },
      atr14: 0.8,
    });
    expect(watch.promotes_setup).toBe(true);
    expect(watch.kind).toBe("daily_level");
  });

  it("does not promote EMA-stack or ATR hits", () => {
    for (const type of ["ema_stack", "atr_breakout"]) {
      const watch = evaluateBreakoutWatch({
        dailyBars: quietGrindBars(),
        price: 50.5,
        existingBreakout: { type, dir: "LONG", rvol: 1.4 },
        atr14: 0.8,
      });
      expect(SETUP_BREAKOUT_KINDS.has(type)).toBe(false);
      expect(watch.promotes_setup).toBe(false);
      expect(watch.informational).toBe(true);
      const ticker = { flags: {} };
      stampBreakoutWatchOnTicker(ticker, watch);
      expect(shouldPromoteBreakoutWatchToSetup(ticker)).toBe(false);
      expect(ticker.flags.breakout_watch).toBe(false);
    }
  });

  it("notes a simultaneous trendline break on a daily-level hit", () => {
    const bars = descendingResistanceBars({
      lastClose: 106.4,
      prevClose: 102.2,
      lastVol: 1_500_000,
    });
    const watch = evaluateBreakoutWatch({
      dailyBars: bars,
      price: 106.4,
      existingBreakout: { type: "daily_level", dir: "LONG", level: 105, rvol: 1.5 },
      atr14: 2.2,
    });
    expect(watch.kind).toBe("daily_level");
    expect(watch.promotes_setup).toBe(true);
    expect(watch.also_trendline).toBe(true);
  });
});

describe("setup promotion and desk copy", () => {
  it("promotes a fired volume trendline and stamps flags", () => {
    const ticker = { ticker: "CRDO", price: 106.4, flags: {} };
    const watch = evaluateBreakoutWatch({
      dailyBars: descendingResistanceBars({
        lastClose: 106.4,
        prevClose: 102.2,
        lastVol: 1_500_000,
      }),
      price: 106.4,
      atr14: 2.2,
    });
    stampBreakoutWatchOnTicker(ticker, watch);
    expect(shouldPromoteBreakoutWatchToSetup(ticker)).toBe(true);
    expect(breakoutWatchSetupReason(ticker)).toBe("breakout_watch:trendline:LONG");
    expect(ticker.flags.breakout_watch).toBe(true);
    expect(breakoutWatchDeskBadge(ticker).label).toBe("Breakout");
    expect(breakoutWatchLookForEntryCopy(watch)).toMatch(/look for a good entry/i);
    expect(breakoutWatchLookForEntryCopy(watch)).not.toMatch(/\byour\b/i);
  });

  it("does not promote an approaching line and exposes a TL Watch badge", () => {
    const ticker = { ticker: "CRDO", price: 103.6, flags: {} };
    const watch = evaluateBreakoutWatch({
      dailyBars: descendingResistanceBars({ lastClose: 103.6, prevClose: 102.8 }),
      price: 103.6,
      atr14: 2.2,
    });
    stampBreakoutWatchOnTicker(ticker, watch);
    expect(watch.approaching).toBe(true);
    expect(shouldPromoteBreakoutWatchToSetup(ticker)).toBe(false);
    expect(ticker.flags.breakout_approaching).toBe(true);
    expect(breakoutWatchDeskBadge(ticker).label).toBe("TL Watch");
    expect(breakoutWatchLookForEntryCopy(watch)).toMatch(/watching for a break/i);
  });

  it("promotes a retest as look-for-entry", () => {
    const ticker = { ticker: "CRDO", price: 104.05, flags: {} };
    const watch = evaluateBreakoutWatch({
      dailyBars: descendingResistanceBars({
        lastClose: 104.05,
        prevClose: 104.4,
        throughIdx: 27,
        throughClose: 107.1,
      }),
      price: 104.05,
      atr14: 2.2,
    });
    stampBreakoutWatchOnTicker(ticker, watch);
    expect(watch.retest).toBe(true);
    expect(shouldPromoteBreakoutWatchToSetup(ticker)).toBe(true);
    expect(breakoutWatchSetupReason(ticker)).toBe("breakout_watch:retest:LONG");
    expect(ticker.flags.breakout_retest).toBe(true);
    expect(breakoutWatchDeskBadge(ticker).label).toBe("Retest");
    expect(breakoutWatchLookForEntryCopy(watch)).toMatch(/retest/i);
  });

  it("does not invent a qualifyEntry / tt_* path name", () => {
    const reason = breakoutWatchSetupReason({
      _breakout_watch: { active: true, promotes_setup: true, dir: "LONG", kind: "trendline" },
    });
    expect(reason.startsWith("breakout_watch:")).toBe(true);
    expect(reason).not.toMatch(/tt_/);
  });

  it("does not promote a leftover ema_stack flag once a watch object exists", () => {
    expect(shouldPromoteBreakoutWatchToSetup({
      _breakout_watch: { active: true, kind: "ema_stack", dir: "LONG", informational: true, promotes_setup: false },
      flags: { breakout_watch: true, breakout_watch_kind: "ema_stack" },
    })).toBe(false);
  });
});
