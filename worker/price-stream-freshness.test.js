// 2026-07-07 MU/WDC/SOXL incident — the TwelveData WS stream wrote timed:prices
// rows with `p` + `t` only. Every freshness gate keys off q_ts/p_ts, so live
// stream ticks read as zombies once the last REST stamp aged past 10 min:
// /timed/all served the prior-day scoring close (MU $984.75 on a -6% day) and
// client merges rejected the fresh feed too (hard refresh didn't help).
import { describe, it, expect } from "vitest";
import { buildStreamFlushRow, mergeStreamRowIntoKv } from "./price-stream.js";
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
