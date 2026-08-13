// worker-bridge/bridge-webull-auth.js
//
// 2026-06-15 — Webull Connect OAuth start/callback/disconnect.

import { wrapSecret, randomState } from "./bridge-crypto.js";
import { recordOauthState, consumeOauthState, readUser, writeUser } from "./bridge-storage.js";
import {
  buildWebullAuthorizeUrl,
  finalizeWebullTokens,
  findCrossOwnerWebullClash,
  isWebullAccessTokenError,
  normalizeWebullLoginLabel,
  parseWebullAccountList,
  resolvePersonalWebullAccessToken,
  syncWebullPersonalAccounts,
  webullCreateTokenFromCode,
  webullCredsEnvSuffix,
  webullEnvCredsFor,
  webullGetAccountList,
  webullSubUserId,
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

  // 2026-08-11 — Secondary Webull login (personal mode only): pass a
  // login_label and store that login's own App Key/Secret as worker
  // secrets named after the label (WEBULL_APP_KEY_<LABEL> /
  // WEBULL_APP_SECRET_<LABEL>, e.g. login_label "acct2" →
  // WEBULL_APP_KEY_ACCT2). Key rotation is then just `wrangler secret
  // put` — no re-connect. Inline app_key/app_secret in the body remain
  // supported as a fallback (wrapped per account row). Accounts sync
  // under the SAME owner email as `owner#webull#<label>-<slug>`, so
  // fan-out / enable / status / reconciliation all work unchanged. The
  // primary login keeps using the env-level WEBULL_APP_KEY/SECRET.
  //
  // Optional partner_email: stamped as notify_emails on each synced row
  // so actions on those accounts notify the partner in addition to
  // BRIDGE_ADMIN_NOTIFY_EMAIL.
  const appKey = String(body?.app_key || "").trim();
  const appSecret = String(body?.app_secret || "").trim();
  const loginLabel = normalizeWebullLoginLabel(body?.login_label);
  const partnerEmail = String(body?.partner_email || body?.notify_email || "").trim().toLowerCase();
  if (partnerEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(partnerEmail)) {
    return { ok: false, error: "invalid_partner_email", status: 400 };
  }
  if ((appKey || appSecret) && !(appKey && appSecret)) {
    return { ok: false, error: "app_key_and_app_secret_both_required", status: 400 };
  }
  if ((appKey || loginLabel) && webullAuthMode(env) !== "personal") {
    return { ok: false, error: "per_login_creds_require_personal_mode", status: 400 };
  }
  const bodyCreds = appKey ? { appKey, appSecret } : null;
  const credsEnvSuffix = (!bodyCreds && loginLabel) ? webullCredsEnvSuffix(loginLabel) : null;
  const envCreds = credsEnvSuffix ? webullEnvCredsFor(env, credsEnvSuffix) : null;
  if (credsEnvSuffix && !envCreds) {
    return {
      ok: false,
      error: "webull_env_creds_missing",
      status: 400,
      note: `Set worker secrets WEBULL_APP_KEY_${credsEnvSuffix} and WEBULL_APP_SECRET_${credsEnvSuffix} on tt-broker-bridge (wrangler secret put), then retry. Or pass app_key/app_secret inline.`,
    };
  }
  const secondLoginCreds = bodyCreds || envCreds;

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

  if (!webullCredentialsConfigured(env) && !secondLoginCreds) {
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
    // Validates the key pair against the live account list before anything
    // is persisted — a typo'd key/secret fails here with 502.
    // Keys generated with 2FA enabled also fail until a NORMAL access
    // token is created + approved in the Webull App (x-access-token).
    let accessToken = "";
    let accountsRes = await webullGetAccountList(env, accessToken, { creds: secondLoginCreds });
    let accounts = parseWebullAccountList(accountsRes);
    let personalTokenExpiresAt = null;
    if (!accounts.length && isWebullAccessTokenError(accountsRes)) {
      const tok = await resolvePersonalWebullAccessToken(env, {
        creds: secondLoginCreds,
        ownerEmail: userId,
      });
      if (!tok.ok) {
        return {
          ok: false,
          error: tok.error || "webull_2fa_required",
          status: tok.status || 400,
          token_status: tok.token_status || null,
          response: tok.response,
          note: tok.note || "This Webull API key requires 2FA approval in the Webull App before it can be linked.",
        };
      }
      accessToken = tok.token;
      personalTokenExpiresAt = tok.expires_at || null;
      accountsRes = await webullGetAccountList(env, accessToken, { creds: secondLoginCreds });
      accounts = parseWebullAccountList(accountsRes);
    }
    if (!accounts.length) {
      const tokenHint = isWebullAccessTokenError(accountsRes)
        ? " This looks like a 2FA access-token rejection — regenerate the key with 2FA unchecked, or approve the OpenAPI notification in the Webull App and retry."
        : "";
      return {
        ok: false,
        error: "webull_personal_account_list_failed",
        status: 502,
        response: accountsRes.response,
        note: (accountsRes.error || (credsEnvSuffix
          ? `Check secrets WEBULL_APP_KEY_${credsEnvSuffix}/WEBULL_APP_SECRET_${credsEnvSuffix} and WEBULL_ENVIRONMENT (prod vs uat).`
          : (bodyCreds
            ? "Check the provided app_key/app_secret and WEBULL_ENVIRONMENT (prod vs uat)."
            : "Check WEBULL_APP_KEY/SECRET and WEBULL_ENVIRONMENT (prod vs uat)."))) + tokenHint,
      };
    }
    // One Webull brokerage account may only be connected under ONE owner —
    // otherwise two app users would mirror into the same real account
    // (double orders) using shared credentials.
    {
      const { listConnectedUsers } = await import("./bridge-storage.js");
      const allRows = await listConnectedUsers(env, 200);
      const clash = findCrossOwnerWebullClash(allRows, userId, accounts);
      if (clash) {
        return {
          ok: false,
          error: "webull_account_already_connected",
          status: 409,
          note: "This Webull account is already connected to a different Timed Trading user. Each Webull account can only be linked once — contact support if this looks wrong.",
        };
      }
    }
    // Unlabeled keys are fine for a fresh owner's first connect and for
    // key rotation of the SAME login (account ids match the stored rows).
    // A genuinely different second login under this owner whose slugs
    // would collide with existing rows still requires a login_label.
    if (bodyCreds && !loginLabel) {
      for (const acct of accounts) {
        const subId = webullSubUserId(userId, acct);
        const existing = await readUser(env, subId);
        if (existing?.webull_account_id && existing.webull_account_id !== acct.account_id) {
          return {
            ok: false,
            error: "login_label_required_for_second_login",
            status: 400,
            note: "A different Webull login is already connected under this owner with the same account slugs. Pass login_label (e.g. 'acct2') so the new login's sub-accounts do not collide.",
          };
        }
      }
    }
    const credsWrap = bodyCreds
      ? {
        key_wrap: await wrapSecret(env, bodyCreds.appKey),
        secret_wrap: await wrapSecret(env, bodyCreds.appSecret),
      }
      : null;
    const accessTokenWrap = accessToken
      ? await wrapSecret(env, accessToken)
      : null;
    const synced = await syncWebullPersonalAccounts(env, userId, accounts, {
      credsWrap,
      credsEnv: envCreds ? credsEnvSuffix : null,
      loginLabel: secondLoginCreds ? loginLabel : null,
      notifyEmails: partnerEmail ? [partnerEmail] : null,
      // Always stamp — clears a stale 2FA wrap when the new key has 2FA off.
      accessTokenWrap,
      accessTokenExpiresAt: accessTokenWrap ? personalTokenExpiresAt : null,
    });
    return {
      ok: true,
      status: 200,
      personal: true,
      user_id: userId,
      login_label: secondLoginCreds ? loginLabel : null,
      creds_source: envCreds ? `env:WEBULL_APP_KEY_${credsEnvSuffix}` : (bodyCreds ? "wrapped_inline" : "env:WEBULL_APP_KEY"),
      partner_email: partnerEmail || null,
      accounts_connected: synced.length,
      accounts: synced,
      webull_2fa_token: !!accessTokenWrap,
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
      // 2026-08-12 — "Remove the connection" removes the credentials:
      // stored App Key/Secret wraps and the env-secret reference are
      // cleared so a disconnected row can never sign a request, and the
      // self-service mirror opt-in is revoked. Reconnect re-stamps all
      // of these.
      webull_app_key_wrap: null,
      webull_app_secret_wrap: null,
      webull_creds_env: null,
      mirror_participant: false,
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
      // 0 = unlimited — mirror on/off is the account control.
      max_per_order_usd: Number.isFinite(Number(env?.DEFAULT_MAX_ORDER_USD)) ? Number(env.DEFAULT_MAX_ORDER_USD) : 0,
      max_orders_per_day: 0,
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
