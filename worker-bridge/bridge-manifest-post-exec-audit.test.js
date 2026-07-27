// worker-bridge/bridge-manifest-post-exec-audit.test.js
//
// 2026-07-27 — Unit tests for the post-execution reducer audit
// (writeLastActionAudit / markLastActionVerified / markLastActionDrift /
// readLastActionAudit) added to bridge-manifest.js.
//
// The audit is the "did our action result in what we expected?"
// contract the operator asked for after the KO trim regression:
// every successful TRIM/EXIT/CLOSE stamps the manifest row with
// pre-held, intended, and expected-post-held qtys so the reconciler
// can verify a couple of minutes later.

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  writeLastActionAudit,
  markLastActionVerified,
  markLastActionDrift,
  readLastActionAudit,
  POST_EXEC_VERIFY_DELAY_MS,
  POST_EXEC_TOLERANCE_QTY,
} from "./bridge-manifest.js";

function makeDb({ changes = 1, secondChanges = 0 } = {}) {
  const calls = [];
  let call = 0;
  return {
    calls,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async run() {
              call++;
              calls.push({ sql, args });
              const c = call === 1 ? changes : secondChanges;
              return { meta: { changes: c } };
            },
          };
        },
      };
    },
  };
}

describe("writeLastActionAudit — stamps sync_last_action_json snapshot", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("returns action=stamped on a matching row and writes the expected snapshot", async () => {
    const db = makeDb({ changes: 1 });
    const now = 1_800_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const r = await writeLastActionAudit(
      { BRIDGE_DB: db },
      {
        userId: "op@example.com",
        tradeId: "inv-KO-auto-123",
        brokerAccountId: "WB-ROTH",
        kind: "trim",
        preHeldQty: 10.9,
        intendedQty: 4.04568,
        clientOrderId: "tt-trim-KO-123-ab",
        brokerOrderId: "wb-ord-99",
        reasons: { is_full: false, model_remaining: 10.9 },
      },
    );
    expect(r.ok).toBe(true);
    expect(r.action).toBe("stamped");
    const write = db.calls[0];
    expect(write.sql).toMatch(/UPDATE mirror_trade_manifest[\s\S]+sync_last_action_json/);
    // bind order: user_id, trade_id, broker_account_id, json, now
    expect(write.args[0]).toBe("op@example.com");
    expect(write.args[1]).toBe("inv-KO-auto-123");
    expect(write.args[2]).toBe("WB-ROTH");
    const snap = JSON.parse(write.args[3]);
    expect(snap.kind).toBe("trim");
    expect(snap.pre_held_qty).toBeCloseTo(10.9, 6);
    expect(snap.intended_qty).toBeCloseTo(4.04568, 6);
    expect(snap.expected_post_held_qty).toBeCloseTo(10.9 - 4.04568, 6);
    expect(snap.client_order_id).toBe("tt-trim-KO-123-ab");
    expect(snap.broker_order_id).toBe("wb-ord-99");
    expect(snap.ts).toBe(now);
    expect(snap.verify_after_ms).toBe(now + POST_EXEC_VERIFY_DELAY_MS);
    expect(snap.verified).toBe(false);
    expect(snap.verified_at).toBeNull();
    expect(snap.drift_qty).toBeNull();
  });

  it("full-exit expected_post_held_qty is 0 (or floored) when intended == held", async () => {
    const db = makeDb({ changes: 1 });
    const r = await writeLastActionAudit(
      { BRIDGE_DB: db },
      {
        userId: "op@example.com",
        tradeId: "inv-KO-auto-123",
        brokerAccountId: "WB-ROTH",
        kind: "exit",
        preHeldQty: 10.90578,
        intendedQty: 10.90578, // dust-swept full flatten
      },
    );
    expect(r.ok).toBe(true);
    const snap = JSON.parse(db.calls[0].args[3]);
    expect(snap.expected_post_held_qty).toBeCloseTo(0, 6);
  });

  it("returns skipped when no matching row and no legacy alias hit", async () => {
    const db = makeDb({ changes: 0, secondChanges: 0 });
    const r = await writeLastActionAudit(
      { BRIDGE_DB: db },
      {
        userId: "op@example.com",
        tradeId: "TRD-1", // no inv-/inv-inv- alias applicable
        brokerAccountId: "WB-ROTH",
        kind: "trim",
        preHeldQty: 5,
        intendedQty: 2,
      },
    );
    expect(r.ok).toBe(false);
    expect(r.action).toBe("skipped");
    expect(r.reason).toBe("no_matching_row");
  });

  it("falls back to the inv-/inv-inv- prefix alias when the direct row is missing", async () => {
    // First UPDATE (inv-KO-auto-123) hits 0 rows; second (inv-inv-KO-auto-123)
    // hits 1 → returns action=stamped_alias.
    const db = makeDb({ changes: 0, secondChanges: 1 });
    const r = await writeLastActionAudit(
      { BRIDGE_DB: db },
      {
        userId: "op@example.com",
        tradeId: "inv-KO-auto-123",
        brokerAccountId: "WB-ROTH",
        kind: "trim",
        preHeldQty: 10.9,
        intendedQty: 4,
      },
    );
    expect(r.ok).toBe(true);
    expect(r.action).toBe("stamped_alias");
    expect(db.calls.length).toBe(2);
    expect(db.calls[0].args[1]).toBe("inv-KO-auto-123");
    expect(db.calls[1].args[1]).toBe("inv-inv-KO-auto-123");
  });

  it("skips when required inputs are missing", async () => {
    const db = makeDb();
    expect((await writeLastActionAudit({ BRIDGE_DB: db }, {
      userId: "", tradeId: "inv-KO-1", brokerAccountId: "A", kind: "trim",
      preHeldQty: 5, intendedQty: 2,
    })).reason).toBe("missing_user_id_or_trade_id");
    expect((await writeLastActionAudit({ BRIDGE_DB: db }, {
      userId: "op@example.com", tradeId: "inv-KO-1", brokerAccountId: "A",
      kind: "trim", preHeldQty: NaN, intendedQty: 2,
    })).reason).toBe("bad_qty_inputs");
    expect((await writeLastActionAudit({ BRIDGE_DB: db }, {
      userId: "op@example.com", tradeId: "inv-KO-1", brokerAccountId: "A",
      kind: "trim", preHeldQty: 5, intendedQty: 0,
    })).reason).toBe("bad_qty_inputs");
  });

  it("returns skipped when BRIDGE_DB is missing (never throws)", async () => {
    const r = await writeLastActionAudit({}, {
      userId: "op@example.com", tradeId: "inv-KO-1", brokerAccountId: "A",
      kind: "trim", preHeldQty: 5, intendedQty: 2,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("no_db");
  });
});

describe("markLastActionVerified — clears the audit + records drift=0", () => {
  it("stamps verified=true, verified_at, drift_qty on the existing snapshot", async () => {
    const audit = {
      ts: 1, kind: "trim", intended_qty: 4, pre_held_qty: 10,
      expected_post_held_qty: 6, verified: false,
    };
    const row = {
      user_id: "op@example.com",
      trade_id: "inv-KO-1",
      broker_account_id: "WB-ROTH",
      sync_last_action_json: JSON.stringify(audit),
    };
    const db = makeDb({ changes: 1 });
    const ok = await markLastActionVerified({ BRIDGE_DB: db }, row, 6.001);
    expect(ok).toBe(true);
    const updated = JSON.parse(db.calls[0].args[3]);
    expect(updated.verified).toBe(true);
    expect(updated.verified_at).toBeTypeOf("number");
    expect(updated.drift_qty).toBeCloseTo(0.001, 6);
    expect(updated.intended_qty).toBe(4); // original preserved
  });

  it("returns false when the row has no audit", async () => {
    const db = makeDb();
    const ok = await markLastActionVerified({ BRIDGE_DB: db }, { user_id: "u", trade_id: "t", broker_account_id: "a" }, 5);
    expect(ok).toBe(false);
    expect(db.calls.length).toBe(0);
  });
});

describe("markLastActionDrift — records drift without clearing", () => {
  it("stamps drift_qty + drift_detected_at + live_held_qty, leaves verified=false", async () => {
    const audit = {
      ts: 1, kind: "trim", intended_qty: 4, pre_held_qty: 10,
      expected_post_held_qty: 6, verified: false,
    };
    const row = {
      user_id: "op@example.com",
      trade_id: "inv-KO-1",
      broker_account_id: "WB-ROTH",
      sync_last_action_json: JSON.stringify(audit),
    };
    const db = makeDb({ changes: 1 });
    const ok = await markLastActionDrift({ BRIDGE_DB: db }, row, 10); // broker didn't trim
    expect(ok).toBe(true);
    const updated = JSON.parse(db.calls[0].args[3]);
    expect(updated.verified).toBe(false);
    expect(updated.drift_qty).toBeCloseTo(4, 6);
    expect(updated.drift_detected_at).toBeTypeOf("number");
    expect(updated.live_held_qty).toBe(10);
    expect(updated.expected_post_held_qty).toBe(6); // original preserved
  });
});

describe("readLastActionAudit — parses string OR pre-parsed audit shape", () => {
  it("parses a JSON string into an object", () => {
    const audit = { ts: 1, intended_qty: 4, verified: false };
    const parsed = readLastActionAudit({ sync_last_action_json: JSON.stringify(audit) });
    expect(parsed).toEqual(audit);
  });
  it("returns already-parsed object as-is (from _expandJsonCols path)", () => {
    const audit = { ts: 1, intended_qty: 4, verified: false };
    const parsed = readLastActionAudit({ sync_last_action_json: audit });
    expect(parsed).toEqual(audit);
  });
  it("returns null when the column is missing or empty", () => {
    expect(readLastActionAudit({})).toBeNull();
    expect(readLastActionAudit({ sync_last_action_json: null })).toBeNull();
    expect(readLastActionAudit({ sync_last_action_json: "" })).toBeNull();
  });
  it("returns null on unparseable JSON (best-effort)", () => {
    expect(readLastActionAudit({ sync_last_action_json: "{not-json" })).toBeNull();
  });
});

describe("POST_EXEC_TOLERANCE_QTY — dust window (2026-07-27 KO regression)", () => {
  it("tolerance covers Webull fill-precision dust (0.05 sh)", () => {
    expect(POST_EXEC_TOLERANCE_QTY).toBeGreaterThan(0);
    expect(POST_EXEC_TOLERANCE_QTY).toBeLessThanOrEqual(0.1);
  });
  it("verify delay gives the broker at least a minute to route the order", () => {
    expect(POST_EXEC_VERIFY_DELAY_MS).toBeGreaterThanOrEqual(60_000);
  });
});
