/**
 * HOOD 2026-09-22 — a sibling lot's sale read as this lot's partial fill.
 *
 * Two investor rows sat on one Webull account (LJJ84GKUVIVG998B8DO3069DKA):
 *
 *   inv-HOOD-auto-1788458617249  CLOSED, mirror_suppressed=1, residual 0.69144
 *   inv-HOOD-auto-1790086478840  OPEN,   broker_remaining_qty 16
 *
 * The broker reports one HOOD position for the account, so both rows read
 * the same number and their claims overlapped by the residual. At 19:07 the
 * closed lot's exit catch-up sold its 0.69144 (audit: pre_held 16 ->
 * expected_post 15.30856). At 19:31 the open lot compared the live 15.30856
 * against its own stale 16 and mailed "partial: broker 15.30856 < expected
 * 16 (diff 0.69)". By 22:41 it had converged to 15.30856 with no action
 * taken, which is the tell: there was never anything to fix.
 *
 * The seller was CLOSED *and* suppressed, so the reconcile scan and the OPEN
 * claim map both filtered it out. Only its last-action audit knew.
 *
 * Quantities below are copied verbatim from production D1.
 */
import { describe, it, expect } from "vitest";
import {
  classifyDrift,
  siblingReducerInFlightQty,
  PENDING_REDUCER_GRACE_MS,
} from "./bridge-reconciler.js";

const ACCT = "LJJ84GKUVIVG998B8DO3069DKA";
const USER = "shashant@gmail.com";
const EXIT_TS = 1790104068344;   // closed lot's exit placed
const DRIFT_TS = 1790105492901;  // open lot's reconcile pass that emailed
const TOL = 0.1;                 // TOLERANCE.investor_equity_abs

/** The CLOSED + suppressed lot, mid-sale. */
const sellerRow = {
  user_id: USER,
  trade_id: "inv-HOOD-auto-1788458617249",
  broker_account_id: ACCT,
  ticker: "HOOD",
  sync_last_action_json: JSON.stringify({
    ts: EXIT_TS,
    kind: "exit",
    intended_qty: 0.69144,
    pre_held_qty: 16,
    expected_post_held_qty: 15.30856,
    client_order_id: "ttex8530379336d99b1de3b8",
    broker_order_id: "5HHCHG6I19QK15O0ELP824LA3A",
    verified: false,
    verified_at: null,
  }),
};

/** The OPEN lot that got the email. */
const openRow = {
  user_id: USER,
  trade_id: "inv-HOOD-auto-1790086478840",
  broker_account_id: ACCT,
  ticker: "HOOD",
  mode: "investor",
  instrument_type: "equity",
  model_status: "OPEN",
  model_intended_qty: 8,
  broker_remaining_qty: 16,
};

describe("siblingReducerInFlightQty", () => {
  it("sees the suppressed, CLOSED lot's in-flight exit", () => {
    expect(siblingReducerInFlightQty(openRow, [sellerRow], DRIFT_TS))
      .toBeCloseTo(0.69144, 5);
  });

  it("does not count the row's own audit", () => {
    const self = { ...openRow, sync_last_action_json: sellerRow.sync_last_action_json };
    expect(siblingReducerInFlightQty(self, [self], DRIFT_TS)).toBe(0);
  });

  it("ignores another ticker on the same account", () => {
    const other = { ...sellerRow, ticker: "EXEL" };
    expect(siblingReducerInFlightQty(openRow, [other], DRIFT_TS)).toBe(0);
  });

  it("ignores the same ticker on a different account", () => {
    const other = { ...sellerRow, broker_account_id: "9QHQ6RKN0POS4JU54D4TJTKH98" };
    expect(siblingReducerInFlightQty(openRow, [other], DRIFT_TS)).toBe(0);
  });

  it("ignores an audit already verified", () => {
    const done = {
      ...sellerRow,
      sync_last_action_json: JSON.stringify({
        ...JSON.parse(sellerRow.sync_last_action_json), verified: true,
      }),
    };
    expect(siblingReducerInFlightQty(openRow, [done], DRIFT_TS)).toBe(0);
  });

  it("ignores an audit past the grace window", () => {
    const late = EXIT_TS + PENDING_REDUCER_GRACE_MS + 1;
    expect(siblingReducerInFlightQty(openRow, [sellerRow], late)).toBe(0);
  });

  it("ignores a sibling ENTRY — a buy does not remove shares", () => {
    const buy = {
      ...sellerRow,
      sync_last_action_json: JSON.stringify({
        ...JSON.parse(sellerRow.sync_last_action_json), kind: "entry",
      }),
    };
    expect(siblingReducerInFlightQty(openRow, [buy], DRIFT_TS)).toBe(0);
  });

  it("derives the qty from pre_held - expected_post when intended is absent", () => {
    const noIntended = JSON.parse(sellerRow.sync_last_action_json);
    delete noIntended.intended_qty;
    const row = { ...sellerRow, sync_last_action_json: JSON.stringify(noIntended) };
    expect(siblingReducerInFlightQty(openRow, [row], DRIFT_TS)).toBeCloseTo(0.69144, 5);
  });

  it("sums several lots selling the same ticker at once", () => {
    const second = {
      ...sellerRow,
      trade_id: "inv-HOOD-auto-other",
      sync_last_action_json: JSON.stringify({
        ...JSON.parse(sellerRow.sync_last_action_json), intended_qty: 1.5,
      }),
    };
    expect(siblingReducerInFlightQty(openRow, [sellerRow, second], DRIFT_TS))
      .toBeCloseTo(2.19144, 5);
  });
});

describe("classifyDrift — the 19:31 pass", () => {
  const live = { qty: 15.30856, avgCost: 124.42 };

  it("without the sibling audit it still mails the false partial (the bug)", () => {
    const out = classifyDrift(openRow, live, { tolerance: TOL });
    expect(out.sync_state).toBe("partial_fill");
    expect(out.drift_detected).toBe(true);
    expect(out.severity).toBe("warn");
    expect(out.note).toBe("partial: broker 15.30856 < expected 16 (diff 0.69)");
  });

  it("with it, the gap is the other lot's sale and nothing is reported", () => {
    const out = classifyDrift(openRow, live, {
      tolerance: TOL,
      sibling_reducer_qty: siblingReducerInFlightQty(openRow, [sellerRow], DRIFT_TS),
    });
    expect(out.sync_state).toBe("in_sync");
    expect(out.drift_detected).toBe(false);
    expect(out.severity).toBe("info");
    expect(out.note).toMatch(/sibling reducer in flight/);
  });

  it("converges broker_remaining_qty on the live qty, as the 22:41 pass did", () => {
    const out = classifyDrift(openRow, live, {
      tolerance: TOL, sibling_reducer_qty: 0.69144,
    });
    expect(out.broker_state.qty).toBeCloseTo(15.30856, 5);
    expect(out.broker_state.expected).toBeCloseTo(15.30856, 5);
  });

  it("a shortfall BIGGER than the sibling's sale is still a real partial", () => {
    const out = classifyDrift(openRow, { qty: 11, avgCost: 124.42 }, {
      tolerance: TOL, sibling_reducer_qty: 0.69144,
    });
    expect(out.sync_state).toBe("partial_fill");
    expect(out.drift_detected).toBe(true);
  });

  it("a shortfall with no sibling selling is still a real partial", () => {
    const out = classifyDrift(openRow, live, { tolerance: TOL, sibling_reducer_qty: 0 });
    expect(out.sync_state).toBe("partial_fill");
  });

  it("the other Webull account on the same exit never drifted — still in_sync", () => {
    // shahpritesh206: account held 10.55515, the closed lot sold its 0.55515
    // and the open lot's expected of 10 was already right.
    const priteshOpen = {
      ...openRow,
      user_id: "shahpritesh206@gmail.com#webull#individual-cash",
      broker_account_id: "9QHQ6RKN0POS4JU54D4TJTKH98",
      model_intended_qty: 5,
      broker_remaining_qty: 10,
    };
    const out = classifyDrift(priteshOpen, { qty: 10, avgCost: 124.42 }, { tolerance: TOL });
    expect(out.sync_state).toBe("in_sync");
    expect(out.drift_detected).toBe(false);
  });
});
