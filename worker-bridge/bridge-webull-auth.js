// worker-bridge/bridge-webull-auth.js
//
// 2026-06-15 — Webull Connect OAuth start/callback/disconnect.

import { wrapSecret, randomState } from "./bridge-crypto.js";
import { recordOauthState, consumeOauthState, readUser, writeUser } from "./bridge-storage.js";
import {
  buildWebullAuthorizeUrl,
  finalizeWebullTokens,
  parseWebullAccountList,
  syncWebullPersonalAccounts,
  webullCreateTokenFromCode,
  webullGetAccountList,
} from "./bridge-webull-api.js";
import {
  isBridgeMockMode,
  webullAuthMode,
  webullCredentialsConfigured,
  webullRedirectUri,
} from "./bridge-webull-config.js";

export async function handleWebullOauthStart(env, req) {
  const body = await req.json().catch(() => ({}));
  const userId = String(body?.user_id || "").trim().toLowerCase();
  if (!userId) {
    return { ok: false, error: "user_id_required", status: 400 };
  }

  if (isBridgeMockMode(env)) {
    const mock = await _finalizeMockWebullConnection(env, userId);
    return {
      ok: true,
      status: 200,
      mock: true,
      user_id: userId,
      webull_account_id: mock.webull_account_id,
      note: "Mock Webull connection finalized (BROKER_BRIDGE_MOCK=true).",
    };
  }

  if (!webullCredentialsConfigured(env)) {
    return {
      ok: false,
      error: "webull_not_configured",
      status: 503,
      note: webullAuthMode(env) === "personal"
        ? "Set WEBULL_APP_KEY and WEBULL_APP_SECRET on tt-broker-bridge (WEBULL_AUTH_MODE=personal)."
        : "Email connect.api@webull-us.com for Connect API credentials. See tasks/2026-06-15-webull-connect-integration-plan.md",
    };
  }

  // Personal Trading API: no browser OAuth — bind every Webull sub-account.
  if (webullAuthMode(env) === "personal") {
    const accountsRes = await webullGetAccountList(env, "");
    const accounts = parseWebullAccountList(accountsRes);
    if (!accounts.length) {
      return {
        ok: false,
        error: "webull_personal_account_list_failed",
        status: 502,
        response: accountsRes.response,
        note: accountsRes.error || "Check WEBULL_APP_KEY/SECRET and WEBULL_ENVIRONMENT (prod vs uat).",
      };
    }
    const synced = await syncWebullPersonalAccounts(env, userId, accounts);
    return {
      ok: true,
      status: 200,
      personal: true,
      user_id: userId,
      accounts_connected: synced.length,
      accounts: synced,
      note: `Webull personal API synced ${synced.length} account(s). Enable live trading per account in Mission Control.`,
    };
  }

  const state = randomState(32);
  await recordOauthState(env, state, {
    user_id: userId,
    broker: "webull",
    started_at: Date.now(),
  });

  const existing = (await readUser(env, userId)) || { user_id: userId };
  await writeUser(env, userId, {
    ...existing,
    broker: "webull",
    status: "pending_oauth",
    pending_oauth_at: Date.now(),
  });

  const redirectUri = webullRedirectUri(env, req);
  const authorizeUrl = buildWebullAuthorizeUrl(env, req, state);
  return {
    ok: true,
    status: 200,
    authorize_url: authorizeUrl,
    state,
    redirect_uri: redirectUri,
    expires_in_s: 600,
  };
}

export async function handleWebullOauthCallback(env, req) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const err = url.searchParams.get("error");
  if (err) return { ok: false, error: `oauth_error:${err}`, status: 400, broker: "webull" };
  if (!code || !state) return { ok: false, error: "missing_code_or_state", status: 400, broker: "webull" };

  const stateRow = await consumeOauthState(env, state);
  if (!stateRow) return { ok: false, error: "state_expired_or_unknown", status: 400, broker: "webull" };
  const userId = String(stateRow.user_id).toLowerCase();

  if (isBridgeMockMode(env)) {
    const mock = await _finalizeMockWebullConnection(env, userId);
    return { ok: true, status: 200, broker: "webull", mock: true, ...mock };
  }

  if (!webullCredentialsConfigured(env)) {
    return { ok: false, error: "webull_not_configured", status: 503, broker: "webull" };
  }

  const tokenRes = await webullCreateTokenFromCode(env, code);
  if (!tokenRes.ok) {
    return {
      ok: false,
      error: tokenRes.error || "webull_token_exchange_failed",
      status: 502,
      broker: "webull",
      response: tokenRes.response,
    };
  }

  const tokenResp = tokenRes.response?.data || tokenRes.response;
  const existing = (await readUser(env, userId)) || { user_id: userId };
  const finalized = await finalizeWebullTokens(env, userId, existing, tokenResp);
  if (!finalized.ok) {
    return { ok: false, status: 502, broker: "webull", ...finalized };
  }

  return {
    ok: true,
    status: 200,
    broker: "webull",
    user_id: userId,
    accounts_connected: finalized.accounts_connected,
    accounts: finalized.accounts,
    webull_account_id: finalized.webull_account_id,
    broker_integration_enabled: finalized.broker_integration_enabled,
    note: "Webull connected. Enable broker_integration_enabled per account before live orders.",
  };
}

export async function handleWebullOauthDisconnect(env, req) {
  const body = await req.json().catch(() => ({}));
  const userId = String(body?.user_id || "").trim().toLowerCase();
  if (!userId) return { ok: false, error: "user_id_required", status: 400 };

  const disconnectOne = async (row) => {
    if (!row) return false;
    await writeUser(env, row.user_id, {
      ...row,
      status: "disconnected",
      disconnected_at: Date.now(),
      broker_integration_enabled: false,
      webull_token_wrap: null,
      webull_refresh_wrap: null,
      webull_token_expires_at: null,
      webull_refresh_expires_at: null,
    });
    return true;
  };

  const existing = await readUser(env, userId);
  if (existing) {
    await disconnectOne(existing);
    return { ok: true, status: 200, user_id: userId, broker: "webull", disconnected: true };
  }

  // Owner email — disconnect all Webull sub-accounts for this login.
  const owner = userId.split("#webull#")[0];
  const { listConnectedUsers } = await import("./bridge-storage.js");
  const all = await listConnectedUsers(env, 200);
  const targets = all.filter((u) => {
    if (String(u?.broker || "").toLowerCase() !== "webull") return false;
    if (u.user_id === owner || u.owner_email === owner) return true;
    return String(u.user_id || "").startsWith(`${owner}#webull#`);
  });
  if (!targets.length) return { ok: false, error: "user_not_found", status: 404 };
  for (const t of targets) await disconnectOne(t);
  return {
    ok: true,
    status: 200,
    user_id: owner,
    broker: "webull",
    disconnected: true,
    accounts_disconnected: targets.length,
  };
}

async function _finalizeMockWebullConnection(env, userId) {
  const wrap = await wrapSecret(env, `mock_webull_access_${randomState(16)}`);
  const refreshWrap = await wrapSecret(env, `mock_webull_refresh_${randomState(16)}`);
  const existing = (await readUser(env, userId)) || { user_id: userId };
  const accountId = `MOCK_WB_${userId.slice(0, 6).toUpperCase()}`;
  const user = {
    ...existing,
    broker: "webull",
    status: "connected",
    connected_at: Date.now(),
    webull_account_id: accountId,
    webull_token_wrap: wrap,
    webull_refresh_wrap: refreshWrap,
    webull_token_expires_at: Date.now() + 3600 * 1000,
    webull_refresh_expires_at: Date.now() + 14 * 86400 * 1000,
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
    user_id: userId,
    webull_account_id: accountId,
    broker_integration_enabled: user.broker_integration_enabled,
  };
}
