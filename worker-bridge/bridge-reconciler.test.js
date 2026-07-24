import { describe, it, expect } from "vitest";
import { reconcileUser } from "./bridge-reconciler.js";

/**
 * 2026-07-24 — two reconciler regressions found during the post-launch
 * full sweep:
 *
 * 1. Manifest rows are written with the mothership's base user_id
 *    (owner email) by the fan-out order path, but the reconciler
 *    iterates per-account users (owner#webull#roth-ira) and selected
 *    rows with `WHERE user_id = ?` only — every cycle scanned 0 rows,
 *    so the entire Phase C reconcile was a silent no-op in production.
 *    Fix: also match rows on broker_account_id.
 *
 * 2. _persistRowUpdate wrote broker_remaining_qty from `expected`,
 *    which is derived from broker_remaining_qty itself — circular, so
 *    the column never converged to broker truth. Fix: write the live
 *    held qty (minus user-added excess) and never shrink
 *    broker_filled_qty (cumulative entry fills) after a trim.
 */

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
          if (/^\s*SELECT \* FROM mirror_trade_manifest/i.test(s)) {
            // Simulate D1: honor the (user_id OR broker_account_id) match.
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

const perAccountUser = {
  user_id: "op@x.com#webull#roth-ira",
  owner_email: "op@x.com",
  broker: "webull",
  status: "connected",
  broker_integration_enabled: true,
  webull_account_id: "WB-ROTH",
};

// Row written by the fan-out order path: base email as user_id.
const manifestRow = {
  user_id: "op@x.com",
  trade_id: "ETN-1",
  broker_account_id: "WB-ROTH",
  ticker: "ETN",
  mode: "trader",
  instrument_type: "equity",
  model_status: "OPEN",
  sync_state: "in_sync",
  model_intended_qty: 1.2,
  broker_filled_qty: 1.2,
  broker_remaining_qty: 0, // stale (old entry-write bug)
  sync_last_checked_at: 0, // always cadence-eligible
  sync_drift_count: 0,
  mirror_suppressed: 0,
};

const adapter = {
  async getEquityPositions() {
    return { ok: true, positions: [{ symbol: "ETN", qty: 1.2, avg_cost: 406.78 }] };
  },
};

describe("reconcileUser — fan-out user_id vs manifest base user_id", () => {
  it("matches manifest rows by broker_account_id when user_id differs", async () => {
    const db = makeDb({ rows: [manifestRow] });
    const stats = await reconcileUser({ BRIDGE_DB: db }, perAccountUser, adapter, {});
    expect(stats.rows_scanned).toBe(1);
    expect(stats.rows_in_sync).toBe(1);
  });

  it("persists broker_remaining_qty from live held qty (converges after stale 0)", async () => {
    const db = makeDb({ rows: [manifestRow] });
    await reconcileUser({ BRIDGE_DB: db }, perAccountUser, adapter, {});
    const upd = db.updates.find(u => /broker_remaining_qty = COALESCE/i.test(u.sql));
    expect(upd).toBeTruthy();
    // bind order: ?1 user, ?2 trade, ?3 acct, ?4 filled, ?5 remaining
    expect(upd.args[4]).toBeCloseTo(1.2, 6);
    // filled must NOT shrink (held 1.2 == recorded 1.2 → keep, bind null)
    expect(upd.args[3]).toBeNull();
  });

  it("does not shrink broker_filled_qty after a trim reduces the live position", async () => {
    const trimmedRow = { ...manifestRow, broker_filled_qty: 2.4, broker_remaining_qty: 2.4 };
    const db = makeDb({ rows: [trimmedRow] });
    // Broker now holds 1.2 (half was trimmed).
    await reconcileUser({ BRIDGE_DB: db }, perAccountUser, adapter, {});
    const upd = db.updates.find(u => /broker_remaining_qty = COALESCE/i.test(u.sql));
    expect(upd).toBeTruthy();
    expect(upd.args[4]).toBeCloseTo(1.2, 6); // remaining converges to held
    expect(upd.args[3]).toBeNull();          // cumulative fills untouched
  });
});
