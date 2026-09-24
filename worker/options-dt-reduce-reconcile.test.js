// 2026-09-24 — IWM 279P and 280P both entered, mirrored, filled, and then
// stopped out on paper (10:05 and 10:35 ET). Both SELLs reached the bridge and
// came back rejected (`no_held_position`, from a Webull position parser that
// could not read its own holdings). Nothing retried either one: Stage 5b only
// runs when the paper book raises an event, and an event fires once. The
// mirrors still said a contract held, the model said flat, and the puts stayed
// long through stops they had already taken.
//
// A missed TRIM is the same bug with none of the symptoms — the position
// legitimately stays open afterwards, so nothing about it looks wrong.
//
// These tests pin the property that was missing: reduces are reconciled on
// QUANTITY, on a schedule, against the paper book — not on an event that will
// never come again.
import { describe, it, expect } from "vitest";
import {
  parseIndexDtSignalId,
  targetMirrorRemaining,
  reconcileIndexDtMirrorPositions,
  indexDtMirrorKey,
  OPT_DT_REDUCE_RECON_KEY,
  MIRROR_REDUCE_LOOKBACK_MS,
  MIRROR_RECONCILE_REASON,
  recordIndexDtMirrorDecision,
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

const trimmedBook = (patch = {}) => ({
  status: "trimmed",
  event: "TRIM",
  contracts: 4,
  trim_sell_qty: 2,
  contracts_remaining: 2,
  entry_premium: 0.64,
  trim_premium: 0.95,
  trim_ts: NOW - 5 * 60 * 1000,
  ...patch,
});

function harness({ mirror = mirroredHolding(), book = closedBook(), quote = { mid: 0.52, bid: 0.5 } } = {}) {
  const fired = [];
  const env = { KV_TIMED: kvMock({ [indexDtMirrorKey(SIG)]: mirror }) };
  const run = (opts = {}) => reconcileIndexDtMirrorPositions(env, {
    now: NOW,
    loadBook: async () => book,
    resolvePremium: async () => quote,
    fireReduce: async (_env, ctx) => {
      fired.push(ctx);
      // `reconcile` is what says the order actually took. Stage 5b always
      // returns it when it fires, and the telemetry below now reads it, so a
      // stub that omits it would be modelling a reduce that never placed.
      return {
        skipped: false,
        close_qty: 1,
        limit_price: 0.5,
        reconcile: { persist: true, pending: false, filledQty: 1, status: "filled" },
      };
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

describe("targetMirrorRemaining", () => {
  it("a closed book means the broker should hold nothing", () => {
    expect(targetMirrorRemaining({ status: "closed" }, { contracts: 3 })).toBe(0);
  });

  it("an open book means the broker should hold everything", () => {
    expect(targetMirrorRemaining({ status: "open" }, { contracts: 3 })).toBe(3);
  });

  it("a trimmed book means the mirror's own trim share is gone", () => {
    expect(targetMirrorRemaining({ status: "trimmed" }, { contracts: 4 })).toBe(2);
    // trimSellQty rounds a 50% trim UP (3 -> 2 sold), so 1 is left.
    expect(targetMirrorRemaining({ status: "trimmed" }, { contracts: 3 })).toBe(1);
  });

  it("a 1-lot mirror cannot partial-trim, so trimmed is not drift for it", () => {
    // Stage 5b refuses the trim (`mirror_single_lot_no_trim`); the target has
    // to agree or the reconciler would chase a reduce that never fires.
    expect(targetMirrorRemaining({ status: "trimmed" }, { contracts: 1 })).toBe(1);
  });

  it("falls back to the remaining count when contracts was never stamped", () => {
    expect(targetMirrorRemaining({ status: "trimmed" }, { contracts_remaining: 4 })).toBe(2);
  });

  it("refuses to do arithmetic the book does not support", () => {
    expect(targetMirrorRemaining({ status: "pending_entry" }, { contracts: 2 })).toBeNull();
    expect(targetMirrorRemaining(null, { contracts: 2 })).toBeNull();
    expect(targetMirrorRemaining({ status: "closed" }, {})).toBeNull();
  });
});

describe("reconcileIndexDtMirrorPositions — closes", () => {
  it("re-fires the close the broker refused", async () => {
    const { fired, run } = harness();
    const out = await run();

    expect(out.drifted).toBe(1);
    expect(out.fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({
      event: "STOP",
      ticker: "IWM",
      signal_id: SIG,
      reason: "mirror_qty_reconcile",
      premium: 0.52,
      bid: 0.5,
      flavor: "put",
      strike: 279,
    });
    expect(out.fired[0]).toMatchObject({ held: 1, target: 0, event: "STOP" });
  });

  it("names the held contract, not whatever the desk would pick now", async () => {
    const { fired, run } = harness();
    await run();

    const leg = fired[0].play.legs[0];
    expect(leg).toMatchObject({ optionType: "PUT", strike: 279, expiration: "2026-09-25" });
    expect(fired[0].play.archetype).toBe("day_trade_put");
    expect(fired[0].expiration).toEqual({ iso: "2026-09-25" });
  });

  it("closes on EXIT when the book closed without naming a sell event", async () => {
    const { fired, run } = harness({ book: closedBook({ event: "PROTECT" }) });
    await run();
    expect(fired[0].event).toBe("EXIT");
  });

  it("leaves an open book alone", async () => {
    const { fired, run } = harness({ book: closedBook({ status: "open", event: "BUY" }) });
    const out = await run();
    expect(fired).toHaveLength(0);
    expect(out.drifted).toBe(0);
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
    expect(out.skipped).toContainEqual({ signal_id: SIG, event: "STOP", reason: "reduce_order_working" });
  });

  it("gives up on a reduce too old to be worth chasing", async () => {
    const { fired, run } = harness({
      book: closedBook({ exit_ts: NOW - MIRROR_REDUCE_LOOKBACK_MS - 1 }),
    });
    const out = await run();
    expect(fired).toHaveLength(0);
    expect(out.skipped).toContainEqual({ signal_id: SIG, event: "STOP", reason: "reduce_too_old" });
  });

  it("will not price a reduce off nothing", async () => {
    const { fired, run } = harness({ quote: null });
    const out = await run();
    expect(fired).toHaveLength(0);
    expect(out.skipped).toContainEqual({ signal_id: SIG, event: "STOP", reason: "no_live_premium" });
  });

  it("bounds how many it fires in one pass", async () => {
    const env = { KV_TIMED: kvMock() };
    for (const strike of [277, 278, 279, 280, 281]) {
      const id = `dt:IWM:2026-09-24:2026-09-25:P:${strike}`;
      env.KV_TIMED.store.set(indexDtMirrorKey(id), mirroredHolding({ strike, signal_id: id }));
    }
    const fired = [];
    const out = await reconcileIndexDtMirrorPositions(env, {
      now: NOW,
      maxFire: 2,
      loadBook: async () => closedBook(),
      resolvePremium: async () => ({ mid: 0.52, bid: 0.5 }),
      fireReduce: async (_e, ctx) => { fired.push(ctx); return { skipped: false }; },
    });
    expect(fired).toHaveLength(2);
    expect(out.fired).toHaveLength(2);
  });
});

describe("reconcileIndexDtMirrorPositions — trims are first class", () => {
  it("re-fires a trim the broker never took", async () => {
    const { fired, run } = harness({
      mirror: mirroredHolding({ contracts: 4, contracts_remaining: 4 }),
      book: trimmedBook(),
    });
    const out = await run();

    expect(out.fired).toHaveLength(1);
    expect(fired[0].event).toBe("TRIM");
    expect(fired[0].reason).toBe("mirror_qty_reconcile");
    expect(out.fired[0]).toMatchObject({ held: 4, target: 2, event: "TRIM" });
  });

  it("asks for exactly the shortfall, so a partially filled trim is not re-sold", async () => {
    // Requested 2, filled 1: 3 held against a target of 2. Stage 5b's own
    // arithmetic would sell the full trim share of 2 and leave the broker
    // holding LESS than the model.
    const { fired, run } = harness({
      mirror: mirroredHolding({ contracts: 4, contracts_remaining: 3, trim_fired: true, trim_qty: 1 }),
      book: trimmedBook(),
    });
    await run();
    expect(fired[0].max_reduce_qty).toBe(1);
  });

  it("does not stack a trim on a working one", async () => {
    const { fired, run } = harness({
      mirror: mirroredHolding({ contracts: 4, contracts_remaining: 4, trim_pending: true, trim_order_id: "WB2" }),
      book: trimmedBook(),
    });
    const out = await run();
    expect(fired).toHaveLength(0);
    expect(out.skipped).toContainEqual({ signal_id: SIG, event: "TRIM", reason: "reduce_order_working" });
  });

  it("measures a trim's age off the trim clock, not the exit clock", async () => {
    const { fired, run } = harness({
      mirror: mirroredHolding({ contracts: 4, contracts_remaining: 4 }),
      book: trimmedBook({ trim_ts: NOW - MIRROR_REDUCE_LOOKBACK_MS - 1 }),
    });
    const out = await run();
    expect(fired).toHaveLength(0);
    expect(out.skipped).toContainEqual({ signal_id: SIG, event: "TRIM", reason: "reduce_too_old" });
  });

  it("leaves a trim that already filled alone", async () => {
    const { fired, run } = harness({
      mirror: mirroredHolding({ contracts: 4, contracts_remaining: 2, trim_fired: true, trim_qty: 2 }),
      book: trimmedBook(),
    });
    const out = await run();
    expect(fired).toHaveLength(0);
    expect(out.drifted).toBe(0);
  });

  it("does not chase a trim a 1-lot mirror would refuse", async () => {
    const { fired, run } = harness({
      mirror: mirroredHolding({ contracts: 1, contracts_remaining: 1 }),
      book: trimmedBook({ contracts: 2, trim_sell_qty: 1, contracts_remaining: 1 }),
    });
    const out = await run();
    expect(fired).toHaveLength(0);
    expect(out.drifted).toBe(0);
  });

  it("flattens rather than trims once the book has closed on top of a trim", async () => {
    const { fired, run } = harness({
      mirror: mirroredHolding({ contracts: 4, contracts_remaining: 2, trim_fired: true, trim_qty: 2 }),
      book: closedBook({ event: "EXIT" }),
    });
    await run();
    expect(fired[0].event).toBe("EXIT");
    expect(fired[0].max_reduce_qty).toBe(2);
  });
});

// The market turned after the 2026-09-24 stops, so the stranded puts came
// back as WINNERS. A repair fills at today's price, and an unlabelled gain is
// worse than an unlabelled loss: it reads as good execution rather than as a
// bug being cleaned up.
describe("a repair is labelled as a repair", () => {
  it("tags the reduce it fires so the records can tell", async () => {
    const { fired, run } = harness();
    await run();
    expect(fired[0].reason).toBe(MIRROR_RECONCILE_REASON);
  });

  it("keeps the provenance on a decision that DID mirror, where reason is nulled", async () => {
    const env = { KV_TIMED: kvMock() };
    await recordIndexDtMirrorDecision(
      env,
      { signal_id: SIG, ticker: "IWM", event: "STOP", reason: MIRROR_RECONCILE_REASON },
      { skipped: false, fill: { status: "filled" }, close_qty: 1 },
    );
    const [row] = JSON.parse(env.KV_TIMED.store.get("timed:opt-dt-mirror-log"));
    expect(row).toMatchObject({ decision: "mirrored", reason: null, via: "reconcile" });
  });

  it("leaves an on-time mirror unlabelled", async () => {
    const env = { KV_TIMED: kvMock() };
    await recordIndexDtMirrorDecision(
      env,
      { signal_id: SIG, ticker: "IWM", event: "STOP", reason: "hard_stop" },
      { skipped: false, fill: { status: "filled" }, close_qty: 1 },
    );
    const [row] = JSON.parse(env.KV_TIMED.store.get("timed:opt-dt-mirror-log"));
    expect(row.via).toBeNull();
  });
});

describe("reconcileIndexDtMirrorPositions — telemetry", () => {
  it("leaves a breadcrumb for /timed/health while a reduce is unmirrored", async () => {
    const { env, run } = harness({ quote: null });
    await run();
    const rec = JSON.parse(env.KV_TIMED.store.get(OPT_DT_REDUCE_RECON_KEY));
    expect(rec.unmirrored).toContainEqual({ signal_id: SIG, event: "STOP", reason: "no_live_premium" });
  });

  it("records a reduce that reached Stage 5b and was refused there", async () => {
    const { env, run } = harness();
    await run({ fireReduce: async () => ({ skipped: true, reason: "vehicle_long_put_disabled" }) });
    const rec = JSON.parse(env.KV_TIMED.store.get(OPT_DT_REDUCE_RECON_KEY));
    expect(rec.unmirrored[0]).toMatchObject({ reason: "vehicle_long_put_disabled", event: "STOP" });
  });

  // 2026-09-24 — the IWM 278P stop-out. The reduce fired every minute for 18
  // minutes and the broker rejected all 20 attempts (a reused
  // client_order_id). `skipped` was false each time, so the breadcrumb listed
  // only the two reduces that HAD placed and nothing paged; the contract was
  // flattened by hand. A reduce that fires and is refused is still unmirrored.
  it("records a reduce the broker rejected, not just one Stage 5b refused", async () => {
    const { env, run } = harness();
    await run({
      fireReduce: async () => ({
        skipped: false,
        close_qty: 1,
        limit_price: 0.44,
        reconcile: { persist: false, pending: false, filledQty: 0, status: "rejected", reason: "order_rejected" },
      }),
    });
    const rec = JSON.parse(env.KV_TIMED.store.get(OPT_DT_REDUCE_RECON_KEY));
    expect(rec.unmirrored[0]).toMatchObject({
      signal_id: SIG, event: "STOP", placed: false, reason: "order_rejected",
    });
  });

  it("does not flag a reduce that left a working order at the broker", async () => {
    const { env, run } = harness();
    await run({
      fireReduce: async () => ({
        skipped: false,
        close_qty: 1,
        limit_price: 0.44,
        reconcile: { persist: false, pending: true, filledQty: 0, status: "working", order_id: "X1" },
      }),
    });
    expect(env.KV_TIMED.store.has(OPT_DT_REDUCE_RECON_KEY)).toBe(false);
  });

  it("clears the breadcrumb once the books agree", async () => {
    const { env, run } = harness({ quote: null });
    await run();
    expect(env.KV_TIMED.store.has(OPT_DT_REDUCE_RECON_KEY)).toBe(true);

    await run({ quote: undefined, resolvePremium: async () => ({ mid: 0.52, bid: 0.5 }) });
    expect(env.KV_TIMED.store.has(OPT_DT_REDUCE_RECON_KEY)).toBe(false);
  });
});
