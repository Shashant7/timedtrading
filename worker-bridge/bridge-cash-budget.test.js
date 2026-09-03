import { describe, it, expect } from "vitest";
import {
  TACTICAL_CASH_RESERVE_PCT,
  isTacticalVehicle,
  tacticalSleevesEnabled,
  sleeveReservePct,
  cashCeilingRaw,
  usableBuyingPower,
  maxQtyForCeiling,
  scaleQtyForCeiling,
  optionDebitUsd,
  addReservation,
  reservedUsd,
  releaseReservation,
  resetLocalReservations,
} from "./bridge-cash-budget.js";

describe("cash ceiling", () => {
  it("uses the tighter of cash vs buying power", () => {
    expect(cashCeilingRaw({ cashUsd: 1000, buyingPowerUsd: 800 })).toBe(800);
    expect(cashCeilingRaw({ cashUsd: 0, buyingPowerUsd: 500 })).toBe(500);
    expect(cashCeilingRaw({ cashUsd: NaN, buyingPowerUsd: NaN })).toBeNull();
  });

  it("leaves reducers uncapped", () => {
    expect(usableBuyingPower({ cashUsd: 100, buyingPowerUsd: 100, isReducer: true })).toBeNull();
  });

  it("subtracts reservations then the tactical holdback for core equity", () => {
    const usable = usableBuyingPower({
      cashUsd: 10000,
      buyingPowerUsd: 10000,
      reservedUsd: 2000,
      equityUsd: 20000,
      reservePct: TACTICAL_CASH_RESERVE_PCT,
    });
    // 10000 - 2000 - 0.12*20000 = 5600
    expect(usable).toBe(5600);
  });

  it("does not hold back cash on tactical vehicles", () => {
    const user = { options_prefs: { vehicles: { long_call: { enabled: true } } } };
    expect(sleeveReservePct(user, "long_call")).toBe(0);
    expect(sleeveReservePct(user, "equity_long")).toBe(TACTICAL_CASH_RESERVE_PCT);
    expect(sleeveReservePct({}, "equity_long")).toBe(0);
    expect(isTacticalVehicle("index_trend_letf")).toBe(true);
    expect(tacticalSleevesEnabled(user)).toBe(true);
  });

  it("floors qty with the Webull 2% buffer", () => {
    expect(maxQtyForCeiling({ usableUsd: 1020, entryUsd: 100 })).toBe(10);
    expect(maxQtyForCeiling({ usableUsd: 1019, entryUsd: 100 })).toBe(9);
    expect(optionDebitUsd({ premium: 1.5, qty: 2 })).toBe(300);
  });

  it("fractional: $92 Roth cash buys ~0.68 TJX instead of rejecting", () => {
    // TJX 2026-09-03 9:43 ET — whole-share floor was 0 → reject.
    const qty = maxQtyForCeiling({ usableUsd: 92, entryUsd: 131.60, fractional: true });
    expect(qty).toBeGreaterThan(0.68);
    expect(qty).toBeLessThan(0.69);
    expect(qty * 131.60 * 1.02).toBeLessThanOrEqual(92 + 1e-6);
    expect(maxQtyForCeiling({ usableUsd: 92, entryUsd: 131.60, fractional: false })).toBe(0);
    expect(scaleQtyForCeiling({ usableUsd: 92, entryUsd: 131.60, fractional: true })).toBeGreaterThan(0.68);
    expect(scaleQtyForCeiling({ usableUsd: 0.50, entryUsd: 131.60, fractional: true })).toBe(0);
  });
});

describe("reservation ledger", () => {
  function memKv() {
    const map = new Map();
    return {
      get: async (k) => map.get(k) ?? null,
      put: async (k, v) => { map.set(k, v); },
      _map: map,
    };
  }

  it("stacks concurrent reservations and releases by id", async () => {
    resetLocalReservations();
    const env = { BRIDGE_KV: memKv() };
    const acct = "webull#roth";
    const t0 = Date.now();
    await addReservation(env, acct, { id: "a", usd: 300 }, t0);
    await addReservation(env, acct, { id: "b", usd: 200 }, t0 + 10);
    expect(await reservedUsd(env, acct, t0 + 20)).toBe(500);
    await releaseReservation(env, acct, "a", t0 + 30);
    expect(await reservedUsd(env, acct, t0 + 40)).toBe(200);
  });

  it("drops expired rows", async () => {
    resetLocalReservations();
    const env = { BRIDGE_KV: memKv() };
    await addReservation(env, "x", { id: "old", usd: 999 }, 1_000);
    expect(await reservedUsd(env, "x", 1_000 + 3 * 60 * 1000 + 1)).toBe(0);
  });
});
