import { describe, it, expect } from "vitest";
import {
  liveSpotFromPriceFeedRow,
  liveDayPctFromPriceFeedRow,
  liveDayChgFromPriceFeedRow,
  priorRthCloseFromPriceFeedRow,
  isPriceFeedRowFresh,
  patchBriefIndexPriceProse,
  patchBriefIndexLiveProse,
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

  it("computes gap from ahp and last RTH close when ahdp missing", () => {
    const sparse = { p: 600, pc: 590, ahp: 610, p_ts: now };
    expect(liveDayPctFromPriceFeedRow(sparse, false)).toBeCloseTo(1.67, 2);
    expect(liveDayChgFromPriceFeedRow(sparse, false)).toBe(10);
  });

  it("uses last RTH close (p) not stale pc for SPY overnight gap baseline", () => {
    const spy = { p: 746.77, pc: 741, ahp: 744.73, ahdp: -0.27, p_ts: now };
    expect(priorRthCloseFromPriceFeedRow(spy, false)).toBe(746.77);
    expect(liveDayPctFromPriceFeedRow(spy, false)).toBe(-0.27);
    const sparse = { p: 746.77, pc: 741, ahp: 744.73, p_ts: now };
    expect(liveDayPctFromPriceFeedRow(sparse, false)).toBeCloseTo(-0.27, 2);
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

  it("accepts fresh poll + extended print when q_ts is older than 26h (long weekend)", () => {
    const weekAgo = now - 4 * 24 * 60 * 60 * 1000;
    const row = {
      p: 746.77,
      pc: 741,
      ahp: 724.5,
      ahdp: -2.98,
      t: now - 2 * 60 * 1000,
      q_ts: weekAgo,
      p_ts: weekAgo,
    };
    expect(isPriceFeedRowFresh(row, false, now)).toBe(true);
    expect(liveSpotFromPriceFeedRow(row, false)).toBe(724.5);
    expect(liveDayPctFromPriceFeedRow(row, false)).toBe(-2.98);
  });

  it("patches stale index spot prices in stored prose", () => {
    const content = "QQQ at $712.60 is down -1.73% pre-market while SPY at $744.78 is flat.";
    const patched = patchBriefIndexPriceProse(content, {
      QQQ: { price: 724.12 },
      SPY: { price: 746.05 },
    });
    expect(patched).toContain("QQQ at $724.12");
    expect(patched).toContain("SPY at $746.05");
  });

  it("patches both price and day-change in live prose helper", () => {
    const content = "QQQ at $712.60 is down -1.73% while SPY is +0.86%.";
    const patched = patchBriefIndexLiveProse(content, {
      QQQ: { price: 724.12, dayPct: 1.45 },
      SPY: { price: 746.05, dayPct: -0.11 },
    });
    expect(patched).toContain("$724.12");
    expect(patched).toContain("+1.45%");
    expect(patched).toContain("-0.11%");
  });
});
