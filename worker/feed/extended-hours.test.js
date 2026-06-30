import { describe, it, expect } from "vitest";
import {
  buildExtendedHoursFields,
  extendedQuoteLooksStale,
  isExtendedOperatingSession,
  lightweightRestRefreshDue,
  reconcileExtendedPrice,
} from "./extended-hours.js";

describe("reconcileExtendedPrice", () => {
  it("rescales KLAC post-split ext print that is 10x too high", () => {
    expect(reconcileExtendedPrice(241.16, 2415)).toBeCloseTo(241.5, 1);
  });

  it("rescales KLAC ext print that is 10x too low", () => {
    expect(reconcileExtendedPrice(241.16, 24.35)).toBeCloseTo(243.5, 1);
  });

  it("rescales split-day pre-split close with post-split ext print", () => {
    expect(reconcileExtendedPrice(2411.64, 243.5)).toBeCloseTo(2435, 0);
  });

  it("leaves sane same-scale ext unchanged", () => {
    expect(reconcileExtendedPrice(241.16, 243.5)).toBeCloseTo(243.5, 2);
  });
});

describe("extendedQuoteLooksStale", () => {
  it("rejects AH drift that disagrees with RTH day change", () => {
    expect(extendedQuoteLooksStale(214.56, -7.66, 226.30)).toBe(true);
  });

  it("accepts modest AH move in same direction as RTH", () => {
    expect(extendedQuoteLooksStale(100, 2, 101.5)).toBe(false);
  });

  it("accepts large AH move when RTH day change is flat (SOXL AMC pop)", () => {
    expect(extendedQuoteLooksStale(229.57, -0.8, 264.7)).toBe(false);
  });
});

describe("buildExtendedHoursFields", () => {
  it("returns zeros when extended price equals RTH close (no distinct AH tick)", () => {
    const out = buildExtendedHoursFields(
      { extendedPrice: 1090.67, extendedChange: 6.84, extendedPercentChange: 6.84 },
      1090.67,
      6.84,
      true,
      false,
    );
    expect(out).toEqual({ extP: 0, extDc: 0, extDp: 0 });
  });

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

  it("fixes KLAC split-scale extended_price before publishing ahp", () => {
    const r = buildExtendedHoursFields(
      { extendedPrice: 2415, extendedChange: 23.4, extendedPercentChange: 0.97 },
      241.16,
      12.9,
      true,
      false,
    );
    expect(r.extP).toBeCloseTo(241.5, 1);
    expect(r.extDc).toBeCloseTo(0.34, 1);
    expect(r.extDp).toBeCloseTo(0.97, 1);
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
