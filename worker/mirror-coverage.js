/**
 * Fail-closed model → broker coverage contract (2026-09-11).
 *
 * One answer to: "what did the model do, and did the broker do the
 * same thing?" Share count may differ (cash scale / partner caps);
 * the ratio must stay relative across the trade. Coverage pages
 * unmatched actions. It does not invent new order paths — heals stay
 * on the existing lane catch-ups.
 *
 * Lanes:
 *   trader       account_ledger mode=trader ENTRY/TRIM/EXIT
 *   investor     investor_lots BUY/DCA_BUY/SELL
 *   index_trend  timed:idx-trend-actions
 *   index_dt     timed:opt-dt-actions
 *   convexity    convexity_tickets that actually engaged the mirror
 *
 * Status:
 *   mirrored            real place (buy/DCA needs an order id)
 *   mirrored_partial    owner filled; a fan-out child rejected
 *   rejected_terminal   expected dead end (already flat / never filled)
 *   pending_intent      D1 broker_intents will retry
 *   deferred            expected ETH / window skip (ring exists)
 *   in_flight           younger than the grace window
 *   unmatched           never left the monolith, or false-ok buy
 */

import { readClientRing } from "./broker-bridge-client.js";
import { ringLooksLikeRealPlace } from "./investor-catchup-run.js";
import { isTerminalIndexTrendExitReject, INDEX_TREND_MIRROR_LOG_KEY } from "./index-trend-auto-mirror.js";
import { readIndexTrendActions } from "./index-trend-alerts.js";
import { readDayTradeActions } from "./option-day-trade-alerts.js";
import { OPT_DT_MIRROR_LOG_KEY } from "./options-auto-mirror.js";
import { paperMirrorLogSide } from "./broker-day-actions-join.js";

export const COVERAGE_GRACE_MS = 2 * 60 * 1000;
export const COVERAGE_MATCH_SLACK_MS = 2 * 60 * 1000;
export const RELATIVE_QTY_ABS = 0.05;
export const RELATIVE_QTY_PCT = 0.10;
export const COVERAGE_SNAPSHOT_KEY = "timed:mirror-coverage:latest";
export const COVERAGE_PAGED_KEY = "timed:mirror-coverage:paged";
export const COVERAGE_CLEAN_DAY_KEY = "timed:mirror-coverage:clean-day";
export const DEFAULT_COVERAGE_LOOKBACK_MS = 48 * 3600 * 1000;

export const HEAL_PAGE_ONLY = "page_only";
export const HEAL_INVESTOR = "catchup-investor";
export const HEAL_TRADER_EXIT = "catchup-trader-exits";
export const HEAL_INDEX_ENTRY = "heal-index-trend-entries";
export const HEAL_INDEX_EXIT = "heal-index-trend-closes";
export const HEAL_INTENT_DRAIN = "drain-broker-intents";

const OPEN_EVENTS = new Set(["ENTRY", "BUY", "DCA_BUY", "DCA_ADD", "ADD", "OPEN"]);
const REDUCE_EVENTS = new Set(["TRIM", "EXIT", "STOP", "SELL", "CLOSE", "REDUCE"]);
const BUY_SIDES = new Set(["buy", "long", "entry", "dca", "add", "open"]);
const SELL_SIDES = new Set(["sell", "trim", "exit", "close", "reduce"]);
const DEFERRED_REASONS = /equity_ah_too_late|fractional_trim_deferred|outside_rth|ah_too_late|entry_deferred_to_rth|only limit orders are supported for extended-hours/i;
const TERMINAL_EXIT_RE = /no_broker_position|already_flat|nothing_to_sell|position_flat|position_zero|qty_zero|no_mirrored_entry|mirror_position_already_flat|no_manifest/i;
const CASH_SUPPRESS_RE = /insufficient_cash|mirror_suppressed/i;

export function isOpenEvent(event) {
  return OPEN_EVENTS.has(String(event || "").toUpperCase());
}

export function isReduceEvent(event) {
  return REDUCE_EVENTS.has(String(event || "").toUpperCase());
}

export function actionSideFamily(event) {
  return isOpenEvent(event) ? "buy" : "sell";
}

export function ringSideFamily(side) {
  const s = String(side || "").toLowerCase();
  if (BUY_SIDES.has(s)) return "buy";
  return "sell";
}

export function normalizeCoverageId(id) {
  return String(id || "").replace(/^inv-/, "").toLowerCase();
}

function actionIds(action) {
  const ids = new Set();
  const push = (v) => {
    const n = normalizeCoverageId(v);
    if (n) ids.add(n);
  };
  push(action?.trade_id);
  push(action?.position_id);
  push(action?.signal_id);
  if (action?.lot_id != null) ids.add(String(action.lot_id));
  return ids;
}

export function coverageIdsMatch(action, row) {
  const lotId = action?.lot_id != null ? String(action.lot_id) : "";
  if (lotId && String(row?.lot_id || "") === lotId) return true;
  const aids = actionIds(action);
  if (!aids.size) return false;
  const rid = normalizeCoverageId(row?.trade_id || row?.signal_id || row?.position_id);
  return !!rid && aids.has(rid);
}

export function coverageTsOk(actionTs, rowTs, slackMs = COVERAGE_MATCH_SLACK_MS) {
  const at = Number(actionTs) || 0;
  const rt = Number(rowTs);
  if (!Number.isFinite(rt)) return false;
  return rt + slackMs >= at;
}

export function ringQty(row) {
  const scaled = Number(row?.bridge_scaled_qty ?? row?.scaled_qty);
  if (scaled > 0) return scaled;
  const q = Number(row?.qty ?? row?.shares ?? row?.contracts);
  return Number.isFinite(q) ? q : null;
}

export function isCoverageTerminalReject(reason, event) {
  const text = String(reason || "");
  if (!text) return false;
  if (isTerminalIndexTrendExitReject(text)) return !isOpenEvent(event);
  if (TERMINAL_EXIT_RE.test(text)) return !isOpenEvent(event);
  return false;
}

export function isCoverageDeferredReject(reason) {
  return DEFERRED_REASONS.test(String(reason || ""));
}

function rejectText(row) {
  return String(row?.reject_reason || row?.error || row?.reason || row?.skip || row?.last_reason || "");
}

function matchingRingRows(action, ring = []) {
  const fam = actionSideFamily(action.event);
  const ticker = String(action.ticker || "").toUpperCase();
  return (ring || []).filter((r) => {
    if (ringSideFamily(r?.side) !== fam) return false;
    if (!coverageIdsMatch(action, r)) return false;
    if (ticker && String(r?.ticker || "").toUpperCase() && String(r.ticker).toUpperCase() !== ticker) {
      return false;
    }
    if (!coverageTsOk(action.ts, r.ts)) return false;
    return true;
  });
}

function matchingIntents(action, intents = []) {
  const fam = actionSideFamily(action.event);
  return (intents || []).filter((row) => {
    if (String(row?.status || "").toLowerCase() !== "pending") return false;
    if (ringSideFamily(row?.side) !== fam) return false;
    return coverageIdsMatch(action, row);
  });
}

function matchingMirrorLogs(action, logs = []) {
  const fam = actionSideFamily(action.event);
  return (logs || []).filter((row) => {
    if (paperMirrorLogSide(row) && ringSideFamily(paperMirrorLogSide(row)) !== fam) return false;
    return coverageIdsMatch(action, { trade_id: row?.signal_id || row?.trade_id });
  });
}

/**
 * Classify one model action against the client ring, intent ledger, and
 * paper-lane mirror logs.
 */
export function classifyActionCoverage(action, {
  ring = [],
  intents = [],
  mirrorLogs = [],
  nowMs = Date.now(),
  graceMs = COVERAGE_GRACE_MS,
} = {}) {
  const hits = matchingRingRows(action, ring);
  const placed = hits.filter((r) => ringLooksLikeRealPlace(r));
  const ageMs = (Number(nowMs) || Date.now()) - (Number(action?.ts) || 0);

  if (placed.length) {
    const qty = ringQty(placed[placed.length - 1]);
    const orderId = placed.map((r) => r.rh_order_id || r.broker_order_id || r.order_id).find(Boolean) || null;
    const childReject = hits.map((r) => rejectText(r)).find((t) => t && !isCoverageTerminalReject(t, action.event));
    if (childReject && CASH_SUPPRESS_RE.test(childReject)) {
      return {
        status: "mirrored_partial",
        reason: childReject.slice(0, 160),
        broker_qty: qty,
        order_id: orderId,
      };
    }
    return { status: "mirrored", reason: null, broker_qty: qty, order_id: orderId };
  }

  const pending = matchingIntents(action, intents);
  if (pending.length) {
    return {
      status: "pending_intent",
      reason: rejectText(pending[0]) || "broker_intent_pending",
      broker_qty: Number(pending[0]?.qty) || null,
      order_id: null,
    };
  }

  const rejectedHits = hits.filter((r) => String(r?.status || "") !== "ok" || rejectText(r));
  const terminalHit = rejectedHits.find((r) => isCoverageTerminalReject(rejectText(r), action.event));
  if (terminalHit) {
    return {
      status: "rejected_terminal",
      reason: rejectText(terminalHit).slice(0, 160),
      broker_qty: 0,
      order_id: null,
    };
  }
  const deferredHit = hits.find((r) => isCoverageDeferredReject(rejectText(r)) || isCoverageDeferredReject(r?.skip));
  if (deferredHit) {
    return {
      status: "deferred",
      reason: rejectText(deferredHit).slice(0, 160) || "deferred_window",
      broker_qty: null,
      order_id: null,
    };
  }

  const logs = matchingMirrorLogs(action, mirrorLogs);
  const latestLog = logs[0] || null;
  if (latestLog) {
    const decision = String(latestLog.decision || (latestLog.skipped ? "skipped" : "")).toLowerCase();
    const reason = rejectText(latestLog);
    if (decision === "mirrored" || (decision === "placed" && !isOpenEvent(action.event))) {
      return {
        status: "mirrored",
        reason: null,
        broker_qty: ringQty(latestLog),
        order_id: latestLog.order_id || null,
      };
    }
    if (decision === "pending") {
      return { status: "pending_intent", reason: reason || "order_working", broker_qty: null, order_id: null };
    }
    if (isCoverageTerminalReject(reason, action.event) || decision === "skipped" && isCoverageTerminalReject(reason, action.event)) {
      return { status: "rejected_terminal", reason: reason.slice(0, 160), broker_qty: 0, order_id: null };
    }
  }

  if (ageMs >= 0 && ageMs < graceMs) {
    return { status: "in_flight", reason: "grace_window", broker_qty: null, order_id: null };
  }

  const falseOk = hits.find((r) => String(r?.status) === "ok" && isOpenEvent(action.event) && !ringLooksLikeRealPlace(r));
  return {
    status: "unmatched",
    reason: falseOk
      ? (falseOk.deduped ? "deduped_not_a_fill" : "false_ok_no_order_id")
      : (hits.length ? (rejectText(hits[hits.length - 1]) || "ring_not_a_place") : "never_attempted"),
    broker_qty: null,
    order_id: null,
  };
}

export function relativeQtyOk({
  modelQty,
  brokerQty,
  basisRatio,
  absTol = RELATIVE_QTY_ABS,
  pctTol = RELATIVE_QTY_PCT,
} = {}) {
  const model = Number(modelQty);
  const broker = Number(brokerQty);
  const ratio = Number(basisRatio);
  if (!(model > 0) || !Number.isFinite(broker) || !(ratio > 0)) {
    return { ok: true, skipped: true, expected: null, abs: null, tol: null };
  }
  const expected = model * ratio;
  const abs = Math.abs(broker - expected);
  const tol = Math.max(absTol, Math.abs(expected) * pctTol);
  return { ok: abs <= tol + 1e-9, expected, abs, tol };
}

/**
 * First mirrored open sets the scale. Later mirrored opens/reduces must
 * stay on that ratio (model 100 / broker 2, then exit 100 / 2 — not 100).
 */
export function computeTradeRelativeQty(rows = []) {
  const list = Array.isArray(rows) ? rows : [];
  const entry = list.find((r) => isOpenEvent(r.event) && (r.status === "mirrored" || r.status === "mirrored_partial")
    && Number(r.model_qty || r.qty) > 0 && Number(r.broker_qty) > 0);
  if (!entry) return { ok: true, skipped: "no_mirrored_entry", ratio: null, drifts: [] };
  const ratio = Number(entry.broker_qty) / Number(entry.model_qty || entry.qty);
  const drifts = [];
  for (const row of list) {
    if (row === entry) continue;
    if (row.status !== "mirrored" && row.status !== "mirrored_partial") continue;
    if (!(Number(row.model_qty || row.qty) > 0) || !Number.isFinite(Number(row.broker_qty))) continue;
    const check = relativeQtyOk({
      modelQty: row.model_qty || row.qty,
      brokerQty: row.broker_qty,
      basisRatio: ratio,
    });
    if (!check.ok) {
      drifts.push({
        key: row.key || coverageKey(row),
        event: row.event,
        model_qty: Number(row.model_qty || row.qty),
        broker_qty: Number(row.broker_qty),
        expected: check.expected,
      });
    }
  }
  return { ok: drifts.length === 0, ratio, drifts };
}

export function coverageKey(action) {
  return [
    action.lane || "unknown",
    String(action.ticker || "").toUpperCase(),
    action.trade_id || action.lot_id || "",
    String(action.event || "").toUpperCase(),
    Number(action.ts) || 0,
  ].join("|");
}

export function healForCoverageRow(row) {
  const status = String(row?.status || "");
  if (status !== "unmatched" && status !== "rejected") return null;
  const lane = String(row?.lane || "");
  const open = isOpenEvent(row?.event);
  if (lane === "investor") return HEAL_INVESTOR;
  if (lane === "trader") return open ? HEAL_PAGE_ONLY : HEAL_TRADER_EXIT;
  if (lane === "index_trend") return open ? HEAL_INDEX_ENTRY : HEAL_INDEX_EXIT;
  if (lane === "convexity" && !open) return HEAL_INTENT_DRAIN;
  return HEAL_PAGE_ONLY;
}

export function coverageHealPlan(anomalies = []) {
  const seen = new Set();
  const plan = [];
  for (const row of anomalies || []) {
    const heal = row.heal || healForCoverageRow(row);
    if (!heal || heal === HEAL_PAGE_ONLY || seen.has(heal)) continue;
    seen.add(heal);
    plan.push(heal);
  }
  return plan;
}

function positionKey(row) {
  return String(row?.position_id || row?.trade_id || row?.ticker || "").toUpperCase();
}

/**
 * Page every unmatched open (a prior BUY must not hide a later DCA).
 * For reduces, last-signal-wins: an older unmatched trim is quiet when
 * a later EXIT on the same position already mirrored or flattened.
 */
export function anomalyVisible(row, allRows = []) {
  if (!isReduceEvent(row?.event)) return true;
  const key = positionKey(row);
  const later = (allRows || []).filter((other) => (
    other !== row
    && positionKey(other) === key
    && isReduceEvent(other.event)
    && (Number(other.ts) || 0) >= (Number(row.ts) || 0)
    && (other.status === "mirrored" || other.status === "mirrored_partial" || other.status === "rejected_terminal")
  ));
  return later.length === 0;
}

export function buildCoverageRows(actions = [], ctx = {}) {
  const rows = (actions || []).map((action) => {
    const cov = classifyActionCoverage(action, ctx);
    return {
      ...action,
      event: String(action.event || "").toUpperCase(),
      ticker: String(action.ticker || "").toUpperCase(),
      model_qty: Number(action.qty) || 0,
      key: coverageKey(action),
      ...cov,
    };
  });
  const byTrade = new Map();
  for (const row of rows) {
    const tid = String(row.trade_id || row.position_id || row.key);
    if (!byTrade.has(tid)) byTrade.set(tid, []);
    byTrade.get(tid).push(row);
  }
  for (const group of byTrade.values()) {
    const rel = computeTradeRelativeQty(group);
    for (const row of group) {
      row.qty_ratio = rel.ratio;
      row.qty_drift = (rel.drifts || []).find((d) => d.key === row.key) || null;
    }
  }
  return rows;
}

export function coverageAnomalies(rows = [], {
  nowMs = Date.now(),
  graceMs = COVERAGE_GRACE_MS,
} = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const anomalies = [];
  for (const row of list) {
    const age = (Number(nowMs) || Date.now()) - (Number(row.ts) || 0);
    if (age >= 0 && age < graceMs) continue;
    if (row.status === "in_flight" || row.status === "pending_intent"
      || row.status === "deferred" || row.status === "rejected_terminal"
      || row.status === "mirrored") {
      // mirrored_partial warns separately
    } else if (row.status === "mirrored_partial") {
      anomalies.push({
        ...row,
        heal: null,
        severity: "warn",
        detail: `${row.ticker} ${row.event} mirrored with a fan-out reject (${row.reason || "partial"})`,
      });
    } else if ((row.status === "unmatched" || row.status === "rejected") && anomalyVisible(row, list)) {
      const heal = healForCoverageRow(row);
      anomalies.push({
        ...row,
        heal,
        severity: "fail",
        detail: `${row.ticker} ${row.lane} ${row.event} ${row.status} — ${row.reason || "no broker place"}`,
      });
    }
    if (row.qty_drift) {
      anomalies.push({
        ...row,
        heal: HEAL_PAGE_ONLY,
        severity: "fail",
        detail: `${row.ticker} ${row.event} qty drift: model ${row.qty_drift.model_qty} / broker ${row.qty_drift.broker_qty} (expected ${Number(row.qty_drift.expected).toFixed(4)} at entry ratio)`,
      });
    }
  }
  return anomalies;
}

export function evaluateModelBrokerCoverage({
  rows = [],
  nowMs = Date.now(),
  graceMs = COVERAGE_GRACE_MS,
} = {}) {
  return coverageAnomalies(rows, { nowMs, graceMs }).map((a) => ({
    ticker: a.ticker || null,
    detail: a.detail,
    severity: a.severity,
    lane: a.lane,
    event: a.event,
    trade_id: a.trade_id || null,
    heal: a.heal || null,
    status: a.status,
  }));
}

export function modelActionFromLedger(row) {
  const event = String(row?.event_type || "").toUpperCase();
  if (!event) return null;
  return {
    lane: "trader",
    event,
    ticker: String(row.ticker || "").toUpperCase(),
    trade_id: String(row.position_id || row.trade_id || ""),
    position_id: row.position_id || null,
    ts: Number(row.ts) || 0,
    qty: Number(row.qty) || 0,
    price: Number(row.price) || 0,
    source: "account_ledger",
  };
}

export function modelActionFromInvestorLot(lot) {
  const action = String(lot?.action || "").toUpperCase();
  const reason = String(lot?.reason || "").toUpperCase();
  let event = "ENTRY";
  if (action === "DCA_BUY") event = "DCA_BUY";
  else if (action === "SELL") event = /INVALIDATION|EXIT|CLOSE|FULL/.test(reason) ? "EXIT" : "TRIM";
  else if (action === "BUY") event = "ENTRY";
  const posId = lot?.position_id != null ? String(lot.position_id) : "";
  const tradeId = posId
    ? (posId.startsWith("inv-") ? posId : `inv-${posId}`)
    : `inv-${lot?.ticker || "UNK"}`;
  return {
    lane: "investor",
    event,
    ticker: String(lot.ticker || "").toUpperCase(),
    trade_id: tradeId,
    position_id: posId || tradeId,
    lot_id: lot?.id != null ? String(lot.id) : null,
    ts: Number(lot.ts) || 0,
    qty: Number(lot.shares) || 0,
    price: Number(lot.price) || 0,
    source: "investor_lots",
  };
}

export function modelActionFromIndexTrend(a) {
  const ev = String(a?.event || "").toUpperCase();
  const event = ev === "BUY" || ev === "DCA_ADD" ? (ev === "DCA_ADD" ? "DCA_BUY" : "ENTRY")
    : (ev === "TRIM" ? "TRIM" : "EXIT");
  return {
    lane: "index_trend",
    event,
    ticker: String(a.letf_ticker || a.underlying || "").toUpperCase(),
    trade_id: String(a.signal_id || ""),
    position_id: a.signal_id || null,
    signal_id: a.signal_id || null,
    ts: Number(a.ts) || 0,
    qty: Number(a.shares) || 0,
    price: Number(a.letf_price) || 0,
    source: "idx-trend-actions",
  };
}

export function modelActionFromIndexDt(a) {
  const ev = String(a?.event || "").toUpperCase();
  const event = ev === "BUY" ? "ENTRY" : (ev === "TRIM" ? "TRIM" : "EXIT");
  return {
    lane: "index_dt",
    event,
    ticker: String(a.ticker || "").toUpperCase(),
    trade_id: String(a.signal_id || ""),
    position_id: a.signal_id || null,
    signal_id: a.signal_id || null,
    ts: Number(a.ts) || 0,
    qty: Number(a.contracts) || 1,
    price: Number(a.premium) || 0,
    source: "opt-dt-actions",
  };
}

export function modelActionFromConvexityTicket(ticket, kind) {
  const closed = String(kind || "").toLowerCase() === "exit";
  return {
    lane: "convexity",
    event: closed ? "EXIT" : "ENTRY",
    ticker: String(ticket.ticker || "").toUpperCase(),
    trade_id: String(ticket.id || ""),
    position_id: ticket.id || null,
    ts: Number(closed ? ticket.closed_ts : ticket.opened_ts) || 0,
    qty: Number(ticket.mirror_contracts || ticket.contracts) || 0,
    price: Number(closed ? ticket.exit_premium : ticket.entry_premium) || 0,
    source: "convexity_tickets",
  };
}

function paperLaneId(id) {
  const s = String(id || "").toLowerCase();
  return s.startsWith("it:") || s.startsWith("dt:") || s.startsWith("cx:");
}

async function kvJson(env, key) {
  try {
    const raw = await env?.KV_TIMED?.get(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function queryRows(env, sql, sinceMs) {
  if (!env?.DB?.prepare) return [];
  try {
    const r = await env.DB.prepare(sql).bind(sinceMs).all();
    return r?.results || [];
  } catch {
    return [];
  }
}

/**
 * Load every in-scope model action and classify it against the ring.
 */
export async function loadMirrorCoverage(env, {
  sinceMs = Date.now() - DEFAULT_COVERAGE_LOOKBACK_MS,
  nowMs = Date.now(),
  graceMs = COVERAGE_GRACE_MS,
} = {}) {
  const actions = [];

  const ledger = await queryRows(env,
    `SELECT mode, ts, event_type, position_id, ticker, qty, price
       FROM account_ledger
      WHERE ts >= ?1 AND mode = 'trader' AND event_type IN ('ENTRY','TRIM','EXIT')
      ORDER BY ts ASC LIMIT 400`,
    sinceMs);
  for (const row of ledger) {
    if (paperLaneId(row?.position_id)) continue;
    const action = modelActionFromLedger(row);
    if (action) actions.push(action);
  }

  const lots = await queryRows(env,
    `SELECT id, position_id, ticker, action, shares, price, ts, reason
       FROM investor_lots
      WHERE ts >= ?1 AND action IN ('BUY','SELL','DCA_BUY')
      ORDER BY ts ASC LIMIT 400`,
    sinceMs);
  for (const lot of lots) actions.push(modelActionFromInvestorLot(lot));

  try {
    for (const a of await readIndexTrendActions(env, sinceMs)) {
      actions.push(modelActionFromIndexTrend(a));
    }
  } catch (_) { /* optional */ }
  try {
    for (const a of await readDayTradeActions(env, sinceMs)) {
      actions.push(modelActionFromIndexDt(a));
    }
  } catch (_) { /* optional */ }

  const tickets = await queryRows(env,
    `SELECT id, ticker, status, contracts, opened_ts, closed_ts, entry_premium, exit_premium,
            mirror_status, mirror_close_status, mirror_contracts, mirror_order_id
       FROM convexity_tickets
      WHERE opened_ts >= ?1 OR (closed_ts IS NOT NULL AND closed_ts >= ?1)
      ORDER BY opened_ts ASC LIMIT 200`,
    sinceMs);
  for (const t of tickets) {
    const engaged = !!(t.mirror_status || t.mirror_order_id || t.mirror_close_status);
    if (!engaged) continue;
    if (Number(t.opened_ts) >= sinceMs) actions.push(modelActionFromConvexityTicket(t, "entry"));
    if (t.closed_ts && Number(t.closed_ts) >= sinceMs) {
      actions.push(modelActionFromConvexityTicket(t, "exit"));
    }
  }

  const ring = await readClientRing(env);
  const intents = await queryRows(env,
    `SELECT id, trade_id, ticker, side, qty, status, last_reason, created_ts
       FROM broker_intents
      WHERE status = 'pending' AND created_ts >= ?1
      ORDER BY created_ts ASC LIMIT 200`,
    sinceMs - 3 * 86400000);
  const idxLog = await kvJson(env, INDEX_TREND_MIRROR_LOG_KEY);
  const dtLog = await kvJson(env, OPT_DT_MIRROR_LOG_KEY);
  const mirrorLogs = [...idxLog, ...dtLog];

  const rows = buildCoverageRows(actions, { ring, intents, mirrorLogs, nowMs, graceMs });
  const anomalies = coverageAnomalies(rows, { nowMs, graceMs });
  const summary = {
    actions: rows.length,
    mirrored: rows.filter((r) => r.status === "mirrored").length,
    mirrored_partial: rows.filter((r) => r.status === "mirrored_partial").length,
    pending_intent: rows.filter((r) => r.status === "pending_intent").length,
    rejected_terminal: rows.filter((r) => r.status === "rejected_terminal").length,
    deferred: rows.filter((r) => r.status === "deferred").length,
    in_flight: rows.filter((r) => r.status === "in_flight").length,
    unmatched: rows.filter((r) => r.status === "unmatched").length,
    anomalies: anomalies.length,
    fails: anomalies.filter((a) => a.severity === "fail").length,
    heals: coverageHealPlan(anomalies),
  };
  return { since_ms: sinceMs, ts: nowMs, actions: rows, anomalies, summary };
}

export function nyDateKey(nowMs = Date.now()) {
  return new Date(nowMs).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

/** Compact desk view of a coverage snapshot (emails, Execution Review, digest). */
export function summarizeCoverageForDesk(snap) {
  const s = snap?.summary || {};
  const fails = (snap?.anomalies || []).filter((a) => a.severity === "fail").slice(0, 6);
  const actions = Number(s.actions) || 0;
  const failN = Number(s.fails) || 0;
  return {
    ts: snap?.ts || null,
    actions,
    mirrored: Number(s.mirrored) || 0,
    mirrored_partial: Number(s.mirrored_partial) || 0,
    unmatched: Number(s.unmatched) || 0,
    pending_intent: Number(s.pending_intent) || 0,
    rejected_terminal: Number(s.rejected_terminal) || 0,
    fails: failN,
    sample: fails.map((a) => ({
      ticker: a.ticker || null,
      lane: a.lane || null,
      event: a.event || null,
      reason: a.reason || a.detail || null,
    })),
    healthy: failN === 0 && actions > 0,
    quiet: actions === 0,
  };
}

export function coverageDeskHeadline(desk) {
  if (!desk) return "Coverage snapshot not taken yet";
  if (desk.quiet) return "No model actions in the coverage window";
  if (desk.healthy) return `${desk.actions} model action${desk.actions === 1 ? "" : "s"} mirrored`;
  return `${desk.fails} unmatched model action${desk.fails === 1 ? "" : "s"}`;
}

export function coverageDeskPlainLines(desk) {
  if (!desk) return "Broker coverage: snapshot not taken yet.";
  const bits = [
    `Broker coverage: ${coverageDeskHeadline(desk)}`,
    `  mirrored ${desk.mirrored} · unmatched ${desk.unmatched} · pending ${desk.pending_intent} · terminal ${desk.rejected_terminal}`,
  ];
  for (const row of desk.sample || []) {
    bits.push(`  ${row.ticker} ${row.lane} ${row.event} — ${String(row.reason || "").slice(0, 80)}`);
  }
  return bits.join("\n");
}

function escHtml(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Dark-theme HTML snippet that matches emailLayout / Account today. */
export function renderCoverageEmailBlock(desk, { href, linkLabel } = {}) {
  const tone = !desk ? "#6b7280" : desk.healthy ? "#00c853" : desk.quiet ? "#9ca3af" : "#ef4444";
  const sample = (desk?.sample || []).map((row) =>
    `<div style="margin:4px 0 0;font-size:12px;color:#9ca3af;font-family:'SF Mono',Menlo,Consolas,'Courier New',monospace">${
      escHtml(String(row.ticker || "").toUpperCase())
    } ${escHtml(row.lane || "")} ${escHtml(row.event || "")} — ${escHtml(String(row.reason || "").slice(0, 80))}</div>`).join("");
  const safeHref = href && /^https?:\/\//i.test(String(href)) ? String(href) : "";
  const link = safeHref
    ? `<div style="margin:10px 0 0;font-size:12px"><a href="${escHtml(safeHref)}" style="color:#00c853;font-weight:700;text-decoration:none">${escHtml(linkLabel || "Open Execution Review →")}</a></div>`
    : "";
  return `
    <p style="margin:18px 0 8px;font-size:11px;font-weight:700;color:#6b7280;letter-spacing:0.08em;text-transform:uppercase">Model vs broker</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 8px;background:#0b0e11;border:1px solid #1e2128;border-radius:10px">
      <tr><td style="padding:14px 16px">
        <div style="font-size:15px;font-weight:700;color:${tone}">${escHtml(coverageDeskHeadline(desk))}</div>
        ${desk ? `<div style="margin:6px 0 0;font-size:12px;color:#9ca3af;font-family:'SF Mono',Menlo,Consolas,'Courier New',monospace">mirrored ${Number(desk.mirrored) || 0} · unmatched ${Number(desk.unmatched) || 0} · pending ${Number(desk.pending_intent) || 0} · terminal ${Number(desk.rejected_terminal) || 0}</div>` : ""}
        ${sample}
        ${link}
      </td></tr>
    </table>`;
}

/** One Discord “clean” line per NY day when the contract is healthy. */
export async function notifyCoverageCleanIfDue(env, desk, { nowMs = Date.now(), notify } = {}) {
  if (!desk?.healthy || typeof notify !== "function") return false;
  const day = nyDateKey(nowMs);
  let lastClean = "";
  try { lastClean = String((await env?.KV_TIMED?.get(COVERAGE_CLEAN_DAY_KEY)) || ""); } catch (_) { lastClean = ""; }
  if (lastClean === day) return false;
  await notify({
    title: "BROKER COVERAGE · clean",
    description: `${desk.actions} model action${desk.actions === 1 ? "" : "s"} mirrored · unmatched 0`,
    color: 0x30a46c,
  });
  try {
    await env?.KV_TIMED?.put(COVERAGE_CLEAN_DAY_KEY, day, { expirationTtl: 2 * 86400 });
  } catch (_) { /* best-effort */ }
  return true;
}

function pageFingerprint(anomalies) {
  return (anomalies || [])
    .filter((a) => a.severity === "fail")
    .map((a) => a.key || `${a.ticker}|${a.event}|${a.trade_id}`)
    .sort()
    .join("|");
}

/**
 * Persist a snapshot. Discord pages only when the fail set changes.
 * Does not place orders.
 */
export async function snapshotMirrorCoverage(env, {
  sinceMs,
  nowMs = Date.now(),
  notify,
} = {}) {
  const snap = await loadMirrorCoverage(env, { sinceMs, nowMs });
  try {
    await env?.KV_TIMED?.put(COVERAGE_SNAPSHOT_KEY, JSON.stringify({
      ts: snap.ts,
      since_ms: snap.since_ms,
      summary: snap.summary,
      anomalies: snap.anomalies,
      actions: snap.actions,
    }), { expirationTtl: 7 * 86400 });
  } catch (_) { /* best-effort */ }

  const fingerprint = pageFingerprint(snap.anomalies);
  let prev = "";
  try { prev = String((await env?.KV_TIMED?.get(COVERAGE_PAGED_KEY)) || ""); } catch (_) { prev = ""; }
  const shouldPage = snap.summary.fails > 0 && fingerprint && fingerprint !== prev;
  if (shouldPage && typeof notify === "function") {
    const lines = snap.anomalies
      .filter((a) => a.severity === "fail")
      .slice(0, 12)
      .map((a) => `${a.ticker} ${a.lane} ${a.event} ${a.status} — ${String(a.reason || a.detail || "").slice(0, 80)}`);
    await notify({
      title: `BROKER COVERAGE · ${snap.summary.fails} unmatched`,
      description: lines.join("\n") || "unmatched model actions",
      color: 0xc0392b,
    });
    try {
      await env?.KV_TIMED?.put(COVERAGE_PAGED_KEY, fingerprint, { expirationTtl: 2 * 86400 });
    } catch (_) { /* best-effort */ }
  }
  if (snap.summary.fails === 0 && prev) {
    try { await env?.KV_TIMED?.put(COVERAGE_PAGED_KEY, "", { expirationTtl: 3600 }); } catch (_) { /* */ }
  }

  // One clean confirmation per NY day so the desk sees that the
  // contract is live — not only the failure pages.
  const pagedClean = await notifyCoverageCleanIfDue(env, summarizeCoverageForDesk(snap), { nowMs, notify });
  return { ...snap, paged: shouldPage, paged_clean: pagedClean };
}
