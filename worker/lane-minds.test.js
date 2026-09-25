// worker/lane-minds.test.js
import { describe, it, expect } from "vitest";
import {
  LANE_MINDS,
  laneMind,
  dayTradeEntryBlock,
  dayTradeSessionReentryBlock,
  dayTradeStopStreakKey,
  dayTradeSessionRoundsKey,
  dayTradeSideFromFlavor,
  normalizeDayLean,
  nySessionDayKey,
} from "./lane-minds.js";

describe("laneMind", () => {
  it("maps aliases onto the three minds", () => {
    expect(laneMind("index_dt")).toBe(LANE_MINDS.day_trade);
    expect(laneMind("trader")).toBe(LANE_MINDS.short_term);
    expect(laneMind("investor")).toBe(LANE_MINDS.investor);
    expect(laneMind("nope")).toBeNull();
  });
});

describe("dayTradeEntryBlock", () => {
  it("stands down after max session stops", () => {
    expect(dayTradeEntryBlock({ sessionStopCount: 2 })).toBeNull();
    expect(dayTradeEntryBlock({ sessionStopCount: 3 })).toBe("session_stop_stand_down");
    expect(dayTradeEntryBlock({ sessionStopCount: 5 })).toBe("session_stop_stand_down");
  });

  it("does not share portfolio risk with Short Term", () => {
    expect(LANE_MINDS.day_trade.shares_portfolio_risk).toBe(false);
    expect(LANE_MINDS.short_term.shares_portfolio_risk).toBe(true);
    expect(LANE_MINDS.short_term.ignore_dt_clock).toBe(true);
    expect(LANE_MINDS.investor.ignore_dt_clock).toBe(true);
  });

  it("enables one-round-per-side and post-profit-lock gates", () => {
    expect(LANE_MINDS.day_trade.one_round_per_side).toBe(true);
    expect(LANE_MINDS.day_trade.block_rebuy_after_green_profit_lock).toBe(true);
  });
});

describe("dayTradeSessionReentryBlock", () => {
  const now = Date.parse("2026-09-25T18:00:00Z");

  it("blocks a second put when lean has not flipped", () => {
    expect(dayTradeSessionReentryBlock({
      side: "put",
      leanNow: "bear",
      sessionRounds: [{ side: "put", lean: "bear" }],
      now,
    })).toBe("one_round_per_side_today");
  });

  it("allows the second put when lean flipped bull→bear or bear→bull", () => {
    expect(dayTradeSessionReentryBlock({
      side: "put",
      leanNow: "bull",
      sessionRounds: [{ side: "put", lean: "bear" }],
      now,
    })).toBeNull();
  });

  it("allows a call after a put the same day (different side)", () => {
    expect(dayTradeSessionReentryBlock({
      side: "call",
      leanNow: "bull",
      sessionRounds: [{ side: "put", lean: "bear" }],
      now,
    })).toBeNull();
  });

  it("blocks re-buy after a green profit_lock_stop the same NY day", () => {
    expect(dayTradeSessionReentryBlock({
      side: "call",
      leanNow: "bull",
      sessionRounds: [],
      lastClose: { reason: "profit_lock_stop", green: true, ts: now - 30 * 60_000 },
      now,
    })).toBe("post_profit_lock_no_rebuy");
  });

  it("does not block after a red profit_lock or a premium_stop", () => {
    expect(dayTradeSessionReentryBlock({
      side: "call",
      leanNow: "bull",
      lastClose: { reason: "profit_lock_stop", green: false, ts: now - 30 * 60_000 },
      now,
    })).toBeNull();
    expect(dayTradeSessionReentryBlock({
      side: "call",
      leanNow: "bull",
      lastClose: { reason: "premium_stop", green: false, ts: now - 30 * 60_000 },
      now,
    })).toBeNull();
  });
});

describe("dayTradeSideFromFlavor / normalizeDayLean", () => {
  it("normalizes flavors and leans", () => {
    expect(dayTradeSideFromFlavor("PUT")).toBe("put");
    expect(dayTradeSideFromFlavor("long_call")).toBe("call");
    expect(normalizeDayLean("Bearish")).toBe("bear");
    expect(normalizeDayLean("bull")).toBe("bull");
  });
});

describe("dayTradeStopStreakKey", () => {
  it("scopes by ticker and NY session day", () => {
    const key = dayTradeStopStreakKey("spy", Date.parse("2026-09-25T18:00:00Z"));
    expect(key).toBe(`timed:opt-dt:stop-streak:SPY:${nySessionDayKey(Date.parse("2026-09-25T18:00:00Z"))}`);
  });

  it("scopes session rounds the same way", () => {
    const key = dayTradeSessionRoundsKey("qqq", Date.parse("2026-09-25T18:00:00Z"));
    expect(key).toBe(`timed:opt-dt:rounds:QQQ:${nySessionDayKey(Date.parse("2026-09-25T18:00:00Z"))}`);
  });
});
