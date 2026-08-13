import { describe, it, expect } from "vitest";
import { preflightOrder } from "./bridge-guards.js";

function makeEnv(user, extra = {}) {
  const kv = new Map();
  kv.set("bridge:killswitch_global", "off");
  kv.set(`bridge:user:${user.user_id}`, JSON.stringify(user));
  return {
    MODEL_BOOK_BASE_USD: "100000",
    BROKER_FRACTIONAL_ENABLED: "true",
    ...extra,
    BRIDGE_KV: {
      async get(k) { return kv.get(k) || null; },
      async put(k, v) { kv.set(k, v); },
      async list({ prefix = "", limit = 100 } = {}) {
        return { keys: [...kv.keys()].filter((k) => k.startsWith(prefix)).slice(0, limit).map((name) => ({ name })) };
      },
    },
  };
}

describe("daily / per-order caps removed (2026-08-13)", () => {
  const user = {
    user_id: "op@x.com#webull#roth-ira",
    owner_email: "op@x.com",
    broker: "webull",
    status: "connected",
    broker_integration_enabled: true,
    webull_account_id: "WB-ROTH",
    webull_account_class: "ROTH_IRA",
    equity_usd: 16500,
    cash_usd: 16500,
    buying_power_usd: 16500,
    // Legacy stored caps that used to block after 3 placements.
    daily_order_count: 99,
    daily_order_count_date: new Date().toISOString().slice(0, 10),
    user_caps: { max_per_order_usd: 300, max_orders_per_day: 3 },
  };

  it("does not reject when daily_order_count exceeds legacy max_orders_per_day", async () => {
    const env = makeEnv(user);
    const payload = {
      user_id: user.user_id,
      trade_id: "TWLO-1",
      ticker: "TWLO",
      side: "buy",
      qty: 8,
      entry: 245,
      mode: "investor",
    };
    const pf = await preflightOrder(env, payload);
    expect(pf.ok).toBe(true);
    expect(String(pf.reject_reason || "")).not.toMatch(/daily_cap/);
  });

  it("ignores leftover user_caps.max_per_order_usd (relational size stands)", async () => {
    const env = makeEnv(user);
    // Relational: 8 sh on $100k model → ~1.32 on $16.5k Roth ≈ $323 notional,
    // which is ABOVE the leftover $300 user_cap — must NOT scale/reject.
    const payload = {
      user_id: user.user_id,
      trade_id: "TWLO-2",
      ticker: "TWLO",
      side: "buy",
      qty: 8,
      entry: 245,
      mode: "investor",
    };
    const pf = await preflightOrder(env, payload);
    expect(pf.ok).toBe(true);
    expect(payload.qty).toBeGreaterThan(1.2);
    expect(payload.qty).toBeLessThan(1.5);
    expect(pf.scaling?.reason || "").not.toMatch(/cap_per_order/);
  });
});
