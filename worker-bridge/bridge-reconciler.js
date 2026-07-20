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
import { emitDriftNotification } from "./bridge-notifications.js";
import { snapshotAccount } from "./bridge-account-ledger.js";
import { resolveBrokerAccountId, resolveBrokerId } from "./bridge-brokers.js";
import { reconcileAccountFills } from "./bridge-fills.js";

const TOLERANCE = {
  trader_equity: 0.01,
  trader_options: 0.0,    // any drift on options counts
  investor_equity_abs: 0.1,
  investor_equity_pct: 0.01,
  investor_options: 0.0,
};

// 2026-06-01 — Phase D: per (mode × instrument) reconcile cadence in
// seconds. The cron fires every 5 min (Phase C); each row is eligible
// only when (now - sync_last_checked_at) >= cadence. Lets us scan
// Trader equity at the cron's native pace while throttling Investor
// to hourly and LEAPs to daily.
const CADENCE_SEC = {
  trader_equity: 5 * 60,
  trader_options: 5 * 60,
  investor_equity: 60 * 60,
  investor_options: 60 * 60,
  leaps: 24 * 60 * 60,
};

// 2026-06-01 — Phase D: LEAP auto-close window. When a LEAP is within
// LEAP_AUTO_CLOSE_DAYS of expiration AND the operator has enabled the
// auto-close behavior via env, the reconciler emits an EXIT-orphan
// flag the operator (or the cron-driven exit dispatcher) can act on.
// This PR sets the flag in `sync_note` but does NOT auto-send an exit
// order — that's Phase E (with the user notification + cluster Discord
// alert preceding the exit). Default disabled.
const LEAP_AUTO_CLOSE_DAYS = 30;
const NON_LEAP_OPTIONS_AUTO_CLOSE_DAYS = 1;

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

// 2026-06-01 — Phase D: contract symbol normalizer for options leg
// matching. Different brokers report option positions with different
// shapes — we accept OCC-style ("AAPL  240119C00150000"), explicit
// fields ({ticker, exp, strike, type}), or raw symbol strings, then
// fold to a canonical key like "AAPL:2024-01-19:150.00:C".
function _normalizeOptionContractKey(p, fallbackTicker = null) {
  if (!p) return null;
  // Explicit fields (cleanest path).
  const ticker = String(
    p.ticker ?? p.symbol ?? p.underlying ?? p.contractDesc ?? fallbackTicker ?? ""
  ).toUpperCase();
  const exp = String(
    p.expiration ?? p.exp ?? p.expiry ?? ""
  ).slice(0, 10); // YYYY-MM-DD
  const strike = Number(p.strike ?? 0);
  const type = String(p.type ?? p.optionType ?? p.right ?? "")
    .toUpperCase().startsWith("P") ? "P" : "C";
  if (ticker && exp && strike > 0) {
    return `${ticker}:${exp}:${strike.toFixed(2)}:${type}`;
  }
  // OCC symbol fallback (21-char standard): TTTTTTYYMMDDXSSSSSSSS
  // where T = ticker (1-6 chars left-padded with spaces), YYMMDD =
  // expiration, X = C/P, S = strike × 1000 (8 digits).
  const raw = String(p.symbol ?? p.occ_symbol ?? p.contract_symbol ?? "").trim();
  if (raw.length >= 15) {
    // Heuristic parse: scan from the right for the strike + flag.
    const m = raw.match(/^([A-Z .]{1,6})\s*(\d{6})([CP])(\d{8})$/);
    if (m) {
      const tk = m[1].trim();
      const yymmdd = m[2];
      const flag = m[3];
      const strikeRaw = Number(m[4]) / 1000;
      const yr = "20" + yymmdd.slice(0, 2);
      const mo = yymmdd.slice(2, 4);
      const dy = yymmdd.slice(4, 6);
      return `${tk}:${yr}-${mo}-${dy}:${strikeRaw.toFixed(2)}:${flag}`;
    }
  }
  return null;
}

// 2026-06-01 — Phase D: index broker option positions by canonical key.
function _indexOptionsByContract(positions) {
  const out = new Map();
  if (!Array.isArray(positions)) return out;
  for (const p of positions) {
    if (!p) continue;
    const key = _normalizeOptionContractKey(p);
    if (!key) continue;
    const qty = Number(p.position ?? p.qty ?? p.quantity ?? p.size ?? 0);
    const avg = Number(p.avgCost ?? p.avg_cost ?? p.avgPrice ?? p.avg_price ?? 0);
    const prev = out.get(key) || { qty: 0, avgCost: 0 };
    const newQty = prev.qty + qty;
    const weighted = (prev.qty * prev.avgCost) + (qty * avg);
    out.set(key, {
      qty: newQty,
      avgCost: newQty !== 0 ? weighted / newQty : 0,
    });
  }
  return out;
}

// 2026-06-01 — Phase D: compare model_intended_legs vs broker options
// positions. Returns one of:
//   { kind: 'in_sync' }
//   { kind: 'partial_fill', missing: [...], short: [...] }
//   { kind: 'broker_orphan', extra_qty: number }
//   { kind: 'mothership_orphan' }
//   { kind: 'expired' }
// Spread trades (>1 leg): ANY mismatched leg → partial_fill (operator
// must manually unwind; never auto-trim a spread).
export function classifyOptionsDrift(row, brokerOptionsIdx) {
  const modelStatus = String(row.model_status || "OPEN").toUpperCase();
  const legs = Array.isArray(row.model_intended_legs)
    ? row.model_intended_legs
    : (() => {
        try { return JSON.parse(row.model_intended_legs || "[]"); }
        catch (_) { return []; }
      })();

  // Expiration check first — overrides all other classifications.
  const expIso = legs[0]?.expiration || row.options_structure_exp || null;
  if (expIso) {
    const expDate = new Date(expIso);
    if (expDate.getTime() < Date.now() - 24 * 60 * 60 * 1000) {
      // Past expiration by > 1 day → manifest is terminal.
      return {
        kind: "expired",
        sync_state: "expired",
        drift_detected: modelStatus !== "EXPIRED",
        severity: "info",
        note: `option position past expiration (${expIso})`,
        broker_state: { positions: [] },
      };
    }
  }

  if (legs.length === 0) {
    // No leg detail — fall back to "untracked" so the operator can review.
    return {
      kind: "untracked",
      sync_state: "untracked",
      drift_detected: false,
      severity: "info",
      note: "no model_intended_legs in manifest; cannot leg-compare",
      broker_state: {},
    };
  }

  // For each leg, find the matching broker position.
  const matches = [];
  const missing = [];
  for (const leg of legs) {
    const key = _normalizeOptionContractKey({
      ticker: row.ticker,
      expiration: leg.expiration,
      strike: leg.strike,
      type: leg.optionType || leg.type,
    });
    if (!key) {
      missing.push({ ...leg, reason: "leg_key_unresolvable" });
      continue;
    }
    const brokerPos = brokerOptionsIdx.get(key);
    const expectedQty = Number(leg.qty) || 0;
    // BUY → expect positive qty; SELL_TO_OPEN → expect negative qty.
    const isShort = String(leg.action || "").toUpperCase().includes("SELL");
    const signedExpected = isShort ? -expectedQty : expectedQty;
    const brokerQty = Number(brokerPos?.qty) || 0;
    matches.push({
      leg, key, expected: signedExpected, broker_qty: brokerQty,
      diff: brokerQty - signedExpected,
    });
    if (!brokerPos || Math.abs(brokerPos.qty) < Math.abs(expectedQty)) {
      missing.push({ ...leg, key, expected: signedExpected, broker_qty: brokerQty });
    }
  }

  if (modelStatus === "CLOSED" || modelStatus === "EXPIRED") {
    const anyHeld = matches.some(m => Math.abs(m.broker_qty) > 0);
    if (anyHeld) {
      return {
        kind: "broker_orphan",
        sync_state: "broker_orphan",
        drift_detected: true,
        severity: _orphanSeverity(row),
        note: `model_${modelStatus.toLowerCase()} but broker still holds legs`,
        broker_state: { matches },
      };
    }
    return {
      kind: "in_sync",
      sync_state: "in_sync",
      drift_detected: false,
      severity: "info",
      note: `model_${modelStatus.toLowerCase()} + broker flat`,
      broker_state: { matches },
    };
  }

  // model_status OPEN
  if (missing.length === 0) {
    return {
      kind: "in_sync",
      sync_state: "in_sync",
      drift_detected: false,
      severity: "info",
      note: "all legs match",
      broker_state: { matches },
    };
  }
  // Multi-leg with any missing → partial_fill (critical for spreads —
  // uncovered legs are risk).
  const isSpread = legs.length > 1;
  return {
    kind: "partial_fill",
    sync_state: "partial_fill",
    drift_detected: true,
    severity: isSpread ? "critical" : "warn",
    note: `${missing.length} of ${legs.length} leg(s) missing/short${isSpread ? " (spread leg gap is critical)" : ""}`,
    broker_state: { matches, missing },
  };
}

// 2026-06-01 — Phase D: aggregate filled qty across Investor DCA
// tranches. Each tranche row = { ts, qty, broker_order_id, filled_qty,
// avg_cost }. Returns { totalFilled, totalIntended, weightedAvgCost,
// pendingTranches }.
export function aggregateDcaTranches(row) {
  const tranches = Array.isArray(row.dca_tranches)
    ? row.dca_tranches
    : (() => {
        try { return JSON.parse(row.dca_tranches || "[]"); }
        catch (_) { return []; }
      })();
  if (tranches.length === 0) return { totalFilled: 0, totalIntended: 0, weightedAvgCost: 0, pendingTranches: 0 };
  let totalFilled = 0;
  let totalIntended = 0;
  let costSum = 0;
  let pending = 0;
  for (const t of tranches) {
    const intended = Number(t.qty) || 0;
    const filled = Number(t.filled_qty) || 0;
    const cost = Number(t.avg_cost) || 0;
    totalIntended += intended;
    totalFilled += filled;
    costSum += filled * cost;
    if (filled < intended) pending++;
  }
  return {
    totalFilled,
    totalIntended,
    weightedAvgCost: totalFilled > 0 ? costSum / totalFilled : 0,
    pendingTranches: pending,
  };
}

// 2026-06-01 — Phase D: cadence eligibility check. Returns true if the
// row is due for re-check given its (mode × instrument).
function _cadenceEligible(row) {
  const last = Number(row.sync_last_checked_at) || 0;
  if (last === 0) return true; // never checked → always eligible
  const mode = String(row.mode || "trader").toLowerCase();
  const inst = String(row.instrument_type || "equity").toLowerCase();
  const isLeap = String(row.options_structure || "").toLowerCase() === "leaps";
  const key = isLeap ? "leaps"
    : (mode === "investor" && inst === "equity") ? "investor_equity"
    : (mode === "investor" && inst === "options") ? "investor_options"
    : (mode === "trader" && inst === "options") ? "trader_options"
    : "trader_equity";
  const cadenceSec = CADENCE_SEC[key] || CADENCE_SEC.trader_equity;
  return (Date.now() - last) >= cadenceSec * 1000;
}

// 2026-06-01 — Phase D: check whether an options row needs the
// "approaching expiration" warning attached to its sync_note.
function _checkApproachingExpiration(row) {
  const isOption = String(row.instrument_type || "").toLowerCase() === "options";
  if (!isOption) return null;
  const isLeap = String(row.options_structure || "").toLowerCase() === "leaps";
  // Reader path: model_intended_legs may arrive as a JSON string (from
  // the raw D1 SELECT in _readOpenRowsForUser) or as an array (when
  // _expandJsonCols has already run). Handle both.
  const legs = Array.isArray(row.model_intended_legs)
    ? row.model_intended_legs
    : (() => {
        try { return JSON.parse(row.model_intended_legs || "[]"); }
        catch (_) { return []; }
      })();
  const expIso = legs[0]?.expiration || null;
  if (!expIso) return null;
  const expDate = new Date(expIso);
  const daysToExp = Math.floor((expDate.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
  const threshold = isLeap ? LEAP_AUTO_CLOSE_DAYS : NON_LEAP_OPTIONS_AUTO_CLOSE_DAYS;
  if (daysToExp >= 0 && daysToExp <= threshold) {
    return {
      kind: isLeap ? "leap_approaching_expiration" : "option_approaching_expiration",
      days_to_exp: daysToExp,
      threshold,
      severity: daysToExp <= 1 ? "critical" : (isLeap ? "warn" : "warn"),
      note: `${isLeap ? "LEAP" : "Option"} expires in ${daysToExp}d (T-${threshold} threshold)`,
    };
  }
  return null;
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

  // 2026-06-01 — Phase D: cadence-filter rows BEFORE fetching positions
  // so we skip cheap reads on rows that aren't due. Empty result = no
  // broker fetch needed.
  const eligible = rows.filter(_cadenceEligible);
  if (eligible.length === 0) {
    return {
      user_id: userId, rows_scanned: rows.length, rows_eligible: 0,
      rows_in_sync: 0, rows_drifting: 0, rows_auto_suppressed: 0,
      by_state: {}, cadence_skipped: rows.length,
    };
  }
  // Determine which broker fetches we need based on instrument mix.
  const hasEquity = eligible.some(r => String(r.instrument_type || "equity").toLowerCase() === "equity");
  const hasOptions = eligible.some(r => String(r.instrument_type || "").toLowerCase() === "options");

  // Fetch broker positions ONCE per user (not per row).
  let equityRes = { ok: true, positions: [] };
  let optionsRes = { ok: true, positions: [] };
  try {
    if (hasEquity) {
      equityRes = typeof brokerAdapter?.getEquityPositions === "function"
        ? await brokerAdapter.getEquityPositions(env, user)
        : { ok: false, error: "adapter_lacks_getEquityPositions" };
    }
    if (hasOptions) {
      optionsRes = typeof brokerAdapter?.getOptionsPositions === "function"
        ? await brokerAdapter.getOptionsPositions(env, user)
        // Fallback: some adapters return options inside getPortfolio.
        : typeof brokerAdapter?.getPortfolio === "function"
          ? await brokerAdapter.getPortfolio(env, user).then(r => ({
              ok: r.ok,
              positions: Array.isArray(r?.portfolio?.options_positions)
                ? r.portfolio.options_positions
                : (Array.isArray(r?.options_positions) ? r.options_positions : []),
              error: r.error,
            }))
          : { ok: false, error: "adapter_lacks_getOptionsPositions" };
    }
  } catch (e) {
    if (hasEquity && !equityRes) equityRes = { ok: false, error: String(e?.message || e).slice(0, 200) };
    if (hasOptions && !optionsRes) optionsRes = { ok: false, error: String(e?.message || e).slice(0, 200) };
  }

  // If BOTH fetches failed, treat as a full broker outage — every
  // eligible row gets reconcile_error.
  if ((hasEquity && !equityRes?.ok) && (hasOptions && !optionsRes?.ok)) {
    let errCount = 0;
    for (const row of eligible) {
      if (await _persistReconcileError(env, row, equityRes?.error || optionsRes?.error || "broker_fetch_failed")) errCount++;
    }
    return {
      user_id: userId, rows_scanned: rows.length, rows_eligible: eligible.length,
      rows_reconcile_error: errCount,
      fetch_error: String(equityRes?.error || optionsRes?.error || "unknown").slice(0, 200),
      by_state: { reconcile_error: errCount },
    };
  }

  const positionsByTicker = _indexByTicker(equityRes?.positions || equityRes?.results || []);
  const optionsByContract = _indexOptionsByContract(optionsRes?.positions || optionsRes?.results || []);

  // Per (mode × instrument) tolerance.
  function _tolerance(row) {
    const mode = String(row.mode || "trader").toLowerCase();
    const inst = String(row.instrument_type || "equity").toLowerCase();
    if (mode === "investor" && inst === "equity") return TOLERANCE.investor_equity_abs;
    if (mode === "trader" && inst === "options") return TOLERANCE.trader_options;
    return TOLERANCE.trader_equity;
  }

  const stats = {
    user_id: userId, rows_scanned: rows.length, rows_eligible: eligible.length,
    rows_in_sync: 0, rows_drifting: 0, rows_auto_suppressed: 0,
    expiration_warnings: 0,
    by_state: {}, cadence_skipped: rows.length - eligible.length,
  };

  for (const row of eligible) {
    const isOptions = String(row.instrument_type || "").toLowerCase() === "options";
    const isInvestor = String(row.mode || "trader").toLowerCase() === "investor";

    let classification;
    if (isOptions) {
      // 2026-06-01 — Phase D: leg-aware options reconciliation.
      classification = classifyOptionsDrift(row, optionsByContract);
    } else {
      // Equity (Trader or Investor). For Investor DCA-tracked rows
      // we also surface the aggregate filled / pending tranche count
      // in sync_note so MC can render it without parsing the JSON.
      const brokerState = positionsByTicker.get(String(row.ticker || "").toUpperCase()) || null;
      classification = classifyDrift(row, brokerState, { tolerance: _tolerance(row) });
      if (isInvestor && row.dca_tranches) {
        const dca = aggregateDcaTranches(row);
        if (dca.pendingTranches > 0) {
          classification = {
            ...classification,
            note: `${classification.note} | DCA: ${dca.totalFilled}/${dca.totalIntended} filled, ${dca.pendingTranches} tranches pending`,
          };
        }
      }
    }

    // Append approaching-expiration warning to the sync_note.
    const expWarn = _checkApproachingExpiration(row);
    if (expWarn) {
      classification = {
        ...classification,
        note: `${classification.note} | ${expWarn.note}`,
        // Don't downgrade severity if already critical.
        severity: classification.severity === "critical" ? "critical" : expWarn.severity,
      };
      stats.expiration_warnings++;
    }

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
      // 2026-06-01 — Phase E: emit a drift notification (severity-aware
      // dedup). Best-effort: a failed notification dispatch never
      // blocks the reconcile cycle. critical → operator Discord +
      // user email queued; warn → user email queued; info → daily
      // digest (no immediate dispatch).
      const sev = classification.severity || "warn";
      if (sev === "warn" || sev === "critical") {
        try {
          const dispatchRes = await emitDriftNotification(env, row, sev);
          if (dispatchRes?.dispatched) {
            stats.notifications_dispatched = (stats.notifications_dispatched || 0) + 1;
          } else {
            stats.notifications_dedup = (stats.notifications_dedup || 0) + 1;
          }
        } catch (e) {
          console.warn("[NOTIFY] emit failed:", String(e?.message || e).slice(0, 200));
        }
      }
    } else {
      stats.rows_in_sync++;
    }
    stats.by_state[classification.sync_state] = (stats.by_state[classification.sync_state] || 0) + 1;
  }

  // ── Per-account sync snapshot ──
  // Persist broker truth (positions + drift) for THIS account so the system
  // and broker stay reconciled per real account, not just per manifest row.
  if (!opts.dryRun) {
    try {
      const equityPositions = (equityRes?.positions || equityRes?.results || []).map((p) => ({
        ticker: String(p.symbol || p.ticker || "").toUpperCase(),
        qty: Number(p.qty ?? p.position ?? p.quantity) || 0,
        avg_cost: Number(p.avg_cost ?? p.avgCost ?? p.avg_price) || null,
        market_value: Number(p.market_value ?? p.marketValue) || null,
        unrealized_pnl: Number(p.unrealized_pnl ?? p.unrealizedPnl) || null,
      })).filter((p) => p.ticker);
      await snapshotAccount(env, {
        broker_account_id: resolveBrokerAccountId(user),
        owner_id: user?.owner_email || userId,
        user_id: userId,
        broker: resolveBrokerId(user) || user?.broker || null,
        account_label: user?.webull_account_label || user?.account_label || null,
        cash_usd: user?.cash_usd ?? null,
        equity_usd: user?.equity_usd ?? null,
        buying_power_usd: user?.buying_power_usd ?? null,
        positions: equityPositions,
        in_sync: stats.rows_drifting === 0,
        drift: [], // per-row drift already persisted on the manifest
        synced_at: Date.now(),
      });
      stats.account_snapshot = "written";
    } catch (e) {
      console.warn("[RECONCILER] account snapshot failed:", String(e?.message || e).slice(0, 160));
    }

    // ── Fill reconciliation ──
    // Poll the broker's recent orders and record real fills to the per-account
    // ledger (submitted → filled qty/price); cancel OCO siblings on fill.
    try {
      const fillStats = await reconcileAccountFills(env, user, brokerAdapter, { limit: 50 });
      stats.fills = fillStats;
    } catch (e) {
      console.warn("[RECONCILER] fill reconcile failed:", String(e?.message || e).slice(0, 160));
    }
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
