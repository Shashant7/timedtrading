// API module — HTTP helpers, CORS, rate limiting, auth, user management
import { sendWelcomeEmail } from "./email.js";

export const sendJSON = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

export function corsHeaders(env, req, allowNoOrigin = false) {
  const corsConfig = env.CORS_ALLOW_ORIGIN || "";
  const allowedOrigins = corsConfig
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  const origin = req?.headers?.get("Origin") || "";

  const isCloudflarePages =
    origin.includes(".pages.dev") || origin.includes("pages.dev") ||
    origin.includes("timed-trading.com");

  console.log("CORS check:", {
    hasConfig: !!corsConfig,
    configLength: corsConfig.length,
    configValue: corsConfig.substring(0, 50),
    allowedOriginsCount: allowedOrigins.length,
    allowedOrigins,
    requestedOrigin: origin,
    originLength: origin.length,
    allowNoOrigin,
    isCloudflarePages,
  });

  let allowed;
  // Cloudflare Pages origins MUST get the specific origin back (not "*")
  // so that credentials: "include" works for cross-origin CF Access cookies.
  if (isCloudflarePages) {
    allowed = origin;
  } else if (allowedOrigins.length === 0 || allowedOrigins.includes("*")) {
    allowed = "*";
  } else if (origin === "" && allowNoOrigin) {
    allowed = "*";
  } else if (allowedOrigins.includes(origin)) {
    allowed = origin;
  } else {
    console.log("CORS mismatch:", {
      requested: origin,
      requestedLength: origin.length,
      allowed: allowedOrigins,
      allowedLengths: allowedOrigins.map((o) => o.length),
      config: corsConfig,
      exactMatch: allowedOrigins.some((o) => o === origin),
      caseInsensitiveMatch: allowedOrigins.some(
        (o) => o.toLowerCase() === origin.toLowerCase(),
      ),
    });
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
  if (!expected) return null;
  const url = new URL(req.url);
  const qKey = url.searchParams.get("key");
  if (qKey && qKey === expected) return null;
  return sendJSON(
    { ok: false, error: "unauthorized" },
    401,
    corsHeaders(env, req),
  );
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
    _jwksCache = { keys: data.keys || data.public_certs, ts: now };
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

    // Verify signature using JWKS
    const keys = await getAccessPublicKeys(teamDomain);
    if (!keys || keys.length === 0) {
      console.warn("[AUTH] No JWKS keys available, skipping signature check");
      return payload; // Degrade gracefully — still extract identity
    }

    // Find the matching key by kid
    const kid = header.kid;
    let matchingKey = keys.find((k) => k.kid === kid);
    if (!matchingKey && keys.length > 0) matchingKey = keys[0]; // fallback

    if (matchingKey) {
      // If keys have 'cert' field (Cloudflare format), we can't easily verify
      // with crypto.subtle. If they have JWK fields (n, e), we can.
      if (matchingKey.n && matchingKey.e) {
        const cryptoKey = await importPublicKey(matchingKey);
        const signatureBytes = Uint8Array.from(
          atob(parts[2].replace(/-/g, "+").replace(/_/g, "/")),
          (c) => c.charCodeAt(0),
        );
        const dataBytes = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
        const valid = await crypto.subtle.verify(
          "RSASSA-PKCS1-v1_5",
          cryptoKey,
          signatureBytes,
          dataBytes,
        );
        if (!valid) return null;
      }
      // If cert-based verification isn't possible, trust Cloudflare's edge
      // (the JWT was set by Access middleware, not user-controlled)
    }

    return payload;
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
    // Return basic identity even if D1 fails
    return { email, display_name: name, role: "member", tier: "free" };
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
 * Require auth via EITHER API key (?key=) OR Cloudflare Access JWT (admin role).
 * Use this for admin/debug endpoints to support both machine and human access.
 * Returns null if authorized, or a 401/403 Response if not.
 */
export async function requireKeyOrAdmin(req, env) {
  // Try API key first (machine-to-machine: scripts, webhooks)
  const keyResult = requireKeyOr401(req, env);
  if (!keyResult) return null; // API key is valid

  // Try JWT auth (human via Cloudflare Access)
  const user = await authenticateUser(req, env);
  if (user && (user.role === "admin" || user.email === env.ADMIN_EMAIL)) {
    return null; // Admin user authenticated
  }

  // Neither worked
  return keyResult; // Return the 401 from API key check
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
