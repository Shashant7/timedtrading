import { describe, it, expect } from "vitest";
import { adoptUserPosition } from "./bridge-manifest.js";

/**
 * 2026-08-13 — "Sync with model" v2: adoption is pure manifest
 * bookkeeping at the model's scaled sizing. NO order may be placed as a
 * side effect — the association is what lets FUTURE model actions flow
 * through the normal mirror path (the reducer guard requires a manifest
 * row; user-initiated positions previously rejected with
 * no_manifest_for_trade).
 */

function makeDb() {
  const statements = [];
  return {
    statements,
    prepare(sql) {
      const stmt = { sql: String(sql), args: [] };
      return {
        bind(...args) { stmt.args = args; return this; },
        async run() { statements.push(stmt); return { success: true, meta: { changes: 1 } }; },
        async first() { return null; },
        async all() { return { results: [] }; },
      };
    },
  };
}

describe("adoptUserPosition", () => {
  it("writes an in_sync OPEN manifest row at the adopted sleeve qty", async () => {
    const db = makeDb();
    const out = await adoptUserPosition({ BRIDGE_DB: db }, {
      userId: "partner@x.com#webull#roth-ira",
      tradeId: "inv-RST-auto-123",
      brokerAccountId: "WB-ROTH",
      broker: "webull",
      ticker: "RST",
      modelIntendedQty: 16.8,
      adoptQty: 16.8,
      brokerAvgCost: 57.0,
    });
    expect(out.ok).toBe(true);
    expect(out.action).toBe("adopted");
    const insert = db.statements.find((s) => /INSERT INTO mirror_trade_manifest/i.test(s.sql));
    expect(insert).toBeTruthy();
    // No order-path statements of any kind — adoption is bookkeeping only.
    expect(db.statements.some((s) => /order|oco/i.test(s.sql) && !/mirror_trade_manifest/i.test(s.sql))).toBe(false);
    // Sleeve qty lands in filled/remaining (same bind, ?10) + in_sync + OPEN.
    expect(insert.sql).toMatch(/'in_sync'/);
    expect(insert.sql).toMatch(/'OPEN'/);
    expect(insert.args).toContain(16.8);
    expect(insert.args).toContain(57.0);
    // Re-adoption clears suppression left from prior drift.
    expect(insert.sql).toMatch(/mirror_suppressed = 0/);
  });

  it("rejects a non-positive adoption quantity", async () => {
    const db = makeDb();
    const out = await adoptUserPosition({ BRIDGE_DB: db }, {
      userId: "partner@x.com#webull#roth-ira",
      tradeId: "inv-RST-auto-123",
      brokerAccountId: "WB-ROTH",
      ticker: "RST",
      adoptQty: 0,
    });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("adopt_qty_must_be_positive");
    expect(db.statements.length).toBe(0);
  });

  it("rejects when the trade association is missing", async () => {
    const out = await adoptUserPosition({ BRIDGE_DB: makeDb() }, {
      userId: "partner@x.com#webull#roth-ira",
      tradeId: "",
      brokerAccountId: "WB-ROTH",
      ticker: "RST",
      adoptQty: 5,
    });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("missing_user_id_trade_id_or_ticker");
  });
});
