// worker-bridge/bridge-robinhood.js
//
// 2026-05-29 — Robinhood Agentic Trading MCP client.
//
// PHASE 1 NOTE — the actual MCP protocol shape (HTTP transport,
// authentication headers, tool-invocation JSON-RPC envelope) is
// not yet published in Robinhood's docs. This module ships with
// MOCK MODE on by default — when env.BROKER_BRIDGE_MOCK === "true"
// every call returns a simulated success response and the audit
// log records what *would* have been sent.
//
// Once the operator has hands-on access to the RH MCP and we know
// the wire format, swap the body of `callMcpTool()` to the real
// HTTP/JSON-RPC POST and flip BROKER_BRIDGE_MOCK to "false".
//
// The 10 tools we care about (from PR #340 research):
//   get_accounts, get_portfolio, get_equity_positions, get_equity_quotes,
//   get_equity_orders, get_equity_tradability, search,
//   review_equity_order, place_equity_order, cancel_equity_order

import { unwrapSecret } from "./bridge-crypto.js";

const RH_MCP_BASE = "https://agent.robinhood.com/mcp/trading";

function isMockMode(env) {
  return String(env?.BROKER_BRIDGE_MOCK || "true").toLowerCase() !== "false";
}

// Decrypt the user's RH access token from KV-stored wrap.
async function getUserAccessToken(env, user) {
  if (!user?.rh_token_wrap) return null;
  try {
    return await unwrapSecret(env, user.rh_token_wrap);
  } catch (e) {
    console.warn(`[BRIDGE/RH] token unwrap failed for ${user.user_id}:`, String(e?.message || e).slice(0, 200));
    return null;
  }
}

// Generic MCP tool invocation. Mock mode short-circuits.
//
// JSON-RPC 2.0 envelope per the MCP spec:
//   { jsonrpc: "2.0", id: ..., method: "tools/call",
//     params: { name: "place_equity_order", arguments: { ... } } }
//
// Transport here is plain HTTPS POST with Bearer auth. The actual MCP
// streaming wire format may use SSE or WebSocket — verify once we get
// hands-on access. The placeholder POST works for any spec-compliant
// HTTP-based MCP server.
export async function callMcpTool(env, user, toolName, args) {
  const t0 = Date.now();
  if (isMockMode(env)) {
    return _mockResponse(toolName, args, t0);
  }
  const token = await getUserAccessToken(env, user);
  if (!token) {
    return {
      ok: false,
      error: "no_access_token",
      latency_ms: Date.now() - t0,
    };
  }
  const body = {
    jsonrpc: "2.0",
    id: crypto.randomUUID(),
    method: "tools/call",
    params: { name: toolName, arguments: args || {} },
  };
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), 12_000);
  try {
    const r = await fetch(RH_MCP_BASE, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
        "Accept": "application/json",
        "User-Agent": "tt-broker-bridge/0.1",
      },
      body: JSON.stringify(body),
    });
    const text = await r.text().catch(() => "");
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch (_) {}
    return {
      ok: r.ok && !parsed?.error,
      http_status: r.status,
      response: parsed || text || null,
      latency_ms: Date.now() - t0,
    };
  } catch (e) {
    return {
      ok: false,
      error: String(e?.message || e).slice(0, 200),
      latency_ms: Date.now() - t0,
    };
  } finally {
    clearTimeout(tid);
  }
}

// Convenience wrappers — translate TT's order shape into RH's MCP args.

export async function reviewOrder(env, user, order) {
  const args = {
    account_number: user.rh_account_number,
    symbol: order.ticker,
    side: order.side === "exit" ? "sell" : "buy",
    qty: Number(order.qty),
    order_type: "market",  // Phase 1: market only. Swap to limit once we test fills.
    time_in_force: "day",  // see PR #340 open question #1 — verify GTC support
  };
  return callMcpTool(env, user, "review_equity_order", args);
}

export async function placeOrder(env, user, order) {
  const args = {
    account_number: user.rh_account_number,
    symbol: order.ticker,
    side: order.side === "exit" ? "sell" : "buy",
    qty: Number(order.qty),
    order_type: "market",
    time_in_force: "day",
  };
  return callMcpTool(env, user, "place_equity_order", args);
}

export async function getPortfolio(env, user) {
  return callMcpTool(env, user, "get_portfolio", {
    account_number: user.rh_account_number,
  });
}

export async function getEquityPositions(env, user) {
  return callMcpTool(env, user, "get_equity_positions", {
    account_number: user.rh_account_number,
  });
}

export async function cancelOrder(env, user, rhOrderId) {
  return callMcpTool(env, user, "cancel_equity_order", {
    account_number: user.rh_account_number,
    order_id: rhOrderId,
  });
}

// Mock response builder. Reads like a real RH success so the audit
// log + flow can be exercised end-to-end without hitting RH.
function _mockResponse(toolName, args, t0) {
  const base = {
    ok: true,
    mock: true,
    tool: toolName,
    latency_ms: Math.max(20, Date.now() - t0),
  };
  switch (toolName) {
    case "review_equity_order":
      return {
        ...base,
        response: {
          review_status: "ok",
          warnings: [],
          estimated_value_usd: Number(args?.qty || 0) * 100,
          buying_power_after: 95000,
        },
      };
    case "place_equity_order":
      return {
        ...base,
        response: {
          order_id: `mock_${crypto.randomUUID().slice(0, 8)}`,
          status: "queued",
          submitted_at: new Date().toISOString(),
          symbol: args?.symbol,
          side: args?.side,
          qty: args?.qty,
        },
      };
    case "cancel_equity_order":
      return { ...base, response: { order_id: args?.order_id, status: "cancelled" } };
    case "get_portfolio":
      return {
        ...base,
        response: {
          account_number: args?.account_number || "mock_account",
          total_equity: 95000,
          cash: 35000,
          buying_power: 35000,
          positions_value: 60000,
        },
      };
    case "get_equity_positions":
      return { ...base, response: { positions: [] } };
    case "get_accounts":
      return { ...base, response: { accounts: [{ account_number: "mock_RH_account_1", type: "agentic" }] } };
    default:
      return { ...base, response: { note: "mock_default", echoed_args: args } };
  }
}
