// API module — HTTP helpers, CORS, rate limiting, auth, user management
import { sendWelcomeEmail } from "./email.js";

// 2026-06-10 PERF — COMPACT stringify (was `JSON.stringify(obj, null, 2)`).
// Pretty-printing inflated /timed/all from ~15.4MB of data to a 26.5MB
// response body: 70%+ overhead in pure indentation on deeply nested
// ticker objects, paid in worker CPU (stringify + compression) on EVERY
// API response, AND it pushed the /timed/all micro-cache value past
// KV's 25MB cap so the cache write silently failed — every page load
// re-ran the full 20s snapshot assembly, which is what made the Today
// page hang and 500/503 under fresh-login fan-out. No client parses
// whitespace; curl users can pipe to `jq .`.
export const sendJSON = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

const CRITICAL_ENV_KEYS = [
  "TIMED_API_KEY",
  "CORS_ALLOW_ORIGIN",
  "CF_ACCESS_TEAM_DOMAIN",
  "CF_ACCESS_AUD",
  "ADMIN_EMAIL",
];

let _runtimeEnvValidation = { fingerprint: null, issues: [] };

function getRuntimeEnvFingerprint(env) {
  return CRITICAL_ENV_KEYS
    .map((key) => `${key}:${String(env?.[key] || "").trim()}`)
    .join("|");
}

export function getRuntimeEnvIssues(env) {
  const fingerprint = getRuntimeEnvFingerprint(env);
  if (_runtimeEnvValidation.fingerprint === fingerprint) {
    return _runtimeEnvValidation.issues;
  }

  const issues = [];
  for (const key of CRITICAL_ENV_KEYS) {
    if (!String(env?.[key] || "").trim()) {
      issues.push(`missing:${key}`);
    }
  }

  const corsOrigin = String(env?.CORS_ALLOW_ORIGIN || "").trim();
  if (corsOrigin === "*" || corsOrigin.includes("*")) {
    issues.push("invalid:CORS_ALLOW_ORIGIN");
  }

  _runtimeEnvValidation = { fingerprint, issues };
  return issues;
}

export function requireRuntimeConfig(env, req = null) {
  const issues = getRuntimeEnvIssues(env);
  if (!issues.length) return null;

  console.error("[CONFIG] Critical runtime configuration invalid", { issues });
  return sendJSON(
    {
      ok: false,
      error: "runtime_misconfigured",
      issues,
    },
    503,
    corsHeaders(env, req, true),
  );
}

export function corsHeaders(env, req, allowNoOrigin = false) {
  const corsConfig = env.CORS_ALLOW_ORIGIN || "";
  const allowedOrigins = corsConfig
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  const origin = req?.headers?.get("Origin") || "";

  let allowed;
  if (!origin && allowNoOrigin) {
    allowed = "*";
  } else if (!origin) {
    allowed = "*";
  } else if (allowedOrigins.includes(origin)) {
    allowed = origin;
  } else {
    console.warn("[CORS] Rejected origin", { origin, allowedOrigins });
    allowed = "null";
  }

  const headers = {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS,DELETE",
    "Access-Control-Allow-Headers": "Content-Type,CF-Access-JWT-Assertion",
    Vary: "Origin",
  };

  // Allow credentials when origin is a specific match (not wildcard)
  // This enables CF Access JWT cookies to be sent cross-origin
  if (allowed && allowed !== "*" && allowed !== "null") {
    headers["Access-Control-Allow-Credentials"] = "true";
  }

  if (req?.method === "OPTIONS") {
    headers["Access-Control-Max-Age"] = "86400";
    const requestedMethod = req.headers.get("Access-Control-Request-Method");
    const requestedHeaders = req.headers.get("Access-Control-Request-Headers");
    if (requestedMethod) {
      headers["Access-Control-Allow-Methods"] = "GET,POST,OPTIONS";
    }
    if (requestedHeaders) {
      headers["Access-Control-Allow-Headers"] = requestedHeaders;
    }
  }

  return headers;
}

export function ackJSON(env, obj, fallbackStatus = 200, req = null) {
  const always200 = (env.TV_ACK_ALWAYS_200 ?? "true") !== "false";
  return sendJSON(obj, always200 ? 200 : fallbackStatus, corsHeaders(env, req));
}

export async function readBodyAsJSON(req) {
  const raw = await req.text();
  try {
    return { obj: JSON.parse(raw), raw, err: null };
  } catch (e) {
    return { obj: null, raw, err: e };
  }
}

export function requireKeyOr401(req, env) {
  const expected = env.TIMED_API_KEY;
  if (!expected) {
    return sendJSON(
      { ok: false, error: "unauthorized" },
      401,
      corsHeaders(env, req),
    );
  }

  // Preferred: API key via header. Headers don't end up in access logs,
  // browser history, or Referer chains the way query strings do.
  const headerKey =
    req.headers.get("X-API-Key") ||
    (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (headerKey && headerKey === expected) return null;

  // Legacy: ?key= query param. Accepted during migration unless the
  // operator flips ALLOW_QUERY_API_KEY=false (do that AFTER rotating
  // TIMED_API_KEY and migrating external scripts to headers).
  if (String(env.ALLOW_QUERY_API_KEY || "true") !== "false") {
    const url = new URL(req.url);
    const qKey = url.searchParams.get("key");
    if (qKey && qKey === expected) {
      console.warn(
        `[AUTH] Deprecated ?key= auth used on ${url.pathname} — migrate caller to X-API-Key header`,
      );
      return null;
    }
  }

  return sendJSON(
    { ok: false, error: "unauthorized" },
    401,
    corsHeaders(env, req),
  );
}

/**
 * Auth for TradingView webhook INGEST endpoints (candle / heartbeat capture).
 *
 * TradingView webhooks CANNOT send custom headers — only a URL + JSON body — so
 * these endpoints MUST accept a `?key=` query param. They accept EITHER the main
 * `TIMED_API_KEY` OR a dedicated, independently-rotatable `TV_INGEST_KEY`. This
 * decouples the webhook from the admin key: rotating the admin key (or the
 * security migration that flips `ALLOW_QUERY_API_KEY=false`) must NEVER silently
 * 401 the candle capture and leave prices stale — the 2026-06-15 incident.
 *
 * Low-privilege by design: only the ingest/heartbeat routes use this, so the TV
 * key can be a simple, rotatable value that grants candle capture and nothing
 * else. `?key=` is always permitted here (TV's only option) regardless of the
 * global `ALLOW_QUERY_API_KEY` flag.
 */
export function requireIngestKey(req, env) {
  const keys = [env.TV_INGEST_KEY, env.TIMED_API_KEY].filter(Boolean);
  if (keys.length === 0) {
    return sendJSON({ ok: false, error: "unauthorized" }, 401, corsHeaders(env, req));
  }
  const headerKey =
    req.headers.get("X-API-Key") ||
    (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (headerKey && keys.includes(headerKey)) return null;
  try {
    const qKey = new URL(req.url).searchParams.get("key");
    if (qKey && keys.includes(qKey)) return null;
  } catch (_) { /* malformed URL → fall through to 401 */ }
  return sendJSON({ ok: false, error: "unauthorized" }, 401, corsHeaders(env, req));
}

// COST OPTIMIZATION: Rate limiting now uses Workers Cache API (caches.default)
// instead of KV. The Cache API is free and eliminates ~6-10M KV read+write
// operations per month (~$15-25/month savings).
//
// How it works: We store a JSON counter in the Cache API keyed by a synthetic URL.
// Cache entries auto-expire via Cache-Control max-age (replaces KV expirationTtl).
// On cache miss, the counter starts at 0 (fail-open, same as KV timeout behavior).
export async function checkRateLimit(
  KV,
  identifier,
  endpoint,
  limit = 100,
  window = 3600,
) {
  const cacheKey = `https://rate-limit.internal/${identifier}/${endpoint}`;
  try {
    const cache = caches.default;
    const cached = await cache.match(cacheKey);
    let current = 0;
    if (cached) {
      try {
        const data = await cached.json();
        current = Number(data.count) || 0;
      } catch { /* corrupt cache entry, reset */ }
    }

    if (current >= limit) {
      return {
        allowed: false,
        remaining: 0,
        resetAt: Date.now() + window * 1000,
      };
    }

    const newResponse = new Response(JSON.stringify({ count: current + 1 }), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": `max-age=${window}`,
      },
    });
    await cache.put(cacheKey, newResponse);

    return {
      allowed: true,
      remaining: limit - current - 1,
      resetAt: Date.now() + window * 1000,
    };
  } catch (e) {
    console.warn(
      `[RATE LIMIT] Cache API error for ${endpoint}:`,
      String(e?.message || e),
    );
    return {
      allowed: true,
      remaining: Math.max(0, limit - 1),
      resetAt: Date.now() + window * 1000,
    };
  }
}

// ── Cloudflare Access JWT Authentication ──────────────────────────────────
// Validates the CF-Access-JWT-Assertion header set by Cloudflare Zero Trust.
// Returns user object { email, name } or null if no valid JWT present.
// Does NOT block requests — callers decide whether to require auth.

/**
 * Decode a base64url string to a regular string.
 */
function base64urlDecode(str) {
  // Replace URL-safe chars with standard base64 chars
  let base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  // Add padding if needed
  while (base64.length % 4) base64 += "=";
  return atob(base64);
}

/**
 * Import a JWK public key for RS256 verification.
 */
async function importPublicKey(jwk) {
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
}

/**
 * Fetch Cloudflare Access public keys (JWKS) for JWT verification.
 * Cached in-memory for 1 hour.
 */
let _jwksCache = { keys: null, ts: 0 };
const JWKS_CACHE_TTL = 60 * 60 * 1000; // 1 hour

async function getAccessPublicKeys(teamDomain) {
  const now = Date.now();
  if (_jwksCache.keys && now - _jwksCache.ts < JWKS_CACHE_TTL) {
    return _jwksCache.keys;
  }
  try {
    const resp = await fetch(
      `https://${teamDomain}.cloudflareaccess.com/cdn-cgi/access/certs`,
    );
    if (!resp.ok) throw new Error(`JWKS fetch failed: ${resp.status}`);
    const data = await resp.json();
    // Only keep keys usable for RS256 verification (JWK with modulus +
    // exponent). PEM `public_certs` entries cannot be imported via
    // crypto.subtle without ASN.1 parsing and previously caused the
    // verifier to silently skip the signature check entirely.
    const usable = (Array.isArray(data.keys) ? data.keys : []).filter(
      (k) => k && k.n && k.e,
    );
    if (usable.length > 0) {
      _jwksCache = { keys: usable, ts: now };
    } else {
      console.warn("[AUTH] JWKS endpoint returned no usable RSA keys");
    }
    return _jwksCache.keys;
  } catch (e) {
    console.warn("[AUTH] Failed to fetch JWKS:", String(e?.message || e));
    return _jwksCache.keys; // return stale cache
  }
}

/**
 * Verify a Cloudflare Access JWT token.
 * Returns the decoded payload or null if invalid.
 */
async function verifyAccessJWT(token, teamDomain, expectedAud) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const headerJSON = base64urlDecode(parts[0]);
    const payloadJSON = base64urlDecode(parts[1]);
    const header = JSON.parse(headerJSON);
    const payload = JSON.parse(payloadJSON);

    // Check expiry
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }

    // Check audience
    if (expectedAud && payload.aud) {
      const audArray = Array.isArray(payload.aud)
        ? payload.aud
        : [payload.aud];
      if (!audArray.includes(expectedAud)) return null;
    }

    // Verify signature using JWKS — FAIL CLOSED. A JWT whose signature
    // cannot be verified must never yield an identity: the assertion
    // header is attacker-controllable on any path that reaches the
    // worker without passing through Access (workers.dev, service
    // misconfig). Operators retain the API-key path if JWKS is down.
    const keys = await getAccessPublicKeys(teamDomain);
    if (!keys || keys.length === 0) {
      console.warn("[AUTH] No JWKS keys available — rejecting JWT (fail closed)");
      return null;
    }

    const signatureBytes = Uint8Array.from(
      atob(parts[2].replace(/-/g, "+").replace(/_/g, "/")),
      (c) => c.charCodeAt(0),
    );
    const dataBytes = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);

    // Try the kid-matched key first, then any remaining keys (rotation
    // windows can briefly desync kid ordering).
    const kid = header.kid;
    const ordered = [
      ...keys.filter((k) => k.kid === kid),
      ...keys.filter((k) => k.kid !== kid),
    ];
    for (const key of ordered) {
      try {
        const cryptoKey = await importPublicKey(key);
        const valid = await crypto.subtle.verify(
          "RSASSA-PKCS1-v1_5",
          cryptoKey,
          signatureBytes,
          dataBytes,
        );
        if (valid) return payload;
      } catch {
        // Malformed key — try the next one
      }
    }

    console.warn("[AUTH] JWT signature verification failed for all JWKS keys");
    return null;
  } catch (e) {
    console.warn("[AUTH] JWT verification error:", String(e?.message || e));
    return null;
  }
}

/**
 * Authenticate the current request via Cloudflare Access JWT.
 * Returns user record from D1 (auto-provisioned on first login) or null.
 *
 * Usage: const user = await authenticateUser(req, env);
 *   user = { email, display_name, role, tier, ... } or null
 */
export async function authenticateUser(req, env) {
  const teamDomain = env.CF_ACCESS_TEAM_DOMAIN;
  const aud = env.CF_ACCESS_AUD;

  // If Access is not configured, fall back to no-auth (development mode)
  if (!teamDomain) return null;

  const jwt =
    req.headers.get("CF-Access-JWT-Assertion") ||
    req.headers.get("cf-access-jwt-assertion");
  if (!jwt) return null;

  const payload = await verifyAccessJWT(jwt, teamDomain, aud);
  if (!payload || !payload.email) return null;

  const email = payload.email;
  const name =
    payload.name ||
    payload.custom?.name ||
    email.split("@")[0];

  // Lookup or auto-provision user in D1
  const DB = env?.DB;
  if (!DB) {
    // No D1 — return basic identity from JWT
    return { email, display_name: name, role: "member", tier: "free" };
  }

  try {
    // Try to get existing user
    const existing = await DB.prepare(
      `SELECT * FROM users WHERE email = ?`,
    )
      .bind(email)
      .first();

    if (existing) {
      // Hard ban — keep blocking. The /timed/me handler still surfaces
      // this case explicitly so the operator sees a "blocked" page
      // instead of an infinite login loop.
      if (existing.status === "blocked") {
        return { ...existing, _blocked: true };
      }

      // Soft-removed (admin "Remove" button, not "PERMANENTLY delete").
      // Old behaviour returned null → frontend stuck on LoginScreen,
      // SSO loop, user dead-ended (2026-05-31 incident: benjasani test).
      //
      // New behaviour: treat status='removed' as "this account was
      // offboarded; if the same person comes back via the same Google
      // identity, they almost always mean to start fresh." Auto-revive
      // with subscription cleared so they re-enter the trial flow. Keep
      // an audit trail via `reactivated_at` + the original
      // `removed_at`. Admin can still hard ban via "Block" if intent
      // was punitive.
      if (existing.status === "removed") {
        const now = Date.now();
        try {
          await DB.prepare(
            `UPDATE users SET
              status = 'active',
              tier = 'free',
              role = CASE WHEN role = 'admin' THEN role ELSE 'member' END,
              subscription_status = NULL,
              stripe_customer_id = NULL,
              stripe_subscription_id = NULL,
              trial_end = NULL,
              terms_accepted_at = NULL,
              reactivated_at = ?,
              updated_at = ?,
              last_login_at = ?,
              display_name = COALESCE(?, display_name)
            WHERE email = ?`,
          )
            .bind(now, now, now, name, email)
            .run();
        } catch (e) {
          // Older schemas may not have the reactivated_at column; fall
          // back to the minimum revive so the user can still proceed.
          try {
            await DB.prepare(
              `UPDATE users SET status = 'active', tier = 'free', subscription_status = NULL,
                trial_end = NULL, terms_accepted_at = NULL, updated_at = ?, last_login_at = ?
                WHERE email = ?`,
            )
              .bind(now, now, email)
              .run();
          } catch (_) {}
        }
        try { console.log(`[AUTH] Reactivated soft-removed user: ${email}`); } catch (_) {}
        return {
          ...existing,
          status: "active",
          tier: "free",
          subscription_status: null,
          trial_end: null,
          terms_accepted_at: null,
          reactivated_at: now,
          last_login_at: now,
          display_name: name || existing.display_name,
        };
      }

      // Update last login + session tracking (login_count, login_days)
      const now = Date.now();
      const todayNY = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }); // "YYYY-MM-DD"
      const isNewDay = existing.last_login_day !== todayNY;
      try {
        await DB.prepare(
          `UPDATE users SET
            last_login_at = ?,
            display_name = COALESCE(?, display_name),
            login_count = COALESCE(login_count, 0) + 1,
            login_days = COALESCE(login_days, 0) + ?,
            last_login_day = ?
          WHERE email = ?`,
        )
          .bind(now, name, isNewDay ? 1 : 0, todayNY, email)
          .run();
      } catch {
        // Fallback if new columns don't exist yet
        await DB.prepare(
          `UPDATE users SET last_login_at = ?, display_name = COALESCE(?, display_name) WHERE email = ?`,
        )
          .bind(now, name, email)
          .run();
      }
      return existing;
    }

    // Auto-provision new user
    const now = Date.now();
    const todayNYNew = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const newUser = {
      email,
      display_name: name,
      role: "member",
      tier: "free",
      created_at: now,
      updated_at: now,
      last_login_at: now,
      expires_at: null,
      login_count: 1,
      login_days: 1,
      last_login_day: todayNYNew,
    };

    try {
      await DB.prepare(
        `INSERT INTO users (email, display_name, role, tier, created_at, updated_at, last_login_at, expires_at, login_count, login_days, last_login_day)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          newUser.email, newUser.display_name, newUser.role, newUser.tier,
          newUser.created_at, newUser.updated_at, newUser.last_login_at, newUser.expires_at,
          newUser.login_count, newUser.login_days, newUser.last_login_day,
        )
        .run();
    } catch {
      // Fallback if new columns don't exist yet
      await DB.prepare(
        `INSERT INTO users (email, display_name, role, tier, created_at, updated_at, last_login_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          newUser.email, newUser.display_name, newUser.role, newUser.tier,
          newUser.created_at, newUser.updated_at, newUser.last_login_at, newUser.expires_at,
        )
        .run();
    }

    console.log(`[AUTH] Auto-provisioned new user: ${email}`);
    // Fire-and-forget welcome email on first login
    if (env) {
      sendWelcomeEmail(env, newUser).catch(e =>
        console.warn("[AUTH] Welcome email failed:", String(e?.message || e).slice(0, 150))
      );
    }
    return newUser;
  } catch (e) {
    console.warn(
      "[AUTH] D1 user lookup failed:",
      String(e?.message || e).slice(0, 200),
    );
    // Return basic identity even if D1 fails, but mark the profile as degraded so
    // the frontend does not mistake the missing DB-backed fields for real state.
    return {
      email,
      display_name: name,
      role: "member",
      tier: "free",
      auth_d1_unavailable: true,
      terms_accepted_at: null,
    };
  }
}

/**
 * Require authenticated user with specific role/tier.
 * Returns [user, errorResponse] — check errorResponse first.
 *
 * Usage:
 *   const [user, err] = await requireUser(req, env, { role: "admin" });
 *   if (err) return err;
 */
export async function requireUser(req, env, opts = {}) {
  const user = await authenticateUser(req, env);
  const cors = corsHeaders(env, req);

  if (!user) {
    return [
      null,
      sendJSON(
        { ok: false, error: "authentication_required" },
        401,
        cors,
      ),
    ];
  }

  if (opts.role && user.role !== opts.role && user.role !== "admin") {
    return [
      null,
      sendJSON(
        {
          ok: false,
          error: "insufficient_role",
          required: opts.role,
          current: user.role,
        },
        403,
        cors,
      ),
    ];
  }

  if (opts.tier) {
    const tierOrder = { free: 0, pro: 1, vip: 1, admin: 2 };
    const required = tierOrder[opts.tier] || 0;
    const current = tierOrder[user.tier] || 0;
    if (current < required) {
      // Check expiry
      if (user.expires_at && user.expires_at < Date.now()) {
        return [
          null,
          sendJSON(
            { ok: false, error: "subscription_expired", tier: user.tier },
            403,
            cors,
          ),
        ];
      }
      return [
        null,
        sendJSON(
          {
            ok: false,
            error: "insufficient_tier",
            required: opts.tier,
            current: user.tier,
          },
          403,
          cors,
        ),
      ];
    }
  }

  return [user, null];
}

/**
 * Compute the data-access tier for a (possibly null) authenticated user.
 * Mirrors the canonical isPro predicate in skills/user-state-matrix.md —
 * worker and frontend MUST stay in sync on this.
 *
 * Returns "admin" | "pro" | "free" | "anon".
 */
export function computeUserDataTier(user, env) {
  if (!user) return "anon";
  if (
    user.role === "admin" ||
    user.tier === "admin" ||
    (env?.ADMIN_EMAIL && user.email === env.ADMIN_EMAIL)
  ) {
    return "admin";
  }
  const subStatus = user.subscription_status;
  const isPastDueInGrace =
    subStatus === "past_due" &&
    Number.isFinite(Number(user.expires_at)) &&
    Number(user.expires_at) > Date.now();
  const isPro =
    user.tier === "pro" ||
    user.tier === "vip" ||
    subStatus === "active" ||
    subStatus === "trialing" ||
    subStatus === "manual" ||
    subStatus === "canceling" ||
    isPastDueInGrace;
  return isPro ? "pro" : "free";
}

// Licensed live price fields. Twelve Data licensing forbids redistributing
// live prices to unentitled visitors. Per operator policy (2026-06-18) live
// prices go to Pro/VIP/Admin only — NOT Members (signed-in, never paid) and
// NOT anon. Kept as a separate set from the proprietary model fields below
// for clarity, though both are stripped together for the unentitled tiers.
const LIVE_PRICE_SNAPSHOT_FIELDS = new Set([
  "price", "close", "open", "high", "low", "volume",
  "prev_close", "prevClose", "p", "pc", "dc", "dp", "dh", "dl", "dv",
  "day_change", "day_change_pct", "dailyChg", "dailyChgPct",
  "ahp", "ahdc", "ahdp", "_ah_change_pct", "extended_price",
  "_live_prev_close", "_live_price", "_price_updated_at",
  "vwap",
]);

// Proprietary model outputs — stripped for Member (free) AND anon.
const PROPRIETARY_SNAPSHOT_FIELDS = new Set([
  "sl", "tp", "tp1", "tp2", "tp3", "targets", "stop_loss", "take_profit",
  "rank", "score", "dynamicScore", "entry_quality", "conviction",
  "regime_forecast", "kanban_stage", "trade_plan",
]);

/** @deprecated internal alias — use tier-aware redactTickerSnapshot(obj, tier) */
const RESTRICTED_SNAPSHOT_FIELDS = new Set([
  ...LIVE_PRICE_SNAPSHOT_FIELDS,
  ...PROPRIETARY_SNAPSHOT_FIELDS,
]);

/**
 * Whether a computeUserDataTier() result may receive licensed live prices
 * AND proprietary model outputs (scores, SL/TP, ranks).
 *
 * User-type policy (operator, 2026-06-18):
 *   Pro (paying), VIP (invited, no fee), Admin → full access.
 *   Member (signed in, never passed the Stripe paywall) + anon → neither.
 * computeUserDataTier() collapses pro+vip → "pro" and "Member" → "free", so
 * the gate is simply admin/pro. (There is no real "free" user type; the code's
 * "free" tier == a "Member".)
 */
export function canAccessLivePrices(tier) {
  return tier === "admin" || tier === "pro";
}

/**
 * Redact a single ticker snapshot object for the caller tier.
 * - admin/pro (incl VIP): untouched
 * - free (Member) + anon: strip BOTH licensed live prices AND proprietary
 *   model fields. (Members never passed the paywall; they get neither.)
 */
export function redactTickerSnapshot(obj, tier = "anon") {
  if (!obj || typeof obj !== "object") return obj;
  if (canAccessLivePrices(tier)) return obj; // admin / pro / vip
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (LIVE_PRICE_SNAPSHOT_FIELDS.has(k) || PROPRIETARY_SNAPSHOT_FIELDS.has(k)) continue;
    out[k] = v;
  }
  out._redacted = true;
  return out;
}

/**
 * Redact a { SYM: snapshot } map in place-safe copy form.
 * "pro" and "admin" tiers pass through untouched.
 */
export function redactTickerMapForTier(dataMap, tier) {
  if (tier === "admin" || tier === "pro") return dataMap;
  if (!dataMap || typeof dataMap !== "object") return dataMap;
  const out = {};
  for (const [sym, payload] of Object.entries(dataMap)) {
    out[sym] = redactTickerSnapshot(payload, tier);
  }
  return out;
}

/**
 * Require auth via EITHER API key (?key=) OR Cloudflare Access JWT (admin role).
 * Use this for admin/debug endpoints to support both machine and human access.
 * Returns null if authorized, or a 401/403 Response if not.
 */
export async function requireKeyOrAdmin(req, env) {
  const expected = env.TIMED_API_KEY;
  if (expected) {
    const keyResult = requireKeyOr401(req, env);
    if (!keyResult) return null;
  }

  const user = await authenticateUser(req, env);
  if (user && (user.role === "admin" || user.tier === "admin" || user.email === env.ADMIN_EMAIL)) {
    return null;
  }

  return sendJSON(
    { ok: false, error: "unauthorized" },
    401,
    corsHeaders(env, req),
  );
}

/**
 * Admin session auth for browser UI: CF Access JWT first, API key second.
 * Prefer this over requireKeyOrAdmin for endpoints hit from Pages /timed proxy
 * where the operator is logged in but window._ttApiKey is never set.
 */
export async function requireAdminSession(req, env) {
  const user = await authenticateUser(req, env);
  if (user && (user.role === "admin" || user.tier === "admin" || user.email === env.ADMIN_EMAIL)) {
    return null;
  }
  const expected = env.TIMED_API_KEY;
  if (expected) {
    const keyResult = requireKeyOr401(req, env);
    if (!keyResult) return null;
  }
  return sendJSON(
    { ok: false, error: "admin_required" },
    403,
    corsHeaders(env, req),
  );
}

// COST OPTIMIZATION: Fixed-window rate limiting also uses Workers Cache API.
export async function checkRateLimitFixedWindow(
  KV,
  identifier,
  endpoint,
  limit = 100,
  window = 3600,
) {
  const bucket = Math.floor(Date.now() / (window * 1000));
  const cacheKey = `https://rate-limit.internal/${identifier}/${endpoint}/${bucket}`;
  const resetAt = (bucket + 1) * window * 1000;

  try {
    const cache = caches.default;
    const cached = await cache.match(cacheKey);
    let current = 0;
    if (cached) {
      try {
        const data = await cached.json();
        current = Number(data.count) || 0;
      } catch { /* corrupt, reset */ }
    }

    if (current >= limit) {
      return {
        allowed: false,
        remaining: 0,
        resetAt,
        limit,
        key: cacheKey,
      };
    }

    const ttl = Math.max(60, Math.ceil((resetAt - Date.now()) / 1000));
    const newResponse = new Response(JSON.stringify({ count: current + 1 }), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": `max-age=${ttl}`,
      },
    });
    await cache.put(cacheKey, newResponse);

    return {
      allowed: true,
      remaining: limit - current - 1,
      resetAt,
      limit,
      key: cacheKey,
    };
  } catch (e) {
    console.warn(`[RATE LIMIT] Cache API error for ${endpoint}:`, String(e?.message || e));
    return {
      allowed: true,
      remaining: Math.max(0, limit - 1),
      resetAt,
      limit,
      key: cacheKey,
    };
  }
}
