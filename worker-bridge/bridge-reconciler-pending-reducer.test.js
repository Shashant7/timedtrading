import { describe, it, expect } from "vitest";
import {
  classifyDrift,
  pendingReducerAudit,
  PENDING_REDUCER_GRACE_MS,
} from "./bridge-reconciler.js";

/**
 * 2026-08-13 — AXON 8/12 spurious "Mirror sync: 1 issue" email. A 50%
 * trim placed + filled correctly (broker went 0.18271 → 0.09136), but
 * the reconcile pass right after the trim still had the PRE-trim
 * broker_remaining_qty as "expected" (only a later pass converges it),
 * so the row classified as partial_fill (warn) and emailed. The
 * unverified last-action audit stamped at place time carries the true
 * expected_post_held_qty — within a grace window it overrides the stale
 * manifest qty.
 */

function auditJson({ kind = "trim", pre = 0.18271, intended = 0.09135, ts = Date.now(), verified = false } = {}) {
  return JSON.stringify({
    ts,
    kind,
    intended_qty: intended,
    pre_held_qty: pre,
    expected_post_held_qty: Math.max(0, pre - intended),
    verified,
  });
}

describe("pendingReducerAudit", () => {
  it("returns the audit while unverified and fresh", () => {
    const row = { sync_last_action_json: auditJson({}) };
    const a = pendingReducerAudit(row);
    expect(a).toBeTruthy();
    expect(a.expected_post_held_qty).toBeCloseTo(0.09136, 4);
  });

  it("returns null once verified", () => {
    const row = { sync_last_action_json: auditJson({ verified: true }) };
    expect(pendingReducerAudit(row)).toBeNull();
  });

  it("returns null past the grace window (stuck order must alert normally)", () => {
    const row = { sync_last_action_json: auditJson({ ts: Date.now() - PENDING_REDUCER_GRACE_MS - 1000 }) };
    expect(pendingReducerAudit(row)).toBeNull();
  });
});

describe("classifyDrift with a reducer in flight", () => {
  const baseRow = {
    model_status: "OPEN",
    model_intended_qty: 0.18271,
    broker_remaining_qty: 0.18271, // stale pre-trim value
    sync_state: "in_sync",
    ticker: "AXON",
  };

  it("AXON case: filled trim classifies in_sync, not partial_fill", () => {
    const audit = pendingReducerAudit({ sync_last_action_json: auditJson({}) });
    const out = classifyDrift(baseRow, { qty: 0.09136, avgCost: 800 }, {
      tolerance: 0.01,
      pending_reducer: audit,
    });
    expect(out.sync_state).toBe("in_sync");
    expect(out.drift_detected).toBe(false);
  });

  it("without the audit the same inputs still flag partial_fill (regression guard)", () => {
    const out = classifyDrift(baseRow, { qty: 0.09136, avgCost: 800 }, { tolerance: 0.01 });
    expect(out.sync_state).toBe("partial_fill");
    expect(out.drift_detected).toBe(true);
  });

  it("trim not yet filled: no user_added excess recorded (fill masking guard)", () => {
    const audit = pendingReducerAudit({ sync_last_action_json: auditJson({}) });
    const out = classifyDrift(baseRow, { qty: 0.18271, avgCost: 800 }, {
      tolerance: 0.01,
      pending_reducer: audit,
    });
    expect(out.drift_detected).toBe(false);
    expect(out.broker_state.user_added).toBeUndefined();
    expect(out.broker_state.reducer_in_flight).toBe(true);
  });

  it("real partial fill still alerts even with a pending audit", () => {
    const audit = pendingReducerAudit({ sync_last_action_json: auditJson({}) });
    // Broker holds LESS than the post-trim expected → genuine gap.
    const out = classifyDrift(baseRow, { qty: 0.03, avgCost: 800 }, {
      tolerance: 0.01,
      pending_reducer: audit,
    });
    expect(out.sync_state).toBe("partial_fill");
    expect(out.drift_detected).toBe(true);
  });

  it("exit in flight on a CLOSED row is not a broker_orphan", () => {
    const closedRow = {
      ...baseRow,
      model_status: "CLOSED",
      sync_state: "in_sync",
    };
    const audit = pendingReducerAudit({
      sync_last_action_json: auditJson({ kind: "exit", pre: 0.18271, intended: 0.18271 }),
    });
    const out = classifyDrift(closedRow, { qty: 0.18271, avgCost: 800 }, {
      tolerance: 0.01,
      pending_reducer: audit,
    });
    expect(out.drift_detected).toBe(false);
    expect(out.sync_state).not.toBe("broker_orphan");
  });

  it("CLOSED row with no pending audit still flags broker_orphan", () => {
    const closedRow = { ...baseRow, model_status: "CLOSED" };
    const out = classifyDrift(closedRow, { qty: 0.18271, avgCost: 800 }, { tolerance: 0.01 });
    expect(out.sync_state).toBe("broker_orphan");
    expect(out.drift_detected).toBe(true);
  });
});
