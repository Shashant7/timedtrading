// worker-bridge/bridge-auth.js
//
// 2026-05-29 — OAuth flow for connecting a TT user's RH Agentic account.
//
// PHASE 1 NOTE — Robinhood has not published their OAuth endpoint
// URLs / scopes publicly. The flow here is the standard OAuth 2.0
// Authorization Code with PKCE. Once the operator gets RH OAuth
// client credentials, fill in the *_URL placeholders below.
//
// Three endpoints expose the flow:
//   POST /bridge/oauth/start      → returns { authorize_url, state }
//   GET  /bridge/oauth/callback   → RH redirects here with code+state
//   POST /bridge/oauth/disconnect → operator revokes a user's link

import { wrapSecret, randomState } from "./bridge-crypto.js";
import { recordOauthState, consumeOauthState, readUser, writeUser } from "./bridge-storage.js";
import { startRhOauth, finishRhOauth } from "./bridge-robinhood-auth.js";

function isMock(env) {
  return String(env?.BROKER_BRIDGE_MOCK || "true").toLowerCase() !== "false";
}

// ────────────────────────────────────────────────────────────────
// TODO(phase1-operator): fill these from Robinhood's OAuth docs
// once we have client credentials issued.
// ────────────────────────────────────────────────────────────────
const RH_AUTHORIZE_URL = "https://robinhood.com/oauth/authorize";  // placeholder
const RH_TOKEN_URL     = "https://api.robinhood.com/oauth/token";   // placeholder
const RH_REVOKE_URL    = "https://api.robinhood.com/oauth/revoke";  // placeholder
const RH_SCOPES        = "agentic.read agentic.trade";              // placeholder

function getRedirectUri(env, req) {
  const explicit = env?.OAUTH_REDIRECT_URI;
  if (explicit) return explicit;
  const url = new URL(req.url);
  return `${url.origin}/bridge/oauth/callback`;
}

export async function handleOauthStart(env, req) {
  const body = await req.json().catch(() => ({}));
  const userId = String(body?.user_id || "").trim().toLowerCase();
  if (!userId) {
    return { ok: false, error: "user_id_required", status: 400 };
  }
  // Live: run the real MCP OAuth (discovery → client → PKCE authorize URL).
  if (!isMock(env)) {
    return startRhOauth(env, req, userId);
  }
  // Mock: keep the legacy placeholder-URL path for end-to-end flow testing.
  const clientId = env?.ROBINHOOD_OAUTH_CLIENT_ID || "mock_client";
  const state = randomState(32);
  await recordOauthState(env, state, { user_id: userId, started_at: Date.now() });

  // Mark user as pending so the UI shows the right status.
  const existing = (await readUser(env, userId)) || { user_id: userId };
  await writeUser(env, userId, {
    ...existing,
    status: "pending_oauth",
    pending_oauth_at: Date.now(),
  });

  const redirectUri = getRedirectUri(env, req);
  const url = new URL(RH_AUTHORIZE_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", RH_SCOPES);
  url.searchParams.set("state", state);
  return {
    ok: true,
    status: 200,
    authorize_url: url.toString(),
    state,
    redirect_uri: redirectUri,
    expires_in_s: 600,
  };
}

export async function handleOauthCallback(env, req) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const err = url.searchParams.get("error");
  if (err) return { ok: false, error: `oauth_error:${err}`, status: 400 };
  if (!code || !state) return { ok: false, error: "missing_code_or_state", status: 400 };

  // Live: exchange the code via the real MCP token endpoint (PKCE + resource).
  if (!isMock(env)) {
    return finishRhOauth(env, req);
  }

  // Mock-mode shortcut so the flow can be tested without real RH OAuth.
  const stateRow = await consumeOauthState(env, state);
  if (!stateRow) return { ok: false, error: "state_expired_or_unknown", status: 400 };
  const userId = String(stateRow.user_id).toLowerCase();
  return await _finalizeMockConnection(env, userId);
}

export async function handleOauthDisconnect(env, req) {
  const body = await req.json().catch(() => ({}));
  const userId = String(body?.user_id || "").trim().toLowerCase();
  if (!userId) return { ok: false, error: "user_id_required", status: 400 };
  const existing = await readUser(env, userId);
  if (!existing) return { ok: false, error: "user_not_found", status: 404 };
  // Attempt to revoke on RH if we have an unwrappable refresh token + creds.
  // Best-effort — failure here does NOT block local disconnect.
  // (Skipped in mock mode.)
  await writeUser(env, userId, {
    ...existing,
    status: "disconnected",
    disconnected_at: Date.now(),
    broker_integration_enabled: false,
    rh_token_wrap: null,
    rh_refresh_wrap: null,
    rh_token_expires_at: null,
  });
  return { ok: true, status: 200, user_id: userId, disconnected: true };
}

// Mock helper — finalize a fake connection so the UI / order flow can
// be exercised end-to-end without real RH OAuth credentials.
async function _finalizeMockConnection(env, userId) {
  const wrap = await wrapSecret(env, `mock_access_token_${randomState(16)}`);
  const refreshWrap = await wrapSecret(env, `mock_refresh_token_${randomState(16)}`);
  const existing = (await readUser(env, userId)) || { user_id: userId };
  const user = {
    ...existing,
    status: "connected",
    connected_at: Date.now(),
    rh_account_number: `MOCK_RH_${userId.slice(0, 6)}`,
    rh_token_wrap: wrap,
    rh_refresh_wrap: refreshWrap,
    rh_token_expires_at: Date.now() + 3600 * 1000,
    broker_integration_enabled: existing.broker_integration_enabled ?? false,
    daily_order_count: 0,
    daily_order_count_date: new Date().toISOString().slice(0, 10),
    total_orders_lifetime: existing.total_orders_lifetime || 0,
    user_caps: existing.user_caps || {
      max_per_order_usd: Number(env?.DEFAULT_MAX_ORDER_USD) || 5000,
      max_orders_per_day: Number(env?.DEFAULT_MAX_ORDERS_PER_DAY) || 3,
    },
    mock_mode: true,
  };
  await writeUser(env, userId, user);
  return {
    ok: true,
    status: 200,
    user_id: userId,
    rh_account_number: user.rh_account_number,
    broker_integration_enabled: user.broker_integration_enabled,
    mock: true,
    note: "Mock connection finalized. Flip broker_integration_enabled to start receiving mock orders.",
  };
}
