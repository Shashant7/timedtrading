import { describe, it, expect } from "vitest";
import {
  isPriceValueFresh,
  overlayTimedPricesRow,
  overlayLivePricesOntoMap,
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

  it("clears stale snapshot _ah_* when timed:prices row has no ahp (GS 1090)", () => {
    const now = Date.now();
    const obj = {
      ticker: "GS",
      price: 1090.67,
      close: 1090.67,
      prev_close: 1020,
      _ah_price: 1090.67,
      _ah_change_pct: 6.84,
      _ah_change: 70,
    };
    const pf = {
      p: 1011.37,
      pc: 1020.21,
      dp: -0.87,
      dc: -8.84,
      t: now,
      p_ts: now - 60 * 1000,
      q_ts: now - 60 * 1000,
    };
    const out = overlayTimedPricesRow(obj, pf, { sym: "GS", marketOpen: false });
    expect(out.price).toBe(1011.37);
    expect(out._ah_price).toBeUndefined();
    expect(out._ah_change_pct).toBeUndefined();
  });

  it("corrects MLI 2:1 split bogus +100% day change from vendor pc", () => {
    const now = Date.now();
    const obj = { ticker: "MLI", price: 122.93, prev_close: 61.42, day_change_pct: 100.16 };
    const pf = {
      p: 122.93,
      pc: 61.42,
      dc: 61.52,
      dp: 100.16,
      t: now,
      p_ts: now - 60 * 1000,
      q_ts: now - 60 * 1000,
    };
    const out = overlayTimedPricesRow(obj, pf, { sym: "MLI", marketOpen: true });
    expect(out.prev_close).toBeCloseTo(122.84, 1);
    expect(Math.abs(out.day_change_pct)).toBeLessThan(1);
  });
});

describe("overlayLivePricesOntoMap", () => {
  const freshPf = (now, p, pc) => ({ p, pc, dp: 1.2, dc: 1, t: now, p_ts: now - 60_000, q_ts: now - 60_000 });

  it("stamps _live_price + freshness timestamps on every row with a fresh feed", () => {
    const now = Date.now();
    const map = {
      XLI: { ticker: "XLI", price: 183.58, close: 183.58, prev_close: 183.58 },
      BRKB: { ticker: "BRKB", price: 500, close: 500, prev_close: 500 },
    };
    const livePrices = {
      updated_at: now,
      prices: { XLI: freshPf(now, 185.23, 183.58), BRKB: freshPf(now, 505, 500) },
    };
    const res = overlayLivePricesOntoMap(map, livePrices, { marketOpen: true });
    expect(res.overlaid).toBe(2);
    expect(map.XLI._live_price).toBe(185.23);
    expect(map.XLI._price_value_ts).toBe(now - 60_000);
    expect(map.XLI._quote_receipt_ts).toBe(now - 60_000);
  });

  it("only overlays the provided symbols when opts.symbols is set (position re-overlay pass)", () => {
    const now = Date.now();
    // Freshly-injected position row that missed the first overlay pass.
    const map = {
      XLI: { ticker: "XLI", has_open_position: true, ts: now },
      AAPL: { ticker: "AAPL", price: 200, close: 200, prev_close: 200 },
    };
    const livePrices = {
      updated_at: now,
      prices: { XLI: freshPf(now, 185.23, 183.58), AAPL: freshPf(now, 205, 200) },
    };
    const res = overlayLivePricesOntoMap(map, livePrices, { symbols: new Set(["XLI"]), marketOpen: true });
    expect(res.overlaid).toBe(1);
    expect(map.XLI._live_price).toBe(185.23);
    expect(map.XLI._price_value_ts).toBe(now - 60_000);
    // AAPL was not in the symbol set — untouched by this scoped pass.
    expect(map.AAPL._live_price).toBeUndefined();
  });

  it("no-ops safely on a missing feed or empty map", () => {
    expect(overlayLivePricesOntoMap({}, null).overlaid).toBe(0);
    expect(overlayLivePricesOntoMap({}, { prices: {} }).overlaid).toBe(0);
    expect(overlayLivePricesOntoMap(null, { prices: { X: {} } }).overlaid).toBe(0);
  });

  it("skips a symbol with no fresh feed row (no fabricated freshness)", () => {
    const now = Date.now();
    const map = { XLI: { ticker: "XLI", has_open_position: true, ts: now } };
    // Stale quote (>10m during RTH) — overlay must not stamp freshness.
    const livePrices = {
      updated_at: now,
      prices: { XLI: { p: 185, pc: 183, t: now, p_ts: now - 11 * 60_000, q_ts: now - 11 * 60_000 } },
    };
    const res = overlayLivePricesOntoMap(map, livePrices, { marketOpen: true });
    expect(res.overlaid).toBe(1);
    expect(map.XLI._live_price).toBeUndefined();
    expect(map.XLI._price_value_ts).toBeUndefined();
  });
});
