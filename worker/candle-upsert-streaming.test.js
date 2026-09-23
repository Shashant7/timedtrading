// The bar cron's D1 upsert used to build one bound statement per bar for the
// WHOLE universe before writing any of them. A top-of-hour pass is ~10k bars
// and each statement re-prepared the same ~450-char SQL from a fresh template
// literal, so the statement array alone was the largest thing the monolith's
// */5 tick held — on a worker whose isolate was already dying with
// `exceededMemory` 9-14s into every tick.
//
// These pin the two properties that matter: the writes are flushed as the bars
// are walked (peak is one batch, not the pass), and nothing is dropped or
// duplicated by the streaming.

import { describe, it, expect } from "vitest";
import { _batchUpsertBars } from "./data-provider.js";

function fakeDb() {
  const calls = { prepares: 0, batches: [], peakPending: 0 };
  const prepared = {
    bind: (...args) => ({ __bound: args }),
  };
  return {
    calls,
    prepare(sql) {
      calls.prepares++;
      calls.sql = sql;
      return prepared;
    },
    async batch(stmts) {
      calls.batches.push(stmts.length);
      calls.peakPending = Math.max(calls.peakPending, stmts.length);
      return stmts.map(() => ({ success: true }));
    },
  };
}

function barsFor(symbols, perSymbol) {
  const out = {};
  for (const sym of symbols) {
    out[sym] = Array.from({ length: perSymbol }, (_, i) => ({
      t: new Date(Date.UTC(2026, 8, 23, 13, 30 + i)).toISOString(),
      o: 10 + i, h: 11 + i, l: 9 + i, c: 10.5 + i, v: 1000 + i,
    }));
  }
  return out;
}

describe("_batchUpsertBars streams instead of materialising the pass", () => {
  it("prepares the SQL once, not once per bar", async () => {
    const db = fakeDb();
    await _batchUpsertBars(db, barsFor(["AAA", "BBB", "CCC"], 40), "10");
    expect(db.calls.prepares).toBe(1);
  });

  it("never holds more than one batch of statements", async () => {
    const db = fakeDb();
    // 30 symbols x 120 bars = 3600 statements, seven batches of 500.
    await _batchUpsertBars(db, barsFor(
      Array.from({ length: 30 }, (_, i) => `S${i}`), 120,
    ), "5");
    expect(db.calls.peakPending).toBeLessThanOrEqual(500);
    expect(db.calls.batches.length).toBeGreaterThan(1);
  });

  it("writes every valid bar exactly once", async () => {
    const db = fakeDb();
    const res = await _batchUpsertBars(db, barsFor(["AAA", "BBB"], 7), "D");
    const written = db.calls.batches.reduce((a, b) => a + b, 0);
    expect(written).toBe(14);
    expect(res.upserted).toBe(14);
    expect(res.errors).toBe(0);
  });

  it("skips bars with an unparseable timestamp or a non-finite OHLC", async () => {
    const db = fakeDb();
    const res = await _batchUpsertBars(db, {
      AAA: [
        { t: "not-a-date", o: 1, h: 2, l: 0.5, c: 1.5, v: 10 },
        { t: "2026-09-23T13:30:00Z", o: 1, h: null, l: 0.5, c: 1.5, v: 10 },
        { t: "2026-09-23T13:35:00Z", o: 1, h: 2, l: 0.5, c: 1.5, v: 10 },
      ],
      BBB: "not-an-array",
    }, "5");
    expect(res.upserted).toBe(1);
  });

  it("releases each symbol from the caller's map as it is consumed", async () => {
    const db = fakeDb();
    const bars = barsFor(["AAA", "BBB", "CCC"], 3);
    await _batchUpsertBars(db, bars, "60");
    expect(Object.keys(bars)).toEqual([]);
  });

  it("falls back to smaller batches when a batch fails, and counts the losses", async () => {
    const db = fakeDb();
    let first = true;
    const realBatch = db.batch.bind(db);
    db.batch = async (stmts) => {
      if (first && stmts.length === 500) { first = false; throw new Error("D1_ERROR"); }
      return realBatch(stmts);
    };
    const res = await _batchUpsertBars(db, barsFor(
      Array.from({ length: 10 }, (_, i) => `S${i}`), 60,
    ), "15");
    // 600 bars: the failed 500 is retried as five 100s, then the tail of 100.
    expect(res.upserted).toBe(600);
    expect(res.errors).toBe(0);
  });
});
