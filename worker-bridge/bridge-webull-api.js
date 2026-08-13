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
  // Webull fractional precision is 5dp max; longer decimals → INVALID_PARAMETER.
  const qtyRaw = Number(order?.qty);
  const qty = Number.isFinite(qtyRaw) && qtyRaw > 0
    ? Math.floor(qtyRaw * 1e5 + 1e-9) / 1e5
    : NaN;
  if (!Number.isFinite(qty) || qty <= 0) throw new Error("invalid_qty");
  // Order type mapping to Webull spec:
  //   MARKET (default), LIMIT, STOP_LOSS (was "STOP"), STOP_LOSS_LIMIT (was
  //   "STOP_LIMIT"). The agnostic planner / OCO orchestrator sets order_type
  //   using the generic names; we translate here. A LIMIT/STOP with no valid
  //   price falls back to MARKET so a bad plan can never place a $0 order.
  //   Spec: https://developer.webull.com/apis/docs/reference/common-order-preview/
  const kind = String(order?.order_type || "market").toLowerCase();
  const limitPrice = Number(order?.limit_price);
  const stopPrice = Number(order?.stop_price);
  const hasLimit = Number.isFinite(limitPrice) && limitPrice > 0;
  const hasStop = Number.isFinite(stopPrice) && stopPrice > 0;
  let orderType = "MARKET";
  if ((kind === "stop_limit" || kind === "stop_loss_limit") && hasStop && hasLimit) orderType = "STOP_LOSS_LIMIT";
  else if ((kind === "stop" || kind === "stop_loss") && hasStop) orderType = "STOP_LOSS";
  else if (kind === "limit" && hasLimit) orderType = "LIMIT";
  // 2026-07-22 — Webull requires orders under a `new_orders` array with
  // instrument_type + market on each order. Previously we spread the order
  // fields at the top level, which the API rejected with
  //   INVALID_PARAMETER: Orders can not be empty
  // for every preview/place — no real Webull order had ever landed.
  // Spec: https://developer.webull.hk/apis/docs/trade-api/stock.md
  const orderRow = {
    client_order_id: preview
      ? `tt-preview-${crypto.randomUUID().slice(0, 12)}`
      : (order?.client_order_id
        ? String(order.client_order_id)
        : `tt-${order?.trade_id || "na"}-${crypto.randomUUID().slice(0, 8)}`),
    combo_type: "NORMAL",
    symbol: String(order?.ticker || "").toUpperCase(),
    instrument_type: "EQUITY",
    market: String(order?.market || "US").toUpperCase(),
    order_type: orderType,
    side: sideToWebull(order?.side),
    // Whole shares as integer strings ("13") — some Webull paths treat
    // "13.0" as fractional and trip TRADE_FRACT_PRO even for whole qty.
    quantity: (Number.isInteger(qty) || Math.abs(qty - Math.round(qty)) < 1e-9)
      ? String(Math.round(qty))
      : String(qty),
    entrust_type: "QTY",
    time_in_force: String(order?.tif || "DAY").toUpperCase(),
    // CORE = RTH only. ALL = pre/post (ETH). NIGHT = overnight session.
    // Default CORE so accidental ETH market orders don't slip through;
    // rebuild / catch-up outside RTH must pass support_trading_session=ALL
    // with LIMIT + GTC (Webull rejects MARKET in extended hours).
    support_trading_session: (() => {
      const raw = String(order?.support_trading_session || "CORE").toUpperCase();
      return ["CORE", "ALL", "NIGHT", "ALL_DAY"].includes(raw) ? raw : "CORE";
    })(),
  };
  // Defensive: ALL/NIGHT session with MARKET + a usable limit → upgrade to
  // LIMIT so ETH placement is not rejected / silently CORE-only.
  if ((orderRow.support_trading_session === "ALL" || orderRow.support_trading_session === "NIGHT")
      && orderType === "MARKET" && hasLimit) {
    orderType = "LIMIT";
    orderRow.order_type = "LIMIT";
  }
  if (orderType === "LIMIT" || orderType === "STOP_LOSS_LIMIT") orderRow.limit_price = String(limitPrice);
  if (orderType === "STOP_LOSS" || orderType === "STOP_LOSS_LIMIT") orderRow.stop_price = String(stopPrice);
  return {
    account_id: accountId,
    new_orders: [orderRow],
  };
}

// 2026-08-11 — Per-account App Key/Secret (second Webull login support).
// Preferred storage: worker-level secrets named after the login label
// (`WEBULL_APP_KEY_<SUFFIX>` / `WEBULL_APP_SECRET_<SUFFIX>`, e.g. label
// "acct2" → WEBULL_APP_KEY_ACCT2) — key rotation is a `wrangler secret
// put`, no KV rewrite or re-connect. The sub-user row stores only the
// suffix (`webull_creds_env`). Fallback: AES-GCM wraps on the row
// (`webull_app_key_wrap` / `webull_app_secret_wrap`, same wrap as token
// wraps) for keys passed inline at connect time. Rows with neither use
// the env-level WEBULL_APP_KEY/SECRET (primary login).

/** login label → env secret suffix ("acct2" → "ACCT2", "wife-s" → "WIFE_S"). */
export function webullCredsEnvSuffix(label) {
  return normalizeWebullLoginLabel(label).toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

/** Read a secondary login's key pair from worker secrets. Null when unset. */
export function webullEnvCredsFor(env, suffix) {
  const s = String(suffix || "").toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  if (!s) return null;
  const appKey = env?.[`WEBULL_APP_KEY_${s}`];
  const appSecret = env?.[`WEBULL_APP_SECRET_${s}`];
  return (appKey && appSecret) ? { appKey, appSecret } : null;
}

export async function resolveWebullUserCreds(env, user) {
  const suffix = user?.webull_creds_env;
  if (suffix) {
    const creds = webullEnvCredsFor(env, suffix);
    if (!creds) {
      throw new Error(`webull_env_creds_missing:WEBULL_APP_KEY_${webullCredsEnvSuffix(suffix) || String(suffix).toUpperCase()}`);
    }
    return creds;
  }
  if (!user?.webull_app_key_wrap || !user?.webull_app_secret_wrap) return null;
  const appKey = await unwrapSecret(env, user.webull_app_key_wrap);
  const appSecret = await unwrapSecret(env, user.webull_app_secret_wrap);
  return { appKey, appSecret };
}

async function credsFor(env, user) {
  try {
    return { ok: true, creds: await resolveWebullUserCreds(env, user) };
  } catch (e) {
    return { ok: false, error: `webull_app_creds_unwrap_failed:${String(e?.message || e).slice(0, 80)}` };
  }
}

async function signedFetch(env, {
  path,
  method = "GET",
  query = {},
  body = null,
  accessToken = "",
  contentType = "application/json",
  creds = null,
}) {
  const appKey = creds?.appKey || env?.WEBULL_APP_KEY;
  const appSecret = creds?.appSecret || env?.WEBULL_APP_SECRET;
  if (!appKey || !appSecret) {
    return { ok: false, error: "webull_app_credentials_not_configured" };
  }

  const host = webullApiHost(env);
  const bodyPayload = body == null
    ? null
    : (contentType === "application/json" ? body : body);

  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query || {})) {
    if (v != null && v !== "") qs.set(k, String(v));
  }
  const url = `${webullApiBaseUrl(env)}${path}${qs.toString() ? `?${qs}` : ""}`;

  // 2026-08-13 — GET-only rate-limit retry. Multi-account owners (5 Webull
  // accounts) burst reads (positions page, reconciler) past Webull's
  // per-app rate limit — later accounts got "Too many requests" and the
  // page showed "Broker positions unavailable". Idempotent GETs retry
  // with backoff; POSTs never retry here (double-order risk — order
  // paths have their own idempotency-keyed handling). Headers are
  // re-signed per attempt (the signature carries a timestamp).
  const maxAttempts = method === "GET" ? 3 : 1;
  let out = { ok: false, error: "unreachable" };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) await new Promise((r) => setTimeout(r, attempt === 2 ? 1200 : 2400));
    await throttleWebullSignedFetch();

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
    const headers = {
      Accept: "application/json",
      ...signHeaders,
    };
    if (contentType) headers["Content-Type"] = contentType;
    // Connect OAuth uses Bearer; personal Trading API uses signed headers only (2FA off).
    if (accessToken && webullAuthMode(env) !== "personal") {
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
      const errCode = parsed?.error_code ?? parsed?.errorCode;
      const ok = r.ok && !errCode;
      out = {
        ok,
        http_status: r.status,
        response: parsed ?? text,
        error: ok ? undefined : (parsed?.message || parsed?.error || errCode || `http_${r.status}`),
        latency_ms: null,
      };
    } catch (e) {
      out = { ok: false, error: String(e?.message || e).slice(0, 200) };
    } finally {
      clearTimeout(tid);
    }
    if (out.ok) return out;
    const rateLimited = out.http_status === 429
      || /too many request|rate.?limit/i.test(String(out.error || ""));
    if (!rateLimited) return out;
    if (attempt < maxAttempts) {
      console.warn(`[WEBULL] rate-limited on ${path} (attempt ${attempt}/${maxAttempts}) — retrying`);
    }
  }
  return out;
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

export async function webullGetAccountList(env, accessToken, { creds = null } = {}) {
  return signedFetch(env, {
    path: webullAccountListPath(env),
    method: "GET",
    accessToken,
    creds,
  });
}

export async function webullGetBalance(env, user, accessToken) {
  const c = await credsFor(env, user);
  if (!c.ok) return c;
  return signedFetch(env, {
    path: WEBULL_API_PATHS.balance,
    method: "GET",
    query: { account_id: user.webull_account_id },
    accessToken,
    creds: c.creds,
  });
}

export async function webullGetPositions(env, user, accessToken) {
  const c = await credsFor(env, user);
  if (!c.ok) return c;
  return signedFetch(env, {
    path: WEBULL_API_PATHS.positions,
    method: "GET",
    query: { account_id: user.webull_account_id },
    accessToken,
    creds: c.creds,
  });
}

export async function webullPostOptionsOrder(env, { path, body, accessToken, user = null }) {
  const c = await credsFor(env, user);
  if (!c.ok) return c;
  return signedFetch(env, {
    path,
    method: "POST",
    body,
    accessToken,
    creds: c.creds,
  });
}

export async function webullPreviewOrder(env, user, order, accessToken) {
  const c = await credsFor(env, user);
  if (!c.ok) return c;
  const body = buildOrderBody(user, order, { preview: true });
  return signedFetch(env, {
    path: WEBULL_API_PATHS.orderPreview,
    method: "POST",
    body,
    accessToken,
    creds: c.creds,
  });
}

export async function webullPlaceOrder(env, user, order, accessToken) {
  const c = await credsFor(env, user);
  if (!c.ok) return c;
  const body = buildOrderBody(user, order, { preview: false });
  return signedFetch(env, {
    path: WEBULL_API_PATHS.orderPlace,
    method: "POST",
    body,
    accessToken,
    creds: c.creds,
  });
}

export async function webullCancelOrder(env, user, orderId, accessToken) {
  const c = await credsFor(env, user);
  if (!c.ok) return c;
  return signedFetch(env, {
    path: WEBULL_API_PATHS.orderCancel,
    method: "POST",
    body: {
      account_id: user.webull_account_id,
      client_order_id: String(orderId || ""),
    },
    accessToken,
    creds: c.creds,
  });
}

/** List recent orders (default: last 7 days) — used for fill reconciliation.
 *  GET /openapi/trade/order/history with query params (max page_size 100).
 *  `path` override (admin diagnostics only) is restricted to read-only
 *  /openapi/trade/order* endpoints. */
export async function webullListOrders(env, user, accessToken, { limit = 50, path = null } = {}) {
  const c = await credsFor(env, user);
  if (!c.ok) return c;
  const safePath = (path && /^\/openapi\/trade\/order/.test(String(path)))
    ? String(path)
    : WEBULL_API_PATHS.ordersList;
  return signedFetch(env, {
    path: safePath,
    method: "GET",
    query: {
      account_id: user.webull_account_id,
      page_size: String(Math.min(100, Number(limit) || 50)),
    },
    accessToken,
    creds: c.creds,
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

/**
 * 2026-08-12 — Cross-owner uniqueness guard. One Webull brokerage account
 * (identified by Webull's own account_id) may only be connected under ONE
 * owner email. Returns the clashing row when any of the incoming accounts
 * is already connected under a different owner, else null. Same-owner
 * matches (re-sync, key rotation, second label) are allowed.
 */
export function findCrossOwnerWebullClash(existingRows, ownerEmail, accounts) {
  const owner = String(ownerEmail || "").toLowerCase().trim();
  const incoming = new Set((accounts || []).map((a) => String(a?.account_id || "")).filter(Boolean));
  for (const row of existingRows || []) {
    if (!row || String(row.broker || "").toLowerCase() !== "webull") continue;
    if (String(row.status || "").toLowerCase() !== "connected") continue;
    const acctId = String(row.webull_account_id || "");
    if (!acctId || !incoming.has(acctId)) continue;
    const rowOwner = String(row.owner_email || String(row.user_id || "").split("#")[0] || "").toLowerCase();
    if (rowOwner && rowOwner !== owner) return row;
  }
  return null;
}

/** Kebab-case a login label ("Wife's account" → "wifes-account"). */
export function normalizeWebullLoginLabel(label) {
  return String(label || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
}

/** Stable bridge user_id per Webull sub-account under one owner email.
 *  A second Webull login syncs with a `loginLabel` prefix so its accounts
 *  never collide with the primary login's slugs (both logins can have an
 *  INDIVIDUAL_CASH account). */
export function webullSubUserId(ownerEmail, account, loginLabel = null) {
  const slug = String(account?.account_class || account?.account_type || account?.account_id || "acct")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const label = normalizeWebullLoginLabel(loginLabel);
  return `${String(ownerEmail).toLowerCase()}#webull#${label ? `${label}-` : ""}${slug}`;
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

/** Upsert one KV row per Webull account under an owner email.
 *  opts.loginLabel — set for a secondary Webull login: prefixes sub ids
 *  (`owner#webull#<label>-<slug>`) so slugs never collide across logins.
 *  opts.credsEnv — env secret suffix (e.g. "ACCT2"): the row signs with
 *  worker secrets WEBULL_APP_KEY_<SUFFIX>/WEBULL_APP_SECRET_<SUFFIX>.
 *  Preferred — rotation is a `wrangler secret put`, no re-connect.
 *  opts.credsWrap — `{ key_wrap, secret_wrap }` (already wrapped) for
 *  keys passed inline at connect time; stamped on every synced row.
 *  credsEnv and credsWrap are mutually exclusive: setting one clears the
 *  other. When both absent, existing creds fields are preserved (primary
 *  login rows have none and keep falling back to env keys).
 *  opts.notifyEmails — array of partner emails: account actions notify
 *  these addresses in addition to BRIDGE_ADMIN_NOTIFY_EMAIL. Preserved
 *  when absent. */
export async function syncWebullPersonalAccounts(env, ownerEmail, accounts, opts = {}) {
  const owner = String(ownerEmail).toLowerCase();
  const loginLabel = normalizeWebullLoginLabel(opts.loginLabel) || null;
  const credsEnv = opts.credsEnv ? webullCredsEnvSuffix(opts.credsEnv) || String(opts.credsEnv).toUpperCase() : null;
  const credsWrap = credsEnv ? null : (opts.credsWrap || null);
  const notifyEmails = Array.isArray(opts.notifyEmails)
    ? opts.notifyEmails.map((e) => String(e || "").trim().toLowerCase()).filter(Boolean)
    : null;
  const synced = [];
  for (const acct of accounts) {
    const subId = webullSubUserId(owner, acct, loginLabel);
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
      webull_login_label: loginLabel || existing.webull_login_label || null,
      webull_creds_env: credsEnv || (credsWrap ? null : (existing.webull_creds_env || null)),
      webull_app_key_wrap: credsWrap ? credsWrap.key_wrap : (credsEnv ? null : (existing.webull_app_key_wrap || null)),
      webull_app_secret_wrap: credsWrap ? credsWrap.secret_wrap : (credsEnv ? null : (existing.webull_app_secret_wrap || null)),
      notify_emails: notifyEmails ?? (existing.notify_emails || null),
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
      webull_login_label: row.webull_login_label || null,
      webull_creds_env: row.webull_creds_env || null,
      has_own_app_creds: !!(row.webull_creds_env || (row.webull_app_key_wrap && row.webull_app_secret_wrap)),
      notify_emails: row.notify_emails || null,
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
