// worker-bridge/bridge-webull-api.js
//
// 2026-06-15 — Webull Connect signed REST + OAuth token lifecycle.

import { unwrapSecret, wrapSecret } from "./bridge-crypto.js";
import { readUser, writeUser } from "./bridge-storage.js";
import { buildWebullSignedHeaders } from "./bridge-webull-sign.js";
import {
  WEBULL_API_PATHS,
  webullAccountListPath,
  webullApiBaseUrl,
  webullApiHost,
  webullAuthMode,
  webullConnectConfigured,
  webullConnectScope,
  webullCredentialsConfigured,
  webullLiveEnabled,
  webullRedirectUri,
  webullTokenRefreshSkewMs,
} from "./bridge-webull-config.js";

const REQUEST_TIMEOUT_MS = 12_000;
// Webull OpenAPI: 2 requests / 2 seconds per app key.
const WEBULL_MIN_REQUEST_GAP_MS = 1100;
let _lastWebullSignedFetchAt = 0;

function parseWebullNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function throttleWebullSignedFetch() {
  const now = Date.now();
  const wait = Math.max(0, _lastWebullSignedFetchAt + WEBULL_MIN_REQUEST_GAP_MS - now);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  _lastWebullSignedFetchAt = Date.now();
}

function sideToWebull(side) {
  const s = String(side || "").toLowerCase();
  if (s === "exit" || s === "sell" || s === "trim") return "SELL";
  if (s === "short" || s === "sell_short") return "SHORT";
  return "BUY";
}

export function buildOrderBody(user, order, { preview = false } = {}) {
  const accountId = user?.webull_account_id;
  if (!accountId) throw new Error("webull_account_id_missing");
  const qty = Number(order?.qty);
  if (!Number.isFinite(qty) || qty <= 0) throw new Error("invalid_qty");
  // Order type: MARKET (default), LIMIT, STOP, or STOP_LIMIT. The agnostic
  // planner / OCO orchestrator sets order_type. A LIMIT/STOP with no valid
  // price falls back to MARKET so a bad plan can never place a $0 order.
  const kind = String(order?.order_type || "market").toLowerCase();
  const limitPrice = Number(order?.limit_price);
  const stopPrice = Number(order?.stop_price);
  const hasLimit = Number.isFinite(limitPrice) && limitPrice > 0;
  const hasStop = Number.isFinite(stopPrice) && stopPrice > 0;
  let orderType = "MARKET";
  if ((kind === "stop_limit") && hasStop && hasLimit) orderType = "STOP_LIMIT";
  else if (kind === "stop" && hasStop) orderType = "STOP";
  else if (kind === "limit" && hasLimit) orderType = "LIMIT";
  const body = {
    account_id: accountId,
    // Prefer the caller's stable client_order_id (per-account idempotency for
    // fan-out); fall back to a generated one for previews / ad-hoc orders.
    client_order_id: preview
      ? `tt-preview-${crypto.randomUUID().slice(0, 12)}`
      : (order?.client_order_id
        ? String(order.client_order_id)
        : `tt-${order?.trade_id || "na"}-${crypto.randomUUID().slice(0, 8)}`),
    symbol: String(order?.ticker || "").toUpperCase(),
    side: sideToWebull(order?.side),
    order_type: orderType,
    entrust_type: "QTY",
    quantity: String(qty),
    time_in_force: String(order?.tif || "DAY").toUpperCase(),
    support_trading_session: "CORE",
    combo_type: "NORMAL",
  };
  if (orderType === "LIMIT" || orderType === "STOP_LIMIT") body.limit_price = String(limitPrice);
  if (orderType === "STOP" || orderType === "STOP_LIMIT") body.stop_price = String(stopPrice);
  return body;
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
  // Connect OAuth uses Bearer; personal Trading API uses signed headers only (2FA off).
  if (accessToken && webullAuthMode(env) !== "personal") {
    headers.Authorization = `Bearer ${accessToken}`;
  }

  await throttleWebullSignedFetch();

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
    const errCode = parsed?.error_code ?? parsed?.errorCode;
    const ok = r.ok && !errCode;
    return {
      ok,
      http_status: r.status,
      response: parsed ?? text,
      error: ok ? undefined : (parsed?.message || parsed?.error || errCode || `http_${r.status}`),
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
  if (webullAuthMode(env) === "personal") {
    if (!webullLiveEnabled(env)) {
      return { ok: true, access_token: "", mock: true, user };
    }
    return { ok: true, access_token: "", user, personal: true };
  }

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
    path: webullAccountListPath(env),
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

export async function webullPostOptionsOrder(env, { path, body, accessToken }) {
  return signedFetch(env, {
    path,
    method: "POST",
    body,
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

/** List recent orders for an account — used for fill reconciliation. */
export async function webullListOrders(env, user, accessToken, { limit = 50 } = {}) {
  return signedFetch(env, {
    path: WEBULL_API_PATHS.ordersList,
    method: "POST",
    body: {
      account_id: user.webull_account_id,
      page_size: Number(limit) || 50,
    },
    accessToken,
  });
}

/** Normalize every account from Webull /openapi/account/list. */
export function parseWebullAccountList(listResponse) {
  const data = listResponse?.response?.data ?? listResponse?.response ?? listResponse;
  const rows = Array.isArray(data) ? data : (Array.isArray(data?.account_list) ? data.account_list : []);
  return rows.map((row) => ({
    account_id: String(row?.account_id || row?.accountId || row?.id || "").trim(),
    account_type: row?.account_type || row?.accountType || null,
    account_label: row?.account_label || row?.accountLabel || row?.account_type || "Account",
    account_class: row?.account_class || row?.accountClass || null,
    account_number: row?.account_number || row?.accountNumber || null,
  })).filter((a) => a.account_id);
}

/** Stable bridge user_id per Webull sub-account under one owner email. */
export function webullSubUserId(ownerEmail, account) {
  const slug = String(account?.account_class || account?.account_type || account?.account_id || "acct")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `${String(ownerEmail).toLowerCase()}#webull#${slug}`;
}

/** Pick the first account id from Webull account list response. */
export function pickWebullAccountId(listResponse) {
  const rows = parseWebullAccountList(listResponse);
  return rows[0]?.account_id || null;
}

/** Normalize balance response for /bridge/portfolio MC UI. */
export function normalizeWebullBalance(balanceResp) {
  const envelope = balanceResp?.response?.data ?? balanceResp?.response ?? balanceResp;
  const row = Array.isArray(envelope) ? envelope[0] : envelope;
  if (!row || typeof row !== "object") return null;

  const ccyAssets = Array.isArray(row.account_currency_assets) ? row.account_currency_assets : [];
  const usd = ccyAssets.find((a) => String(a?.currency || "").toUpperCase() === "USD") || ccyAssets[0] || {};

  const equity = parseWebullNumber(
    row.total_net_liquidation_value
    ?? row.total_asset
    ?? usd.net_liquidation_value
    ?? row.net_liquidation
    ?? row.totalAsset
    ?? row.equity,
  );
  const cash = parseWebullNumber(
    row.total_cash_balance
    ?? row.total_cash
    ?? usd.cash_balance
    ?? row.cash_balance
    ?? row.totalCash
    ?? row.cash,
  );
  const buyingPower = parseWebullNumber(
    usd.buying_power
    ?? usd.day_buying_power
    ?? usd.overnight_buying_power
    ?? row.buying_power
    ?? row.buyingPower
    ?? row.day_buying_power,
  );

  return {
    equity,
    cash,
    buying_power: buyingPower,
    raw: row,
  };
}

/** Normalize positions array for reconciler. */
export function normalizeWebullPositions(posResp) {
  const envelope = posResp?.response?.data ?? posResp?.response ?? posResp;
  let rows = [];
  if (Array.isArray(envelope)) {
    rows = envelope;
  } else if (Array.isArray(envelope?.positions)) {
    rows = envelope.positions;
  } else if (Array.isArray(envelope?.position_list)) {
    rows = envelope.position_list;
  }

  return rows
    .filter((p) => {
      const t = String(p?.instrument_type || p?.instrumentType || "EQUITY").toUpperCase();
      return t === "EQUITY" || t === "ETF";
    })
    .map((p) => {
      const qty = Number(p.qty ?? p.quantity);
      const mv = parseWebullNumber(p.market_value ?? p.marketValue);
      const last = parseWebullNumber(p.last_price ?? p.lastPrice);
      const avg = parseWebullNumber(
        p.cost_price ?? p.avg_cost ?? p.avgCost ?? p.avg_price ?? p.avgPrice,
      );
      const upl = parseWebullNumber(
        p.unrealized_profit_loss ?? p.unrealized_pnl ?? p.unrealizedPnl ?? p.upl,
      );
      const computedMv = Number.isFinite(mv)
        ? mv
        : (Number.isFinite(last) ? last * Math.abs(qty || 0) : null);
      return {
        symbol: String(p.symbol || "").toUpperCase(),
        qty,
        side: qty < 0 ? "short" : "long",
        avg_cost: avg,
        avgCost: avg,
        unrealized_pnl: upl,
        unrealizedPnl: upl,
        market_value: computedMv,
        raw: p,
      };
    })
    .filter((p) => p.symbol && Number.isFinite(p.qty));
}

/** Upsert one KV row per Webull account under an owner email. */
export async function syncWebullPersonalAccounts(env, ownerEmail, accounts) {
  const owner = String(ownerEmail).toLowerCase();
  const synced = [];
  for (const acct of accounts) {
    const subId = webullSubUserId(owner, acct);
    const existing = (await readUser(env, subId)) || { user_id: subId };
    const row = {
      ...existing,
      user_id: subId,
      owner_email: owner,
      broker: "webull",
      status: "connected",
      connected_at: existing.connected_at || Date.now(),
      webull_account_id: acct.account_id,
      webull_account_label: acct.account_label,
      webull_account_type: acct.account_type,
      webull_account_class: acct.account_class,
      webull_account_number: acct.account_number || null,
      webull_auth_mode: webullAuthMode(env),
      broker_integration_enabled: existing.broker_integration_enabled ?? false,
      daily_order_count: existing.daily_order_count || 0,
      daily_order_count_date: existing.daily_order_count_date || new Date().toISOString().slice(0, 10),
      total_orders_lifetime: existing.total_orders_lifetime || 0,
      user_caps: existing.user_caps || {
        max_per_order_usd: Number(env?.DEFAULT_MAX_ORDER_USD) || 5000,
        max_orders_per_day: Number(env?.DEFAULT_MAX_ORDERS_PER_DAY) || 3,
      },
    };
    await writeUser(env, subId, row);
    synced.push({
      user_id: subId,
      owner_email: owner,
      webull_account_id: acct.account_id,
      webull_account_label: acct.account_label,
      webull_account_type: acct.account_type,
      webull_account_class: acct.account_class,
      broker_integration_enabled: row.broker_integration_enabled,
    });
  }

  const legacy = await readUser(env, owner);
  if (legacy?.broker === "webull" && legacy?.status === "connected" && !String(legacy.user_id || "").includes("#webull#")) {
    await writeUser(env, owner, {
      ...legacy,
      status: "disconnected",
      disconnected_at: Date.now(),
      broker_integration_enabled: false,
      superseded_by: "webull_subaccounts",
    });
  }
  return synced;
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
  const parsed = parseWebullAccountList(accounts);
  if (!parsed.length) {
    return { ok: false, error: "webull_no_account_id_in_list", response: accounts.response };
  }

  const synced = await syncWebullPersonalAccounts(env, userId, parsed);
  return {
    ok: true,
    user_id: userId,
    accounts_connected: synced.length,
    accounts: synced,
    webull_account_id: synced[0]?.webull_account_id || null,
    broker_integration_enabled: synced.some((a) => a.broker_integration_enabled),
  };
}

export { webullConnectScope, webullConnectConfigured, webullCredentialsConfigured, webullLiveEnabled };
