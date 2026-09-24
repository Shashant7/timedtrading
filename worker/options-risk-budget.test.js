// worker/options-risk-budget.test.js
//
// 2026-09-23 — one daily loss limit in dollars, replacing the count caps.
//
// The count caps did not limit loss, they limited activity, and they
// limited it to zero: two limit buys that never filled spent the whole
// 2/day `long_put` allowance 74 seconds after the open. "Two trades" says
// nothing about money — two $500 tickets and two $60 tickets look the same
// to it.
//
// What these tests pin is that the budget behaves like a stop-loss and not
// like a trade counter:
//   - a winning day does not throttle itself
//   - a losing day tightens until it stops
//   - an order that never became a position costs nothing
//   - commit and release are idempotent, because the bug being replaced was
//     a counter that could only ever go up
import { describe, it, expect } from "vitest";
import {
  DEFAULT_DAILY_LOSS_LIMIT_USD,
  RISK_STATE_KEY,
  loadRiskState,
  riskBudgetSnapshot,
  riskBudgetHasRoom,
  commitRisk,
  releaseRisk,
  settleRisk,
  optionDebitUsd,
  optionStopRiskUsd,
  stopFractionFromPct,
  DEFAULT_STOP_FRACTION,
  dailyLossLimitFor,
  tradingDayOf,
  reconcileRiskBudget,
} from "./options-risk-budget.js";
import { HARD_STOP_PCT } from "./option-day-trade-plan.js";

const OP = "op@x.com";
const NOW = Date.parse("2026-09-23T17:46:23Z");
const DATE = "2026-09-23";

function kvMock(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    get: async (k) => (store.has(k) ? store.get(k) : null),
    put: async (k, v) => { store.set(k, v); },
  };
}
const envOf = (kv) => ({ KV_TIMED: kv });
const stateIn = (kv) => JSON.parse(kv.store.get(RISK_STATE_KEY(OP, DATE)) || "null");

describe("optionDebitUsd — the debit IS the max loss", () => {
  it("prices a ticket at premium x 100 x contracts", () => {
    expect(optionDebitUsd(0.59, 2)).toBe(118);
    expect(optionDebitUsd(4.42, 1)).toBe(442);
  });

  it("is zero for a missing or nonsense price", () => {
    expect(optionDebitUsd(0, 2)).toBe(0);
    expect(optionDebitUsd(null, 2)).toBe(0);
    expect(optionDebitUsd(1.0, 0)).toBe(0);
    expect(optionDebitUsd("abc", 2)).toBe(0);
  });
});

describe("optionStopRiskUsd — the budget is charged the stop, not the ticket", () => {
  it("tracks the hard stop the desk actually commits to", () => {
    // If these drift apart the budget starts pricing a risk the doctrine
    // does not take.
    expect(DEFAULT_STOP_FRACTION).toBe(Math.abs(HARD_STOP_PCT) / 100);
  });

  it("charges half the debit at the house stop", () => {
    expect(optionStopRiskUsd(0.59, 2)).toBe(59);
    expect(optionStopRiskUsd(1.13, 3)).toBe(169.5);
  });

  it("never charges more than the ticket, however wide the stop", () => {
    expect(optionStopRiskUsd(1.0, 1, { stopFraction: 2.5 })).toBe(100);
    expect(optionStopRiskUsd(1.0, 1, { stopFraction: 1 })).toBe(100);
  });

  it("falls back to the house stop on a nonsense fraction", () => {
    expect(optionStopRiskUsd(1.0, 1, { stopFraction: 0 })).toBe(50);
    expect(optionStopRiskUsd(1.0, 1, { stopFraction: -0.4 })).toBe(50);
    expect(optionStopRiskUsd(1.0, 1, { stopFraction: "wide" })).toBe(50);
  });

  it("is zero whenever the debit is", () => {
    expect(optionStopRiskUsd(0, 3)).toBe(0);
    expect(optionStopRiskUsd(1.0, 0)).toBe(0);
  });

  it("reads a play's own negative stop percentage", () => {
    expect(stopFractionFromPct(-50)).toBe(0.5);
    expect(stopFractionFromPct(-35)).toBe(0.35);
    expect(stopFractionFromPct(-140)).toBe(1);
    expect(stopFractionFromPct(null)).toBe(DEFAULT_STOP_FRACTION);
    expect(stopFractionFromPct(0)).toBe(DEFAULT_STOP_FRACTION);
  });
});

describe("dailyLossLimitFor", () => {
  it("is the operator's $500, sized against the house 3-contract lot", () => {
    expect(DEFAULT_DAILY_LOSS_LIMIT_USD).toBe(500);
    // Three contracts of a typical $1.00 index put: $300 debit, $150 of stop
    // risk. Three can be on at once, and several can be wrong.
    expect(Math.floor(DEFAULT_DAILY_LOSS_LIMIT_USD / optionStopRiskUsd(1.0, 3))).toBe(3);
  });

  it("defaults when the operator has not set one", () => {
    expect(dailyLossLimitFor({})).toBe(DEFAULT_DAILY_LOSS_LIMIT_USD);
    expect(dailyLossLimitFor(null)).toBe(DEFAULT_DAILY_LOSS_LIMIT_USD);
  });

  it("honours an explicit zero as 'no limit at all'", () => {
    expect(dailyLossLimitFor({ daily_loss_limit_usd: 0 })).toBe(0);
  });

  it("takes an operator value verbatim", () => {
    expect(dailyLossLimitFor({ daily_loss_limit_usd: 250 })).toBe(250);
  });

  it("falls back rather than trusting a negative or unparseable value", () => {
    expect(dailyLossLimitFor({ daily_loss_limit_usd: -5 })).toBe(DEFAULT_DAILY_LOSS_LIMIT_USD);
    expect(dailyLossLimitFor({ daily_loss_limit_usd: "lots" })).toBe(DEFAULT_DAILY_LOSS_LIMIT_USD);
  });
});

describe("riskBudgetSnapshot", () => {
  it("counts open risk and realised losses, not trade count", () => {
    const s = {
      date: DATE,
      realized_pnl_usd: -150,
      open: { a: { usd: 118 }, b: { usd: 232 } },
    };
    const snap = riskBudgetSnapshot(s, 1000);
    expect(snap.open_usd).toBe(350);
    expect(snap.open_count).toBe(2);
    expect(snap.realized_loss_usd).toBe(150);
    expect(snap.consumed_usd).toBe(500);
    expect(snap.remaining_usd).toBe(500);
  });

  it("does not let a winning day raise its own ceiling", () => {
    // Up $400 with nothing open. The allowance is the limit, not limit+400.
    const snap = riskBudgetSnapshot({ realized_pnl_usd: 400, open: {} }, 1000);
    expect(snap.realized_loss_usd).toBe(0);
    expect(snap.consumed_usd).toBe(0);
    expect(snap.remaining_usd).toBe(1000);
  });

  it("reports unenforced when the limit is zero", () => {
    const snap = riskBudgetSnapshot({ realized_pnl_usd: -900, open: {} }, 0);
    expect(snap.enforced).toBe(false);
    expect(snap.remaining_usd).toBe(null);
  });
});

describe("riskBudgetHasRoom", () => {
  it("lets a ticket through when the day can still afford it", async () => {
    const kv = kvMock();
    const r = await riskBudgetHasRoom(envOf(kv), OP, { riskUsd: 118, limitUsd: 1000, now: NOW });
    expect(r.ok).toBe(true);
  });

  it("refuses the ticket that would breach the limit, and says by how much", async () => {
    const kv = kvMock();
    await commitRisk(envOf(kv), OP, "a", { usd: 900, now: NOW });
    const r = await riskBudgetHasRoom(envOf(kv), OP, { riskUsd: 200, limitUsd: 1000, now: NOW });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("daily_loss_budget_100_left_of_1000_needs_200");
    expect(r.budget.remaining_usd).toBe(100);
  });

  it("allows a ticket that exactly spends the rest", async () => {
    const kv = kvMock();
    await commitRisk(envOf(kv), OP, "a", { usd: 900, now: NOW });
    const r = await riskBudgetHasRoom(envOf(kv), OP, { riskUsd: 100, limitUsd: 1000, now: NOW });
    expect(r.ok).toBe(true);
  });

  it("never blocks when the limit is 0", async () => {
    const kv = kvMock();
    await commitRisk(envOf(kv), OP, "a", { usd: 99999, now: NOW });
    const r = await riskBudgetHasRoom(envOf(kv), OP, { riskUsd: 5000, limitUsd: 0, now: NOW });
    expect(r.ok).toBe(true);
  });

  it("does not count trades — ten small tickets fit where two big ones do not", async () => {
    const kv = kvMock();
    for (let i = 0; i < 10; i++) {
      const r = await riskBudgetHasRoom(envOf(kv), OP, { riskUsd: 60, limitUsd: 1000, now: NOW });
      expect(r.ok).toBe(true);
      await commitRisk(envOf(kv), OP, `s${i}`, { usd: 60, now: NOW });
    }
    expect(riskBudgetSnapshot(await loadRiskState(envOf(kv), OP, NOW), 1000).open_count).toBe(10);
    // …and the eleventh still fits, because $600 of $1000 is spent.
    expect((await riskBudgetHasRoom(envOf(kv), OP, { riskUsd: 400, limitUsd: 1000, now: NOW })).ok).toBe(true);
    expect((await riskBudgetHasRoom(envOf(kv), OP, { riskUsd: 401, limitUsd: 1000, now: NOW })).ok).toBe(false);
  });
});

describe("commit / release are idempotent by signal id", () => {
  it("commits by assignment, so a replay is not a double charge", async () => {
    const kv = kvMock();
    await commitRisk(envOf(kv), OP, "sig", { usd: 118, now: NOW });
    await commitRisk(envOf(kv), OP, "sig", { usd: 118, now: NOW });
    await commitRisk(envOf(kv), OP, "sig", { usd: 118, now: NOW });
    expect(riskBudgetSnapshot(stateIn(kv), 1000).open_usd).toBe(118);
  });

  it("releases by delete, so a replay is not a double refund", async () => {
    const kv = kvMock();
    await commitRisk(envOf(kv), OP, "sig", { usd: 118, now: NOW });
    await commitRisk(envOf(kv), OP, "other", { usd: 200, now: NOW });
    await releaseRisk(envOf(kv), OP, "sig", { now: NOW });
    await releaseRisk(envOf(kv), OP, "sig", { now: NOW });
    const snap = riskBudgetSnapshot(stateIn(kv), 1000);
    expect(snap.open_usd).toBe(200);
    expect(snap.open_count).toBe(1);
  });

  it("releasing something that was never committed changes nothing", async () => {
    const kv = kvMock();
    await commitRisk(envOf(kv), OP, "sig", { usd: 118, now: NOW });
    await releaseRisk(envOf(kv), OP, "ghost", { now: NOW });
    expect(riskBudgetSnapshot(stateIn(kv), 1000).open_usd).toBe(118);
  });

  it("an order that never became a position costs the day nothing", async () => {
    // This is the 2026-09-23 case: placed, never filled, cancelled.
    const kv = kvMock();
    await commitRisk(envOf(kv), OP, "dt:SPY:768P", { usd: 118, now: NOW });
    expect(riskBudgetSnapshot(stateIn(kv), 1000).remaining_usd).toBe(882);
    await releaseRisk(envOf(kv), OP, "dt:SPY:768P", { now: NOW });
    const snap = riskBudgetSnapshot(stateIn(kv), 1000);
    expect(snap.remaining_usd).toBe(1000);
    expect(snap.realized_pnl_usd).toBe(0);
  });
});

describe("re-entry on the same plan is a new trade, not a replay", () => {
  it("charges the second round after the first has closed", async () => {
    const kv = kvMock();
    await commitRisk(envOf(kv), OP, "dt:SPY:766P", { usd: 111, orderId: "A", now: NOW });
    await settleRisk(envOf(kv), OP, "dt:SPY:766P", { realizedUsd: -27, remainingRiskUsd: 0, now: NOW });
    expect(riskBudgetSnapshot(stateIn(kv), 1000).open_usd).toBe(0);

    await commitRisk(envOf(kv), OP, "dt:SPY:766P", { usd: 120, orderId: "B", now: NOW });
    const snap = riskBudgetSnapshot(stateIn(kv), 1000);
    expect(snap.open_usd).toBe(120);
    expect(snap.realized_loss_usd).toBe(27); // the first round still counts
    expect(snap.consumed_usd).toBe(147);
    expect(snap.placed_count).toBe(2);
  });

  it("still dedupes a replayed place — same order id, one round", async () => {
    const kv = kvMock();
    await commitRisk(envOf(kv), OP, "dt:SPY:766P", { usd: 111, orderId: "A", now: NOW });
    await commitRisk(envOf(kv), OP, "dt:SPY:766P", { usd: 111, orderId: "A", now: NOW });
    const snap = riskBudgetSnapshot(stateIn(kv), 1000);
    expect(snap.open_usd).toBe(111);
    expect(snap.placed_count).toBe(1);
  });

  it("dedupes a replay with no order id while the position is still open", async () => {
    const kv = kvMock();
    await commitRisk(envOf(kv), OP, "dt:SPY:766P", { usd: 111, now: NOW });
    await commitRisk(envOf(kv), OP, "dt:SPY:766P", { usd: 111, now: NOW });
    expect(riskBudgetSnapshot(stateIn(kv), 1000).placed_count).toBe(1);
  });

  it("keeps counting across a deploy that changed the stored shape", async () => {
    // States written before 2026-09-24 held bare signal ids.
    const kv = kvMock({
      [RISK_STATE_KEY(OP, DATE)]: JSON.stringify({
        date: DATE, realized_pnl_usd: 0, open: {}, placed: ["dt:QQQ:741P"],
      }),
    });
    await commitRisk(envOf(kv), OP, "dt:SPY:768P", { usd: 59, orderId: "B", now: NOW });
    expect(riskBudgetSnapshot(stateIn(kv), 1000).placed_count).toBe(2);
  });
});

describe("settleRisk — open risk becomes realised P&L", () => {
  it("a full loss converts the whole debit into realised loss", async () => {
    const kv = kvMock();
    await commitRisk(envOf(kv), OP, "sig", { usd: 118, now: NOW });
    await settleRisk(envOf(kv), OP, "sig", { realizedUsd: -118, remainingRiskUsd: 0, now: NOW });
    const snap = riskBudgetSnapshot(stateIn(kv), 1000);
    expect(snap.open_usd).toBe(0);
    expect(snap.realized_loss_usd).toBe(118);
    expect(snap.consumed_usd).toBe(118);
  });

  it("a win gives the allowance back", async () => {
    const kv = kvMock();
    await commitRisk(envOf(kv), OP, "sig", { usd: 118, now: NOW });
    await settleRisk(envOf(kv), OP, "sig", { realizedUsd: 82, remainingRiskUsd: 0, now: NOW });
    const snap = riskBudgetSnapshot(stateIn(kv), 1000);
    expect(snap.consumed_usd).toBe(0);
    expect(snap.remaining_usd).toBe(1000);
  });

  it("a trim keeps the unsold half on the books at its original basis", async () => {
    const kv = kvMock();
    await commitRisk(envOf(kv), OP, "sig", { usd: 236, now: NOW }); // 2 lots @ $1.18
    await settleRisk(envOf(kv), OP, "sig", { realizedUsd: 40, remainingRiskUsd: 118, now: NOW });
    const snap = riskBudgetSnapshot(stateIn(kv), 1000);
    expect(snap.open_usd).toBe(118);
    expect(snap.realized_pnl_usd).toBe(40);
    expect(snap.consumed_usd).toBe(118);
  });

  it("losses accumulate across trades until the day stops itself", async () => {
    const kv = kvMock();
    const env = envOf(kv);
    for (let i = 0; i < 3; i++) {
      await commitRisk(env, OP, `s${i}`, { usd: 300, now: NOW });
      await settleRisk(env, OP, `s${i}`, { realizedUsd: -300, remainingRiskUsd: 0, now: NOW });
    }
    const snap = riskBudgetSnapshot(stateIn(kv), 1000);
    expect(snap.realized_loss_usd).toBe(900);
    expect(snap.remaining_usd).toBe(100);
    expect((await riskBudgetHasRoom(env, OP, { riskUsd: 300, limitUsd: 1000, now: NOW })).ok).toBe(false);
  });

  it("a green day keeps trading — the same three trades, won", async () => {
    const kv = kvMock();
    const env = envOf(kv);
    for (let i = 0; i < 3; i++) {
      await commitRisk(env, OP, `s${i}`, { usd: 300, now: NOW });
      await settleRisk(env, OP, `s${i}`, { realizedUsd: 150, remainingRiskUsd: 0, now: NOW });
    }
    expect((await riskBudgetHasRoom(env, OP, { riskUsd: 300, limitUsd: 1000, now: NOW })).ok).toBe(true);
  });
});

describe("state handling", () => {
  it("is scoped to the day, so yesterday's losses do not block today", async () => {
    const kv = kvMock();
    const yesterday = Date.parse("2026-09-22T17:00:00Z");
    await commitRisk(envOf(kv), OP, "sig", { usd: 900, now: yesterday });
    const r = await riskBudgetHasRoom(envOf(kv), OP, { riskUsd: 900, limitUsd: 1000, now: NOW });
    expect(r.ok).toBe(true);
  });

  it("treats corrupt state as an empty day rather than throwing", async () => {
    const kv = kvMock({ [RISK_STATE_KEY(OP, DATE)]: "{not json" });
    const s = await loadRiskState(envOf(kv), OP, NOW);
    expect(s.open).toEqual({});
    expect(s.realized_pnl_usd).toBe(0);
  });

  it("is a no-op without KV or an operator", async () => {
    expect(await commitRisk({}, OP, "sig", { usd: 100 })).toBe(null);
    expect(await releaseRisk({ KV_TIMED: kvMock() }, "", "sig")).toBe(null);
    expect(await settleRisk({ KV_TIMED: kvMock() }, OP, "")).toBe(null);
  });
});

describe("the budget's day is New York's, not UTC's", () => {
  // A UTC key rolls at 20:00 ET. The evening reconcile is still settling
  // the session then, so a loss booked at 20:05 ET would have landed on
  // tomorrow's budget and an overnight hold's open risk would have simply
  // disappeared from the ledger.
  const EVENING = Date.parse("2026-09-24T00:10:00Z"); // 20:10 ET, 23 Sep

  it("still calls 20:10 ET the 23rd", () => {
    expect(new Date(EVENING).toISOString().slice(0, 10)).toBe("2026-09-24");
    expect(tradingDayOf(EVENING)).toBe("2026-09-23");
  });

  it("keeps the evening on the same ledger as the session", async () => {
    const kv = kvMock();
    await commitRisk(envOf(kv), OP, "sig", { usd: 400, now: NOW });
    await settleRisk(envOf(kv), OP, "sig", { realizedUsd: -400, remainingRiskUsd: 0, now: EVENING });
    const snap = riskBudgetSnapshot(stateIn(kv), 500);
    expect(snap.realized_loss_usd).toBe(400);
    expect(snap.open_usd).toBe(0);
    // And the next entry attempt that evening is still gated by it.
    expect((await riskBudgetHasRoom(envOf(kv), OP, { riskUsd: 150, limitUsd: 500, now: EVENING })).ok).toBe(false);
  });

  it("rolls at the New York midnight instead", () => {
    expect(tradingDayOf(Date.parse("2026-09-24T03:59:00Z"))).toBe("2026-09-23");
    expect(tradingDayOf(Date.parse("2026-09-24T04:01:00Z"))).toBe("2026-09-24");
  });
});

describe("reconcileRiskBudget — the ledger is rebuilt from the mirrors", () => {
  // Commit and release are each idempotent, but idempotency only protects
  // an operation that RUNS. A release that never ran leaves the day paying
  // for a position that does not exist, forever — the same one-way failure
  // the counter this module replaced had. So the ledger has to be
  // reconstructible from ground truth.
  const mirrors = (map) => async (_env, sid) => map[sid] ?? null;

  it("frees a charge whose order never became a position", async () => {
    const kv = kvMock();
    await commitRisk(envOf(kv), OP, "dt:SPY:768P", { usd: 118, now: NOW });
    const r = await reconcileRiskBudget(envOf(kv), OP, {
      loadMirror: mirrors({}), now: NOW, limitUsd: 500,
    });
    expect(r.freed).toBe(1);
    expect(r.freedUsd).toBe(118);
    expect(riskBudgetSnapshot(stateIn(kv), 500).open_usd).toBe(0);
    expect(r.snapshot.remaining_usd).toBe(500);
  });

  it("frees a charge whose mirror says the entry was never filled or placed", async () => {
    const kv = kvMock();
    await commitRisk(envOf(kv), OP, "dt:SPY:768P", { usd: 118, now: NOW });
    const r = await reconcileRiskBudget(envOf(kv), OP, {
      loadMirror: mirrors({ "dt:SPY:768P": { entry_fired: false, entry_placed: false } }),
      now: NOW,
    });
    expect(r.freed).toBe(1);
    expect(riskBudgetSnapshot(stateIn(kv), 500).open_count).toBe(0);
  });

  it("leaves a working order alone — it is real exposure", async () => {
    const kv = kvMock();
    await commitRisk(envOf(kv), OP, "dt:SPY:768P", { usd: 118, now: NOW });
    const r = await reconcileRiskBudget(envOf(kv), OP, {
      loadMirror: mirrors({ "dt:SPY:768P": { entry_pending: true } }),
      now: NOW,
    });
    expect(r.freed).toBe(0);
    expect(riskBudgetSnapshot(stateIn(kv), 500).open_usd).toBe(118);
  });

  it("re-prices a held position down to what is actually still held", async () => {
    // Charged for 3 lots, a trim the settle path missed left 1.
    const kv = kvMock();
    await commitRisk(envOf(kv), OP, "dt:IWM:281P", { usd: 169.5, now: NOW });
    const r = await reconcileRiskBudget(envOf(kv), OP, {
      loadMirror: mirrors({
        "dt:IWM:281P": {
          entry_fired: true, contracts_remaining: 1, entry_premium: 1.13, entry_stop_fraction: 0.5,
        },
      }),
      now: NOW,
    });
    expect(r.repriced).toBe(1);
    expect(r.freedUsd).toBe(113);
    expect(riskBudgetSnapshot(stateIn(kv), 500).open_usd).toBe(56.5);
  });

  it("does not rewrite a charge that already matches", async () => {
    const kv = kvMock();
    await commitRisk(envOf(kv), OP, "dt:IWM:281P", { usd: 169.5, now: NOW });
    const r = await reconcileRiskBudget(envOf(kv), OP, {
      loadMirror: mirrors({
        "dt:IWM:281P": { entry_fired: true, contracts_remaining: 3, entry_premium: 1.13 },
      }),
      now: NOW,
    });
    expect(r.repriced).toBe(0);
    expect(r.freed).toBe(0);
  });

  it("will NOT drop a position that was owned and is now flat", async () => {
    // From here it cannot tell whether settleRisk already booked the P&L.
    // Dropping it could erase a realised loss and loosen the budget, so it
    // fails restrictive and reports drift instead of guessing.
    const kv = kvMock();
    await commitRisk(envOf(kv), OP, "dt:QQQ:737P", { usd: 118, now: NOW });
    const r = await reconcileRiskBudget(envOf(kv), OP, {
      loadMirror: mirrors({ "dt:QQQ:737P": { entry_fired: true, contracts_remaining: 0 } }),
      now: NOW,
    });
    expect(r.drift).toBe(1);
    expect(r.driftSignals).toEqual(["dt:QQQ:737P"]);
    expect(r.freed).toBe(0);
    expect(riskBudgetSnapshot(stateIn(kv), 500).open_usd).toBe(118);
  });

  it("keeps the charge when the mirror cannot be read at all", async () => {
    const kv = kvMock();
    await commitRisk(envOf(kv), OP, "dt:SPY:768P", { usd: 118, now: NOW });
    const r = await reconcileRiskBudget(envOf(kv), OP, {
      loadMirror: async () => { throw new Error("kv down"); },
      now: NOW,
    });
    expect(r.freed).toBe(0);
    expect(riskBudgetSnapshot(stateIn(kv), 500).open_usd).toBe(118);
  });

  it("unwedges the day so the next entry can be taken", async () => {
    // The whole point: $500 spent on three orders that never filled is a
    // lane that cannot trade again until midnight.
    const kv = kvMock();
    const env = envOf(kv);
    for (const s of ["a", "b", "c"]) await commitRisk(env, OP, s, { usd: 170, now: NOW });
    expect((await riskBudgetHasRoom(env, OP, { riskUsd: 150, limitUsd: 500, now: NOW })).ok).toBe(false);

    await reconcileRiskBudget(env, OP, { loadMirror: mirrors({}), now: NOW, limitUsd: 500 });
    expect((await riskBudgetHasRoom(env, OP, { riskUsd: 150, limitUsd: 500, now: NOW })).ok).toBe(true);
  });

  it("reports an exhausted budget even with nothing open to repair", async () => {
    // Spent entirely on realised losses. Nothing to fix, but the lane has
    // stopped trading and that is what the cron pages on.
    const kv = kvMock();
    await commitRisk(envOf(kv), OP, "s", { usd: 500, now: NOW });
    await settleRisk(envOf(kv), OP, "s", { realizedUsd: -500, remainingRiskUsd: 0, now: NOW });
    const r = await reconcileRiskBudget(envOf(kv), OP, {
      loadMirror: mirrors({}), now: NOW, limitUsd: 500,
    });
    expect(r.checked).toBe(0);
    expect(r.snapshot.remaining_usd).toBe(0);
    expect(r.snapshot.enforced).toBe(true);
  });

  it("is a no-op without KV, an operator, or a mirror reader", async () => {
    const none = { checked: 0, freed: 0, repriced: 0, freedUsd: 0, drift: 0, driftSignals: [], snapshot: null };
    expect(await reconcileRiskBudget({}, OP, { loadMirror: mirrors({}) })).toEqual(none);
    expect(await reconcileRiskBudget(envOf(kvMock()), "", { loadMirror: mirrors({}) })).toEqual(none);
    expect(await reconcileRiskBudget(envOf(kvMock()), OP, {})).toEqual(none);
  });
});
