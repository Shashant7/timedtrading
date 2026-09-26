// worker-bridge/bridge-etrade-auth.js
//
// E*TRADE OAuth 1.0a connect flow (scaffold).
//
// Flow (live, once ETRADE_CONSUMER_KEY/SECRET are set):
//   1. POST /bridge/etrade/oauth/start  → request token + authorize URL
//   2. User authorizes at us.etrade.com → callback with oauth_verifier
//   3. GET  /bridge/etrade/oauth/callback → access token (encrypted at rest)
//   4. Cron renewAccessToken before midnight ET / after 2h idle
//
// Until live keys land, start/connect persist a mock-connected user row
// so Mission Control + mirror routing can be exercised end-to-end.

import { wrapSecret } from "./bridge-crypto.js";
import { readUser, writeUser } from "./bridge-storage.js";
import {
  etradeApiBase,
  etradeAuthorizeUrl,
  etradeCallbackUrl,
  etradeConsumerConfigured,
  isBridgeMockMode,
} from "./bridge-etrade-config.js";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function normalizeEmail(v) {
  return String(v || "").trim().toLowerCase();
}

/**
 * Operator connect — mock or stub until OAuth 1.0a signing is live.
 * Body: { user_id, etrade_account_id?, mock?: true }
 */
export async function handleEtradeConnect(env, req) {
  const body = await req.json().catch(() => ({}));
  const userId = normalizeEmail(body?.user_id);
  if (!userId) return json({ ok: false, error: "user_id_required" }, 400);

  const mock = isBridgeMockMode(env) || body?.mock === true || !etradeConsumerConfigured(env);
  const acctId = String(body?.etrade_account_id || body?.account_id || "MOCK_ETRADE").trim();
  const existing = (await readUser(env, userId)) || { user_id: userId };

  const user = {
    ...existing,
    broker: "etrade",
    status: "connected",
    connected_at: Date.now(),
    etrade_account_id: acctId,
    etrade_auth_mode: mock ? "mock" : "oauth1a",
    mock_mode: mock,
    // Live tokens go here after callback (encrypted).
    etrade_access_token_wrap: existing.etrade_access_token_wrap || null,
    etrade_access_token_secret_wrap: existing.etrade_access_token_secret_wrap || null,
    etrade_token_obtained_at: existing.etrade_token_obtained_at || null,
    broker_integration_enabled: existing.broker_integration_enabled ?? false,
    daily_order_count: existing.daily_order_count || 0,
    daily_order_count_date: existing.daily_order_count_date || new Date().toISOString().slice(0, 10),
    total_orders_lifetime: existing.total_orders_lifetime || 0,
    user_caps: existing.user_caps || {
      max_per_order_usd: Number(env?.DEFAULT_MAX_ORDER_USD) || 5000,
      max_orders_per_day: Number.isFinite(Number(env?.DEFAULT_MAX_ORDERS_PER_DAY))
        ? Number(env.DEFAULT_MAX_ORDERS_PER_DAY)
        : 0,
    },
  };
  await writeUser(env, userId, user);

  return json({
    ok: true,
    user_id: userId,
    broker: "etrade",
    etrade_account_id: acctId,
    mock_mode: mock,
    broker_integration_enabled: user.broker_integration_enabled,
    note: mock
      ? "E*TRADE connected in MOCK mode. Flip BROKER_BRIDGE_MOCK=false + set ETRADE_CONSUMER_KEY/SECRET, then complete OAuth 1.0a before enabling live orders."
      : "E*TRADE row reserved. Complete OAuth 1.0a via /bridge/etrade/oauth/start before enabling live orders.",
    authorize_hint: etradeAuthorizeUrl(env),
    api_base: etradeApiBase(env),
    callback_configured: !!etradeCallbackUrl(env),
    consumer_configured: etradeConsumerConfigured(env),
  });
}

/**
 * Start OAuth 1.0a. Live path not wired until signing lands — returns
 * structured next-steps so operators know what is blocked.
 */
export async function handleEtradeOauthStart(env, req) {
  const body = await req.json().catch(() => ({}));
  const userId = normalizeEmail(body?.user_id);
  if (!userId) return json({ ok: false, error: "user_id_required" }, 400);

  if (!etradeConsumerConfigured(env)) {
    return json({
      ok: false,
      error: "etrade_consumer_not_configured",
      remediation: "Set ETRADE_CONSUMER_KEY + ETRADE_CONSUMER_SECRET on tt-broker-bridge (sandbox keys from developer.etrade.com).",
      fallback: "POST /bridge/etrade/connect with mock:true to exercise the adapter without keys.",
    }, 503);
  }

  // Live request-token exchange is the next slice. Do not invent unsigned
  // OAuth calls — fail closed with an explicit reason.
  return json({
    ok: false,
    error: "etrade_oauth_request_token_not_wired",
    user_id: userId,
    note: "Consumer keys are present, but OAuth 1.0a HMAC-SHA1 request-token exchange is not shipped yet. Use /bridge/etrade/connect?mock for E2E mirror routing tests.",
    api_base: etradeApiBase(env),
    authorize_url_template: `${etradeAuthorizeUrl(env)}?key={CONSUMER_KEY}&token={REQUEST_TOKEN}`,
    callback: etradeCallbackUrl(env) || null,
  }, 501);
}

export async function handleEtradeOauthCallback(env, req) {
  const url = new URL(req.url);
  const verifier = url.searchParams.get("oauth_verifier");
  const token = url.searchParams.get("oauth_token");
  if (!verifier || !token) {
    return json({ ok: false, error: "missing_oauth_verifier_or_token" }, 400);
  }
  return json({
    ok: false,
    error: "etrade_oauth_access_token_not_wired",
    note: "Callback received verifier — access-token exchange lands with the signing slice.",
    oauth_token: String(token).slice(0, 12) + "…",
  }, 501);
}

export async function handleEtradeOauthDisconnect(env, req) {
  const body = await req.json().catch(() => ({}));
  const userId = normalizeEmail(body?.user_id);
  if (!userId) return json({ ok: false, error: "user_id_required" }, 400);
  const existing = await readUser(env, userId);
  if (!existing || String(existing.broker || "").toLowerCase() !== "etrade") {
    return json({ ok: false, error: "etrade_user_not_found" }, 404);
  }
  const user = {
    ...existing,
    status: "disconnected",
    broker_integration_enabled: false,
    etrade_access_token_wrap: null,
    etrade_access_token_secret_wrap: null,
    etrade_token_obtained_at: null,
    disconnected_at: Date.now(),
  };
  await writeUser(env, userId, user);
  return json({ ok: true, user_id: userId, broker: "etrade", status: "disconnected" });
}

/** Persist encrypted access token pair after a successful live exchange. */
export async function persistEtradeAccessToken(env, userId, { token, tokenSecret, accountId }) {
  const existing = (await readUser(env, userId)) || { user_id: userId };
  const user = {
    ...existing,
    broker: "etrade",
    status: "connected",
    etrade_account_id: accountId || existing.etrade_account_id || null,
    etrade_access_token_wrap: await wrapSecret(env, token),
    etrade_access_token_secret_wrap: await wrapSecret(env, tokenSecret),
    etrade_token_obtained_at: Date.now(),
    etrade_auth_mode: "oauth1a",
    mock_mode: false,
  };
  await writeUser(env, userId, user);
  return user;
}
