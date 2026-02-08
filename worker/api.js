// API module — HTTP helpers, CORS, rate limiting, auth

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
    origin.includes(".pages.dev") || origin.includes("pages.dev");

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
  if (allowedOrigins.length === 0 || allowedOrigins.includes("*")) {
    allowed = "*";
  } else if (origin === "" && allowNoOrigin) {
    allowed = "*";
  } else if (isCloudflarePages) {
    allowed = origin;
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
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };

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

export async function checkRateLimit(
  KV,
  identifier,
  endpoint,
  limit = 100,
  window = 3600,
) {
  const key = `ratelimit:${identifier}:${endpoint}`;

  const withTimeout = (p, ms) =>
    Promise.race([
      p,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("rate_limit_kv_timeout")), ms),
      ),
    ]);

  try {
    const count = await withTimeout(KV.get(key), 750);
    const current = count ? Number(count) : 0;

    if (current >= limit) {
      return {
        allowed: false,
        remaining: 0,
        resetAt: Date.now() + window * 1000,
      };
    }

    try {
      await withTimeout(
        KV.put(key, String(current + 1), { expirationTtl: window }),
        750,
      );
    } catch (e) {
      console.warn(
        `[RATE LIMIT] KV.put timeout for ${endpoint}:`,
        String(e?.message || e),
      );
    }

    return {
      allowed: true,
      remaining: limit - current - 1,
      resetAt: Date.now() + window * 1000,
    };
  } catch (e) {
    console.warn(
      `[RATE LIMIT] KV.get timeout for ${endpoint}:`,
      String(e?.message || e),
    );
    return {
      allowed: true,
      remaining: Math.max(0, limit - 1),
      resetAt: Date.now() + window * 1000,
    };
  }
}

export async function checkRateLimitFixedWindow(
  KV,
  identifier,
  endpoint,
  limit = 100,
  window = 3600,
) {
  const bucket = Math.floor(Date.now() / (window * 1000));
  const key = `ratelimit:${identifier}:${endpoint}:${bucket}`;
  const count = await KV.get(key);
  const current = count ? Number(count) : 0;

  const resetAt = (bucket + 1) * window * 1000;

  if (current >= limit) {
    return {
      allowed: false,
      remaining: 0,
      resetAt,
      limit,
      key,
    };
  }

  await KV.put(key, String(current + 1), { expirationTtl: window + 60 });
  return {
    allowed: true,
    remaining: limit - current - 1,
    resetAt,
    limit,
    key,
  };
}
