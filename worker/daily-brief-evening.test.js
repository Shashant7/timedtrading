import { describe, it, expect } from "vitest";
import {
  buildPremarketGapContext,
  liveSpotFromPriceFeedRow,
  liveDayPctFromPriceFeedRow,
  patchBriefIndexDayPctProse,
  formatIndexSessionGroundTruthBlock,
  priorRthCloseFromPriceFeedRow,
} from "./daily-brief.js";

describe("buildPremarketGapContext session window", () => {
  const pf = {
    SPY: { p: 600, pc: 590, ahp: 610.5, ahdp: 1.75, p_ts: Date.now() },
  };

  it("returns gap context during pre-market (before 9:30 ET)", () => {
    const ctx = buildPremarketGapContext(pf, false, Date.parse("2026-06-30T13:00:00.000Z")); // 9:00 ET
    expect(ctx).toMatch(/pre-market/i);
    expect(ctx).toMatch(/610\.50/);
  });

  it("returns null after the open — ahp vs pc is not a pre-market gap", () => {
    const ctx = buildPremarketGapContext(pf, false, Date.parse("2026-06-30T21:00:00.000Z")); // 5:00 PM ET
    expect(ctx).toBeNull();
  });

  it("anchors gap on last RTH close (p) when pc lags one session", () => {
    const stalePc = {
      SPY: { p: 746.77, pc: 741, ahp: 750.5, p_ts: Date.now() },
    };
    const ctx = buildPremarketGapContext(stalePc, false, Date.parse("2026-07-02T13:00:00.000Z"));
    expect(ctx).toMatch(/746\.77/);
    expect(ctx).not.toMatch(/741\.00/);
    expect(priorRthCloseFromPriceFeedRow(stalePc.SPY, false)).toBe(746.77);
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

describe("patchBriefIndexDayPctProse", () => {
  it("rewrites stale gap percentages in evening recap prose", () => {
    const moves = { SPY: { dayPct: 0.78 }, QQQ: { dayPct: 1.70 }, IWM: { dayPct: 0.50 } };
    const raw = "QQQ +2.49% and SPY +1.65% ripped higher while IWM -0.29% lagged.";
    const out = patchBriefIndexDayPctProse(raw, moves);
    expect(out).toContain("QQQ +1.70%");
    expect(out).toContain("SPY +0.78%");
    expect(out).toContain("IWM +0.50%");
  });

  it("leaves percentages already matching ground truth", () => {
    const moves = { SPY: { dayPct: 0.78 } };
    const raw = "SPY +0.78% closed firm.";
    expect(patchBriefIndexDayPctProse(raw, moves)).toBe(raw);
  });
});

describe("formatIndexSessionGroundTruthBlock", () => {
  it("emits mandatory ground-truth lines for evening", () => {
    const block = formatIndexSessionGroundTruthBlock({
      SPY: { dayPct: 0.78, price: 741.47 },
      QQQ: { dayPct: 1.70, price: 723.52 },
    }, { type: "evening" });
    expect(block).toMatch(/GROUND TRUTH/);
    expect(block).toContain("SPY: +0.78%");
    expect(block).toContain("QQQ: +1.70%");
  });
});
