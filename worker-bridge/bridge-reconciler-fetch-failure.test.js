// worker-bridge/bridge-reconciler-fetch-failure.test.js
//
// 2026-09-22 — A broker position fetch that FAILS must never be read as
// "the broker holds nothing".
//
// The reconciler's outage guard used to require that BOTH the equity and
// the options fetch had failed. An equity-only row set can never satisfy
// that: `hasOptions` is false, so the second half of the AND is false no
// matter how badly the equity call went. A rate-limited Webull positions
// call therefore fell through to classification with an empty position
// map, and every live row came out `mothership_orphan` —
// "model_open expected N but broker holds 0 (user closed manually?)".
//
// Because drift notifications dedup one warn per trade per day, the
// account drained into the operator's inbox a few tickers at a time:
// TQQQ at 2:35 PM ET on 2026-09-21, then UDOW / TNA / NBIS / P at 2:50,
// each of them still held in the Roth IRA the whole time.

import { describe, it, expect } from "vitest";
import { reconcileUser } from "./bridge-reconciler.js";

function makeDb({ rows = [] } = {}) {
  const updates = [];
  return {
    updates,
    prepare(sql) {
      const s = String(sql || "");
      const stmt = { sql: s, args: [] };
      return {
        bind(...args) { stmt.args = args; return this; },
        async run() {
          if (/^\s*UPDATE mirror_trade_manifest/i.test(s)) updates.push(stmt);
          return { success: true, meta: { changes: 1 } };
        },
        async first() { return null; },
        async all() {
          // The observe-only read of suppressed rows filters the way D1 would.
          if (/mirror_suppressed, 0\) = 1/.test(s)) {
            const [uid, , acct] = stmt.args;
            return {
              results: rows.filter(r =>
                (r.user_id === uid || (acct != null && r.broker_account_id === acct))
                && (Number(r.mirror_suppressed) === 1 || r.sync_state === "mirror_suppressed")
                && String(r.instrument_type || "equity") !== "options"
                && Number(r.broker_remaining_qty) > 0),
            };
          }
          if (/^\s*SELECT \* FROM mirror_trade_manifest/i.test(s)) {
            const [uid, , acct] = stmt.args;
            return {
              results: rows.filter(r =>
                r.user_id === uid || (acct != null && r.broker_account_id === acct)),
            };
          }
          return { results: [] };
        },
      };
    },
  };
}

const USER = {
  user_id: "op@x.com#webull#roth-ira",
  owner_email: "op@x.com",
  broker: "webull",
  status: "connected",
  broker_integration_enabled: true,
  webull_account_id: "WB-ROTH",
};

function equityRow(ticker, qty, extra = {}) {
  return {
    user_id: "op@x.com",
    trade_id: `${ticker}-1789481038069-abc`,
    broker_account_id: "WB-ROTH",
    ticker,
    mode: "trader",
    instrument_type: "equity",
    model_status: "OPEN",
    sync_state: "in_sync",
    model_intended_qty: qty,
    broker_filled_qty: qty,
    broker_remaining_qty: qty,
    sync_last_checked_at: 0, // always cadence-eligible
    sync_drift_count: 0,
    mirror_suppressed: 0,
    sync_last_action_json: null,
    ...extra,
  };
}

function optionsRow(ticker, qty, extra = {}) {
  return {
    ...equityRow(ticker, qty),
    trade_id: `${ticker}-opt-1789481038069-abc`,
    instrument_type: "options",
    option_symbol: `${ticker}  261218C00500000`,
    option_expiry: "2026-12-18",
    option_strike: 500,
    option_right: "call",
    ...extra,
  };
}

// Both manifest writers bind (user_id, trade_id, broker_account_id, …).
// _persistReconcileError hardcodes the state in SQL; _persistRowUpdate
// binds it as ?9.
function statesByTrade(db) {
  const out = new Map();
  for (const u of db.updates) {
    if (!/\bWHERE user_id = \?1 AND trade_id = \?2\b/.test(u.sql)) continue;
    const literal = /sync_state\s*=\s*'([a-z_]+)'/i.exec(u.sql);
    out.set(u.args[1], literal ? literal[1] : u.args[8]);
  }
  return out;
}

const OK_POSITIONS = {
  ok: true,
  positions: [
    { ticker: "TQQQ", qty: 4.58644, avgCost: 70.34 },
    { ticker: "UDOW", qty: 5, avgCost: 67.68 },
  ],
};

describe("reconcileUser — failed equity fetch on an equity-only account", () => {
  const rows = () => [
    equityRow("TQQQ", 4.58644),
    equityRow("UDOW", 5),
    equityRow("NBIS", 2),
  ];

  it("does not orphan live positions when the positions call is rate limited", async () => {
    const db = makeDb({ rows: rows() });
    const stats = await reconcileUser({ BRIDGE_DB: db }, USER, {
      getEquityPositions: async () => ({ ok: false, error: "Too many requests" }),
    });

    expect(stats.rows_eligible).toBe(3);
    expect(stats.rows_reconcile_error).toBe(3);
    expect(stats.fetch_error).toContain("Too many requests");
    expect(stats.by_state.mothership_orphan).toBeUndefined();

    for (const state of statesByTrade(db).values()) {
      expect(state).toBe("reconcile_error");
    }
  });

  it("still orphans when the fetch succeeds and the broker really is flat", async () => {
    const db = makeDb({ rows: rows() });
    const stats = await reconcileUser({ BRIDGE_DB: db }, USER, {
      getEquityPositions: async () => ({ ok: true, positions: [] }),
    });

    expect(stats.by_state.mothership_orphan).toBe(3);
    expect(stats.rows_reconcile_error).toBeUndefined();
  });

  it("an adapter with no getEquityPositions defers instead of orphaning", async () => {
    const db = makeDb({ rows: rows() });
    const stats = await reconcileUser({ BRIDGE_DB: db }, USER, {});

    expect(stats.rows_reconcile_error).toBe(3);
    expect(stats.by_state.mothership_orphan).toBeUndefined();
    expect(stats.fetch_error).toContain("adapter_lacks_getEquityPositions");
  });

  it("a thrown adapter error defers instead of orphaning", async () => {
    const db = makeDb({ rows: rows() });
    const stats = await reconcileUser({ BRIDGE_DB: db }, USER, {
      getEquityPositions: async () => { throw new Error("socket hang up"); },
    });

    expect(stats.rows_reconcile_error).toBe(3);
    expect(stats.by_state.mothership_orphan).toBeUndefined();
  });

  it("does not bump sync_drift_count — a rate limit is not drift", async () => {
    const db = makeDb({ rows: rows() });
    await reconcileUser({ BRIDGE_DB: db }, USER, {
      getEquityPositions: async () => ({ ok: false, error: "Too many requests" }),
    });

    for (const u of db.updates) {
      expect(u.sql).not.toMatch(/sync_drift_count/i);
    }
  });
});

describe("reconcileUser — one instrument class fails, the other answers", () => {
  it("errors only the blind equity rows and still reconciles options", async () => {
    const db = makeDb({ rows: [equityRow("TQQQ", 4.58644), optionsRow("SPY", 1)] });
    const stats = await reconcileUser({ BRIDGE_DB: db }, USER, {
      getEquityPositions: async () => ({ ok: false, error: "Too many requests" }),
      getOptionsPositions: async () => ({ ok: true, positions: [] }),
    });

    expect(stats.rows_reconcile_error).toBe(1);
    expect(stats.by_state.mothership_orphan).toBeUndefined();

    const states = statesByTrade(db);
    expect(states.get("TQQQ-1789481038069-abc")).toBe("reconcile_error");
    // The options row was classified normally (broker flat, so it drifts).
    expect(states.get("SPY-opt-1789481038069-abc")).not.toBe("reconcile_error");
  });

  it("errors only the blind options rows and still reconciles equity", async () => {
    const db = makeDb({ rows: [equityRow("TQQQ", 4.58644), optionsRow("SPY", 1)] });
    const stats = await reconcileUser({ BRIDGE_DB: db }, USER, {
      getEquityPositions: async () => OK_POSITIONS,
      getOptionsPositions: async () => ({ ok: false, error: "Too many requests" }),
    });

    expect(stats.rows_reconcile_error).toBe(1);
    expect(stats.rows_in_sync).toBe(1);

    const states = statesByTrade(db);
    expect(states.get("SPY-opt-1789481038069-abc")).toBe("reconcile_error");
    expect(states.get("TQQQ-1789481038069-abc")).toBe("in_sync");
  });

  it("errors everything when both classes fail", async () => {
    const db = makeDb({ rows: [equityRow("TQQQ", 4.58644), optionsRow("SPY", 1)] });
    const stats = await reconcileUser({ BRIDGE_DB: db }, USER, {
      getEquityPositions: async () => ({ ok: false, error: "Too many requests" }),
      getOptionsPositions: async () => ({ ok: false, error: "Too many requests" }),
    });

    expect(stats.rows_reconcile_error).toBe(2);
    expect(stats.by_state).toEqual({ reconcile_error: 2 });
  });
});
