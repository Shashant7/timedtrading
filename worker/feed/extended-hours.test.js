import { describe, it, expect } from "vitest";
import {
  buildExtendedHoursFields,
  cachedAhpLooksStale,
  extendedQuoteLooksStale,
  isExtendedOperatingSession,
  lightweightRestRefreshDue,
  priceFeedPriceChanged,
  reconcileExtendedPrice,
  resolveAhPersistence,
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
  it("rejects missing or non-positive prints only", () => {
    expect(extendedQuoteLooksStale(0, -7.66, 226.30)).toBe(true);
    expect(extendedQuoteLooksStale(214.56, -7.66, 0)).toBe(true);
  });

  it("accepts premarket reversal after a large RTH loss (NOW bounce)", () => {
    expect(extendedQuoteLooksStale(214.56, -7.66, 226.30)).toBe(false);
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

  it("publishes premarket reverse bounce after a large RTH loss", () => {
    const r = buildExtendedHoursFields(
      { extendedPrice: 102.5, extendedChange: 7.04, extendedPercentChange: 7.37 },
      95.46,
      -6.47,
      true,
      false,
    );
    expect(r.extP).toBe(102.5);
    expect(r.extDp).toBeCloseTo(7.37, 2);
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

describe("resolveAhPersistence", () => {
  it("drops cached ahp when RTH close moves (GS 1090 zombie)", () => {
    const prev = { p: 1090.67, ahp: 1090.67, ahdc: 6.84, ahdp: 6.84 };
    const out = resolveAhPersistence(
      prev,
      { extP: 0, extDc: 0, extDp: 0 },
      1076.17,
      true,
      priceFeedPriceChanged(prev.p, 1076.17),
    );
    expect(out).toEqual({});
  });

  it("preserves cached ahp overnight when p is unchanged and vendor is quiet", () => {
    const prev = { p: 600, ahp: 601.5, ahdc: 1.5, ahdp: 0.25 };
    const out = resolveAhPersistence(
      prev,
      { extP: 0, extDc: 0, extDp: 0 },
      600,
      true,
      false,
    );
    expect(out.ahp).toBe(601.5);
    expect(out.ahdp).toBe(0.25);
  });

  it("publishes fresh vendor extended fields when present", () => {
    const out = resolveAhPersistence(
      { p: 600, ahp: 601.5 },
      { extP: 602, extDc: 2, extDp: 0.33 },
      600,
      true,
      false,
    );
    expect(out).toEqual({ ahp: 602, ahdc: 2, ahdp: 0.33 });
  });

  it("preserves large reverse EXT when p is unchanged and vendor is quiet", () => {
    const prev = { p: 95.46, ahp: 102.5, ahdc: 7.04, ahdp: 7.37 };
    const out = resolveAhPersistence(
      prev,
      { extP: 0, extDc: 0, extDp: 0 },
      95.46,
      true,
      false,
    );
    expect(out.ahp).toBe(102.5);
    expect(out.ahdp).toBe(7.37);
  });

  it("cachedAhpLooksStale helper still measures >1.5% drift (unused by persistence)", () => {
    expect(cachedAhpLooksStale(1076.17, 1090.67)).toBe(false);
    expect(cachedAhpLooksStale(1076.17, 1093)).toBe(true);
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
