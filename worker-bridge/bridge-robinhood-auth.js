// worker-bridge/bridge-robinhood-auth.js
//
// 2026-07-21 — Headless OAuth for the Robinhood Agentic Trading MCP.
//
// Implements the MCP authorization spec (OAuth 2.1):
//   1. Discovery: RFC 9728 Protected Resource Metadata → RFC 8414 Auth Server
//      Metadata (endpoints, PKCE support).
//   2. Client: pre-registered (env) → cached DCR (RFC 7591) fallback.
//   3. Authorization code + PKCE (S256, mandatory).
//   4. RFC 8707 `resource` indicator on EVERY authorize + token + refresh
//      request (binds the token's audience to the MCP server).
//   5. Headless refresh (resource indicator required on refresh too).
//
// The ONE interactive step is the operator approving consent in a browser
// (unavoidable for an authorization-code grant). Everything else — discovery,
// client registration, code exchange, and ongoing refresh — runs server-side.
//
// Pure helpers (PKCE, metadata parsing, URL/form builders) are unit-tested;
// the network orchestration is live-only and mock-gated.

import { wrapSecret, unwrapSecret, randomState } from "./bridge-crypto.js";
import { recordOauthState, consumeOauthState, readUser, writeUser } from "./bridge-storage.js";

const RH_MCP_RESOURCE_DEFAULT = "https://agent.robinhood.com/mcp/trading";
const RH_SCOPE_DEFAULT = "agentic.read agentic.trade";
const DISCOVERY_KV = "bridge:rh:oauth:discovery";
const CLIENT_KV = "bridge:rh:oauth:client";
const DISCOVERY_TTL_S = 3600;
const REFRESH_SKEW_MS = 5 * 60 * 1000; // refresh 5 min before expiry

// ── Pure helpers ────────────────────────────────────────────────────

function b64url(buf) {
  const arr = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** PKCE code_verifier: 43-128 char base64url (RFC 7636). */
export function randomCodeVerifier(bytes = 48) {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** PKCE S256 challenge = base64url(SHA-256(verifier)). */
export async function codeChallengeS256(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(verifier)));
  return b64url(digest);
}

export function mcpResource(env) {
  return String(env?.RH_MCP_RESOURCE || RH_MCP_RESOURCE_DEFAULT);
}

/** RFC 9728 Protected Resource Metadata → the trusted authorization server(s). */
export function parseProtectedResourceMetadata(json) {
  if (!json || typeof json !== "object") return null;
  const servers = Array.isArray(json.authorization_servers) ? json.authorization_servers : [];
  return {
    resource: json.resource || null,
    authorization_servers: servers,
    scopes_supported: Array.isArray(json.scopes_supported) ? json.scopes_supported : [],
  };
}

/** RFC 8414 Authorization Server Metadata → the endpoints we need. */
export function parseAuthServerMetadata(json) {
  if (!json || typeof json !== "object") return null;
  return {
    issuer: json.issuer || null,
    authorization_endpoint: json.authorization_endpoint || null,
    token_endpoint: json.token_endpoint || null,
    registration_endpoint: json.registration_endpoint || null,
    code_challenge_methods_supported: Array.isArray(json.code_challenge_methods_supported)
      ? json.code_challenge_methods_supported : [],
    scopes_supported: Array.isArray(json.scopes_supported) ? json.scopes_supported : [],
    token_endpoint_auth_methods_supported: Array.isArray(json.token_endpoint_auth_methods_supported)
      ? json.token_endpoint_auth_methods_supported : [],
  };
}

/** Build the authorize URL with PKCE + the RFC 8707 resource indicator. */
export function buildAuthorizeUrl({ asMeta, clientId, redirectUri, scope, state, codeChallenge, resource }) {
  const u = new URL(asMeta.authorization_endpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  if (scope) u.searchParams.set("scope", scope);
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", codeChallenge);
  u.searchParams.set("code_challenge_method", "S256");
  // RFC 8707 — bind the resulting token's audience to the MCP server.
  u.searchParams.set("resource", resource);
  return u.toString();
}

/** Token request form. `resource` is REQUIRED on both code exchange and refresh. */
export function buildTokenForm({ grant, code, codeVerifier, refreshToken, clientId, clientSecret, redirectUri, resource }) {
  const f = new URLSearchParams();
  f.set("grant_type", grant);
  if (grant === "authorization_code") {
    f.set("code", code);
    f.set("redirect_uri", redirectUri);
    f.set("code_verifier", codeVerifier);
  } else if (grant === "refresh_token") {
    f.set("refresh_token", refreshToken);
  }
  f.set("client_id", clientId);
  if (clientSecret) f.set("client_secret", clientSecret);
  f.set("resource", resource); // RFC 8707 on every token request incl. refresh
  return f;
}

// ── Discovery + client registration (I/O) ───────────────────────────

async function fetchJson(url, init) {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), 10_000);
  try {
    const r = await fetch(url, { ...init, signal: controller.signal });
    const text = await r.text().catch(() => "");
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) {}
    return { ok: r.ok, status: r.status, json, text };
  } catch (e) {
    return { ok: false, status: 0, error: String(e?.message || e).slice(0, 160) };
  } finally {
    clearTimeout(tid);
  }
}

/**
 * Discover the RH MCP's authorization server + endpoints. Env overrides win
 * (in case RH's discovery is non-standard): RH_OAUTH_AUTHORIZE_URL,
 * RH_OAUTH_TOKEN_URL, RH_OAUTH_REGISTRATION_URL, RH_OAUTH_SCOPE.
 */
export async function discoverRhAuth(env) {
  const resource = mcpResource(env);
  const scope = String(env?.RH_OAUTH_SCOPE || RH_SCOPE_DEFAULT);

  // Full manual override — skip network discovery.
  if (env?.RH_OAUTH_AUTHORIZE_URL && env?.RH_OAUTH_TOKEN_URL) {
    return {
      ok: true, resource, scope,
      asMeta: {
        authorization_endpoint: env.RH_OAUTH_AUTHORIZE_URL,
        token_endpoint: env.RH_OAUTH_TOKEN_URL,
        registration_endpoint: env.RH_OAUTH_REGISTRATION_URL || null,
        code_challenge_methods_supported: ["S256"],
        scopes_supported: scope.split(/\s+/),
        token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
      },
      source: "env_override",
    };
  }

  const KV = env?.BRIDGE_KV;
  if (KV) {
    try {
      const cached = await KV.get(DISCOVERY_KV);
      if (cached) {
        const d = JSON.parse(cached);
        if (d?.asMeta?.authorization_endpoint && d?.asMeta?.token_endpoint) return { ...d, ok: true, cached: true };
      }
    } catch (_) {}
  }

  // 1. Protected Resource Metadata (RFC 9728).
  const origin = new URL(resource).origin;
  const path = new URL(resource).pathname.replace(/^\/|\/$/g, "");
  const prmCandidates = [
    env?.RH_OAUTH_PRM_URL,
    `${origin}/.well-known/oauth-protected-resource/${path}`,
    `${origin}/.well-known/oauth-protected-resource`,
  ].filter(Boolean);

  let prm = null;
  for (const url of prmCandidates) {
    const r = await fetchJson(url);
    if (r.ok && r.json) { prm = parseProtectedResourceMetadata(r.json); break; }
  }
  if (!prm || !prm.authorization_servers.length) {
    return { ok: false, error: "protected_resource_metadata_not_found", resource };
  }

  // 2. Authorization Server Metadata (RFC 8414 → OIDC fallback).
  const asIssuer = prm.authorization_servers[0].replace(/\/$/, "");
  const asCandidates = [
    `${asIssuer}/.well-known/oauth-authorization-server`,
    `${asIssuer}/.well-known/openid-configuration`,
  ];
  let asMeta = null;
  for (const url of asCandidates) {
    const r = await fetchJson(url);
    if (r.ok && r.json) { asMeta = parseAuthServerMetadata(r.json); break; }
  }
  if (!asMeta || !asMeta.authorization_endpoint || !asMeta.token_endpoint) {
    return { ok: false, error: "auth_server_metadata_not_found", as_issuer: asIssuer };
  }
  if (!asMeta.code_challenge_methods_supported.includes("S256")) {
    // MCP spec: refuse if S256 PKCE isn't supported.
    return { ok: false, error: "as_pkce_s256_unsupported" };
  }

  const out = { resource, scope: prm.scopes_supported.join(" ") || scope, asMeta, source: "discovery" };
  if (KV) {
    try { await KV.put(DISCOVERY_KV, JSON.stringify(out), { expirationTtl: DISCOVERY_TTL_S }); } catch (_) {}
  }
  return { ok: true, ...out };
}

/** Pre-registered client (env) → cached DCR (RFC 7591). */
export async function ensureRhClient(env, asMeta, redirectUri) {
  if (env?.ROBINHOOD_OAUTH_CLIENT_ID) {
    return { ok: true, client_id: env.ROBINHOOD_OAUTH_CLIENT_ID, client_secret: env?.ROBINHOOD_OAUTH_CLIENT_SECRET || null, source: "env" };
  }
  const KV = env?.BRIDGE_KV;
  if (KV) {
    try {
      const cached = await KV.get(CLIENT_KV);
      if (cached) {
        const c = JSON.parse(cached);
        if (c?.client_id) return { ok: true, ...c, cached: true };
      }
    } catch (_) {}
  }
  if (!asMeta?.registration_endpoint) {
    return { ok: false, error: "no_registration_endpoint_and_no_preregistered_client" };
  }
  // Dynamic Client Registration (RFC 7591). Public client + PKCE (no secret).
  const reg = await fetchJson(asMeta.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Timed Trading Bridge",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: String(env?.RH_OAUTH_SCOPE || RH_SCOPE_DEFAULT),
    }),
  });
  if (!reg.ok || !reg.json?.client_id) {
    return { ok: false, error: `dcr_failed_${reg.status}`, detail: String(reg.text || reg.error || "").slice(0, 160) };
  }
  const client = { client_id: reg.json.client_id, client_secret: reg.json.client_secret || null };
  if (KV) {
    try { await KV.put(CLIENT_KV, JSON.stringify(client)); } catch (_) {}
  }
  return { ok: true, ...client, source: "dcr" };
}

// ── Flow orchestration ──────────────────────────────────────────────

function getRedirectUri(env, req) {
  if (env?.OAUTH_REDIRECT_URI) return env.OAUTH_REDIRECT_URI;
  const url = new URL(req.url);
  return `${url.origin}/bridge/oauth/callback`;
}

export async function startRhOauth(env, req, userId) {
  const disc = await discoverRhAuth(env);
  if (!disc.ok) return { ok: false, error: `discovery_failed:${disc.error}`, status: 502 };

  const redirectUri = getRedirectUri(env, req);
  const client = await ensureRhClient(env, disc.asMeta, redirectUri);
  if (!client.ok) return { ok: false, error: `client_registration_failed:${client.error}`, status: 502 };

  const codeVerifier = randomCodeVerifier();
  const codeChallenge = await codeChallengeS256(codeVerifier);
  const state = randomState(32);

  await recordOauthState(env, state, {
    user_id: userId,
    code_verifier: codeVerifier,
    resource: disc.resource,
    scope: disc.scope,
    client_id: client.client_id,
    client_secret_present: !!client.client_secret,
    token_endpoint: disc.asMeta.token_endpoint,
    redirect_uri: redirectUri,
    started_at: Date.now(),
  });

  const existing = (await readUser(env, userId)) || { user_id: userId };
  await writeUser(env, userId, { ...existing, broker: "robinhood", status: "pending_oauth", pending_oauth_at: Date.now() });

  const authorize_url = buildAuthorizeUrl({
    asMeta: disc.asMeta,
    clientId: client.client_id,
    redirectUri,
    scope: disc.scope,
    state,
    codeChallenge,
    resource: disc.resource,
  });
  return { ok: true, status: 200, authorize_url, state, redirect_uri: redirectUri, resource: disc.resource };
}

export async function finishRhOauth(env, req) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const err = url.searchParams.get("error");
  if (err) return { ok: false, error: `oauth_error:${err}`, status: 400 };
  if (!code || !state) return { ok: false, error: "missing_code_or_state", status: 400 };

  const st = await consumeOauthState(env, state);
  if (!st) return { ok: false, error: "state_expired_or_unknown", status: 400 };
  const userId = String(st.user_id).toLowerCase();

  const clientSecret = st.client_secret_present
    ? (env?.ROBINHOOD_OAUTH_CLIENT_SECRET || null)
    : null;
  const form = buildTokenForm({
    grant: "authorization_code",
    code,
    codeVerifier: st.code_verifier,
    clientId: st.client_id,
    clientSecret,
    redirectUri: st.redirect_uri,
    resource: st.resource,
  });

  const r = await fetchJson(st.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
    body: form.toString(),
  });
  if (!r.ok || !r.json?.access_token) {
    return { ok: false, error: `token_exchange_${r.status}`, detail: String(r.text || r.error || "").slice(0, 200), status: 502 };
  }

  const accessToken = r.json.access_token;
  const refreshToken = r.json.refresh_token || null;
  const expiresIn = Number(r.json.expires_in) || 3600;
  const accountNumber = r.json.account_number || r.json.rh_account_number || null;

  const existing = (await readUser(env, userId)) || { user_id: userId };
  const user = {
    ...existing,
    broker: "robinhood",
    status: "connected",
    connected_at: Date.now(),
    rh_account_number: accountNumber || existing.rh_account_number || null,
    rh_token_wrap: await wrapSecret(env, accessToken),
    rh_refresh_wrap: refreshToken ? await wrapSecret(env, refreshToken) : (existing.rh_refresh_wrap || null),
    rh_token_expires_at: Date.now() + expiresIn * 1000,
    rh_oauth_client_id: st.client_id,
    rh_oauth_token_endpoint: st.token_endpoint,
    rh_oauth_resource: st.resource,
    broker_integration_enabled: existing.broker_integration_enabled ?? false,
  };
  await writeUser(env, userId, user);
  return {
    ok: true, status: 200, user_id: userId,
    rh_account_number: user.rh_account_number,
    broker_integration_enabled: user.broker_integration_enabled,
    note: "Robinhood connected. Create+fund a dedicated Agentic account, then flip broker_integration_enabled to start orders.",
  };
}

/**
 * Ensure a fresh access token for RH MCP calls. Refreshes with the refresh
 * token (resource indicator required) when within the skew window.
 * @returns {{ok, access_token?, user?, refreshed?, error?}}
 */
export async function ensureRhAccessToken(env, user) {
  if (!user?.rh_token_wrap) return { ok: false, error: "no_token" };
  const expiresAt = Number(user.rh_token_expires_at) || 0;
  const needsRefresh = expiresAt > 0 && Date.now() >= expiresAt - REFRESH_SKEW_MS;

  if (!needsRefresh) {
    try {
      return { ok: true, access_token: await unwrapSecret(env, user.rh_token_wrap), user, refreshed: false };
    } catch (e) {
      return { ok: false, error: `unwrap_failed:${String(e?.message || e).slice(0, 80)}` };
    }
  }

  if (!user.rh_refresh_wrap || !user.rh_oauth_token_endpoint || !user.rh_oauth_client_id) {
    // Can't refresh — return the (possibly still-valid) current token.
    try {
      return { ok: true, access_token: await unwrapSecret(env, user.rh_token_wrap), user, refreshed: false, stale: true };
    } catch (e) {
      return { ok: false, error: "no_refresh_material" };
    }
  }

  let refreshToken;
  try { refreshToken = await unwrapSecret(env, user.rh_refresh_wrap); }
  catch (e) { return { ok: false, error: "refresh_unwrap_failed" }; }

  const clientSecret = env?.ROBINHOOD_OAUTH_CLIENT_SECRET || null;
  const form = buildTokenForm({
    grant: "refresh_token",
    refreshToken,
    clientId: user.rh_oauth_client_id,
    clientSecret,
    resource: user.rh_oauth_resource || mcpResource(env),
  });
  const r = await fetchJson(user.rh_oauth_token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
    body: form.toString(),
  });
  if (!r.ok || !r.json?.access_token) {
    return { ok: false, error: `refresh_${r.status}`, detail: String(r.text || r.error || "").slice(0, 160) };
  }
  const accessToken = r.json.access_token;
  const expiresIn = Number(r.json.expires_in) || 3600;
  const updated = {
    ...user,
    rh_token_wrap: await wrapSecret(env, accessToken),
    rh_token_expires_at: Date.now() + expiresIn * 1000,
    // Refresh-token rotation: store the new one if returned.
    rh_refresh_wrap: r.json.refresh_token ? await wrapSecret(env, r.json.refresh_token) : user.rh_refresh_wrap,
  };
  await writeUser(env, user.user_id, updated);
  return { ok: true, access_token: accessToken, user: updated, refreshed: true };
}

/** Cron: proactively refresh RH tokens nearing expiry. */
export async function refreshRhTokensIfNeeded(env, { limit = 50 } = {}) {
  const mock = String(env?.BROKER_BRIDGE_MOCK || "true").toLowerCase() !== "false";
  if (mock) return { ok: true, skipped: "mock_mode", refreshed: 0 };
  const { listConnectedUsers } = await import("./bridge-storage.js");
  const users = await listConnectedUsers(env, limit);
  const rh = users.filter((u) => u && u.status === "connected" && String(u.broker || "").toLowerCase() === "robinhood" && u.rh_token_wrap);
  let refreshed = 0, failed = 0;
  for (const u of rh) {
    try {
      const res = await ensureRhAccessToken(env, u);
      if (res.ok && res.refreshed) refreshed++;
      else if (!res.ok) failed++;
    } catch (_) { failed++; }
  }
  return { ok: true, refreshed, failed, total: rh.length };
}
