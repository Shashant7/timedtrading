import { describe, it, expect, vi } from "vitest";
import {
  heldEquityFromAccounts,
  heldQtyFor,
  loadBrokerHeldEquity,
  HELD_CACHE_TTL_MS,
} from "./broker-held-equity.js";

// Shapes lifted from the live /bridge/positions payload on 2026-09-14.
const LIVE_ACCOUNTS = [
  {
    account_id: "op@x.com#webull#individual-margin",
    label: "Individual Margin",
    mirror_enabled: false,
    items: [{ ticker: "SPY 0C", instrument: "option", broker_qty: 13, avg_cost: 1.99 }],
  },
  {
    account_id: "op@x.com#webull#rollover-ira",
    label: "Rollover IRA",
    mirror_enabled: false,
    items: [{ ticker: "MSTU", instrument: "equity", broker_qty: 30, avg_cost: 27.6 }],
  },
  {
    account_id: "op@x.com#webull#roth-ira",
    label: "Roth IRA",
    mirror_enabled: true,
    items: [
      { ticker: "SPYU", instrument: "equity", broker_qty: 9, avg_cost: 33.35 },
      { ticker: "TNA", instrument: "equity", broker_qty: 0, avg_cost: null },
      { ticker: "UDOW", instrument: "equity", broker_qty: 0, avg_cost: null },
      { ticker: "TQQQ", instrument: "equity", broker_qty: 4.58644, avg_cost: 70.34 },
    ],
  },
];

function envWithStore(seed = {}) {
  const store = { ...seed };
  return {
    ADMIN_EMAIL: "op@x.com",
    BROKER_BRIDGE_URL: "https://bridge.test",
    BROKER_BRIDGE_OPERATOR_KEY: "opkey",
    KV_TIMED: {
      get: async (k) => (store[k] == null ? null : store[k]),
      put: async (k, v) => { store[k] = v; },
    },
    store,
  };
}

describe("heldEquityFromAccounts", () => {
  it("reports the orphaned SPYU fill the model never claimed", () => {
    const held = heldEquityFromAccounts(LIVE_ACCOUNTS);
    expect(held.SPYU.qty).toBe(9);
    expect(held.SPYU.avg_cost).toBe(33.35);
    expect(heldQtyFor(held, "SPYU")).toBe(9);
  });

  it("does not count accounts the mirror never trades", () => {
    // Rollover IRA holds MSTU but mirror_enabled is false, so it is not ours.
    expect(heldEquityFromAccounts(LIVE_ACCOUNTS).MSTU).toBeUndefined();
  });

  it("does not read an option contract count as shares of the underlying", () => {
    expect(heldEquityFromAccounts(LIVE_ACCOUNTS)["SPY 0C"]).toBeUndefined();
    expect(heldEquityFromAccounts(LIVE_ACCOUNTS).SPY).toBeUndefined();
  });

  it("treats a zero-qty row as flat, so the sleeve is still buyable", () => {
    const held = heldEquityFromAccounts(LIVE_ACCOUNTS);
    expect(held.TNA).toBeUndefined();
    expect(heldQtyFor(held, "TNA")).toBe(0);
    expect(heldQtyFor(held, "UDOW")).toBe(0);
  });

  it("sums one ticker across several mirror-enabled accounts", () => {
    const held = heldEquityFromAccounts([
      { account_id: "a", mirror_enabled: true, items: [{ ticker: "TQQQ", broker_qty: 4 }] },
      { account_id: "b", mirror_enabled: true, items: [{ ticker: "TQQQ", broker_qty: 6 }] },
    ]);
    expect(held.TQQQ.qty).toBe(10);
    expect(held.TQQQ.accounts).toEqual(["a", "b"]);
  });
});

describe("heldQtyFor", () => {
  // The difference between "holds nothing" and "could not ask" is the
  // difference between a safe buy and a double buy.
  it("returns null for an unreachable broker, not zero", () => {
    expect(heldQtyFor(null, "SPYU")).toBe(null);
    expect(heldQtyFor(undefined, "SPYU")).toBe(null);
    expect(heldQtyFor({}, "SPYU")).toBe(0);
  });
});

describe("loadBrokerHeldEquity", () => {
  it("returns null when the bridge call fails", async () => {
    const env = envWithStore();
    global.fetch = vi.fn(async () => { throw new Error("unreachable"); });
    expect(await loadBrokerHeldEquity(env, { owner: "op@x.com" })).toBe(null);
  });

  it("returns null when no operator key is configured", async () => {
    const env = envWithStore();
    delete env.BROKER_BRIDGE_OPERATOR_KEY;
    expect(await loadBrokerHeldEquity(env, { owner: "op@x.com" })).toBe(null);
  });

  it("returns null on a non-ok bridge body rather than an empty book", async () => {
    const env = envWithStore();
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ ok: false, error: "nope" })));
    expect(await loadBrokerHeldEquity(env, { owner: "op@x.com" })).toBe(null);
  });

  it("serves a fresh cache without calling the broker again", async () => {
    const env = envWithStore();
    const now = 1_700_000_000_000;
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true, accounts: LIVE_ACCOUNTS })));

    const first = await loadBrokerHeldEquity(env, { owner: "op@x.com", nowMs: now });
    expect(first.SPYU.qty).toBe(9);
    expect(global.fetch).toHaveBeenCalledTimes(1);

    const second = await loadBrokerHeldEquity(env, { owner: "op@x.com", nowMs: now + 1000 });
    expect(second.SPYU.qty).toBe(9);
    expect(global.fetch).toHaveBeenCalledTimes(1);

    const later = await loadBrokerHeldEquity(env, {
      owner: "op@x.com",
      nowMs: now + HELD_CACHE_TTL_MS + 1,
    });
    expect(later.SPYU.qty).toBe(9);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});
