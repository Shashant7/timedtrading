import { describe, it, expect } from "vitest";
import { writeEntryManifest } from "./bridge-manifest.js";

/**
 * 2026-07-24 — broker_remaining_qty semantics.
 *
 * broker_remaining_qty means "shares currently HELD at the broker" (the
 * reconciler diffs it against live positions; the reducer guard clamps
 * trims to it). A fully-filled ENTRY must therefore write remaining =
 * filledQty — NOT `model_intended_qty - filled` (the unfilled remainder
 * of the order), which left every fresh entry with remaining=0 and made
 * follow-on TRIM/EXIT clamp to zero until the next reconcile pass.
 */

/**
 * D1 stub that records every bound statement. `insertConflicts` makes the
 * INSERT report 0 changes so writeEntryManifest falls to the UPDATE branch,
 * with `existingRow` returned by the SELECT.
 */
function makeRecordingDb({ insertConflicts = false, existingRow = null } = {}) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      const stmt = { sql: String(sql || ""), args: [] };
      return {
        bind(...args) { stmt.args = args; return this; },
        async run() {
          calls.push(stmt);
          if (/^\s*INSERT/i.test(stmt.sql)) {
            return { success: true, meta: { changes: insertConflicts ? 0 : 1 } };
          }
          return { success: true, meta: { changes: 1 } };
        },
        async first() {
          calls.push(stmt);
          return /^\s*SELECT/i.test(stmt.sql) ? existingRow : null;
        },
      };
    },
  };
}

const user = {
  user_id: "op@x.com#webull#roth-ira",
  broker: "webull",
  webull_account_id: "WB-ROTH",
};

const entryPayload = {
  user_id: "op@x.com#webull#roth-ira",
  trade_id: "ETN-1",
  broker_account_id: "WB-ROTH",
  ticker: "ETN",
  side: "buy",
  qty: 1.20755,
};

describe("writeEntryManifest — broker_remaining_qty is held qty", () => {
  it("INSERT: fully-filled entry writes remaining = filledQty (not intended - filled = 0)", async () => {
    const db = makeRecordingDb();
    const r = await writeEntryManifest({ BRIDGE_DB: db }, entryPayload, user, {
      broker_order_id: "ord-1",
      filled_qty: 1.20755,
    });
    expect(r.ok).toBe(true);
    expect(r.action).toBe("inserted");
    const ins = db.calls.find((c) => /INSERT INTO mirror_trade_manifest/i.test(c.sql));
    expect(ins).toBeTruthy();
    // bind order: ...?11 model_intended_qty ... ?15 broker_filled_qty, ?16 broker_remaining_qty
    const filled = ins.args[14];
    const remaining = ins.args[15];
    expect(filled).toBeCloseTo(1.20755, 6);
    expect(remaining).toBeCloseTo(1.20755, 6);
  });

  it("UPDATE (ADD tranche): remaining = existing remaining + new fill", async () => {
    const db = makeRecordingDb({
      insertConflicts: true,
      existingRow: {
        broker_entry_order_ids: JSON.stringify([{ order_id: "ord-1", ts: 1, requested_qty: 1, filled_qty: 1 }]),
        broker_filled_qty: 1,
        broker_remaining_qty: 0.5, // half already trimmed away
        model_intended_qty: 1,
      },
    });
    const r = await writeEntryManifest({ BRIDGE_DB: db }, { ...entryPayload, qty: 2 }, user, {
      broker_order_id: "ord-2",
      filled_qty: 2,
    });
    expect(r.ok).toBe(true);
    expect(r.action).toBe("updated");
    const upd = db.calls.find((c) => /UPDATE mirror_trade_manifest/i.test(c.sql));
    expect(upd).toBeTruthy();
    // bind order: ?1 user, ?2 trade, ?3 acct, ?4 intended, ?5 filled, ?6 tracker, ?7 now, ?8 remaining
    expect(upd.args[3]).toBeCloseTo(2, 6);   // model_intended_qty = max(1, 2)
    expect(upd.args[4]).toBeCloseTo(3, 6);   // filled accumulates 1 + 2
    expect(upd.args[7]).toBeCloseTo(2.5, 6); // remaining = held 0.5 + new fill 2
  });
});
