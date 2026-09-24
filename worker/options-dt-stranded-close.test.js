// 2026-09-24 — IWM 279P entered, mirrored, filled, and then stopped out on
// paper at 10:05 ET. The SELL reached the bridge and came back rejected
// (`no_held_position`, from a Webull position parser that could not read its
// own holdings). Nothing retried it: Stage 5b only runs when the paper book
// raises an event, and that book was already closed. The mirror still said
// one contract held, the model said flat, and the put stayed long in the
// account through a stop it had already taken.
//
// These tests pin the property that was missing: a mirrored position whose
// paper book has closed gets put back in front of the broker on a schedule,
// not on an event that will never come again.
import { describe, it, expect } from "vitest";
import {
  parseIndexDtSignalId,
  sweepStrandedIndexDtCloses,
  indexDtMirrorKey,
  STRANDED_CLOSE_LOOKBACK_MS,
} from "./options-auto-mirror.js";

const SIG = "dt:IWM:2026-09-24:2026-09-25:P:279";
const NOW = Date.parse("2026-09-24T14:30:00Z");

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

const mirroredHolding = (patch = {}) => JSON.stringify({
  entry_fired: true,
  entry_placed: true,
  ticker: "IWM",
  contracts: 1,
  contracts_remaining: 1,
  strike: 279,
  flavor: "put",
  entry_premium: 0.74,
  signal_id: SIG,
  ...patch,
});

const closedBook = (patch = {}) => ({
  status: "closed",
  event: "STOP",
  contracts: 2,
  contracts_remaining: 2,
  entry_premium: 0.64,
  exit_premium: 0.63,
  exit_ts: NOW - 5 * 60 * 1000,
  ...patch,
});

function harness({ mirror = mirroredHolding(), book = closedBook(), quote = { mid: 0.52, bid: 0.5 } } = {}) {
  const fired = [];
  const env = { KV_TIMED: kvMock({ [indexDtMirrorKey(SIG)]: mirror }) };
  const run = (opts = {}) => sweepStrandedIndexDtCloses(env, {
    now: NOW,
    loadBook: async () => book,
    resolvePremium: async () => quote,
    fireClose: async (_env, ctx) => {
      fired.push(ctx);
      return { skipped: false, close_qty: 1, limit_price: 0.5 };
    },
    ...opts,
  });
  return { env, fired, run };
}

describe("parseIndexDtSignalId", () => {
  it("recovers the contract from the signal id alone", () => {
    expect(parseIndexDtSignalId(SIG)).toEqual({
      ticker: "IWM",
      ny_date: "2026-09-24",
      expiration: "2026-09-25",
      right: "P",
      strike: 279,
      flavor: "put",
    });
  });

  it("returns null for anything that is not a day-trade contract id", () => {
    expect(parseIndexDtSignalId("it:IWM:TNA:LONG:2026-W39")).toBeNull();
    expect(parseIndexDtSignalId("")).toBeNull();
  });
});

describe("sweepStrandedIndexDtCloses", () => {
  it("re-fires the close the broker refused", async () => {
    const { fired, run } = harness();
    const out = await run();

    expect(out.stranded).toBe(1);
    expect(out.fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({
      event: "STOP",
      ticker: "IWM",
      signal_id: SIG,
      reason: "stranded_close_heal",
      premium: 0.52,
      bid: 0.5,
      flavor: "put",
      strike: 279,
    });
  });

  it("names the held contract, not whatever the desk would pick now", async () => {
    const { fired, run } = harness();
    await run();

    const leg = fired[0].play.legs[0];
    expect(leg).toMatchObject({ optionType: "PUT", strike: 279, expiration: "2026-09-25" });
    expect(fired[0].play.archetype).toBe("day_trade_put");
    expect(fired[0].expiration).toEqual({ iso: "2026-09-25" });
  });

  it("leaves an open book alone", async () => {
    const { fired, run } = harness({ book: closedBook({ status: "open", event: "BUY" }) });
    const out = await run();
    expect(fired).toHaveLength(0);
    expect(out.stranded).toBe(0);
  });

  it("leaves a mirror that already exited alone", async () => {
    const { fired, run } = harness({
      mirror: mirroredHolding({ exit_fired: true, contracts_remaining: 0 }),
    });
    await run();
    expect(fired).toHaveLength(0);
  });

  it("never sells against an entry that was not mirrored", async () => {
    const { fired, run } = harness({ mirror: mirroredHolding({ entry_fired: false }) });
    await run();
    expect(fired).toHaveLength(0);
  });

  it("does not stack a second SELL on a working one", async () => {
    const { fired, run } = harness({
      mirror: mirroredHolding({ exit_pending: true, exit_order_id: "WB1" }),
    });
    const out = await run();
    expect(fired).toHaveLength(0);
    expect(out.skipped).toContainEqual({ signal_id: SIG, reason: "exit_order_working" });
  });

  it("gives up on a close too old to be worth flattening", async () => {
    const { fired, run } = harness({
      book: closedBook({ exit_ts: NOW - STRANDED_CLOSE_LOOKBACK_MS - 1 }),
    });
    const out = await run();
    expect(fired).toHaveLength(0);
    expect(out.skipped).toContainEqual({ signal_id: SIG, reason: "close_too_old" });
  });

  it("will not price a close off nothing", async () => {
    const { fired, run } = harness({ quote: null });
    const out = await run();
    expect(fired).toHaveLength(0);
    expect(out.skipped).toContainEqual({ signal_id: SIG, reason: "no_live_premium" });
  });

  it("bounds how many it fires in one pass", async () => {
    const env = { KV_TIMED: kvMock() };
    for (const strike of [277, 278, 279, 280, 281]) {
      const id = `dt:IWM:2026-09-24:2026-09-25:P:${strike}`;
      env.KV_TIMED.store.set(indexDtMirrorKey(id), mirroredHolding({ strike, signal_id: id }));
    }
    const fired = [];
    const out = await sweepStrandedIndexDtCloses(env, {
      now: NOW,
      maxFire: 2,
      loadBook: async () => closedBook(),
      resolvePremium: async () => ({ mid: 0.52, bid: 0.5 }),
      fireClose: async (_e, ctx) => { fired.push(ctx); return { skipped: false }; },
    });
    expect(fired).toHaveLength(2);
    expect(out.fired).toHaveLength(2);
  });
});
