// worker/options-dt-broker-flat.test.js
//
// 2026-09-24 — a reduce that can never succeed, retried forever.
//
// Five day trades were closed by hand at Webull that morning after the
// mirror's own stops failed to place. The mirror ledger kept saying one
// contract held, so the reconciler re-offered each SELL once a minute and the
// broker answered `no_held_position` every time: IWM 280P took the identical
// rejection for four hours. Re-offering is the right answer when the broker
// never took the reduce, and no answer at all when the broker does not hold
// the contract.
//
// The cost was not the wasted calls. The day's risk budget still charged all
// five hand-closed contracts as open risk — $448 of a $500 limit committed to
// positions that no longer existed — which blocks every later entry.
//
// `no_held_position` is the only rejection safe to treat as final: the SELL
// guard reserves that name for "holdings read fine, contract absent" and
// reports positions_unavailable / positions_unresolved /
// position_direction_unknown when it could not read the account.

import { describe, it, expect } from "vitest";
import {
  isBrokerFlatReject,
  reconcileIndexDtFill,
  indexDtMirrorKey,
  maybeAutoMirrorIndexDayTradeEvent,
} from "./options-auto-mirror.js";
import {
  RISK_STATE_KEY,
  riskBudgetSnapshot,
  tradingDayOf,
} from "./options-risk-budget.js";

const rejectedWith = (reason) => reconcileIndexDtFill({
  event: "STOP",
  requestedQty: 1,
  fill: { status: "rejected", filled_qty: 0, reason },
});

describe("reconcileIndexDtFill — keeps the broker's own reason", () => {
  it("carries the reject text alongside our label", () => {
    expect(rejectedWith("no_held_position")).toMatchObject({
      persist: false, pending: false, reason: "order_rejected", broker_reason: "no_held_position",
    });
  });

  it("leaves broker_reason null when the broker gave none", () => {
    expect(reconcileIndexDtFill({
      event: "STOP", requestedQty: 1, fill: { status: "rejected", filled_qty: 0 },
    }).broker_reason).toBeNull();
  });

  it("does not invent a reason for a working or filled order", () => {
    expect(reconcileIndexDtFill({
      event: "STOP", requestedQty: 1, fill: { status: "working" },
    }).broker_reason).toBeUndefined();
  });
});

describe("isBrokerFlatReject", () => {
  it("is true only for no_held_position", () => {
    expect(isBrokerFlatReject(rejectedWith("no_held_position"))).toBe(true);
  });

  it("is false for every rejection that means the account could not be read", () => {
    // These three are the guard's names for "we could not see the holdings".
    // Standing the mirror down on any of them abandons a live option.
    for (const reason of [
      "positions_unavailable",
      "positions_unresolved",
      "position_direction_unknown",
    ]) {
      expect(isBrokerFlatReject(rejectedWith(reason))).toBe(false);
    }
  });

  it("is false when the account holds SOME of the contract", () => {
    // A partial holding is still a holding — the reduce should be clamped and
    // retried, not abandoned.
    expect(isBrokerFlatReject(rejectedWith("sell_qty_exceeds_held"))).toBe(false);
  });

  it("is false for a broker-side refusal that a retry can heal", () => {
    // The rejection that started this incident. A reused client_order_id or a
    // submit throttle says nothing about what the account holds.
    expect(isBrokerFlatReject(rejectedWith("Please do not place an order repeatedly"))).toBe(false);
    expect(isBrokerFlatReject(rejectedWith("insufficient_buying_power"))).toBe(false);
  });

  it("does not match a reason that merely contains the words", () => {
    expect(isBrokerFlatReject(rejectedWith("xno_held_positionx"))).toBe(false);
  });

  it("is false for a reduce that placed or is still working", () => {
    expect(isBrokerFlatReject({ persist: true, broker_reason: "no_held_position" })).toBe(false);
    expect(isBrokerFlatReject({ pending: true, broker_reason: "no_held_position" })).toBe(false);
  });

  it("is false for junk", () => {
    expect(isBrokerFlatReject(null)).toBe(false);
    expect(isBrokerFlatReject({})).toBe(false);
  });
});

// ── End to end: the mirror stands down and gives the money back ──────────

const OP = "op@x.com";
const SIG = "dt:IWM:2026-09-24:2026-09-25:P:278";

function kvMock(seed = {}) {
  const store = new Map(Object.entries(seed));
  const meta = new Map();
  return {
    store,
    get: async (k) => (store.has(k) ? store.get(k) : null),
    put: async (k, v, opts) => {
      store.set(k, v);
      if (opts && "metadata" in opts) meta.set(k, opts.metadata);
    },
    delete: async (k) => { store.delete(k); meta.delete(k); },
    list: async ({ prefix = "" } = {}) => ({
      keys: [...store.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((k) => (meta.has(k) ? { name: k, metadata: meta.get(k) } : { name: k })),
      list_complete: true,
    }),
  };
}

// The state the morning actually ended in: the entry mirrored and filled, the
// operator sold the contract by hand, and the mirror has not been told.
function seededKv() {
  const day = tradingDayOf(Date.now());
  const kv = kvMock();
  kv.store.set(`timed:options:auto-mirror:${OP}`, JSON.stringify({
    enabled: true,
    daily_loss_limit_usd: 500,
    vehicles: { long_put: { enabled: true, max_per_order_usd: 500 } },
  }));
  kv.store.set(indexDtMirrorKey(SIG), JSON.stringify({
    entry_fired: true, entry_placed: true, entry_fill_status: "filled",
    ticker: "IWM", contracts: 1, contracts_remaining: 1,
    strike: 278, flavor: "put", entry_premium: 0.69,
    entry_risk_usd: 34.5, entry_stop_fraction: 0.5, vehicle: "long_put",
    signal_id: SIG,
  }));
  kv.store.set(RISK_STATE_KEY(OP, day), JSON.stringify({
    date: day,
    realized_pnl_usd: 0,
    open: { [SIG]: { usd: 34.5, vehicle: "long_put", ticker: "IWM", ts: Date.now() } },
    placed: [{ sid: SIG, order_id: "N5G6F9VHJEI85HDO25EHQKT0OA", ts: Date.now() }],
  }));
  return kv;
}

const envRejecting = (kv, reason) => ({
  ADMIN_EMAIL: OP,
  KV_TIMED: kv,
  BROKER_BRIDGE_HMAC_KEY: "secret",
  BROKER_BRIDGE_URL: "https://bridge.example.workers.dev",
  BROKER_BRIDGE: {
    fetch: async () => new Response(
      JSON.stringify({ ok: false, rejected: true, reject_reason: reason }),
      { status: 200 },
    ),
  },
});

const stopCtx = () => ({
  event: "STOP",
  ticker: "IWM",
  signal_id: SIG,
  indicesFlagOn: true,
  strike: 278,
  flavor: "put",
  premium: 0.44,
  bid: 0.43,
  expiration: { iso: "2026-09-25" },
  book: { status: "stopped", event: "STOP", contracts: 1, contracts_remaining: 0, exit_premium: 0.44 },
  play: {
    archetype: "day_trade_put",
    _day_trade_flavor: "put",
    strikes: { primary: 278 },
    expiration: { iso: "2026-09-25" },
    legs: [{ action: "BUY", optionType: "PUT", strike: 278, expiration: "2026-09-25", qty: 1 }],
    premium: { mid: 0.44 },
    contracts: 1,
  },
});

const mirrorRow = (kv) => JSON.parse(kv.store.get(indexDtMirrorKey(SIG)));
const budget = (kv) => riskBudgetSnapshot(
  JSON.parse(kv.store.get(RISK_STATE_KEY(OP, tradingDayOf(Date.now())))), 500,
);

describe("a STOP the broker answers no_held_position", () => {
  it("stands the mirror down instead of re-offering the SELL forever", async () => {
    const kv = seededKv();
    await maybeAutoMirrorIndexDayTradeEvent(envRejecting(kv, "no_held_position"), stopCtx());
    expect(mirrorRow(kv)).toMatchObject({
      contracts_remaining: 0, exit_fired: true, exit_pending: false, exit_via: "broker_flat",
    });
  });

  it("writes no exit price — nothing was sold, so there is no fill to attribute", async () => {
    const kv = seededKv();
    await maybeAutoMirrorIndexDayTradeEvent(envRejecting(kv, "no_held_position"), stopCtx());
    expect(mirrorRow(kv).exit_premium).toBeUndefined();
    expect(mirrorRow(kv).exit_qty).toBe(0);
  });

  it("gives the day's risk budget back", async () => {
    // The whole cost of the 2026-09-24 incident: five hand-closed contracts
    // held $448 of a $500 limit and blocked every later entry.
    const kv = seededKv();
    expect(budget(kv).open_usd).toBe(34.5);
    await maybeAutoMirrorIndexDayTradeEvent(envRejecting(kv, "no_held_position"), stopCtx());
    expect(budget(kv).open_usd).toBe(0);
    expect(budget(kv).remaining_usd).toBe(500);
  });

  it("keeps re-offering when the account could not be READ", async () => {
    // positions_unresolved is a parser regression, not a flat account.
    // Standing down here would abandon a live option.
    for (const reason of ["positions_unresolved", "positions_unavailable", "position_direction_unknown"]) {
      const kv = seededKv();
      await maybeAutoMirrorIndexDayTradeEvent(envRejecting(kv, reason), stopCtx());
      expect(mirrorRow(kv).contracts_remaining).toBe(1);
      expect(mirrorRow(kv).exit_via).toBeUndefined();
      expect(budget(kv).open_usd).toBe(34.5);
    }
  });

  it("keeps re-offering when the broker refused the ORDER", async () => {
    // The rejection that started the incident. A reused client_order_id says
    // nothing about what the account holds, and a retry is the right answer.
    const kv = seededKv();
    await maybeAutoMirrorIndexDayTradeEvent(
      envRejecting(kv, "Please do not place an order repeatedly"), stopCtx(),
    );
    expect(mirrorRow(kv).contracts_remaining).toBe(1);
    expect(budget(kv).open_usd).toBe(34.5);
  });
});
