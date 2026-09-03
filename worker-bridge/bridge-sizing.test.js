import { describe, it, expect } from "vitest";
import {
  computeRelationalQty,
  roundQtyForBroker,
  preferWholeShareQty,
} from "./bridge-sizing.js";
import { preflightOrder } from "./bridge-guards.js";
import { resetLocalReservations } from "./bridge-cash-budget.js";

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

describe("preferWholeShareQty", () => {
  it("rounds 1.623 up to 2 when the target slack covers it", () => {
    const r = preferWholeShareQty({
      qty: 1.62344,
      price: 70,
      targetNotionalUsd: 1.62344 * 70,
      maxQty: 10,
      allowFractional: true,
    });
    expect(r.qty).toBe(2);
    expect(r.mode).toBe("round_up");
  });

  it("floors when round-up would exceed the cash ceiling", () => {
    const r = preferWholeShareQty({
      qty: 1.8,
      price: 100,
      cashCeilingUsd: 150,
      maxQty: 10,
      allowFractional: true,
    });
    expect(r.qty).toBe(1);
    expect(r.mode).toBe("round_down");
  });

  it("keeps a sub-share fractional for LLY-class names in RTH", () => {
    const r = preferWholeShareQty({
      qty: 0.35,
      price: 850,
      accountEquity: 16500,
      targetNotionalUsd: 0.35 * 850,
      allowFractional: true,
    });
    expect(r.qty).toBeGreaterThan(0.3);
    expect(r.qty).toBeLessThan(0.4);
    expect(r.mode).toMatch(/^fractional_/);
  });

  it("rejects a sub-share when fractionals are off (ETH)", () => {
    const r = preferWholeShareQty({
      qty: 0.35,
      price: 850,
      accountEquity: 16500,
      targetNotionalUsd: 0.35 * 850,
      allowFractional: false,
    });
    expect(r.qty).toBe(0);
    expect(r.reason).toBe("account_too_small_for_one_share");
  });
});

describe("computeRelationalQty — Roth IRA ($16.5k) mirroring a $100k model", () => {
  const base = { modelQty: 17, entryPrice: 251.71, accountEquity: 16500, modelBookUsd: 100000 };

  it("prefers whole shares: scales 17 → ~2.8 then rounds up to 3", () => {
    const r = computeRelationalQty({ ...base, fractional: true });
    expect(r.ok).toBe(true);
    expect(r.qty).toBe(3);
    expect(r.fractional_used).toBe(false);
    expect(r.scaled).toBe(true);
    expect(r.whole_share_mode).toBe("round_up");
  });

  it("whole-share broker: floors 2.8 → 2", () => {
    const r = computeRelationalQty({ ...base, fractional: false });
    expect(r.qty).toBe(2);
    expect(r.fractional_used).toBe(false);
  });

  it("honors an explicit model_account_pct then rounds 1.97 → 2", () => {
    const r = computeRelationalQty({ ...base, modelAccountPct: 3, fractional: true });
    // 3% of $16,500 = $495 → 495/251.71 ≈ 1.966 → prefer whole 2
    expect(r.target_notional).toBeCloseTo(495, 0);
    expect(r.qty).toBe(2);
    expect(r.whole_share_mode).toBe("round_up");
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

  it("scales a 17-share AMZN entry and prefers whole shares (3) for the Roth", async () => {
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
    expect(payload.qty).toBe(3);
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

  // 2026-08-19 — TJX 8/17 15:59 ET rejection. Cash account with $340 of
  // total cash but $332 buying power (recent sell not yet settled).
  // Model wanted a $338.69 buy (2.24 sh @ $151.14). Old sizing
  // (cash * 0.98) produced $333.20 which cleared cash but violated
  // Webull's 2% market-order buffer against BP.
  it("scales against min(cash, buying_power) / 1.02 then prefers whole shares", async () => {
    // Simulate a cash account whose whole equity is model-book-sized
    // (so relational sizing does NOT clamp the request); BP is the
    // only tighter ceiling because recent proceeds have not settled.
    const unsettled = {
      ...rothUser,
      user_id: "op@x.com#webull#individual-cash",
      webull_account_id: "WB-CASH",
      cash_usd: 340,
      buying_power_usd: 332,
      equity_usd: 100000,
    };
    const env = makeEnv(unsettled);
    const payload = {
      user_id: "op@x.com#webull#individual-cash",
      trade_id: "TJX-8/17",
      ticker: "TJX",
      side: "buy",
      qty: 2.24,      // model wanted $338.69
      entry: 151.14,
      mode: "investor",
    };
    const pf = await preflightOrder(env, payload);
    expect(pf.ok).toBe(true);
    // Ceiling 332 / 1.02 = 325.49 → ~2.153 fractional → prefer whole 2
    // (3 shares = $453 > ceiling).
    expect(payload.qty).toBe(2);
    expect(payload.qty * payload.entry * 1.02).toBeLessThanOrEqual(332);
    expect(pf.scaling?.reason).toMatch(/cash_buffer/);
    expect(pf.scaling?.buying_power_usd).toBe(332);
    expect(pf.scaling?.cash_ceiling_usd).toBe(332);
  });

  it("uses cash_usd as ceiling when buying_power is missing", async () => {
    const cashOnly = {
      ...rothUser,
      user_id: "op@x.com#webull#margin",
      webull_account_id: "WB-MARGIN",
      cash_usd: 500,
      buying_power_usd: undefined,
      equity_usd: 100000,
    };
    const env = makeEnv(cashOnly);
    const payload = {
      user_id: "op@x.com#webull#margin",
      trade_id: "TJX-cash",
      ticker: "TJX",
      side: "buy",
      qty: 4,      // $604 order > $500 cash
      entry: 151.14,
      mode: "investor",
    };
    const pf = await preflightOrder(env, payload);
    expect(pf.ok).toBe(true);
    // 500 / 1.02 = 490.19 → ~3.243 → prefer whole 3
    expect(payload.qty).toBe(3);
    expect(payload.qty * payload.entry * 1.02).toBeLessThanOrEqual(500);
  });

  it("fractional RTH: $92 Roth cash scales TJX to a sub-share (can't afford 1 whole)", async () => {
    // Prior preflight tests reserve cash on WB-ROTH in the process-local
    // ledger; clear it so this tight-cash case is isolated.
    resetLocalReservations();
    // 2026-09-03 — model 10.07 sh @ $131.60. Relational → ~1.66, then
    // cash ceiling leaves ~0.68. One whole share does not fit → fractional.
    const tightCash = {
      ...rothUser,
      cash_usd: 92,
      buying_power_usd: 92,
      equity_usd: 16500,
    };
    const env = makeEnv(tightCash);
    const payload = {
      user_id: "op@x.com#webull#roth-ira",
      trade_id: "TJX-1788443010856-y683gd3xi",
      ticker: "TJX",
      side: "buy",
      qty: 10.07,
      entry: 131.60,
      mode: "trader",
    };
    const pf = await preflightOrder(env, payload);
    expect(pf.ok).toBe(true);
    expect(payload.qty).toBeGreaterThan(0.68);
    expect(payload.qty).toBeLessThan(0.69);
    expect(payload.qty * payload.entry * 1.02).toBeLessThanOrEqual(92 + 1e-6);
    expect(pf.scaling?.reason).toMatch(/cash_buffer/);
  });
});
