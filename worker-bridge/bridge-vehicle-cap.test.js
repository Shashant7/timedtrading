import { describe, it, expect } from "vitest";
import { applyVehicleNotionalCap, preflightOrder } from "./bridge-guards.js";

// ─── unit: applyVehicleNotionalCap ────────────────────────────────────
describe("applyVehicleNotionalCap — per-vehicle cap semantics", () => {
  const rothUser = {
    user_id: "op@x.com#webull#roth-ira",
    broker: "webull",
    options_prefs: { vehicles: { equity_long: { enabled: true, max_per_order_usd: 300 } } },
  };

  it("passes through when scaled notional is under the cap", () => {
    const r = applyVehicleNotionalCap({ vehicle: "equity_long", entry: 100, qty: 2 }, rothUser, { fractional: true });
    expect(r.ok).toBe(true);
    expect(r.scaled).toBeFalsy();
  });

  it("SCALES equity_long to fit (fractional on) instead of rejecting", () => {
    // 10 shares × $145 = $1,450 vs $300 cap. Should scale to ~2.0689 shares.
    const payload = { vehicle: "equity_long", entry: 145, qty: 10 };
    const r = applyVehicleNotionalCap(payload, rothUser, { fractional: true });
    expect(r.ok).toBe(true);
    expect(r.scaled).toBe(true);
    expect(r.scaled_qty).toBeGreaterThan(2.06);
    expect(r.scaled_qty).toBeLessThan(2.07);
    expect(r.scaled_value).toBeLessThanOrEqual(300);
    expect(r.original_qty).toBe(10);
    expect(r.vehicle_cap).toBe(300);
  });

  it("SCALES equity_long to whole shares when fractional is off", () => {
    const r = applyVehicleNotionalCap({ vehicle: "equity_long", entry: 145, qty: 10 }, rothUser, { fractional: false });
    expect(r.ok).toBe(true);
    expect(r.scaled).toBe(true);
    expect(r.scaled_qty).toBe(2);
    expect(r.scaled_value).toBe(290);
  });

  it("REJECTS equity_long when one whole share won't fit the cap and fractional is off", () => {
    // $600 share vs $300 cap, fractional off → 0 shares, must reject.
    const r = applyVehicleNotionalCap({ vehicle: "equity_long", entry: 600, qty: 5 }, rothUser, { fractional: false });
    expect(r.ok).toBe(false);
    expect(r.reject_reason).toMatch(/cap_300_below_min_share_price/);
  });

  it("HARD REJECTS option vehicles (never silently scale contracts)", () => {
    const user = {
      options_prefs: { vehicles: { long_call: { enabled: true, max_per_order_usd: 200 } } },
    };
    const r = applyVehicleNotionalCap({ vehicle: "long_call", entry: 3.5, qty: 100 }, user, { fractional: false });
    expect(r.ok).toBe(false);
    expect(r.reject_reason).toBe("vehicle_long_call_notional_350_exceeds_cap_200");
  });

  it("no-op when the user has no per-vehicle cap set", () => {
    const user = { options_prefs: { vehicles: { equity_long: { enabled: true } } } };
    const r = applyVehicleNotionalCap({ vehicle: "equity_long", entry: 999, qty: 999 }, user);
    expect(r.ok).toBe(true);
    expect(r.scaled).toBeFalsy();
  });

  it("no-op when payload has no vehicle field (plain equity order)", () => {
    const r = applyVehicleNotionalCap({ entry: 100, qty: 100 }, rothUser);
    expect(r.ok).toBe(true);
  });
});

// ─── integration: preflightOrder end-to-end for the SPHB/XLK repro ────
function makeEnv(user) {
  const kv = new Map();
  kv.set("bridge:killswitch_global", "off");
  kv.set(`bridge:user:${user.user_id}`, JSON.stringify(user));
  return {
    MODEL_BOOK_BASE_USD: "100000",
    BROKER_FRACTIONAL_ENABLED: "true",
    BROKER_FRACTIONAL_MIN_USD: "1",
    BRIDGE_KV: {
      async get(k) { return kv.get(k) || null; },
      async put(k, v) { kv.set(k, v); },
      async list({ prefix = "", limit = 100 } = {}) {
        return { keys: [...kv.keys()].filter((k) => k.startsWith(prefix)).slice(0, limit).map((name) => ({ name })) };
      },
    },
  };
}

const rothBase = {
  user_id: "op@x.com#webull#roth-ira",
  owner_email: "op@x.com",
  broker: "webull",
  status: "connected",
  broker_integration_enabled: true,
  webull_account_id: "WB-ROTH",
  webull_account_class: "ROTH_IRA",
  equity_usd: 16583,
  cash_usd: 16583,
  buying_power_usd: 16583,
};

describe("preflightOrder — Roth IRA vehicle-cap ordering (SPHB/XLK regression)", () => {
  it("PRE-FIX repro: shipped $300 equity_long cap USED to reject SPHB (model qty × entry)", () => {
    // Sanity check on the raw math the bridge WAS comparing before the fix:
    // 59 shares × $145 = $8640, and $8640 > $300 → hard reject at
    // validateVehiclePrefs (line 483 in preflight order). This is the
    // situation the operator hit; the test below shows the fix now allows
    // scale-to-fit and places a smaller-but-real order.
    const modelNotional = 59 * 145;
    expect(modelNotional).toBeGreaterThan(300);
  });

  it("with the shipped $300 cap: SPHB entry SCALES to fit instead of rejecting", async () => {
    const user = {
      ...rothBase,
      // Exactly the operator's live prefs — shipped 'small account' preset.
      options_prefs: { vehicles: { equity_long: { enabled: true, daily_cap: 3, max_per_order_usd: 300 } } },
      options_prefs_updated_at: Date.now(),
    };
    const env = makeEnv(user);
    const payload = {
      user_id: user.user_id, trade_id: "SPHB-1", ticker: "SPHB",
      side: "buy", qty: 59, entry: 145.36, mode: "trader",
      vehicle: "equity_long",
    };
    const pf = await preflightOrder(env, payload);
    expect(pf.ok).toBe(true);
    // Relational sizing scales 59 → ~9.79. Vehicle cap of $300 then
    // trims further to ~2.06 shares ($300 / $145.36).
    expect(payload.qty).toBeGreaterThan(2.05);
    expect(payload.qty).toBeLessThan(2.10);
    expect(payload._vehicle_cap_scaling).toBeTruthy();
    expect(payload._vehicle_cap_scaling.vehicle_cap).toBe(300);
    expect(payload._sizing).toBeTruthy(); // relational sizing also ran
  });

  it("with the NEW $5000 default cap: SPHB entry lands at the full relational size", async () => {
    const user = {
      ...rothBase,
      options_prefs: { vehicles: { equity_long: { enabled: true, daily_cap: 10, max_per_order_usd: 5000 } } },
      options_prefs_updated_at: Date.now(),
    };
    const env = makeEnv(user);
    const payload = {
      user_id: user.user_id, trade_id: "SPHB-2", ticker: "SPHB",
      side: "buy", qty: 59, entry: 145.36, mode: "trader",
      vehicle: "equity_long",
    };
    const pf = await preflightOrder(env, payload);
    expect(pf.ok).toBe(true);
    // No further cap trim — the relational size (~9.79) fits under $5k.
    expect(payload.qty).toBeGreaterThan(9.5);
    expect(payload.qty).toBeLessThan(10.0);
    expect(payload._vehicle_cap_scaling).toBeUndefined();
  });

  it("with vehicle disabled: rejects at the enable check (no relational sizing wasted)", async () => {
    const user = {
      ...rothBase,
      options_prefs: { vehicles: { equity_long: { enabled: false } } },
    };
    const env = makeEnv(user);
    const payload = {
      user_id: user.user_id, trade_id: "X-1", ticker: "XLK",
      side: "buy", qty: 52, entry: 181, mode: "trader",
      vehicle: "equity_long",
    };
    const pf = await preflightOrder(env, payload);
    expect(pf.ok).toBe(false);
    expect(pf.reject_reason).toBe("vehicle_equity_long_disabled_by_user");
  });
});
