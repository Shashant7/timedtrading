// @vitest-environment jsdom
//
// Calendar parity + holiday-awareness contract (2026-07-03).
//
// RCA context (tasks/2026-07-03-holiday-weekend-stabilization-plan.md):
// "is the market open right now?" was answered by THREE divergent tables —
// worker/market-calendar.js (static fallback), worker/foundation/
// trading-calendar.js, and react-app/shared-price-utils.js (which had NO
// holiday table at all). The market-calendar fallback wrongly listed
// 2026-07-02 as an equity early close (a SIFMA bond-market recommendation),
// which shut the live-candle sync at 1 PM ET while freshness SLOs stayed on
// RTH thresholds — the universe-wide stale-candle pages on Jul 2.
//
// This test pins: (1) the three tables agree on every date 2025–2028, and
// (2) session-state behavior on the incident dates.

import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

import {
  isHoliday as foundationIsHoliday,
  isHalfDay as foundationIsHalfDay,
} from "../worker/foundation/trading-calendar.js";
import {
  fetchAndCacheCalendar,
  isNyRegularMarketOpen as calIsNyRegularMarketOpen,
} from "../worker/market-calendar.js";

function loadPriceUtils() {
  const src = readFileSync(join(process.cwd(), "react-app/shared-price-utils.js"), "utf8");
  // eslint-disable-next-line no-eval
  eval(src);
  return globalThis.TimedPriceUtils;
}

function* datesInRange(startYear, endYear) {
  const d = new Date(Date.UTC(startYear, 0, 1));
  const end = new Date(Date.UTC(endYear, 11, 31));
  while (d <= end) {
    yield d.toISOString().slice(0, 10);
    d.setUTCDate(d.getUTCDate() + 1);
  }
}

describe("calendar parity: the three tables agree (2025–2028)", () => {
  let staticCal;
  let frontendTables;

  beforeAll(async () => {
    // No Alpaca creds in the env → returns the static fallback calendar.
    staticCal = await fetchAndCacheCalendar({});
    expect(staticCal.source).toBe("static");
    frontendTables = loadPriceUtils()._calendarTables;
  });

  it("holidays match across foundation, market-calendar fallback, and frontend", () => {
    for (const ds of datesInRange(2025, 2028)) {
      const a = foundationIsHoliday(ds);
      const b = staticCal.equityHolidays.has(ds);
      const c = !!frontendTables.holidays[ds];
      expect(`${ds}:${a}:${b}:${c}`).toBe(`${ds}:${a}:${a}:${a}`);
    }
  });

  it("early closes match across foundation, market-calendar fallback, and frontend", () => {
    for (const ds of datesInRange(2025, 2028)) {
      const a = foundationIsHalfDay(ds);
      const b = staticCal.equityEarlyClose.has(ds);
      const c = !!frontendTables.halfDays[ds];
      expect(`${ds}:${a}:${b}:${c}`).toBe(`${ds}:${a}:${a}:${a}`);
    }
  });

  it("Jul 4 2026 observance: Fri 2026-07-03 is a FULL holiday, Thu 2026-07-02 is a FULL session", () => {
    expect(staticCal.equityHolidays.has("2026-07-03")).toBe(true);
    expect(staticCal.equityEarlyClose.has("2026-07-03")).toBe(false);
    // The Jul 2 incident: this date must NOT be an early close.
    expect(staticCal.equityHolidays.has("2026-07-02")).toBe(false);
    expect(staticCal.equityEarlyClose.has("2026-07-02")).toBe(false);
  });
});

describe("worker session state on the incident dates", () => {
  let staticCal;
  beforeAll(async () => {
    staticCal = await fetchAndCacheCalendar({});
  });

  it("2026-07-02 14:30 ET (Thu) — market OPEN (regression: bogus early close said closed)", () => {
    expect(calIsNyRegularMarketOpen(staticCal, new Date("2026-07-02T18:30:00Z"))).toBe(true);
  });

  it("2026-07-03 11:00 ET (Fri, Independence Day observed) — market CLOSED", () => {
    expect(calIsNyRegularMarketOpen(staticCal, new Date("2026-07-03T15:00:00Z"))).toBe(false);
  });

  it("2026-11-27 (day after Thanksgiving) — open 11:00 ET, closed 13:30 ET", () => {
    expect(calIsNyRegularMarketOpen(staticCal, new Date("2026-11-27T16:00:00Z"))).toBe(true);  // 11:00 EST
    expect(calIsNyRegularMarketOpen(staticCal, new Date("2026-11-27T18:30:00Z"))).toBe(false); // 13:30 EST
  });
});

describe("frontend isNyRegularMarketOpen is holiday/half-day aware (Bug 1)", () => {
  let utils;

  beforeAll(() => {
    utils = loadPriceUtils();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockNyClock(str) {
    vi.spyOn(Date.prototype, "toLocaleString").mockImplementation(function (loc, opts) {
      if (opts && opts.timeZone === "America/New_York") return str;
      return str;
    });
  }

  it("Fri 2026-07-03 11:00 ET (holiday, would be RTH) — closed", () => {
    mockNyClock("7/3/2026, 11:00:00");
    expect(utils.isNyRegularMarketOpen()).toBe(false);
  });

  it("Mon 2026-07-06 11:00 ET (first session after the holiday) — open", () => {
    mockNyClock("7/6/2026, 11:00:00");
    expect(utils.isNyRegularMarketOpen()).toBe(true);
  });

  it("Fri 2026-06-19 12:00 ET (Juneteenth, the prior false-open) — closed", () => {
    mockNyClock("6/19/2026, 12:00:00");
    expect(utils.isNyRegularMarketOpen()).toBe(false);
  });

  it("Fri 2026-11-27 (early close): open at 11:00 ET, closed at 13:30 ET", () => {
    mockNyClock("11/27/2026, 11:00:00");
    expect(utils.isNyRegularMarketOpen()).toBe(true);
    vi.restoreAllMocks();
    mockNyClock("11/27/2026, 13:30:00");
    expect(utils.isNyRegularMarketOpen()).toBe(false);
  });

  it("holiday during fake-RTH: getExtChange no longer suppressed, EXT anchor usable", () => {
    mockNyClock("7/3/2026, 11:00:00");
    // Market is (correctly) closed → EXT change resolver may return data.
    const ts = Date.now() - 60 * 1000;
    const ext = utils.getExtChange({
      ticker: "SPY",
      close: 600.0,
      price: 600.0,
      _ah_change_pct: 0.25,
      _price_updated_at: ts,
      _price_value_ts: ts,
    });
    expect(ext).not.toBeNull();
    expect(ext.pct).toBeCloseTo(0.25, 2);
  });
});
