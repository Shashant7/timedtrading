import { describe, it, expect } from "vitest";
import { isDuplicateExitEvent, computeLedgerReconciliation } from "./ledger-reconcile.js";

/** Minimal D1 mock: routes each prepared SQL to a canned responder. */
function makeDb(responders) {
  return {
    prepare(sql) {
      const responder = responders.find((r) => r.match.test(sql));
      if (!responder) throw new Error(`no responder for sql: ${sql.slice(0, 80)}`);
      const call = { sql, binds: [] };
      return {
        bind(...args) { call.binds = args; return this; },
        async first() { return responder.first ? responder.first(call) : null; },
        async all() { return { results: responder.all ? responder.all(call) : [] }; },
        async run() { return { success: true }; },
      };
    },
  };
}

describe("isDuplicateExitEvent", () => {
  const existingExit = { ledger_id: 80095, qty: 105.76807770715915, price: 81.39998104 };

  function dbWithExits(rows) {
    return makeDb([{ match: /FROM account_ledger/, all: () => rows }]);
  }

  it("flags the exact production double-fire shape (KO 2026-07-13)", async () => {
    const dup = await isDuplicateExitEvent(dbWithExits([existingExit]), {
      mode: "trader",
      event_type: "EXIT",
      position_id: "t_ko",
      qty: 105.76807770715915,
      price: 81.39998104,
    });
    expect(dup).toBe(true);
  });

  it("allows a second EXIT with a different fill (staged exit)", async () => {
    const dup = await isDuplicateExitEvent(dbWithExits([existingExit]), {
      mode: "trader",
      event_type: "EXIT",
      position_id: "t_ko",
      qty: 50,
      price: 81.10,
    });
    expect(dup).toBe(false);
  });

  it("never blocks non-EXIT events", async () => {
    const dup = await isDuplicateExitEvent(dbWithExits([existingExit]), {
      mode: "trader",
      event_type: "TRIM",
      position_id: "t_ko",
      qty: 105.76807770715915,
      price: 81.39998104,
    });
    expect(dup).toBe(false);
  });

  it("never blocks when position_id is missing", async () => {
    const dup = await isDuplicateExitEvent(dbWithExits([existingExit]), {
      mode: "trader",
      event_type: "EXIT",
      qty: 1,
      price: 2,
    });
    expect(dup).toBe(false);
  });

  it("fails open when the lookup throws (missed dedupe is recoverable; a blocked close is not)", async () => {
    const db = {
      prepare() {
        return { bind() { return this; }, async all() { throw new Error("boom"); } };
      },
    };
    const dup = await isDuplicateExitEvent(db, {
      mode: "trader",
      event_type: "EXIT",
      position_id: "x",
      qty: 1,
      price: 2,
    });
    expect(dup).toBe(false);
  });
});

describe("computeLedgerReconciliation", () => {
  it("decomposes the audit's $142.44 gap and reports reconciled", async () => {
    // Production shape from 2026-09-04: rows 37,047.91 vs events 36,905.47;
    // 339.64 net per-trade drift minus 197.20 open-trade trims == 142.44.
    const db = makeDb([
      {
        match: /events_realized/,
        first: () => ({
          events_realized: 36905.47,
          closed_rows_pnl: 37047.91,
          events_on_open_trades: 197.20,
          event_count: 1679,
          closed_row_count: 748,
        }),
      },
      {
        match: /LEFT JOIN/,
        all: () => [
          { trade_id: "ko", ticker: "KO", status: "LOSS", row_pnl: -210.48, event_pnl: -420.96, drift: 210.48 },
          { trade_id: "rest", ticker: "ZZZ", status: "WIN", row_pnl: 129.16, event_pnl: 0, drift: 129.16 },
        ],
      },
      {
        match: /GROUP BY position_id/,
        all: () => [
          { position_id: "ko", ticker: "KO", n: 2, total_rpnl: -420.96, total_cash: 17219.04 },
        ],
      },
    ]);

    const out = await computeLedgerReconciliation(db);
    expect(out.gap).toBe(142.44);
    expect(out.decomposition.per_trade_drift_total).toBe(339.64);
    expect(out.decomposition.events_on_open_trades).toBe(197.20);
    expect(out.decomposition.explained).toBe(142.44);
    expect(out.decomposition.residual).toBe(0);
    expect(out.reconciled).toBe(true);
    expect(out.duplicate_exit_events).toHaveLength(1);
  });

  it("reports unreconciled when residual drift remains", async () => {
    const db = makeDb([
      {
        match: /events_realized/,
        first: () => ({
          events_realized: 1000,
          closed_rows_pnl: 1500,
          events_on_open_trades: 0,
          event_count: 10,
          closed_row_count: 5,
        }),
      },
      { match: /LEFT JOIN/, all: () => [] },
      { match: /GROUP BY position_id/, all: () => [] },
    ]);
    const out = await computeLedgerReconciliation(db);
    expect(out.gap).toBe(500);
    expect(out.reconciled).toBe(false);
    expect(out.decomposition.residual).toBe(500);
  });
});
