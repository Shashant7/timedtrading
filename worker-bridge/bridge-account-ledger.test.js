import { describe, it, expect, beforeEach } from "vitest";
import {
  recordAccountFill,
  readAccountLedger,
  snapshotAccount,
  readAccountSnapshots,
} from "./bridge-account-ledger.js";

// Minimal D1 stub: captures runs, returns canned rows for `all()`.
function makeStubDb() {
  const runs = [];
  let nextAll = { results: [] };
  return {
    runs,
    setNextAll(rows) { nextAll = { results: rows }; },
    prepare(sql) {
      const stmt = { sql, _binds: [] };
      stmt.bind = (...b) => { stmt._binds = b; return stmt; };
      stmt.run = async () => { runs.push({ sql, binds: stmt._binds }); return { meta: { last_row_id: runs.length } }; };
      stmt.all = async () => nextAll;
      stmt.first = async () => (nextAll.results[0] || null);
      return stmt;
    },
  };
}

describe("bridge-account-ledger", () => {
  let db, env;
  beforeEach(() => { db = makeStubDb(); env = { BRIDGE_DB: db }; });

  it("records a fill bound to the specific broker account", async () => {
    const res = await recordAccountFill(env, {
      owner_id: "op@x.com",
      user_id: "op@x.com#webull#margin",
      broker: "webull",
      broker_account_id: "WB-777",
      model_trade_id: "AMZN-1",
      client_order_id: "tt-entry-AMZN-1",
      ticker: "AMZN",
      side: "buy",
      event_type: "ENTRY",
      qty: 17,
      price: 251.71,
    });
    expect(res.ok).toBe(true);
    const insert = db.runs.find((r) => /INSERT INTO broker_account_ledger/.test(r.sql));
    expect(insert).toBeTruthy();
    // broker_account_id is the 5th bind (after ts, owner, user, broker).
    expect(insert.binds).toContain("WB-777");
    expect(insert.binds).toContain("AMZN");
    // value auto-derived from qty*price.
    expect(insert.binds).toContain(17 * 251.71);
  });

  it("refuses to record without an account id", async () => {
    const res = await recordAccountFill(env, { ticker: "AMZN", qty: 1, price: 1 });
    expect(res.ok).toBe(false);
    expect(res.skip).toBe("no_account_id");
  });

  it("reads ledger rows for one account", async () => {
    db.setNextAll([{ id: 1, broker_account_id: "WB-777", ticker: "AMZN" }]);
    const rows = await readAccountLedger(env, { broker_account_id: "WB-777" });
    expect(rows).toHaveLength(1);
    expect(rows[0].broker_account_id).toBe("WB-777");
  });

  it("upserts an account snapshot with positions + drift", async () => {
    const res = await snapshotAccount(env, {
      broker_account_id: "U-IBKR-1",
      owner_id: "op@x.com",
      broker: "ibkr",
      positions: [{ ticker: "AMZN", qty: 17, avg_cost: 251.71 }],
      in_sync: true,
      drift: [],
    });
    expect(res.ok).toBe(true);
    const upsert = db.runs.find((r) => /INSERT INTO broker_account_snapshot/.test(r.sql));
    expect(upsert).toBeTruthy();
    expect(upsert.binds).toContain("U-IBKR-1");
    // positions_count bind = 1
    expect(upsert.binds).toContain(1);
  });

  it("parses snapshot JSON back into arrays on read", async () => {
    db.setNextAll([{
      broker_account_id: "U-IBKR-1",
      positions_json: JSON.stringify([{ ticker: "AMZN", qty: 17 }]),
      drift_json: null,
    }]);
    const snaps = await readAccountSnapshots(env, { owner_id: "op@x.com" });
    expect(snaps[0].positions).toEqual([{ ticker: "AMZN", qty: 17 }]);
    expect(snaps[0].drift).toEqual([]);
  });

  it("no-ops gracefully without a DB binding", async () => {
    const res = await recordAccountFill({}, { broker_account_id: "X", qty: 1, price: 1 });
    expect(res.ok).toBe(false);
    expect(res.skip).toBe("no_db");
  });
});
