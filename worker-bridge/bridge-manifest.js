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
      filledQty, modelIntendedQty - filledQty,
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
      SELECT broker_entry_order_ids, broker_filled_qty, model_intended_qty
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
    await db.prepare(`
      UPDATE mirror_trade_manifest
         SET model_intended_qty = ?4,
             broker_filled_qty  = ?5,
             broker_remaining_qty = ?4 - ?5,
             broker_entry_order_ids = ?6,
             sync_state = CASE WHEN ?5 >= ?4 THEN 'in_sync' ELSE sync_state END,
             updated_at = ?7
       WHERE user_id=?1 AND trade_id=?2 AND broker_account_id=?3
    `).bind(
      userId, tradeId, brokerAccountId,
      newModelIntended, newBrokerFilled,
      mergedTracker.length > 0 ? JSON.stringify(mergedTracker) : null,
      now,
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
  try {
    const row = await db.prepare(`
      SELECT * FROM mirror_trade_manifest
       WHERE user_id=?1 AND trade_id=?2 AND broker_account_id=?3
    `).bind(
      String(userId).toLowerCase(),
      String(tradeId),
      String(brokerAccountId || "default"),
    ).first();
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
  ]) {
    if (typeof row[k] === "string" && row[k].length > 0) {
      try { row[k] = JSON.parse(row[k]); } catch (_) { /* leave as string */ }
    }
  }
  return row;
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
