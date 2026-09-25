// worker/options-dt-partner-close-operator-flat.test.js
//
// 2026-09-25 — SPY 763P. The bridge placed the operator's buy and the
// partner's buy in one call. The operator's was cancelled unfilled; the
// partner's filled. At 11:01 the model stopped the round, the close path saw
// no operator position and returned `entry_order_cancelled_unfilled` without
// calling the bridge — so the partner, reached only through that call, never
// got a sell and was still holding the put at 12:17.

import { describe, it, expect } from "vitest";
import {
  indexDtMirrorKey,
  maybeAutoMirrorIndexDayTradeEvent,
  shouldClosePartnersOnly,
  summarizePartnerFanout,
} from "./options-auto-mirror.js";

const OP = "op@x.com";
const SIG = "dt:SPY:2026-09-25:2026-09-28:P:763";

function kvMock(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    get: async (k) => (store.has(k) ? store.get(k) : null),
    put: async (k, v) => { store.set(k, v); },
    delete: async (k) => { store.delete(k); },
    list: async ({ prefix = "" } = {}) => ({
      keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
      list_complete: true,
    }),
  };
}

function seeded(mirror) {
  const kv = kvMock();
  kv.store.set(`timed:options:auto-mirror:${OP}`, JSON.stringify({
    enabled: true,
    daily_loss_limit_usd: 500,
    vehicles: { long_put: { enabled: true, max_per_order_usd: 500 } },
  }));
  if (mirror) kv.store.set(indexDtMirrorKey(SIG), JSON.stringify({ signal_id: SIG, ...mirror }));
  return kv;
}

// Operator refused `no_held_position`; the partner sells its one contract.
function bridge(calls, partnerResult = { ok: true, status: "filled", filled_qty: 1, order_id: "P1" }) {
  return {
    fetch: async (req) => {
      calls.push(JSON.parse(await req.text()));
      return new Response(JSON.stringify({
        ok: false, rejected: true, reason: "no_held_position",
        fanout: { accounts: 1, results: [{ user_id: "partner@x.com#webull#individual-cash", ok: partnerResult.ok !== false, contracts: 1, result: partnerResult }] },
      }), { status: 200 });
    },
  };
}

const envWith = (kv, calls, partnerResult) => ({
  ADMIN_EMAIL: OP,
  KV_TIMED: kv,
  BROKER_BRIDGE_HMAC_KEY: "secret",
  BROKER_BRIDGE_URL: "https://bridge.example.workers.dev",
  BROKER_BRIDGE: bridge(calls, partnerResult),
});

const stopCtx = () => ({
  event: "STOP",
  ticker: "SPY",
  signal_id: SIG,
  indicesFlagOn: true,
  strike: 763,
  flavor: "put",
  premium: 0.72,
  bid: 0.71,
  expiration: { iso: "2026-09-28" },
  book: { status: "closed", event: "STOP", contracts: 2, contracts_remaining: 2, exit_premium: 0.72 },
  play: {
    archetype: "day_trade_put",
    _day_trade_flavor: "put",
    strikes: { primary: 763 },
    expiration: { iso: "2026-09-28" },
    legs: [{ action: "BUY", optionType: "PUT", strike: 763, expiration: "2026-09-28", qty: 2 }],
    premium: { mid: 0.72 },
    contracts: 2,
  },
});

// Exactly the record 9/25 ended with, plus the stamp a sent BUY now leaves.
const operatorNeverFilled = {
  entry_fired: false, entry_placed: false, entry_pending: false,
  entry_fill_status: "cancelled", ticker: "SPY", contracts: 1, contracts_remaining: 0,
  strike: 763, flavor: "put", entry_sent_ts: 1790345781286,
};

describe("a STOP on a round the operator never held", () => {
  it("still sends the close so the partner fan-out sells what the partner holds", async () => {
    const kv = seeded(operatorNeverFilled);
    const calls = [];
    const r = await maybeAutoMirrorIndexDayTradeEvent(envWith(kv, calls), stopCtx());
    expect(calls).toHaveLength(1);
    expect(calls[0].play.legs[0]).toMatchObject({ action: "SELL", optionType: "PUT", strike: 763, qty: 2 });
    expect(r.partners_only).toBe(true);
    expect(JSON.parse(kv.store.get(indexDtMirrorKey(SIG))).partners_close_for).toBe(1790345781286);
  });

  it("sends it once per round", async () => {
    const kv = seeded(operatorNeverFilled);
    const calls = [];
    await maybeAutoMirrorIndexDayTradeEvent(envWith(kv, calls), stopCtx());
    await maybeAutoMirrorIndexDayTradeEvent(envWith(kv, calls), stopCtx());
    expect(calls).toHaveLength(1);
  });

  it("does not page the operator's refused leg as an unmirrored reduce", async () => {
    const kv = seeded(operatorNeverFilled);
    await maybeAutoMirrorIndexDayTradeEvent(envWith(kv, []), stopCtx());
    expect([...kv.store.keys()].some((k) => k.startsWith("timed:opt-dt:reduce-unmirrored:"))).toBe(false);
  });

  it("sends nothing for a round no BUY ever went out on", async () => {
    const kv = seeded({ ...operatorNeverFilled, entry_sent_ts: undefined });
    const calls = [];
    await maybeAutoMirrorIndexDayTradeEvent(envWith(kv, calls), stopCtx());
    expect(calls).toHaveLength(0);
  });
});

describe("shouldClosePartnersOnly", () => {
  it("only for EXIT / STOP on a round whose BUY was sent and not yet closed", () => {
    expect(shouldClosePartnersOnly("STOP", { entry_sent_ts: 5 })).toBe(true);
    expect(shouldClosePartnersOnly("EXIT", { entry_sent_ts: 5 })).toBe(true);
    expect(shouldClosePartnersOnly("TRIM", { entry_sent_ts: 5 })).toBe(false);
    expect(shouldClosePartnersOnly("STOP", { entry_sent_ts: 5, partners_close_for: 5 })).toBe(false);
    expect(shouldClosePartnersOnly("STOP", { entry_sent_ts: 9, partners_close_for: 5 })).toBe(true);
    expect(shouldClosePartnersOnly("STOP", null)).toBe(false);
  });
});

describe("summarizePartnerFanout — a flat partner is not a failed reduce", () => {
  const fired = (reason) => ({
    response: { fanout: { accounts: 1, results: [{ user_id: "p@x.com", ok: false, contracts: 1, result: { ok: false, rejected: true, reason } }] } },
  });

  it("grades no_held_position on a close as flat", () => {
    expect(summarizePartnerFanout(fired("no_held_position"), { event: "STOP" })[0])
      .toMatchObject({ decision: "flat", reason: "no_held_position" });
  });

  it("still grades a real refusal as rejected", () => {
    expect(summarizePartnerFanout(fired("positions_unavailable"), { event: "STOP" })[0].decision).toBe("rejected");
  });
});
