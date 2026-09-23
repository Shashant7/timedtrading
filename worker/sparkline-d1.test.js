// The scoring tick asked D1 for the whole universe's daily closes in one
// statement -- 329 bound parameters against a cap of 100 -- so every run
// logged `[SCORING] Sparkline enrichment failed: D1_ERROR: too many SQL
// variables at offset 451` and no ticker got a fresh sparkline.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchSparklinesFromD1, SPARKLINE_BIND_LIMIT } from "./sparkline-d1.js";

/** A D1 stand-in that enforces the real bind cap. */
function fakeDB(rowsFor, { bindCap = 100 } = {}) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      return {
        bind(...binds) {
          calls.push({ sql, binds });
          return {
            async all() {
              if (binds.length > bindCap) {
                throw new Error(`D1_ERROR: too many SQL variables at offset 451: SQLITE_ERROR`);
              }
              return { results: rowsFor(binds.filter((b) => typeof b === "string")) };
            },
          };
        },
      };
    },
  };
}

const closesFor = (syms) => syms.flatMap((s, i) => [
  { ticker: s, ts: 1, c: 10 + i },
  { ticker: s, ts: 2, c: 11 + i },
]);

describe("fetchSparklinesFromD1", () => {
  let warn;
  beforeEach(() => { warn = vi.spyOn(console, "warn").mockImplementation(() => {}); });
  afterEach(() => { warn.mockRestore(); });

  it("fetches the live 329-ticker universe, which the single statement could not", async () => {
    const syms = Array.from({ length: 329 }, (_, i) => `T${i}`);
    const DB = fakeDB(closesFor);
    const out = await fetchSparklinesFromD1(DB, syms);
    expect(Object.keys(out)).toHaveLength(329);
    expect(out.T0).toEqual([10, 11]);
  });

  it("never exceeds D1's bind cap, with or without a ts floor", async () => {
    const syms = Array.from({ length: 329 }, (_, i) => `T${i}`);
    for (const sinceMs of [0, 1_700_000_000_000]) {
      const DB = fakeDB(closesFor);
      await fetchSparklinesFromD1(DB, syms, { sinceMs });
      expect(DB.calls.length).toBeGreaterThan(1);
      for (const c of DB.calls) expect(c.binds.length).toBeLessThanOrEqual(100);
    }
  });

  it("spends a bind slot on the ts floor rather than overflowing", async () => {
    const syms = Array.from({ length: SPARKLINE_BIND_LIMIT }, (_, i) => `T${i}`);
    const DB = fakeDB(closesFor);
    await fetchSparklinesFromD1(DB, syms, { sinceMs: 123 });
    expect(DB.calls[0].binds).toHaveLength(SPARKLINE_BIND_LIMIT);
    expect(DB.calls[0].binds.at(-1)).toBe(123);
  });

  it("keeps closes oldest-first, the order the sparkline draws in", async () => {
    const DB = fakeDB(() => [
      { ticker: "AMD", ts: 1, c: 100 },
      { ticker: "AMD", ts: 2, c: 101 },
      { ticker: "AMD", ts: 3, c: 102 },
    ]);
    const out = await fetchSparklinesFromD1(DB, ["AMD"]);
    expect(out.AMD).toEqual([100, 101, 102]);
  });

  it("loses one bad chunk, not the other 300 tickers", async () => {
    const syms = Array.from({ length: 200 }, (_, i) => `T${i}`);
    let n = 0;
    const DB = {
      prepare: () => ({
        bind: (...binds) => ({
          all: async () => {
            if (n++ === 0) throw new Error("D1_ERROR: no such table: ticker_candles");
            return { results: closesFor(binds) };
          },
        }),
      }),
    };
    const out = await fetchSparklinesFromD1(DB, syms);
    expect(Object.keys(out).length).toBeGreaterThan(100);
    expect(out.T0).toBeUndefined();
    expect(warn.mock.calls[0][0]).toContain("[sparklines]");
  });

  it("dedupes and normalizes the ticker list", async () => {
    const DB = fakeDB(closesFor);
    await fetchSparklinesFromD1(DB, ["amd", "AMD", "", null, "WAY_TOO_LONG_TICKER"]);
    expect(DB.calls[0].binds).toEqual(["AMD"]);
  });

  it("returns an empty map rather than throwing on no input", async () => {
    expect(await fetchSparklinesFromD1(null, ["AMD"])).toEqual({});
    expect(await fetchSparklinesFromD1(fakeDB(closesFor), [])).toEqual({});
    expect(await fetchSparklinesFromD1(fakeDB(closesFor), null)).toEqual({});
  });
});
