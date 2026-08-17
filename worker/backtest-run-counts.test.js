import { describe, it, expect } from "vitest";
import { backfillMissingRunTradeCounts } from "./backtest-run-archive-helpers.js";

function fakeDb(rowsByStatus, capture = {}) {
  return {
    prepare(sql) {
      capture.sql = sql;
      return {
        bind(...args) {
          capture.args = args;
          return {
            async all() {
              return { results: rowsByStatus };
            },
          };
        },
      };
    },
  };
}

describe("backfillMissingRunTradeCounts", () => {
  it("recovers counts for runs whose metrics row was never written", async () => {
    const capture = {};
    const db = fakeDb([
      { run_id: "live-short-term-2026-08", status: "WIN", n: 7 },
      { run_id: "live-short-term-2026-08", status: "LOSS", n: 10 },
      { run_id: "live-short-term-2026-08", status: "FLAT", n: 2 },
      { run_id: "live-short-term-2026-08", status: "OPEN", n: 12 },
    ], capture);

    const rows = [
      { run_id: "live-short-term-2026-08", status: "completed", total_trades: null },
    ];
    await backfillMissingRunTradeCounts(db, rows);

    expect(rows[0].total_trades).toBe(31);
    expect(rows[0].closed_trades).toBe(19);
    expect(rows[0].open_trades).toBe(12);
    expect(rows[0].wins).toBe(7);
    expect(rows[0].losses).toBe(10);
    expect(rows[0].counts_source).toBe("backtest_run_trades");
    expect(capture.args).toEqual(["live-short-term-2026-08"]);
  });

  it("counts TP_HIT_TRIM as open, not closed", async () => {
    const db = fakeDb([
      { run_id: "r1", status: "TP_HIT_TRIM", n: 3 },
      { run_id: "r1", status: "WIN", n: 1 },
    ]);
    const rows = [{ run_id: "r1", total_trades: null }];
    await backfillMissingRunTradeCounts(db, rows);
    expect(rows[0].open_trades).toBe(3);
    expect(rows[0].closed_trades).toBe(1);
  });

  it("does not query when every row already has metrics", async () => {
    let called = false;
    const db = {
      prepare() {
        called = true;
        throw new Error("should not be called");
      },
    };
    const rows = [{ run_id: "r1", total_trades: 12 }, { run_id: "r2", total_trades: 0 }];
    await backfillMissingRunTradeCounts(db, rows);
    expect(called).toBe(false);
    expect(rows[0].total_trades).toBe(12);
    expect(rows[1].total_trades).toBe(0);
  });

  it("leaves counts null when the archive table is missing", async () => {
    const db = {
      prepare() {
        return { bind: () => ({ all: async () => { throw new Error("no such table"); } }) };
      },
    };
    const rows = [{ run_id: "r1", total_trades: null }];
    await backfillMissingRunTradeCounts(db, rows);
    expect(rows[0].total_trades).toBeNull();
  });
});
