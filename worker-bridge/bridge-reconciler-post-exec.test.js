// worker-bridge/bridge-reconciler-post-exec.test.js
//
// 2026-07-27 — Post-execution reducer audit verification inside the
// reconciler. Every ~5min the reconciler already fetches broker
// positions; when a manifest row carries a `sync_last_action_json`
// snapshot (stamped by bridge-index after a successful TRIM/EXIT
// place), we compare live held vs expected_post_held_qty and either:
//
//   - clear the audit + emit `post_exec_verified` (broker converged)
//   - stamp drift on the audit + emit `post_exec_drift` (broker did
//     NOT do what we asked — signal was blocked/dropped upstream, or
//     under/over-executed)
//
// This is the "did our action result in what we expected?" contract
// the operator asked for after the KO trim regression.

import { describe, it, expect } from "vitest";
import { reconcileUser, classifyPostExecHeldDrift } from "./bridge-reconciler.js";
import {
  POST_EXEC_VERIFY_DELAY_MS,
  POST_EXEC_TOLERANCE_QTY,
  POST_EXEC_DRIFT_REPEAT_MS,
  shouldReportPostExecDrift,
} from "./bridge-manifest.js";

function makeDb({ rows = [] } = {}) {
  const updates = [];
  const audits = []; // bridge_audit inserts
  return {
    updates,
    audits,
    prepare(sql) {
      const s = String(sql || "");
      const stmt = { sql: s, args: [] };
      return {
        bind(...args) { stmt.args = args; return this; },
        async run() {
          if (/^\s*UPDATE mirror_trade_manifest/i.test(s)) updates.push(stmt);
          if (/^\s*INSERT INTO bridge_audit/i.test(s)) audits.push(stmt);
          return { success: true, meta: { changes: 1 } };
        },
        async first() { return null; },
        async all() {
          // The observe-only read of suppressed rows filters the way D1 would.
          if (/mirror_suppressed, 0\) = 1/.test(s)) {
            const [uid, , acct] = stmt.args;
            return {
              results: rows.filter(r =>
                (r.user_id === uid || (acct != null && r.broker_account_id === acct))
                && (Number(r.mirror_suppressed) === 1 || r.sync_state === "mirror_suppressed")
                && String(r.instrument_type || "equity") !== "options"
                && Number(r.broker_remaining_qty) > 0),
            };
          }
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

const perAccountUser = {
  user_id: "op@x.com#webull#roth-ira",
  owner_email: "op@x.com",
  broker: "webull",
  status: "connected",
  broker_integration_enabled: true,
  webull_account_id: "WB-ROTH",
};

function auditSnapshot({
  kind = "trim",
  preHeld = 10.9,
  intended = 4.04568,
  verified = false,
  verifyAfterMs = 0, // 0 = due immediately
  brokerOrderId = "wb-ord-99",
} = {}) {
  return {
    ts: Date.now(),
    kind,
    intended_qty: intended,
    pre_held_qty: preHeld,
    expected_post_held_qty: preHeld - intended,
    client_order_id: "tt-trim-KO-123-ab",
    broker_order_id: brokerOrderId,
    verify_after_ms: verifyAfterMs,
    verified,
    verified_at: null,
    drift_qty: null,
  };
}

function makeRow({
  audit = auditSnapshot(),
  broker_filled_qty = 10.9,
  broker_remaining_qty = 10.9,
} = {}) {
  return {
    user_id: "op@x.com",
    trade_id: "inv-KO-auto-123",
    broker_account_id: "WB-ROTH",
    ticker: "KO",
    mode: "investor",
    instrument_type: "equity",
    model_status: "OPEN",
    sync_state: "in_sync",
    model_intended_qty: 10.9,
    broker_filled_qty,
    broker_remaining_qty,
    sync_last_checked_at: 0, // always cadence-eligible
    sync_drift_count: 0,
    mirror_suppressed: 0,
    sync_last_action_json: audit ? JSON.stringify(audit) : null,
  };
}

describe("classifyPostExecHeldDrift — ULTA leftover vs true replenish", () => {
  const exitAudit = {
    kind: "exit",
    pre_held_qty: 50,
    intended_qty: 50,
    expected_post_held_qty: 0,
  };

  it("full EXIT leftover ≤ pre_held is underexecuted, not replenished", () => {
    const out = classifyPostExecHeldDrift(exitAudit, 12.4);
    expect(out.status).toBe("drift");
    expect(out.reason).toBe("reducer_underexecuted");
    expect(out.severity).toBe("warn");
    expect(out.leftover_qty).toBeCloseTo(12.4, 6);
  });

  it("does not treat a blocked trim (still at pre_held) as replenished", () => {
    const trim = {
      kind: "trim",
      pre_held_qty: 10.9,
      intended_qty: 4.04568,
      expected_post_held_qty: 6.85432,
    };
    const out = classifyPostExecHeldDrift(trim, 10.9);
    expect(out.reason).toBe("reducer_underexecuted");
  });

  it("live above pre_held is replenished (a new lot)", () => {
    const out = classifyPostExecHeldDrift(exitAudit, 55);
    expect(out.reason).toBe("reducer_replenished");
    expect(out.severity).toBe("critical");
    expect(out.added_qty).toBeCloseTo(5, 6);
  });

  it("live below expected is overexecuted", () => {
    const trim = {
      kind: "trim",
      pre_held_qty: 10.9,
      intended_qty: 4.04568,
      expected_post_held_qty: 6.85432,
    };
    const out = classifyPostExecHeldDrift(trim, 0);
    expect(out.reason).toBe("reducer_overexecuted");
    expect(out.severity).toBe("critical");
  });
});

describe("reconcileUser — post-execution audit VERIFIED path", () => {
  it("marks audit verified + emits post_exec_verified when live held converges to expected", async () => {
    // Model wanted to trim 4.04568 sh from 10.9 held → expected 6.85432.
    // Broker actually held 6.85432 (exact match).
    const row = makeRow();
    const db = makeDb({ rows: [row] });
    const adapter = {
      async getEquityPositions() {
        return { ok: true, positions: [{ symbol: "KO", qty: 6.85432, avg_cost: 82.11 }] };
      },
    };
    const stats = await reconcileUser({ BRIDGE_DB: db }, perAccountUser, adapter, {});
    expect(stats.post_exec_verified).toBe(1);
    expect(stats.post_exec_drift || 0).toBe(0);
    // Audit was stamped verified=true.
    const auditUpd = db.updates.find(u => /sync_last_action_json/.test(u.sql));
    expect(auditUpd).toBeTruthy();
    const written = JSON.parse(auditUpd.args[3]);
    expect(written.verified).toBe(true);
    expect(written.drift_qty).toBeCloseTo(0, 6);
    // A `post_exec_verified` audit row was written.
    const receipt = db.audits.find(a => a.args.some(x => String(x).includes("post_exec_verified")));
    expect(receipt).toBeTruthy();
  });

  it("verifies within POST_EXEC_TOLERANCE_QTY dust window (broker rounded 0.001 short)", async () => {
    const row = makeRow();
    const db = makeDb({ rows: [row] });
    const adapter = {
      async getEquityPositions() {
        // Expected 6.85432; broker holds 6.85340 (0.00092 sh dust — within tolerance).
        return { ok: true, positions: [{ symbol: "KO", qty: 6.85340, avg_cost: 82.11 }] };
      },
    };
    const stats = await reconcileUser({ BRIDGE_DB: db }, perAccountUser, adapter, {});
    expect(stats.post_exec_verified).toBe(1);
    expect(POST_EXEC_TOLERANCE_QTY).toBeGreaterThan(0.001);
  });
});

describe("reconcileUser — post-execution audit DRIFT path", () => {
  it("flags drift + emits post_exec_drift when broker still holds pre-trim qty (KO signal blocked)", async () => {
    // KO regression scenario: model intended a 4.04568-sh trim from 10.9;
    // upstream side-mapping bug flipped kind=trim → side=sell → recon
    // treated it as full liquidation, then the guard rejected. Bridge
    // client thought it placed but broker still holds all 10.9.
    const row = makeRow();
    const db = makeDb({ rows: [row] });
    const adapter = {
      async getEquityPositions() {
        return { ok: true, positions: [{ symbol: "KO", qty: 10.9, avg_cost: 82.11 }] };
      },
    };
    const stats = await reconcileUser({ BRIDGE_DB: db }, perAccountUser, adapter, {});
    expect(stats.post_exec_drift).toBe(1);
    expect(stats.post_exec_verified || 0).toBe(0);
    // Audit stamped with drift_qty ≈ +4.04568 (broker held MORE than expected).
    const auditUpd = db.updates.find(u => /sync_last_action_json/.test(u.sql));
    expect(auditUpd).toBeTruthy();
    const written = JSON.parse(auditUpd.args[3]);
    expect(written.verified).toBe(false);
    expect(written.drift_qty).toBeCloseTo(4.04568, 4);
    expect(written.live_held_qty).toBe(10.9);
    expect(written.drift_detected_at).toBeTypeOf("number");
    // A post_exec_drift bridge_audit row was written.
    const alert = db.audits.find(a => a.args.some(x => String(x).includes("post_exec_drift")));
    expect(alert).toBeTruthy();
  });

  it("flags drift when broker over-executes (sold more than expected)", async () => {
    // KO retry regression: full-liquidation dispatched on a partial-trim
    // intent. Expected 6.85432 sh remaining; broker sold everything.
    const row = makeRow();
    const db = makeDb({ rows: [row] });
    const adapter = {
      async getEquityPositions() {
        return { ok: true, positions: [] }; // flat
      },
    };
    const stats = await reconcileUser({ BRIDGE_DB: db }, perAccountUser, adapter, {});
    expect(stats.post_exec_drift).toBe(1);
    const auditUpd = db.updates.find(u => /sync_last_action_json/.test(u.sql));
    const written = JSON.parse(auditUpd.args[3]);
    expect(written.drift_qty).toBeCloseTo(-6.85432, 4);
  });
});

describe("reconcileUser — post-execution audit SKIP paths", () => {
  it("skips verification when the audit is not yet due (verify_after_ms in the future)", async () => {
    const audit = auditSnapshot({ verifyAfterMs: Date.now() + POST_EXEC_VERIFY_DELAY_MS });
    const row = makeRow({ audit });
    const db = makeDb({ rows: [row] });
    const adapter = {
      async getEquityPositions() {
        return { ok: true, positions: [{ symbol: "KO", qty: 10.9, avg_cost: 82.11 }] };
      },
    };
    const stats = await reconcileUser({ BRIDGE_DB: db }, perAccountUser, adapter, {});
    expect(stats.post_exec_pending).toBe(1);
    expect(stats.post_exec_verified || 0).toBe(0);
    expect(stats.post_exec_drift || 0).toBe(0);
    // No audit UPDATE emitted (the row update from _persistRowUpdate is
    // still present but does not touch sync_last_action_json).
    const auditUpd = db.updates.find(u => /sync_last_action_json/.test(u.sql));
    expect(auditUpd).toBeFalsy();
  });

  it("skips verification when the audit is already verified", async () => {
    const audit = auditSnapshot({ verified: true });
    const row = makeRow({ audit });
    const db = makeDb({ rows: [row] });
    const adapter = {
      async getEquityPositions() {
        return { ok: true, positions: [{ symbol: "KO", qty: 6.85432, avg_cost: 82.11 }] };
      },
    };
    const stats = await reconcileUser({ BRIDGE_DB: db }, perAccountUser, adapter, {});
    expect(stats.post_exec_verified || 0).toBe(0);
    expect(stats.post_exec_drift || 0).toBe(0);
    expect(stats.post_exec_pending || 0).toBe(0);
    const auditUpd = db.updates.find(u => /sync_last_action_json/.test(u.sql));
    expect(auditUpd).toBeFalsy();
  });

  it("skips verification when the row has no audit stamped", async () => {
    const row = makeRow({ audit: null });
    const db = makeDb({ rows: [row] });
    const adapter = {
      async getEquityPositions() {
        return { ok: true, positions: [{ symbol: "KO", qty: 10.9, avg_cost: 82.11 }] };
      },
    };
    const stats = await reconcileUser({ BRIDGE_DB: db }, perAccountUser, adapter, {});
    expect(stats.post_exec_verified || 0).toBe(0);
    expect(stats.post_exec_drift || 0).toBe(0);
    expect(stats.post_exec_pending || 0).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2026-08-17 — XLRE regression. Two model trades held the same ticker in one
// broker account: an exiting trade (17.3812 sh) and an older open one
// (1.35379 sh). The exit filled exactly as intended, but the audit compared
// its whole-account expectation (18.73499 - 17.3812 = 1.35379) against the
// CLOSED row's per-row residual, which the classifier reports as 0 because
// the open sibling claims those shares. Result: a CRITICAL "reducer
// overexecuted" alert every reconciler cycle on a clean exit.
// ─────────────────────────────────────────────────────────────────────────
describe("reconcileUser — post-exec audit with a sibling trade on the same ticker", () => {
  const exitAudit = {
    ts: Date.now(),
    kind: "exit",
    intended_qty: 17.3812,
    pre_held_qty: 18.73499,          // whole-account XLRE position at order time
    expected_post_held_qty: 1.35379, // the sibling trade's shares
    client_order_id: "tt-exit-XLRE-1",
    broker_order_id: "wb-xlre-1",
    verify_after_ms: 0,
    verified: false,
    verified_at: null,
    drift_qty: null,
  };

  const closedRow = {
    user_id: "op@x.com",
    trade_id: "XLRE-exiting",
    broker_account_id: "WB-ROTH",
    ticker: "XLRE",
    mode: "trader",
    instrument_type: "equity",
    model_status: "CLOSED",
    sync_state: "in_sync",
    model_intended_qty: 17.3812,
    broker_filled_qty: 17.3812,
    broker_remaining_qty: 0,
    sync_last_checked_at: 0,
    sync_drift_count: 0,
    mirror_suppressed: 0,
    sync_last_action_json: JSON.stringify(exitAudit),
  };

  const openSibling = {
    ...closedRow,
    trade_id: "XLRE-older-open",
    model_status: "OPEN",
    model_intended_qty: 1.35379,
    broker_filled_qty: 1.35379,
    broker_remaining_qty: 1.35379,
    sync_last_action_json: null,
  };

  it("verifies the exit when the broker still holds exactly the sibling's shares", async () => {
    const db = makeDb({ rows: [closedRow, openSibling] });
    const adapter = {
      async getEquityPositions() {
        // Broker holds only the older trade's shares — the exit did its job.
        return { ok: true, positions: [{ symbol: "XLRE", qty: 1.35379, avg_cost: 45.2 }] };
      },
    };
    const stats = await reconcileUser({ BRIDGE_DB: db }, perAccountUser, adapter, {});
    expect(stats.post_exec_verified).toBe(1);
    expect(stats.post_exec_drift || 0).toBe(0);
  });

  it("still flags drift when the broker really did liquidate the sibling too", async () => {
    const db = makeDb({ rows: [closedRow, openSibling] });
    const adapter = {
      async getEquityPositions() {
        return { ok: true, positions: [] }; // account genuinely flat
      },
    };
    const stats = await reconcileUser({ BRIDGE_DB: db }, perAccountUser, adapter, {});
    expect(stats.post_exec_drift).toBe(1);
  });

  it("reports execution_drift rather than a connection error", async () => {
    const db = makeDb({ rows: [closedRow, openSibling] });
    const adapter = { async getEquityPositions() { return { ok: true, positions: [] }; } };
    await reconcileUser({ BRIDGE_DB: db }, perAccountUser, adapter, {});
    const alert = db.audits.find(a => a.args.some(x => String(x).includes("post_exec_drift")));
    expect(alert).toBeTruthy();
    expect(alert.args.some(x => String(x).includes("reducer_overexecuted"))).toBe(true);
  });
});

describe("reconcileUser — ULTA partial EXIT leftover", () => {
  it("stamps reducer_underexecuted when the broker sold only part of a full EXIT", async () => {
    const audit = {
      ts: Date.now(),
      kind: "exit",
      intended_qty: 50,
      pre_held_qty: 50,
      expected_post_held_qty: 0,
      client_order_id: "tt-exit-ULTA-1",
      broker_order_id: "wb-ulta-1",
      verify_after_ms: 0,
      verified: false,
    };
    const row = {
      user_id: "op@x.com",
      trade_id: "ULTA-w36",
      broker_account_id: "WB-ROTH",
      ticker: "ULTA",
      mode: "trader",
      instrument_type: "equity",
      model_status: "CLOSED",
      sync_state: "in_sync",
      model_intended_qty: 50,
      broker_filled_qty: 50,
      broker_remaining_qty: 0,
      sync_last_checked_at: 0,
      sync_drift_count: 0,
      mirror_suppressed: 0,
      sync_last_action_json: JSON.stringify(audit),
    };
    const db = makeDb({ rows: [row] });
    const adapter = {
      async getEquityPositions() {
        return { ok: true, positions: [{ symbol: "ULTA", qty: 12.4, avg_cost: 537.25 }] };
      },
    };
    const stats = await reconcileUser({ BRIDGE_DB: db }, perAccountUser, adapter, {});
    expect(stats.post_exec_drift).toBe(1);
    const alert = db.audits.find(a => a.args.some(x => String(x).includes("post_exec_drift")));
    expect(alert).toBeTruthy();
    expect(alert.args.some(x => String(x).includes("reducer_underexecuted"))).toBe(true);
    expect(alert.args.some(x => String(x).includes("reducer_underexecuted_or_replenished"))).toBe(false);
    expect(alert.args.some(x => String(x).includes("reducer_replenished"))).toBe(false);
  });
});

// 2026-09-15 — a drift is deliberately left `verified:false` so a later pass
// can see it heal, but the drift path treated "re-check" and "re-report" as
// the same thing. DE (`DE-1787252853209-e3325t0lf`, 0.226964 sh) wrote a
// post_exec_drift audit row and emitted a notification every reconcile pass
// for days: 6 of the 6 newest audit rows, with real placements pushed 26 rows
// deep in a 400-row pull. The audit log is where an operator looks to see
// whether an order reached the broker, so burying it has a cost.
describe("shouldReportPostExecDrift — say it once, keep checking", () => {
  const NOW = Date.UTC(2026, 8, 15, 18, 0, 0);

  it("reports a drift nobody has reported yet", () => {
    const out = shouldReportPostExecDrift({ drift_qty: 0.226964 }, 0.226964, { now: NOW });
    expect(out.report).toBe(true);
    expect(out.reason).toBe("first_report");
  });

  it("reports rows written before drift_reported_at existed", () => {
    // The old code stamped drift_detected_at and nothing else, so the very
    // first pass after this ships must not silently swallow a live drift.
    const legacy = { drift_qty: 0.226964, drift_detected_at: NOW - 60_000 };
    expect(shouldReportPostExecDrift(legacy, 0.226964, { now: NOW }).report).toBe(true);
  });

  it("stays quiet on the same drift already reported", () => {
    const prev = { drift_qty: 0.226964, drift_reported_at: NOW - 5 * 60 * 1000 };
    const out = shouldReportPostExecDrift(prev, 0.226964, { now: NOW });
    expect(out.report).toBe(false);
    expect(out.reason).toBe("unchanged_since_last_report");
    expect(out.suppressed_for_ms).toBeGreaterThan(0);
  });

  it("speaks up again when the drift moves past the fill tolerance", () => {
    const prev = { drift_qty: 0.226964, drift_reported_at: NOW - 5 * 60 * 1000 };
    // Dust-level change is still the same gap.
    expect(shouldReportPostExecDrift(prev, 0.226964 + POST_EXEC_TOLERANCE_QTY / 2, { now: NOW }).report).toBe(false);
    // A real move means something happened at the broker.
    const moved = shouldReportPostExecDrift(prev, 4.5, { now: NOW });
    expect(moved.report).toBe(true);
    expect(moved.reason).toBe("drift_qty_changed");
    // Shrinking counts too — a partial heal is news.
    expect(shouldReportPostExecDrift(prev, 0, { now: NOW }).reason).toBe("drift_qty_changed");
  });

  it("re-reports an unresolved drift after the repeat window", () => {
    const prev = { drift_qty: 0.226964, drift_reported_at: NOW - POST_EXEC_DRIFT_REPEAT_MS - 1 };
    const out = shouldReportPostExecDrift(prev, 0.226964, { now: NOW });
    expect(out.report).toBe(true);
    expect(out.reason).toBe("repeat_window_elapsed");
  });
});

describe("reconcileUser — an unchanged drift is re-checked, not re-reported", () => {
  /** A row whose audit already carries a reported drift of +4.04568. */
  function rowWithReportedDrift(over = {}) {
    const audit = {
      ...auditSnapshot(),
      drift_qty: 4.04568,
      drift_detected_at: Date.now() - 60 * 60 * 1000,
      drift_reported_at: Date.now() - 5 * 60 * 1000,
      live_held_qty: 10.9,
      ...over,
    };
    return makeRow({ audit });
  }

  const stillHolding = {
    async getEquityPositions() {
      return { ok: true, positions: [{ symbol: "KO", qty: 10.9, avg_cost: 82.11 }] };
    },
  };

  it("writes no new audit row and no notification for the same gap", async () => {
    const db = makeDb({ rows: [rowWithReportedDrift()] });
    const stats = await reconcileUser({ BRIDGE_DB: db }, perAccountUser, stillHolding, {});
    expect(stats.post_exec_drift_repeat).toBe(1);
    expect(stats.post_exec_drift || 0).toBe(0);
    expect(db.audits.find((a) => a.args.some((x) => String(x).includes("post_exec_drift")))).toBeFalsy();
  });

  it("keeps re-checking, so the audit still updates and can still heal", async () => {
    const db = makeDb({ rows: [rowWithReportedDrift()] });
    await reconcileUser({ BRIDGE_DB: db }, perAccountUser, stillHolding, {});
    const upd = db.updates.find((u) => /sync_last_action_json/.test(u.sql));
    expect(upd).toBeTruthy();
    const written = JSON.parse(upd.args[3]);
    // Suppressing the REPORT must not suppress the re-check: verified stays
    // false so a later pass can still flip it, and the last-seen stamp moves.
    expect(written.verified).toBe(false);
    expect(written.drift_last_seen_at).toBeTypeOf("number");
  });

  it("does not move drift_reported_at while suppressed, so the window still expires", async () => {
    // If the suppressed path refreshed the stamp, the repeat window would
    // never elapse and a real unresolved drift would go silent forever.
    const reportedAt = Date.now() - 5 * 60 * 1000;
    const db = makeDb({ rows: [rowWithReportedDrift({ drift_reported_at: reportedAt })] });
    await reconcileUser({ BRIDGE_DB: db }, perAccountUser, stillHolding, {});
    const written = JSON.parse(db.updates.find((u) => /sync_last_action_json/.test(u.sql)).args[3]);
    expect(written.drift_reported_at).toBe(reportedAt);
  });

  it("keeps drift_detected_at pinned to first sight", async () => {
    // It used to be overwritten with `now` every pass, so a drift sitting for
    // days always looked brand new.
    const firstSeen = Date.now() - 36 * 60 * 60 * 1000;
    const db = makeDb({ rows: [rowWithReportedDrift({ drift_detected_at: firstSeen })] });
    await reconcileUser({ BRIDGE_DB: db }, perAccountUser, stillHolding, {});
    const written = JSON.parse(db.updates.find((u) => /sync_last_action_json/.test(u.sql)).args[3]);
    expect(written.drift_detected_at).toBe(firstSeen);
  });

  it("still reports when the gap changes at the broker", async () => {
    const db = makeDb({ rows: [rowWithReportedDrift()] });
    const soldSome = {
      async getEquityPositions() {
        return { ok: true, positions: [{ symbol: "KO", qty: 8.0, avg_cost: 82.11 }] };
      },
    };
    const stats = await reconcileUser({ BRIDGE_DB: db }, perAccountUser, soldSome, {});
    expect(stats.post_exec_drift).toBe(1);
    expect(stats.post_exec_drift_repeat || 0).toBe(0);
  });

  it("still verifies when the drift heals", async () => {
    const db = makeDb({ rows: [rowWithReportedDrift()] });
    const converged = {
      async getEquityPositions() {
        return { ok: true, positions: [{ symbol: "KO", qty: 6.85432, avg_cost: 82.11 }] };
      },
    };
    const stats = await reconcileUser({ BRIDGE_DB: db }, perAccountUser, converged, {});
    expect(stats.post_exec_verified).toBe(1);
    expect(stats.post_exec_drift_repeat || 0).toBe(0);
  });
});
