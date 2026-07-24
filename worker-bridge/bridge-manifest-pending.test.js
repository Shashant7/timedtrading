import { describe, it, expect } from "vitest";
import { manifestAwareReducerCheck, preflightOrder } from "./bridge-guards.js";

/** Minimal D1 stub: DDL run() succeeds; SELECT first() returns `row`. */
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

function makeKvEnv(user, extra = {}) {
  const kv = new Map();
  kv.set("bridge:killswitch_global", "off");
  kv.set(`bridge:user:${user.user_id}`, JSON.stringify(user));
  return {
    BROKER_MANIFEST_ENFORCE: "on",
    BROKER_SCALE_TO_FIT: "true",
    MODEL_BOOK_BASE_USD: "100000",
    BRIDGE_KV: {
      async get(k) { return kv.get(k) || null; },
      async put(k, v) { kv.set(k, v); },
      async list({ prefix = "", limit = 100 } = {}) {
        return {
          keys: [...kv.keys()].filter((k) => k.startsWith(prefix)).slice(0, limit)
            .map((name) => ({ name })),
        };
      },
    },
    ...extra,
  };
}

const rothUser = {
  user_id: "op@x.com#webull#roth-ira",
  owner_email: "op@x.com",
  broker: "webull",
  status: "connected",
  broker_integration_enabled: true,
  webull_account_id: "WB-ROTH",
  webull_account_class: "ROTH_IRA",
  equity_usd: 16500,
  cash_usd: 50,
  buying_power_usd: 50,
};

describe("manifestAwareReducerCheck — pending entry that already placed", () => {
  it("allows TRIM when sync_state=pending but broker_remaining_qty > 0 (Webull no filled_qty echo)", async () => {
    const env = {
      BROKER_MANIFEST_ENFORCE: "on",
      BRIDGE_DB: makeManifestDb({
        user_id: rothUser.user_id,
        trade_id: "NVDA-1",
        broker_account_id: "WB-ROTH",
        sync_state: "pending",
        broker_filled_qty: 0,
        broker_remaining_qty: 7.75,
        model_intended_qty: 7.75,
        broker_entry_order_ids: JSON.stringify(["ord-nvda-1"]),
        mirror_suppressed: 0,
      }),
    };
    const r = await manifestAwareReducerCheck(env, {
      user_id: rothUser.user_id,
      trade_id: "NVDA-1",
      ticker: "NVDA",
      side: "trim",
      qty: 3.8,
    }, rothUser);
    expect(r.ok).toBe(true);
    expect(r.pending_entry_assumed_filled).toBe(true);
    expect(r.manifest_sync_state).toBe("pending");
  });

  it("still rejects pending with no remaining qty, no intended qty, and no entry order ids", async () => {
    const env = {
      BROKER_MANIFEST_ENFORCE: "on",
      BRIDGE_DB: makeManifestDb({
        user_id: rothUser.user_id,
        trade_id: "NVDA-2",
        broker_account_id: "WB-ROTH",
        sync_state: "pending",
        broker_filled_qty: 0,
        broker_remaining_qty: 0,
        model_intended_qty: 0,
        broker_entry_order_ids: null,
        mirror_suppressed: 0,
      }),
    };
    const r = await manifestAwareReducerCheck(env, {
      user_id: rothUser.user_id,
      trade_id: "NVDA-2",
      ticker: "NVDA",
      side: "trim",
      qty: 1,
    }, rothUser);
    expect(r.ok).toBe(false);
    expect(r.reject_reason).toBe("reducer_blocked_by_sync_state:pending");
  });

  it("allows EXIT under the same pending-but-placed condition", async () => {
    const env = {
      BROKER_MANIFEST_ENFORCE: "on",
      BRIDGE_DB: makeManifestDb({
        user_id: rothUser.user_id,
        trade_id: "NVDA-3",
        broker_account_id: "WB-ROTH",
        sync_state: "pending",
        broker_filled_qty: 0,
        broker_remaining_qty: 7.75,
        model_intended_qty: 7.75,
        broker_entry_order_ids: '["ord-3"]',
        mirror_suppressed: 0,
      }),
    };
    const r = await manifestAwareReducerCheck(env, {
      user_id: rothUser.user_id,
      trade_id: "NVDA-3",
      ticker: "NVDA",
      side: "exit",
      qty: 7.75,
    }, rothUser);
    expect(r.ok).toBe(true);
    expect(r.pending_entry_assumed_filled).toBe(true);
  });
});

describe("preflightOrder — reducers skip buy-side cash/cap scaling", () => {
  it("does not cash-scale a TRIM when cash << notional (NVDA trim must not go to 0)", async () => {
    const env = makeKvEnv(rothUser, {
      BRIDGE_DB: makeManifestDb({
        user_id: rothUser.user_id,
        trade_id: "NVDA-trim-cash",
        broker_account_id: "WB-ROTH",
        sync_state: "in_sync",
        broker_filled_qty: 7.75,
        broker_remaining_qty: 7.75,
        model_intended_qty: 7.75,
        broker_entry_order_ids: '["ord"]',
        mirror_suppressed: 0,
      }),
    });
    const payload = {
      user_id: rothUser.user_id,
      trade_id: "NVDA-trim-cash",
      ticker: "NVDA",
      side: "trim",
      qty: 3.8,
      entry: 180,
      mode: "trader",
    };
    // 3.8 * $180 ≈ $684 notional vs $50 cash — buy-side path would floor to 0.
    const pf = await preflightOrder(env, payload);
    expect(pf.ok).toBe(true);
    expect(payload.qty).toBeCloseTo(3.8, 5);
    expect(pf.scaling).toBeNull();
  });
});
