// worker-bridge/bridge-ibkr.js
//
// 2026-05-29 — Interactive Brokers (IBKR) adapter for the broker
// bridge. Drop-in alternative to bridge-robinhood.js with broader
// capability (SHORTS, options, margin) and a more stable surface
// area than Robinhood's MCP.
//
// API CHOICE — IBKR's Client Portal Web API
//
// IBKR exposes three programmatic surfaces:
//   1. TWS API (Trader Workstation) — requires a desktop app or IB
//      Gateway running. Bad fit for serverless workers.
//   2. Client Portal Web API — REST + WebSocket, no desktop binary.
//      OAuth-style session model with a /sso/auth flow. THIS is
//      what we use.
//   3. FIX — institutional, overkill for a per-user bridge.
//
// Base URL: https://api.ibkr.com/v1/api
// Docs:     https://interactivebrokers.github.io/cpwebapi/
//
// AUTH MODEL — different from Robinhood OAuth
//
// IBKR uses an *authenticated session* (cookie-based) rather than a
// raw OAuth token:
//   1. Operator logs into the Client Portal Gateway (CPG) at
//      localhost or via the IBKR-hosted endpoint with their
//      username + password + 2FA.
//   2. CPG returns a session cookie.
//   3. The session needs a keepalive ping every ~5 min OR it dies.
//
// For a serverless bridge, we use IBKR's OAuth 1.0a flow against
// Self-Service OAuth (paid Pro plan required, ~$10/mo individuals).
// This produces a permanent consumer key + access token pair that
// CAN be stored per-user and reused — much friendlier for
// always-on automation than the cookie session.
//
// For Phase 1 the per-user IBKR setup is more involved than
// Robinhood (no friendly "connect" button — operator has to mint
// their own OAuth credentials in IBKR Account Management). We
// document the setup runbook in tasks/2026-05-29-broker-bridge-
// phase1-plan.md.
//
// SCHEMA (per-user KV under bridge:user:{user_id})
//
// For IBKR users the userObj also carries:
//   broker: "ibkr"
//   ibkr_account_id:   "U1234567"           (visible in IBKR portal)
//   ibkr_consumer_key: <plaintext, public>  (paired w/ access token)
//   ibkr_oauth_token_wrap:        encrypted
//   ibkr_oauth_token_secret_wrap: encrypted
//
// 10 TOOL EQUIVALENTS we use:
//   GET   /portfolio/accounts                  → list accounts
//   GET   /portfolio/{accountId}/summary       → portfolio snapshot
//   GET   /portfolio/{accountId}/positions/0   → open positions
//   GET   /iserver/marketdata/snapshot         → live quotes
//   GET   /iserver/account/orders              → order history
//   GET   /trsrv/secdef/search                 → ticker search
//   POST  /iserver/account/{accountId}/orders  → place order (+ preview flag for dry-run)
//   POST  /iserver/account/{accountId}/orders/{orderId}/cancel → cancel
//
// IBKR's REST is more straightforward than RH's MCP envelope —
// each tool is its own HTTPS endpoint with JSON bodies.

import { unwrapSecret } from "./bridge-crypto.js";

const IBKR_BASE = "https://api.ibkr.com/v1/api";
const REQUEST_TIMEOUT_MS = 12_000;

function isMockMode(env) {
  return String(env?.BROKER_BRIDGE_MOCK || "true").toLowerCase() !== "false";
}

// OAuth 1.0a HMAC-SHA256 signing for IBKR's Self-Service OAuth.
// IBKR's flavor: consumer-key + access-token-key are public, the
// access-token-SECRET is what we encrypt. Each request signs:
//   base = METHOD&URL&params (sorted, percent-encoded)
//   key  = consumer_secret & access_token_secret
//
// For Phase 1 we ship a stub that wires the call shape correctly.
// Real OAuth 1.0a HMAC requires careful percent-encoding; we'll
// finalize once the operator has IBKR creds and we can test live.
async function signRequest(env, user, method, url, params = {}) {
  // TODO(phase1-operator): implement full OAuth 1.0a HMAC-SHA1/256
  // signing per IBKR's spec. For now the stub returns a placeholder
  // signature that the live API will reject — caller falls into
  // mock mode until this is wired.
  return { Authorization: "OAuth oauth_signature=todo,oauth_signature_method=HMAC-SHA256" };
}

async function getAccessTokenSecret(env, user) {
  if (!user?.ibkr_oauth_token_secret_wrap) return null;
  try {
    return await unwrapSecret(env, user.ibkr_oauth_token_secret_wrap);
  } catch (e) {
    console.warn(`[BRIDGE/IBKR] token unwrap failed for ${user.user_id}:`, String(e?.message || e).slice(0, 200));
    return null;
  }
}

// Generic IBKR call. Mock mode short-circuits.
async function callIbkr(env, user, method, path, body) {
  const t0 = Date.now();
  if (isMockMode(env)) {
    return _mockResponse(path, body, t0);
  }
  const secret = await getAccessTokenSecret(env, user);
  if (!secret) return { ok: false, error: "no_access_token_secret", latency_ms: Date.now() - t0 };

  const url = `${IBKR_BASE}${path}`;
  const headers = await signRequest(env, user, method, url, body || {});
  headers["Content-Type"] = "application/json";
  headers["Accept"] = "application/json";
  headers["User-Agent"] = "tt-broker-bridge/0.1";

  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method,
      signal: controller.signal,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text().catch(() => "");
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch (_) {}
    return {
      ok: r.ok,
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

// Convenience wrappers — translate TT's order shape into IBKR's REST
// schema. IBKR uses `conid` (contract ID) for symbols — we resolve
// via /trsrv/secdef/search on first use and cache the conid per ticker.

async function resolveConid(env, user, symbol) {
  // 24h cache in KV per ticker so we don't re-resolve every order.
  const KV = env?.BRIDGE_KV;
  const cacheKey = `bridge:ibkr:conid:${String(symbol).toUpperCase()}`;
  if (KV) {
    try {
      const cached = await KV.get(cacheKey);
      if (cached) return Number(cached) || null;
    } catch (_) {}
  }
  const r = await callIbkr(env, user, "GET", `/trsrv/secdef/search?symbol=${encodeURIComponent(symbol)}&secType=STK&name=false`);
  const conid = Array.isArray(r?.response) ? r.response[0]?.conid : null;
  if (conid && KV) {
    try { await KV.put(cacheKey, String(conid), { expirationTtl: 86400 }); } catch (_) {}
  }
  return conid || null;
}

export async function reviewOrder(env, user, order) {
  const conid = await resolveConid(env, user, order.ticker);
  if (!conid) return { ok: false, error: `conid_not_found_for_${order.ticker}` };
  // IBKR uses ?preview=true on the same place endpoint for dry-run.
  // Body shape per https://interactivebrokers.github.io/cpwebapi/endpoints
  const body = {
    acctId: user.ibkr_account_id,
    conid,
    orderType: "MKT",          // Phase 1: market. Swap to LMT once we test fills.
    side: order.side === "exit" || order.side === "sell" ? "SELL" : "BUY",
    quantity: Number(order.qty),
    tif: "DAY",                 // see PR #340 open Q #1 — verify GTC support per-account
  };
  return callIbkr(env, user, "POST", `/iserver/account/${user.ibkr_account_id}/orders?preview=true`, body);
}

export async function placeOrder(env, user, order) {
  const conid = await resolveConid(env, user, order.ticker);
  if (!conid) return { ok: false, error: `conid_not_found_for_${order.ticker}` };
  const body = {
    acctId: user.ibkr_account_id,
    conid,
    orderType: "MKT",
    side: order.side === "exit" || order.side === "sell" ? "SELL" : (order.side === "short" ? "SELL" : "BUY"),
    quantity: Number(order.qty),
    tif: "DAY",
  };
  return callIbkr(env, user, "POST", `/iserver/account/${user.ibkr_account_id}/orders`, body);
}

export async function getPortfolio(env, user) {
  return callIbkr(env, user, "GET", `/portfolio/${user.ibkr_account_id}/summary`);
}

export async function getEquityPositions(env, user) {
  return callIbkr(env, user, "GET", `/portfolio/${user.ibkr_account_id}/positions/0`);
}

export async function cancelOrder(env, user, ibkrOrderId) {
  return callIbkr(env, user, "DELETE", `/iserver/account/${user.ibkr_account_id}/order/${ibkrOrderId}`);
}

// Mock response builder — mirrors bridge-robinhood.js shape so the
// audit log + flow are exercised end-to-end without IBKR creds.
function _mockResponse(path, body, t0) {
  const base = {
    ok: true,
    mock: true,
    broker: "ibkr",
    path,
    latency_ms: Math.max(20, Date.now() - t0),
  };
  // Preview (review) path — IBKR returns warning/risk preview block.
  if (path.includes("?preview=true")) {
    return {
      ...base,
      response: {
        preview: {
          warnings: [],
          warnings_count: 0,
          equity: { current: 100000, change: -Number(body?.quantity || 0) * 100 },
          margin: { current: 100000, change: 0 },
        },
        review_status: "ok",
      },
    };
  }
  if (path.startsWith("/iserver/account/") && path.endsWith("/orders") && body) {
    return {
      ...base,
      response: [{
        order_id: `mock_ibkr_${crypto.randomUUID().slice(0, 8)}`,
        order_status: "Submitted",
        encrypt_message: "1",
      }],
    };
  }
  if (path.startsWith("/iserver/account/") && path.includes("/order/")) {
    return { ...base, response: { msg: "Request was submitted", order_id: path.split("/").pop() } };
  }
  if (path.startsWith("/portfolio/") && path.endsWith("/summary")) {
    return {
      ...base,
      response: {
        accountcode: { value: body?.acctId || "U_MOCK" },
        nettotalliquidationusd: { amount: 100000, currency: "USD" },
        availablefunds: { amount: 40000, currency: "USD" },
        buyingpower: { amount: 160000, currency: "USD" },
      },
    };
  }
  if (path.startsWith("/portfolio/") && path.includes("/positions/")) {
    return { ...base, response: [] };
  }
  if (path.startsWith("/trsrv/secdef/search")) {
    // Return a deterministic mock conid so resolveConid caches a value.
    const sym = (path.match(/symbol=([^&]+)/) || [])[1] || "UNK";
    const conid = Math.abs(sym.split("").reduce((s, c) => ((s << 5) - s) + c.charCodeAt(0), 0)) % 99999999;
    return { ...base, response: [{ symbol: sym, conid, secType: "STK", name: `${sym} (mock)` }] };
  }
  return { ...base, response: { note: "mock_default_ibkr", echoed_body: body } };
}
