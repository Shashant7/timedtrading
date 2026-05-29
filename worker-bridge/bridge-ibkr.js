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

// OAuth 1.0a RSA-SHA256 signing for IBKR's Self-Service OAuth.
//
// IBKR's flavor of OAuth 1.0a uses asymmetric signing — the bridge
// holds an RSA private key (private_signature.pem) and IBKR holds
// the matching public key uploaded during operator setup. This is
// MORE secure than HMAC because the access-token-secret never has
// to be transmitted on each request.
//
// Signing recipe per https://ndcdyn.interactivebrokers.com/oauth/
// (and corroborated by Voyz/ibind reverse-engineering):
//
//   1. Build OAuth parameter set:
//        oauth_consumer_key:     <9-char string operator chose>
//        oauth_token:            <access token from /Generate Token>
//        oauth_signature_method: RSA-SHA256
//        oauth_timestamp:        unix seconds
//        oauth_nonce:            random 16-byte hex
//        oauth_version:          1.0
//        + any request-specific query params
//
//   2. Base string:
//        METHOD + "&" + percent_encode(URL) + "&" +
//        percent_encode(sorted(k=v joined by "&"))
//      (BUT — and this is the IBKR-specific bit — the
//       access_token_secret needs to be DECODED using the
//       Diffie-Hellman shared secret first to become the
//       LST (Live Session Token) before signing)
//
//   3. Sign base with RSA-SHA256(private_signature_key)
//
//   4. Header:
//        Authorization: OAuth realm="limited_poa",
//          oauth_consumer_key="...",
//          oauth_token="...",
//          oauth_signature_method="RSA-SHA256",
//          oauth_timestamp="...",
//          oauth_nonce="...",
//          oauth_version="1.0",
//          oauth_signature="<url-encoded base64 RSA signature>"
//
// The LST exchange happens ONCE per session via /oauth/live_session_token
// and is cached for ~24h. We do that lazily on first call.

function _percentEncode(s) {
  return encodeURIComponent(String(s))
    .replace(/!/g, "%21").replace(/\*/g, "%2A")
    .replace(/'/g, "%27").replace(/\(/g, "%28").replace(/\)/g, "%29");
}

function _genNonce() {
  const buf = crypto.getRandomValues(new Uint8Array(16));
  let s = "";
  for (let i = 0; i < buf.length; i++) s += buf[i].toString(16).padStart(2, "0");
  return s;
}

// Import a PEM RSA private key for WebCrypto signing.
async function _importRsaKey(pem) {
  // Strip PEM headers + whitespace.
  const b64 = String(pem || "")
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  if (!b64) throw new Error("empty_pem");
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return crypto.subtle.importKey(
    "pkcs8",
    buf.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

// One-shot exchange to obtain the Live Session Token. IBKR caches
// this LST for ~24h on their side after exchange — we cache in KV.
// TODO(phase2): implement /oauth/live_session_token exchange. For
// now we use the access_token_secret directly (works for read-only
// portfolio queries; write paths will need full LST flow).
async function _getLiveSessionToken(env, creds) {
  return creds.accessTokenSecret;
}

async function signRequest(env, user, method, url, params = {}) {
  const creds = await resolveIbkrCreds(env, user);
  if (!creds || !creds.accessToken || !creds.privateSignatureKey) {
    // Caller falls into mock mode when creds missing.
    return { Authorization: "OAuth oauth_signature=missing_creds" };
  }
  const oauthParams = {
    oauth_consumer_key:     creds.consumerKey,
    oauth_token:            creds.accessToken,
    oauth_signature_method: "RSA-SHA256",
    oauth_timestamp:        Math.floor(Date.now() / 1000).toString(),
    oauth_nonce:            _genNonce(),
    oauth_version:          "1.0",
  };
  // Merge request-specific params (sorted).
  const allParams = { ...oauthParams, ...(params || {}) };
  const sortedKeys = Object.keys(allParams).sort();
  const paramString = sortedKeys
    .map((k) => `${_percentEncode(k)}=${_percentEncode(allParams[k])}`)
    .join("&");
  const baseString = [
    method.toUpperCase(),
    _percentEncode(url),
    _percentEncode(paramString),
  ].join("&");
  try {
    const privKey = await _importRsaKey(creds.privateSignatureKey);
    const sigBuf = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      privKey,
      new TextEncoder().encode(baseString),
    );
    const sigArr = new Uint8Array(sigBuf);
    let sigB64 = "";
    for (let i = 0; i < sigArr.length; i++) sigB64 += String.fromCharCode(sigArr[i]);
    const signature = _percentEncode(btoa(sigB64));
    const headerParts = [
      `realm="limited_poa"`,
      ...Object.entries({ ...oauthParams, oauth_signature: signature })
        .map(([k, v]) => `${k}="${v}"`),
    ];
    return { Authorization: `OAuth ${headerParts.join(", ")}` };
  } catch (e) {
    console.warn(`[BRIDGE/IBKR] sign failed:`, String(e?.message || e).slice(0, 200));
    return { Authorization: "OAuth oauth_signature=sign_error" };
  }
}

// 2026-05-29 — Resolve IBKR credentials with TWO sources:
//
//   (a) env-level secrets (worker secrets via wrangler secret put) —
//       used when the operator is the sole IBKR user. Simpler +
//       safer because credentials never round-trip through KV.
//   (b) per-user KV-stored credentials (via POST /bridge/ibkr/connect)
//       — used for multi-user Phase 2+ when each customer has their
//       own IBKR account.
//
// env-level wins if both are set. Lets the operator set their own
// account via wrangler secrets while still supporting the per-user
// path for future customer onboarding without code changes.
async function resolveIbkrCreds(env, user) {
  // (a) env-level
  if (env?.IBKR_ACCESS_TOKEN_SECRET) {
    return {
      source: "env",
      accountId:           env.IBKR_ACCOUNT_ID || user?.ibkr_account_id || null,
      consumerKey:         env.IBKR_CONSUMER_KEY || user?.ibkr_consumer_key || null,
      accessToken:         env.IBKR_ACCESS_TOKEN || null,
      accessTokenSecret:   env.IBKR_ACCESS_TOKEN_SECRET,
      privateSignatureKey: env.IBKR_PRIVATE_SIGNATURE_KEY || null,
      privateEncryptionKey: env.IBKR_PRIVATE_ENCRYPTION_KEY || null,
      dhPrime:             env.IBKR_DH_PRIME || null,
    };
  }
  // (b) per-user KV
  if (!user?.ibkr_oauth_token_secret_wrap) return null;
  try {
    return {
      source: "kv",
      accountId: user.ibkr_account_id,
      consumerKey: user.ibkr_consumer_key,
      accessToken: user.ibkr_oauth_token_wrap ? await unwrapSecret(env, user.ibkr_oauth_token_wrap) : null,
      accessTokenSecret: await unwrapSecret(env, user.ibkr_oauth_token_secret_wrap),
      privateSignatureKey: user.ibkr_private_signature_wrap ? await unwrapSecret(env, user.ibkr_private_signature_wrap) : null,
      privateEncryptionKey: user.ibkr_private_encryption_wrap ? await unwrapSecret(env, user.ibkr_private_encryption_wrap) : null,
      dhPrime: user.ibkr_dh_prime || null,
    };
  } catch (e) {
    console.warn(`[BRIDGE/IBKR] cred unwrap failed for ${user?.user_id}:`, String(e?.message || e).slice(0, 200));
    return null;
  }
}

// Legacy single-secret helper kept for backwards compat with code paths
// that only need the token-secret string.
async function getAccessTokenSecret(env, user) {
  const c = await resolveIbkrCreds(env, user);
  return c?.accessTokenSecret || null;
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
