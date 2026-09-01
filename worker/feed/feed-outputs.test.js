import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  decideValueFreshnessPage,
  isPriceValueFresh,
  mergeFreshnessIntoLatest,
  minutesSinceRthOpen,
  overlayTimedPricesRow,
  overlayLivePricesOntoMap,
  PF_FRESH_MS,
  PF_STALE_JITTER_MAX_MS,
  priceValueTimestamp,
  quoteReceiptTimestamp,
  resolveRestQuoteReceiptTs,
  syncLivePricesToChartCandles,
  usesAggressiveQuoteSweep,
  VALUE_STALE_OPEN_GRACE_MIN,
  VALUE_STALE_PAGE_COUNT,
  VALUE_STALE_PREOPEN_ET_MIN,
} from "./feed-outputs.js";
import { RTH_OPEN } from "../market-calendar.js";

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

describe("resolveRestQuoteReceiptTs", () => {
  const noJitter = { jitterMaxMs: 0 };

  // 2026-07-28 — TD-QUANTIZATION FIX. TwelveData's `/quote` API returns
  // minute-quantized `last_quote_at` values for quiet symbols (a single
  // batch response for BNY/CRDO/RKT/… arrived with 30+ symbols all
  // sharing the same value). The prior implementation shortcut to
  // `return trade` when trade_ts was fresh, stamping every symbol in the
  // batch with an IDENTICAL q_ts and defeating the per-symbol jitter.
  // The helper now ALWAYS uses receipt-now (jittered), so even a fresh
  // vendor trade clock desyncs across a batch. Actual vendor trade time
  // stays on `snap.trade_ts` for callers that need the last-trade info.
  it("stamps receipt-now even when vendor trade_ts is fresh (defeats TD batch quantization)", () => {
    const now = Date.now();
    const trade = now - 2 * 60 * 1000; // vendor says trade was 2m ago
    expect(resolveRestQuoteReceiptTs(trade, now, noJitter)).toBe(now);
    // With default jitter, the stamp is now-jitter (in the receipt window).
    const stamp = resolveRestQuoteReceiptTs(trade, now, { random: () => 0.5 });
    expect(stamp).toBe(now - Math.floor(0.5 * PF_STALE_JITTER_MAX_MS));
  });

  it("does not return the vendor trade clock even for tiny (<PF_FRESH_MS) trade_ts values", () => {
    const now = Date.now();
    // TD sometimes returns last_quote_at within 30s of now for actively-traded
    // symbols in a batch. Each still needs an independent jitter so that a
    // batch of 8 symbols with identical trade_ts don't all resolve to the
    // same q_ts.
    const veryFreshTrade = now - 15 * 1000;
    const stamps = [];
    for (let i = 0; i < 20; i++) {
      const stamp = resolveRestQuoteReceiptTs(veryFreshTrade, now, { random: () => Math.random() });
      // Never returns trade — always in [now - jitterMax, now].
      expect(stamp).toBeGreaterThanOrEqual(now - PF_STALE_JITTER_MAX_MS);
      expect(stamp).toBeLessThanOrEqual(now);
      expect(stamp).not.toBe(veryFreshTrade);
      stamps.push(stamp);
    }
    // With random jitter, at least half the stamps should be unique
    // (defeats the batch-sync that the old shortcut created).
    const uniqueStamps = new Set(stamps);
    expect(uniqueStamps.size).toBeGreaterThan(1);
  });

  it("desyncs a simulated TD batch response where every symbol shares last_quote_at", () => {
    // Reproduces the 2026-07-28 alert: TD returned 30+ quiet symbols with
    // the SAME `last_quote_at` (minute-quantized). Under the old shortcut,
    // every call stamped the identical q_ts and the batch aged in lockstep.
    //
    // Use a deterministic RNG — Math.random() can land jitter exactly on
    // the shared trade offset (now-90s), which made CI flake even though
    // the helper never returns trade_ts (it always returns now-jitter).
    const now = Date.now();
    const sharedTrade = now - 90 * 1000; // TD's quantized last_quote_at
    let seed = 0xC0FFEE;
    const detRandom = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    const stamps = [];
    for (let i = 0; i < 40; i++) {
      const stamp = resolveRestQuoteReceiptTs(sharedTrade, now, { random: detRandom });
      expect(stamp).toBeGreaterThanOrEqual(now - PF_STALE_JITTER_MAX_MS);
      expect(stamp).toBeLessThanOrEqual(now);
      stamps.push(stamp);
    }
    // Contract: receipt stamps desync across the batch (not lockstep).
    // Accidental equality with sharedTrade is possible for some jitter
    // draws and is not a regression — q_ts is never "return trade".
    const unique = new Set(stamps);
    expect(unique.size).toBeGreaterThan(10);
    const min = Math.min(...stamps);
    const max = Math.max(...stamps);
    expect(max - min).toBeGreaterThan(60_000); // >1 minute spread across 40 draws
  });

  it("stamps receipt now when vendor trade_ts is aged (overnight / quiet print)", () => {
    const now = Date.now();
    const aged = now - 17 * 60 * 60 * 1000;
    expect(resolveRestQuoteReceiptTs(aged, now, noJitter)).toBe(now);
  });

  it("stamps receipt now when trade_ts is missing", () => {
    const now = Date.now();
    expect(resolveRestQuoteReceiptTs(0, now, noJitter)).toBe(now);
    expect(resolveRestQuoteReceiptTs(null, now, noJitter)).toBe(now);
  });

  it("treats trade_ts just beyond PF_FRESH_MS as receipt-now", () => {
    const now = Date.now();
    expect(resolveRestQuoteReceiptTs(now - PF_FRESH_MS - 1, now, noJitter)).toBe(now);
  });

  // 2026-07-24 — value-freshness burst fix. Batched REST sweeps stamped
  // every quiet symbol with q_ts = now; they then aged in lockstep and
  // paged price_value_freshness the moment they crossed the 10-min stale
  // threshold. Fallback now jitters q_ts across a 0..8m window so aging
  // spreads across the cycle.
  describe("stale-jitter fallback", () => {
    it("exports a jitter cap below the 10m freshness gate so jittered stamps stay display-fresh", () => {
      expect(PF_STALE_JITTER_MAX_MS).toBeGreaterThan(0);
      expect(PF_STALE_JITTER_MAX_MS).toBeLessThan(PF_FRESH_MS);
    });

    it("subtracts a bounded jittered offset from receipt-now (default cap)", () => {
      const now = Date.now();
      const stampMax = resolveRestQuoteReceiptTs(0, now, { random: () => 0.999999 });
      const stampMid = resolveRestQuoteReceiptTs(0, now, { random: () => 0.5 });
      const stampMin = resolveRestQuoteReceiptTs(0, now, { random: () => 0 });
      expect(stampMin).toBe(now);
      expect(stampMax).toBeGreaterThanOrEqual(now - PF_STALE_JITTER_MAX_MS);
      expect(stampMax).toBeLessThan(now);
      expect(stampMid).toBe(now - Math.floor(0.5 * PF_STALE_JITTER_MAX_MS));
    });

    it("respects an explicit jitterMaxMs override", () => {
      const now = Date.now();
      const stamp = resolveRestQuoteReceiptTs(0, now, { jitterMaxMs: 60_000, random: () => 0.5 });
      expect(stamp).toBe(now - 30_000);
    });

    it("clamps a negative jitterMaxMs to zero (no jitter)", () => {
      const now = Date.now();
      expect(resolveRestQuoteReceiptTs(0, now, { jitterMaxMs: -1 })).toBe(now);
    });

    it("keeps every jittered fallback within the value-freshness window", () => {
      const now = Date.now();
      for (let i = 0; i < 20; i++) {
        const stamp = resolveRestQuoteReceiptTs(0, now, { random: () => Math.random() });
        expect(now - stamp).toBeGreaterThanOrEqual(0);
        expect(now - stamp).toBeLessThan(PF_FRESH_MS);
      }
    });
  });
});

describe("minutesSinceRthOpen + page thresholds", () => {
  it("exports watchdog-aligned page count, short open grace, and 9:00 preopen gate", () => {
    expect(VALUE_STALE_PAGE_COUNT).toBe(40);
    expect(VALUE_STALE_OPEN_GRACE_MIN).toBe(5);
    expect(VALUE_STALE_PREOPEN_ET_MIN).toBe(9 * 60);
  });

  it("returns minutes since 9:30 ET during RTH", () => {
    // Construct a UTC instant that is ~9:45 ET on a known weekday.
    // 2026-07-15 13:45 UTC = 09:45 ET (EDT).
    const at945 = Date.parse("2026-07-15T13:45:00Z");
    expect(minutesSinceRthOpen(at945)).toBe(15);
  });

  it("returns null outside RTH", () => {
    const preOpen = Date.parse("2026-07-15T13:00:00Z"); // 09:00 ET
    const afterClose = Date.parse("2026-07-15T21:00:00Z"); // 17:00 ET
    expect(minutesSinceRthOpen(preOpen)).toBeNull();
    expect(minutesSinceRthOpen(afterClose)).toBeNull();
  });

  it("open grace covers the first minutes after RTH_OPEN", () => {
    expect(RTH_OPEN + VALUE_STALE_OPEN_GRACE_MIN).toBe(575); // 9:35 ET
  });
});

describe("usesAggressiveQuoteSweep", () => {
  it("is true during RTH and extended session, false overnight", () => {
    expect(usesAggressiveQuoteSweep(true, false)).toBe(true);
    expect(usesAggressiveQuoteSweep(false, true)).toBe(true);
    expect(usesAggressiveQuoteSweep(false, false)).toBe(false);
  });
});

describe("decideValueFreshnessPage", () => {
  it("succeeds under the page threshold", () => {
    expect(decideValueFreshnessPage({
      count: 8,
      marketOpen: true,
      extendedSession: false,
      nowMs: Date.parse("2026-07-15T14:00:00Z"),
    })).toMatchObject({ page: false, success: true, reason: "under_threshold" });
  });

  it("warms quietly before 9:00 ET during premarket", () => {
    // 2026-07-15 12:00 UTC = 08:00 ET
    expect(decideValueFreshnessPage({
      count: 200,
      marketOpen: false,
      extendedSession: true,
      nowMs: Date.parse("2026-07-15T12:00:00Z"),
    })).toMatchObject({ page: false, success: false, reason: "premarket_warming" });
  });

  it("pages from 9:00 ET preopen when still deeply stale", () => {
    // 2026-07-15 13:05 UTC = 09:05 ET
    expect(decideValueFreshnessPage({
      count: 80,
      marketOpen: false,
      extendedSession: true,
      nowMs: Date.parse("2026-07-15T13:05:00Z"),
    })).toMatchObject({ page: true, success: false, reason: "preopen_not_ready" });
  });

  it("applies short open grace then pages during RTH", () => {
    // 09:32 ET — inside 5m grace
    expect(decideValueFreshnessPage({
      count: 80,
      marketOpen: true,
      extendedSession: false,
      nowMs: Date.parse("2026-07-15T13:32:00Z"),
    })).toMatchObject({ page: false, reason: "open_grace" });
    // 09:40 ET — past grace
    expect(decideValueFreshnessPage({
      count: 80,
      marketOpen: true,
      extendedSession: false,
      nowMs: Date.parse("2026-07-15T13:40:00Z"),
    })).toMatchObject({ page: true, reason: "rth_stale" });
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

  it("does not overlay leftover last-AH pennies as EXT (QQQ 717.04 vs 716.76)", () => {
    const now = Date.now();
    const obj = { ticker: "QQQ", price: 716.76, close: 716.76, prev_close: 716.43 };
    const pf = {
      p: 716.76,
      pc: 716.43,
      dp: 0.05,
      ahp: 717.04,
      ahdc: 0.28,
      ahdp: 0.04,
      t: now,
      p_ts: now - 60 * 1000,
      q_ts: now - 60 * 1000,
    };
    const out = overlayTimedPricesRow(obj, pf, { sym: "QQQ", marketOpen: false });
    expect(out.price).toBe(716.76);
    expect(out._ah_price).toBeUndefined();
    expect(out._ah_change_pct).toBeUndefined();
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

  it("corrects MLI post-split drift when vendor pc is still pre-split", () => {
    const now = Date.now();
    const obj = { ticker: "MLI", price: 56.18, prev_close: 122.83, open: 58.2, day_change_pct: -54.26 };
    const pf = {
      p: 56.18,
      pc: 122.83,
      dc: -66.65,
      dp: -54.26,
      t: now,
      p_ts: now - 60 * 1000,
      q_ts: now - 60 * 1000,
    };
    const out = overlayTimedPricesRow(obj, pf, { sym: "MLI", marketOpen: true });
    expect(out.prev_close).toBeCloseTo(61.42, 1);
    expect(Math.abs(out.day_change_pct)).toBeLessThan(12);
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

// B3 (2026-07-03 stabilization plan) — live-candle sync coverage: priority
// always included; the non-priority remainder rotates so overflow tickers
// don't starve tick after tick.
describe("syncLivePricesToChartCandles coverage rotation", () => {
  // D-bar writes anchor to etDateStr(now); weekends/holidays skip D rows.
  const RTH_WEEKDAY_MS = new Date("2026-07-07T15:00:00.000Z").getTime();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(RTH_WEEKDAY_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function mockDb() {
    const batches = [];
    return {
      batches,
      prepare(sql) {
        return { bind: (...args) => ({ sql, args }) };
      },
      async batch(chunk) {
        batches.push(...chunk);
      },
    };
  }

  function pricesFor(syms) {
    const out = {};
    for (const s of syms) out[s] = { p: 100, t: Date.now() };
    return out;
  }

  function tickersWritten(db) {
    return new Set(db.batches.map((s) => s.args[0]));
  }

  const openHook = { isNyRegularMarketOpen: () => true };

  it("skips entirely when the market is closed (no force)", async () => {
    const db = mockDb();
    const res = await syncLivePricesToChartCandles(
      { DB: db }, pricesFor(["AAA"]), { log: false },
      { isNyRegularMarketOpen: () => false },
    );
    expect(res.skipped).toBe("market_closed");
    expect(db.batches.length).toBe(0);
  });

  it("covers the whole map when under the cap (D + 6 intraday TFs per ticker)", async () => {
    const db = mockDb();
    const syms = ["AAA", "BBB", "CCC"];
    await syncLivePricesToChartCandles({ DB: db }, pricesFor(syms), { log: false }, openHook);
    expect(tickersWritten(db)).toEqual(new Set(syms));
    // 1 D row per ticker + 6 intraday TFs (5/10/15/30/60/240) = 7 rows
    expect(db.batches.length).toBe(syms.length * 7);
  });

  it("D bar is written for EVERY priced ticker even when intraday rotation caps", async () => {
    const syms = Array.from({ length: 20 }, (_, i) => `T${String(i).padStart(2, "0")}`);
    const db = mockDb();
    await syncLivePricesToChartCandles(
      { DB: db }, pricesFor(syms),
      { log: false, maxTickers: 5, rotationOffset: 0 },
      openHook,
    );
    // Every ticker must have a D row even though intraday is capped at 5.
    const dRows = db.batches.filter((s) => s.args[1] === "D");
    const dTickers = new Set(dRows.map((s) => s.args[0]));
    expect(dTickers.size).toBe(20);
  });

  it("priority tickers are always included when over the cap (intraday coverage)", async () => {
    const syms = Array.from({ length: 20 }, (_, i) => `T${String(i).padStart(2, "0")}`);
    for (let rot = 0; rot < 5; rot++) {
      const db = mockDb();
      await syncLivePricesToChartCandles(
        { DB: db }, pricesFor(syms),
        { log: false, maxTickers: 10, priorityTickers: ["T19", "T18"], rotationOffset: rot },
        openHook,
      );
      const intradayRows = db.batches.filter((s) => s.args[1] !== "D");
      const intradayTickers = new Set(intradayRows.map((s) => s.args[0]));
      expect(intradayTickers.has("T19")).toBe(true);
      expect(intradayTickers.has("T18")).toBe(true);
      expect(intradayTickers.size).toBe(10);
    }
  });

  it("rotation covers every non-priority ticker across successive offsets", async () => {
    const syms = Array.from({ length: 25 }, (_, i) => `R${String(i).padStart(2, "0")}`);
    const covered = new Set();
    for (let rot = 0; rot < 3; rot++) {
      const db = mockDb();
      await syncLivePricesToChartCandles(
        { DB: db }, pricesFor(syms),
        { log: false, maxTickers: 10, rotationOffset: rot * 10 },
        openHook,
      );
      const intradayRows = db.batches.filter((s) => s.args[1] !== "D");
      for (const s of intradayRows) covered.add(s.args[0]);
    }
    expect(covered.size).toBe(25);
  });

  it("different offsets select different overflow subsets (no permanent tail)", async () => {
    const syms = Array.from({ length: 30 }, (_, i) => `S${String(i).padStart(2, "0")}`);
    const db1 = mockDb();
    await syncLivePricesToChartCandles({ DB: db1 }, pricesFor(syms), { log: false, maxTickers: 10, rotationOffset: 0 }, openHook);
    const db2 = mockDb();
    await syncLivePricesToChartCandles({ DB: db2 }, pricesFor(syms), { log: false, maxTickers: 10, rotationOffset: 10 }, openHook);
    const w1 = new Set(db1.batches.filter((s) => s.args[1] !== "D").map((s) => s.args[0]));
    const w2 = new Set(db2.batches.filter((s) => s.args[1] !== "D").map((s) => s.args[0]));
    const overlap = [...w1].filter((t) => w2.has(t));
    expect(overlap.length).toBe(0);
  });
});

// B1 regression — mergeFreshnessIntoLatest previously called the
// market-calendar isNyRegularMarketOpen with NO calendar arg; every weekday
// row threw inside Promise.allSettled and tt-feed's merge lane silently
// wrote nothing since 2026-06-23.
describe("mergeFreshnessIntoLatest merge-lane regression", () => {
  function mockKV(seed = {}) {
    const store = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]));
    return {
      store,
      async get(key, type) {
        const raw = store.get(key);
        if (!raw) return null;
        return type === "json" ? JSON.parse(raw) : raw;
      },
      async put(key, val) {
        store.set(key, val);
      },
    };
  }

  it("merges price + ingest_ts during RTH (previously threw per row)", async () => {
    const kv = mockKV({ "timed:latest:AAPL": { ticker: "AAPL", price: 200, prev_close: 198 } });
    const res = await mergeFreshnessIntoLatest(kv, { AAPL: { p: 205.5, pc: 198, t: Date.now(), dc: 7.5, dp: 3.79 } }, { marketOpen: true });
    expect(res.merged).toBe(1);
    const row = JSON.parse(kv.store.get("timed:latest:AAPL"));
    expect(row.price).toBe(205.5);
    expect(row.day_change).toBe(7.5);
    expect(row.ingest_ts).toBeGreaterThan(0);
    // RTH: extended-hours fields must be cleared, never populated
    expect(row._ah_price).toBeUndefined();
  });

  it("stamps _live_price with price so zombie overlay fields cannot persist", async () => {
    const kv = mockKV({
      "timed:latest:AAPL": {
        ticker: "AAPL",
        price: 307.77,
        close: 307.77,
        _live_price: 307.77,
        prev_close: 325,
      },
    });
    const res = await mergeFreshnessIntoLatest(
      kv,
      { AAPL: { p: 331.91, pc: 325, t: Date.now(), dc: 6.91, dp: 2.13 } },
      { marketOpen: true },
    );
    expect(res.merged).toBe(1);
    const row = JSON.parse(kv.store.get("timed:latest:AAPL"));
    expect(row.price).toBe(331.91);
    expect(row.close).toBe(331.91);
    expect(row._live_price).toBe(331.91);
  });

  it("works without opts (env-less static session fallback, no throw)", async () => {
    const kv = mockKV({ "timed:latest:MSFT": { ticker: "MSFT", price: 500, prev_close: 495 } });
    const res = await mergeFreshnessIntoLatest(kv, { MSFT: { p: 502, pc: 495, t: Date.now(), dc: 7, dp: 1.41 } });
    expect(res.merged).toBe(1);
  });

  it("outside RTH: persists capped extended-hours fields", async () => {
    const kv = mockKV({ "timed:latest:SPY": { ticker: "SPY", price: 600, prev_close: 594 } });
    await mergeFreshnessIntoLatest(kv, { SPY: { p: 600, pc: 594, t: Date.now(), dc: 6, dp: 1.01, ahp: 601.2, ahdc: 1.2, ahdp: 0.2 } }, { marketOpen: false });
    const row = JSON.parse(kv.store.get("timed:latest:SPY"));
    expect(row._ah_price).toBe(601.2);
    expect(row._ah_change_pct).toBe(0.2);
  });
});
