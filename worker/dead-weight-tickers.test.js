import { describe, it, expect } from "vitest";
import {
  classifyDeadWeightTicker,
  classifyDeadWeightUniverse,
  hasUsableLatestScore,
  isStructuralProxy,
  RECENT_LIVE_TRADE_MS,
  WATCH_IDLE_MS,
} from "./dead-weight-tickers.js";

const NOW = 1_700_000_000_000;

describe("isStructuralProxy", () => {
  it("keeps index, pulse, and sector ETFs", () => {
    expect(isStructuralProxy("spy")).toBe(true);
    expect(isStructuralProxy("XLK")).toBe(true);
    expect(isStructuralProxy("ES1!")).toBe(true);
    expect(isStructuralProxy("TQQQ")).toBe(true);
    expect(isStructuralProxy("AAPL")).toBe(false);
  });
});

describe("hasUsableLatestScore", () => {
  it("requires a real HTF score and a price", () => {
    expect(hasUsableLatestScore({ price: 10, htf_score: 4, sl: 9 })).toBe(true);
    expect(hasUsableLatestScore({ price: 10, htf_score: 0, sl: 9 })).toBe(true);
    expect(hasUsableLatestScore({ price: 10, htf_score: null, sl: 9 })).toBe(false);
    expect(hasUsableLatestScore({ price: 10, htf_score: 4, rank: 3 })).toBe(true);
    expect(hasUsableLatestScore(null)).toBe(false);
  });
});

describe("classifyDeadWeightTicker", () => {
  it("keeps open books, user slots, and proxies", () => {
    expect(classifyDeadWeightTicker({ ticker: "SPY" }, NOW).bucket).toBe("KEEP");
    expect(classifyDeadWeightTicker({ ticker: "FOO", isUserSlot: true }, NOW).reason).toBe("user_slot");
    expect(classifyDeadWeightTicker({ ticker: "ALL", isPriorityPick: true }, NOW).reason).toBe("priority_pick");
    expect(classifyDeadWeightTicker({ ticker: "DDOG", isUptick: true }, NOW).reason).toBe("upticks_overlay");
    expect(isStructuralProxy("TNA")).toBe(true);
    expect(classifyDeadWeightTicker({ ticker: "BAR", openLiveTrades: 1 }, NOW).bucket).toBe("KEEP");
    expect(classifyDeadWeightTicker({ ticker: "BAZ", openInvestor: true }, NOW).reason).toBe("open_investor");
  });

  it("keeps a name that traded in the last 180 days", () => {
    const r = classifyDeadWeightTicker({
      ticker: "NVDA",
      inSectorMap: true,
      hasProfile: true,
      hasUsableScore: true,
      liveTradeCount: 2,
      lastLiveEntryTs: NOW - RECENT_LIVE_TRADE_MS + 1000,
    }, NOW);
    expect(r.bucket).toBe("KEEP");
    expect(r.reason).toMatch(/recent_live_trade/);
  });

  it("watches a healthy core name that never traded", () => {
    const r = classifyDeadWeightTicker({
      ticker: "NKE",
      inSectorMap: true,
      hasProfile: true,
      hasUsableScore: true,
      liveTradeCount: 0,
    }, NOW);
    expect(r).toMatchObject({ bucket: "WATCH", reason: "core_never_traded" });
  });

  it("watches a healthy core name idle for a year", () => {
    const r = classifyDeadWeightTicker({
      ticker: "NKE",
      inSectorMap: true,
      hasProfile: true,
      hasUsableScore: true,
      liveTradeCount: 4,
      lastLiveEntryTs: NOW - WATCH_IDLE_MS - 1000,
    }, NOW);
    expect(r).toMatchObject({ bucket: "WATCH", reason: "core_idle_365d" });
  });

  it("marks unused screener adds and broken orphans as DEAD", () => {
    expect(classifyDeadWeightTicker({
      ticker: "GRNI",
      inSectorMap: false,
      hasProfile: false,
      hasUsableScore: false,
      liveTradeCount: 0,
    }, NOW)).toMatchObject({ bucket: "DEAD", reason: "broken_orphan" });

    expect(classifyDeadWeightTicker({
      ticker: "SKHY",
      inSectorMap: false,
      hasProfile: true,
      hasUsableScore: true,
      liveTradeCount: 0,
    }, NOW)).toMatchObject({ bucket: "WATCH", reason: "registry_never_traded" });
  });

  it("marks a broken core-map name with no trades as DEAD", () => {
    expect(classifyDeadWeightTicker({
      ticker: "SPCX",
      inSectorMap: true,
      hasProfile: false,
      hasUsableScore: false,
      liveTradeCount: 0,
    }, NOW)).toMatchObject({ bucket: "DEAD", reason: "core_broken_onboard" });
  });
});

describe("classifyDeadWeightUniverse", () => {
  it("counts buckets and never implies a delete", () => {
    const report = classifyDeadWeightUniverse([
      { ticker: "SPY" },
      { ticker: "NKE", inSectorMap: true, hasProfile: true, hasUsableScore: true },
      { ticker: "ZZZZ", inSectorMap: false },
    ], NOW);
    expect(report.counts).toEqual({ total: 3, KEEP: 1, WATCH: 1, DEAD: 1 });
    expect(report.byBucket.DEAD[0].ticker).toBe("ZZZZ");
  });
});
