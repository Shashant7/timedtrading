// worker/mirror-kernel.test.js — the entangled mirror kernel against real SQLite.

import { describe, it, expect, beforeEach } from "vitest";
import { d1Sqlite } from "./test-support/d1-sqlite.js";
import {
  dayTradePositionId,
  kernelClientOrderId,
  sleeveTarget,
  isIndivisibleLot,
  canonicalDivergence,
  DIVERGENCE,
  recordModelLeg,
  listUnverifiedPositions,
  markPositionVerified,
  ensureSleeve,
  setSleeveStatus,
  loadSleeves,
  upsertAttempt,
  nextAttemptNumber,
  findAttemptByBrokerOrder,
  attemptStatusFromFill,
  planSleeveConverge,
  _resetKernelSchemaForTest,
} from "./mirror-kernel.js";

const SID = "dt:IWM:2026-09-24:2026-09-25:P:279";
const T0 = Date.UTC(2026, 8, 24, 14, 0, 0);

describe("identity", () => {
  it("names one round of one day trade", () => {
    expect(dayTradePositionId(SID, T0)).toBe(`${SID}@${T0}`);
    expect(dayTradePositionId(SID, null)).toBeNull();
    expect(dayTradePositionId("", T0)).toBeNull();
  });

  it("derives a 30-character client_order_id that never repeats", async () => {
    const a = await kernelClientOrderId({ positionId: "p", seq: 1, accountId: "A", attempt: 1 });
    const b = await kernelClientOrderId({ positionId: "p", seq: 1, accountId: "A", attempt: 1 });
    expect(a).toHaveLength(30);
    expect(a).toMatch(/^tt[0-9a-f]{28}$/);
    expect(a).not.toBe(b);
  });

  it("is deterministic when the nonce is pinned", async () => {
    const args = { positionId: "p", seq: 1, accountId: "A", attempt: 2, nonce: "n" };
    expect(await kernelClientOrderId(args)).toBe(await kernelClientOrderId(args));
  });
});

describe("sleeveTarget — the mirror-image rule", () => {
  // Design doc §3.1: the model opens 3, trims 2, keeps 1.
  const model = { opened_qty: 3, remaining_qty: 1 };

  it.each([
    [3, 1, false],
    [2, 1, false],
    [1, 1, true],
  ])("a %i-lot sleeve holds %i after the trim (indivisible: %s)", (opened, target, indivisible) => {
    expect(sleeveTarget(model, { opened_qty: opened })).toBe(target);
    expect(isIndivisibleLot(model, { opened_qty: opened })).toBe(indivisible);
  });

  it("halves a two-lot sleeve on a two-lot model's trim", () => {
    expect(sleeveTarget({ opened_qty: 2, remaining_qty: 1 }, { opened_qty: 2 })).toBe(1);
  });

  it("is zero once the model is flat, whatever the sleeve size", () => {
    expect(sleeveTarget({ opened_qty: 3, remaining_qty: 0 }, { opened_qty: 5 })).toBe(0);
  });

  it("is zero for a sleeve that never bought", () => {
    expect(sleeveTarget({ opened_qty: 2, remaining_qty: 2 }, { opened_qty: 0 })).toBe(0);
  });

  it("never exceeds what the sleeve opened", () => {
    expect(sleeveTarget({ opened_qty: 2, remaining_qty: 2 }, { opened_qty: 1 })).toBe(1);
  });
});

describe("canonicalDivergence — the closed set", () => {
  it.each([
    ["daily_loss_budget_52_left_of_500_needs_108", DIVERGENCE.DAILY_LOSS_BUDGET],
    ["vehicle_daily_cap_2_reached_for_long_put", DIVERGENCE.VEHICLE_DAILY_CAP],
    ["one_lot_over_max_per_order_usd", DIVERGENCE.PER_ORDER_CAP],
    ["one_lot_over_daily_loss_limit", DIVERGENCE.MAX_LOSS_CAP],
    ["insufficient_cash_for_one_unit_0_lt_154.73", DIVERGENCE.INSUFFICIENT_BUYING_POWER],
    ["account_too_small_to_mirror_9909_account_too_small_for_one_share", DIVERGENCE.ACCOUNT_TOO_SMALL],
    ["options_not_enabled", DIVERGENCE.LANE_DISABLED],
    ["order_cancelled", DIVERGENCE.UNFILLED_AT_LIMIT],
  ])("an entry refused with %s is %s", (raw, reason) => {
    expect(canonicalDivergence(raw, "buy")).toBe(reason);
  });

  it("names the holder's own sale on a reduce", () => {
    expect(canonicalDivergence("no_held_position", "sell")).toBe(DIVERGENCE.EXTERNAL_REDUCTION);
  });

  it.each([
    ["Please do not place an order repeatedly", "buy"],
    ["account_equity_unknown", "buy"],
    ["positions_unavailable", "sell"],
    ["daily_loss_budget_0_left", "sell"],
    ["", "buy"],
  ])("treats %s on a %s as a defect", (raw, side) => {
    expect(canonicalDivergence(raw, side)).toBeNull();
  });
});

describe("model legs", () => {
  let db;
  beforeEach(() => { _resetKernelSchemaForTest(); db = d1Sqlite(); });

  const leg = (event, remainingAfter, ts) => recordModelLeg(db, {
    signalId: SID, entryTs: T0, ticker: "iwm", event, openedQty: 2, remainingAfter, now: ts,
  });

  it("numbers BUY, TRIM and STOP in order and tracks the position", async () => {
    expect((await leg("BUY", 2, T0)).seq).toBe(0);
    expect((await leg("TRIM", 1, T0 + 60_000)).seq).toBe(1);
    expect((await leg("STOP", 1, T0 + 120_000)).seq).toBe(2);
    const pos = await db.prepare("SELECT * FROM model_position").first();
    expect(pos).toMatchObject({
      position_id: `${SID}@${T0}`, ticker: "IWM", opened_qty: 2, remaining_qty: 0,
      status: "closed", last_seq: 2, last_event: "STOP",
    });
  });

  it("does not record the same action twice", async () => {
    await leg("BUY", 2, T0);
    const again = await leg("BUY", 2, T0 + 5);
    expect(again).toMatchObject({ seq: 0, duplicate: true });
    const n = await db.prepare("SELECT COUNT(*) AS n FROM model_leg").first("n");
    expect(n).toBe(1);
  });

  it("ignores PROTECT and anything without a round", async () => {
    expect(await leg("PROTECT", 1, T0)).toBeNull();
    expect(await recordModelLeg(db, { signalId: SID, entryTs: null, event: "BUY" })).toBeNull();
  });

  it("lists a reduce for verification only after the settle window", async () => {
    await leg("BUY", 2, T0);
    await leg("STOP", 0, T0 + 60_000);
    expect(await listUnverifiedPositions(db, { now: T0 + 90_000, settleMs: 60_000 })).toHaveLength(0);
    const due = await listUnverifiedPositions(db, { now: T0 + 130_000, settleMs: 60_000 });
    expect(due).toHaveLength(1);
    await markPositionVerified(db, due[0].position_id, due[0].last_seq, T0 + 131_000);
    expect(await listUnverifiedPositions(db, { now: T0 + 200_000 })).toHaveLength(0);
  });

  it("does not list a position whose only leg is the entry", async () => {
    await leg("BUY", 2, T0);
    expect(await listUnverifiedPositions(db, { now: T0 + 10 * 60_000 })).toHaveLength(0);
  });
});

describe("sleeves are derived from attempts", () => {
  let db;
  const PID = `${SID}@${T0}`;
  beforeEach(async () => {
    _resetKernelSchemaForTest();
    db = d1Sqlite();
    await ensureSleeve(db, { positionId: PID, accountId: "ACC1", userId: "op@x.com#webull#roth-ira", isOwner: true });
  });

  it("opens from buy fills and reduces from sell and external fills", async () => {
    await upsertAttempt(db, { clientOrderId: "c1", positionId: PID, accountId: "ACC1", side: "buy", requestedQty: 2, filledQty: 2, avgPrice: 0.64, status: "filled" });
    await upsertAttempt(db, { clientOrderId: "c2", positionId: PID, accountId: "ACC1", side: "sell", requestedQty: 1, filledQty: 1, avgPrice: 0.9, status: "filled" });
    let [s] = await loadSleeves(db, PID);
    expect(s).toMatchObject({ opened_qty: 2, remaining_qty: 1, in_flight: 0, is_owner: true });
    expect(s.entry_avg).toBeCloseTo(0.64);
    await upsertAttempt(db, { clientOrderId: "x1", positionId: PID, accountId: "ACC1", side: "external", filledQty: 1, status: "filled" });
    [s] = await loadSleeves(db, PID);
    expect(s.remaining_qty).toBe(0);
  });

  it("re-reading a cumulative fill never double-counts it", async () => {
    await upsertAttempt(db, { clientOrderId: "c1", positionId: PID, accountId: "ACC1", side: "buy", filledQty: 1, status: "working" });
    await upsertAttempt(db, { clientOrderId: "c1", positionId: PID, accountId: "ACC1", side: "buy", filledQty: 2, status: "filled" });
    await upsertAttempt(db, { clientOrderId: "c1", positionId: PID, accountId: "ACC1", side: "buy", filledQty: 2, status: "filled" });
    // A stale poll reporting less must not walk a fill backwards either.
    await upsertAttempt(db, { clientOrderId: "c1", positionId: PID, accountId: "ACC1", side: "buy", filledQty: 1, status: "filled" });
    const [s] = await loadSleeves(db, PID);
    expect(s.opened_qty).toBe(2);
  });

  it("counts an order still working as in flight", async () => {
    await upsertAttempt(db, { clientOrderId: "c1", positionId: PID, accountId: "ACC1", side: "buy", filledQty: 2, status: "filled" });
    await upsertAttempt(db, { clientOrderId: "c2", positionId: PID, accountId: "ACC1", side: "sell", requestedQty: 2, status: "sending" });
    const [s] = await loadSleeves(db, PID);
    expect(s.in_flight).toBe(1);
    expect(s.remaining_qty).toBe(2);
  });

  it("keeps a declined account as a sleeve with its reason", async () => {
    await ensureSleeve(db, { positionId: PID, accountId: "ACC2", userId: "p@x.com#webull#cash" });
    await setSleeveStatus(db, { positionId: PID, accountId: "ACC2", status: "diverged", reason: DIVERGENCE.DAILY_LOSS_BUDGET });
    const sleeves = await loadSleeves(db, PID);
    const p = sleeves.find((s) => s.account_id === "ACC2");
    expect(p).toMatchObject({ opened_qty: 0, status: "diverged", divergence_reason: "daily_loss_budget" });
  });

  it("numbers attempts per sleeve leg and finds one by broker order id", async () => {
    expect(await nextAttemptNumber(db, { positionId: PID, accountId: "ACC1", seq: 2 })).toBe(1);
    await upsertAttempt(db, { clientOrderId: "c9", positionId: PID, accountId: "ACC1", seq: 2, side: "sell", brokerOrderId: "WB123", status: "working" });
    expect(await nextAttemptNumber(db, { positionId: PID, accountId: "ACC1", seq: 2 })).toBe(2);
    expect((await findAttemptByBrokerOrder(db, "WB123")).client_order_id).toBe("c9");
    expect((await findAttemptByBrokerOrder(db, "c9")).broker_order_id).toBe("WB123");
  });
});

describe("attemptStatusFromFill", () => {
  it("maps broker outcomes onto attempt states", () => {
    expect(attemptStatusFromFill({ status: "filled" })).toBe("filled");
    expect(attemptStatusFromFill({ status: "partial" })).toBe("working");
    expect(attemptStatusFromFill({ status: "working" })).toBe("working");
    expect(attemptStatusFromFill({ status: "cancelled" })).toBe("dead");
    expect(attemptStatusFromFill({ status: "filled" }, { placed: false })).toBe("rejected");
    expect(attemptStatusFromFill({ mock: true })).toBe("filled");
  });
});

describe("planSleeveConverge", () => {
  const closed = { opened_qty: 2, remaining_qty: 0 };
  const trimmed = { opened_qty: 2, remaining_qty: 1 };

  it("sells a stopped-out sleeve the broker still holds", () => {
    expect(planSleeveConverge({ model: closed, sleeve: { opened_qty: 2, remaining_qty: 2 }, held: 2 }))
      .toEqual({ action: "sell", qty: 2, target: 0 });
  });

  it("verifies a sleeve the broker shows flat", () => {
    expect(planSleeveConverge({ model: closed, sleeve: { opened_qty: 2, remaining_qty: 0 }, held: 0 }))
      .toMatchObject({ action: "verified", target: 0 });
  });

  it("trims to the mirror image and verifies once there", () => {
    expect(planSleeveConverge({ model: trimmed, sleeve: { opened_qty: 2, remaining_qty: 2 }, held: 2 }))
      .toEqual({ action: "sell", qty: 1, target: 1 });
    expect(planSleeveConverge({ model: trimmed, sleeve: { opened_qty: 2, remaining_qty: 1 }, held: 1 }))
      .toMatchObject({ action: "verified", target: 1 });
  });

  it("keeps a one-lot sleeve through a trim and says why", () => {
    expect(planSleeveConverge({ model: trimmed, sleeve: { opened_qty: 1, remaining_qty: 1 }, held: 1 }))
      .toMatchObject({ action: "verified", target: 1 });
    expect(planSleeveConverge({ model: { opened_qty: 3, remaining_qty: 1 }, sleeve: { opened_qty: 1, remaining_qty: 1 }, held: 1 }))
      .toMatchObject({ action: "verified", divergence: DIVERGENCE.INDIVISIBLE_LOT });
  });

  it("re-anchors when the holder sold on their own", () => {
    expect(planSleeveConverge({ model: closed, sleeve: { opened_qty: 2, remaining_qty: 2 }, held: 0 }))
      .toMatchObject({ action: "reanchor", external_qty: 2 });
  });

  it("never sells the holder's own contracts", () => {
    // Account holds 5; the sleeve is 2 of them. Only the sleeve's 2 go.
    expect(planSleeveConverge({ model: closed, sleeve: { opened_qty: 2, remaining_qty: 2 }, held: 5 }))
      .toEqual({ action: "sell", qty: 2, target: 0 });
  });

  it("waits while an order is in flight", () => {
    expect(planSleeveConverge({ model: closed, sleeve: { opened_qty: 2, remaining_qty: 2, in_flight: 1 }, held: 2 }))
      .toEqual({ action: "wait", reason: "order_in_flight" });
  });

  it("concludes nothing from an unreadable account", () => {
    expect(planSleeveConverge({ model: closed, sleeve: { opened_qty: 2, remaining_qty: 2 }, held: null }))
      .toEqual({ action: "unknown", reason: "holdings_unreadable" });
  });
});
