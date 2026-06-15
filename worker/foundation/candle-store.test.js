import { describe, it, expect } from "vitest";
import {
  upsertSeries, tailBase5, materializeIntraday, materializeAllIntraday,
  materializeDailyDerived, readMaterialized, cursorTs, DEFAULT_TAIL_DAYS,
} from "./candle-store.js";
import { resampleIntradaySessions } from "./resample.js";
import { defaultSessionClip, DERIVED_INTRADAY_TFS } from "./candle-chain.js";
import { expectedIntradayBuckets } from "./trading-calendar.js";

// Three consecutive trading days of synthetic 5m bars (extended-hours grid).
const DAYS = ["2026-06-10", "2026-06-11", "2026-06-12"];
function session5m(dateStr) {
  return expectedIntradayBuckets(dateStr, 5).map((ts, i) => ({
    ts, o: 100 + i, h: 100 + i + 0.5, l: 100 + i - 0.5, c: 100 + i + 0.2, v: 10 + i,
  }));
}
const FULL_5M = DAYS.flatMap(session5m).sort((a, b) => a.ts - b.ts);

function fullResample(tf) {
  return resampleIntradaySessions(FULL_5M, Number(tf), { clipToSession: defaultSessionClip(tf) });
}

describe("upsertSeries", () => {
  it("replaces by ts (incoming wins), sorts, caps", () => {
    const a = [{ ts: 1, c: 1 }, { ts: 2, c: 2 }];
    const b = [{ ts: 2, c: 99 }, { ts: 3, c: 3 }];
    const out = upsertSeries(a, b, 0);
    expect(out.map((x) => x.ts)).toEqual([1, 2, 3]);
    expect(out.find((x) => x.ts === 2).c).toBe(99); // incoming won
  });
  it("caps to the last N", () => {
    const big = Array.from({ length: 10 }, (_, i) => ({ ts: i, c: i }));
    expect(upsertSeries(big, [], 3).map((x) => x.ts)).toEqual([7, 8, 9]);
  });
});

describe("tailBase5", () => {
  it("returns whole last-N ET sessions (so resample buckets align)", () => {
    const tail = tailBase5(FULL_5M, 1);
    const lastDayBars = session5m(DAYS[2]);
    expect(tail.length).toBe(lastDayBars.length);
    expect(tail[0].ts).toBe(lastDayBars[0].ts); // starts on a session boundary
  });
});

describe("PARITY INVARIANT — incremental materialize == full resample", () => {
  // Feed the base in small additive CHUNKS (like 1-2 bars/tick), materializing the
  // tail each time; the final materialized series must equal a from-scratch resample.
  for (const tf of DERIVED_INTRADAY_TFS) {
    it(`tf=${tf}: chunked additive ingest reproduces the full resample`, () => {
      let materialized = [];
      const baseSoFar = [];
      const CHUNK = 7; // arbitrary small additive batch, crosses bucket boundaries
      for (let i = 0; i < FULL_5M.length; i += CHUNK) {
        for (const b of FULL_5M.slice(i, i + CHUNK)) baseSoFar.push(b);
        materialized = materializeIntraday(materialized, baseSoFar, tf, { tailDays: DEFAULT_TAIL_DAYS, cap: 0 });
      }
      const full = fullResample(tf);
      expect(materialized.map((b) => b.ts)).toEqual(full.map((b) => b.ts));
      // OHLCV identical, not just the grid
      for (let i = 0; i < full.length; i++) {
        expect(materialized[i].o).toBe(full[i].o);
        expect(materialized[i].h).toBe(full[i].h);
        expect(materialized[i].l).toBe(full[i].l);
        expect(materialized[i].c).toBe(full[i].c);
        expect(materialized[i].v).toBe(full[i].v);
      }
    });
  }

  it("a LATE 5m bar (arrives after its bucket was first materialized) corrects the bucket", () => {
    const tf = "10";
    // ingest all but the 2nd bar, then ingest the 2nd bar late (full re-derive so
    // the 3-day base is fully covered; the upsert must correct the first bucket)
    const without2nd = FULL_5M.filter((_, i) => i !== 1);
    let m = materializeIntraday([], without2nd, tf, { cap: 0, full: true });
    m = materializeIntraday(m, FULL_5M, tf, { cap: 0, full: true }); // late bar now present
    const full = fullResample(tf);
    expect(m.map((b) => b.ts)).toEqual(full.map((b) => b.ts));
    expect(m[0].v).toBe(full[0].v); // first 10m bucket volume now matches full
  });
});

describe("materializeAllIntraday", () => {
  it("materializes every LTF in one pass, each matching its full resample", () => {
    const all = materializeAllIntraday({}, FULL_5M, { cap: 0, full: true });
    for (const tf of DERIVED_INTRADAY_TFS) {
      expect(all[tf].map((b) => b.ts)).toEqual(fullResample(tf).map((b) => b.ts));
    }
  });
});

describe("materializeDailyDerived (W/M)", () => {
  const daily = Array.from({ length: 80 }, (_, i) => ({
    ts: Date.UTC(2026, 0, 1 + i), o: 10 + i, h: 11 + i, l: 9 + i, c: 10.5 + i, v: 1000,
  }));
  it("derives weekly + monthly from the daily base", () => {
    const w = materializeDailyDerived(daily, "W", { cap: 0 });
    const m = materializeDailyDerived(daily, "M", { cap: 0 });
    expect(w.length).toBeGreaterThan(0);
    expect(m.length).toBeGreaterThan(0);
    expect(m.length).toBeLessThan(w.length); // fewer months than weeks
  });
});

describe("readMaterialized", () => {
  const s = Array.from({ length: 100 }, (_, i) => ({ ts: i * 1000, c: i }));
  it("slices to limit (freshest)", () => {
    expect(readMaterialized(s, { limit: 5 }).map((b) => b.c)).toEqual([95, 96, 97, 98, 99]);
  });
  it("slices to window", () => {
    const w = readMaterialized(s, { startMs: 10000, endMs: 15000 });
    expect(w.map((b) => b.c)).toEqual([10, 11, 12, 13, 14]);
  });
});

describe("cursorTs", () => {
  it("returns the newest ts (the additive ingest cursor)", () => {
    expect(cursorTs(FULL_5M)).toBe(FULL_5M[FULL_5M.length - 1].ts);
    expect(cursorTs([])).toBe(0);
  });
});
