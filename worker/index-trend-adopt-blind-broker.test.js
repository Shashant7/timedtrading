// worker/index-trend-adopt-blind-broker.test.js
//
// 2026-09-22 — the seam between the catch-up and the broker, with NOTHING
// mocked except the network.
//
// `index-trend-auto-mirror.test.js` mocks `loadBrokerHeldEquity` and its
// default is `async () => ({})`, commented "Default: nothing, which is the
// 'safe to buy' case". That is true of a reachable broker holding nothing,
// and it is exactly what the producer also returned when the positions call
// FAILED: `/bridge/positions` marks the account `positions_error`, coerces
// its item list to `[]`, and still answers `{ ok: true, accounts: [...] }`,
// because the envelope reports the bridge being reachable and not the broker
// having answered. Summing items over that gives `{}`, and
// `heldQtyFor({}, "SPYU")` is 0.
//
// So every guard downstream was correct and the whole chain was still wrong:
// `adoptBrokerHeldSleeve` only defers on `held == null`, `{}` skips past it,
// `qty` comes out 0, adopt returns null, and the caller's
// `if (adopted) return adopted;` falls through to planEntryQty and buys the
// sleeve a second time. That is SPYU W38 — a real 9-share fill with no ring
// settle, no audit row and no mirror row — repeated with real money.
//
// Mocking the thing under test cannot catch that, so this file does not.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { healMissedIndexTrendEntries } from "./index-trend-auto-mirror.js";
import { forwardOrderToBridge } from "./broker-bridge-client.js";

vi.mock("./broker-bridge-client.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    forwardOrderToBridge: vi.fn(async () => ({ ok: true, order_id: "ord-1" })),
  };
});

const SIGNAL_ID = "it:SPY:SPYU:LONG:2026-W38";
const NOW = Date.UTC(2026, 8, 14, 14, 30, 0); // Mon 10:30 ET
const ENTRY_TS = Date.UTC(2026, 8, 14, 13, 45, 0);

const ENABLED_PREFS = JSON.stringify({
  enabled: true,
  daily_cap: 3,
  vehicles: { index_trend_letf: { enabled: true, daily_cap: 2, max_per_order_usd: 2000 } },
});

function envWithSpyuBook() {
  const store = {
    "timed:options:auto-mirror:op@test.com": ENABLED_PREFS,
    "timed:idx-trend-carry:SPYU": JSON.stringify({
      signal_id: SIGNAL_ID,
      book: {
        status: "open",
        shares: 90,
        shares_remaining: 90,
        entry_ts: ENTRY_TS,
        underlying: "SPY",
        letf_ticker: "SPYU",
        last_letf_price: 33.42,
        signal_id: SIGNAL_ID,
      },
    }),
  };
  return {
    ADMIN_EMAIL: "op@test.com",
    BROKER_BRIDGE_URL: "https://bridge.test",
    BROKER_BRIDGE_OPERATOR_KEY: "opkey",
    KV_TIMED: {
      get: async (k) => (store[k] == null ? null : store[k]),
      put: async (k, v) => { store[k] = v; },
    },
    store,
  };
}

/** What /bridge/positions really answers when Webull rate limits the read. */
const RATE_LIMITED = {
  ok: true,
  accounts: [{
    account_id: "op@test.com#webull#roth-ira",
    label: "Roth IRA",
    mirror_enabled: true,
    positions_error: "Too many requests",
    items: [],
  }],
};

/** The same account, answering, holding the orphaned W38 fill. */
const HOLDS_SPYU = {
  ok: true,
  accounts: [{
    account_id: "op@test.com#webull#roth-ira",
    label: "Roth IRA",
    mirror_enabled: true,
    items: [{ ticker: "SPYU", instrument: "equity", broker_qty: 9, avg_cost: 33.35 }],
  }],
};

/** The same account, answering, genuinely flat. */
const FLAT = {
  ok: true,
  accounts: [{
    account_id: "op@test.com#webull#roth-ira",
    label: "Roth IRA",
    mirror_enabled: true,
    items: [],
  }],
};

function bridgeAnswers(payload) {
  global.fetch = vi.fn(async () => new Response(JSON.stringify(payload)));
}

describe("index-trend catch-up vs a broker that could not be read", () => {
  beforeEach(() => {
    forwardOrderToBridge.mockClear();
  });

  it("does not buy a second time when the positions call was rate limited", async () => {
    const env = envWithSpyuBook();
    bridgeAnswers(RATE_LIMITED);

    const heal = await healMissedIndexTrendEntries(env, { now: NOW });

    expect(forwardOrderToBridge).not.toHaveBeenCalled();
    expect(heal.results[0].reason).toBe("broker_holdings_unknown_entry_deferred");
    // Deferred, not written off — the sleeve is still catchable next tick.
    expect(env.store[`timed:idx-trend-mirror:${SIGNAL_ID}`]).toBeUndefined();
  });

  it("adopts the orphaned fill when the broker does answer", async () => {
    const env = envWithSpyuBook();
    bridgeAnswers(HOLDS_SPYU);

    await healMissedIndexTrendEntries(env, { now: NOW });

    expect(forwardOrderToBridge).not.toHaveBeenCalled();
    const mirror = JSON.parse(env.store[`timed:idx-trend-mirror:${SIGNAL_ID}`]);
    expect(mirror.adopted_from_broker).toBe(true);
    expect(mirror.adopted_broker_qty).toBe(9);
  });

  it("still buys when the broker answers and is genuinely flat", async () => {
    // The fix must not turn every catch-up into a deferral — an answered
    // empty book is still a licence to buy.
    const env = envWithSpyuBook();
    bridgeAnswers(FLAT);

    await healMissedIndexTrendEntries(env, { now: NOW });

    expect(forwardOrderToBridge).toHaveBeenCalled();
  });
});
