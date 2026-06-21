// worker-bridge/bridge-webull-api.js
//
// 2026-06-15 — Webull Connect signed REST + OAuth token lifecycle.

import { unwrapSecret, wrapSecret } from "./bridge-crypto.js";
import { writeUser } from "./bridge-storage.js";
import { buildWebullSignedHeaders } from "./bridge-webull-sign.js";
import {
  WEBULL_API_PATHS,
  webullApiBaseUrl,
  webullApiHost,
  webullConnectConfigured,
  webullConnectScope,
  webullLiveEnabled,
  webullRedirectUri,
  webullTokenRefreshSkewMs,
} from "./bridge-webull-config.js";

const REQUEST_TIMEOUT_MS = 12_000;

function sideToWebull(side) {
  const s = String(side || "").toLowerCase();
  if (s === "exit" || s === "sell" || s === "trim") return "SELL";
  if (s === "short" || s === "sell_short") return "SHORT";
  return "BUY";
}

function buildOrderBody(user, order, { preview = false } = {}) {
  const accountId = user?.webull_account_id;
  if (!accountId) throw new Error("webull_account_id_missing");
  const qty = Number(order?.qty);
  if (!Number.isFinite(qty) || qty <= 0) throw new Error("invalid_qty");
  return {
    account_id: accountId,
    client_order_id: preview
      ? `tt-preview-${crypto.randomUUID().slice(0, 12)}`
      : `tt-${order?.trade_id || "na"}-${crypto.randomUUID().slice(0, 8)}`,
    symbol: String(order?.ticker || "").toUpperCase(),
    side: sideToWebull(order?.side),
    order_type: "MARKET",
    entrust_type: "QTY",
    quantity: String(qty),
    time_in_force: "DAY",
    support_trading_session: "CORE",
    combo_type: "NORMAL",
  };
}

async function signedFetch(env, {
  path,
  method = "GET",
  query = {},
  body = null,
  accessToken = "",
  contentType = "application/json",
}) {
  const appKey = env?.WEBULL_APP_KEY;
  const appSecret = env?.WEBULL_APP_SECRET;
  if (!appKey || !appSecret) {
    return { ok: false, error: "webull_app_credentials_not_configured" };
  }

  const host = webullApiHost(env);
  const bodyPayload = body == null
    ? null
    : (contentType === "application/json" ? body : body);

  const signHeaders = buildWebullSignedHeaders({
    path,
    method,
    host,
    appKey,
    appSecret,
    query,
    body: bodyPayload,
    accessToken,
  });

  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query || {})) {
    if (v != null && v !== "") qs.set(k, String(v));
  }
  const url = `${webullApiBaseUrl(env)}${path}${qs.toString() ? `?${qs}` : ""}`;

  const headers = {
    Accept: "application/json",
    ...signHeaders,
  };
  if (contentType) headers["Content-Type"] = contentType;
  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }

  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const init = { method, headers, signal: controller.signal };
    if (bodyPayload != null) {
      init.body = contentType === "application/json"
        ? JSON.stringify(bodyPayload)
        : String(bodyPayload);
    }
    const r = await fetch(url, init);
    const text = await r.text().catch(() => "");
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch (_) {}
    return {
      ok: r.ok && !parsed?.error_code,
      http_status: r.status,
      response: parsed ?? text,
      latency_ms: null,
    };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  } finally {
    clearTimeout(tid);
  }
}

/** Exchange authorization code or refresh token (Connect OAuth step 2). */
export async function webullExchangeToken(env, formFields) {
  if (!webullConnectConfigured(env)) {
    return { ok: false, error: "webull_connect_not_configured" };
  }

  const clientId = env.WEBULL_CONNECT_CLIENT_ID;
  const clientSecret = env.WEBULL_CONNECT_CLIENT_SECRET;
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    ...formFields,
  }).toString();

  // Token endpoint uses form body + signed headers; x-access-token empty on first exchange.
  return signedFetch(env, {
    path: WEBULL_API_PATHS.token,
    method: "POST",
    body,
    accessToken: "",
    contentType: "application/x-www-form-urlencoded",
  });
}

export async function webullCreateTokenFromCode(env, code) {
  return webullExchangeToken(env, {
    grant_type: "authorization_code",
    code: String(code || ""),
  });
}

export async function webullRefreshAccessToken(env, refreshToken) {
  return webullExchangeToken(env, {
    grant_type: "refresh_token",
    refresh_token: String(refreshToken || ""),
  });
}

async function persistTokenResponse(env, userId, user, tokenResp) {
  const accessToken = tokenResp?.access_token;
  if (!accessToken) {
    return { ok: false, error: "no_access_token_in_response", response: tokenResp };
  }
  const expiresIn = Number(tokenResp?.expires_in) || 1800;
  const rtExpiresIn = Number(tokenResp?.rt_expires_in) || (15 * 86400);
  const wrap = await wrapSecret(env, accessToken);
  const refreshToken = tokenResp?.refresh_token;
  const refreshWrap = refreshToken ? await wrapSecret(env, refreshToken) : user?.webull_refresh_wrap || null;

  const updated = {
    ...user,
    webull_token_wrap: wrap,
    webull_refresh_wrap: refreshWrap,
    webull_token_expires_at: Date.now() + (expiresIn * 1000),
    webull_refresh_expires_at: Date.now() + (rtExpiresIn * 1000),
    webull_identity_id: tokenResp?.identity_id || user?.webull_identity_id || null,
    webull_token_refreshed_at: Date.now(),
  };
  await writeUser(env, userId, updated);
  return { ok: true, user: updated, access_token: accessToken };
}

/** Ensure a valid access token; refresh proactively when near expiry. */
export async function ensureWebullAccessToken(env, user) {
  if (!user?.webull_token_wrap) {
    return { ok: false, error: "no_webull_token" };
  }
  if (!webullLiveEnabled(env)) {
    return { ok: true, access_token: "mock_access_token", mock: true, user };
  }

  const userId = user.user_id;
  let accessToken;
  try {
    accessToken = await unwrapSecret(env, user.webull_token_wrap);
  } catch (e) {
    return { ok: false, error: `token_unwrap_failed:${String(e?.message || e).slice(0, 80)}` };
  }

  const expiresAt = Number(user.webull_token_expires_at) || 0;
  const skew = webullTokenRefreshSkewMs(env);
  if (expiresAt - Date.now() > skew) {
    return { ok: true, access_token: accessToken, user };
  }

  if (!user.webull_refresh_wrap) {
    return { ok: false, error: "webull_refresh_token_missing_reauthorize" };
  }

  let refreshToken;
  try {
    refreshToken = await unwrapSecret(env, user.webull_refresh_wrap);
  } catch (e) {
    return { ok: false, error: `refresh_unwrap_failed:${String(e?.message || e).slice(0, 80)}` };
  }

  const refreshed = await webullRefreshAccessToken(env, refreshToken);
  if (!refreshed.ok) {
    return { ok: false, error: refreshed.error || "webull_refresh_failed", response: refreshed.response };
  }
  const tokenResp = refreshed.response?.data || refreshed.response;
  const persisted = await persistTokenResponse(env, userId, user, tokenResp);
  if (!persisted.ok) return persisted;
  return { ok: true, access_token: persisted.access_token, user: persisted.user, refreshed: true };
}

export async function webullGetAccountList(env, accessToken) {
  return signedFetch(env, {
    path: WEBULL_API_PATHS.accountList,
    method: "GET",
    accessToken,
  });
}

export async function webullGetBalance(env, user, accessToken) {
  return signedFetch(env, {
    path: WEBULL_API_PATHS.balance,
    method: "GET",
    query: { account_id: user.webull_account_id },
    accessToken,
  });
}

export async function webullGetPositions(env, user, accessToken) {
  return signedFetch(env, {
    path: WEBULL_API_PATHS.positions,
    method: "GET",
    query: { account_id: user.webull_account_id },
    accessToken,
  });
}

export async function webullPreviewOrder(env, user, order, accessToken) {
  const body = buildOrderBody(user, order, { preview: true });
  return signedFetch(env, {
    path: WEBULL_API_PATHS.orderPreview,
    method: "POST",
    body,
    accessToken,
  });
}

export async function webullPlaceOrder(env, user, order, accessToken) {
  const body = buildOrderBody(user, order, { preview: false });
  return signedFetch(env, {
    path: WEBULL_API_PATHS.orderPlace,
    method: "POST",
    body,
    accessToken,
  });
}

export async function webullCancelOrder(env, user, orderId, accessToken) {
  return signedFetch(env, {
    path: WEBULL_API_PATHS.orderCancel,
    method: "POST",
    body: {
      account_id: user.webull_account_id,
      client_order_id: String(orderId || ""),
    },
    accessToken,
  });
}

/** Pick the first account id from Webull account list response. */
export function pickWebullAccountId(listResponse) {
  const data = listResponse?.response?.data ?? listResponse?.response ?? listResponse;
  const rows = Array.isArray(data) ? data : (Array.isArray(data?.account_list) ? data.account_list : []);
  const first = rows[0];
  return String(first?.account_id || first?.accountId || first?.id || "").trim() || null;
}

/** Normalize balance response for /bridge/portfolio MC UI. */
export function normalizeWebullBalance(balanceResp) {
  const data = balanceResp?.response?.data ?? balanceResp?.response ?? balanceResp;
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== "object") return null;
  const equity = Number(row.total_asset ?? row.net_liquidation ?? row.totalAsset ?? row.equity);
  const cash = Number(row.total_cash ?? row.cash_balance ?? row.totalCash ?? row.cash);
  const buyingPower = Number(row.buying_power ?? row.buyingPower ?? row.day_buying_power);
  return {
    equity: Number.isFinite(equity) ? equity : null,
    cash: Number.isFinite(cash) ? cash : null,
    buying_power: Number.isFinite(buyingPower) ? buyingPower : null,
    raw: row,
  };
}

/** Normalize positions array for reconciler. */
export function normalizeWebullPositions(posResp) {
  const data = posResp?.response?.data ?? posResp?.response ?? posResp;
  const rows = Array.isArray(data) ? data : [];
  return rows
    .filter((p) => String(p?.instrument_type || "EQUITY").toUpperCase() === "EQUITY")
    .map((p) => ({
      symbol: String(p.symbol || "").toUpperCase(),
      qty: Number(p.quantity),
      side: Number(p.quantity) < 0 ? "short" : "long",
      market_value: Number(p.last_price) * Math.abs(Number(p.quantity) || 0),
      raw: p,
    }))
    .filter((p) => p.symbol && Number.isFinite(p.qty));
}

export function buildWebullAuthorizeUrl(env, req, state) {
  const base = webullApiBaseUrl(env);
  const url = new URL(`${base}${WEBULL_API_PATHS.authorizeLogin}`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", env.WEBULL_CONNECT_CLIENT_ID);
  url.searchParams.set("scope", webullConnectScope(env));
  url.searchParams.set("state", state);
  url.searchParams.set("redirect_uri", webullRedirectUri(env, req));
  return url.toString();
}

export async function finalizeWebullTokens(env, userId, user, tokenResp) {
  const persisted = await persistTokenResponse(env, userId, user, tokenResp);
  if (!persisted.ok) return persisted;

  const tok = await ensureWebullAccessToken(env, persisted.user);
  if (!tok.ok) return tok;

  const accounts = await webullGetAccountList(env, tok.access_token);
  const accountId = pickWebullAccountId(accounts);
  if (!accountId) {
    return { ok: false, error: "webull_no_account_id_in_list", response: accounts.response };
  }

  const connected = {
    ...tok.user,
    broker: "webull",
    status: "connected",
    connected_at: Date.now(),
    webull_account_id: accountId,
    broker_integration_enabled: user?.broker_integration_enabled ?? false,
    daily_order_count: user?.daily_order_count || 0,
    daily_order_count_date: user?.daily_order_count_date || new Date().toISOString().slice(0, 10),
    total_orders_lifetime: user?.total_orders_lifetime || 0,
    user_caps: user?.user_caps || {
      max_per_order_usd: Number(env?.DEFAULT_MAX_ORDER_USD) || 5000,
      max_orders_per_day: Number(env?.DEFAULT_MAX_ORDERS_PER_DAY) || 3,
    },
  };
  await writeUser(env, userId, connected);
  return {
    ok: true,
    user_id: userId,
    webull_account_id: accountId,
    broker_integration_enabled: connected.broker_integration_enabled,
  };
}

export { webullConnectScope, webullConnectConfigured, webullLiveEnabled };
