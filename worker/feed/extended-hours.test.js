import { describe, it, expect } from "vitest";
import {
  buildExtendedHoursFields,
  extendedQuoteLooksStale,
  isExtendedOperatingSession,
  lightweightRestRefreshDue,
} from "./extended-hours.js";

describe("extendedQuoteLooksStale", () => {
  it("rejects extreme drift from RTH close", () => {
    expect(extendedQuoteLooksStale(214.56, -7.66, 226.30)).toBe(true);
  });

  it("accepts modest AH move in same direction as RTH", () => {
    expect(extendedQuoteLooksStale(100, 2, 101.5)).toBe(false);
  });
});

describe("buildExtendedHoursFields", () => {
  it("prefers TwelveData native extended fields", () => {
    const r = buildExtendedHoursFields(
      { extendedPrice: 105, extendedChange: 2, extendedPercentChange: 1.94 },
      103,
      1.5,
      true,
      false,
    );
    expect(r).toEqual({ extP: 105, extDc: 2, extDp: 1.94 });
  });

  it("returns zeros during RTH", () => {
    expect(buildExtendedHoursFields({ extendedPrice: 105 }, 103, 0, false, false))
      .toEqual({ extP: 0, extDc: 0, extDp: 0 });
  });

  it("returns zeros for crypto", () => {
    expect(buildExtendedHoursFields({ extendedPrice: 105 }, 103, 0, true, true))
      .toEqual({ extP: 0, extDc: 0, extDp: 0 });
  });
});

describe("isExtendedOperatingSession", () => {
  it("is true when market closed inside operating hours", () => {
    expect(isExtendedOperatingSession(true, () => true)).toBe(true);
  });

  it("is false during RTH", () => {
    expect(isExtendedOperatingSession(false, () => true)).toBe(false);
  });
});

describe("lightweightRestRefreshDue", () => {
  it("uses 5-min cadence during extended session", () => {
    expect(lightweightRestRefreshDue({
      utcMinute: 10,
      nonZeroCount: 50,
      hasAhData: true,
      extendedSession: true,
    })).toBe(true);
    expect(lightweightRestRefreshDue({
      utcMinute: 11,
      nonZeroCount: 50,
      hasAhData: true,
      extendedSession: true,
    })).toBe(false);
  });

  it("uses 30-min cadence overnight outside extended session", () => {
    expect(lightweightRestRefreshDue({
      utcMinute: 10,
      nonZeroCount: 50,
      hasAhData: true,
      extendedSession: false,
    })).toBe(false);
    expect(lightweightRestRefreshDue({
      utcMinute: 30,
      nonZeroCount: 50,
      hasAhData: true,
      extendedSession: false,
    })).toBe(true);
  });
});
