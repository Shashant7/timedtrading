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
import { reconcileUser } from "./bridge-reconciler.js";
import { POST_EXEC_VERIFY_DELAY_MS, POST_EXEC_TOLERANCE_QTY } from "./bridge-manifest.js";

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
