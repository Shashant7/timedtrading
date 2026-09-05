// worker/convexity-mirror.js
//
// Broker mirror for convexity tickets (2026-09-05).
//
// The ticket ledger (convexity-tickets.js) grades the options desk. This
// module is the step after the grade: when the report card has earned it,
// a ticket's entry is placed at the broker through the options auto-mirror
// (vehicle `lotto`, operator prefs), and every ticket close is a SELL that
// either places or becomes a broker_intents row drained inside the options
// sell window. Nothing here fires when the evidence is not there.
//
// Evidence gate (convexityMirrorDecision): >= 20 closed tickets, positive
// median, win rate >= 40%. CONVEXITY_MIRROR="true" forces on (operator
// judgment), "false" forces off. The operator's vehicle toggle in Mission
// Control is still required either way.

import {
  fireAutoMirror,
  loadAutoMirrorPrefs,
  extractMirrorFill,
  reconcileIndexDtFill,
  marketableCloseLimit,
  optionTick,
} from "./options-auto-mirror.js";
import { recordBrokerIntent, OPTIONS_CLOSE_KIND } from "./broker-intents.js";

export const MIRROR_MIN_CLOSED = 20;
export const MIRROR_MIN_WIN_RATE = 40;
export const CONVEXITY_MIRROR_VEHICLE = "lotto";

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Pure. Has the desk earned the broker? */
export function convexityMirrorDecision(report, env = {}) {
  const flag = String(env?.CONVEXITY_MIRROR ?? "").toLowerCase();
  if (flag === "false") return { enabled: false, reason: "forced_off" };
  if (flag === "true") return { enabled: true, reason: "forced_on" };
  const closed = num(report?.closed_n) || 0;
  const median = num(report?.median_pnl_pct);
  const win = num(report?.win_rate_pct);
  if (closed < MIRROR_MIN_CLOSED) return { enabled: false, reason: `graded_${closed}_of_${MIRROR_MIN_CLOSED}` };
  if (!(median > 0)) return { enabled: false, reason: `median_${median}` };
  if (!(win >= MIRROR_MIN_WIN_RATE)) return { enabled: false, reason: `win_rate_${win}` };
  return { enabled: true, reason: `graded_${closed}_median_${median}_win_${win}` };
}

/** Pure. Contracts the vehicle cap allows for this premium; 0 when one lot is too big. */
export function mirrorContractsFor(ticket, vehicleRow) {
  const prem = num(ticket?.entry_premium);
  if (!(prem > 0)) return 0;
  const perContract = prem * 100;
  const cap = num(vehicleRow?.max_per_order_usd) || 0;
  const lossCap = num(vehicleRow?.max_loss_per_order_usd) || cap;
  const budget = Math.min(cap || Infinity, lossCap || Infinity);
  if (!(budget > 0) || perContract > budget) return 0;
  return Math.max(0, Math.min(Math.max(1, Math.round(num(ticket?.contracts) || 1)), Math.floor(budget / perContract)));
}

function optType(ticket) {
  return String(ticket?.side || "C").toUpperCase() === "P" ? "PUT" : "CALL";
}

export function buildTicketEntryPlay(ticket, { contracts, limit }) {
  const K = num(ticket.strike);
  const mid = Math.round(num(limit) * 100) / 100;
  return {
    archetype: optType(ticket) === "PUT" ? "lotto_put" : "lotto_call",
    label: `${ticket.ticker} ${K}${ticket.side} ${ticket.expiration} lotto`,
    ticker: ticket.ticker,
    trade_id: ticket.id,
    legs: [{ action: "BUY", optionType: optType(ticket), strike: K, expiration: ticket.expiration, qty: contracts, premium_mid: mid }],
    strikes: { primary: K },
    expiration: { iso: ticket.expiration },
    premium: { mid },
    contracts,
    max_loss_usd: Math.round(mid * 100 * contracts),
    _convexity_ticket: true,
  };
}

export function buildTicketClosePlay(ticket, { qty, limit, reason }) {
  const K = num(ticket.strike);
  const mid = Math.round(num(limit) * 100) / 100;
  return {
    archetype: optType(ticket) === "PUT" ? "lotto_put" : "lotto_call",
    label: `Close ${ticket.ticker} ${K}${ticket.side} (${String(reason || "exit").toUpperCase()})`,
    ticker: ticket.ticker,
    trade_id: ticket.id,
    legs: [{ action: "SELL", optionType: optType(ticket), strike: K, expiration: ticket.expiration, qty, premium_mid: mid, side_label: "credit" }],
    strikes: { primary: K },
    expiration: { iso: ticket.expiration },
    premium: { mid },
    contracts: qty,
    max_loss_usd: Math.round(mid * 100 * qty),
    _convexity_ticket: true,
    _close_event: String(reason || "exit").toLowerCase(),
  };
}

/** Marketable buy limit: mid plus 3% (at least one tick), never above the ask when known. */
export function ticketBuyLimit(mid, ask = null) {
  const m = num(mid);
  if (!(m > 0)) return null;
  const tick = optionTick(m);
  const bump = Math.max(tick, m * 0.03);
  const lim = Math.round(Math.round((m + bump) / tick) * tick * 100) / 100;
  const a = num(ask);
  return a > 0 ? Math.min(lim, a) : lim;
}

/**
 * Mirror a ticket entry. Returns a patch for the ticket row
 * ({ mirror_status, mirror_contracts, mirror_order_id }). Never throws.
 */
export async function mirrorConvexityTicketEntry(env, ticket, { report = null, now = Date.now() } = {}) {
  const skip = (reason) => ({ mirror_status: `skipped:${reason}`, mirror_contracts: 0, mirror_order_id: null });
  try {
    const decision = convexityMirrorDecision(report, env);
    if (!decision.enabled) return skip(decision.reason);
    const operatorEmail = env?.ADMIN_EMAIL;
    if (!operatorEmail) return skip("no_operator_email");
    const prefs = await loadAutoMirrorPrefs(env, operatorEmail);
    if (!prefs?.enabled) return skip("auto_mirror_disabled");
    const vehicleRow = prefs.vehicles?.[CONVEXITY_MIRROR_VEHICLE];
    if (!vehicleRow?.enabled) return skip(`vehicle_${CONVEXITY_MIRROR_VEHICLE}_disabled`);
    const contracts = mirrorContractsFor(ticket, vehicleRow);
    if (contracts < 1) return skip("one_lot_exceeds_vehicle_cap");
    const limit = ticketBuyLimit(ticket.entry_premium);
    if (!(limit > 0)) return skip("no_buy_limit");
    const play = buildTicketEntryPlay(ticket, { contracts, limit });
    const fired = await fireAutoMirror(env, operatorEmail, {
      trade_id: ticket.id,
      ticker: ticket.ticker,
      play,
      vehicle: CONVEXITY_MIRROR_VEHICLE,
      source: "auto_mirror_convexity",
      lifecycle: "entry",
      side: "buy",
      buy_limit: limit,
      ts_hint: now,
    });
    const fill = extractMirrorFill(fired, contracts);
    const rec = reconcileIndexDtFill({ event: "BUY", requestedQty: contracts, fill });
    if (rec.persist) {
      return { mirror_status: "placed", mirror_contracts: rec.filledQty, mirror_order_id: fill.order_id || null };
    }
    if (rec.pending) {
      return { mirror_status: "working", mirror_contracts: contracts, mirror_order_id: fill.order_id || rec.order_id || null };
    }
    return { mirror_status: `rejected:${String(fill?.reason || rec.reason || "rejected").slice(0, 80)}`, mirror_contracts: 0, mirror_order_id: null };
  } catch (e) {
    return skip(`error:${String(e?.message || e).slice(0, 80)}`);
  }
}

/**
 * Options forwarder for the intent drain: (env, order) -> normalized result
 * that classifyBridgeOutcome understands. `order` is the shape written by
 * buildTicketCloseOrder below.
 */
export async function forwardOptionsClose(env, order) {
  const operatorEmail = order?.user_id || env?.ADMIN_EMAIL;
  if (!operatorEmail) return { ok: false, skip: "no_operator_email" };
  const qty = Math.max(1, Math.round(Number(order.qty) || 1));
  const limit = num(order.limit_price);
  if (!(limit > 0)) return { ok: false, skip: "no_close_limit" };
  const ticket = order.ticket || {};
  const play = buildTicketClosePlay(ticket, { qty, limit, reason: order.reason });
  const fired = await fireAutoMirror(env, operatorEmail, {
    trade_id: order.trade_id,
    ticker: order.ticker,
    play,
    vehicle: CONVEXITY_MIRROR_VEHICLE,
    source: "auto_mirror_convexity_close",
    lifecycle: "close",
    side: "exit",
    close_event: String(order.reason || "exit").toUpperCase(),
    close_qty: qty,
    limit_price: limit,
    client_order_id: order.client_order_id || null,
  });
  const fill = extractMirrorFill(fired, qty);
  const rec = reconcileIndexDtFill({ event: "EXIT", requestedQty: qty, fill });
  if (rec.persist || rec.pending) return { ok: true, response: fired?.response || null, fill };
  return {
    ok: false,
    http_status: Number(fired?.status) || 0,
    response: { reject_reason: String(fill?.reason || rec.reason || "rejected") },
  };
}

export function buildTicketCloseOrder(ticket, { mark, reason, now = Date.now(), operatorEmail = null } = {}) {
  const qty = Math.max(1, Math.round(Number(ticket?.mirror_contracts) || 0));
  const mid = num(mark) ?? num(ticket?.mark_premium) ?? 0.01;
  const limit = marketableCloseLimit({ event: "EXIT", mid, bid: null }) || Math.max(0.01, mid * 0.9);
  return {
    _kind: OPTIONS_CLOSE_KIND,
    mode: "options",
    side: "exit",
    vehicle: "option",
    trade_id: ticket.id,
    ticker: ticket.ticker,
    qty,
    limit_price: Math.round(limit * 100) / 100,
    reason: String(reason || "exit"),
    user_id: operatorEmail || null,
    ticket: {
      id: ticket.id, ticker: ticket.ticker, side: ticket.side, strike: ticket.strike, expiration: ticket.expiration,
    },
    meta: { lane: OPTIONS_CLOSE_KIND, reason: String(reason || "exit"), ts: now },
  };
}

/**
 * Close the broker leg of a ticket. Tries once now; if it does not place,
 * the order becomes a broker_intents row and the five-minute drain owns it.
 */
export async function mirrorConvexityTicketClose(env, ticket, { mark, reason, now = Date.now() } = {}) {
  const held = Math.round(Number(ticket?.mirror_contracts) || 0);
  if (held < 1) return { mirrored: false, reason: "no_broker_leg" };
  const operatorEmail = env?.ADMIN_EMAIL || null;
  const order = buildTicketCloseOrder(ticket, { mark, reason, now, operatorEmail });
  let result;
  try {
    result = await forwardOptionsClose(env, order);
  } catch (e) {
    result = { ok: false, error: String(e?.message || e) };
  }
  const outcome = await recordBrokerIntent(env, order, result, now);
  return { mirrored: result?.ok === true, outcome, order_qty: order.qty, limit: order.limit_price };
}
