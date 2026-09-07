// worker/foundation/trading-calendar.test.js
import { describe, it, expect } from "vitest";
import {
  isTradingDay, isHoliday, isHalfDay, sessionBoundsUtc,
  etWallToUtcMs, etDateStr, expectedIntradayBuckets, tradingDaysInRange,
  expectedBuckets, addDays, tradingDateUtcMs, computeMarketSessionReference,
  latestSettledSessionOpenMs, sessionAwareStaleMs,
} from "./trading-calendar.js";

describe("trading-calendar: trading days", () => {
  it("weekday yes, weekend no", () => {
    expect(isTradingDay("2026-06-12")).toBe(true);   // Fri
    expect(isTradingDay("2026-06-13")).toBe(false);  // Sat
    expect(isTradingDay("2026-06-14")).toBe(false);  // Sun
  });
  it("holidays are closed", () => {
    expect(isHoliday("2026-01-01")).toBe(true);
    expect(isTradingDay("2026-01-01")).toBe(false);
  });
  it("half-days are still trading days", () => {
    expect(isHalfDay("2026-12-24")).toBe(true);
    expect(isTradingDay("2026-12-24")).toBe(true);
  });
});

describe("trading-calendar: ET↔UTC + session bounds (DST-correct)", () => {
  it("June (EDT, UTC-4): 09:30→13:30Z, 16:00→20:00Z", () => {
    const b = sessionBoundsUtc("2026-06-12");
    expect(b.openMs).toBe(Date.UTC(2026, 5, 12, 13, 30));
    expect(b.closeMs).toBe(Date.UTC(2026, 5, 12, 20, 0));
  });
  it("December half-day (EST, UTC-5): close 13:00→18:00Z", () => {
    const b = sessionBoundsUtc("2026-12-24");
    expect(b.openMs).toBe(Date.UTC(2026, 11, 24, 14, 30));
    expect(b.closeMs).toBe(Date.UTC(2026, 11, 24, 18, 0));
  });
  it("etWallToUtcMs round-trips a date string", () => {
    expect(etDateStr(etWallToUtcMs(2026, 6, 12, 9, 30))).toBe("2026-06-12");
  });
  it("addDays crosses weekends correctly", () => {
    expect(addDays("2026-06-12", 3)).toBe("2026-06-15");
  });
});

describe("trading-calendar: expected grids", () => {
  it("regular session 5m = 78 buckets, first=open, last=close-5m", () => {
    const g = expectedIntradayBuckets("2026-06-12", 5);
    const b = sessionBoundsUtc("2026-06-12");
    expect(g.length).toBe(78);                 // 6.5h * 12
    expect(g[0]).toBe(b.openMs);
    expect(g[g.length - 1]).toBe(b.closeMs - 5 * 60000);
  });
  it("half-day 5m = 42 buckets (3.5h)", () => {
    expect(expectedIntradayBuckets("2026-12-24", 5).length).toBe(42);
  });
  it("30m regular session = 13 buckets", () => {
    expect(expectedIntradayBuckets("2026-06-12", 30).length).toBe(13);
  });
  it("tradingDaysInRange excludes weekend + Juneteenth", () => {
    // 2026-06-15..06-22 includes Juneteenth (06-19 Fri) holiday + a weekend
    const days = tradingDaysInRange("2026-06-15", "2026-06-22");
    expect(days).toEqual(["2026-06-15", "2026-06-16", "2026-06-17", "2026-06-18", "2026-06-22"]);
  });
  it("expectedBuckets D = one per trading day, anchored at 00:00 UTC", () => {
    const start = tradingDateUtcMs("2026-06-15");
    const end = sessionBoundsUtc("2026-06-22").closeMs;
    const grid = expectedBuckets({ tf: "D", startMs: start, endMs: end });
    expect(grid.length).toBe(5);
    expect(grid[0]).toBe(Date.UTC(2026, 5, 15)); // 00:00 UTC, not the 13:30 open
  });
});

describe("trading-calendar: session reference", () => {
  it("lastCompletedTradingDay skips Juneteenth and returns Thursday", () => {
    const sat = Date.UTC(2026, 5, 20, 15, 0, 0);
    const ref = computeMarketSessionReference(sat);
    expect(ref.last_trading_day).toBe("2026-06-18");
    expect(ref.next_trading_day).toBe("2026-06-22");
    expect(ref.market_open).toBe(false);
    expect(ref.session_phase).toBe("closed");
  });
});

describe("trading-calendar: session-aware staleness horizon", () => {
  const H = 3600000;
  const friOpen = etWallToUtcMs(2026, 9, 4, 9, 30);   // Fri 2026-09-04 (before Labor Day)
  const monOpen = etWallToUtcMs(2026, 9, 14, 9, 30);  // ordinary Monday

  it("Labor Day Monday 9 AM: latest settled session is Friday; a Friday stub is not stale", () => {
    const laborDay9am = etWallToUtcMs(2026, 9, 7, 9, 0);
    expect(latestSettledSessionOpenMs(laborDay9am)).toBe(friOpen);
    expect(sessionAwareStaleMs(laborDay9am)).toBe(71.5 * H);
    const friStubTs = etWallToUtcMs(2026, 9, 4, 15, 55);
    expect(laborDay9am - friStubTs).toBeLessThan(sessionAwareStaleMs(laborDay9am));
  });
  it("Labor Day Monday 3 PM stays anchored to Friday (no session today)", () => {
    const laborDay3pm = etWallToUtcMs(2026, 9, 7, 15, 0);
    expect(latestSettledSessionOpenMs(laborDay3pm)).toBe(friOpen);
    expect(sessionAwareStaleMs(laborDay3pm)).toBe(77.5 * H);
  });
  it("Tuesday after the holiday: 9 AM still Friday-anchored, 3 PM flips to today's session", () => {
    const tue9am = etWallToUtcMs(2026, 9, 8, 9, 0);
    expect(latestSettledSessionOpenMs(tue9am)).toBe(friOpen);
    expect(sessionAwareStaleMs(tue9am)).toBe(95.5 * H);
    const tue3pm = etWallToUtcMs(2026, 9, 8, 15, 0);
    expect(latestSettledSessionOpenMs(tue3pm)).toBe(etWallToUtcMs(2026, 9, 8, 9, 30));
    // Today's open is 5.5h back; the 24h floor wins, so a Friday stub IS stale.
    expect(sessionAwareStaleMs(tue3pm)).toBe(24 * H);
    expect(tue3pm - etWallToUtcMs(2026, 9, 4, 15, 55)).toBeGreaterThan(24 * H);
  });
  it("ordinary Monday 9 AM reaches back to Friday (matches the old 72h Monday rule)", () => {
    const mon9am = etWallToUtcMs(2026, 9, 14, 9, 0);
    expect(sessionAwareStaleMs(mon9am)).toBe(71.5 * H);
  });
  it("mid-week 9 AM and a session under the 4h settle window fall back to the floor", () => {
    const tue9am = etWallToUtcMs(2026, 9, 15, 9, 0);
    expect(latestSettledSessionOpenMs(tue9am)).toBe(monOpen);
    expect(sessionAwareStaleMs(tue9am)).toBe(24 * H);
    const tue10am = etWallToUtcMs(2026, 9, 15, 10, 0);
    expect(latestSettledSessionOpenMs(tue10am)).toBe(monOpen); // today's open only 30m back
    expect(sessionAwareStaleMs(tue10am)).toBe(24.5 * H);
  });
});
