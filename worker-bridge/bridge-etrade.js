// worker-bridge/bridge-etrade.js
//
// E*TRADE adapter — same contract as bridge-webull.js / bridge-ibkr.js.
// Scaffold: mock mode always works. Live REST stays gated on
// ETRADE_LIVE_ENABLED + consumer keys + per-user OAuth access token.
//
// Live place/cancel will land after OAuth 1.0a start/callback + renew
// cron are proven against the sandbox (apisb.etrade.com).

import {
  etradeLiveEnabled,
  isBridgeMockMode,
} from "./bridge-etrade-config.js";

function mockMode(env) {
  return isBridgeMockMode(env) || !etradeLiveEnabled(env);
}

function mockOrderId() {
  return `MOCK-ET-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function reviewOrder(env, user, order) {
  if (mockMode(env)) {
    return {
      ok: true,
      mock: true,
      broker: "etrade",
      response: {
        preview_id: `prev-${mockOrderId()}`,
        ticker: String(order?.ticker || order?.symbol || "").toUpperCase(),
        side: String(order?.side || "buy").toLowerCase(),
        qty: Number(order?.qty) || 0,
      },
    };
  }
  return { ok: false, error: "etrade_live_place_not_wired", broker: "etrade" };
}

export async function placeOrder(env, user, order) {
  if (mockMode(env)) {
    const qty = Number(order?.qty) || 0;
    return {
      ok: true,
      mock: true,
      broker: "etrade",
      response: {
        order_id: mockOrderId(),
        filled_qty: qty,
        status: "filled",
        account_id: order?.etrade_account_id || user?.etrade_account_id || "MOCK_ETRADE",
        ticker: String(order?.ticker || order?.symbol || "").toUpperCase(),
        side: String(order?.side || "buy").toLowerCase(),
        qty,
      },
    };
  }
  return { ok: false, error: "etrade_live_place_not_wired", broker: "etrade" };
}

export async function getPortfolio(env, user) {
  if (mockMode(env)) {
    return {
      ok: true,
      mock: true,
      broker: "etrade",
      response: {
        account_id: user?.etrade_account_id || "MOCK_ETRADE",
        cash: 25000,
        equity: 100000,
        buying_power: 25000,
      },
    };
  }
  return { ok: false, error: "etrade_live_portfolio_not_wired", broker: "etrade" };
}

export async function getEquityPositions(env, user) {
  if (mockMode(env)) {
    return {
      ok: true,
      mock: true,
      broker: "etrade",
      positions: [],
    };
  }
  return { ok: false, error: "etrade_live_positions_not_wired", broker: "etrade", positions: [] };
}

export async function cancelOrder(env, user, orderId) {
  if (mockMode(env)) {
    return {
      ok: true,
      mock: true,
      broker: "etrade",
      response: { order_id: orderId, status: "cancelled" },
    };
  }
  return { ok: false, error: "etrade_live_cancel_not_wired", broker: "etrade" };
}

export async function listOrders(env, user, opts = {}) {
  if (mockMode(env)) {
    return {
      ok: true,
      mock: true,
      broker: "etrade",
      orders: [],
      opts,
    };
  }
  return { ok: false, error: "etrade_live_list_orders_not_wired", broker: "etrade", orders: [] };
}
