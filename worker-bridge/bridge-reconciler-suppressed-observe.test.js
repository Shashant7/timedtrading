// worker-bridge/bridge-reconciler-suppressed-observe.test.js
//
// Suppression stops a row paging. It used to stop the row being READ too:
// the reconcile scan skipped suppressed rows, so `broker_remaining_qty`
// froze at whatever the broker held the day the row was suppressed. On
// 2026-09-24 all 27 model-closed Short Term rows still recording shares were
// suppressed, last read 1-55 days earlier, 25 of them in tickers neither
// account held. Real SQLite, real manifest schema.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { reconcileUser } from "./bridge-reconciler.js";
import { ensureMirrorManifestSchema } from "./bridge-manifest.js";
import { d1Sqlite } from "../worker/test-support/d1-sqlite.js";

const USER = {
  user_id: "op@x.com#webull#roth-ira",
  owner_email: "op@x.com",
  broker: "webull",
  status: "connected",
  broker_integration_enabled: true,
  webull_account_id: "WB-ROTH",
};

let env;
beforeAll(async () => {
  env = { BRIDGE_DB: d1Sqlite(), BRIDGE_KV: { get: async () => null, put: async () => {}, list: async () => ({ keys: [] }) } };
  await ensureMirrorManifestSchema(env);
});
beforeEach(async () => {
  await env.BRIDGE_DB.prepare("DELETE FROM mirror_trade_manifest").run();
});

async function insertRow({ ticker, status = "CLOSED", remaining, suppressed = 1, syncState = "broker_orphan", checkedAt = 1 }) {
  await env.BRIDGE_DB.prepare(`
    INSERT INTO mirror_trade_manifest (user_id, trade_id, broker_account_id, broker, mode, instrument_type,
      ticker, direction, model_intended_qty, model_status, broker_filled_qty, broker_remaining_qty,
      sync_state, sync_drift_count, mirror_suppressed, mirror_suppressed_reason, sync_last_checked_at,
      model_entry_ts, created_at, updated_at)
    VALUES (?1, ?2, 'WB-ROTH', 'webull', 'trader', 'equity', ?3, 'LONG', ?4, ?5, ?4, ?4,
      ?6, 4, ?7, 'auto_suppressed_after_4_drifts:broker_orphan', ?8, 1786730641396, 1, 1)
  `).bind("op@x.com", `${ticker}-1786730641396-x`, ticker, remaining, status, syncState, suppressed, checkedAt).run();
}

const readRow = (ticker) => env.BRIDGE_DB.prepare(
  "SELECT * FROM mirror_trade_manifest WHERE ticker = ?1",
).bind(ticker).first();

const holding = (positions, ok = true) => ({
  getEquityPositions: async () => (ok ? { ok: true, positions } : { ok: false, error: "rate_limited" }),
});

describe("suppressed rows are read, not re-armed", () => {
  it("releases a suppressed closed row once the broker is flat on it", async () => {
    await insertRow({ ticker: "UNP", remaining: 1.90357 });
    const stats = await reconcileUser(env, USER, holding([]));
    const row = await readRow("UNP");
    expect(row.broker_remaining_qty).toBe(0);
    expect(row.mirror_suppressed).toBe(0);
    expect(row.sync_state).toBe("in_sync");
    expect(row.sync_drift_count).toBe(0);
    expect(row.mirror_suppressed_reason).toMatch(/^auto_released_resolved:auto_suppressed_after_4_drifts/);
    expect(stats.suppressed_released).toBe(1);
  });

  it("refreshes what the mirror holds while the row stays suppressed", async () => {
    await insertRow({ ticker: "XLRE", remaining: 17.3812 });
    await reconcileUser(env, USER, holding([{ symbol: "XLRE", qty: 1.35379 }]));
    const row = await readRow("XLRE");
    expect(row.broker_remaining_qty).toBeCloseTo(1.35379, 5);
    expect(row.mirror_suppressed).toBe(1);
    expect(row.sync_note).toMatch(/^observed while suppressed/);
  });

  it("touches nothing when the broker could not be read", async () => {
    await insertRow({ ticker: "USO", remaining: 1.56695, checkedAt: 7 });
    await reconcileUser(env, USER, holding([], false));
    const row = await readRow("USO");
    expect(row.broker_remaining_qty).toBeCloseTo(1.56695, 5);
    expect(row.mirror_suppressed).toBe(1);
    expect(row.sync_last_checked_at).toBe(7);
  });

  it("never changes the model's status or counts drift", async () => {
    await insertRow({ ticker: "FLR", remaining: 4 });
    await reconcileUser(env, USER, holding([{ symbol: "FLR", qty: 4 }]));
    const row = await readRow("FLR");
    expect(row.model_status).toBe("CLOSED");
    expect(row.sync_drift_count).toBe(4);
    expect(row.mirror_suppressed).toBe(1);
  });

  it("leaves unsuppressed rows to the normal scan", async () => {
    await insertRow({ ticker: "MSFT", status: "OPEN", remaining: 2, suppressed: 0, syncState: "in_sync" });
    await reconcileUser(env, USER, holding([{ symbol: "MSFT", qty: 2 }]));
    const row = await readRow("MSFT");
    expect(row.sync_note || "").not.toMatch(/suppressed/);
  });
});
