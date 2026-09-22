// worker-bridge/bridge-reconciler-blind-claims.test.js
//
// 2026-09-22 — two more places where an unreadable value was being read as
// a measured one, both found while chasing the false Mothership Orphan
// pages.
//
// 1. `_readOpenClaimRowsForUser` is the ONLY query that sees rejected and
//    suppressed re-entries; the reconcile scan filters those states out.
//    It swallowed D1 errors into `[]`, and an empty claim map is a positive
//    statement — "no other trade owns these shares" — which is exactly what
//    turns a CLOSED row's leftover into a `broker_orphan` page. So a
//    transient D1 blip silently re-opened DPZ 2026-09-03.
//
// 2. `sync_drift_count` is described everywhere as a run of consecutive
//    chronic drift cycles (`AUTO_SUPPRESS_AFTER_DRIFT`, the
//    `auto_suppressed_after_N_drifts` reason, the design doc, Mission
//    Control's "drift cycle count" tooltip) but nothing ever reset it. It
//    was a lifetime tally, so a row that drifted three times in July would
//    auto-suppress on its first drift in September.

import { describe, it, expect } from "vitest";
import { reconcileUser } from "./bridge-reconciler.js";

const CLAIM_SELECT = /^\s*SELECT ticker, instrument_type, model_status/i;

function makeDb({ rows = [], claimRows = [], claimsThrow = false } = {}) {
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
          if (/^\s*SELECT \* FROM mirror_trade_manifest/i.test(s)) {
            const [uid, , acct] = stmt.args;
            return {
              results: rows.filter(r =>
                r.user_id === uid || (acct != null && r.broker_account_id === acct)),
            };
          }
          if (CLAIM_SELECT.test(s)) {
            if (claimsThrow) throw new Error("D1_ERROR: network error");
            return { results: claimRows };
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

function row(ticker, qty, extra = {}) {
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
    sync_last_checked_at: 0,
    sync_drift_count: 0,
    mirror_suppressed: 0,
    sync_last_action_json: null,
    ...extra,
  };
}

/**
 * sync_state per trade_id. _persistReconcileError puts it in the SQL
 * literally; _persistRowUpdate binds it as ?9. The notification writer
 * targets the same row without touching sync_state, so require the
 * statement to actually set the column or it clobbers the reading.
 */
function statesByTrade(db) {
  const out = new Map();
  for (const u of db.updates) {
    if (!/\bWHERE user_id = \?1 AND trade_id = \?2\b/.test(u.sql)) continue;
    const literal = /sync_state\s*=\s*'([a-z_]+)'/i.exec(u.sql);
    if (literal) { out.set(u.args[1], literal[1]); continue; }
    if (/sync_state = \?9/.test(u.sql)) out.set(u.args[1], u.args[8]);
  }
  return out;
}

/** A broker adapter that reports exactly these equity positions. */
function brokerHolding(positions) {
  return { getEquityPositions: async () => ({ ok: true, positions }) };
}

/** newDriftCount is bound as ?11 by _persistRowUpdate. */
function driftCountByTrade(db) {
  const out = new Map();
  for (const u of db.updates) {
    if (!/sync_drift_count = \?11/.test(u.sql)) continue;
    out.set(u.args[1], u.args[10]);
  }
  return out;
}

describe("a failed open-claim read defers instead of orphaning", () => {
  // DPZ: the model closed the trade, the broker still holds 0.2714 sh, and
  // a rejected re-entry on the same ticker is what owns them. Only the
  // claim query can see that row.
  const closedRow = () => row("DPZ", 0.2714, {
    model_status: "CLOSED",
    model_exit_ts: 1789416215546,
  });
  const BROKER_HOLDS_DPZ = brokerHolding([{ ticker: "DPZ", qty: 0.2714, avgCost: 410.2 }]);

  it("orphans the leftover when the claim read says nobody owns it", async () => {
    const db = makeDb({ rows: [closedRow()], claimRows: [] });
    const stats = await reconcileUser({ BRIDGE_DB: db }, USER, BROKER_HOLDS_DPZ);

    expect(stats.rows_reconcile_error).toBeUndefined();
    expect(statesByTrade(db).get("DPZ-1789481038069-abc")).toBe("broker_orphan");
  });

  it("stays quiet when an open sibling claims the shares", async () => {
    const db = makeDb({
      rows: [closedRow()],
      claimRows: [{
        ticker: "DPZ",
        instrument_type: "equity",
        model_status: "OPEN",
        model_intended_qty: 0.2714,
        broker_remaining_qty: 0.2714,
        trade_id: "DPZ-re-entry",
        sync_state: "rejected",
        mirror_suppressed: 0,
      }],
    });
    await reconcileUser({ BRIDGE_DB: db }, USER, BROKER_HOLDS_DPZ);
    expect(statesByTrade(db).get("DPZ-1789481038069-abc")).not.toBe("broker_orphan");
  });

  it("defers the CLOSED row when the claim read itself failed", async () => {
    // The whole point: this must not look like the first case.
    const db = makeDb({ rows: [closedRow()], claimsThrow: true });
    const stats = await reconcileUser({ BRIDGE_DB: db }, USER, BROKER_HOLDS_DPZ);

    expect(stats.rows_reconcile_error).toBe(1);
    expect(stats.fetch_error).toBe("open_claim_read_failed");
    expect(stats.by_state.broker_orphan).toBeUndefined();
    expect(statesByTrade(db).get("DPZ-1789481038069-abc")).toBe("reconcile_error");
  });

  it("still reconciles OPEN rows while the claim map is unknown", async () => {
    // Only CLOSED / EXPIRED equity rows consult the claim map, so an
    // unreadable claim query must not stall the whole account.
    const db = makeDb({ rows: [closedRow(), row("TQQQ", 4.58644)], claimsThrow: true });
    const stats = await reconcileUser({ BRIDGE_DB: db }, USER, brokerHolding([
      { ticker: "DPZ", qty: 0.2714, avgCost: 410.2 },
      { ticker: "TQQQ", qty: 4.58644, avgCost: 70.34 },
    ]));

    expect(stats.rows_reconcile_error).toBe(1);
    expect(stats.rows_in_sync).toBe(1);

    const states = statesByTrade(db);
    expect(states.get("DPZ-1789481038069-abc")).toBe("reconcile_error");
    expect(states.get("TQQQ-1789481038069-abc")).toBe("in_sync");
  });

  it("does not bump sync_drift_count for a blind claim read", async () => {
    const db = makeDb({ rows: [closedRow()], claimsThrow: true });
    await reconcileUser({ BRIDGE_DB: db }, USER, BROKER_HOLDS_DPZ);
    for (const u of db.updates) {
      expect(u.sql).not.toMatch(/sync_drift_count/i);
    }
  });
});

describe("sync_drift_count is a consecutive run, not a lifetime tally", () => {
  const IN_SYNC_BROKER = brokerHolding([{ ticker: "TQQQ", qty: 4.58644, avgCost: 70.34 }]);
  const FLAT_BROKER = brokerHolding([]);

  it("clears the counter when the row reconciles clean", async () => {
    // TQQQ / UDOW / TNA / NBIS / P all reconcile in_sync while carrying a 1
    // banked by the fetch-failure bug. One healthy pass should spend it.
    const db = makeDb({ rows: [row("TQQQ", 4.58644, { sync_drift_count: 1 })] });
    const stats = await reconcileUser({ BRIDGE_DB: db }, USER, IN_SYNC_BROKER);

    expect(stats.rows_in_sync).toBe(1);
    expect(driftCountByTrade(db).get("TQQQ-1789481038069-abc")).toBe(0);
  });

  it("leaves a zero counter at zero", async () => {
    const db = makeDb({ rows: [row("TQQQ", 4.58644)] });
    await reconcileUser({ BRIDGE_DB: db }, USER, IN_SYNC_BROKER);
    expect(driftCountByTrade(db).get("TQQQ-1789481038069-abc")).toBe(0);
  });

  it("still counts up while the row keeps drifting", async () => {
    const db = makeDb({
      rows: [row("TQQQ", 4.58644, {
        sync_state: "mothership_orphan",
        sync_drift_count: 2,
      })],
    });
    await reconcileUser({ BRIDGE_DB: db }, USER, FLAT_BROKER);
    expect(driftCountByTrade(db).get("TQQQ-1789481038069-abc")).toBe(3);
  });

  it("does not auto-suppress a row on its first drift in months", async () => {
    // Pre-fix, a row sitting at 3 from July suppressed on its very next
    // drift, because nothing had reset it through weeks of clean passes.
    const healed = makeDb({ rows: [row("TQQQ", 4.58644, { sync_drift_count: 3 })] });
    await reconcileUser({ BRIDGE_DB: healed }, USER, IN_SYNC_BROKER);
    expect(driftCountByTrade(healed).get("TQQQ-1789481038069-abc")).toBe(0);

    const drifts = makeDb({ rows: [row("TQQQ", 4.58644, { sync_drift_count: 0 })] });
    const stats = await reconcileUser({ BRIDGE_DB: drifts }, USER, FLAT_BROKER);
    expect(driftCountByTrade(drifts).get("TQQQ-1789481038069-abc")).toBe(1);
    expect(stats.rows_auto_suppressed).toBe(0);
  });

  it("still auto-suppresses a genuinely chronic run", async () => {
    const db = makeDb({
      rows: [row("TQQQ", 4.58644, {
        sync_state: "mothership_orphan",
        sync_drift_count: 3,
      })],
    });
    const stats = await reconcileUser({ BRIDGE_DB: db }, USER, FLAT_BROKER);
    expect(driftCountByTrade(db).get("TQQQ-1789481038069-abc")).toBe(4);
    expect(stats.rows_auto_suppressed).toBe(1);
  });
});
