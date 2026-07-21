// worker-bridge/bridge-robinhood.js
//
// 2026-05-29 — Robinhood Agentic Trading MCP client.
// 2026-07-21 — Robinhood shipped the official Agentic Trading MCP (launched
// May 2026) at https://agent.robinhood.com/mcp/trading with the exact tools we
// scaffolded (review/place/cancel_equity_order + reads). The transport is MCP
// "Streamable HTTP". This module now speaks it properly:
//   - 2025-11-25 spec: `initialize` handshake → `Mcp-Session-Id` on every
//     tools/call. (Robinhood launched under this spec.)
//   - 2026-07-28 spec: stateless — no handshake/session; routing headers
//     (MCP-Protocol-Version / Mcp-Method / Mcp-Name) + `_meta` in the body.
//   Select via env RH_MCP_PROTOCOL_VERSION (default "2025-11-25").
//   Responses may be application/json OR text/event-stream (SSE) — both parsed.
//
// STILL REQUIRED before live orders flow (see skills/broker-bridge.md):
//   1. A funded, dedicated Robinhood *Agentic account* (desktop-only to create).
//   2. An OAuth token for it (MCP OAuth) stored on the user row (rh_token_wrap).
//   3. Live verification of the place_equity_order arg schema (limit/fractional).
// Until then MOCK MODE (default) simulates success for end-to-end flow testing.

import { unwrapSecret } from "./bridge-crypto.js";

const RH_MCP_BASE = "https://agent.robinhood.com/mcp/trading";
const RH_MCP_DEFAULT_PROTOCOL = "2025-11-25";
const RH_CLIENT_INFO = { name: "tt-broker-bridge", version: "0.2" };

// In-memory session cache (2025-11-25 spec). Keyed by a short token hash so a
// worker instance reuses one session across calls within its lifetime.
const _mcpSessions = new Map(); // tokenKey -> { sessionId, ts }
const MCP_SESSION_TTL_MS = 10 * 60 * 1000;

function isMockMode(env) {
  return String(env?.BROKER_BRIDGE_MOCK || "true").toLowerCase() !== "false";
}

function rhProtocolVersion(env) {
  return String(env?.RH_MCP_PROTOCOL_VERSION || RH_MCP_DEFAULT_PROTOCOL);
}

/** Headers for an MCP Streamable HTTP request. Stateless spec adds routing headers. */
export function buildMcpHeaders({ token, protocolVersion, toolName, sessionId = null, stateless = false } = {}) {
  const h = {
    "Content-Type": "application/json",
    // MCP servers may stream the response as SSE; accept both.
    "Accept": "application/json, text/event-stream",
    "MCP-Protocol-Version": protocolVersion,
    "User-Agent": `${RH_CLIENT_INFO.name}/${RH_CLIENT_INFO.version}`,
  };
  if (token) h["Authorization"] = `Bearer ${token}`;
  if (stateless) {
    // 2026-07-28: routable headers so gateways route without body inspection.
    h["Mcp-Method"] = "tools/call";
    if (toolName) h["Mcp-Name"] = toolName;
  } else if (sessionId) {
    h["Mcp-Session-Id"] = sessionId;
  }
  return h;
}

/** JSON-RPC body for a tools/call. Stateless spec carries client info in _meta. */
export function buildToolCallBody({ toolName, args, protocolVersion, stateless = false } = {}) {
  const body = {
    jsonrpc: "2.0",
    id: crypto.randomUUID(),
    method: "tools/call",
    params: { name: toolName, arguments: args || {} },
  };
  if (stateless) {
    body.params._meta = {
      protocolVersion,
      clientInfo: RH_CLIENT_INFO,
      capabilities: {},
    };
  }
  return body;
}

/**
 * Parse an MCP Streamable HTTP response body, which is either a JSON-RPC object
 * (application/json) or an SSE stream (text/event-stream) whose `data:` lines
 * carry JSON-RPC frames. Returns the last JSON-RPC object found.
 */
export function parseMcpResponseText(text, contentType = "") {
  if (!text) return null;
  const ct = String(contentType || "").toLowerCase();
  if (ct.includes("text/event-stream") || /^\s*(event:|data:)/m.test(text)) {
    let last = null;
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^data:\s?(.*)$/);
      if (!m) continue;
      const payload = m[1].trim();
      if (!payload || payload === "[DONE]") continue;
      try { last = JSON.parse(payload); } catch (_) { /* skip non-JSON frames */ }
    }
    return last;
  }
  try { return JSON.parse(text); } catch (_) { return null; }
}

/** Extract a tool result (or throw-ish error info) from a JSON-RPC response. */
export function extractToolResult(rpc) {
  if (!rpc || typeof rpc !== "object") return { ok: false, error: "empty_mcp_response" };
  if (rpc.error) return { ok: false, error: `mcp_error:${rpc.error?.message || rpc.error?.code || "unknown"}`, response: rpc.error };
  const result = rpc.result ?? rpc;
  // MCP tool results wrap content; surface structuredContent when present.
  const structured = result?.structuredContent ?? result?.content ?? result;
  const isError = result?.isError === true;
  return { ok: !isError, response: structured, raw: result };
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

async function _tokenKey(token) {
  return String(token || "").slice(-16);
}

// 2025-11-25 spec: establish a session via `initialize` and cache the
// Mcp-Session-Id. Returns the session id or null (server may be stateless).
async function ensureMcpSession(env, token, protocolVersion) {
  const key = await _tokenKey(token);
  const cached = _mcpSessions.get(key);
  if (cached && Date.now() - cached.ts < MCP_SESSION_TTL_MS) return cached.sessionId;

  const body = {
    jsonrpc: "2.0", id: crypto.randomUUID(), method: "initialize",
    params: { protocolVersion, capabilities: {}, clientInfo: RH_CLIENT_INFO },
  };
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), 12_000);
  try {
    const r = await fetch(RH_MCP_BASE, {
      method: "POST",
      signal: controller.signal,
      headers: buildMcpHeaders({ token, protocolVersion, toolName: null }),
      body: JSON.stringify(body),
    });
    const sessionId = r.headers.get("Mcp-Session-Id") || r.headers.get("mcp-session-id") || null;
    if (sessionId) {
      _mcpSessions.set(key, { sessionId, ts: Date.now() });
      // Best-effort `notifications/initialized` per spec (fire-and-forget).
      fetch(RH_MCP_BASE, {
        method: "POST",
        headers: buildMcpHeaders({ token, protocolVersion, toolName: null, sessionId }),
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      }).catch(() => {});
    }
    return sessionId;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(tid);
  }
}

// Generic MCP tools/call over Streamable HTTP. Mock mode short-circuits.
export async function callMcpTool(env, user, toolName, args) {
  const t0 = Date.now();
  if (isMockMode(env)) {
    return _mockResponse(toolName, args, t0);
  }
  const token = await getUserAccessToken(env, user);
  if (!token) {
    return { ok: false, error: "no_access_token", latency_ms: Date.now() - t0 };
  }
  const protocolVersion = rhProtocolVersion(env);
  const stateless = protocolVersion >= "2026-07-28";

  let sessionId = null;
  if (!stateless) {
    sessionId = await ensureMcpSession(env, token, protocolVersion);
  }

  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), 12_000);
  try {
    const r = await fetch(RH_MCP_BASE, {
      method: "POST",
      signal: controller.signal,
      headers: buildMcpHeaders({ token, protocolVersion, toolName, sessionId, stateless }),
      body: JSON.stringify(buildToolCallBody({ toolName, args, protocolVersion, stateless })),
    });
    const text = await r.text().catch(() => "");
    const rpc = parseMcpResponseText(text, r.headers.get("Content-Type"));
    const result = extractToolResult(rpc);
    // A stale session (404/expired) → drop cache so the next call re-inits.
    if (!r.ok && (r.status === 404 || r.status === 401)) {
      _mcpSessions.delete(await _tokenKey(token));
    }
    return {
      ok: r.ok && result.ok,
      http_status: r.status,
      response: result.response ?? (text || null),
      error: result.ok ? undefined : result.error,
      latency_ms: Date.now() - t0,
    };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 200), latency_ms: Date.now() - t0 };
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

// get_equity_orders — order status history. Used by fill reconciliation.
export async function listOrders(env, user) {
  return callMcpTool(env, user, "get_equity_orders", {
    account_number: user.rh_account_number,
  });
}

// get_equity_tradability — is a symbol tradable + fractional-eligible.
export async function getEquityTradability(env, user, symbol) {
  return callMcpTool(env, user, "get_equity_tradability", {
    account_number: user.rh_account_number,
    symbol: String(symbol || "").toUpperCase(),
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
    case "get_equity_orders":
      return { ...base, response: { orders: [] } };
    case "get_equity_tradability":
      return { ...base, response: { symbol: args?.symbol, tradable: true, fractional: true } };
    case "get_accounts":
      return { ...base, response: { accounts: [{ account_number: "mock_RH_account_1", type: "agentic" }] } };
    default:
      return { ...base, response: { note: "mock_default", echoed_args: args } };
  }
}
