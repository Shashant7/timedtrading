// worker-bridge/bridge-post-exec-resolution.test.js
//
// 2026-09-22 — Retire post-execution expectations that can never come true.
//
// The post-exec audit keeps `verified:false` on purpose so a drift can
// still heal on a later pass, and `POST_EXEC_DRIFT_REPEAT_MS` throttles
// the re-report to once every 6h. For a drift that CAN heal that is the
// right trade. For one that cannot, 6h is just a slower forever:
//
//   LLY  inv-LLY-auto-1787068954740 — trim 2026-09-18 on a 0.0556 sh
//        (~$40) investor sleeve, meant to keep 0.051 sh, broker went to 0.
//   DE   DE-1787252853209-e3325t0lf — trim 2026-08-21 meant to keep
//        2.0427 sh; a catch-up exit closed the whole trade on 09-14.
//
// Both rows reconciled as `in_sync` ("model_closed and broker flat —
// consistent"), and both still paged CRITICAL Execution Drift daily,
// because the notification path overrides sync_state with
// "execution_drift" and so bypasses the healthy-state guard in
// shouldDispatchDriftNotification.

import { describe, it, expect } from "vitest";
import {
  classifyPostExecHeldDrift,
  isUnverifiedReducerLeftover,
  pendingReducerAudit,
  reconcileUser,
} from "./bridge-reconciler.js";
import { classifyPostExecResolution } from "./bridge-manifest.js";

const DAY = 24 * 60 * 60 * 1000;

// LLY: trim on a dust investor sleeve, broker ended flat.
const LLY_AUDIT = {
  ts: Date.parse("2026-09-18T15:02:00Z"),
  kind: "trim",
  intended_qty: 0.004595,
  pre_held_qty: 0.05562,
  expected_post_held_qty: 0.051025,
};
const LLY_ROW = {
  ticker: "LLY",
  mode: "investor",
  model_status: "OPEN",
  model_exit_ts: null,
  broker_remaining_qty: 0,
  sync_state: "in_sync",
};

// DE: trim in August, whole trade exited by catch-up a month later.
const DE_AUDIT = {
  ts: Date.parse("2026-08-21T13:30:00Z"),
  kind: "trim",
  intended_qty: 0.226964,
  pre_held_qty: 2.26964,
  expected_post_held_qty: 2.042676,
};
const DE_ROW = {
  ticker: "DE",
  mode: "trader",
  model_status: "CLOSED",
  model_exit_ts: Date.parse("2026-09-14T14:43:35Z"),
  broker_remaining_qty: 0,
  sync_state: "in_sync",
};

function resolve(row, audit, liveHeld) {
  const classified = classifyPostExecHeldDrift(audit, liveHeld);
  return { classified, resolution: classifyPostExecResolution(row, audit, classified) };
}

describe("classifyPostExecResolution", () => {
  it("retires LLY: broker flat after an over-executed trim", () => {
    const { classified, resolution } = resolve(LLY_ROW, LLY_AUDIT, 0);
    expect(classified.reason).toBe("reducer_overexecuted");
    expect(resolution).toEqual({
      reason: "broker_flat_after_overexecution",
      report: true,
    });
  });

  it("retires DE: the model closed the trade after the trim was stamped", () => {
    const { resolution } = resolve(DE_ROW, DE_AUDIT, 0);
    // The close supersedes the expectation, so it is not even news.
    expect(resolution).toEqual({
      reason: "superseded_by_model_close",
      report: false,
    });
  });

  it("does not retire an underexecuted trim — the leftover can still be sold", () => {
    const audit = { ts: Date.now() - DAY, kind: "trim", intended_qty: 50, pre_held_qty: 50, expected_post_held_qty: 0 };
    const { classified, resolution } = resolve(
      { ticker: "ULTA", model_status: "OPEN", model_exit_ts: null }, audit, 12.4,
    );
    expect(classified.reason).toBe("reducer_underexecuted");
    expect(resolution).toBeNull();
  });

  it("does not retire a replenished sleeve — a new lot needs reconciling", () => {
    const audit = { ts: Date.now() - DAY, kind: "exit", intended_qty: 50, pre_held_qty: 50, expected_post_held_qty: 0 };
    const { classified, resolution } = resolve(
      { ticker: "HOOD", model_status: "OPEN", model_exit_ts: null }, audit, 55,
    );
    expect(classified.reason).toBe("reducer_replenished");
    expect(resolution).toBeNull();
  });

  it("does not retire an over-execution that still leaves shares behind", () => {
    const audit = { ts: Date.now() - DAY, kind: "trim", intended_qty: 2, pre_held_qty: 12, expected_post_held_qty: 10 };
    const { classified, resolution } = resolve(
      { ticker: "MU", model_status: "OPEN", model_exit_ts: null }, audit, 3,
    );
    expect(classified.reason).toBe("reducer_overexecuted");
    expect(resolution).toBeNull();
  });

  it("does not call a closed row superseded when its exit PREDATES the audit", () => {
    // A reducer stamped after the close is a fresh intent on a closed
    // sleeve (catch-up selling leftover), so the close did not supersede
    // anything. The broker is still flat, so it retires on the other
    // rule — reported once rather than silently.
    const row = { ...DE_ROW, model_exit_ts: DE_AUDIT.ts - 60_000 };
    const { resolution } = resolve(row, DE_AUDIT, 0);
    expect(resolution.reason).toBe("broker_flat_after_overexecution");
    expect(resolution.report).toBe(true);
  });

  it("returns null when the broker converged (nothing to resolve)", () => {
    const { classified, resolution } = resolve(LLY_ROW, LLY_AUDIT, 0.051025);
    expect(classified.status).toBe("verified");
    expect(resolution).toBeNull();
  });
});

function makeDb({ rows = [] } = {}) {
  const updates = [];
  const audits = [];
  return {
    rows,
    updates,
    audits,
    prepare(sql) {
      const s = String(sql || "");
      const stmt = { sql: s, args: [] };
      return {
        bind(...args) { stmt.args = args; return this; },
        async run() {
          if (/^\s*UPDATE mirror_trade_manifest/i.test(s)) {
            updates.push(stmt);
            // Write the audit JSON back so a second pass sees it.
            if (/sync_last_action_json = \?4/.test(s)) {
              const target = rows.find(r => r.trade_id === stmt.args[1]);
              if (target) target.sync_last_action_json = stmt.args[3];
            }
          }
          if (/^\s*INSERT INTO bridge_audit/i.test(s)) audits.push(stmt);
          return { success: true, meta: { changes: 1 } };
        },
        async first() { return null; },
        async all() {
          if (/^\s*SELECT \* FROM mirror_trade_manifest/i.test(s)) {
            const [uid, , acct] = stmt.args;
            return {
              results: rows.filter(r =>
                r.user_id === uid || (acct != null && r.broker_account_id === acct)),
            };
          }
          return { results: [] };
        },
      };
    },
  };
}

const USER = {
  user_id: "op@x.com#webull#roth-ira",
  owner_email: "op@x.com",
  broker: "webull",
  status: "connected",
  broker_integration_enabled: true,
  webull_account_id: "WB-ROTH",
};

const FLAT_BROKER = { async getEquityPositions() { return { ok: true, positions: [] }; } };

function manifestRow(row, audit) {
  return {
    user_id: "op@x.com",
    trade_id: `${row.ticker}-post-exec-fixture`,
    broker_account_id: "WB-ROTH",
    instrument_type: "equity",
    mode: row.mode,
    ticker: row.ticker,
    model_status: row.model_status,
    model_exit_ts: row.model_exit_ts,
    model_intended_qty: audit.pre_held_qty,
    broker_filled_qty: audit.pre_held_qty,
    broker_remaining_qty: row.broker_remaining_qty,
    sync_state: row.sync_state,
    sync_last_checked_at: 0,
    sync_drift_count: 0,
    mirror_suppressed: 0,
    sync_last_action_json: JSON.stringify(audit),
  };
}

function auditRowCount(db, action) {
  return db.audits.filter(a => a.args.some(x => String(x).includes(action))).length;
}

describe("reconcileUser — the daily LLY / DE drift stops after one pass", () => {
  it("LLY: alerts once, then retires the audit", async () => {
    const db = makeDb({ rows: [manifestRow(LLY_ROW, LLY_AUDIT)] });
    const env = { BRIDGE_DB: db };

    const first = await reconcileUser(env, USER, FLAT_BROKER, {});
    expect(first.post_exec_drift).toBe(1);
    expect(first.post_exec_drift_retired).toBe(1);
    expect(auditRowCount(db, "post_exec_drift")).toBe(1);

    const stored = JSON.parse(db.rows[0].sync_last_action_json);
    expect(stored.resolved).toBe(true);
    expect(stored.resolved_reason).toBe("broker_flat_after_overexecution");
    expect(stored.verified).toBe(false);
    expect(stored.drift_qty).toBeCloseTo(-0.051025, 6);

    // Every later pass is silent — no second audit row, no second page.
    for (let i = 0; i < 3; i++) {
      const again = await reconcileUser(env, USER, FLAT_BROKER, {});
      expect(again.post_exec_drift || 0).toBe(0);
      expect(again.post_exec_drift_repeat || 0).toBe(0);
    }
    expect(auditRowCount(db, "post_exec_drift")).toBe(1);
  });

  it("DE: retires a month-old trim the model already closed out, without alerting", async () => {
    const db = makeDb({ rows: [manifestRow(DE_ROW, DE_AUDIT)] });
    const env = { BRIDGE_DB: db };

    const first = await reconcileUser(env, USER, FLAT_BROKER, {});
    expect(first.post_exec_drift || 0).toBe(0);
    expect(first.post_exec_drift_resolved).toBe(1);
    expect(auditRowCount(db, "post_exec_drift")).toBe(0);

    const stored = JSON.parse(db.rows[0].sync_last_action_json);
    expect(stored.resolved).toBe(true);
    expect(stored.resolved_reason).toBe("superseded_by_model_close");

    const again = await reconcileUser(env, USER, FLAT_BROKER, {});
    expect(again.post_exec_drift_resolved || 0).toBe(0);
  });

  it("an underexecuted trim keeps re-checking (not retired)", async () => {
    const audit = {
      ts: Date.now() - 3 * 60 * 60 * 1000,
      kind: "trim",
      intended_qty: 4,
      pre_held_qty: 10,
      expected_post_held_qty: 6,
    };
    const row = manifestRow(
      { ticker: "ULTA", mode: "trader", model_status: "OPEN", model_exit_ts: null, broker_remaining_qty: 6, sync_state: "in_sync" },
      audit,
    );
    const db = makeDb({ rows: [row] });
    const adapter = {
      async getEquityPositions() { return { ok: true, positions: [{ symbol: "ULTA", qty: 9, avg_cost: 400 }] }; },
    };

    const first = await reconcileUser({ BRIDGE_DB: db }, USER, adapter, {});
    expect(first.post_exec_drift).toBe(1);
    expect(first.post_exec_drift_retired || 0).toBe(0);
    expect(JSON.parse(db.rows[0].sync_last_action_json).resolved).toBeUndefined();
  });
});

describe("a resolved audit is spent everywhere it is read", () => {
  // Both readers have their own recency window, so anchor on now.
  const fresh = { ...LLY_AUDIT, ts: Date.now() };

  it("no longer reserves leftover shares", () => {
    expect(isUnverifiedReducerLeftover(fresh, 0.05)).toBe(true);
    expect(isUnverifiedReducerLeftover({ ...fresh, resolved: true }, 0.05)).toBe(false);
  });

  it("no longer overrides the expected qty as a reducer in flight", () => {
    expect(pendingReducerAudit({ sync_last_action_json: JSON.stringify(fresh) })).toBeTruthy();
    expect(pendingReducerAudit({
      sync_last_action_json: JSON.stringify({ ...fresh, resolved: true }),
    })).toBeNull();
  });
});
