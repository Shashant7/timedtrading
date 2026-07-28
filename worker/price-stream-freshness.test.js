// 2026-07-07 MU/WDC/SOXL incident — the TwelveData WS stream wrote timed:prices
// rows with `p` + `t` only. Every freshness gate keys off q_ts/p_ts, so live
// stream ticks read as zombies once the last REST stamp aged past 10 min:
// /timed/all served the prior-day scoring close (MU $984.75 on a -6% day) and
// client merges rejected the fresh feed too (hard refresh didn't help).
import { describe, it, expect } from "vitest";
import {
  applyPriceSnapshotBatch,
  buildStreamFlushRow,
  mergeStreamRowIntoKv,
} from "./price-stream.js";
import {
  isPriceValueFresh,
  overlayTimedPricesRow,
  summarizeValueStaleSymbols,
} from "./feed/feed-outputs.js";

describe("buildStreamFlushRow", () => {
  it("stamps q_ts from the event timestamp and p_ts from the last price change", () => {
    const now = Date.now();
    const row = buildStreamFlushRow({
      last: 925.5, lastTs: now - 5000, lastChangeTs: now - 8000,
      prevClose: 984.75, dayHigh: 935.51, dayLow: 891.7, dayVol: 2982236,
    }, now);
    expect(row.p).toBe(925.5);
    expect(row.q_ts).toBe(now - 5000);
    expect(row.p_ts).toBe(now - 8000);
    expect(row.dp).toBeCloseTo(-6.02, 1);
  });

  it("falls back p_ts to lastTs for legacy symState without lastChangeTs", () => {
    const now = Date.now();
    const row = buildStreamFlushRow({ last: 100, lastTs: now - 1000, prevClose: 99 }, now);
    expect(row.p_ts).toBe(now - 1000);
  });

  it("produces rows that pass the RTH value-freshness gate", () => {
    const now = Date.now();
    const row = buildStreamFlushRow({ last: 157.89, lastTs: now - 10_000, lastChangeTs: now - 10_000, prevClose: 194.65 }, now);
    expect(isPriceValueFresh(row, now, true)).toBe(true);
  });

  it("outside RTH keeps RTH close on p and parks live print on ahp (IBM pattern)", () => {
    const now = Date.now();
    const row = buildStreamFlushRow({
      last: 222.69,
      dailyClose: 290.23,
      prevClose: 287.56,
      lastTs: now,
      lastChangeTs: now,
    }, now, { session: "PRE" });
    expect(row.p).toBe(290.23);
    expect(row.dp).toBeCloseTo(0.93, 1);
    expect(row.ahp).toBe(222.69);
    expect(row.ahdp).toBeCloseTo(-23.27, 1);
  });

  it("crypto outside RTH still writes last onto p", () => {
    const now = Date.now();
    const row = buildStreamFlushRow({
      last: 65000, dailyClose: 64000, prevClose: 64000, lastTs: now, lastChangeTs: now,
    }, now, { session: "PRE", isCrypto: true });
    expect(row.p).toBe(65000);
    expect(row.ahp).toBeUndefined();
  });
});

describe("mergeStreamRowIntoKv", () => {
  it("never regresses q_ts/p_ts below a newer REST sweep stamp", () => {
    const now = Date.now();
    const ex = { p: 925, pc: 984.75, q_ts: now - 1000, p_ts: now - 1000, ahp: 920 };
    const row = { p: 925.5, pc: 984.75, dc: -59.25, dp: -6.02, t: now - 60_000, q_ts: now - 60_000, p_ts: now - 60_000 };
    const merged = mergeStreamRowIntoKv(ex, row);
    expect(merged.q_ts).toBe(now - 1000);
    expect(merged.p_ts).toBe(now - 1000);
    expect(merged.p).toBe(925.5);
    expect(merged.ahp).toBe(920); // REST-written EXT fields preserved
  });

  it("advances q_ts/p_ts when the stream tick is newer", () => {
    const now = Date.now();
    const ex = { p: 924, pc: 984.75, q_ts: now - 30 * 60_000, p_ts: now - 30 * 60_000 };
    const row = { p: 925.5, pc: 984.75, dc: -59.25, dp: -6.02, t: now, q_ts: now, p_ts: now };
    const merged = mergeStreamRowIntoKv(ex, row);
    expect(merged.q_ts).toBe(now);
    expect(merged.p_ts).toBe(now);
    expect(isPriceValueFresh(merged, now, true)).toBe(true);
  });

  it("price-only rows (unseeded pc) still stamp timestamps without clobbering daily fields", () => {
    const now = Date.now();
    const ex = { p: 50, pc: 49, dc: 1, dp: 2.04, q_ts: now - 20 * 60_000, p_ts: now - 20 * 60_000 };
    const row = { p: 51, pc: 0, dc: null, dp: null, dh: 0, dl: 0, dv: 0, t: now, q_ts: now, p_ts: now };
    const merged = mergeStreamRowIntoKv(ex, row);
    expect(merged.p).toBe(51);
    expect(merged.pc).toBe(49); // seeded pc preserved
    expect(merged.dc).toBe(1);
    expect(merged.q_ts).toBe(now);
  });

  it("outside RTH remaps legacy AH-on-p ticks onto ahp without clobbering RTH close", () => {
    const now = Date.now();
    const ex = {
      p: 290.23, pc: 287.56, dc: 2.67, dp: 0.93,
      q_ts: now - 60_000, p_ts: now - 60_000,
    };
    const legacyAhOnP = {
      p: 222.69, pc: 287.56, dc: -64.87, dp: -22.56,
      t: now, q_ts: now, p_ts: now,
    };
    const merged = mergeStreamRowIntoKv(ex, legacyAhOnP, { session: "PRE" });
    expect(merged.p).toBe(290.23);
    expect(merged.dp).toBe(0.93);
    expect(merged.ahp).toBe(222.69);
    expect(merged.ahdp).toBeCloseTo(-23.27, 1);
    expect(merged.q_ts).toBe(now);
  });
});

describe("incident regression: stream tick must reach /timed/all", () => {
  it("a stream-flushed row overlays the prior-day scoring snapshot during RTH", () => {
    const now = Date.now();
    // Exact incident shape: snapshot baked at Monday close (984.75, +0.94%),
    // stream ticking live at 925.5 (-6%) on Tuesday.
    const snapshotRow = { ticker: "MU", price: 984.75, close: 984.75, prev_close: 975.56, day_change_pct: 0.94 };
    const streamRow = buildStreamFlushRow({
      last: 925.5, lastTs: now - 15_000, lastChangeTs: now - 15_000, prevClose: 984.75,
    }, now);
    const kvRow = mergeStreamRowIntoKv({ q_ts: now - 33 * 60_000, p_ts: now - 33 * 60_000 }, streamRow);
    overlayTimedPricesRow(snapshotRow, kvRow, { sym: "MU", marketOpen: true });
    expect(snapshotRow.price).toBe(925.5);
    expect(snapshotRow._live_price).toBe(925.5);
    expect(snapshotRow.day_change_pct).toBeCloseTo(-6.02, 1);
  });

  it("the OLD row shape (p+t only, stale q_ts) is rejected — doctrine unchanged", () => {
    const now = Date.now();
    const snapshotRow = { ticker: "MU", price: 984.75, close: 984.75, prev_close: 975.56, day_change_pct: 0.94 };
    const oldShape = { p: 925.5, pc: 984.75, dp: -6.02, t: now, q_ts: now - 33 * 60_000, p_ts: now - 33 * 60_000 };
    overlayTimedPricesRow(snapshotRow, oldShape, { sym: "MU", marketOpen: true });
    expect(snapshotRow.price).toBe(984.75); // gate correctly refuses stale-stamped values
  });
});

// 2026-07-28 — QUIET-SYMBOL FRESHNESS. TwelveData's /quote returns
// minute-quantized (and often 30+ min old) `last_quote_at` for quiet
// mid-caps. The DO's `_applySnapshots` previously stamped
// `existing.lastTs = data.trade_ts` on the !priceChanged branch — so the
// DO's next KV flush wrote a stale q_ts that could clobber the cron sweep's
// fresh stamp via `mergeStreamRowIntoKv`'s `max(base, next)` when the DO's
// KV read missed a recent cron write (KV eventual consistency between
// writers is up to ~60s). Result: 46-62 quiet symbols paged
// price_value_freshness with 30-38m ages even though the feed was healthy.
// Fix: on every successful refresh, `lastTs = max(nextTs, receiptTs)`.
describe("applyPriceSnapshotBatch — quiet-symbol freshness", () => {
  it("advances lastTs to receiptTs even when the vendor trade_ts is stale (!priceChanged)", () => {
    const receiptTs = 1_785_267_240_000;
    const staleTradeTs = receiptTs - 33 * 60_000;
    const symState = {
      OKLO: {
        last: 39.49,
        lastTs: receiptTs - 20 * 60_000,
        lastChangeTs: receiptTs - 45 * 60_000,
        prevClose: 39.5,
        dailyClose: 39.49,
      },
    };
    applyPriceSnapshotBatch(
      symState,
      {
        OKLO: {
          price: 39.49,
          dailyClose: 39.49,
          prevDailyClose: 39.5,
          trade_ts: staleTradeTs,
        },
      },
      { receiptTs, session: "RTH" },
    );
    expect(symState.OKLO.lastTs).toBe(receiptTs);
    expect(symState.OKLO.lastChangeTs).toBe(receiptTs - 45 * 60_000); // p didn't move → not bumped
    expect(symState.OKLO.dirty).toBe(true);
  });

  it("also advances lastTs to receiptTs when priceChanged, and moves lastChangeTs too", () => {
    const receiptTs = 1_785_267_240_000;
    const symState = {
      NVDA: {
        last: 190,
        lastTs: receiptTs - 5_000,
        lastChangeTs: receiptTs - 5_000,
        prevClose: 189,
      },
    };
    applyPriceSnapshotBatch(
      symState,
      {
        NVDA: {
          price: 192.5,
          dailyClose: 192.5,
          prevDailyClose: 189,
          trade_ts: receiptTs - 500,
        },
      },
      { receiptTs, session: "RTH" },
    );
    expect(symState.NVDA.last).toBe(192.5);
    expect(symState.NVDA.lastTs).toBe(receiptTs);
    expect(symState.NVDA.lastChangeTs).toBe(receiptTs);
  });

  it("keeps a vendor trade_ts that is somehow fresher than the local clock", () => {
    const receiptTs = 1_785_267_240_000;
    const futureTradeTs = receiptTs + 2_000; // vendor clock ahead of local by 2s
    const symState = {
      AAPL: {
        last: 220,
        lastTs: receiptTs - 60_000,
        prevClose: 219,
      },
    };
    applyPriceSnapshotBatch(
      symState,
      {
        AAPL: {
          price: 220,
          dailyClose: 220,
          prevDailyClose: 219,
          trade_ts: futureTradeTs,
        },
      },
      { receiptTs, session: "RTH" },
    );
    expect(symState.AAPL.lastTs).toBe(futureTradeTs);
  });

  it("seeds a brand-new quiet symbol with lastTs = receiptTs, not the vendor's stale trade clock", () => {
    const receiptTs = 1_785_267_240_000;
    const staleTradeTs = receiptTs - 45 * 60_000;
    const symState = {};
    applyPriceSnapshotBatch(
      symState,
      {
        WULF: {
          price: 16.61,
          dailyClose: 16.61,
          prevDailyClose: 16.5,
          trade_ts: staleTradeTs,
        },
      },
      { receiptTs, session: "RTH" },
    );
    expect(symState.WULF.lastTs).toBe(receiptTs);
    // lastChangeTs seeded from vendor trade_ts (best-effort "last observed move")
    expect(symState.WULF.lastChangeTs).toBe(staleTradeTs);
  });

  it("does not advance lastTs when the /quote response carries no price (skip)", () => {
    const receiptTs = 1_785_267_240_000;
    const symState = {
      DEAD: { last: 10, lastTs: receiptTs - 40 * 60_000 },
    };
    applyPriceSnapshotBatch(
      symState,
      { DEAD: { price: 0, dailyClose: 0, trade_ts: receiptTs - 40 * 60_000 } },
      { receiptTs, session: "RTH" },
    );
    expect(symState.DEAD.lastTs).toBe(receiptTs - 40 * 60_000);
  });

  it("a batch of 40 quiet symbols with identical stale vendor trade_ts all get fresh lastTs", () => {
    const receiptTs = 1_785_267_240_000;
    const staleShared = receiptTs - 30 * 60_000;
    const symState = {};
    for (let i = 0; i < 40; i++) symState[`Q${i}`] = { last: 10, lastTs: receiptTs - 30 * 60_000 };
    const snaps = {};
    for (let i = 0; i < 40; i++) {
      snaps[`Q${i}`] = { price: 10, dailyClose: 10, prevDailyClose: 10, trade_ts: staleShared };
    }
    applyPriceSnapshotBatch(symState, snaps, { receiptTs, session: "RTH" });
    for (let i = 0; i < 40; i++) {
      expect(symState[`Q${i}`].lastTs).toBe(receiptTs);
    }
  });

  it("regression: flushed rows built from post-fix symState pass the RTH value-freshness gate", () => {
    const receiptTs = 1_785_267_240_000;
    const staleTradeTs = receiptTs - 33 * 60_000;
    const symState = {
      DUOL: { last: 140.47, lastTs: receiptTs - 33 * 60_000, prevClose: 141 },
    };
    applyPriceSnapshotBatch(
      symState,
      {
        DUOL: {
          price: 140.47,
          dailyClose: 140.47,
          prevDailyClose: 141,
          trade_ts: staleTradeTs,
        },
      },
      { receiptTs, session: "RTH" },
    );
    const row = buildStreamFlushRow(symState.DUOL, receiptTs);
    expect(row.q_ts).toBe(receiptTs);
    expect(isPriceValueFresh(row, receiptTs, true)).toBe(true);
    // Merge with a KV row whose q_ts is even older — max(fresh, stale) wins.
    const kvStale = { p: 140.5, pc: 141, q_ts: receiptTs - 45 * 60_000 };
    const merged = mergeStreamRowIntoKv(kvStale, row);
    expect(merged.q_ts).toBe(receiptTs);
    expect(isPriceValueFresh(merged, receiptTs, true)).toBe(true);
  });

  it("outside RTH: extendedPrice wins over dailyClose for liveP, and lastTs still fresh", () => {
    const receiptTs = 1_785_267_240_000;
    const symState = {};
    applyPriceSnapshotBatch(
      symState,
      {
        IBM: {
          price: 290,
          extendedPrice: 222.69,
          dailyClose: 290.23,
          prevDailyClose: 287.56,
          trade_ts: receiptTs - 5_000,
        },
      },
      { receiptTs, session: "PRE" },
    );
    expect(symState.IBM.last).toBe(222.69); // AH print
    expect(symState.IBM.lastTs).toBe(receiptTs);
  });
});

describe("summarizeValueStaleSymbols", () => {
  it("counts symbols whose vendor value stamp is outside the RTH window", () => {
    const now = Date.now();
    const prices = {
      MU: { p: 925, q_ts: now - 33 * 60_000, p_ts: now - 33 * 60_000 },
      NVDA: { p: 193, q_ts: now - 60_000, p_ts: now - 60_000 },
      LEGACY: { p: 10, t: now }, // no value stamps at all
      "ES1!": { p: 6000, t: now }, // futures excluded
      SPX: { p: 6400, t: now }, // index gauge excluded
    };
    const res = summarizeValueStaleSymbols(prices, now, true);
    expect(res.count).toBe(2);
    // Never-stamped rows sort first (worst), then oldest ages.
    expect(res.symbols).toEqual(["LEGACY:never", "MU:33m"]);
  });

  it("applies grace so quiet-tape lag does not page", () => {
    const now = Date.now();
    const prices = {
      QUIET: { p: 20, q_ts: now - 15 * 60_000, p_ts: now - 15 * 60_000 },
      DEAD: { p: 20, q_ts: now - 45 * 60_000, p_ts: now - 45 * 60_000 },
    };
    const res = summarizeValueStaleSymbols(prices, now, true, 10, { graceMs: 10 * 60_000 });
    expect(res.count).toBe(1);
    expect(res.symbols[0]).toBe("DEAD:45m");
  });

  it("excludes junk TEST rows from display-staleness accounting", () => {
    const now = Date.now();
    const prices = {
      TEST: { p: 1, q_ts: now - 90 * 60_000, p_ts: now - 90 * 60_000 },
      MU: { p: 925, q_ts: now - 33 * 60_000, p_ts: now - 33 * 60_000 },
    };
    const res = summarizeValueStaleSymbols(prices, now, true);
    expect(res.count).toBe(1);
    expect(res.symbols[0]).toBe("MU:33m");
  });
});
