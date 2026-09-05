import { describe, it, expect } from "vitest";
import { manifestAwareReducerCheck } from "./bridge-guards.js";

function makeManifestDb(row) {
  return {
    prepare(sql) {
      const isSelect = /^\s*SELECT/i.test(String(sql || ""));
      return {
        bind() { return this; },
        async run() { return { success: true }; },
        async first() { return isSelect ? row : null; },
        async all() { return { results: isSelect && row ? [row] : [] }; },
      };
    },
  };
}

const user = {
  user_id: "op@x.com#webull#main",
  broker: "webull",
  webull_account_id: "WB-MAIN",
};

const baseRow = {
  user_id: user.user_id,
  trade_id: "DPZ-1788443309854-hlxfbubhx",
  broker_account_id: "WB-MAIN",
  model_intended_qty: 0.8285,
  broker_entry_order_ids: JSON.stringify(["wb-1"]),
};

describe("manifestAwareReducerCheck — a sleeve that still holds shares is always reducible", () => {
  it("allows EXIT on a rejected + mirror_suppressed sleeve with broker_remaining_qty > 0 (DPZ 0.2714)", async () => {
    const env = {
      BROKER_MANIFEST_ENFORCE: "on",
      BRIDGE_DB: makeManifestDb({
        ...baseRow,
        sync_state: "rejected",
        mirror_suppressed: 1,
        mirror_suppressed_reason: "insufficient_cash_for_one_unit_0_lt_346.75",
        broker_filled_qty: 0.2714,
        broker_remaining_qty: 0.2714,
      }),
    };
    const r = await manifestAwareReducerCheck(env, {
      user_id: user.user_id, trade_id: baseRow.trade_id, ticker: "DPZ", side: "exit", qty: 0.8285,
    }, user);
    expect(r.ok).toBe(true);
    expect(r.held_override).toBe(true);
    expect(r.broker_remaining_qty).toBeCloseTo(0.2714, 6);
    expect(r.held_override_reason).toMatch(/^mirror_suppressed:insufficient_cash/);
  });

  it("allows TRIM on a mothership_orphan sleeve that still shows remaining qty", async () => {
    const env = {
      BROKER_MANIFEST_ENFORCE: "on",
      BRIDGE_DB: makeManifestDb({
        ...baseRow,
        trade_id: "TSLA-1",
        sync_state: "mothership_orphan",
        mirror_suppressed: 0,
        broker_filled_qty: 0.44542,
        broker_remaining_qty: 0.22271,
      }),
    };
    const r = await manifestAwareReducerCheck(env, {
      user_id: user.user_id, trade_id: "TSLA-1", ticker: "TSLA", side: "trim", qty: 0.95,
    }, user);
    expect(r.ok).toBe(true);
    expect(r.held_override).toBe(true);
    expect(r.held_override_reason).toBe("sync_state:mothership_orphan");
  });

  it("still rejects a suppressed sleeve that holds nothing", async () => {
    const env = {
      BROKER_MANIFEST_ENFORCE: "on",
      BRIDGE_DB: makeManifestDb({
        ...baseRow,
        sync_state: "rejected",
        mirror_suppressed: 1,
        mirror_suppressed_reason: "account_equity_unknown_sync_required",
        broker_filled_qty: 0,
        broker_remaining_qty: 0,
      }),
    };
    const r = await manifestAwareReducerCheck(env, {
      user_id: user.user_id, trade_id: baseRow.trade_id, ticker: "DPZ", side: "exit", qty: 0.8285,
    }, user);
    expect(r.ok).toBe(false);
    expect(r.reject_reason).toMatch(/^mirror_suppressed:/);
  });

  it("in_sync rows keep the normal path (no held_override flag)", async () => {
    const env = {
      BROKER_MANIFEST_ENFORCE: "on",
      BRIDGE_DB: makeManifestDb({
        ...baseRow,
        sync_state: "in_sync",
        mirror_suppressed: 0,
        broker_filled_qty: 0.8285,
        broker_remaining_qty: 0.8285,
      }),
    };
    const r = await manifestAwareReducerCheck(env, {
      user_id: user.user_id, trade_id: baseRow.trade_id, ticker: "DPZ", side: "exit", qty: 0.8285,
    }, user);
    expect(r.ok).toBe(true);
    expect(r.held_override).toBeUndefined();
  });
});
