// worker/lane-minds.test.js
import { describe, it, expect } from "vitest";
import {
  LANE_MINDS,
  laneMind,
  dayTradeEntryBlock,
  dayTradeStopStreakKey,
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
});

describe("dayTradeStopStreakKey", () => {
  it("scopes by ticker and NY session day", () => {
    const key = dayTradeStopStreakKey("spy", Date.parse("2026-09-25T18:00:00Z"));
    expect(key).toBe(`timed:opt-dt:stop-streak:SPY:${nySessionDayKey(Date.parse("2026-09-25T18:00:00Z"))}`);
  });
});
