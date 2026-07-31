import { describe, it, expect } from "vitest";
import {
  classifyDrift,
  claimedOpenEquityByTicker,
  reconcileUser,
} from "./bridge-reconciler.js";

describe("claimedOpenEquityByTicker", () => {
  it("sums OPEN equity remaining (falls back to intended)", () => {
    const map = claimedOpenEquityByTicker([
      { ticker: "PLTR", mode: "investor", instrument_type: "equity", model_status: "OPEN", broker_remaining_qty: 2, model_intended_qty: 5 },
      { ticker: "PLTR", mode: "trader", instrument_type: "equity", model_status: "CLOSED", broker_remaining_qty: 0, model_intended_qty: 1 },
      { ticker: "TWLO", mode: "investor", instrument_type: "equity", model_status: "OPEN", broker_remaining_qty: 0, model_intended_qty: 1 },
    ]);
    expect(map.get("PLTR")).toBe(2);
    expect(map.get("TWLO")).toBe(1);
  });
});

describe("classifyDrift — cross-mode claim", () => {
  it("does not orphan CLOSED trader when investor OPEN claims the shares", () => {
    const row = {
      ticker: "PLTR",
      mode: "trader",
      model_status: "CLOSED",
      model_intended_qty: 0,
      broker_remaining_qty: 0,
      sync_state: "broker_orphan",
    };
    const r = classifyDrift(row, { qty: 2, avgCost: 40 }, {
      tolerance: 0.01,
      claimed_elsewhere_qty: 2,
    });
    expect(r.sync_state).toBe("in_sync");
    expect(r.drift_detected).toBe(false);
    expect(r.broker_state.qty).toBe(0);
    expect(String(r.note)).toMatch(/claimed by open rows/i);
  });

  it("still orphans residual above open claims", () => {
    const row = {
      ticker: "PLTR",
      mode: "trader",
      model_status: "CLOSED",
      model_intended_qty: 0,
      broker_remaining_qty: 0,
    };
    const r = classifyDrift(row, { qty: 3, avgCost: 40 }, {
      tolerance: 0.01,
      claimed_elsewhere_qty: 2,
    });
    expect(r.sync_state).toBe("broker_orphan");
    expect(r.drift_detected).toBe(true);
    expect(r.broker_state.qty).toBe(1);
  });
});

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

describe("reconcileUser — investor claim prevents trader orphan email state", () => {
  it("marks CLOSED trader in_sync when investor OPEN holds the broker qty", async () => {
    const investorOpen = {
      user_id: "op@x.com",
      trade_id: "PLTR-INV",
      broker_account_id: "WB-ROTH",
      ticker: "PLTR",
      mode: "investor",
      instrument_type: "equity",
      model_status: "OPEN",
      sync_state: "in_sync",
      model_intended_qty: 2,
      broker_filled_qty: 2,
      broker_remaining_qty: 2,
      sync_last_checked_at: 0,
      sync_drift_count: 0,
      mirror_suppressed: 0,
    };
    const traderClosed = {
      user_id: "op@x.com",
      trade_id: "PLTR-TR",
      broker_account_id: "WB-ROTH",
      ticker: "PLTR",
      mode: "trader",
      instrument_type: "equity",
      model_status: "CLOSED",
      sync_state: "broker_orphan",
      model_intended_qty: 0,
      broker_filled_qty: 0,
      broker_remaining_qty: 0,
      sync_last_checked_at: 0,
      sync_drift_count: 3,
      mirror_suppressed: 0,
      model_exit_ts: Date.now() - 1000,
    };
    const db = makeDb({ rows: [investorOpen, traderClosed] });
    const adapter = {
      async getEquityPositions() {
        return { ok: true, positions: [{ symbol: "PLTR", qty: 2, avg_cost: 40 }] };
      },
    };
    const user = {
      user_id: "op@x.com#webull#roth-ira",
      owner_email: "op@x.com",
      broker: "webull",
      status: "connected",
      broker_integration_enabled: true,
      webull_account_id: "WB-ROTH",
    };
    const stats = await reconcileUser({ BRIDGE_DB: db }, user, adapter, {});
    expect(stats.rows_scanned).toBe(2);
    // Trader closed should converge to in_sync (not drifting).
    const traderUpd = db.updates.find(u => u.args?.[1] === "PLTR-TR");
    expect(traderUpd).toBeTruthy();
    // sync_state bind is ?9 in the persist SQL (index 8 in 0-based args after user/trade/acct...)
    // bind: user, trade, acct, filled, held, avg, stateJson, now, newSyncState, ...
    expect(traderUpd.args[8]).toBe("in_sync");
    expect(stats.rows_drifting).toBe(0);
  });
});
