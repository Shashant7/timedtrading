import { describe, it, expect } from "vitest";
import {
  isPriceValueFresh,
  overlayTimedPricesRow,
  priceValueTimestamp,
  quoteReceiptTimestamp,
} from "./feed-outputs.js";

describe("priceValueTimestamp", () => {
  it("prefers p_ts over poll t", () => {
    expect(priceValueTimestamp({ p_ts: 1000, t: 5000 })).toBe(1000);
  });

  it("does not fall back to poll t when p_ts is missing", () => {
    expect(priceValueTimestamp({ t: Date.now() })).toBe(0);
  });
});

describe("quoteReceiptTimestamp", () => {
  it("prefers the newer of q_ts and p_ts", () => {
    expect(quoteReceiptTimestamp({ q_ts: 5000, p_ts: 3000, t: 9000 })).toBe(5000);
    expect(quoteReceiptTimestamp({ q_ts: 2000, p_ts: 7000, t: 9000 })).toBe(7000);
  });

  it("does not fall back to poll t", () => {
    expect(quoteReceiptTimestamp({ t: Date.now() })).toBe(0);
  });
});

describe("isPriceValueFresh", () => {
  it("treats week-old q_ts as stale outside RTH", () => {
    const now = Date.now();
    const weekAgo = now - 8 * 24 * 60 * 60 * 1000;
    expect(isPriceValueFresh({ q_ts: weekAgo, p_ts: weekAgo, t: now }, now, false)).toBe(false);
  });

  it("accepts recent q_ts during RTH within 10 minutes", () => {
    const now = Date.now();
    expect(isPriceValueFresh({ q_ts: now - 5 * 60 * 1000, t: now }, now, true)).toBe(true);
  });

  it("rejects RTH quotes older than 10 minutes even when poll t is fresh (GS zombie)", () => {
    const now = Date.now();
    expect(isPriceValueFresh({
      p: 1090.67,
      t: now,
      q_ts: now - 11 * 60 * 1000,
      p_ts: now - 11 * 60 * 1000,
    }, now, true)).toBe(false);
  });
});

describe("overlayTimedPricesRow", () => {
  it("skips overlay when p_ts is missing (legacy row)", () => {
    const now = Date.now();
    const obj = { ticker: "GS", price: 1090.67, close: 1090.67, prev_close: 1020 };
    const pf = { p: 1090.67, pc: 1020, dp: 6.84, t: now };
    const out = overlayTimedPricesRow(obj, pf, { sym: "GS", marketOpen: false });
    expect(out).toBe(obj);
  });

  it("skips overlay when quote receipt is older than 10m during RTH even if poll t is fresh", () => {
    const now = Date.now();
    const obj = { ticker: "GS", price: 800, close: 800, prev_close: 780 };
    const pf = {
      p: 1090.67,
      pc: 1020,
      dp: 6.84,
      t: now,
      q_ts: now - 11 * 60 * 1000,
      p_ts: now - 11 * 60 * 1000,
    };
    const out = overlayTimedPricesRow(obj, pf, { sym: "GS", marketOpen: true });
    expect(out.price).toBe(800);
    expect(out._live_price).toBeUndefined();
  });

  it("skips overlay when p_ts is a week old (GS zombie)", () => {
    const now = Date.now();
    const obj = { ticker: "GS", price: 1090.67, close: 1090.67, prev_close: 1020 };
    const pf = { p: 1090.67, pc: 1020, dp: 6.84, t: now, p_ts: now - 8 * 24 * 60 * 60 * 1000, q_ts: now - 8 * 24 * 60 * 60 * 1000 };
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
      q_ts: now - 60 * 1000,
    };
    const out = overlayTimedPricesRow(obj, pf, { sym: "GS", marketOpen: false });
    expect(out.price).toBe(1045.5);
    expect(out.close).toBe(1045.5);
    expect(out._price_value_ts).toBe(now - 60 * 1000);
    expect(out._ah_price).toBe(1042);
  });
});
