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
import { loadBrokerHeldEquity, loadBrokerSleeves, sleeveFor } from "./broker-held-equity.js";
import {
  isTerminalIndexTrendExitReject,
  indexTrendMirrorKey,
  INDEX_TREND_MIRROR_LOG_KEY,
  INDEX_TREND_CARRY_LETFS,
  INDEX_TREND_NEVER_ATTEMPTED_ENTRY_MS,
} from "./index-trend-auto-mirror.js";
import { readIndexTrendActions, loadIndexTrendBook } from "./index-trend-alerts.js";
import { indexTrendBookIsLive } from "./index-trend-paper.js";
import { readDayTradeActions } from "./option-day-trade-alerts.js";
import { OPT_DT_MIRROR_LOG_KEY } from "./options-auto-mirror.js";
import { canonicalDivergence } from "./mirror-kernel.js";
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
export const HEAL_INDEX_DT_EXIT = "heal-index-dt-closes";
export const HEAL_INTENT_DRAIN = "drain-broker-intents";

/** Lanes whose reduces are routed by manifest sleeve (trade_id → broker lot). */
const MANIFEST_ROUTED_LANES = new Set(["trader", "investor"]);

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

/**
 * Account-fit ceilings the bridge names when one actually bites. Every other
 * reduction is the bridge doing its job (see `ringScaleShortfall`).
 */
const SCALE_CAP_REASON_RE = /cap_per_order|cash_buffer|cash|concentration|vehicle_cap|daily_cap/i;

/**
 * Reason string when an account-fit CAP cut the order down.
 *
 * The premise this check was built on — "the ring row's own qty is already
 * account-sized, so a reduction recorded here means a cap bit" — is false.
 * The ring records the MODEL qty; relational sizing (equity / model-book
 * ratio) happens bridge-side and mutates the order without setting
 * `scaling`, which `bridge-index.js` documents at the `accepted_qty` stamp.
 * So `accepted < requested` is the NORMAL state of a mirrored order, not an
 * exception: 62 of the 200 rows in the 2026-09-22 live ring were scaled, all
 * 200 with a null reason, at ratios that are stable per ticker across days
 * (MU 0.245 on 09-17, 09-18 and 09-22; EXEL 0.159 on all three) — the
 * signature of a proportion, not a ceiling. It paged NBIS 3-of-9.98, P
 * 3-of-13.30 and MSFT 3-of-10.09 as "mirrored only in part" when each was a
 * correctly sized ~30% sleeve.
 *
 * `bridge_scale_reason` is the discriminator the bridge already provides:
 * the cap paths (per-order notional, cash ceiling, concentration) each name
 * themselves in `scaling.reason`, and relational sizing leaves it null. Only
 * a named cap is worth an operator's attention — a sleeve sized to the
 * account is the mirror working.
 *
 * The 0.5% floor keeps fractional-share rounding from reading as a partial.
 */
export function ringScaleShortfall(row) {
  const accepted = Number(row?.bridge_scaled_qty ?? row?.scaled_qty);
  const requested = Number(row?.qty ?? row?.shares ?? row?.contracts);
  if (!(accepted > 0) || !(requested > 0)) return null;
  if (accepted >= requested * 0.995) return null;
  const why = String(row?.bridge_scale_reason || "").trim();
  if (!SCALE_CAP_REASON_RE.test(why)) return null;
  const pct = Math.round((accepted / requested) * 100);
  return `broker_scaled_to_${accepted}_of_${requested}_${pct}pct_${why}`;
}

export function isCoverageTerminalReject(reason, event) {
  const text = String(reason || "");
  if (!text) return false;
  if (isTerminalIndexTrendExitReject(text)) return !isOpenEvent(event);
  if (TERMINAL_EXIT_RE.test(text)) return !isOpenEvent(event);
  return false;
}

/**
 * Gates that DECLINE an entry on purpose, by name.
 *
 * Each of these is a risk or policy rule answering "no" with its own
 * reason recorded: the per-day loss budget, a vehicle's daily cap, a
 * notional or max-loss ceiling, a signal already mirrored, a ticker the
 * lane does not trade. The order never went out because nothing was
 * supposed to send it.
 */
const DECLINED_ENTRY_RE = new RegExp([
  "daily_loss_budget",
  "vehicle_daily_cap",
  "daily_cap",
  "max_per_order",
  "over_max_loss",
  "over_cap",
  "one_lot_notional",
  "one_lot_max_loss",
  "account_too_small",
  "ticker_not_index",
  "entry_already_mirrored",
  "no_mirrored_entry",
  "kill_switch",
  "user_disabled",
  "options_not_enabled",
  "disabled",
].join("|"), "i");

/**
 * Did a gate refuse this ENTRY on purpose?
 *
 * `unmatched` means "never left the monolith", and the reason it prints
 * when no ring row exists is `never_attempted`. For a reduce that is the
 * whole point of the check. For an entry it conflated two opposite
 * findings: a signal the pipeline DROPPED, and a signal a risk gate
 * deliberately declined and wrote its reason down.
 *
 * 2026-09-24 — fifteen `index_dt ENTRY unmatched — never_attempted`
 * failures sat in the sweep. Fourteen were prior-session signals the
 * vehicle daily cap had refused and one was `QQQ 744C`, declined by the
 * loss budget. Every reason was already in `timed:opt-dt-mirror-log`;
 * coverage read the log, found no terminal match (the terminal test only
 * ever fires for a reduce) and threw the reason away. Eighteen failures
 * with nothing actionable in them is how a real one goes unnoticed — and
 * how the truncated incident record ended up showing five warnings under
 * a `fail` headline.
 *
 * A declined entry is terminal: the setup is gone and there is nothing to
 * heal hours later. A skip with NO recorded reason stays `unmatched` —
 * that one really is the pipeline dropping a signal.
 */
export function isDeclinedEntry(reason, event) {
  if (!isOpenEvent(event)) return false;
  const text = String(reason || "").trim();
  if (!text) return false;
  return DECLINED_ENTRY_RE.test(text);
}

export function isCoverageDeferredReject(reason) {
  return DEFERRED_REASONS.test(String(reason || ""));
}

function rejectText(row) {
  return String(row?.reject_reason || row?.error || row?.reason || row?.skip || row?.last_reason || "");
}

/** Sub-share dust the broker cannot sell anyway. */
export const COVERAGE_FLAT_EPSILON = 1e-6;

/**
 * Shares the broker holds for a ticker, or null when holdings are unknown.
 * `{}` from a reachable broker legitimately means "flat everywhere"; a null
 * map means the call failed and nothing may be concluded from it.
 */
export function heldCoverageQty(held, ticker) {
  if (!held || typeof held !== "object") return null;
  const key = String(ticker || "").toUpperCase().trim();
  if (!key) return null;
  const qty = Number(held[key]?.qty);
  return Number.isFinite(qty) ? qty : 0;
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
  held = null,
  sleeves = null,
  nowMs = Date.now(),
  graceMs = COVERAGE_GRACE_MS,
} = {}) {
  const hits = matchingRingRows(action, ring);
  const placed = hits.filter((r) => ringLooksLikeRealPlace(r));
  const ageMs = (Number(nowMs) || Date.now()) - (Number(action?.ts) || 0);

  if (placed.length) {
    const lastPlaced = placed[placed.length - 1];
    const qty = ringQty(lastPlaced);
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
    // A place a CAP cut down is not a clean mirror: on 2026-09-15 TNA W37
    // and UDOW W38 went out for 31 / 28 shares, the concentration ceiling
    // on a $14.8k Roth placed 5, and this returned "mirrored" with no
    // qualifier — the one thing the operator reads to decide whether a
    // signal reached the broker. Report those so a 16%-filled sleeve is
    // visible instead of green.
    //
    // Routine relational sizing is NOT a shortfall (see ringScaleShortfall),
    // and either way `broker_qty` above is already `ringQty`'s accepted
    // number, so the sleeve is recorded at what the broker took. The only
    // question here is whether it is worth an operator's attention.
    const shortfall = ringScaleShortfall(lastPlaced);
    if (shortfall) {
      return {
        status: "mirrored_partial",
        reason: shortfall,
        broker_qty: qty,
        order_id: orderId,
      };
    }
    return { status: "mirrored", reason: null, broker_qty: qty, order_id: orderId };
  }

  // The lane's own mirror row confirms the broker holds this sleeve. It
  // outranks the ring, which stays stuck on the `pending` breadcrumb
  // forever when the isolate died before the response was written back.
  if (action?.broker_confirmed) {
    return {
      status: "mirrored",
      reason: null,
      broker_qty: Number(action.broker_qty) || null,
      order_id: action.order_id || null,
    };
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
    const raw = rejectText(terminalHit).slice(0, 160);
    const side = isOpenEvent(action.event) ? "buy" : "sell";
    const named = canonicalDivergence(raw, side);
    return {
      status: "rejected_terminal",
      reason: named || raw,
      known_why: !!named,
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
  let declinedReason = null;
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
    if (isDeclinedEntry(reason, action.event)) {
      return { status: "rejected_terminal", reason: reason.slice(0, 160), broker_qty: 0, order_id: null };
    }
    // Still unmatched, but the lane said WHY. Falling through without this
    // reprints the reason as `never_attempted`, which is the one thing it
    // is not: something looked at this signal and wrote an answer down.
    if (reason) declinedReason = reason;
  }

  if (ageMs >= 0 && ageMs < graceMs) {
    return { status: "in_flight", reason: "grace_window", broker_qty: null, order_id: null };
  }

  // A reduce nobody can account for has nothing to sell when the broker
  // never held the sleeve. Asked in order of how specific the answer is:
  // this trade's own sleeve first, then the ticker's total position.
  //
  // 2026-09-14 — U and MNST paged as unmatched EXITs while the account held
  // 0 of either, and DPZ and KO paged while the account held 0.2714 and
  // 3.55. The DPZ shares belonged to two older lots and the KO shares to an
  // investor DCA sleeve; neither exited trade had a manifest sleeve, so
  // their entries never mirrored and their exits are un-actionable. A page
  // that cannot be acted on is a page nobody reads.
  if (isReduceEvent(action.event)) {
    // Only the manifest-routed lanes. A paper-lane close is dispatched off
    // its own mirror row, which is how an adopted broker-only sleeve gets
    // sold (SPYU: 9 shares the manifest has never heard of), so an absent
    // sleeve there means nothing.
    const sleeve = MANIFEST_ROUTED_LANES.has(String(action.lane || ""))
      ? sleeveFor(sleeves, action.trade_id || action.position_id)
      : null;
    if (sleeve && sleeve.filled <= COVERAGE_FLAT_EPSILON) {
      return {
        status: "rejected_terminal",
        reason: canonicalDivergence("broker_never_held_this_trade", "sell") || "broker_never_held_this_trade",
        known_why: true,
        broker_qty: 0,
        order_id: null,
      };
    }
    if (sleeve && sleeve.remaining <= COVERAGE_FLAT_EPSILON) {
      return {
        status: "rejected_terminal",
        reason: canonicalDivergence("broker_sleeve_already_flat", "sell") || "broker_sleeve_already_flat",
        known_why: true,
        broker_qty: 0,
        order_id: null,
      };
    }
    const heldQty = heldCoverageQty(held, action.ticker);
    if (heldQty != null && heldQty <= COVERAGE_FLAT_EPSILON) {
      return {
        status: "rejected_terminal",
        reason: canonicalDivergence("broker_position_already_flat", "sell") || "broker_position_already_flat",
        known_why: true,
        broker_qty: 0,
        order_id: null,
      };
    }
  }

  const falseOk = hits.find((r) => String(r?.status) === "ok" && isOpenEvent(action.event) && !ringLooksLikeRealPlace(r));
  const unmatchedReason = falseOk
    ? (falseOk.deduped ? "deduped_not_a_fill" : "false_ok_no_order_id")
    : (hits.length
      ? (rejectText(hits[hits.length - 1]) || "ring_not_a_place")
      : (declinedReason ? declinedReason.slice(0, 160) : "never_attempted"));

  // Known-why vs defect: map the raw reason onto the kernel's closed set.
  // A named divergence is terminal (nothing to heal). Anything else on a
  // reduce stays unmatched so lane catch-ups can re-fire — and is prefixed
  // `defect:` so the page says so instead of looking like a silent skip.
  // Applies to index_dt, Short Term, and index-trend (the three mirrored
  // reduce lanes); investor/convexity keep their own vocabularies.
  const side = isOpenEvent(action.event) ? "buy" : "sell";
  const named = canonicalDivergence(unmatchedReason, side);
  if (named) {
    return {
      status: "rejected_terminal",
      reason: named,
      known_why: true,
      broker_qty: isOpenEvent(action.event) ? null : 0,
      order_id: null,
    };
  }
  // 2026-09-26 — DIA index_dt ENTRY sat `unmatched — order_rejected` for the
  // whole 48h window. The ring already recorded the broker refusal; COO
  // cannot re-place ENTRIES (they must re-qualify), so the fail re-paged
  // every coverage cycle and every heal "success". A refused entry is
  // terminal the same way a declined gate is: the setup is gone.
  if (isOpenEvent(action.event) && /order_rejected|order_cancelled/i.test(unmatchedReason)) {
    return {
      status: "rejected_terminal",
      reason: String(unmatchedReason).slice(0, 160),
      known_why: true,
      broker_qty: 0,
      order_id: null,
    };
  }
  const DEFECT_REDUCE_LANES = new Set(["index_dt", "trader", "index_trend"]);
  const defectReason = (DEFECT_REDUCE_LANES.has(String(action.lane || ""))
    && isReduceEvent(action.event)
    && unmatchedReason && unmatchedReason !== "never_attempted")
    ? `defect:${String(unmatchedReason).slice(0, 140)}`
    : unmatchedReason;

  return {
    status: "unmatched",
    reason: defectReason,
    known_why: false,
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
 * A reduce that leaves the broker holding nothing cannot be the wrong size.
 *
 * The ratio test asks "is this the right FRACTION of the position?", which
 * only means something while there is a position left to be a fraction of.
 * A final flatten is judged on one thing: the account is empty afterwards.
 *
 * 2026-09-24 — GS, DINO and EMR each paged `TRIM qty drift` on a leg that
 * had reached the broker and filled, and all three were the model closing
 * out: `/timed/investor/positions` no longer listed any of them and both
 * Webull accounts held zero. The broker had done exactly the right thing
 * and the monitor called it a failure, three times, for a reason no
 * operator could act on.
 */
export function reduceWentFlat(row, held) {
  if (!isReduceEvent(row?.event)) return false;
  const after = heldCoverageQty(held, row?.ticker);
  return after != null && after <= COVERAGE_FLAT_EPSILON;
}

/**
 * Mirrored opens set the scale; later mirrored rows must stay on it
 * (model 100 / broker 2, then exit 100 / 2 — not 100).
 *
 * The basis is the SUM of the mirrored opens, not the first one. An
 * investor position is built by DCA, and every add is sized against the
 * cash the account has that day — so the first buy's ratio is a sample of
 * one, and by the third add the true ratio has moved off it. Measuring a
 * later leg against the opening sample is how a correctly sized sleeve
 * reads as drift. Summing both sides asks the question that actually
 * matters: of everything the model bought, what share did the broker buy?
 */
export function computeTradeRelativeQty(rows = [], { held = null } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const opens = list.filter((r) => isOpenEvent(r.event)
    && (r.status === "mirrored" || r.status === "mirrored_partial")
    && Number(r.model_qty || r.qty) > 0 && Number(r.broker_qty) > 0);
  if (!opens.length) return { ok: true, skipped: "no_mirrored_entry", ratio: null, drifts: [] };
  const modelTotal = opens.reduce((sum, r) => sum + Number(r.model_qty || r.qty), 0);
  const brokerTotal = opens.reduce((sum, r) => sum + Number(r.broker_qty), 0);
  if (!(modelTotal > 0) || !(brokerTotal > 0)) {
    return { ok: true, skipped: "no_mirrored_entry", ratio: null, drifts: [] };
  }
  const ratio = brokerTotal / modelTotal;
  const drifts = [];
  for (const row of list) {
    if (opens.includes(row)) continue;
    if (row.status !== "mirrored" && row.status !== "mirrored_partial") continue;
    if (!(Number(row.model_qty || row.qty) > 0) || !Number.isFinite(Number(row.broker_qty))) continue;
    if (reduceWentFlat(row, held)) continue;
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
  // A day-trade ENTRY that missed is gone with the setup — nothing to heal
  // hours later. A close that missed is a live contract the model thinks it
  // is out of, and that one is worth re-firing.
  if (lane === "index_dt" && !open) return HEAL_INDEX_DT_EXIT;
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
    const rel = computeTradeRelativeQty(group, { held: ctx.held });
    for (const row of group) {
      row.qty_ratio = rel.ratio;
      row.qty_drift = (rel.drifts || []).find((d) => d.key === row.key) || null;
    }
  }
  return rows;
}

/**
 * Say which order fell short: this one, or the entry it is selling.
 *
 * `mirror_suppressed:<reason>` is the bridge reporting that the sleeve's
 * ENTRY was rejected at preflight, so a later reduce against the same
 * trade_id has no fully-mirrored position behind it. The reason carried
 * forward belongs to that entry.
 *
 * 2026-09-24 — `EMR TRIM mirrored only in part
 * (mirror_suppressed:insufficient_cash_for_one_unit_0_lt_154.73)` reads
 * as a sell the broker refused for lack of cash, which is not a thing
 * that can happen. The sell went through and moved 4.61 shares; it was
 * the DCA buy months earlier that the cash ceiling cut down. Triage went
 * looking for a broken sell path.
 */
export function describePartialMirror(row) {
  const reason = String(row?.reason || "").trim();
  const m = reason.match(/^mirror_suppressed:(.*)$/);
  if (m && isReduceEvent(row?.event)) {
    const why = m[1].trim() || "entry not mirrored";
    return `${row.ticker} ${row.event} sold against a sleeve whose ENTRY was suppressed (${why})`;
  }
  return `${row.ticker} ${row.event} mirrored only in part (${reason || "partial"})`;
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
        // Two different causes land here now — a fan-out child rejecting,
        // and the bridge scaling the order to fit the account. Naming only
        // the first would misdescribe the second, so let the reason speak.
        detail: describePartialMirror(row),
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

export function modelActionFromIndexTrendBook(book, { letf, signalId, mirror } = {}) {
  const action = {
    lane: "index_trend",
    event: "ENTRY",
    ticker: String(letf || book?.letf_ticker || "").toUpperCase(),
    trade_id: String(signalId || ""),
    position_id: signalId || null,
    signal_id: signalId || null,
    ts: Number(book?.entry_ts) || 0,
    qty: Number(book?.shares) || 0,
    price: Number(book?.entry_letf_price) || Number(book?.last_letf_price) || 0,
    source: "idx-trend-book",
  };
  // `entry_fired` is only ever stamped on a confirmed bridge place or on a
  // sleeve adopted from a live broker position, so it settles the row even
  // when the ring never got its response written back (SPYU W38).
  if (mirror?.entry_fired) {
    action.broker_confirmed = true;
    action.broker_qty = Number(mirror.adopted_broker_qty ?? mirror.shares) || null;
    action.order_id = mirror.entry_order_id || null;
    action.adopted = mirror.adopted_from_broker === true;
  }
  return action;
}

/**
 * Live paper books, read the way the entry healer reads them.
 *
 * The index_trend lane used to be joined from `timed:idx-trend-actions`
 * alone. That tape is best-effort and stopped gaining rows on 2026-09-10,
 * so the SPYU / TNA / UDOW books opened after it went quiet were invisible
 * here: coverage reported a clean contract while three sleeves sat open
 * with no broker position and nothing paged. The book is the authority
 * Discord already fires from, so a lost tape row can no longer hide a
 * missed fill. Bounded by the healer's own catch-up window so anything
 * paged is still something a heal can act on.
 */
export async function loadIndexTrendBookActions(env, {
  sinceMs = 0,
  nowMs = Date.now(),
} = {}) {
  const out = [];
  const floor = Math.min(Number(sinceMs) || 0, (Number(nowMs) || Date.now()) - INDEX_TREND_NEVER_ATTEMPTED_ENTRY_MS);
  for (const letf of INDEX_TREND_CARRY_LETFS) {
    let loaded = null;
    try {
      loaded = await loadIndexTrendBook(env, { letf_ticker: letf });
    } catch (_) {
      continue;
    }
    const book = loaded?.book;
    if (!book || !indexTrendBookIsLive(book)) continue;
    const signalId = loaded.signal_id || book.signal_id || null;
    const ts = Number(book.entry_ts) || 0;
    if (!signalId || !(ts >= floor)) continue;
    let mirror = null;
    try {
      mirror = JSON.parse((await env?.KV_TIMED?.get(indexTrendMirrorKey(signalId))) || "null");
    } catch (_) { mirror = null; }
    out.push(modelActionFromIndexTrendBook(book, { letf, signalId, mirror }));
  }
  return out;
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

  const idxSeen = new Set();
  try {
    for (const a of await readIndexTrendActions(env, sinceMs)) {
      const action = modelActionFromIndexTrend(a);
      idxSeen.add(`${action.trade_id}|${action.event}`);
      actions.push(action);
    }
  } catch (_) { /* optional */ }
  try {
    for (const action of await loadIndexTrendBookActions(env, { sinceMs, nowMs })) {
      // An ENTRY already on the tape (or a book the model has since added
      // to) must not be counted twice.
      if (idxSeen.has(`${action.trade_id}|ENTRY`) || idxSeen.has(`${action.trade_id}|DCA_BUY`)) continue;
      actions.push(action);
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

  // Ground truth for "is there anything left to sell". Cached bridge-side
  // and worker-side, so the */5 snapshot does not hammer the broker.
  let held = null;
  try {
    held = await loadBrokerHeldEquity(env, { nowMs });
  } catch (_) { held = null; }
  let sleeves = null;
  try {
    sleeves = await loadBrokerSleeves(env);
  } catch (_) { sleeves = null; }

  const rows = buildCoverageRows(actions, { ring, intents, mirrorLogs, held, sleeves, nowMs, graceMs });
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
