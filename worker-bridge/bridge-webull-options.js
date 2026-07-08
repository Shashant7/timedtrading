// worker-bridge/bridge-webull-options.js
//
// Webull options: preview + place single-leg long call/put (LMT).
// Docs: https://developer.webull.com/apis/docs/trade-api/options.md

import {
  ensureWebullAccessToken,
  webullGetPositions,
  webullPostOptionsOrder,
} from "./bridge-webull-api.js";
import { WEBULL_API_PATHS, isBridgeMockMode, webullLiveEnabled } from "./bridge-webull-config.js";

function isMockMode(env) {
  return isBridgeMockMode(env) || !webullLiveEnabled(env);
}

/**
 * Translate a TT ladder play into a Webull single-leg option order.
 */
export function playToWebullOptionOrder(play, symbol) {
  if (!play || !Array.isArray(play.legs) || play.legs.length === 0) return null;
  const sym = String(symbol || play.ticker || play.legs[0]?.ticker || "").toUpperCase();
  if (play.legs.length !== 1) return null;

  const leg = play.legs[0];
  if (!leg.optionType && leg.instrument !== "OPTION") return null;

  const right = String(leg.optionType || leg.right || "").toUpperCase();
  const optionType = right.includes("P") ? "PUT" : "CALL";
  const strike = Number(leg.strike);
  const exp = leg.expiration || leg.expire_date || null;
  const qty = Number(leg.qty) || Number(play.contracts) || 1;
  const limit = Number(
    play.premium?.mid
    ?? leg.premium_mid
    ?? leg.limit_price
    ?? play.limit_price,
  );

  if (!(strike > 0) || !exp || !(limit > 0)) return null;

  return {
    type: "single",
    symbol: sym,
    action: String(leg.action || "BUY").toUpperCase(),
    qty,
    strike,
    expiration: exp,
    option_type: optionType,
    limit_price: limit,
    order_type: "LMT",
    trade_id: play.trade_id || null,
  };
}

export function buildWebullOptionOrderPayload(user, order, { preview = false } = {}) {
  const accountId = user?.webull_account_id;
  if (!accountId) throw new Error("webull_account_id_missing");

  const sym = String(order.symbol || "").toUpperCase();
  const qty = Number(order.qty) || 1;
  const strike = Number(order.strike);
  const exp = String(order.expiration || "");
  const optionType = String(order.option_type || "CALL").toUpperCase();
  const side = String(order.action || "BUY").toUpperCase();
  const limit = Number(order.limit_price);

  if (!sym || !(strike > 0) || !exp || !(limit > 0)) {
    throw new Error("incomplete_option_order");
  }

  const clientOrderId = preview
    ? `tt-opt-prev-${crypto.randomUUID().slice(0, 10)}`
    : `tt-opt-${order.trade_id || "na"}-${crypto.randomUUID().slice(0, 8)}`.slice(0, 32);

  const newOrder = {
    client_order_id: clientOrderId,
    combo_type: "NORMAL",
    order_type: "LIMIT",
    limit_price: limit.toFixed(2),
    quantity: String(qty),
    option_strategy: "SINGLE",
    side,
    time_in_force: "DAY",
    entrust_type: "QTY",
    instrument_type: "OPTION",
    market: "US",
    symbol: sym,
    legs: [{
      side,
      quantity: String(qty),
      symbol: sym,
      strike_price: strike.toFixed(2),
      option_expire_date: exp,
      instrument_type: "OPTION",
      option_type: optionType,
      market: "US",
    }],
  };

  return {
    account_id: accountId,
    new_orders: [newOrder],
  };
}

function _mockOptionsResponse(kind, order, t0) {
  const sym = String(order?.symbol || "AAPL").toUpperCase();
  return {
    ok: true,
    mock: true,
    broker: "webull",
    kind,
    latency_ms: Math.max(20, Date.now() - t0),
    response: {
      preview_status: kind === "review" ? "ok" : undefined,
      order_id: kind === "place" ? `mock_wb_opt_${crypto.randomUUID().slice(0, 8)}` : undefined,
      symbol: sym,
      qty: Number(order?.qty) || 1,
      limit_price: order?.limit_price,
      option_type: order?.option_type,
      strike: order?.strike,
      expiration: order?.expiration,
    },
  };
}

async function _postOptionOrder(env, user, order, { preview }) {
  const tok = await ensureWebullAccessToken(env, user);
  if (!tok.ok) return tok;

  const body = buildWebullOptionOrderPayload(user, order, { preview });
  const path = preview ? WEBULL_API_PATHS.orderPreview : WEBULL_API_PATHS.orderPlace;
  return webullPostOptionsOrder(env, { path, body, accessToken: tok.access_token });
}

export async function reviewOptionsOrder(env, user, order) {
  const t0 = Date.now();
  if (isMockMode(env)) return _mockOptionsResponse("review", order, t0);
  const res = await _postOptionOrder(env, user, order, { preview: true });
  return { ...res, latency_ms: Math.max(1, Date.now() - t0) };
}

export async function placeOptionsOrder(env, user, order) {
  const t0 = Date.now();
  if (isMockMode(env)) return _mockOptionsResponse("place", order, t0);
  const res = await _postOptionOrder(env, user, order, { preview: false });
  return { ...res, latency_ms: Math.max(1, Date.now() - t0) };
}

export function normalizeWebullOptionsPositions(positionsResp) {
  const envelope = positionsResp?.response?.data ?? positionsResp?.response ?? positionsResp;
  const rows = Array.isArray(envelope) ? envelope : (Array.isArray(envelope?.positions) ? envelope.positions : []);
  return rows
    .filter((p) => {
      const t = String(p?.instrument_type || p?.instrumentType || "").toUpperCase();
      return t === "OPTION" || t === "OPTIONS";
    })
    .map((p) => {
      const qty = Number(p.qty ?? p.quantity);
      return {
        symbol: String(p.symbol || "").toUpperCase(),
        underlying: String(p.underlying_symbol || p.underlying || p.symbol || "").toUpperCase(),
        qty,
        option_type: String(p.option_type || p.optionType || "").toUpperCase(),
        strike: Number(p.strike_price ?? p.strike),
        expiration: p.option_expire_date || p.expiration || null,
        avg_cost: Number(p.cost_price ?? p.avg_cost) || null,
        unrealized_pnl: Number(p.unrealized_profit_loss ?? p.unrealized_pnl) || null,
        market_value: Number(p.market_value) || null,
        raw: p,
      };
    })
    .filter((p) => p.symbol || p.underlying);
}

export async function getOptionsPositions(env, user) {
  const t0 = Date.now();
  if (isMockMode(env)) return { ok: true, positions: [], latency_ms: Date.now() - t0 };
  const tok = await ensureWebullAccessToken(env, user);
  if (!tok.ok) return tok;
  const raw = await webullGetPositions(env, user, tok.access_token);
  const parsed = normalizeWebullOptionsPositions(raw);
  return { ok: true, positions: parsed, latency_ms: Date.now() - t0 };
}
