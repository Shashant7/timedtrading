// worker-bridge/bridge-reconciler.js
//
// 2026-06-01 — Phase C of the trade-aware mirror sync (PR sequence
// after #412 / #414 / #415). Per tasks/2026-06-01-trade-aware-mirror-
// sync-design.md §5.
//
// What this module does
// ─────────────────────────────────────────────────────────────────────
// Every ~5 minutes during operating hours (and on-demand via
// POST /bridge/reconcile?user_id=X), this module:
//
//   1. Reads every OPEN manifest row for a user
//   2. Fetches the user's broker positions (equity for now; options
//      added in Phase D)
//   3. Compares manifest.broker_remaining_qty vs broker actual qty
//   4. Updates manifest fields (broker_filled_qty, broker_remaining_qty,
//      broker_avg_cost, broker_last_known_state, broker_last_seen_at,
//      sync_state, sync_last_checked_at)
//   5. Classifies drift per §6 and bumps sync_drift_count
//   6. Auto-suppresses on chronic drift (drift_count > 3) and on
//      mothership_orphan
//   7. Emits a summary stats object the caller (cron handler) logs +
//      surfaces in Mission Control
//
// What this module does NOT do (Phase D / Phase E)
// ─────────────────────────────────────────────────────────────────────
//   - Options leg-aware reconciliation (Phase D)
//   - Auto-retry of broker-orphan exits (Phase D)
//   - User notifications (Phase E)
//   - Daily owner email (Phase E)
//
// Failure behavior
// ─────────────────────────────────────────────────────────────────────
//   - Broker API failure → set sync_state='reconcile_error', bump
//     drift count; after 3 consecutive failures the row is flagged
//     for operator attention (Phase E).
//   - D1 read/write failure → log + continue with next row. Reconciler
//     is best-effort; missed cycles recover on the next run.
//   - Schema mismatch (e.g. column missing) → caught and logged once
//     per process; subsequent rows continue.

import { ensureMirrorManifestSchema } from "./bridge-manifest.js";

const TOLERANCE = {
  trader_equity: 0.01,
  trader_options: 0.0,    // any drift on options counts
  investor_equity_abs: 0.1,
  investor_equity_pct: 0.01,
  investor_options: 0.0,
};

// Cap on rows scanned per user per cycle so a runaway operator with
// hundreds of open trades doesn't blow the cron budget. The remainder
// rolls over to the next cycle (ORDER BY sync_last_checked_at ASC NULLS FIRST).
const MAX_ROWS_PER_USER_PER_CYCLE = 100;

// Drift classifications from §6.
const SYNC_STATES = {
  IN_SYNC: "in_sync",
  PARTIAL_FILL: "partial_fill",
  BROKER_ORPHAN: "broker_orphan",
  MOTHERSHIP_ORPHAN: "mothership_orphan",
  EXPIRED: "expired",
  RECONCILE_ERROR: "reconcile_error",
  UNTRACKED: "untracked",
  // pending / rejected / mirror_suppressed are writer-set; the
  // reconciler doesn't transition INTO them.
};

const AUTO_SUPPRESS_AFTER_DRIFT = 3;

/**
 * Normalize a broker position object into { qty, avgCost }. Different
 * broker adapters return different shapes — try every field we've seen.
 */
function _normalizePos(p) {
  if (!p) return null;
  return {
    qty: Number(p.position ?? p.qty ?? p.quantity ?? p.size ?? 0),
    avgCost: Number(p.avgCost ?? p.avg_cost ?? p.avgPrice ?? p.avg_price ?? 0),
  };
}

/**
 * Build a ticker→position map from broker positions array.
 * @param {Array} positions  Adapter-returned positions
 * @returns {Map<string, {qty, avgCost}>}
 */
function _indexByTicker(positions) {
  const out = new Map();
  if (!Array.isArray(positions)) return out;
  for (const p of positions) {
    if (!p) continue;
    const ticker = String(
      p.contractDesc ?? p.symbol ?? p.ticker ?? p.instrument_symbol ?? ""
    ).toUpperCase();
    if (!ticker) continue;
    const norm = _normalizePos(p);
    if (!norm) continue;
    // Merge across multiple position rows for the same ticker (some
    // brokers return one row per lot).
    const existing = out.get(ticker);
    if (existing) {
      const newQty = existing.qty + norm.qty;
      const weighted = (existing.qty * existing.avgCost) + (norm.qty * norm.avgCost);
      out.set(ticker, {
        qty: newQty,
        avgCost: newQty > 0 ? weighted / newQty : 0,
      });
    } else {
      out.set(ticker, norm);
    }
  }
  return out;
}

/**
 * Classify drift for a single open manifest row. Returns
 * { sync_state, drift_detected, severity, note, broker_state }.
 *
 * @param {object} row    Manifest row
 * @param {object} brokerState  { qty, avgCost } | null (null = ticker
 *                              not in broker positions)
 * @param {object} cfg    { tolerance, mode }
 */
export function classifyDrift(row, brokerState, cfg = {}) {
  const tolerance = Number(cfg.tolerance) || TOLERANCE.trader_equity;
  const modelStatus = String(row.model_status || "OPEN").toUpperCase();
  const modelQty = Number(row.model_intended_qty) || 0;
  const expectedBrokerQty = Number(row.broker_remaining_qty);
  // If broker_remaining_qty is 0/null (e.g. brand-new row before fill),
  // fall back to model_intended_qty as the expected.
  const expected = (Number.isFinite(expectedBrokerQty) && expectedBrokerQty > 0)
    ? expectedBrokerQty
    : modelQty;

  const brokerQty = Number(brokerState?.qty) || 0;
  const brokerAvgCost = Number(brokerState?.avgCost) || 0;

  // Model has been CLOSED — either broker_orphan (broker still holds)
  // or in_sync (broker also flat). This branch handles both so we don't
  // fall through to the partial_fill calc with a stale expected qty.
  if (modelStatus === "CLOSED" || modelStatus === "EXPIRED") {
    if (brokerQty > tolerance) {
      return {
        sync_state: SYNC_STATES.BROKER_ORPHAN,
        drift_detected: true,
        severity: _orphanSeverity(row),
        note: `model_${modelStatus.toLowerCase()} but broker holds ${brokerQty}`,
        broker_state: { qty: brokerQty, avgCost: brokerAvgCost, expected: 0 },
      };
    }
    return {
      sync_state: SYNC_STATES.IN_SYNC,
      drift_detected: false,
      severity: "info",
      note: `model_${modelStatus.toLowerCase()} and broker flat — consistent`,
      broker_state: { qty: 0, avgCost: 0, expected: 0 },
    };
  }

  // Model OPEN, broker has nothing → mothership_orphan
  if (modelStatus === "OPEN" && brokerQty < tolerance) {
    // Caveat: a brand-new pending row may not have hit the broker yet.
    // Only flag mothership_orphan if expected > 0 (we believed the
    // broker should be holding something).
    if (expected > tolerance) {
      return {
        sync_state: SYNC_STATES.MOTHERSHIP_ORPHAN,
        drift_detected: true,
        severity: "warn",
        note: `model_open expected ${expected} but broker holds 0 (user closed manually?)`,
        broker_state: { qty: 0, avgCost: 0, expected },
      };
    }
    // Expected is 0 and broker is 0 → pending entry, no drift yet.
    return {
      sync_state: row.sync_state || SYNC_STATES.IN_SYNC,
      drift_detected: false,
      severity: "info",
      note: "pending_entry_no_broker_position_yet",
      broker_state: { qty: 0, avgCost: 0, expected },
    };
  }

  // Both OPEN — compare qty
  const diff = Math.abs(brokerQty - expected);
  if (diff <= tolerance) {
    return {
      sync_state: SYNC_STATES.IN_SYNC,
      drift_detected: false,
      severity: "info",
      note: `match within tolerance (${diff.toFixed(2)} <= ${tolerance})`,
      broker_state: { qty: brokerQty, avgCost: brokerAvgCost, expected },
    };
  }

  // Drift — partial fill if broker < expected; if broker > expected
  // it's likely the user added shares (which is fine — we treat the
  // excess as untracked).
  if (brokerQty < expected) {
    return {
      sync_state: SYNC_STATES.PARTIAL_FILL,
      drift_detected: true,
      severity: "warn",
      note: `partial: broker ${brokerQty} < expected ${expected} (diff ${diff.toFixed(2)})`,
      broker_state: { qty: brokerQty, avgCost: brokerAvgCost, expected },
    };
  }
  // brokerQty > expected → user added shares (untracked delta).
  return {
    sync_state: SYNC_STATES.IN_SYNC, // don't reject; user owns excess
    drift_detected: false,
    severity: "info",
    note: `broker ${brokerQty} > expected ${expected} (user-added excess; ignored)`,
    broker_state: { qty: brokerQty, avgCost: brokerAvgCost, expected, user_added: brokerQty - expected },
  };
}

function _orphanSeverity(row) {
  const exitTs = Number(row.model_exit_ts) || 0;
  if (exitTs > 0 && Date.now() - exitTs > 24 * 60 * 60 * 1000) return "critical";
  return "warn";
}

/**
 * Read OPEN (or never-checked) manifest rows for a user, ordered by
 * sync_last_checked_at ASC NULLS FIRST so we always make progress.
 */
async function _readOpenRowsForUser(env, userId, limit) {
  const db = env?.BRIDGE_DB;
  if (!db) return [];
  await ensureMirrorManifestSchema(env);
  try {
    // Skip expired + rejected + mirror_suppressed rows — those are
    // terminal states the reconciler doesn't transition out of.
    const r = await db.prepare(`
      SELECT * FROM mirror_trade_manifest
       WHERE user_id = ?1
         AND model_status IN ('OPEN','CLOSED')
         AND sync_state NOT IN ('expired','rejected','mirror_suppressed')
       ORDER BY COALESCE(sync_last_checked_at, 0) ASC
       LIMIT ?2
    `).bind(String(userId).toLowerCase(), Math.max(1, Math.min(500, Number(limit) || 100))).all().catch(() => ({ results: [] }));
    return r?.results || [];
  } catch (e) {
    console.warn(`[RECONCILER] read rows failed for ${userId}:`,
      String(e?.message || e).slice(0, 200));
    return [];
  }
}

/**
 * Persist the reconciliation result for one row. Best-effort; logs +
 * continues on DB error.
 */
async function _persistRowUpdate(env, row, classification) {
  const db = env?.BRIDGE_DB;
  if (!db) return false;
  const now = Date.now();
  const brokerState = classification.broker_state || {};
  const newSyncState = classification.sync_state;
  const driftDetected = !!classification.drift_detected;
  const wasDrifting = String(row.sync_state || "") !== "in_sync"
    && String(row.sync_state || "") !== "pending";
  const stillDriftingOrNew = driftDetected
    && (newSyncState !== "in_sync");
  // Bump drift count when:
  //   - drift was detected on this cycle, AND
  //   - the sync_state CHANGED (transition into a new drift class) OR
  //     this is the same drift class as last cycle (chronic).
  const bumpDrift = stillDriftingOrNew && (
    String(row.sync_state || "") === newSyncState || // chronic
    !wasDrifting                                     // new
  );
  const newDriftCount = (Number(row.sync_drift_count) || 0) + (bumpDrift ? 1 : 0);
  const shouldAutoSuppress = bumpDrift
    && newDriftCount > AUTO_SUPPRESS_AFTER_DRIFT
    && Number(row.mirror_suppressed) !== 1;
  const newSuppressed = shouldAutoSuppress ? 1 : Number(row.mirror_suppressed || 0);
  const newSuppressedReason = shouldAutoSuppress
    ? `auto_suppressed_after_${newDriftCount}_drifts:${newSyncState}`
    : (row.mirror_suppressed_reason || null);
  const newSuppressedAt = shouldAutoSuppress ? now : (row.mirror_suppressed_at || null);
  const noteShort = String(classification.note || "").slice(0, 200);
  try {
    await db.prepare(`
      UPDATE mirror_trade_manifest
         SET broker_filled_qty = COALESCE(?4, broker_filled_qty),
             broker_remaining_qty = COALESCE(?5, broker_remaining_qty),
             broker_avg_cost = COALESCE(?6, broker_avg_cost),
             broker_last_known_state = ?7,
             broker_last_seen_at = ?8,
             sync_state = ?9,
             sync_last_checked_at = ?8,
             sync_last_drift_at = CASE WHEN ?10 = 1 THEN ?8 ELSE sync_last_drift_at END,
             sync_drift_count = ?11,
             sync_note = ?12,
             mirror_suppressed = ?13,
             mirror_suppressed_at = ?14,
             mirror_suppressed_reason = ?15,
             updated_at = ?8
       WHERE user_id = ?1 AND trade_id = ?2 AND broker_account_id = ?3
    `).bind(
      row.user_id, row.trade_id, row.broker_account_id,
      Number.isFinite(brokerState.qty) ? brokerState.qty : null,
      Number.isFinite(brokerState.qty) && Number.isFinite(brokerState.expected)
        ? Math.max(0, brokerState.expected - 0) // remaining = expected (already-filled view), keep last known qty
        : null,
      Number.isFinite(brokerState.avgCost) ? brokerState.avgCost : null,
      JSON.stringify(brokerState).slice(0, 4000),
      now,
      newSyncState,
      bumpDrift ? 1 : 0,
      newDriftCount,
      noteShort,
      newSuppressed,
      newSuppressedAt,
      newSuppressedReason ? String(newSuppressedReason).slice(0, 200) : null,
    ).run();
    return true;
  } catch (e) {
    console.warn(`[RECONCILER] persist failed for ${row.user_id}/${row.trade_id}:`,
      String(e?.message || e).slice(0, 200));
    return false;
  }
}

/**
 * Mark a manifest row reconcile_error after a broker fetch failure.
 */
async function _persistReconcileError(env, row, errMsg) {
  const db = env?.BRIDGE_DB;
  if (!db) return false;
  const now = Date.now();
  const newDriftCount = (Number(row.sync_drift_count) || 0) + 1;
  try {
    await db.prepare(`
      UPDATE mirror_trade_manifest
         SET sync_state = 'reconcile_error',
             sync_last_checked_at = ?4,
             sync_last_drift_at = ?4,
             sync_drift_count = ?5,
             sync_note = ?6,
             updated_at = ?4
       WHERE user_id = ?1 AND trade_id = ?2 AND broker_account_id = ?3
    `).bind(
      row.user_id, row.trade_id, row.broker_account_id, now, newDriftCount,
      String(errMsg || "reconcile_error").slice(0, 200),
    ).run();
    return true;
  } catch (e) {
    console.warn(`[RECONCILER] error-persist failed for ${row.user_id}/${row.trade_id}:`,
      String(e?.message || e).slice(0, 200));
    return false;
  }
}

/**
 * Reconcile a single user against their broker.
 *
 * @param {object} env
 * @param {object} user   User record (must have user_id, broker)
 * @param {object} brokerAdapter  { getEquityPositions(env, user) }
 * @param {object} opts   { limit, tolerance?, dryRun? }
 * @returns {object} stats {
 *   user_id, rows_scanned, rows_in_sync, rows_drifting,
 *   rows_auto_suppressed, by_state: { ... }, fetch_error? }
 */
export async function reconcileUser(env, user, brokerAdapter, opts = {}) {
  const userId = String(user?.user_id || "").toLowerCase();
  if (!userId) return { user_id: null, rows_scanned: 0, error: "no_user_id" };

  const rows = await _readOpenRowsForUser(env, userId, opts.limit || MAX_ROWS_PER_USER_PER_CYCLE);
  if (rows.length === 0) {
    return {
      user_id: userId, rows_scanned: 0, rows_in_sync: 0,
      rows_drifting: 0, rows_auto_suppressed: 0, by_state: {},
    };
  }

  // Fetch broker positions ONCE per user (not per row).
  let posRes;
  try {
    posRes = typeof brokerAdapter?.getEquityPositions === "function"
      ? await brokerAdapter.getEquityPositions(env, user)
      : { ok: false, error: "adapter_lacks_getEquityPositions" };
  } catch (e) {
    posRes = { ok: false, error: String(e?.message || e).slice(0, 200) };
  }

  if (!posRes?.ok) {
    // Broker fetch failed — mark every row reconcile_error so the
    // operator can see the cluster of failures and take action.
    let errCount = 0;
    for (const row of rows) {
      if (await _persistReconcileError(env, row, posRes?.error || "broker_fetch_failed")) errCount++;
    }
    return {
      user_id: userId, rows_scanned: rows.length, rows_reconcile_error: errCount,
      fetch_error: String(posRes?.error || "unknown").slice(0, 200),
      by_state: { reconcile_error: errCount },
    };
  }

  const positionsByTicker = _indexByTicker(posRes.positions || posRes.results || []);

  // Per (mode × instrument) tolerance.
  function _tolerance(row) {
    const mode = String(row.mode || "trader").toLowerCase();
    const inst = String(row.instrument_type || "equity").toLowerCase();
    if (mode === "investor" && inst === "equity") return TOLERANCE.investor_equity_abs;
    if (mode === "trader" && inst === "options") return TOLERANCE.trader_options;
    return TOLERANCE.trader_equity;
  }

  const stats = {
    user_id: userId, rows_scanned: rows.length,
    rows_in_sync: 0, rows_drifting: 0, rows_auto_suppressed: 0,
    by_state: {},
  };

  for (const row of rows) {
    // Phase C scope: equity only. Phase D adds options leg-aware checks.
    if (String(row.instrument_type || "").toLowerCase() === "options") {
      // Mark it checked-but-skipped so we don't starve it from the queue.
      const now = Date.now();
      try {
        await env.BRIDGE_DB.prepare(`
          UPDATE mirror_trade_manifest
             SET sync_last_checked_at = ?4, sync_note = 'phase_c_skip_options', updated_at = ?4
           WHERE user_id = ?1 AND trade_id = ?2 AND broker_account_id = ?3
        `).bind(row.user_id, row.trade_id, row.broker_account_id, now).run();
      } catch (_) {}
      stats.by_state["options_skipped_phase_c"] = (stats.by_state["options_skipped_phase_c"] || 0) + 1;
      continue;
    }

    const brokerState = positionsByTicker.get(String(row.ticker || "").toUpperCase()) || null;
    const classification = classifyDrift(row, brokerState, { tolerance: _tolerance(row) });

    if (opts.dryRun) {
      stats.by_state[classification.sync_state] = (stats.by_state[classification.sync_state] || 0) + 1;
      if (classification.drift_detected) stats.rows_drifting++;
      else stats.rows_in_sync++;
      continue;
    }

    await _persistRowUpdate(env, row, classification);
    if (classification.drift_detected) {
      stats.rows_drifting++;
      const newDrift = (Number(row.sync_drift_count) || 0) + 1;
      if (newDrift > AUTO_SUPPRESS_AFTER_DRIFT) stats.rows_auto_suppressed++;
    } else {
      stats.rows_in_sync++;
    }
    stats.by_state[classification.sync_state] = (stats.by_state[classification.sync_state] || 0) + 1;
  }

  return stats;
}

/**
 * Top-level cron entry point. Iterates every connected user, calls
 * reconcileUser, returns aggregate stats. Caller (cron handler) logs
 * the result and surfaces in Mission Control via the manifest debug
 * view.
 *
 * @param {object} env
 * @param {Function} userListFn  async () => [user objects]
 * @param {Function} adapterForUser  (user) => brokerAdapter
 * @param {object} opts   { dryRun? }
 */
export async function reconcileAllUsers(env, userListFn, adapterForUser, opts = {}) {
  const t0 = Date.now();
  let users = [];
  try {
    users = await userListFn();
  } catch (e) {
    return { ok: false, error: `user_list_failed:${String(e?.message || e).slice(0, 200)}`, elapsed_ms: Date.now() - t0 };
  }
  const eligible = users.filter(u => u && u.status === "connected" && u.broker_integration_enabled);
  const perUser = [];
  for (const u of eligible) {
    try {
      const adapter = adapterForUser(u);
      const stats = await reconcileUser(env, u, adapter, opts);
      perUser.push(stats);
    } catch (e) {
      perUser.push({ user_id: u.user_id, error: String(e?.message || e).slice(0, 200) });
    }
  }
  // Aggregate
  const agg = perUser.reduce((acc, s) => {
    acc.rows_scanned += Number(s.rows_scanned) || 0;
    acc.rows_in_sync += Number(s.rows_in_sync) || 0;
    acc.rows_drifting += Number(s.rows_drifting) || 0;
    acc.rows_auto_suppressed += Number(s.rows_auto_suppressed) || 0;
    acc.rows_reconcile_error += Number(s.rows_reconcile_error) || 0;
    return acc;
  }, { rows_scanned: 0, rows_in_sync: 0, rows_drifting: 0, rows_auto_suppressed: 0, rows_reconcile_error: 0 });

  return {
    ok: true,
    users_total: users.length,
    users_eligible: eligible.length,
    per_user: perUser,
    aggregate: agg,
    elapsed_ms: Date.now() - t0,
    dry_run: !!opts.dryRun,
    server_time: Date.now(),
  };
}
