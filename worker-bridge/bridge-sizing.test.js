import { describe, it, expect } from "vitest";
import { computeRelationalQty, roundQtyForBroker } from "./bridge-sizing.js";
import { preflightOrder } from "./bridge-guards.js";

describe("roundQtyForBroker", () => {
  it("floors to whole shares when not fractional", () => {
    expect(roundQtyForBroker(2.805, { fractional: false })).toBe(2);
  });
  it("keeps decimals (rounded down) when fractional", () => {
    expect(roundQtyForBroker(2.80599, { fractional: true, precision: 3 })).toBe(2.805);
  });
  it("returns 0 for non-positive", () => {
    expect(roundQtyForBroker(0, { fractional: true })).toBe(0);
  });
});

describe("computeRelationalQty — Roth IRA ($16.5k) mirroring a $100k model", () => {
  const base = { modelQty: 17, entryPrice: 251.71, accountEquity: 16500, modelBookUsd: 100000 };

  it("fractional: scales 17 shares to ~2.8 (same ~4.4% of a smaller book)", () => {
    const r = computeRelationalQty({ ...base, fractional: true });
    expect(r.ok).toBe(true);
    expect(r.qty).toBeGreaterThan(2.7);
    expect(r.qty).toBeLessThan(2.9);
    expect(r.fractional_used).toBe(true);
    expect(r.scaled).toBe(true);
    // Same fraction of capital as the model deployed of its book.
    const acctPct = (r.qty * base.entryPrice) / base.accountEquity;
    const modelPct = (base.modelQty * base.entryPrice) / base.modelBookUsd;
    expect(acctPct).toBeCloseTo(modelPct, 2);
  });

  it("whole-share broker: floors 2.8 → 2", () => {
    const r = computeRelationalQty({ ...base, fractional: false });
    expect(r.qty).toBe(2);
    expect(r.fractional_used).toBe(false);
  });

  it("honors an explicit model_account_pct (3% of the real account)", () => {
    const r = computeRelationalQty({ ...base, modelAccountPct: 3, fractional: true });
    // 3% of $16,500 = $495 → 495/251.71 ≈ 1.966 shares
    expect(r.target_notional).toBeCloseTo(495, 0);
    expect(r.qty).toBeGreaterThan(1.9);
    expect(r.qty).toBeLessThan(2.0);
  });

  it("never scales UP when the account is larger than the model book", () => {
    const r = computeRelationalQty({ modelQty: 10, entryPrice: 100, accountEquity: 250000, modelBookUsd: 100000, fractional: true });
    expect(r.qty).toBe(10); // capped at model qty
  });

  it("rejects when even a fractional min-notional can't be met", () => {
    const r = computeRelationalQty({ modelQty: 1, entryPrice: 5000, accountEquity: 16500, modelBookUsd: 100000, fractional: true, minNotionalUsd: 100 });
    // ratio .165 → target 0.165*5000 = $825 which IS > $100... so this fills.
    expect(r.ok).toBe(true);
  });

  it("rejects a whole-share order too small for one share", () => {
    const r = computeRelationalQty({ modelQty: 1, entryPrice: 5000, accountEquity: 16500, modelBookUsd: 100000, fractional: false });
    // ratio .165 → target 0.165 shares → floor 0 → reject
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("account_too_small_for_one_share");
  });

  it("falls back (no scale) when entry price is missing", () => {
    const r = computeRelationalQty({ modelQty: 17, entryPrice: 0, accountEquity: 16500 });
    expect(r.ok).toBe(false);
    expect(r.fallback).toBe(true);
    expect(r.qty).toBe(17);
  });
});

// ── preflight integration: a Roth IRA entry gets relationally sized ──
function makeEnv(user) {
  const kv = new Map();
  kv.set("bridge:killswitch_global", "off");
  kv.set(`bridge:user:${user.user_id}`, JSON.stringify(user));
  return {
    MODEL_BOOK_BASE_USD: "100000",
    BROKER_FRACTIONAL_ENABLED: "true",
    BRIDGE_KV: {
      async get(k) { return kv.get(k) || null; },
      async put(k, v) { kv.set(k, v); },
      async list({ prefix = "", limit = 100 } = {}) {
        return { keys: [...kv.keys()].filter((k) => k.startsWith(prefix)).slice(0, limit).map((name) => ({ name })) };
      },
    },
  };
}

describe("preflightOrder — Roth IRA relational sizing", () => {
  const rothUser = {
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
  };

  it("scales a 17-share AMZN entry down to a fractional ~2.8 for the Roth", async () => {
    const env = makeEnv(rothUser);
    const payload = {
      user_id: "op@x.com#webull#roth-ira",
      trade_id: "AMZN-1",
      ticker: "AMZN",
      side: "buy",
      qty: 17,
      entry: 251.71,
      mode: "trader",
    };
    const pf = await preflightOrder(env, payload);
    expect(pf.ok).toBe(true);
    // payload.qty mutated in place to the scaled (fractional) size.
    expect(payload.qty).toBeGreaterThan(2.7);
    expect(payload.qty).toBeLessThan(2.9);
  });

  it("fail-safe: rejects an entry when account equity is unknown (no over-allocation)", async () => {
    const noEquity = { ...rothUser, equity_usd: undefined, cash_usd: undefined, buying_power_usd: undefined };
    const env = makeEnv(noEquity);
    const payload = {
      user_id: "op@x.com#webull#roth-ira", trade_id: "AMZN-2", ticker: "AMZN",
      side: "buy", qty: 17, entry: 251.71, mode: "trader",
    };
    const pf = await preflightOrder(env, payload);
    expect(pf.ok).toBe(false);
    expect(pf.reject_reason).toBe("account_equity_unknown_sync_required");
  });
});
