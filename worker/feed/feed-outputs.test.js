import { describe, it, expect } from "vitest";
import {
  isPriceValueFresh,
  overlayTimedPricesRow,
  priceValueTimestamp,
} from "./feed-outputs.js";

describe("priceValueTimestamp", () => {
  it("prefers p_ts over poll t", () => {
    expect(priceValueTimestamp({ p_ts: 1000, t: 5000 })).toBe(1000);
  });
});

describe("isPriceValueFresh", () => {
  it("treats week-old p_ts as stale outside RTH", () => {
    const now = Date.now();
    expect(isPriceValueFresh({ p_ts: now - 8 * 24 * 60 * 60 * 1000, t: now }, now, false)).toBe(false);
  });

  it("accepts recent p_ts during RTH", () => {
    const now = Date.now();
    expect(isPriceValueFresh({ p_ts: now - 5 * 60 * 1000, t: now }, now, true)).toBe(true);
  });
});

describe("overlayTimedPricesRow", () => {
  it("skips overlay when p_ts is a week old (GS zombie)", () => {
    const now = Date.now();
    const obj = { ticker: "GS", price: 1090.67, close: 1090.67, prev_close: 1020 };
    const pf = { p: 1090.67, pc: 1020, dp: 6.84, t: now, p_ts: now - 8 * 24 * 60 * 60 * 1000 };
    const out = overlayTimedPricesRow(obj, pf, { sym: "GS", marketOpen: false });
    expect(out).toBe(obj);
    expect(out._price_value_ts).toBeUndefined();
  });

  it("overlays fresh p_ts and sets close outside RTH", () => {
    const now = Date.now();
    const obj = { ticker: "GS", price: 1020, close: 1020, prev_close: 1020 };
    const pf = {
      p: 1045.5,
      pc: 1020,
      dp: 2.5,
      ahp: 1042,
      ahdp: -0.33,
      t: now,
      p_ts: now - 60 * 1000,
    };
    const out = overlayTimedPricesRow(obj, pf, { sym: "GS", marketOpen: false });
    expect(out.price).toBe(1045.5);
    expect(out.close).toBe(1045.5);
    expect(out._price_value_ts).toBe(now - 60 * 1000);
    expect(out._ah_price).toBe(1042);
  });
});
