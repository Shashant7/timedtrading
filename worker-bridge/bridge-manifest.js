// worker-bridge/bridge-manifest.js
//
// 2026-06-01 — Phase A of the trade-aware mirror sync (PR sequence
// after #410 + #411 + #412). Per
// tasks/2026-06-01-trade-aware-mirror-sync-design.md §3.1.
//
// One row per (user_id, model trade_id, broker_account_id) tracking the
// FULL lifecycle of a model-emitted trade against the broker mirror:
//   - What the model intended (qty, legs, direction, mode, instrument)
//   - What the broker actually filled (qty, avg cost, order IDs per
//     action: entry / trim / exit / SL / TP)
//   - Sync state machine (pending / in_sync / partial_fill / broker_orphan
//     / mothership_orphan / expired / rejected / mirror_suppressed /
//     reconcile_error / untracked)
//   - Suppression flag + notification audit
//
// THIS PR IS WRITER-ONLY. The reconciler (Phase C) and the manifest-
// aware reducer (Phase B) ship separately. Goal here: populate the
// manifest on every ENTRY/ADD so Phase B can read it.
//
// Behavioral invariants:
//   - Insert is idempotent on (user_id, trade_id, broker_account_id);
//     re-emit of the same entry only updates the row.
//   - Insert NEVER throws — the bridge's primary job is to place the
//     order; if the manifest write fails, we log a warning and continue.
//     A missing manifest row will be re-discovered by the reconciler.
//   - Mirror suppression (sync_state='mirror_suppressed') is operator-
//     set; the writer never flips that state.

import { resolveBrokerAccountId } from "./bridge-brokers.js";

const SCHEMA_DDL = [
  `CREATE TABLE IF NOT EXISTS mirror_trade_manifest (
    user_id                  TEXT NOT NULL,
    trade_id                 TEXT NOT NULL,
    broker_account_id        TEXT NOT NULL,
    broker                   TEXT NOT NULL,

    mode                     TEXT NOT NULL,
    instrument_type          TEXT NOT NULL,
    options_structure        TEXT,

    ticker                   TEXT NOT NULL,
    direction                TEXT NOT NULL,
    setup_name               TEXT,
    model_intended_qty       REAL NOT NULL,
    model_intended_legs      TEXT,
    model_entry_ts           INTEGER NOT NULL,
    model_status             TEXT NOT NULL,
    model_exit_ts            INTEGER,
    model_exit_reason        TEXT,

    dca_tranches             TEXT,

    broker_filled_qty        REAL DEFAULT 0,
    broker_remaining_qty     REAL DEFAULT 0,
    broker_avg_cost          REAL,
    broker_realized_pnl_usd  REAL DEFAULT 0,
    broker_last_known_state  TEXT,
    broker_last_seen_at      INTEGER,

    broker_entry_order_ids   TEXT,
    broker_trim_order_ids    TEXT,
    broker_exit_order_ids    TEXT,
    broker_sl_order_id       TEXT,
    broker_tp_order_ids      TEXT,

    sync_state               TEXT NOT NULL DEFAULT 'pending',
    sync_last_checked_at     INTEGER,
    sync_last_drift_at       INTEGER,
    sync_drift_count         INTEGER DEFAULT 0,
    sync_note                TEXT,

    mirror_suppressed        INTEGER DEFAULT 0,
    mirror_suppressed_at     INTEGER,
    mirror_suppressed_reason TEXT,

    last_user_notified_at    INTEGER,
    notification_severity    TEXT,

    created_at               INTEGER NOT NULL,
    updated_at               INTEGER NOT NULL,

    PRIMARY KEY (user_id, trade_id, broker_account_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_mtm_user_state ON mirror_trade_manifest(user_id, sync_state)`,
  // Partial indexes — D1 supports the WHERE clause; helps the reconciler
  // skip CLOSED/EXPIRED rows when scanning for open trades.
  `CREATE INDEX IF NOT EXISTS idx_mtm_user_open  ON mirror_trade_manifest(user_id, mode)`,
  `CREATE INDEX IF NOT EXISTS idx_mtm_ticker_user ON mirror_trade_manifest(user_id, ticker)`,
  `CREATE INDEX IF NOT EXISTS idx_mtm_drift      ON mirror_trade_manifest(sync_last_drift_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_mtm_options_exp ON mirror_trade_manifest(user_id, model_status)`,
  `CREATE INDEX IF NOT EXISTS idx_mtm_updated    ON mirror_trade_manifest(updated_at DESC)`,
];

// 2026-07-27 — Post-execution reducer audit column, added via ALTER TABLE
// (wrapped in try/catch — safe when the column already exists per
// tasks/lessons.md D1 rules). Stores JSON snapshot of the LAST placed
// reducer's expectation: { ts, kind, intended_qty, pre_held_qty,
// expected_post_held_qty, client_order_id, broker_order_id, verified,
// verified_at, drift_pct }. The next reconciler cycle compares live
// held vs expected_post_held_qty and clears (or drift-alerts) the row.
const SCHEMA_ALTERS = [
  `ALTER TABLE mirror_trade_manifest ADD COLUMN sync_last_action_json TEXT`,
];

let _schemaReady = false;

/**
 * Ensure the manifest table + indexes exist. Idempotent + safe to call
 * on every invocation; the result is cached in-process so we don't
 * re-issue the DDL on every order.
 *
 * Called from ensureBridgeSchema() in bridge-storage.js so the bridge
 * picks it up automatically alongside the bridge_audit table.
 */
export async function ensureMirrorManifestSchema(env) {
  if (_schemaReady) return;
  const db = env?.BRIDGE_DB;
  if (!db) return;
  try {
    for (const ddl of SCHEMA_DDL) {
      await db.prepare(ddl).run();
    }
    // Idempotent column adds — safe to run on every deploy; ignore
    // "duplicate column" errors from D1 when the column already exists
    // (per tasks/lessons.md D1 rules).
    for (const alt of SCHEMA_ALTERS) {
      try {
        await db.prepare(alt).run();
      } catch (e) {
        const msg = String(e?.message || e).toLowerCase();
        if (!msg.includes("duplicate column") && !msg.includes("already exists")) {
          console.warn(`[MANIFEST] ALTER skipped: ${msg.slice(0, 160)}`);
        }
      }
    }
    _schemaReady = true;
  } catch (e) {
    console.warn("[MANIFEST] schema ensure failed:", String(e?.message || e).slice(0, 200));
  }
}

/**
 * Classify a side string into the lifecycle bucket used by the writer.
 * - "entry" / "buy" / "long" / "add" → 'open'   (creates or updates a manifest row)
 * - "trim" / "sell" (with reducing intent) → 'reduce' (Phase B will gate on manifest)
 * - "exit" / "close" → 'close' (Phase B gates; Phase C reconciles)
 * - anything else → 'other' (no manifest action)
 *
 * For Phase A only the 'open' bucket triggers a manifest write. The
 * 'reduce' / 'close' buckets are reserved for Phase B's manifest-aware
 * reducer — this PR does not change reducer behavior.
 */
export function classifyOrderLifecycle(side) {
  const s = String(side || "").toLowerCase();
  if (s === "entry" || s === "buy" || s === "long" || s === "add" || s === "dca_buy") return "open";
  if (s === "trim") return "reduce";
  if (s === "exit" || s === "close" || s === "sell") return "close";
  return "other";
}

/**
 * Infer the instrument shape from the order payload.
 * Equity orders have no `vehicle` field (or vehicle === 'equity_long').
 * Options orders carry vehicle ∈ {long_call, long_put, vertical_spread,
 * leaps, straddle, moonshot}.
 *
 * Returns { instrument_type, options_structure }.
 */
function inferInstrument(payload) {
  const vehicle = payload?.vehicle ? String(payload.vehicle).trim().toLowerCase() : null;
  if (!vehicle || vehicle === "equity_long") {
    return { instrument_type: "equity", options_structure: null };
  }
  return { instrument_type: "options", options_structure: vehicle };
}

/**
 * Upsert a manifest row for an ENTRY/ADD order. Idempotent: a second
 * call with the same (user_id, trade_id, broker_account_id) tuple is
 * treated as an additional tranche of the same trade and only updates
 * mutable fields (model_intended_qty for the active size, updated_at,
 * broker_entry_order_ids on successful place).
 *
 * Best-effort: never throws. Returns { ok, rowid?, action: 'inserted'
 * | 'updated' | 'skipped', reason? }.
 *
 * @param {object} env
 * @param {object} payload   Order payload received at /bridge/order
 * @param {object} user      User record from readUser()
 * @param {object} extras    Optional: { broker_order_id, requested_qty,
 *                                       filled_qty }
 */
export async function writeEntryManifest(env, payload, user, extras = {}) {
  const db = env?.BRIDGE_DB;
  if (!db) return { ok: false, action: "skipped", reason: "no_db" };
  await ensureMirrorManifestSchema(env);

  const lifecycle = classifyOrderLifecycle(payload?.side);
  if (lifecycle !== "open") {
    return { ok: false, action: "skipped", reason: `lifecycle_${lifecycle}_not_open` };
  }
  const userId = String(payload?.user_id || user?.user_id || "").toLowerCase();
  const tradeId = String(payload?.trade_id || "").trim();
  if (!userId || !tradeId) {
    return { ok: false, action: "skipped", reason: "missing_user_id_or_trade_id" };
  }
  // Prefer an explicit account target from the payload; else resolve the
  // agnostic account id from the user row (includes webull_account_id, which
  // the old chain dropped → Webull manifests collapsed to "default").
  const brokerAccountId = String(payload?.broker_account_id || resolveBrokerAccountId(user));
  const broker = String(user?.broker || "ibkr").toLowerCase();
  const ticker = String(payload?.ticker || "").trim().toUpperCase();
  const direction = String(payload?.direction || "LONG").toUpperCase();
  const mode = String(payload?.mode || "trader").toLowerCase();
  const { instrument_type, options_structure } = inferInstrument(payload);
  const modelIntendedQty = Number(payload?.qty) || 0;
  const modelEntryTs = Number(payload?.action_ts || payload?.ts) || Date.now();
  const setupName = payload?.setup_name || null;
  const modelLegs = Array.isArray(payload?.legs) ? payload.legs : null;

  const now = Date.now();
  const entryOrderId = extras?.broker_order_id || payload?.broker_order_id || null;
  const filledQty = Number(extras?.filled_qty) || 0;
  const orderTrackerJson = entryOrderId
    ? JSON.stringify([{
        order_id: entryOrderId,
        ts: now,
        requested_qty: modelIntendedQty,
        filled_qty: filledQty,
      }])
    : null;

  try {
    // Try INSERT first (PK conflict → UPDATE branch).
    const inserted = await db.prepare(`
      INSERT INTO mirror_trade_manifest (
        user_id, trade_id, broker_account_id, broker,
        mode, instrument_type, options_structure,
        ticker, direction, setup_name,
        model_intended_qty, model_intended_legs, model_entry_ts, model_status,
        broker_filled_qty, broker_remaining_qty,
        broker_entry_order_ids,
        sync_state, sync_last_checked_at,
        created_at, updated_at
      ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21)
      ON CONFLICT(user_id, trade_id, broker_account_id) DO NOTHING
    `).bind(
      userId, tradeId, brokerAccountId, broker,
      mode, instrument_type, options_structure,
      ticker, direction, setupName,
      modelIntendedQty, modelLegs ? JSON.stringify(modelLegs) : null, modelEntryTs, "OPEN",
      // broker_remaining_qty = shares now HELD at the broker (what the
      // reconciler/reducer guard clamp against), NOT the unfilled
      // remainder of this order. A fully-filled entry holds filledQty.
      filledQty, filledQty,
      orderTrackerJson,
      filledQty > 0 ? "in_sync" : "pending", now,
      now, now,
    ).run();

    if (inserted?.meta?.changes && inserted.meta.changes > 0) {
      return { ok: true, action: "inserted" };
    }

    // Row already existed — UPDATE the entry-tracker JSON to append
    // this fresh tranche / order ID. Use a merge-then-write because
    // D1 SQLite lacks json_each-style append.
    const existing = await db.prepare(`
      SELECT broker_entry_order_ids, broker_filled_qty, broker_remaining_qty, model_intended_qty
        FROM mirror_trade_manifest
       WHERE user_id=?1 AND trade_id=?2 AND broker_account_id=?3
    `).bind(userId, tradeId, brokerAccountId).first();

    let mergedTracker = [];
    if (existing?.broker_entry_order_ids) {
      try { mergedTracker = JSON.parse(existing.broker_entry_order_ids) || []; } catch (_) {}
    }
    if (entryOrderId && !mergedTracker.some(t => t.order_id === entryOrderId)) {
      mergedTracker.push({
        order_id: entryOrderId, ts: now,
        requested_qty: modelIntendedQty,
        filled_qty: filledQty,
      });
    }
    const newBrokerFilled = Number(existing?.broker_filled_qty || 0) + filledQty;
    const newModelIntended = Math.max(Number(existing?.model_intended_qty || 0), modelIntendedQty);
    // broker_remaining_qty tracks shares HELD at the broker. An entry/ADD
    // fill increases the held position; trims are decremented by the
    // reconciler from live positions (Phase C), not here.
    const newRemaining = Math.max(0, Number(existing?.broker_remaining_qty || 0)) + filledQty;
    await db.prepare(`
      UPDATE mirror_trade_manifest
         SET model_intended_qty = ?4,
             broker_filled_qty  = ?5,
             broker_remaining_qty = ?8,
             broker_entry_order_ids = ?6,
             sync_state = CASE WHEN ?5 >= ?4 THEN 'in_sync' ELSE sync_state END,
             updated_at = ?7
       WHERE user_id=?1 AND trade_id=?2 AND broker_account_id=?3
    `).bind(
      userId, tradeId, brokerAccountId,
      newModelIntended, newBrokerFilled,
      mergedTracker.length > 0 ? JSON.stringify(mergedTracker) : null,
      now,
      newRemaining,
    ).run();
    return { ok: true, action: "updated" };
  } catch (e) {
    // Never block the order flow on a manifest write failure.
    console.warn(`[MANIFEST] writeEntryManifest failed for ${userId}/${tradeId}:`,
      String(e?.message || e).slice(0, 200));
    return { ok: false, action: "skipped", reason: `write_error:${String(e?.message || e).slice(0, 80)}` };
  }
}

/**
 * Mark a manifest row as 'rejected' + suppress future mirrors.
 *
 * Called when preflightOrder rejects an ENTRY (the row should still be
 * recorded so the reconciler doesn't think there's an orphan, and so
 * Phase B can return a 'mirror_suppressed' reject reason for any
 * follow-on TRIM/EXIT on this trade_id).
 */
export async function writeRejectedEntry(env, payload, user, rejectReason) {
  const db = env?.BRIDGE_DB;
  if (!db) return { ok: false, action: "skipped", reason: "no_db" };
  await ensureMirrorManifestSchema(env);
  const lifecycle = classifyOrderLifecycle(payload?.side);
  if (lifecycle !== "open") return { ok: false, action: "skipped", reason: "not_an_entry" };
  const userId = String(payload?.user_id || user?.user_id || "").toLowerCase();
  const tradeId = String(payload?.trade_id || "").trim();
  if (!userId || !tradeId) return { ok: false, action: "skipped", reason: "missing_user_id_or_trade_id" };
  const brokerAccountId = String(payload?.broker_account_id || resolveBrokerAccountId(user));
  const broker = String(user?.broker || "ibkr").toLowerCase();
  const ticker = String(payload?.ticker || "").trim().toUpperCase();
  const direction = String(payload?.direction || "LONG").toUpperCase();
  const mode = String(payload?.mode || "trader").toLowerCase();
  const { instrument_type, options_structure } = inferInstrument(payload);
  const modelIntendedQty = Number(payload?.qty) || 0;
  const modelEntryTs = Number(payload?.action_ts || payload?.ts) || Date.now();
  const now = Date.now();

  try {
    await db.prepare(`
      INSERT INTO mirror_trade_manifest (
        user_id, trade_id, broker_account_id, broker,
        mode, instrument_type, options_structure,
        ticker, direction, model_intended_qty, model_entry_ts, model_status,
        sync_state, mirror_suppressed, mirror_suppressed_at,
        mirror_suppressed_reason, sync_note,
        created_at, updated_at
      ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19)
      ON CONFLICT(user_id, trade_id, broker_account_id) DO UPDATE SET
        sync_state = excluded.sync_state,
        mirror_suppressed = excluded.mirror_suppressed,
        mirror_suppressed_at = excluded.mirror_suppressed_at,
        mirror_suppressed_reason = excluded.mirror_suppressed_reason,
        sync_note = excluded.sync_note,
        updated_at = excluded.updated_at
    `).bind(
      userId, tradeId, brokerAccountId, broker,
      mode, instrument_type, options_structure,
      ticker, direction, modelIntendedQty, modelEntryTs, "OPEN",
      "rejected", 1, now,
      String(rejectReason || "preflight_rejected").slice(0, 200),
      `Entry rejected at preflight: ${String(rejectReason || "").slice(0, 160)}`,
      now, now,
    ).run();
    return { ok: true, action: "rejected_logged" };
  } catch (e) {
    console.warn(`[MANIFEST] writeRejectedEntry failed for ${userId}/${tradeId}:`,
      String(e?.message || e).slice(0, 200));
    return { ok: false, action: "skipped", reason: `write_error:${String(e?.message || e).slice(0, 80)}` };
  }
}

/**
 * Read a manifest row by composite key. Returns null if missing or on
 * DB error. Used by the MC debug view (and Phase B's reducer).
 */
export async function readManifestRow(env, userId, tradeId, brokerAccountId) {
  const db = env?.BRIDGE_DB;
  if (!db) return null;
  await ensureMirrorManifestSchema(env);
  const uid = String(userId).toLowerCase();
  const acct = String(brokerAccountId || "default");
  const tid = String(tradeId);
  try {
    let row = await db.prepare(`
      SELECT * FROM mirror_trade_manifest
       WHERE user_id=?1 AND trade_id=?2 AND broker_account_id=?3
    `).bind(uid, tid, acct).first();
    if (!row) {
      // 2026-07-27 — legacy trade_id prefix alias. Investor DCAs prior to
      // the client_order_id / trade_id normalization sat in the manifest
      // as `inv-inv-<pos_id>` while the current forwardInvestorMirror
      // writes `inv-<pos_id>`. Any reducer/close/reconcile against a
      // legacy row would miss and hard-reject `no_manifest_for_trade`
      // (KO PRE_EARNINGS trim, Jul 27). Try the flipped prefix once
      // before returning null. New writes are single-prefix by design;
      // this is a read-side compat shim that costs one extra query only
      // when the direct lookup misses.
      const altTid = tid.startsWith("inv-inv-")
        ? tid.replace(/^inv-inv-/, "inv-")
        : (tid.startsWith("inv-") ? tid.replace(/^inv-/, "inv-inv-") : null);
      if (altTid) {
        row = await db.prepare(`
          SELECT * FROM mirror_trade_manifest
           WHERE user_id=?1 AND trade_id=?2 AND broker_account_id=?3
        `).bind(uid, altTid, acct).first();
      }
    }
    return row ? _expandJsonCols(row) : null;
  } catch (e) {
    console.warn(`[MANIFEST] readManifestRow failed:`,
      String(e?.message || e).slice(0, 200));
    return null;
  }
}

/**
 * Read recent manifest rows for the operator debug view.
 *
 * @param {object} env
 * @param {object} opts  { user_id?, limit=50, since_ms? }
 * @returns {Array<object>} rows ordered by updated_at DESC
 */
export async function recentManifestRows(env, opts = {}) {
  const db = env?.BRIDGE_DB;
  if (!db) return [];
  await ensureMirrorManifestSchema(env);
  const userId = opts.user_id ? String(opts.user_id).toLowerCase() : null;
  const limit = Math.max(1, Math.min(500, Number(opts.limit) || 50));
  const sinceMs = Number(opts.since_ms) || 0;
  try {
    let q, b;
    if (userId && sinceMs > 0) {
      q = `SELECT * FROM mirror_trade_manifest
            WHERE user_id = ?1 AND updated_at >= ?2
            ORDER BY updated_at DESC LIMIT ?3`;
      b = [userId, sinceMs, limit];
    } else if (userId) {
      q = `SELECT * FROM mirror_trade_manifest
            WHERE user_id = ?1
            ORDER BY updated_at DESC LIMIT ?2`;
      b = [userId, limit];
    } else if (sinceMs > 0) {
      q = `SELECT * FROM mirror_trade_manifest
            WHERE updated_at >= ?1
            ORDER BY updated_at DESC LIMIT ?2`;
      b = [sinceMs, limit];
    } else {
      q = `SELECT * FROM mirror_trade_manifest
            ORDER BY updated_at DESC LIMIT ?1`;
      b = [limit];
    }
    const r = await db.prepare(q).bind(...b).all().catch(() => ({ results: [] }));
    // Expand JSON-encoded columns so the MC table renders cleanly.
    return (r?.results || []).map(_expandJsonCols);
  } catch (e) {
    console.warn(`[MANIFEST] recentManifestRows failed:`,
      String(e?.message || e).slice(0, 200));
    return [];
  }
}

function _expandJsonCols(row) {
  if (!row) return row;
  for (const k of [
    "model_intended_legs",
    "dca_tranches",
    "broker_entry_order_ids",
    "broker_trim_order_ids",
    "broker_exit_order_ids",
    "broker_tp_order_ids",
    "broker_last_known_state",
    "sync_last_action_json",
  ]) {
    if (typeof row[k] === "string" && row[k].length > 0) {
      try { row[k] = JSON.parse(row[k]); } catch (_) { /* leave as string */ }
    }
  }
  return row;
}

// ─────────────────────────────────────────────────────────────────────
// 2026-07-27 — Post-execution reducer audit
// ─────────────────────────────────────────────────────────────────────
//
// After every successful reducer (TRIM / EXIT / CLOSE) place, we stamp
// the manifest row with a snapshot of what the bridge INTENDED to
// happen: pre-held qty (verified from live positions milliseconds
// before order placement), the reconciled intended qty, the expected
// post-execution held qty, and the broker order id. The next reconciler
// cycle (after a short verify-wait window) reads live broker held vs
// `expected_post_held_qty` and either:
//
//   1. Clears the audit + marks in_sync when live matches expected
//      within a tight tolerance (broker did what we asked).
//   2. Emits a `post_exec_drift` notification + leaves the audit
//      populated so an operator can retry / investigate.
//
// This is the "did our action result in what we expected?" contract
// the operator asked for — every model-fired reducer signal now has
// a first-class execution receipt attached to its manifest row.
//
// The audit is intentionally single-slot per row (last action wins).
// A second reducer against the same trade before the first has been
// verified is uncommon (blocked by manifest enforcement in most cases)
// and would overwrite the prior expectation with the newer one — the
// reconciler still compares live held against the LATEST intent, which
// is the correct behavior.

// Verification cannot fire immediately — the broker needs time to
// route/fill and the fill reconciler needs time to snapshot. We defer
// the first check until at least this many ms after the audit was
// written; earlier reconciler passes will skip the row. 2 min is
// tight enough to catch a blocked order the same session, loose
// enough to survive routine broker latency + our 5-min reconcile cron.
export const POST_EXEC_VERIFY_DELAY_MS = 2 * 60 * 1000;
// Tolerance on the (expected_post_held_qty - live_held_qty) diff, in
// shares. Broker fill precision (~0.00001 sh on Webull) plus tiny
// dust routinely creates a fractional delta; anything larger than
// this is a real execution gap we alert on.
export const POST_EXEC_TOLERANCE_QTY = 0.05;

/**
 * Stamp the last-action expectation onto a manifest row. Best-effort:
 * never throws. Called immediately after a successful reducer place
 * from bridge-index.js so the reconciler can verify the outcome.
 *
 * @param {object} env
 * @param {object} args
 *   @property {string} userId          Manifest user_id (mirror owner)
 *   @property {string} tradeId
 *   @property {string} brokerAccountId
 *   @property {string} kind            'trim' | 'exit' | 'close' | 'sell' | 'reduce'
 *   @property {number} preHeldQty      Broker-verified held qty before the reducer
 *   @property {number} intendedQty     Reconciled qty that was actually placed
 *   @property {string} [clientOrderId]
 *   @property {string} [brokerOrderId]
 *   @property {object} [reasons]       Snapshot of recon.reasons / meta
 * @returns {Promise<{ok:boolean, action?:string, reason?:string}>}
 */
export async function writeLastActionAudit(env, args = {}) {
  const db = env?.BRIDGE_DB;
  if (!db) return { ok: false, action: "skipped", reason: "no_db" };
  await ensureMirrorManifestSchema(env);

  const userId = String(args?.userId || "").toLowerCase();
  const tradeId = String(args?.tradeId || "").trim();
  const brokerAccountId = String(args?.brokerAccountId || "default");
  if (!userId || !tradeId) {
    return { ok: false, action: "skipped", reason: "missing_user_id_or_trade_id" };
  }

  const preHeld = Number(args?.preHeldQty);
  const intended = Number(args?.intendedQty);
  if (!Number.isFinite(preHeld) || !Number.isFinite(intended) || intended <= 0) {
    return { ok: false, action: "skipped", reason: "bad_qty_inputs" };
  }
  const expectedPostHeld = Math.max(0, preHeld - intended);
  const now = Date.now();
  const snapshot = {
    ts: now,
    kind: String(args?.kind || "").toLowerCase(),
    intended_qty: intended,
    pre_held_qty: preHeld,
    expected_post_held_qty: expectedPostHeld,
    client_order_id: args?.clientOrderId || null,
    broker_order_id: args?.brokerOrderId || null,
    reasons: args?.reasons || null,
    verify_after_ms: now + POST_EXEC_VERIFY_DELAY_MS,
    verified: false,
    verified_at: null,
    drift_qty: null,
  };

  try {
    const res = await db.prepare(`
      UPDATE mirror_trade_manifest
         SET sync_last_action_json = ?4,
             updated_at = ?5
       WHERE user_id = ?1 AND trade_id = ?2 AND broker_account_id = ?3
    `).bind(userId, tradeId, brokerAccountId, JSON.stringify(snapshot), now).run();
    const changes = res?.meta?.changes ?? 0;
    if (changes > 0) return { ok: true, action: "stamped" };

    // Reader-side alias parity — mirror the inv-*/inv-inv-* fallback
    // in readManifestRow so a legacy DCA row still receives the audit.
    const altTid = tradeId.startsWith("inv-inv-")
      ? tradeId.replace(/^inv-inv-/, "inv-")
      : (tradeId.startsWith("inv-") ? tradeId.replace(/^inv-/, "inv-inv-") : null);
    if (altTid) {
      const alt = await db.prepare(`
        UPDATE mirror_trade_manifest
           SET sync_last_action_json = ?4,
               updated_at = ?5
         WHERE user_id = ?1 AND trade_id = ?2 AND broker_account_id = ?3
      `).bind(userId, altTid, brokerAccountId, JSON.stringify(snapshot), now).run();
      if ((alt?.meta?.changes ?? 0) > 0) return { ok: true, action: "stamped_alias" };
    }
    return { ok: false, action: "skipped", reason: "no_matching_row" };
  } catch (e) {
    console.warn(`[MANIFEST] writeLastActionAudit failed for ${userId}/${tradeId}:`,
      String(e?.message || e).slice(0, 200));
    return { ok: false, action: "skipped", reason: `write_error:${String(e?.message || e).slice(0, 80)}` };
  }
}

/**
 * Mark a last-action audit as verified (live held converged to
 * expected within tolerance). Populates `verified`, `verified_at`,
 * `drift_qty` on the existing snapshot.
 *
 * @param {object} env
 * @param {object} row     Manifest row (already read; caller passes
 *                         the parsed sync_last_action_json).
 * @param {number} liveHeldQty
 * @returns {Promise<boolean>}
 */
export async function markLastActionVerified(env, row, liveHeldQty) {
  const db = env?.BRIDGE_DB;
  if (!db) return false;
  const audit = _parseAudit(row?.sync_last_action_json);
  if (!audit) return false;
  const drift = (Number(liveHeldQty) || 0) - (Number(audit.expected_post_held_qty) || 0);
  const now = Date.now();
  const updated = { ...audit, verified: true, verified_at: now, drift_qty: drift };
  try {
    await db.prepare(`
      UPDATE mirror_trade_manifest
         SET sync_last_action_json = ?4,
             updated_at = ?5
       WHERE user_id = ?1 AND trade_id = ?2 AND broker_account_id = ?3
    `).bind(row.user_id, row.trade_id, row.broker_account_id, JSON.stringify(updated), now).run();
    return true;
  } catch (e) {
    console.warn(`[MANIFEST] markLastActionVerified failed for ${row?.user_id}/${row?.trade_id}:`,
      String(e?.message || e).slice(0, 200));
    return false;
  }
}

/**
 * Stamp a drift on the last-action audit (live held did NOT converge
 * to expected within tolerance). Preserves the original expectation
 * so the operator can see intended vs actual side-by-side; sets
 * `drift_qty` + `drift_detected_at` and leaves `verified=false` so
 * follow-up reconciler passes re-check (the drift may self-heal on
 * the next fill snapshot).
 */
export async function markLastActionDrift(env, row, liveHeldQty) {
  const db = env?.BRIDGE_DB;
  if (!db) return false;
  const audit = _parseAudit(row?.sync_last_action_json);
  if (!audit) return false;
  const drift = (Number(liveHeldQty) || 0) - (Number(audit.expected_post_held_qty) || 0);
  const now = Date.now();
  const updated = {
    ...audit,
    verified: false,
    verified_at: null,
    drift_qty: drift,
    drift_detected_at: now,
    live_held_qty: Number(liveHeldQty) || 0,
  };
  try {
    await db.prepare(`
      UPDATE mirror_trade_manifest
         SET sync_last_action_json = ?4,
             updated_at = ?5
       WHERE user_id = ?1 AND trade_id = ?2 AND broker_account_id = ?3
    `).bind(row.user_id, row.trade_id, row.broker_account_id, JSON.stringify(updated), now).run();
    return true;
  } catch (e) {
    console.warn(`[MANIFEST] markLastActionDrift failed for ${row?.user_id}/${row?.trade_id}:`,
      String(e?.message || e).slice(0, 200));
    return false;
  }
}

function _parseAudit(raw) {
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  if (typeof raw !== "string") return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

/**
 * Extract the parsed audit snapshot from a manifest row. Returns null
 * if the row has no audit stamped, or the JSON is unparseable.
 */
export function readLastActionAudit(row) {
  return _parseAudit(row?.sync_last_action_json);
}

/**
 * Mark a trade as model-CLOSED in the manifest. Called from the model
 * side when an EXIT fires (Phase B will wire this up — for now just
 * exported so callers can use it incrementally).
 */
export async function markManifestModelClosed(env, userId, tradeId, brokerAccountId, { exitReason, exitTs } = {}) {
  const db = env?.BRIDGE_DB;
  if (!db) return false;
  await ensureMirrorManifestSchema(env);
  try {
    await db.prepare(`
      UPDATE mirror_trade_manifest
         SET model_status = 'CLOSED',
             model_exit_ts = ?4,
             model_exit_reason = ?5,
             updated_at = ?4
       WHERE user_id = ?1 AND trade_id = ?2 AND broker_account_id = ?3
    `).bind(
      String(userId).toLowerCase(), String(tradeId), String(brokerAccountId || "default"),
      Number(exitTs) || Date.now(),
      String(exitReason || "exit").slice(0, 200),
    ).run();
    return true;
  } catch (e) {
    console.warn(`[MANIFEST] markManifestModelClosed failed:`,
      String(e?.message || e).slice(0, 200));
    return false;
  }
}
