// worker-bridge/bridge-webull.js
//
// 2026-06-15 — Webull Connect adapter for tt-broker-bridge.
// Implements the same contract as bridge-robinhood.js / bridge-ibkr.js.

import {
  ensureWebullAccessToken,
  normalizeWebullBalance,
  normalizeWebullPositions,
  webullCancelOrder,
  webullGetBalance,
  webullGetPositions,
  webullLiveEnabled,
  webullPlaceOrder,
  webullPreviewOrder,
} from "./bridge-webull-api.js";
import { isBridgeMockMode } from "./bridge-webull-config.js";

function isMockMode(env) {
  return isBridgeMockMode(env) || !webullLiveEnabled(env);
}

function withLatency(base, t0) {
  return { ...base, latency_ms: Math.max(1, Date.now() - t0) };
}

function _mockResponse(kind, order, t0) {
  const sym = String(order?.ticker || "AAPL").toUpperCase();
  const qty = Number(order?.qty) || 1;
  const base = { ok: true, mock: true, latency_ms: Math.max(20, Date.now() - t0) };
  switch (kind) {
    case "review":
      return {
        ...base,
        response: {
          preview_status: "ok",
          symbol: sym,
          qty,
          estimated_value_usd: qty * 100,
        },
      };
    case "place":
      return {
        ...base,
        response: {
          order_id: `mock_wb_${crypto.randomUUID().slice(0, 8)}`,
          client_order_id: `tt-mock-${Date.now()}`,
          status: "SUBMITTED",
          symbol: sym,
          qty,
        },
      };
    case "portfolio":
      return {
        ...base,
        response: {
          total_asset: 95000,
          total_cash: 35000,
          buying_power: 35000,
          account_id: order?.webull_account_id || "MOCK_WEBULL",
        },
      };
    case "positions":
      return { ...base, response: [], positions: [] };
    case "cancel":
      return { ...base, response: { status: "CANCELLED" } };
    default:
      return { ...base, response: {} };
  }
}

async function _liveCall(env, user, fn) {
  const tok = await ensureWebullAccessToken(env, user);
  if (!tok.ok) return tok;
  const res = await fn(tok.access_token);
  return { ...res, user: tok.user, refreshed: tok.refreshed };
}

export async function reviewOrder(env, user, order) {
  const t0 = Date.now();
  if (isMockMode(env)) return _mockResponse("review", order, t0);
  const res = await _liveCall(env, user, (token) => webullPreviewOrder(env, user, order, token));
  return withLatency(res, t0);
}

export async function placeOrder(env, user, order) {
  const t0 = Date.now();
  if (isMockMode(env)) return _mockResponse("place", order, t0);
  const res = await _liveCall(env, user, (token) => webullPlaceOrder(env, user, order, token));
  return withLatency(res, t0);
}

export async function getPortfolio(env, user) {
  const t0 = Date.now();
  if (isMockMode(env)) return _mockResponse("portfolio", user, t0);
  const res = await _liveCall(env, user, (token) => webullGetBalance(env, user, token));
  if (!res.ok) return withLatency(res, t0);
  const norm = normalizeWebullBalance(res);
  return withLatency({
    ok: true,
    response: norm?.raw || res.response,
    equity: norm?.equity,
    cash: norm?.cash,
    buying_power: norm?.buying_power,
  }, t0);
}

export async function getEquityPositions(env, user) {
  const t0 = Date.now();
  if (isMockMode(env)) {
    const mock = _mockResponse("positions", user, t0);
    return { ...mock, positions: [] };
  }
  const res = await _liveCall(env, user, (token) => webullGetPositions(env, user, token));
  if (!res.ok) return withLatency(res, t0);
  const positions = normalizeWebullPositions(res);
  return withLatency({ ok: true, response: res.response, positions }, t0);
}

export async function cancelOrder(env, user, orderId) {
  const t0 = Date.now();
  if (isMockMode(env)) return _mockResponse("cancel", user, t0);
  const res = await _liveCall(env, user, (token) => webullCancelOrder(env, user, orderId, token));
  return withLatency(res, t0);
}

/** Manual probe helper — maps action names to adapter calls. */
export async function callWebullAction(env, user, action, args = {}) {
  const act = String(action || "get_portfolio").toLowerCase();
  if (act === "get_portfolio" || act === "get_balance") return getPortfolio(env, user);
  if (act === "get_equity_positions" || act === "get_positions") return getEquityPositions(env, user);
  if (act === "preview_order") {
    return reviewOrder(env, user, {
      ticker: args.symbol || args.ticker || "AAPL",
      side: args.side || "buy",
      qty: args.qty || 1,
    });
  }
  if (act === "place_order") {
    return placeOrder(env, user, {
      ticker: args.symbol || args.ticker || "AAPL",
      side: args.side || "buy",
      qty: args.qty || 1,
      trade_id: args.trade_id || "probe",
    });
  }
  return { ok: false, error: `unknown_webull_action:${act}` };
}
