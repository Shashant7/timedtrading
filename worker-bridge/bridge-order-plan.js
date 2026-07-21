// worker-bridge/bridge-order-plan.js
//
// 2026-07-20 — Broker-agnostic order planner.
//
// The model emits ONE normalized signal (buy/sell N shares, optional SL/TP).
// This module translates that intent into a CONCRETE order plan for a specific
// broker, respecting exactly what that broker's adapter can execute today:
//   - market vs limit
//   - native bracket (parent + attached SL/TP) vs OCO children vs neither
// When a broker cannot carry the protective stop natively, the plan downgrades
// protection to `synthetic_engine` (our lifecycle engine manages the SL/TP and
// sends a plain close order when hit) rather than silently dropping the stop.
//
// Pure + deterministic — no I/O, fully unit-testable. `handleOrderWebhook`
// consumes the plan to decide what to send and audits the downgrades so the
// operator always knows whether protection lives at the broker or in-engine.

import { brokerCapabilities, brokerMeta } from "./bridge-brokers.js";

/** Lifecycle class from an order side. */
export function classifyIntent(side) {
  const s = String(side || "").toLowerCase();
  if (s === "exit" || s === "sell" || s === "close") return "close";
  if (s === "add" || s === "dca_buy" || s === "scale_in") return "add";
  if (s === "trim" || s === "reduce") return "reduce";
  return "open";
}

/** Normalize a raw bridge order payload into a broker-agnostic intent. */
export function normalizeOrderIntent(payload = {}) {
  const side = String(payload.side || "").toLowerCase();
  const vehicle = String(payload.vehicle || payload.instrument_type || "equity").toLowerCase()
    .includes("option") ? "option" : "equity";
  const kindRaw = String(payload.order_kind || payload.order_type || "").toLowerCase();
  const order_kind = kindRaw === "limit" || kindRaw === "lmt" ? "limit" : "market";
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  return {
    lifecycle: classifyIntent(side),
    side: side === "exit" ? "sell" : (side || "buy"),
    is_short: side === "short",
    vehicle,
    symbol: String(payload.ticker || payload.symbol || "").toUpperCase(),
    qty: num(payload.qty) || 0,
    order_kind,
    limit_price: num(payload.limit_price ?? (order_kind === "limit" ? payload.entry : null)),
    stop_loss: num(payload.sl ?? payload.stop_loss),
    take_profit: num(payload.tp ?? payload.take_profit),
    tif: String(payload.tif || "DAY").toUpperCase(),
    trade_id: payload.trade_id || null,
    client_order_id: payload.client_order_id || null,
  };
}

function pickTif(requested, allowed) {
  const want = String(requested || "DAY").toUpperCase();
  const list = Array.isArray(allowed) && allowed.length ? allowed : ["DAY"];
  return list.includes(want) ? want : list[0];
}

/**
 * Plan a concrete broker order from a normalized intent.
 * @returns {{broker, vehicle, ok, reject_reason, primary, protection, downgrades}}
 */
export function planBrokerOrder(brokerId, intent, opts = {}) {
  const tier = opts.tier === "native" ? "native" : "adapter";
  const meta = brokerMeta(brokerId);
  const caps = brokerCapabilities(brokerId, tier);
  const downgrades = [];

  if (!meta || !caps) {
    return { broker: brokerId || null, ok: false, reject_reason: "unknown_broker", downgrades, primary: null, protection: null };
  }
  if (!intent || !intent.symbol || !(intent.qty > 0)) {
    return { broker: meta.id, ok: false, reject_reason: "invalid_intent", downgrades, primary: null, protection: null };
  }

  const vehicle = intent.vehicle === "option" ? "option" : "equity";
  const kinds = vehicle === "option" ? caps.options : caps.equity;

  // Short-sale support.
  if (intent.is_short && meta.supportsShorts === false) {
    return { broker: meta.id, ok: false, reject_reason: "shorts_unsupported", downgrades, primary: null, protection: null };
  }

  // Resolve executable order kind (market vs limit), downgrading if needed.
  let orderType = intent.order_kind;
  if (orderType === "limit" && !kinds.limit) {
    downgrades.push({ field: "order_kind", requested: "limit", using: "market", reason: `${meta.id}_${vehicle}_limit_unsupported` });
    orderType = "market";
  }
  if (orderType === "market" && !kinds.market) {
    // Adapter can't even do market for this vehicle (e.g. RH options).
    if (kinds.limit && intent.limit_price) {
      downgrades.push({ field: "order_kind", requested: "market", using: "limit", reason: `${meta.id}_${vehicle}_market_unsupported` });
      orderType = "limit";
    } else {
      return { broker: meta.id, ok: false, reject_reason: `${vehicle}_orders_unsupported`, downgrades, primary: null, protection: null };
    }
  }

  const primary = {
    order_type: orderType,
    side: intent.side,
    qty: intent.qty,
    symbol: intent.symbol,
    tif: pickTif(intent.tif, caps.tif),
    limit_price: orderType === "limit" ? intent.limit_price : null,
    vehicle,
  };

  // Protection planning — only meaningful when OPENING with SL/TP.
  const wantsProtection = intent.lifecycle === "open"
    && (intent.stop_loss != null || intent.take_profit != null);

  let protection = { mode: "none", stop_loss: intent.stop_loss ?? null, take_profit: intent.take_profit ?? null, legs: [] };

  if (wantsProtection) {
    const protectSide = intent.side === "buy" ? "sell" : "buy";
    const legs = [];
    if (intent.stop_loss != null) {
      legs.push({ purpose: "stop_loss", order_type: "stop", side: protectSide, qty: intent.qty, stop_price: intent.stop_loss });
    }
    if (intent.take_profit != null) {
      legs.push({ purpose: "take_profit", order_type: "limit", side: protectSide, qty: intent.qty, limit_price: intent.take_profit });
    }

    if (caps.bracket) {
      protection = { mode: "native_bracket", stop_loss: intent.stop_loss ?? null, take_profit: intent.take_profit ?? null, legs };
    } else if (caps.oco && opts.ocoEnabled !== false) {
      // Emulated OCO: place SL + TP children after entry; cancel the sibling
      // when one fills (fill reconciliation drives the cancel).
      protection = { mode: "oco_children", stop_loss: intent.stop_loss ?? null, take_profit: intent.take_profit ?? null, legs };
    } else {
      // No broker-side protection — the lifecycle engine owns the SL/TP and
      // will send a plain close order when hit (gated by the close-price
      // sanity check). Make this explicit so it is never a silent gap.
      protection = { mode: "synthetic_engine", stop_loss: intent.stop_loss ?? null, take_profit: intent.take_profit ?? null, legs: [] };
      downgrades.push({
        field: "protection",
        requested: "broker_bracket",
        using: "synthetic_engine",
        reason: `${meta.id}_no_native_bracket_or_oco`,
      });
    }
  }

  return { broker: meta.id, vehicle, ok: true, reject_reason: null, primary, protection, downgrades };
}

/** Compact one-line summary of a plan for audit logs. */
export function summarizeOrderPlan(plan) {
  if (!plan) return "no_plan";
  if (!plan.ok) return `reject:${plan.reject_reason}`;
  const p = plan.primary;
  const prot = plan.protection?.mode && plan.protection.mode !== "none" ? ` +${plan.protection.mode}` : "";
  const dg = plan.downgrades?.length ? ` [${plan.downgrades.map((d) => d.reason).join(",")}]` : "";
  return `${plan.broker}:${p.side}:${p.qty}:${p.order_type}${prot}${dg}`;
}
