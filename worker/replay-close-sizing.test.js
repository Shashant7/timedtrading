// Replay end-of-window close: the open leg must be sized off the position's
// real share count, not the legacy $1,000 TRADE_SIZE nominal.
//
// Regression: ja-* July/August 2026 arms booked every `replay_end_close` row
// on a $1,000 notional while the realized (trim) carry was booked on the real
// position. That understated pnl ~10x and, for trimmed positions, inflated
// pnl_pct by the same factor — CIBR Jul 30 reported +32.14% / $321 when the
// position actually made +3.99% / $477 on its $11,955 notional.

import { describe, it, expect } from "vitest";
import { closeReplayPositionsAtDate } from "./replay-admin-helpers.js";

const TRADE_SIZE = 1000;

function makeDeps() {
  return {
    d1EnsureBacktestRunsSchema: async () => {},
    nyWallTimeToUtcMs: (date) => new Date(`${date}T20:00:00Z`).getTime(),
    kvGetJSON: async () => null,
    kvPutJSON: async () => {},
    clamp: (v, lo, hi) => Math.min(hi, Math.max(lo, v)),
    TRADE_SIZE,
  };
}

/**
 * Minimal D1 double: serves the open trade row, swallows everything else, and
 * records the UPDATE bindings so the test can read back pnl / pnl_pct.
 */
function makeDb(openRow, markPrice) {
  const updates = [];
  const prepare = (sql) => ({
    bind: (...args) => ({
      all: async () => {
        if (/FROM trail_5m_facts/i.test(sql)) {
          return { results: [{ ticker: openRow.ticker, price_close: markPrice }] };
        }
        if (/FROM ticker_candles/i.test(sql)) {
          return { results: [{ ticker: openRow.ticker, c: markPrice }] };
        }
        if (/FROM trades/i.test(sql)) return { results: [openRow] };
        return { results: [] };
      },
      run: async () => ({}),
      first: async () => null,
      __sql: sql,
      __args: args,
    }),
    all: async () => ({ results: [] }),
    run: async () => ({}),
    first: async () => null,
    __sql: sql,
  });
  return {
    prepare,
    batch: async (stmts) => {
      for (const stmt of stmts) {
        if (/UPDATE trades/i.test(stmt.__sql || "")) updates.push(stmt.__args);
      }
      return [];
    },
    __updates: updates,
  };
}

describe("closeReplayPositionsAtDate — open-leg sizing", () => {
  // CIBR Jul 30 2026: 133.89 sh @ 89.29 ($11,955 notional), 50% trimmed with
  // $307.21 realized carry, marked at 91.83.
  const entryPx = 89.29;
  const shares = 133.89;
  const notional = 11955;
  const lastPx = 91.83;
  const trimmedPct = 0.5;
  const realizedCarry = 307.21;

  const baseRow = {
    trade_id: "t-cibr",
    ticker: "CIBR",
    direction: "LONG",
    entry_price: entryPx,
    entry_ts: 1,
    pnl: realizedCarry,
    trimmed_pct: trimmedPct,
    shares,
    notional,
    run_id: "test-run",
  };

  const runClose = async (row) => {
    const db = makeDb(row, lastPx);
    await closeReplayPositionsAtDate({
      env: {},
      KV: null,
      db,
      dateParam: "2026-07-31",
      runIdParam: "",
      deps: makeDeps(),
    });
    expect(db.__updates.length).toBe(1);
    const [status, , exitPrice, exitReason, pnl, pnlPct] = db.__updates[0];
    return { status, exitPrice, exitReason, pnl, pnlPct };
  };

  it("books the remaining leg on real shares, not the $1k nominal", async () => {
    const { pnl, pnlPct, exitReason } = await runClose(baseRow);
    const expectedPnl = realizedCarry + (lastPx - entryPx) * shares * (1 - trimmedPct);

    expect(exitReason).toBe("replay_end_close");
    expect(pnl).toBeCloseTo(expectedPnl, 2); // ~$477, not the ~$321 the bug produced
    expect(pnlPct).toBeCloseTo((expectedPnl / notional) * 100, 2); // ~3.99%, not 32.14%
  });

  it("derives shares from notional when the shares column is absent", async () => {
    const { pnl } = await runClose({ ...baseRow, shares: null });
    const expectedPnl = realizedCarry + (lastPx - entryPx) * (notional / entryPx) * (1 - trimmedPct);
    expect(pnl).toBeCloseTo(expectedPnl, 2);
  });

  it("falls back to TRADE_SIZE only when both shares and notional are missing", async () => {
    const { pnl } = await runClose({ ...baseRow, shares: null, notional: null });
    const expectedPnl =
      realizedCarry + (lastPx - entryPx) * (TRADE_SIZE / entryPx) * (1 - trimmedPct);
    expect(pnl).toBeCloseTo(expectedPnl, 2);
  });

  it("sizes an untrimmed position off the full share count", async () => {
    const { pnl, pnlPct, status } = await runClose({
      ...baseRow,
      pnl: 0,
      trimmed_pct: 0,
    });
    expect(pnl).toBeCloseTo((lastPx - entryPx) * shares, 2);
    expect(pnlPct).toBeCloseTo(((lastPx - entryPx) / entryPx) * 100, 2);
    expect(status).toBe("WIN");
  });

  it("keeps SHORT direction sign correct", async () => {
    const { pnl, status } = await runClose({
      ...baseRow,
      direction: "SHORT",
      pnl: 0,
      trimmed_pct: 0,
    });
    expect(pnl).toBeCloseTo(-(lastPx - entryPx) * shares, 2);
    expect(status).toBe("LOSS");
  });
});
