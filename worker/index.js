// Timed Trading Worker — KV latest + trail + rank + top lists + Discord alerts (CORRIDOR-ONLY)
// Routes:
// POST /timed/ingest?key=...
// GET  /timed/all
// GET  /timed/latest?ticker=XYZ
// GET  /timed/tickers
// GET  /timed/trail?ticker=XYZ
// GET  /timed/top?bucket=long|short|setup&n=10
// GET  /timed/momentum?ticker=XYZ
// GET  /timed/momentum/history?ticker=XYZ
// GET  /timed/momentum/all
// GET  /timed/sectors - Get all sectors and ratings
// GET  /timed/sectors/:sector/tickers?limit=10 - Get top tickers in sector
// GET  /timed/sectors/recommendations?limit=10&totalLimit=50 - Get top tickers across overweight sectors
// POST /timed/ingest-candles?key=... (multi-timeframe OHLCV capture)
// GET  /timed/candles?ticker=XYZ&tf=30&limit=200 (multi-timeframe OHLCV series)
// POST /timed/watchlist/add?key=... - Add tickers to watchlist
// POST /timed/cleanup-no-scores?key=... - Remove tickers without score data from index
// GET  /timed/health
// GET  /timed/version
// POST /timed/purge?key=... (manual purge)
// POST /timed/clear-rate-limit?key=...&ip=...&endpoint=... (clear rate limit)
// GET  /timed/trades?version=2.1.0 (get trades, optional version filter)
// POST /timed/trades?key=... (create/update trade)
// DELETE /timed/trades/:id?key=... (delete trade)
// GET  /timed/alert-debug?ticker=XYZ (debug why alerts aren't firing)
// GET  /timed/debug/trades (get all trades with details)
// GET  /timed/debug/tickers (get all tickers with latest data)
// GET  /timed/debug/config (check Discord and other config)
// POST /timed/debug/simulate-trades?key=... (manually simulate trades for all tickers)

async function readBodyAsJSON(req) {
  const raw = await req.text();
  try {
    return { obj: JSON.parse(raw), raw, err: null };
  } catch (e) {
    return { obj: null, raw, err: e };
  }
}

const sendJSON = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

function corsHeaders(env, req, allowNoOrigin = false) {
  // Get allowed origins from environment variable (comma-separated)
  const corsConfig = env.CORS_ALLOW_ORIGIN || "";
  const allowedOrigins = corsConfig
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  const origin = req?.headers?.get("Origin") || "";

  // Always allow Cloudflare Pages origins (timedtrading.pages.dev)
  // This ensures the dashboard always works regardless of CORS_ALLOW_ORIGIN config
  const isCloudflarePages =
    origin.includes(".pages.dev") || origin.includes("pages.dev");

  // Debug logging (will appear in Cloudflare Worker logs)
  console.log("CORS check:", {
    hasConfig: !!corsConfig,
    configLength: corsConfig.length,
    configValue: corsConfig.substring(0, 50), // First 50 chars for safety
    allowedOriginsCount: allowedOrigins.length,
    allowedOrigins: allowedOrigins,
    requestedOrigin: origin,
    originLength: origin.length,
    allowNoOrigin,
    isCloudflarePages,
  });

  // If no allowed origins configured, default to "*" (backward compatible)
  // Otherwise, only allow configured origins
  let allowed;
  if (allowedOrigins.length === 0) {
    allowed = "*";
  } else if (origin === "" && allowNoOrigin) {
    // Allow requests without origin (e.g., curl, direct API calls) for debug endpoints
    allowed = "*";
  } else if (isCloudflarePages) {
    // Always allow Cloudflare Pages origins
    allowed = origin;
  } else if (allowedOrigins.includes(origin)) {
    allowed = origin;
  } else {
    // Log for debugging (remove in production if needed)
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
    Vary: "Origin", // Important: tells Cloudflare to vary cache by Origin
  };

  // For preflight requests, add additional headers
  if (req?.method === "OPTIONS") {
    headers["Access-Control-Max-Age"] = "86400"; // 24 hours
    // Include the requested method and headers in the response
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

function ackJSON(env, obj, fallbackStatus = 200, req = null) {
  const always200 = (env.TV_ACK_ALWAYS_200 ?? "true") !== "false";
  return sendJSON(obj, always200 ? 200 : fallbackStatus, corsHeaders(env, req));
}

const normTicker = (t) => {
  let normalized = String(t || "")
    .trim()
    .toUpperCase();

  // Normalize BRK.B to BRK-B (TradingView uses BRK.B, but we standardize on BRK-B for US market)
  if (normalized === "BRK.B" || normalized === "BRK-B") {
    normalized = "BRK-B";
  }

  return normalized;
};
const isNum = (x) => Number.isFinite(Number(x));

// Trading day key in US/Eastern (for daily change vs yesterday close)
const NY_DAY_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const NY_WD_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
});
function nyTradingDayKey(tsMs) {
  const ms = Number(tsMs);
  if (!Number.isFinite(ms)) return null;
  try {
    return NY_DAY_FMT.format(new Date(ms)); // YYYY-MM-DD
  } catch {
    return null;
  }
}
function isNyWeekend(tsMs) {
  const ms = Number(tsMs);
  if (!Number.isFinite(ms)) return false;
  try {
    const wd = String(NY_WD_FMT.format(new Date(ms))).toLowerCase();
    return wd.startsWith("sat") || wd.startsWith("sun");
  } catch {
    return false;
  }
}

// Convert a wall-clock time in a TZ (YYYY-MM-DD at 00:00:00) to a UTC ms timestamp.
// We use a small fixed-point iteration to handle DST correctly.
const NY_TS_PARTS_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour12: false,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});
function tzOffsetMs(ts, timeZone) {
  const d = new Date(Number(ts));
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(d);
  const map = {};
  for (const p of parts) if (p.type !== "literal") map[p.type] = p.value;
  const asIso = `${map.year}-${map.month}-${map.day}T${map.hour}:${map.minute}:${map.second}Z`;
  const wallAsUtc = Date.parse(asIso);
  return wallAsUtc - Number(ts);
}
function nyWallMidnightToUtcMs(dayKey) {
  if (!dayKey) return null;
  const t0 = Date.parse(`${dayKey}T00:00:00Z`); // wall time interpreted as UTC
  if (!Number.isFinite(t0)) return null;
  let ts = t0;
  for (let i = 0; i < 3; i++) {
    const off = tzOffsetMs(ts, "America/New_York");
    const next = t0 - off;
    if (!Number.isFinite(next)) break;
    if (Math.abs(next - ts) < 1000) {
      ts = next;
      break;
    }
    ts = next;
  }
  return ts;
}

// Convert a NY wall-clock time (YYYY-MM-DD at HH:MM:SS) to a UTC ms timestamp.
// Uses the same fixed-point iteration as nyWallMidnightToUtcMs for DST correctness.
function nyWallTimeToUtcMs(dayKey, hh = 0, mm = 0, ss = 0) {
  if (!dayKey) return null;
  const H = String(Math.max(0, Math.min(23, Number(hh) || 0))).padStart(2, "0");
  const M = String(Math.max(0, Math.min(59, Number(mm) || 0))).padStart(2, "0");
  const S = String(Math.max(0, Math.min(59, Number(ss) || 0))).padStart(2, "0");
  const t0 = Date.parse(`${dayKey}T${H}:${M}:${S}Z`); // wall time interpreted as UTC
  if (!Number.isFinite(t0)) return null;
  let ts = t0;
  for (let i = 0; i < 3; i++) {
    const off = tzOffsetMs(ts, "America/New_York");
    const next = t0 - off;
    if (!Number.isFinite(next)) break;
    if (Math.abs(next - ts) < 1000) {
      ts = next;
      break;
    }
    ts = next;
  }
  return ts;
}

function prevTradingDayKey(dayKey) {
  if (!dayKey) return null;
  // Work with a stable noon UTC anchor so DST shifts don’t jump dates.
  let ms = Date.parse(`${dayKey}T12:00:00Z`);
  if (!Number.isFinite(ms)) return null;
  for (let i = 0; i < 10; i++) {
    ms -= 24 * 60 * 60 * 1000;
    const k = nyTradingDayKey(ms);
    if (!k) continue;
    if (!isNyWeekend(ms)) return k;
  }
  return null;
}

async function computePrevCloseFromTrail(db, ticker, asOfTs) {
  if (!db || !ticker) return null;
  const dayKey = nyTradingDayKey(asOfTs);
  const prevKey = prevTradingDayKey(dayKey);
  if (!prevKey) return null;
  // Watchlist semantics: previous close = prior trading day regular session close (4pm ET).
  const closeCutoff = nyWallTimeToUtcMs(prevKey, 16, 0, 0);
  if (!Number.isFinite(closeCutoff)) return null;
  const lookbackStart = closeCutoff - 14 * 24 * 60 * 60 * 1000;
  try {
    const row = await db
      .prepare(
        `SELECT price AS price, ts AS ts
         FROM timed_trail
         WHERE ticker = ?1 AND ts >= ?2 AND ts <= ?3 AND price IS NOT NULL
         ORDER BY ts DESC
         LIMIT 1`,
      )
      .bind(String(ticker).toUpperCase(), lookbackStart, closeCutoff + 1000)
      .first();
    const p = Number(row?.price);
    const ts = Number(row?.ts);
    if (!Number.isFinite(p) || p <= 0) return null;
    return { close: p, ts: Number.isFinite(ts) ? ts : null, dayKey: prevKey };
  } catch {
    return null;
  }
}

async function kvGetJSON(KV, key) {
  const t = await KV.get(key);
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

async function kvPutJSON(KV, key, val, ttlSec = null) {
  const opts = {};
  if (ttlSec && Number.isFinite(ttlSec) && ttlSec > 0)
    opts.expirationTtl = Math.floor(ttlSec);
  await KV.put(key, JSON.stringify(val), opts);
}

// Derive a minimal ticker context from common payload fields.
// This is a fallback for when Pine capture throttles `payload.context`.
function deriveTickerContext(obj) {
  const pickStr = (...vals) => {
    for (const v of vals) {
      if (typeof v === "string") {
        const s = v.trim();
        if (s) return s;
      }
    }
    return "";
  };

  const fundamentals = obj?.fundamentals && typeof obj.fundamentals === "object"
    ? obj.fundamentals
    : {};
  const profile =
    obj?.profile && typeof obj.profile === "object"
      ? obj.profile
      : obj?.company_profile && typeof obj.company_profile === "object"
        ? obj.company_profile
        : {};
  const meta = obj?.meta && typeof obj.meta === "object" ? obj.meta : {};

  const name = pickStr(
    obj?.name,
    obj?.company_name,
    fundamentals?.name,
    fundamentals?.longName,
    fundamentals?.shortName,
    profile?.name,
    meta?.name,
  );
  const description = pickStr(
    obj?.description,
    fundamentals?.description,
    fundamentals?.business_summary,
    fundamentals?.longBusinessSummary,
    profile?.description,
    profile?.summary,
  );
  const sector = pickStr(obj?.sector, fundamentals?.sector, profile?.sector);
  const industry = pickStr(
    obj?.industry,
    fundamentals?.industry,
    profile?.industry,
  );
  const website = pickStr(obj?.website, fundamentals?.website, profile?.website);

  const out = {};
  if (name) out.name = name;
  if (description) out.description = description;
  if (sector) out.sector = sector;
  if (industry) out.industry = industry;
  if (website) out.website = website;

  return Object.keys(out).length > 0 ? out : null;
}

function mergeTickerContext(existing, incoming) {
  const a =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? existing
      : null;
  const b =
    incoming && typeof incoming === "object" && !Array.isArray(incoming)
      ? incoming
      : null;
  if (!a && !b) return null;
  if (!a) return b;
  if (!b) return a;

  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (v == null) continue;
    if (typeof v === "string") {
      const s = v.trim();
      if (!s) continue;
      out[k] = s;
      continue;
    }
    out[k] = v;
  }
  return out;
}

function sanitizeTickerContext(ctx, hostObj = null) {
  if (!ctx || typeof ctx !== "object" || Array.isArray(ctx)) return null;
  const host = hostObj && typeof hostObj === "object" ? hostObj : null;

  const cleanStr = (s, fallback = "") => {
    if (s == null) return fallback;
    let v = String(s);
    // If something double-escaped upstream, normalize literal "\\r" sequences too.
    if (v.includes("\\r")) v = v.replace(/\\r/g, "r");
    // Some upstream strings contain a literal carriage return (\r) where "r" should be (seen in sector/name).
    // Prefer a known-good fallback when available; otherwise treat it as "r".
    if (v.includes("\r")) {
      if (fallback) return String(fallback);
      v = v.replace(/\r/g, "r");
    }
    return v.trim();
  };

  const out = { ...ctx };
  if (typeof out.name === "string") out.name = cleanStr(out.name, host?.name);
  if (typeof out.description === "string")
    out.description = cleanStr(out.description, host?.description);
  if (typeof out.sector === "string")
    out.sector = cleanStr(out.sector, host?.sector);
  if (typeof out.industry === "string")
    out.industry = cleanStr(out.industry, host?.industry);
  if (typeof out.country === "string")
    out.country = cleanStr(out.country, host?.country);

  // Nested string fields (keep objects but clean known strings).
  if (
    out.technical_rating &&
    typeof out.technical_rating === "object" &&
    !Array.isArray(out.technical_rating) &&
    typeof out.technical_rating.status === "string"
  ) {
    out.technical_rating = { ...out.technical_rating };
    out.technical_rating.status = cleanStr(out.technical_rating.status);
  }

  return out;
}

function numParam(url, key, fallback) {
  const v = url?.searchParams?.get(key);
  if (v == null || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// Retry KV write with verification (for critical operations like trade saving)
async function kvPutJSONWithRetry(KV, key, val, ttlSec = null, maxRetries = 3) {
  const opts = {};
  if (ttlSec && Number.isFinite(ttlSec) && ttlSec > 0)
    opts.expirationTtl = Math.floor(ttlSec);

  const valStr = JSON.stringify(val);
  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await KV.put(key, valStr, opts);

      // Verify the write succeeded (with small delay for KV consistency)
      await new Promise((resolve) => setTimeout(resolve, 50));
      const verify = await KV.get(key);

      if (verify && verify === valStr) {
        return { success: true, attempt };
      } else if (verify) {
        // Value exists but doesn't match - might be a race condition
        // Try parsing to see if it's equivalent JSON
        try {
          const verifyObj = JSON.parse(verify);
          const valObj = JSON.parse(valStr);
          // Deep comparison would be expensive, so just log and return success
          // The write succeeded, even if there was a concurrent update
          return {
            success: true,
            attempt,
            note: "verified (concurrent update possible)",
          };
        } catch {
          // Not JSON, retry
          lastError = new Error(
            `Verification failed: value mismatch on attempt ${attempt}`,
          );
        }
      } else {
        lastError = new Error(
          `Verification failed: value not found after write on attempt ${attempt}`,
        );
      }
    } catch (err) {
      lastError = err;
    }

    if (attempt < maxRetries) {
      // Exponential backoff: 50ms, 100ms, 200ms
      await new Promise((resolve) =>
        setTimeout(resolve, 50 * Math.pow(2, attempt - 1)),
      );
    }
  }

  return { success: false, error: lastError, attempts: maxRetries };
}

async function kvPutText(KV, key, text, ttlSec = null) {
  const opts = {};
  if (ttlSec && Number.isFinite(ttlSec) && ttlSec > 0)
    opts.expirationTtl = Math.floor(ttlSec);
  await KV.put(key, text, opts);
}

function stableHash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

// Rate limiting helper
async function checkRateLimit(
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
    // IMPORTANT: KV can occasionally stall; never block request handling.
    const count = await withTimeout(KV.get(key), 750);
    const current = count ? Number(count) : 0;

    if (current >= limit) {
      return {
        allowed: false,
        remaining: 0,
        resetAt: Date.now() + window * 1000,
      };
    }

    // Best-effort write; if it times out we still allow the request.
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
    // Fail-open: don't take down the UI if KV is slow.
    return {
      allowed: true,
      remaining: Math.max(0, limit - 1),
      resetAt: Date.now() + window * 1000,
    };
  }
}

// Fixed-window rate limiting helper (bucketed by window).
// Unlike checkRateLimit (sliding TTL), this naturally resets every window bucket.
async function checkRateLimitFixedWindow(
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

  // Ensure the key expires shortly after the bucket ends
  await KV.put(key, String(current + 1), { expirationTtl: window + 60 });
  return {
    allowed: true,
    remaining: limit - current - 1,
    resetAt,
    limit,
    key,
  };
}

async function ensureTickerIndex(KV, ticker) {
  try {
    const key = "timed:tickers";

    // Use retry logic to handle race conditions
    let retries = 3;
    let success = false;

    while (retries > 0 && !success) {
      const cur = (await kvGetJSON(KV, key)) || [];

      // Debug: Always log for BMNR/BABA/ETHT
      if (ticker === "BMNR" || ticker === "BABA" || ticker === "ETHT") {
        console.log(
          `[TICKER INDEX] ensureTickerIndex called for ${ticker} (retries: ${retries}):`,
          {
            alreadyInIndex: cur.includes(ticker),
            currentIndexSize: cur.length,
            indexSample: cur.slice(0, 10),
          },
        );
      }

      if (!cur.includes(ticker)) {
        cur.push(ticker);
        cur.sort();
        await kvPutJSON(KV, key, cur);

        // Verify it was added (with small delay to ensure KV consistency)
        await new Promise((resolve) => setTimeout(resolve, 50));
        const verify = (await kvGetJSON(KV, key)) || [];
        const wasAdded = verify.includes(ticker);

        if (wasAdded) {
          console.log(
            `[TICKER INDEX] Added ${ticker} to index. New count: ${cur.length}, Verified: ${wasAdded}`,
          );
          success = true;
        } else {
          // Retry if verification failed (possible race condition)
          console.warn(
            `[TICKER INDEX] ${ticker} verification failed, retrying... (retries left: ${
              retries - 1
            })`,
          );
          retries--;
          if (retries > 0) {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        }

        if (
          !wasAdded &&
          retries === 0 &&
          (ticker === "BMNR" || ticker === "BABA" || ticker === "ETHT")
        ) {
          console.error(
            `[TICKER INDEX ERROR] ${ticker} was NOT added to index after ${3} retries!`,
            {
              beforeAdd: cur.length,
              afterAdd: verify.length,
              tickerInVerify: verify.includes(ticker),
              verifySample: verify.slice(0, 10),
            },
          );
        }
      } else {
        // Already in index - success
        if (ticker === "BMNR" || ticker === "BABA" || ticker === "ETHT") {
          console.log(
            `[TICKER INDEX DEBUG] ${ticker} already in index (count: ${cur.length})`,
          );
        }
        success = true;
      }
    }
  } catch (err) {
    console.error(`[TICKER INDEX ERROR] Failed to ensure ${ticker} in index:`, {
      error: String(err),
      message: err.message,
      stack: err.stack,
    });
    // Don't throw - we don't want index failures to break ingestion
  }
}

function marketType(ticker) {
  const t = String(ticker || "").toUpperCase();
  if (t.endsWith("USDT") || t.endsWith("USD")) return "CRYPTO_24_7";
  if (t.endsWith("1!")) return "FUTURES_24_5";
  if (["DXY", "US500", "USOIL", "GOLD", "SILVER"].includes(t)) return "MACRO";
  return "EQUITY_RTH";
}

function getEasternParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const obj = {};
  for (const p of parts) obj[p.type] = p.value;
  return {
    weekday: obj.weekday || "",
    hour: Number(obj.hour || 0),
    minute: Number(obj.minute || 0),
  };
}

function isMarketHoursET(date = new Date()) {
  const { weekday, hour, minute } = getEasternParts(date);
  if (["Sat", "Sun"].includes(weekday)) return false;
  const mins = hour * 60 + minute;
  return mins >= 9 * 60 + 30 && mins <= 16 * 60;
}

function minutesSince(ts) {
  if (!ts || typeof ts !== "number") return null;
  return (Date.now() - ts) / 60000;
}

function formatUtcHourBucket(ts) {
  if (!Number.isFinite(ts)) return null;
  return new Date(ts).toISOString().slice(0, 13); // YYYY-MM-DDTHH (UTC)
}

function buildAlertDedupeKey({ ticker, action, side, ts }) {
  const t = String(ticker || "").toUpperCase();
  const act = String(action || "").toUpperCase();
  const dir = String(side || "").toUpperCase();
  const bucket = formatUtcHourBucket(ts);
  const day = bucket ? bucket.slice(0, 10) : null;
  if (!t || !act || !bucket) {
    return { key: null, bucket: null, day };
  }
  return {
    key: `timed:alerted:${t}:${act}:${dir || "UNKNOWN"}:${bucket}`,
    bucket,
    day,
  };
}

async function shouldSendTradeDiscordEvent(
  KV,
  { tradeId, type, ts },
  ttlSec = 48 * 60 * 60,
) {
  try {
    const id = String(tradeId || "").trim();
    const t = String(type || "")
      .trim()
      .toUpperCase();
    const ms = Number(ts);
    if (!id || !t || !Number.isFinite(ms)) {
      return { ok: true, key: null, deduped: false };
    }
    // Minute-bucketed idempotency. Prevents duplicate Discord posts caused by concurrent ingests/races.
    const bucket = Math.floor(ms / 60000);
    const key = `timed:dedupe:trade_event:${id}:${t}:${bucket}`;
    const already = await KV.get(key);
    if (already) return { ok: true, key, deduped: true };
    await kvPutText(KV, key, "1", ttlSec);
    return { ok: true, key, deduped: false };
  } catch (e) {
    // Fail open: better to alert than silently drop.
    return {
      ok: false,
      key: null,
      deduped: false,
      error: String(e?.message || e),
    };
  }
}

function stalenessBucket(ticker, ts) {
  const mt = marketType(ticker);
  const age = minutesSince(ts);
  if (age == null) return { mt, bucket: "UNKNOWN", ageMin: null };

  const warn = mt === "EQUITY_RTH" ? 120 : mt === "FUTURES_24_5" ? 60 : 30;
  const stale = mt === "EQUITY_RTH" ? 480 : mt === "FUTURES_24_5" ? 180 : 120;

  if (age <= warn) return { mt, bucket: "FRESH", ageMin: age };
  if (age <= stale) return { mt, bucket: "AGING", ageMin: age };
  return { mt, bucket: "STALE", ageMin: age };
}

function computeRR(d) {
  // RR should be based on the "entry reference" (trigger price when available),
  // otherwise it looks artificially better/worse after a move has already run.
  const price = Number(d.price);
  const entryRefRaw = Number(d.trigger_price);
  const entryRef =
    Number.isFinite(entryRefRaw) && entryRefRaw > 0 ? entryRefRaw : price;
  const sl = Number(d.sl);
  if (!Number.isFinite(entryRef) || !Number.isFinite(sl)) return null;

  // Use MAX TP from tp_levels if available, otherwise fall back to first TP
  let tp = Number(d.tp_max_price);
  if (!Number.isFinite(tp)) tp = Number(d.tp_target_price);
  if (!Number.isFinite(tp)) tp = Number(d.tp);
  if (d.tp_levels && Array.isArray(d.tp_levels) && d.tp_levels.length > 0) {
    // Extract prices from tp_levels (handle both object and number formats)
    const tpPrices = d.tp_levels
      .map((tpItem) => {
        if (
          typeof tpItem === "object" &&
          tpItem !== null &&
          tpItem.price != null
        ) {
          return Number(tpItem.price);
        }
        return typeof tpItem === "number" ? Number(tpItem) : Number(tpItem);
      })
      .filter((p) => Number.isFinite(p));

    if (tpPrices.length > 0) {
      // Use maximum TP for LONG, minimum for SHORT
      const state = String(d.state || "");
      const isLong = state.includes("BULL");
      const isShort = state.includes("BEAR");
      tp = isShort ? Math.min(...tpPrices) : Math.max(...tpPrices);
    }
  }

  if (!Number.isFinite(tp)) return null;

  // Determine direction from state to calculate risk/reward correctly
  const state = String(d.state || "");
  const isLong = state.includes("BULL");
  const isShort = state.includes("BEAR");

  let risk, gain;

  if (isLong) {
    // For LONG: SL should be below entryRef, TP should be above entryRef
    risk = entryRef - sl;
    gain = tp - entryRef;
  } else if (isShort) {
    // For SHORT: SL should be above entryRef, TP should be below entryRef
    risk = sl - entryRef;
    gain = entryRef - tp;
  } else {
    // Fallback to absolute values if direction unclear
    risk = Math.abs(entryRef - sl);
    gain = Math.abs(tp - entryRef);
  }

  // Ensure both risk and gain are positive
  if (risk <= 0 || gain <= 0) return null;
  return gain / risk;
}

// Helper function: completionForSize (normalize completion to 0-1)
// NOTE: Pine computes completion, but we keep a worker-side fallback for safety.
function completionForSize(ticker) {
  const c = Number(ticker?.completion);
  if (Number.isFinite(c)) return Math.max(0, Math.min(1, c));

  const price = Number(ticker?.price);
  const triggerPrice = Number(ticker?.trigger_price);
  const tp = Number(ticker?.tp);
  if (
    !Number.isFinite(price) ||
    !Number.isFinite(triggerPrice) ||
    !Number.isFinite(tp)
  )
    return 0;

  const denom = Math.abs(tp - triggerPrice);
  if (!(denom > 0)) return 0;

  const raw = Math.abs(price - triggerPrice) / denom;
  return Math.max(0, Math.min(1, raw));
}

function computeTpMaxFromLevels(ticker) {
  const tpMaxRaw = Number(ticker?.tp_max_price);
  if (Number.isFinite(tpMaxRaw) && tpMaxRaw > 0) return tpMaxRaw;
  const tpLevels = Array.isArray(ticker?.tp_levels) ? ticker.tp_levels : [];
  const tpPrices = tpLevels
    .map((tpItem) => {
      if (
        typeof tpItem === "object" &&
        tpItem !== null &&
        tpItem.price != null
      ) {
        return Number(tpItem.price);
      }
      return typeof tpItem === "number" ? Number(tpItem) : Number(tpItem);
    })
    .filter((p) => Number.isFinite(p));
  if (tpPrices.length === 0) return null;
  const state = String(ticker?.state || "");
  const isLong = state.includes("BULL");
  const isShort = state.includes("BEAR");
  return isShort ? Math.min(...tpPrices) : Math.max(...tpPrices);
}

function computeCompletionToTpMax(ticker) {
  const price = Number(ticker?.price);
  const triggerPrice = Number(ticker?.trigger_price);
  const tpMax = computeTpMaxFromLevels(ticker);
  if (
    !Number.isFinite(price) ||
    !Number.isFinite(triggerPrice) ||
    !Number.isFinite(tpMax)
  )
    return null;
  const denom = Math.abs(tpMax - triggerPrice);
  if (!(denom > 0)) return null;
  const raw = Math.abs(price - triggerPrice) / denom;
  return Math.max(0, Math.min(1, raw));
}

function computeRRWith(entryRef, slRef, tpRef, state) {
  const e = Number(entryRef);
  const sl = Number(slRef);
  const tp = Number(tpRef);
  if (!Number.isFinite(e) || !Number.isFinite(sl) || !Number.isFinite(tp))
    return null;

  const s = String(state || "");
  const isLong = s.includes("BULL");
  const isShort = s.includes("BEAR");

  let risk, gain;
  if (isLong) {
    risk = e - sl;
    gain = tp - e;
  } else if (isShort) {
    risk = sl - e;
    gain = e - tp;
  } else {
    risk = Math.abs(e - sl);
    gain = Math.abs(tp - e);
  }
  if (!(risk > 0) || !(gain > 0)) return null;
  return gain / risk;
}

function computeDynamicStopBreakeven(ticker) {
  const state = String(ticker?.state || "");
  const isLong = state.includes("BULL");
  const isShort = state.includes("BEAR");
  const sl = Number(ticker?.sl);
  const trig = Number(ticker?.trigger_price);
  if (!Number.isFinite(sl) || sl <= 0) return null;
  if (!Number.isFinite(trig) || trig <= 0) return sl;
  if (isShort) return Math.min(sl, trig);
  if (isLong) return Math.max(sl, trig);
  return sl;
}

function computeRRTargets(ticker) {
  const state = String(ticker?.state || "");
  const price = Number(ticker?.price);
  const triggerPrice = Number(ticker?.trigger_price);
  const sl = Number(ticker?.sl);
  const tpLikely =
    Number(ticker?.tp_target_price) ||
    Number(ticker?.tp_target) ||
    Number(ticker?.tp_target_price);
  const tpRef = Number.isFinite(tpLikely) && tpLikely > 0 ? tpLikely : null;
  if (!tpRef || !Number.isFinite(sl) || sl <= 0) return null;

  const entryRef =
    Number.isFinite(triggerPrice) && triggerPrice > 0 ? triggerPrice : null;
  const rrEntryLikely = entryRef
    ? computeRRWith(entryRef, sl, tpRef, state)
    : null;

  const dynStop = computeDynamicStopBreakeven(ticker);
  const rrNowLikely =
    Number.isFinite(price) && Number.isFinite(dynStop)
      ? computeRRWith(price, dynStop, tpRef, state)
      : null;

  return {
    tp_likely: tpRef,
    sl_dynamic: Number.isFinite(dynStop) ? dynStop : null,
    rr_entry_likely: Number.isFinite(rrEntryLikely) ? rrEntryLikely : null,
    rr_now_likely: Number.isFinite(rrNowLikely) ? rrNowLikely : null,
  };
}

function computeDataCompleteness(tickerData) {
  const hasTfTech = !!(
    tickerData?.tf_tech && typeof tickerData.tf_tech === "object"
  );
  const hasTriggersField = "triggers" in (tickerData || {});
  const triggersNonEmpty =
    Array.isArray(tickerData?.triggers) &&
    tickerData.triggers.some((t) => typeof t === "string" && t.trim());
  const hasTpLevels =
    Array.isArray(tickerData?.tp_levels) && tickerData.tp_levels.length > 0;
  const hasDailyEma = !!tickerData?.daily_ema_cloud;
  const hasIchD = !!tickerData?.ichimoku_d;
  const hasIchW = !!tickerData?.ichimoku_w;

  const missing = [];
  if (!hasTfTech) missing.push("tf_tech");
  if (!hasTriggersField) missing.push("triggers_field");
  if (!hasTpLevels) missing.push("tp_levels");
  if (!hasDailyEma) missing.push("daily_ema_cloud");
  if (!hasIchD) missing.push("ichimoku_d");
  if (!hasIchW) missing.push("ichimoku_w");

  // Score is intentionally simple + stable for UI filters.
  // 100 = fully instrumented, lower scores indicate missing context.
  let score = 100;
  if (!hasTfTech) score -= 35;
  if (!hasTriggersField) score -= 5;
  if (!hasTpLevels) score -= 10;
  if (!hasDailyEma) score -= 10;
  if (!hasIchD) score -= 15;
  if (!hasIchW) score -= 10;
  score = Math.max(0, Math.min(100, score));

  return {
    score,
    missing,
    has_tf_tech: hasTfTech,
    has_triggers_field: hasTriggersField,
    triggers_non_empty: triggersNonEmpty,
    has_tp_levels: hasTpLevels,
    has_daily_ema_cloud: hasDailyEma,
    has_ichimoku_d: hasIchD,
    has_ichimoku_w: hasIchW,
  };
}

function tfTechAlignmentSummary(tickerData) {
  const tfTech = tickerData?.tf_tech;
  if (!tfTech || typeof tfTech !== "object") return null;

  const side = sideFromStateOrScores(tickerData); // LONG | SHORT | null
  if (!side) return null;

  const TF_ORDER = ["W", "D", "4H", "1H", "30", "10"];
  const WEIGHTS = { W: 2.0, D: 2.0, "4H": 1.5, "1H": 1.5, 30: 1.0, 10: 1.0 };

  let alignedW = 0;
  let opposedW = 0;
  let presentW = 0;
  const stacks = {};

  for (const k of TF_ORDER) {
    const row = tfTech[k];
    const stack = Number(row?.ema?.stack);
    if (!Number.isFinite(stack)) continue;
    presentW += WEIGHTS[k] || 1.0;
    stacks[k] = stack;
    const isAligned = side === "LONG" ? stack >= 4 : stack <= -4;
    const isOpposed = side === "LONG" ? stack <= -4 : stack >= 4;
    if (isAligned) alignedW += WEIGHTS[k] || 1.0;
    if (isOpposed) opposedW += WEIGHTS[k] || 1.0;
  }

  // Convert to a bounded score contribution:
  // - strong alignment across TFs => +0..+10
  // - strong opposition => down to -8
  const raw = alignedW - opposedW;
  const score = Math.max(-8, Math.min(10, raw * 2));

  const sq30 = tfTech["30"]?.sq;
  const sq10 = tfTech["10"]?.sq;
  const squeezeOn = !!(sq30?.s === 1 || sq10?.s === 1);
  const squeezeRel = !!(sq30?.r === 1 || sq10?.r === 1);

  return {
    score,
    side,
    aligned_weight: Math.round(alignedW * 10) / 10,
    opposed_weight: Math.round(opposedW * 10) / 10,
    present_weight: Math.round(presentW * 10) / 10,
    squeeze_on: squeezeOn,
    squeeze_release: squeezeRel,
    stacks,
  };
}

function triggerSummaryAndScore(tickerData) {
  const side = sideFromStateOrScores(tickerData); // LONG | SHORT | null
  const list = Array.isArray(tickerData?.triggers)
    ? tickerData.triggers
        .filter((t) => typeof t === "string" && t.trim())
        .map((t) => t.trim())
    : [];

  const uniq = Array.from(new Set(list));
  let score = 0;

  const has = (s) => uniq.includes(s);
  const matchSide = (bull, bear) => {
    if (!side) return 0;
    if (side === "LONG" && has(bull)) return 1;
    if (side === "SHORT" && has(bear)) return 1;
    if (side === "LONG" && has(bear)) return -1;
    if (side === "SHORT" && has(bull)) return -1;
    return 0;
  };

  if (has("SQUEEZE_RELEASE_30M")) score += 6;
  score += 6 * matchSide("EMA_CROSS_1H_13_48_BULL", "EMA_CROSS_1H_13_48_BEAR");
  score +=
    2 * matchSide("EMA_CROSS_30M_13_48_BULL", "EMA_CROSS_30M_13_48_BEAR");
  if (has("ST_FLIP_1H")) score += 1;
  if (has("ST_FLIP_30M")) score += 1;
  score +=
    7 * matchSide("BUYABLE_DIP_1H_13_48_LONG", "BUYABLE_DIP_1H_13_48_SHORT");

  // Fallback for legacy payloads without triggers[] populated
  const flags = tickerData?.flags || {};
  if (uniq.length === 0) {
    if (flags.sq30_release) score += 4;
    if (flags.ema_cross_1h_13_48) score += 5;
    if (flags.buyable_dip_1h_13_48) score += 7;
  }

  score = Math.max(-6, Math.min(18, score));

  return {
    score,
    side,
    count: uniq.length,
    top: uniq.slice(0, 5),
  };
}

function triggerReasonCorroboration(tickerData) {
  const rawReason =
    tickerData?.trigger_reason != null
      ? String(tickerData.trigger_reason).trim()
      : "";
  const rawDir =
    tickerData?.trigger_dir != null
      ? String(tickerData.trigger_dir).trim()
      : "";
  if (!rawReason) return { corroborated: true, note: "" };

  const triggers = Array.isArray(tickerData?.triggers)
    ? tickerData.triggers
        .filter((t) => typeof t === "string" && t.trim())
        .map((t) => t.trim())
    : [];
  const flags =
    tickerData?.flags && typeof tickerData.flags === "object"
      ? tickerData.flags
      : {};

  const hasAny = (...xs) => xs.some((x) => triggers.includes(x));

  // Only guard the noisy categories that can "stick" on HTF series.
  if (rawReason === "EMA_CROSS_1H_13_48") {
    const ok =
      hasAny("EMA_CROSS_1H_13_48_BULL", "EMA_CROSS_1H_13_48_BEAR") ||
      !!flags.ema_cross_1h_13_48;
    return {
      corroborated: ok,
      note: ok
        ? ""
        : `uncorroborated ${rawReason}${rawDir ? " (" + rawDir + ")" : ""}`,
    };
  }
  if (rawReason === "EMA_CROSS_30M_13_48") {
    const ok =
      hasAny("EMA_CROSS_30M_13_48_BULL", "EMA_CROSS_30M_13_48_BEAR") ||
      !!flags.ema_cross_30m_13_48;
    return {
      corroborated: ok,
      note: ok
        ? ""
        : `uncorroborated ${rawReason}${rawDir ? " (" + rawDir + ")" : ""}`,
    };
  }

  return { corroborated: true, note: "" };
}

/**
 * Detect "Flip Watch" - tickers about to transition from PULLBACK to momentum
 * Based on analysis of top movers: 76% flipped from PULLBACK to momentum within 6h
 * Common traits: Low completion (<15%), Early phase (<35%), Strong HTF, In/near corridor
 */
function detectFlipWatch(tickerData, trail = []) {
  const state = String(tickerData?.state || "");
  const htfScore = Number(tickerData?.htf_score);
  const ltfScore = Number(tickerData?.ltf_score);
  const completion = Number(tickerData?.completion);
  const phase = Number(tickerData?.phase_pct);
  const flags = tickerData?.flags || {};

  // Must be in PULLBACK state (setup quadrant)
  const inPullback =
    state === "HTF_BULL_LTF_PULLBACK" || state === "HTF_BEAR_LTF_PULLBACK";
  if (!inPullback) return null;

  const isBullSetup = state === "HTF_BULL_LTF_PULLBACK";
  const isBearSetup = state === "HTF_BEAR_LTF_PULLBACK";

  // Check corridor status
  const inCorridor = (() => {
    if (!Number.isFinite(htfScore) || !Number.isFinite(ltfScore)) return false;
    if (isBullSetup) {
      return htfScore > 0 && ltfScore >= -10 && ltfScore <= 0;
    } else if (isBearSetup) {
      return htfScore < 0 && ltfScore >= 0 && ltfScore <= 10;
    }
    return false;
  })();

  const nearCorridor = (() => {
    if (inCorridor) return false; // already in, not "near"
    if (!Number.isFinite(htfScore) || !Number.isFinite(ltfScore)) return false;
    if (isBullSetup) {
      // Near corridor: HTF positive, LTF slightly below corridor (-15 to -10)
      return htfScore > 0 && ltfScore >= -15 && ltfScore < -10;
    } else if (isBearSetup) {
      // Near corridor: HTF negative, LTF slightly above corridor (10 to 15)
      return htfScore < 0 && ltfScore > 10 && ltfScore <= 15;
    }
    return false;
  })();

  // Score components (0-100 scale)
  const reasons = [];
  let score = 0;

  // 1. Corridor status (30 points)
  if (inCorridor) {
    score += 30;
    reasons.push("In corridor");
  } else if (nearCorridor) {
    score += 20;
    reasons.push("Near corridor");
  }

  // 2. HTF strength (20 points) - Strong HTF indicates trend support
  const htfStrength = Math.abs(htfScore);
  if (htfStrength >= 20) {
    score += 20;
    reasons.push(`Strong HTF (${htfScore.toFixed(1)})`);
  } else if (htfStrength >= 15) {
    score += 15;
    reasons.push(`Moderate HTF (${htfScore.toFixed(1)})`);
  } else if (htfStrength >= 10) {
    score += 10;
    reasons.push(`Weak HTF (${htfScore.toFixed(1)})`);
  }

  // 3. Low completion (20 points) - 64% of winners had completion <15%
  if (Number.isFinite(completion)) {
    if (completion < 0.15) {
      score += 20;
      reasons.push(`Very low completion (${Math.round(completion * 100)}%)`);
    } else if (completion < 0.25) {
      score += 15;
      reasons.push(`Low completion (${Math.round(completion * 100)}%)`);
    } else if (completion < 0.35) {
      score += 10;
      reasons.push(`Moderate completion (${Math.round(completion * 100)}%)`);
    }
  }

  // 4. Early phase (15 points) - 52% of winners had phase <35%
  if (Number.isFinite(phase)) {
    if (phase < 0.35) {
      score += 15;
      reasons.push(`Early phase (${Math.round(phase * 100)}%)`);
    } else if (phase < 0.5) {
      score += 10;
      reasons.push(`Mid phase (${Math.round(phase * 100)}%)`);
    }
  }

  // 5. Squeeze signals (15 points) - 40% had sq30_on, 32% had sq30_release
  if (flags.sq30_release) {
    score += 15;
    reasons.push("Squeeze released");
  } else if (flags.sq30_on) {
    score += 10;
    reasons.push("Squeeze building");
  }

  // 6. HTF improving (bonus 10 points) - momentum building
  if (flags.htf_improving_4h) {
    score += 10;
    reasons.push("HTF improving");
  }

  // 7. LTF approaching flip zone (bonus) - LTF moving toward zero
  if (Number.isFinite(ltfScore)) {
    const ltfAbs = Math.abs(ltfScore);
    if (ltfAbs <= 5) {
      score += 5;
      reasons.push("LTF near flip zone");
    }
  }

  // 8. Check recent trail for momentum building (if available)
  if (Array.isArray(trail) && trail.length >= 2) {
    // Look at last 6 points (~30 minutes at 5m cadence)
    const recent = trail.slice(-6);
    const htfScores = recent
      .map((p) => Number(p?.htf_score))
      .filter(Number.isFinite);
    const ltfScores = recent
      .map((p) => Number(p?.ltf_score))
      .filter(Number.isFinite);

    if (htfScores.length >= 3) {
      // Check if HTF is strengthening
      const htfLast = htfScores[htfScores.length - 1];
      const htfFirst = htfScores[0];
      const htfImproving = isBullSetup
        ? htfLast > htfFirst
        : htfLast < htfFirst;
      if (htfImproving) {
        score += 5;
        reasons.push("HTF strengthening");
      }
    }

    if (ltfScores.length >= 3) {
      // Check if LTF is moving toward momentum zone
      const ltfLast = ltfScores[ltfScores.length - 1];
      const ltfFirst = ltfScores[0];
      const ltfMovingToMomentum = isBullSetup
        ? ltfLast > ltfFirst
        : ltfLast < ltfFirst;
      if (ltfMovingToMomentum) {
        score += 5;
        reasons.push("LTF moving to momentum");
      }
    }
  }

  // Require minimum score of 50 to flag as flip watch
  if (score < 50) return null;

  return {
    score,
    reasons,
    state,
    htf_score: htfScore,
    ltf_score: ltfScore,
    completion,
    phase,
    in_corridor: inCorridor,
    near_corridor: nearCorridor,
  };
}

/** 8 Kanban lanes (Worker = source of truth):
 *  watch, setup_watch | flip_watch, just_flipped | enter_now | just_entered | hold | trim | exit | archive
 *  UI maps: Watching | Almost Ready | Enter Now | Just Entered | Hold | Trim | Exit | Archived
 */
function classifyKanbanStage(tickerData) {
  const state = String(tickerData?.state || "");
  const flags = tickerData?.flags || {};
  const moveStatus = computeMoveStatus(tickerData);
  const completion = Number(tickerData?.completion) || 0;
  const phase = Number(tickerData?.phase_pct) || 0;
  const isMomentum =
    state === "HTF_BULL_LTF_BULL" || state === "HTF_BEAR_LTF_BEAR";
  const seq = tickerData?.seq || {};
  const isActive = moveStatus?.status === "ACTIVE";
  const htfScore = Number(tickerData?.htf_score) || 0;
  const ltfScore = Number(tickerData?.ltf_score) || 0;
  const score = Number(tickerData?.score ?? tickerData?.rank) ?? 0;
  const position = Number(tickerData?.position ?? tickerData?.rank_position) || 0;
  const ed = tickerData?.entry_decision || null;
  const edAction = String(ed?.action || "").toUpperCase();
  const edOk = ed?.ok === true;

  // Terminal/administrative stages -> ARCHIVE
  const hasMoveStatus = moveStatus?.status && moveStatus.status !== "NONE";
  if (
    hasMoveStatus &&
    (moveStatus?.status === "INVALIDATED" || moveStatus?.status === "COMPLETED")
  )
    return "archive";

  // For open positions, use move invalidation signals to determine exit/trim
  if (hasMoveStatus && isActive) {
    // Stage 6: Exit - position invalidated or critical issues
    const reasons = moveStatus?.reasons || [];
    const severity = moveStatus?.severity || "NONE";
    if (
      severity === "CRITICAL" || 
      reasons.includes("left_entry_corridor") ||
      reasons.includes("large_adverse_move") ||
      reasons.includes("sl_breached")
    ) {
      return "exit";
    }

    // Stage 5: Trim - take profits when signs of exhaustion appear
    // Tightened from 70% to 60% completion for earlier profit-taking
    if (
      completion >= 0.6 || 
      (phase >= 0.65 && severity === "WARNING") ||
      reasons.includes("adverse_move_warning")
    ) {
      return "trim";
    }

    // Stage 4.5: Defend - fold into Hold (UI shows Defend badge via deriveKanbanMeta)
    if (severity === "WARNING" && completion < 0.6 && phase < 0.65) {
      return "hold";
    }

    // Stage 4.1: Just Entered - recently entered (within 15 min)
    const entryTsRaw = Number(tickerData?.entry_ts ?? tickerData?.kanban_cycle_enter_now_ts);
    const curTs = Number(tickerData?.ts ?? tickerData?.ingest_ts ?? Date.now());
    if (Number.isFinite(entryTsRaw) && entryTsRaw > 0 && Number.isFinite(curTs)) {
      const entryMs = entryTsRaw < 1e12 ? entryTsRaw * 1000 : entryTsRaw;
      const ageMs = curTs - entryMs;
      if (ageMs >= 0 && ageMs < 15 * 60 * 1000) return "just_entered";
    }

    // Stage 4: Hold - all other open positions
    return "hold";
  }

  // For non-position tickers, determine if they're entry opportunities

  // Stage 1: Flip Watch - about to transition
  if (flags.flip_watch) {
    const ent = entryType(tickerData);
    const inCorridor = !!ent?.corridor;
    // Allow enter_now when flip_watch + corridor + strong score (catch move as it starts)
    if (inCorridor && (score >= 70 || ((flags.thesis_match || flags.momentum_elite) && score >= 60))) {
      return "enter_now";
    }
    return "flip_watch";
  }

  // Stage 2: Just Flipped - recently entered momentum; can qualify for Enter Now
  if (isMomentum && seq.corridorEntry_60m === true) {
    // Fall through to Enter Now paths below; only return just_flipped if we don't qualify
  }

  // Stage 3: Enter Now - high-confidence entry opportunities
  // Must be in momentum (or just_flipped) and meet quality thresholds
  if (isMomentum) {
    // Hard gate: never show ENTER_NOW if the entry decision is explicitly blocked.
    if (edAction === "ENTRY" && !edOk) return "watch";

    const ent = entryType(tickerData);
    const inCorridor = !!ent?.corridor;
    const htfAbs = Math.abs(htfScore);
    const ltfAbs = Math.abs(ltfScore);
    const ema1H1348 = !!flags.ema_cross_1h_13_48;
    const buyableDip1H = !!flags.buyable_dip_1h_13_48;

    // Path 1: Top tier + corridor (never score alone)
    if ((score >= 75 || (position > 0 && position <= 20)) && inCorridor)
      return "enter_now";

    // Path 2: Thesis / Momentum Elite (with score gate)
    if ((flags.thesis_match || flags.momentum_elite) && score >= 60)
      return "enter_now";

    // Path 3: Strong HTF/LTF
    if (htfAbs >= 40 && ltfAbs >= 20 && score >= 70)
      return "enter_now";

    // Path 4: Corridor + Squeeze
    if (inCorridor && flags.sq30_release && score >= 70)
      return "enter_now";

    // Path 5: 1H 13/48 EMA Cross — pivot change + pullback opportunity
    if (inCorridor && (ema1H1348 || buyableDip1H) && score >= 68)
      return "enter_now";

    // Watch: Momentum-aligned, but ENTRY is blocked (meaningful "next-up" lane)
    const ed = tickerData?.entry_decision;
    const action = String(ed?.action || "").toUpperCase();
    const ok = ed?.ok === true;
    const blockers = Array.isArray(ed?.blockers) ? ed.blockers : [];
    const hasMeaningfulBlocker =
      blockers.includes("not_in_corridor") ||
      blockers.includes("rank_below_min") ||
      blockers.includes("completion_high") ||
      blockers.includes("phase_high") ||
      blockers.includes("no_trigger") ||
      blockers.includes("no_fresh_pullback");
    if (action === "ENTRY" && !ok && hasMeaningfulBlocker) {
      return "watch";
    }
  }

  // Late-cycle: overextended / high phase but NOT in momentum.
  // This avoids pulling names like AAPL out of Watch when they're still momentum-aligned.
  const phaseZone = String(tickerData?.phase_zone || "").toUpperCase();
  const isLate =
    phaseZone === "HIGH" ||
    phaseZone === "EXTREME" ||
    phase >= 0.7 ||
    completion >= 0.95;
  if (!isMomentum && isLate) {
    return "archive";
  }

  // Setup + squeeze release + corridor: enter on squeeze release from setup (catch move early)
  const ent = entryType(tickerData);
  if (!isMomentum && !!ent?.corridor && flags.sq30_release && score >= 70) {
    return "enter_now";
  }

  // Setup-state tickers in corridor (not yet momentum, not late-cycle)
  if (!isMomentum && !!ent?.corridor) {
    return "setup_watch";
  }

  // Catch-all: tickers with valid data but no lane (momentum outside corridor, missing htf/ltf, etc.)
  // Show in Watching so they don't disappear from the board (e.g. BE, overextended momentum names)
  const hasValidData =
    state &&
    Number.isFinite(Number(tickerData?.price)) &&
    String(tickerData?.ticker || "").trim();
  if (hasValidData && !isLate) {
    return "watch";
  }

  // Default: no stage (not in trading pipeline)
  return null;
}

function deriveKanbanMeta(tickerData, stage) {
  const ms = tickerData?.move_status || computeMoveStatus(tickerData);
  const completion = Number(tickerData?.completion) || 0;
  const phase = Number(tickerData?.phase_pct) || 0;
  const phaseZone = String(tickerData?.phase_zone || "").toUpperCase();
  const isLate =
    phaseZone === "HIGH" ||
    phaseZone === "EXTREME" ||
    phase >= 0.7 ||
    completion >= 0.95;
  const state = String(tickerData?.state || "");
  const isMomentum =
    state === "HTF_BULL_LTF_BULL" || state === "HTF_BEAR_LTF_BEAR";

  // Hold + warning conditions = Defend (UI shows badge)
  if (stage === "hold") {
    const severity = String(ms?.severity || "").toUpperCase();
    if (severity === "WARNING" && completion < 0.6 && phase < 0.65) {
      return { bucket: "defend", emoji: "🛡", reason: "warning", reasons: ms?.reasons || [] };
    }
    return null;
  }

  // Archive meta
  if (stage !== "archive") return null;

  if (ms?.status === "INVALIDATED") {
    const reasons = Array.isArray(ms?.reasons) ? ms.reasons : [];
    return {
      bucket: "invalidated",
      emoji: "⛔",
      reason: reasons[0] || "invalidated",
      reasons,
    };
  }
  if (ms?.status === "COMPLETED") {
    const reasons = Array.isArray(ms?.reasons) ? ms.reasons : [];
    return {
      bucket: "completed",
      emoji: "✅",
      reason: reasons[0] || "completed",
      reasons,
    };
  }
  if (!isMomentum && isLate) {
    const why =
      completion >= 0.95
        ? "completion_high"
        : phase >= 0.7
          ? "phase_high"
          : phaseZone
            ? `phase_${phaseZone.toLowerCase()}`
            : "late_cycle";
    return { bucket: "late_cycle", emoji: "🌙", reason: why, reasons: [why] };
  }
  return {
    bucket: "archive",
    emoji: "🗂",
    reason: "archived",
    reasons: ["archived"],
  };
}

function computeMoveStatus(tickerData) {
  const side = sideFromStateOrScores(tickerData); // LONG | SHORT | null
  const flags = tickerData?.flags || {};
  const momentumElite = !!flags.momentum_elite;

  const price = Number(tickerData?.price);
  const sl = Number(tickerData?.sl);
  const tp = computeTpMaxFromLevels(tickerData) ?? Number(tickerData?.tp);
  const triggerTsRaw = Number(tickerData?.trigger_ts);
  const entryTsRaw = Number(
    tickerData?.entry_ts ?? tickerData?.kanban_cycle_enter_now_ts,
  );
  const entryPriceRaw = Number(tickerData?.entry_price);
  let triggerTs = triggerTsRaw;
  const curTs = Number(tickerData?.ts ?? tickerData?.ingest_ts ?? Date.now());

  const reasons = [];

  // If we can't infer direction, don't mark invalidated.
  if (!side) {
    return {
      status: "ACTIVE",
      side: null,
      severity: "NONE",
      reasons: [],
    };
  }

  // Only consider a "move" ACTIVE once we've actually entered the cycle.
  // ENTER_NOW stamps entry_ts/entry_price (or cycle enter ts), which is our proxy for “we took it”.
  // Without this, tickers can incorrectly show HOLD/DEFEND/TRIM/EXIT just because they have a trigger_ts.
  const hasEntered = Number.isFinite(entryTsRaw) && entryTsRaw > 0;
  if (!hasEntered) {
    return {
      status: "NONE",
      side,
      severity: "NONE",
      reasons: [],
    };
  }

  // If we don't have a trigger timestamp, this isn't an active "move" yet.
  // This prevents labeling the entire universe as ACTIVE/HOLD/TRIM/EXIT.
  if (!Number.isFinite(triggerTs) || triggerTs <= 0) {
    // Back-compat: if the user has acted (ENTER_NOW stamps entry_ts/entry_price),
    // we still need move-status logic even if trigger_ts is missing.
    if (Number.isFinite(entryTsRaw) && entryTsRaw > 0) {
      triggerTs = entryTsRaw;
    } else {
      return {
        status: "NONE",
        side,
        severity: "NONE",
        reasons: [],
      };
    }
  }

  // If the trigger is stale, don't keep the ticker stuck in "move" lanes forever.
  // This is especially important when the market is closed and many names won't ingest frequently.
  // Treat old triggers as no active move so opportunity lanes (Flip Watch / Enter Now) can surface.
  if (Number.isFinite(curTs) && curTs > 0) {
    const ageMs = curTs - triggerTs;
    const STALE_TRIGGER_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
    if (Number.isFinite(ageMs) && ageMs > STALE_TRIGGER_MS) {
      const entryAgeMs =
        Number.isFinite(entryTsRaw) && entryTsRaw > 0 ? curTs - entryTsRaw : null;
      const entryFresh =
        entryAgeMs != null &&
        Number.isFinite(entryAgeMs) &&
        entryAgeMs >= 0 &&
        entryAgeMs <= STALE_TRIGGER_MS;
      if (entryFresh) {
        triggerTs = entryTsRaw;
      } else {
        return {
          status: "NONE",
          side,
          severity: "NONE",
          reasons: [],
        };
      }
    }
  }

  // Soft invalidation: breached trigger/entry anchor (clear “get out” signal even before SL).
  // This avoids cases like AGQ: ENTER_NOW → large adverse move → no EXIT lane until SL.
  const anchorPrice = (() => {
    const trigPx = Number(tickerData?.trigger_price);
    if (Number.isFinite(trigPx) && trigPx > 0) return trigPx;
    if (Number.isFinite(entryPriceRaw) && entryPriceRaw > 0) return entryPriceRaw;
    return null;
  })();
  if (Number.isFinite(price) && Number.isFinite(anchorPrice) && anchorPrice > 0) {
    if (side === "LONG" && price < anchorPrice) reasons.push("below_trigger");
    if (side === "SHORT" && price > anchorPrice) reasons.push("above_trigger");
    const pctMove = Math.abs((price - anchorPrice) / anchorPrice);
    if (
      (reasons.includes("below_trigger") || reasons.includes("above_trigger")) &&
      Number.isFinite(pctMove) &&
      pctMove >= 0.05
    ) {
      reasons.push("trigger_breached_5pct");
    }
  }

  // Hard invalidation: SL breach
  if (Number.isFinite(price) && Number.isFinite(sl) && sl > 0) {
    if (side === "LONG" && price <= sl) reasons.push("sl_breached");
    if (side === "SHORT" && price >= sl) reasons.push("sl_breached");
  }

  // Completion: TP reached/exceeded (move is "done" from entry standpoint)
  if (Number.isFinite(price) && Number.isFinite(tp) && tp > 0) {
    if (side === "LONG" && price >= tp) reasons.push("tp_reached");
    if (side === "SHORT" && price <= tp) reasons.push("tp_reached");
  }

  // Regime breaks: HTF structure disagrees with direction
  if (!dailyEmaRegimeOk(tickerData, side))
    reasons.push("daily_ema_regime_break");
  if (!ichimokuRegimeOk(tickerData, side))
    reasons.push("ichimoku_regime_break");

  // Late-cycle: disqualifier unless Momentum Elite
  if (isLateCycle(tickerData) && !momentumElite) reasons.push("late_cycle");

  // Overextension: extremely high completion means little edge left (relative to MAX TP)
  const comp = (() => {
    const cMax = computeCompletionToTpMax(tickerData);
    return Number.isFinite(cMax) ? cMax : completionForSize(tickerData);
  })();
  if (Number.isFinite(comp) && comp >= 0.95) reasons.push("overextended");

  // If we have a trigger timestamp and we're not in the entry corridor anymore,
  // treat it as "not an entry" for this move (soft).
  if (Number.isFinite(triggerTs) && triggerTs > 0) {
    const ent = entryType(tickerData);
    if (ent && ent.corridor === false) reasons.push("left_entry_corridor");
  }

  // Adverse move detection (tightened from 15% to 10% for earlier exits)
  if (Number.isFinite(price) && Number.isFinite(anchorPrice) && anchorPrice > 0) {
    const adverseMove = (price - anchorPrice) / anchorPrice;
    const isAdverse = 
      (side === "LONG" && adverseMove < 0) ||
      (side === "SHORT" && adverseMove > 0);
    
    if (isAdverse) {
      const absMove = Math.abs(adverseMove);
      // Critical: >10% adverse move = hard exit (was 15%)
      if (absMove >= 0.10) {
        reasons.push("large_adverse_move");
      }
      // Warning: >5% adverse move = defensive signal
      else if (absMove >= 0.05) {
        reasons.push("adverse_move_warning");
      }
    }
  }

  // IMPORTANT: do NOT mark the entire universe invalidated for "soft" reasons.
  // Only hard-stop conditions should become INVALIDATED / COMPLETED.
  const isCompleted = reasons.includes("tp_reached");
  const isInvalidated = 
    reasons.includes("sl_breached") || 
    reasons.includes("large_adverse_move");

  const status = isCompleted
    ? "COMPLETED"
    : isInvalidated
      ? "INVALIDATED"
      : "ACTIVE";

  // Severity is used by Kanban stage logic and UI; keep it consistent:
  // NONE | WARNING | CRITICAL
  const severity = reasons.includes("sl_breached") || reasons.includes("trigger_breached_5pct")
    ? "CRITICAL"
    : reasons.length
      ? "WARNING"
      : "NONE";

  return {
    status,
    side,
    severity,
    reasons,
  };
}

function sideFromStateOrScores(tickerData) {
  const state = String(tickerData?.state || "");
  if (state.includes("BULL")) return "LONG";
  if (state.includes("BEAR")) return "SHORT";
  const h = Number(tickerData?.htf_score);
  const l = Number(tickerData?.ltf_score);
  if (Number.isFinite(h) && Number.isFinite(l)) {
    if (h > 0) return "LONG";
    if (h < 0) return "SHORT";
  }
  return null;
}

function dailyEmaRegimeOk(tickerData, side) {
  const cloud = tickerData?.daily_ema_cloud;
  const pos =
    cloud?.position != null ? String(cloud.position).toLowerCase() : "";
  if (!pos) return true;
  if (side === "LONG") return pos !== "below";
  if (side === "SHORT") return pos !== "above";
  return true;
}

function ichimokuRegimeOk(tickerData, side) {
  const dPos =
    tickerData?.ichimoku_d?.position != null
      ? String(tickerData.ichimoku_d.position).toLowerCase()
      : "";
  const wPos =
    tickerData?.ichimoku_w?.position != null
      ? String(tickerData.ichimoku_w.position).toLowerCase()
      : "";

  // If we don't have Ichimoku in the payload yet, don't block.
  if (!dPos && !wPos) return true;

  const dBadLong = dPos === "below";
  const wBadLong = wPos === "below";
  const dBadShort = dPos === "above";
  const wBadShort = wPos === "above";

  // Block only when BOTH HTFs disagree with the trade direction.
  if (side === "LONG") return !(dBadLong && wBadLong);
  if (side === "SHORT") return !(dBadShort && wBadShort);
  return true;
}

function isLateCycle(tickerData) {
  const z = String(tickerData?.phase_zone || "").toUpperCase();
  const phase = Number(tickerData?.phase_pct) || 0;
  // Zones are: LOW / MEDIUM / HIGH / EXTREME (from Pine).
  if (z === "EXTREME") return true;
  if (z === "HIGH") return true;
  // Additional safety for legacy payloads without zones.
  return phase >= 0.7;
}

// Helper function: entryType (check if ticker is in corridor)
function entryType(ticker) {
  // Corridor is defined in score-space (HTF/LTF bands), not by TP/SL price bounds.
  // This must match `corridorSide()` and the UI corridor filters.
  return { corridor: corridorSide(ticker) != null };
}

// Dynamic SCORE calculation that considers real-time conditions
// NOTE: This returns a SCORE (0-200+), not a RANK (position 1-135)
// RANK is determined by sorting all tickers by this score
function computeDynamicScore(ticker) {
  const baseScore = Number(ticker.rank) || 50; // Base score from worker (0-100)
  const htf = Number(ticker.htf_score) || 0;
  const ltf = Number(ticker.ltf_score) || 0;
  const comp = completionForSize(ticker);
  const phase = Number(ticker.phase_pct) || 0;
  const rr = Number(ticker.rr) || 0;
  const flags = ticker.flags || {};
  const state = String(ticker.state || "");
  const holdIntent = String(
    ticker.hold_intent || ticker.horizon_bucket || "",
  ).toUpperCase();

  const sqRel = !!flags.sq30_release;
  const sqOn = !!flags.sq30_on;
  const phaseZoneChange = !!flags.phase_zone_change;
  const aligned =
    state === "HTF_BULL_LTF_BULL" || state === "HTF_BEAR_LTF_BEAR";
  const ent = entryType(ticker);
  const inCorridor = ent.corridor;

  let dynamicScore = baseScore;

  // Data completeness penalty: prefer fully-instrumented names.
  const completeness =
    ticker?.data_completeness || computeDataCompleteness(ticker);
  if (completeness && typeof completeness === "object") {
    if (completeness.score < 70) dynamicScore -= 6;
    else if (completeness.score < 85) dynamicScore -= 3;
  }

  // Per-TF technical structure: reward aligned multi-timeframe stacks.
  const tfAlign = ticker?.tf_summary || tfTechAlignmentSummary(ticker);
  if (
    tfAlign &&
    typeof tfAlign === "object" &&
    Number.isFinite(tfAlign.score)
  ) {
    dynamicScore += tfAlign.score;
    if (tfAlign.squeeze_on && !sqRel && inCorridor) dynamicScore += 1;
    if (tfAlign.squeeze_release && inCorridor) dynamicScore += 2;
  }

  // Explicit triggers[] “why now” boost (bounded).
  const trig = ticker?.trigger_summary || triggerSummaryAndScore(ticker);
  if (trig && typeof trig === "object" && Number.isFinite(trig.score)) {
    dynamicScore += trig.score;
  }

  // Move status: deprioritize invalidated/completed moves
  const ms = ticker?.move_status || computeMoveStatus(ticker);
  if (ms && typeof ms === "object") {
    if (ms.status === "INVALIDATED") dynamicScore -= 30;
    else if (ms.status === "COMPLETED") dynamicScore -= 20;
  }

  // Corridor bonus (high priority - active setups)
  if (inCorridor) {
    dynamicScore += 12; // Strong bonus for being in corridor

    // Extra bonus if aligned AND in corridor (perfect setup)
    if (aligned) {
      dynamicScore += 8;
    }
  }

  // Squeeze release in corridor = very strong signal
  if (sqRel && inCorridor) {
    dynamicScore += 10;
  }

  // Squeeze on in corridor = building pressure
  if (sqOn && inCorridor && !sqRel) {
    dynamicScore += 5;
  }

  // RR bonus (scaled - better RR = higher score)
  if (rr >= 2.0) {
    dynamicScore += 8; // Excellent RR
  } else if (rr >= 1.5) {
    dynamicScore += 5; // Good RR
  } else if (rr >= 1.0) {
    dynamicScore += 2; // Acceptable RR
  }

  // Phase bonus (early phase = better opportunity)
  if (phase < 0.3) {
    dynamicScore += 6; // Very early
  } else if (phase < 0.5) {
    dynamicScore += 3; // Early
  } else if (phase > 0.7) {
    dynamicScore -= 5; // Late phase penalty
  }

  // Completion bonus (low completion = more room to run)
  if (comp < 0.3) {
    dynamicScore += 5; // Early in move
  } else if (comp > 0.8) {
    dynamicScore -= 8; // Near completion penalty
  }

  // Phase 2: Hold-intent scoring (small nudge; only when HTF strength supports it)
  // Goal: favor longer-duration setups when HTF strength is high, without overpowering other gates.
  const htfAbs = Math.abs(htf);
  if (holdIntent === "POSITION" && htfAbs >= 15) {
    dynamicScore += 2;
  } else if (holdIntent === "SWING" && htfAbs >= 10) {
    dynamicScore += 1;
  }

  // Score strength bonus (strong HTF/LTF scores)
  const htfStrength = Math.min(8, Math.abs(htf) * 0.15);
  const ltfStrength = Math.min(6, Math.abs(ltf) * 0.12);
  dynamicScore += htfStrength + ltfStrength;

  // Phase zone change bonus
  if (phaseZoneChange) {
    dynamicScore += 4;
  }

  // NO CAP - let scores go above 100 to avoid ties
  // Minimum is 0, but no maximum cap
  dynamicScore = Math.max(0, dynamicScore);

  return Math.round(dynamicScore * 100) / 100; // Round to 2 decimals for precision
}

// Compute RR at trigger price (for alert evaluation)
// This evaluates RR at the entry point, not current price
// This is critical because price moves after trigger, which decreases RR
function computeRRAtTrigger(d) {
  // Use trigger_price if available, otherwise fall back to current price
  const triggerPrice =
    d.trigger_price != null ? Number(d.trigger_price) : Number(d.price);
  const sl = Number(d.sl);
  if (!Number.isFinite(triggerPrice) || !Number.isFinite(sl)) return null;

  // Use MAX TP from tp_levels if available, otherwise fall back to first TP
  let tp = Number(d.tp);
  if (d.tp_levels && Array.isArray(d.tp_levels) && d.tp_levels.length > 0) {
    // Extract prices from tp_levels (handle both object and number formats)
    const tpPrices = d.tp_levels
      .map((tpItem) => {
        if (
          typeof tpItem === "object" &&
          tpItem !== null &&
          tpItem.price != null
        ) {
          return Number(tpItem.price);
        }
        return typeof tpItem === "number" ? Number(tpItem) : Number(tpItem);
      })
      .filter((p) => Number.isFinite(p));

    if (tpPrices.length > 0) {
      // Use maximum TP (best-case scenario for RR calculation)
      tp = Math.max(...tpPrices);
    }
  }

  if (!Number.isFinite(tp)) return null;

  // Determine direction from state to calculate risk/reward correctly
  const state = String(d.state || "");
  const isLong = state.includes("BULL");
  const isShort = state.includes("BEAR");

  let risk, gain;

  if (isLong) {
    // For LONG: SL should be below trigger price, TP should be above trigger price
    risk = triggerPrice - sl; // Risk is distance from trigger price to SL (down)
    gain = tp - triggerPrice; // Gain is distance from trigger price to TP (up)
  } else if (isShort) {
    // For SHORT: SL should be above trigger price, TP should be below trigger price
    risk = sl - triggerPrice; // Risk is distance from trigger price to SL (up)
    gain = triggerPrice - tp; // Gain is distance from trigger price to TP (down)
  } else {
    // Fallback to absolute values if direction unclear
    risk = Math.abs(triggerPrice - sl);
    gain = Math.abs(tp - triggerPrice);
  }

  // Ensure both risk and gain are positive
  if (risk <= 0 || gain <= 0) return null;
  return gain / risk;
}

// ─────────────────────────────────────────────────────────────
// Horizon + ETA v2 (Worker-derived, % based)
// ─────────────────────────────────────────────────────────────

function clampNum(x, lo, hi) {
  const n = Number(x);
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function median(values) {
  const arr = Array.isArray(values)
    ? values.filter((n) => Number.isFinite(Number(n))).map((n) => Number(n))
    : [];
  if (arr.length === 0) return null;
  arr.sort((a, b) => a - b);
  const mid = Math.floor(arr.length / 2);
  if (arr.length % 2 === 1) return arr[mid];
  return (arr[mid - 1] + arr[mid]) / 2;
}

// Infer ATR (absolute) from ATR_FIB tp_levels by solving:
// price_i - price_j = (mult_i - mult_j) * ATR
function inferAtrAbsFromTpLevels(tpLevels, timeframe) {
  if (!Array.isArray(tpLevels) || tpLevels.length < 2) return null;
  const tf = String(timeframe || "").toUpperCase();

  const atrFib = tpLevels
    .map((tp) => {
      const type = String(tp?.type || "").toUpperCase();
      const t = String(tp?.timeframe || "").toUpperCase();
      const price = Number(tp?.price);
      const mult = Number(tp?.multiplier);
      if (type !== "ATR_FIB") return null;
      if (t !== tf) return null;
      if (!Number.isFinite(price) || price <= 0) return null;
      if (!Number.isFinite(mult) || mult <= 0) return null;
      return { price, mult };
    })
    .filter(Boolean);

  if (atrFib.length < 2) return null;

  const ests = [];
  for (let i = 0; i < atrFib.length; i++) {
    for (let j = i + 1; j < atrFib.length; j++) {
      const dm = Math.abs(atrFib[i].mult - atrFib[j].mult);
      const dp = Math.abs(atrFib[i].price - atrFib[j].price);
      if (dm <= 1e-9) continue;
      if (!Number.isFinite(dp) || dp <= 0) continue;
      const atr = dp / dm;
      if (Number.isFinite(atr) && atr > 0) ests.push(atr);
    }
  }

  const atrMed = median(ests);
  if (!Number.isFinite(atrMed) || atrMed <= 0) return null;
  return atrMed;
}

function horizonBucketFromEtaDays(etaDays) {
  const eta = Number(etaDays);
  if (!Number.isFinite(eta) || eta <= 0) return "UNKNOWN";
  if (eta <= 7) return "SHORT_TERM";
  if (eta <= 30) return "SWING";
  return "POSITIONAL";
}

function deriveHorizonAndMetrics(payload) {
  if (!payload || typeof payload !== "object") return {};

  const state = String(payload.state || "");
  const direction = state.includes("BULL")
    ? "LONG"
    : state.includes("BEAR")
      ? "SHORT"
      : null;
  const isLong = direction === "LONG";

  const entryRef =
    payload.trigger_price != null && Number(payload.trigger_price) > 0
      ? Number(payload.trigger_price)
      : Number(payload.price);
  const sl = Number(payload.sl);

  const out = {
    entry_ref: Number.isFinite(entryRef) ? entryRef : null,
    risk_pct: null,
    tp_max_price: null,
    tp_max_pct: null,
    tp_target_price: null,
    tp_target_pct: null,
    expected_return_pct: null,
    eta_days_v2: null,
    eta_days_next: null,
    eta_days_max: null,
    eta_confidence: 0.4,
    horizon_bucket: "UNKNOWN",
    // Alias for downstream clarity (Phase 2: hold-intent scoring/labeling)
    hold_intent: "UNKNOWN",
  };

  if (!direction || !Number.isFinite(entryRef) || entryRef <= 0) {
    const etaFallback = Number(payload.eta_days);
    out.horizon_bucket = horizonBucketFromEtaDays(etaFallback);
    out.eta_days_v2 = Number.isFinite(etaFallback) ? etaFallback : null;
    out.eta_confidence = Number.isFinite(etaFallback) ? 0.35 : 0.2;
    out.hold_intent = out.horizon_bucket;
    return out;
  }

  if (Number.isFinite(sl) && sl > 0) {
    const riskAbs = Math.abs(entryRef - sl);
    const riskPct = riskAbs / entryRef;
    if (Number.isFinite(riskPct) && riskPct > 0) {
      out.risk_pct = Math.round(riskPct * 10000) / 100;
    }
  }

  const tpLevelsRaw = Array.isArray(payload.tp_levels) ? payload.tp_levels : [];
  const minDistPct = 0.01;

  const tpCandidates = tpLevelsRaw
    .map((tp) => {
      const price = Number(tp?.price);
      if (!Number.isFinite(price) || price <= 0) return null;
      const distancePct = Math.abs(price - entryRef) / entryRef;
      if (!Number.isFinite(distancePct) || distancePct < minDistPct)
        return null;
      if (isLong && price <= entryRef) return null;
      if (!isLong && price >= entryRef) return null;
      return {
        price,
        distancePct,
        timeframe: String(tp?.timeframe || "D").toUpperCase(),
        type: String(tp?.type || "ATR_FIB").toUpperCase(),
        source: String(tp?.source || "").trim(),
        confidence: Number(tp?.confidence),
        multiplier: tp?.multiplier == null ? null : Number(tp?.multiplier),
        _fused: tp?._fused || null,
      };
    })
    .filter(Boolean);

  if (tpCandidates.length > 0) {
    const tpMax = isLong
      ? Math.max(...tpCandidates.map((t) => t.price))
      : Math.min(...tpCandidates.map((t) => t.price));
    if (Number.isFinite(tpMax) && tpMax > 0) {
      out.tp_max_price = tpMax;
      const tpMaxPct = (Math.abs(tpMax - entryRef) / entryRef) * 100;
      if (Number.isFinite(tpMaxPct) && tpMaxPct > 0) {
        out.tp_max_pct = Math.round(tpMaxPct * 100) / 100;
      }
    }
  }

  const atrD = inferAtrAbsFromTpLevels(tpLevelsRaw, "D");
  const atrW = inferAtrAbsFromTpLevels(tpLevelsRaw, "W");
  const atr4 = inferAtrAbsFromTpLevels(tpLevelsRaw, "240");

  let dailyAtrPct = null;
  if (Number.isFinite(atrD) && atrD > 0) dailyAtrPct = atrD / entryRef;
  else if (Number.isFinite(atrW) && atrW > 0) dailyAtrPct = atrW / entryRef / 5;
  else if (Number.isFinite(atr4) && atr4 > 0)
    dailyAtrPct = (atr4 / entryRef) * 1.8;

  const htfAbs = Math.abs(Number(payload.htf_score) || 0);
  const ltfAbs = Math.abs(Number(payload.ltf_score) || 0);
  const momentumFactor = clampNum(
    0.85 + (htfAbs / 50) * 0.25 + (ltfAbs / 50) * 0.25,
    0.75,
    1.45,
  );

  let expectedDailyMovePct = null;
  if (Number.isFinite(dailyAtrPct) && dailyAtrPct > 0) {
    expectedDailyMovePct = clampNum(
      dailyAtrPct * 0.35 * momentumFactor,
      0.003,
      dailyAtrPct * 1.1,
    );
    out.eta_confidence += 0.25;
  } else if (Number.isFinite(out.risk_pct) && out.risk_pct > 0) {
    expectedDailyMovePct = clampNum(
      (out.risk_pct / 100) * 0.25 * momentumFactor,
      0.003,
      0.02,
    );
    out.eta_confidence += 0.1;
  } else {
    expectedDailyMovePct = 0.006;
    out.eta_confidence += 0.05;
  }

  // Intelligent target TP: use horizon-aware TP array to pick a realistic target
  const tpArray = buildIntelligentTPArray(payload, entryRef, direction);
  const targetTp =
    tpArray && tpArray.length > 1
      ? tpArray[1]
      : tpArray && tpArray.length > 0
        ? tpArray[0]
        : null;
  if (targetTp && Number.isFinite(targetTp.price) && targetTp.price > 0) {
    out.tp_target_price = Number(targetTp.price);
    const targetPct =
      (Math.abs(out.tp_target_price - entryRef) / entryRef) * 100;
    if (Number.isFinite(targetPct) && targetPct > 0) {
      out.tp_target_pct = Math.round(targetPct * 100) / 100;
      out.expected_return_pct = out.tp_target_pct;
    }
    if (Number.isFinite(expectedDailyMovePct) && expectedDailyMovePct > 0) {
      const etaTarget = targetPct / 100 / expectedDailyMovePct;
      if (Number.isFinite(etaTarget) && etaTarget > 0) {
        out.eta_days_v2 = Math.round(clampNum(etaTarget, 0.2, 180) * 100) / 100;
        out.eta_confidence += 0.15;
      }
    }
  }

  const qualityScore = (tp) => {
    const tf = String(tp?.timeframe || "D").toUpperCase();
    const type = String(tp?.type || "").toUpperCase();
    const conf = Number(tp?.confidence);
    const tfScore =
      tf === "W" ? 3 : tf === "D" ? 2 : tf === "240" || tf === "4H" ? 1 : 0;
    const typeScore = type.startsWith("FUSED")
      ? 3
      : type === "STRUCTURE"
        ? 3
        : type === "LIQUIDITY"
          ? 2
          : type === "FVG"
            ? 1.5
            : type === "GAP"
              ? 1
              : type === "ATR_FIB"
                ? 1
                : 0.5;
    const confScore = Number.isFinite(conf)
      ? clampNum((conf - 0.6) / 0.3, 0, 1)
      : 0.5;
    return tfScore + typeScore + confScore;
  };

  const scored = tpCandidates
    .map((tp) => ({
      ...tp,
      _q: qualityScore(tp),
      _eta: tp.distancePct / expectedDailyMovePct,
    }))
    .filter((tp) => Number.isFinite(tp._eta) && tp._eta > 0)
    .sort((a, b) => {
      const aScore = a._q / (1 + a.distancePct * 12);
      const bScore = b._q / (1 + b.distancePct * 12);
      return bScore - aScore;
    });

  const next = scored[0] || null;
  if (next) {
    out.eta_days_next = Math.round(clampNum(next._eta, 0.2, 180) * 100) / 100;
    if (!Number.isFinite(out.eta_days_v2)) {
      out.eta_days_v2 = out.eta_days_next;
      out.eta_confidence += 0.2;
    }
  }

  if (Number.isFinite(out.tp_max_price) && out.tp_max_price > 0) {
    const distMaxPct = Math.abs(out.tp_max_price - entryRef) / entryRef;
    const etaMax = distMaxPct / expectedDailyMovePct;
    if (Number.isFinite(etaMax) && etaMax > 0) {
      out.eta_days_max = Math.round(clampNum(etaMax, 0.5, 365) * 100) / 100;
    }
  }

  if (
    !Number.isFinite(out.expected_return_pct) &&
    Number.isFinite(out.tp_max_pct)
  ) {
    out.expected_return_pct = out.tp_max_pct;
  }

  out.eta_confidence =
    Math.round(clampNum(out.eta_confidence, 0.1, 0.95) * 100) / 100;
  const etaForBucket = Number.isFinite(out.eta_days_v2)
    ? out.eta_days_v2
    : Number(payload.eta_days);
  out.horizon_bucket = horizonBucketFromEtaDays(etaForBucket);
  out.hold_intent = out.horizon_bucket;

  return out;
}

function normalizeDay(ts) {
  const ms = Number(ts);
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 86400000);
}

function buildDailyCloseSeries(trail = [], maxDays = 20) {
  if (!Array.isArray(trail) || trail.length === 0) return [];
  const dayMap = new Map();
  for (const point of trail) {
    const day = normalizeDay(point.ts);
    const price = Number(point.price);
    if (!Number.isFinite(day) || !Number.isFinite(price)) continue;
    // Keep last price of the day
    dayMap.set(day, price);
  }
  const days = Array.from(dayMap.keys()).sort((a, b) => a - b);
  const clipped = days.slice(-1 * Math.max(1, maxDays + 1));
  return clipped.map((day) => ({ day, close: dayMap.get(day) }));
}

function buildReturnMap(series = []) {
  const map = new Map();
  for (let i = 1; i < series.length; i++) {
    const prev = series[i - 1];
    const cur = series[i];
    if (!prev || !cur) continue;
    const ret = (cur.close - prev.close) / Math.max(1e-9, prev.close);
    if (!Number.isFinite(ret)) continue;
    map.set(cur.day, ret);
  }
  return map;
}

function pearsonCorrelation(a = [], b = []) {
  if (!Array.isArray(a) || !Array.isArray(b)) return null;
  const n = Math.min(a.length, b.length);
  if (n < 5) return null;
  const x = a.slice(-n);
  const y = b.slice(-n);
  const mean = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length;
  const meanX = mean(x);
  const meanY = mean(y);
  let num = 0;
  let denX = 0;
  let denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  const den = Math.sqrt(denX * denY);
  if (!Number.isFinite(den) || den <= 0) return null;
  return num / den;
}

async function computeOpenTradesCorrelation(env, KV, options = {}) {
  const cacheKey = "timed:corr:open_trades";
  const ttlSec = Number(options.ttlSec || 300);
  const now = Date.now();
  try {
    const cached = await kvGetJSON(KV, cacheKey);
    if (
      cached &&
      cached.computedAt &&
      now - cached.computedAt < ttlSec * 1000
    ) {
      return cached;
    }
  } catch {
    // ignore cache errors
  }

  const db = env?.DB;
  if (!db) return { ok: false, skipped: true, reason: "no_db_binding" };

  const trades = (await kvGetJSON(KV, "timed:trades:all")) || [];
  const openTickers = Array.from(
    new Set(
      trades
        .filter((t) => {
          const status = String(t?.status || "").toUpperCase();
          return status === "OPEN" || status === "TP_HIT_TRIM" || !status;
        })
        .map((t) => String(t?.ticker || "").toUpperCase())
        .filter(Boolean),
    ),
  );

  if (openTickers.length < 2) {
    return {
      ok: true,
      computedAt: now,
      tickers: openTickers,
      avgCorrByTicker: {},
    };
  }

  const sinceTs = now - 35 * 24 * 60 * 60 * 1000;
  const seriesMap = new Map();

  await Promise.all(
    openTickers.map(async (ticker) => {
      const res = await d1GetTrailRange(env, ticker, sinceTs, 8000);
      const trail = res && Array.isArray(res.trail) ? res.trail : [];
      const dailySeries = buildDailyCloseSeries(trail, 20);
      seriesMap.set(ticker, dailySeries);
    }),
  );

  const returnMapByTicker = new Map();
  for (const ticker of openTickers) {
    const series = seriesMap.get(ticker) || [];
    returnMapByTicker.set(ticker, buildReturnMap(series));
  }

  const avgCorrByTicker = {};
  const sectorMap = new Map();
  const sectorCounts = {};
  for (const ticker of openTickers) {
    try {
      const latest = await kvGetJSON(KV, `timed:latest:${ticker}`);
      const sector =
        latest?.sector || latest?.fundamentals?.sector || "UNKNOWN";
      sectorMap.set(ticker, sector);
      sectorCounts[sector] = (sectorCounts[sector] || 0) + 1;
    } catch {
      sectorMap.set(ticker, "UNKNOWN");
      sectorCounts.UNKNOWN = (sectorCounts.UNKNOWN || 0) + 1;
    }
  }
  for (const ticker of openTickers) {
    const baseMap = returnMapByTicker.get(ticker);
    if (!baseMap || baseMap.size < 5) continue;
    const corrVals = [];
    for (const other of openTickers) {
      if (other === ticker) continue;
      const otherMap = returnMapByTicker.get(other);
      if (!otherMap || otherMap.size < 5) continue;
      const commonDays = [];
      for (const [day, ret] of baseMap.entries()) {
        if (otherMap.has(day)) {
          commonDays.push([ret, otherMap.get(day)]);
        }
      }
      if (commonDays.length < 5) continue;
      const a = commonDays.map((v) => v[0]);
      const b = commonDays.map((v) => v[1]);
      const corr = pearsonCorrelation(a, b);
      if (Number.isFinite(corr)) corrVals.push(Math.abs(corr));
    }
    if (corrVals.length > 0) {
      const avg =
        corrVals.reduce((sum, v) => sum + v, 0) / Math.max(1, corrVals.length);
      const diversity = Math.round(Math.max(0, 1 - avg) * 100);
      avgCorrByTicker[ticker] = {
        avg_corr: Math.round(avg * 1000) / 1000,
        diversity_score: diversity,
        corr_count: corrVals.length,
      };
    }
  }

  // Fallback proxy: sector concentration when return series is insufficient.
  for (const ticker of openTickers) {
    if (avgCorrByTicker[ticker]) continue;
    const sector = sectorMap.get(ticker) || "UNKNOWN";
    const sameSector = Math.max(1, sectorCounts[sector] || 1);
    const total = Math.max(1, openTickers.length);
    const share = sameSector / total;
    const avg = Math.min(0.95, 0.3 + 0.7 * share);
    const diversity = Math.round(Math.max(0, 1 - avg) * 100);
    avgCorrByTicker[ticker] = {
      avg_corr: Math.round(avg * 1000) / 1000,
      diversity_score: diversity,
      corr_count: 0,
      _proxy: "sector",
    };
  }

  const result = {
    ok: true,
    computedAt: now,
    tickers: openTickers,
    avgCorrByTicker,
  };

  try {
    await kvPutJSON(KV, cacheKey, result, ttlSec);
  } catch {
    // ignore cache set errors
  }

  return result;
}

// ── Corridor helpers (must match UI corridors)
// LONG ltf -10..22: wider upper bound so momentum entries (LTF 12-22) still qualify
// SHORT ltf -12..10. Accept htf_score/htfScore, ltf_score/ltfScore (ingest payloads may use either)
function inLongCorridor(d) {
  const h = Number(d?.htf_score ?? d?.htfScore);
  const l = Number(d?.ltf_score ?? d?.ltfScore);
  return (
    Number.isFinite(h) && Number.isFinite(l) && h > 0 && l >= -10 && l <= 22
  );
}
function inShortCorridor(d) {
  const h = Number(d?.htf_score ?? d?.htfScore);
  const l = Number(d?.ltf_score ?? d?.ltfScore);
  return (
    Number.isFinite(h) && Number.isFinite(l) && h < 0 && l >= -12 && l <= 10
  );
}
function corridorSide(d) {
  if (inLongCorridor(d)) return "LONG";
  if (inShortCorridor(d)) return "SHORT";
  return null;
}

function fmt2(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n.toFixed(2) : "—";
}
function pct01(x) {
  const n = Number(x);
  return Number.isFinite(n) ? `${Math.round(n * 100)}%` : "—";
}

// ─────────────────────────────────────────────────────────────
// Trade Simulation Functions (Worker-Level)
// ─────────────────────────────────────────────────────────────

const TRADE_SIZE = 1000; // $1000 per trade
const PORTFOLIO_START_CASH = 100000;
const MIN_TRADE_NOTIONAL = 1000;
const MAX_TRADE_NOTIONAL = 5000;
const PORTFOLIO_KEY = "timed:portfolio:v1";

function clamp(x, lo, hi) {
  const n = Number(x);
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function computeTradeConfidence(tickerData) {
  const t = tickerData && typeof tickerData === "object" ? tickerData : {};
  const flags = t.flags && typeof t.flags === "object" ? t.flags : {};
  const rank = Number(t.rank) || 0;
  const rr =
    Number(t.rr_now_likely) || Number(t.rr_entry_likely) || Number(t.rr) || 0;
  const h = Math.abs(Number(t.htf_score) || 0);
  const l = Math.abs(Number(t.ltf_score) || 0);

  // Rank is the strongest driver: 60→0, 90→1
  const cRank = clamp((rank - 60) / 30, 0, 1);
  // RR: 1.0→0, 2.5→1
  const cRr = clamp((rr - 1.0) / 1.5, 0, 1);
  // Scores: soft contribution
  const cScore = clamp((h / 60) * 0.6 + (l / 35) * 0.4, 0, 1);
  const bonus =
    (flags.momentum_elite ? 0.08 : 0) +
    (flags.thesis_match ? 0.08 : 0) +
    (flags.sq30_release ? 0.04 : 0);

  const confidence = clamp(
    0.55 * cRank + 0.25 * cRr + 0.2 * cScore + bonus,
    0,
    1,
  );
  return confidence;
}

async function getPortfolioState(KV) {
  try {
    const p = await kvGetJSON(KV, PORTFOLIO_KEY);
    if (p && typeof p === "object" && Number.isFinite(Number(p.cash))) return p;
  } catch {
    // ignore
  }
  const now = Date.now();
  return {
    version: 1,
    startCash: PORTFOLIO_START_CASH,
    cash: PORTFOLIO_START_CASH,
    created_at: now,
    updated_at: now,
  };
}

async function putPortfolioState(KV, p) {
  try {
    const now = Date.now();
    const next = { ...(p || {}), updated_at: now };
    if (!Number.isFinite(Number(next.startCash)))
      next.startCash = PORTFOLIO_START_CASH;
    if (!Number.isFinite(Number(next.cash)))
      next.cash = Number(next.startCash) || PORTFOLIO_START_CASH;
    await kvPutJSON(KV, PORTFOLIO_KEY, next);
    return next;
  } catch {
    return p;
  }
}

function tradeNotionalFromConfidence(confidence, cashAvailable) {
  const base =
    MIN_TRADE_NOTIONAL +
    (MAX_TRADE_NOTIONAL - MIN_TRADE_NOTIONAL) * clamp(confidence, 0, 1);
  const maxByCash = Number.isFinite(Number(cashAvailable))
    ? Number(cashAvailable)
    : base;
  const capped = Math.min(base, maxByCash, MAX_TRADE_NOTIONAL);
  return clamp(capped, MIN_TRADE_NOTIONAL, MAX_TRADE_NOTIONAL);
}

function computeSharesForTrade(ticker, entryPrice, notional) {
  const sym = String(ticker || "").toUpperCase();
  const isFutures = FUTURES_SPECS[sym] || sym.endsWith("1!");
  if (isFutures && FUTURES_SPECS[sym]) {
    return { shares: 1, pointValue: FUTURES_SPECS[sym].pointValue };
  }
  const px = Number(entryPrice);
  const n = Number(notional);
  if (!Number.isFinite(px) || px <= 0 || !Number.isFinite(n) || n <= 0)
    return { shares: null, pointValue: 1 };
  return { shares: n / px, pointValue: 1 };
}

// Futures contract specifications (point value per contract)
const FUTURES_SPECS = {
  "ES1!": { pointValue: 50, name: "E-mini S&P 500" },
  "NQ1!": { pointValue: 20, name: "E-mini Nasdaq-100" },
  "MES1!": { pointValue: 5, name: "Micro E-mini S&P 500" },
  "MNQ1!": { pointValue: 2, name: "Micro E-mini Nasdaq-100" },
  "YM1!": { pointValue: 5, name: "E-mini Dow" },
  "RTY1!": { pointValue: 50, name: "E-mini Russell 2000" },
  ES: { pointValue: 50, name: "E-mini S&P 500" },
  NQ: { pointValue: 20, name: "E-mini Nasdaq-100" },
  YM: { pointValue: 5, name: "E-mini Dow" },
};

const FUTURES_TICKERS = new Set([
  "ES",
  "NQ",
  "YM",
  "RTY",
  "CL",
  "GC",
  "SI",
  "HG",
  "NG",
]);

// Check if ticker should trigger a trade (matches UI logic)
function shouldTriggerTradeSimulation(ticker, tickerData, prevData) {
  const tickerUpper = String(ticker || "").toUpperCase();

  // Skip futures
  if (FUTURES_TICKERS.has(tickerUpper)) return false;

  // Must have valid entry/exit levels (support alternate field names)
  const slVal = Number(tickerData?.sl ?? tickerData?.sl_price ?? tickerData?.stop_loss);
  const tpVal = Number(tickerData?.tp ?? tickerData?.tp_max_price ?? tickerData?.tp_target_price ?? tickerData?.tp_target);
  if (!tickerData.price || !Number.isFinite(slVal) || slVal <= 0 || !Number.isFinite(tpVal) || tpVal <= 0) return false;

  const flags = tickerData.flags || {};
  const flipWatch = !!flags.flip_watch;
  const state = String(tickerData.state || "");
  const alignedLong = state === "HTF_BULL_LTF_BULL";
  const alignedShort = state === "HTF_BEAR_LTF_BEAR";
  const aligned = alignedLong || alignedShort;

  const h = Number(tickerData.htf_score);
  const l = Number(tickerData.ltf_score);
  const inCorridor =
    Number.isFinite(h) &&
    Number.isFinite(l) &&
    ((h > 0 && l >= -10 && l <= 22) || // LONG corridor (widened upper for momentum entries)
      (h < 0 && l >= -12 && l <= 10)); // SHORT corridor

  const side =
    h > 0 && l >= -10 && l <= 22
      ? "LONG"
      : h < 0 && l >= -12 && l <= 10
        ? "SHORT"
        : null;
  const corridorAlignedOK =
    (side === "LONG" && alignedLong) || (side === "SHORT" && alignedShort);

  if (!inCorridor || !corridorAlignedOK) return false;

  // Check for trigger conditions
  const enteredAligned = prevData && prevData.state !== state && aligned;
  const prevH = prevData ? Number(prevData.htf_score) : NaN;
  const prevL = prevData ? Number(prevData.ltf_score) : NaN;
  const prevInCorridor =
    Number.isFinite(prevH) &&
    Number.isFinite(prevL) &&
    ((prevH > 0 && prevL >= -10 && prevL <= 22) ||
      (prevH < 0 && prevL >= -12 && prevL <= 10));
  const justEnteredCorridor = !!prevData && !prevInCorridor && inCorridor;
  const trigReason = String(tickerData.trigger_reason || "");
  const trigOk = trigReason === "EMA_CROSS" || trigReason === "SQUEEZE_RELEASE" ||
    trigReason.includes("EMA_CROSS") || trigReason.includes("SQUEEZE_RELEASE");
  const sqRelease = !!flags.sq30_release;

  const shouldConsiderAlert =
    inCorridor &&
    corridorAlignedOK &&
    (justEnteredCorridor || enteredAligned || trigOk || sqRelease || flipWatch);

  const momentumElite = !!flags.momentum_elite;
  const baseMinRR = 1.2;
  const baseMaxComp = 0.5;
  const baseMaxPhase = 0.65;
  const minRR = momentumElite ? Math.max(1.0, baseMinRR * 0.9) : baseMinRR;
  const maxComp = flipWatch || sqRelease
    ? Math.min(0.6, baseMaxComp * 1.2)
    : momentumElite
      ? Math.min(0.55, baseMaxComp * 1.1)
      : baseMaxComp;
  const maxPhase = momentumElite
    ? Math.min(0.75, baseMaxPhase * 1.15)
    : baseMaxPhase;

  // Rank threshold: 70 (env-aligned); Momentum Elite 60 for more movement when market moves.
  const rank = Number(tickerData.rank ?? tickerData.rank_position ?? tickerData.position) || 0;
  const minRank = momentumElite ? 60 : 70;
  const rankOk = rank >= minRank;

  const rr = Number(tickerData.rr) || 0;
  const compRaw = completionForSize(tickerData);
  const compToMax = computeCompletionToTpMax(tickerData);
  const comp = Number.isFinite(compToMax) ? compToMax : compRaw;
  const phase = Number(tickerData.phase_pct) || 0;

  const rrOk = rr >= minRR;
  const compOk = comp <= maxComp;
  const phaseOk = phase <= maxPhase;

  const momentumEliteTrigger =
    momentumElite &&
    inCorridor &&
    corridorAlignedOK &&
    (trigOk || sqRelease || flipWatch || justEnteredCorridor);
  const enhancedTrigger = shouldConsiderAlert || momentumEliteTrigger;

  // Don't enter if the move has already invalidated/completed
  const ms = tickerData?.move_status || computeMoveStatus(tickerData);
  if (ms && (ms.status === "INVALIDATED" || ms.status === "COMPLETED"))
    return false;

  // Phase 1/3 gates applied to simulation entries too.
  const inferredSide = side || sideFromStateOrScores(tickerData);
  if (!dailyEmaRegimeOk(tickerData, inferredSide)) return false;
  if (!ichimokuRegimeOk(tickerData, inferredSide)) return false;
  if (isLateCycle(tickerData) && !momentumElite) return false;
  // Fresh trigger: pullback→re-align, squeeze release, flip_watch, or just entered corridor (market moved in).
  const prevStateStr = prevData ? String(prevData.state || "") : "";
  const enteredFromPullback =
    !!enteredAligned && prevStateStr.includes("PULLBACK");
  const freshPullbackOk =
    enteredFromPullback ||
    sqRelease ||
    (trigReason === "SQUEEZE_RELEASE" || trigReason.includes("SQUEEZE_RELEASE")) ||
    (trigReason.includes("EMA_CROSS")) ||
    flipWatch ||
    justEnteredCorridor;
  if (!freshPullbackOk) return false;

  return enhancedTrigger && rrOk && compOk && phaseOk && rankOk;
}

// Debug: return blockers for trade entry (same logic as shouldTriggerTradeSimulation)
function getEntryBlockers(ticker, tickerData, prevData) {
  const blockers = [];
  const tickerUpper = String(ticker || "").toUpperCase();
  if (FUTURES_TICKERS.has(tickerUpper)) return ["futures_disabled"];

  const slVal = Number(tickerData?.sl ?? tickerData?.sl_price ?? tickerData?.stop_loss);
  const tpVal = Number(tickerData?.tp ?? tickerData?.tp_max_price ?? tickerData?.tp_target_price ?? tickerData?.tp_target);
  if (!tickerData.price || !Number.isFinite(slVal) || slVal <= 0 || !Number.isFinite(tpVal) || tpVal <= 0) {
    blockers.push("missing_levels");
    return blockers;
  }

  const flags = tickerData.flags || {};
  const flipWatch = !!flags.flip_watch;
  const state = String(tickerData.state || "");
  const alignedLong = state === "HTF_BULL_LTF_BULL";
  const alignedShort = state === "HTF_BEAR_LTF_BEAR";
  const aligned = alignedLong || alignedShort;
  const h = Number(tickerData.htf_score);
  const l = Number(tickerData.ltf_score);
  const inCorridor = Number.isFinite(h) && Number.isFinite(l) &&
    ((h > 0 && l >= -10 && l <= 22) || (h < 0 && l >= -12 && l <= 10));
  const side = h > 0 && l >= -10 && l <= 22 ? "LONG" : h < 0 && l >= -12 && l <= 10 ? "SHORT" : null;
  const corridorAlignedOK = (side === "LONG" && alignedLong) || (side === "SHORT" && alignedShort);

  if (!inCorridor) blockers.push("not_in_corridor");
  if (inCorridor && !corridorAlignedOK) blockers.push("corridor_misaligned");

  const prevH = prevData ? Number(prevData.htf_score) : NaN;
  const prevL = prevData ? Number(prevData.ltf_score) : NaN;
  const prevInCorridor = Number.isFinite(prevH) && Number.isFinite(prevL) &&
    ((prevH > 0 && prevL >= -10 && prevL <= 22) || (prevH < 0 && prevL >= -12 && prevL <= 10));
  const justEnteredCorridor = !!prevData && !prevInCorridor && inCorridor;
  const trigReason = String(tickerData.trigger_reason || "");
  const trigOk = trigReason === "EMA_CROSS" || trigReason === "SQUEEZE_RELEASE" ||
    trigReason.includes("EMA_CROSS") || trigReason.includes("SQUEEZE_RELEASE");
  const sqRelease = !!flags.sq30_release;
  const enteredAligned = prevData && prevData.state !== state && aligned;

  const shouldConsiderAlert = inCorridor && corridorAlignedOK &&
    (justEnteredCorridor || enteredAligned || trigOk || sqRelease || flipWatch);
  const momentumElite = !!flags.momentum_elite;
  const momentumEliteTrigger = momentumElite && inCorridor && corridorAlignedOK &&
    (trigOk || sqRelease || flipWatch || justEnteredCorridor);
  const enhancedTrigger = shouldConsiderAlert || momentumEliteTrigger;

  const rank = Number(tickerData.rank ?? tickerData.rank_position ?? tickerData.position) || 0;
  const minRank = momentumElite ? 60 : 70;
  if (rank < minRank) blockers.push(`rank_below_min(${rank}<${minRank})`);

  const rr = Number(tickerData.rr) || 0;
  const minRR = momentumElite ? Math.max(1.0, 1.2 * 0.9) : 1.2;
  if (rr < minRR) blockers.push(`rr_below_min(${rr?.toFixed(2)}<${minRR})`);

  const compRaw = completionForSize(tickerData);
  const compToMax = computeCompletionToTpMax(tickerData);
  const comp = Number.isFinite(compToMax) ? compToMax : compRaw;
  const maxComp = flipWatch || sqRelease ? 0.6 : momentumElite ? 0.55 : 0.5;
  if (comp > maxComp) blockers.push(`completion_high(${(comp*100).toFixed(0)}%>${(maxComp*100).toFixed(0)}%)`);

  const phase = Number(tickerData.phase_pct) || 0;
  const maxPhase = momentumElite ? 0.75 : 0.65;
  if (phase > maxPhase) blockers.push(`phase_high(${(phase*100).toFixed(0)}%>${(maxPhase*100).toFixed(0)}%)`);

  const ms = tickerData?.move_status || computeMoveStatus(tickerData);
  if (ms?.status === "INVALIDATED") blockers.push("move_invalidated");
  if (ms?.status === "COMPLETED") blockers.push("move_completed");

  const inferredSide = side || sideFromStateOrScores(tickerData);
  if (!dailyEmaRegimeOk(tickerData, inferredSide)) blockers.push("htf_regime_gate");
  if (!ichimokuRegimeOk(tickerData, inferredSide)) blockers.push("ichimoku_regime_gate");
  if (isLateCycle(tickerData) && !momentumElite) blockers.push("late_cycle");

  const prevStateStr = prevData ? String(prevData.state || "") : "";
  const enteredFromPullback = !!enteredAligned && prevStateStr.includes("PULLBACK");
  const freshPullbackOk = enteredFromPullback || sqRelease ||
    (trigReason === "SQUEEZE_RELEASE" || trigReason.includes("SQUEEZE_RELEASE")) ||
    trigReason.includes("EMA_CROSS") || flipWatch || justEnteredCorridor;
  if (!freshPullbackOk) blockers.push("no_fresh_pullback");

  if (!enhancedTrigger) blockers.push("no_enhanced_trigger");

  return blockers;
}

function isOpenTradeStatus(status) {
  const s = String(status || "").toUpperCase();
  return s === "OPEN" || s === "TP_HIT_TRIM" || !s;
}

async function findOpenTradeForTicker(KV, ticker, direction = null) {
  const trades = (await kvGetJSON(KV, "timed:trades:all")) || [];
  const t = String(ticker || "").toUpperCase();
  const dir = direction ? String(direction).toUpperCase() : null;
  return (
    trades.find((trade) => {
      if (!trade) return false;
      if (String(trade.ticker || "").toUpperCase() !== t) return false;
      if (dir && String(trade.direction || "").toUpperCase() !== dir)
        return false;
      return isOpenTradeStatus(trade.status);
    }) || null
  );
}

async function checkIngestCoverage(KV, now = new Date()) {
  if (!isMarketHoursET(now)) return { ok: true, skipped: true };
  const tickers = (await kvGetJSON(KV, "timed:tickers")) || [];
  const missing = [];
  const maxAgeMin = 10;

  for (const ticker of tickers) {
    if (marketType(ticker) !== "EQUITY_RTH") continue;
    const latest = await kvGetJSON(KV, `timed:latest:${ticker}`);
    const lastTsRaw = latest?.ingest_ts ?? latest?.ts ?? null;
    const lastTs = Number(lastTsRaw);
    const ageMin = Number.isFinite(lastTs)
      ? (now.getTime() - lastTs) / 60000
      : null;

    if (!Number.isFinite(ageMin) || ageMin > maxAgeMin) {
      missing.push({
        ticker: String(ticker).toUpperCase(),
        ageMin,
        lastTs,
        state: latest?.state,
        rank: latest?.rank,
        price: latest?.price,
      });
      const missKey = `timed:ingest:missing:${String(ticker).toUpperCase()}`;
      const already = await KV.get(missKey);
      if (!already) {
        await kvPutText(KV, missKey, "1", 60 * 60);
        await appendActivity(KV, {
          type: "ingest_missing",
          ticker: String(ticker).toUpperCase(),
          action: "missing_ingest",
          age_min: Number.isFinite(ageMin) ? Math.round(ageMin) : null,
          last_ingest_ts: Number.isFinite(lastTs) ? lastTs : null,
          state: latest?.state,
          rank: latest?.rank,
          price: latest?.price,
        });
      }
    } else {
      const missKey = `timed:ingest:missing:${String(ticker).toUpperCase()}`;
      await KV.delete(missKey);
    }
  }

  return { ok: true, missing, checked: tickers.length };
}

function buildEntryDecision(ticker, tickerData, prevState) {
  const tickerUpper = String(ticker || "").toUpperCase();
  const blockers = [];
  const warnings = [];
  const flags = tickerData.flags || {};
  const flipWatch = !!flags.flip_watch;
  const state = String(tickerData.state || "");

  const alignedLong = state === "HTF_BULL_LTF_BULL";
  const alignedShort = state === "HTF_BEAR_LTF_BEAR";
  const aligned = alignedLong || alignedShort;

  const h = Number(tickerData.htf_score);
  const l = Number(tickerData.ltf_score);
  const inCorridor =
    Number.isFinite(h) &&
    Number.isFinite(l) &&
    ((h > 0 && l >= -10 && l <= 22) || (h < 0 && l >= -12 && l <= 10));
  const side =
    h > 0 && l >= -10 && l <= 22
      ? "LONG"
      : h < 0 && l >= -12 && l <= 10
        ? "SHORT"
        : null;
  const corridorAlignedOK =
    (side === "LONG" && alignedLong) || (side === "SHORT" && alignedShort);

  const enteredAligned = aligned && prevState && prevState !== state;
  const trigReason = String(tickerData.trigger_reason || "");
  const trigOk = trigReason === "EMA_CROSS" || trigReason === "SQUEEZE_RELEASE" ||
    trigReason.includes("EMA_CROSS") || trigReason.includes("SQUEEZE_RELEASE");
  const sqRelease = !!flags.sq30_release;
  // Note: do NOT treat mere presence of trigger_price/trigger_ts as a trigger.
  // Many payloads include those fields continuously, causing over-trading.
  const hasTrigger = false;

  const shouldConsiderAlert =
    inCorridor &&
    corridorAlignedOK &&
    (enteredAligned || trigOk || sqRelease || hasTrigger);

  const momentumElite = !!flags.momentum_elite;
  const baseMinRR = 1.2;
  const baseMaxComp = 0.5;
  const baseMaxPhase = 0.65;
  const minRR = momentumElite ? Math.max(1.0, baseMinRR * 0.9) : baseMinRR;
  const maxComp = flipWatch || sqRelease
    ? Math.min(0.6, baseMaxComp * 1.2)
    : momentumElite
      ? Math.min(0.55, baseMaxComp * 1.1)
      : baseMaxComp;
  const maxPhase = momentumElite
    ? Math.min(0.75, baseMaxPhase * 1.15)
    : baseMaxPhase;

  const price = Number(tickerData.price);
  const triggerPrice = Number(tickerData.trigger_price);
  const entryPrice =
    Number.isFinite(price) && price > 0
      ? price
      : Number.isFinite(triggerPrice) && triggerPrice > 0
        ? triggerPrice
        : null;
  const entryPriceSource =
    Number.isFinite(price) && price > 0
      ? "price"
      : Number.isFinite(triggerPrice) && triggerPrice > 0
        ? "trigger_price"
        : null;

  // Normalize sl/tp from alternate field names (payloads may vary)
  const slVal = Number(tickerData?.sl ?? tickerData?.sl_price ?? tickerData?.stop_loss);
  const tpVal = Number(tickerData?.tp ?? tickerData?.tp_max_price ?? tickerData?.tp_target_price ?? tickerData?.tp_target);
  if (Number.isFinite(slVal) && tickerData.sl == null) tickerData.sl = slVal;
  if (Number.isFinite(tpVal) && tickerData.tp == null) tickerData.tp = tpVal;

  const hasLevels = Number.isFinite(slVal) && slVal > 0 && Number.isFinite(tpVal) && tpVal > 0;
  const rrAtEntry =
    entryPrice != null ? calculateRRAtEntry(tickerData, entryPrice) : null;
  const compRaw = completionForSize(tickerData);
  const compToMax = computeCompletionToTpMax(tickerData);
  const comp = Number.isFinite(compToMax) ? compToMax : compRaw;
  const phase = Number(tickerData.phase_pct) || 0;

  const rrOk =
    (rrAtEntry != null && Number.isFinite(rrAtEntry))
      ? rrAtEntry >= minRR
      : (hasLevels && entryPrice != null);
  const compOk = comp <= maxComp;
  const phaseOk = phase <= maxPhase;

  const rank = Number(tickerData.rank ?? tickerData.rank_position ?? tickerData.position) || 0;
  const minRank = momentumElite ? 60 : 70;
  const rankOk = rank >= minRank;

  if (FUTURES_TICKERS.has(tickerUpper)) blockers.push("futures_disabled");
  if (!Number.isFinite(entryPrice) || !hasLevels)
    blockers.push("missing_levels");
  if (!inCorridor) blockers.push("not_in_corridor");
  if (inCorridor && !corridorAlignedOK) blockers.push("corridor_misaligned");
  if (!shouldConsiderAlert) blockers.push("no_trigger");

  // Move invalidation/completion gate (don't suggest entries on broken/done moves)
  const ms = tickerData?.move_status || computeMoveStatus(tickerData);
  if (ms && ms.status === "INVALIDATED") blockers.push("move_invalidated");
  if (ms && ms.status === "COMPLETED") blockers.push("move_completed");

  // Phase 1: HTF regime gate + late-cycle disqualifier + pullback-only entry constraint
  const inferredSide = side || sideFromStateOrScores(tickerData);
  if (!dailyEmaRegimeOk(tickerData, inferredSide))
    blockers.push("htf_regime_gate");
  if (!ichimokuRegimeOk(tickerData, inferredSide))
    blockers.push("ichimoku_regime_gate");

  const lateCycle = isLateCycle(tickerData);
  if (lateCycle && !momentumElite) blockers.push("late_cycle");
  else if (lateCycle && momentumElite) warnings.push("late_cycle");

  // Pullback-only entry: require a pullback→re-alignment transition OR a squeeze release OR flip_watch.
  const enteredFromPullback =
    !!enteredAligned && String(prevState || "").includes("PULLBACK");
  const freshPullbackOk =
    enteredFromPullback || sqRelease || trigReason === "SQUEEZE_RELEASE" ||
    trigReason.includes("SQUEEZE_RELEASE") || trigReason.includes("EMA_CROSS") || flipWatch;
  if (!freshPullbackOk) blockers.push("no_fresh_pullback");

  if (!rankOk) blockers.push("rank_below_min");
  if (!rrOk) blockers.push("rr_below_min");
  if (!compOk) blockers.push("completion_high");
  if (!phaseOk) blockers.push("phase_high");

  const staleness = String(tickerData.staleness || "").toUpperCase();
  if (staleness && staleness !== "FRESH") warnings.push("stale_data");

  return {
    ok: blockers.length === 0,
    action: "ENTRY",
    side: side || (alignedLong ? "LONG" : alignedShort ? "SHORT" : null),
    blockers,
    warnings,
    entry_price: entryPrice,
    entry_price_source: entryPriceSource,
    checks: {
      aligned,
      in_corridor: inCorridor,
      corridor_aligned: corridorAlignedOK,
      entered_aligned: enteredAligned,
      trigger_ok: trigOk,
      squeeze_release: sqRelease,
      has_trigger: hasTrigger,
      rank,
      rank_min: minRank,
      rr_at_entry: rrAtEntry,
      rr_min: minRR,
      completion: comp,
      completion_max: maxComp,
      phase,
      phase_max: maxPhase,
    },
  };
}

// Get direction from state
function getTradeDirection(state) {
  const s = String(state || "");
  if (s.includes("BULL")) return "LONG";
  if (s.includes("BEAR")) return "SHORT";
  return null;
}

function computeTradePnlComponents(trade, tickerData) {
  const direction = String(trade?.direction || "").toUpperCase();
  const isLong = direction === "LONG";
  const entryPrice = Number(trade?.entryPrice);
  const currentPrice = Number(tickerData?.price ?? trade?.currentPrice);
  const shares = Number(trade?.shares);
  const pointValue = Number(trade?.pointValue) || 1;
  const trimmedPct = clamp(Number(trade?.trimmedPct || 0), 0, 1);
  const remainingPct = Math.max(0, 1 - trimmedPct);
  if (
    !Number.isFinite(entryPrice) ||
    !Number.isFinite(currentPrice) ||
    !Number.isFinite(shares)
  ) {
    return {
      pnl: null,
      pnlPct: null,
      realized: Number(trade?.realizedPnl || 0) || 0,
      unrealized: null,
    };
  }
  const dirSign = isLong ? 1 : -1;
  const unrealized =
    (currentPrice - entryPrice) * shares * pointValue * remainingPct * dirSign;
  const realized = Number(trade?.realizedPnl || 0) || 0;
  const pnl = realized + unrealized;
  const notional =
    Number(trade?.notional) ||
    (Number.isFinite(entryPrice) ? entryPrice * shares : null);
  const pnlPct =
    Number.isFinite(notional) && notional !== 0 ? (pnl / notional) * 100 : null;
  return { pnl, pnlPct, realized, unrealized };
}

// Helper: Score TP level for intelligent selection
function scoreTPLevel(tpLevel, entryPrice, direction, allTPs, horizonConfig) {
  const isLong = direction === "LONG";
  const price = Number(tpLevel.price || tpLevel);

  // Base score from confidence (0.60-0.85, normalize to 0-1)
  const confidence = Number(tpLevel.confidence || 0.75);
  let score = (confidence - 0.6) / (0.85 - 0.6); // Normalize to 0-1

  // Timeframe priority: Weekly > Daily > 4H
  const tf = String(tpLevel.timeframe || "D").toUpperCase();
  if (tf === "W") score += 0.3;
  else if (tf === "D") score += 0.2;
  else if (tf === "240" || tf === "4H") score += 0.1;

  // Type priority: STRUCTURE > ATR_FIB > LIQUIDITY > FVG > GAP
  const type = String(tpLevel.type || "ATR_FIB").toUpperCase();
  if (type === "STRUCTURE") score += 0.25;
  else if (type === "ATR_FIB") {
    // Boost key Fibonacci levels (61.8%, 100%, 161.8%)
    const mult = Number(tpLevel.multiplier || 0);
    if (mult === 0.618 || mult === 1.0 || mult === 1.618) score += 0.2;
    else if (mult === 0.382 || mult === 0.786 || mult === 1.236) score += 0.15;
    else score += 0.1;
  } else if (type === "LIQUIDITY") score += 0.15;
  else if (type === "FVG") score += 0.1;
  else if (type === "GAP") score += 0.05;

  // Distance from entry (use horizon-aware bands)
  const distancePct = Math.abs(price - entryPrice) / entryPrice;
  const bands = horizonConfig || {};
  const sweetMin = Number(bands.sweetMin ?? 0.02);
  const sweetMax = Number(bands.sweetMax ?? 0.05);
  const okMin = Number(bands.okMin ?? 0.01);
  const okMax = Number(bands.okMax ?? 0.08);
  const minDist = Number(bands.minDistancePct ?? 0.01);
  const tooFar = Number(bands.tooFarPct ?? 0.15);

  if (distancePct >= sweetMin && distancePct <= sweetMax) {
    score += 0.2; // Sweet spot
  } else if (distancePct >= okMin && distancePct <= okMax) {
    score += 0.1; // Acceptable range
  } else if (distancePct < minDist) {
    score -= 0.2; // Too close - penalize
  } else if (distancePct > tooFar) {
    score -= 0.1; // Too far - slight penalty
  }

  // Clustering penalty: if many TPs are very close, prefer ones that stand out
  const clusteringThreshold = entryPrice * 0.005; // 0.5% clustering threshold
  const nearbyTPs = allTPs.filter((tp) => {
    const tpPrice = Number(tp.price || tp);
    return Math.abs(tpPrice - price) < clusteringThreshold;
  }).length;

  if (nearbyTPs > 3) {
    score -= 0.15; // Heavy clustering penalty
  } else if (nearbyTPs > 1) {
    score -= 0.05; // Light clustering penalty
  }

  return score;
}

// Helper: Fuse many TP candidates into a few "confluence" TP zones.
// We cluster nearby TPs and return weighted centroids (still direction-safe).
function fuseTPCandidates(
  tpCandidates,
  entryPrice,
  direction,
  risk,
  horizonConfig,
) {
  if (!Array.isArray(tpCandidates) || tpCandidates.length === 0) return [];
  const isLong = direction === "LONG";

  // Cluster distance: a blend of % of entry and fraction of risk.
  // This keeps clustering stable across different price ranges.
  const clusterAbs = Math.max(entryPrice * 0.003, (Number(risk) || 0) * 0.25); // ~0.3% or 0.25R

  const items = tpCandidates
    .map((tp) => {
      const price = Number(tp?.price);
      if (!Number.isFinite(price) || price <= 0) return null;
      return { ...tp, price };
    })
    .filter(Boolean)
    .sort((a, b) => a.price - b.price);

  const tfPriority = (tf) => {
    const t = String(tf || "D").toUpperCase();
    if (t === "W") return 3;
    if (t === "D") return 2;
    if (t === "240" || t === "4H") return 1;
    return 0;
  };

  const clusters = [];
  for (const tp of items) {
    const s = scoreTPLevel(tp, entryPrice, direction, items, horizonConfig);
    const w = Math.max(0.1, 1 + s); // keep weights positive
    const last = clusters[clusters.length - 1];
    if (!last) {
      clusters.push({
        items: [{ tp, s, w }],
        min: tp.price,
        max: tp.price,
        sumW: w,
        sumWP: w * tp.price,
      });
      continue;
    }

    // Add to cluster if close to its current centroid (or within min/max band)
    const centroid = last.sumWP / Math.max(1e-9, last.sumW);
    const closeToCentroid = Math.abs(tp.price - centroid) <= clusterAbs;
    const closeToBand =
      tp.price >= last.min - clusterAbs && tp.price <= last.max + clusterAbs;

    if (closeToCentroid || closeToBand) {
      last.items.push({ tp, s, w });
      last.min = Math.min(last.min, tp.price);
      last.max = Math.max(last.max, tp.price);
      last.sumW += w;
      last.sumWP += w * tp.price;
    } else {
      clusters.push({
        items: [{ tp, s, w }],
        min: tp.price,
        max: tp.price,
        sumW: w,
        sumWP: w * tp.price,
      });
    }
  }

  const fused = clusters
    .map((c, idx) => {
      const price = c.sumWP / Math.max(1e-9, c.sumW);
      // Direction safety: ignore clusters that ended up on wrong side (paranoia)
      if (isLong && price <= entryPrice) return null;
      if (!isLong && price >= entryPrice) return null;

      const bestTf = c.items
        .map((x) => x.tp?.timeframe)
        .sort((a, b) => tfPriority(b) - tfPriority(a))[0];

      const confidences = c.items
        .map((x) => Number(x.tp?.confidence))
        .filter((n) => Number.isFinite(n));
      const confidence =
        confidences.length > 0
          ? Math.max(...confidences) // prefer the strongest member
          : 0.75;

      const sources = Array.from(
        new Set(
          c.items.map((x) => String(x.tp?.source || "").trim()).filter(Boolean),
        ),
      );
      const types = Array.from(
        new Set(
          c.items.map((x) => String(x.tp?.type || "").trim()).filter(Boolean),
        ),
      );

      // Confluence score: sum of member scores + small boost for multiple confirmations,
      // and a light penalty for a very wide cluster.
      const sumScore = c.items.reduce((acc, x) => acc + (x.s || 0), 0);
      const confluenceBoost = 0.2 * Math.log(1 + c.items.length);
      const spreadPct = (c.max - c.min) / Math.max(1e-9, entryPrice);
      const spreadPenalty = Math.min(0.2, spreadPct * 2); // cap penalty
      const fusedScore = sumScore + confluenceBoost - spreadPenalty;

      return {
        price,
        source:
          sources.length > 0
            ? `FUSED(${c.items.length}): ${sources.slice(0, 2).join(", ")}`
            : `FUSED(${c.items.length})`,
        type:
          types.length > 0 ? `FUSED:${types.slice(0, 2).join(",")}` : "FUSED",
        timeframe: bestTf || "D",
        confidence,
        multiplier: null,
        label: `TP_FUSED_${idx + 1}`,
        _fused: {
          idx,
          count: c.items.length,
          min: c.min,
          max: c.max,
          score: fusedScore,
        },
      };
    })
    .filter(Boolean)
    .sort((a, b) => (b._fused?.score || 0) - (a._fused?.score || 0));

  return fused;
}

// Helper: Build intelligent TP array with progressive trim levels (25%, 50%, 75%)
// This creates a systematic TP array that allows holding winners longer
function buildIntelligentTPArray(tickerData, entryPrice, direction) {
  const isLong = direction === "LONG";
  const sl = Number(tickerData.sl);

  if (!Number.isFinite(entryPrice) || !Number.isFinite(sl)) {
    return [];
  }

  // Calculate risk (distance from entry to SL)
  const risk = Math.abs(entryPrice - sl);
  if (risk <= 0) return [];

  // Horizon-aware settings (short vs swing vs positional)
  const bucketRaw = String(
    tickerData.horizon_bucket ||
      horizonBucketFromEtaDays(tickerData.eta_days_v2 ?? tickerData.eta_days) ||
      "",
  )
    .trim()
    .toUpperCase();
  const bucket = bucketRaw || "SWING";

  const horizonConfigMap = {
    SHORT_TERM: {
      minDistancePct: 0.05, // 5% min run-up before first trim (was 3%)
      sweetMin: 0.05,
      sweetMax: 0.12,
      okMin: 0.03,
      okMax: 0.18,
      tooFarPct: 0.25,
      minDistanceBetweenTPs: 0.04,
      maxTPs: 3,
      trimLevels: [0.2, 0.5, 1.0],
      fallbackMultipliers: [0.7, 1.0, 1.4],
    },
    SWING: {
      minDistancePct: 0.06, // 6% min run-up before first trim (was 4%)
      sweetMin: 0.08,
      sweetMax: 0.2,
      okMin: 0.05,
      okMax: 0.3,
      tooFarPct: 0.45,
      minDistanceBetweenTPs: 0.06,
      maxTPs: 4,
      trimLevels: [0.1, 0.25, 0.5, 1.0],
      fallbackMultipliers: [0.6, 1.0, 1.6],
    },
    POSITIONAL: {
      minDistancePct: 0.08, // 8% min run-up before first trim (was 6%)
      sweetMin: 0.15,
      sweetMax: 0.4,
      okMin: 0.1,
      okMax: 0.6,
      tooFarPct: 0.8,
      minDistanceBetweenTPs: 0.1,
      maxTPs: 4,
      trimLevels: [0.1, 0.25, 0.5, 1.0],
      fallbackMultipliers: [0.5, 1.0, 1.8],
    },
  };
  const horizonConfig = horizonConfigMap[bucket] || horizonConfigMap.SWING;

  // Extract all TP levels with metadata
  let tpLevels = [];
  if (
    tickerData.tp_levels &&
    Array.isArray(tickerData.tp_levels) &&
    tickerData.tp_levels.length > 0
  ) {
    tpLevels = tickerData.tp_levels
      .map((tpItem) => {
        if (typeof tpItem === "object" && tpItem !== null) {
          return {
            price: Number(tpItem.price),
            source: tpItem.source || "ATR Level",
            type: tpItem.type || "ATR_FIB",
            timeframe: tpItem.timeframe || "D",
            confidence: Number(tpItem.confidence || 0.75),
            multiplier: tpItem.multiplier ? Number(tpItem.multiplier) : null,
            label: tpItem.label || "TP",
          };
        }
        return {
          price: Number(tpItem),
          source: "ATR Level",
          type: "ATR_FIB",
          timeframe: "D",
          confidence: 0.75,
          multiplier: null,
          label: "TP",
        };
      })
      .filter((item) => Number.isFinite(item.price) && item.price > 0);
  }

  // Add primary TP if valid
  const primaryTP = Number(tickerData.tp);
  if (Number.isFinite(primaryTP) && primaryTP > 0) {
    tpLevels.push({
      price: primaryTP,
      source: "Primary TP",
      type: "ATR_FIB",
      timeframe: "D",
      confidence: 0.75,
      multiplier: null,
      label: "TP",
    });
  }

  // Filter by direction and ensure they're beyond entry
  // Also filter out TPs that are too close - these are likely noise
  const minDistancePct = horizonConfig.minDistancePct;
  const validTPs = tpLevels
    .filter((item) => {
      const price = Number(item.price);
      if (!Number.isFinite(price) || price <= 0) return false;

      // Direction check
      const directionValid = isLong ? price > entryPrice : price < entryPrice;
      if (!directionValid) return false;

      // Distance check - filter out TPs too close to entry
      const distancePct = Math.abs(price - entryPrice) / entryPrice;
      if (distancePct < minDistancePct) return false;

      return true;
    })
    .sort((a, b) => {
      // Sort by distance from entry (closest first for LONG, furthest first for SHORT)
      const distA = Math.abs(a.price - entryPrice);
      const distB = Math.abs(b.price - entryPrice);
      return isLong ? distA - distB : distB - distA;
    });

  if (validTPs.length === 0) {
    // Fallback: create basic TP array from primary TP, enforcing min run-up
    if (Number.isFinite(primaryTP) && primaryTP > 0) {
      const rawDist = Math.abs(primaryTP - entryPrice) / entryPrice;
      const minRun = horizonConfig.minDistancePct;
      const scale = rawDist >= minRun ? 1 : minRun / Math.max(rawDist, 0.001);
      const baseDist = Math.abs(primaryTP - entryPrice) * scale;
      const tp1 = isLong
        ? entryPrice + baseDist
        : entryPrice - baseDist;
      const tp2 = isLong
        ? entryPrice + baseDist * 1.5
        : entryPrice - baseDist * 1.5;
      const tp3 = isLong
        ? entryPrice + baseDist * 2.0
        : entryPrice - baseDist * 2.0;

      return [
        { price: tp1, trimPct: 0.25, label: "TP1 (25%)" },
        { price: tp2, trimPct: 0.5, label: "TP2 (50%)" },
        { price: tp3, trimPct: 0.75, label: "TP3 (75%)" },
      ];
    }
    return [];
  }

  // Fuse raw TP candidates into a few "confluence" zones, then score those fused zones.
  // This prevents overreacting to noisy/clustered TP sets and yields more stable trim levels.
  const fusedTPs = fuseTPCandidates(
    validTPs,
    entryPrice,
    direction,
    risk,
    horizonConfig,
  );
  const baseForScoring = fusedTPs.length > 0 ? fusedTPs : validTPs;

  // Score all candidates (fused preferred; otherwise raw)
  const scoredTPs = baseForScoring.map((tpItem) => ({
    ...tpItem,
    score:
      tpItem && tpItem._fused && typeof tpItem._fused.score === "number"
        ? tpItem._fused.score
        : scoreTPLevel(tpItem, entryPrice, direction, validTPs, horizonConfig),
  }));

  // Prioritize HTF timeframes (Weekly/Daily) - these should be further away and more reliable
  // Sort by: HTF timeframe first, then by score
  scoredTPs.sort((a, b) => {
    const tfA = String(a.timeframe || "D").toUpperCase();
    const tfB = String(b.timeframe || "D").toUpperCase();

    // HTF priority: W > D > 4H > others
    const htfPriority = (tf) => {
      if (tf === "W") return 3;
      if (tf === "D") return 2;
      if (tf === "240" || tf === "4H") return 1;
      return 0;
    };

    const priorityA = htfPriority(tfA);
    const priorityB = htfPriority(tfB);

    // If same HTF priority, sort by score
    if (priorityA === priorityB) {
      return b.score - a.score;
    }

    // Higher HTF priority first
    return priorityB - priorityA;
  });

  // Build intelligent TP array with progressive trim levels
  // Strategy: Prioritize HTF timeframes (Weekly/Daily) and select 3-4 TPs that are well-spaced
  const selectedTPs = [];
  const minDistanceBetweenTPs = horizonConfig.minDistanceBetweenTPs;
  const maxTPs = horizonConfig.maxTPs;

  // First pass: Prioritize HTF timeframes (W, D) - these are more reliable and further away
  const htfTPs = scoredTPs.filter((tp) => {
    const tf = String(tp.timeframe || "D").toUpperCase();
    return tf === "W" || tf === "D";
  });

  // Second pass: If we don't have enough HTF TPs, add lower timeframe TPs
  const allTPsToConsider = htfTPs.length >= 3 ? htfTPs : scoredTPs;

  for (const tp of allTPsToConsider) {
    if (selectedTPs.length >= maxTPs) break;

    // Check if this TP is far enough from already selected TPs
    const tooClose = selectedTPs.some((selected) => {
      const distancePct = Math.abs(tp.price - selected.price) / entryPrice;
      return distancePct < minDistanceBetweenTPs;
    });

    if (!tooClose) {
      selectedTPs.push(tp);
    }
  }

  // If we don't have enough TPs, fill gaps intelligently
  if (selectedTPs.length < 3) {
    // Use top scored TPs and create intermediate levels
    const topTP = scoredTPs[0];
    if (topTP) {
      const baseDistance = Math.abs(topTP.price - entryPrice);
      const [m1, m2, m3] = horizonConfig.fallbackMultipliers || [0.6, 1.0, 1.5];

      // Create TP1 (closest)
      const tp1 = isLong
        ? entryPrice + baseDistance * m1
        : entryPrice - baseDistance * m1;

      // TP2 (middle) - use top scored TP
      const tp2 = topTP.price;

      // TP3 (farthest)
      const tp3 = isLong
        ? entryPrice + baseDistance * m3
        : entryPrice - baseDistance * m3;

      const trims = horizonConfig.trimLevels || [0.25, 0.5, 0.75];
      return [
        {
          price: tp1,
          trimPct: trims[0] || 0.25,
          label: `TP1 (${Math.round((trims[0] || 0.25) * 100)}%)`,
          source: topTP.source,
          timeframe: topTP.timeframe,
        },
        {
          price: tp2,
          trimPct: trims[1] || 0.5,
          label: `TP2 (${Math.round((trims[1] || 0.5) * 100)}%)`,
          source: topTP.source,
          timeframe: topTP.timeframe,
        },
        {
          price: tp3,
          trimPct: trims[2] || 0.75,
          label: `TP3 (${Math.round((trims[2] || 0.75) * 100)}%)`,
          source: topTP.source,
          timeframe: topTP.timeframe,
        },
      ];
    }
  }

  // Assign trim percentages to selected TPs
  // Closest TP = 25%, Middle = 50%, Farthest = 75%
  const sortedByDistance = [...selectedTPs].sort((a, b) => {
    const distA = Math.abs(a.price - entryPrice);
    const distB = Math.abs(b.price - entryPrice);
    return distA - distB;
  });

  const trimLevels = horizonConfig.trimLevels || [0.25, 0.5, 0.75];
  const tpArray = sortedByDistance.slice(0, 3).map((tp, idx) => ({
    price: tp.price,
    trimPct: trimLevels[idx] || 0.75,
    label: `TP${idx + 1} (${Math.round(trimLevels[idx] * 100)}%)`,
    source: tp.source,
    timeframe: tp.timeframe,
    confidence: tp.confidence,
  }));

  // If we have a 4th TP, add it as final exit
  if (sortedByDistance.length > 3 && trimLevels[3] != null) {
    const finalTP = sortedByDistance[3];
    tpArray.push({
      price: finalTP.price,
      trimPct: trimLevels[3],
      label: `TP4 (${Math.round(trimLevels[3] * 100)}%)`,
      source: finalTP.source,
      timeframe: finalTP.timeframe,
      confidence: finalTP.confidence,
    });
  }

  return tpArray;
}

// Helper: Get intelligent TP (best single or weighted blend) - for backward compatibility
function getIntelligentTP(tickerData, entryPrice, direction) {
  // Build TP array and return the first TP (25% trim level) as the primary TP
  const tpArray = buildIntelligentTPArray(tickerData, entryPrice, direction);
  if (tpArray.length > 0) {
    return tpArray[0].price;
  }

  // Fallback to original logic
  return getValidTP(tickerData, entryPrice, direction);
}

// Helper: Get valid TP based on direction and entry price (fallback)
function getValidTP(tickerData, entryPrice, direction) {
  const isLong = direction === "LONG";

  // Get TP from tickerData
  let tp = Number(tickerData.tp);

  // If tp_levels exists, extract all valid TP prices
  let tpPrices = [];
  if (
    tickerData.tp_levels &&
    Array.isArray(tickerData.tp_levels) &&
    tickerData.tp_levels.length > 0
  ) {
    tpPrices = tickerData.tp_levels
      .map((tpItem) => {
        if (
          typeof tpItem === "object" &&
          tpItem !== null &&
          tpItem.price != null
        ) {
          return Number(tpItem.price);
        }
        return typeof tpItem === "number" ? Number(tpItem) : null;
      })
      .filter((p) => Number.isFinite(p) && p > 0);
  }

  // Add the primary TP if it's valid
  if (Number.isFinite(tp) && tp > 0) {
    tpPrices.push(tp);
  }

  // Remove duplicates and sort
  tpPrices = [...new Set(tpPrices)].sort((a, b) => a - b);

  // Find first valid TP based on direction
  if (isLong) {
    // For LONG: TP must be above entry price
    const validTPs = tpPrices.filter((p) => p > entryPrice);
    if (validTPs.length > 0) {
      return validTPs[0]; // Return first (lowest) valid TP above entry
    }
    // If no valid TP found, check if primary TP is valid
    if (Number.isFinite(tp) && tp > entryPrice) {
      return tp;
    }
    // Fallback: use highest TP from levels (might still be invalid, but better than nothing)
    if (tpPrices.length > 0) {
      console.warn(
        `[TP VALIDATION] ⚠️ ${
          tickerData.ticker || "UNKNOWN"
        } LONG: No TP above entry $${entryPrice.toFixed(
          2,
        )}. Using highest TP: $${Math.max(...tpPrices).toFixed(2)}`,
      );
      return Math.max(...tpPrices);
    }
  } else {
    // For SHORT: TP must be below entry price
    const validTPs = tpPrices.filter((p) => p < entryPrice);
    if (validTPs.length > 0) {
      return validTPs[validTPs.length - 1]; // Return last (highest) valid TP below entry
    }
    // If no valid TP found, check if primary TP is valid
    if (Number.isFinite(tp) && tp < entryPrice) {
      return tp;
    }
    // Fallback: use lowest TP from levels
    if (tpPrices.length > 0) {
      console.warn(
        `[TP VALIDATION] ⚠️ ${
          tickerData.ticker || "UNKNOWN"
        } SHORT: No TP below entry $${entryPrice.toFixed(
          2,
        )}. Using lowest TP: $${Math.min(...tpPrices).toFixed(2)}`,
      );
      return Math.min(...tpPrices);
    }
  }

  // Last resort: return primary TP even if invalid
  if (Number.isFinite(tp) && tp > 0) {
    console.warn(
      `[TP VALIDATION] ⚠️ ${
        tickerData.ticker || "UNKNOWN"
      } ${direction}: Using invalid TP $${tp.toFixed(
        2,
      )} (entry: $${entryPrice.toFixed(2)})`,
    );
    return tp;
  }

  return null;
}

// Calculate RR at entry price (for trade creation) using intelligent TP array
function calculateRRAtEntry(tickerData, entryPrice) {
  const direction = getTradeDirection(tickerData.state);
  const sl = Number(tickerData.sl);

  if (!Number.isFinite(entryPrice) || !Number.isFinite(sl)) {
    return null;
  }

  // Build intelligent TP array and use max TP for RR calculation
  const tpArray = buildIntelligentTPArray(tickerData, entryPrice, direction);

  let maxTP = null;
  if (tpArray.length > 0) {
    // Use the highest TP from the array (farthest target)
    maxTP = Math.max(...tpArray.map((tp) => tp.price));
  } else {
    // Fallback to single TP
    const tp = getIntelligentTP(tickerData, entryPrice, direction);
    if (!Number.isFinite(tp)) return null;
    maxTP = tp;
  }

  const state = String(tickerData.state || "");
  const isLong = state.includes("BULL");
  const isShort = state.includes("BEAR");

  let risk, gain;

  if (isLong) {
    risk = entryPrice - sl; // Risk from entry to SL
    gain = maxTP - entryPrice; // Gain from entry to max TP
  } else if (isShort) {
    risk = sl - entryPrice; // Risk from entry to SL
    gain = entryPrice - maxTP; // Gain from entry to max TP
  } else {
    risk = Math.abs(entryPrice - sl);
    gain = Math.abs(maxTP - entryPrice);
  }

  if (risk <= 0 || gain <= 0) return null;
  return gain / risk;
}

// Calculate trade P&L and status with progressive TP trimming (25%, 50%, 75%)
function calculateTradePnl(tickerData, entryPrice, existingTrade = null) {
  const direction = getTradeDirection(tickerData.state);
  if (!direction) return null;

  const sl = Number(tickerData.sl);
  const currentPrice = Number(tickerData.price);

  if (!Number.isFinite(sl) || !Number.isFinite(currentPrice)) {
    return null;
  }

  // Market is closed on weekends — never execute TP trims/exits on Sat/Sun.
  // (We still allow SL evaluation to be conservative.)
  const weekendNow = isNyWeekend(Date.now());

  const ticker = String(tickerData.ticker || "").toUpperCase();
  const isFutures = FUTURES_SPECS[ticker] || ticker.endsWith("1!");

  // For futures: trade 1 contract, calculate P&L based on point value
  // For stocks: calculate shares based on dollar amount
  let shares;
  let pointValue = 1; // Default for stocks (price per share)

  if (isFutures && FUTURES_SPECS[ticker]) {
    // Futures: always trade 1 contract
    shares = 1;
    pointValue = FUTURES_SPECS[ticker].pointValue;
  } else {
    // Stocks: calculate shares from dollar amount
    shares = TRADE_SIZE / entryPrice;
  }

  // Get or build intelligent TP array
  let tpArray = existingTrade?.tpArray || [];
  if (tpArray.length === 0) {
    // Build TP array if not stored in trade
    tpArray = buildIntelligentTPArray(tickerData, entryPrice, direction);
  }

  // Defensive: If an entry price was corrected after the trade was created,
  // an older stored tpArray may no longer be on the profit side (e.g. TP < entry for LONG),
  // which can cause "TP trims" at a loss. Filter + rebuild if needed.
  const isLong = direction === "LONG";
  const minDistancePct = 0.01; // keep consistent with buildIntelligentTPArray
  const isProfitSide = (tpPrice) =>
    isLong
      ? tpPrice > entryPrice &&
        (tpPrice - entryPrice) / entryPrice >= minDistancePct
      : tpPrice < entryPrice &&
        (entryPrice - tpPrice) / entryPrice >= minDistancePct;

  const sanitizedTpArray = Array.isArray(tpArray)
    ? tpArray
        .map((tp) => ({
          ...tp,
          price: Number(tp?.price),
          trimPct: Number(tp?.trimPct),
          label: tp?.label,
        }))
        .filter(
          (tp) =>
            Number.isFinite(tp.price) &&
            Number.isFinite(tp.trimPct) &&
            tp.trimPct > 0 &&
            tp.trimPct <= 1 &&
            isProfitSide(tp.price),
        )
        .sort((a, b) => (a.trimPct || 0) - (b.trimPct || 0))
    : [];

  // If the stored TP plan becomes invalid after entry corrections, rebuild it.
  if (sanitizedTpArray.length === 0) {
    const rebuilt = buildIntelligentTPArray(tickerData, entryPrice, direction);
    if (Array.isArray(rebuilt) && rebuilt.length > 0) {
      tpArray = rebuilt;
    } else {
      tpArray = [];
    }
  } else {
    tpArray = sanitizedTpArray;
  }

  // Fallback to single TP if array is empty
  const fallbackTP =
    existingTrade?.tp || getIntelligentTP(tickerData, entryPrice, direction);
  if (tpArray.length === 0 && Number.isFinite(fallbackTP)) {
    tpArray = [{ price: fallbackTP, trimPct: 0.5, label: "TP (50%)" }];
  }

  const trimmedPct = existingTrade ? existingTrade.trimmedPct || 0 : 0;

  // Check which TP levels have been hit (sorted by trim percentage)
  const hitTPLevels = [];
  for (const tpLevel of tpArray) {
    const tpPrice = Number(tpLevel.price);
    if (!Number.isFinite(tpPrice)) continue;

    const hit = isLong ? currentPrice >= tpPrice : currentPrice <= tpPrice;
    if (hit) {
      hitTPLevels.push({
        ...tpLevel,
        price: tpPrice,
      });
    }
  }

  // Sort hit TPs by trim percentage (ascending)
  hitTPLevels.sort((a, b) => (a.trimPct || 0) - (b.trimPct || 0));

  // Check SL hit
  const hitSL = isLong ? currentPrice <= sl : currentPrice >= sl;

  let pnl = 0;
  let pnlPct = 0;
  let status = "OPEN";
  let newTrimmedPct = trimmedPct;
  let realizedPnl = 0; // P&L from trimmed portions

  if (hitSL) {
    // Stop Loss hit - close entire remaining position
    const slDiff = isLong ? sl - entryPrice : entryPrice - sl;

    // Calculate realized P&L from any previous trims
    for (const tpLevel of hitTPLevels) {
      const levelTrimPct = tpLevel.trimPct || 0;
      if (levelTrimPct <= trimmedPct) {
        const tpDiff = isLong
          ? tpLevel.price - entryPrice
          : entryPrice - tpLevel.price;
        // Only count the portion that was actually trimmed
        const alreadyCountedPct = Math.min(levelTrimPct, trimmedPct);
        realizedPnl += tpDiff * shares * pointValue * alreadyCountedPct;
      }
    }

    // Final P&L = realized from trims + remaining position at SL
    const remainingPct = 1 - trimmedPct;
    const remainingPnl = slDiff * shares * pointValue * remainingPct;
    pnl = realizedPnl + remainingPnl;
    pnlPct = ((sl - entryPrice) / entryPrice) * 100;
    status = "LOSS";
    return {
      shares,
      pnl,
      pnlPct,
      status,
      currentPrice,
      trimmedPct: trimmedPct,
      tpArray,
      exitPrice: sl,
      exitReason: "SL",
      exitCategory: "INVALIDATION",
    };
  } else if (hitTPLevels.length > 0 && !weekendNow) {
    // One or more TP levels hit - determine next trim action
    // Find the highest TP level hit that we haven't trimmed yet
    let nextTrimTP = null;
    for (const tpLevel of hitTPLevels) {
      const levelTrimPct = tpLevel.trimPct || 0;
      if (levelTrimPct > trimmedPct) {
        nextTrimTP = tpLevel;
        break; // Take the first (lowest) untrimmed TP
      }
    }

    if (nextTrimTP) {
      // Need to trim at this TP level
      const targetTrimPct = nextTrimTP.trimPct || 0.5;
      const trimAmount = targetTrimPct - trimmedPct;
      const tpDiff = isLong
        ? nextTrimTP.price - entryPrice
        : entryPrice - nextTrimTP.price;

      // Calculate realized P&L from all previous trims (including intermediate levels)
      for (const tpLevel of hitTPLevels) {
        const levelTrimPct = tpLevel.trimPct || 0;
        if (levelTrimPct < targetTrimPct && levelTrimPct > trimmedPct) {
          // Intermediate TP hit - calculate P&L for the portion between previous trim and this level
          const levelTpDiff = isLong
            ? tpLevel.price - entryPrice
            : entryPrice - tpLevel.price;
          const intermediateTrimAmount = levelTrimPct - trimmedPct;
          realizedPnl +=
            levelTpDiff * shares * pointValue * intermediateTrimAmount;
        }
      }

      // Calculate P&L from this trim
      const trimPnl = tpDiff * shares * pointValue * trimAmount;
      const trimPnlPct = ((nextTrimTP.price - entryPrice) / entryPrice) * 100;

      // If we've trimmed 100%, close the trade
      if (targetTrimPct >= 1.0) {
        // Full exit - calculate total P&L
        const totalRealizedPnl = realizedPnl + trimPnl;
        return {
          shares,
          pnl: totalRealizedPnl,
          pnlPct: trimPnlPct,
          status: totalRealizedPnl >= 0 ? "WIN" : "LOSS",
          currentPrice,
          trimmedPct: 1.0,
          tpArray,
          exitPrice: nextTrimTP.price,
          exitReason: "TP_FULL",
          exitCategory: "PROFIT_MANAGEMENT",
          trimPrice: nextTrimTP.price,
          trimTargetPct: targetTrimPct,
          trimDeltaPct: trimAmount,
        };
      }

      // Partial trim - return with new trimmed percentage
      return {
        shares,
        pnl: realizedPnl + trimPnl,
        pnlPct: trimPnlPct,
        status: "TP_HIT_TRIM",
        currentPrice,
        trimmedPct: targetTrimPct,
        tpArray, // Store TP array for next check
        decisionCategory: "PROFIT_MANAGEMENT",
        trimPrice: nextTrimTP.price,
        trimTargetPct: targetTrimPct,
        trimDeltaPct: trimAmount,
      };
    } else {
      // Already trimmed at all hit TP levels - check if we should hold winners
      // Calculate current price vs entry
      const priceDiff = isLong
        ? currentPrice - entryPrice
        : entryPrice - currentPrice;
      const priceDiffPct = (priceDiff / entryPrice) * 100;

      // Calculate realized P&L from all trims
      for (const tpLevel of hitTPLevels) {
        const levelTrimPct = tpLevel.trimPct || 0;
        if (levelTrimPct <= trimmedPct) {
          const levelTpDiff = isLong
            ? tpLevel.price - entryPrice
            : entryPrice - tpLevel.price;
          // Count the portion that was actually trimmed
          const trimmedAtThisLevel = Math.min(levelTrimPct, trimmedPct);
          const prevTrimmedPct = hitTPLevels
            .filter((tp) => (tp.trimPct || 0) < levelTrimPct)
            .reduce((sum, tp) => Math.max(sum, tp.trimPct || 0), 0);
          const trimAmount = trimmedAtThisLevel - prevTrimmedPct;
          if (trimAmount > 0) {
            realizedPnl += levelTpDiff * shares * pointValue * trimAmount;
          }
        }
      }

      // Check if we should hold winners (price above 4H 8-13 EMA cloud)
      // Use 4H EMA cloud position if available, otherwise fallback to price momentum
      let shouldHold = false;
      const fourHEMACloud = tickerData.fourh_ema_cloud;

      if (fourHEMACloud && fourHEMACloud.position) {
        // Use 4H EMA cloud position for hold decision
        if (isLong) {
          // For LONG: hold if price is above the 4H EMA cloud
          shouldHold = fourHEMACloud.position === "above" && trimmedPct < 1.0;
        } else {
          // For SHORT: hold if price is below the 4H EMA cloud
          shouldHold = fourHEMACloud.position === "below" && trimmedPct < 1.0;
        }
      } else {
        // Fallback: use price momentum and profit threshold
        // Hold if: price is significantly above entry (>2%) and we haven't trimmed everything
        shouldHold = priceDiffPct > 2.0 && trimmedPct < 1.0;
      }

      if (shouldHold) {
        // Hold remaining position - calculate unrealized P&L
        const remainingPct = 1 - trimmedPct;
        const unrealizedPnl = priceDiff * shares * pointValue * remainingPct;

        return {
          shares,
          pnl: realizedPnl + unrealizedPnl,
          pnlPct: priceDiffPct,
          status: "OPEN", // Still holding
          currentPrice,
          trimmedPct,
          tpArray,
          exitReason: null,
          decisionCategory: "PROFIT_MANAGEMENT",
        };
      }

      // Not holding - calculate current P&L
      const remainingPct = 1 - trimmedPct;
      const currentPnl = priceDiff * shares * pointValue * remainingPct;

      return {
        shares,
        pnl: realizedPnl + currentPnl,
        pnlPct: priceDiffPct,
        status: "OPEN",
        currentPrice,
        trimmedPct,
        tpArray,
        exitReason: null,
        decisionCategory: "PROFIT_MANAGEMENT",
      };
    }
  } else {
    // No TP hit yet - calculate unrealized P&L
    const priceDiff = isLong
      ? currentPrice - entryPrice
      : entryPrice - currentPrice;
    const remainingPct = 1 - trimmedPct;
    pnl = priceDiff * shares * pointValue * remainingPct;
    pnlPct = ((currentPrice - entryPrice) / entryPrice) * 100;

    // Add realized P&L from any previous trims (shouldn't happen if no TP hit, but handle edge case)
    if (trimmedPct > 0 && hitTPLevels.length > 0) {
      // Estimate realized P&L based on highest TP hit
      const highestTP = hitTPLevels[hitTPLevels.length - 1];
      const tpDiff = isLong
        ? highestTP.price - entryPrice
        : entryPrice - highestTP.price;
      realizedPnl = tpDiff * shares * pointValue * trimmedPct;
      pnl += realizedPnl;
    }

    status = "OPEN";
  }

  return {
    shares,
    pnl,
    pnlPct,
    status,
    currentPrice,
    trimmedPct: newTrimmedPct,
    tpArray,
    exitReason: null,
  };
}

// Pattern Recognition: Analyze winning patterns from trade history
function analyzeWinningPatterns(tradeHistory, currentTickers) {
  if (!tradeHistory || tradeHistory.length === 0) {
    return { summary: "No trade history available for pattern analysis" };
  }

  const wins = tradeHistory.filter((t) => t.status === "WIN");
  const losses = tradeHistory.filter((t) => t.status === "LOSS");
  const winRate = wins.length / tradeHistory.length;

  // Analyze by rank ranges
  const rankPatterns = {};
  tradeHistory.forEach((t) => {
    const rank = Math.floor((t.rank || 0) / 10) * 10; // Group by 10s
    const key = `Rank ${rank}-${rank + 9}`;
    if (!rankPatterns[key]) {
      rankPatterns[key] = { wins: 0, losses: 0, totalPnl: 0 };
    }
    if (t.status === "WIN") rankPatterns[key].wins++;
    if (t.status === "LOSS") rankPatterns[key].losses++;
    rankPatterns[key].totalPnl += t.pnl || 0;
  });

  // Analyze by RR ranges
  const rrPatterns = {};
  tradeHistory.forEach((t) => {
    const rr = t.rr || 0;
    let range = "Unknown";
    if (rr >= 2.0) range = "RR ≥ 2.0";
    else if (rr >= 1.5) range = "RR 1.5-2.0";
    else if (rr >= 1.0) range = "RR 1.0-1.5";
    else if (rr > 0) range = "RR < 1.0";

    if (!rrPatterns[range]) {
      rrPatterns[range] = { wins: 0, losses: 0, totalPnl: 0 };
    }
    if (t.status === "WIN") rrPatterns[range].wins++;
    if (t.status === "LOSS") rrPatterns[range].losses++;
    rrPatterns[range].totalPnl += t.pnl || 0;
  });

  // Find best performing patterns
  const bestRankPattern = Object.entries(rankPatterns)
    .filter(([_, stats]) => stats.wins + stats.losses >= 3)
    .sort((a, b) => {
      const aRate = a[1].wins / (a[1].wins + a[1].losses || 1);
      const bRate = b[1].wins / (b[1].wins + b[1].losses || 1);
      return bRate - aRate;
    })[0];

  const bestRRPattern = Object.entries(rrPatterns)
    .filter(([_, stats]) => stats.wins + stats.losses >= 3)
    .sort((a, b) => {
      const aRate = a[1].wins / (a[1].wins + a[1].losses || 1);
      const bRate = b[1].wins / (b[1].wins + b[1].losses || 1);
      return bRate - aRate;
    })[0];

  // Match current tickers to winning patterns
  const matchingSetups = currentTickers.filter((t) => {
    if (!bestRankPattern || !bestRRPattern) return false;
    const rankRange = bestRankPattern[0];
    const rrRange = bestRRPattern[0];
    const tickerRank = Math.floor((t.rank || 0) / 10) * 10;
    const rankMatch = rankRange.includes(`Rank ${tickerRank}`);
    const rrMatch =
      (rrRange === "RR ≥ 2.0" && t.rr >= 2.0) ||
      (rrRange === "RR 1.5-2.0" && t.rr >= 1.5 && t.rr < 2.0) ||
      (rrRange === "RR 1.0-1.5" && t.rr >= 1.0 && t.rr < 1.5);
    return rankMatch && rrMatch;
  });

  return {
    summary: `Analyzed ${tradeHistory.length} trades. Win rate: ${(
      winRate * 100
    ).toFixed(1)}%. Best pattern: ${bestRankPattern?.[0] || "N/A"} with ${
      bestRRPattern?.[0] || "N/A"
    } RR. ${matchingSetups.length} current setups match winning patterns.`,
    bestRankPattern: bestRankPattern?.[0] || null,
    bestRRPattern: bestRRPattern?.[0] || null,
    matchingSetups: matchingSetups.slice(0, 5).map((t) => t.ticker),
    winRate: winRate,
  };
}

// Proactive Alert Generation: Detect conditions requiring attention
function generateProactiveAlerts(allTickers, allTrades) {
  const alerts = [];
  const now = Date.now();

  // Get open trades
  const openTrades = allTrades.filter(
    (t) => t.status === "OPEN" || t.status === "TP_HIT_TRIM",
  );

  // Alert 1: Positions approaching TP (within 2% of TP)
  openTrades.forEach((trade) => {
    const currentPrice = Number(trade.currentPrice || trade.entryPrice || 0);
    const tp = Number(trade.tp || 0);
    const sl = Number(trade.sl || 0);
    const entryPrice = Number(trade.entryPrice || 0);
    const direction = trade.direction || "LONG";

    if (tp > 0 && currentPrice > 0 && sl > 0 && entryPrice > 0) {
      let distanceToTP = 0;
      let pctToTP = 0;

      if (direction === "LONG") {
        distanceToTP = tp - currentPrice;
        const totalDistance = tp - entryPrice;
        pctToTP = totalDistance > 0 ? (distanceToTP / totalDistance) * 100 : 0;
      } else {
        distanceToTP = currentPrice - tp;
        const totalDistance = entryPrice - tp;
        pctToTP = totalDistance > 0 ? (distanceToTP / totalDistance) * 100 : 0;
      }

      if (pctToTP > 0 && pctToTP <= 5) {
        alerts.push({
          type: "TP_APPROACHING",
          priority: "high",
          ticker: trade.ticker,
          message: `${trade.ticker} is within ${pctToTP.toFixed(
            1,
          )}% of TP ($${tp.toFixed(2)}). Current: $${currentPrice.toFixed(
            2,
          )}. Consider trimming 50% at TP.`,
          currentPrice,
          tp,
          pctToTP,
        });
      }
    }
  });

  // Alert 2: Positions approaching SL (within 2% of SL)
  openTrades.forEach((trade) => {
    const currentPrice = Number(trade.currentPrice || trade.entryPrice || 0);
    const sl = Number(trade.sl || 0);
    const entryPrice = Number(trade.entryPrice || 0);
    const direction = trade.direction || "LONG";

    if (sl > 0 && currentPrice > 0 && entryPrice > 0) {
      let distanceToSL = 0;
      let pctToSL = 0;

      if (direction === "LONG") {
        distanceToSL = currentPrice - sl;
        const totalDistance = entryPrice - sl;
        pctToSL = totalDistance > 0 ? (distanceToSL / totalDistance) * 100 : 0;
      } else {
        distanceToSL = sl - currentPrice;
        const totalDistance = sl - entryPrice;
        pctToSL = totalDistance > 0 ? (distanceToSL / totalDistance) * 100 : 0;
      }

      if (pctToSL > 0 && pctToSL <= 5) {
        alerts.push({
          type: "SL_APPROACHING",
          priority: "high",
          ticker: trade.ticker,
          message: `⚠️ ${trade.ticker} is within ${pctToSL.toFixed(
            1,
          )}% of SL ($${sl.toFixed(2)}). Current: $${currentPrice.toFixed(
            2,
          )}. Monitor closely.`,
          currentPrice,
          sl,
          pctToSL,
        });
      }
    }
  });

  // Alert 3: High completion positions (should trim/exit)
  allTickers.forEach((ticker) => {
    const matchingTrade = openTrades.find((t) => t.ticker === ticker.ticker);
    if (matchingTrade && ticker.completion > 0.8) {
      alerts.push({
        type: "HIGH_COMPLETION",
        priority: "medium",
        ticker: ticker.ticker,
        message: `${ticker.ticker} has reached ${(
          ticker.completion * 100
        ).toFixed(
          0,
        )}% completion. Consider trimming 50-75% to lock in profits.`,
        completion: ticker.completion,
      });
    }
  });

  // Alert 4: Late phase positions (risk of reversal)
  allTickers.forEach((ticker) => {
    const matchingTrade = openTrades.find((t) => t.ticker === ticker.ticker);
    if (matchingTrade && ticker.phase_pct > 0.75) {
      alerts.push({
        type: "LATE_PHASE",
        priority: "medium",
        ticker: ticker.ticker,
        message: `${ticker.ticker} is in late phase (${(
          ticker.phase_pct * 100
        ).toFixed(
          0,
        )}%). Risk of reversal increasing. Consider trimming or tightening stops.`,
        phasePct: ticker.phase_pct,
      });
    }
  });

  // Alert 5: New prime setups emerging
  const newPrimeSetups = allTickers.filter(
    (t) =>
      t.rank >= 75 &&
      t.rr >= 1.5 &&
      t.completion < 0.4 &&
      t.phase_pct < 0.6 &&
      !openTrades.find((ot) => ot.ticker === t.ticker),
  );

  if (newPrimeSetups.length > 0) {
    alerts.push({
      type: "NEW_OPPORTUNITY",
      priority: "high",
      ticker: "MULTIPLE",
      message: `🎯 ${
        newPrimeSetups.length
      } new prime setups detected: ${newPrimeSetups
        .slice(0, 5)
        .map((t) => t.ticker)
        .join(", ")}. Consider monitoring for entry.`,
      setups: newPrimeSetups.slice(0, 5).map((t) => ({
        ticker: t.ticker,
        rank: t.rank,
        rr: t.rr,
      })),
    });
  }

  // Alert 6: Momentum Elite opportunities
  const momentumEliteSetups = allTickers.filter(
    (t) =>
      t.flags?.momentum_elite &&
      t.rank >= 70 &&
      !openTrades.find((ot) => ot.ticker === t.ticker),
  );

  if (momentumEliteSetups.length > 0) {
    alerts.push({
      type: "MOMENTUM_ELITE",
      priority: "high",
      ticker: "MULTIPLE",
      message: `🚀 ${
        momentumEliteSetups.length
      } Momentum Elite setups available: ${momentumEliteSetups
        .slice(0, 5)
        .map((t) => t.ticker)
        .join(", ")}. High-quality opportunities.`,
      setups: momentumEliteSetups.slice(0, 5).map((t) => ({
        ticker: t.ticker,
        rank: t.rank,
        rr: t.rr,
      })),
    });
  }

  // Sort by priority (high first) and return
  return alerts.sort((a, b) => {
    const priorityOrder = { high: 3, medium: 2, low: 1 };
    return priorityOrder[b.priority] - priorityOrder[a.priority];
  });
}

// Process trade simulation for a ticker (called on ingest)
// options.replayBatchContext: { allTrades } - use pre-loaded trades, skip KV reads/writes for trades+exec (replay perf)
async function processTradeSimulation(
  KV,
  ticker,
  tickerData,
  prevData,
  env = null,
  options = {},
) {
  const forceUseIngestTs = !!options?.forceUseIngestTs;
  const replayCtx = options?.replayBatchContext;
  const isReplay = !!replayCtx;
  // During replay, use ingest timestamp for all event timestamps (not Date.now())
  const asOfMsRaw = options?.asOfTs ?? tickerData?.ts ?? tickerData?.ingest_ts;
  const asOfMs = (isReplay && asOfMsRaw != null)
    ? (Number(asOfMsRaw) < 1e12 ? Number(asOfMsRaw) * 1000 : Number(asOfMsRaw))
    : null;
  const eventTs = () =>
    Number.isFinite(asOfMs) ? new Date(asOfMs).toISOString() : new Date().toISOString();
  try {
    const tradesKey = "timed:trades:all";
    const allTrades = isReplay
      ? (replayCtx.allTrades || [])
      : (await kvGetJSON(KV, tradesKey)) || [];

    const sym = String(ticker || "").toUpperCase();
    const stage = String(tickerData?.kanban_stage || "")
      .trim()
      .toLowerCase();
    const prevStage = String(prevData?.kanban_stage || "")
      .trim()
      .toLowerCase();
    const direction = getTradeDirection(tickerData.state);
    if (!direction) return;

    let openTrade = allTrades.find(
      (t) =>
        String(t?.ticker || "").toUpperCase() === sym &&
        isOpenTradeStatus(t?.status),
    );
    const openTradeDir =
      openTrade && String(openTrade.direction || "").toUpperCase();
    const now = Date.now();

    // Portfolio (cash gating + bookkeeping)
    let portfolio = isReplay
      ? { cash: 1e9 }
      : await getPortfolioState(KV);

    const stageTransition = stage && stage !== prevStage;
    // IMPORTANT:
    // Entering only on stage *transition* can miss entries if we don't ingest during the brief
    // window where a ticker first enters ENTER_NOW. If the ticker remains in ENTER_NOW and there
    // is still no open trade, we should re-attempt entry on subsequent ingests (cooldown + cycle guard
    // prevent churn / duplicate entries).
    const isEnter = stage === "enter_now";
    // IMPORTANT:
    // Trimming only on stage *transition* can miss trims if we miss the first TRIM-lane ingest
    // (or if the TRIM lane persists). Use cooldown + trimmedPct guard to prevent churn.
    const isTrim = stage === "trim";
    // IMPORTANT:
    // Exiting only on stage *transition* can get stuck if we miss the first "enter exit lane"
    // ingest, or the exit is throttled by cooldown. If a ticker remains in the EXIT lane while
    // the ledger trade is still OPEN/TP_HIT_TRIM, we should re-attempt the exit on subsequent
    // ingests (cooldown prevents churn).
    const isExit = stage === "exit";

    // Idempotency / anti-flap guards (per ticker) — skipped in replay (no cooldown for historical)
    const execKey = `timed:exec:last:${sym}`;
    const execState = isReplay ? {} : (await kvGetJSON(KV, execKey)) || {};
    const lastEnterMs = Number(execState.lastEnterMs);
    const lastTrimMs = Number(execState.lastTrimMs);
    const lastExitMs = Number(execState.lastExitMs);
    const lastEnterTriggerTs = Number(execState.lastEnterTriggerTs);
    const lastEnterSide =
      execState.lastEnterSide != null ? String(execState.lastEnterSide) : null;
    const curTriggerTs = Number(tickerData?.trigger_ts);
    const enterCooldownOk =
      !Number.isFinite(lastEnterMs) || now - lastEnterMs >= 10 * 60 * 1000; // 10m
    const trimCooldownOk =
      !Number.isFinite(lastTrimMs) || now - lastTrimMs >= 5 * 60 * 1000; // 5m
    const exitCooldownOk =
      !Number.isFinite(lastExitMs) || now - lastExitMs >= 5 * 60 * 1000; // 5m
    const sameEnterCycle =
      Number.isFinite(curTriggerTs) &&
      curTriggerTs > 0 &&
      Number.isFinite(lastEnterTriggerTs) &&
      lastEnterTriggerTs > 0 &&
      lastEnterTriggerTs === curTriggerTs &&
      !!lastEnterSide &&
      lastEnterSide === direction;

    const pxNow = Number(tickerData?.price);
    const entryPxCandidate =
      Number(tickerData?.entry_price) ||
      Number(tickerData?.entry_ref) ||
      Number(tickerData?.trigger_price) ||
      pxNow ||
      null;

    const move =
      tickerData?.move_status && typeof tickerData.move_status === "object"
        ? tickerData.move_status
        : null;
    const reasons = Array.isArray(move?.reasons) ? move.reasons : [];
    const reason =
      reasons.length > 0
        ? String(reasons[0])
        : stage
          ? `KANBAN_${stage.toUpperCase()}`
          : "KANBAN";

    const persistTrades = async () => {
      allTrades.sort((a, b) => {
        const timeA = new Date(a.entryTime || 0).getTime();
        const timeB = new Date(b.entryTime || 0).getTime();
        return timeB - timeA;
      });
      if (!isReplay) await kvPutJSON(KV, tradesKey, allTrades);
    };

    const upsertAlertSafe = async (alert) => {
      try {
        if (!env) return;
        await d1UpsertAlert(env, alert);
      } catch (e) {
        console.error("[D1 LEDGER] alert upsert failed:", e);
      }
    };

    const closeTradeAtPrice = async (trade, closePrice, closeReason) => {
      const p = Number(closePrice);
      if (!Number.isFinite(p) || p <= 0) return;
      const trimmed = clamp(Number(trade.trimmedPct || 0), 0, 1);
      const remainingPct = Math.max(0, 1 - trimmed);
      const shares = Number(trade.shares);
      if (!Number.isFinite(shares)) return;
      const remainingShares = shares * remainingPct;

      const dirSign =
        String(trade.direction || "").toUpperCase() === "SHORT" ? -1 : 1;
      const pnlRemaining =
        (p - Number(trade.entryPrice)) *
        remainingShares *
        (Number(trade.pointValue) || 1) *
        dirSign;
      trade.realizedPnl = Number(trade.realizedPnl || 0) + pnlRemaining;

      const ev = {
        type: "EXIT",
        timestamp: eventTs(),
        price: p,
        shares: remainingShares,
        value: p * remainingShares,
        reason: closeReason,
        pnl_realized: pnlRemaining,
        note: `Exit at $${p.toFixed(2)} (${closeReason})`,
      };
      trade.history = Array.isArray(trade.history)
        ? [...trade.history, ev]
        : [ev];

      trade.exitReason = closeReason;
      trade.exitPrice = p;
      trade.status = trade.realizedPnl >= 0 ? "WIN" : "LOSS";
      trade.pnl = trade.realizedPnl;
      trade.pnlPct =
        Number.isFinite(Number(trade.notional)) && Number(trade.notional) > 0
          ? (trade.pnl / Number(trade.notional)) * 100
          : null;
      trade.lastUpdate = eventTs();

      // Portfolio cash increases by proceeds
      portfolio.cash = Number(portfolio.cash) + p * remainingShares;

      // Persist to D1 ledger best-effort
      if (env) {
        d1UpsertTrade(env, trade).catch(() => {});
        if (trade?.id) d1InsertTradeEvent(env, trade.id, ev).catch(() => {});
      }

      // Discord + D1 alert (best-effort, deduped)
      if (env && trade?.id) {
        try {
          const tsMs = Date.now();
          const dedupe = await shouldSendTradeDiscordEvent(KV, {
            tradeId: trade.id,
            type: "TRADE_EXIT",
            ts: tsMs,
          });
          if (!dedupe.deduped) {
            const embed = createTradeClosedEmbed(
              sym,
              String(trade.direction || "").toUpperCase(),
              String(trade.status || "").toUpperCase(),
              Number(trade.entryPrice),
              Number(trade.exitPrice),
              Number(trade.pnl || trade.realizedPnl || 0),
              Number(trade.pnlPct || 0),
              Number(trade.rank || 0),
              Number(trade.rr || 0),
              tickerData,
              trade,
            );
            const allow = shouldSendDiscordAlert(env, "TRADE_EXIT", {
              ticker: sym,
              direction: trade.direction,
            });
            const sendRes = allow
              ? await notifyDiscord(env, embed).catch((err) => ({
                  ok: false,
                  error: String(err),
                }))
              : { ok: false, skipped: true, reason: "critical_only" };
            await upsertAlertSafe({
              alert_id: buildAlertId(sym, tsMs, "TRADE_EXIT"),
              ticker: sym,
              ts: tsMs,
              side: String(trade.direction || "").toUpperCase(),
              state: tickerData?.state,
              rank: Number(trade.rank) || 0,
              rr_at_alert: Number(trade.rr) || 0,
              trigger_reason: closeReason || "TRADE_EXIT",
              dedupe_day: formatDedupDay(tsMs),
              discord_sent: !!sendRes?.ok,
              discord_status: sendRes?.status ?? null,
              discord_error: sendRes?.ok
                ? null
                : sendRes?.reason || sendRes?.statusText || sendRes?.error || null,
              payload_json: (() => {
                try {
                  return JSON.stringify(tickerData || null);
                } catch {
                  return null;
                }
              })(),
              meta_json: (() => {
                try {
                  return JSON.stringify({
                    type: "TRADE_EXIT",
                    trade_id: trade.id,
                    status: trade.status,
                    reason: closeReason,
                    exit_price: trade.exitPrice,
                  });
                } catch {
                  return null;
                }
              })(),
            });
          }
        } catch (e) {
          console.error("[KANBAN TRADE] exit discord error:", e);
        }
      }
    };

    const trimTradeToPct = async (
      trade,
      targetTrimPct,
      trimPrice,
      trimReason,
    ) => {
      const p = Number(trimPrice);
      if (!Number.isFinite(p) || p <= 0) return;
      const oldTrim = clamp(Number(trade.trimmedPct || 0), 0, 1);
      const tgt = clamp(Number(targetTrimPct), 0, 0.95);
      if (tgt <= oldTrim + 1e-6) return;
      const delta = tgt - oldTrim;
      const shares = Number(trade.shares);
      if (!Number.isFinite(shares)) return;
      const trimShares = shares * delta;

      const dirSign =
        String(trade.direction || "").toUpperCase() === "SHORT" ? -1 : 1;
      const pnlRealized =
        (p - Number(trade.entryPrice)) *
        trimShares *
        (Number(trade.pointValue) || 1) *
        dirSign;
      trade.realizedPnl = Number(trade.realizedPnl || 0) + pnlRealized;
      trade.trimmedPct = tgt;
      trade.status = tgt > 0 ? "TP_HIT_TRIM" : "OPEN";

      const ev = {
        type: "TRIM",
        timestamp: eventTs(),
        price: p,
        shares: trimShares,
        value: p * trimShares,
        trimPct: tgt,
        trimDeltaPct: delta,
        reason: trimReason,
        pnl_realized: pnlRealized,
        note: `Trimmed ${Math.round(delta * 100)}% at $${p.toFixed(2)} (${trimReason})`,
      };
      trade.history = Array.isArray(trade.history)
        ? [...trade.history, ev]
        : [ev];
      trade.lastUpdate = eventTs();

      // Portfolio cash increases by proceeds
      portfolio.cash = Number(portfolio.cash) + p * trimShares;

      if (env) {
        d1UpsertTrade(env, trade).catch(() => {});
        if (trade?.id) d1InsertTradeEvent(env, trade.id, ev).catch(() => {});
      }

      // Discord + D1 alert (best-effort, deduped)
      if (env && trade?.id) {
        try {
          const tsMs = Date.now();
          const dedupe = await shouldSendTradeDiscordEvent(KV, {
            tradeId: trade.id,
            type: "TRADE_TRIM",
            ts: tsMs,
          });
          if (!dedupe.deduped) {
            const dir = String(trade.direction || "").toUpperCase();
            const dirSign = dir === "SHORT" ? -1 : 1;
            const pnlPctAtTrim =
              Number.isFinite(Number(trade.entryPrice)) && Number(trade.entryPrice) > 0
                ? ((p - Number(trade.entryPrice)) / Number(trade.entryPrice)) *
                  100 *
                  dirSign
                : 0;
            const allow = shouldSendDiscordAlert(env, "TRADE_TRIM", {
              newTrimmedPct: tgt,
              trimDeltaPctRaw: delta,
            });
            const embed = createTradeTrimmedEmbed(
              sym,
              dir,
              Number(trade.entryPrice),
              Number(trade.currentPrice || p),
              Number(trade.tp || p),
              Number(pnlRealized || 0),
              Number(pnlPctAtTrim || 0),
              tgt,
              tickerData,
              trade,
              delta,
            );
            const sendRes = allow
              ? await notifyDiscord(env, embed).catch((err) => ({
                  ok: false,
                  error: String(err),
                }))
              : { ok: false, skipped: true, reason: "critical_only" };
            await upsertAlertSafe({
              alert_id: buildAlertId(sym, tsMs, "TRADE_TRIM"),
              ticker: sym,
              ts: tsMs,
              side: dir,
              state: tickerData?.state,
              rank: Number(trade.rank) || 0,
              rr_at_alert: Number(trade.rr) || 0,
              trigger_reason: trimReason || "TRADE_TRIM",
              dedupe_day: formatDedupDay(tsMs),
              discord_sent: !!sendRes?.ok,
              discord_status: sendRes?.status ?? null,
              discord_error: sendRes?.ok
                ? null
                : sendRes?.reason || sendRes?.statusText || sendRes?.error || null,
              payload_json: (() => {
                try {
                  return JSON.stringify(tickerData || null);
                } catch {
                  return null;
                }
              })(),
              meta_json: (() => {
                try {
                  return JSON.stringify({
                    type: "TRADE_TRIM",
                    trade_id: trade.id,
                    trimmed_pct: tgt,
                    trim_delta_pct: delta,
                    trim_price: p,
                  });
                } catch {
                  return null;
                }
              })(),
            });
          }
        } catch (e) {
          console.error("[KANBAN TRADE] trim discord error:", e);
        }
      }
    };

    // Market is closed on weekends — never execute TP trims/exits on Sat/Sun.
    // (We still allow SL evaluation elsewhere to be conservative.)
    const weekendNow = isNyWeekend(Date.now());

    // 1) EXIT: close any open trade while in EXIT lane
    if (isExit && !weekendNow && exitCooldownOk && openTrade) {
      await closeTradeAtPrice(openTrade, pxNow, reason);
      if (!isReplay) await kvPutJSON(KV, execKey, { ...execState, lastExitMs: now });
    }

    // 2) TRIM: apply progressive trim on transition into TRIM lane
    if (isTrim && !weekendNow && trimCooldownOk && openTrade && Number.isFinite(pxNow)) {
      const comp = Number(tickerData?.completion);
      const phase = Number(tickerData?.phase_pct);
      // progressive ladder driven by lifecycle: 25% -> 50% -> 75%
      let target = 0.25;
      if (Number.isFinite(comp) && comp >= 0.85) target = 0.75;
      else if (Number.isFinite(comp) && comp >= 0.7) target = 0.5;
      else if (Number.isFinite(phase) && phase >= 0.8) target = 0.75;
      else if (Number.isFinite(phase) && phase >= 0.7) target = 0.5;
      await trimTradeToPct(openTrade, target, pxNow, reason);
      if (!isReplay) await kvPutJSON(KV, execKey, { ...execState, lastTrimMs: now });
    }

    // 3) ENTER: open trade while in ENTER_NOW lane
    if (isEnter && !weekendNow && enterCooldownOk && !sameEnterCycle) {
      // If we already have an open trade in the opposite direction, close it first (flip).
      if (
        openTrade &&
        openTradeDir &&
        openTradeDir !== direction &&
        exitCooldownOk
      ) {
        await closeTradeAtPrice(openTrade, pxNow, `FLIP_${reason}`);
        if (!isReplay) await kvPutJSON(KV, execKey, { ...execState, lastExitMs: now });
        openTrade = null;
      }
    }

    if (isEnter && !weekendNow && enterCooldownOk && !sameEnterCycle && !openTrade) {
      const entryPx = Number(entryPxCandidate);
      const slCandidate = Number(tickerData?.sl ?? tickerData?.sl_price ?? tickerData?.stop_loss);
      let tpCandidate = Number(tickerData?.tp ?? tickerData?.tp_max_price ?? tickerData?.tp_target_price ?? tickerData?.tp_target);
      if (!Number.isFinite(tpCandidate) || tpCandidate <= 0) {
        const tpFromLevels = computeTpMaxFromLevels(tickerData);
        tpCandidate = Number.isFinite(tpFromLevels) ? tpFromLevels : 0;
      }
      if (
        Number.isFinite(entryPx) &&
        entryPx > 0 &&
        Number.isFinite(pxNow) &&
        pxNow > 0
        // Require valid SL/TP to avoid creating "unmanaged" trades
        && Number.isFinite(slCandidate) &&
        slCandidate > 0 &&
        Number.isFinite(tpCandidate) &&
        tpCandidate > 0
      ) {
        const confidence = computeTradeConfidence(tickerData);
        const cash = Number(portfolio.cash);
        const notional =
          Number.isFinite(cash) && cash >= MIN_TRADE_NOTIONAL
            ? tradeNotionalFromConfidence(confidence, cash)
            : null;
        if (notional != null) {
          const { shares, pointValue } = computeSharesForTrade(
            sym,
            entryPx,
            notional,
          );
          if (Number.isFinite(shares) && shares > 0) {
            const tradeId = `${sym}-${now}-${Math.random().toString(36).substr(2, 9)}`;
            const entryTime = eventTs();
            const ev = {
              type: "ENTRY",
              timestamp: entryTime,
              price: entryPx,
              shares: shares,
              value: entryPx * shares,
              reason: reason,
              note: `Entry from ENTER_NOW at $${entryPx.toFixed(2)}`,
            };

            const trade = {
              id: tradeId,
              ticker: sym,
              direction,
              entryPrice: entryPx,
              entryTime,
              triggerTimestamp: Number(tickerData?.trigger_ts) || null,
              sl: slCandidate,
              tp: tpCandidate,
              rr: Number(tickerData?.rr) || 0,
              rank: Number(tickerData?.rank) || 0,
              state: tickerData?.state,
              flags: tickerData?.flags || {},
              scriptVersion: tickerData?.script_version || "unknown",
              status: "OPEN",
              trimmedPct: 0,
              history: [ev],
              notional: notional,
              confidence: confidence,
              shares: shares,
              pointValue: pointValue,
              realizedPnl: 0,
              currentPrice: pxNow,
              lastUpdate: eventTs(),
              source: "KANBAN_ENTER_NOW",
            };

            // Portfolio cash decreases by cost
            portfolio.cash = Number(portfolio.cash) - entryPx * shares;

            allTrades.push(trade);
            if (!isReplay) await kvPutJSON(KV, execKey, {
              ...execState,
              lastEnterMs: now,
              lastEnterTriggerTs:
                Number.isFinite(curTriggerTs) && curTriggerTs > 0
                  ? curTriggerTs
                  : null,
              lastEnterSide: direction,
            });
            if (env) {
              d1UpsertTrade(env, trade).catch(() => {});
              d1InsertTradeEvent(env, tradeId, ev).catch(() => {});
            }

            // Discord + D1 alert (best-effort, deduped)
            if (env) {
              try {
                const tsMs = Date.now();
                const dedupe = await shouldSendTradeDiscordEvent(KV, {
                  tradeId,
                  type: "TRADE_ENTRY",
                  ts: tsMs,
                });
                if (!dedupe.deduped) {
                  const allow = shouldSendDiscordAlert(env, "TRADE_ENTRY", {
                    ticker: sym,
                    rr: Number(trade.rr || 0),
                    rank: Number(trade.rank || 0),
                    momentumElite: !!trade.flags?.momentum_elite,
                  });
                  const embed = createTradeEntryEmbed(
                    sym,
                    direction,
                    Number(entryPx),
                    Number(slCandidate),
                    Number(tpCandidate),
                    Number(trade.rr || 0),
                    Number(trade.rank || 0),
                    trade.state,
                    Number(pxNow),
                    false,
                    tickerData,
                  );
                  const sendRes = allow
                    ? await notifyDiscord(env, embed).catch((err) => ({
                        ok: false,
                        error: String(err),
                      }))
                    : { ok: false, skipped: true, reason: "critical_only" };
                  await upsertAlertSafe({
                    alert_id: buildAlertId(sym, tsMs, "TRADE_ENTRY"),
                    ticker: sym,
                    ts: tsMs,
                    side: direction,
                    state: tickerData?.state,
                    rank: Number(trade.rank) || 0,
                    rr_at_alert: Number(trade.rr) || 0,
                    trigger_reason: reason || "TRADE_ENTRY",
                    dedupe_day: formatDedupDay(tsMs),
                    discord_sent: !!sendRes?.ok,
                    discord_status: sendRes?.status ?? null,
                    discord_error: sendRes?.ok
                      ? null
                      : sendRes?.reason ||
                        sendRes?.statusText ||
                        sendRes?.error ||
                        null,
                    payload_json: (() => {
                      try {
                        return JSON.stringify(tickerData || null);
                      } catch {
                        return null;
                      }
                    })(),
                    meta_json: (() => {
                      try {
                        return JSON.stringify({
                          type: "TRADE_ENTRY",
                          trade_id: tradeId,
                          entry_price: entryPx,
                          sl: slCandidate,
                          tp: tpCandidate,
                        });
                      } catch {
                        return null;
                      }
                    })(),
                  });
                }
              } catch (e) {
                console.error("[KANBAN TRADE] entry discord error:", e);
              }
            }
          }
        } else {
          tickerData.flags =
            tickerData.flags && typeof tickerData.flags === "object"
              ? tickerData.flags
              : {};
          tickerData.flags.portfolio_no_cash = true;
        }
      }
    }

    // 4) Mark-to-market open trade (no auto TP/SL execution; Kanban lanes drive executions)
    if (openTrade && isOpenTradeStatus(openTrade.status)) {
      openTrade.currentPrice = Number.isFinite(pxNow)
        ? pxNow
        : openTrade.currentPrice;
      const mtm = computeTradePnlComponents(openTrade, tickerData);
      if (mtm.pnl != null) openTrade.pnl = mtm.pnl;
      if (mtm.pnlPct != null) openTrade.pnlPct = mtm.pnlPct;

      // Gain protection: tighten stale SL once trade is meaningfully in profit.
      // We DO NOT loosen stops; only tighten in the trade's favor.
      try {
        const dir = String(openTrade.direction || "").toUpperCase();
        const entry = Number(openTrade.entryPrice);
        const mark = Number(openTrade.currentPrice);
        const oldSl = Number(openTrade.sl);
        const trimmedPct = clamp(Number(openTrade.trimmedPct || 0), 0, 1);
        const completion = Number(tickerData?.completion);

        const sign = dir === "SHORT" ? -1 : 1;
        const pnlPct =
          Number.isFinite(entry) && entry > 0 && Number.isFinite(mark) && mark > 0
            ? ((mark - entry) / entry) * 100 * sign
            : NaN;

        const lastSlTightenMs = Number(execState.lastSlTightenMs);
        const slCooldownOk =
          !Number.isFinite(lastSlTightenMs) || now - lastSlTightenMs >= 15 * 60 * 1000; // 15m

        const shouldProtect =
          slCooldownOk &&
          !weekendNow &&
          Number.isFinite(pnlPct) &&
          (pnlPct >= 2.0 ||
            trimmedPct > 0 ||
            (Number.isFinite(completion) && completion >= 0.6));

        if (shouldProtect && (dir === "LONG" || dir === "SHORT")) {
          // Candidate 1: break-even once +2% (or after trim)
          let candidate = null;
          if (pnlPct >= 2.0 || trimmedPct > 0) {
            candidate = entry;
          }

          // Candidate 2: use Daily EMA cloud boundary when available (acts as dynamic support/resistance)
          const dailyCloud =
            tickerData?.daily_ema_cloud && typeof tickerData.daily_ema_cloud === "object"
              ? tickerData.daily_ema_cloud
              : null;
          if (dailyCloud) {
            const upper = Number(dailyCloud.upper);
            const lower = Number(dailyCloud.lower);
            if (dir === "LONG" && Number.isFinite(lower) && lower > 0) {
              candidate = candidate == null ? lower : Math.max(candidate, lower);
            }
            if (dir === "SHORT" && Number.isFinite(upper) && upper > 0) {
              candidate = candidate == null ? upper : Math.min(candidate, upper);
            }
          }

          // Bound the candidate so it remains a valid protective stop relative to current price
          let newSl = null;
          if (candidate != null && Number.isFinite(candidate) && candidate > 0) {
            if (dir === "LONG") {
              // Stop must be below current price; cap at 99.5% of mark.
              newSl = Math.min(candidate, mark * 0.995);
              // Only tighten if it moves up meaningfully.
              if (Number.isFinite(oldSl) && oldSl > 0) {
                if (newSl <= oldSl + entry * 0.0005) newSl = null;
              }
            } else if (dir === "SHORT") {
              // Stop must be above current price; floor at 100.5% of mark.
              newSl = Math.max(candidate, mark * 1.005);
              if (Number.isFinite(oldSl) && oldSl > 0) {
                if (newSl >= oldSl - entry * 0.0005) newSl = null;
              }
            }
          }

          if (newSl != null && Number.isFinite(newSl) && newSl > 0) {
            const prev = Number.isFinite(oldSl) ? oldSl : null;
            openTrade.sl = newSl;
            openTrade.sl_protect_reason = "PROTECT_GAINS";
            openTrade.sl_last_tighten_ts = eventTs();

            const ev = {
              type: "SL_TIGHTEN",
              timestamp: eventTs(),
              price: mark,
              oldSl: prev,
              newSl,
              pnlPct,
              note: `Tightened SL to protect gains (${pnlPct.toFixed(2)}% unrealized)`,
            };
            openTrade.history = Array.isArray(openTrade.history)
              ? [...openTrade.history, ev]
              : [ev];

            if (!isReplay) await kvPutJSON(KV, execKey, {
              ...execState,
              lastSlTightenMs: now,
            });

            if (env && openTrade?.id) {
              d1UpsertTrade(env, openTrade).catch(() => {});
              d1InsertTradeEvent(env, openTrade.id, ev).catch(() => {});
            }
          }
        }
      } catch (e) {
        console.error("[KANBAN TRADE] gain-protection SL tighten error:", e);
      }

      openTrade.lastUpdate = eventTs();
      if (env) d1UpsertTrade(env, openTrade).catch(() => {});
    }

    if (!isReplay) portfolio = await putPortfolioState(KV, portfolio);
    await persistTrades();

    // Legacy price-based simulation path removed from Kanban-driven execution.
    // Keep the function returning successfully for callers.
    return;

    if (false) {
      // Check if entry price needs correction (was incorrectly set from trigger_price)
      let correctedEntryPrice = existingOpenTrade.entryPrice;
      const entryPriceCorrected =
        existingOpenTrade.entryPriceCorrected || false;

      if (!entryPriceCorrected && tickerData.price) {
        const currentEntryPrice = Number(existingOpenTrade.entryPrice);
        const currentPrice = Number(tickerData.price);
        const triggerPrice = tickerData.trigger_price
          ? Number(tickerData.trigger_price)
          : null;

        // Check if price is available and entry price differs significantly
        const priceAvailable = currentPrice > 0;
        const entryPriceDiffers =
          Math.abs(currentEntryPrice - currentPrice) / currentPrice > 0.01; // More than 1% difference

        console.log(
          `[TRADE SIM] Checking ${ticker} ${direction} entry price correction: entry=$${currentEntryPrice.toFixed(
            2,
          )}, current=$${currentPrice.toFixed(2)}, trigger=${
            triggerPrice ? "$" + triggerPrice.toFixed(2) : "null"
          }, differs=${entryPriceDiffers}, corrected=${entryPriceCorrected}`,
        );

        if (priceAvailable && entryPriceDiffers) {
          // Check if trade is old (backfill) - use entry time from trade
          const entryTime = existingOpenTrade.entryTime
            ? new Date(existingOpenTrade.entryTime).getTime()
            : null;
          const now = Date.now();
          const isOldTrade = entryTime && now - entryTime > 60 * 60 * 1000; // More than 1 hour old

          // Also check trigger timestamp if available
          const triggerTimestamp =
            tickerData.trigger_ts != null
              ? new Date(Number(tickerData.trigger_ts)).toISOString()
              : tickerData.ts != null
                ? new Date(Number(tickerData.ts)).toISOString()
                : null;
          const triggerTime = triggerTimestamp
            ? new Date(triggerTimestamp).getTime()
            : null;
          const isBackfill = triggerTime && now - triggerTime > 60 * 60 * 1000;

          // Determine if entry price was likely set incorrectly
          // Check if entry price matches trigger_price (if available) or if trade is old
          const entryMatchesTrigger =
            triggerPrice &&
            Math.abs(currentEntryPrice - triggerPrice) / triggerPrice < 0.001;

          console.log(
            `[TRADE SIM] ${ticker} correction check: isOldTrade=${isOldTrade}, isBackfill=${isBackfill}, entryMatchesTrigger=${entryMatchesTrigger}, entryTime=${existingOpenTrade.entryTime}`,
          );

          // For old trades: ALWAYS use current price (entry was likely wrong)
          // For trades where entry matches trigger_price: use current price (entry was likely wrong)
          // If entry differs significantly from current price, it's likely wrong
          if (isOldTrade || entryMatchesTrigger || entryPriceDiffers) {
            // For old trades or mismatched prices: ALWAYS use current price, never trigger_price
            correctedEntryPrice = currentPrice;
            console.log(
              `[TRADE SIM] 🔧 Correcting ${ticker} ${direction} entry price: $${currentEntryPrice.toFixed(
                2,
              )} -> $${correctedEntryPrice.toFixed(2)} (reason: ${
                isOldTrade
                  ? "old trade"
                  : entryMatchesTrigger
                    ? "matches trigger_price"
                    : "differs from current price"
              }, using current price)`,
            );
          } else if (isBackfill && triggerPrice) {
            // For backfills only (not old trades): use trigger_price if significantly different
            const priceDiff =
              Math.abs(triggerPrice - currentPrice) / currentPrice;
            if (priceDiff > 0.01) {
              // More than 1% difference - use trigger_price for backfill
              correctedEntryPrice = triggerPrice;
              console.log(
                `[TRADE SIM] 🔧 Correcting ${ticker} ${direction} entry price: $${currentEntryPrice.toFixed(
                  2,
                )} -> $${correctedEntryPrice.toFixed(
                  2,
                )} (backfill, using trigger_price)`,
              );
            } else {
              // Price is close - use current price even for backfills
              correctedEntryPrice = currentPrice;
              console.log(
                `[TRADE SIM] 🔧 Correcting ${ticker} ${direction} entry price: $${currentEntryPrice.toFixed(
                  2,
                )} -> $${correctedEntryPrice.toFixed(
                  2,
                )} (backfill, trigger_price close, using current price)`,
              );
            }
          }
        }
      }

      // Recalculate shares if entry price was corrected (to maintain $1000 position size for stocks, 1 contract for futures)
      let correctedShares = existingOpenTrade.shares;
      if (
        correctedEntryPrice !== existingOpenTrade.entryPrice &&
        !entryPriceCorrected
      ) {
        // Calculate shares based on asset type (futures vs stocks)
        const tickerUpper = String(ticker || "").toUpperCase();
        const isFutures =
          FUTURES_SPECS[tickerUpper] || tickerUpper.endsWith("1!");
        correctedShares =
          isFutures && FUTURES_SPECS[tickerUpper]
            ? 1
            : TRADE_SIZE / correctedEntryPrice;
        console.log(
          `[TRADE SIM] 🔧 Recalculating ${ticker} ${direction} shares: ${existingOpenTrade.shares?.toFixed(
            4,
          )} -> ${correctedShares.toFixed(4)} (due to entry price correction)`,
        );
      }

      // Check TD Sequential exit signals BEFORE calculating P&L
      // TD Sequential can signal exhaustion/reversal even if TP/SL haven't been hit
      const tdSeq = tickerData.td_sequential || {};
      const tdSeqExitLong =
        tdSeq.exit_long === true || tdSeq.exit_long === "true";
      const tdSeqExitShort =
        tdSeq.exit_short === true || tdSeq.exit_short === "true";

      // Check if TD Sequential signals an exit for this trade direction
      let shouldExitFromTDSeq =
        (direction === "LONG" && tdSeqExitLong) ||
        (direction === "SHORT" && tdSeqExitShort);

      let tradeCalc;
      if (shouldExitFromTDSeq) {
        // Market is closed on weekends — do not exit/defend based on TDSEQ on Sat/Sun.
        if (isNyWeekend(Date.now())) {
          shouldExitFromTDSeq = false;
        }
      }

      // Avoid instant churn: ignore TDSEQ exits shortly after entry.
      if (shouldExitFromTDSeq) {
        const entryMs =
          isoToMs(existingOpenTrade?.entryTime) ||
          Number(existingOpenTrade?.entryTs) ||
          Number(existingOpenTrade?.entry_ts) ||
          isoToMs(existingOpenTrade?.entry_time) ||
          null;
        const nowMs = Number(tickerData?.ts) || Date.now();
        const ageMs = Number.isFinite(entryMs) ? nowMs - entryMs : null;
        const MIN_TDSEQ_HOLD_MS = 4 * 60 * 60 * 1000; // 4 hours (TD9 is usually a pullback; don't flinch early)
        if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < MIN_TDSEQ_HOLD_MS) {
          shouldExitFromTDSeq = false;
          // Breadcrumb for debugging / review
          await appendActivity(KV, {
            ticker,
            type: "tdseq_ignored_early",
            direction,
            age_min: Math.round(ageMs / 60000),
            min_age_min: Math.round(MIN_TDSEQ_HOLD_MS / 60000),
            td9_bullish:
              tdSeq.td9_bullish === true || tdSeq.td9_bullish === "true",
            td9_bearish:
              tdSeq.td9_bearish === true || tdSeq.td9_bearish === "true",
            td13_bullish:
              tdSeq.td13_bullish === true || tdSeq.td13_bullish === "true",
            td13_bearish:
              tdSeq.td13_bearish === true || tdSeq.td13_bearish === "true",
          });
        }
      }

      // TDSEQ should protect gains, not force exits at a loss.
      // Require (a) some profit buffer and (b) meaningful progress (phase/completion/TP progress) before allowing a TDSEQ exit.
      if (shouldExitFromTDSeq) {
        const priceNow = Number(tickerData?.price);
        const entryPx =
          Number(existingOpenTrade?.entryPrice) ||
          Number(existingOpenTrade?.entry_price) ||
          Number(tickerData?.trigger_price) ||
          Number(tickerData?.price);
        const tpPx =
          Number(existingOpenTrade?.tp) ||
          Number(existingOpenTrade?.tp_price) ||
          Number(tickerData?.tp);
        const completion = Number(tickerData?.completion);
        const phasePct = Number(tickerData?.phase_pct);

        const pnlPctNow =
          Number.isFinite(priceNow) && Number.isFinite(entryPx) && entryPx > 0
            ? direction === "LONG"
              ? ((priceNow - entryPx) / entryPx) * 100
              : ((entryPx - priceNow) / entryPx) * 100
            : null;

        let tpProgress = null;
        if (
          Number.isFinite(priceNow) &&
          Number.isFinite(entryPx) &&
          Number.isFinite(tpPx) &&
          tpPx !== entryPx
        ) {
          const raw =
            direction === "LONG"
              ? (priceNow - entryPx) / (tpPx - entryPx)
              : (entryPx - priceNow) / (entryPx - tpPx);
          tpProgress = Number.isFinite(raw)
            ? Math.max(0, Math.min(1, raw))
            : null;
        }

        const hasProfitBuffer = Number.isFinite(pnlPctNow)
          ? pnlPctNow >= 0.35
          : false; // ~35 bps
        const hasMeaningfulProgress =
          (Number.isFinite(completion) && completion >= 0.7) ||
          (Number.isFinite(phasePct) && phasePct >= 0.7) ||
          (Number.isFinite(tpProgress) && tpProgress >= 0.35);

        if (!(hasProfitBuffer && hasMeaningfulProgress)) {
          shouldExitFromTDSeq = false;
          await appendActivity(KV, {
            ticker,
            type: "tdseq_ignored_not_ready",
            direction,
            pnl_pct: Number.isFinite(pnlPctNow) ? pnlPctNow : null,
            completion: Number.isFinite(completion) ? completion : null,
            phase_pct: Number.isFinite(phasePct) ? phasePct : null,
            tp_progress: Number.isFinite(tpProgress) ? tpProgress : null,
            td9_bullish:
              tdSeq.td9_bullish === true || tdSeq.td9_bullish === "true",
            td9_bearish:
              tdSeq.td9_bearish === true || tdSeq.td9_bearish === "true",
            td13_bullish:
              tdSeq.td13_bullish === true || tdSeq.td13_bullish === "true",
            td13_bearish:
              tdSeq.td13_bearish === true || tdSeq.td13_bearish === "true",
          });
        }
      }

      if (shouldExitFromTDSeq) {
        // Higher-TF confirmation: only allow TDSEQ exits when DAILY structure confirms.
        // If DAILY doesn't confirm (or is missing), defend by tightening SL and keep holding.
        const daily = tickerData?.daily_ema_cloud || null;
        const fourH = tickerData?.fourh_ema_cloud || null;

        const dailyPos = String(daily?.position || "").toLowerCase();
        const dailyUpper = Number(daily?.upper);
        const dailyLower = Number(daily?.lower);

        const fourHPos = String(fourH?.position || "").toLowerCase();
        const fourHUpper = Number(fourH?.upper);
        const fourHLower = Number(fourH?.lower);

        const priceNow = Number(tickerData.price || 0);

        const dailyExists =
          dailyPos ||
          (Number.isFinite(dailyUpper) && dailyUpper > 0) ||
          (Number.isFinite(dailyLower) && dailyLower > 0);

        const dailyConfirmsExit =
          direction === "LONG"
            ? dailyExists &&
              (dailyPos === "below" ||
                (Number.isFinite(dailyLower) &&
                  dailyLower > 0 &&
                  priceNow < dailyLower))
            : dailyExists &&
              (dailyPos === "above" ||
                (Number.isFinite(dailyUpper) &&
                  dailyUpper > 0 &&
                  priceNow > dailyUpper));

        // If daily doesn't confirm the reversal, prefer defending (tighten SL) over exiting.
        const shouldDefend = !dailyConfirmsExit;

        const defendUpper =
          dailyExists && Number.isFinite(dailyUpper) && dailyUpper > 0
            ? dailyUpper
            : Number.isFinite(fourHUpper) && fourHUpper > 0
              ? fourHUpper
              : null;
        const defendLower =
          dailyExists && Number.isFinite(dailyLower) && dailyLower > 0
            ? dailyLower
            : Number.isFinite(fourHLower) && fourHLower > 0
              ? fourHLower
              : null;

        const canDefendLong =
          direction === "LONG" &&
          shouldDefend &&
          (dailyPos ? dailyPos !== "below" : true) &&
          Number.isFinite(defendLower) &&
          defendLower > 0;
        const canDefendShort =
          direction === "SHORT" &&
          shouldDefend &&
          (dailyPos ? dailyPos !== "above" : true) &&
          Number.isFinite(defendUpper) &&
          defendUpper > 0;

        if (canDefendLong || canDefendShort) {
          const suggestedSl = canDefendLong ? defendLower : defendUpper;
          const oldSlRaw =
            existingOpenTrade?.sl != null
              ? Number(existingOpenTrade.sl)
              : Number(tickerData?.sl);
          const oldSl = Number.isFinite(oldSlRaw) ? oldSlRaw : null;

          const tighten =
            oldSl == null
              ? true
              : direction === "LONG"
                ? suggestedSl > oldSl
                : suggestedSl < oldSl;

          if (tighten) {
            existingOpenTrade.sl = suggestedSl;
          }

          // Add activity feed event (even if no tighten, it documents the decision)
          await appendActivity(KV, {
            ticker,
            type: "tdseq_defense",
            direction,
            price: priceNow,
            old_sl: oldSl,
            new_sl: tighten ? suggestedSl : oldSl,
            cloud_pos: dailyPos || fourHPos || null,
            cloud_upper: Number.isFinite(defendUpper) ? defendUpper : null,
            cloud_lower: Number.isFinite(defendLower) ? defendLower : null,
            td9_bullish:
              tdSeq.td9_bullish === true || tdSeq.td9_bullish === "true",
            td9_bearish:
              tdSeq.td9_bearish === true || tdSeq.td9_bearish === "true",
            td13_bullish:
              tdSeq.td13_bullish === true || tdSeq.td13_bullish === "true",
            td13_bearish:
              tdSeq.td13_bearish === true || tdSeq.td13_bearish === "true",
          });

          // Discord + D1 alert (deduped hourly)
          try {
            const discordEnable = env?.DISCORD_ENABLE || "false";
            const discordWebhook = env?.DISCORD_WEBHOOK_URL;
            const discordConfigured =
              discordEnable === "true" && !!discordWebhook;

            const nowMs = Date.now();
            const hourBucket = new Date(nowMs).toISOString().slice(0, 13); // YYYY-MM-DDTHH
            const dedupeKey = `timed:dedupe:tdseq_defense:${ticker}:${direction}:${hourBucket}`;
            const already = await KV.get(dedupeKey);

            if (!already) {
              await KV.put(dedupeKey, "1", { expirationTtl: 60 * 60 });

              if (
                discordConfigured &&
                shouldSendDiscordAlert(env, "TDSEQ_DEFENSE", {
                  ticker,
                  direction,
                })
              ) {
                const embed = createTDSeqDefenseEmbed(
                  ticker,
                  direction,
                  correctedEntryPrice,
                  priceNow,
                  oldSl,
                  tighten ? suggestedSl : oldSl,
                  tdSeq,
                  tickerData,
                );
                const sendRes = await notifyDiscord(env, embed).catch((err) => {
                  console.error(
                    `[TRADE SIM] ❌ Failed to send TDSEQ defense alert for ${ticker}:`,
                    err,
                  );
                  return { ok: false, error: String(err) };
                });

                d1UpsertAlert(env, {
                  alert_id: buildAlertId(ticker, nowMs, "TDSEQ_DEFENSE"),
                  ticker,
                  ts: nowMs,
                  side: direction,
                  state: tickerData.state,
                  rank: Number(existingOpenTrade.rank) || 0,
                  rr_at_alert: Number(existingOpenTrade.rr) || 0,
                  trigger_reason: "TDSEQ_DEFENSE",
                  dedupe_day: formatDedupDay(nowMs),
                  discord_sent: !!sendRes?.ok,
                  discord_status: sendRes?.status ?? null,
                  discord_error: sendRes?.ok
                    ? null
                    : sendRes?.reason ||
                      sendRes?.statusText ||
                      sendRes?.error ||
                      "discord_send_failed",
                  payload_json: JSON.stringify({
                    ticker,
                    direction,
                    price: priceNow,
                    old_sl: oldSl,
                    new_sl: tighten ? suggestedSl : oldSl,
                    cloud: dailyExists ? daily : fourH,
                    td_sequential: tdSeq,
                  }),
                  meta_json: JSON.stringify({ kind: "tdseq_defense" }),
                }).catch((e) => {
                  console.error(
                    `[D1 LEDGER] Failed to upsert TDSEQ defense alert:`,
                    e,
                  );
                });
              }
            }
          } catch (e) {
            console.error(`[TRADE SIM] TDSEQ defense alert error:`, e);
          }

          // Do not exit; continue with normal TP/SL evaluation using updated SL.
          shouldExitFromTDSeq = false;
        }

        // If DAILY doesn't confirm, do not exit (even if we couldn't tighten).
        if (shouldDefend && shouldExitFromTDSeq) {
          shouldExitFromTDSeq = false;
        }
      }

      if (shouldExitFromTDSeq) {
        console.log(
          `[TRADE SIM] 🚨 TD Sequential exit signal for ${ticker} ${direction}: ` +
            `TD9/TD13 ${
              direction === "LONG" ? "bearish" : "bullish"
            } reversal detected`,
        );

        // Force exit at current price (TD Sequential exhaustion signal)
        const currentPrice = Number(tickerData.price || 0);
        const shares = correctedShares || existingOpenTrade.shares || 0;
        let pnl = 0;
        let pnlPct = 0;

        if (direction === "LONG") {
          pnl = (currentPrice - correctedEntryPrice) * shares;
          pnlPct =
            ((currentPrice - correctedEntryPrice) / correctedEntryPrice) * 100;
        } else {
          pnl = (correctedEntryPrice - currentPrice) * shares;
          pnlPct =
            ((correctedEntryPrice - currentPrice) / correctedEntryPrice) * 100;
        }

        const tdSeqStatus = pnl >= 0 ? "WIN" : "LOSS";
        tradeCalc = {
          shares,
          pnl,
          pnlPct,
          status: tdSeqStatus,
          currentPrice,
          trimmedPct: existingOpenTrade.trimmedPct || 0,
          exitPrice: currentPrice,
          exitReason: "TDSEQ",
          exitCategory: "INVALIDATION",
        };

        // Add activity feed event for TD9 exit
        await appendActivity(KV, {
          ticker,
          type: "td9_exit",
          direction,
          side: direction === "LONG" ? "bearish" : "bullish",
          entryPrice: correctedEntryPrice,
          exitPrice: currentPrice,
          pnl,
          pnlPct,
          status: tdSeqStatus,
          td9_bullish:
            tdSeq.td9_bullish === true || tdSeq.td9_bullish === "true",
          td9_bearish:
            tdSeq.td9_bearish === true || tdSeq.td9_bearish === "true",
          td13_bullish:
            tdSeq.td13_bullish === true || tdSeq.td13_bullish === "true",
          td13_bearish:
            tdSeq.td13_bearish === true || tdSeq.td13_bearish === "true",
        });
      } else {
        // Normal TP/SL calculation
        tradeCalc = calculateTradePnl(tickerData, correctedEntryPrice, {
          ...existingOpenTrade,
          shares: correctedShares,
        });
      }

      if (tradeCalc) {
        // Ensure status matches actual P&L (fix for trades marked WIN with negative P&L)
        let newStatus =
          tradeCalc.status === "TP_HIT_TRIM" ? "TP_HIT_TRIM" : tradeCalc.status;
        if (
          (newStatus === "WIN" || newStatus === "LOSS") &&
          tradeCalc.pnl !== undefined
        ) {
          // Double-check: WIN must have positive P&L, LOSS must have negative P&L
          if (newStatus === "WIN" && tradeCalc.pnl < 0) {
            console.log(
              `[TRADE SIM] ⚠️ Correcting ${ticker} ${direction}: WIN with negative P&L (${tradeCalc.pnl.toFixed(
                2,
              )}) -> LOSS`,
            );
            newStatus = "LOSS";
          } else if (newStatus === "LOSS" && tradeCalc.pnl > 0) {
            console.log(
              `[TRADE SIM] ⚠️ Correcting ${ticker} ${direction}: LOSS with positive P&L (${tradeCalc.pnl.toFixed(
                2,
              )}) -> WIN`,
            );
            newStatus = "WIN";
          }
        }

        // Update history for trade lifecycle events (ENTRY / TRIM / EXIT)
        const history = Array.isArray(existingOpenTrade.history)
          ? [...existingOpenTrade.history]
          : [];
        const newHistoryEvents = [];

        const ensureEntryInHistory = () => {
          const hasEntry = history.some((e) => e && e.type === "ENTRY");
          if (hasEntry) return;
          history.unshift({
            type: "ENTRY",
            timestamp: existingOpenTrade.entryTime,
            price: existingOpenTrade.entryPrice,
            shares: existingOpenTrade.shares || 0,
            value:
              existingOpenTrade.entryPrice * (existingOpenTrade.shares || 0),
            note: `Initial entry at $${Number(
              existingOpenTrade.entryPrice,
            ).toFixed(2)}`,
            positionPct: 1.0,
          });
        };

        ensureEntryInHistory();

        // Add history entry if entry price was corrected
        if (
          correctedEntryPrice !== existingOpenTrade.entryPrice &&
          !entryPriceCorrected
        ) {
          const ev = {
            type: "ENTRY_CORRECTION",
            timestamp: eventTs(),
            price: correctedEntryPrice,
            shares: correctedShares,
            value: correctedEntryPrice * correctedShares,
            note: `Entry price corrected from $${existingOpenTrade.entryPrice.toFixed(
              2,
            )} to $${correctedEntryPrice.toFixed(
              2,
            )} (was incorrectly using trigger_price)`,
          };
          history.push(ev);
          newHistoryEvents.push(ev);
        }

        const oldStatus = existingOpenTrade.status || "OPEN";
        const oldTrimmedPct = Number(existingOpenTrade.trimmedPct || 0);
        const newTrimmedPct = Number(
          tradeCalc.trimmedPct != null ? tradeCalc.trimmedPct : oldTrimmedPct,
        );
        const trimDeltaPctRaw = newTrimmedPct - oldTrimmedPct;
        const EPS = 1e-6;
        const didTrim = trimDeltaPctRaw > EPS;

        // Determine prices/reasons used by the calc
        const currentPrice = Number(
          tickerData.price || tradeCalc.currentPrice || 0,
        );
        const trimPrice = Number(
          tradeCalc.trimPrice != null
            ? tradeCalc.trimPrice
            : tickerData.tp != null
              ? Number(tickerData.tp)
              : existingOpenTrade.tp,
        );
        const exitPrice = Number(
          tradeCalc.exitPrice != null ? tradeCalc.exitPrice : currentPrice,
        );
        const exitReason =
          tradeCalc.exitReason ||
          (shouldExitFromTDSeq
            ? "TDSEQ"
            : newStatus === "LOSS"
              ? "SL"
              : "TP_FULL");
        const exitCategory =
          tradeCalc.exitCategory ||
          (exitReason === "SL" || exitReason === "TDSEQ"
            ? "INVALIDATION"
            : exitReason === "TP_FULL"
              ? "PROFIT_MANAGEMENT"
              : null);

        // Add TRIM event whenever trimmedPct increases (supports progressive trims)
        if (didTrim) {
          const alreadyLogged = history.some((e) => {
            if (!e || e.type !== "TRIM") return false;
            const ePct = Number(
              e.trimPct != null
                ? e.trimPct
                : e.trimmedPct != null
                  ? e.trimmedPct
                  : 0,
            );
            return Math.abs(ePct - newTrimmedPct) < EPS;
          });

          if (!alreadyLogged) {
            const trimShares =
              (correctedShares || existingOpenTrade.shares || 0) *
              trimDeltaPctRaw; // Allow fractional shares
            const ev = {
              type: "TRIM",
              timestamp: eventTs(),
              price: Number.isFinite(trimPrice) ? trimPrice : null,
              shares: trimShares,
              value:
                Number.isFinite(trimPrice) && Number.isFinite(trimShares)
                  ? trimPrice * trimShares
                  : null,
              trimPct: newTrimmedPct, // total trimmed
              trimDeltaPct: trimDeltaPctRaw, // this trim step
              remainingPct: Math.max(0, 1 - newTrimmedPct),
              category:
                tradeCalc.decisionCategory ||
                tradeCalc.exitCategory ||
                "PROFIT_MANAGEMENT",
              note: `Trimmed ${Math.round(trimDeltaPctRaw * 100)}% at TP ${
                Number.isFinite(trimPrice)
                  ? `$${Number(trimPrice).toFixed(2)}`
                  : "—"
              } (total trimmed: ${Math.round(newTrimmedPct * 100)}%)`,
            };
            history.push(ev);
            newHistoryEvents.push(ev);
          }
        }

        // Add history entry for close
        if (
          (newStatus === "WIN" || newStatus === "LOSS") &&
          oldStatus !== "WIN" &&
          oldStatus !== "LOSS"
        ) {
          const remainingShares =
            (correctedShares || existingOpenTrade.shares || 0) *
            Math.max(0, 1 - oldTrimmedPct);
          const ev = {
            type: "EXIT",
            timestamp: eventTs(),
            price: exitPrice,
            shares: remainingShares,
            value: exitPrice * remainingShares,
            reason: exitReason,
            category: exitCategory,
            note: `Closed ${
              newStatus === "WIN" ? "profitably" : "at loss"
            } at $${Number(exitPrice).toFixed(2)} (${exitReason})`,
          };
          history.push(ev);
          newHistoryEvents.push(ev);
        }

        const updatedTrade = {
          ...existingOpenTrade,
          ...tradeCalc,
          entryPrice: correctedEntryPrice, // Use corrected entry price if it was corrected
          shares: correctedShares, // Use corrected shares if entry price was corrected
          entryPriceCorrected:
            correctedEntryPrice !== existingOpenTrade.entryPrice ||
            entryPriceCorrected, // Mark as corrected
          status: newStatus,
          trimmedPct: tradeCalc.trimmedPct || existingOpenTrade.trimmedPct || 0,
          lastUpdate: eventTs(),
          // Prefer the trade's current SL (may be tightened defensively)
          sl: Number.isFinite(Number(existingOpenTrade.sl))
            ? Number(existingOpenTrade.sl)
            : Number(tickerData.sl) || existingOpenTrade.sl,
          // Prefer the trade's TP plan (may be rebuilt after entry corrections)
          tpArray:
            tradeCalc.tpArray && Array.isArray(tradeCalc.tpArray)
              ? tradeCalc.tpArray
              : existingOpenTrade.tpArray,
          tp: (() => {
            const arr =
              tradeCalc.tpArray && Array.isArray(tradeCalc.tpArray)
                ? tradeCalc.tpArray
                : existingOpenTrade.tpArray;
            const first =
              Array.isArray(arr) && arr.length > 0
                ? arr
                    .map((x) => ({
                      price: Number(x?.price),
                      trimPct: Number(x?.trimPct),
                    }))
                    .filter(
                      (x) =>
                        Number.isFinite(x.price) && Number.isFinite(x.trimPct),
                    )
                    .sort((a, b) => a.trimPct - b.trimPct)[0]?.price
                : null;
            return Number.isFinite(first)
              ? first
              : Number(tickerData.tp) || existingOpenTrade.tp;
          })(),
          rr: (() => {
            const slVal = Number.isFinite(Number(existingOpenTrade.sl))
              ? Number(existingOpenTrade.sl)
              : Number(tickerData.sl) || existingOpenTrade.sl;
            const risk = Math.abs(correctedEntryPrice - Number(slVal));
            const arr =
              tradeCalc.tpArray && Array.isArray(tradeCalc.tpArray)
                ? tradeCalc.tpArray
                : existingOpenTrade.tpArray;
            const prices = Array.isArray(arr)
              ? arr
                  .map((x) => Number(x?.price))
                  .filter((p) => Number.isFinite(p))
              : [];
            const exitTp =
              prices.length > 0
                ? direction === "LONG"
                  ? Math.max(...prices)
                  : Math.min(...prices)
                : null;
            const gain =
              Number.isFinite(exitTp) && risk > 0
                ? direction === "LONG"
                  ? exitTp - correctedEntryPrice
                  : correctedEntryPrice - exitTp
                : null;
            const rrCalc =
              risk > 0 && gain != null && gain > 0 ? gain / risk : null;
            return rrCalc || Number(tickerData.rr) || existingOpenTrade.rr || 0;
          })(),
          rank: Number(tickerData.rank) || existingOpenTrade.rank,
          history: history,
          exitReason:
            newStatus === "WIN" || newStatus === "LOSS" ? exitReason : null,
          exitCategory:
            newStatus === "WIN" || newStatus === "LOSS" ? exitCategory : null,
          exitPrice:
            newStatus === "WIN" || newStatus === "LOSS" ? exitPrice : null,
        };

        const tradeIndex = allTrades.findIndex(
          (t) => t.id === existingOpenTrade.id,
        );
        if (tradeIndex >= 0) {
          allTrades[tradeIndex] = updatedTrade;
          await kvPutJSON(KV, tradesKey, allTrades);
          console.log(
            `[TRADE SIM] Updated trade ${ticker} ${direction}: ${oldStatus} -> ${newStatus}`,
          );

          // Persist trade + new lifecycle events to D1 ledger (best-effort)
          d1UpsertTrade(env, updatedTrade).catch((e) => {
            console.error(
              `[D1 LEDGER] Failed to upsert trade ${updatedTrade?.id}:`,
              e,
            );
          });
          if (
            updatedTrade?.id &&
            Array.isArray(newHistoryEvents) &&
            newHistoryEvents.length > 0
          ) {
            for (const ev of newHistoryEvents) {
              d1InsertTradeEvent(env, updatedTrade.id, ev).catch((e) => {
                console.error(
                  `[D1 LEDGER] Failed to insert trade event for ${updatedTrade.id}:`,
                  e,
                );
              });
            }
          }

          // Send Discord notifications for status changes
          if (env) {
            const pnl = updatedTrade.pnl || 0;
            const pnlPct = updatedTrade.pnlPct || 0;
            const findHistoryTs = (type) => {
              if (!Array.isArray(newHistoryEvents)) return Date.now();
              for (let i = newHistoryEvents.length - 1; i >= 0; i--) {
                const ev = newHistoryEvents[i];
                if (!ev || !ev.type) continue;
                if (String(ev.type).toUpperCase() === type) {
                  const ts =
                    isoToMs(ev.timestamp) || Number(ev.ts) || Date.now();
                  return Number.isFinite(ts) ? ts : Date.now();
                }
              }
              return Date.now();
            };

            // Send TRIM alert whenever a new TRIM event was created
            if (didTrim) {
              console.log(
                `[TRADE SIM] 📢 Preparing trim alert for ${ticker} ${direction} (trimmedPct ${oldTrimmedPct} -> ${newTrimmedPct})`,
              );
              const alertTs = findHistoryTs("TRIM");
              const dedupe = await shouldSendTradeDiscordEvent(KV, {
                tradeId: updatedTrade.id,
                type: "TRADE_TRIM",
                ts: alertTs,
              });
              if (dedupe.deduped) {
                console.log(
                  `[TRADE SIM] 🔁 Deduped TRIM alert for ${ticker} ${direction} (${dedupe.key})`,
                );
              } else if (
                shouldSendDiscordAlert(env, "TRADE_TRIM", {
                  newTrimmedPct,
                  trimDeltaPctRaw,
                })
              ) {
                const embed = createTradeTrimmedEmbed(
                  ticker,
                  direction,
                  updatedTrade.entryPrice,
                  currentPrice,
                  Number.isFinite(trimPrice)
                    ? trimPrice
                    : Number(updatedTrade.tp),
                  pnl,
                  pnlPct,
                  newTrimmedPct,
                  tickerData,
                  updatedTrade,
                  trimDeltaPctRaw,
                );
                const sendRes = await notifyDiscord(env, embed).catch((err) => {
                  console.error(
                    `[TRADE SIM] ❌ Failed to send trim alert for ${ticker}:`,
                    err,
                  );
                  return { ok: false, error: String(err) };
                }); // Don't let Discord errors break trade updates
                // persist alert (best-effort)
                const alertPayloadJson = (() => {
                  try {
                    return JSON.stringify(tickerData);
                  } catch {
                    return null;
                  }
                })();
                const alertMetaJson = (() => {
                  try {
                    return JSON.stringify({
                      type: "TRADE_TRIM",
                      trade_id: updatedTrade.id,
                      trimmed_pct: newTrimmedPct,
                      trim_delta_pct: trimDeltaPctRaw,
                    });
                  } catch {
                    return null;
                  }
                })();
                d1UpsertAlert(env, {
                  alert_id: buildAlertId(ticker, alertTs, "TRADE_TRIM"),
                  ticker,
                  ts: alertTs,
                  side: direction,
                  state: tickerData.state,
                  rank: updatedTrade.rank,
                  rr_at_alert: updatedTrade.rr,
                  trigger_reason: "TRADE_TRIM",
                  dedupe_day: formatDedupDay(alertTs),
                  discord_sent: !!sendRes?.ok,
                  discord_status: sendRes?.status ?? null,
                  discord_error: sendRes?.ok
                    ? null
                    : sendRes?.reason ||
                      sendRes?.statusText ||
                      sendRes?.error ||
                      "discord_send_failed",
                  payload_json: alertPayloadJson,
                  meta_json: alertMetaJson,
                }).catch((e) => {
                  console.error(`[D1 LEDGER] Failed to upsert trim alert:`, e);
                });
              } else {
                console.log(
                  `[TRADE SIM] (critical-only) Skipping TRIM discord for ${ticker} (${newTrimmedPct}% total trimmed)`,
                );
              }
            }

            // Send EXIT alert on first transition into WIN/LOSS
            if (
              (newStatus === "WIN" || newStatus === "LOSS") &&
              oldStatus !== "WIN" &&
              oldStatus !== "LOSS"
            ) {
              console.log(
                `[TRADE SIM] 📢 Preparing exit alert for ${ticker} ${direction} (${newStatus})`,
              );
              const exitTs = findHistoryTs("EXIT");
              const exitDedupe = await shouldSendTradeDiscordEvent(KV, {
                tradeId: updatedTrade.id,
                type: "TRADE_EXIT",
                ts: exitTs,
              });
              if (exitDedupe.deduped) {
                console.log(
                  `[TRADE SIM] 🔁 Deduped EXIT alert for ${ticker} ${direction} (${exitDedupe.key})`,
                );
              } else {
                const embed = createTradeClosedEmbed(
                  ticker,
                  direction,
                  newStatus,
                  updatedTrade.entryPrice,
                  exitPrice,
                  pnl,
                  pnlPct,
                  updatedTrade.rank || existingOpenTrade.rank || 0,
                  updatedTrade.rr || existingOpenTrade.rr || 0,
                  tickerData,
                  updatedTrade,
                );
                const sendRes = await notifyDiscord(env, embed).catch((err) => {
                  console.error(
                    `[TRADE SIM] ❌ Failed to send exit alert for ${ticker}:`,
                    err,
                  );
                  return { ok: false, error: String(err) };
                }); // Don't let Discord errors break trade updates
                // persist alert (best-effort)
                const exitPayloadJson = (() => {
                  try {
                    return JSON.stringify(tickerData);
                  } catch {
                    return null;
                  }
                })();
                const exitMetaJson = (() => {
                  try {
                    return JSON.stringify({
                      type: "TRADE_EXIT",
                      trade_id: updatedTrade.id,
                      status: newStatus,
                      exit_reason: updatedTrade.exitReason || null,
                      pnl,
                      pnlPct,
                    });
                  } catch {
                    return null;
                  }
                })();
                d1UpsertAlert(env, {
                  alert_id: buildAlertId(ticker, exitTs, "TRADE_EXIT"),
                  ticker,
                  ts: exitTs,
                  side: direction,
                  state: tickerData.state,
                  rank: updatedTrade.rank,
                  rr_at_alert: updatedTrade.rr,
                  trigger_reason: updatedTrade.exitReason || "TRADE_EXIT",
                  dedupe_day: formatDedupDay(exitTs),
                  discord_sent: !!sendRes?.ok,
                  discord_status: sendRes?.status ?? null,
                  discord_error: sendRes?.ok
                    ? null
                    : sendRes?.reason ||
                      sendRes?.statusText ||
                      sendRes?.error ||
                      "discord_send_failed",
                  payload_json: exitPayloadJson,
                  meta_json: exitMetaJson,
                }).catch((e) => {
                  console.error(`[D1 LEDGER] Failed to upsert exit alert:`, e);
                });

                // If this was a TD exit, send additional TD9/TD13 alert
                if (
                  shouldExitFromTDSeq &&
                  shouldSendDiscordAlert(env, "TD9_EXIT", { ticker, direction })
                ) {
                  console.log(
                    `[TRADE SIM] 📢 Preparing TD9 exit alert for ${ticker} ${direction}`,
                  );
                  const td9Ts = exitTs || findHistoryTs("EXIT");
                  const td9Dedupe = await shouldSendTradeDiscordEvent(KV, {
                    tradeId: updatedTrade.id,
                    type: "TD9_EXIT",
                    ts: td9Ts,
                  });
                  if (td9Dedupe.deduped) {
                    console.log(
                      `[TRADE SIM] 🔁 Deduped TD9_EXIT alert for ${ticker} ${direction} (${td9Dedupe.key})`,
                    );
                  } else {
                    const tdSeq = tickerData.td_sequential || {};
                    const td9Embed = createTD9ExitEmbed(
                      ticker,
                      direction,
                      updatedTrade.entryPrice,
                      exitPrice,
                      pnl,
                      pnlPct,
                      tdSeq,
                      tickerData,
                    );
                    const td9Res = await notifyDiscord(env, td9Embed).catch(
                      (err) => {
                        console.error(
                          `[TRADE SIM] ❌ Failed to send TD9 exit alert for ${ticker}:`,
                          err,
                        );
                        return { ok: false, error: String(err) };
                      },
                    );
                    d1UpsertAlert(env, {
                      alert_id: buildAlertId(ticker, td9Ts, "TD9_EXIT"),
                      ticker,
                      ts: td9Ts,
                      side: direction,
                      state: tickerData.state,
                      rank: updatedTrade.rank,
                      rr_at_alert: updatedTrade.rr,
                      trigger_reason: "TDSEQ_EXIT",
                      dedupe_day: formatDedupDay(td9Ts),
                      discord_sent: !!td9Res?.ok,
                      discord_status: td9Res?.status ?? null,
                      discord_error: td9Res?.ok
                        ? null
                        : td9Res?.reason ||
                          td9Res?.statusText ||
                          td9Res?.error ||
                          "discord_send_failed",
                      payload_json: exitPayloadJson,
                      meta_json: exitMetaJson,
                    }).catch((e) => {
                      console.error(
                        `[D1 LEDGER] Failed to upsert TD9 exit alert:`,
                        e,
                      );
                    });
                  }
                }
              }
            }
          } else {
            console.log(
              `[TRADE SIM] ⚠️ Skipping Discord alert for ${ticker} ${direction} status change (${oldStatus} -> ${newStatus}) - env not available`,
            );
          }
        }
      }
    } else {
      // Check if we should create a new trade
      // ALWAYS prefer price field from TradingView for entry price
      // Only use trigger_price as fallback if price is missing or invalid
      const currentPrice = tickerData.price ? Number(tickerData.price) : null;
      const triggerPrice = tickerData.trigger_price
        ? Number(tickerData.trigger_price)
        : null;

      // Detect backfill: if trigger_ts is significantly older
      const triggerTimestamp =
        tickerData.trigger_ts != null
          ? new Date(Number(tickerData.trigger_ts)).toISOString()
          : tickerData.ts != null
            ? new Date(Number(tickerData.ts)).toISOString()
            : null;
      const now = Date.now();
      const triggerTime = triggerTimestamp
        ? new Date(triggerTimestamp).getTime()
        : null;
      const isBackfill = triggerTime && now - triggerTime > 60 * 60 * 1000; // More than 1 hour old

      let entryPrice;
      let priceSource;

      // ALWAYS use current price if available and valid (> 0)
      // For new trades, we want the entry price to reflect the CURRENT market price,
      // not a historical trigger_price, so traders see accurate entry levels
      if (currentPrice && currentPrice > 0) {
        entryPrice = currentPrice;
        priceSource = isBackfill ? "price (backfill, using current)" : "price";
        console.log(
          `[TRADE SIM] Using current price $${currentPrice.toFixed(
            2,
          )} as entry price${
            isBackfill
              ? " (backfill detected, but using current price for accuracy)"
              : " (real-time)"
          }`,
        );
      } else if (triggerPrice && triggerPrice > 0) {
        // Fallback: only use trigger_price if price is not available
        entryPrice = triggerPrice;
        priceSource = "trigger_price (fallback)";
        console.log(
          `[TRADE SIM] ⚠️ Using trigger_price $${triggerPrice.toFixed(
            2,
          )} as fallback (price not available)`,
        );
      } else {
        // No valid price available - cannot create trade
        console.log(
          `[TRADE SIM] ⚠️ Cannot create trade for ${ticker}: no valid price or trigger_price`,
        );
        return; // Exit early if no valid price
      }

      console.log(
        `[TRADE SIM] ${ticker} entry price: $${entryPrice.toFixed(
          2,
        )} (from ${priceSource}${
          isBackfill ? ", BACKFILL" : ""
        }), current price: $${Number(tickerData.price || 0).toFixed(
          2,
        )}, trigger_price: ${
          tickerData.trigger_price
            ? "$" + Number(tickerData.trigger_price).toFixed(2)
            : "null"
        }`,
      );
      const entryRR = calculateRRAtEntry(tickerData, entryPrice);

      // Create a temporary tickerData with entry RR for checking conditions
      const tickerDataForCheck = {
        ...tickerData,
        rr: entryRR, // Use entry RR instead of current RR
      };

      const shouldTrigger = shouldTriggerTradeSimulation(
        ticker,
        tickerDataForCheck,
        prevData,
      );

      // Log detailed check results for debugging
      const h = Number(tickerData.htf_score);
      const l = Number(tickerData.ltf_score);
      const state = String(tickerData.state || "");
      const alignedLong = state === "HTF_BULL_LTF_BULL";
      const alignedShort = state === "HTF_BEAR_LTF_BEAR";
      const inCorridor =
        Number.isFinite(h) &&
        Number.isFinite(l) &&
        ((h > 0 && l >= -10 && l <= 22) || (h < 0 && l >= -12 && l <= 10));
      const side =
        h > 0 && l >= -10 && l <= 22
          ? "LONG"
          : h < 0 && l >= -12 && l <= 10
            ? "SHORT"
            : null;
      const corridorAlignedOK =
        (side === "LONG" && alignedLong) || (side === "SHORT" && alignedShort);

      const flags = tickerData.flags || {};
      const momentumElite = !!flags.momentum_elite;
      const baseMinRR = 1.5;
      const minRR = momentumElite ? Math.max(1.2, baseMinRR * 0.9) : baseMinRR;

      const rrOk = (entryRR || 0) >= minRR;
      const compOk =
        (Number(tickerData.completion) || 0) <= (momentumElite ? 0.5 : 0.4);
      const phaseOk =
        (Number(tickerData.phase_pct) || 0) <= (momentumElite ? 0.7 : 0.6);

      console.log(
        `[TRADE SIM] ${ticker} ${direction}: shouldTrigger=${shouldTrigger}, entryRR=${
          entryRR?.toFixed(2) || "null"
        }, currentRR=${tickerData.rr?.toFixed(2) || "null"}, rank=${
          tickerData.rank || 0
        }, state=${state}`,
      );
      console.log(
        `[TRADE SIM] ${ticker} checks: inCorridor=${inCorridor}, corridorAlignedOK=${corridorAlignedOK}, rrOk=${rrOk} (${
          entryRR?.toFixed(2) || "null"
        } >= ${minRR}), compOk=${compOk}, phaseOk=${phaseOk}`,
      );

      if (!shouldTrigger) {
        console.log(
          `[TRADE SIM] ❌ ${ticker} ${direction}: Trade creation BLOCKED - conditions not met`,
        );
        return; // Exit early - do not create trade
      }

      if (shouldTrigger) {
        const now = Date.now();
        const recentCloseWindow = 5 * 60 * 1000; // 5 minutes

        // Check for recently closed trade (prevent rapid re-entry)
        const recentlyClosedTrade = allTrades.find(
          (t) =>
            t.ticker === ticker &&
            t.direction === direction &&
            (t.status === "WIN" || t.status === "LOSS") &&
            t.entryTime &&
            now - new Date(t.entryTime).getTime() < recentCloseWindow,
        );

        // Check for existing open trade
        // Allow new position if entry price is significantly different (>5%) - enables scaling in
        const anyOpenTrade = allTrades.find(
          (t) =>
            t.ticker === ticker &&
            t.direction === direction &&
            (t.status === "OPEN" || !t.status || t.status === "TP_HIT_TRIM"),
        );

        // If open trade exists, check if entry price is significantly different
        let shouldBlockOpenTrade = false;
        if (anyOpenTrade && anyOpenTrade.entryPrice) {
          const existingEntryPrice = Number(anyOpenTrade.entryPrice);
          const priceDiffPct =
            Math.abs(entryPrice - existingEntryPrice) / existingEntryPrice;
          // Block only if entry prices are within 5% of each other (too similar to be scaling in)
          shouldBlockOpenTrade = priceDiffPct < 0.05; // 5% threshold

          if (shouldBlockOpenTrade) {
            console.log(
              `[TRADE SIM] ⚠️ ${ticker} ${direction}: Open trade exists with similar entry price (${existingEntryPrice.toFixed(
                2,
              )} vs ${entryPrice.toFixed(2)}, diff: ${(
                priceDiffPct * 100
              ).toFixed(2)}%)`,
            );
          } else {
            // Scaling in - merge into existing trade
            console.log(
              `[TRADE SIM] ℹ️ ${ticker} ${direction}: Scaling in - entry price differs significantly (${existingEntryPrice.toFixed(
                2,
              )} vs ${entryPrice.toFixed(2)}, diff: ${(
                priceDiffPct * 100
              ).toFixed(2)}%)`,
            );

            // Calculate new average entry price and total shares
            const existingShares = anyOpenTrade.shares || 0;
            const existingValue = existingEntryPrice * existingShares;
            // Calculate shares based on asset type (futures vs stocks)
            const tickerUpper = String(ticker || "").toUpperCase();
            const isFutures =
              FUTURES_SPECS[tickerUpper] || tickerUpper.endsWith("1!");
            const newShares =
              isFutures && FUTURES_SPECS[tickerUpper]
                ? 1
                : TRADE_SIZE / entryPrice;
            const newValue = entryPrice * newShares;
            const totalShares = existingShares + newShares;
            const totalValue = existingValue + newValue;
            const avgEntryPrice =
              totalShares > 0 ? totalValue / totalShares : entryPrice;

            // Update existing trade with scaled-in position
            const tradeCalc = calculateTradePnl(
              tickerData,
              avgEntryPrice,
              anyOpenTrade,
            );
            if (tradeCalc) {
              // Add history entry for scaling in
              const history = anyOpenTrade.history || [
                {
                  type: "ENTRY",
                  timestamp: anyOpenTrade.entryTime,
                  price: existingEntryPrice,
                  shares: existingShares,
                  value: existingValue,
                  note: `Initial entry at $${existingEntryPrice.toFixed(2)}`,
                },
              ];

              history.push({
                type: "SCALE_IN",
                timestamp: eventTs(),
                price: entryPrice,
                shares: newShares,
                value: newValue,
                note: `Scaled in at $${entryPrice.toFixed(
                  2,
                )} (avg entry now $${avgEntryPrice.toFixed(2)})`,
              });

              const updatedTrade = {
                ...anyOpenTrade,
                entryPrice: avgEntryPrice, // Update to average entry price
                shares: totalShares,
                ...tradeCalc,
                history: history,
                lastUpdate: eventTs(),
              };

              const tradeIndex = allTrades.findIndex(
                (t) => t.id === anyOpenTrade.id,
              );
              if (tradeIndex >= 0) {
                allTrades[tradeIndex] = updatedTrade;
                await kvPutJSON(KV, tradesKey, allTrades);
                console.log(
                  `[TRADE SIM] ✅ Scaled in ${ticker} ${direction} - Avg Entry: $${avgEntryPrice.toFixed(
                    2,
                  )}, Total Shares: ${totalShares}`,
                );

                // Persist to D1 ledger (best-effort)
                d1UpsertTrade(env, updatedTrade).catch((e) => {
                  console.error(
                    `[D1 LEDGER] Failed to upsert scaled-in trade:`,
                    e,
                  );
                });
                const scaleEvent = history[history.length - 1];
                if (scaleEvent && updatedTrade?.id) {
                  d1InsertTradeEvent(env, updatedTrade.id, scaleEvent).catch(
                    (e) => {
                      console.error(
                        `[D1 LEDGER] Failed to insert SCALE_IN event:`,
                        e,
                      );
                    },
                  );
                }

                // Send Discord notification for scaling in
                if (env) {
                  const embed = {
                    title: `📈 Position Scaled In: ${ticker} ${direction}`,
                    color: 0x00ff00,
                    fields: [
                      {
                        name: "New Entry Price",
                        value: `$${entryPrice.toFixed(2)}`,
                        inline: true,
                      },
                      {
                        name: "Average Entry Price",
                        value: `$${avgEntryPrice.toFixed(2)}`,
                        inline: true,
                      },
                      {
                        name: "Total Shares",
                        value: `${totalShares}`,
                        inline: true,
                      },
                      {
                        name: "Current Price",
                        value: `$${Number(tickerData.price).toFixed(2)}`,
                        inline: true,
                      },
                      {
                        name: "Current P&L",
                        value: `$${tradeCalc.pnl?.toFixed(2) || "0.00"} (${
                          tradeCalc.pnlPct?.toFixed(2) || "0.00"
                        }%)`,
                        inline: true,
                      },
                    ],
                    footer: {
                      text: "Timed Trading Simulator",
                    },
                    timestamp: new Date().toISOString(),
                  };
                  if (
                    shouldSendDiscordAlert(env, "SYSTEM", {
                      ticker,
                      kind: "trade_merge",
                    })
                  ) {
                    await notifyDiscord(env, embed).catch(() => {});
                  }
                }
              }
            }

            // Don't create a new trade - we've merged into existing
            return;
          }
        } else if (anyOpenTrade) {
          // Open trade exists but no entry price - block to be safe
          shouldBlockOpenTrade = true;
        }

        // Check for closed trades on subsequent days with similar entry price
        // Allow scaling/pyramiding if price differs significantly (>2%), but block if price is nearly the same
        const priceThreshold = entryPrice * 0.02; // 2% threshold for "nearly the same"
        const today = new Date(now);
        today.setHours(0, 0, 0, 0);
        const todayStart = today.getTime();

        // Find closed trades from previous days (not today) with similar entry price
        const similarPriceClosedTrade = allTrades.find((t) => {
          if (
            t.ticker === ticker &&
            t.direction === direction &&
            (t.status === "WIN" || t.status === "LOSS") &&
            t.entryPrice &&
            t.entryTime
          ) {
            const entryDate = new Date(t.entryTime);
            entryDate.setHours(0, 0, 0, 0);
            const entryDayStart = entryDate.getTime();

            // Only check trades from previous days (not today)
            const isPreviousDay = entryDayStart < todayStart;

            // Check if price is nearly the same (within 2%)
            const priceDiff = Math.abs(Number(t.entryPrice) - entryPrice);
            const isSimilarPrice = priceDiff < priceThreshold;

            return isPreviousDay && isSimilarPrice;
          }
          return false;
        });

        // Check for open trades with similar price (existing logic - keep this)
        const similarPriceOpenTrade = allTrades.find(
          (t) =>
            t.ticker === ticker &&
            t.direction === direction &&
            (t.status === "OPEN" || !t.status || t.status === "TP_HIT_TRIM") &&
            t.entryPrice &&
            Math.abs(Number(t.entryPrice) - entryPrice) < priceThreshold,
        );

        // Log why trade was rejected if applicable
        if (recentlyClosedTrade) {
          console.log(
            `[TRADE SIM] ⚠️ ${ticker} ${direction}: Skipping - recently closed trade (within 5 min)`,
          );
        } else if (shouldBlockOpenTrade) {
          console.log(
            `[TRADE SIM] ⚠️ ${ticker} ${direction}: Skipping - open trade already exists with similar entry price`,
          );
        } else if (similarPriceOpenTrade) {
          console.log(
            `[TRADE SIM] ⚠️ ${ticker} ${direction}: Skipping - open trade exists with similar entry price (${Number(
              similarPriceOpenTrade.entryPrice,
            ).toFixed(2)} vs ${entryPrice.toFixed(2)}, diff: ${(
              (Math.abs(Number(similarPriceOpenTrade.entryPrice) - entryPrice) /
                entryPrice) *
              100
            ).toFixed(2)}%)`,
          );
        } else if (similarPriceClosedTrade) {
          console.log(
            `[TRADE SIM] ⚠️ ${ticker} ${direction}: Skipping - closed trade from previous day with similar entry price (${Number(
              similarPriceClosedTrade.entryPrice,
            ).toFixed(2)} vs ${entryPrice.toFixed(2)}, diff: ${(
              (Math.abs(
                Number(similarPriceClosedTrade.entryPrice) - entryPrice,
              ) /
                entryPrice) *
              100
            ).toFixed(2)}%, closed: ${similarPriceClosedTrade.entryTime})`,
          );
        } else {
          // Price differs significantly or no similar trade found - allow scaling/pyramiding
          if (similarPriceClosedTrade === undefined && anyOpenTrade) {
            console.log(
              `[TRADE SIM] ℹ️ ${ticker} ${direction}: Price differs significantly from previous day's closed trade - allowing scaling/pyramiding`,
            );
          }
        }

        if (
          !recentlyClosedTrade &&
          !shouldBlockOpenTrade &&
          !similarPriceOpenTrade &&
          !similarPriceClosedTrade
        ) {
          const tradeCalc = calculateTradePnl(tickerData, entryPrice);

          if (tradeCalc) {
            console.log(
              `[TRADE SIM] ✅ Creating new trade ${ticker} ${direction} - Entry: $${entryPrice.toFixed(
                2,
              )}, RR: ${entryRR?.toFixed(2) || "N/A"}`,
            );
            // Determine entry time: use ingest ts when reprocessing/replay, or trigger_ts for backfill, otherwise now
            const entryTime =
              Number.isFinite(asOfMs)
                ? new Date(asOfMs).toISOString()
                : forceUseIngestTs && (tickerData.ts != null || triggerTimestamp)
                  ? (tickerData.ts != null ? new Date(Number(tickerData.ts) < 1e12 ? Number(tickerData.ts) * 1000 : Number(tickerData.ts)).toISOString() : triggerTimestamp)
                  : isBackfill && triggerTimestamp
                    ? triggerTimestamp
                    : new Date().toISOString();

            // Build intelligent TP array with progressive trim levels (25%, 50%, 75%)
            const tpArray = buildIntelligentTPArray(
              tickerData,
              entryPrice,
              direction,
            );
            if (tpArray.length === 0) {
              console.error(
                `[TRADE SIM] ❌ ${ticker} ${direction}: Cannot create trade - no valid TP array found`,
              );
              return; // Exit early if no valid TP array
            }

            // Use first TP (25% trim level) as primary TP for backward compatibility
            const validTP = tpArray[0].price;

            // Calculate RR using max TP from array
            const maxTP = Math.max(...tpArray.map((tp) => tp.price));
            const sl = Number(tickerData.sl);
            const risk = Math.abs(entryPrice - sl);
            const gain =
              direction === "LONG" ? maxTP - entryPrice : entryPrice - maxTP;
            const calculatedRR = risk > 0 && gain > 0 ? gain / risk : null;

            const trade = {
              id: `${ticker}-${now}-${Math.random().toString(36).substr(2, 9)}`,
              ticker,
              direction,
              entryPrice,
              entryTime: entryTime, // When trade was actually created
              triggerTimestamp: triggerTimestamp, // When signal was generated (for reference)
              sl: Number(tickerData.sl),
              tp: validTP, // Primary TP (first level, 25% trim)
              tpArray: tpArray, // Store full TP array for progressive trimming
              rr: calculatedRR || entryRR || Number(tickerData.rr) || 0, // Use calculated RR from max TP
              rank: Number(tickerData.rank) || 0,
              state: tickerData.state,
              flags: tickerData.flags || {},
              scriptVersion: tickerData.script_version || "unknown",
              trimmedPct: 0, // Start with 0% trimmed
              // Trade history/audit trail
              history: [
                {
                  type: "ENTRY",
                  timestamp: entryTime,
                  price: entryPrice,
                  shares: tradeCalc.shares || 0,
                  value: entryPrice * (tradeCalc.shares || 0),
                  note: `Initial entry at $${entryPrice.toFixed(2)}${
                    triggerTimestamp
                      ? ` (signal: ${new Date(
                          triggerTimestamp,
                        ).toLocaleString()})`
                      : ""
                  }`,
                },
              ],
              ...tradeCalc,
            };

            allTrades.push(trade);
            allTrades.sort((a, b) => {
              const timeA = new Date(a.entryTime || 0).getTime();
              const timeB = new Date(b.entryTime || 0).getTime();
              return timeB - timeA;
            });

            // CRITICAL: Save trade to KV with retry logic to ensure it persists
            // This ensures the trade is saved even if the request is canceled
            // Use retry with verification to handle race conditions
            const saveResult = await kvPutJSONWithRetry(
              KV,
              tradesKey,
              allTrades,
            );
            if (saveResult.success) {
              console.log(
                `[TRADE SIM] ✅ Created new trade ${ticker} ${direction} (Rank ${
                  trade.rank
                }, Entry RR ${trade.rr.toFixed(2)}) - Saved to KV (attempt ${
                  saveResult.attempt
                }${saveResult.note ? `, ${saveResult.note}` : ""})`,
              );
            } else {
              console.error(
                `[TRADE SIM] ❌ Failed to save trade ${ticker} ${direction} after ${saveResult.attempts} attempts:`,
                saveResult.error,
              );
              // Still log the trade creation even if save failed
              // The trade will be recreated on next ingestion if conditions are met
              console.log(
                `[TRADE SIM] ⚠️ Trade ${ticker} ${direction} created but NOT saved - will retry on next ingestion`,
              );
            }

            // Persist new trade + ENTRY event to D1 ledger (best-effort)
            d1UpsertTrade(env, trade).catch((e) => {
              console.error(
                `[D1 LEDGER] Failed to upsert new trade ${ticker}:`,
                e,
              );
            });
            const entryEvent =
              Array.isArray(trade.history) && trade.history.length > 0
                ? trade.history[0]
                : null;
            if (entryEvent && trade?.id) {
              d1InsertTradeEvent(env, trade.id, entryEvent).catch((e) => {
                console.error(
                  `[D1 LEDGER] Failed to insert ENTRY event for ${ticker}:`,
                  e,
                );
              });
            }

            // Send Discord notification for new trade entry
            // Only send alert if this is a real-time trade (not a backfill)
            // Backfills can have misleading entry prices and confuse traders
            if (env && !isBackfill) {
              console.log(
                `[TRADE SIM] 📢 Preparing entry alert for ${ticker} ${direction}`,
              );

              // CRITICAL: If we're sending a Discord alert, ensure the trade is saved
              // Retry KV write if it failed, since we have enough confidence to alert
              if (!saveResult.success) {
                console.log(
                  `[TRADE SIM] 🔄 Retrying KV save for ${ticker} ${direction} before sending alert`,
                );
                const retryResult = await kvPutJSONWithRetry(
                  KV,
                  tradesKey,
                  allTrades,
                  null,
                  5,
                );
                if (retryResult.success) {
                  console.log(
                    `[TRADE SIM] ✅ Trade ${ticker} ${direction} saved on retry (attempt ${retryResult.attempt})`,
                  );
                } else {
                  console.error(
                    `[TRADE SIM] ❌ Trade ${ticker} ${direction} STILL not saved after retry - alerting anyway but trade may be lost`,
                  );
                }
              }

              const allowDiscord = shouldSendDiscordAlert(env, "TRADE_ENTRY", {
                ticker,
                rank: trade.rank || 0,
                rr: entryRR || 0,
                momentumElite: !!tickerData?.flags?.momentum_elite,
              });

              const embed = allowDiscord
                ? createTradeEntryEmbed(
                    ticker,
                    direction,
                    entryPrice,
                    Number(tickerData.sl),
                    validTP, // Use validated TP
                    entryRR || 0,
                    trade.rank || 0,
                    tickerData.state || "N/A",
                    Number(tickerData.price), // Current price for comparison
                    isBackfill,
                    tickerData, // Pass full ticker data for comprehensive embed
                  )
                : null;
              const sendRes = allowDiscord
                ? await notifyDiscord(env, embed).catch((err) => {
                    console.error(
                      `[TRADE SIM] ❌ Failed to send entry alert for ${ticker}:`,
                      err,
                    );
                    return { ok: false, error: String(err) };
                  }) // Don't let Discord errors break trade creation
                : {
                    ok: false,
                    skipped: true,
                    reason: "suppressed_critical_only",
                  };

              const entryTs =
                isoToMs(trade.entryTime) ||
                Number(trade.entry_ts) ||
                Date.now();
              const entryPayloadJson = (() => {
                try {
                  return JSON.stringify(tickerData);
                } catch {
                  return null;
                }
              })();
              const entryMetaJson = (() => {
                try {
                  return JSON.stringify({
                    type: "TRADE_ENTRY",
                    trade_id: trade.id,
                    entry_price: entryPrice,
                    sl: Number(tickerData.sl),
                    tp: validTP,
                  });
                } catch {
                  return null;
                }
              })();
              d1UpsertAlert(env, {
                alert_id: buildAlertId(ticker, entryTs, "TRADE_ENTRY"),
                ticker,
                ts: entryTs,
                side: direction,
                state: tickerData.state,
                rank: trade.rank || 0,
                rr_at_alert: entryRR || 0,
                trigger_reason: "TRADE_ENTRY",
                dedupe_day: formatDedupDay(entryTs),
                discord_sent: !!sendRes?.ok,
                discord_status: sendRes?.status ?? null,
                discord_error: sendRes?.ok
                  ? null
                  : sendRes?.reason ||
                    sendRes?.statusText ||
                    sendRes?.error ||
                    "discord_send_failed",
                payload_json: entryPayloadJson,
                meta_json: entryMetaJson,
              }).catch((e) => {
                console.error(`[D1 LEDGER] Failed to upsert entry alert:`, e);
              });

              // Log trade entry to activity feed
              try {
                await appendActivity(KV, {
                  ticker,
                  type: "trade_entry",
                  direction: direction,
                  action: "entry",
                  entryPrice: entryPrice,
                  sl: Number(tickerData.sl),
                  tp: validTP,
                  maxTP:
                    tickerData.tp_levels &&
                    Array.isArray(tickerData.tp_levels) &&
                    tickerData.tp_levels.length > 0
                      ? Math.max(
                          ...tickerData.tp_levels
                            .map((tp) =>
                              typeof tp === "object" && tp.price
                                ? Number(tp.price)
                                : Number(tp),
                            )
                            .filter((p) => Number.isFinite(p)),
                        )
                      : validTP,
                  rr: entryRR || 0,
                  rank: trade.rank || 0,
                  state: tickerData.state || "N/A",
                  htf_score: tickerData.htf_score,
                  ltf_score: tickerData.ltf_score,
                  completion: tickerData.completion,
                  phase_pct: tickerData.phase_pct,
                  price: Number(tickerData.price),
                  tradeId: trade.id,
                });
              } catch (activityErr) {
                console.error(
                  `[TRADE SIM] Failed to log trade entry to activity feed for ${ticker}:`,
                  activityErr,
                );
              }
            } else if (env && isBackfill) {
              console.log(
                `[TRADE SIM] ⚠️ Skipping Discord alert for ${ticker} ${direction} - backfill trade (entry: $${entryPrice.toFixed(
                  2,
                )}, current: $${Number(tickerData.price).toFixed(2)})`,
              );
            } else if (!env) {
              console.log(
                `[TRADE SIM] ⚠️ Skipping Discord alert for ${ticker} ${direction} - env not available`,
              );
            }
          } else {
            console.log(
              `[TRADE SIM] ⚠️ ${ticker} ${direction}: tradeCalc returned null`,
            );
          }
        }
      } else {
        // Log why trade wasn't created
        const rr = entryRR || Number(tickerData.rr) || 0;
        const comp = Number(tickerData.completion) || 0;
        const phase = Number(tickerData.phase_pct) || 0;
        const rank = Number(tickerData.rank) || 0;
        const h = Number(tickerData.htf_score);
        const l = Number(tickerData.ltf_score);
        const hFinite = Number.isFinite(h);
        const lFinite = Number.isFinite(l);
        const inCorridor =
          hFinite &&
          lFinite &&
          ((h > 0 && l >= -8 && l <= 12) || (h < 0 && l >= -12 && l <= 8));
        const aligned =
          tickerData.state === "HTF_BULL_LTF_BULL" ||
          tickerData.state === "HTF_BEAR_LTF_BEAR";

        // Determine why inCorridor is false
        let corridorReason = "";
        if (!hFinite || !lFinite) {
          corridorReason = `HTF/LTF scores invalid (HTF: ${
            hFinite ? h.toFixed(2) : "invalid"
          }, LTF: ${lFinite ? l.toFixed(2) : "invalid"})`;
        } else if (h > 0) {
          // LONG corridor check
          if (l < -8) {
            corridorReason = `LTF too low for LONG corridor (LTF: ${l.toFixed(
              2,
            )} < -8)`;
          } else if (l > 12) {
            corridorReason = `LTF too high for LONG corridor (LTF: ${l.toFixed(
              2,
            )} > 12)`;
          } else {
            corridorReason = `Should be in LONG corridor (HTF: ${h.toFixed(
              2,
            )} > 0, LTF: ${l.toFixed(2)} in [-8, 12])`;
          }
        } else if (h < 0) {
          // SHORT corridor check
          if (l < -12) {
            corridorReason = `LTF too low for SHORT corridor (LTF: ${l.toFixed(
              2,
            )} < -12)`;
          } else if (l > 8) {
            corridorReason = `LTF too high for SHORT corridor (LTF: ${l.toFixed(
              2,
            )} > 8)`;
          } else {
            corridorReason = `Should be in SHORT corridor (HTF: ${h.toFixed(
              2,
            )} < 0, LTF: ${l.toFixed(2)} in [-12, 8])`;
          }
        } else {
          corridorReason = `HTF is zero (HTF: ${h.toFixed(
            2,
          )}, neither LONG nor SHORT corridor)`;
        }

        // Check shouldTriggerTradeSimulation conditions
        const shouldTrigger = shouldTriggerTradeSimulation(
          ticker,
          tickerData,
          prevData,
        );

        console.log(
          `[TRADE SIM] ❌ ${ticker} ${direction}: Conditions not met`,
          {
            entryRR: entryRR?.toFixed(2),
            currentRR: tickerData.rr?.toFixed(2),
            comp,
            phase,
            rank,
            state: tickerData.state,
            htf_score: hFinite ? h.toFixed(2) : "invalid",
            ltf_score: lFinite ? l.toFixed(2) : "invalid",
            inCorridor,
            corridorReason,
            aligned,
            shouldTrigger,
            // Show what shouldTriggerTradeSimulation checks
            hasPrice: !!tickerData.price,
            hasSL: !!tickerData.sl,
            hasTP: !!tickerData.tp,
            trigger_reason: tickerData.trigger_reason || "none",
            sq30_release: !!(tickerData.flags && tickerData.flags.sq30_release),
            momentum_elite: !!(
              tickerData.flags && tickerData.flags.momentum_elite
            ),
          },
        );
      }
    }
  } catch (err) {
    console.error(`[TRADE SIM ERROR] ${ticker}:`, err);
  }
}

//─────────────────────────────────────────────────────────────────────────────
// Momentum Elite Calculation (Worker-Based with Caching)
//─────────────────────────────────────────────────────────────────────────────

// Fetch market cap from external API (placeholder - implement with your preferred API)
async function fetchMarketCap(ticker) {
  // TODO: Implement with Alpha Vantage, Yahoo Finance, or other API
  // For now, return null to skip market cap check
  // Example: const response = await fetch(`https://api.example.com/marketcap/${ticker}`);
  return null; // Will be implemented with actual API
}

// Calculate Average Daily Range (ADR) from price data
function calculateADR(price, high, low) {
  if (!price || price <= 0) return null;
  const dailyRange = (high - low) / price;
  return dailyRange;
}

// Calculate percentage change over period
function calculatePctChange(current, previous) {
  if (!previous || previous <= 0) return null;
  return (current - previous) / previous;
}

// Check if ticker meets Momentum Elite criteria
async function computeMomentumElite(KV, ticker, payload) {
  const cacheKey = `timed:momentum:${ticker}`;
  const now = Date.now();

  // Check cache (5 minute TTL for final status)
  const cached = await kvGetJSON(KV, cacheKey);
  if (cached && now - cached.timestamp < 5 * 60 * 1000) {
    return cached;
  }

  const price = Number(payload.price) || 0;

  // All base criteria must be true:
  // 1. Price > $4
  const priceOver4 = price >= 4.0;

  // 2. Market Cap > $1B (cached for 24 hours)
  // NOTE: Market cap is not enforced for Momentum Elite in this build (UI expectation),
  // but we still compute it for informational/debug purposes.
  const marketCapKey = `timed:momentum:marketcap:${ticker}`;
  let marketCapOver1B = true; // Default to true if we can't check
  const marketCapCache = await kvGetJSON(KV, marketCapKey);
  if (marketCapCache && now - marketCapCache.timestamp < 24 * 60 * 60 * 1000) {
    marketCapOver1B = marketCapCache.value;
  } else {
    // Fetch fresh market cap
    const marketCap = await fetchMarketCap(ticker);
    if (marketCap !== null) {
      marketCapOver1B = marketCap >= 1000000000;
      await kvPutJSON(
        KV,
        marketCapKey,
        { value: marketCapOver1B, timestamp: now },
        24 * 60 * 60,
      );
    }
  }

  // 3. Average Daily Range (ADR) (looser, cached for 1 hour)
  // Prefer TradingView heartbeat fields when present.
  const adrKey = `timed:momentum:adr:${ticker}`;
  let adrOk = true; // Looser: if we can't compute ADR, don't block
  const adrCache = await kvGetJSON(KV, adrKey);
  if (adrCache && now - adrCache.timestamp < 60 * 60 * 1000) {
    adrOk = !!adrCache.value;
  } else {
    // Prefer ADR from payload:
    // - Heartbeat sends `adr_14` as an absolute $ range
    // - Some sources may provide `adr_pct_14` as a fraction (0.02 == 2%)
    const adrAbs = Number(payload.adr_14);
    const adrPctDirect = Number(payload.adr_pct_14);

    const priceForAdr = price > 0 ? price : Number(payload.price) || 0;
    const adrPct =
      Number.isFinite(adrPctDirect) && adrPctDirect > 0
        ? adrPctDirect
        : Number.isFinite(adrAbs) && adrAbs > 0 && priceForAdr > 0
          ? adrAbs / priceForAdr
          : null;

    if (Number.isFinite(adrAbs) && adrAbs > 0) {
      // Looser than $2: treat >= $1 as "OK"
      adrOk = adrAbs >= 1.0;
    } else if (Number.isFinite(adrPct) && adrPct > 0) {
      // Looser than 2%: treat >= 1.5% as "OK"
      adrOk = adrPct >= 0.015;
    } else {
      // Fallback: if only OHLC is available, estimate ADR as a percent of price (legacy).
      const high = Number(payload.high ?? payload.h) || price;
      const low = Number(payload.low ?? payload.l) || price;
      const adrPct = calculateADR(price, high, low); // fraction of price
      // Looser: accept >= 1.5% if computed
      adrOk = adrPct != null && Number.isFinite(adrPct) && adrPct >= 0.015;
    }
    await kvPutJSON(KV, adrKey, { value: adrOk, timestamp: now }, 60 * 60);
  }

  // 4. Average Volume (30 days) > 2M (cached for 1 hour)
  // Prefer TradingView heartbeat fields when present (most accurate).
  const volumeKey = `timed:momentum:volume:${ticker}`;
  let volumeOver2M = false;
  const volumeCache = await kvGetJSON(KV, volumeKey);
  if (volumeCache && now - volumeCache.timestamp < 60 * 60 * 1000) {
    volumeOver2M = volumeCache.value;
  } else {
    const avgVol30 = Number(payload.avg_vol_30);
    const avgVol50 = Number(payload.avg_vol_50);
    const avgVol =
      Number.isFinite(avgVol30) && avgVol30 > 0
        ? avgVol30
        : Number.isFinite(avgVol50) && avgVol50 > 0
          ? avgVol50
          : Number(payload.volume) || 0;
    volumeOver2M = avgVol >= 2000000;
    await kvPutJSON(
      KV,
      volumeKey,
      { value: volumeOver2M, timestamp: now },
      60 * 60,
    );
  }

  // All base criteria (looser ADR gate)
  const allBaseCriteria = priceOver4 && adrOk && volumeOver2M;

  // Any momentum criteria (cached for 15 minutes):
  // Prefer TradingView payload data (most accurate), fallback to trail history
  const momentumKey = `timed:momentum:changes:${ticker}`;
  let anyMomentumCriteria = false;
  const momentumCache = await kvGetJSON(KV, momentumKey);
  if (momentumCache && now - momentumCache.timestamp < 15 * 60 * 1000) {
    anyMomentumCriteria = momentumCache.value;
  } else {
    // First, try to use momentum_pct from TradingView payload (most accurate)
    const momentumPct = payload.momentum_pct || {};
    const weekPct = momentumPct.week != null ? Number(momentumPct.week) : null;
    const monthPct =
      momentumPct.month != null ? Number(momentumPct.month) : null;
    const threeMonthsPct =
      momentumPct.three_months != null
        ? Number(momentumPct.three_months)
        : null;
    const sixMonthsPct =
      momentumPct.six_months != null ? Number(momentumPct.six_months) : null;

    if (monthPct != null) {
      // Align to TradingView screener-style filter: 1M change >= 25%
      anyMomentumCriteria = Number.isFinite(monthPct) && monthPct >= 25.0;
    } else {
      // Fallback: Calculate from trail history (for older data or if TradingView doesn't send it)
      const trailKey = `timed:trail:${ticker}`;
      const trail = (await kvGetJSON(KV, trailKey)) || [];

      if (trail.length > 0 && price > 0) {
        const currentPrice = price;
        const now = Date.now();

        // Time periods in milliseconds
        const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000;
        const oneMonthAgo = now - 30 * 24 * 60 * 60 * 1000;
        const threeMonthsAgo = now - 90 * 24 * 60 * 60 * 1000;
        const sixMonthsAgo = now - 180 * 24 * 60 * 60 * 1000;

        // Find closest trail points to these times (by timestamp)
        const findClosestPrice = (targetTime) => {
          let closest = null;
          let minDiff = Infinity;
          for (const point of trail) {
            if (!point.ts) continue;
            const diff = Math.abs(point.ts - targetTime);
            if (diff < minDiff) {
              minDiff = diff;
              // Try to get price from point (might be in different fields)
              const pointPrice =
                Number(point.price) || Number(point.close) || null;
              if (pointPrice && pointPrice > 0) {
                closest = pointPrice;
              }
            }
          }
          return closest;
        };

        const priceWeekAgo = findClosestPrice(oneWeekAgo);
        const priceMonthAgo = findClosestPrice(oneMonthAgo);
        const price3MonthsAgo = findClosestPrice(threeMonthsAgo);
        const price6MonthsAgo = findClosestPrice(sixMonthsAgo);

        // Calculate percentage changes
        const monthOver25Pct =
          priceMonthAgo && priceMonthAgo > 0
            ? (currentPrice - priceMonthAgo) / priceMonthAgo >= 0.25
            : false;
        anyMomentumCriteria = !!monthOver25Pct;
      } else {
        // No trail data yet, default to false
        anyMomentumCriteria = false;
      }
    }

    // Cache result
    await kvPutJSON(
      KV,
      momentumKey,
      { value: anyMomentumCriteria, timestamp: now },
      15 * 60,
    );
  }

  const momentumElite = allBaseCriteria && anyMomentumCriteria;

  // Store result with metadata
  const result = {
    momentum_elite: momentumElite,
    criteria: {
      priceOver4,
      marketCapOver1B,
      // Back-compat name: still called adrOver2 in UI, but now means "ADR gate passed (looser)".
      adrOver2: adrOk,
      volumeOver2M,
      allBaseCriteria,
      anyMomentumCriteria,
    },
    timestamp: now,
  };

  // Check for status change and log history
  const prevStatus = cached ? cached.momentum_elite : false;
  if (momentumElite !== prevStatus) {
    const historyKey = `timed:momentum:history:${ticker}`;
    const history = (await kvGetJSON(KV, historyKey)) || [];
    history.push({
      status: momentumElite,
      timestamp: now,
      criteria: result.criteria,
    });
    // Keep last 100 status changes
    const trimmedHistory = history.slice(-100);
    await kvPutJSON(KV, historyKey, trimmedHistory);
  }

  // Cache result (keep long enough for UI filtering between bar closes)
  await kvPutJSON(KV, cacheKey, result, 6 * 60 * 60);

  return result;
}

function computeRank(d) {
  const htf = Number(d.htf_score);
  const ltf = Number(d.ltf_score);
  const comp = completionForSize(d);
  const phase = Number(d.phase_pct);
  const rr = d.rr != null ? Number(d.rr) : computeRR(d);

  const flags = d.flags || {};
  const sqRel = !!flags.sq30_release;
  const sqOn = !!flags.sq30_on;
  const phaseZoneChange = !!flags.phase_zone_change;
  const momentumElite = !!flags.momentum_elite;
  const emaCross1H1348 = !!flags.ema_cross_1h_13_48;
  const buyableDip1H1348 = !!flags.buyable_dip_1h_13_48;

  const state = String(d.state || "");
  const aligned =
    state === "HTF_BULL_LTF_BULL" || state === "HTF_BEAR_LTF_BEAR";
  const setup =
    state === "HTF_BULL_LTF_PULLBACK" || state === "HTF_BEAR_LTF_PULLBACK";

  // ADJUSTED SCORING: More discriminating, lower base
  let score = 30; // Reduced from 50 to make scoring more selective

  // Data completeness: slightly down-rank incomplete payloads so “Today/Prime” stays sane.
  const completeness = d?.data_completeness || computeDataCompleteness(d);
  if (completeness && typeof completeness === "object") {
    if (completeness.score < 70) score -= 10;
    else if (completeness.score < 85) score -= 5;
    else if (completeness.score < 95) score -= 2;
  }

  // Per-TF technical structure alignment (bonus/penalty).
  const tfAlign = d?.tf_summary || tfTechAlignmentSummary(d);
  if (
    tfAlign &&
    typeof tfAlign === "object" &&
    Number.isFinite(tfAlign.score)
  ) {
    score += tfAlign.score;
  }

  // Explicit triggers[] “why now” boost.
  const trig = d?.trigger_summary || triggerSummaryAndScore(d);
  if (trig && typeof trig === "object" && Number.isFinite(trig.score)) {
    score += trig.score;
  }

  // Move status: invalidate/completed moves should fall out of “best setups”
  const ms = d?.move_status || computeMoveStatus(d);
  if (ms && typeof ms === "object") {
    if (ms.status === "INVALIDATED") score -= 25;
    else if (ms.status === "COMPLETED") score -= 15;
  }

  // State bonuses (reduced)
  if (aligned) score += 12; // Reduced from 15
  if (setup) score += 4; // Reduced from 5

  // HTF/LTF contributions (more selective - require stronger signals)
  if (Number.isFinite(htf)) {
    const htfAbs = Math.abs(htf);
    // Only give full credit for strong HTF signals (>= 25)
    if (htfAbs >= 25) score += Math.min(10, htfAbs * 0.4);
    else if (htfAbs >= 15)
      score += Math.min(7, htfAbs * 0.35); // Reduced for moderate signals
    else score += Math.min(4, htfAbs * 0.25); // Minimal for weak signals
  }

  if (Number.isFinite(ltf)) {
    const ltfAbs = Math.abs(ltf);
    // Only give full credit for strong LTF signals (>= 20)
    if (ltfAbs >= 20) score += Math.min(10, ltfAbs * 0.3);
    else if (ltfAbs >= 12)
      score += Math.min(6, ltfAbs * 0.25); // Reduced for moderate signals
    else score += Math.min(3, ltfAbs * 0.2); // Minimal for weak signals
  }

  // Completion bonus (reduced and more selective)
  if (Number.isFinite(comp)) {
    // Early completion gets more points, but cap reduced
    if (comp <= 0.2)
      score += 15; // Excellent (0-20% completion)
    else if (comp <= 0.4)
      score += 10; // Good (20-40% completion)
    else if (comp <= 0.6) score += 5; // Moderate (40-60% completion)
    // No bonus for completion > 60%
  }

  // Phase penalty (starts earlier, more aggressive)
  if (Number.isFinite(phase)) {
    if (phase > 0.5) score -= Math.max(0, (phase - 0.5) * 30); // Penalty starts at 50% instead of 60%
    // Early phase (< 50%) gets small bonus
    if (phase <= 0.3) score += 3; // Early phase bonus
  }

  // Squeeze bonuses (reduced)
  if (sqRel)
    score += 12; // Reduced from 15
  else if (sqOn) score += 4; // Reduced from 6

  // Phase zone change bonus (reduced)
  if (phaseZoneChange) score += 2; // Reduced from 3

  // RR contribution (more selective - requires better RR)
  if (Number.isFinite(rr)) {
    if (rr >= 2.0)
      score += 10; // Excellent RR (2.0+)
    else if (rr >= 1.5)
      score += 7; // Good RR (1.5-2.0)
    else if (rr >= 1.2) score += 4; // Acceptable RR (1.2-1.5)
    // No bonus for RR < 1.2
  }

  // Momentum Elite boost (reduced but still significant)
  if (momentumElite) score += 15; // Reduced from 20

  // 1H 13/48 cross + buyable-dip nuance
  // - Cross is a strong pivot/confirmation marker
  // - Dip-after-cross is a premium pullback entry opportunity
  if (emaCross1H1348) score += 5;
  if (buyableDip1H1348) score += 7;

  // RSI Divergence boost/penalty
  const rsi = d.rsi;
  if (rsi && rsi.divergence) {
    const divType = String(rsi.divergence.type || "none");
    const divStrength = Number(rsi.divergence.strength || 0);
    if (divType === "bullish") {
      score += 3 + Math.min(2, divStrength * 0.1); // Boost for bullish divergence
    } else if (divType === "bearish") {
      score -= 3 - Math.min(2, divStrength * 0.1); // Penalty for bearish divergence
    }
  }

  // TD Sequential boost/penalty (from Pine Script calculation)
  const tdSeq = d.td_sequential || {};
  const tdSeqBoost = Number(tdSeq.boost) || 0;
  if (Number.isFinite(tdSeqBoost) && tdSeqBoost !== 0) {
    score += tdSeqBoost;
  }

  score = Math.max(0, Math.min(100, score));
  return Math.round(score);
}

// ─────────────────────────────────────────────────────────────
// Live Thesis features (seq + deltas) computed from trail
// Mirrors feature families used in scripts/analyze-best-setups.js
// ─────────────────────────────────────────────────────────────

function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function flagOn(flags, k) {
  if (!flags || typeof flags !== "object") return false;
  const v = flags[k];
  return v === true || v === 1 || v === "true";
}

function orderedWithin(a, b, maxMs) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(maxMs))
    return false;
  return b >= a && b - a <= maxMs;
}

function normalizeTrailPoint(p) {
  if (!p || typeof p !== "object") return null;
  const ts = Number(p.ts ?? p.timestamp ?? p.ingest_ts ?? p.ingest_time);
  const price = Number(p.price ?? p.__price);
  return {
    __ts: Number.isFinite(ts) ? ts : null,
    __price: Number.isFinite(price) ? price : null,
    htf_score: p.htf_score != null ? Number(p.htf_score) : null,
    ltf_score: p.ltf_score != null ? Number(p.ltf_score) : null,
    completion: p.completion != null ? Number(p.completion) : null,
    phase_pct: p.phase_pct != null ? Number(p.phase_pct) : null,
    state: p.state != null ? String(p.state) : "",
    rank: p.rank != null ? Number(p.rank) : null,
    trigger_reason: p.trigger_reason != null ? String(p.trigger_reason) : null,
    trigger_dir:
      p.trigger_dir != null ? String(p.trigger_dir).trim().toUpperCase() : null,
    __flags: p.flags && typeof p.flags === "object" ? p.flags : {},
  };
}

function directionForThesis(p, fallbackPayload = null) {
  const fromTrig =
    (fallbackPayload && fallbackPayload.trigger_dir) || (p && p.trigger_dir);
  const td = String(fromTrig || "")
    .trim()
    .toUpperCase();
  if (td === "LONG" || td === "SHORT") return td;

  const st = String(
    (fallbackPayload && fallbackPayload.state) || (p && p.state) || "",
  );
  if (st.includes("BEAR")) return "SHORT";
  if (st.includes("BULL")) return "LONG";

  const htf = Number(
    (fallbackPayload && fallbackPayload.htf_score) || (p && p.htf_score),
  );
  if (Number.isFinite(htf) && htf < 0) return "SHORT";
  if (Number.isFinite(htf) && htf > 0) return "LONG";
  return null;
}

function lowerBoundTs(points, tsTarget, idxHiExclusive) {
  let lo = 0;
  let hi = Math.max(
    0,
    Number.isFinite(idxHiExclusive) ? idxHiExclusive : points.length,
  );
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const ts = Number(points[mid]?.__ts);
    if (!Number.isFinite(ts) || ts < tsTarget) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function lookbackDeltas(points, idx0, lookbackMs) {
  const p0 = points[idx0];
  const t0 = Number(p0?.__ts);
  if (!Number.isFinite(t0) || !Number.isFinite(lookbackMs) || lookbackMs <= 0)
    return null;
  const idxHi = Math.max(0, idx0);
  if (idxHi <= 0) return null;
  const tsTarget = t0 - lookbackMs;
  const idx = lowerBoundTs(points, tsTarget, idxHi);
  const p1 = points[Math.min(idx, idxHi - 1)];
  if (!p1) return null;

  const htf0 = Number(p0?.htf_score);
  const ltf0 = Number(p0?.ltf_score);
  const px0 = Number(p0?.__price);
  const t1 = Number(p1?.__ts);
  const htf1 = Number(p1?.htf_score);
  const ltf1 = Number(p1?.ltf_score);
  const px1 = Number(p1?.__price);

  const dtMs = Number.isFinite(t1) ? t0 - t1 : null;
  const dHtf =
    Number.isFinite(htf0) && Number.isFinite(htf1) ? htf0 - htf1 : null;
  const dLtf =
    Number.isFinite(ltf0) && Number.isFinite(ltf1) ? ltf0 - ltf1 : null;
  const dPxPct =
    Number.isFinite(px0) && Number.isFinite(px1) && px1 > 0
      ? (px0 - px1) / px1
      : null;

  return {
    lookbackMs,
    t1: Number.isFinite(t1) ? t1 : null,
    dtMs,
    deltaHtf: dHtf,
    deltaLtf: dLtf,
    deltaPricePct: dPxPct,
  };
}

function isWinnerSignatureSnapshotForThesis(p) {
  const flags = p?.__flags || {};
  const state = String(p?.state || "");
  const isSetup = state.includes("PULLBACK");
  const inCorridor = corridorSide(p) != null;
  const completion = clamp01(p?.completion);
  const phasePct = clamp01(p?.phase_pct);
  const inSqueeze = flagOn(flags, "sq30_on") && !flagOn(flags, "sq30_release");
  return (
    isSetup && inCorridor && completion < 0.15 && (phasePct < 0.6 || inSqueeze)
  );
}

function isPrimeLikeSnapshotForThesis(p) {
  const flags = p?.__flags || {};
  const state = String(p?.state || "");
  const inCorridor = corridorSide(p) != null;
  const rank = Number(p?.rank);
  const completion = clamp01(p?.completion);
  const phase = clamp01(p?.phase_pct);
  const aligned =
    state === "HTF_BULL_LTF_BULL" || state === "HTF_BEAR_LTF_BEAR";
  const sqRel = flagOn(flags, "sq30_release");
  const phaseZoneChange = flagOn(flags, "phase_zone_change");
  return (
    inCorridor &&
    (Number.isFinite(rank) ? rank >= 75 : false) &&
    completion < 0.4 &&
    phase < 0.6 &&
    (aligned || sqRel || phaseZoneChange)
  );
}

function computeLiveThesisFeaturesFromTrail(trailPoints, payload) {
  const H1 = 60 * 60 * 1000;
  const LOOKBACK_4H = 4 * H1;
  const LOOKBACK_1D = 24 * H1;

  const raw = Array.isArray(trailPoints) ? trailPoints : [];
  const pts = raw
    .map(normalizeTrailPoint)
    .filter((x) => x && Number.isFinite(x.__ts))
    .sort((a, b) => Number(a.__ts) - Number(b.__ts));

  const empty = {
    seq: {
      recentSqueezeRelease_6h: false,
      recentSqueezeOn_6h: false,
      corridorEntry_60m: false,
      pattern: {
        squeezeReleaseToMomentum_6h: false,
        squeezeOnToRelease_24h: false,
      },
    },
    deltas: { htf_4h: null, ltf_4h: null, htf_1d: null },
    flags: {
      htf_improving_4h: false,
      htf_improving_1d: false,
      htf_move_4h_ge_5: false,
      thesis_match: false,
    },
  };
  if (pts.length < 2) return empty;

  let lastCorridorEntryTs = null;
  let lastSqueezeOnTs = null;
  let lastSqueezeReleaseTs = null;
  let lastSetupToMomentumTs = null;

  for (let i = 1; i < pts.length; i++) {
    const p = pts[i];
    const prev = pts[i - 1];
    const ts = Number(p.__ts);
    if (!Number.isFinite(ts)) continue;

    const ent = corridorSide(p) != null;
    const entPrev = corridorSide(prev) != null;

    const flags = p.__flags || {};
    const flagsPrev = prev.__flags || {};

    const st = String(p.state || "");
    const stPrev = String(prev.state || "");
    const isPullback = st.includes("PULLBACK");
    const wasPullback = stPrev.includes("PULLBACK");
    const isMomentum =
      (st.includes("LTF_BULL") || st.includes("LTF_BEAR")) && !isPullback;

    if (!entPrev && ent) lastCorridorEntryTs = ts;
    if (flagOn(flags, "sq30_on") && !flagOn(flagsPrev, "sq30_on"))
      lastSqueezeOnTs = ts;
    if (flagOn(flags, "sq30_release") && !flagOn(flagsPrev, "sq30_release"))
      lastSqueezeReleaseTs = ts;
    if (wasPullback && isMomentum) lastSetupToMomentumTs = ts;
  }

  const latest = pts[pts.length - 1];
  const nowTs = Number(latest.__ts);
  const since = {
    corridorEntryMs: Number.isFinite(lastCorridorEntryTs)
      ? Math.max(0, nowTs - lastCorridorEntryTs)
      : null,
    squeezeOnMs: Number.isFinite(lastSqueezeOnTs)
      ? Math.max(0, nowTs - lastSqueezeOnTs)
      : null,
    squeezeReleaseMs: Number.isFinite(lastSqueezeReleaseTs)
      ? Math.max(0, nowTs - lastSqueezeReleaseTs)
      : null,
  };

  const deltas4h = lookbackDeltas(pts, pts.length - 1, LOOKBACK_4H);
  const deltas1d = lookbackDeltas(pts, pts.length - 1, LOOKBACK_1D);

  const dir = directionForThesis(latest, payload);
  const htf_4h = deltas4h ? deltas4h.deltaHtf : null;
  const ltf_4h = deltas4h ? deltas4h.deltaLtf : null;
  const htf_1d = deltas1d ? deltas1d.deltaHtf : null;

  const htf_improving_4h =
    !!dir &&
    Number.isFinite(htf_4h) &&
    ((dir === "LONG" && htf_4h > 0) || (dir === "SHORT" && htf_4h < 0));
  const htf_improving_1d =
    !!dir &&
    Number.isFinite(htf_1d) &&
    ((dir === "LONG" && htf_1d > 0) || (dir === "SHORT" && htf_1d < 0));
  const htf_move_4h_ge_5 = Number.isFinite(htf_4h) && Math.abs(htf_4h) >= 5;

  const seq = {
    recentSqueezeRelease_6h:
      since.squeezeReleaseMs != null && since.squeezeReleaseMs <= 6 * H1,
    recentSqueezeOn_6h:
      since.squeezeOnMs != null && since.squeezeOnMs <= 6 * H1,
    corridorEntry_60m:
      since.corridorEntryMs != null && since.corridorEntryMs <= 60 * 60 * 1000,
    pattern: {
      squeezeReleaseToMomentum_6h: orderedWithin(
        lastSqueezeReleaseTs,
        lastSetupToMomentumTs,
        6 * H1,
      ),
      squeezeOnToRelease_24h: orderedWithin(
        lastSqueezeOnTs,
        lastSqueezeReleaseTs,
        24 * H1,
      ),
    },
  };

  const primeLike = isPrimeLikeSnapshotForThesis(latest);
  const winnerSignature = isWinnerSignatureSnapshotForThesis(latest);

  const rank = Number(payload?.rank ?? latest?.rank);
  const completion = clamp01(payload?.completion ?? latest?.completion);
  const phase = clamp01(payload?.phase_pct ?? latest?.phase_pct);
  const rr = (() => {
    const n = Number(payload?.rr);
    if (Number.isFinite(n)) return n;
    const v = computeRR(payload);
    return Number.isFinite(v) ? Number(v) : null;
  })();

  const baseGate =
    Number.isFinite(rank) &&
    rank >= 74 &&
    Number.isFinite(rr) &&
    rr >= 1.5 &&
    Number.isFinite(completion) &&
    completion <= 0.6 + 1e-9 &&
    Number.isFinite(phase) &&
    phase <= 0.6 + 1e-9;

  const A = seq.pattern.squeezeReleaseToMomentum_6h && htf_move_4h_ge_5;
  const B = seq.recentSqueezeRelease_6h && htf_improving_4h;
  const C =
    (primeLike && htf_move_4h_ge_5) || (winnerSignature && htf_improving_4h);
  const thesis_match = !!baseGate && (A || B || C);

  return {
    seq,
    deltas: { htf_4h, ltf_4h, htf_1d },
    flags: {
      htf_improving_4h,
      htf_improving_1d,
      htf_move_4h_ge_5,
      thesis_match,
    },
  };
}

async function appendTrail(KV, ticker, point, maxN = 8) {
  const key = `timed:trail:${ticker}`;
  const cur = (await kvGetJSON(KV, key)) || [];
  cur.push(point);
  const keep = cur.length > maxN ? cur.slice(cur.length - maxN) : cur;
  await kvPutJSON(KV, key, keep);
  return keep;
}

async function appendCaptureTrail(KV, ticker, point, maxN = 48) {
  const key = `timed:capture:trail:${ticker}`;
  const cur = (await kvGetJSON(KV, key)) || [];
  cur.push(point);
  const keep = cur.length > maxN ? cur.slice(cur.length - maxN) : cur;
  await kvPutJSON(KV, key, keep);
}

// ─────────────────────────────────────────────────────────────
// D1 Trail Storage (7-day historical)
// ─────────────────────────────────────────────────────────────

async function d1InsertTrailPoint(env, ticker, payload) {
  const db = env?.DB;
  if (!db) return { ok: false, skipped: true, reason: "no_db_binding" };

  const ts = Number(payload?.ts);
  if (!Number.isFinite(ts))
    return { ok: false, skipped: true, reason: "bad_ts" };

  const point = {
    ts,
    price: payload?.price,
    htf_score: payload?.htf_score,
    ltf_score: payload?.ltf_score,
    completion: payload?.completion,
    phase_pct: payload?.phase_pct,
    state: payload?.state,
    rank: payload?.rank,
    flags: payload?.flags || {},
    trigger_reason: payload?.trigger_reason,
    trigger_dir: payload?.trigger_dir,
  };

  const flagsJson =
    point?.flags && typeof point.flags === "object"
      ? JSON.stringify(point.flags)
      : point?.flags != null
        ? JSON.stringify(point.flags)
        : null;

  try {
    await db
      .prepare(
        `INSERT OR REPLACE INTO timed_trail
          (ticker, ts, price, htf_score, ltf_score, completion, phase_pct, state, rank, flags_json, trigger_reason, trigger_dir, payload_json)
         VALUES
          (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
      )
      .bind(
        String(ticker || "").toUpperCase(),
        ts,
        point?.price != null ? Number(point.price) : null,
        point?.htf_score != null ? Number(point.htf_score) : null,
        point?.ltf_score != null ? Number(point.ltf_score) : null,
        point?.completion != null ? Number(point.completion) : null,
        point?.phase_pct != null ? Number(point.phase_pct) : null,
        point?.state != null ? String(point.state) : null,
        point?.rank != null ? Number(point.rank) : null,
        flagsJson,
        point?.trigger_reason != null ? String(point.trigger_reason) : null,
        point?.trigger_dir != null ? String(point.trigger_dir) : null,
        (() => {
          try {
            return JSON.stringify(payload);
          } catch {
            return null;
          }
        })(),
      )
      .run();

    return { ok: true };
  } catch (err) {
    console.error(`[D1 TRAIL] Insert failed for ${ticker}:`, err);
    return { ok: false, error: String(err) };
  }
}

async function d1InsertIngestReceipt(env, ticker, payload, rawPayload) {
  const db = env?.DB;
  if (!db) return { ok: false, skipped: true, reason: "no_db_binding" };

  const ts = Number(payload?.ts);
  if (!Number.isFinite(ts))
    return { ok: false, skipped: true, reason: "bad_ts" };

  let raw = typeof rawPayload === "string" ? rawPayload : "";
  if (!raw) {
    try {
      raw = JSON.stringify(payload);
    } catch {
      raw = "";
    }
  }
  const hash = stableHash(raw || "");
  const receiptId = `${String(ticker || "").toUpperCase()}:${ts}:${hash}`;
  const bucket5m = Math.floor(ts / (5 * 60 * 1000)) * (5 * 60 * 1000);
  const receivedTs = Date.now();
  const scriptVersion = payload?.script_version || null;

  try {
    await db
      .prepare(
        `INSERT OR IGNORE INTO ingest_receipts
          (receipt_id, ticker, ts, bucket_5m, received_ts, payload_hash, script_version, payload_json)
         VALUES
          (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      )
      .bind(
        receiptId,
        String(ticker || "").toUpperCase(),
        ts,
        bucket5m,
        receivedTs,
        hash,
        scriptVersion,
        raw || null,
      )
      .run();

    return { ok: true };
  } catch (err) {
    console.error(`[D1 INGEST] Receipt insert failed for ${ticker}:`, err);
    return { ok: false, error: String(err) };
  }
}

// ─────────────────────────────────────────────────────────────
// D1 Latest Snapshot Storage (fast reads for UI)
// ─────────────────────────────────────────────────────────────

async function d1EnsureLatestSchema(env) {
  const db = env?.DB;
  if (!db) return { ok: false, skipped: true, reason: "no_db_binding" };

  // Throttle schema checks to ~once/day
  const KV = env?.KV_TIMED;
  const throttleKey = "timed:d1:latest:schema_ok_ms";
  try {
    if (KV) {
      const last = Number(await KV.get(throttleKey));
      if (Number.isFinite(last) && Date.now() - last < 24 * 60 * 60 * 1000) {
        return { ok: true, skipped: true, reason: "throttled" };
      }
    }
  } catch {
    // ignore
  }

  try {
    // Index of tickers we know about (baseline)
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS ticker_index (
          ticker TEXT PRIMARY KEY,
          first_seen_ts INTEGER NOT NULL,
          last_seen_ts INTEGER NOT NULL
        )`,
      )
      .run();

    // Latest snapshot per ticker (for UI reads)
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS ticker_latest (
          ticker TEXT PRIMARY KEY,
          ts INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          kanban_stage TEXT,
          prev_kanban_stage TEXT,
          payload_json TEXT NOT NULL
        )`,
      )
      .run();

    // Best-effort schema migration for existing deployments (D1/SQLite doesn't support IF NOT EXISTS for ADD COLUMN)
    try {
      await db
        .prepare(`ALTER TABLE ticker_latest ADD COLUMN prev_kanban_stage TEXT`)
        .run();
    } catch {
      // ignore (already exists)
    }

    await db
      .prepare(
        `CREATE INDEX IF NOT EXISTS idx_ticker_latest_ts ON ticker_latest (ts)`,
      )
      .run();
    await db
      .prepare(
        `CREATE INDEX IF NOT EXISTS idx_ticker_latest_kanban_stage ON ticker_latest (kanban_stage)`,
      )
      .run();
    await db
      .prepare(
        `CREATE INDEX IF NOT EXISTS idx_ticker_latest_prev_kanban_stage ON ticker_latest (prev_kanban_stage)`,
      )
      .run();

    try {
      if (KV)
        await KV.put(throttleKey, String(Date.now()), {
          expirationTtl: 7 * 24 * 60 * 60,
        });
    } catch {
      // ignore
    }

    return { ok: true };
  } catch (err) {
    console.error("[D1 LATEST] Schema ensure failed:", err);
    return { ok: false, error: String(err) };
  }
}

// ─────────────────────────────────────────────────────────────
// D1 Candle Storage (multi-timeframe OHLCV)
// ─────────────────────────────────────────────────────────────

async function d1EnsureCandleSchema(env) {
  const db = env?.DB;
  if (!db) return { ok: false, skipped: true, reason: "no_db_binding" };

  // Throttle schema checks to ~once/day
  const KV = env?.KV_TIMED;
  const throttleKey = "timed:d1:candles:schema_ok_ms";
  try {
    if (KV) {
      const last = Number(await KV.get(throttleKey));
      if (Number.isFinite(last) && Date.now() - last < 24 * 60 * 60 * 1000) {
        return { ok: true, skipped: true, reason: "throttled" };
      }
    }
  } catch {
    // ignore
  }

  try {
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS ticker_candles (
          ticker TEXT NOT NULL,
          tf TEXT NOT NULL,
          ts INTEGER NOT NULL,
          o REAL,
          h REAL,
          l REAL,
          c REAL,
          v REAL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (ticker, tf, ts)
        )`,
      )
      .run();

    await db
      .prepare(
        `CREATE INDEX IF NOT EXISTS idx_ticker_candles_ticker_tf_ts
         ON ticker_candles (ticker, tf, ts DESC)`,
      )
      .run();

    try {
      if (KV)
        await KV.put(throttleKey, String(Date.now()), {
          expirationTtl: 7 * 24 * 60 * 60,
        });
    } catch {
      // ignore
    }

    return { ok: true };
  } catch (err) {
    console.error("[D1 CANDLES] Schema ensure failed:", err);
    return { ok: false, error: String(err) };
  }
}

// ─────────────────────────────────────────────────────────────
// ML v1 (online, lightweight) — schema + model utils
// ─────────────────────────────────────────────────────────────

// Keep KV key stable for admin reset + migrations.
const ML_V1_MODEL_KEY = "timed:model:ml_v1";
let ML_V1_CACHE = { model: null, loadedAt: 0 };

function mlV1Sigmoid(z) {
  const n = Number(z);
  if (!Number.isFinite(n)) return 0.5;
  // Clamp to avoid overflow
  const x = Math.max(-30, Math.min(30, n));
  return 1 / (1 + Math.exp(-x));
}

function mlV1DefaultModel() {
  // Keep this small + stable; we can expand later once backfill exists.
  const featureNames = [
    "bias",
    "rank_n",
    "rr_n",
    "completion",
    "phase",
    "abs_htf_n",
    "abs_ltf_n",
    "aligned",
    "setup",
    "sq_rel",
    "in_corridor",
    "momentum_elite",
  ];
  return {
    version: 1,
    featureNames,
    w: featureNames.map(() => 0),
    n: 0,
    lr: 0.05,
    l2: 0.001,
    updated_at: Date.now(),
  };
}

async function mlV1GetModel(KV) {
  const now = Date.now();
  if (ML_V1_CACHE.model && now - ML_V1_CACHE.loadedAt < 60 * 1000) {
    return ML_V1_CACHE.model;
  }
  let model = null;
  try {
    model = KV ? await kvGetJSON(KV, ML_V1_MODEL_KEY) : null;
  } catch {
    model = null;
  }
  if (!model || typeof model !== "object" || !Array.isArray(model.w)) {
    model = mlV1DefaultModel();
  }
  ML_V1_CACHE = { model, loadedAt: now };
  return model;
}

async function mlV1PutModel(KV, model) {
  if (!KV) return;
  const out =
    model && typeof model === "object" ? { ...model, updated_at: Date.now() } : null;
  if (!out) return;
  await kvPutJSON(KV, ML_V1_MODEL_KEY, out);
  ML_V1_CACHE = { model: out, loadedAt: Date.now() };
}

function mlV1ExtractX(d) {
  const flags = d?.flags && typeof d.flags === "object" ? d.flags : {};
  const state = String(d?.state || "");
  const rank = Number(d?.rank);
  const rr = Number(d?.rr);
  const completion = clamp01(d?.completion);
  const phase = clamp01(d?.phase_pct);
  const htf = Number(d?.htf_score);
  const ltf = Number(d?.ltf_score);
  const aligned =
    state === "HTF_BULL_LTF_BULL" || state === "HTF_BEAR_LTF_BEAR" ? 1 : 0;
  const setup =
    state === "HTF_BULL_LTF_PULLBACK" || state === "HTF_BEAR_LTF_PULLBACK"
      ? 1
      : 0;

  // Normalize to roughly [-1,1] where possible.
  const rank_n = Number.isFinite(rank) ? (rank - 50) / 50 : 0;
  const rr_n = Number.isFinite(rr) ? Math.max(0, Math.min(4, rr)) / 4 : 0;
  const abs_htf_n = Number.isFinite(htf) ? Math.min(1, Math.abs(htf) / 100) : 0;
  const abs_ltf_n = Number.isFinite(ltf) ? Math.min(1, Math.abs(ltf) / 100) : 0;

  const inCorridor = (() => {
    try {
      return entryType(d)?.corridor ? 1 : 0;
    } catch {
      return 0;
    }
  })();

  return [
    1,
    rank_n,
    rr_n,
    completion,
    phase,
    abs_htf_n,
    abs_ltf_n,
    aligned,
    setup,
    flagOn(flags, "sq30_release") ? 1 : 0,
    inCorridor,
    flagOn(flags, "momentum_elite") ? 1 : 0,
  ];
}

function mlV1PredictProba(model, x) {
  const w = Array.isArray(model?.w) ? model.w : [];
  const n = Math.min(w.length, Array.isArray(x) ? x.length : 0);
  let z = 0;
  for (let i = 0; i < n; i++) z += Number(w[i] || 0) * Number(x[i] || 0);
  return mlV1Sigmoid(z);
}

function mlV1AttachScore(d, model) {
  const x = mlV1ExtractX(d);
  const p = mlV1PredictProba(model, x);
  const rr = Number(d?.rr);
  const rrUnit = Number.isFinite(rr) && rr > 0 ? Math.min(4, rr) : 1;
  // EV in "R units" (treat loss as -1R, win as +RR R). Expose as percent-ish for UI.
  const evUnits = p * rrUnit - (1 - p) * 1;
  const out = {
    v: 1,
    p_win_4h: p,
    ev_4h: evUnits * 100,
    p_win_1d: p,
    ev_1d: evUnits * 100,
    n: Number(model?.n) || 0,
    updated_at: model?.updated_at || null,
  };
  d.ml_v1 = out;
  // Back-compat alias used by UI snippets
  if (d.ml == null) d.ml = out;
  if (d.model == null) d.model = out;
  return out;
}

// Back-compat helper used by ingest/latest/all to attach model fields.
async function mlV1AttachToPayload(KV, payload) {
  if (!payload || typeof payload !== "object") return payload;
  const model = await mlV1GetModel(KV);
  mlV1AttachScore(payload, model);
  return payload;
}

async function d1EnsureMlV1Schema(env) {
  const db = env?.DB;
  if (!db) return { ok: false, skipped: true, reason: "no_db_binding" };
  try {
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS ml_v1_queue (
          id TEXT PRIMARY KEY,
          ticker TEXT NOT NULL,
          ts INTEGER NOT NULL,
          horizon_ms INTEGER NOT NULL,
          dir TEXT,
          entry_price REAL,
          features_json TEXT,
          label_due_ts INTEGER NOT NULL,
          y INTEGER,
          labeled_at INTEGER,
          created_at INTEGER NOT NULL
        )`,
      )
      .run();
    await db
      .prepare(
        `CREATE INDEX IF NOT EXISTS idx_ml_v1_queue_due ON ml_v1_queue (label_due_ts)`,
      )
      .run();
    return { ok: true };
  } catch (e) {
    console.error("[D1 ML] Schema ensure failed:", e);
    return { ok: false, error: String(e) };
  }
}

async function d1EnqueueMlV1(env, ticker, payload, horizonsMs) {
  const db = env?.DB;
  if (!db) return { ok: false, skipped: true, reason: "no_db_binding" };
  const ts = Number(payload?.ts);
  const price = Number(payload?.price);
  if (!Number.isFinite(ts) || !Number.isFinite(price) || price <= 0)
    return { ok: false, skipped: true, reason: "bad_ts_or_price" };
  await d1EnsureMlV1Schema(env);

  const dir = sideFromStateOrScores(payload);
  const x = mlV1ExtractX(payload);
  const createdAt = Date.now();

  const sym = String(ticker || "").toUpperCase();
  const hs = Array.isArray(horizonsMs) ? horizonsMs : [];
  for (const h of hs) {
    const hm = Number(h);
    if (!Number.isFinite(hm) || hm <= 0) continue;
    const due = ts + hm;
    const id = `${sym}:${ts}:${hm}`;
    try {
      await db
        .prepare(
          `INSERT OR IGNORE INTO ml_v1_queue
           (id, ticker, ts, horizon_ms, dir, entry_price, features_json, label_due_ts, y, labeled_at, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, NULL, ?9)`,
        )
        .bind(
          id,
          sym,
          ts,
          hm,
          dir != null ? String(dir) : null,
          price,
          JSON.stringify({ x }),
          due,
          createdAt,
        )
        .run();
    } catch (e) {
      console.error(`[D1 ML] enqueue failed for ${id}:`, String(e));
    }
  }
  return { ok: true };
}

async function d1NearestClose(env, ticker, tsTarget) {
  const db = env?.DB;
  if (!db) return null;
  const sym = String(ticker || "").toUpperCase();
  const t = Number(tsTarget);
  if (!sym || !Number.isFinite(t)) return null;
  
  // Query timed_trail for ingest data (has price from TradingView scripts)
  try {
    const row = await db
      .prepare(
        `SELECT ts, payload_json FROM timed_trail
         WHERE ticker=?1 AND ts>=?2
         ORDER BY ts ASC LIMIT 1`,
      )
      .bind(sym, t)
      .first();
    if (row && row.payload_json) {
      try {
        const p = JSON.parse(row.payload_json);
        const price = Number(p?.price || p?.close);
        if (Number.isFinite(price) && price > 0) return price;
      } catch {
        // ignore parse error
      }
    }
  } catch (e) {
    console.error(`[ML LABEL] Failed to get exit price for ${sym}:`, String(e));
  }
  
  // Fallback to ticker_candles if available (for chart backfill data)
  const tfs = ["3", "10", "30"];
  for (const tf of tfs) {
    try {
      const row = await db
        .prepare(
          `SELECT ts, c FROM ticker_candles
           WHERE ticker=?1 AND tf=?2 AND ts>=?3
           ORDER BY ts ASC LIMIT 1`,
        )
        .bind(sym, tf, t)
        .first();
      if (row && Number.isFinite(Number(row.c))) return Number(row.c);
    } catch {
      // ignore
    }
  }
  // Fallback to last known <= target
  for (const tf of tfs) {
    try {
      const row = await db
        .prepare(
          `SELECT ts, c FROM ticker_candles
           WHERE ticker=?1 AND tf=?2 AND ts<=?3
           ORDER BY ts DESC LIMIT 1`,
        )
        .bind(sym, tf, t)
        .first();
      if (row && Number.isFinite(Number(row.c))) return Number(row.c);
    } catch {
      // ignore
    }
  }
  return null;
}

function mlV1LabelFromHorizon(entryPrice, exitPrice, dir) {
  const ep = Number(entryPrice);
  const xp = Number(exitPrice);
  if (!Number.isFinite(ep) || !Number.isFinite(xp) || ep <= 0) return null;
  const side = String(dir || "").toUpperCase();
  const ret = (xp - ep) / ep;
  if (side === "SHORT") return ret < 0 ? 1 : 0;
  if (side === "LONG") return ret > 0 ? 1 : 0;
  // If direction unknown, just ask "up?"
  return ret > 0 ? 1 : 0;
}

async function mlV1TrainFromQueue(env, KV, maxN = 75, force = false) {
  const db = env?.DB;
  if (!db) return { ok: false, skipped: true, reason: "no_db_binding" };
  await d1EnsureMlV1Schema(env);
  const now = Date.now();
  
  // Force mode: ignore label_due_ts check (for backfilling old data)
  const query = force
    ? `SELECT id, ticker, ts, horizon_ms, dir, entry_price, features_json, label_due_ts
       FROM ml_v1_queue
       WHERE y IS NULL
       ORDER BY ts ASC
       LIMIT ?1`
    : `SELECT id, ticker, ts, horizon_ms, dir, entry_price, features_json, label_due_ts
       FROM ml_v1_queue
       WHERE y IS NULL AND label_due_ts <= ?1
       ORDER BY label_due_ts ASC
       LIMIT ?2`;
  
  const rows = force
    ? await db.prepare(query).bind(Math.max(1, Math.min(250, Number(maxN) || 75))).all()
    : await db.prepare(query).bind(now, Math.max(1, Math.min(250, Number(maxN) || 75))).all();
  const due = Array.isArray(rows?.results) ? rows.results : [];
  console.log(`[ML TRAIN] Found ${due.length} entries to process (force=${force})`);
  if (due.length === 0) return { ok: true, trained: 0 };

  let model = await mlV1GetModel(KV);
  let trained = 0;
  let skipped = { no_exit: 0, no_label: 0, no_features: 0 };

  for (const r of due) {
    const exit = await d1NearestClose(env, r.ticker, Number(r.label_due_ts));
    if (exit == null) {
      skipped.no_exit++;
      continue;
    }
    const y = mlV1LabelFromHorizon(r.entry_price, exit, r.dir);
    if (y == null) {
      skipped.no_label++;
      continue;
    }
    let x = null;
    try {
      const fj = r.features_json ? JSON.parse(String(r.features_json)) : null;
      x = Array.isArray(fj?.x) ? fj.x : null;
    } catch {
      x = null;
    }
    if (!Array.isArray(x)) continue;

    const p = mlV1PredictProba(model, x);
    const err = Number(y) - p;
    const lr = Number(model?.lr) || 0.05;
    const l2 = Number(model?.l2) || 0.001;
    const w = Array.isArray(model?.w) ? model.w.slice() : mlV1DefaultModel().w;

    for (let i = 0; i < Math.min(w.length, x.length); i++) {
      const wi = Number(w[i] || 0);
      const xi = Number(x[i] || 0);
      w[i] = wi + lr * (err * xi - l2 * wi);
    }
    model = { ...model, w, n: (Number(model?.n) || 0) + 1 };

    try {
      await db
        .prepare(
          `UPDATE ml_v1_queue SET y=?2, labeled_at=?3 WHERE id=?1`,
        )
        .bind(String(r.id), Number(y), now)
        .run();
      trained++;
    } catch {
      // ignore
    }
  }

  if (trained > 0) {
    await mlV1PutModel(KV, model);
  }
  console.log(`[ML TRAIN] Result: trained=${trained}, skipped=${JSON.stringify(skipped)}`);
  return { ok: true, trained, model_n: model.n, skipped, checked: due.length };
}

function normalizeTfKey(tf) {
  const raw = String(tf == null ? "" : tf).trim().toUpperCase();
  if (!raw) return null;
  // Allow common forms
  if (raw === "1" || raw === "1M") return "1";
  if (raw === "3" || raw === "3M") return "3";
  if (raw === "5" || raw === "5M") return "5";
  if (raw === "10" || raw === "10M") return "10";
  if (raw === "30" || raw === "30M") return "30";
  if (raw === "60" || raw === "1H" || raw === "1HR") return "60";
  if (raw === "240" || raw === "4H" || raw === "4HR") return "240";
  if (raw === "D" || raw === "1D" || raw === "DAY") return "D";
  if (raw === "W" || raw === "1W" || raw === "WEEK") return "W";
  return null;
}

async function d1UpsertCandle(env, ticker, tf, candle) {
  const db = env?.DB;
  if (!db) return { ok: false, skipped: true, reason: "no_db_binding" };
  const sym = String(ticker || "").toUpperCase();
  const tfKey = normalizeTfKey(tf);
  if (!sym || !tfKey) return { ok: false, error: "bad_params" };

  const ts = Number(candle?.ts);
  if (!Number.isFinite(ts)) return { ok: false, error: "bad_ts" };
  const o = Number(candle?.o);
  const h = Number(candle?.h);
  const l = Number(candle?.l);
  const c = Number(candle?.c);
  const v = candle?.v != null ? Number(candle?.v) : null;
  if (![o, h, l, c].every((x) => Number.isFinite(x))) {
    return { ok: false, error: "bad_ohlc" };
  }
  const updatedAt = Date.now();

  try {
    await d1EnsureCandleSchema(env);
    await db
      .prepare(
        `INSERT INTO ticker_candles (ticker, tf, ts, o, h, l, c, v, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(ticker, tf, ts) DO UPDATE SET
           o=excluded.o, h=excluded.h, l=excluded.l, c=excluded.c, v=excluded.v, updated_at=excluded.updated_at`,
      )
      .bind(sym, tfKey, ts, o, h, l, c, v, updatedAt)
      .run();
    return { ok: true };
  } catch (err) {
    console.error(`[D1 CANDLES] Upsert failed for ${sym} ${tfKey}:`, err);
    return { ok: false, error: String(err) };
  }
}

async function d1GetCandles(env, ticker, tf, limit = 200) {
  const db = env?.DB;
  if (!db) return { ok: false, error: "no_db_binding" };
  const sym = String(ticker || "").toUpperCase();
  const tfKey = normalizeTfKey(tf);
  const n = Math.max(10, Math.min(500, Number(limit) || 200));
  if (!sym || !tfKey) return { ok: false, error: "bad_params" };

  try {
    await d1EnsureCandleSchema(env);
    const rows = await db
      .prepare(
        `SELECT ts, o, h, l, c, v
         FROM ticker_candles
         WHERE ticker = ?1 AND tf = ?2
         ORDER BY ts DESC
         LIMIT ?3`,
      )
      .bind(sym, tfKey, n)
      .all();
    const out = (rows?.results || [])
      .map((r) => ({
        ts: Number(r?.ts),
        o: Number(r?.o),
        h: Number(r?.h),
        l: Number(r?.l),
        c: Number(r?.c),
        v: r?.v != null ? Number(r?.v) : null,
      }))
      .filter((x) => Number.isFinite(x.ts) && Number.isFinite(x.o))
      .sort((a, b) => a.ts - b.ts);
    return { ok: true, ticker: sym, tf: tfKey, candles: out };
  } catch (err) {
    console.error(`[D1 CANDLES] Read failed for ${sym} ${tfKey}:`, err);
    return { ok: false, error: String(err) };
  }
}

async function d1UpsertTickerIndex(env, ticker, ts) {
  const db = env?.DB;
  if (!db) return { ok: false, skipped: true, reason: "no_db_binding" };
  const sym = String(ticker || "").toUpperCase();
  const nowTs = Number(ts) || Date.now();

  try {
    await d1EnsureLatestSchema(env);
    await db
      .prepare(
        `INSERT INTO ticker_index (ticker, first_seen_ts, last_seen_ts)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(ticker) DO UPDATE SET last_seen_ts = excluded.last_seen_ts`,
      )
      .bind(sym, nowTs, nowTs)
      .run();
    return { ok: true };
  } catch (err) {
    console.error(`[D1 LATEST] Index upsert failed for ${sym}:`, err);
    return { ok: false, error: String(err) };
  }
}

async function d1UpsertTickerLatest(env, ticker, payload) {
  const db = env?.DB;
  if (!db) return { ok: false, skipped: true, reason: "no_db_binding" };
  const sym = String(ticker || "").toUpperCase();
  const ts = Number(payload?.ts) || Date.now();
  const updatedAt = Date.now();
  const stage =
    payload?.kanban_stage != null ? String(payload.kanban_stage) : null;
  const prevStage =
    payload?.prev_kanban_stage != null
      ? String(payload.prev_kanban_stage)
      : null;

  let payloadJson = null;
  try {
    payloadJson = JSON.stringify(payload);
  } catch {
    payloadJson = null;
  }
  if (!payloadJson)
    return { ok: false, skipped: true, reason: "payload_json_failed" };

  try {
    await d1EnsureLatestSchema(env);
    await db
      .prepare(
        `INSERT INTO ticker_latest (ticker, ts, updated_at, kanban_stage, prev_kanban_stage, payload_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(ticker) DO UPDATE SET
           ts = excluded.ts,
           updated_at = excluded.updated_at,
           kanban_stage = excluded.kanban_stage,
           prev_kanban_stage = excluded.prev_kanban_stage,
           payload_json = excluded.payload_json`,
      )
      .bind(sym, ts, updatedAt, stage, prevStage, payloadJson)
      .run();
    return { ok: true };
  } catch (err) {
    console.error(`[D1 LATEST] Latest upsert failed for ${sym}:`, err);
    return { ok: false, error: String(err) };
  }
}

// Patch selected fields inside ticker_latest.payload_json without rewriting the whole row.
// Uses SQLite JSON1 `json_set` to avoid a read+merge cycle.
async function d1PatchTickerLatestFields(env, ticker, patch) {
  const db = env?.DB;
  if (!db) return { ok: false, skipped: true, reason: "no_db_binding" };
  const sym = String(ticker || "").toUpperCase();
  if (!sym) return { ok: false, skipped: true, reason: "bad_ticker" };
  if (!patch || typeof patch !== "object")
    return { ok: false, skipped: true, reason: "bad_patch" };

  const pairs = [];
  const binds = [];
  const add = (k, v) => {
    if (v == null) return;
    // Keep numbers as numbers; booleans as 1/0; strings as strings.
    let val = v;
    if (typeof v === "boolean") val = v ? 1 : 0;
    pairs.push(`'$.${k}', ?${binds.length + 1}`);
    binds.push(val);
  };

  add("prev_close", patch.prev_close);
  add("day_change", patch.day_change);
  add("day_change_pct", patch.day_change_pct);
  add("change", patch.change);
  add("change_pct", patch.change_pct);
  add("session", patch.session);
  add("is_rth", patch.is_rth);

  if (pairs.length === 0)
    return { ok: false, skipped: true, reason: "no_fields" };

  try {
    await d1EnsureLatestSchema(env);
    const sql = `UPDATE ticker_latest
                 SET payload_json = json_set(payload_json, ${pairs.join(", ")})
                 WHERE ticker = ?${binds.length + 1} AND payload_json IS NOT NULL`;
    binds.push(sym);
    await db
      .prepare(sql)
      .bind(...binds)
      .run();
    return { ok: true };
  } catch (err) {
    console.error(`[D1 LATEST] Patch failed for ${sym}:`, err);
    return { ok: false, error: String(err) };
  }
}

// Periodic KV → D1 latest sync (batched) to bootstrap /timed/all quickly after deploy.
async function d1SyncLatestBatchFromKV(env, ctx, batchSize = 50) {
  const KV = env?.KV_TIMED;
  const db = env?.DB;
  if (!KV || !db)
    return { ok: false, skipped: true, reason: "missing_kv_or_db" };

  try {
    await d1EnsureLatestSchema(env);
  } catch {
    // ignore
  }

  const tickers = (await kvGetJSON(KV, "timed:tickers")) || [];
  if (!Array.isArray(tickers) || tickers.length === 0) {
    return { ok: false, skipped: true, reason: "no_tickers_index" };
  }

  const cursorKey = "timed:d1:latest_sync_cursor";
  let cursor = 0;
  try {
    cursor = Number(await KV.get(cursorKey)) || 0;
    if (!Number.isFinite(cursor) || cursor < 0) cursor = 0;
  } catch {
    cursor = 0;
  }

  const start = Date.now();
  const end = Math.min(cursor + batchSize, tickers.length);
  const slice = tickers.slice(cursor, end);

  for (const t of slice) {
    const sym = String(t || "").toUpperCase();
    if (!sym) continue;
    try {
      // Always index the ticker (even if no latest yet)
      await d1UpsertTickerIndex(env, sym, Date.now());
      const latest = await kvGetJSON(KV, `timed:latest:${sym}`);
      if (latest && typeof latest === "object") {
        // Attach ML predictions before syncing to D1
        try {
          await mlV1AttachToPayload(KV, latest);
        } catch (e) {
          console.warn(`[D1 SYNC] ML attach failed for ${sym}:`, String(e));
        }
        
        // Ensure stage exists for D1 consumers
        try {
          if (latest.kanban_stage == null) {
            const stage = classifyKanbanStage(latest);
            if (stage) latest.kanban_stage = stage;
          }
        } catch {
          // ignore
        }
        await d1UpsertTickerLatest(env, sym, latest);
      }
    } catch (e) {
      console.error(`[D1 SYNC] Failed for ${sym}:`, String(e));
    }
  }

  const nextCursor = end >= tickers.length ? 0 : end;
  try {
    await KV.put(cursorKey, String(nextCursor), {
      expirationTtl: 7 * 24 * 60 * 60,
    });
  } catch {
    // ignore
  }

  const ms = Date.now() - start;
  console.log(
    `[D1 SYNC] Synced ${slice.length}/${tickers.length} tickers in ${ms}ms (cursor ${cursor}→${nextCursor})`,
  );
  return {
    ok: true,
    synced: slice.length,
    total: tickers.length,
    ms,
    cursor,
    nextCursor,
  };
}

async function d1CleanupOldTrail(env, ttlDays = 35) {
  const db = env?.DB;
  if (!db) return { ok: false, skipped: true, reason: "no_db_binding" };

  const KV = env?.KV_TIMED;
  // throttle cleanup to at most once per hour
  const throttleKey = "timed:d1:trail:last_cleanup_ms";
  try {
    if (KV) {
      const last = Number(await KV.get(throttleKey));
      if (Number.isFinite(last) && Date.now() - last < 60 * 60 * 1000) {
        return { ok: true, skipped: true, reason: "throttled" };
      }
    }
  } catch {
    // ignore throttle failures
  }

  const cutoff = Date.now() - Number(ttlDays) * 24 * 60 * 60 * 1000;
  try {
    const r = await db
      .prepare(`DELETE FROM timed_trail WHERE ts < ?1`)
      .bind(cutoff)
      .run();

    if (KV) {
      await KV.put(throttleKey, String(Date.now()), {
        expirationTtl: 2 * 60 * 60, // 2 hours
      });
    }

    return { ok: true, deleted: r?.meta?.changes || 0, cutoff };
  } catch (err) {
    console.error(`[D1 TRAIL] Cleanup failed:`, err);
    return { ok: false, error: String(err) };
  }
}

async function d1GetTrailRange(env, ticker, sinceTs = null, limit = 5000) {
  const db = env?.DB;
  if (!db) return { ok: false, skipped: true, reason: "no_db_binding" };
  const t = String(ticker || "").toUpperCase();
  const lim = Math.max(1, Math.min(20000, Number(limit) || 5000));

  try {
    let stmt;
    if (sinceTs != null && Number.isFinite(Number(sinceTs))) {
      stmt = db
        .prepare(
          `SELECT ts, price, htf_score, ltf_score, completion, phase_pct, state, rank, flags_json, trigger_reason, trigger_dir
           FROM timed_trail
           WHERE ticker = ?1 AND ts >= ?2
           ORDER BY ts ASC
           LIMIT ?3`,
        )
        .bind(t, Number(sinceTs), lim);
    } else {
      stmt = db
        .prepare(
          `SELECT ts, price, htf_score, ltf_score, completion, phase_pct, state, rank, flags_json, trigger_reason, trigger_dir
           FROM timed_trail
           WHERE ticker = ?1
           ORDER BY ts DESC
           LIMIT ?2`,
        )
        .bind(t, lim);
    }

    const rows = await stmt.all();
    const out = Array.isArray(rows?.results) ? rows.results : [];
    const trail = out
      .map((r) => ({
        ts: Number(r.ts),
        price: r.price != null ? Number(r.price) : null,
        htf_score: r.htf_score != null ? Number(r.htf_score) : null,
        ltf_score: r.ltf_score != null ? Number(r.ltf_score) : null,
        completion: r.completion != null ? Number(r.completion) : null,
        phase_pct: r.phase_pct != null ? Number(r.phase_pct) : null,
        state: r.state != null ? String(r.state) : null,
        rank: r.rank != null ? Number(r.rank) : null,
        flags:
          r.flags_json && typeof r.flags_json === "string"
            ? (() => {
                try {
                  return JSON.parse(r.flags_json);
                } catch {
                  return {};
                }
              })()
            : {},
        momentum_elite: false, // derived in UI/logic from flags when needed
        trigger_reason:
          r.trigger_reason != null ? String(r.trigger_reason) : null,
        trigger_dir: r.trigger_dir != null ? String(r.trigger_dir) : null,
      }))
      .filter((p) => Number.isFinite(p.ts));

    // If we queried DESC (no since), normalize to ASC for consumers
    trail.sort((a, b) => a.ts - b.ts);
    return { ok: true, trail, source: "d1" };
  } catch (err) {
    console.error(`[D1 TRAIL] Query failed for ${ticker}:`, err);
    return { ok: false, error: String(err) };
  }
}

async function d1GetTrailPayloadRange(
  env,
  ticker,
  sinceTs = null,
  untilTs = null,
  limit = 5000,
) {
  const db = env?.DB;
  if (!db) return { ok: false, skipped: true, reason: "no_db_binding" };
  const t = String(ticker || "").toUpperCase();
  const lim = Math.max(1, Math.min(20000, Number(limit) || 5000));

  const since =
    sinceTs != null && Number.isFinite(Number(sinceTs))
      ? Number(sinceTs)
      : null;
  const until =
    untilTs != null && Number.isFinite(Number(untilTs))
      ? Number(untilTs)
      : null;

  try {
    let stmt;
    if (since != null && until != null) {
      stmt = db
        .prepare(
          `SELECT ts, payload_json
         FROM timed_trail
         WHERE ticker = ?1 AND ts >= ?2 AND ts <= ?3
         ORDER BY ts ASC
         LIMIT ?4`,
        )
        .bind(t, since, until, lim);
    } else if (since != null) {
      stmt = db
        .prepare(
          `SELECT ts, payload_json
         FROM timed_trail
         WHERE ticker = ?1 AND ts >= ?2
         ORDER BY ts ASC
         LIMIT ?3`,
        )
        .bind(t, since, lim);
    } else {
      stmt = db
        .prepare(
          `SELECT ts, payload_json
         FROM timed_trail
         WHERE ticker = ?1
         ORDER BY ts DESC
         LIMIT ?2`,
        )
        .bind(t, lim);
    }

    const rows = await stmt.all();
    const results = Array.isArray(rows?.results) ? rows.results : [];
    const payloads = results
      .map((r) => {
        const ts = Number(r.ts);
        const raw = r.payload_json;
        if (!raw || typeof raw !== "string") return null;
        try {
          const p = JSON.parse(raw);
          p.ts = ts; // trust DB ts
          return p;
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => Number(a.ts) - Number(b.ts));

    return { ok: true, payloads, source: "d1" };
  } catch (err) {
    console.error(`[D1 TRAIL] Payload query failed for ${ticker}:`, err);
    return { ok: false, error: String(err) };
  }
}

// ─────────────────────────────────────────────────────────────
// D1 Ledger Storage (alerts + trades + trade_events)
// ─────────────────────────────────────────────────────────────

function isoToMs(v) {
  if (v == null) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const s = String(v);
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

function formatDedupDay(ts) {
  if (!Number.isFinite(ts)) return null;
  return new Date(ts).toISOString().split("T")[0];
}

function buildAlertId(ticker, ts, type) {
  const t = String(ticker || "").toUpperCase();
  const kind = String(type || "ALERT").toUpperCase();
  return `${t}:${ts}:${kind}`;
}

async function d1UpsertAlert(env, alert) {
  const db = env?.DB;
  if (!db) return { ok: false, skipped: true, reason: "no_db_binding" };

  const ticker = String(alert?.ticker || "").toUpperCase();
  const ts = Number(alert?.ts);
  if (!ticker || !Number.isFinite(ts))
    return { ok: false, skipped: true, reason: "bad_key" };

  const alertId = String(alert?.alert_id || `${ticker}:${ts}`);
  const discordSent = alert?.discord_sent ? 1 : 0;

  try {
    await db
      .prepare(
        `INSERT OR REPLACE INTO alerts
          (alert_id, ticker, ts, side, state, rank, rr_at_alert, trigger_reason, dedupe_day,
           discord_sent, discord_status, discord_error, payload_json, meta_json)
         VALUES
          (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`,
      )
      .bind(
        alertId,
        ticker,
        ts,
        alert?.side != null ? String(alert.side) : null,
        alert?.state != null ? String(alert.state) : null,
        alert?.rank != null ? Number(alert.rank) : null,
        alert?.rr_at_alert != null ? Number(alert.rr_at_alert) : null,
        alert?.trigger_reason != null ? String(alert.trigger_reason) : null,
        alert?.dedupe_day != null ? String(alert.dedupe_day) : null,
        discordSent,
        alert?.discord_status != null ? Number(alert.discord_status) : null,
        alert?.discord_error != null ? String(alert.discord_error) : null,
        alert?.payload_json != null ? String(alert.payload_json) : null,
        alert?.meta_json != null ? String(alert.meta_json) : null,
      )
      .run();

    return { ok: true, alert_id: alertId };
  } catch (err) {
    console.error(`[D1 LEDGER] Alert upsert failed for ${ticker}:`, err);
    return { ok: false, error: String(err) };
  }
}

async function d1UpsertTrade(env, trade) {
  const db = env?.DB;
  if (!db) return { ok: false, skipped: true, reason: "no_db_binding" };
  if (!trade) return { ok: false, skipped: true, reason: "missing_trade" };

  const tradeId = String(trade.id || trade.trade_id || "").trim();
  if (!tradeId) return { ok: false, skipped: true, reason: "missing_trade_id" };

  const ticker = String(trade.ticker || "").toUpperCase();
  const direction = String(trade.direction || "").toUpperCase();
  const entryTs = isoToMs(trade.entryTime) || Number(trade.entry_ts) || null;
  const createdAt = entryTs || Date.now();
  const updatedAt = Date.now();

  // Best-effort exit ts from history
  let exitTs = null;
  let exitEvent = null;
  if (Array.isArray(trade.history)) {
    for (let i = trade.history.length - 1; i >= 0; i--) {
      const e = trade.history[i];
      if (e && e.type === "EXIT") {
        exitEvent = e;
        exitTs = isoToMs(e.timestamp);
        break;
      }
    }
  }

  // Best-effort exit price/reason from history for legacy trades (so backfill becomes useful)
  const derivedExitPrice =
    trade.exitPrice != null
      ? Number(trade.exitPrice)
      : exitEvent && exitEvent.price != null
        ? Number(exitEvent.price)
        : null;
  const derivedExitReason =
    trade.exitReason != null
      ? String(trade.exitReason)
      : inferExitReasonForLegacyTrade(trade, exitEvent);

  try {
    // Preserve created_at by inserting once.
    await db
      .prepare(
        `INSERT OR IGNORE INTO trades
          (trade_id, ticker, direction, entry_ts, entry_price, rank, rr, status,
           exit_ts, exit_price, exit_reason, trimmed_pct, pnl, pnl_pct, script_version,
           created_at, updated_at)
         VALUES
          (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)`,
      )
      .bind(
        tradeId,
        ticker || null,
        direction || null,
        entryTs != null ? Number(entryTs) : null,
        trade.entryPrice != null ? Number(trade.entryPrice) : null,
        trade.rank != null ? Number(trade.rank) : null,
        trade.rr != null ? Number(trade.rr) : null,
        trade.status != null ? String(trade.status) : null,
        exitTs != null ? Number(exitTs) : null,
        Number.isFinite(derivedExitPrice) ? derivedExitPrice : null,
        derivedExitReason != null ? String(derivedExitReason) : null,
        trade.trimmedPct != null ? Number(trade.trimmedPct) : null,
        trade.pnl != null ? Number(trade.pnl) : null,
        trade.pnlPct != null ? Number(trade.pnlPct) : null,
        trade.scriptVersion != null
          ? String(trade.scriptVersion)
          : trade.script_version != null
            ? String(trade.script_version)
            : null,
        createdAt,
        updatedAt,
      )
      .run();

    await db
      .prepare(
        `UPDATE trades SET
          ticker=?2, direction=?3, entry_ts=?4, entry_price=?5, rank=?6, rr=?7, status=?8,
          exit_ts=?9, exit_price=?10, exit_reason=?11,
          trimmed_pct=?12, pnl=?13, pnl_pct=?14, script_version=?15,
          updated_at=?16
         WHERE trade_id=?1`,
      )
      .bind(
        tradeId,
        ticker || null,
        direction || null,
        entryTs != null ? Number(entryTs) : null,
        trade.entryPrice != null ? Number(trade.entryPrice) : null,
        trade.rank != null ? Number(trade.rank) : null,
        trade.rr != null ? Number(trade.rr) : null,
        trade.status != null ? String(trade.status) : null,
        exitTs != null ? Number(exitTs) : null,
        Number.isFinite(derivedExitPrice) ? derivedExitPrice : null,
        derivedExitReason != null ? String(derivedExitReason) : null,
        trade.trimmedPct != null ? Number(trade.trimmedPct) : null,
        trade.pnl != null ? Number(trade.pnl) : null,
        trade.pnlPct != null ? Number(trade.pnlPct) : null,
        trade.scriptVersion != null
          ? String(trade.scriptVersion)
          : trade.script_version != null
            ? String(trade.script_version)
            : null,
        updatedAt,
      )
      .run();

    return { ok: true, trade_id: tradeId };
  } catch (err) {
    console.error(`[D1 LEDGER] Trade upsert failed for ${tradeId}:`, err);
    return { ok: false, error: String(err) };
  }
}

async function d1InsertTradeEvent(env, tradeId, event) {
  const db = env?.DB;
  if (!db) return { ok: false, skipped: true, reason: "no_db_binding" };
  if (!tradeId) return { ok: false, skipped: true, reason: "missing_trade_id" };
  if (!event) return { ok: false, skipped: true, reason: "missing_event" };

  const ts = isoToMs(event.timestamp) || Number(event.ts) || null;
  const type = String(event.type || "").toUpperCase();
  if (!Number.isFinite(ts) || !type)
    return { ok: false, skipped: true, reason: "bad_event_key" };

  const eventId = `${tradeId}:${type}:${ts}`;

  // Quantity fields: for TRIM, represent trimmed percentages.
  const qtyPctTotal =
    event.trimPct != null
      ? Number(event.trimPct)
      : event.trimmedPct != null
        ? Number(event.trimmedPct)
        : null;
  const qtyPctDelta =
    event.trimDeltaPct != null ? Number(event.trimDeltaPct) : null;

  const meta = (() => {
    try {
      return JSON.stringify(event);
    } catch {
      return null;
    }
  })();

  try {
    await db
      .prepare(
        `INSERT OR IGNORE INTO trade_events
          (event_id, trade_id, ts, type, price, qty_pct_delta, qty_pct_total, pnl_realized, reason, meta_json)
         VALUES
          (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
      )
      .bind(
        eventId,
        String(tradeId),
        Number(ts),
        type,
        event.price != null ? Number(event.price) : null,
        qtyPctDelta != null && Number.isFinite(qtyPctDelta)
          ? qtyPctDelta
          : null,
        qtyPctTotal != null && Number.isFinite(qtyPctTotal)
          ? qtyPctTotal
          : null,
        event.pnl_realized != null ? Number(event.pnl_realized) : null,
        event.reason != null ? String(event.reason) : null,
        meta,
      )
      .run();

    return { ok: true, event_id: eventId };
  } catch (err) {
    console.error(`[D1 LEDGER] Trade event insert failed for ${tradeId}:`, err);
    return { ok: false, error: String(err) };
  }
}

function encodeCursor(obj) {
  try {
    const s = JSON.stringify(obj);
    if (typeof btoa === "function") return btoa(s);
    // Node fallback
    return Buffer.from(s, "utf8").toString("base64");
  } catch {
    return null;
  }
}

function decodeCursor(s) {
  if (!s) return null;
  try {
    const raw =
      typeof atob === "function"
        ? atob(String(s))
        : Buffer.from(String(s), "base64").toString("utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parseExitReasonFromText(text) {
  const s = String(text || "").toUpperCase();
  if (!s) return null;
  if (s.includes("TDSEQ") || s.includes("TD9") || s.includes("TD13"))
    return "TDSEQ";
  // Prefer explicit SL phrasing
  if (s.includes("STOP LOSS") || s.includes("STOP-LOSS")) return "SL";
  // Avoid mapping generic "SL" inside words; still helpful for legacy notes
  if (/\bSL\b/.test(s)) return "SL";
  if (s.includes("TP_FULL")) return "TP_FULL";
  if (s.includes("TAKE PROFIT")) return "TP_FULL";
  // Avoid mapping any "TP" occurrence too aggressively
  if (/\bTP\b/.test(s)) return "TP_FULL";
  return null;
}

function parseTrimPctFromText(text) {
  const s = String(text || "");
  const m = s.match(/Trimmed\s+(\d{1,3})%/i);
  if (!m) return null;
  const pct = Number(m[1]);
  if (!Number.isFinite(pct) || pct <= 0) return null;
  return Math.max(0, Math.min(1, pct / 100));
}

function inferExitReasonForLegacyTrade(trade, exitEvent) {
  const explicit =
    (exitEvent && exitEvent.reason) ||
    (trade && trade.exitReason) ||
    (trade && trade.exit_reason);
  if (explicit) return String(explicit);

  const parsed =
    parseExitReasonFromText(exitEvent?.note) ||
    parseExitReasonFromText(exitEvent?.meta_json) ||
    parseExitReasonFromText(exitEvent?.text) ||
    parseExitReasonFromText(exitEvent?.type);
  if (parsed) return parsed;

  // Heuristic fallback for legacy trades with no reason recorded
  const status = String(trade?.status || "").toUpperCase();
  if (status === "LOSS") return "SL";
  if (status === "WIN") return "TP_FULL";
  return "unknown";
}

async function d1GetNearestTrailPayload(
  db,
  ticker,
  targetTs,
  windowMs = 2 * 60 * 60 * 1000,
) {
  if (!db) return null;
  const sym = String(ticker || "").toUpperCase();
  const ts = Number(targetTs);
  if (!sym || !Number.isFinite(ts)) return null;
  const w = Math.max(60 * 1000, Number(windowMs) || 0);
  const lo = ts - w;
  const hi = ts + w;
  try {
    const row = await db
      .prepare(
        `SELECT ts, payload_json
         FROM timed_trail
         WHERE ticker = ?1 AND ts BETWEEN ?2 AND ?3 AND payload_json IS NOT NULL
         ORDER BY ABS(ts - ?4) ASC
         LIMIT 1`,
      )
      .bind(sym, lo, hi, ts)
      .first();
    if (!row || !row.payload_json) return null;
    try {
      return {
        ts: Number(row.ts),
        payload: JSON.parse(String(row.payload_json)),
      };
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

// Activity feed tracking (1 week history)
async function appendActivity(KV, event) {
  const key = "timed:activity:feed";
  const now = Date.now();
  const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000;

  const feed = (await kvGetJSON(KV, key)) || [];

  // Add new event with timestamp
  const activityEvent = {
    ...event,
    ts: now,
    id: `${event.ticker}-${now}-${Math.random().toString(36).substr(2, 9)}`,
  };

  feed.unshift(activityEvent); // Add to beginning

  // Remove events older than 1 week
  const filtered = feed.filter((e) => e.ts > oneWeekAgo);

  // Keep max 500 events
  const keep = filtered.slice(0, 500);

  await kvPutJSON(KV, key, keep);
}

// Version management and migration
const CURRENT_DATA_VERSION = "2.5.0"; // Must match SCRIPT_VERSION in Pine Script

async function getStoredVersion(KV) {
  const versionKey = "timed:data_version";
  const stored = await KV.get(versionKey);
  return stored ? stored : null;
}

async function setStoredVersion(KV, version) {
  const versionKey = "timed:data_version";
  await kvPutText(KV, versionKey, version);
}

async function checkAndMigrate(KV, incomingVersion) {
  const storedVersion = await getStoredVersion(KV);
  return checkAndMigrateWithStoredVersion(KV, storedVersion, incomingVersion);
}

async function checkAndMigrateWithStoredVersion(
  KV,
  storedVersion,
  incomingVersion,
) {
  // If no stored version, this is first run - set it and continue
  if (!storedVersion) {
    await setStoredVersion(KV, incomingVersion);
    return { migrated: false, reason: "initial_setup" };
  }

  // If versions match, no migration needed
  if (storedVersion === incomingVersion) {
    return { migrated: false, reason: "version_match" };
  }

  // Version changed - trigger migration
  console.log(
    `Version change detected: ${storedVersion} -> ${incomingVersion}`,
  );

  // Get tickers before purging (for archive)
  const tickers = (await kvGetJSON(KV, "timed:tickers")) || [];

  // Archive old data (optional - store timestamp of migration)
  const archiveKey = `timed:archive:${storedVersion}:${Date.now()}`;
  const archiveData = {
    version: storedVersion,
    migratedAt: Date.now(),
    tickerCount: tickers.length,
    tickers: tickers.slice(0, 10), // Store sample of tickers for reference
  };
  await kvPutJSON(KV, archiveKey, archiveData, 30 * 24 * 60 * 60); // Keep archive for 30 days

  // Purge old data
  const purgeResult = await purgeOldData(KV);

  // Update to new version
  await setStoredVersion(KV, incomingVersion);

  return {
    migrated: true,
    reason: "version_changed",
    oldVersion: storedVersion,
    newVersion: incomingVersion,
    archived: true,
    tickerCount: purgeResult.tickerCount,
    purged: purgeResult.purged,
  };
}

async function purgeOldData(KV) {
  // Get tickers BEFORE clearing the index
  const tickers = (await kvGetJSON(KV, "timed:tickers")) || [];
  const tickerCount = tickers.length;

  // Build all delete operations in parallel for faster execution
  const deletePromises = [];

  // Clear ticker index first (to prevent race conditions)
  deletePromises.push(KV.delete("timed:tickers"));

  // Create all delete operations for each ticker in parallel
  for (const ticker of tickers) {
    // Latest data
    deletePromises.push(KV.delete(`timed:latest:${ticker}`));
    // Trails
    deletePromises.push(KV.delete(`timed:trail:${ticker}`));
    // Momentum data (all keys)
    deletePromises.push(KV.delete(`timed:momentum:${ticker}`));
    deletePromises.push(KV.delete(`timed:momentum:marketcap:${ticker}`));
    deletePromises.push(KV.delete(`timed:momentum:adr:${ticker}`));
    deletePromises.push(KV.delete(`timed:momentum:volume:${ticker}`));
    deletePromises.push(KV.delete(`timed:momentum:changes:${ticker}`));
    deletePromises.push(KV.delete(`timed:momentum:history:${ticker}`));
    // State tracking
    deletePromises.push(KV.delete(`timed:prevstate:${ticker}`));
    // Additional state tracking keys
    deletePromises.push(KV.delete(`timed:prevcorridor:${ticker}`));
    deletePromises.push(KV.delete(`timed:prevsqueeze:${ticker}`));
    deletePromises.push(KV.delete(`timed:prevsqueezerel:${ticker}`));
    deletePromises.push(KV.delete(`timed:prevmomentumelite:${ticker}`));
  }

  // Execute all deletes in parallel (much faster than sequential)
  await Promise.all(deletePromises);

  return { purged: tickerCount, tickerCount };
}

async function ensureCaptureIndex(KV, ticker) {
  try {
    const key = "timed:capture:tickers";
    const existing = (await kvGetJSON(KV, key)) || [];
    const upper = String(ticker || "").toUpperCase();
    if (!upper) return;
    if (!existing.includes(upper)) {
      existing.push(upper);
      existing.sort();
      await kvPutJSON(KV, key, existing);
    }
  } catch (err) {
    console.error(`[CAPTURE INDEX] Failed to update index:`, err);
  }
}

// Send Discord notification with embed card styling
async function notifyDiscord(env, embed) {
  const discordEnable = env.DISCORD_ENABLE || "false";
  if (discordEnable !== "true") {
    console.log(
      `[DISCORD] Notifications disabled (DISCORD_ENABLE="${discordEnable}", expected "true")`,
    );
    return { ok: false, skipped: true, reason: "disabled" };
  }
  const url = env.DISCORD_WEBHOOK_URL;
  if (!url) {
    console.log(
      `[DISCORD] Webhook URL not configured (DISCORD_WEBHOOK_URL is missing)`,
    );
    return { ok: false, skipped: true, reason: "missing_webhook" };
  }

  console.log(`[DISCORD] Sending notification: ${embed.title || "Untitled"}`);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [embed] }),
    });
    if (!response.ok) {
      const responseText = await response
        .text()
        .catch(() => "Unable to read response");
      console.error(
        `[DISCORD] Failed to send notification: ${response.status} ${response.statusText}`,
        { responseText: responseText.substring(0, 200) },
      );
      return {
        ok: false,
        status: response.status,
        statusText: response.statusText,
        responseText: responseText.substring(0, 200),
      };
    } else {
      console.log(
        `[DISCORD] ✅ Notification sent successfully: ${
          embed.title || "Untitled"
        }`,
      );
      return { ok: true, status: response.status };
    }
  } catch (error) {
    console.error(`[DISCORD] Error sending notification:`, {
      error: String(error),
      message: error.message,
      stack: error.stack,
    });
    return { ok: false, error: String(error), message: error.message };
  }
}

function getDiscordAlertMode(env) {
  // Modes:
  // - "critical" (default): high-signal only
  // - "all": legacy behavior (send everything)
  const raw = String(env?.DISCORD_ALERT_MODE || "critical")
    .trim()
    .toLowerCase();
  return raw === "all" ? "all" : "critical";
}

function shouldSendDiscordAlert(env, type, ctx = {}) {
  const mode = getDiscordAlertMode(env);
  if (mode === "all") return true;
  const t = String(type || "").toUpperCase();

  // Critical-only policy: fewer, higher-signal alerts.
  // Keep exits, keep major trims, keep only very high-conviction entries.
  if (t === "TRADE_EXIT") return true;

  if (t === "TRADE_TRIM") {
    // NOTE: trims are fractional (0.5 = 50%). Be tolerant if percent is passed (50 = 50%).
    const rawTotal = Number(ctx.newTrimmedPct);
    const rawDelta = Number(ctx.trimDeltaPctRaw);
    const total =
      Number.isFinite(rawTotal) && rawTotal > 1 ? rawTotal / 100 : rawTotal;
    const delta =
      Number.isFinite(rawDelta) && Math.abs(rawDelta) > 1
        ? rawDelta / 100
        : rawDelta;
    // Major trim events only (e.g. scaled out meaningfully)
    if (Number.isFinite(total) && total >= 0.5) return true; // >= 50% total trimmed
    if (Number.isFinite(delta) && Math.abs(delta) >= 0.2) return true; // >= 20% step
    return false;
  }

  if (t === "TRADE_ENTRY") {
    const rr = Number(ctx.rr);
    const rank = Number(ctx.rank);
    const momentumElite = !!ctx.momentumElite;
    // High conviction: very strong rank + RR, or Momentum Elite with slightly relaxed RR.
    if (Number.isFinite(rank) && rank >= 80 && Number.isFinite(rr) && rr >= 2.0)
      return true;
    if (
      momentumElite &&
      Number.isFinite(rank) &&
      rank >= 75 &&
      Number.isFinite(rr) &&
      rr >= 1.6
    )
      return true;
    return false;
  }

  // Kanban stage transitions (Enter Now and beyond) - always allow in critical mode
  if (t === "KANBAN_ENTER_NOW") return true;
  if (t === "KANBAN_HOLD") return true;
  if (t === "KANBAN_DEFEND") return true;
  if (t === "KANBAN_TRIM") return true;
  if (t === "KANBAN_EXIT") return true;

  // Suppress noisy/secondary alerts in critical mode:
  // - flip_watch: early heads-up (nice-to-have, not critical)
  // - tdseq_defense: internal SL tightening (can be frequent/noisy)
  // - td9_exit: redundant with TRADE_EXIT
  // - alert_entry (corridor entry signals): redundant with trade simulation entry alerts
  if (t === "FLIP_WATCH") return false;
  if (t === "TDSEQ_DEFENSE") return false;
  if (t === "TD9_EXIT") return false;
  if (t === "TD9_ENTRY") return false;
  if (t === "SYSTEM") return false;
  if (t === "ALERT_ENTRY") return false;

  // Default: suppress.
  return false;
}

// Helper: Generate natural language interpretation for trade actions
function generateTradeActionInterpretation(
  action,
  tickerData,
  trade = null,
  trimPct = null,
) {
  const ticker = tickerData.ticker || "UNKNOWN";
  const direction =
    trade?.direction ||
    (tickerData.state?.includes("BULL")
      ? "LONG"
      : tickerData.state?.includes("BEAR")
        ? "SHORT"
        : null);
  const state = tickerData.state || "";
  const flags = tickerData.flags || {};
  const htfScore = Number(tickerData.htf_score || 0);
  const ltfScore = Number(tickerData.ltf_score || 0);
  const completion = Number(tickerData.completion || 0);
  const phase = Number(tickerData.phase_pct || 0);
  const rr = Number(tickerData.rr || trade?.rr || 0);
  const rank = Number(tickerData.rank || trade?.rank || 0);
  const sqRel = !!flags.sq30_release;
  const sqOn = !!flags.sq30_on;
  const momentumElite = !!flags.momentum_elite;
  const tdSeq = tickerData.td_sequential || {};
  const rsi = tickerData.rsi || {};
  const fourHEMACloud = tickerData.fourh_ema_cloud || {};

  let reasons = [];
  let actionText = "";

  if (action === "ENTRY") {
    actionText = `**Entering a ${direction} position** because:`;

    // State-based reasons
    if (state === "HTF_BULL_LTF_BULL") {
      reasons.push(
        "✅ **HTF and LTF are both bullish** - Strong alignment in favor of upward movement",
      );
    } else if (state === "HTF_BEAR_LTF_BEAR") {
      reasons.push(
        "✅ **HTF and LTF are both bearish** - Strong alignment in favor of downward movement",
      );
    } else if (state === "HTF_BULL_LTF_PULLBACK") {
      reasons.push(
        "✅ **HTF bullish with LTF pullback** - Prime setup for long entry on pullback",
      );
    } else if (state === "HTF_BEAR_LTF_PULLBACK") {
      reasons.push(
        "✅ **HTF bearish with LTF pullback** - Prime setup for short entry on pullback",
      );
    }

    // Score-based reasons
    if (htfScore >= 25) {
      reasons.push(
        `📈 **Strong HTF score (${htfScore.toFixed(
          1,
        )})** - High timeframe momentum is very favorable`,
      );
    } else if (htfScore >= 15) {
      reasons.push(
        `📈 **Good HTF score (${htfScore.toFixed(
          1,
        )})** - High timeframe momentum is favorable`,
      );
    }

    if (ltfScore >= 20) {
      reasons.push(
        `📊 **Strong LTF score (${ltfScore.toFixed(
          1,
        )})** - Low timeframe momentum is very favorable`,
      );
    } else if (ltfScore >= 12) {
      reasons.push(
        `📊 **Good LTF score (${ltfScore.toFixed(
          1,
        )})** - Low timeframe momentum is favorable`,
      );
    }

    // Squeeze reasons
    if (sqRel) {
      reasons.push(
        "🚀 **Squeeze release detected** - Momentum breakout from compression, strong directional move expected",
      );
    } else if (sqOn) {
      reasons.push(
        "💥 **In squeeze** - Building energy for potential explosive move",
      );
    }

    // Completion reasons
    if (completion <= 0.2) {
      reasons.push(
        `🎯 **Early in move (${(completion * 100).toFixed(
          0,
        )}% complete)** - Plenty of room to run`,
      );
    } else if (completion <= 0.4) {
      reasons.push(
        `🎯 **Good entry timing (${(completion * 100).toFixed(
          0,
        )}% complete)** - Still early in the move`,
      );
    }

    // Phase reasons
    if (phase <= 0.3) {
      reasons.push(
        `⚡ **Early phase (${(phase * 100).toFixed(
          0,
        )}%)** - Strong momentum building`,
      );
    }

    // RR reasons
    if (rr >= 2.0) {
      reasons.push(
        `💰 **Excellent Risk/Reward (${rr.toFixed(
          2,
        )}:1)** - High potential reward relative to risk`,
      );
    } else if (rr >= 1.5) {
      reasons.push(
        `💰 **Good Risk/Reward (${rr.toFixed(
          2,
        )}:1)** - Favorable reward relative to risk`,
      );
    }

    // Rank reasons
    if (rank >= 80) {
      reasons.push(
        `⭐ **Top-ranked setup (Rank: ${rank})** - One of the best opportunities in the watchlist`,
      );
    } else if (rank >= 70) {
      reasons.push(
        `⭐ **High-ranked setup (Rank: ${rank})** - Strong opportunity`,
      );
    }

    // Momentum Elite
    if (momentumElite) {
      reasons.push(
        "🚀 **Momentum Elite** - High-quality momentum stock with strong fundamentals",
      );
    }

    // TD Sequential
    if (tdSeq.td9_bullish && direction === "LONG") {
      reasons.push(
        "🔢 **TD9 Bullish signal** - DeMark exhaustion pattern suggests upward reversal",
      );
    } else if (tdSeq.td9_bearish && direction === "SHORT") {
      reasons.push(
        "🔢 **TD9 Bearish signal** - DeMark exhaustion pattern suggests downward reversal",
      );
    }

    // RSI Divergence
    if (rsi.divergence?.type === "bullish" && direction === "LONG") {
      reasons.push(
        "📊 **RSI Bullish Divergence** - Price making lower lows while RSI makes higher lows, suggesting upward reversal",
      );
    } else if (rsi.divergence?.type === "bearish" && direction === "SHORT") {
      reasons.push(
        "📊 **RSI Bearish Divergence** - Price making higher highs while RSI makes lower highs, suggesting downward reversal",
      );
    }

    // EMA Cloud position
    if (fourHEMACloud.position === "above" && direction === "LONG") {
      reasons.push(
        "☁️ **Price above 4H EMA cloud** - Strong trend continuation signal",
      );
    } else if (fourHEMACloud.position === "below" && direction === "SHORT") {
      reasons.push(
        "☁️ **Price below 4H EMA cloud** - Strong trend continuation signal",
      );
    }
  } else if (action === "TRIM") {
    const trimPercent = Math.round((trimPct || 0.5) * 100);
    actionText = `**Trimming ${trimPercent}%** because:`;

    reasons.push(
      `🎯 **Take Profit level hit** - Price reached TP target, locking in ${trimPercent}% of profits`,
    );

    if (trimPct === 0.25) {
      reasons.push(
        "📈 **First trim (25%)** - Securing initial profits while letting the rest run",
      );
    } else if (trimPct === 0.5) {
      reasons.push(
        "📈 **Second trim (50%)** - Locking in half the position, remaining 50% continues to run",
      );
    } else if (trimPct === 0.75) {
      reasons.push(
        "📈 **Third trim (75%)** - Securing most profits, trailing stop on remaining 25%",
      );
    }

    // EMA Cloud position for hold decision
    if (fourHEMACloud.position === "above" && direction === "LONG") {
      reasons.push(
        "☁️ **Price still above 4H EMA cloud** - Trend intact, holding remaining position",
      );
    } else if (fourHEMACloud.position === "below" && direction === "SHORT") {
      reasons.push(
        "☁️ **Price still below 4H EMA cloud** - Trend intact, holding remaining position",
      );
    }
  } else if (action === "CLOSE") {
    const status = trade?.status || "CLOSED";
    const exitReason = trade?.exitReason || null;
    actionText = `**Closing position** because:`;

    if (exitReason === "TDSEQ") {
      reasons.push(
        "🔢 **TD Sequential exit signal** - DeMark exhaustion pattern suggests trend reversal",
      );
    } else if (exitReason === "SL") {
      reasons.push(
        "❌ **Stop Loss hit** - Price moved against position, risk management triggered",
      );
    } else if (exitReason === "TP_FULL") {
      reasons.push(
        "✅ **Take Profit fully achieved** - All TP levels hit, trade completed successfully",
      );
    } else if (status === "WIN") {
      reasons.push("✅ **Trade closed as WIN** - Profit secured");
    } else if (status === "LOSS") {
      reasons.push("❌ **Trade closed as LOSS** - Loss realized");
    }

    // Final P&L context
    const pnl = trade?.pnl || 0;
    const pnlPct = trade?.pnlPct || 0;
    if (pnl > 0) {
      reasons.push(
        `💰 **Final P&L: +$${Math.abs(pnl).toFixed(2)} (${
          pnlPct >= 0 ? "+" : ""
        }${pnlPct.toFixed(2)}%)** - Trade profitable`,
      );
    } else {
      reasons.push(
        `💰 **Final P&L: -$${Math.abs(pnl).toFixed(2)} (${pnlPct.toFixed(
          2,
        )}%)** - Trade closed at loss`,
      );
    }
  }

  // If no reasons found, add generic ones
  if (reasons.length === 0) {
    reasons.push(
      "📊 **System signal detected** - Automated trade management triggered",
    );
  }

  return {
    action: actionText,
    reasons: reasons.join("\n"),
  };
}

// Helper: Create Discord embed for trade entry
function createTradeEntryEmbed(
  ticker,
  direction,
  entryPrice,
  sl,
  tp,
  rr,
  rank,
  state,
  currentPrice = null,
  isBackfill = false,
  tickerData = null,
) {
  const color = direction === "LONG" ? 0x00ff00 : 0xff0000; // Green for LONG, Red for SHORT

  // If current price differs significantly from entry, show both
  let entryPriceDisplay = `$${entryPrice.toFixed(2)}`;
  if (currentPrice && Math.abs(currentPrice - entryPrice) / entryPrice > 0.01) {
    entryPriceDisplay += ` (current: $${currentPrice.toFixed(2)})`;
  }

  // Generate natural language interpretation
  const interpretation = tickerData
    ? generateTradeActionInterpretation("ENTRY", tickerData, {
        direction,
        rank,
        rr,
      })
    : null;

  // Build comprehensive fields
  const fields = [
    {
      name: "📊 Action & Reasoning",
      value: interpretation
        ? `${interpretation.action}\n\n${interpretation.reasons}`
        : "Entering position based on system signals",
      inline: false,
    },
    {
      name: "💰 Entry Details",
      value: `**Entry:** ${entryPriceDisplay}\n**Stop Loss:** $${sl.toFixed(
        2,
      )}\n**Take Profit:** $${tp.toFixed(2)}`,
      inline: false,
    },
  ];

  // Add TP array if available
  if (
    tickerData?.tp_levels &&
    Array.isArray(tickerData.tp_levels) &&
    tickerData.tp_levels.length > 0
  ) {
    const tpPrices = tickerData.tp_levels
      .map((tpItem) => {
        if (
          typeof tpItem === "object" &&
          tpItem !== null &&
          tpItem.price != null
        ) {
          return Number(tpItem.price);
        }
        return typeof tpItem === "number" ? Number(tpItem) : null;
      })
      .filter((p) => Number.isFinite(p) && p > 0);

    if (tpPrices.length > 0) {
      const maxTP = Math.max(...tpPrices);
      fields.push({
        name: "🎯 TP Levels",
        value: `**Primary TP:** $${tp.toFixed(2)}\n**Max TP:** $${maxTP.toFixed(
          2,
        )}\n**Total Levels:** ${tpPrices.length}`,
        inline: false,
      });
    }
  }

  // Add scores and metrics
  if (tickerData) {
    const htfScore = Number(tickerData.htf_score || 0);
    const ltfScore = Number(tickerData.ltf_score || 0);
    const completion = Number(tickerData.completion || 0);
    const phase = Number(tickerData.phase_pct || 0);

    fields.push({
      name: "📈 Scores & Metrics",
      value: `**HTF Score:** ${htfScore.toFixed(
        2,
      )}\n**LTF Score:** ${ltfScore.toFixed(2)}\n**Completion:** ${(
        completion * 100
      ).toFixed(1)}%\n**Phase:** ${(phase * 100).toFixed(1)}%`,
      inline: true,
    });
  }

  fields.push({
    name: "⭐ Quality Metrics",
    value: `**Rank:** ${rank}\n**Risk/Reward:** ${rr.toFixed(
      2,
    )}:1\n**State:** ${state || "N/A"}`,
    inline: true,
  });

  // Add flags and signals
  if (tickerData?.flags) {
    const flags = tickerData.flags;
    const flagItems = [];
    if (flags.sq30_release) flagItems.push("🚀 Squeeze Release");
    if (flags.sq30_on && !flags.sq30_release) flagItems.push("💥 In Squeeze");
    if (flags.momentum_elite) flagItems.push("⭐ Momentum Elite");
    if (flags.phase_dot) flagItems.push("⚫ Phase Dot");
    if (flags.phase_zone_change) flagItems.push("🔄 Phase Zone Change");

    if (flagItems.length > 0) {
      fields.push({
        name: "🚩 Active Signals",
        value: flagItems.join("\n"),
        inline: false,
      });
    }
  }

  // Add TD Sequential if available
  if (tickerData?.td_sequential) {
    const tdSeq = tickerData.td_sequential;
    const tdItems = [];
    if (tdSeq.td9_bullish) tdItems.push("🔢 TD9 Bullish");
    if (tdSeq.td9_bearish) tdItems.push("🔢 TD9 Bearish");
    if (tdSeq.td13_bullish) tdItems.push("🔢 TD13 Bullish");
    if (tdSeq.td13_bearish) tdItems.push("🔢 TD13 Bearish");

    if (tdItems.length > 0) {
      fields.push({
        name: "🔢 TD Sequential",
        value:
          tdItems.join("\n") +
          (tdSeq.boost ? `\n**Boost:** ${Number(tdSeq.boost).toFixed(1)}` : ""),
        inline: false,
      });
    }
  }

  // Add RSI if available
  if (tickerData?.rsi) {
    const rsi = tickerData.rsi;
    const rsiValue = Number(rsi.value || 0);
    const rsiLevel = rsi.level || "neutral";
    const divergence = rsi.divergence || {};

    let rsiText = `**RSI:** ${rsiValue.toFixed(2)} (${rsiLevel})`;
    if (divergence.type && divergence.type !== "none") {
      rsiText += `\n**Divergence:** ${
        divergence.type === "bullish" ? "🔼 Bullish" : "🔽 Bearish"
      }`;
      if (divergence.strength) {
        rsiText += ` (Strength: ${Number(divergence.strength).toFixed(2)})`;
      }
    }

    fields.push({
      name: "📊 RSI",
      value: rsiText,
      inline: false,
    });
  }

  // Add EMA Cloud positions if available
  if (
    tickerData?.daily_ema_cloud ||
    tickerData?.fourh_ema_cloud ||
    tickerData?.oneh_ema_cloud
  ) {
    const cloudItems = [];
    if (tickerData.daily_ema_cloud) {
      const daily = tickerData.daily_ema_cloud;
      cloudItems.push(`**Daily (5-8 EMA):** ${daily.position.toUpperCase()}`);
    }
    if (tickerData.fourh_ema_cloud) {
      const fourH = tickerData.fourh_ema_cloud;
      cloudItems.push(`**4H (8-13 EMA):** ${fourH.position.toUpperCase()}`);
    }
    if (tickerData.oneh_ema_cloud) {
      const oneH = tickerData.oneh_ema_cloud;
      cloudItems.push(`**1H (13-21 EMA):** ${oneH.position.toUpperCase()}`);
    }

    if (cloudItems.length > 0) {
      fields.push({
        name: "☁️ EMA Cloud Positions",
        value: cloudItems.join("\n"),
        inline: false,
      });
    }
  }

  return {
    title: `🎯 Trade Entered: ${ticker} ${direction}${
      isBackfill ? " (from backfill)" : ""
    }`,
    description: interpretation
      ? interpretation.action
      : `New ${direction} position opened`,
    color: color,
    fields: fields,
    timestamp: new Date().toISOString(),
    footer: {
      text: "Timed Trading Simulator",
    },
  };
}

// Helper: Create Discord embed for trade trimmed
function createTradeTrimmedEmbed(
  ticker,
  direction,
  entryPrice,
  currentPrice,
  tp,
  pnl,
  pnlPct,
  trimmedPct = 0.5,
  tickerData = null,
  trade = null,
  trimDeltaPct = null,
) {
  const remainingPct = 1 - trimmedPct;
  const trimPercent = Math.round(trimmedPct * 100);
  const stepTrimPct =
    typeof trimDeltaPct === "number" && Number.isFinite(trimDeltaPct)
      ? trimDeltaPct
      : null;
  const stepTrimPercent =
    stepTrimPct != null ? Math.round(stepTrimPct * 100) : null;

  // Next TP level (if we have a TP array)
  const nextTp =
    trade?.tpArray && Array.isArray(trade.tpArray)
      ? [...trade.tpArray]
          .map((x) => ({
            price: Number(x?.price),
            trimPct: Number(x?.trimPct),
            label: x?.label,
          }))
          .filter((x) => Number.isFinite(x.price) && Number.isFinite(x.trimPct))
          .sort((a, b) => a.trimPct - b.trimPct)
          .find((x) => x.trimPct > trimmedPct + 1e-6) || null
      : null;

  const tpPlan =
    trade?.tpArray && Array.isArray(trade.tpArray)
      ? [...trade.tpArray]
          .map((x) => ({
            price: Number(x?.price),
            trimPct: Number(x?.trimPct),
            label: x?.label,
            source: x?.source,
            timeframe: x?.timeframe,
          }))
          .filter((x) => Number.isFinite(x.price) && Number.isFinite(x.trimPct))
          .sort((a, b) => a.trimPct - b.trimPct)
      : [];

  // Generate natural language interpretation
  const interpretation = tickerData
    ? generateTradeActionInterpretation("TRIM", tickerData, trade, trimmedPct)
    : null;

  const fields = [
    {
      name: "📊 Action & Reasoning",
      value: interpretation
        ? `${interpretation.action}\n\n${interpretation.reasons}`
        : `Trimming ${trimPercent}% of position at TP level`,
      inline: false,
    },
    {
      name: "💰 Position Details",
      value: `**Entry:** $${entryPrice.toFixed(
        2,
      )}\n**Current:** $${currentPrice.toFixed(2)}\n**TP Hit:** $${tp.toFixed(
        2,
      )}`,
      inline: false,
    },
    {
      name: "💵 Realized P&L",
      value: `**Amount:** $${pnl.toFixed(2)}\n**Percentage:** ${
        pnlPct >= 0 ? "+" : ""
      }${pnlPct.toFixed(2)}%\n**This Trim:** ${
        stepTrimPercent != null ? `${stepTrimPercent}%` : "—"
      }\n**Total Trimmed:** ${trimPercent}%`,
      inline: true,
    },
    {
      name: "📈 Position Status",
      value: `**Remaining:** ${Math.round(remainingPct * 100)}%\n**Next TP:** ${
        nextTp
          ? `$${Number(nextTp.price).toFixed(2)} (${Math.round(
              nextTp.trimPct * 100,
            )}%)`
          : "—"
      }\n**Status:** Holding remaining position`,
      inline: true,
    },
  ];

  if (tpPlan.length > 0) {
    fields.push({
      name: "🎯 TP Plan",
      value: tpPlan
        .slice(0, 5)
        .map((tp) => {
          const pct = Math.round(tp.trimPct * 100);
          const meta =
            tp.timeframe || tp.source
              ? ` (${[tp.timeframe, tp.source].filter(Boolean).join(", ")})`
              : "";
          return `**${tp.label || `TP (${pct}%)`}:** $${tp.price.toFixed(
            2,
          )} (${pct}%)${meta}`;
        })
        .join("\n"),
      inline: false,
    });
  }

  // Add EMA Cloud position if available (for hold decision context)
  if (tickerData?.fourh_ema_cloud) {
    const fourH = tickerData.fourh_ema_cloud;
    const holdReason =
      fourH.position === "above" && direction === "LONG"
        ? "Price above 4H EMA cloud - trend intact"
        : fourH.position === "below" && direction === "SHORT"
          ? "Price below 4H EMA cloud - trend intact"
          : "Monitoring trend continuation";

    fields.push({
      name: "☁️ Trend Analysis",
      value: `**4H EMA Cloud:** ${fourH.position.toUpperCase()}\n**Hold Reason:** ${holdReason}`,
      inline: false,
    });
  }

  return {
    title: `✂️ Trade Trimmed: ${ticker} ${direction} - ${trimPercent}%`,
    description: interpretation
      ? interpretation.action
      : `Position trimmed by ${trimPercent}%`,
    color: 0xffaa00, // Orange
    fields: fields,
    timestamp: new Date().toISOString(),
    footer: {
      text: "Timed Trading Simulator",
    },
  };
}

// Helper: Create Discord embed for trade closed
function createTradeClosedEmbed(
  ticker,
  direction,
  status,
  entryPrice,
  exitPrice,
  pnl,
  pnlPct,
  rank,
  rr,
  tickerData = null,
  trade = null,
) {
  const color = status === "WIN" ? 0x00ff00 : 0xff0000; // Green for WIN, Red for LOSS
  const emoji = status === "WIN" ? "✅" : "❌";

  // Generate natural language interpretation
  const interpretation =
    tickerData && trade
      ? generateTradeActionInterpretation("CLOSE", tickerData, trade)
      : null;

  const fields = [
    {
      name: "📊 Action & Reasoning",
      value: interpretation
        ? `${interpretation.action}\n\n${interpretation.reasons}`
        : `Trade closed - ${status}`,
      inline: false,
    },
    {
      name: "💰 Trade Summary",
      value: `**Entry:** $${entryPrice.toFixed(
        2,
      )}\n**Exit:** $${exitPrice.toFixed(2)}\n**Final P&L:** $${pnl.toFixed(
        2,
      )} (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%)`,
      inline: false,
    },
  ];

  // Add explicit exit reason when available
  const exitReason = trade?.exitReason || null;
  if (exitReason) {
    const reasonText =
      exitReason === "TDSEQ"
        ? "🔢 **TD Sequential Exhaustion** - DeMark pattern suggests trend reversal"
        : exitReason === "SL"
          ? "❌ **Stop Loss Hit** - Risk management triggered"
          : exitReason === "TP_FULL"
            ? "✅ **Take Profit Achieved** - TP plan completed"
            : `📌 **Exit Reason:** ${exitReason}`;
    fields.push({
      name: "📌 Exit Reason",
      value: reasonText,
      inline: false,
    });
  }

  // Add performance metrics
  fields.push({
    name: "⭐ Performance Metrics",
    value: `**Rank:** ${rank || "N/A"}\n**Risk/Reward:** ${
      rr ? rr.toFixed(2) + ":1" : "N/A"
    }\n**Result:** ${status}`,
    inline: true,
  });

  // Add final stats
  const priceChange = exitPrice - entryPrice;
  const priceChangePct = ((exitPrice - entryPrice) / entryPrice) * 100;
  fields.push({
    name: "📈 Price Movement",
    value: `**Change:** ${priceChange >= 0 ? "+" : ""}$${priceChange.toFixed(
      2,
    )}\n**Change %:** ${priceChangePct >= 0 ? "+" : ""}${priceChangePct.toFixed(
      2,
    )}%`,
    inline: true,
  });

  return {
    title: `${emoji} Trade Closed: ${ticker} ${direction} - ${status}`,
    description: interpretation
      ? interpretation.action
      : `Trade closed with ${status} result`,
    color: color,
    fields: fields,
    timestamp: new Date().toISOString(),
    footer: {
      text: "Timed Trading Simulator",
    },
  };
}

// Helper: Create Discord embed for TD9 exit signal
function createTD9ExitEmbed(
  ticker,
  direction,
  entryPrice,
  exitPrice,
  pnl,
  pnlPct,
  tdSeq,
  tickerData = null,
) {
  const td9Bullish = tdSeq.td9_bullish === true || tdSeq.td9_bullish === "true";
  const td9Bearish = tdSeq.td9_bearish === true || tdSeq.td9_bearish === "true";
  const td13Bullish =
    tdSeq.td13_bullish === true || tdSeq.td13_bullish === "true";
  const td13Bearish =
    tdSeq.td13_bearish === true || tdSeq.td13_bearish === "true";

  const signalType = td13Bullish || td13Bearish ? "TD13" : "TD9";
  const signalDirection = td9Bearish || td13Bearish ? "Bearish" : "Bullish";
  const oppositeDirection = direction === "LONG" ? "SHORT" : "LONG";

  // Natural language interpretation
  const actionText = `**Closing ${direction} position** because:`;
  let reasons = [];

  if (signalType === "TD13") {
    reasons.push(
      `🔢 **TD13 ${signalDirection} exhaustion** - Strong DeMark reversal signal, lead-up phase complete`,
    );
  } else {
    reasons.push(
      `🔢 **TD9 ${signalDirection} exhaustion** - DeMark reversal signal, preparation phase complete`,
    );
  }

  reasons.push(
    `📉 **Price exhaustion detected** - Trend showing signs of reversal`,
  );
  reasons.push(
    `⚠️ **Risk management** - Exiting to protect profits and avoid reversal`,
  );

  if (oppositeDirection) {
    reasons.push(
      `🔄 **Consider ${oppositeDirection} entry** - If conditions align, opposite direction may present opportunity`,
    );
  }

  const fields = [
    {
      name: "📊 Action & Reasoning",
      value: `${actionText}\n\n${reasons.join("\n")}`,
      inline: false,
    },
    {
      name: "💰 Trade Summary",
      value: `**Entry:** $${entryPrice.toFixed(
        2,
      )}\n**Exit:** $${exitPrice.toFixed(2)}\n**P&L:** $${pnl.toFixed(2)} (${
        pnlPct >= 0 ? "+" : ""
      }${pnlPct.toFixed(2)}%)`,
      inline: false,
    },
    {
      name: "🔢 TD Sequential Signals",
      value: `**TD9 Bullish:** ${td9Bullish ? "✅" : "❌"}\n**TD9 Bearish:** ${
        td9Bearish ? "✅" : "❌"
      }\n**TD13 Bullish:** ${td13Bullish ? "✅" : "❌"}\n**TD13 Bearish:** ${
        td13Bearish ? "✅" : "❌"
      }`,
      inline: true,
    },
  ];

  // Add counts if available
  if (
    tdSeq.bullish_prep_count !== undefined ||
    tdSeq.bearish_prep_count !== undefined
  ) {
    fields.push({
      name: "📊 TD Counts",
      value: `**Bullish Prep:** ${
        tdSeq.bullish_prep_count || 0
      }/9\n**Bearish Prep:** ${
        tdSeq.bearish_prep_count || 0
      }/9\n**Bullish Leadup:** ${
        tdSeq.bullish_leadup_count || 0
      }/13\n**Bearish Leadup:** ${tdSeq.bearish_leadup_count || 0}/13`,
      inline: true,
    });
  }

  // Add additional context from tickerData if available
  if (tickerData) {
    const htfScore = Number(tickerData.htf_score || 0);
    const ltfScore = Number(tickerData.ltf_score || 0);
    fields.push({
      name: "📈 Current Scores",
      value: `**HTF:** ${htfScore.toFixed(2)}\n**LTF:** ${ltfScore.toFixed(2)}`,
      inline: true,
    });
  }

  return {
    title: `🔢 TD Sequential ${signalType} Exit: ${ticker} ${direction}`,
    description: `${actionText} ${signalType} ${signalDirection} exhaustion detected`,
    color: 0xffaa00, // Orange
    fields: fields,
    timestamp: new Date().toISOString(),
    footer: {
      text: "TD Sequential Exhaustion Signal",
    },
  };
}

// Helper: Create Discord embed for TD Sequential defensive hold (tighten SL to Daily 5-8 EMA cloud)
function createTDSeqDefenseEmbed(
  ticker,
  direction,
  entryPrice,
  currentPrice,
  oldSl,
  newSl,
  tdSeq,
  tickerData = null,
) {
  const daily = tickerData?.daily_ema_cloud || {};
  const cloudPos = String(daily?.position || "").toUpperCase() || "UNKNOWN";
  const upper = Number(daily?.upper);
  const lower = Number(daily?.lower);
  const signalType =
    tdSeq.td13_bullish === true ||
    tdSeq.td13_bullish === "true" ||
    tdSeq.td13_bearish === true ||
    tdSeq.td13_bearish === "true"
      ? "TD13"
      : "TD9";

  const fields = [
    {
      name: "🛡️ Decision",
      value: `**Hold ${direction}** (TD Sequential signal detected)\n**Reason:** Price still ${cloudPos} the **Daily 5–8 EMA cloud**`,
      inline: false,
    },
    {
      name: "💰 Price / Risk",
      value: `**Current:** $${Number(currentPrice || 0).toFixed(2)}\n**Entry:** $${Number(entryPrice || 0).toFixed(2)}\n**SL:** ${
        Number.isFinite(oldSl) ? `$${Number(oldSl).toFixed(2)}` : "—"
      } → ${Number.isFinite(newSl) ? `$${Number(newSl).toFixed(2)}` : "—"}`,
      inline: true,
    },
    {
      name: "☁️ Daily EMA Cloud (5–8)",
      value: `**Position:** ${cloudPos}\n**Upper:** ${
        Number.isFinite(upper) ? `$${upper.toFixed(2)}` : "—"
      }\n**Lower:** ${Number.isFinite(lower) ? `$${lower.toFixed(2)}` : "—"}`,
      inline: true,
    },
  ];

  // TD signal detail
  const td9Bullish = tdSeq.td9_bullish === true || tdSeq.td9_bullish === "true";
  const td9Bearish = tdSeq.td9_bearish === true || tdSeq.td9_bearish === "true";
  const td13Bullish =
    tdSeq.td13_bullish === true || tdSeq.td13_bullish === "true";
  const td13Bearish =
    tdSeq.td13_bearish === true || tdSeq.td13_bearish === "true";

  fields.push({
    name: "🔢 TD Sequential",
    value: `**Signal:** ${signalType}\n**TD9 Bullish:** ${
      td9Bullish ? "✅" : "—"
    }\n**TD9 Bearish:** ${td9Bearish ? "✅" : "—"}\n**TD13 Bullish:** ${
      td13Bullish ? "✅" : "—"
    }\n**TD13 Bearish:** ${td13Bearish ? "✅" : "—"}`,
    inline: true,
  });

  if (tickerData) {
    const htfScore = Number(tickerData.htf_score || 0);
    const ltfScore = Number(tickerData.ltf_score || 0);
    fields.push({
      name: "📈 Current Scores",
      value: `**HTF:** ${htfScore.toFixed(2)}\n**LTF:** ${ltfScore.toFixed(2)}`,
      inline: true,
    });
  }

  return {
    title: `🛡️ ${signalType} Defense: Hold ${ticker} ${direction} (Tighten SL)`,
    description:
      "TD Sequential signal detected, but trend is still supported by the Daily EMA cloud. Tighten stop loss defensively instead of exiting.",
    color: 0x4ade80, // green
    fields,
    timestamp: new Date().toISOString(),
    footer: { text: "TD Sequential Defensive Rule" },
  };
}

// Helper: Create Discord embed for Kanban stage transition (Enter Now and beyond)
function createKanbanStageEmbed(ticker, stage, prevStage, tickerData = null) {
  const stageLabels = {
    enter_now: "🎯 Enter Now",
    just_entered: "🆕 Just Entered",
    hold: "📌 Hold",
    trim: "✂️ Trim",
    exit: "🚪 Exit",
  };
  const label = stageLabels[stage] || stage?.replace(/_/g, " ").toUpperCase();
  const prevLabel =
    stageLabels[prevStage] ||
    (prevStage ? prevStage.replace(/_/g, " ").toUpperCase() : "—");
  const direction =
    tickerData?.state?.includes("BULL")
      ? "LONG"
      : tickerData?.state?.includes("BEAR")
        ? "SHORT"
        : null;
  const price = Number(tickerData?.price);
  const rr = Number(tickerData?.rr);
  const score = Number(tickerData?.score ?? tickerData?.rank);
  const completion = Number(tickerData?.completion) * 100;
  const phase = Number(tickerData?.phase_pct) * 100;

  const fields = [
    {
      name: "📊 Transition",
      value: `**${prevLabel}** → **${label}**${direction ? ` (${direction})` : ""}`,
      inline: false,
    },
  ];
  if (Number.isFinite(price) && price > 0) {
    fields.push({
      name: "💰 Price",
      value: `$${price.toFixed(2)}`,
      inline: true,
    });
  }
  if (Number.isFinite(rr) && rr > 0) {
    fields.push({ name: "⚖️ R:R", value: rr.toFixed(2) + ":1", inline: true });
  }
  if (Number.isFinite(score)) {
    fields.push({ name: "⭐ Score", value: String(score), inline: true });
  }
  if (
    (stage === "trim" || stage === "exit") &&
    (Number.isFinite(completion) || Number.isFinite(phase))
  ) {
    const parts = [];
    if (Number.isFinite(completion)) parts.push(`Completion: ${completion.toFixed(1)}%`);
    if (Number.isFinite(phase)) parts.push(`Phase: ${phase.toFixed(1)}%`);
    fields.push({
      name: "📈 Metrics",
      value: parts.join(" | ") || "—",
      inline: true,
    });
  }

  const color =
    stage === "enter_now"
      ? 0x22c55e
      : stage === "just_entered"
        ? 0x0ea5e9
        : stage === "hold"
          ? 0x3b82f6
          : stage === "trim"
            ? 0x8b5cf6
            : 0xef4444; // exit: red

  return {
    title: `${label}: ${ticker}`,
    description: `Ticker moved from **${prevLabel}** to **${label}**`,
    color,
    fields,
    timestamp: new Date().toISOString(),
    footer: { text: "Kanban Lane Transition" },
  };
}

// Helper: Create Discord embed for TD9 entry signal
function createTD9EntryEmbed(
  ticker,
  direction,
  price,
  sl,
  tp,
  rr,
  rank,
  tdSeq,
  tickerData = null,
) {
  const td9Bullish = tdSeq.td9_bullish === true || tdSeq.td9_bullish === "true";
  const td9Bearish = tdSeq.td9_bearish === true || tdSeq.td9_bearish === "true";
  const td13Bullish =
    tdSeq.td13_bullish === true || tdSeq.td13_bullish === "true";
  const td13Bearish =
    tdSeq.td13_bearish === true || tdSeq.td13_bearish === "true";

  const signalType = td13Bullish || td13Bearish ? "TD13" : "TD9";
  const signalDirection = direction === "LONG" ? "Bullish" : "Bearish";

  // Natural language interpretation
  const actionText = `**Consider entering ${direction} position** because:`;
  let reasons = [];

  if (signalType === "TD13") {
    reasons.push(
      `🔢 **TD13 ${signalDirection} signal** - Strong DeMark reversal pattern, lead-up phase complete`,
    );
  } else {
    reasons.push(
      `🔢 **TD9 ${signalDirection} signal** - DeMark reversal pattern, preparation phase complete`,
    );
  }

  reasons.push(`📈 **Price exhaustion** - Trend showing signs of reversal`);

  if (rr >= 1.5) {
    reasons.push(
      `💰 **Good Risk/Reward (${rr.toFixed(
        2,
      )}:1)** - Favorable reward relative to risk`,
    );
  }

  if (rank >= 70) {
    reasons.push(
      `⭐ **High-ranked setup (Rank: ${rank})** - Strong opportunity`,
    );
  }

  const fields = [
    {
      name: "📊 Action & Reasoning",
      value: `${actionText}\n\n${reasons.join("\n")}`,
      inline: false,
    },
    {
      name: "💰 Entry Details",
      value: `**Current Price:** $${price.toFixed(
        2,
      )}\n**Stop Loss:** $${sl.toFixed(2)}\n**Take Profit:** $${tp.toFixed(2)}`,
      inline: false,
    },
    {
      name: "⭐ Quality Metrics",
      value: `**Risk/Reward:** ${rr.toFixed(2)}:1\n**Rank:** ${rank || "N/A"}`,
      inline: true,
    },
    {
      name: "🔢 TD Sequential Signals",
      value: `**TD9 Bullish:** ${td9Bullish ? "✅" : "❌"}\n**TD9 Bearish:** ${
        td9Bearish ? "✅" : "❌"
      }\n**TD13 Bullish:** ${td13Bullish ? "✅" : "❌"}\n**TD13 Bearish:** ${
        td13Bearish ? "✅" : "❌"
      }`,
      inline: true,
    },
  ];

  // Add counts if available
  if (
    tdSeq.bullish_prep_count !== undefined ||
    tdSeq.bearish_prep_count !== undefined
  ) {
    fields.push({
      name: "📊 TD Counts",
      value: `**Bullish Prep:** ${
        tdSeq.bullish_prep_count || 0
      }/9\n**Bearish Prep:** ${
        tdSeq.bearish_prep_count || 0
      }/9\n**Bullish Leadup:** ${
        tdSeq.bullish_leadup_count || 0
      }/13\n**Bearish Leadup:** ${tdSeq.bearish_leadup_count || 0}/13`,
      inline: false,
    });
  }

  // Add additional context from tickerData if available
  if (tickerData) {
    const htfScore = Number(tickerData.htf_score || 0);
    const ltfScore = Number(tickerData.ltf_score || 0);
    const state = tickerData.state || "";

    fields.push({
      name: "📈 Current Scores",
      value: `**HTF:** ${htfScore.toFixed(2)}\n**LTF:** ${ltfScore.toFixed(
        2,
      )}\n**State:** ${state}`,
      inline: true,
    });
  }

  return {
    title: `🔢 TD Sequential ${signalType} Entry Signal: ${ticker} ${direction}`,
    description: `${actionText} ${signalType} ${signalDirection} reversal pattern detected`,
    color: direction === "LONG" ? 0x00ff00 : 0xff0000,
    fields: fields,
    timestamp: new Date().toISOString(),
    footer: {
      text: "TD Sequential Entry Signal",
    },
  };
}

function createFlipWatchEmbed(ticker, tickerData) {
  const state = String(tickerData?.state || "");
  const htfScore = Number(tickerData?.htf_score);
  const ltfScore = Number(tickerData?.ltf_score);
  const completion = Number(tickerData?.completion);
  const phase = Number(tickerData?.phase_pct);
  const price = Number(tickerData?.price);
  const rank = Number(tickerData?.rank);
  const score = Number(tickerData?.flip_watch_score);
  const reasons = tickerData?.flip_watch_reasons || [];

  const isBullSetup = state === "HTF_BULL_LTF_PULLBACK";
  const direction = isBullSetup ? "LONG" : "SHORT";
  const emoji = isBullSetup ? "📈" : "📉";

  const fields = [
    {
      name: "🎯 Flip Watch Alert",
      value: `**${ticker}** is in a **PULLBACK setup** and showing signs it may flip to **momentum** soon (within 2-6 hours based on historical patterns).`,
      inline: false,
    },
    {
      name: "📊 Setup Quality",
      value: `**Flip Watch Score:** ${score}/100\n**Why watching:**\n${reasons
        .slice(0, 5)
        .map((r) => `• ${r}`)
        .join("\n")}`,
      inline: false,
    },
    {
      name: "💰 Entry Details",
      value: `**Current Price:** $${price.toFixed(2)}\n**Direction:** ${emoji} ${direction}\n**State:** ${state}`,
      inline: true,
    },
    {
      name: "📈 Scores & Position",
      value: `**HTF Score:** ${htfScore.toFixed(1)}\n**LTF Score:** ${ltfScore.toFixed(1)}\n**Rank:** ${rank > 0 ? rank : "—"}`,
      inline: true,
    },
    {
      name: "🎪 Phase & Completion",
      value: `**Phase:** ${Math.round(phase * 100)}%\n**Completion:** ${Math.round(completion * 100)}%`,
      inline: true,
    },
  ];

  // Add momentum indicators if available
  const flags = tickerData?.flags || {};
  const indicators = [];
  if (flags.sq30_release) indicators.push("⚡ Squeeze released");
  else if (flags.sq30_on) indicators.push("🧨 Squeeze building");
  if (flags.htf_improving_4h) indicators.push("📈 HTF improving");
  if (flags.momentum_elite) indicators.push("🚀 Momentum Elite");

  if (indicators.length > 0) {
    fields.push({
      name: "🔥 Momentum Indicators",
      value: indicators.join("\n"),
      inline: false,
    });
  }

  fields.push({
    name: "⏱️ What to Watch",
    value: `Monitor for **LTF score to cross zero** and state to change to **${isBullSetup ? "HTF_BULL_LTF_BULL" : "HTF_BEAR_LTF_BEAR"}**.\n\n**Historical pattern:** 76% of top movers flipped from PULLBACK to momentum within 6 hours, with 64% having <15% completion at start.`,
    inline: false,
  });

  return {
    title: `🎯 Flip Watch Alert: ${ticker} ${emoji}`,
    description: `Setup quality score: **${score}/100** — Ready to transition from pullback to momentum`,
    color: isBullSetup ? 0xfbbf24 : 0xf59e0b, // amber/orange for watch status
    fields,
    timestamp: new Date().toISOString(),
    footer: { text: "Flip Watch — Timed Trading Pattern Detection" },
  };
}

function requireKeyOr401(req, env) {
  const expected = env.TIMED_API_KEY;
  if (!expected) return null; // open if unset (not recommended)
  const url = new URL(req.url);
  const qKey = url.searchParams.get("key");
  if (qKey && qKey === expected) return null;
  return sendJSON(
    { ok: false, error: "unauthorized" },
    401,
    corsHeaders(env, req),
  );
}

function validateTimedPayload(body) {
  const ticker = normTicker(body?.ticker);
  if (!ticker) return { ok: false, error: "missing ticker" };

  const ts = Number(body?.ts);
  const htf = Number(body?.htf_score);
  const ltf = Number(body?.ltf_score);

  // More detailed error messages
  if (!isNum(ts)) {
    return {
      ok: false,
      error: "missing/invalid ts",
      details: { received: body?.ts, type: typeof body?.ts },
    };
  }
  if (!isNum(htf)) {
    return {
      ok: false,
      error: "missing/invalid htf_score",
      details: { received: body?.htf_score, type: typeof body?.htf_score },
    };
  }
  if (!isNum(ltf)) {
    return {
      ok: false,
      error: "missing/invalid ltf_score",
      details: { received: body?.ltf_score, type: typeof body?.ltf_score },
    };
  }

  return {
    ok: true,
    ticker,
    payload: { ...body, ticker, ts, htf_score: htf, ltf_score: ltf },
  };
}

function validateCapturePayload(body) {
  const ticker = normTicker(body?.ticker);
  if (!ticker) return { ok: false, error: "missing ticker" };

  const ts = Number(body?.ts);
  if (!isNum(ts)) {
    return {
      ok: false,
      error: "missing/invalid ts",
      details: { received: body?.ts, type: typeof body?.ts },
    };
  }

  const price =
    body?.price != null && Number.isFinite(Number(body?.price))
      ? Number(body?.price)
      : null;

  return {
    ok: true,
    ticker,
    payload: {
      ...body,
      ticker,
      ts,
      price,
      ingest_kind: "capture",
    },
  };
}

function validateCandlesPayload(body) {
  const ticker = normTicker(body?.ticker);
  if (!ticker) return { ok: false, error: "missing ticker" };

  const tfCandles = body?.tf_candles;
  if (!tfCandles || typeof tfCandles !== "object") {
    return { ok: false, error: "missing tf_candles" };
  }

  // Normalize to object keyed by tf.
  let byTf = null;
  if (Array.isArray(tfCandles)) {
    byTf = {};
    for (const it of tfCandles) {
      const tf = normalizeTfKey(it?.tf);
      if (!tf) continue;
      byTf[tf] = it;
    }
  } else {
    byTf = tfCandles;
  }

  const out = {};
  let n = 0;
  for (const [tfRaw, candleOrArray] of Object.entries(byTf)) {
    const tf = normalizeTfKey(tfRaw);
    if (!tf) continue;

    // Handle both single candle and array of candles
    const candleList = Array.isArray(candleOrArray)
      ? candleOrArray
      : [candleOrArray];

    const validCandles = [];
    for (const candle of candleList) {
      if (!candle || typeof candle !== "object") continue;
      const ts = Number(candle?.ts);
      const o = Number(candle?.o);
      const h = Number(candle?.h);
      const l = Number(candle?.l);
      const c = Number(candle?.c);
      const v = candle?.v != null ? Number(candle?.v) : null;
      if (!Number.isFinite(ts)) continue;
      if (![o, h, l, c].every((x) => Number.isFinite(x))) continue;
      validCandles.push({ tf, ts, o, h, l, c, v });
      n++;
    }

    if (validCandles.length > 0) {
      out[tf] = validCandles.length === 1 ? validCandles[0] : validCandles;
    }
  }

  if (n === 0) return { ok: false, error: "no_valid_candles" };

  const tsTop = Number(body?.ts);
  return {
    ok: true,
    ticker,
    payload: {
      ...body,
      ticker,
      ts: Number.isFinite(tsTop) ? tsTop : Date.now(),
      tf_candles: out,
      ingest_kind: "candles",
    },
  };
}

// ─────────────────────────────────────────────────────────────
// Sector Mapping & Ratings
// ─────────────────────────────────────────────────────────────

const SECTOR_MAP = {
  // Consumer Discretionary
  AMZN: "Consumer Discretionary",
  TSLA: "Consumer Discretionary",
  NKE: "Consumer Discretionary",
  TJX: "Consumer Discretionary",
  HD: "Consumer Discretionary",
  MCD: "Consumer Discretionary",
  SBUX: "Consumer Discretionary",
  LOW: "Consumer Discretionary",
  BKNG: "Consumer Discretionary",
  CMG: "Consumer Discretionary",
  ABNB: "Consumer Discretionary",
  EXPE: "Consumer Discretionary",
  RBLX: "Consumer Discretionary",
  ULTA: "Consumer Discretionary",
  SHOP: "Consumer Discretionary",
  // Industrials
  CAT: "Industrials",
  GE: "Industrials",
  BA: "Industrials",
  HON: "Industrials",
  RTX: "Industrials",
  EMR: "Industrials",
  ETN: "Industrials",
  DE: "Industrials",
  PH: "Industrials",
  CSX: "Industrials",
  UNP: "Industrials",
  UPS: "Industrials",
  FDX: "Industrials",
  LMT: "Industrials",
  NOC: "Industrials",
  GD: "Industrials",
  TT: "Industrials",
  PWR: "Industrials",
  AWI: "Industrials",
  WTS: "Industrials",
  DY: "Industrials",
  FIX: "Industrials",
  ITT: "Industrials",
  STRL: "Industrials",
  // Information Technology
  AAPL: "Information Technology",
  MSFT: "Information Technology",
  NVDA: "Information Technology",
  AVGO: "Information Technology",
  AMD: "Information Technology",
  ORCL: "Information Technology",
  CRM: "Information Technology",
  ADBE: "Information Technology",
  INTC: "Information Technology",
  CSCO: "Information Technology",
  QCOM: "Information Technology",
  TXN: "Information Technology",
  AMAT: "Information Technology",
  LRCX: "Information Technology",
  KLAC: "Information Technology",
  ANET: "Information Technology",
  CDNS: "Information Technology",
  CRWD: "Information Technology",
  PANW: "Information Technology",
  PLTR: "Information Technology",
  MDB: "Information Technology",
  PATH: "Information Technology",
  QLYS: "Information Technology",
  PEGA: "Information Technology",
  IOT: "Information Technology",
  PSTG: "Information Technology",
  MU: "Information Technology",
  APLD: "Information Technology",
  // Communication Services
  META: "Communication Services",
  GOOGL: "Communication Services",
  GOOG: "Communication Services",
  NFLX: "Communication Services",
  DIS: "Communication Services",
  CMCSA: "Communication Services",
  VZ: "Communication Services",
  T: "Communication Services",
  TWLO: "Communication Services",
  RDDT: "Communication Services",
  // Basic Materials
  LIN: "Basic Materials",
  APD: "Basic Materials",
  ECL: "Basic Materials",
  SHW: "Basic Materials",
  PPG: "Basic Materials",
  FCX: "Basic Materials",
  NEM: "Basic Materials",
  ALB: "Basic Materials",
  MP: "Basic Materials",
  NEU: "Basic Materials",
  AU: "Basic Materials",
  CCJ: "Basic Materials",
  RGLD: "Basic Materials",
  SN: "Basic Materials",
  // Energy
  XOM: "Energy",
  CVX: "Energy",
  SLB: "Energy",
  EOG: "Energy",
  COP: "Energy",
  MPC: "Energy",
  PSX: "Energy",
  VST: "Energy",
  FSLR: "Energy",
  // Financials
  JPM: "Financials",
  BAC: "Financials",
  WFC: "Financials",
  GS: "Financials",
  MS: "Financials",
  C: "Financials",
  AXP: "Financials",
  COF: "Financials",
  SPGI: "Financials",
  MCO: "Financials",
  BLK: "Financials",
  SCHW: "Financials",
  PNC: "Financials",
  BK: "Financials",
  TFC: "Financials",
  USB: "Financials",
  ALLY: "Financials",
  EWBC: "Financials",
  WAL: "Financials",
  SOFI: "Financials",
  HOOD: "Financials",
  // Real Estate
  AMT: "Real Estate",
  PLD: "Real Estate",
  EQIX: "Real Estate",
  PSA: "Real Estate",
  WELL: "Real Estate",
  SPG: "Real Estate",
  O: "Real Estate",
  DLR: "Real Estate",
  VICI: "Real Estate",
  EXPI: "Real Estate",
  // Consumer Staples
  PG: "Consumer Staples",
  KO: "Consumer Staples",
  PEP: "Consumer Staples",
  WMT: "Consumer Staples",
  COST: "Consumer Staples",
  MDLZ: "Consumer Staples",
  CL: "Consumer Staples",
  KMB: "Consumer Staples",
  STZ: "Consumer Staples",
  TGT: "Consumer Staples",
  // Health Care
  UNH: "Health Care",
  JNJ: "Health Care",
  LLY: "Health Care",
  ABBV: "Health Care",
  MRK: "Health Care",
  TMO: "Health Care",
  ABT: "Health Care",
  DHR: "Health Care",
  BMY: "Health Care",
  AMGN: "Health Care",
  GILD: "Health Care",
  REGN: "Health Care",
  VRTX: "Health Care",
  BIIB: "Health Care",
  UTHR: "Health Care",
  HIMS: "Health Care",
  NBIS: "Health Care",
  // Utilities
  NEE: "Utilities",
  DUK: "Utilities",
  SO: "Utilities",
  D: "Utilities",
  AEP: "Utilities",
  SRE: "Utilities",
  EXC: "Utilities",
  XEL: "Utilities",
  WEC: "Utilities",
  ES: "Utilities",
  PEG: "Utilities",
  ETR: "Utilities",
  FE: "Utilities",
  AEE: "Utilities",
};

const SECTOR_RATINGS = {
  "Consumer Discretionary": { rating: "neutral", boost: 0 },
  Industrials: { rating: "overweight", boost: 5 },
  "Information Technology": { rating: "neutral", boost: 0 },
  "Communication Services": { rating: "neutral", boost: 0 },
  "Basic Materials": { rating: "neutral", boost: 0 },
  Energy: { rating: "overweight", boost: 5 },
  Financials: { rating: "overweight", boost: 5 },
  "Real Estate": { rating: "underweight", boost: -3 },
  "Consumer Staples": { rating: "underweight", boost: -3 },
  Healthcare: { rating: "overweight", boost: 5 }, // Fixed: "Health Care" -> "Healthcare" to match SECTOR_MAP
  Utilities: { rating: "overweight", boost: 5 },
};

function getSector(ticker) {
  return SECTOR_MAP[ticker?.toUpperCase()] || null;
}

// Load sector mappings from KV (called on startup)
async function loadSectorMappingsFromKV(KV) {
  try {
    if (!KV) {
      console.log(
        `[SECTOR LOAD] KV not available, skipping sector mapping load`,
      );
      return;
    }
    // Get all tickers from watchlist
    const tickersList = await KV.get("timed:tickers", "json");
    if (!tickersList || !Array.isArray(tickersList)) {
      console.log(`[SECTOR LOAD] No tickers list found in KV, skipping`);
      return;
    }

    let loadedCount = 0;
    for (const ticker of tickersList) {
      const tickerUpper = String(ticker).toUpperCase();
      const sectorKey = `timed:sector_map:${tickerUpper}`;
      const sector = await KV.get(sectorKey, "text");

      if (sector && sector.trim() !== "") {
        SECTOR_MAP[tickerUpper] = sector.trim();
        loadedCount++;
      }
    }

    if (loadedCount > 0) {
      console.log(
        `[SECTOR LOAD] Loaded ${loadedCount} sector mappings from KV`,
      );
    }
  } catch (err) {
    console.error(`[SECTOR LOAD] Error loading sector mappings:`, err);
  }
}

function getSectorRating(sector) {
  return SECTOR_RATINGS[sector] || { rating: "neutral", boost: 0 };
}

function getTickersInSector(sector) {
  return Object.keys(SECTOR_MAP).filter(
    (ticker) => SECTOR_MAP[ticker] === sector,
  );
}

function getAllSectors() {
  return Object.keys(SECTOR_RATINGS);
}

// ─────────────────────────────────────────────────────────────
// Historical P/E Percentile Calculation
// ─────────────────────────────────────────────────────────────

// Calculate percentile from sorted array
function calculatePercentile(sortedArray, percentile) {
  if (!sortedArray || sortedArray.length === 0) return null;
  const index = Math.floor((percentile / 100) * sortedArray.length);
  return sortedArray[Math.min(index, sortedArray.length - 1)];
}

// Calculate all percentiles from P/E history
function calculatePEPercentiles(peHistory) {
  if (!peHistory || peHistory.length < 10) return null; // Need at least 10 data points

  const sorted = [...peHistory].sort((a, b) => a - b);

  return {
    p10: calculatePercentile(sorted, 10),
    p25: calculatePercentile(sorted, 25),
    p50: calculatePercentile(sorted, 50), // Median
    p75: calculatePercentile(sorted, 75),
    p90: calculatePercentile(sorted, 90),
    avg: peHistory.reduce((a, b) => a + b, 0) / peHistory.length,
    count: peHistory.length,
  };
}

// Determine percentile position
function getPercentilePosition(currentPE, percentiles) {
  if (!currentPE || !percentiles) return null;

  if (currentPE < percentiles.p25) return "Bottom 25%";
  if (currentPE < percentiles.p50) return "Below Median";
  if (currentPE < percentiles.p75) return "Above Median";
  return "Top 25%";
}

// ─────────────────────────────────────────────────────────────
// Fair Value Calculation
// ─────────────────────────────────────────────────────────────

// Calculate fair value P/E using multiple methods
function calculateFairValuePE(peHistory, epsGrowthRate, targetPEG = 1.0) {
  const methods = {};

  // Method 1: Historical Average
  if (peHistory && peHistory.length > 0) {
    methods.historical_avg =
      peHistory.reduce((a, b) => a + b, 0) / peHistory.length;
  }

  // Method 2: Historical Median
  if (peHistory && peHistory.length > 0) {
    const sorted = [...peHistory].sort((a, b) => a - b);
    methods.historical_median = sorted[Math.floor(sorted.length / 2)];
  }

  // Method 3: Growth-Adjusted (PEG-based)
  if (epsGrowthRate && epsGrowthRate > 0) {
    const growthBasedPE = epsGrowthRate * targetPEG;
    // Cap at reasonable levels (min: historical avg if available, max: 40x)
    const minPE = methods.historical_avg || 15;
    const maxPE = 40;
    methods.growth_adjusted = Math.max(minPE, Math.min(growthBasedPE, maxPE));
  }

  // Preferred method: Use growth-adjusted if available, otherwise historical median, fallback to avg
  methods.preferred =
    methods.growth_adjusted ||
    methods.historical_median ||
    methods.historical_avg;

  return methods;
}

// Calculate fair value price
function calculateFairValuePrice(eps, fairValuePE) {
  if (!eps || !fairValuePE || eps <= 0) return null;
  return eps * fairValuePE;
}

// Calculate premium/discount percentage
function calculatePremiumDiscount(currentPrice, fairValuePrice) {
  if (!currentPrice || !fairValuePrice || fairValuePrice <= 0) return null;
  return ((currentPrice - fairValuePrice) / fairValuePrice) * 100;
}

// ─────────────────────────────────────────────────────────────
// Valuation Signals
// ─────────────────────────────────────────────────────────────

// Determine valuation signal based on multiple factors
function calculateValuationSignal(
  currentPE,
  fairValuePE,
  pegRatio,
  premiumDiscount,
  percentiles,
) {
  // Default thresholds
  const UNDERVALUED_THRESHOLD = -15; // 15% below fair value
  const OVERVALUED_THRESHOLD = 15; // 15% above fair value
  const PEG_UNDERVALUED = 0.8;
  const PEG_OVERVALUED = 1.5;

  let signals = {
    signal: "fair", // undervalued, fair, overvalued
    is_undervalued: false,
    is_overvalued: false,
    confidence: "medium", // low, medium, high
    reasons: [],
  };

  // Factor 1: Premium/Discount to Fair Value
  if (premiumDiscount !== null) {
    if (premiumDiscount < UNDERVALUED_THRESHOLD) {
      signals.is_undervalued = true;
      signals.reasons.push(
        `Price ${Math.abs(premiumDiscount).toFixed(1)}% below fair value`,
      );
    } else if (premiumDiscount > OVERVALUED_THRESHOLD) {
      signals.is_overvalued = true;
      signals.reasons.push(
        `Price ${premiumDiscount.toFixed(1)}% above fair value`,
      );
    }
  }

  // Factor 2: PEG Ratio
  if (pegRatio !== null) {
    if (pegRatio < PEG_UNDERVALUED) {
      signals.is_undervalued = true;
      signals.reasons.push(
        `PEG ratio ${pegRatio.toFixed(2)} suggests undervalued growth`,
      );
    } else if (pegRatio > PEG_OVERVALUED) {
      signals.is_overvalued = true;
      signals.reasons.push(
        `PEG ratio ${pegRatio.toFixed(2)} suggests overvalued`,
      );
    }
  }

  // Factor 3: Historical P/E Percentile
  if (currentPE && percentiles) {
    if (currentPE < percentiles.p25) {
      signals.is_undervalued = true;
      signals.reasons.push(`P/E in bottom 25% historically`);
    } else if (currentPE > percentiles.p75) {
      signals.is_overvalued = true;
      signals.reasons.push(`P/E in top 25% historically`);
    }
  }

  // Determine final signal
  if (signals.is_undervalued && !signals.is_overvalued) {
    signals.signal = "undervalued";
    signals.confidence = signals.reasons.length >= 2 ? "high" : "medium";
  } else if (signals.is_overvalued && !signals.is_undervalued) {
    signals.signal = "overvalued";
    signals.confidence = signals.reasons.length >= 2 ? "high" : "medium";
  } else {
    signals.signal = "fair";
    signals.confidence = "medium";
  }

  return signals;
}

// ─────────────────────────────────────────────────────────────
// Valuation Boost/Penalty for Ranking
// ─────────────────────────────────────────────────────────────

// Calculate valuation boost/penalty to add to rank
function calculateValuationBoost(fundamentals) {
  if (!fundamentals) return 0;

  let boost = 0;

  // Factor 1: Valuation Signal (primary factor)
  if (fundamentals.is_undervalued) {
    if (fundamentals.valuation_confidence === "high") {
      boost += 5; // Strong undervaluation signal
    } else {
      boost += 3; // Moderate undervaluation signal
    }
  } else if (fundamentals.is_overvalued) {
    if (fundamentals.valuation_confidence === "high") {
      boost -= 5; // Strong overvaluation signal
    } else {
      boost -= 3; // Moderate overvaluation signal
    }
  }

  // Factor 2: PEG Ratio (secondary factor for growth stocks)
  if (fundamentals.peg_ratio !== null && fundamentals.peg_ratio > 0) {
    if (fundamentals.peg_ratio < 0.8) {
      boost += 2; // Excellent PEG (undervalued growth)
    } else if (fundamentals.peg_ratio < 1.0) {
      boost += 1; // Good PEG (fairly valued growth)
    } else if (fundamentals.peg_ratio > 1.5) {
      boost -= 1; // Poor PEG (overvalued)
    } else if (fundamentals.peg_ratio > 2.0) {
      boost -= 3; // Very poor PEG (highly overvalued)
    }
  }

  // Factor 3: Premium/Discount to Fair Value (tertiary factor)
  if (fundamentals.premium_discount_pct !== null) {
    if (fundamentals.premium_discount_pct < -20) {
      boost += 2; // Significantly below fair value
    } else if (fundamentals.premium_discount_pct < -10) {
      boost += 1; // Moderately below fair value
    } else if (fundamentals.premium_discount_pct > 20) {
      boost -= 2; // Significantly above fair value
    } else if (fundamentals.premium_discount_pct > 10) {
      boost -= 1; // Moderately above fair value
    }
  }

  // Cap the boost/penalty to reasonable bounds
  return Math.max(-8, Math.min(8, boost));
}

// Rank tickers within a sector by technical score + sector boost
async function rankTickersInSector(KV, sector, limit = 10) {
  const sectorTickers = getTickersInSector(sector);
  const sectorRating = getSectorRating(sector);

  const tickerData = [];

  // Get data for all tickers in sector
  for (const ticker of sectorTickers) {
    const data = await kvGetJSON(KV, `timed:latest:${ticker}`);
    if (data) {
      const baseRank = Number(data.rank) || 0;
      const sectorBoost = sectorRating.boost;

      // Get valuation boost from fundamentals
      const fundamentals =
        data.fundamentals ||
        (await kvGetJSON(KV, `timed:fundamentals:${ticker}`));
      const valuationBoost = calculateValuationBoost(fundamentals);

      // Calculate total boosted rank: base + sector + valuation
      const boostedRank = baseRank + sectorBoost + valuationBoost;

      tickerData.push({
        ticker,
        rank: baseRank,
        boostedRank,
        sector,
        sectorRating: sectorRating.rating,
        sectorBoost: sectorRating.boost,
        valuationBoost: valuationBoost,
        ...data,
      });
    }
  }

  // Sort by boosted rank (descending)
  tickerData.sort((a, b) => b.boostedRank - a.boostedRank);

  return tickerData.slice(0, limit);
}

// Module-level variable for lazy initialization (persists across requests in same isolate)
let sectorMappingsLoaded = false;

export default {
  async fetch(req, env, ctx) {
    // Top-level error handler to prevent 500 errors from crashing the worker
    try {
      const url = new URL(req.url);

      // Always satisfy CORS preflight before touching bindings.
      // This prevents the dashboard from being blocked by CORS when KV/D1 are misconfigured.
      if (req.method === "OPTIONS") {
        return new Response("", {
          status: 204,
          headers: corsHeaders(env, req),
        });
      }

      const KV = env.KV_TIMED;

      // Verify KV binding is available
      if (!KV) {
        console.error(`[FETCH ERROR] KV_TIMED binding is not available`, {
          hasEnv: !!env,
          envKeys: env ? Object.keys(env) : [],
          url: req?.url,
        });
        return sendJSON(
          {
            ok: false,
            error: "kv_not_configured",
            message:
              "KV binding is not configured. Please add KV_TIMED binding in Cloudflare Dashboard.",
          },
          500,
          corsHeaders(env, req),
        );
      }

      // Use waitUntil to ensure critical operations complete even after response
      // This helps prevent race conditions with request cancellation

      // Load sector mappings from KV on first request (lazy initialization)
      // Wrap in try-catch to prevent crashes if KV is unavailable
      if (!sectorMappingsLoaded && KV) {
        try {
          // Never let a slow KV read block the entire Worker (can cause all endpoints to hang)
          const withTimeout = (p, ms) =>
            Promise.race([
              p,
              new Promise((_, reject) =>
                setTimeout(
                  () => reject(new Error("sector_mappings_timeout")),
                  ms,
                ),
              ),
            ]);

          await withTimeout(loadSectorMappingsFromKV(KV), 1000);
          sectorMappingsLoaded = true;
        } catch (sectorLoadErr) {
          console.error(`[SECTOR LOAD] Failed to load sector mappings:`, {
            error: String(sectorLoadErr),
            message: sectorLoadErr?.message,
          });
          // Continue anyway - sector mappings are optional
          sectorMappingsLoaded = true; // Mark as loaded to prevent retry loops
        }
      }

      // url already parsed above

      // POST /timed/ingest
      // NOTE: This endpoint uses API key authentication instead of rate limiting
      // TradingView webhooks are authenticated via ?key= parameter
      if (url.pathname === "/timed/ingest" && req.method === "POST") {
        let body = null; // Declare outside try for catch block access
        try {
          // Early logging to confirm request reception
          const ip = req.headers.get("CF-Connecting-IP") || "unknown";
          console.log(
            `[INGEST REQUEST RECEIVED] IP: ${ip}, User-Agent: ${
              req.headers.get("User-Agent") || "none"
            }`,
          );

          const authFail = requireKeyOr401(req, env);
          if (authFail) {
            console.log(`[INGEST AUTH FAILED] IP: ${ip}`);
            return authFail;
          }

          console.log(`[INGEST AUTH PASSED] Processing request from IP: ${ip}`);
          const { obj: bodyData, raw, err } = await readBodyAsJSON(req);
          body = bodyData; // Assign to outer variable
          if (!body) {
            console.log(
              `[INGEST JSON PARSE FAILED] IP: ${ip}, Error: ${String(
                err || "unknown",
              )}, Raw sample: ${String(raw || "").slice(0, 200)}`,
            );
            return ackJSON(
              env,
              {
                ok: false,
                error: "bad_json",
                sample: String(raw || "").slice(0, 200),
                parseError: String(err || ""),
              },
              400,
              req,
            );
          }

          // Log raw payload for debugging (especially for missing tickers)
          const tickerFromBody = normTicker(body?.ticker);
          console.log(`[INGEST RAW] ${tickerFromBody || "UNKNOWN"}:`, {
            hasTicker: !!body?.ticker,
            hasTs: body?.ts !== undefined,
            hasHtf: body?.htf_score !== undefined,
            hasLtf: body?.ltf_score !== undefined,
            ts: body?.ts,
            htf: body?.htf_score,
            ltf: body?.ltf_score,
            tsType: typeof body?.ts,
            htfType: typeof body?.htf_score,
            ltfType: typeof body?.ltf_score,
          });

          const v = validateTimedPayload(body);
          if (!v.ok) {
            console.log(
              `[INGEST VALIDATION FAILED] ${tickerFromBody || "UNKNOWN"}:`,
              {
                error: v.error,
                ticker: body?.ticker,
                ts: body?.ts,
                htf: body?.htf_score,
                ltf: body?.ltf_score,
              },
            );
            return ackJSON(env, v, 400, req);
          }

          const ticker = v.ticker;
          const payload = v.payload;

          const rawPayload =
            typeof raw === "string"
              ? raw
              : (() => {
                  try {
                    return JSON.stringify(body);
                  } catch {
                    return "";
                  }
                })();

          // Store raw webhook receipt (KV + D1) before any filtering or derived logic
          try {
            if (rawPayload) {
              await kvPutText(
                KV,
                `timed:ingest:raw:${ticker}`,
                rawPayload,
                2 * 24 * 60 * 60,
              );
            }
          } catch (rawErr) {
            console.error(
              `[INGEST RAW] KV store failed for ${ticker}:`,
              rawErr,
            );
          }

          d1InsertIngestReceipt(env, ticker, payload, rawPayload).catch(
            (err) => {
              console.error(
                `[D1 INGEST] Receipt insert exception for ${ticker}:`,
                err,
              );
            },
          );

          // Migrate BRK.B to BRK-B if needed (TradingView sends BRK.B, but we use BRK-B)
          // Check BEFORE normalization to catch BRK.B from TradingView
          const rawTicker = body?.ticker;
          if (
            rawTicker === "BRK.B" ||
            rawTicker === "BRK-B" ||
            ticker === "BRK-B"
          ) {
            // Check if old BRK.B data exists and migrate it
            const oldData = await kvGetJSON(KV, `timed:latest:BRK.B`);
            const newData = await kvGetJSON(KV, `timed:latest:BRK-B`);

            if (
              oldData &&
              (!newData ||
                (oldData.ts && newData.ts && oldData.ts > newData.ts))
            ) {
              console.log(
                `[MIGRATE BRK] Migrating BRK.B data to BRK-B (old ts: ${
                  oldData.ts
                }, new ts: ${newData?.ts || "none"})`,
              );
              // Copy data to BRK-B (use newer data if both exist)
              const dataToUse =
                newData && newData.ts > oldData.ts ? newData : oldData;
              await kvPutJSON(KV, `timed:latest:BRK-B`, dataToUse);
              // Copy trail if exists
              const oldTrail = await kvGetJSON(KV, `timed:trail:BRK.B`);
              const newTrail = await kvGetJSON(KV, `timed:trail:BRK-B`);
              if (oldTrail) {
                await kvPutJSON(KV, `timed:trail:BRK-B`, oldTrail);
              } else if (newTrail) {
                await kvPutJSON(KV, `timed:trail:BRK-B`, newTrail);
              }
              // Ensure BRK-B is in index (should already be, but double-check)
              await ensureTickerIndex(KV, "BRK-B");
              // Delete old BRK.B data only if we migrated it
              if (dataToUse === oldData) {
                await KV.delete(`timed:latest:BRK.B`);
                await KV.delete(`timed:trail:BRK.B`);
                console.log(
                  `[MIGRATE BRK] Migration complete: BRK.B → BRK-B (deleted old BRK.B)`,
                );
              } else {
                console.log(
                  `[MIGRATE BRK] BRK-B already has newer data, keeping both`,
                );
              }
            }
          }

          // Log ingestion for debugging
          console.log(`[INGEST] ${ticker}:`, {
            ts: payload.ts,
            htf: payload.htf_score,
            ltf: payload.ltf_score,
            state: payload.state,
            price: payload.price,
            script_version: payload.script_version,
          });

          // Check version and migrate if needed (non-blocking for large migrations)
          const incomingVersion = payload.script_version || "unknown";
          const storedVersion = await getStoredVersion(KV);
          let migration = { migrated: false, reason: "version_match" };

          if (!storedVersion) {
            // First run - set version immediately
            await setStoredVersion(KV, incomingVersion);
          } else if (storedVersion !== incomingVersion) {
            // Version changed - run migration in background to avoid timeout
            console.log(
              `Version change detected: ${storedVersion} -> ${incomingVersion}, starting background migration`,
            );

            // Update version immediately to prevent concurrent migrations from multiple requests
            // Migration will still run (it checks storedVersion at start, before we update)
            // But subsequent requests won't trigger migration again
            await setStoredVersion(KV, incomingVersion);

            // Start migration in background (fire and forget) - don't wait for completion
            // This prevents timeout on large data sets (133+ tickers)
            // Use storedVersion from before update to run migration correctly
            const migrationPromise = checkAndMigrateWithStoredVersion(
              KV,
              storedVersion,
              incomingVersion,
            );
            migrationPromise
              .then((result) => {
                if (result.migrated) {
                  console.log(
                    `Background migration completed: ${result.oldVersion} -> ${
                      result.newVersion
                    }, purged ${result.tickerCount || 0} tickers`,
                  );
                  // Optionally notify Discord about migration
                  // Notify Discord about migration with embed card
                  const migrationEmbed = {
                    title: "🔄 Data Model Migration",
                    color: 0x0099ff, // Blue
                    fields: [
                      {
                        name: "Version",
                        value: `${result.oldVersion} → ${result.newVersion}`,
                        inline: true,
                      },
                      {
                        name: "Tickers Purged",
                        value: `${result.tickerCount || 0}`,
                        inline: true,
                      },
                      {
                        name: "Archive Created",
                        value: result.archived ? "Yes" : "No",
                        inline: true,
                      },
                    ],
                    description: "Migration completed in background",
                    timestamp: new Date().toISOString(),
                    footer: {
                      text: "Timed Trading System",
                    },
                  };
                  if (
                    shouldSendDiscordAlert(env, "SYSTEM", { kind: "migration" })
                  ) {
                    notifyDiscord(env, migrationEmbed).catch(() => {}); // Don't let Discord notification errors break anything
                  }
                }
              })
              .catch((err) => {
                console.error(`[MIGRATION ERROR]`, {
                  error: String(err),
                  stack: err.stack,
                  fromVersion: storedVersion,
                  toVersion: incomingVersion,
                });
              });

            migration = {
              migrated: true,
              reason: "version_changed",
              inProgress: true,
            };
          }

          // Dedupe rapid repeats (only if exact same data within 60s)
          // Note: For Force Baseline, TV sends all alerts with same timestamp/data structure
          // We still want to index all tickers, so dedupe only prevents duplicate alert processing
          // but ticker indexing happens regardless
          const basis = JSON.stringify({
            ts: payload.ts,
            htf: payload.htf_score,
            ltf: payload.ltf_score,
            state: payload.state || "",
            completion: payload.completion,
            phase_pct: payload.phase_pct,
            rr: payload.rr,
            trigger_ts: payload.trigger_ts,
            // Note: We don't include ticker in hash because Force Baseline sends same data structure for all
            // Dedupe is per-ticker, so each ticker gets processed even if data is identical
          });

          const hash = stableHash(basis);
          const dedupeKey = `timed:dedupe:${ticker}:${hash}`;
          const alreadyDeduped = await KV.get(dedupeKey);
          const isRapidDeduped = !!alreadyDeduped;
          if (isRapidDeduped) {
            console.log(
              `[INGEST DEDUPED] ${ticker} - same data within 60s (hash: ${hash.substring(
                0,
                8,
              )})`,
            );
          } else {
            await kvPutText(KV, dedupeKey, "1", 60);
            console.log(
              `[INGEST NOT DEDUPED] ${ticker} - new or changed data (hash: ${hash.substring(
                0,
                8,
              )})`,
            );
          }

          // Derived: staleness
          const stale = stalenessBucket(ticker, payload.ts);
          payload.market_type = stale.mt;
          payload.age_min = stale.ageMin;
          payload.staleness = stale.bucket;

          // Derived: rr/rank
          payload.rr = payload.rr ?? computeRR(payload);
          // (optional clamp to prevent any bizarre edge cases)
          if (payload.rr != null && Number(payload.rr) > 25) payload.rr = 25;

          // Calculate Momentum Elite (worker-based with caching)
          if (ticker === "ETHT") {
            console.log(`[ETHT DEBUG] About to compute Momentum Elite`);
          }
          const momentumEliteData = await computeMomentumElite(
            KV,
            ticker,
            payload,
          );
          if (ticker === "ETHT") {
            console.log(`[ETHT DEBUG] Momentum Elite computed:`, {
              momentum_elite: momentumEliteData?.momentum_elite,
              hasCriteria: !!momentumEliteData?.criteria,
            });
          }
          if (momentumEliteData && momentumEliteData.momentum_elite) {
            // Update flags with Momentum Elite status
            if (!payload.flags) payload.flags = {};
            payload.flags.momentum_elite = true;
            // Store full criteria for debugging/display
            payload.momentum_elite_criteria = momentumEliteData.criteria;
          } else {
            // Ensure flag is set to false if not elite
            if (!payload.flags) payload.flags = {};
            payload.flags.momentum_elite = false;
          }

          // Data completeness + TF/trigger summaries (used by UI + scoring)
          try {
            payload.data_completeness = computeDataCompleteness(payload);
            const tfSum = tfTechAlignmentSummary(payload);
            if (tfSum) payload.tf_summary = tfSum;
            payload.trigger_summary = triggerSummaryAndScore(payload);
            payload.move_status = computeMoveStatus(payload);
            payload.flags =
              payload.flags && typeof payload.flags === "object"
                ? payload.flags
                : {};
            payload.flags.move_invalidated =
              payload.move_status?.status === "INVALIDATED";
            payload.flags.move_completed =
              payload.move_status?.status === "COMPLETED";
            const trigCorr = triggerReasonCorroboration(payload);
            payload.trigger_reason_corroborated = !!trigCorr.corroborated;
            payload.trigger_reason_note = trigCorr.note || "";
          } catch (e) {
            console.error(
              `[ENRICH] Failed for ${ticker}:`,
              String(e?.message || e),
            );
          }

          payload.rank = computeRank(payload);
          payload.score = payload.rank;

          // Derived: horizon + % metrics (ETA v2 + risk/return)
          try {
            const derived = deriveHorizonAndMetrics(payload);
            Object.assign(payload, derived);
          } catch (e) {
            console.error(`[DERIVED METRICS] Failed for ${ticker}:`, String(e));
          }

          // Trail (light) - store immediately after derived metrics
          try {
            // Load previous state for Flip Watch, Kanban lifecycle, and stage transition detection
            const existing =
              (await kvGetJSON(KV, `timed:latest:${ticker}`)) || {};
            const trailPoint = {
              ts: payload.ts,
              price: payload.price, // Add price to trail for momentum calculations
              htf_score: payload.htf_score,
              ltf_score: payload.ltf_score,
              completion: payload.completion,
              phase_pct: payload.phase_pct,
              state: payload.state,
              rank: payload.rank,
              flags: payload.flags || {},
              momentum_elite: !!(payload.flags && payload.flags.momentum_elite),
              trigger_reason: payload.trigger_reason,
              trigger_dir: payload.trigger_dir,
            };

            const trail = await appendTrail(KV, ticker, trailPoint, 320); // ~26h at 5m cadence (enables 4h/1d deltas)

            // Compute live thesis features from the updated trail
            try {
              const computed = computeLiveThesisFeaturesFromTrail(
                trail,
                payload,
              );
              if (computed && typeof computed === "object") {
                payload.seq = computed.seq;
                payload.deltas = computed.deltas;
                payload.flags =
                  payload.flags && typeof payload.flags === "object"
                    ? payload.flags
                    : {};
                payload.flags.htf_improving_4h =
                  !!computed.flags?.htf_improving_4h;
                payload.flags.htf_improving_1d =
                  !!computed.flags?.htf_improving_1d;
                payload.flags.htf_move_4h_ge_5 =
                  !!computed.flags?.htf_move_4h_ge_5;
                payload.flags.thesis_match = !!computed.flags?.thesis_match;
              }

              // Flip Watch detection - tickers about to transition from setup to momentum
              try {
                const nowMs = Number(
                  payload?.ts ?? payload?.ingest_ts ?? Date.now(),
                );
                const state = String(payload?.state || "");
                const inPullback =
                  state === "HTF_BULL_LTF_PULLBACK" ||
                  state === "HTF_BEAR_LTF_PULLBACK";
                const isMomentum =
                  state === "HTF_BULL_LTF_BULL" ||
                  state === "HTF_BEAR_LTF_BEAR";

                const flipWatch = detectFlipWatch(payload, trail);
                const prevUntilRaw = Number(existing?.flip_watch_until_ts);
                const prevUntil = Number.isFinite(prevUntilRaw)
                  ? prevUntilRaw
                  : null;
                const prevScore = Number(existing?.flip_watch_score);
                const prevReasons = Array.isArray(existing?.flip_watch_reasons)
                  ? existing.flip_watch_reasons
                  : null;

                // Sticky window: once triggered, keep Flip Watch for 60m *while still in pullback*.
                // If it flips into momentum, release immediately so it can progress (Just Flipped / Enter Now).
                const STICKY_MS = 60 * 60 * 1000;
                const stickyActive =
                  !isMomentum &&
                  inPullback &&
                  prevUntil != null &&
                  Number.isFinite(nowMs) &&
                  nowMs <= prevUntil;

                if (flipWatch) {
                  payload.flags.flip_watch = true;
                  payload.flip_watch_score = flipWatch.score;
                  payload.flip_watch_reasons = flipWatch.reasons;
                  payload.flip_watch_until_ts = nowMs + STICKY_MS;
                } else if (stickyActive) {
                  payload.flags.flip_watch = true;
                  if (Number.isFinite(prevScore))
                    payload.flip_watch_score = prevScore;
                  if (prevReasons) payload.flip_watch_reasons = prevReasons;
                  payload.flip_watch_until_ts = prevUntil;
                } else {
                  payload.flags.flip_watch = false;
                  payload.flip_watch_until_ts = null;
                }
              } catch (e) {
                console.error(
                  `[FLIP WATCH] Detection failed for ${ticker}:`,
                  String(e),
                );
              }
            } catch (e) {
              console.error(
                `[THESIS FEATURES] Compute failed for ${ticker}:`,
                String(e),
              );
            }

            // Kanban Stage classification - ALWAYS run (independent of thesis/flip-watch logic)
            // CRITICAL: Merge entry_ts/entry_price from existing BEFORE classifyKanbanStage.
            // Otherwise computeMoveStatus sees hasEntered=false and tickers that should be HOLD
            // (move passed) end up in Watch. Same for cycle fields (lifecycle gate).
            try {
              if (existing?.entry_ts != null || existing?.entry_price != null) {
                if (payload.entry_ts == null && Number.isFinite(Number(existing?.entry_ts)))
                  payload.entry_ts = Number(existing.entry_ts);
                if (payload.entry_price == null && Number.isFinite(Number(existing?.entry_price)))
                  payload.entry_price = Number(existing.entry_price);
              }
              if (existing?.kanban_cycle_enter_now_ts != null)
                payload.kanban_cycle_enter_now_ts = existing.kanban_cycle_enter_now_ts;
              if (existing?.kanban_cycle_trigger_ts != null)
                payload.kanban_cycle_trigger_ts = existing.kanban_cycle_trigger_ts;
              if (existing?.kanban_cycle_side != null)
                payload.kanban_cycle_side = existing.kanban_cycle_side;

              // Fallback: if we have an open trade in the ledger but no entry_ts on payload,
              // inject from the trade so we correctly show HOLD (not Watch).
              const openTrade = await findOpenTradeForTicker(KV, ticker, null);
              if ((payload.entry_ts == null || payload.entry_price == null) && openTrade) {
                const et = isoToMs(openTrade.entryTime) || Number(openTrade.entry_ts) || Number(openTrade.entryTs);
                const ep = Number(openTrade.entryPrice ?? openTrade.entry_price);
                if (payload.entry_ts == null && Number.isFinite(et)) payload.entry_ts = et;
                if (payload.entry_price == null && Number.isFinite(ep) && ep > 0)
                  payload.entry_price = ep;
              }
              // Recompute move_status so stored payload reflects merged entry_ts (HOLD vs Watch)
              payload.move_status = computeMoveStatus(payload);
              if (payload.flags) {
                payload.flags.move_invalidated = payload.move_status?.status === "INVALIDATED";
                payload.flags.move_completed = payload.move_status?.status === "COMPLETED";
              }

              const stage = classifyKanbanStage(payload);
              const prevStage = existing?.kanban_stage;
              // Recycle rule: if something was in ARCHIVE, it must re-enter via opportunity lanes
              // so users clearly see it "recycled" rather than jumping into position-management lanes.
              let finalStage = stage;
              if (
                prevStage === "archive" &&
                (stage === "hold" ||
                  stage === "just_entered" ||
                  stage === "trim" ||
                  stage === "exit")
              ) {
                finalStage = "watch";
                payload.flags =
                  payload.flags && typeof payload.flags === "object"
                    ? payload.flags
                    : {};
                payload.flags.recycled_from_archive = true;
              }

              // Lifecycle gate: HOLD/DEFEND/TRIM/EXIT must pass through ENTER_NOW first (per trigger+side cycle).
              // This prevents "jumping" into management lanes when a ticker flips sides or has stale trigger state.
              try {
                const mgmt =
                  finalStage === "hold" ||
                  finalStage === "just_entered" ||
                  finalStage === "trim" ||
                  finalStage === "exit";
                if (mgmt) {
                  const curTriggerTs = Number(payload?.trigger_ts);
                  const curSide = sideFromStateOrScores(payload); // "LONG" | "SHORT" | null
                  const cycleEnterTs = Number(
                    existing?.kanban_cycle_enter_now_ts,
                  );
                  const cycleTrig = Number(existing?.kanban_cycle_trigger_ts);
                  const cycleSide =
                    existing?.kanban_cycle_side != null
                      ? String(existing.kanban_cycle_side)
                      : null;
                  const sameTrig =
                    Number.isFinite(curTriggerTs) &&
                    curTriggerTs > 0 &&
                    Number.isFinite(cycleTrig) &&
                    cycleTrig > 0 &&
                    cycleTrig === curTriggerTs;
                  const cycleOk =
                    Number.isFinite(cycleEnterTs) &&
                    cycleEnterTs > 0 &&
                    sameTrig &&
                    !!cycleSide &&
                    !!curSide &&
                    cycleSide === curSide;

                  if (!Number.isFinite(curTriggerTs) || curTriggerTs <= 0) {
                    // Can't be in management lanes without a valid trigger.
                    finalStage = "watch";
                    payload.flags =
                      payload.flags && typeof payload.flags === "object"
                        ? payload.flags
                        : {};
                    payload.flags.forced_watch_missing_trigger = true;
                  } else if (!cycleOk) {
                    finalStage = "enter_now";
                    payload.flags =
                      payload.flags && typeof payload.flags === "object"
                        ? payload.flags
                        : {};
                    payload.flags.forced_enter_now_gate = true;
                  }
                }

                const tsNow = Number(payload?.ts) || Date.now();
                if (finalStage === "enter_now") {
                  const curTriggerTs = Number(payload?.trigger_ts);
                  const curSide = sideFromStateOrScores(payload);
                  payload.kanban_cycle_enter_now_ts = tsNow;
                  payload.kanban_cycle_trigger_ts =
                    Number.isFinite(curTriggerTs) && curTriggerTs > 0
                      ? curTriggerTs
                      : null;
                  payload.kanban_cycle_side =
                    curSide != null ? String(curSide) : null;
                } else if (
                  finalStage === "hold" ||
                  finalStage === "just_entered" ||
                  finalStage === "trim" ||
                  finalStage === "exit"
                ) {
                  // Carry forward the cycle markers while in management lanes.
                  payload.kanban_cycle_enter_now_ts =
                    existing?.kanban_cycle_enter_now_ts || null;
                  payload.kanban_cycle_trigger_ts =
                    existing?.kanban_cycle_trigger_ts || null;
                  payload.kanban_cycle_side =
                    existing?.kanban_cycle_side || null;
                } else {
                  // Reset cycle when we're not in ENTER_NOW or management lanes.
                  payload.kanban_cycle_enter_now_ts = null;
                  payload.kanban_cycle_trigger_ts = null;
                  payload.kanban_cycle_side = null;
                }
              } catch (e) {
                console.error(
                  `[KANBAN] lifecycle gate failed for ${ticker}:`,
                  String(e),
                );
              }

              payload.kanban_stage = finalStage;
              payload.kanban_meta = deriveKanbanMeta(payload, finalStage);
              // Persist last transition source lane so UI can show "from: <lane>".
              // If stage changed: stamp prev_kanban_stage = previous lane (if known).
              // If stage did NOT change: carry forward the last stamped prev_kanban_stage.
              if (
                prevStage != null &&
                finalStage != null &&
                String(prevStage) !== String(finalStage)
              ) {
                payload.prev_kanban_stage = String(prevStage);
                payload.prev_kanban_stage_ts =
                  Number(payload?.ts) || Date.now();
              } else if (existing?.prev_kanban_stage != null) {
                payload.prev_kanban_stage = String(existing.prev_kanban_stage);
                payload.prev_kanban_stage_ts = Number.isFinite(
                  Number(existing?.prev_kanban_stage_ts),
                )
                  ? Number(existing.prev_kanban_stage_ts)
                  : null;
              } else {
                payload.prev_kanban_stage = null;
                payload.prev_kanban_stage_ts = null;
              }

              // Track entry price when entering "enter_now" stage
              if (finalStage === "enter_now" && prevStage !== "enter_now") {
                const price = Number(payload?.price);
                if (Number.isFinite(price) && price > 0) {
                  payload.entry_price = price;
                  payload.entry_ts = payload.ts;
                  console.log(
                    `[KANBAN] ${ticker} entered ENTER_NOW at $${price.toFixed(2)}`,
                  );
                }
              }

              // Discord notification for Enter Now and beyond lane transitions
              const actionableStages = [
                "enter_now",
                "hold",
                "just_entered",
                "trim",
                "exit",
              ];
              if (
                prevStage != null &&
                finalStage != null &&
                String(prevStage) !== String(finalStage) &&
                actionableStages.includes(finalStage)
              ) {
                const alertType = `KANBAN_${finalStage.toUpperCase()}`;
                const tsMs = Number(payload?.ts) || Date.now();
                const dedupeBucket = Math.floor(tsMs / 900000); // 15 min
                const dedupeKey = `timed:discord:kanban:${ticker}:${finalStage}:${dedupeBucket}`;
                ctx.waitUntil(
                  (async () => {
                    try {
                      const already = await KV.get(dedupeKey);
                      if (already) return;
                      await kvPutText(KV, dedupeKey, "1", 60 * 60); // 1h TTL
                      if (!shouldSendDiscordAlert(env, alertType, { ticker }))
                        return;
                      const embed = createKanbanStageEmbed(
                        ticker,
                        finalStage,
                        prevStage,
                        payload,
                      );
                      await notifyDiscord(env, embed).catch((err) => {
                        console.error(
                          `[KANBAN DISCORD] ${ticker} ${finalStage}:`,
                          err,
                        );
                      });
                    } catch (e) {
                      console.error(
                        `[KANBAN DISCORD] ${ticker} ${finalStage}:`,
                        e,
                      );
                    }
                  })(),
                );
              }

              // Preserve entry_price if already set and still in the pipeline
              if (finalStage && existing?.entry_price) {
                payload.entry_price = existing.entry_price;
                payload.entry_ts = existing.entry_ts;
              }

              // Calculate % change from entry if we have entry_price
              if (payload.entry_price) {
                const entryPrice = Number(payload.entry_price);
                const currentPrice = Number(payload.price);
                if (
                  Number.isFinite(entryPrice) &&
                  Number.isFinite(currentPrice) &&
                  entryPrice > 0
                ) {
                  payload.entry_change_pct =
                    ((currentPrice - entryPrice) / entryPrice) * 100;
                }
              }

              if (finalStage) console.log(`[KANBAN] ${ticker} → ${finalStage}`);
            } catch (e) {
              console.error(
                `[KANBAN] Stage classification failed for ${ticker}:`,
                String(e),
              );
              payload.kanban_stage = existing?.kanban_stage || null;
              payload.prev_kanban_stage = existing?.prev_kanban_stage || null;
              payload.prev_kanban_stage_ts =
                existing?.prev_kanban_stage_ts || null;
            }

            // Also store into D1 (if configured) for 7-day history.
            // Don't let D1 failures affect ingestion.
            d1InsertTrailPoint(env, ticker, payload).catch((e) => {
              console.error(`[D1 TRAIL] Insert exception for ${ticker}:`, e);
            });

            // Periodic cleanup (throttled) to keep ~35 days retention
            d1CleanupOldTrail(env, 35).catch((e) => {
              console.error(`[D1 TRAIL] Cleanup exception:`, e);
            });
          } catch (trailErr) {
            console.error(
              `[TRAIL ERROR] Failed to append trail for ${ticker}:`,
              {
                error: String(trailErr),
                message: trailErr.message,
                stack: trailErr.stack,
              },
            );
            // Don't throw - continue with ingestion even if trail fails
          }

          // Auto-populate sector: PRIORITIZE SECTOR_MAP over TradingView data
          // TradingView uses industry classifications (e.g., "Electronic Technology", "Retail Trade")
          // but we use GICS sectors (e.g., "Information Technology", "Consumer Discretionary")
          // So we always check SECTOR_MAP first, then fall back to TradingView data for unmapped tickers
          const tickerUpper = String(payload.ticker || ticker).toUpperCase();
          let sectorToUse = null;

          // First, check our SECTOR_MAP (GICS sectors)
          sectorToUse = getSector(tickerUpper);

          // If not in SECTOR_MAP, use TradingView's sector (for new/unmapped tickers)
          if (!sectorToUse) {
            if (
              payload.sector &&
              typeof payload.sector === "string" &&
              payload.sector.trim() !== ""
            ) {
              sectorToUse = payload.sector.trim();
              // Store TradingView sector in KV for reference (but don't override SECTOR_MAP)
              const sectorMapKey = `timed:sector_map:${tickerUpper}`;
              await kvPutText(KV, sectorMapKey, sectorToUse);
              console.log(
                `[SECTOR AUTO-MAP] ${tickerUpper} → ${sectorToUse} (from TradingView, not in SECTOR_MAP)`,
              );
            }
          } else {
            // Ticker is in SECTOR_MAP - use our GICS sector classification
            console.log(
              `[SECTOR] ${tickerUpper} → ${sectorToUse} (from SECTOR_MAP, ignoring TradingView sector: ${
                payload.sector || "none"
              })`,
            );
          }

          // Set sector at top level if we have one
          if (sectorToUse) {
            payload.sector = sectorToUse;
          }

          // Store sector and industry in payload (even if no fundamental data)
          // These are safe fields that work for all asset types
          if (payload.sector && typeof payload.sector === "string") {
            payload.sector = payload.sector.trim();
          }
          if (payload.industry && typeof payload.industry === "string") {
            payload.industry = payload.industry.trim();
          }

          // Store fundamental data if provided
          if (
            payload.pe_ratio !== undefined ||
            payload.eps !== undefined ||
            payload.market_cap !== undefined ||
            payload.eps_growth_rate !== undefined ||
            payload.peg_ratio !== undefined
          ) {
            const currentPE = payload.pe_ratio
              ? Number(payload.pe_ratio)
              : null;
            const eps = payload.eps ? Number(payload.eps) : null;
            const epsGrowthRate = payload.eps_growth_rate
              ? Number(payload.eps_growth_rate)
              : null;
            const pegRatio = payload.peg_ratio
              ? Number(payload.peg_ratio)
              : null;
            const currentPrice = Number(payload.price) || null;

            // ─────────────────────────────────────────────────────────────
            // Historical P/E Percentiles
            // ─────────────────────────────────────────────────────────────
            let peHistory = [];
            let percentiles = null;
            let percentilePosition = null;

            if (currentPE && currentPE > 0 && currentPE < 1000) {
              // Load existing P/E history
              const peHistoryKey = `timed:pe_history:${ticker}`;
              const existingHistory = await kvGetJSON(KV, peHistoryKey);

              if (existingHistory && Array.isArray(existingHistory)) {
                peHistory = existingHistory;
              }

              // Add current P/E to history
              peHistory.push(currentPE);

              // Keep last ~1260 data points (approximately 5 years of daily data)
              const maxHistoryLength = 1260;
              if (peHistory.length > maxHistoryLength) {
                peHistory = peHistory.slice(-maxHistoryLength);
              }

              // Save updated history
              await kvPutJSON(KV, peHistoryKey, peHistory);

              // Calculate percentiles
              percentiles = calculatePEPercentiles(peHistory);
              if (percentiles) {
                percentilePosition = getPercentilePosition(
                  currentPE,
                  percentiles,
                );
              }
            }

            // ─────────────────────────────────────────────────────────────
            // Fair Value Calculation
            // ─────────────────────────────────────────────────────────────
            const fairValuePE = calculateFairValuePE(peHistory, epsGrowthRate);
            const fairValuePrice = calculateFairValuePrice(
              eps,
              fairValuePE?.preferred,
            );
            const premiumDiscount = calculatePremiumDiscount(
              currentPrice,
              fairValuePrice,
            );

            // ─────────────────────────────────────────────────────────────
            // Valuation Signals
            // ─────────────────────────────────────────────────────────────
            const valuationSignals = calculateValuationSignal(
              currentPE,
              fairValuePE?.preferred,
              pegRatio,
              premiumDiscount,
              percentiles,
            );

            // ─────────────────────────────────────────────────────────────
            // Build Fundamentals Object
            // ─────────────────────────────────────────────────────────────
            payload.fundamentals = {
              // Basic metrics
              pe_ratio: currentPE,
              eps: eps,
              eps_growth_rate: epsGrowthRate,
              peg_ratio: pegRatio,
              market_cap: payload.market_cap
                ? Number(payload.market_cap)
                : null,
              industry: payload.industry || null,

              // Historical P/E Percentiles
              pe_percentiles: percentiles
                ? {
                    p10: percentiles.p10,
                    p25: percentiles.p25,
                    p50: percentiles.p50,
                    p75: percentiles.p75,
                    p90: percentiles.p90,
                    avg: percentiles.avg,
                    count: percentiles.count,
                  }
                : null,
              pe_percentile_position: percentilePosition,

              // Fair Value
              fair_value_pe: fairValuePE
                ? {
                    historical_avg: fairValuePE.historical_avg || null,
                    historical_median: fairValuePE.historical_median || null,
                    growth_adjusted: fairValuePE.growth_adjusted || null,
                    preferred: fairValuePE.preferred || null,
                  }
                : null,
              fair_value_price: fairValuePrice,
              premium_discount_pct: premiumDiscount,

              // Valuation Signals
              valuation_signal: valuationSignals.signal,
              is_undervalued: valuationSignals.is_undervalued,
              is_overvalued: valuationSignals.is_overvalued,
              valuation_confidence: valuationSignals.confidence,
              valuation_reasons: valuationSignals.reasons,
            };

            // Store fundamentals in KV for persistence
            const fundamentalsKey = `timed:fundamentals:${ticker}`;
            await kvPutJSON(KV, fundamentalsKey, payload.fundamentals);

            // Apply valuation boost to rank (if fundamentals available)
            if (payload.fundamentals) {
              const valuationBoost = calculateValuationBoost(
                payload.fundamentals,
              );
              if (valuationBoost !== 0) {
                const baseRank = payload.rank || 0;
                payload.rank = Math.max(
                  0,
                  Math.min(100, baseRank + valuationBoost),
                );
                payload.score = payload.rank;

                // Store valuation boost for debugging/display
                if (!payload.rank_components) payload.rank_components = {};
                payload.rank_components.valuation_boost = valuationBoost;
                payload.rank_components.base_rank = baseRank;

                console.log(
                  `[RANK] ${ticker}: Base=${baseRank}, Valuation Boost=${valuationBoost}, Final=${payload.rank}`,
                );
              }
            }
          } else {
            // No fundamental data provided, but still store sector/industry if available
            // Create minimal fundamentals object for UI compatibility
            if (payload.sector || payload.industry) {
              payload.fundamentals = {
                pe_ratio: null,
                eps: null,
                eps_growth_rate: null,
                peg_ratio: null,
                market_cap: null,
                industry: payload.industry
                  ? String(payload.industry).trim()
                  : null,
                sector: payload.sector ? String(payload.sector).trim() : null,
                pe_percentiles: null,
                pe_percentile_position: null,
                fair_value_pe: null,
                fair_value_price: null,
                premium_discount_pct: null,
                valuation_signal: "fair",
                is_undervalued: false,
                is_overvalued: false,
                valuation_confidence: "low",
                valuation_reasons: [],
              };
            }
          }

          // Detect state transition into aligned (enter Q2/Q3)
          const prevKey = `timed:prevstate:${ticker}`;
          const prevState = await KV.get(prevKey);
          await kvPutText(
            KV,
            prevKey,
            String(payload.state || ""),
            7 * 24 * 60 * 60,
          );

          const state = String(payload.state || "");
          const alignedLong = state === "HTF_BULL_LTF_BULL";
          const alignedShort = state === "HTF_BEAR_LTF_BEAR";
          const aligned = alignedLong || alignedShort;
          const enteredAligned = aligned && prevState !== state;

          const trigReason = String(payload.trigger_reason || "");
          const trigOk =
            trigReason === "EMA_CROSS" || trigReason === "SQUEEZE_RELEASE" ||
            trigReason.includes("EMA_CROSS") || trigReason.includes("SQUEEZE_RELEASE");

          const flags = payload.flags || {};
          const sqRel = !!flags.sq30_release;

          // Activity feed tracking - detect events (load BEFORE alert logic to check for corridor entry)
          if (ticker === "ETHT") {
            console.log(`[ETHT DEBUG] About to load activity tracking state`);
          }
          const prevCorridorKey = `timed:prevcorridor:${ticker}`;
          const prevInCorridor = await KV.get(prevCorridorKey);

          // Corridor-only logic (must match UI)
          const side = corridorSide(payload); // LONG/SHORT/null
          const inCorridor = !!side;
          const enteredCorridor = inCorridor && prevInCorridor !== "true";

          // corridor must match alignment
          const corridorAlignedOK =
            (side === "LONG" && alignedLong) ||
            (side === "SHORT" && alignedShort);

          // Allow alerts if:
          // 1. ENTERED corridor (just entered) AND aligned AND (entered aligned OR trigger OR squeeze release)
          // 2. OR in corridor AND aligned AND (entered aligned OR trigger OR squeeze release)
          // 3. OR in corridor AND squeeze release (squeeze release is a strong signal even if not fully aligned)
          const shouldConsiderAlert =
            (enteredCorridor &&
              corridorAlignedOK &&
              (enteredAligned || trigOk || sqRel)) ||
            (inCorridor &&
              ((corridorAlignedOK && (enteredAligned || trigOk || sqRel)) ||
                (sqRel && side))); // Squeeze release in corridor is a valid trigger even if not fully aligned
          payload.entry_decision = buildEntryDecision(
            ticker,
            payload,
            prevState,
          );
          const prevSqueezeKey = `timed:prevsqueeze:${ticker}`;
          const prevSqueezeOn = await KV.get(prevSqueezeKey);
          const prevSqueezeRelKey = `timed:prevsqueezerel:${ticker}`;
          const prevSqueezeRel = await KV.get(prevSqueezeRelKey);
          const prevMomentumEliteKey = `timed:prevmomentumelite:${ticker}`;
          const prevMomentumElite = await KV.get(prevMomentumEliteKey);
          if (ticker === "ETHT") {
            console.log(`[ETHT DEBUG] Activity tracking state loaded`);
          }

          // Track corridor entry
          // Wrap activity tracking in try-catch to prevent errors from breaking ingestion
          try {
            const actionableOnly = true;
            const enteredCorridor = inCorridor && prevInCorridor !== "true";
            const exitedCorridor = !inCorridor && prevInCorridor === "true";

            if (enteredCorridor) {
              if (!actionableOnly) {
                await appendActivity(KV, {
                  type: "corridor_entry",
                  ticker: ticker,
                  side: side,
                  price: payload.price,
                  state: payload.state,
                  rank: payload.rank,
                  sl: payload.sl,
                  tp: payload.tp,
                  tp_levels: payload.tp_levels,
                  rr: payload.rr,
                  phase_pct: payload.phase_pct,
                  completion: payload.completion,
                });
              }
              await kvPutText(KV, prevCorridorKey, "true", 7 * 24 * 60 * 60);
            } else if (exitedCorridor) {
              await kvPutText(KV, prevCorridorKey, "false", 7 * 24 * 60 * 60);
            }

            // Track squeeze start
            if (flags.sq30_on && prevSqueezeOn !== "true") {
              if (!actionableOnly) {
                await appendActivity(KV, {
                  type: "squeeze_start",
                  ticker: ticker,
                  price: payload.price,
                  state: payload.state,
                  rank: payload.rank,
                  sl: payload.sl,
                  tp: payload.tp,
                  tp_levels: payload.tp_levels,
                  rr: payload.rr,
                  phase_pct: payload.phase_pct,
                  completion: payload.completion,
                });
              }
              await kvPutText(KV, prevSqueezeKey, "true", 7 * 24 * 60 * 60);
            } else if (!flags.sq30_on && prevSqueezeOn === "true") {
              await kvPutText(KV, prevSqueezeKey, "false", 7 * 24 * 60 * 60);
            }

            // Track squeeze release
            if (sqRel && prevSqueezeRel !== "true") {
              await appendActivity(KV, {
                type: "squeeze_release",
                ticker: ticker,
                side:
                  side ||
                  (alignedLong ? "LONG" : alignedShort ? "SHORT" : null),
                price: payload.price,
                state: payload.state,
                rank: payload.rank,
                trigger_dir: payload.trigger_dir,
                sl: payload.sl,
                tp: payload.tp,
                tp_levels: payload.tp_levels,
                rr: payload.rr,
                phase_pct: payload.phase_pct,
                completion: payload.completion,
              });
              await kvPutText(KV, prevSqueezeRelKey, "true", 7 * 24 * 60 * 60);
            } else if (!sqRel && prevSqueezeRel === "true") {
              await kvPutText(KV, prevSqueezeRelKey, "false", 7 * 24 * 60 * 60);
            }

            // Track flip watch (tickers about to flip from PULLBACK to momentum)
            const prevFlipWatchKey = `timed:prev_flip_watch:${ticker}`;
            const prevFlipWatch = await KV.get(prevFlipWatchKey);
            const nowFlipWatch = !!flags.flip_watch;

            if (nowFlipWatch && prevFlipWatch !== "true") {
              // New flip watch - send Discord alert
              const discordEnable = env?.DISCORD_ENABLE || "false";
              const discordWebhook = env?.DISCORD_WEBHOOK_URL;
              const discordConfigured =
                discordEnable === "true" && !!discordWebhook;

              const nowMs = Date.now();
              const hourBucket = new Date(nowMs).toISOString().slice(0, 13);
              const dedupeKey = `timed:dedupe:flip_watch:${ticker}:${hourBucket}`;
              const already = await KV.get(dedupeKey);

              if (
                !already &&
                discordConfigured &&
                shouldSendDiscordAlert(env, "FLIP_WATCH", { ticker })
              ) {
                await KV.put(dedupeKey, "1", { expirationTtl: 60 * 60 * 4 }); // 4 hour dedupe

                const embed = createFlipWatchEmbed(ticker, payload);
                const sendRes = await notifyDiscord(env, embed).catch((err) => {
                  console.error(
                    `[FLIP WATCH] Failed to send alert for ${ticker}:`,
                    err,
                  );
                  return { ok: false, error: String(err) };
                });

                console.log(
                  `[FLIP WATCH] 🎯 Alert sent for ${ticker}, score=${payload.flip_watch_score}`,
                );
              }

              await appendActivity(KV, {
                type: "flip_watch",
                ticker: ticker,
                side: side,
                price: payload.price,
                state: payload.state,
                rank: payload.rank,
                flip_watch_score: payload.flip_watch_score,
                flip_watch_reasons: payload.flip_watch_reasons,
                sl: payload.sl,
                tp: payload.tp,
                tp_levels: payload.tp_levels,
                rr: payload.rr,
                phase_pct: payload.phase_pct,
                completion: payload.completion,
              });

              await kvPutText(KV, prevFlipWatchKey, "true", 7 * 24 * 60 * 60);
            } else if (!nowFlipWatch && prevFlipWatch === "true") {
              await kvPutText(KV, prevFlipWatchKey, "false", 7 * 24 * 60 * 60);
            }

            // Track state change to aligned
            if (enteredAligned) {
              if (!actionableOnly) {
                await appendActivity(KV, {
                  type: "state_aligned",
                  ticker: ticker,
                  side: alignedLong ? "LONG" : "SHORT",
                  price: payload.price,
                  state: payload.state,
                  rank: payload.rank,
                  sl: payload.sl,
                  tp: payload.tp,
                  tp_levels: payload.tp_levels,
                  rr: payload.rr,
                  phase_pct: payload.phase_pct,
                  completion: payload.completion,
                });
              }
            }

            // Track Momentum Elite status change
            const currentMomentumElite = !!(
              payload.flags && payload.flags.momentum_elite
            );
            if (currentMomentumElite && prevMomentumElite !== "true") {
              if (!actionableOnly) {
                await appendActivity(KV, {
                  type: "momentum_elite",
                  ticker: ticker,
                  price: payload.price,
                  state: payload.state,
                  rank: payload.rank,
                  sl: payload.sl,
                  tp: payload.tp,
                  tp_levels: payload.tp_levels,
                  rr: payload.rr,
                  phase_pct: payload.phase_pct,
                  completion: payload.completion,
                });
              }
              await kvPutText(
                KV,
                prevMomentumEliteKey,
                "true",
                7 * 24 * 60 * 60,
              );
            } else if (!currentMomentumElite && prevMomentumElite === "true") {
              await kvPutText(
                KV,
                prevMomentumEliteKey,
                "false",
                7 * 24 * 60 * 60,
              );
            }
          } catch (activityErr) {
            console.error(
              `[ACTIVITY ERROR] Failed to track activity for ${ticker}:`,
              {
                error: String(activityErr),
                message: activityErr.message,
                stack: activityErr.stack,
              },
            );
            // Don't throw - continue with ingestion even if activity tracking fails
          }

          // Add ingestion timestamp to payload for per-ticker tracking
          const now = Date.now();
          payload.ingest_ts = now; // Timestamp when this data was ingested
          payload.ingest_time = new Date(now).toISOString(); // Human-readable format

          // Attach ML v1 score so UI can display model fields immediately.
          try {
            await mlV1AttachToPayload(KV, payload);
          } catch (e) {
            console.warn(
              `[ML V1] attach failed for ${ticker}:`,
              String(e?.message || e),
            );
          }

          if (ticker === "ETHT") {
            console.log(`[ETHT DEBUG] About to get previous data and store`);
          }

          // Get previous data BEFORE storing new data (for trade simulation comparison)
          const prevLatest = await kvGetJSON(KV, `timed:latest:${ticker}`);

          // ─────────────────────────────────────────────────────────────
          // Daily change support (watchlist-style)
          // We persist a "yesterday close" per ticker in KV and compute day_change/day_change_pct.
          // ─────────────────────────────────────────────────────────────
          try {
            const curTs = Number(payload.ts ?? now);
            const curDay = nyTradingDayKey(curTs);
            const price = Number(payload.price);

            let prevClose = null;
            const prevCloseKey = `timed:prev_close:${ticker}`;
            const storedPrev = await kvGetJSON(KV, prevCloseKey);
            if (
              storedPrev &&
              storedPrev.day &&
              storedPrev.day !== curDay &&
              Number.isFinite(Number(storedPrev.close)) &&
              Number(storedPrev.close) > 0
            ) {
              prevClose = Number(storedPrev.close);
            }

            // If no stored prev close, derive it on day-boundary from the last stored tick
            if (!Number.isFinite(prevClose) && prevLatest) {
              const prevTs = Number(
                prevLatest.ts ?? prevLatest.ingest_ts ?? prevLatest.ingest_time,
              );
              const prevDay = nyTradingDayKey(prevTs);
              const prevPrice = Number(prevLatest.price);
              if (
                curDay &&
                prevDay &&
                prevDay !== curDay &&
                Number.isFinite(prevPrice) &&
                prevPrice > 0
              ) {
                prevClose = prevPrice;
                // Store for up to ~2 weeks
                await kvPutJSON(
                  KV,
                  prevCloseKey,
                  { day: prevDay, close: prevPrice },
                  14 * 24 * 60 * 60,
                );
              }
            }

            if (
              Number.isFinite(price) &&
              price > 0 &&
              Number.isFinite(prevClose) &&
              prevClose > 0
            ) {
              payload.prev_close = prevClose;
              payload.day_change = price - prevClose;
              payload.day_change_pct = ((price - prevClose) / prevClose) * 100;
            }
          } catch (e) {
            console.warn(
              `[DAILY CHANGE] Failed to compute daily change for ${ticker}:`,
              String(e?.message || e),
            );
          }

          if (ticker === "ETHT") {
            console.log(
              `[ETHT DEBUG] Previous data retrieved, about to store latest`,
            );
          }

          // Attach ML score (v1) so UI can display model output immediately.
          // This is lightweight and does not require D1.
          try {
            await mlV1AttachToPayload(KV, payload);
          } catch (e) {
            console.warn(`[ML_V1] attach failed for ${ticker}:`, String(e));
          }

          // Store latest (do this BEFORE alert so UI has it)
          await kvPutJSON(KV, `timed:latest:${ticker}`, payload);

          // Enqueue for ML training (4h and 1d horizons)
          try {
            await d1EnqueueMlV1(env, ticker, payload, [4 * 60 * 60 * 1000, 24 * 60 * 60 * 1000]);
          } catch (e) {
            console.error(`[ML ENQUEUE] Failed for ${ticker}:`, String(e));
          }

          // Upsert latest snapshot to D1 for fast UI reads (best-effort)
          try {
            ctx.waitUntil(d1UpsertTickerLatest(env, ticker, payload));
            ctx.waitUntil(d1UpsertTickerIndex(env, ticker, payload?.ts));
          } catch {
            // ignore
          }

          if (ticker === "ETHT") {
            console.log(`[ETHT DEBUG] Successfully stored latest data`);
          }

          // Store version-specific snapshot for historical access
          const snapshotVersion = payload.script_version || "unknown";
          if (snapshotVersion !== "unknown") {
            await kvPutJSON(
              KV,
              `timed:snapshot:${ticker}:${snapshotVersion}`,
              payload,
            );
            // Also store timestamp of when this version was last seen
            await kvPutText(
              KV,
              `timed:version:${ticker}:${snapshotVersion}:last_seen`,
              String(payload.ts || Date.now()),
            );
          }

          console.log(
            `[INGEST STORED] ${ticker} - latest data saved at ${new Date(
              now,
            ).toISOString()}`,
          );

          // CRITICAL: Ensure ticker is in index IMMEDIATELY after storage
          // This ensures ticker appears on dashboard even if request is canceled later
          await ensureTickerIndex(KV, ticker);
          if (ticker === "ETHT") {
            console.log(`[ETHT DEBUG] Indexing completed`);
          }

          // CRITICAL: Trade simulation runs BEFORE alert evaluation
          // If a trade is entered, we suppress the alert for this ticker.
          // Wrap in try-catch to prevent trade simulation errors from breaking ingestion
          try {
            // Pre-check: Calculate entry RR first to avoid unnecessary processing
            // Use trigger_price if available, otherwise use current price
            const entryPriceForCheck = payload.trigger_price
              ? Number(payload.trigger_price)
              : payload.price
                ? Number(payload.price)
                : null;

            if (entryPriceForCheck && entryPriceForCheck > 0) {
              const entryRRForCheck = computeRRAtTrigger(payload);
              const payloadWithEntryRR = {
                ...payload,
                rr: entryRRForCheck || payload.rr || 0,
              };

              // Only proceed if initial check passes
              if (
                shouldTriggerTradeSimulation(
                  ticker,
                  payloadWithEntryRR,
                  prevLatest,
                )
              ) {
                await processTradeSimulation(
                  KV,
                  ticker,
                  payload,
                  prevLatest,
                  env,
                );
              } else {
                console.log(
                  `[TRADE SIM] ${ticker}: Pre-check failed - entryRR=${
                    entryRRForCheck?.toFixed(2) || "null"
                  }, rank=${payload.rank || 0}, state=${payload.state || "N/A"}`,
                );
              }
            } else {
              console.log(
                `[TRADE SIM] ${ticker}: Skipping - no valid entry price (trigger_price=${payload.trigger_price}, price=${payload.price})`,
              );
            }
          } catch (tradeSimErr) {
            console.error(
              `[TRADE SIM ERROR] Failed to process trade simulation for ${ticker}:`,
              {
                error: String(tradeSimErr),
                message: tradeSimErr.message,
                stack: tradeSimErr.stack,
              },
            );
            // Don't throw - continue with ingestion even if trade simulation fails
          }

          // CRITICAL: Alert evaluation runs after trade simulation
          // Alert evaluation uses corridor state variables loaded above (prevInCorridor, etc.)
          // Wrap in try-catch to prevent alert errors from breaking ingestion
          try {
            // Threshold gates (with Momentum Elite adjustments)
            const momentumElite = !!flags.momentum_elite;

            // Momentum Elite gets relaxed thresholds (higher quality stocks)
            const baseMinRR = Number(env.ALERT_MIN_RR || "1.5");
            const baseMaxComp = Number(env.ALERT_MAX_COMPLETION || "0.4");
            const baseMaxPhase = Number(env.ALERT_MAX_PHASE || "0.6");
            // Adjust thresholds for Momentum Elite (more lenient for quality stocks)
            const minRR = momentumElite
              ? Math.max(1.2, baseMinRR * 0.9)
              : baseMinRR; // Lower RR requirement
            const maxComp = momentumElite
              ? Math.min(0.5, baseMaxComp * 1.25)
              : baseMaxComp; // Allow higher completion
            const maxPhase = momentumElite
              ? Math.min(0.7, baseMaxPhase * 1.17)
              : baseMaxPhase; // Allow higher phase

            // Use current price for dynamic RR calculation (real-time risk/reward)
            // This shows the current R:R based on where price is now, not where it was at trigger
            // This is more accurate for alerts as it reflects the actual current opportunity
            const currentRR = computeRR(payload);
            const rrToUse =
              currentRR != null
                ? currentRR
                : payload.rr != null
                  ? Number(payload.rr)
                  : 0;
            const rrOk = rrToUse >= minRR;
            const compOk =
              payload.completion == null
                ? true
                : Number(payload.completion) <= maxComp;
            const phaseOk =
              payload.phase_pct == null
                ? true
                : Number(payload.phase_pct) <= maxPhase;

            // Also consider Momentum Elite as a trigger condition (quality signal)
            // Momentum Elite can trigger even if not fully aligned, as long as in corridor
            const momentumEliteTrigger =
              momentumElite && inCorridor && (corridorAlignedOK || sqRel);

            // Enhanced trigger: original conditions OR Momentum Elite in good setup
            const enhancedTrigger = shouldConsiderAlert || momentumEliteTrigger;

            // Debug logging for alert conditions - log all tickers in corridor or entering corridor
            if (inCorridor || enteredCorridor) {
              console.log(`[ALERT DEBUG] ${ticker}:`, {
                inCorridor,
                enteredCorridor,
                prevInCorridor,
                corridorAlignedOK,
                side,
                state: payload.state,
                enteredAligned,
                trigOk,
                trigReason,
                sqRel,
                shouldConsiderAlert,
                momentumEliteTrigger,
                enhancedTrigger,
                rrOk,
                rr: rrToUse,
                rrFromPayload: payload.rr,
                calculatedAtCurrentPrice: currentRR,
                minRR,
                compOk,
                completion: payload.completion,
                maxComp,
                phaseOk,
                phase: payload.phase_pct,
                maxPhase,
                momentumElite,
                flags: payload.flags,
              });
            }

            // Log alert evaluation summary
            console.log(`[ALERT EVAL] ${ticker}:`, {
              enhancedTrigger,
              rrOk,
              rr: rrToUse,
              rrFromPayload: payload.rr,
              calculatedAtCurrentPrice: currentRR,
              compOk,
              completion: payload.completion,
              phaseOk,
              phase: payload.phase_pct,
              allConditionsMet: enhancedTrigger && rrOk && compOk && phaseOk,
            });

            // Enhanced logging for alert conditions - log what's blocking alerts
            if (inCorridor && !(enhancedTrigger && rrOk && compOk && phaseOk)) {
              const blockers = [];
              if (!enhancedTrigger) blockers.push("trigger conditions");
              if (!rrOk)
                blockers.push(
                  `RR (${
                    rrToUse?.toFixed(2) || "null"
                  } < ${minRR}, payload.rr=${
                    payload.rr?.toFixed(2) || "null"
                  }, currentRR=${currentRR?.toFixed(2) || "null"})`,
                );
              if (!compOk)
                blockers.push(
                  `Completion (${
                    payload.completion?.toFixed(2) || "null"
                  } > ${maxComp})`,
                );
              if (!phaseOk)
                blockers.push(
                  `Phase (${
                    payload.phase_pct?.toFixed(2) || "null"
                  } > ${maxPhase})`,
                );

              console.log(
                `[ALERT BLOCKED] ${ticker}: Alert blocked by: ${blockers.join(
                  ", ",
                )}`,
              );
            }

            // Trade simulation already processed above (before alert logic)

            // Check Discord configuration before evaluating conditions
            const discordEnable = env.DISCORD_ENABLE || "false";
            const discordWebhook = env.DISCORD_WEBHOOK_URL;
            const discordConfigured =
              discordEnable === "true" && !!discordWebhook;

            if (!discordConfigured && (inCorridor || enteredCorridor)) {
              console.log(
                `[DISCORD CONFIG] ${ticker}: Discord not configured`,
                {
                  DISCORD_ENABLE: discordEnable,
                  hasWebhook: !!discordWebhook,
                  inCorridor,
                  enteredCorridor,
                },
              );
            }

            const tradeSide = side || getTradeDirection(payload.state);
            const openTrade = tradeSide
              ? await findOpenTradeForTicker(KV, ticker, tradeSide)
              : await findOpenTradeForTicker(KV, ticker, null);
            if (openTrade) {
              console.log(
                `[ALERT SKIPPED] ${ticker}: Trade already open (${
                  openTrade.direction || "UNKNOWN"
                })`,
              );
            } else if (enhancedTrigger && rrOk && compOk && phaseOk) {
              // Smart dedupe: action + direction + UTC minute bucket (prevents duplicates but allows valid re-alerts)
              const action = "ENTRY";
              const alertEventTs = Number(
                payload.trigger_ts || payload.ts || Date.now(),
              );
              const dedupeInfo = buildAlertDedupeKey({
                ticker,
                action,
                side,
                ts: alertEventTs,
              });
              const akey = dedupeInfo.key;
              const today =
                dedupeInfo.day || new Date().toISOString().split("T")[0];
              const alreadyAlerted = akey ? await KV.get(akey) : null;

              console.log(`[ALERT CHECK] ${ticker}:`, {
                enhancedTrigger,
                rrOk,
                compOk,
                phaseOk,
                allConditionsMet: true,
                today,
                akey,
                dedupe_bucket: dedupeInfo.bucket,
                action,
                alreadyAlerted: !!alreadyAlerted,
                trigger_ts: payload.trigger_ts,
                ts: payload.ts,
              });

              if (!alreadyAlerted) {
                // Store deduplication key for 48 hours (covers edge cases around midnight)
                if (akey) {
                  await kvPutText(KV, akey, "1", 48 * 60 * 60);
                }

                console.log(`[DISCORD ALERT] Sending alert for ${ticker}`, {
                  akey,
                  today,
                  dedupe_bucket: dedupeInfo.bucket,
                  action,
                  side,
                  rank: payload.rank,
                  discordConfigured,
                  DISCORD_ENABLE: discordEnable,
                  hasWebhook: !!discordWebhook,
                });

                const alertTs = alertEventTs;
                const alertPayloadJson = (() => {
                  try {
                    return JSON.stringify(payload);
                  } catch {
                    return null;
                  }
                })();
                const alertMetaJson = (() => {
                  try {
                    return JSON.stringify({
                      akey,
                      today,
                      dedupe_bucket: dedupeInfo.bucket,
                      action,
                      alreadyAlerted: false,
                      side,
                      state: payload.state,
                      rank: payload.rank,
                      rr: rrToUse,
                      rrFromPayload: payload.rr,
                      calculatedAtCurrentPrice: currentRR,
                      thresholds: { minRR, maxComp, maxPhase },
                      checks: {
                        inCorridor,
                        enteredCorridor,
                        prevInCorridor,
                        corridorAlignedOK,
                        enteredAligned,
                        trigOk,
                        trigReason,
                        sqRel,
                        shouldConsiderAlert,
                        momentumEliteTrigger,
                        enhancedTrigger,
                        rrOk,
                        compOk,
                        phaseOk,
                      },
                      discordConfigured,
                    });
                  } catch {
                    return null;
                  }
                })();

                const why =
                  (side === "LONG"
                    ? "Entry corridor Q1→Q2"
                    : "Entry corridor Q4→Q3") +
                  (momentumElite ? " | 🚀 Momentum Elite" : "") +
                  (enteredAligned ? " | Entered aligned" : "") +
                  (trigReason
                    ? ` | ${trigReason}${
                        payload.trigger_dir
                          ? " (" + payload.trigger_dir + ")"
                          : ""
                      }`
                    : "") +
                  (sqRel ? " | ⚡ squeeze release" : "");

                const tv = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(
                  ticker,
                )}`;

                // Create Discord embed for trading opportunity
                // Calculate current R:R using current price (not trigger price)
                // This gives accurate R:R based on where price is now
                const currentRR = computeRR(payload);
                const rr = currentRR != null ? currentRR : payload.rr || 0;

                // Process TP levels with metadata
                const currentPrice = Number(payload.price) || 0;
                let tpLevels = [];
                let maxTP = Number(payload.tp);
                let minTP = Number(payload.tp);

                if (
                  payload.tp_levels &&
                  Array.isArray(payload.tp_levels) &&
                  payload.tp_levels.length > 0
                ) {
                  tpLevels = payload.tp_levels
                    .map((tpItem) => {
                      if (
                        typeof tpItem === "object" &&
                        tpItem !== null &&
                        tpItem.price != null
                      ) {
                        const price = Number(tpItem.price);
                        if (!Number.isFinite(price) || price <= 0) return null;
                        return {
                          price,
                          source: tpItem.source || "ATR Level",
                          type: tpItem.type || "ATR_FIB",
                          timeframe: tpItem.timeframe || "D",
                          confidence: Number(tpItem.confidence || 0.75),
                          multiplier: tpItem.multiplier
                            ? Number(tpItem.multiplier)
                            : null,
                          label: tpItem.label || "TP",
                        };
                      }
                      const price =
                        typeof tpItem === "number"
                          ? Number(tpItem)
                          : Number(tpItem);
                      if (!Number.isFinite(price) || price <= 0) return null;
                      return {
                        price,
                        source: "ATR Level",
                        type: "ATR_FIB",
                        timeframe: "D",
                        confidence: 0.75,
                        multiplier: null,
                        label: "TP",
                      };
                    })
                    .filter((tp) => tp !== null);

                  if (tpLevels.length > 0) {
                    const tpPrices = tpLevels.map((tp) => tp.price);
                    maxTP = Math.max(...tpPrices);
                    minTP = Math.min(...tpPrices);
                  }
                }

                // Add primary TP if not already in levels
                const primaryTP = Number(payload.tp);
                if (Number.isFinite(primaryTP) && primaryTP > 0) {
                  const exists = tpLevels.some(
                    (tp) => Math.abs(tp.price - primaryTP) < 0.01,
                  );
                  if (!exists) {
                    tpLevels.push({
                      price: primaryTP,
                      source: "Primary TP",
                      type: "ATR_FIB",
                      timeframe: "D",
                      confidence: 0.75,
                      multiplier: null,
                      label: "TP",
                    });
                  }
                }

                // Sort TP levels by price (ascending for LONG, descending for SHORT)
                const state = String(payload.state || "");
                const isLong = state.includes("BULL");
                tpLevels.sort((a, b) =>
                  isLong ? a.price - b.price : b.price - a.price,
                );

                const rrFormatted =
                  rr >= 1 ? `${rr.toFixed(2)}:1` : `1:${(1 / rr).toFixed(2)}`;

                // Calculate distance to TP and SL from current price
                const distanceToMaxTP =
                  maxTP > 0 ? Math.abs(maxTP - currentPrice) : 0;
                const distanceToSL =
                  Number(payload.sl) > 0
                    ? Math.abs(currentPrice - Number(payload.sl))
                    : 0;
                const maxTPDistancePct =
                  currentPrice > 0
                    ? ((distanceToMaxTP / currentPrice) * 100).toFixed(2)
                    : "0.00";
                const slDistancePct =
                  currentPrice > 0
                    ? ((distanceToSL / currentPrice) * 100).toFixed(2)
                    : "0.00";

                // Generate comprehensive trade opportunity interpretation
                const interpretation = generateTradeActionInterpretation(
                  "ENTRY",
                  payload,
                  {
                    direction: side,
                    rank: payload.rank,
                    rr: rr,
                  },
                );

                // Build comprehensive fields similar to Trade Entered card
                const fields = [];

                // Action & Reasoning (comprehensive explanation)
                if (interpretation) {
                  fields.push({
                    name: "📊 Why This Is A Trade Opportunity",
                    value: `${interpretation.action}\n\n${interpretation.reasons}`,
                    inline: false,
                  });
                } else {
                  // Fallback detailed explanation
                  const reasons = [];
                  if (inCorridor) reasons.push("✅ Price is in entry corridor");
                  if (corridorAlignedOK)
                    reasons.push("✅ Timeframes are aligned");
                  if (enhancedTrigger)
                    reasons.push("✅ Trigger conditions met");
                  if (momentumElite) reasons.push("⭐ Momentum Elite stock");
                  if (rr >= 1.5)
                    reasons.push(`💰 Excellent R:R (${rrFormatted})`);
                  if (payload.rank >= 75)
                    reasons.push(`⭐ High rank (${payload.rank})`);

                  fields.push({
                    name: "📊 Why This Is A Trade Opportunity",
                    value:
                      reasons.length > 0
                        ? reasons.join("\n")
                        : why || "Trade opportunity detected",
                    inline: false,
                  });
                }

                // Entry Details
                fields.push({
                  name: "💰 Entry Details",
                  value: `**Trigger Price:** $${fmt2(
                    payload.trigger_price,
                  )}\n**Current Price:** $${fmt2(
                    payload.price,
                  )}\n**Stop Loss:** $${fmt2(
                    payload.sl,
                  )} (${slDistancePct}% away)`,
                  inline: false,
                });

                // TP Levels with detailed breakdown
                if (tpLevels.length > 0) {
                  const tpLevelText = tpLevels
                    .map((tp) => {
                      const distance = Math.abs(tp.price - currentPrice);
                      const distancePct =
                        currentPrice > 0
                          ? ((distance / currentPrice) * 100).toFixed(2)
                          : "0.00";
                      const isMax = Math.abs(tp.price - maxTP) < 0.01;
                      const prefix = isMax ? "**⭐ MAX TP:**" : `**TP:**`;
                      const typeLabel =
                        tp.type === "STRUCTURE"
                          ? "Structure"
                          : tp.type === "ATR_FIB"
                            ? tp.multiplier
                              ? `ATR×${tp.multiplier}`
                              : "ATR Fib"
                            : tp.type;
                      const tfLabel =
                        tp.timeframe === "W"
                          ? "Weekly"
                          : tp.timeframe === "D"
                            ? "Daily"
                            : tp.timeframe === "240" || tp.timeframe === "4H"
                              ? "4H"
                              : tp.timeframe;
                      return `${prefix} $${tp.price.toFixed(
                        2,
                      )} (${distancePct}% away) - ${typeLabel} @ ${tfLabel} (${(
                        tp.confidence * 100
                      ).toFixed(0)}% conf)`;
                    })
                    .join("\n");

                  fields.push({
                    name: "🎯 Take Profit Levels",
                    value: tpLevelText,
                    inline: false,
                  });
                } else {
                  // Fallback if no TP levels
                  const distanceToTP =
                    primaryTP > 0 ? Math.abs(primaryTP - currentPrice) : 0;
                  const tpDistancePct =
                    currentPrice > 0
                      ? ((distanceToTP / currentPrice) * 100).toFixed(2)
                      : "0.00";
                  const tpVeryClose =
                    currentPrice > 0 && distanceToTP / currentPrice < 0.005;
                  const tpWarning = tpVeryClose ? " ⚠️ Very close!" : "";

                  fields.push({
                    name: "🎯 Take Profit",
                    value: `**Primary TP:** $${fmt2(
                      primaryTP,
                    )} (${tpDistancePct}% away)${tpWarning}`,
                    inline: false,
                  });
                }

                // Scores & Metrics
                const htfScore = Number(payload.htf_score || 0);
                const ltfScore = Number(payload.ltf_score || 0);
                const completion = Number(payload.completion || 0);
                const phase = Number(payload.phase_pct || 0);

                fields.push({
                  name: "📈 Scores & Metrics",
                  value: `**HTF Score:** ${htfScore.toFixed(
                    2,
                  )}\n**LTF Score:** ${ltfScore.toFixed(2)}\n**Completion:** ${(
                    completion * 100
                  ).toFixed(1)}%\n**Phase:** ${(phase * 100).toFixed(1)}%`,
                  inline: true,
                });

                // Quality Metrics
                fields.push({
                  name: "⭐ Quality Metrics",
                  value: `**Rank:** ${
                    payload.rank
                  }\n**Risk/Reward:** ${rrFormatted}${
                    currentRR != null && currentRR !== payload.rr ? " ⚠️" : ""
                  }\n**State:** ${payload.state || "N/A"}\n**ETA:** ${
                    payload.eta_days != null
                      ? `${Number(payload.eta_days).toFixed(1)}d`
                      : "—"
                  }`,
                  inline: true,
                });

                // Active Signals
                if (payload.flags) {
                  const flags = payload.flags;
                  const flagItems = [];
                  if (flags.sq30_release) flagItems.push("🚀 Squeeze Release");
                  if (flags.sq30_on && !flags.sq30_release)
                    flagItems.push("💥 In Squeeze");
                  if (flags.momentum_elite) flagItems.push("⭐ Momentum Elite");
                  if (flags.phase_dot) flagItems.push("⚫ Phase Dot");
                  if (flags.phase_zone_change)
                    flagItems.push("🔄 Phase Zone Change");

                  if (flagItems.length > 0) {
                    fields.push({
                      name: "🚩 Active Signals",
                      value: flagItems.join("\n"),
                      inline: false,
                    });
                  }
                }

                // TD Sequential if available
                if (payload.td_sequential) {
                  const tdSeq = payload.td_sequential;
                  const tdItems = [];
                  if (tdSeq.td9_bullish) tdItems.push("🔢 TD9 Bullish");
                  if (tdSeq.td9_bearish) tdItems.push("🔢 TD9 Bearish");
                  if (tdSeq.td13_bullish) tdItems.push("🔢 TD13 Bullish");
                  if (tdSeq.td13_bearish) tdItems.push("🔢 TD13 Bearish");

                  if (tdItems.length > 0) {
                    fields.push({
                      name: "🔢 TD Sequential",
                      value:
                        tdItems.join("\n") +
                        (tdSeq.boost
                          ? `\n**Boost:** ${Number(tdSeq.boost).toFixed(1)}`
                          : ""),
                      inline: false,
                    });
                  }
                }

                // RSI if available
                if (payload.rsi) {
                  const rsi = payload.rsi;
                  const rsiValue = Number(rsi.value || 0);
                  const rsiLevel = rsi.level || "neutral";
                  const divergence = rsi.divergence || {};

                  let rsiText = `**RSI:** ${rsiValue.toFixed(2)} (${rsiLevel})`;
                  if (divergence.type && divergence.type !== "none") {
                    rsiText += `\n**Divergence:** ${
                      divergence.type === "bullish"
                        ? "🔼 Bullish"
                        : "🔽 Bearish"
                    }`;
                    if (divergence.strength) {
                      rsiText += ` (Strength: ${Number(
                        divergence.strength,
                      ).toFixed(2)})`;
                    }
                  }

                  fields.push({
                    name: "📊 RSI",
                    value: rsiText,
                    inline: false,
                  });
                }

                // EMA Cloud positions if available
                if (
                  payload.daily_ema_cloud ||
                  payload.fourh_ema_cloud ||
                  payload.oneh_ema_cloud
                ) {
                  const cloudItems = [];
                  if (payload.daily_ema_cloud) {
                    const daily = payload.daily_ema_cloud;
                    cloudItems.push(
                      `**Daily (5-8 EMA):** ${daily.position.toUpperCase()}`,
                    );
                  }
                  if (payload.fourh_ema_cloud) {
                    const fourH = payload.fourh_ema_cloud;
                    cloudItems.push(
                      `**4H (8-13 EMA):** ${fourH.position.toUpperCase()}`,
                    );
                  }
                  if (payload.oneh_ema_cloud) {
                    const oneH = payload.oneh_ema_cloud;
                    cloudItems.push(
                      `**1H (13-21 EMA):** ${oneH.position.toUpperCase()}`,
                    );
                  }

                  if (cloudItems.length > 0) {
                    fields.push({
                      name: "☁️ EMA Cloud Positions",
                      value: cloudItems.join("\n"),
                      inline: false,
                    });
                  }
                }

                const allowDiscord = shouldSendDiscordAlert(
                  env,
                  "ALERT_ENTRY",
                  {
                    ticker,
                    side,
                    rank: payload.rank,
                    rr: rrToUse,
                    momentumElite,
                  },
                );

                const opportunityEmbed = {
                  title: `🎯 Trading Opportunity: ${ticker} ${side}`,
                  color: side === "LONG" ? 0x00ff00 : 0xff0000, // Green for LONG, Red for SHORT
                  fields: fields,
                  timestamp: new Date().toISOString(),
                  footer: {
                    text: "Timed Trading Alert",
                  },
                  url: tv, // Make the title clickable to open TradingView
                };

                const sendRes = allowDiscord
                  ? await notifyDiscord(env, opportunityEmbed)
                  : {
                      ok: false,
                      skipped: true,
                      reason: "suppressed_critical_only",
                    };

                // Persist alert ledger record to D1 (best-effort)
                d1UpsertAlert(env, {
                  ticker,
                  ts: alertTs,
                  side,
                  state: payload.state,
                  rank: payload.rank,
                  rr_at_alert: rrToUse,
                  trigger_reason: trigReason,
                  dedupe_day: today,
                  discord_sent: !!sendRes?.ok,
                  discord_status: sendRes?.status ?? null,
                  discord_error: sendRes?.ok
                    ? null
                    : sendRes?.reason ||
                      sendRes?.statusText ||
                      sendRes?.error ||
                      "discord_send_failed",
                  payload_json: alertPayloadJson,
                  meta_json: alertMetaJson,
                }).catch((e) => {
                  console.error(
                    `[D1 LEDGER] Failed to upsert alert ${ticker}:`,
                    e,
                  );
                });

                // Log Discord alert to activity feed
                if (sendRes?.ok) {
                  await appendActivity(KV, {
                    ticker,
                    type: "discord_alert",
                    direction: side,
                    action: "entry",
                    rank: payload.rank,
                    rr: payload.rr,
                    price: payload.price,
                    trigger_price: payload.trigger_price,
                    sl: payload.sl,
                    tp: payload.tp,
                    state: payload.state,
                    htf_score: payload.htf_score,
                    ltf_score: payload.ltf_score,
                    completion: payload.completion,
                    phase_pct: payload.phase_pct,
                    why: why,
                    momentum_elite: momentumElite,
                  });
                }
              } else {
                console.log(
                  `[DISCORD ALERT] Skipped ${ticker} - already alerted`,
                  {
                    akey,
                    today,
                    dedupe_bucket: dedupeInfo.bucket,
                    action,
                  },
                );

                // Persist deduped alert decision to D1 (best-effort)
                const alertTs = alertEventTs;
                const alertPayloadJson = (() => {
                  try {
                    return JSON.stringify(payload);
                  } catch {
                    return null;
                  }
                })();
                const alertMetaJson = (() => {
                  try {
                    return JSON.stringify({
                      akey,
                      today,
                      dedupe_bucket: dedupeInfo.bucket,
                      action,
                      alreadyAlerted: true,
                      side,
                      state: payload.state,
                      rank: payload.rank,
                      rr: rrToUse,
                      rrFromPayload: payload.rr,
                      calculatedAtCurrentPrice: currentRR,
                      thresholds: { minRR, maxComp, maxPhase },
                      checks: {
                        inCorridor,
                        enteredCorridor,
                        prevInCorridor,
                        corridorAlignedOK,
                        enteredAligned,
                        trigOk,
                        trigReason,
                        sqRel,
                        shouldConsiderAlert,
                        momentumEliteTrigger,
                        enhancedTrigger,
                        rrOk,
                        compOk,
                        phaseOk,
                      },
                      discordConfigured,
                    });
                  } catch {
                    return null;
                  }
                })();
                d1UpsertAlert(env, {
                  ticker,
                  ts: alertTs,
                  side,
                  state: payload.state,
                  rank: payload.rank,
                  rr_at_alert: rrToUse,
                  trigger_reason: trigReason,
                  dedupe_day: today,
                  discord_sent: false,
                  discord_status: null,
                  discord_error: "deduped_already_alerted",
                  payload_json: alertPayloadJson,
                  meta_json: alertMetaJson,
                }).catch((e) => {
                  console.error(
                    `[D1 LEDGER] Failed to upsert deduped alert ${ticker}:`,
                    e,
                  );
                });
              }
            } else if (inCorridor && corridorAlignedOK) {
              // Log why alert didn't fire
              const reasons = [];
              if (!enhancedTrigger) reasons.push("no trigger condition");
              if (!rrOk)
                reasons.push(
                  `RR ${rrToUse?.toFixed(2) || "null"} < ${minRR} (payload.rr=${
                    payload.rr?.toFixed(2) || "null"
                  })`,
                );
              if (!compOk)
                reasons.push(`Completion ${payload.completion} > ${maxComp}`);
              if (!phaseOk)
                reasons.push(`Phase ${payload.phase_pct} > ${maxPhase}`);
              console.log(`[ALERT SKIPPED] ${ticker}: ${reasons.join(", ")}`);
            }

            // Check for TD9 entry signals (potential reversal setups)
            const tdSeq = payload.td_sequential || {};
            const td9Bullish =
              tdSeq.td9_bullish === true || tdSeq.td9_bullish === "true";
            const td9Bearish =
              tdSeq.td9_bearish === true || tdSeq.td9_bearish === "true";
            const td13Bullish =
              tdSeq.td13_bullish === true || tdSeq.td13_bullish === "true";
            const td13Bearish =
              tdSeq.td13_bearish === true || tdSeq.td13_bearish === "true";

            // TD9 entry signal: TD9/TD13 bullish suggests LONG, TD9/TD13 bearish suggests SHORT
            const hasTD9Signal =
              td9Bullish || td9Bearish || td13Bullish || td13Bearish;
            if (hasTD9Signal) {
              const suggestedDirection =
                td9Bullish || td13Bullish ? "LONG" : "SHORT";
              const signalType = td13Bullish || td13Bearish ? "TD13" : "TD9";

              // Check if TD9 signal aligns with corridor direction (potential entry)
              const td9AlignsWithCorridor =
                (suggestedDirection === "LONG" && side === "LONG") ||
                (suggestedDirection === "SHORT" && side === "SHORT");

              // Only alert if TD9 signal aligns with corridor and has reasonable RR
              if (td9AlignsWithCorridor && payload.rr >= 1.2) {
                const td9AlertKey = `timed:td9_alerted:${ticker}:${signalType}:${suggestedDirection}`;
                const alreadyTD9Alerted = await KV.get(td9AlertKey);

                if (!alreadyTD9Alerted) {
                  await kvPutText(KV, td9AlertKey, "1", 24 * 60 * 60); // 24h dedup

                  // Add activity feed event
                  await appendActivity(KV, {
                    ticker,
                    type: "td9_entry",
                    direction: suggestedDirection,
                    signalType,
                    price: payload.price,
                    sl: payload.sl,
                    tp: payload.tp,
                    rr: payload.rr,
                    rank: payload.rank,
                    td9_bullish: td9Bullish,
                    td9_bearish: td9Bearish,
                    td13_bullish: td13Bullish,
                    td13_bearish: td13Bearish,
                  });

                  // Send Discord alert (suppressed in critical-only mode)
                  if (
                    shouldSendDiscordAlert(env, "TD9_ENTRY", {
                      ticker,
                      direction: suggestedDirection,
                      rr: payload.rr,
                      rank: payload.rank,
                    })
                  ) {
                    const td9Embed = createTD9EntryEmbed(
                      ticker,
                      suggestedDirection,
                      payload.price,
                      payload.sl,
                      payload.tp,
                      payload.rr,
                      payload.rank,
                      tdSeq,
                      payload, // Pass full payload as tickerData
                    );
                    await notifyDiscord(env, td9Embed).catch(() => {});
                  }

                  console.log(
                    `[TD9 ENTRY ALERT] ${ticker} ${suggestedDirection} - ${signalType} signal`,
                  );
                }
              }
            }
          } catch (alertErr) {
            console.error(
              `[ALERT ERROR] Failed to process alert evaluation for ${ticker}:`,
              {
                error: String(alertErr),
                message: alertErr.message,
                stack: alertErr.stack,
              },
            );
            // Don't throw - continue with ingestion even if alert evaluation fails
          }

          // Store version-specific snapshot for historical access
          const version = payload.script_version || "unknown";
          if (version !== "unknown") {
            await kvPutJSON(KV, `timed:snapshot:${ticker}:${version}`, payload);
            // Also store timestamp of when this version was last seen
            await kvPutText(
              KV,
              `timed:version:${ticker}:${version}:last_seen`,
              String(payload.ts || Date.now()),
            );
          }

          await ensureTickerIndex(KV, ticker);
          await kvPutText(KV, "timed:last_ingest_ms", String(Date.now()));

          // Get current ticker count for logging
          const currentTickers = (await kvGetJSON(KV, "timed:tickers")) || [];
          const wasNewTicker = !currentTickers.includes(ticker);
          console.log(
            `[INGEST COMPLETE] ${ticker} - ${
              wasNewTicker ? "NEW TICKER ADDED" : "updated existing"
            } - Total tickers in index: ${currentTickers.length} - Version: ${
              payload.script_version || "unknown"
            }`,
          );

          // Log all tickers in index if count is low (to debug missing tickers)
          if (currentTickers.length < 130) {
            console.log(
              `[INGEST INDEX DEBUG] Current tickers (${currentTickers.length}):`,
              currentTickers.slice(0, 30).join(", "),
              currentTickers.length > 30
                ? `... (showing first 30 of ${currentTickers.length})`
                : "",
            );
          }

          // Get final ticker count
          const finalTickers = (await kvGetJSON(KV, "timed:tickers")) || [];
          console.log(
            `[INGEST SUCCESS] ${ticker} - completed successfully. Total tickers: ${finalTickers.length}`,
          );
          return ackJSON(
            env,
            { ok: true, ticker, totalTickers: finalTickers.length },
            200,
            req,
          );
        } catch (error) {
          // Catch any unexpected errors during ingestion
          const ip = req.headers.get("CF-Connecting-IP") || "unknown";
          const ticker = normTicker(body?.ticker) || "UNKNOWN";
          console.error(`[INGEST ERROR] ${ticker} - IP: ${ip}`, {
            error: String(error),
            stack: error.stack,
            message: error.message,
            body: body ? { ticker: body.ticker, ts: body.ts } : null,
          });
          // Return 500 instead of 429 to avoid confusion
          return ackJSON(
            env,
            {
              ok: false,
              error: "internal_error",
              message: "An error occurred during ingestion",
              ticker: ticker !== "UNKNOWN" ? ticker : null,
            },
            500,
            req,
          );
        }
      }

      // POST /timed/ingest-capture (capture-only heartbeat)
      if (url.pathname === "/timed/ingest-capture" && req.method === "POST") {
        let body = null;
        try {
          const ip = req.headers.get("CF-Connecting-IP") || "unknown";
          console.log(
            `[CAPTURE INGEST RECEIVED] IP: ${ip}, User-Agent: ${
              req.headers.get("User-Agent") || "none"
            }`,
          );

          const authFail = requireKeyOr401(req, env);
          if (authFail) return authFail;

          const { obj: bodyData, raw, err } = await readBodyAsJSON(req);
          body = bodyData;
          if (!body) {
            return ackJSON(
              env,
              {
                ok: false,
                error: "bad_json",
                sample: String(raw || "").slice(0, 200),
                parseError: String(err || ""),
              },
              400,
              req,
            );
          }

          const v = validateCapturePayload(body);
          if (!v.ok) return ackJSON(env, v, 400, req);

          const ticker = v.ticker;
          const payload = v.payload;
          const rawPayload =
            typeof raw === "string"
              ? raw
              : (() => {
                  try {
                    return JSON.stringify(body);
                  } catch {
                    return "";
                  }
                })();

          // Store raw capture payload separately for audit
          try {
            if (rawPayload) {
              await kvPutText(
                KV,
                `timed:capture:raw:${ticker}`,
                rawPayload,
                2 * 24 * 60 * 60,
              );
            }
          } catch (rawErr) {
            console.error(
              `[CAPTURE RAW] KV store failed for ${ticker}:`,
              rawErr,
            );
          }

          d1InsertIngestReceipt(env, ticker, payload, rawPayload).catch(
            (err) => {
              console.error(
                `[D1 CAPTURE] Receipt insert exception for ${ticker}:`,
                err,
              );
            },
          );

          const now = Date.now();
          payload.ingest_ts = now;
          payload.ingest_time = new Date(now).toISOString();

          // Compute Momentum Elite for capture payload too (display-only enrichment).
          // This lets the UI show 🚀 + criteria even if the ticker's scoring feed is separate.
          try {
            payload.flags =
              payload.flags && typeof payload.flags === "object"
                ? payload.flags
                : {};
            const m = await computeMomentumElite(KV, ticker, payload);
            if (m) {
              payload.flags.momentum_elite = !!m.momentum_elite;
              payload.momentum_elite_criteria = m.criteria;
            }
          } catch (e) {
            console.error(
              `[CAPTURE MOMENTUM] Failed for ${ticker}:`,
              String(e),
            );
          }

          // Persist context separately so it survives bars where context is omitted.
          // The capture heartbeat throttles context and otherwise sends a minimal payload;
          // without this, `timed:capture:latest:*` gets overwritten and context disappears.
          try {
            if (payload.context && typeof payload.context === "object") {
              // Avoid downgrading richer context (e.g. keep name/description if a later payload omits them).
              const incoming = sanitizeTickerContext(payload.context, payload);
              const saved = await kvGetJSON(KV, `timed:context:${ticker}`);
              const merged = mergeTickerContext(saved, incoming);
              await kvPutJSON(
                KV,
                `timed:context:${ticker}`,
                merged || incoming || payload.context,
                30 * 24 * 60 * 60,
              );
            }
          } catch (e) {
            console.error(
              `[CAPTURE CONTEXT] KV store failed for ${ticker}:`,
              String(e),
            );
          }

          await kvPutJSON(KV, `timed:capture:latest:${ticker}`, payload);
          // Best-effort: persist the heartbeat daily-change fields into D1 ticker_latest so /timed/all stays KV-free.
          try {
            ctx.waitUntil(
              d1PatchTickerLatestFields(env, ticker, {
                prev_close: payload.prev_close,
                day_change: payload.day_change,
                day_change_pct: payload.day_change_pct,
                change: payload.change,
                change_pct: payload.change_pct,
                session: payload.session,
                is_rth: payload.is_rth,
              }),
            );
          } catch {
            // ignore
          }
          await appendCaptureTrail(KV, ticker, {
            ts: payload.ts,
            price: payload.price,
            bar_index: payload.bar_index,
            time_close: payload.time_close,
          });
          await ensureCaptureIndex(KV, ticker);

          await kvPutText(KV, "timed:capture:last_ingest_ms", String(now));

          // If payload includes tf_candles, upsert them to D1 (heartbeat can now send both capture + candles).
          if (payload.tf_candles && typeof payload.tf_candles === "object") {
            try {
              await d1EnsureCandleSchema(env);
              for (const [tf, candle] of Object.entries(payload.tf_candles)) {
                if (candle && typeof candle === "object") {
                  ctx.waitUntil(d1UpsertCandle(env, ticker, tf, candle));
                }
              }
            } catch (candleErr) {
              console.error(
                `[CAPTURE CANDLES] Upsert failed for ${ticker}:`,
                String(candleErr),
              );
            }
          }

          // Promote capture payload into main latest/trail when it contains full score fields.
          // This fixes the “stale latest despite fresh receipts” issue when some alerts are wired to /ingest-capture.
          try {
            const hasScores =
              isNum(payload?.htf_score) &&
              isNum(payload?.ltf_score) &&
              isNum(payload?.ts);
            if (hasScores) {
              // Ensure RR is present (used widely by UI/alerts)
              if (!isNum(payload?.rr)) {
                try {
                  payload.rr = computeRR(payload);
                } catch {
                  // ignore
                }
              }

              // Store latest and trail (KV) and write to D1 trail, but do NOT run alert/discord logic here.
              // Ensure kanban_stage is always computed even on capture-promote path
              try {
                const existing = await kvGetJSON(KV, `timed:latest:${ticker}`);
                // CRITICAL: Merge entry_ts/entry_price from existing so HOLD (not Watch) when move passed
                if (existing?.entry_ts != null || existing?.entry_price != null) {
                  if (payload.entry_ts == null && Number.isFinite(Number(existing?.entry_ts)))
                    payload.entry_ts = Number(existing.entry_ts);
                  if (payload.entry_price == null && Number.isFinite(Number(existing?.entry_price)))
                    payload.entry_price = Number(existing.entry_price);
                }
                if (existing?.kanban_cycle_enter_now_ts != null)
                  payload.kanban_cycle_enter_now_ts = existing.kanban_cycle_enter_now_ts;
                if (existing?.kanban_cycle_trigger_ts != null)
                  payload.kanban_cycle_trigger_ts = existing.kanban_cycle_trigger_ts;
                if (existing?.kanban_cycle_side != null)
                  payload.kanban_cycle_side = existing.kanban_cycle_side;
                const openTrade = await findOpenTradeForTicker(KV, ticker, null);
                if ((payload.entry_ts == null || payload.entry_price == null) && openTrade) {
                  const et = isoToMs(openTrade.entryTime) || Number(openTrade.entry_ts) || Number(openTrade.entryTs);
                  const ep = Number(openTrade.entryPrice ?? openTrade.entry_price);
                  if (payload.entry_ts == null && Number.isFinite(et)) payload.entry_ts = et;
                  if (payload.entry_price == null && Number.isFinite(ep) && ep > 0)
                    payload.entry_price = ep;
                }
                payload.move_status = computeMoveStatus(payload);
                if (payload.flags) {
                  payload.flags.move_invalidated = payload.move_status?.status === "INVALIDATED";
                  payload.flags.move_completed = payload.move_status?.status === "COMPLETED";
                }
                const stage = classifyKanbanStage(payload);
                const prevStage = existing?.kanban_stage;
                let finalStage = stage;

                // Lifecycle gate: HOLD/DEFEND/TRIM/EXIT must pass through ENTER_NOW first (per trigger+side cycle).
                try {
                  const mgmt =
                    finalStage === "hold" ||
                    finalStage === "just_entered" ||
                    finalStage === "trim" ||
                    finalStage === "exit";
                  if (mgmt) {
                    const curTriggerTs = Number(payload?.trigger_ts);
                    const curSide = sideFromStateOrScores(payload);
                    const cycleEnterTs = Number(
                      existing?.kanban_cycle_enter_now_ts,
                    );
                    const cycleTrig = Number(existing?.kanban_cycle_trigger_ts);
                    const cycleSide =
                      existing?.kanban_cycle_side != null
                        ? String(existing.kanban_cycle_side)
                        : null;
                    const sameTrig =
                      Number.isFinite(curTriggerTs) &&
                      curTriggerTs > 0 &&
                      Number.isFinite(cycleTrig) &&
                      cycleTrig > 0 &&
                      cycleTrig === curTriggerTs;
                    const cycleOk =
                      Number.isFinite(cycleEnterTs) &&
                      cycleEnterTs > 0 &&
                      sameTrig &&
                      !!cycleSide &&
                      !!curSide &&
                      cycleSide === curSide;

                    if (!Number.isFinite(curTriggerTs) || curTriggerTs <= 0) {
                      finalStage = "watch";
                      payload.flags =
                        payload.flags && typeof payload.flags === "object"
                          ? payload.flags
                          : {};
                      payload.flags.forced_watch_missing_trigger = true;
                    } else if (!cycleOk) {
                      finalStage = "enter_now";
                      payload.flags =
                        payload.flags && typeof payload.flags === "object"
                          ? payload.flags
                          : {};
                      payload.flags.forced_enter_now_gate = true;
                    }
                  }

                  const tsNow = Number(payload?.ts) || Date.now();
                  if (finalStage === "enter_now") {
                    const curTriggerTs = Number(payload?.trigger_ts);
                    const curSide = sideFromStateOrScores(payload);
                    payload.kanban_cycle_enter_now_ts = tsNow;
                    payload.kanban_cycle_trigger_ts =
                      Number.isFinite(curTriggerTs) && curTriggerTs > 0
                        ? curTriggerTs
                        : null;
                    payload.kanban_cycle_side =
                      curSide != null ? String(curSide) : null;
                  } else if (
                    finalStage === "hold" ||
                    finalStage === "just_entered" ||
                    finalStage === "trim" ||
                    finalStage === "exit"
                  ) {
                    payload.kanban_cycle_enter_now_ts =
                      existing?.kanban_cycle_enter_now_ts || null;
                    payload.kanban_cycle_trigger_ts =
                      existing?.kanban_cycle_trigger_ts || null;
                    payload.kanban_cycle_side =
                      existing?.kanban_cycle_side || null;
                  } else {
                    payload.kanban_cycle_enter_now_ts = null;
                    payload.kanban_cycle_trigger_ts = null;
                    payload.kanban_cycle_side = null;
                  }
                } catch (e) {
                  console.error(
                    `[KANBAN] capture-promote lifecycle gate failed for ${ticker}:`,
                    String(e),
                  );
                }

                payload.kanban_stage = finalStage;
                if (
                  prevStage != null &&
                  stage != null &&
                  String(prevStage) !== String(stage)
                ) {
                  payload.prev_kanban_stage = String(prevStage);
                  payload.prev_kanban_stage_ts =
                    Number(payload?.ts) || Date.now();
                } else if (existing?.prev_kanban_stage != null) {
                  payload.prev_kanban_stage = String(
                    existing.prev_kanban_stage,
                  );
                  payload.prev_kanban_stage_ts = Number.isFinite(
                    Number(existing?.prev_kanban_stage_ts),
                  )
                    ? Number(existing.prev_kanban_stage_ts)
                    : null;
                } else {
                  payload.prev_kanban_stage = null;
                  payload.prev_kanban_stage_ts = null;
                }

                // Discord notification for Enter Now and beyond (capture-promote path)
                const actionableStages = [
                  "enter_now",
                  "hold",
                  "just_entered",
                  "trim",
                  "exit",
                ];
                if (
                  prevStage != null &&
                  finalStage != null &&
                  String(prevStage) !== String(finalStage) &&
                  actionableStages.includes(finalStage)
                ) {
                  const alertType = `KANBAN_${finalStage.toUpperCase()}`;
                  const tsMs = Number(payload?.ts) || Date.now();
                  const dedupeBucket = Math.floor(tsMs / 900000);
                  const dedupeKey = `timed:discord:kanban:${ticker}:${finalStage}:${dedupeBucket}`;
                  ctx.waitUntil(
                    (async () => {
                      try {
                        const already = await KV.get(dedupeKey);
                        if (already) return;
                        await kvPutText(KV, dedupeKey, "1", 60 * 60);
                        if (!shouldSendDiscordAlert(env, alertType, { ticker }))
                          return;
                        const embed = createKanbanStageEmbed(
                          ticker,
                          finalStage,
                          prevStage,
                          payload,
                        );
                        await notifyDiscord(env, embed).catch((err) => {
                          console.error(
                            `[KANBAN DISCORD] ${ticker} ${finalStage}:`,
                            err,
                          );
                        });
                      } catch (e) {
                        console.error(
                          `[KANBAN DISCORD] ${ticker} ${finalStage}:`,
                          e,
                        );
                      }
                    })(),
                  );
                }

                if (stage === "enter_now" && prevStage !== "enter_now") {
                  const price = Number(payload?.price);
                  if (Number.isFinite(price) && price > 0) {
                    payload.entry_price = price;
                    payload.entry_ts = payload.ts;
                  }
                }
                if (stage && existing?.entry_price) {
                  payload.entry_price = existing.entry_price;
                  payload.entry_ts = existing.entry_ts;
                }
                if (payload.entry_price) {
                  const entryPrice = Number(payload.entry_price);
                  const currentPrice = Number(payload.price);
                  if (
                    Number.isFinite(entryPrice) &&
                    Number.isFinite(currentPrice) &&
                    entryPrice > 0
                  ) {
                    payload.entry_change_pct =
                      ((currentPrice - entryPrice) / entryPrice) * 100;
                  }
                }
              } catch (e) {
                console.error(
                  `[KANBAN] capture-promote stage compute failed for ${ticker}:`,
                  String(e),
                );
              }

              // Attach ML score (v1) so UI can display model output immediately.
              try {
                await mlV1AttachToPayload(KV, payload);
              } catch (e) {
                console.warn(
                  `[ML_V1] attach failed (capture-promote) for ${ticker}:`,
                  String(e),
                );
              }

              await kvPutJSON(KV, `timed:latest:${ticker}`, payload);

              // Upsert latest snapshot to D1 for fast UI reads (best-effort)
              try {
                ctx.waitUntil(d1UpsertTickerLatest(env, ticker, payload));
                ctx.waitUntil(d1UpsertTickerIndex(env, ticker, payload?.ts));
              } catch {
                // ignore
              }
              await appendTrail(
                KV,
                ticker,
                {
                  ts: payload.ts,
                  price: payload.price,
                  htf_score: payload.htf_score,
                  ltf_score: payload.ltf_score,
                  completion: payload.completion,
                  phase_pct: payload.phase_pct,
                  state: payload.state,
                  rank: payload.rank,
                  flags: payload.flags,
                  trigger_reason: payload.trigger_reason,
                  trigger_dir: payload.trigger_dir,
                },
                20,
              );
              d1InsertTrailPoint(env, ticker, payload).catch((e) => {
                console.error(
                  `[D1 CAPTURE→TRAIL] Insert failed for ${ticker}:`,
                  String(e),
                );
              });
              await ensureTickerIndex(KV, ticker);
              await kvPutText(KV, "timed:last_ingest_ms", String(now));
            }
          } catch (promoteErr) {
            console.error(
              `[CAPTURE PROMOTE] Failed for ${ticker}:`,
              String(promoteErr),
            );
          }

          return ackJSON(env, { ok: true, ticker, capture: true }, 200, req);
        } catch (err) {
          console.error(`[CAPTURE INGEST ERROR]`, err);
          return ackJSON(
            env,
            { ok: false, error: String(err?.message || err) },
            500,
            req,
          );
        }
      }

      // POST /timed/ingest-candles (multi-timeframe OHLCV)
      if (url.pathname === "/timed/ingest-candles" && req.method === "POST") {
        let body = null;
        try {
          const authFail = requireKeyOr401(req, env);
          if (authFail) return authFail;

          const { obj: bodyData, raw, err } = await readBodyAsJSON(req);
          body = bodyData;
          if (!body) {
            return ackJSON(
              env,
              {
                ok: false,
                error: "bad_json",
                sample: String(raw || "").slice(0, 200),
                parseError: String(err || ""),
              },
              400,
              req,
            );
          }

          const v = validateCandlesPayload(body);
          if (!v.ok) return ackJSON(env, v, 400, req);

          const ticker = v.ticker;
          const payload = v.payload;
          const tfCandles = payload?.tf_candles || {};

          // Check if bulk mode (tf_candles values are arrays of candles instead of single candles)
          const isBulk = Object.values(tfCandles).some((val) => Array.isArray(val));

          let okCount = 0;
          let errCount = 0;
          try {
            await d1EnsureCandleSchema(env);
          } catch {
            // ignore (d1UpsertCandle will surface errors)
          }

          if (isBulk) {
            // Bulk mode: each TF has an array of candles
            for (const [tf, candleArray] of Object.entries(tfCandles)) {
              if (!Array.isArray(candleArray)) continue;
              for (const candle of candleArray) {
                if (!candle || typeof candle !== "object") continue;
                const res = await d1UpsertCandle(env, ticker, tf, candle);
                if (res?.ok) okCount++;
                else errCount++;
              }
            }
          } else {
            // Single-candle mode: each TF has one candle object
            for (const [tf, candle] of Object.entries(tfCandles)) {
              const res = await d1UpsertCandle(env, ticker, tf, candle);
              if (res?.ok) okCount++;
              else errCount++;
            }
          }

          return ackJSON(
            env,
            {
              ok: true,
              ticker,
              ingested: okCount,
              rejected: errCount,
              tfs: Object.keys(tfCandles),
              bulk: isBulk,
            },
            200,
            req,
          );
        } catch (err) {
          console.error(`[CANDLES INGEST ERROR]`, err);
          return ackJSON(
            env,
            { ok: false, error: String(err?.message || err) },
            500,
            req,
          );
        }
      }

      // GET /timed/latest?ticker=
      if (url.pathname === "/timed/latest" && req.method === "GET") {
        // Rate limiting
        const ip = req.headers.get("CF-Connecting-IP") || "unknown";
        const rateLimit = await checkRateLimit(
          KV,
          ip,
          "/timed/latest",
          1000, // Increased for single-user
          3600,
        );

        if (!rateLimit.allowed) {
          return sendJSON(
            { ok: false, error: "rate_limit_exceeded", retryAfter: 3600 },
            429,
            corsHeaders(env, req),
          );
        }

        const ticker = normTicker(url.searchParams.get("ticker"));
        if (!ticker)
          return sendJSON(
            { ok: false, error: "missing ticker" },
            400,
            corsHeaders(env, req),
          );
        // Prefer D1 for reads (single-row query)
        let data = null;
        let d1Stage = null;
        let d1PrevStage = null;
        let d1UpdatedAt = null;
        try {
          if (env?.DB) {
            await d1EnsureLatestSchema(env);
            const row = await env.DB.prepare(
              `SELECT payload_json, kanban_stage, prev_kanban_stage, updated_at
                 FROM ticker_latest
                 WHERE ticker = ?1`,
            )
              .bind(String(ticker || "").toUpperCase())
              .first();
            if (row) {
              d1Stage =
                row.kanban_stage != null ? String(row.kanban_stage) : null;
              d1PrevStage =
                row.prev_kanban_stage != null
                  ? String(row.prev_kanban_stage)
                  : null;
              d1UpdatedAt = Number(row.updated_at);
              if (!Number.isFinite(d1UpdatedAt)) d1UpdatedAt = null;
            }
            if (row && row.payload_json) {
              try {
                data = JSON.parse(String(row.payload_json));
              } catch {
                data = null;
              }
            }
          }
        } catch (e) {
          console.error(`[D1 LATEST] Read failed for ${ticker}:`, String(e));
        }

        // Fallback to KV if D1 misses (and best-effort backfill D1)
        if (!data) {
          data = await kvGetJSON(KV, `timed:latest:${ticker}`);
          if (data) {
            try {
              ctx.waitUntil(d1UpsertTickerLatest(env, ticker, data));
              ctx.waitUntil(d1UpsertTickerIndex(env, ticker, data?.ts));
            } catch {
              // ignore
            }
          }
        }
        const capture = await kvGetJSON(KV, `timed:capture:latest:${ticker}`);
        if (data) {
          // Ensure prev/current lane fields are present even if payload_json is older.
          if (data.kanban_stage == null && d1Stage != null)
            data.kanban_stage = d1Stage;
          if (data.prev_kanban_stage == null && d1PrevStage != null)
            data.prev_kanban_stage = d1PrevStage;
          if (
            data.prev_kanban_stage != null &&
            data.prev_kanban_stage_ts == null &&
            d1UpdatedAt != null
          ) {
            // Best-effort: when we only know "prev stage" from columns, approximate timestamp from row update.
            data.prev_kanban_stage_ts = d1UpdatedAt;
          }
          // Merge capture-only enrichment fields when present (non-destructive).
          // This helps after-hours analytics + Momentum Elite metadata even if heartbeat is wired to /ingest-capture.
          if (capture && typeof capture === "object") {
            // Prefer capture for daily-change fields (more reliable for UI/analysis).
            for (const k of ["prev_close", "day_change", "day_change_pct"]) {
              if (capture[k] != null) data[k] = capture[k];
            }
            for (const k of [
              "session",
              "is_rth",
              "avg_vol_30",
              "avg_vol_50",
              "adr_14",
              "momentum_pct",
              "momentum_elite_criteria",
            ]) {
              if (data[k] == null && capture[k] != null) data[k] = capture[k];
            }
            if (capture.flags && typeof capture.flags === "object") {
              data.flags =
                data.flags && typeof data.flags === "object" ? data.flags : {};
              // Override from capture: score payloads don't compute Momentum Elite reliably.
              if (capture.flags.momentum_elite != null)
                data.flags.momentum_elite = !!capture.flags.momentum_elite;
            }
          }

          // Context enrichment is now delivered via /timed/ingest-capture (throttled in Pine).
          // Merge it opportunistically when present (non-blocking).
          try {
            if (capture && typeof capture === "object") {
              const ctx =
                capture.context && typeof capture.context === "object"
                  ? capture.context
                  : null;
              if (ctx) {
                const cleaned = sanitizeTickerContext(ctx, data);
                data.context = mergeTickerContext(data.context, cleaned || ctx);
              }
            }
          } catch (e) {
            console.error(
              `[CONTEXT] /timed/latest capture merge failed for ${ticker}:`,
              String(e),
            );
          }

          // If capture doesn't include context on this bar, fall back to the persisted context blob.
          try {
            if (!data.context) {
              const saved = await kvGetJSON(KV, `timed:context:${ticker}`);
              if (saved && typeof saved === "object") {
                const cleaned = sanitizeTickerContext(saved, data);
                data.context = cleaned || saved;
              }
            }
          } catch (e) {
            console.error(
              `[CONTEXT] /timed/latest persisted context read failed for ${ticker}:`,
              String(e),
            );
          }

          // Final fallback: derive minimal context from fundamentals/profile fields.
          try {
            if (!data.context) {
              const derived = deriveTickerContext(data);
              if (derived) {
                const cleaned = sanitizeTickerContext(derived, data);
                data.context = cleaned || derived;
              }
            }
          } catch {
            // ignore
          }

          // Ensure Momentum Elite reflects the most recent computed status.
          // Score payloads often default flags.momentum_elite=false; use cached momentum computation when available.
          try {
            const m = await kvGetJSON(KV, `timed:momentum:${ticker}`);
            if (m && typeof m === "object" && m.momentum_elite != null) {
              data.flags =
                data.flags && typeof data.flags === "object" ? data.flags : {};
              data.flags.momentum_elite = !!m.momentum_elite;
              if (data.momentum_elite_criteria == null && m.criteria) {
                data.momentum_elite_criteria = m.criteria;
              }
            }
          } catch {
            // ignore
          }
          // Always recompute RR to ensure it uses the latest max TP from tp_levels
          data.rr = computeRR(data);

          // Ensure watchlist-style daily change is correct (prev trading day 4pm ET close).
          // This is used by the UI header/kanban and should not depend on ingest quirks.
          try {
            if (env?.DB) {
              const asOfTs = Number(data.ts ?? data.ingest_ts ?? Date.now());
              const rec = await computePrevCloseFromTrail(
                env.DB,
                ticker,
                asOfTs,
              );
              const price = Number(data.price);
              // Only backfill if daily-change fields are missing. Heartbeat capture is preferred when present.
              if (
                rec &&
                Number.isFinite(price) &&
                price > 0 &&
                !(
                  Number.isFinite(Number(data.day_change_pct)) &&
                  Number.isFinite(Number(data.day_change))
                )
              ) {
                data.prev_close = rec.close;
                data.day_change = price - rec.close;
                data.day_change_pct = ((price - rec.close) / rec.close) * 100;
              }
            }
          } catch (e) {
            console.warn(
              `[DAILY CHANGE] /timed/latest backfill failed for ${ticker}:`,
              String(e?.message || e),
            );
          }

          // Canonicalize daily change: if day_* disagrees with change_* (heartbeat), prefer change_*.
          try {
            const dayPct = Number(data.day_change_pct);
            const altPct = Number(data.change_pct);
            const dayChg = Number(data.day_change);
            const altChg = Number(data.change);
            const price = Number(data.price);
            const hasHeartbeatSession =
              data.session != null || data.is_rth != null;
            // If heartbeat fields are present, treat change/change_pct as authoritative watchlist daily change.
            if (hasHeartbeatSession && Number.isFinite(altPct)) {
              data.day_change_pct = altPct;
              if (Number.isFinite(altChg)) data.day_change = altChg;
              if (Number.isFinite(price) && Number.isFinite(altChg))
                data.prev_close = price - altChg;
            }
            const disagree =
              Number.isFinite(dayPct) &&
              Number.isFinite(altPct) &&
              (dayPct >= 0 !== altPct >= 0 || Math.abs(dayPct - altPct) >= 1.5);
            const absurd = Number.isFinite(dayPct) && Math.abs(dayPct) > 5;
            const saneAlt = Number.isFinite(altPct) && Math.abs(altPct) <= 5;
            if ((disagree || (absurd && saneAlt)) && Number.isFinite(altPct)) {
              data.day_change_pct = altPct;
              if (Number.isFinite(altChg)) data.day_change = altChg;
              if (Number.isFinite(price) && Number.isFinite(altChg))
                data.prev_close = price - altChg;
            } else if (!Number.isFinite(dayPct) && Number.isFinite(altPct)) {
              data.day_change_pct = altPct;
              if (Number.isFinite(altChg)) data.day_change = altChg;
              if (Number.isFinite(price) && Number.isFinite(altChg))
                data.prev_close = price - altChg;
            } else if (!Number.isFinite(dayChg) && Number.isFinite(altChg)) {
              data.day_change = altChg;
              if (Number.isFinite(price) && Number.isFinite(altChg))
                data.prev_close = price - altChg;
            }
          } catch {
            // ignore
          }

          // Back-compat: older KV entries may not have derived horizon/ETA v2 fields yet,
          // or may be missing the newer target TP fields. Compute on-the-fly.
          try {
            if (
              !data.horizon_bucket ||
              data.eta_days_v2 == null ||
              data.tp_target_price == null ||
              data.tp_target_pct == null
            ) {
              const derived = deriveHorizonAndMetrics(data);
              Object.assign(data, derived);
            }
          } catch (e) {
            console.error(
              `[DERIVED METRICS] /timed/latest failed for ${ticker}:`,
              String(e),
            );
          }
          // Back-compat: compute entry decision if missing
          try {
            if (!data.entry_decision) {
              data.entry_decision = buildEntryDecision(ticker, data, null);
            }
          } catch (e) {
            console.error(
              `[ENTRY DECISION] /timed/latest failed for ${ticker}:`,
              String(e),
            );
          }

          // Back-compat: attach ML v1 fields if missing (for older payloads).
          try {
            if (!data.ml_v1) {
              await mlV1AttachToPayload(KV, data);
            } else if (data.ml == null) {
              data.ml = data.ml_v1;
            }
          } catch (e) {
            console.error(
              `[ML V1] /timed/latest failed for ${ticker}:`,
              String(e?.message || e),
            );
          }

          // Back-compat: compute thesis features if missing (older KV entries)
          try {
            const hasThesisMatch =
              data?.flags &&
              typeof data.flags === "object" &&
              data.flags.thesis_match != null;
            const hasSeq = data?.seq && typeof data.seq === "object";
            const hasDeltas = data?.deltas && typeof data.deltas === "object";
            if (!hasThesisMatch || !hasSeq || !hasDeltas) {
              const trail =
                (await kvGetJSON(KV, `timed:trail:${ticker}`)) || null;
              if (trail && Array.isArray(trail) && trail.length >= 2) {
                const computed = computeLiveThesisFeaturesFromTrail(
                  trail,
                  data,
                );
                if (computed && typeof computed === "object") {
                  data.seq = computed.seq;
                  data.deltas = computed.deltas;
                  data.flags =
                    data.flags && typeof data.flags === "object"
                      ? data.flags
                      : {};
                  data.flags.htf_improving_4h =
                    !!computed.flags?.htf_improving_4h;
                  data.flags.htf_improving_1d =
                    !!computed.flags?.htf_improving_1d;
                  data.flags.htf_move_4h_ge_5 =
                    !!computed.flags?.htf_move_4h_ge_5;
                  data.flags.thesis_match = !!computed.flags?.thesis_match;

                  // Persist backfill so future reads don’t need to recompute.
                  await kvPutJSON(KV, `timed:latest:${ticker}`, data);
                }
              }
            }
          } catch (e) {
            console.error(
              `[THESIS FEATURES] /timed/latest failed for ${ticker}:`,
              String(e),
            );
          }

          // Back-compat: compute completeness + summaries if missing (older KV entries)
          try {
            if (!data.data_completeness) {
              data.data_completeness = computeDataCompleteness(data);
            }
            if (!data.tf_summary) {
              const tfSum = tfTechAlignmentSummary(data);
              if (tfSum) data.tf_summary = tfSum;
            }
            if (!data.trigger_summary) {
              data.trigger_summary = triggerSummaryAndScore(data);
            }
            if (!data.move_status) {
              data.move_status = computeMoveStatus(data);
            }
            data.flags =
              data.flags && typeof data.flags === "object" ? data.flags : {};
            data.flags.move_invalidated =
              data.move_status?.status === "INVALIDATED";
            data.flags.move_completed =
              data.move_status?.status === "COMPLETED";
          } catch (e) {
            console.error(
              `[ENRICH] /timed/latest failed for ${ticker}:`,
              String(e?.message || e),
            );
          }

          try {
            const corrData = await computeOpenTradesCorrelation(env, KV);
            const corr =
              corrData && corrData.avgCorrByTicker
                ? corrData.avgCorrByTicker[String(ticker).toUpperCase()]
                : null;
            if (corr) {
              data.avg_corr = corr.avg_corr;
              data.diversity_score = corr.diversity_score;
              data.corr_count = corr.corr_count;
            }
          } catch (e) {
            console.error(
              `[CORR] /timed/latest failed for ${ticker}:`,
              String(e),
            );
          }

          // Ensure kanban_stage reflects current logic for Action Center flow
          try {
            const cMax = computeCompletionToTpMax(data);
            if (Number.isFinite(cMax)) data.completion = cMax;
            const rr = computeRR(data);
            if (Number.isFinite(rr)) data.rr = rr;
            const rrTargets = computeRRTargets(data);
            if (rrTargets) Object.assign(data, rrTargets);
            data.move_status = computeMoveStatus(data);
          } catch {
            // ignore
          }
          try {
            data.flags =
              data.flags && typeof data.flags === "object" ? data.flags : {};
            data.flags.move_invalidated =
              data.move_status?.status === "INVALIDATED";
            data.flags.move_completed =
              data.move_status?.status === "COMPLETED";
          } catch {
            // ignore
          }
          try {
            const prevStage =
              data?.kanban_stage != null ? String(data.kanban_stage) : null;
            const stage = classifyKanbanStage(data);
            data.kanban_stage = stage;
            data.kanban_meta = deriveKanbanMeta(data, stage);
            // Track lane transitions even on read-time recompute (so UI can show prev lane + highlight).
            if (
              prevStage != null &&
              stage != null &&
              String(prevStage) !== String(stage)
            ) {
              data.prev_kanban_stage = String(prevStage);
              data.prev_kanban_stage_ts = Date.now();
              try {
                ctx.waitUntil(d1UpsertTickerLatest(env, ticker, data));
                ctx.waitUntil(d1UpsertTickerIndex(env, ticker, data?.ts));
              } catch {
                // ignore
              }
            }
          } catch {
            // ignore
          }

          return sendJSON(
            { ok: true, ticker, latestData: data, data },
            200,
            corsHeaders(env, req),
          );
        }
        return sendJSON(
          { ok: false, error: "ticker_not_found", ticker },
          404,
          corsHeaders(env, req),
        );
      }

      // GET /timed/tickers
      if (url.pathname === "/timed/tickers" && req.method === "GET") {
        // Rate limiting
        const ip = req.headers.get("CF-Connecting-IP") || "unknown";
        const rateLimit = await checkRateLimit(
          KV,
          ip,
          "/timed/tickers",
          20000, // Increased: UI polling + multiple tabs
          3600,
        );

        if (!rateLimit.allowed) {
          return sendJSON(
            { ok: false, error: "rate_limit_exceeded", retryAfter: 3600 },
            429,
            corsHeaders(env, req),
          );
        }

        // Prefer D1 for reads (fast index table)
        let tickers = [];
        try {
          if (env?.DB) {
            await d1EnsureLatestSchema(env);
            const rows = await env.DB.prepare(
              `SELECT ticker FROM ticker_index ORDER BY ticker ASC`,
            ).all();
            const list = rows?.results || [];
            tickers = list
              .map((r) => String(r.ticker || "").toUpperCase())
              .filter(Boolean);
          }
        } catch (e) {
          console.error(`[D1 LATEST] /timed/tickers read failed:`, String(e));
        }
        // If D1 is still warming up, fall back to KV index to avoid hiding tickers.
        const kvTickers = (await kvGetJSON(KV, "timed:tickers")) || [];
        if (
          !Array.isArray(tickers) ||
          tickers.length === 0 ||
          (Array.isArray(kvTickers) && kvTickers.length > tickers.length)
        ) {
          tickers = Array.isArray(kvTickers) ? kvTickers : [];
          // Kick a background sync so D1 catches up without blocking the request.
          try {
            ctx.waitUntil(d1SyncLatestBatchFromKV(env, ctx, 50));
          } catch {
            // ignore
          }
        }
        return sendJSON(
          { ok: true, tickers, count: tickers.length },
          200,
          corsHeaders(env, req),
        );
      }

      // GET /timed/all?version=2.5.0 (optional version parameter)
      if (url.pathname === "/timed/all" && req.method === "GET") {
        // Rate limiting
        const ip = req.headers.get("CF-Connecting-IP") || "unknown";
        const rateLimit = await checkRateLimit(
          KV,
          ip,
          "/timed/all",
          20000,
          3600,
        ); // Increased for single-user

        if (!rateLimit.allowed) {
          return sendJSON(
            { ok: false, error: "rate_limit_exceeded", retryAfter: 3600 },
            429,
            corsHeaders(env, req),
          );
        }
        // Read from D1 (single query) for UI performance
        try {
          if (!env?.DB) {
            return sendJSON(
              { ok: false, error: "no_db_binding" },
              500,
              corsHeaders(env, req),
            );
          }

          await d1EnsureLatestSchema(env);
          const rows = await env.DB.prepare(
            `SELECT ticker, payload_json, updated_at, kanban_stage, prev_kanban_stage FROM ticker_latest`,
          ).all();

          const results = rows?.results || [];
          const data = {};
          let maxUpdatedAt = 0;

          for (const r of results) {
            const sym = String(r?.ticker || "").toUpperCase();
            if (!sym) continue;
            if (Number(r?.updated_at) > maxUpdatedAt)
              maxUpdatedAt = Number(r.updated_at);
            const raw = r?.payload_json;
            if (!raw) continue;
            try {
              const obj = JSON.parse(String(raw));
              // Ensure lane fields are present even if payload_json is older than the D1 columns.
              if (obj.kanban_stage == null && r?.kanban_stage != null)
                obj.kanban_stage = String(r.kanban_stage);
              if (obj.prev_kanban_stage == null && r?.prev_kanban_stage != null)
                obj.prev_kanban_stage = String(r.prev_kanban_stage);
              if (
                obj.prev_kanban_stage != null &&
                obj.prev_kanban_stage_ts == null &&
                Number.isFinite(Number(r?.updated_at))
              ) {
                obj.prev_kanban_stage_ts = Number(r.updated_at);
              }
              // Canonicalize daily change fields: prefer heartbeat capture semantics (change/change_pct)
              // when stored day_change_pct is poisoned by a bad prev_close anchor.
              try {
                const dayPct = Number(obj.day_change_pct);
                const altPct = Number(obj.change_pct);
                const altChg = Number(obj.change);
                const price = Number(obj.price);
                const hasHeartbeatSession =
                  obj.session != null || obj.is_rth != null;
                if (hasHeartbeatSession && Number.isFinite(altPct)) {
                  obj.day_change_pct = altPct;
                  if (Number.isFinite(altChg)) obj.day_change = altChg;
                  if (Number.isFinite(price) && Number.isFinite(altChg))
                    obj.prev_close = price - altChg;
                }
                const disagree =
                  Number.isFinite(dayPct) &&
                  Number.isFinite(altPct) &&
                  (dayPct >= 0 !== altPct >= 0 ||
                    Math.abs(dayPct - altPct) >= 1.5);
                const absurd = Number.isFinite(dayPct) && Math.abs(dayPct) > 5;
                const saneAlt =
                  Number.isFinite(altPct) && Math.abs(altPct) <= 5;
                if (
                  (disagree || (absurd && saneAlt)) &&
                  Number.isFinite(altPct)
                ) {
                  obj.day_change_pct = altPct;
                  if (Number.isFinite(altChg)) obj.day_change = altChg;
                  if (Number.isFinite(price) && Number.isFinite(altChg))
                    obj.prev_close = price - altChg;
                } else if (
                  !Number.isFinite(dayPct) &&
                  Number.isFinite(altPct)
                ) {
                  obj.day_change_pct = altPct;
                  if (Number.isFinite(altChg)) obj.day_change = altChg;
                  if (Number.isFinite(price) && Number.isFinite(altChg))
                    obj.prev_close = price - altChg;
                }
              } catch {
                // ignore
              }
              // Ensure stage/status reflect current logic even if no new ingests
              try {
                const cMax = computeCompletionToTpMax(obj);
                if (Number.isFinite(cMax)) obj.completion = cMax;
                const rr = computeRR(obj);
                if (Number.isFinite(rr)) obj.rr = rr;
                const rrTargets = computeRRTargets(obj);
                if (rrTargets) Object.assign(obj, rrTargets);
                obj.move_status = computeMoveStatus(obj);
              } catch {
                // ignore
              }
              try {
                obj.flags =
                  obj.flags && typeof obj.flags === "object" ? obj.flags : {};
                obj.flags.move_invalidated =
                  obj.move_status?.status === "INVALIDATED";
                obj.flags.move_completed =
                  obj.move_status?.status === "COMPLETED";
              } catch {
                // ignore
              }
              try {
                const prevStage =
                  obj?.kanban_stage != null ? String(obj.kanban_stage) : null;
                const stage = classifyKanbanStage(obj);
                obj.kanban_stage = stage;
                obj.kanban_meta = deriveKanbanMeta(obj, stage);
                // Track lane transitions even if no new ingests (persist back into D1 so UI can highlight).
                if (
                  prevStage != null &&
                  stage != null &&
                  String(prevStage) !== String(stage)
                ) {
                  obj.prev_kanban_stage = String(prevStage);
                  obj.prev_kanban_stage_ts = Date.now();
                  try {
                    ctx.waitUntil(d1UpsertTickerLatest(env, sym, obj));
                    ctx.waitUntil(d1UpsertTickerIndex(env, sym, obj?.ts));
                  } catch {
                    // ignore
                  }
                }
              } catch {
                // ignore
              }

              // Context fallback for D1 /timed/all path (payload_json may omit capture.context).
              try {
                if (obj.context && typeof obj.context === "object") {
                  const cleaned = sanitizeTickerContext(obj.context, obj);
                  if (cleaned) obj.context = cleaned;
                } else if (!obj.context) {
                  const derived = deriveTickerContext(obj);
                  if (derived) {
                    const cleaned = sanitizeTickerContext(derived, obj);
                    obj.context = cleaned || derived;
                  }
                }
              } catch {
                // ignore
              }

              data[sym] = obj;
            } catch {
              // skip bad rows
            }
          }

          // If D1 is warming up, report total index from KV for transparency
          let totalIndex = Object.keys(data).length;
          try {
            const kvTickers = (await kvGetJSON(KV, "timed:tickers")) || [];
            if (Array.isArray(kvTickers) && kvTickers.length > totalIndex) {
              totalIndex = kvTickers.length;
              // Background sync to accelerate warm-up
              try {
                ctx.waitUntil(d1SyncLatestBatchFromKV(env, ctx, 75));
              } catch {
                // ignore
              }
            }
          } catch {
            // ignore
          }

          // Compute rank positions and add score/position (canonical) alongside rank/rank_position
          const ranked = Object.entries(data)
            .map(([ticker, value]) => {
              const sc = Number(value?.dynamicScore ?? value?.rank);
              const safeScore = Number.isFinite(sc)
                ? sc
                : (value && computeDynamicScore(value)) || Number(value?.rank) || 0;
              return { ticker, score: safeScore };
            })
            .sort((a, b) => b.score - a.score);
          const rankTotal = ranked.length;
          ranked.forEach((item, idx) => {
            const entry = data[item.ticker];
            if (!entry) return;
            const pos = idx + 1;
            entry.rank_position = pos;
            entry.position = pos;
            entry.rank_total = rankTotal;
            entry.rank_score = item.score;
            entry.score = Number(entry?.rank ?? item.score);
          });

          return sendJSON(
            {
              ok: true,
              count: Object.keys(data).length,
              totalIndex,
              data,
              d1_max_updated_at: maxUpdatedAt || null,
            },
            200,
            corsHeaders(env, req),
          );
        } catch (e) {
          console.error(`[D1 LATEST] /timed/all failed:`, String(e));
          return sendJSON(
            {
              ok: false,
              error: "d1_all_failed",
              message: String(e?.message || e),
            },
            500,
            corsHeaders(env, req),
          );
        }

        /* REMOVED: On-demand computation (KV-based) - replaced by D1 reads
        const useLightweightMode = true;
        const tickers = (await kvGetJSON(KV, "timed:tickers")) || [];
        const storedVersion =
          (await getStoredVersion(KV)) || CURRENT_DATA_VERSION;

        // Debug: Check if BMNR is in the ticker index
        if (tickers.includes("BMNR") || tickers.includes("BABA")) {
          console.log(`[ALL ENDPOINT] BMNR/BABA in index:`, {
            BMNR: tickers.includes("BMNR"),
            BABA: tickers.includes("BABA"),
            totalTickers: tickers.length,
            indexSample: tickers.slice(0, 10),
          });
        } else {
          console.log(
            `[ALL ENDPOINT] BMNR/BABA NOT in index. Total tickers: ${tickers.length}`
          );
        }

        // Check if version parameter is provided
        const requestedVersion = url.searchParams.get("version");
        const useVersionSnapshots =
          requestedVersion && requestedVersion !== "latest";

        // Use Promise.all for parallel KV reads instead of sequential
        const dataPromises = tickers.map(async (t) => {
          let value;
          if (useVersionSnapshots) {
            // Try to get version-specific snapshot first
            value = await kvGetJSON(
              KV,
              `timed:snapshot:${t}:${requestedVersion}`
            );
            // If no snapshot found, fall back to latest
            if (!value) {
              value = await kvGetJSON(KV, `timed:latest:${t}`);
              // Only include if version matches
              if (value && value.script_version !== requestedVersion) {
                value = null; // Don't include mismatched versions
              }
            }
          } else if (useLightweightMode) {
            // LIGHTWEIGHT MODE: Only get latest data, skip capture/context/momentum merges
            value = await kvGetJSON(KV, `timed:latest:${t}`);
          } else {
            // Default: get latest data
            value = await kvGetJSON(KV, `timed:latest:${t}`);

            // Merge capture-only enrichment fields when present (non-destructive).
            // This helps after-hours analytics + Momentum Elite metadata even if heartbeat is wired to /ingest-capture.
            if (!useLightweightMode) {
              try {
                const capture = await kvGetJSON(KV, `timed:capture:latest:${t}`);
                if (value && capture && typeof capture === "object") {
                // Prefer capture for daily-change fields (more reliable for UI/analysis).
                for (const k of ["prev_close", "day_change", "day_change_pct"]) {
                  if (capture[k] != null) value[k] = capture[k];
                }
                for (const k of [
                  "session",
                  "is_rth",
                  "avg_vol_30",
                  "avg_vol_50",
                  "adr_14",
                  "momentum_pct",
                  "momentum_elite_criteria",
                ]) {
                  if (value[k] == null && capture[k] != null) value[k] = capture[k];
                }
                if (capture.flags && typeof capture.flags === "object") {
                  value.flags = value.flags && typeof value.flags === "object" ? value.flags : {};
                  // Override from capture: score payloads don't compute Momentum Elite reliably.
                  if (capture.flags.momentum_elite != null) value.flags.momentum_elite = !!capture.flags.momentum_elite;
                }

                // Context enrichment rides along on capture payload (throttled in Pine).
                if (capture.context && typeof capture.context === "object") {
                  value.context = capture.context;
                }
              }
            } catch (e) {
              // ignore merge failures
            }

            // If capture doesn't include context on this bar, fall back to persisted context.
            try {
              if (value && !value.context) {
                const saved = await kvGetJSON(KV, `timed:context:${t}`);
                if (saved && typeof saved === "object") value.context = saved;
              }
            } catch {
              // ignore
            }

            // Ensure Momentum Elite reflects the most recent computed status.
            try {
              if (value) {
                const m = await kvGetJSON(KV, `timed:momentum:${t}`);
                if (m && typeof m === "object" && m.momentum_elite != null) {
                  value.flags = value.flags && typeof value.flags === "object" ? value.flags : {};
                  value.flags.momentum_elite = !!m.momentum_elite;
                  if (value.momentum_elite_criteria == null && m.criteria) {
                    value.momentum_elite_criteria = m.criteria;
                  }
                }
              }
              } catch {
                // ignore
              }
            } // End lightweight mode skip

            // Debug: Check if BMNR data exists in KV
            if (t === "BMNR" || t === "BABA") {
              console.log(`[ALL ENDPOINT] Fetched ${t} from KV:`, {
                hasValue: !!value,
                valueKeys: value ? Object.keys(value) : [],
                htf_score: value?.htf_score,
                ltf_score: value?.ltf_score,
                script_version: value?.script_version,
              });
            }
          }
          return { ticker: t, value };
        });
        const results = await Promise.all(dataPromises);

        // Find all versions in the data
        const versionsSeen = new Set();
        for (const { value } of results) {
          if (value && value.script_version) {
            versionsSeen.add(value.script_version);
          }
        }

        // Accept ANY version that exists in the data, plus "unknown" for legacy data
        // This prevents filtering out data during version transitions
        const acceptedVersions = new Set([
          storedVersion,
          CURRENT_DATA_VERSION,
          "unknown", // Legacy data without script_version
          ...Array.from(versionsSeen), // All versions seen in current data
        ]);

        const data = {};
        let corrData = null;
        if (!useLightweightMode) {
          try {
            corrData = await computeOpenTradesCorrelation(env, KV);
          } catch (e) {
            console.error(`[CORR] /timed/all compute failed:`, String(e));
          }
        }
        let versionFilteredCount = 0;
        const versionBreakdown = {}; // Track which versions are being filtered

        for (const { ticker, value } of results) {
          // Debug specific tickers that aren't showing
          if (ticker === "BMNR" || ticker === "BABA") {
            console.log(`[ALL ENDPOINT DEBUG] ${ticker}:`, {
              inIndex: tickers.includes(ticker),
              hasValue: !!value,
              valueKeys: value ? Object.keys(value) : [],
              htf_score: value?.htf_score,
              ltf_score: value?.ltf_score,
              script_version: value?.script_version,
              price: value?.price,
              state: value?.state,
            });
          }

          if (value) {
            // Accept ALL data - don't filter by version unless explicitly requested
            // This ensures all historical data is accessible
            const tickerVersion = value.script_version || "unknown";

            // Only filter if a specific version was requested AND it doesn't match
            if (useVersionSnapshots && tickerVersion !== requestedVersion) {
              versionFilteredCount++;
              // Track which versions are being filtered
              if (!versionBreakdown[tickerVersion]) {
                versionBreakdown[tickerVersion] = 0;
              }
              versionBreakdown[tickerVersion]++;
              console.log(
                `[FILTER] Ticker ${ticker} filtered: version=${tickerVersion}, requested=${requestedVersion}`
              );
            } else {
              // LIGHTWEIGHT MODE: Skip heavy enrichment, just return raw data
              if (!useLightweightMode) {
                // Always recompute RR to ensure it uses the latest max TP from tp_levels
                value.rr = computeRR(value);
              }

              // Back-compat: compute completeness + summaries if missing (older KV entries)
              if (!useLightweightMode) {
                try {
                if (!value.data_completeness) {
                  value.data_completeness = computeDataCompleteness(value);
                }
                if (!value.tf_summary) {
                  const tfSum = tfTechAlignmentSummary(value);
                  if (tfSum) value.tf_summary = tfSum;
                }
                if (!value.trigger_summary) {
                  value.trigger_summary = triggerSummaryAndScore(value);
                }
                if (!value.move_status) {
                  value.move_status = computeMoveStatus(value);
                }
                value.flags = value.flags && typeof value.flags === "object" ? value.flags : {};
                value.flags.move_invalidated = value.move_status?.status === "INVALIDATED";
                value.flags.move_completed = value.move_status?.status === "COMPLETED";
              } catch (e) {
                console.error(
                  `[ENRICH] /timed/all failed for ${ticker}:`,
                  String(e?.message || e)
                );
                }
              } // End lightweight mode skip

              // Calculate dynamicScore (for ranking) - backend calculation
              if (!useLightweightMode) {
                value.dynamicScore = computeDynamicScore(value);
              }

              // Back-compat: compute derived horizon/ETA v2 + target TP fields if missing
              if (!useLightweightMode) {
              try {
                if (
                  !value.horizon_bucket ||
                  value.eta_days_v2 == null ||
                  value.tp_target_price == null ||
                  value.tp_target_pct == null
                ) {
                  const derived = deriveHorizonAndMetrics(value);
                  Object.assign(value, derived);
                }
              } catch (e) {
                console.error(
                  `[DERIVED METRICS] /timed/all failed for ${ticker}:`,
                  String(e)
                );
              }
              // Back-compat: compute entry decision if missing
              try {
                if (!value.entry_decision) {
                  value.entry_decision = buildEntryDecision(
                    ticker,
                    value,
                    null
                  );
                }
              } catch (e) {
                console.error(
                  `[ENTRY DECISION] /timed/all failed for ${ticker}:`,
                  String(e)
                );
                }
              } // End lightweight mode skip

              if (!useLightweightMode) {
                if (corrData && corrData.avgCorrByTicker) {
                  const corr =
                    corrData.avgCorrByTicker[String(ticker).toUpperCase()];
                  if (corr) {
                    value.avg_corr = corr.avg_corr;
                    value.diversity_score = corr.diversity_score;
                    value.corr_count = corr.corr_count;
                  }
                }
              }

              // Enrich with sector from SECTOR_MAP if not present in data
              if (!value.sector && !value.fundamentals?.sector) {
                const sectorFromMap = getSector(ticker);
                if (sectorFromMap) {
                  // Add sector to both top-level and fundamentals for consistency
                  value.sector = sectorFromMap;
                  if (!value.fundamentals) {
                    value.fundamentals = {};
                  }
                  value.fundamentals.sector = sectorFromMap;
                }
              }

              data[ticker] = value;
            }
          } else {
            // Log tickers in index but without data
            if (ticker === "BMNR" || ticker === "BABA") {
              console.log(
                `[ALL ENDPOINT DEBUG] ${ticker}: In index but no data found in KV`
              );
            }
          }
        }

        // Backfill daily change fields (watchlist-style) if missing.
        // Many tickers do not include prev close / session change from TradingView,
        // so we derive prev_close from D1 timed_trail and cache it in KV.
        //
        // IMPORTANT: We anchor "current day" to each ticker's own last timestamp.
        // This makes weekends behave like a trading platform watchlist:
        // - Sat/Sun: compare Friday close vs Thursday close (since ticker ts is Friday)
        // - Mon: compare current vs Friday close
        // - Tue: compare current vs Monday close, etc.
        try {
          const db = env?.DB;
          if (db) {
            const needs = [];
            const byDay = new Map(); // dayKey -> Set(ticker)

            for (const [sym, v] of Object.entries(data)) {
              if (!v || typeof v !== "object") continue;
              const price = Number(v.price);
              if (!Number.isFinite(price) || price <= 0) continue;
              if (
                v.prev_close != null ||
                v.day_change != null ||
                v.day_change_pct != null
              ) {
                continue;
              }
              const ts = Number(v.ts ?? v.ingest_ts);
              const dayKey = nyTradingDayKey(ts);
              if (!dayKey) continue;
              needs.push(sym);
              if (!byDay.has(dayKey)) byDay.set(dayKey, new Set());
              byDay.get(dayKey).add(String(sym).toUpperCase());
            }

            if (needs.length > 0 && byDay.size > 0) {
              const cachePromises = [];

              for (const [dayKey, tickSet] of byDay.entries()) {
                const prevKey = prevTradingDayKey(dayKey);
                if (!prevKey) continue;
                const closeCutoff = nyWallTimeToUtcMs(prevKey, 16, 0, 0);
                if (!Number.isFinite(closeCutoff)) continue;
                const lookbackStart = closeCutoff - 14 * 24 * 60 * 60 * 1000;

                // Watchlist semantics: prev_close = prior trading day regular close (4pm ET).
                const rows = await db
                  .prepare(
                    `SELECT t1.ticker AS ticker, t1.price AS price, t1.ts AS ts
                     FROM timed_trail t1
                     JOIN (
                       SELECT ticker, MAX(ts) AS tsMax
                       FROM timed_trail
                       WHERE ts >= ?1 AND ts <= ?2 AND price IS NOT NULL
                       GROUP BY ticker
                     ) t2
                     ON t1.ticker = t2.ticker AND t1.ts = t2.tsMax`
                  )
                  .bind(lookbackStart, closeCutoff + 1000)
                  .all();

                const closeMap = new Map();
                for (const r of rows?.results || []) {
                  const sym = String(r.ticker || "").toUpperCase();
                  const p = Number(r.price);
                  if (sym && Number.isFinite(p) && p > 0 && !closeMap.has(sym)) {
                    closeMap.set(sym, { close: p, ts: Number(r.ts) });
                  }
                }

                for (const sym of tickSet.values()) {
                  const v = data[sym];
                  if (!v) continue;
                  const price = Number(v.price);
                  const rec = closeMap.get(sym);
                  const prevClose = Number(rec?.close);
                  if (!Number.isFinite(price) || price <= 0) continue;
                  if (!Number.isFinite(prevClose) || prevClose <= 0) continue;

                  v.prev_close = prevClose;
                  v.day_change = price - prevClose;
                  v.day_change_pct = ((price - prevClose) / prevClose) * 100;

                  const prevDayKey = prevKey;
                  if (prevDayKey) {
                    cachePromises.push(
                      kvPutJSON(
                        KV,
                        `timed:prev_close:${sym}`,
                        { day: prevDayKey, close: prevClose },
                        14 * 24 * 60 * 60
                      )
                    );
                  }
                }
              }

              if (cachePromises.length > 0) {
                await Promise.allSettled(cachePromises);
              }
            }
          }
        } catch (e) {
          console.warn(`[DAILY CHANGE] /timed/all backfill failed:`, String(e?.message || e));
        }

        // Log summary if any data was filtered
        if (versionFilteredCount > 0) {
          console.log(
            `[FILTER] Filtered ${versionFilteredCount} tickers by version. Breakdown:`,
            versionBreakdown
          );
        }

        // Compute rank positions once (server-authoritative)
        const ranked = Object.entries(data)
          .map(([ticker, value]) => {
            const score = Number(value?.dynamicScore);
            const safeScore = Number.isFinite(score)
              ? score
              : computeDynamicScore(value || {});
            return { ticker, score: safeScore };
          })
          .sort((a, b) => b.score - a.score);
        const rankTotal = ranked.length;
        ranked.forEach((item, idx) => {
          const entry = data[item.ticker];
          if (!entry) return;
          entry.rank_position = idx + 1;
          entry.rank_total = rankTotal;
          entry.rank_score = item.score;
        });

        const responseData = {
          ok: true,
          count: Object.keys(data).length,
          totalIndex: tickers.length,
          versionFiltered: versionFilteredCount,
          versionBreakdown: versionBreakdown,
          dataVersion: storedVersion,
          requestedVersion: requestedVersion || "latest",
          versionsSeen: Array.from(versionsSeen),
          acceptedVersions: Array.from(acceptedVersions),
          currentDataVersion: CURRENT_DATA_VERSION,
          data,
          cached_at: Date.now(),
        };
        
        // Cache the response for future requests (background write, don't await)
        ctx.waitUntil(kvPutJSON(KV, "timed:all:cache", responseData));
        
        return sendJSON(responseData, 200, corsHeaders(env, req));
        */
        // END OF REMOVED ON-DEMAND COMPUTATION CODE
      }

      // GET /timed/candles?ticker=&tf=&limit=
      if (url.pathname === "/timed/candles" && req.method === "GET") {
        try {
          const ip = req.headers.get("CF-Connecting-IP") || "unknown";
          const rateLimit = await checkRateLimitFixedWindow(
            KV,
            ip,
            "/timed/candles",
            20000,
            3600,
          );
          if (!rateLimit.allowed) {
            const retryAfter = Math.max(
              1,
              Math.ceil((rateLimit.resetAt - Date.now()) / 1000),
            );
            return sendJSON(
              { ok: false, error: "rate_limit_exceeded", retryAfter },
              429,
              {
                ...corsHeaders(env, req),
                "Retry-After": String(retryAfter),
                "X-RateLimit-Limit": String(rateLimit.limit ?? 20000),
                "X-RateLimit-Remaining": "0",
                "X-RateLimit-Reset": String(rateLimit.resetAt),
              },
            );
          }

          const ticker = normTicker(url.searchParams.get("ticker"));
          const tf = url.searchParams.get("tf");
          const limitRaw = url.searchParams.get("limit");
          const limit =
            limitRaw != null && limitRaw !== "" ? Number(limitRaw) : 200;
          if (!ticker || !tf) {
            return sendJSON(
              { ok: false, error: "missing ticker/tf" },
              400,
              corsHeaders(env, req),
            );
          }

          const res = await d1GetCandles(env, ticker, tf, limit);
          if (!res?.ok) {
            return sendJSON(
              { ok: false, error: res?.error || "candles_read_failed" },
              500,
              corsHeaders(env, req),
            );
          }
          return sendJSON(res, 200, corsHeaders(env, req));
        } catch (e) {
          console.error(`[CANDLES] /timed/candles failed:`, String(e));
          return sendJSON(
            { ok: false, error: "internal_error" },
            500,
            corsHeaders(env, req),
          );
        }
      }

      // GET /timed/trail?ticker=
      if (url.pathname === "/timed/trail" && req.method === "GET") {
        try {
          // Rate limiting
          const ip = req.headers.get("CF-Connecting-IP") || "unknown";
          const rateLimit = await checkRateLimitFixedWindow(
            KV,
            ip,
            "/timed/trail",
            20000, // Higher limit: UI may fetch many tickers' trails
            3600,
          );

          if (!rateLimit.allowed) {
            const retryAfter = Math.max(
              1,
              Math.ceil((rateLimit.resetAt - Date.now()) / 1000),
            );
            return sendJSON(
              { ok: false, error: "rate_limit_exceeded", retryAfter },
              429,
              {
                ...corsHeaders(env, req),
                "Retry-After": String(retryAfter),
                "X-RateLimit-Limit": String(rateLimit.limit ?? 20000),
                "X-RateLimit-Remaining": "0",
                "X-RateLimit-Reset": String(rateLimit.resetAt),
              },
            );
          }

          const ticker = normTicker(url.searchParams.get("ticker"));
          if (!ticker) {
            return sendJSON(
              { ok: false, error: "missing ticker" },
              400,
              corsHeaders(env, req),
            );
          }

          const sinceRaw = url.searchParams.get("since");
          const limitRaw = url.searchParams.get("limit");
          const since =
            sinceRaw != null && sinceRaw !== "" ? Number(sinceRaw) : null;
          const limit =
            limitRaw != null && limitRaw !== "" ? Number(limitRaw) : 5000;

          // Prefer D1 for longer history, but fall back to KV if D1 is empty/sparse.
          const d1Result = await d1GetTrailRange(env, ticker, since, limit);
          const d1Trail =
            d1Result && Array.isArray(d1Result.trail) ? d1Result.trail : [];

          // KV (rolling window) — also used as fallback when D1 is sparse.
          let kvTrail = [];
          try {
            kvTrail = (await kvGetJSON(KV, `timed:trail:${ticker}`)) || [];
            if (!Array.isArray(kvTrail)) kvTrail = [];
          } catch (kvError) {
            console.error(`[TRAIL] KV read error for ${ticker}:`, kvError);
            kvTrail = [];
          }

          if (since != null && Number.isFinite(since)) {
            kvTrail = kvTrail.filter((p) => Number(p?.ts) >= since);
          }

          // IMPORTANT:
          // D1 can be "ok" but still return very few rows (e.g. not backfilled / intermittent writes),
          // while KV may still have a healthy recent window. If D1 is sparse and KV is richer,
          // return KV so the UI can render a usable trail.
          if (d1Result.ok && d1Trail.length > 0) {
            const d1IsSparse = d1Trail.length < 2;
            const kvIsRicher = kvTrail.length > d1Trail.length;
            if (!d1IsSparse || !kvIsRicher) {
              return sendJSON(
                {
                  ok: true,
                  ticker,
                  trail: d1Trail,
                  count: d1Trail.length,
                  source: d1Result.source,
                },
                200,
                {
                  ...corsHeaders(env, req),
                  "X-RateLimit-Limit": String(rateLimit.limit ?? 20000),
                  "X-RateLimit-Remaining": String(rateLimit.remaining ?? 0),
                  "X-RateLimit-Reset": String(rateLimit.resetAt ?? Date.now()),
                },
              );
            }
          }

          // KV response (either fallback, or D1 is sparse/unavailable)
          const trail = kvTrail;

          return sendJSON(
            {
              ok: true,
              ticker,
              trail,
              count: trail.length,
              source: "kv",
              note: d1Result.ok
                ? d1Trail.length > 0
                  ? `D1 returned sparse rows (${d1Trail.length}) — using KV recent window`
                  : "D1 returned 0 rows (falling back to KV)"
                : d1Result.skipped
                  ? `D1 unavailable (${d1Result.reason || "unknown"})`
                  : d1Result.error
                    ? `D1 error (${d1Result.error})`
                    : "D1 unavailable",
            },
            200,
            {
              ...corsHeaders(env, req),
              "X-RateLimit-Limit": String(rateLimit.limit ?? 20000),
              "X-RateLimit-Remaining": String(rateLimit.remaining ?? 0),
              "X-RateLimit-Reset": String(rateLimit.resetAt ?? Date.now()),
            },
          );
        } catch (error) {
          console.error(`[TRAIL] Unexpected error:`, error);
          // Return empty trail instead of 500 error
          const ticker =
            normTicker(url.searchParams.get("ticker")) || "UNKNOWN";
          return sendJSON(
            { ok: true, ticker, trail: [], count: 0, source: "error" },
            200,
            corsHeaders(env, req),
          );
        }
      }

      // GET /timed/top?bucket=long|short|setup&n=10
      if (url.pathname === "/timed/top" && req.method === "GET") {
        const n = Math.max(
          1,
          Math.min(50, Number(url.searchParams.get("n") || "10")),
        );
        const bucket = String(
          url.searchParams.get("bucket") || "long",
        ).toLowerCase();
        const tickers = (await kvGetJSON(KV, "timed:tickers")) || [];

        const items = [];
        for (const t of tickers) {
          const d = await kvGetJSON(KV, `timed:latest:${t}`);
          if (d) items.push(d);
        }

        // IMPORTANT: Top lists should favor corridor relevance for "long/short" tabs.
        // long bucket shows Q2 (bull aligned), short shows Q3 (bear aligned), setup shows Q1/Q4.
        const isLongAligned = (d) => d.state === "HTF_BULL_LTF_BULL";
        const isShortAligned = (d) => d.state === "HTF_BEAR_LTF_BEAR";
        const isSetup = (d) =>
          d.state === "HTF_BULL_LTF_PULLBACK" ||
          d.state === "HTF_BEAR_LTF_PULLBACK";

        let filtered =
          bucket === "long"
            ? items.filter(isLongAligned)
            : bucket === "short"
              ? items.filter(isShortAligned)
              : items.filter(isSetup);

        filtered.sort((a, b) => Number(b.rank || 0) - Number(a.rank || 0));
        filtered = filtered.slice(0, n);

        return sendJSON(
          { ok: true, bucket, n: filtered.length, data: filtered },
          200,
          corsHeaders(env, req),
        );
      }

      // GET /timed/momentum?ticker=XYZ
      if (url.pathname === "/timed/momentum" && req.method === "GET") {
        // Rate limiting
        const ip = req.headers.get("CF-Connecting-IP") || "unknown";
        const rateLimit = await checkRateLimit(
          KV,
          ip,
          "/timed/momentum",
          1000, // Increased for single-user
          3600,
        );

        if (!rateLimit.allowed) {
          return sendJSON(
            { ok: false, error: "rate_limit_exceeded", retryAfter: 3600 },
            429,
            corsHeaders(env, req),
          );
        }

        const ticker = normTicker(url.searchParams.get("ticker"));
        if (!ticker)
          return sendJSON(
            { ok: false, error: "missing ticker" },
            400,
            corsHeaders(env, req),
          );
        let data = await kvGetJSON(KV, `timed:momentum:${ticker}`);
        if (!data) {
          // On-demand compute using latest + capture enrichment (avoids waiting for next cache fill).
          try {
            const latest = await kvGetJSON(KV, `timed:latest:${ticker}`);
            const capture = await kvGetJSON(
              KV,
              `timed:capture:latest:${ticker}`,
            );
            const base =
              latest && typeof latest === "object" ? { ...latest } : {};
            if (capture && typeof capture === "object") {
              for (const k of [
                "avg_vol_30",
                "avg_vol_50",
                "adr_14",
                "momentum_pct",
                "price",
              ]) {
                if (base[k] == null && capture[k] != null) base[k] = capture[k];
              }
            }
            if (base && Object.keys(base).length > 0) {
              data = await computeMomentumElite(KV, ticker, base);
            }
          } catch {
            // ignore
          }
        }
        return sendJSON({ ok: true, ticker, data }, 200, corsHeaders(env, req));
      }

      // GET /timed/momentum/history?ticker=XYZ
      if (url.pathname === "/timed/momentum/history" && req.method === "GET") {
        // Rate limiting
        const ip = req.headers.get("CF-Connecting-IP") || "unknown";
        const rateLimit = await checkRateLimit(
          KV,
          ip,
          "/timed/momentum/history",
          1000, // Increased for single-user
          3600,
        );

        if (!rateLimit.allowed) {
          return sendJSON(
            { ok: false, error: "rate_limit_exceeded", retryAfter: 3600 },
            429,
            corsHeaders(env, req),
          );
        }

        const ticker = normTicker(url.searchParams.get("ticker"));
        if (!ticker)
          return sendJSON(
            { ok: false, error: "missing ticker" },
            400,
            corsHeaders(env, req),
          );
        const history =
          (await kvGetJSON(KV, `timed:momentum:history:${ticker}`)) || [];
        return sendJSON(
          { ok: true, ticker, history },
          200,
          corsHeaders(env, req),
        );
      }

      // GET /timed/momentum/all
      if (url.pathname === "/timed/momentum/all" && req.method === "GET") {
        // Rate limiting
        const ip = req.headers.get("CF-Connecting-IP") || "unknown";
        const rateLimit = await checkRateLimit(
          KV,
          ip,
          "/timed/momentum/all",
          1000, // Increased for single-user
          3600,
        );

        if (!rateLimit.allowed) {
          return sendJSON(
            { ok: false, error: "rate_limit_exceeded", retryAfter: 3600 },
            429,
            corsHeaders(env, req),
          );
        }

        const tickers = (await kvGetJSON(KV, "timed:tickers")) || [];
        const eliteTickers = [];
        for (const t of tickers) {
          const momentumData = await kvGetJSON(KV, `timed:momentum:${t}`);
          if (momentumData && momentumData.momentum_elite) {
            eliteTickers.push({ ticker: t, ...momentumData });
          }
        }
        return sendJSON(
          { ok: true, count: eliteTickers.length, tickers: eliteTickers },
          200,
          corsHeaders(env, req),
        );
      }

      // GET /timed/sectors - Get all sectors and their ratings
      if (url.pathname === "/timed/sectors" && req.method === "GET") {
        const sectors = getAllSectors().map((sector) => ({
          sector,
          ...getSectorRating(sector),
          tickerCount: getTickersInSector(sector).length,
        }));

        return sendJSON({ ok: true, sectors }, 200, corsHeaders(env, req));
      }

      // GET /timed/sectors/:sector/tickers?limit=10 - Get top tickers in a sector
      if (
        url.pathname.startsWith("/timed/sectors/") &&
        url.pathname.endsWith("/tickers") &&
        req.method === "GET"
      ) {
        const sectorPath = url.pathname
          .replace("/timed/sectors/", "")
          .replace("/tickers", "");
        const sector = decodeURIComponent(sectorPath);
        const limit = Math.max(
          1,
          Math.min(50, Number(url.searchParams.get("limit") || "10")),
        );

        if (!getAllSectors().includes(sector)) {
          return sendJSON(
            { ok: false, error: `Invalid sector: ${sector}` },
            400,
            corsHeaders(env, req),
          );
        }

        const topTickers = await rankTickersInSector(KV, sector, limit);

        return sendJSON(
          {
            ok: true,
            sector,
            rating: getSectorRating(sector),
            limit: topTickers.length,
            tickers: topTickers,
          },
          200,
          corsHeaders(env, req),
        );
      }

      // GET /timed/sectors/recommendations?limit=10 - Get top tickers across all overweight sectors
      if (
        url.pathname === "/timed/sectors/recommendations" &&
        req.method === "GET"
      ) {
        const limitPerSector = Math.max(
          1,
          Math.min(20, Number(url.searchParams.get("limit") || "10")),
        );
        const totalLimit = Math.max(
          1,
          Math.min(100, Number(url.searchParams.get("totalLimit") || "50")),
        );

        const overweightSectors = getAllSectors().filter(
          (sector) => getSectorRating(sector).rating === "overweight",
        );

        const allRecommendations = [];

        for (const sector of overweightSectors) {
          const topTickers = await rankTickersInSector(
            KV,
            sector,
            limitPerSector,
          );
          allRecommendations.push(
            ...topTickers.map((t) => ({
              ...t,
              sector,
            })),
          );
        }

        // Sort by boosted rank and take top N
        allRecommendations.sort((a, b) => b.boostedRank - a.boostedRank);
        const topRecommendations = allRecommendations.slice(0, totalLimit);

        return sendJSON(
          {
            ok: true,
            sectors: overweightSectors,
            limitPerSector,
            totalLimit: topRecommendations.length,
            recommendations: topRecommendations,
          },
          200,
          corsHeaders(env, req),
        );
      }

      // POST /timed/debug/migrate-brk?key=... - Migrate BRK.B to BRK-B
      if (
        url.pathname === "/timed/debug/migrate-brk" &&
        req.method === "POST"
      ) {
        const authFail = requireKeyOr401(req, env);
        if (authFail) return authFail;

        try {
          const oldData = await kvGetJSON(KV, `timed:latest:BRK.B`);
          const newData = await kvGetJSON(KV, `timed:latest:BRK-B`);

          if (!oldData && !newData) {
            return sendJSON(
              { ok: false, error: "No BRK data found" },
              404,
              corsHeaders(env, req),
            );
          }

          // Use newer data if both exist
          const dataToUse =
            oldData && newData && newData.ts > oldData.ts
              ? newData
              : oldData || newData;
          const migrated = !!oldData && oldData !== dataToUse;

          await kvPutJSON(KV, `timed:latest:BRK-B`, dataToUse);

          // Migrate trail data
          const oldTrail = await kvGetJSON(KV, `timed:trail:BRK.B`);
          const newTrail = await kvGetJSON(KV, `timed:trail:BRK-B`);
          if (oldTrail || newTrail) {
            await kvPutJSON(KV, `timed:trail:BRK-B`, oldTrail || newTrail);
          }

          // Ensure BRK-B is in index
          await ensureTickerIndex(KV, "BRK-B");

          // Remove BRK.B from index if it exists
          let tickers = (await kvGetJSON(KV, "timed:tickers")) || [];
          if (tickers.includes("BRK.B")) {
            tickers = tickers.filter((t) => t !== "BRK.B");
            await kvPutJSON(KV, "timed:tickers", tickers);
          }

          // Delete old BRK.B data if we migrated
          if (migrated) {
            await KV.delete(`timed:latest:BRK.B`);
            await KV.delete(`timed:trail:BRK.B`);
          }

          return sendJSON(
            {
              ok: true,
              message: "BRK migration completed",
              hadOldData: !!oldData,
              hadNewData: !!newData,
              migrated,
              finalTicker: "BRK-B",
              ts: dataToUse?.ts,
              htf_score: dataToUse?.htf_score,
              ltf_score: dataToUse?.ltf_score,
            },
            200,
            corsHeaders(env, req),
          );
        } catch (err) {
          console.error(`[MIGRATE BRK ERROR]`, {
            error: String(err),
            message: err.message,
            stack: err.stack,
          });
          return sendJSON(
            { ok: false, error: "internal_error", message: err.message },
            500,
            corsHeaders(env, req),
          );
        }
      }

      // POST /timed/debug/cleanup-duplicates?key=... - Remove duplicate/empty tickers from index
      if (
        url.pathname === "/timed/debug/cleanup-duplicates" &&
        req.method === "POST"
      ) {
        const authFail = requireKeyOr401(req, env);
        if (authFail) return authFail;

        try {
          const tickers = (await kvGetJSON(KV, "timed:tickers")) || [];
          const duplicatesToRemove = [
            "BTC", // Duplicate of BTCUSD (BTCUSD has data)
            "ES", // Duplicate of ES1! (ES1! has data)
            "ETH", // Duplicate of ETHUSD (ETHUSD has data)
            "NQ", // Duplicate of NQ1! (NQ1! has data)
            "MES1!", // Not sending data
            "MNQ1!", // Not sending data
            "RTY1!", // Not sending data
            "YM1!", // Not sending data
          ];

          const removed = [];
          const notFound = [];
          const hasData = [];

          for (const ticker of duplicatesToRemove) {
            if (!tickers.includes(ticker)) {
              notFound.push(ticker);
              continue;
            }

            // Check if ticker has data
            const data = await kvGetJSON(KV, `timed:latest:${ticker}`);
            if (
              data &&
              (data.htf_score !== undefined || data.ltf_score !== undefined)
            ) {
              hasData.push(ticker);
              continue; // Don't remove if it has data
            }

            // Remove from index
            removed.push(ticker);

            // Also delete the data if it exists (even without scores)
            await KV.delete(`timed:latest:${ticker}`);
            await KV.delete(`timed:trail:${ticker}`);
          }

          // Update index once after processing all removals
          if (removed.length > 0) {
            const updatedTickers = tickers.filter((t) => !removed.includes(t));
            updatedTickers.sort();
            await kvPutJSON(KV, "timed:tickers", updatedTickers);
          }

          const finalTickers = (await kvGetJSON(KV, "timed:tickers")) || [];

          return sendJSON(
            {
              ok: true,
              message: "Cleanup completed",
              removed,
              notFound,
              hasData,
              beforeCount: tickers.length,
              afterCount: finalTickers.length,
              removedCount: removed.length,
            },
            200,
            corsHeaders(env, req),
          );
        } catch (err) {
          return sendJSON(
            { ok: false, error: err.message },
            500,
            corsHeaders(env, req),
          );
        }
      }

      // POST /timed/debug/fix-index?key=...&ticker=BMNR - Manually add ticker to index if data exists
      if (url.pathname === "/timed/debug/fix-index" && req.method === "POST") {
        const authFail = requireKeyOr401(req, env);
        if (authFail) return authFail;

        // Allow requests without origin for debug endpoints (curl, direct API calls)
        const cors = corsHeaders(env, req, true);

        try {
          const ticker = normTicker(url.searchParams.get("ticker"));
          if (!ticker) {
            return sendJSON(
              { ok: false, error: "ticker parameter required" },
              400,
              cors,
            );
          }

          // Check if data exists in KV
          const data = await kvGetJSON(KV, `timed:latest:${ticker}`);
          const inIndex = (await kvGetJSON(KV, "timed:tickers")) || [];
          const alreadyInIndex = inIndex.includes(ticker);

          if (!data) {
            return sendJSON(
              {
                ok: false,
                error: "ticker data not found in KV",
                ticker,
                inIndex: alreadyInIndex,
              },
              404,
              cors,
            );
          }

          // Add to index if not already there
          if (!alreadyInIndex) {
            await ensureTickerIndex(KV, ticker);
            const updatedIndex = (await kvGetJSON(KV, "timed:tickers")) || [];
            const nowInIndex = updatedIndex.includes(ticker);

            return sendJSON(
              {
                ok: true,
                message: `Ticker ${ticker} ${
                  nowInIndex ? "added to" : "failed to add to"
                } index`,
                ticker,
                hadData: true,
                wasInIndex: false,
                nowInIndex,
                indexSize: updatedIndex.length,
              },
              200,
              cors,
            );
          } else {
            return sendJSON(
              {
                ok: true,
                message: `Ticker ${ticker} already in index`,
                ticker,
                hadData: true,
                inIndex: true,
                indexSize: inIndex.length,
              },
              200,
              cors,
            );
          }
        } catch (err) {
          return sendJSON({ ok: false, error: err.message }, 500, cors);
        }
      }

      // POST /timed/watchlist/add?key=... - Add tickers to watchlist
      if (url.pathname === "/timed/watchlist/add" && req.method === "POST") {
        const authFail = requireKeyOr401(req, env);
        if (authFail) return authFail;

        try {
          const { obj: body } = await readBodyAsJSON(req);
          const tickersToAdd = body.tickers || [];

          if (!Array.isArray(tickersToAdd) || tickersToAdd.length === 0) {
            return sendJSON(
              { ok: false, error: "tickers array required" },
              400,
              corsHeaders(env, req),
            );
          }

          const currentTickers = (await kvGetJSON(KV, "timed:tickers")) || [];
          const added = [];
          const alreadyExists = [];

          for (const ticker of tickersToAdd) {
            const tickerUpper = String(ticker).toUpperCase().trim();
            if (!tickerUpper) continue;

            if (!currentTickers.includes(tickerUpper)) {
              currentTickers.push(tickerUpper);
              added.push(tickerUpper);
              await ensureTickerIndex(KV, tickerUpper);
            } else {
              alreadyExists.push(tickerUpper);
            }
          }

          // Sort and save
          currentTickers.sort();
          await kvPutJSON(KV, "timed:tickers", currentTickers);

          return sendJSON(
            {
              ok: true,
              added: added.length,
              alreadyExists: alreadyExists.length,
              addedTickers: added,
              alreadyExistsTickers: alreadyExists,
              totalTickers: currentTickers.length,
            },
            200,
            corsHeaders(env, req),
          );
        } catch (err) {
          return sendJSON(
            { ok: false, error: err.message },
            500,
            corsHeaders(env, req),
          );
        }
      }

      // GET /timed/activity
      if (url.pathname === "/timed/activity" && req.method === "GET") {
        const feed = (await kvGetJSON(KV, "timed:activity:feed")) || [];

        const now = Date.now();
        const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000;
        const currentEvents = [];

        // Merge feed events with current events, deduplicate by ticker+type
        const allEvents = [...feed, ...currentEvents];
        const seen = new Set();
        const uniqueEvents = allEvents.filter((e) => {
          const key = `${e.ticker}-${e.type}-${Math.floor(
            e.ts / (60 * 60 * 1000),
          )}`; // Group by hour
          if (seen.has(key)) return false;
          seen.add(key);
          return e.ts > oneWeekAgo; // Only keep events from last week
        });

        // Sort by timestamp descending
        uniqueEvents.sort((a, b) => b.ts - a.ts);

        const limit = Math.min(
          100,
          Number(url.searchParams.get("limit") || "100"),
        );
        const filtered = uniqueEvents.slice(0, limit);

        return sendJSON(
          {
            ok: true,
            count: filtered.length,
            events: filtered,
          },
          200,
          corsHeaders(env, req),
        );
      }

      // GET /timed/check-ticker?ticker=AAPL
      if (url.pathname === "/timed/check-ticker" && req.method === "GET") {
        const ticker = url.searchParams.get("ticker");
        if (!ticker) {
          return sendJSON(
            { ok: false, error: "ticker parameter required" },
            400,
            corsHeaders(env, req),
          );
        }

        const tickerUpper = ticker.toUpperCase();
        const tickers = (await kvGetJSON(KV, "timed:tickers")) || [];
        const inIndex = tickers.includes(tickerUpper);
        const latest = await kvGetJSON(KV, `timed:latest:${tickerUpper}`);
        const trail = await kvGetJSON(KV, `timed:trail:${tickerUpper}`);

        // Capture-only channel (some TV alerts may be wired to /timed/ingest-capture)
        const captureTickers =
          (await kvGetJSON(KV, "timed:capture:tickers")) || [];
        const inCaptureIndex = Array.isArray(captureTickers)
          ? captureTickers.includes(tickerUpper)
          : false;
        const captureLatest = await kvGetJSON(
          KV,
          `timed:capture:latest:${tickerUpper}`,
        );
        const captureTrail = await kvGetJSON(
          KV,
          `timed:capture:trail:${tickerUpper}`,
        );

        // Raw payload breadcrumbs (last seen) to identify which endpoint is receiving data.
        // NOTE: truncated for safety/size.
        const ingestRawKey = `timed:ingest:raw:${tickerUpper}`;
        const captureRawKey = `timed:capture:raw:${tickerUpper}`;
        const ingestRaw = await KV.get(ingestRawKey);
        const captureRaw = await KV.get(captureRawKey);
        const ingestRawSample = ingestRaw
          ? String(ingestRaw).slice(0, 500)
          : null;
        const captureRawSample = captureRaw
          ? String(captureRaw).slice(0, 500)
          : null;

        const latestTs =
          latest?.ingest_ts ?? latest?.ingest_time ?? latest?.ts ?? null;
        const captureTs =
          captureLatest?.ingest_ts ??
          captureLatest?.ingest_time ??
          captureLatest?.ts ??
          null;
        const likelyCaptureOnly = !!captureLatest && !latest && inCaptureIndex;

        return sendJSON(
          {
            ok: true,
            ticker: tickerUpper,
            inIndex,
            hasLatest: !!latest,
            hasTrail: !!trail,
            latestData: latest || null,
            trailLength: trail ? trail.length : 0,
            inCaptureIndex,
            hasCaptureLatest: !!captureLatest,
            hasCaptureTrail: !!captureTrail,
            captureLatestData: captureLatest || null,
            captureTrailLength: captureTrail ? captureTrail.length : 0,
            debug: {
              latestTs,
              captureTs,
              likelyCaptureOnly,
              raw: {
                ingestRawPresent: !!ingestRaw,
                captureRawPresent: !!captureRaw,
                ingestRawSample,
                captureRawSample,
              },
            },
          },
          200,
          corsHeaders(env, req),
        );
      }

      // GET /timed/ingest-status
      if (url.pathname === "/timed/ingest-status" && req.method === "GET") {
        try {
          const now = new Date();
          const result = await checkIngestCoverage(KV, now);
          return sendJSON(
            {
              ok: true,
              marketHoursET: isMarketHoursET(now),
              checked: result.checked || 0,
              missing: result.missing || [],
            },
            200,
            corsHeaders(env, req),
          );
        } catch (err) {
          return sendJSON(
            { ok: false, error: String(err?.message || err) },
            500,
            corsHeaders(env, req),
          );
        }
      }

      // GET /timed/ingestion/stats?since&until&bucketMin
      // Coverage = distinct(ticker,bucket) / (watchlist_count * bucket_count)
      if (url.pathname === "/timed/ingestion/stats" && req.method === "GET") {
        const db = env?.DB;
        if (!db) {
          return sendJSON(
            { ok: false, error: "d1_not_configured" },
            503,
            corsHeaders(env, req),
          );
        }

        const now = Date.now();
        const since = numParam(url, "since", now - 6 * 60 * 60 * 1000);
        const until = numParam(url, "until", now);
        const bucketMin = Math.max(
          1,
          Math.floor(numParam(url, "bucketMin", 5)),
        );
        const bucketMs = bucketMin * 60 * 1000;
        const threshold = Math.max(
          0,
          Math.min(1, numParam(url, "threshold", 0.9)),
        );
        const basis = String(url.searchParams.get("basis") || "payload")
          .trim()
          .toLowerCase(); // payload|received

        if (
          !Number.isFinite(since) ||
          !Number.isFinite(until) ||
          until <= since
        ) {
          return sendJSON(
            { ok: false, error: "invalid_since_until" },
            400,
            corsHeaders(env, req),
          );
        }

        const tickers = (await kvGetJSON(KV, "timed:tickers")) || [];
        const watchlistCount = Array.isArray(tickers) ? tickers.length : 0;

        const bucketStart = Math.floor(since / bucketMs) * bucketMs;
        const bucketEnd = Math.floor(until / bucketMs) * bucketMs;
        const bucketCount =
          bucketEnd >= bucketStart
            ? Math.floor((bucketEnd - bucketStart) / bucketMs) + 1
            : 0;
        const expectedPairs = watchlistCount * bucketCount;

        const receiptsTotalRow = await db
          .prepare(
            `SELECT COUNT(*) AS n
             FROM ingest_receipts
             WHERE received_ts >= ?1 AND received_ts <= ?2`,
          )
          .bind(since, until)
          .first();

        const distinctPairsRow = await db
          .prepare(
            basis === "received"
              ? `SELECT COUNT(DISTINCT ticker || ':' || (CAST(received_ts / ?1 AS INTEGER) * ?1)) AS n
                 FROM ingest_receipts
                 WHERE received_ts >= ?2 AND received_ts <= ?3`
              : `SELECT COUNT(DISTINCT ticker || ':' || (CAST(ts / ?1 AS INTEGER) * ?1)) AS n
                 FROM ingest_receipts
                 WHERE received_ts >= ?2 AND received_ts <= ?3`,
          )
          .bind(bucketMs, since, until)
          .first();

        const receiptsTotal = Number(receiptsTotalRow?.n) || 0;
        const distinctPairs = Number(distinctPairsRow?.n) || 0;
        const coverage =
          expectedPairs > 0 ? distinctPairs / expectedPairs : null;

        return sendJSON(
          {
            ok: true,
            window: {
              since,
              until,
              bucketMin,
              bucketMs,
              bucketStart,
              bucketEnd,
              bucketCount,
            },
            basis,
            watchlistCount,
            expectedPairs,
            receiptsTotal,
            distinctPairs,
            coveragePct:
              coverage == null ? null : Math.round(coverage * 10000) / 100,
            meetsThreshold: coverage == null ? null : coverage >= threshold,
            thresholdPct: Math.round(threshold * 10000) / 100,
          },
          200,
          corsHeaders(env, req),
        );
      }

      // GET /timed/watchlist/coverage?since&until&bucketMin&threshold
      // Per-ticker coverage across expected buckets (uses ingest_receipts)
      if (
        url.pathname === "/timed/watchlist/coverage" &&
        req.method === "GET"
      ) {
        const db = env?.DB;
        if (!db) {
          return sendJSON(
            { ok: false, error: "d1_not_configured" },
            503,
            corsHeaders(env, req),
          );
        }

        const now = Date.now();
        const since = numParam(url, "since", now - 6 * 60 * 60 * 1000);
        const until = numParam(url, "until", now);
        const bucketMin = Math.max(
          1,
          Math.floor(numParam(url, "bucketMin", 5)),
        );
        const bucketMs = bucketMin * 60 * 1000;
        const threshold = Math.max(
          0,
          Math.min(1, numParam(url, "threshold", 0.9)),
        );
        const basis = String(url.searchParams.get("basis") || "payload")
          .trim()
          .toLowerCase(); // payload|received

        if (
          !Number.isFinite(since) ||
          !Number.isFinite(until) ||
          until <= since
        ) {
          return sendJSON(
            { ok: false, error: "invalid_since_until" },
            400,
            corsHeaders(env, req),
          );
        }

        const tickers = (await kvGetJSON(KV, "timed:tickers")) || [];
        const list = Array.isArray(tickers)
          ? tickers
              .map((t) =>
                String(t || "")
                  .trim()
                  .toUpperCase(),
              )
              .filter(Boolean)
          : [];

        const bucketStart = Math.floor(since / bucketMs) * bucketMs;
        const bucketEnd = Math.floor(until / bucketMs) * bucketMs;
        const bucketCount =
          bucketEnd >= bucketStart
            ? Math.floor((bucketEnd - bucketStart) / bucketMs) + 1
            : 0;

        const rows = await db
          .prepare(
            basis === "received"
              ? `SELECT
                  ticker,
                  COUNT(DISTINCT (CAST(received_ts / ?1 AS INTEGER) * ?1)) AS seen_buckets
                 FROM ingest_receipts
                 WHERE received_ts >= ?2 AND received_ts <= ?3
                 GROUP BY ticker`
              : `SELECT
                  ticker,
                  COUNT(DISTINCT (CAST(ts / ?1 AS INTEGER) * ?1)) AS seen_buckets
                 FROM ingest_receipts
                 WHERE received_ts >= ?2 AND received_ts <= ?3
                 GROUP BY ticker`,
          )
          .bind(bucketMs, since, until)
          .all();

        const seenByTicker = new Map();
        for (const r of rows?.results || []) {
          const t = String(r.ticker || "").toUpperCase();
          const n = Number(r.seen_buckets) || 0;
          if (t) seenByTicker.set(t, n);
        }

        const perTicker = list.map((t) => {
          const seen = seenByTicker.get(t) || 0;
          const pct = bucketCount > 0 ? seen / bucketCount : 0;
          return {
            ticker: t,
            seenBuckets: seen,
            expectedBuckets: bucketCount,
            coveragePct: bucketCount > 0 ? Math.round(pct * 10000) / 100 : null,
            meetsThreshold: bucketCount > 0 ? pct >= threshold : null,
          };
        });

        const tickersTotal = perTicker.length;
        const tickersAny = perTicker.filter(
          (t) => (t.seenBuckets || 0) > 0,
        ).length;
        const tickersMeet = perTicker.filter(
          (t) => t.meetsThreshold === true,
        ).length;

        // Sort “worst first” to make it easy to spot dropouts
        perTicker.sort((a, b) => (a.coveragePct ?? 0) - (b.coveragePct ?? 0));

        return sendJSON(
          {
            ok: true,
            window: {
              since,
              until,
              bucketMin,
              bucketMs,
              bucketStart,
              bucketEnd,
              bucketCount,
            },
            basis,
            thresholdPct: Math.round(threshold * 10000) / 100,
            summary: {
              tickersTotal,
              tickersAny,
              pctTickersAny:
                tickersTotal > 0
                  ? Math.round((tickersAny / tickersTotal) * 10000) / 100
                  : null,
              tickersMeet,
              pctTickersMeet:
                tickersTotal > 0
                  ? Math.round((tickersMeet / tickersTotal) * 10000) / 100
                  : null,
            },
            worst: perTicker.slice(0, 25),
          },
          200,
          corsHeaders(env, req),
        );
      }

      // GET /timed/ingest-audit?since&until&bucket&ticker&includeKv&scriptVersion
      if (url.pathname === "/timed/ingest-audit" && req.method === "GET") {
        const db = env?.DB;
        if (!db) {
          return sendJSON(
            { ok: false, error: "d1_not_configured" },
            503,
            corsHeaders(env, req),
          );
        }

        const sinceRaw = url.searchParams.get("since");
        const untilRaw = url.searchParams.get("until");
        const bucketRaw = url.searchParams.get("bucket");
        const tickerParam = normTicker(url.searchParams.get("ticker"));
        const includeKv = url.searchParams.get("includeKv") === "1";
        const scriptVersion = url.searchParams.get("scriptVersion");

        const now = Date.now();
        const since =
          sinceRaw != null && sinceRaw !== ""
            ? Number(sinceRaw)
            : now - 6 * 60 * 60 * 1000;
        const until =
          untilRaw != null && untilRaw !== "" ? Number(untilRaw) : now;
        const bucketMin = Math.max(1, Number(bucketRaw) || 5);
        const bucketMs = bucketMin * 60 * 1000;

        if (
          !Number.isFinite(since) ||
          !Number.isFinite(until) ||
          until <= since
        ) {
          return sendJSON(
            { ok: false, error: "invalid_since_until" },
            400,
            corsHeaders(env, req),
          );
        }

        const tickers = tickerParam
          ? [tickerParam]
          : (await kvGetJSON(KV, "timed:tickers")) || [];

        const expectedBuckets = [];
        for (let t = since; t <= until; t += bucketMs) {
          expectedBuckets.push(Math.floor(t / bucketMs) * bucketMs);
        }

        const receiptRows = await db
          .prepare(
            `SELECT
              ticker,
              (ts / ?1) * ?1 AS bucket,
              COUNT(*) AS cnt
             FROM ingest_receipts
             WHERE ts >= ?2 AND ts <= ?3
             ${scriptVersion ? "AND script_version = ?4" : ""}
             ${tickerParam ? `AND ticker = ?${scriptVersion ? 5 : 4}` : ""}
             GROUP BY ticker, bucket`,
          )
          .bind(
            bucketMs,
            since,
            until,
            ...(scriptVersion ? [scriptVersion] : []),
            ...(tickerParam ? [tickerParam] : []),
          )
          .all();

        const trailRows = await db
          .prepare(
            `SELECT
              ticker,
              (ts / ?1) * ?1 AS bucket,
              COUNT(*) AS cnt
             FROM timed_trail
             WHERE ts >= ?2 AND ts <= ?3
             ${tickerParam ? "AND ticker = ?4" : ""}
             GROUP BY ticker, bucket`,
          )
          .bind(bucketMs, since, until, ...(tickerParam ? [tickerParam] : []))
          .all();

        const receiptMap = new Map();
        for (const row of receiptRows?.results || []) {
          const t = String(row.ticker || "").toUpperCase();
          if (!receiptMap.has(t)) receiptMap.set(t, new Set());
          receiptMap.get(t).add(Number(row.bucket));
        }

        const trailMap = new Map();
        for (const row of trailRows?.results || []) {
          const t = String(row.ticker || "").toUpperCase();
          if (!trailMap.has(t)) trailMap.set(t, new Set());
          trailMap.get(t).add(Number(row.bucket));
        }

        const kvMap = new Map();
        if (includeKv && tickerParam) {
          try {
            let kvTrail =
              (await kvGetJSON(KV, `timed:trail:${tickerParam}`)) || [];
            if (!Array.isArray(kvTrail)) kvTrail = [];
            const buckets = new Set();
            for (const point of kvTrail) {
              const ts = Number(point?.ts);
              if (!Number.isFinite(ts)) continue;
              if (ts < since || ts > until) continue;
              buckets.add(Math.floor(ts / bucketMs) * bucketMs);
            }
            kvMap.set(tickerParam, buckets);
          } catch (err) {
            console.error(`[INGEST AUDIT] KV trail read failed:`, err);
          }
        }

        const perTicker = tickers.map((t) => {
          const ticker = String(t || "").toUpperCase();
          const receiptBuckets = receiptMap.get(ticker) || new Set();
          const trailBuckets = trailMap.get(ticker) || new Set();
          const kvBuckets = kvMap.get(ticker) || null;

          const missingReceipts = expectedBuckets.filter(
            (b) => !receiptBuckets.has(b),
          );
          const missingTrail = expectedBuckets.filter(
            (b) => !trailBuckets.has(b),
          );
          const missingKv = kvBuckets
            ? expectedBuckets.filter((b) => !kvBuckets.has(b))
            : null;

          return {
            ticker,
            expectedBuckets: expectedBuckets.length,
            receiptBuckets: receiptBuckets.size,
            trailBucketsD1: trailBuckets.size,
            trailBucketsKV: kvBuckets ? kvBuckets.size : null,
            missingReceipts: missingReceipts.length,
            missingTrailD1: missingTrail.length,
            missingTrailKV: missingKv ? missingKv.length : null,
            missingReceiptSamples: missingReceipts.slice(0, 20),
            missingTrailSamples: missingTrail.slice(0, 20),
            missingTrailKvSamples: missingKv ? missingKv.slice(0, 20) : null,
          };
        });

        return sendJSON(
          {
            ok: true,
            since,
            until,
            bucketMinutes: bucketMin,
            tickers: tickers.length,
            includeKv: includeKv && !!tickerParam,
            scriptVersion: scriptVersion || null,
            perTicker,
          },
          200,
          corsHeaders(env, req),
        );
      }

      // GET /timed/health
      if (url.pathname === "/timed/health" && req.method === "GET") {
        // Rate limiting
        const ip = req.headers.get("CF-Connecting-IP") || "unknown";
        const rateLimit = await checkRateLimit(
          KV,
          ip,
          "/timed/health",
          500,
          3600,
        ); // Increased for single-user

        if (!rateLimit.allowed) {
          return sendJSON(
            { ok: false, error: "rate_limit_exceeded", retryAfter: 3600 },
            429,
            corsHeaders(env, req),
          );
        }

        const last = Number(await KV.get("timed:last_ingest_ms")) || 0;
        const captureLast =
          Number(await KV.get("timed:capture:last_ingest_ms")) || 0;
        const tickers = (await kvGetJSON(KV, "timed:tickers")) || [];
        const captureTickers =
          (await kvGetJSON(KV, "timed:capture:tickers")) || [];
        const storedVersion = await getStoredVersion(KV);
        return sendJSON(
          {
            ok: true,
            now: Date.now(),
            lastIngestMs: last,
            minutesSinceLast: last ? (Date.now() - last) / 60000 : null,
            captureLastIngestMs: captureLast,
            captureMinutesSinceLast: captureLast
              ? (Date.now() - captureLast) / 60000
              : null,
            tickers: tickers.length,
            captureTickers: Array.isArray(captureTickers)
              ? captureTickers.length
              : 0,
            dataVersion: storedVersion || "none",
            expectedVersion: CURRENT_DATA_VERSION,
          },
          200,
          corsHeaders(env, req),
        );
      }

      // POST /timed/purge?key=... (Manual purge endpoint)
      if (url.pathname === "/timed/purge" && req.method === "POST") {
        const authFail = requireKeyOr401(req, env);
        if (authFail) return authFail;

        const result = await purgeOldData(KV);
        await setStoredVersion(KV, CURRENT_DATA_VERSION);

        return sendJSON(
          {
            ok: true,
            message: "Data purged successfully",
            purged: result.purged,
            tickerCount: result.tickerCount,
            version: CURRENT_DATA_VERSION,
          },
          200,
          corsHeaders(env, req),
        );
      }

      // POST /timed/cleanup-no-scores?key=... (Remove tickers without score data from index)
      if (
        url.pathname === "/timed/cleanup-no-scores" &&
        req.method === "POST"
      ) {
        const authFail = requireKeyOr401(req, env);
        if (authFail) return authFail;

        const tickers = (await kvGetJSON(KV, "timed:tickers")) || [];
        const tickersToKeep = [];
        const tickersRemoved = [];

        for (const ticker of tickers) {
          const data = await kvGetJSON(KV, `timed:latest:${ticker}`);
          const hasScores =
            data &&
            (data.htf_score !== undefined || data.ltf_score !== undefined);

          if (hasScores) {
            tickersToKeep.push(ticker);
          } else {
            tickersRemoved.push(ticker);
            // Also clean up the latest data entry if it exists but has no scores
            await KV.delete(`timed:latest:${ticker}`);
          }
        }

        await kvPutJSON(KV, "timed:tickers", tickersToKeep);

        return sendJSON(
          {
            ok: true,
            message: `Cleaned up ${tickersRemoved.length} tickers without scores`,
            removed: tickersRemoved,
            kept: tickersToKeep.length,
            totalBefore: tickers.length,
            totalAfter: tickersToKeep.length,
          },
          200,
          corsHeaders(env, req),
        );
      }

      // POST /timed/rebuild-index?key=... (Rebuild ticker index from watchlist)
      if (url.pathname === "/timed/rebuild-index" && req.method === "POST") {
        const authFail = requireKeyOr401(req, env);
        if (authFail) return authFail;

        // Known ticker list from watchlists (Q1 2026 + Sectors)
        // This should match your TradingView watchlists
        const knownTickers = [
          "TSLA",
          "STX",
          "AU",
          "CCJ",
          "CLS",
          "CRS",
          "VST",
          "FSLR",
          "JCI",
          "ORCL",
          "AMZN",
          "BRK-B",
          "BABA",
          "WMT",
          "PH",
          "GEV",
          "HII",
          "ULTA",
          "SHOP",
          "CSX",
          "PWR",
          "HOOD",
          "SPGI",
          "APP",
          "PANW",
          "RDDT",
          "TT",
          "GLXY",
          "ETHA",
          "META",
          "NVDA",
          "AMD",
          "ANET",
          "GS",
          "TJX",
          "SOFI",
          "PNC",
          "PLTR",
          "NFLX",
          "MSTR",
          "MSFT",
          "MNST",
          "LRCX",
          "KLAC",
          "JPM",
          "GOOGL",
          "GE",
          "EXPE",
          "ETN",
          "EMR",
          "DE",
          "CRWD",
          "COST",
          "CDNS",
          "CAT",
          "BK",
          "AXP",
          "AXON",
          "AVGO",
          "AAPL",
          "RKLB",
          "LITE",
          "SN",
          "ALB",
          "RGLD",
          "MTZ",
          "ON",
          "ALLY",
          "DY",
          "EWBC",
          "PATH",
          "WFRD",
          "WAL",
          "IESC",
          "ENS",
          "TWLO",
          "MLI",
          "KTOS",
          "MDB",
          "TLN",
          "EME",
          "AWI",
          "IBP",
          "DCI",
          "WTS",
          "FIX",
          "UTHR",
          "NBIS",
          "SGI",
          "AYI",
          "RIOT",
          "NXT",
          "SANM",
          "BWXT",
          "PEGA",
          "JOBY",
          "IONQ",
          "ITT",
          "STRL",
          "QLYS",
          "MP",
          "HIMS",
          "IOT",
          "BE",
          "NEU",
          "AVAV",
          "PSTG",
          "RBLX",
          "CSCO",
          "BA",
          "NKE",
          "PI",
          "APLD",
          "MU",
          // ETFs
          "XLK",
          "XLF",
          "XLY",
          "XLP",
          "XLC",
          "XLB",
          "XLE",
          "XLU",
          "XLV",
          // Futures & Crypto
          "ES",
          "NQ",
          "BTC",
          "ETH",
          "BTCUSD",
          "ETHUSD",
          // Futures contracts
          "ES1!",
          "NQ1!",
          "MES1!",
          "MNQ1!",
          "YM1!",
          "RTY1!",
        ]
          .map((t) => t.toUpperCase())
          .filter((v, i, a) => a.indexOf(v) === i); // Deduplicate

        const currentIndex = (await kvGetJSON(KV, "timed:tickers")) || [];
        const addedTickers = [];
        const existingTickers = new Set(currentIndex);

        for (const ticker of knownTickers) {
          if (!existingTickers.has(ticker)) {
            currentIndex.push(ticker);
            addedTickers.push(ticker);
          }
        }

        // Sort and save
        currentIndex.sort();
        await kvPutJSON(KV, "timed:tickers", currentIndex);

        return sendJSON(
          {
            ok: true,
            message: `Index rebuilt. Added ${addedTickers.length} tickers.`,
            beforeCount: currentIndex.length - addedTickers.length,
            afterCount: currentIndex.length,
            addedTickers: addedTickers.slice(0, 20), // Show first 20
            totalAdded: addedTickers.length,
            note: "Index will continue to grow as TradingView sends alerts for these tickers.",
          },
          200,
          corsHeaders(env, req),
        );
      }

      // POST /timed/purge-trades-by-version?key=...&version=2.6.0 (Purge trades by version)
      if (
        url.pathname === "/timed/purge-trades-by-version" &&
        req.method === "POST"
      ) {
        const authFail = requireKeyOr401(req, env);
        if (authFail) return authFail;

        const targetVersion = url.searchParams.get("version");
        if (!targetVersion) {
          return sendJSON(
            { ok: false, error: "version parameter required" },
            400,
            corsHeaders(env, req),
          );
        }

        const tradesKey = "timed:trades:all";
        const allTrades = (await kvGetJSON(KV, tradesKey)) || [];

        const beforeCount = allTrades.length;
        const filteredTrades = allTrades.filter((trade) => {
          const tradeVersion =
            trade.scriptVersion || trade.script_version || "unknown";
          return tradeVersion !== targetVersion;
        });
        const purgedCount = beforeCount - filteredTrades.length;

        await kvPutJSON(KV, tradesKey, filteredTrades);

        return sendJSON(
          {
            ok: true,
            message: `Purged ${purgedCount} trades with version ${targetVersion}`,
            beforeCount,
            afterCount: filteredTrades.length,
            purgedCount,
            targetVersion,
          },
          200,
          corsHeaders(env, req),
        );
      }

      // POST /timed/cleanup-tickers?key=... (Remove unapproved tickers, keep only approved list, normalize Gold/Silver)
      // POST /timed/clear-rate-limit?key=...&all=true (Reset all) or &ip=...&endpoint=... (Clear specific)
      if (url.pathname === "/timed/clear-rate-limit" && req.method === "POST") {
        const authFail = requireKeyOr401(req, env);
        if (authFail) return authFail;

        const ip = url.searchParams.get("ip") || null;
        const endpoint = url.searchParams.get("endpoint") || null;
        const clearAll = url.searchParams.get("all") === "true";

        // List of all known endpoints that use rate limiting
        const allEndpoints = [
          "/timed/all",
          "/timed/latest",
          "/timed/activity",
          "/timed/trail",
          "/timed/top",
          "/timed/momentum",
          "/timed/momentum/history",
          "/timed/momentum/all",
          "/timed/trades",
          "/timed/health",
          "/timed/version",
          "/timed/alert-debug",
          "/timed/check-ticker",
        ];

        let cleared = 0;
        const clearedKeys = [];

        if (clearAll) {
          // Clear ALL rate limits - note: KV doesn't support listing all keys
          // So we return a message that rate limits will expire naturally
          // For immediate clearing, users should specify IP
          return sendJSON(
            {
              ok: true,
              message:
                "Rate limit reset acknowledged. Note: Cloudflare KV doesn't support listing all keys, so active rate limits will expire naturally after 1 hour. For immediate clearing, use ?ip=IP_ADDRESS to clear all endpoints for a specific IP.",
              note: "To clear all rate limits for your IP immediately, use: ?ip=YOUR_IP",
              endpoints: allEndpoints,
            },
            200,
            corsHeaders(env, req),
          );
        } else if (ip && endpoint) {
          // Clear specific IP + endpoint combination
          const legacyKey = `ratelimit:${ip}:${endpoint}`;
          await KV.delete(legacyKey);
          clearedKeys.push(legacyKey);
          cleared++;

          // Also clear fixed-window buckets (current + previous bucket)
          const window = 3600;
          const bucket = Math.floor(Date.now() / (window * 1000));
          const fixedKeyNow = `ratelimit:${ip}:${endpoint}:${bucket}`;
          const fixedKeyPrev = `ratelimit:${ip}:${endpoint}:${bucket - 1}`;
          await KV.delete(fixedKeyNow);
          await KV.delete(fixedKeyPrev);
          clearedKeys.push(fixedKeyNow, fixedKeyPrev);
          cleared++;
        } else if (ip) {
          // Clear all rate limits for a specific IP (all endpoints)
          for (const ep of allEndpoints) {
            const legacyKey = `ratelimit:${ip}:${ep}`;
            await KV.delete(legacyKey);
            cleared++;
            clearedKeys.push(legacyKey);

            // Also clear fixed-window buckets (current + previous bucket)
            const window = 3600;
            const bucket = Math.floor(Date.now() / (window * 1000));
            const fixedKeyNow = `ratelimit:${ip}:${ep}:${bucket}`;
            const fixedKeyPrev = `ratelimit:${ip}:${ep}:${bucket - 1}`;
            await KV.delete(fixedKeyNow);
            await KV.delete(fixedKeyPrev);
            cleared += 2;
            clearedKeys.push(fixedKeyNow, fixedKeyPrev);
          }
        } else if (endpoint) {
          // Clear all rate limits for a specific endpoint (all IPs)
          // Note: This is not directly possible without listing all IPs
          // For now, return an error suggesting to specify IP
          return sendJSON(
            {
              ok: false,
              error:
                "Cannot clear endpoint without IP. Please specify both 'ip' and 'endpoint', or just 'ip' to clear all endpoints for that IP.",
            },
            400,
            corsHeaders(env, req),
          );
        } else {
          // No parameters - return usage info
          return sendJSON(
            {
              ok: false,
              error: "Missing parameters",
              usage: {
                clearAll: "POST /timed/clear-rate-limit?key=YOUR_KEY&all=true",
                clearSpecific:
                  "POST /timed/clear-rate-limit?key=YOUR_KEY&ip=IP_ADDRESS&endpoint=/timed/activity",
                clearAllForIP:
                  "POST /timed/clear-rate-limit?key=YOUR_KEY&ip=IP_ADDRESS",
              },
            },
            400,
            corsHeaders(env, req),
          );
        }

        return sendJSON(
          {
            ok: true,
            message: `Cleared ${cleared} rate limit(s)`,
            cleared,
            keys: clearedKeys,
          },
          200,
          corsHeaders(env, req),
        );
      }

      // POST /timed/cleanup-tickers?key=... (Cleanup tickers to match approved list)
      if (url.pathname === "/timed/cleanup-tickers" && req.method === "POST") {
        const authFail = requireKeyOr401(req, env);
        if (authFail) return authFail;

        // Approved ticker list (normalized to uppercase)
        const approvedTickers = new Set([
          // Upticks
          "TSLA",
          "STX",
          "AU",
          "CCJ",
          "CLS",
          "CRS",
          "VST",
          "FSLR",
          "JCI",
          "ORCL",
          "AMZN",
          "BRK-B",
          "BRK.B",
          "BABA",
          "WMT",
          "PH",
          "GEV",
          "HII",
          "ULTA",
          "SHOP",
          "CSX",
          "PWR",
          "HOOD",
          "SPGI",
          "APP",
          "PANW",
          "RDDT",
          "TT",
          "GLXY",
          "ETHA",
          // Super Granny
          "META",
          "NVDA",
          "AMD",
          "ANET",
          "GS",
          // GRNI
          "TJX",
          "SOFI",
          "PNC",
          "PLTR",
          "NFLX",
          "MSTR",
          "MSFT",
          "MNST",
          "LRCX",
          "KLAC",
          "JPM",
          "GOOGL",
          "GE",
          "EXPE",
          "ETN",
          "EMR",
          "DE",
          "CRWD",
          "COST",
          "CDNS",
          "CAT",
          "BK",
          "AXP",
          "AXON",
          "AVGO",
          "AAPL",
          // GRNJ
          "RKLB",
          "LITE",
          "SN",
          "ALB",
          "RGLD",
          "MTZ",
          "ON",
          "ALLY",
          "DY",
          "EWBC",
          "PATH",
          "WFRD",
          "WAL",
          "IESC",
          "ENS",
          "TWLO",
          "MLI",
          "KTOS",
          "MDB",
          "TLN",
          "EME",
          "AWI",
          "IBP",
          "DCI",
          "WTS",
          "FIX",
          "UTHR",
          "NBIS",
          "SGI",
          "AYI",
          "RIOT",
          "NXT",
          "SANM",
          "BWXT",
          "PEGA",
          "JOBY",
          "IONQ",
          "ITT",
          "STRL",
          "QLYS",
          "MP",
          "HIMS",
          "IOT",
          "BE",
          "NEU",
          "AVAV",
          "PSTG",
          "RBLX",
          // GRNY (already covered above)
          // Social
          "CSCO",
          "BA",
          "NKE",
          "AAPL",
          "PI",
          "APLD",
          "MU",
          // SP Sectors
          "XLK",
          "XLF",
          "XLY",
          "XLP",
          "XLC",
          "XLB",
          "XLE",
          "XLU",
          "XLV",
          // Futures (normalize to common formats)
          "ES",
          "ES1!",
          "MES1!",
          "NQ",
          "NQ1!",
          "MNQ1!",
          "BTC",
          "BTC1!",
          "BTCUSD",
          "ETH",
          "ETH1!",
          "ETHT",
          "ETHUSD",
          "GOLD",
          "XAUUSD",
          "SILVER",
          "XAGUSD",
        ]);

        // Ticker normalization map (handle variations)
        const tickerMap = {
          "BRK-B": "BRK.B", // Map BRK-B to BRK.B format
          GOLD: "GOLD", // Keep as is
          SILVER: "SILVER", // Keep as is
          ES: "ES1!", // Map ES to ES1!
          NQ: "NQ1!", // Map NQ to NQ1!
          BTC: "BTC1!", // Map BTC to BTC1!
          ETH: "ETH1!", // Map ETH to ETH1!
        };

        const currentTickers = (await kvGetJSON(KV, "timed:tickers")) || [];
        const currentSet = new Set(currentTickers.map((t) => t.toUpperCase()));

        const toRemove = [];
        const toKeep = [];
        const renamed = [];

        // Process each current ticker
        for (const ticker of currentTickers) {
          const upperTicker = ticker.toUpperCase();
          const normalized = tickerMap[upperTicker] || upperTicker;

          if (
            approvedTickers.has(upperTicker) ||
            approvedTickers.has(normalized)
          ) {
            // Keep this ticker
            if (normalized !== upperTicker && tickerMap[upperTicker]) {
              // Need to rename
              renamed.push({ from: ticker, to: normalized });
              toKeep.push(normalized);
            } else {
              toKeep.push(ticker);
            }
          } else {
            // Remove this ticker
            toRemove.push(ticker);
          }
        }

        // Remove unapproved tickers from KV
        let removedCount = 0;
        for (const ticker of toRemove) {
          await KV.delete(`timed:latest:${ticker}`);
          await KV.delete(`timed:trail:${ticker}`);
          removedCount++;
        }

        // Rename tickers if needed
        let renamedCount = 0;
        for (const { from, to } of renamed) {
          const latestData = await kvGetJSON(KV, `timed:latest:${from}`);
          const trailData = await kvGetJSON(KV, `timed:trail:${from}`);

          if (latestData) {
            await kvPutJSON(KV, `timed:latest:${to}`, latestData);
            await KV.delete(`timed:latest:${from}`);
          }
          if (trailData) {
            await kvPutJSON(KV, `timed:trail:${to}`, trailData);
            await KV.delete(`timed:trail:${from}`);
          }
          renamedCount++;
        }

        // Update ticker index
        await kvPutJSON(KV, "timed:tickers", toKeep.sort());

        return sendJSON(
          {
            ok: true,
            message: "Ticker cleanup completed",
            removed: removedCount,
            renamed: renamedCount,
            kept: toKeep.length,
            removedTickers: toRemove.sort(),
            renamedTickers: renamed,
            finalTickers: toKeep.sort(),
          },
          200,
          corsHeaders(env, req),
        );
      }

      // GET /timed/cors-debug (Debug CORS configuration)
      if (url.pathname === "/timed/cors-debug" && req.method === "GET") {
        const corsConfig = env.CORS_ALLOW_ORIGIN || "";
        const allowedOrigins = corsConfig
          .split(",")
          .map((o) => o.trim())
          .filter(Boolean);
        const origin = req?.headers?.get("Origin") || "";

        return sendJSON(
          {
            ok: true,
            cors: {
              config: corsConfig,
              allowedOrigins: allowedOrigins,
              requestedOrigin: origin,
              isAllowed: allowedOrigins.includes(origin),
              willReturn:
                allowedOrigins.length === 0
                  ? "*"
                  : allowedOrigins.includes(origin)
                    ? origin
                    : "null",
            },
          },
          200,
          corsHeaders(env, req),
        );
      }

      // GET /timed/version (Check current version)
      if (url.pathname === "/timed/version" && req.method === "GET") {
        // Rate limiting
        const ip = req.headers.get("CF-Connecting-IP") || "unknown";
        const rateLimit = await checkRateLimit(
          KV,
          ip,
          "/timed/version",
          500, // Increased for single-user
          3600,
        );

        if (!rateLimit.allowed) {
          return sendJSON(
            { ok: false, error: "rate_limit_exceeded", retryAfter: 3600 },
            429,
            corsHeaders(env, req),
          );
        }

        const storedVersion = await getStoredVersion(KV);
        return sendJSON(
          {
            ok: true,
            storedVersion: storedVersion || "none",
            expectedVersion: CURRENT_DATA_VERSION,
            match: storedVersion === CURRENT_DATA_VERSION,
          },
          200,
          corsHeaders(env, req),
        );
      }

      // GET /timed/alert-debug?ticker=XYZ (Debug why alerts aren't firing)
      if (url.pathname === "/timed/alert-debug" && req.method === "GET") {
        // Rate limiting
        const ip = req.headers.get("CF-Connecting-IP") || "unknown";
        const rateLimit = await checkRateLimit(
          KV,
          ip,
          "/timed/alert-debug",
          500, // Increased for single-user
          3600,
        );

        if (!rateLimit.allowed) {
          return sendJSON(
            { ok: false, error: "rate_limit_exceeded", retryAfter: 3600 },
            429,
            corsHeaders(env, req),
          );
        }

        const ticker = normTicker(url.searchParams.get("ticker"));
        if (!ticker) {
          return sendJSON(
            { ok: false, error: "missing ticker" },
            400,
            corsHeaders(env, req),
          );
        }

        const data = await kvGetJSON(KV, `timed:latest:${ticker}`);
        if (!data) {
          return sendJSON(
            { ok: false, error: "no data for ticker", ticker },
            404,
            corsHeaders(env, req),
          );
        }

        // Replicate alert logic
        const state = String(data.state || "");
        const alignedLong = state === "HTF_BULL_LTF_BULL";
        const alignedShort = state === "HTF_BEAR_LTF_BEAR";
        const aligned = alignedLong || alignedShort;

        const prevKey = `timed:prevstate:${ticker}`;
        const prevState = await KV.get(prevKey);
        const enteredAligned = aligned && prevState !== state;

        const trigReason = String(data.trigger_reason || "");
        const trigOk =
          trigReason === "EMA_CROSS" || trigReason === "SQUEEZE_RELEASE" ||
          trigReason.includes("EMA_CROSS") || trigReason.includes("SQUEEZE_RELEASE");

        const flags = data.flags || {};
        const sqRel = !!flags.sq30_release;

        const side = corridorSide(data);
        const inCorridor = !!side;
        const corridorAlignedOK =
          (side === "LONG" && alignedLong) ||
          (side === "SHORT" && alignedShort);

        const shouldConsiderAlert =
          inCorridor &&
          corridorAlignedOK &&
          (enteredAligned || trigOk || sqRel);

        // Threshold gates (with Momentum Elite adjustments)
        const momentumElite = !!flags.momentum_elite;

        // Momentum Elite gets relaxed thresholds (higher quality stocks)
        const baseMinRR = Number(env.ALERT_MIN_RR || "1.5");
        const baseMaxComp = Number(env.ALERT_MAX_COMPLETION || "0.4");
        const baseMaxPhase = Number(env.ALERT_MAX_PHASE || "0.6");
        // Adjust thresholds for Momentum Elite (more lenient for quality stocks)
        const minRR = momentumElite
          ? Math.max(1.2, baseMinRR * 0.9)
          : baseMinRR; // Lower RR requirement
        const maxComp = momentumElite
          ? Math.min(0.5, baseMaxComp * 1.25)
          : baseMaxComp; // Allow higher completion
        const maxPhase = momentumElite
          ? Math.min(0.7, baseMaxPhase * 1.17)
          : baseMaxPhase; // Allow higher phase

        // Use current price for dynamic RR calculation (matches actual alert logic)
        const currentRR = computeRR(data);
        const rrToUse =
          currentRR != null ? currentRR : data.rr != null ? Number(data.rr) : 0;
        const rrOk = rrToUse >= minRR;
        const compToMax = computeCompletionToTpMax(data);
        const compRaw = data.completion == null ? null : Number(data.completion);
        const compVal = Number.isFinite(compToMax) ? compToMax : compRaw;
        const compOk = compVal == null ? true : compVal <= maxComp;
        const phaseOk =
          data.phase_pct == null ? true : Number(data.phase_pct) <= maxPhase;

        // Also consider Momentum Elite as a trigger condition (quality signal)
        const momentumEliteTrigger =
          momentumElite && inCorridor && corridorAlignedOK;

        // Enhanced trigger: original conditions OR Momentum Elite in good setup
        const enhancedTrigger = shouldConsiderAlert || momentumEliteTrigger;

        const discordEnabled = (env.DISCORD_ENABLE || "false") === "true";
        const discordUrlSet = !!env.DISCORD_WEBHOOK_URL;

        const wouldAlert =
          enhancedTrigger &&
          rrOk &&
          compOk &&
          phaseOk &&
          discordEnabled &&
          discordUrlSet;

        return sendJSON(
          {
            ok: true,
            ticker,
            wouldAlert,
            discord: {
              enabled: discordEnabled,
              urlSet: discordUrlSet,
              configured: discordEnabled && discordUrlSet,
            },
            conditions: {
              inCorridor,
              side: side || "none",
              corridorAlignedOK,
              enteredAligned,
              trigOk,
              sqRel,
              momentumElite,
              shouldConsiderAlert,
              momentumEliteTrigger,
              enhancedTrigger,
              rrOk: {
                value: rrToUse,
                valueFromPayload: data.rr,
                calculatedAtCurrentPrice: currentRR,
                baseRequired: baseMinRR,
                adjustedRequired: minRR,
                ok: rrOk,
              },
              compOk: {
                value: data.completion,
                baseRequired: baseMaxComp,
                adjustedRequired: maxComp,
                ok: compOk,
              },
              phaseOk: {
                value: data.phase_pct,
                baseRequired: baseMaxPhase,
                adjustedRequired: maxPhase,
                ok: phaseOk,
              },
            },
            thresholds: {
              base: {
                minRR: baseMinRR,
                maxComp: baseMaxComp,
                maxPhase: baseMaxPhase,
              },
              adjusted: { minRR, maxComp, maxPhase },
              momentumEliteAdjustments: momentumElite,
            },
            data: {
              state,
              htf_score: data.htf_score,
              ltf_score: data.ltf_score,
              rr: data.rr,
              completion: data.completion,
              phase_pct: data.phase_pct,
              trigger_reason: data.trigger_reason,
              flags: data.flags,
            },
          },
          200,
          corsHeaders(env, req),
        );
      }

      // GET /timed/alert-replay?ticker=XYZ&since=<ms>&until=<ms>&limit=<n>
      // Replays alert eligibility across historical ingest payloads (D1-backed).
      if (url.pathname === "/timed/alert-replay" && req.method === "GET") {
        const ip = req.headers.get("CF-Connecting-IP") || "unknown";
        const rateLimit = await checkRateLimit(
          KV,
          ip,
          "/timed/alert-replay",
          200, // conservative; this endpoint can be heavy
          3600,
        );
        if (!rateLimit.allowed) {
          return sendJSON(
            { ok: false, error: "rate_limit_exceeded", retryAfter: 3600 },
            429,
            corsHeaders(env, req),
          );
        }

        const ticker = normTicker(url.searchParams.get("ticker"));
        if (!ticker) {
          return sendJSON(
            { ok: false, error: "missing ticker" },
            400,
            corsHeaders(env, req),
          );
        }

        const sinceRaw = url.searchParams.get("since");
        const untilRaw = url.searchParams.get("until");
        const limitRaw = url.searchParams.get("limit");

        const now = Date.now();
        const since =
          sinceRaw != null && sinceRaw !== ""
            ? Number(sinceRaw)
            : now - 8 * 24 * 60 * 60 * 1000; // default: last ~week
        const until =
          untilRaw != null && untilRaw !== "" ? Number(untilRaw) : null;
        const limit =
          limitRaw != null && limitRaw !== "" ? Number(limitRaw) : 5000;

        const history = await d1GetTrailPayloadRange(
          env,
          ticker,
          since,
          until,
          limit,
        );
        if (!history.ok) {
          return sendJSON(
            {
              ok: false,
              error: history.skipped
                ? `d1_unavailable:${history.reason || "unknown"}`
                : "d1_query_failed",
              details: history.error || null,
              ticker,
            },
            503,
            corsHeaders(env, req),
          );
        }

        const payloads = Array.isArray(history.payloads)
          ? history.payloads
          : [];
        if (payloads.length === 0) {
          return sendJSON(
            {
              ok: true,
              ticker,
              source: history.source,
              since,
              until,
              count: 0,
              results: [],
              note: "No historical payloads found in D1 for requested range.",
            },
            200,
            corsHeaders(env, req),
          );
        }

        const discordEnabled = (env.DISCORD_ENABLE || "false") === "true";
        const discordUrlSet = !!env.DISCORD_WEBHOOK_URL;

        const baseMinRR = Number(env.ALERT_MIN_RR || "1.5");
        const baseMaxComp = Number(env.ALERT_MAX_COMPLETION || "0.4");
        const baseMaxPhase = Number(env.ALERT_MAX_PHASE || "0.6");

        let prevState = null;
        const results = [];
        const wouldDays = new Set();

        for (const data of payloads) {
          const state = String(data.state || "");
          const alignedLong = state === "HTF_BULL_LTF_BULL";
          const alignedShort = state === "HTF_BEAR_LTF_BEAR";
          const aligned = alignedLong || alignedShort;

          const enteredAligned =
            aligned && prevState != null && prevState !== state;

          const trigReason = String(data.trigger_reason || "");
          const trigOk =
            trigReason === "EMA_CROSS" || trigReason === "SQUEEZE_RELEASE" ||
            trigReason.includes("EMA_CROSS") || trigReason.includes("SQUEEZE_RELEASE");

          const flags = data.flags || {};
          const sqRel = !!flags.sq30_release;

          const side = corridorSide(data);
          const inCorridor = !!side;
          const corridorAlignedOK =
            (side === "LONG" && alignedLong) ||
            (side === "SHORT" && alignedShort);

          const shouldConsiderAlert =
            inCorridor &&
            corridorAlignedOK &&
            (enteredAligned || trigOk || sqRel);

          const momentumElite = !!flags.momentum_elite;

          const minRR = momentumElite
            ? Math.max(1.2, baseMinRR * 0.9)
            : baseMinRR;
          const maxComp = momentumElite
            ? Math.min(0.5, baseMaxComp * 1.25)
            : baseMaxComp;
          const maxPhase = momentumElite
            ? Math.min(0.7, baseMaxPhase * 1.17)
            : baseMaxPhase;

          const currentRR = computeRR(data);
          const rrToUse =
            currentRR != null
              ? currentRR
              : data.rr != null
                ? Number(data.rr)
                : 0;
          const rrOk = rrToUse >= minRR;
          const compOk =
            data.completion == null ? true : Number(data.completion) <= maxComp;
          const phaseOk =
            data.phase_pct == null ? true : Number(data.phase_pct) <= maxPhase;

          const momentumEliteTrigger =
            momentumElite && inCorridor && corridorAlignedOK;
          const enhancedTrigger = shouldConsiderAlert || momentumEliteTrigger;

          const wouldAlertLogic = enhancedTrigger && rrOk && compOk && phaseOk;
          const wouldAlert = wouldAlertLogic && discordEnabled && discordUrlSet;

          const action = "ENTRY";
          const ts = Number(data.trigger_ts || data.ts);
          const dedupeInfo = buildAlertDedupeKey({
            ticker,
            action,
            side,
            ts,
          });
          if (wouldAlert && dedupeInfo.key) wouldDays.add(dedupeInfo.key);

          if (wouldAlertLogic) {
            results.push({
              ts,
              day: dedupeInfo.day,
              dedupe_key: dedupeInfo.key,
              dedupe_bucket: dedupeInfo.bucket,
              action,
              state,
              side: side || "none",
              inCorridor,
              corridorAlignedOK,
              enteredAligned,
              trigOk,
              trigger_reason: trigReason || null,
              sqRel,
              momentumElite,
              rr: rrToUse,
              rrOk,
              completion: data.completion,
              compOk,
              phase_pct: data.phase_pct,
              phaseOk,
              rank: data.rank,
              enhancedTrigger,
              wouldAlertLogic,
              wouldAlert, // includes discord configured
            });
          }

          prevState = state;
        }

        // Check KV dedupe keys for alert buckets (so replay can explain "blocked by dedupe")
        const dedupe = {};
        const days = Array.from(wouldDays);
        await Promise.all(
          days.map(async (day) => {
            const v = await KV.get(day);
            dedupe[day] = { key: day, alreadyAlerted: !!v };
          }),
        );

        // Compute "wouldSendIfFirstBucket" as a deterministic simulation of dedupe behavior
        const firstOfDaySeen = new Set();
        const enriched = results.map((r) => {
          if (!r.wouldAlert)
            return {
              ...r,
              dedupe: dedupe[r.dedupe_key] || null,
              wouldSend: false,
            };
          const already =
            (dedupe[r.dedupe_key] && dedupe[r.dedupe_key].alreadyAlerted) ||
            false;
          const first = r.dedupe_key && !firstOfDaySeen.has(r.dedupe_key);
          if (r.dedupe_key && first) firstOfDaySeen.add(r.dedupe_key);
          return {
            ...r,
            dedupe: dedupe[r.dedupe_key] || null,
            wouldSend: !already && first,
          };
        });

        return sendJSON(
          {
            ok: true,
            ticker,
            source: history.source,
            since,
            until,
            pointsFetched: payloads.length,
            eligiblePoints: enriched.length, // only those passing logic
            wouldSendCount: enriched.filter((x) => x.wouldSend).length,
            discord: { enabled: discordEnabled, urlSet: discordUrlSet },
            thresholds: {
              base: {
                minRR: baseMinRR,
                maxComp: baseMaxComp,
                maxPhase: baseMaxPhase,
              },
            },
            results: enriched,
          },
          200,
          corsHeaders(env, req),
        );
      }

      // GET /timed/ledger/trades?since&until&ticker&status&limit&cursor
      if (url.pathname === "/timed/ledger/trades" && req.method === "GET") {
        const db = env?.DB;
        if (!db) {
          return sendJSON(
            { ok: false, error: "d1_not_configured" },
            503,
            corsHeaders(env, req),
          );
        }

        const ip = req.headers.get("CF-Connecting-IP") || "unknown";
        const rateLimit = await checkRateLimit(
          KV,
          ip,
          "/timed/ledger/trades",
          600,
          3600,
        );
        if (!rateLimit.allowed) {
          return sendJSON(
            { ok: false, error: "rate_limit_exceeded", retryAfter: 3600 },
            429,
            corsHeaders(env, req),
          );
        }

        const ticker = normTicker(url.searchParams.get("ticker")) || null;
        const statusRaw = url.searchParams.get("status");
        const sinceRaw = url.searchParams.get("since");
        const untilRaw = url.searchParams.get("until");
        const limitRaw = url.searchParams.get("limit");
        const cursorRaw = url.searchParams.get("cursor");

        const since =
          sinceRaw != null && sinceRaw !== "" ? Number(sinceRaw) : null;
        const until =
          untilRaw != null && untilRaw !== "" ? Number(untilRaw) : null;
        const limit = Math.max(1, Math.min(1000, Number(limitRaw) || 200));
        const cursor = decodeCursor(cursorRaw);

        let where = "WHERE 1=1";
        const binds = [];
        if (ticker) {
          where += " AND ticker = ?";
          binds.push(String(ticker).toUpperCase());
        }
        const statusNorm =
          statusRaw != null ? String(statusRaw).trim().toLowerCase() : "";
        if (statusNorm && statusNorm !== "all") {
          // UX-friendly filters used by the ledger UI
          if (statusNorm === "closed") {
            where += " AND status IN ('WIN','LOSS')";
          } else if (statusNorm === "open") {
            // Includes OPEN + TRIMMED-style intermediate statuses + nulls
            where += " AND (status IS NULL OR status NOT IN ('WIN','LOSS'))";
          } else {
            // Exact match fallback (stored statuses are uppercase)
            where += " AND status = ?";
            binds.push(String(statusRaw).toUpperCase());
          }
        }
        if (since != null && Number.isFinite(since)) {
          where += " AND entry_ts >= ?";
          binds.push(Number(since));
        }
        if (until != null && Number.isFinite(until)) {
          where += " AND entry_ts <= ?";
          binds.push(Number(until));
        }
        if (
          cursor &&
          Number.isFinite(Number(cursor.entry_ts)) &&
          cursor.trade_id
        ) {
          where += " AND (entry_ts < ? OR (entry_ts = ? AND trade_id < ?))";
          binds.push(
            Number(cursor.entry_ts),
            Number(cursor.entry_ts),
            String(cursor.trade_id),
          );
        }

        const sql = `SELECT
            trade_id, ticker, direction, entry_ts, entry_price, rank, rr, status,
            exit_ts, exit_price, exit_reason, trimmed_pct, pnl, pnl_pct,
            script_version, created_at, updated_at
          FROM trades
          ${where}
          ORDER BY entry_ts DESC, trade_id DESC
          LIMIT ?`;

        const rows = await db
          .prepare(sql)
          .bind(...binds, limit + 1)
          .all();
        const results = Array.isArray(rows?.results) ? rows.results : [];
        const page = results.slice(0, limit);
        const hasMore = results.length > limit;
        const last = page.length > 0 ? page[page.length - 1] : null;
        const nextCursor =
          hasMore && last
            ? encodeCursor({ entry_ts: last.entry_ts, trade_id: last.trade_id })
            : null;

        return sendJSON(
          { ok: true, count: page.length, hasMore, nextCursor, trades: page },
          200,
          corsHeaders(env, req),
        );
      }

      // GET /timed/ledger/trades/:tradeId
      // GET /timed/ledger/trades/:tradeId/decision-card?type=ENTRY|TRIM|EXIT&ts=...
      // Returns a Discord-style "Action & Reasoning" card using the nearest trail snapshot.
      if (
        url.pathname.startsWith("/timed/ledger/trades/") &&
        url.pathname.endsWith("/decision-card") &&
        req.method === "GET"
      ) {
        const db = env?.DB;
        if (!db) {
          return sendJSON(
            { ok: false, error: "d1_not_configured" },
            503,
            corsHeaders(env, req),
          );
        }

        const raw = url.pathname.split("/timed/ledger/trades/")[1] || "";
        const tradeId = decodeURIComponent(
          raw.replace(/\/decision-card$/, ""),
        ).trim();
        if (!tradeId) {
          return sendJSON(
            { ok: false, error: "missing trade_id" },
            400,
            corsHeaders(env, req),
          );
        }

        const typeRaw = String(
          url.searchParams.get("type") || url.searchParams.get("event") || "",
        )
          .trim()
          .toUpperCase();
        const type =
          typeRaw === "CLOSE"
            ? "EXIT"
            : typeRaw === "ENTRY" || typeRaw === "TRIM" || typeRaw === "EXIT"
              ? typeRaw
              : null;
        if (!type) {
          return sendJSON(
            {
              ok: false,
              error: "missing_or_invalid_type",
              allowed: ["ENTRY", "TRIM", "EXIT"],
            },
            400,
            corsHeaders(env, req),
          );
        }

        const tsParam = url.searchParams.get("ts");
        const ts = tsParam != null && tsParam !== "" ? Number(tsParam) : null;

        const tradeRow = await db
          .prepare(
            `SELECT
              trade_id, ticker, direction, entry_ts, entry_price, rank, rr, status,
              exit_ts, exit_price, exit_reason, trimmed_pct, pnl, pnl_pct,
              script_version, created_at, updated_at
             FROM trades WHERE trade_id = ?1 LIMIT 1`,
          )
          .bind(tradeId)
          .first();

        if (!tradeRow) {
          return sendJSON(
            { ok: false, error: "not_found", trade_id: tradeId },
            404,
            corsHeaders(env, req),
          );
        }

        const ticker = String(tradeRow.ticker || "").toUpperCase();
        if (!ticker) {
          return sendJSON(
            { ok: false, error: "missing_ticker", trade_id: tradeId },
            400,
            corsHeaders(env, req),
          );
        }

        const evRowFromDb = await (async () => {
          if (Number.isFinite(ts)) {
            // Find closest event in time (best for "By Day Activity" clicks)
            const r = await db
              .prepare(
                `SELECT
                  event_id, trade_id, ts, type, price, qty_pct_delta, qty_pct_total, pnl_realized, reason, meta_json
                 FROM trade_events
                 WHERE trade_id = ?1 AND type = ?2
                 ORDER BY ABS(ts - ?3) ASC
                 LIMIT 1`,
              )
              .bind(tradeId, type, Number(ts))
              .first();
            return r || null;
          }
          // Default: entry -> earliest; others -> latest
          const order = type === "ENTRY" ? "ASC" : "DESC";
          const r = await db
            .prepare(
              `SELECT
                event_id, trade_id, ts, type, price, qty_pct_delta, qty_pct_total, pnl_realized, reason, meta_json
               FROM trade_events
               WHERE trade_id = ?1 AND type = ?2
               ORDER BY ts ${order}
               LIMIT 1`,
            )
            .bind(tradeId, type)
            .first();
          return r || null;
        })();

        // Resilience: some environments may not have trade_events populated.
        // In that case, fall back to the timestamp passed by the client (preferred),
        // or use the trade's own lifecycle timestamps.
        const fallbackTs = (() => {
          if (Number.isFinite(ts)) return Number(ts);
          if (type === "ENTRY") return Number(tradeRow.entry_ts);
          if (type === "EXIT") return Number(tradeRow.exit_ts);
          // TRIM: best available fallback is updated_at when trim status is present
          const trimmed = Number(tradeRow.trimmed_pct || 0);
          if (type === "TRIM" && trimmed > 0)
            return Number(tradeRow.updated_at);
          return null;
        })();

        const evRow = evRowFromDb
          ? evRowFromDb
          : Number.isFinite(Number(fallbackTs))
            ? {
                event_id: null,
                trade_id: String(tradeId),
                ts: Number(fallbackTs),
                type,
                price: null,
                qty_pct_delta: null,
                qty_pct_total:
                  type === "TRIM"
                    ? Number(tradeRow.trimmed_pct || 0) || null
                    : null,
                pnl_realized: null,
                reason: null,
                meta_json: null,
              }
            : null;

        if (!evRow || !Number.isFinite(Number(evRow.ts))) {
          return sendJSON(
            { ok: false, error: "event_not_found", trade_id: tradeId, type },
            404,
            corsHeaders(env, req),
          );
        }

        const evTs = Number(evRow.ts);
        const snapWindowMs =
          type === "ENTRY" ? 3 * 60 * 60 * 1000 : 2 * 60 * 60 * 1000;
        const snap = await d1GetNearestTrailPayload(
          db,
          ticker,
          evTs,
          snapWindowMs,
        );

        const tickerData = snap && snap.payload ? snap.payload : null;
        if (!tickerData) {
          return sendJSON(
            {
              ok: false,
              error: "missing_snapshot",
              trade_id: tradeId,
              type,
              ts: evTs,
            },
            404,
            corsHeaders(env, req),
          );
        }

        const tradeLite = {
          direction: tradeRow.direction,
          rank: Number(tradeRow.rank) || 0,
          rr: Number(tradeRow.rr) || 0,
          status: tradeRow.status,
          exitReason: tradeRow.exit_reason || null,
          pnl: Number(tradeRow.pnl) || 0,
          pnlPct: Number(tradeRow.pnl_pct) || 0,
        };

        const trimPct = (() => {
          const v =
            evRow.qty_pct_total != null ? Number(evRow.qty_pct_total) : null;
          if (Number.isFinite(v)) return v;
          const fromMeta = parseTrimPctFromText(evRow.meta_json);
          return Number.isFinite(fromMeta) ? fromMeta : null;
        })();

        const actionKey = type === "EXIT" ? "CLOSE" : type;
        const interpretation = generateTradeActionInterpretation(
          actionKey,
          tickerData,
          tradeLite,
          trimPct,
        );

        return sendJSON(
          {
            ok: true,
            trade: tradeRow,
            event: evRow,
            snapshot: { ts: Number(snap.ts), payload: tickerData },
            card: {
              title:
                `${ticker} ${String(tradeLite.direction || "").toUpperCase()}`.trim(),
              action: interpretation?.action || null,
              reasons: interpretation?.reasons || null,
            },
          },
          200,
          corsHeaders(env, req),
        );
      }

      if (
        url.pathname.startsWith("/timed/ledger/trades/") &&
        !url.pathname.endsWith("/decision-card") &&
        req.method === "GET"
      ) {
        const db = env?.DB;
        if (!db) {
          return sendJSON(
            { ok: false, error: "d1_not_configured" },
            503,
            corsHeaders(env, req),
          );
        }

        const tradeId = decodeURIComponent(
          url.pathname.split("/timed/ledger/trades/")[1] || "",
        ).trim();
        if (!tradeId) {
          return sendJSON(
            { ok: false, error: "missing trade_id" },
            400,
            corsHeaders(env, req),
          );
        }

        const includeEvidence =
          (url.searchParams.get("includeEvidence") || "") === "1";

        const tradeRow = await db
          .prepare(
            `SELECT
              trade_id, ticker, direction, entry_ts, entry_price, rank, rr, status,
              exit_ts, exit_price, exit_reason, trimmed_pct, pnl, pnl_pct,
              script_version, created_at, updated_at
             FROM trades WHERE trade_id = ?1 LIMIT 1`,
          )
          .bind(tradeId)
          .first();

        if (!tradeRow) {
          return sendJSON(
            { ok: false, error: "not_found", trade_id: tradeId },
            404,
            corsHeaders(env, req),
          );
        }

        const eventsRows = await db
          .prepare(
            `SELECT
              event_id, trade_id, ts, type, price, qty_pct_delta, qty_pct_total, pnl_realized, reason, meta_json
             FROM trade_events
             WHERE trade_id = ?1
             ORDER BY ts ASC`,
          )
          .bind(tradeId)
          .all();

        const events = Array.isArray(eventsRows?.results)
          ? eventsRows.results
          : [];

        let evidence = null;
        let entry_evidence = null;
        if (includeEvidence) {
          const ticker = String(tradeRow.ticker || "").toUpperCase();
          // Always try to attach a "best" entry snapshot (bubble-style detail)
          entry_evidence = await d1GetNearestTrailPayload(
            db,
            ticker,
            tradeRow.entry_ts,
            3 * 60 * 60 * 1000,
          );

          evidence = [];
          for (const ev of events) {
            const ts = Number(ev.ts);
            if (!ticker || !Number.isFinite(ts)) continue;
            const snap = await d1GetNearestTrailPayload(
              db,
              ticker,
              ts,
              2 * 60 * 60 * 1000,
            );
            if (snap && snap.payload) {
              evidence.push({
                event_id: ev.event_id,
                ts: ts,
                snapshot_ts: Number(snap.ts),
                payload: snap.payload,
              });
            }
          }
        }

        return sendJSON(
          { ok: true, trade: tradeRow, events, evidence, entry_evidence },
          200,
          corsHeaders(env, req),
        );
      }

      // GET /timed/ledger/alerts?since&until&ticker&dedupe_day&limit&cursor
      if (url.pathname === "/timed/ledger/alerts" && req.method === "GET") {
        const db = env?.DB;
        if (!db) {
          return sendJSON(
            { ok: false, error: "d1_not_configured" },
            503,
            corsHeaders(env, req),
          );
        }

        const ip = req.headers.get("CF-Connecting-IP") || "unknown";
        const rateLimit = await checkRateLimit(
          KV,
          ip,
          "/timed/ledger/alerts",
          600,
          3600,
        );
        if (!rateLimit.allowed) {
          return sendJSON(
            { ok: false, error: "rate_limit_exceeded", retryAfter: 3600 },
            429,
            corsHeaders(env, req),
          );
        }

        const ticker = normTicker(url.searchParams.get("ticker")) || null;
        const dedupeDay = url.searchParams.get("dedupe_day");
        const sinceRaw = url.searchParams.get("since");
        const untilRaw = url.searchParams.get("until");
        const limitRaw = url.searchParams.get("limit");
        const cursorRaw = url.searchParams.get("cursor");

        const since =
          sinceRaw != null && sinceRaw !== "" ? Number(sinceRaw) : null;
        const until =
          untilRaw != null && untilRaw !== "" ? Number(untilRaw) : null;
        const limit = Math.max(1, Math.min(1000, Number(limitRaw) || 200));
        const cursor = decodeCursor(cursorRaw);

        let where = "WHERE 1=1";
        const binds = [];
        if (ticker) {
          where += " AND ticker = ?";
          binds.push(String(ticker).toUpperCase());
        }
        if (dedupeDay && dedupeDay !== "all") {
          where += " AND dedupe_day = ?";
          binds.push(String(dedupeDay));
        }
        if (since != null && Number.isFinite(since)) {
          where += " AND ts >= ?";
          binds.push(Number(since));
        }
        if (until != null && Number.isFinite(until)) {
          where += " AND ts <= ?";
          binds.push(Number(until));
        }
        if (cursor && Number.isFinite(Number(cursor.ts)) && cursor.alert_id) {
          where += " AND (ts < ? OR (ts = ? AND alert_id < ?))";
          binds.push(
            Number(cursor.ts),
            Number(cursor.ts),
            String(cursor.alert_id),
          );
        }

        const sql = `SELECT
            alert_id, ticker, ts, side, state, rank, rr_at_alert, trigger_reason, dedupe_day,
            discord_sent, discord_status, discord_error
          FROM alerts
          ${where}
          ORDER BY ts DESC, alert_id DESC
          LIMIT ?`;

        const rows = await db
          .prepare(sql)
          .bind(...binds, limit + 1)
          .all();
        const results = Array.isArray(rows?.results) ? rows.results : [];
        const page = results.slice(0, limit);
        const hasMore = results.length > limit;
        const last = page.length > 0 ? page[page.length - 1] : null;
        const nextCursor =
          hasMore && last
            ? encodeCursor({ ts: last.ts, alert_id: last.alert_id })
            : null;

        return sendJSON(
          { ok: true, count: page.length, hasMore, nextCursor, alerts: page },
          200,
          corsHeaders(env, req),
        );
      }

      // GET /timed/ledger/summary?since&until
      if (url.pathname === "/timed/ledger/summary" && req.method === "GET") {
        const db = env?.DB;
        if (!db) {
          return sendJSON(
            { ok: false, error: "d1_not_configured" },
            503,
            corsHeaders(env, req),
          );
        }

        const ip = req.headers.get("CF-Connecting-IP") || "unknown";
        const rateLimit = await checkRateLimit(
          KV,
          ip,
          "/timed/ledger/summary",
          300,
          3600,
        );
        if (!rateLimit.allowed) {
          return sendJSON(
            { ok: false, error: "rate_limit_exceeded", retryAfter: 3600 },
            429,
            corsHeaders(env, req),
          );
        }

        const sinceRaw = url.searchParams.get("since");
        const untilRaw = url.searchParams.get("until");
        const since =
          sinceRaw != null && sinceRaw !== "" ? Number(sinceRaw) : null;
        const until =
          untilRaw != null && untilRaw !== "" ? Number(untilRaw) : null;

        let where = "WHERE 1=1";
        const binds = [];
        if (since != null && Number.isFinite(since)) {
          where += " AND entry_ts >= ?";
          binds.push(Number(since));
        }
        if (until != null && Number.isFinite(until)) {
          where += " AND entry_ts <= ?";
          binds.push(Number(until));
        }

        const overall = await db
          .prepare(
            `SELECT
              COUNT(*) AS total,
              SUM(CASE WHEN status IN ('WIN','LOSS') THEN 1 ELSE 0 END) AS closed,
              SUM(CASE WHEN status = 'WIN' THEN 1 ELSE 0 END) AS wins,
              SUM(CASE WHEN status = 'LOSS' THEN 1 ELSE 0 END) AS losses,
              SUM(CASE WHEN status IN ('WIN','LOSS') THEN pnl ELSE 0 END) AS closed_pnl,
              SUM(CASE WHEN status = 'WIN' THEN pnl ELSE 0 END) AS gross_win,
              SUM(CASE WHEN status = 'LOSS' THEN -pnl ELSE 0 END) AS gross_loss,
              AVG(CASE WHEN status = 'WIN' THEN pnl ELSE NULL END) AS avg_win,
              AVG(CASE WHEN status = 'LOSS' THEN -pnl ELSE NULL END) AS avg_loss_abs
            FROM trades
            ${where}`,
          )
          .bind(...binds)
          .first();

        const closed = Number(overall?.closed || 0);
        const openTrades = Math.max(0, Number(overall?.total || 0) - closed);
        const wins = Number(overall?.wins || 0);
        const losses = Number(overall?.losses || 0);
        const winRate = closed > 0 ? (wins / closed) * 100 : 0;
        const grossWin = Number(overall?.gross_win || 0);
        const grossLoss = Number(overall?.gross_loss || 0);
        const profitFactor =
          grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;
        const avgWin = Number(overall?.avg_win || 0);
        const avgLossAbs = Number(overall?.avg_loss_abs || 0);
        const expectancy =
          closed > 0 ? Number(overall?.closed_pnl || 0) / closed : 0;

        const rankBuckets = await db
          .prepare(
            `SELECT
              CASE
                WHEN rank >= 80 THEN '80+'
                WHEN rank >= 70 THEN '70-79'
                WHEN rank >= 60 THEN '60-69'
                WHEN rank IS NULL THEN 'unknown'
                ELSE '<60'
              END AS bucket,
              COUNT(*) AS n,
              SUM(CASE WHEN status = 'WIN' THEN 1 ELSE 0 END) AS wins,
              SUM(CASE WHEN status = 'LOSS' THEN 1 ELSE 0 END) AS losses,
              SUM(CASE WHEN status IN ('WIN','LOSS') THEN pnl ELSE 0 END) AS pnl
            FROM trades
            ${where}
            GROUP BY bucket
            ORDER BY bucket`,
          )
          .bind(...binds)
          .all();

        const rrBuckets = await db
          .prepare(
            `SELECT
              CASE
                WHEN rr >= 2.0 THEN '2.0+'
                WHEN rr >= 1.5 THEN '1.5-1.99'
                WHEN rr >= 1.0 THEN '1.0-1.49'
                WHEN rr IS NULL THEN 'unknown'
                ELSE '<1.0'
              END AS bucket,
              COUNT(*) AS n,
              SUM(CASE WHEN status = 'WIN' THEN 1 ELSE 0 END) AS wins,
              SUM(CASE WHEN status = 'LOSS' THEN 1 ELSE 0 END) AS losses,
              SUM(CASE WHEN status IN ('WIN','LOSS') THEN pnl ELSE 0 END) AS pnl
            FROM trades
            ${where}
            GROUP BY bucket
            ORDER BY bucket`,
          )
          .bind(...binds)
          .all();

        const exitReasons = await db
          .prepare(
            `SELECT
              COALESCE(exit_reason, 'unknown') AS reason,
              COUNT(*) AS n,
              SUM(CASE WHEN status = 'WIN' THEN 1 ELSE 0 END) AS wins,
              SUM(CASE WHEN status = 'LOSS' THEN 1 ELSE 0 END) AS losses,
              SUM(CASE WHEN status IN ('WIN','LOSS') THEN pnl ELSE 0 END) AS pnl
            FROM trades
            ${where}
            GROUP BY reason
            ORDER BY n DESC`,
          )
          .bind(...binds)
          .all();

        // Trigger reasons from alerts (sent + skipped) in same time window (best-effort)
        let alertWhere = "WHERE 1=1";
        const alertBinds = [];
        if (since != null && Number.isFinite(since)) {
          alertWhere += " AND ts >= ?";
          alertBinds.push(Number(since));
        }
        if (until != null && Number.isFinite(until)) {
          alertWhere += " AND ts <= ?";
          alertBinds.push(Number(until));
        }

        const triggerReasons = await db
          .prepare(
            `SELECT
              COALESCE(trigger_reason, 'unknown') AS reason,
              COUNT(*) AS n,
              SUM(CASE WHEN discord_sent = 1 THEN 1 ELSE 0 END) AS sent,
              SUM(CASE WHEN discord_sent = 0 THEN 1 ELSE 0 END) AS not_sent
            FROM alerts
            ${alertWhere}
            GROUP BY reason
            ORDER BY n DESC`,
          )
          .bind(...alertBinds)
          .all();

        return sendJSON(
          {
            ok: true,
            since,
            until,
            totals: {
              totalTrades: Number(overall?.total || 0),
              openTrades,
              closedTrades: closed,
              wins,
              losses,
              winRate,
              closedPnl: Number(overall?.closed_pnl || 0),
              profitFactor,
              avgWin,
              avgLoss: avgLossAbs,
              expectancy,
              grossWin,
              grossLoss,
            },
            breakdown: {
              byRank: rankBuckets?.results || [],
              byRR: rrBuckets?.results || [],
              byExitReason: exitReasons?.results || [],
              byTriggerReason: triggerReasons?.results || [],
            },
          },
          200,
          corsHeaders(env, req),
        );
      }

      // POST /timed/admin/backfill-trades?key=...&limit=...&offset=...&ticker=...
      // Backfill KV trades/history into D1 ledger tables (idempotent via upserts + INSERT OR IGNORE).
      if (
        url.pathname === "/timed/admin/backfill-trades" &&
        req.method === "POST"
      ) {
        const authFail = requireKeyOr401(req, env);
        if (authFail) return authFail;

        const db = env?.DB;
        if (!db) {
          return sendJSON(
            { ok: false, error: "d1_not_configured" },
            503,
            corsHeaders(env, req),
          );
        }

        const qLimit = Number(url.searchParams.get("limit") || "0");
        const qOffset = Number(url.searchParams.get("offset") || "0");
        const tickerFilter = normTicker(url.searchParams.get("ticker"));

        const tradesKey = "timed:trades:all";
        const allTrades = (await kvGetJSON(KV, tradesKey)) || [];
        const filtered = Array.isArray(allTrades)
          ? allTrades.filter((t) => {
              if (!t || !t.id) return false;
              if (tickerFilter)
                return String(t.ticker || "").toUpperCase() === tickerFilter;
              return true;
            })
          : [];

        const offset = Math.max(0, Number.isFinite(qOffset) ? qOffset : 0);
        const limit =
          qLimit > 0 ? Math.max(1, Math.min(5000, qLimit)) : filtered.length;
        const slice = filtered.slice(offset, offset + limit);

        let tradesUpserted = 0;
        let eventsInserted = 0;
        const errors = [];

        const batchSize = 50;
        for (let i = 0; i < slice.length; i += batchSize) {
          const batch = slice.slice(i, i + batchSize);
          await Promise.all(
            batch.map(async (t) => {
              try {
                // Enrich legacy history (trim percentages + inferred exit reason/price)
                const tradeCopy = { ...t };
                if (Array.isArray(tradeCopy.history)) {
                  let prevTrimTotal = 0;
                  for (let idx = 0; idx < tradeCopy.history.length; idx++) {
                    const ev = tradeCopy.history[idx];
                    if (!ev || !ev.type) continue;
                    if (String(ev.type).toUpperCase() === "TRIM") {
                      const inferredTotal =
                        ev.trimPct != null
                          ? Number(ev.trimPct)
                          : (parseTrimPctFromText(ev.note) ??
                            parseTrimPctFromText(ev.meta_json));
                      if (
                        inferredTotal != null &&
                        Number.isFinite(inferredTotal)
                      ) {
                        ev.trimPct = inferredTotal;
                        if (ev.trimDeltaPct == null && prevTrimTotal != null) {
                          ev.trimDeltaPct = Math.max(
                            0,
                            inferredTotal - prevTrimTotal,
                          );
                        }
                        prevTrimTotal = inferredTotal;
                      }
                    }
                    if (String(ev.type).toUpperCase() === "EXIT") {
                      // Add explicit reason for better bucketing
                      ev.reason =
                        ev.reason ||
                        inferExitReasonForLegacyTrade(tradeCopy, ev);
                      // Ensure price is a number if present
                      if (ev.price != null) ev.price = Number(ev.price);
                    }
                  }
                }

                // Ensure trade-level exit fields exist for legacy trades
                if (
                  (String(tradeCopy.status || "").toUpperCase() === "WIN" ||
                    String(tradeCopy.status || "").toUpperCase() === "LOSS") &&
                  Array.isArray(tradeCopy.history)
                ) {
                  const exitEv =
                    [...tradeCopy.history]
                      .reverse()
                      .find((e) => e && e.type === "EXIT") || null;
                  if (exitEv) {
                    if (tradeCopy.exitPrice == null && exitEv.price != null)
                      tradeCopy.exitPrice = Number(exitEv.price);
                    if (!tradeCopy.exitReason)
                      tradeCopy.exitReason = inferExitReasonForLegacyTrade(
                        tradeCopy,
                        exitEv,
                      );
                  }
                }

                const r = await d1UpsertTrade(env, tradeCopy);
                if (r.ok) tradesUpserted += 1;

                if (Array.isArray(tradeCopy.history)) {
                  for (const ev of tradeCopy.history) {
                    const er = await d1InsertTradeEvent(
                      env,
                      String(tradeCopy.id),
                      ev,
                    );
                    if (er.ok) eventsInserted += 1;
                  }
                }
              } catch (e) {
                errors.push({ trade_id: t?.id || null, error: String(e) });
              }
            }),
          );
        }

        return sendJSON(
          {
            ok: true,
            ticker: tickerFilter || null,
            totalInKV: Array.isArray(allTrades) ? allTrades.length : 0,
            filtered: filtered.length,
            offset,
            limit: slice.length,
            tradesUpserted,
            eventsInserted,
            errorsCount: errors.length,
            errors: errors.slice(0, 25),
          },
          200,
          corsHeaders(env, req),
        );
      }

      // POST /timed/admin/backfill-alerts?key=...&limit=...&offset=...&ticker=...&source=trades|activity|all
      // Backfill KV activity + trades into D1 alerts ledger (idempotent via upserts).
      if (
        url.pathname === "/timed/admin/backfill-alerts" &&
        req.method === "POST"
      ) {
        const authFail = requireKeyOr401(req, env);
        if (authFail) return authFail;

        const db = env?.DB;
        if (!db) {
          return sendJSON(
            { ok: false, error: "d1_not_configured" },
            503,
            corsHeaders(env, req),
          );
        }

        const source = String(
          url.searchParams.get("source") || "all",
        ).toLowerCase();
        const qLimit = Number(url.searchParams.get("limit") || "0");
        const qOffset = Number(url.searchParams.get("offset") || "0");
        const tickerFilter = normTicker(url.searchParams.get("ticker"));

        let alertsUpserted = 0;
        const errors = [];

        const upsertAlertSafe = async (payload) => {
          try {
            const r = await d1UpsertAlert(env, payload);
            if (r.ok) alertsUpserted += 1;
          } catch (err) {
            errors.push(String(err));
          }
        };

        if (source === "activity" || source === "all") {
          try {
            const feed = (await kvGetJSON(KV, "timed:activity:feed")) || [];
            const activityAlerts = feed.filter((e) => {
              if (!e || !e.ticker) return false;
              if (
                tickerFilter &&
                String(e.ticker).toUpperCase() !== tickerFilter
              )
                return false;
              return (
                e.type === "discord_alert" ||
                e.type === "trade_entry" ||
                e.type === "td9_exit"
              );
            });
            for (const ev of activityAlerts) {
              const ts = Number(ev.ts) || Date.now();
              const side =
                ev.direction || ev.side || ev.trigger_dir || ev.action || null;
              const alertType =
                ev.type === "discord_alert"
                  ? "ALERT_ENTRY"
                  : ev.type === "trade_entry"
                    ? "TRADE_ENTRY"
                    : "TD9_EXIT";
              const payloadJson = (() => {
                try {
                  return JSON.stringify(ev);
                } catch {
                  return null;
                }
              })();
              const metaJson = (() => {
                try {
                  return JSON.stringify({ source: "activity", type: ev.type });
                } catch {
                  return null;
                }
              })();
              await upsertAlertSafe({
                alert_id: buildAlertId(ev.ticker, ts, alertType),
                ticker: ev.ticker,
                ts,
                side,
                state: ev.state,
                rank: ev.rank,
                rr_at_alert: ev.rr,
                trigger_reason: ev.trigger_reason || ev.action || alertType,
                dedupe_day: formatDedupDay(ts),
                discord_sent: true,
                discord_status: 200,
                discord_error: null,
                payload_json: payloadJson,
                meta_json: metaJson,
              });
            }
          } catch (err) {
            errors.push(String(err));
          }
        }

        if (source === "trades" || source === "all") {
          const tradesKey = "timed:trades:all";
          const allTrades = (await kvGetJSON(KV, tradesKey)) || [];
          const filtered = Array.isArray(allTrades)
            ? allTrades.filter((t) => {
                if (!t || !t.id) return false;
                if (tickerFilter)
                  return String(t.ticker || "").toUpperCase() === tickerFilter;
                return true;
              })
            : [];

          const offset = Math.max(0, Number.isFinite(qOffset) ? qOffset : 0);
          const limit =
            qLimit > 0 ? Math.max(1, Math.min(5000, qLimit)) : filtered.length;
          const slice = filtered.slice(offset, offset + limit);

          for (const trade of slice) {
            if (!Array.isArray(trade.history)) continue;
            for (const ev of trade.history) {
              if (!ev || !ev.type) continue;
              const ts = isoToMs(ev.timestamp) || Number(ev.ts) || Date.now();
              const type = String(ev.type).toUpperCase();
              const reason =
                ev.reason ||
                (type === "EXIT"
                  ? trade.exitReason || trade.exit_reason
                  : type);
              const payloadJson = (() => {
                try {
                  return JSON.stringify({
                    trade_id: trade.id,
                    trade,
                    event: ev,
                  });
                } catch {
                  return null;
                }
              })();
              const metaJson = (() => {
                try {
                  return JSON.stringify({ source: "trade_history", type });
                } catch {
                  return null;
                }
              })();
              await upsertAlertSafe({
                alert_id: buildAlertId(trade.ticker, ts, type),
                ticker: trade.ticker,
                ts,
                side: trade.direction,
                state: trade.state,
                rank: trade.rank,
                rr_at_alert: trade.rr,
                trigger_reason: reason,
                dedupe_day: formatDedupDay(ts),
                discord_sent: false,
                discord_status: null,
                discord_error: null,
                payload_json: payloadJson,
                meta_json: metaJson,
              });
            }
          }
        }

        return sendJSON(
          { ok: true, alertsUpserted, errors },
          200,
          corsHeaders(env, req),
        );
      }

      // POST /timed/admin/backfill-derived?key=...&limit=...&offset=...&ticker=...&includeTrades=1
      // Recompute derived horizon/ETA/TP fields for latest tickers (and optionally trades) and persist to KV.
      if (
        url.pathname === "/timed/admin/backfill-derived" &&
        req.method === "POST"
      ) {
        const authFail = requireKeyOr401(req, env);
        if (authFail) return authFail;

        const qLimit = Number(url.searchParams.get("limit") || "0");
        const qOffset = Number(url.searchParams.get("offset") || "0");
        const tickerFilter = normTicker(url.searchParams.get("ticker"));
        const includeTrades =
          String(url.searchParams.get("includeTrades") || "") === "1";

        const tickersList = (await kvGetJSON(KV, "timed:tickers")) || [];
        const filteredTickers = Array.isArray(tickersList)
          ? tickersList.filter((t) => {
              if (!t) return false;
              if (tickerFilter)
                return String(t).toUpperCase() === String(tickerFilter);
              return true;
            })
          : [];

        const offset = Math.max(0, Number.isFinite(qOffset) ? qOffset : 0);
        const limit =
          qLimit > 0
            ? Math.max(1, Math.min(2000, qLimit))
            : filteredTickers.length;
        const slice = filteredTickers.slice(offset, offset + limit);

        let tickersUpdated = 0;
        let tradesUpdated = 0;
        const errors = [];

        for (const t of slice) {
          try {
            const ticker = String(t || "").toUpperCase();
            if (!ticker) continue;
            const latestKey = `timed:latest:${ticker}`;
            const latest = await kvGetJSON(KV, latestKey);
            if (!latest || typeof latest !== "object") continue;
            const derived = deriveHorizonAndMetrics(latest);
            Object.assign(latest, derived);
            await kvPutJSON(KV, latestKey, latest);
            tickersUpdated += 1;
          } catch (e) {
            errors.push({ ticker: t || null, error: String(e) });
          }
        }

        if (includeTrades) {
          const tradesKey = "timed:trades:all";
          const allTrades = (await kvGetJSON(KV, tradesKey)) || [];
          if (Array.isArray(allTrades) && allTrades.length > 0) {
            for (const trade of allTrades) {
              if (!trade || !trade.ticker) continue;
              const tradeTicker = String(trade.ticker || "").toUpperCase();
              if (tickerFilter && tradeTicker !== tickerFilter) continue;
              try {
                const latest = await kvGetJSON(
                  KV,
                  `timed:latest:${tradeTicker}`,
                );
                const base =
                  latest && typeof latest === "object" ? latest : trade;
                const source = {
                  ...base,
                  entry_ref:
                    base.entry_ref != null
                      ? base.entry_ref
                      : (trade.entryPrice ?? base.trigger_price ?? base.price),
                  trigger_price: base.trigger_price ?? trade.entryPrice,
                  price: base.price ?? trade.currentPrice ?? trade.entryPrice,
                  sl: base.sl ?? trade.sl,
                  tp: base.tp ?? trade.tp,
                };
                const derived = deriveHorizonAndMetrics(source);
                trade.horizon_bucket = derived.horizon_bucket;
                trade.eta_days_v2 = derived.eta_days_v2;
                trade.expected_return_pct = derived.expected_return_pct;
                trade.risk_pct = derived.risk_pct;
                trade.tp_target_price = derived.tp_target_price;
                trade.tp_target_pct = derived.tp_target_pct;
                trade.tp_max_price = derived.tp_max_price;
                trade.tp_max_pct = derived.tp_max_pct;
                trade.entry_ref = derived.entry_ref ?? trade.entry_ref;
                tradesUpdated += 1;
              } catch (e) {
                errors.push({ trade_id: trade?.id || null, error: String(e) });
              }
            }
            await kvPutJSON(KV, tradesKey, allTrades);
          }
        }

        return sendJSON(
          {
            ok: true,
            ticker: tickerFilter || null,
            totalTickers: Array.isArray(tickersList) ? tickersList.length : 0,
            filtered: filteredTickers.length,
            offset,
            limit: slice.length,
            tickersUpdated,
            tradesUpdated: includeTrades ? tradesUpdated : 0,
            errorsCount: errors.length,
            errors: errors.slice(0, 25),
          },
          200,
          corsHeaders(env, req),
        );
      }

      // GET /timed/trades?version=2.1.0 (Get all trades, optional version filter)
      if (url.pathname === "/timed/trades" && req.method === "GET") {
        // Rate limiting - increased limits for UI polling (100 requests per minute)
        const ip = req.headers.get("CF-Connecting-IP") || "unknown";
        const rateLimit = await checkRateLimit(
          KV,
          ip,
          "/timed/trades",
          100, // 100 requests
          60, // per minute (instead of per hour)
        );

        if (!rateLimit.allowed) {
          return sendJSON(
            { ok: false, error: "rate_limit_exceeded", retryAfter: 60 },
            429,
            corsHeaders(env, req),
          );
        }
        const versionFilter = url.searchParams.get("version");
        const tradesKey = "timed:trades:all";
        let allTrades = (await kvGetJSON(KV, tradesKey)) || [];

        // Correct any trades with incorrect WIN/LOSS status based on P&L
        let corrected = false;
        for (let i = 0; i < allTrades.length; i++) {
          const trade = allTrades[i];
          if (
            (trade.status === "WIN" || trade.status === "LOSS") &&
            trade.pnl !== undefined &&
            trade.pnl !== null
          ) {
            // Check if status matches P&L
            if (trade.status === "WIN" && trade.pnl < 0) {
              console.log(
                `[TRADE CORRECTION] Correcting ${trade.ticker} ${
                  trade.direction
                }: WIN with negative P&L (${trade.pnl.toFixed(2)}) -> LOSS`,
              );
              allTrades[i] = { ...trade, status: "LOSS" };
              corrected = true;
            } else if (trade.status === "LOSS" && trade.pnl > 0) {
              console.log(
                `[TRADE CORRECTION] Correcting ${trade.ticker} ${
                  trade.direction
                }: LOSS with positive P&L (${trade.pnl.toFixed(2)}) -> WIN`,
              );
              allTrades[i] = { ...trade, status: "WIN" };
              corrected = true;
            }
          }
        }

        // Save corrected trades back to KV if any corrections were made
        if (corrected) {
          await kvPutJSON(KV, tradesKey, allTrades);
          console.log(
            `[TRADE CORRECTION] Saved ${allTrades.length} trades with corrections`,
          );
        }

        // Dedupe by (ticker, direction, entry_ts) — replay can create duplicates
        const entryTsForTrade = (t) => {
          const et = Number(t?.entry_ts ?? t?.entryTs);
          if (Number.isFinite(et)) return et;
          const iso = t?.entryTime;
          if (iso) return isoToMs(iso) || null;
          const hist = Array.isArray(t?.history) ? t.history : [];
          const ent = hist.find((e) => String(e?.type || "").toUpperCase() === "ENTRY");
          return ent ? isoToMs(ent.timestamp ?? ent.ts) || null : null;
        };
        const seen = new Set();
        const deduped = [];
        for (const t of allTrades) {
          const ticker = String(t?.ticker || "").toUpperCase();
          const dir = String(t?.direction || "").toUpperCase();
          const et = entryTsForTrade(t);
          const key = `${ticker}:${dir}:${et != null ? et : t?.id || ""}`;
          if (seen.has(key)) continue;
          seen.add(key);
          deduped.push(t);
        }
        if (deduped.length < allTrades.length) {
          await kvPutJSON(KV, tradesKey, deduped);
          allTrades = deduped;
        }

        let filteredTrades = allTrades;
        if (versionFilter && versionFilter !== "all") {
          filteredTrades = allTrades.filter(
            (t) => (t.scriptVersion || "unknown") === versionFilter,
          );
        }

        // Get unique versions for reference
        const versions = [
          ...new Set(allTrades.map((t) => t.scriptVersion || "unknown")),
        ]
          .sort()
          .reverse();

        return sendJSON(
          {
            ok: true,
            count: filteredTrades.length,
            totalCount: allTrades.length,
            version: versionFilter || "all",
            versions: versions,
            trades: filteredTrades,
            corrected: corrected, // Indicate if corrections were made
          },
          200,
          corsHeaders(env, req),
        );
      }

      // GET /timed/portfolio (paper portfolio + executions, derived from KV trades)
      if (url.pathname === "/timed/portfolio" && req.method === "GET") {
        const ip = req.headers.get("CF-Connecting-IP") || "unknown";
        const rateLimit = await checkRateLimit(
          KV,
          ip,
          "/timed/portfolio",
          2000,
          3600,
        );
        if (!rateLimit.allowed) {
          return sendJSON(
            { ok: false, error: "rate_limit_exceeded", retryAfter: 3600 },
            429,
            corsHeaders(env, req),
          );
        }

        const tradesKey = "timed:trades:all";
        const trades = (await kvGetJSON(KV, tradesKey)) || [];
        const startCash = PORTFOLIO_START_CASH;
        const events = [];

        const tpTargetPrice = (src) => {
          const directTarget = Number(src?.tp_target_price ?? src?.tp_target);
          if (Number.isFinite(directTarget) && directTarget > 0)
            return directTarget;
          const tp = Number(src?.tp);
          if (Number.isFinite(tp) && tp > 0) return tp;
          return null;
        };

        const toMs = (tsLike) => {
          const n =
            typeof tsLike === "string" ? isoToMs(tsLike) : Number(tsLike);
          if (!Number.isFinite(n) || n <= 0) return null;
          return n < 1e12 ? n * 1000 : n;
        };
        const dayKey = (ms) => {
          try {
            const d = new Date(ms);
            const y = d.getUTCFullYear();
            const m = String(d.getUTCMonth() + 1).padStart(2, "0");
            const da = String(d.getUTCDate()).padStart(2, "0");
            return `${y}-${m}-${da}`;
          } catch {
            return "unknown";
          }
        };

        for (const tr of trades) {
          const ticker = String(tr?.ticker || "").toUpperCase();
          const dir = String(tr?.direction || "").toUpperCase();
          const notional = Number(tr?.notional);
          const hist = Array.isArray(tr?.history) ? tr.history : [];
          for (const ev of hist) {
            const ts = toMs(ev?.timestamp ?? ev?.ts);
            if (!Number.isFinite(ts)) continue;
            const type = String(ev?.type || "").toUpperCase();
            if (!type) continue;
            const price = Number(ev?.price);
            const shares = Number(ev?.shares);
            const value = Number.isFinite(Number(ev?.value))
              ? Number(ev.value)
              : Number.isFinite(price) && Number.isFinite(shares)
                ? price * shares
                : null;
            events.push({
              ts,
              day: dayKey(ts),
              ticker,
              direction: dir,
              type,
              price: Number.isFinite(price) ? price : null,
              shares: Number.isFinite(shares) ? shares : null,
              value: Number.isFinite(value) ? value : null,
              reason: ev?.reason != null ? String(ev.reason) : null,
              notional: Number.isFinite(notional) ? notional : null,
              trade_id: tr?.id || null,
            });
          }
        }

        // Dedupe events (same ticker+direction+type+ts) — prevents duplicate tape entries
        const eventKey = (e) => `${e.ticker}:${e.direction}:${e.type}:${e.ts}`;
        const seenEvents = new Set();
        const dedupedEvents = [];
        for (const e of events) {
          const k = eventKey(e);
          if (seenEvents.has(k)) continue;
          seenEvents.add(k);
          dedupedEvents.push(e);
        }
        events.length = 0;
        events.push(...dedupedEvents);

        events.sort((a, b) => a.ts - b.ts);

        // Best-effort latest snapshots for tickers referenced by the portfolio/tape.
        const latestByTicker = {};
        try {
          const tickSet = new Set();
          for (const e of events)
            if (e?.ticker) tickSet.add(String(e.ticker).toUpperCase());
          for (const tr of trades)
            if (tr?.ticker) tickSet.add(String(tr.ticker).toUpperCase());
          const tickers = Array.from(tickSet).filter(Boolean).slice(0, 500);

          // Prefer D1 for reads (batch query), fallback to KV.
          if (env?.DB && tickers.length > 0) {
            await d1EnsureLatestSchema(env);
            const placeholders = tickers.map((_, i) => `?${i + 1}`).join(", ");
            const rows = await env.DB.prepare(
              `SELECT ticker, payload_json FROM ticker_latest WHERE ticker IN (${placeholders})`,
            )
              .bind(...tickers)
              .all();
            for (const r of rows?.results || []) {
              const sym = String(r?.ticker || "").toUpperCase();
              if (!sym) continue;
              const raw = r?.payload_json;
              if (!raw) continue;
              try {
                latestByTicker[sym] = JSON.parse(String(raw));
              } catch {
                // ignore
              }
            }
          }

          // Backfill from KV when D1 misses.
          const missing = tickers.filter((t) => !latestByTicker[t]);
          if (missing.length > 0) {
            for (const t of missing) {
              const v = await kvGetJSON(KV, `timed:latest:${t}`);
              if (v && typeof v === "object") {
                latestByTicker[t] = v;
                try {
                  ctx.waitUntil(d1UpsertTickerLatest(env, t, v));
                  ctx.waitUntil(d1UpsertTickerIndex(env, t, v?.ts));
                } catch {
                  // ignore
                }
              }
            }
          }
        } catch (e) {
          console.warn(
            `[PORTFOLIO] latest snapshot join failed:`,
            String(e?.message || e),
          );
        }

        // Replay portfolio from executions (simple cash + positions model)
        let cash = startCash;
        const positions = {}; // ticker -> {direction, shares, avgEntry, cost}

        const ensurePos = (tkr, dir) => {
          if (!positions[tkr])
            positions[tkr] = {
              ticker: tkr,
              direction: dir,
              shares: 0,
              avgEntry: null,
              cost: 0,
            };
          return positions[tkr];
        };

        for (const e of events) {
          if (!e.ticker || !e.type) continue;
          const tkr = e.ticker;
          const dir = e.direction || null;
          const shares = Number(e.shares);
          const value = Number(e.value);
          if (!Number.isFinite(shares) || shares <= 0) continue;
          if (!Number.isFinite(value) || value <= 0) continue;

          if (e.type === "ENTRY") {
            cash -= value;
            const p = ensurePos(tkr, dir);
            // simple avg entry calc
            const newShares = p.shares + shares;
            const entryPx = Number(e.price);
            const newCost = p.cost + value;
            p.shares = newShares;
            p.cost = newCost;
            p.avgEntry =
              Number.isFinite(entryPx) && newShares > 0
                ? newCost / newShares
                : p.avgEntry;
            p.direction = dir || p.direction;
          } else if (e.type === "TRIM" || e.type === "EXIT") {
            cash += value;
            const p = ensurePos(tkr, dir);
            p.shares = Math.max(0, p.shares - shares);
            if (p.shares <= 1e-9) {
              delete positions[tkr];
            }
          }
        }

        // Mark-to-market open positions using last known trade currentPrice (best-effort)
        let positionsValue = 0;
        const openPositions = [];
        for (const [tkr, p] of Object.entries(positions)) {
          const trade = trades.find(
            (x) =>
              String(x?.ticker || "").toUpperCase() === tkr &&
              isOpenTradeStatus(x?.status),
          );
          const latest = latestByTicker[String(tkr).toUpperCase()];
          const px = Number(
            latest?.price ??
              latest?.last ??
              latest?.close ??
              trade?.currentPrice ??
              trade?.price,
          );
          const val = Number.isFinite(px) ? px * Number(p.shares) : null;
          if (Number.isFinite(val)) positionsValue += val;
          openPositions.push({
            ticker: tkr,
            direction: p.direction,
            shares: p.shares,
            avgEntry: p.avgEntry,
            mark: Number.isFinite(px) ? px : null,
            value: Number.isFinite(val) ? val : null,
            phase_pct:
              latest?.phase_pct != null ? Number(latest.phase_pct) : null,
            completion:
              latest?.completion != null ? Number(latest.completion) : null,
            tp: tpTargetPrice(latest),
          });
        }

        const equity = cash + positionsValue;

        // Group executions by day and ticker
        const byDay = {};
        const byTicker = {};
        for (const e of events) {
          if (!byDay[e.day]) byDay[e.day] = [];
          byDay[e.day].push(e);
          if (!byTicker[e.ticker]) byTicker[e.ticker] = [];
          byTicker[e.ticker].push(e);
        }

        // Proof snapshot (server-side join): per-day rows with trade details.
        const proofByDay = {};
        try {
          const entryByTradeId = new Map(); // trade_id -> { entryPrice, entryShares, entryTs, direction }
          for (const e of events) {
            if (
              e?.type === "ENTRY" &&
              e?.trade_id &&
              Number.isFinite(Number(e?.price))
            ) {
              entryByTradeId.set(String(e.trade_id), {
                entryPrice: Number(e.price),
                entryShares: Number.isFinite(Number(e?.shares))
                  ? Number(e.shares)
                  : null,
                entryTs: Number.isFinite(Number(e?.ts)) ? Number(e.ts) : null,
                direction: e?.direction || null,
              });
            }
          }

          // Index open positions for remaining qty and avgEntry/mark.
          const posByTickerDir = new Map(); // `${tkr}:${dir}` -> pos
          for (const p of openPositions) {
            const key = `${String(p.ticker).toUpperCase()}:${String(p.direction || "").toUpperCase()}`;
            posByTickerDir.set(key, p);
          }

          const getPos = (tkr, dir) => {
            const key = `${String(tkr).toUpperCase()}:${String(dir || "").toUpperCase()}`;
            return posByTickerDir.get(key) || null;
          };

          for (const [day, dayEvents] of Object.entries(byDay)) {
            const arr = Array.isArray(dayEvents) ? dayEvents : [];
            const tradesById = new Map();
            let entries = 0,
              trims = 0,
              exits = 0;
            let realizedPnl = 0;
            const closedById = new Map(); // trade_id -> pnl

            for (const e of arr) {
              const tradeId = e?.trade_id ? String(e.trade_id) : null;
              const tkr = String(e?.ticker || "").toUpperCase();
              const type = String(e?.type || "").toUpperCase();
              if (type === "ENTRY") entries += 1;
              if (type === "TRIM") trims += 1;
              if (type === "EXIT") exits += 1;

              if (!tradeId || !tkr) continue;
              if (!tradesById.has(tradeId)) {
                const meta = entryByTradeId.get(tradeId) || {};
                const latest = latestByTicker[tkr] || null;
                const pos = getPos(tkr, meta.direction || e?.direction || "");
                const currentPx = Number(
                  pos?.mark ??
                    latest?.price ??
                    latest?.last ??
                    latest?.close ??
                    null,
                );
                const entryPx = Number.isFinite(Number(pos?.avgEntry))
                  ? Number(pos.avgEntry)
                  : Number(meta?.entryPrice);
                tradesById.set(tradeId, {
                  trade_id: tradeId,
                  ticker: tkr,
                  direction:
                    String(
                      meta.direction || e?.direction || "",
                    ).toUpperCase() || null,
                  entry: {
                    ts: meta?.entryTs ?? null,
                    price: Number.isFinite(entryPx) ? entryPx : null,
                    shares: meta?.entryShares ?? null,
                  },
                  current: {
                    price: Number.isFinite(currentPx) ? currentPx : null,
                    phase_pct:
                      latest?.phase_pct != null
                        ? Number(latest.phase_pct)
                        : null,
                    completion:
                      latest?.completion != null
                        ? Number(latest.completion)
                        : null,
                    tp: tpTargetPrice(latest),
                    ts: latest?.ts != null ? toMs(latest.ts) : null,
                  },
                  last_action_type: null,
                  last_action_ts: null,
                  trim_price: null,
                  exit_price: null,
                  exit_reason: null,
                  remaining_qty:
                    pos?.shares != null ? Number(pos.shares) : null,
                  realized_pnl: 0,
                });
              }

              const t = tradesById.get(tradeId);
              const px = Number(e?.price);
              const sh = Number(e?.shares);
              if (Number.isFinite(Number(e?.ts)))
                t.last_action_ts = Number(e.ts);
              t.last_action_type = type || t.last_action_type;
              if (type === "TRIM" && Number.isFinite(px)) t.trim_price = px;
              if (type === "EXIT" && Number.isFinite(px)) t.exit_price = px;
              if (type === "EXIT" && e?.reason)
                t.exit_reason = String(e.reason);

              // realized pnl for trim/exit if entry is known
              const entryPx = Number(t?.entry?.price);
              const dir = String(t?.direction || "").toUpperCase();
              const sign = dir === "SHORT" ? -1 : 1;
              if (
                (type === "TRIM" || type === "EXIT") &&
                Number.isFinite(entryPx) &&
                Number.isFinite(px) &&
                Number.isFinite(sh)
              ) {
                const pnl = (px - entryPx) * sh * sign;
                t.realized_pnl += pnl;
                realizedPnl += pnl;
                if (type === "EXIT") closedById.set(tradeId, pnl);
              }
            }

            let wins = 0,
              losses = 0;
            for (const pnl of closedById.values()) {
              if (!Number.isFinite(pnl) || pnl === 0) continue;
              if (pnl > 0) wins += 1;
              if (pnl < 0) losses += 1;
            }

            proofByDay[day] = {
              day,
              stats: {
                entries,
                trims,
                exits,
                wins,
                losses,
                realizedPnl,
              },
              trades: Array.from(tradesById.values()).sort(
                (a, b) =>
                  Number(b.last_action_ts || 0) - Number(a.last_action_ts || 0),
              ),
            };
          }
        } catch (e) {
          console.warn(
            `[PORTFOLIO] proof build failed:`,
            String(e?.message || e),
          );
        }

        return sendJSON(
          {
            ok: true,
            portfolio: {
              startCash,
              cash,
              equity,
              positionsValue,
              openPositions,
              updated_at: Date.now(),
            },
            executions: {
              count: events.length,
              byDay,
              byTicker,
            },
            proof: {
              generated_at: Date.now(),
              byDay: proofByDay,
            },
          },
          200,
          corsHeaders(env, req),
        );
      }

      // POST /timed/trades?key=... (Create or update trade)
      if (url.pathname === "/timed/trades" && req.method === "POST") {
        const authFail = requireKeyOr401(req, env);
        if (authFail) return authFail;

        const { obj: body, err } = await readBodyAsJSON(req);
        if (!body || !body.id) {
          return sendJSON(
            { ok: false, error: "missing trade id" },
            400,
            corsHeaders(env, req),
          );
        }

        const tradesKey = "timed:trades:all";
        const allTrades = (await kvGetJSON(KV, tradesKey)) || [];

        // Find existing trade or add new one
        const existingIndex = allTrades.findIndex((t) => t.id === body.id);

        if (existingIndex >= 0) {
          // Update existing trade
          allTrades[existingIndex] = { ...allTrades[existingIndex], ...body };
        } else {
          // Add new trade
          allTrades.push(body);
        }

        // Sort by entry time (newest first)
        allTrades.sort((a, b) => {
          const timeA = new Date(a.entryTime || 0).getTime();
          const timeB = new Date(b.entryTime || 0).getTime();
          return timeB - timeA;
        });

        await kvPutJSON(KV, tradesKey, allTrades);

        return sendJSON(
          {
            ok: true,
            trade: existingIndex >= 0 ? allTrades[existingIndex] : body,
            action: existingIndex >= 0 ? "updated" : "created",
          },
          200,
          corsHeaders(env, req),
        );
      }

      // DELETE /timed/trades/:id?key=... (Delete trade)
      if (
        url.pathname.startsWith("/timed/trades/") &&
        req.method === "DELETE"
      ) {
        const authFail = requireKeyOr401(req, env);
        if (authFail) return authFail;

        const tradeId = url.pathname.split("/timed/trades/")[1];
        if (!tradeId) {
          return sendJSON(
            { ok: false, error: "missing trade id" },
            400,
            corsHeaders(env, req),
          );
        }

        const tradesKey = "timed:trades:all";
        const allTrades = (await kvGetJSON(KV, tradesKey)) || [];
        const filteredTrades = allTrades.filter((t) => t.id !== tradeId);

        await kvPutJSON(KV, tradesKey, filteredTrades);

        return sendJSON(
          {
            ok: true,
            deleted: allTrades.length - filteredTrades.length === 1,
            remainingCount: filteredTrades.length,
          },
          200,
          corsHeaders(env, req),
        );
      }

      // OPTIONS /timed/ai/chat (CORS preflight)
      if (url.pathname === "/timed/ai/chat" && req.method === "OPTIONS") {
        const origin = req?.headers?.get("Origin") || "";
        // Always allow timedtrading.pages.dev origin, otherwise use "*"
        const allowedOrigin = origin.includes("timedtrading.pages.dev")
          ? origin
          : "*";
        const aiChatCorsHeaders = {
          "Access-Control-Allow-Origin": allowedOrigin,
          "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "86400",
          Vary: "Origin",
        };
        return new Response(null, {
          status: 204,
          headers: aiChatCorsHeaders,
        });
      }

      // POST /timed/ai/chat (AI Chat Assistant)
      if (url.pathname === "/timed/ai/chat" && req.method === "POST") {
        // Get CORS headers early - always allow timedtrading.pages.dev for AI chat
        const origin = req?.headers?.get("Origin") || "";
        // Always allow timedtrading.pages.dev origin, otherwise use "*"
        const allowedOrigin = origin.includes("timedtrading.pages.dev")
          ? origin
          : "*";
        const aiChatCorsHeaders = {
          "Access-Control-Allow-Origin": allowedOrigin,
          "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          Vary: "Origin",
        };

        // Wrap entire handler in try-catch to ensure CORS headers are always returned
        try {
          // Handle JSON parsing errors with CORS headers
          let body;
          try {
            const result = await readBodyAsJSON(req);
            if (result.err) {
              return sendJSON(
                { ok: false, error: "Invalid JSON in request body" },
                400,
                aiChatCorsHeaders,
              );
            }
            body = result.obj;
          } catch (e) {
            return sendJSON(
              { ok: false, error: "Failed to parse request body" },
              400,
              aiChatCorsHeaders,
            );
          }

          if (!body || !body.message) {
            return sendJSON(
              { ok: false, error: "missing message" },
              400,
              aiChatCorsHeaders,
            );
          }

          try {
            const openaiApiKey = env.OPENAI_API_KEY;
            if (!openaiApiKey) {
              return sendJSON(
                {
                  ok: false,
                  error:
                    "AI service not configured. Please set OPENAI_API_KEY secret.",
                },
                503,
                aiChatCorsHeaders,
              );
            }

            // Fetch full ticker data for context
            const tickerSymbols = body.tickerData || [];
            const tickerContext = [];

            // Handle ticker data fetching with error handling
            try {
              const tickerDataPromises = tickerSymbols
                .slice(0, 20)
                .map(async (ticker) => {
                  try {
                    const latestData = await kvGetJSON(
                      KV,
                      `timed:latest:${ticker}`,
                    );
                    if (latestData) {
                      return {
                        ticker: ticker,
                        rank: latestData.rank || 0,
                        rr: latestData.rr || 0,
                        price: latestData.price || 0,
                        state: latestData.state || "",
                        phase_pct: latestData.phase_pct || 0,
                        completion: latestData.completion || 0,
                        flags: latestData.flags || {},
                      };
                    }
                    return null;
                  } catch (err) {
                    console.error(
                      `[AI CHAT] Error fetching ticker ${ticker}:`,
                      err,
                    );
                    return null;
                  }
                });

              const tickerDataResults = await Promise.all(tickerDataPromises);
              tickerDataResults
                .filter(Boolean)
                .forEach((t) => tickerContext.push(t));
            } catch (err) {
              console.error("[AI CHAT] Error fetching ticker data:", err);
              // Continue with empty ticker context - not critical
            }

            // Format activity feed context with safe handling
            const activityContext = [];
            try {
              const rawActivityData = body.activityData || [];
              if (Array.isArray(rawActivityData)) {
                rawActivityData.slice(0, 10).forEach((event) => {
                  try {
                    if (event && typeof event === "object") {
                      const ts = event.ts ? Number(event.ts) : Date.now();
                      const price = Number(event.price) || 0;
                      activityContext.push({
                        ticker: String(event.ticker || "UNKNOWN"),
                        type: String(event.type || "event"),
                        time:
                          ts > 0
                            ? new Date(ts).toLocaleTimeString()
                            : "Unknown time",
                        price: price,
                        rank: Number(event.rank) || 0,
                      });
                    }
                  } catch (e) {
                    console.error(
                      "[AI CHAT] Error formatting activity event:",
                      e,
                    );
                    // Skip this event
                  }
                });
              }
            } catch (err) {
              console.error("[AI CHAT] Error processing activity data:", err);
              // Continue with empty activity context - not critical
            }

            // Build system prompt with context
            const systemPrompt = `You are an expert trading analyst assistant and active monitor for the Timed Trading platform. 
Your role is to continuously observe market conditions, identify opportunities, warn about risks, and help traders make informed decisions.

## YOUR CAPABILITIES
- **Real-time Monitoring**: Continuously observe ticker data, activity feeds, and market conditions
- **Proactive Alerts**: Identify good trades to watch, warnings about risks, trim/exit signals
- **Pattern Recognition**: Learn from trade history and identify profitable patterns
- **Data Analysis**: Analyze ticker data (ranks, RR, phase, completion, states)
- **Signal Interpretation**: Interpret trading signals and setups
- **System Education**: Explain the quadrant-based trading system
- **Risk Management**: Provide risk assessments and actionable insights
- **Research Capabilities**: Answer questions about setups, signals, and market research (note: external research APIs can be added later)

## AVAILABLE DATA
- **${
              tickerContext.length
            } tickers** with real-time data (rank, RR, price, phase, completion, state)
- **${
              activityContext.length
            } recent activity events** (corridor entries, squeeze releases, alignments)

### Sample Ticker Data (Top 10):
${
  tickerContext.length > 0
    ? tickerContext
        .slice(0, 10)
        .map((t) => {
          try {
            const rr = Number(t.rr) || 0;
            const price = Number(t.price) || 0;
            const phasePct = Number(t.phase_pct) || 0;
            const completion = Number(t.completion) || 0;
            return `- **${String(t.ticker || "UNKNOWN")}**: Rank ${
              Number(t.rank) || 0
            }, RR ${rr.toFixed(2)}:1, Price $${price.toFixed(
              2,
            )}, State: ${String(t.state || "UNKNOWN")}, Phase: ${(
              phasePct * 100
            ).toFixed(0)}%, Completion: ${(completion * 100).toFixed(0)}%`;
          } catch (e) {
            console.error("[AI CHAT] Error formatting ticker:", t, e);
            return `- **${String(t.ticker || "UNKNOWN")}**: Data unavailable`;
          }
        })
        .filter(Boolean)
        .join("\n")
    : "No ticker data available"
}

### Recent Activity:
${
  activityContext.length > 0
    ? activityContext
        .map((a) => {
          try {
            const price = Number(a.price) || 0;
            return `- ${String(a.time || "Unknown time")}: **${String(
              a.ticker || "UNKNOWN",
            )}** ${String(a.type || "event")} at $${price.toFixed(2)}`;
          } catch (e) {
            console.error("[AI CHAT] Error formatting activity:", a, e);
            return null;
          }
        })
        .filter(Boolean)
        .join("\n")
    : "No recent activity"
}

## TRADING SYSTEM OVERVIEW

### Quadrant System:
The platform uses a quadrant-based approach combining Higher Timeframe (HTF) and Lower Timeframe (LTF) signals:

- **Q1 (HTF_BULL_LTF_PULLBACK)**: Bull Setup - High timeframe bullish, short-term pullback. Waiting for entry confirmation.
- **Q2 (HTF_BULL_LTF_BULL)**: Bull Momentum - Both timeframes bullish. Active long trend, momentum phase.
- **Q3 (HTF_BEAR_LTF_BEAR)**: Bear Momentum - Both timeframes bearish. Active short trend, momentum phase.
- **Q4 (HTF_BEAR_LTF_PULLBACK)**: Bear Setup - High timeframe bearish, short-term pullback. Waiting for entry confirmation.

### Setup Quality Indicators:
- **Prime Setup**: High rank (≥75), excellent RR (≥1.5), low completion (<40%), favorable phase (<60%). Highest quality setups.
- **Momentum Elite**: High-quality momentum stock with strong fundamentals (volume, ADR, momentum metrics).
- **In Corridor**: Price is in the optimal entry zone for the directional setup (LTF score between -8 to +12 for LONG, -12 to +8 for SHORT).
- **Squeeze Release**: Momentum indicator suggesting a directional move is beginning (pent-up energy releasing).

### Key Metrics:
- **Rank**: Composite score (0-100) based on multiple factors. Higher = better setup quality.
- **RR (Risk/Reward)**: Ratio of potential profit to potential loss. ≥1.5 is considered good.
- **Phase %**: Position in the market cycle (0-100%). Lower (<40%) = early, higher (>60%) = late.
- **Completion %**: How far price has moved toward target (0-100%). Lower = more upside potential.

## MONITORING & PROACTIVE ALERTS

As an active monitor, you should:

1. **Identify Opportunities**:
   - Prime setups (Rank ≥75, RR ≥1.5, Completion <40%, Phase <60%)
   - Momentum Elite stocks entering good setups
   - New corridor entries with strong signals
   - Squeeze releases indicating potential moves

2. **Flag Warnings**:
   - High completion (>70%) - consider trimming or exiting
   - Late phase (>80%) - risk of reversal
   - Positions approaching stop loss
   - Setups losing quality (rank dropping, RR deteriorating)

3. **Pattern Recognition**:
   - Identify which setups/types perform best
   - Recognize when similar patterns led to wins/losses
   - Suggest improvements based on historical performance

4. **Continuous Learning**:
   - Reference trade history when relevant
   - Learn from what worked and what didn't
   - Adapt recommendations based on patterns

## RESPONSE GUIDELINES

1. **Be concise but thorough**: 
   - Simple queries: 2-4 sentences
   - Analysis questions: More detailed but organized
   - Monitoring queries: Structured with Opportunities, Warnings, Insights, Recommendations
   - Use bullet points for multiple items

2. **Always reference data**: 
   - Cite specific ranks, RR values, prices, states
   - Reference activity feed events when relevant
   - Mention trade history patterns when applicable
   - If ticker data isn't available, say so clearly

3. **Provide actionable insights**:
   - Not just data, but interpretation
   - Highlight risks and opportunities proactively
   - Suggest next steps (watch, enter, trim, exit)
   - Be specific: "Consider trimming 50% of POSITION at $PRICE"

4. **Risk awareness**:
   - Always mention risks for high-completion setups
   - Caution about late-phase positions
   - Note when setups lack confirmation
   - Warn about approaching stop losses

5. **Formatting**:
   - Use **bold** for tickers and key terms
   - Use \`code\` for technical terms
   - Use bullet points for lists
   - Use emojis for quick scanning: 🎯 Opportunities, ⚠️ Warnings, 📊 Insights, 💡 Recommendations
   - Keep paragraphs short (2-3 sentences max)

6. **Educational approach**:
   - Explain concepts if user seems unfamiliar
   - Define abbreviations on first use
   - Provide context for recommendations
   - Reference the trading system when explaining decisions

## EXAMPLE RESPONSES

**Good response for "What's the status of AAPL?"**:
"**AAPL** is currently ranked #X with an RR of X:1. It's in Q2 (Bull Momentum) with phase at X% and completion at X%. [Specific insight based on data]. [Risk assessment if relevant]."

**Good response for "Show me prime setups"**:
"Based on current data, here are the prime setups: [List with ranks and RR]. These setups have high rank (≥75), good RR (≥1.5), and are in early stages. [Overall market context]."

Remember: You're a helpful assistant. Be professional, accurate, and prioritize user safety by emphasizing risk management.`;

            // Format conversation history
            const messages = [
              { role: "system", content: systemPrompt },
              ...(body.conversationHistory || []).slice(-8).map((msg) => ({
                role: msg.role,
                content: msg.content,
              })),
              { role: "user", content: body.message },
            ];

            // Call OpenAI API with timeout
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout

            let aiResponse;
            try {
              aiResponse = await fetch(
                "https://api.openai.com/v1/chat/completions",
                {
                  method: "POST",
                  headers: {
                    Authorization: `Bearer ${openaiApiKey}`,
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({
                    model:
                      env.OPENAI_MODEL && env.OPENAI_MODEL !== "gpt-4"
                        ? env.OPENAI_MODEL
                        : "gpt-3.5-turbo",
                    messages: messages,
                    temperature: 0.7,
                    max_tokens: 800,
                  }),
                  signal: controller.signal,
                },
              );
            } catch (fetchError) {
              clearTimeout(timeoutId);
              if (fetchError.name === "AbortError") {
                throw new Error(
                  "Request timeout - OpenAI API took too long to respond",
                );
              }
              throw new Error(`Network error: ${fetchError.message}`);
            }

            clearTimeout(timeoutId);

            if (!aiResponse.ok) {
              let errorData = {};
              try {
                errorData = await aiResponse.json();
              } catch (e) {
                // If response isn't JSON, use status text
                errorData = { error: { message: aiResponse.statusText } };
              }
              console.error(
                "[AI CHAT] OpenAI API error:",
                aiResponse.status,
                errorData,
              );
              // Provide user-friendly error messages for common OpenAI errors
              let errorMessage =
                errorData.error?.message ||
                `OpenAI API error: ${aiResponse.status}`;
              if (aiResponse.status === 429) {
                if (errorData.error?.code === "insufficient_quota") {
                  errorMessage =
                    "OpenAI API quota exceeded. Please check your billing and plan details.";
                } else {
                  errorMessage =
                    "OpenAI API rate limit exceeded. Please try again later.";
                }
              }
              throw new Error(errorMessage);
            }

            let aiData;
            try {
              aiData = await aiResponse.json();
            } catch (e) {
              throw new Error("Invalid JSON response from OpenAI API");
            }

            const aiMessage =
              aiData.choices?.[0]?.message?.content ||
              "Sorry, I couldn't process that request.";

            // Extract sources if any tickers were mentioned
            const mentionedTickers = [];
            const tickerRegex = /\b([A-Z]{1,5})\b/g;
            const matches = body.message.toUpperCase().match(tickerRegex);
            if (matches) {
              matches.forEach((ticker) => {
                if (tickerContext.some((t) => t.ticker === ticker)) {
                  mentionedTickers.push(ticker);
                }
              });
            }

            return sendJSON(
              {
                ok: true,
                response: aiMessage,
                sources:
                  mentionedTickers.length > 0
                    ? [`Data from: ${mentionedTickers.join(", ")}`]
                    : [],
                timestamp: Date.now(),
              },
              200,
              aiChatCorsHeaders,
            );
          } catch (error) {
            // Catch any errors (including errors in error handling)
            console.error("[AI CHAT ERROR]", error);
            console.error("[AI CHAT ERROR] Stack:", error.stack);
            console.error("[AI CHAT ERROR] Message:", error.message);
            console.error("[AI CHAT ERROR] Name:", error.name);
            // Always return CORS headers even on error
            try {
              return sendJSON(
                {
                  ok: false,
                  error: error.message || "AI service error",
                  details: error.stack,
                },
                500,
                aiChatCorsHeaders,
              );
            } catch (sendError) {
              // If even sendJSON fails, return a basic response with CORS headers
              console.error(
                "[AI CHAT FATAL ERROR] Failed to send error response:",
                sendError,
              );
              return new Response(
                JSON.stringify({ ok: false, error: "Internal server error" }),
                {
                  status: 500,
                  headers: {
                    "Content-Type": "application/json",
                    ...aiChatCorsHeaders,
                  },
                },
              );
            }
          } // End of inner try-catch for OpenAI API
        } catch (fatalError) {
          // Catch any unhandled errors that might crash the worker
          console.error("[AI CHAT FATAL ERROR]", fatalError);
          console.error("[AI CHAT FATAL ERROR] Stack:", fatalError?.stack);
          console.error("[AI CHAT FATAL ERROR] Message:", fatalError?.message);
          console.error("[AI CHAT FATAL ERROR] Name:", fatalError?.name);
          console.error("[AI CHAT FATAL ERROR] Type:", typeof fatalError);
          // Always return CORS headers even on fatal errors
          // Re-create CORS headers in case they're out of scope
          const origin = req?.headers?.get("Origin") || "";
          const allowedOrigin = origin.includes("timedtrading.pages.dev")
            ? origin
            : "*";
          const fatalCorsHeaders = {
            "Access-Control-Allow-Origin": allowedOrigin,
            "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
            Vary: "Origin",
          };
          try {
            return sendJSON(
              {
                ok: false,
                error: "Internal server error",
                details: fatalError?.message || "Unknown error",
              },
              500,
              fatalCorsHeaders,
            );
          } catch (sendError) {
            // Last resort - return basic response
            console.error("[AI CHAT] Even sendJSON failed:", sendError);
            return new Response(
              JSON.stringify({ ok: false, error: "Internal server error" }),
              {
                status: 500,
                headers: {
                  "Content-Type": "application/json",
                  ...fatalCorsHeaders,
                },
              },
            );
          }
        }
      } // End of POST /timed/ai/chat handler

      // GET /timed/ai/updates (Get periodic AI updates)
      if (url.pathname === "/timed/ai/updates" && req.method === "GET") {
        const origin = req?.headers?.get("Origin") || "";
        const allowedOrigin = origin.includes("timedtrading.pages.dev")
          ? origin
          : "*";
        const aiChatCorsHeaders = {
          "Access-Control-Allow-Origin": allowedOrigin,
          "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          Vary: "Origin",
        };

        try {
          const limit = parseInt(url.searchParams.get("limit") || "10", 10);

          // Get list of updates
          const updatesListKey = `timed:ai:updates:list`;
          const updatesList = (await kvGetJSON(KV, updatesListKey)) || [];

          // Fetch actual update data
          const updatesPromises = updatesList
            .slice(0, limit)
            .map(async (item) => {
              try {
                const updateData = await kvGetJSON(KV, item.key);
                return updateData;
              } catch (err) {
                return null;
              }
            });

          const updates = (await Promise.all(updatesPromises))
            .filter(Boolean)
            .sort((a, b) => {
              const timeA = a.timestamp ? new Date(a.timestamp).getTime() : 0;
              const timeB = b.timestamp ? new Date(b.timestamp).getTime() : 0;
              return timeB - timeA;
            });

          return sendJSON(
            {
              ok: true,
              updates,
              count: updates.length,
            },
            200,
            aiChatCorsHeaders,
          );
        } catch (error) {
          console.error("[AI UPDATES ERROR]", error);
          return sendJSON(
            {
              ok: false,
              error: error.message || "Failed to fetch updates",
            },
            500,
            aiChatCorsHeaders,
          );
        }
      }

      // GET /timed/ai/daily-summary (Daily Summary of Simulation Dashboard Performance)
      if (url.pathname === "/timed/ai/daily-summary" && req.method === "GET") {
        const origin = req?.headers?.get("Origin") || "";
        const allowedOrigin = origin.includes("timedtrading.pages.dev")
          ? origin
          : "*";
        const aiChatCorsHeaders = {
          "Access-Control-Allow-Origin": allowedOrigin,
          "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          Vary: "Origin",
        };

        try {
          const openaiApiKey = env.OPENAI_API_KEY;
          if (!openaiApiKey) {
            return sendJSON(
              {
                ok: false,
                error:
                  "AI service not configured. Please set OPENAI_API_KEY secret.",
              },
              503,
              aiChatCorsHeaders,
            );
          }

          // Get date filter (default: today)
          const dateParam = url.searchParams.get("date");
          const targetDate = dateParam ? new Date(dateParam) : new Date();
          const todayStart = new Date(targetDate);
          todayStart.setHours(0, 0, 0, 0);
          const todayEnd = new Date(targetDate);
          todayEnd.setHours(23, 59, 59, 999);

          // Fetch all trades from unified storage
          const tradesKey = "timed:trades:all";
          const allTrades = (await kvGetJSON(KV, tradesKey)) || [];

          // Filter trades by date
          const todayTrades = allTrades.filter((trade) => {
            if (!trade.entryTime) return false;
            const entryDate = new Date(trade.entryTime);
            return entryDate >= todayStart && entryDate <= todayEnd;
          });

          // Categorize trades
          const newTrades = todayTrades.filter(
            (t) => t.status === "OPEN" || !t.status,
          );
          const closedTrades = todayTrades.filter(
            (t) => t.status === "WIN" || t.status === "LOSS",
          );
          const trimmedTrades = todayTrades.filter(
            (t) => t.status === "TP_HIT_TRIM",
          );

          // Calculate P&L
          const closedPnl = closedTrades.reduce(
            (sum, t) => sum + (Number(t.pnl) || 0),
            0,
          );
          const openPnl = newTrades.reduce(
            (sum, t) => sum + (Number(t.pnl) || 0),
            0,
          );
          const trimmedPnl = trimmedTrades.reduce(
            (sum, t) => sum + (Number(t.pnl) || 0),
            0,
          );

          // Calculate win rate
          const wins = closedTrades.filter((t) => t.status === "WIN").length;
          const losses = closedTrades.filter((t) => t.status === "LOSS").length;
          const winRate =
            closedTrades.length > 0 ? (wins / closedTrades.length) * 100 : 0;

          // Analyze patterns for learning
          const winningTrades = closedTrades.filter((t) => t.status === "WIN");
          const losingTrades = closedTrades.filter((t) => t.status === "LOSS");

          // Analyze by signal types (trigger reasons and flags)
          const signalAnalysis = {};
          const allTradesForSignals = [...todayTrades];
          allTradesForSignals.forEach((trade) => {
            const signals = [];

            // Trigger reasons
            if (trade.state) {
              const state = String(trade.state || "");
              if (state.includes("BULL")) signals.push("HTF_BULL");
              if (state.includes("BEAR")) signals.push("HTF_BEAR");
              if (state.includes("PULLBACK")) signals.push("LTF_PULLBACK");
              if (state.includes("LTF_BULL")) signals.push("LTF_BULL");
              if (state.includes("LTF_BEAR")) signals.push("LTF_BEAR");
            }

            // Flags
            const flags = trade.flags || {};
            if (flags.sq30_release) signals.push("SQUEEZE_RELEASE");
            if (flags.sq30_on) signals.push("SQUEEZE_ON");
            if (flags.phase_zone_change) signals.push("PHASE_ZONE_CHANGE");
            if (flags.momentum_elite) signals.push("MOMENTUM_ELITE");

            // Trigger reason
            if (trade.trigger_reason) {
              const triggerReason = String(trade.trigger_reason || "");
              if (triggerReason === "EMA_CROSS")
                signals.push("EMA_CROSS_DAILY");
              if (triggerReason === "SQUEEZE_RELEASE")
                signals.push("SQUEEZE_RELEASE_TRIGGER");
            }

            const signalKey =
              signals.length > 0 ? signals.sort().join("+") : "NO_SIGNALS";

            if (!signalAnalysis[signalKey]) {
              signalAnalysis[signalKey] = {
                total: 0,
                wins: 0,
                losses: 0,
                totalPnl: 0,
                trades: [],
              };
            }

            signalAnalysis[signalKey].total++;
            if (trade.status === "WIN") signalAnalysis[signalKey].wins++;
            if (trade.status === "LOSS") signalAnalysis[signalKey].losses++;
            signalAnalysis[signalKey].totalPnl += Number(trade.pnl) || 0;
            signalAnalysis[signalKey].trades.push({
              ticker: trade.ticker,
              status: trade.status,
              pnl: Number(trade.pnl) || 0,
              rank: Number(trade.rank) || 0,
              rr: Number(trade.rr) || 0,
            });
          });

          // Analyze by rank ranges
          const rankAnalysis = {};
          closedTrades.forEach((trade) => {
            const rank = Number(trade.rank) || 0;
            let range = "Unknown";
            if (rank >= 80) range = "Rank ≥ 80";
            else if (rank >= 70) range = "Rank 70-80";
            else if (rank >= 60) range = "Rank 60-70";
            else if (rank > 0) range = "Rank < 60";

            if (!rankAnalysis[range]) {
              rankAnalysis[range] = { wins: 0, losses: 0, totalPnl: 0 };
            }
            if (trade.status === "WIN") rankAnalysis[range].wins++;
            if (trade.status === "LOSS") rankAnalysis[range].losses++;
            rankAnalysis[range].totalPnl += Number(trade.pnl) || 0;
          });

          // Analyze by RR ranges
          const rrAnalysis = {};
          closedTrades.forEach((trade) => {
            const rr = Number(trade.rr) || 0;
            let range = "Unknown";
            if (rr >= 2.0) range = "RR ≥ 2.0";
            else if (rr >= 1.5) range = "RR 1.5-2.0";
            else if (rr >= 1.0) range = "RR 1.0-1.5";
            else if (rr > 0) range = "RR < 1.0";

            if (!rrAnalysis[range]) {
              rrAnalysis[range] = { wins: 0, losses: 0, totalPnl: 0 };
            }
            if (trade.status === "WIN") rrAnalysis[range].wins++;
            if (trade.status === "LOSS") rrAnalysis[range].losses++;
            rrAnalysis[range].totalPnl += Number(trade.pnl) || 0;
          });

          // Find most common signals
          const topSignals = Object.entries(signalAnalysis)
            .filter(([_, stats]) => stats.total >= 2)
            .sort((a, b) => {
              const aRate = a[1].wins / (a[1].wins + a[1].losses || 1);
              const bRate = b[1].wins / (b[1].wins + b[1].losses || 1);
              return bRate - aRate;
            })
            .slice(0, 5);

          // Build summary prompt
          const summaryPrompt = `You are a senior trading analyst providing a comprehensive daily market thesis. Write as if someone asked you: "How did the market do today? What interesting developments were there?"

Your response should be thesis-driven, narrative, and detailed - like a professional market commentary.

## TODAY'S PERFORMANCE SUMMARY

**Date:** ${targetDate.toLocaleDateString()}

### Trade Activity:
- **New Trades:** ${newTrades.length}
- **Closed Trades:** ${closedTrades.length} (${wins} wins, ${losses} losses)
- **Trimmed Trades:** ${trimmedTrades.length}

### P&L Summary:
- **Closed P&L:** $${closedPnl.toFixed(2)}
- **Open P&L:** $${openPnl.toFixed(2)}
- **Trimmed P&L:** $${trimmedPnl.toFixed(2)}
- **Total P&L:** $${(closedPnl + openPnl + trimmedPnl).toFixed(2)}
- **Win Rate:** ${winRate.toFixed(1)}%

### Signal Breakdown - What Drove Today's Trades:

**Most Common Signal Combinations:**
${
  topSignals.length > 0
    ? topSignals
        .map(
          ([signals, stats]) =>
            `- **${signals}**: ${stats.total} trades | ${stats.wins}W/${
              stats.losses
            }L (${(
              (stats.wins / (stats.wins + stats.losses || 1)) *
              100
            ).toFixed(1)}% win rate) | P&L: $${stats.totalPnl.toFixed(2)}`,
        )
        .join("\n")
    : "No significant signal patterns"
}

**Signal Details:**
- **EMA Crossovers (Daily)**: ${
            allTradesForSignals.filter((t) => t.trigger_reason === "EMA_CROSS")
              .length
          } trades
- **Squeeze Releases**: ${
            allTradesForSignals.filter((t) => t.flags?.sq30_release).length
          } trades
- **Momentum Elite**: ${
            allTradesForSignals.filter((t) => t.flags?.momentum_elite).length
          } trades
- **Phase Zone Changes**: ${
            allTradesForSignals.filter((t) => t.flags?.phase_zone_change).length
          } trades

---

### Performance by Rank:
${
  Object.entries(rankAnalysis)
    .map(
      ([range, stats]) =>
        `- **${range}**: ${stats.wins}W/${
          stats.losses
        }L | P&L: $${stats.totalPnl.toFixed(2)}`,
    )
    .join("\n") || "No data"
}

---

### Performance by RR:
${
  Object.entries(rrAnalysis)
    .map(
      ([range, stats]) =>
        `- **${range}**: ${stats.wins}W/${
          stats.losses
        }L | P&L: $${stats.totalPnl.toFixed(2)}`,
    )
    .join("\n") || "No data"
}

---

### Top Performers:
${
  winningTrades
    .sort((a, b) => (Number(b.pnl) || 0) - (Number(a.pnl) || 0))
    .slice(0, 5)
    .map((t) => {
      const rr = Number(t.rr) || 0;
      const rrFormatted =
        rr >= 1 ? `${rr.toFixed(2)}:1` : `1:${(1 / rr).toFixed(2)}`;
      return `- **${t.ticker}**: +$${(Number(t.pnl) || 0).toFixed(2)} | Rank ${
        t.rank || 0
      } | RR ${rrFormatted}`;
    })
    .join("\n") || "None"
}

### Worst Performers:
${
  losingTrades
    .sort((a, b) => (Number(a.pnl) || 0) - (Number(b.pnl) || 0))
    .slice(0, 5)
    .map((t) => {
      const rr = Number(t.rr) || 0;
      const rrFormatted =
        rr >= 1 ? `${rr.toFixed(2)}:1` : `1:${(1 / rr).toFixed(2)}`;
      return `- **${t.ticker}**: $${(Number(t.pnl) || 0).toFixed(2)} | Rank ${
        t.rank || 0
      } | RR ${rrFormatted}`;
    })
    .join("\n") || "None"
}

### Current Open Positions (For Actionable Recommendations):
${
  newTrades.length > 0
    ? newTrades
        .slice(0, 10)
        .map((t) => {
          const entryPrice = Number(t.entryPrice) || 0;
          const currentPrice = Number(t.currentPrice) || entryPrice;
          const sl = Number(t.sl) || 0;
          const tp = Number(t.tp) || 0;
          const rr = Number(t.rr) || 0;
          const rrFormatted =
            rr >= 1 ? `${rr.toFixed(2)}:1` : `1:${(1 / rr).toFixed(2)}`;
          const direction = String(t.direction || "LONG");
          const riskPerShare =
            direction === "LONG" ? entryPrice - sl : sl - entryPrice;
          const rewardPerShare =
            direction === "LONG" ? tp - entryPrice : entryPrice - tp;
          const distanceToTP =
            direction === "LONG" ? tp - currentPrice : currentPrice - tp;
          const distanceToSL =
            direction === "LONG" ? currentPrice - sl : sl - currentPrice;
          const pctToTP =
            entryPrice > 0
              ? ((distanceToTP / rewardPerShare) * 100).toFixed(0)
              : "0";
          const trimLevel = tp; // Trim at first TP

          return `- **${t.ticker}** (${direction}): Entry $${entryPrice.toFixed(
            2,
          )} | Current $${currentPrice.toFixed(2)} | SL $${sl.toFixed(
            2,
          )} | TP $${tp.toFixed(2)} | RR ${rrFormatted} | Rank ${
            t.rank || 0
          } | ${pctToTP}% to TP`;
        })
        .join("\n")
    : "No open positions"
}

## YOUR TASK

Write a comprehensive, thesis-driven daily market summary. Structure it as follows:

### 1. **Market Thesis** (2-3 paragraphs)
Start with a clear thesis statement: "Today's market was characterized by [X]..." 
- What was the overall market character? (Bullish momentum, choppy consolidation, bearish pressure, etc.)
- What drove the day's activity? (EMA crossovers, squeeze releases, specific setups)
- Were there any notable patterns or themes?

### 2. **Signal-Driven Analysis** (Detailed breakdown)
For each major signal type, explain:
- **EMA Crossovers**: How many occurred? Were they on the daily timeframe? Did they lead to successful trades? What was the typical setup?
- **Squeeze Releases**: How many squeeze releases triggered trades? Were they bullish or bearish? How did they perform?
- **Momentum Elite**: Did Momentum Elite stocks outperform? What was their win rate?
- **Phase Zone Changes**: Did phase transitions lead to good entries? Were they early or late in the cycle?

Break down what specifically drove the scores and signals. For example:
- "The majority of winning trades today were driven by EMA crossovers on the daily timeframe, particularly when combined with squeeze releases. These setups showed an average rank of 78 and RR of 2.1:1..."
- "Squeeze releases were the dominant signal, accounting for X% of new entries. However, they showed mixed results - bullish squeezes in Q2 (HTF_BULL_LTF_BULL) performed well with a Y% win rate, while bearish squeezes struggled..."

### 3. **Interesting Developments** (What stood out)
- Were there any unusual patterns? (e.g., "Rank ≥80 trades significantly outperformed today")
- Did certain sectors or setups surprise? (e.g., "Short setups unexpectedly outperformed longs")
- Any notable failures or successes? (e.g., "High RR trades (>2.0) had perfect win rate but low volume")

### 4. **Performance Breakdown by Signals**
Reference the signal analysis data above. Explain which signal combinations worked best and why.

### 5. **Actionable Trade Recommendations** (Walk-through with actual details)
For each open position, provide specific guidance:

**Format for each recommendation:**
\`\`\`
**[TICKER]** - [DIRECTION] Setup
- **Current Price**: $X.XX
- **Entry Price**: $X.XX (if different from current)
- **Stop Loss**: $X.XX (risk: $X.XX per share, X.X% risk)
- **Take Profit**: $X.XX (reward: $X.XX per share, X.X% reward)
- **Risk/Reward**: X.X:1
- **Current Status**: X% to TP / X% above SL
- **When to Trim**: Trim 50% at $X.XX (first TP level)
- **Action Plan**: [Specific guidance - e.g., "Hold until TP at $X.XX, then trim 50%. Move SL to breakeven if price reaches $X.XX"]
- **Risk Assessment**: [Any concerns - e.g., "Approaching SL, consider tightening stop if price breaks below $X.XX"]
\`\`\`

Provide 3-5 most important open positions with full walk-through details. Be specific about price levels, percentages, and exact actions.

### 6. **Recommendations for Scoring/Capturing** (System improvements)
Based on today's data:
- Should we adjust minimum rank thresholds? (e.g., "Rank ≥80 showed 85% win rate vs 60% for Rank 70-80")
- Should we adjust RR requirements? (e.g., "RR ≥2.0 trades had perfect win rate")
- Are certain signal combinations performing better? (e.g., "EMA_CROSS+SQUEEZE_RELEASE+MOMENTUM_ELITE had 90% win rate")
- What patterns should we focus on? (e.g., "Focus on Momentum Elite stocks with squeeze releases")

### 7. **What to Watch Tomorrow**
- What setups are forming?
- What signals are developing?
- Any warnings or opportunities?

**Writing Style:**
- Write in a narrative, conversational tone (like explaining to a colleague)
- Use specific data points and examples
- Be detailed about signal mechanics (e.g., "EMA crossovers on the daily timeframe when price was above the 21 EMA")
- Reference actual tickers when relevant
- Make it insightful, not just data-dumping

**Length:** Aim for 800-1200 words. Be thorough but focused.`;

          // Call OpenAI API
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 30000);

          let aiResponse;
          try {
            aiResponse = await fetch(
              "https://api.openai.com/v1/chat/completions",
              {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${openaiApiKey}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  model:
                    env.OPENAI_MODEL && env.OPENAI_MODEL !== "gpt-4"
                      ? env.OPENAI_MODEL
                      : "gpt-3.5-turbo",
                  messages: [{ role: "system", content: summaryPrompt }],
                  temperature: 0.7,
                  max_tokens: 2000,
                }),
                signal: controller.signal,
              },
            );
          } catch (fetchError) {
            clearTimeout(timeoutId);
            if (fetchError.name === "AbortError") {
              throw new Error("Request timeout");
            }
            throw new Error(`Network error: ${fetchError.message}`);
          }

          clearTimeout(timeoutId);

          if (!aiResponse.ok) {
            throw new Error(`OpenAI API error: ${aiResponse.status}`);
          }

          const aiData = await aiResponse.json();
          const summary =
            aiData.choices?.[0]?.message?.content ||
            "Daily summary unavailable.";

          return sendJSON(
            {
              ok: true,
              summary,
              stats: {
                date: targetDate.toISOString().split("T")[0],
                newTrades: newTrades.length,
                closedTrades: closedTrades.length,
                trimmedTrades: trimmedTrades.length,
                wins,
                losses,
                winRate: winRate.toFixed(1),
                closedPnl: closedPnl.toFixed(2),
                openPnl: openPnl.toFixed(2),
                trimmedPnl: trimmedPnl.toFixed(2),
                totalPnl: (closedPnl + openPnl + trimmedPnl).toFixed(2),
                rankAnalysis,
                rrAnalysis,
                signalAnalysis,
                topSignals: topSignals.map(([signals, stats]) => ({
                  signals,
                  ...stats,
                })),
              },
              timestamp: Date.now(),
            },
            200,
            aiChatCorsHeaders,
          );
        } catch (error) {
          console.error("[DAILY SUMMARY ERROR]", error);
          return sendJSON(
            {
              ok: false,
              error: error.message || "Daily summary service error",
            },
            500,
            aiChatCorsHeaders,
          );
        }
      }

      // GET /timed/ai/monitor (Real-time Monitoring & Proactive Alerts)
      if (url.pathname === "/timed/ai/monitor" && req.method === "GET") {
        const origin = req?.headers?.get("Origin") || "";
        const allowedOrigin = origin.includes("timedtrading.pages.dev")
          ? origin
          : "*";
        const aiChatCorsHeaders = {
          "Access-Control-Allow-Origin": allowedOrigin,
          "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          Vary: "Origin",
        };

        try {
          const openaiApiKey = env.OPENAI_API_KEY;
          if (!openaiApiKey) {
            return sendJSON(
              {
                ok: false,
                error:
                  "AI service not configured. Please set OPENAI_API_KEY secret.",
              },
              503,
              aiChatCorsHeaders,
            );
          }

          // Fetch all ticker data
          const allKeys = await KV.list({ prefix: "timed:latest:" });
          const tickerDataPromises = allKeys.keys
            .slice(0, 50)
            .map(async (key) => {
              try {
                const data = await kvGetJSON(KV, key.name);
                if (data) {
                  const ticker = key.name.replace("timed:latest:", "");
                  return {
                    ticker,
                    rank: Number(data.rank) || 0,
                    rr: Number(data.rr) || 0,
                    price: Number(data.price) || 0,
                    state: String(data.state || ""),
                    phase_pct: Number(data.phase_pct) || 0,
                    completion: Number(data.completion) || 0,
                    flags: data.flags || {},
                    htf_score: Number(data.htf_score) || 0,
                    ltf_score: Number(data.ltf_score) || 0,
                    sl: Number(data.sl) || 0,
                    tp: Number(data.tp) || 0,
                  };
                }
                return null;
              } catch (err) {
                console.error(`[AI MONITOR] Error fetching ${key.name}:`, err);
                return null;
              }
            });

          const allTickers = (await Promise.all(tickerDataPromises))
            .filter(Boolean)
            .sort((a, b) => (b.rank || 0) - (a.rank || 0));

          // Fetch recent activity feed (last 20 events)
          const activityKeys = await KV.list({ prefix: "timed:activity:" });
          const recentActivity = [];
          const activityPromises = activityKeys.keys
            .slice(-20)
            .map(async (key) => {
              try {
                const data = await kvGetJSON(KV, key.name);
                if (data) {
                  return {
                    ticker: String(data.ticker || "UNKNOWN"),
                    type: String(data.type || "event"),
                    ts: Number(data.ts) || Date.now(),
                    price: Number(data.price) || 0,
                    rank: Number(data.rank) || 0,
                  };
                }
                return null;
              } catch (err) {
                return null;
              }
            });

          const activityEvents = (await Promise.all(activityPromises))
            .filter(Boolean)
            .sort((a, b) => b.ts - a.ts)
            .slice(0, 20);

          // Fetch trade history for pattern recognition
          const tradesKey = "timed:trades:all";
          const allTradesForHistory = (await kvGetJSON(KV, tradesKey)) || [];
          const tradeHistory = allTradesForHistory
            .filter((t) => t.status === "WIN" || t.status === "LOSS")
            .slice(-50) // Increased to 50 for better pattern recognition
            .map((t) => ({
              ticker: String(t.ticker || ""),
              direction: String(t.direction || ""),
              status: String(t.status || ""),
              pnl: Number(t.pnl) || 0,
              rank: Number(t.rank) || 0,
              rr: Number(t.rr) || 0,
              entryTime: String(t.entryTime || ""),
              state: String(t.state || ""),
              flags: t.flags || {},
            }));

          // Pattern Recognition: Analyze winning patterns
          const winningPatterns = analyzeWinningPatterns(
            tradeHistory,
            allTickers,
          );

          // Proactive Alerts: Detect conditions that need attention
          const proactiveAlerts = generateProactiveAlerts(
            allTickers,
            allTradesForHistory,
          );

          // Analyze for proactive alerts
          const primeSetups = allTickers.filter(
            (t) =>
              t.rank >= 75 &&
              t.rr >= 1.5 &&
              t.completion < 0.4 &&
              t.phase_pct < 0.6,
          );

          const highRiskPositions = allTickers.filter(
            (t) => t.completion > 0.7 || t.phase_pct > 0.8,
          );

          const momentumEliteSetups = allTickers.filter(
            (t) => t.flags?.momentum_elite && t.rank >= 70,
          );

          // Build monitoring prompt
          const monitoringPrompt = `You are an AI trading monitor for the Timed Trading platform. Your role is to continuously observe market conditions, identify opportunities, warn about risks, and provide actionable insights.

## YOUR MONITORING CAPABILITIES
- **Real-time Market Analysis**: Monitor all tickers and activity feeds
- **Proactive Alerts**: Identify good trades, warnings, trim/exit signals
- **Pattern Recognition**: Learn from trade history and identify patterns
- **Risk Management**: Flag high-risk positions and suggest exits
- **Opportunity Detection**: Surface prime setups and momentum elite stocks

## CURRENT MARKET DATA
- **${allTickers.length} total tickers** being monitored
- **${
            primeSetups.length
          } prime setups** (Rank ≥75, RR ≥1.5, Completion <40%, Phase <60%)
- **${
            highRiskPositions.length
          } high-risk positions** (Completion >70% or Phase >80%)
- **${momentumEliteSetups.length} Momentum Elite setups**
- **${activityEvents.length} recent activity events**
- **${tradeHistory.length} closed trades** for pattern analysis

### Top Prime Setups (${primeSetups.slice(0, 10).length}):
${
  primeSetups
    .slice(0, 10)
    .map((t) => {
      const rr = Number(t.rr) || 0;
      const rrFormatted =
        rr >= 1 ? `${rr.toFixed(2)}:1` : `1:${(1 / rr).toFixed(2)}`;
      return `- **${t.ticker}**: Rank ${
        t.rank
      } | RR ${rrFormatted} | Price $${t.price.toFixed(2)} | Phase ${(
        t.phase_pct * 100
      ).toFixed(0)}% | Completion ${(t.completion * 100).toFixed(0)}%`;
    })
    .join("\n") || "None"
}

### High-Risk Positions (${highRiskPositions.slice(0, 10).length}):
${
  highRiskPositions
    .slice(0, 10)
    .map(
      (t) =>
        `- **${t.ticker}**: Rank ${t.rank}, Completion ${(
          t.completion * 100
        ).toFixed(0)}%, Phase ${(t.phase_pct * 100).toFixed(
          0,
        )}%, Price $${t.price.toFixed(2)}`,
    )
    .join("\n") || "None"
}

### Recent Activity (Last ${activityEvents.slice(0, 10).length}):
${
  activityEvents
    .slice(0, 10)
    .map(
      (a) =>
        `- ${new Date(a.ts).toLocaleTimeString()}: **${a.ticker}** ${
          a.type
        } at $${a.price.toFixed(2)}`,
    )
    .join("\n") || "None"
}

### Trade History Patterns (Last ${tradeHistory.length}):
${
  tradeHistory.length > 0
    ? `Win Rate: ${(
        (tradeHistory.filter((t) => t.status === "WIN").length /
          tradeHistory.length) *
        100
      ).toFixed(1)}%\n` +
      `Avg P&L: $${(
        tradeHistory.reduce((sum, t) => sum + (t.pnl || 0), 0) /
        tradeHistory.length
      ).toFixed(2)}\n` +
      `Best Performers: ${tradeHistory
        .filter((t) => t.pnl > 0)
        .sort((a, b) => b.pnl - a.pnl)
        .slice(0, 5)
        .map((t) => `${t.ticker} (+$${t.pnl.toFixed(2)})`)
        .join(", ")}`
    : "No trade history available"
}

### Pattern Recognition Insights:
${winningPatterns.summary || "Analyzing patterns..."}

### Proactive Alerts (${proactiveAlerts.length}):
${
  proactiveAlerts.length > 0
    ? proactiveAlerts
        .slice(0, 10)
        .map((a) => `- **${a.type}**: ${a.message}`)
        .join("\n")
    : "No alerts at this time"
}

## MONITORING RESPONSE FORMAT

Provide a well-structured, easy-to-read analysis with clear spacing and formatting:

### 🎯 Opportunities

List prime setups worth watching and pattern matches. For each opportunity:
- Use bullet points with ticker symbol in **bold**
- Include: Rank, RR, Price, Phase %, Completion %
- Add a brief reason why it's worth watching
- Leave a blank line between each opportunity

Example format:
\`\`\`
- **AWI**: Rank 89 | RR 2.00:1 | Price $189.56 | Phase 34% | Completion 15%
  Prime setup with excellent risk/reward and early stage positioning.
\`\`\`

### ⚠️ Warnings

List high-risk positions and positions approaching TP/SL. Group by type:
- **High-Risk Positions**: (Completion >70% or Phase >80%)
- **Approaching TP**: (Within 5% of Take Profit - consider trimming)
- **Approaching SL**: (Within 5% of Stop Loss - monitor closely)

For each warning:
- Use bullet points with ticker symbol in **bold**
- Include relevant metrics (Completion %, Phase %, distance to TP/SL)
- Add specific action recommendation
- Leave a blank line between each warning

Example format:
\`\`\`
**High-Risk Positions:**
- **ALB**: Rank 90 | Completion 19% | Phase 83% | Price $162.05
  Late phase position - consider trimming or tightening stops.

**Approaching TP:**
- **GS**: Within 2.3% of TP at $940.68
  Consider trimming 50% at TP to lock in profits.
\`\`\`

### 📊 Market Insights

Provide overall market conditions and pattern recognition findings:
- Start with a brief summary sentence
- Reference pattern recognition insights from above
- Mention any notable trends or patterns
- Use bullet points for key insights
- Leave blank lines between major points

### 💡 Recommendations

Provide 3-5 actionable next steps:
- Number each recommendation (1., 2., 3.)
- Be specific and actionable
- Reference specific tickers when relevant
- Include price levels or percentages when applicable
- Leave blank lines between each recommendation

**FORMATTING GUIDELINES:**
- Use **bold** for ticker symbols and key terms
- Use blank lines (double newlines) to separate major sections
- Use bullet points (-) for lists within sections
- Use numbered lists (1., 2., 3.) for recommendations
- Keep paragraphs short (2-3 sentences max)
- Use code formatting for specific values like prices or percentages

**IMPORTANT**: Reference the proactive alerts above and pattern recognition insights. Prioritize alerts marked as "high" priority. Be concise but thorough. Focus on actionable insights, not just data.`;

          // Call OpenAI API
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 30000);

          let aiResponse;
          try {
            aiResponse = await fetch(
              "https://api.openai.com/v1/chat/completions",
              {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${openaiApiKey}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  model:
                    env.OPENAI_MODEL && env.OPENAI_MODEL !== "gpt-4"
                      ? env.OPENAI_MODEL
                      : "gpt-3.5-turbo",
                  messages: [{ role: "system", content: monitoringPrompt }],
                  temperature: 0.7,
                  max_tokens: 1000,
                }),
                signal: controller.signal,
              },
            );
          } catch (fetchError) {
            clearTimeout(timeoutId);
            if (fetchError.name === "AbortError") {
              throw new Error("Request timeout");
            }
            throw new Error(`Network error: ${fetchError.message}`);
          }

          clearTimeout(timeoutId);

          if (!aiResponse.ok) {
            let errorData = {};
            try {
              errorData = await aiResponse.json();
            } catch (e) {
              errorData = { error: { message: aiResponse.statusText } };
            }
            throw new Error(
              errorData.error?.message ||
                `OpenAI API error: ${aiResponse.status}`,
            );
          }

          const aiData = await aiResponse.json();
          const aiMessage =
            aiData.choices?.[0]?.message?.content ||
            "Monitoring analysis unavailable.";

          return sendJSON(
            {
              ok: true,
              analysis: aiMessage,
              stats: {
                totalTickers: allTickers.length,
                primeSetups: primeSetups.length,
                highRiskPositions: highRiskPositions.length,
                momentumElite: momentumEliteSetups.length,
                recentActivity: activityEvents.length,
                tradeHistory: tradeHistory.length,
              },
              timestamp: Date.now(),
            },
            200,
            aiChatCorsHeaders,
          );
        } catch (error) {
          console.error("[AI MONITOR ERROR]", error);
          return sendJSON(
            {
              ok: false,
              error: error.message || "Monitoring service error",
            },
            500,
            aiChatCorsHeaders,
          );
        }
      }

      // ─────────────────────────────────────────────────────────────
      // Debug Endpoints
      // ─────────────────────────────────────────────────────────────

      // GET /timed/debug/trades?ticker=RIOT - Get all trades with details, optionally filtered by ticker
      if (url.pathname === "/timed/debug/trades" && req.method === "GET") {
        const authFail = requireKeyOr401(req, env);
        if (authFail) return authFail;

        try {
          const tradesKey = "timed:trades:all";
          const allTrades = (await kvGetJSON(KV, tradesKey)) || [];

          // Optional ticker filter
          const tickerFilter = url.searchParams.get("ticker");
          let filteredTrades = allTrades;
          if (tickerFilter) {
            const tickerUpper = String(tickerFilter).toUpperCase();
            filteredTrades = allTrades.filter(
              (t) => String(t.ticker || "").toUpperCase() === tickerUpper,
            );
          }

          const openTrades = filteredTrades.filter(
            (t) =>
              t.status === "OPEN" || !t.status || t.status === "TP_HIT_TRIM",
          );
          const closedTrades = filteredTrades.filter(
            (t) => t.status === "WIN" || t.status === "LOSS",
          );

          return sendJSON(
            {
              ok: true,
              ticker: tickerFilter || null,
              total: filteredTrades.length,
              open: openTrades.length,
              closed: closedTrades.length,
              trades: filteredTrades,
              summary: {
                byVersion: filteredTrades.reduce((acc, t) => {
                  const v = t.scriptVersion || "unknown";
                  acc[v] = (acc[v] || 0) + 1;
                  return acc;
                }, {}),
                byStatus: filteredTrades.reduce((acc, t) => {
                  const s = t.status || "OPEN";
                  acc[s] = (acc[s] || 0) + 1;
                  return acc;
                }, {}),
              },
            },
            200,
            corsHeaders(env, req),
          );
        } catch (err) {
          return sendJSON(
            { ok: false, error: err.message },
            500,
            corsHeaders(env, req),
          );
        }
      }

      // GET /timed/debug/score-analysis - Analyze score distribution
      if (
        url.pathname === "/timed/debug/score-analysis" &&
        req.method === "GET"
      ) {
        const authFail = requireKeyOr401(req, env);
        if (authFail) return authFail;

        try {
          const tickerIndex = (await kvGetJSON(KV, "timed:tickers")) || [];
          const tickerDataPromises = tickerIndex.map(async (ticker) => {
            const data = await kvGetJSON(KV, `timed:latest:${ticker}`);
            return data;
          });

          const allData = (await Promise.all(tickerDataPromises)).filter(
            Boolean,
          );

          // Score distribution
          const scoreRanges = {
            "90-100": 0,
            "80-89": 0,
            "70-79": 0,
            "60-69": 0,
            "50-59": 0,
            "40-49": 0,
            "30-39": 0,
            "20-29": 0,
            "10-19": 0,
            "0-9": 0,
          };

          const scoreBreakdown = [];
          const componentStats = {
            aligned: { count: 0, avgScore: 0 },
            setup: { count: 0, avgScore: 0 },
            squeezeRelease: { count: 0, avgScore: 0 },
            squeezeOn: { count: 0, avgScore: 0 },
            momentumElite: { count: 0, avgScore: 0 },
            phaseZoneChange: { count: 0, avgScore: 0 },
          };

          allData.forEach((d) => {
            const rank = Number(d.rank) || 0;
            const scoreRange =
              rank >= 90
                ? "90-100"
                : rank >= 80
                  ? "80-89"
                  : rank >= 70
                    ? "70-79"
                    : rank >= 60
                      ? "60-69"
                      : rank >= 50
                        ? "50-59"
                        : rank >= 40
                          ? "40-49"
                          : rank >= 30
                            ? "30-39"
                            : rank >= 20
                              ? "20-29"
                              : rank >= 10
                                ? "10-19"
                                : "0-9";
            scoreRanges[scoreRange]++;

            // Component analysis
            const state = String(d.state || "");
            const aligned =
              state === "HTF_BULL_LTF_BULL" || state === "HTF_BEAR_LTF_BEAR";
            const setup =
              state === "HTF_BULL_LTF_PULLBACK" ||
              state === "HTF_BEAR_LTF_PULLBACK";
            const flags = d.flags || {};
            const sqRel = !!flags.sq30_release;
            const sqOn = !!flags.sq30_on;
            const momentumElite = !!flags.momentum_elite;
            const phaseZoneChange = !!flags.phase_zone_change;

            if (aligned) {
              componentStats.aligned.count++;
              componentStats.aligned.avgScore += rank;
            }
            if (setup) {
              componentStats.setup.count++;
              componentStats.setup.avgScore += rank;
            }
            if (sqRel) {
              componentStats.squeezeRelease.count++;
              componentStats.squeezeRelease.avgScore += rank;
            }
            if (sqOn && !sqRel) {
              componentStats.squeezeOn.count++;
              componentStats.squeezeOn.avgScore += rank;
            }
            if (momentumElite) {
              componentStats.momentumElite.count++;
              componentStats.momentumElite.avgScore += rank;
            }
            if (phaseZoneChange) {
              componentStats.phaseZoneChange.count++;
              componentStats.phaseZoneChange.avgScore += rank;
            }

            // Detailed breakdown for high scores
            if (rank >= 85) {
              const htf = Number(d.htf_score) || 0;
              const ltf = Number(d.ltf_score) || 0;
              const comp = Number(d.completion) || 0;
              const phase = Number(d.phase_pct) || 0;
              const rr = Number(d.rr) || 0;

              scoreBreakdown.push({
                ticker: d.ticker,
                rank,
                state,
                aligned,
                setup,
                htf_score: htf,
                ltf_score: ltf,
                completion: comp,
                phase_pct: phase,
                rr,
                flags: {
                  sq30_release: sqRel,
                  sq30_on: sqOn,
                  momentum_elite: momentumElite,
                  phase_zone_change: phaseZoneChange,
                },
              });
            }
          });

          // Calculate averages
          Object.keys(componentStats).forEach((key) => {
            if (componentStats[key].count > 0) {
              componentStats[key].avgScore =
                componentStats[key].avgScore / componentStats[key].count;
            }
          });

          // Overall stats
          const ranks = allData
            .map((d) => Number(d.rank) || 0)
            .filter((r) => r > 0);
          const avgRank =
            ranks.length > 0
              ? ranks.reduce((a, b) => a + b, 0) / ranks.length
              : 0;
          const medianRank =
            ranks.length > 0
              ? ranks.sort((a, b) => a - b)[Math.floor(ranks.length / 2)]
              : 0;
          const maxRank = ranks.length > 0 ? Math.max(...ranks) : 0;
          const minRank = ranks.length > 0 ? Math.min(...ranks) : 0;

          return sendJSON(
            {
              ok: true,
              summary: {
                totalTickers: allData.length,
                avgRank: Math.round(avgRank * 100) / 100,
                medianRank,
                maxRank,
                minRank,
              },
              distribution: scoreRanges,
              componentStats,
              highScoreBreakdown: scoreBreakdown.slice(0, 50), // Top 50 high scores
            },
            200,
            corsHeaders(env, req),
          );
        } catch (err) {
          return sendJSON(
            { ok: false, error: err.message },
            500,
            corsHeaders(env, req),
          );
        }
      }

      // GET /timed/debug/tickers - Get all tickers with latest data
      if (url.pathname === "/timed/debug/tickers" && req.method === "GET") {
        const authFail = requireKeyOr401(req, env);
        if (authFail) return authFail;

        try {
          const tickerIndex = (await kvGetJSON(KV, "timed:tickers")) || [];
          const tickerDataPromises = tickerIndex
            .slice(0, 100)
            .map(async (ticker) => {
              const data = await kvGetJSON(KV, `timed:latest:${ticker}`);
              return {
                ticker,
                hasData: !!data,
                data: data
                  ? {
                      price: data.price,
                      state: data.state,
                      rank: data.rank,
                      rr: data.rr,
                      completion: data.completion,
                      phase_pct: data.phase_pct,
                      sl: data.sl,
                      tp: data.tp,
                      script_version: data.script_version,
                      ingest_time: data.ingest_time,
                    }
                  : null,
              };
            });

          const tickerData = await Promise.all(tickerDataPromises);

          return sendJSON(
            {
              ok: true,
              totalTickers: tickerIndex.length,
              tickersWithData: tickerData.filter((t) => t.hasData).length,
              tickers: tickerData,
            },
            200,
            corsHeaders(env, req),
          );
        } catch (err) {
          return sendJSON(
            { ok: false, error: err.message },
            500,
            corsHeaders(env, req),
          );
        }
      }

      // GET /timed/debug/config - Check Discord and other configuration
      if (url.pathname === "/timed/debug/config" && req.method === "GET") {
        const authFail = requireKeyOr401(req, env);
        if (authFail) return authFail;

        return sendJSON(
          {
            ok: true,
            config: {
              discordEnabled: (env.DISCORD_ENABLE || "false") === "true",
              discordWebhookSet: !!env.DISCORD_WEBHOOK_URL,
              discordWebhookUrl: env.DISCORD_WEBHOOK_URL
                ? "***SET***"
                : "NOT SET",
              openaiApiKeySet: !!env.OPENAI_API_KEY,
              openaiModel: env.OPENAI_MODEL || "gpt-3.5-turbo",
              alertMinRR: env.ALERT_MIN_RR || "1.5",
              alertMaxCompletion: env.ALERT_MAX_COMPLETION || "0.4",
              alertMaxPhase: env.ALERT_MAX_PHASE || "0.6",
              alertMinRank: env.ALERT_MIN_RANK || "70",
            },
          },
          200,
          corsHeaders(env, req),
        );
      }

      // GET /timed/debug/daily?ticker=AMD
      // Debug endpoint to inspect daily change inputs/sources (latest vs capture vs worker-derived).
      if (url.pathname === "/timed/debug/daily" && req.method === "GET") {
        const authFail = requireKeyOr401(req, env);
        if (authFail) return authFail;

        const ticker = normTicker(url.searchParams.get("ticker"));
        if (!ticker) {
          return sendJSON(
            { ok: false, error: "missing ticker" },
            400,
            corsHeaders(env, req),
          );
        }

        const latest = await kvGetJSON(KV, `timed:latest:${ticker}`);
        const capture = await kvGetJSON(KV, `timed:capture:latest:${ticker}`);

        const pick = (obj, keys) => {
          for (const k of keys) {
            if (!obj || typeof obj !== "object") continue;
            if (obj[k] != null) return obj[k];
          }
          return null;
        };
        const num = (v) => {
          const n = Number(v);
          return Number.isFinite(n) ? n : null;
        };

        const latestTs = num(pick(latest, ["ts", "ingest_ts"])) || null;
        const captureTs = num(pick(capture, ["ts", "ingest_ts"])) || null;
        const asOfTs = latestTs || captureTs || Date.now();

        let derived = null;
        try {
          if (env?.DB) {
            const rec = await computePrevCloseFromTrail(env.DB, ticker, asOfTs);
            const price =
              num(pick(latest, ["price"])) ?? num(pick(capture, ["price"]));
            if (rec && Number.isFinite(price) && price > 0) {
              derived = {
                prev_close: rec.close,
                prev_close_day: rec.dayKey,
                prev_close_ts: rec.ts,
                day_change: price - rec.close,
                day_change_pct: ((price - rec.close) / rec.close) * 100,
              };
            } else {
              derived = {
                prev_close: null,
                reason: rec ? "bad_price" : "no_prev_close_row",
              };
            }
          }
        } catch (e) {
          derived = { prev_close: null, error: String(e?.message || e) };
        }

        const fields = [
          "price",
          "prev_close",
          "day_change",
          "day_change_pct",
          "change",
          "change_pct",
          "session",
          "is_rth",
          "ts",
          "ingest_ts",
        ];
        const subset = (obj) => {
          const out = {};
          for (const k of fields)
            if (obj && typeof obj === "object" && obj[k] != null)
              out[k] = obj[k];
          return out;
        };

        return sendJSON(
          {
            ok: true,
            ticker,
            latest: subset(latest),
            capture: subset(capture),
            derived,
          },
          200,
          corsHeaders(env, req),
        );
      }

      // POST /timed/debug/cleanup-duplicates?key=...&ticker=RIOT - Remove duplicate trades for a ticker
      if (
        url.pathname === "/timed/debug/cleanup-duplicates" &&
        req.method === "POST"
      ) {
        const authFail = requireKeyOr401(req, env);
        if (authFail) return authFail;

        try {
          const tradesKey = "timed:trades:all";
          const allTrades = (await kvGetJSON(KV, tradesKey)) || [];
          const tickerFilter = url.searchParams.get("ticker");

          if (!tickerFilter) {
            return sendJSON(
              { ok: false, error: "ticker parameter required" },
              400,
              corsHeaders(env, req),
            );
          }

          const tickerUpper = String(tickerFilter).toUpperCase();
          const tickerTrades = allTrades.filter(
            (t) => String(t.ticker || "").toUpperCase() === tickerUpper,
          );

          if (tickerTrades.length === 0) {
            return sendJSON(
              {
                ok: true,
                message: `No trades found for ${tickerUpper}`,
                removed: 0,
                kept: 0,
              },
              200,
              corsHeaders(env, req),
            );
          }

          // Group by direction and find duplicates
          const byDirection = {};
          tickerTrades.forEach((trade) => {
            const dir = trade.direction || "UNKNOWN";
            if (!byDirection[dir]) {
              byDirection[dir] = [];
            }
            byDirection[dir].push(trade);
          });

          const tradesToKeep = [];
          const tradesToRemove = [];

          Object.keys(byDirection).forEach((direction) => {
            const dirTrades = byDirection[direction];

            // Keep the most recent open trade, or if all closed, keep the most recent one
            const openTrades = dirTrades.filter(
              (t) =>
                t.status === "OPEN" || !t.status || t.status === "TP_HIT_TRIM",
            );

            if (openTrades.length > 0) {
              // Keep the most recent open trade
              const sortedOpen = openTrades.sort((a, b) => {
                const timeA = new Date(a.entryTime || 0).getTime();
                const timeB = new Date(b.entryTime || 0).getTime();
                return timeB - timeA;
              });
              tradesToKeep.push(sortedOpen[0]);
              tradesToRemove.push(...sortedOpen.slice(1));
              tradesToRemove.push(
                ...dirTrades.filter((t) => !openTrades.includes(t)),
              );
            } else {
              // All closed - keep the most recent one
              const sortedClosed = dirTrades.sort((a, b) => {
                const timeA = new Date(a.entryTime || 0).getTime();
                const timeB = new Date(b.entryTime || 0).getTime();
                return timeB - timeA;
              });
              tradesToKeep.push(sortedClosed[0]);
              tradesToRemove.push(...sortedClosed.slice(1));
            }
          });

          // Remove duplicates from allTrades
          const tradeIdsToRemove = new Set(tradesToRemove.map((t) => t.id));
          const cleanedTrades = allTrades.filter(
            (t) => !tradeIdsToRemove.has(t.id),
          );

          await kvPutJSON(KV, tradesKey, cleanedTrades);

          return sendJSON(
            {
              ok: true,
              ticker: tickerUpper,
              total: tickerTrades.length,
              kept: tradesToKeep.length,
              removed: tradesToRemove.length,
              keptTrades: tradesToKeep.map((t) => ({
                id: t.id,
                entryTime: t.entryTime,
                entryPrice: t.entryPrice,
                status: t.status,
              })),
              removedTrades: tradesToRemove.map((t) => ({
                id: t.id,
                entryTime: t.entryTime,
                entryPrice: t.entryPrice,
                status: t.status,
              })),
            },
            200,
            corsHeaders(env, req),
          );
        } catch (err) {
          return sendJSON(
            { ok: false, error: err.message },
            500,
            corsHeaders(env, req),
          );
        }
      }

      // POST /timed/debug/purge-ticker?key=...&ticker=RIOT - Delete ALL trades for a specific ticker
      if (
        url.pathname === "/timed/debug/purge-ticker" &&
        req.method === "POST"
      ) {
        const authFail = requireKeyOr401(req, env);
        if (authFail) return authFail;

        try {
          const tradesKey = "timed:trades:all";
          const allTrades = (await kvGetJSON(KV, tradesKey)) || [];
          const tickerFilter = url.searchParams.get("ticker");

          if (!tickerFilter) {
            return sendJSON(
              { ok: false, error: "ticker parameter required" },
              400,
              corsHeaders(env, req),
            );
          }

          const tickerUpper = String(tickerFilter).toUpperCase();
          const beforeCount = allTrades.length;

          // Filter out all trades for this ticker
          const filteredTrades = allTrades.filter(
            (t) => String(t.ticker || "").toUpperCase() !== tickerUpper,
          );

          const removedCount = beforeCount - filteredTrades.length;

          if (removedCount === 0) {
            return sendJSON(
              {
                ok: true,
                message: `No trades found for ${tickerUpper}`,
                removed: 0,
                remaining: beforeCount,
              },
              200,
              corsHeaders(env, req),
            );
          }

          // Save the cleaned trades
          await kvPutJSON(KV, tradesKey, filteredTrades);

          return sendJSON(
            {
              ok: true,
              ticker: tickerUpper,
              removed: removedCount,
              remaining: filteredTrades.length,
              beforeCount: beforeCount,
              message: `Successfully purged all ${removedCount} trades for ${tickerUpper}`,
            },
            200,
            corsHeaders(env, req),
          );
        } catch (err) {
          return sendJSON(
            { ok: false, error: err.message },
            500,
            corsHeaders(env, req),
          );
        }
      }

      // POST /timed/debug/cleanup-all-duplicates?key=... - Remove all duplicate trades (keeps most recent per ticker+direction)
      if (
        url.pathname === "/timed/debug/cleanup-all-duplicates" &&
        req.method === "POST"
      ) {
        const authFail = requireKeyOr401(req, env);
        if (authFail) return authFail;

        try {
          const tradesKey = "timed:trades:all";
          const allTrades = (await kvGetJSON(KV, tradesKey)) || [];

          const beforeCount = allTrades.length;

          // Group trades by ticker+direction, keep most recent
          const tradeMap = new Map();
          const duplicates = [];

          allTrades.forEach((trade) => {
            const key = `${String(trade.ticker || "").toUpperCase()}_${
              trade.direction || "UNKNOWN"
            }`;
            const existing = tradeMap.get(key);

            if (!existing) {
              tradeMap.set(key, trade);
            } else {
              // Compare entry times to keep the most recent
              const existingTime = existing.entryTime
                ? new Date(existing.entryTime).getTime()
                : 0;
              const currentTime = trade.entryTime
                ? new Date(trade.entryTime).getTime()
                : 0;

              if (currentTime > existingTime) {
                duplicates.push(existing);
                tradeMap.set(key, trade);
              } else {
                duplicates.push(trade);
              }
            }
          });

          const cleanedTrades = Array.from(tradeMap.values());
          const removedCount = beforeCount - cleanedTrades.length;

          if (removedCount === 0) {
            return sendJSON(
              {
                ok: true,
                message: "No duplicates found",
                beforeCount,
                afterCount: cleanedTrades.length,
                removed: 0,
              },
              200,
              corsHeaders(env, req),
            );
          }

          // Save cleaned trades
          await kvPutJSON(KV, tradesKey, cleanedTrades);

          // Group duplicates by ticker for summary
          const duplicatesByTicker = {};
          duplicates.forEach((d) => {
            const ticker = String(d.ticker || "UNKNOWN").toUpperCase();
            if (!duplicatesByTicker[ticker]) {
              duplicatesByTicker[ticker] = [];
            }
            duplicatesByTicker[ticker].push({
              id: d.id,
              entryTime: d.entryTime,
              entryPrice: d.entryPrice,
              status: d.status,
            });
          });

          return sendJSON(
            {
              ok: true,
              message: `Successfully removed ${removedCount} duplicate trades`,
              beforeCount,
              afterCount: cleanedTrades.length,
              removed: removedCount,
              duplicatesByTicker,
              summary: Object.keys(duplicatesByTicker).map((ticker) => ({
                ticker,
                count: duplicatesByTicker[ticker].length,
              })),
            },
            200,
            corsHeaders(env, req),
          );
        } catch (err) {
          return sendJSON(
            { ok: false, error: err.message },
            500,
            corsHeaders(env, req),
          );
        }
      }

      // POST /timed/debug/recalculate-ranks?key=... - Recalculate ranks for all tickers using new formula
      if (
        url.pathname === "/timed/debug/recalculate-ranks" &&
        req.method === "POST"
      ) {
        const authFail = requireKeyOr401(req, env);
        if (authFail) return authFail;

        try {
          const tickerIndex = (await kvGetJSON(KV, "timed:tickers")) || [];
          const results = {
            processed: 0,
            updated: 0,
            errors: [],
          };

          // Process all tickers
          for (const ticker of tickerIndex) {
            try {
              const data = await kvGetJSON(KV, `timed:latest:${ticker}`);
              if (!data) {
                results.errors.push({ ticker, error: "No data found" });
                continue;
              }

              // Recalculate rank using new formula
              const newRank = computeRank(data);
              const oldRank = Number(data.rank) || 0;

              // Only update if rank changed
              if (newRank !== oldRank) {
                data.rank = newRank;
                await kvPutJSON(KV, `timed:latest:${ticker}`, data);
                results.updated++;
              }

              results.processed++;
            } catch (err) {
              results.errors.push({ ticker, error: err.message });
            }
          }

          return sendJSON(
            {
              ok: true,
              message: `Recalculated ranks for ${results.processed} tickers`,
              results,
            },
            200,
            corsHeaders(env, req),
          );
        } catch (err) {
          return sendJSON(
            { ok: false, error: err.message },
            500,
            corsHeaders(env, req),
          );
        }
      }

      // POST /timed/debug/fix-entry-prices?key=... - Fix entry prices for trades that used trigger_price instead of current price
      if (
        url.pathname === "/timed/debug/fix-entry-prices" &&
        req.method === "POST"
      ) {
        const authFail = requireKeyOr401(req, env);
        if (authFail) return authFail;

        try {
          const tradesKey = "timed:trades:all";
          const allTrades = (await kvGetJSON(KV, tradesKey)) || [];
          let fixed = 0;
          const fixedTrades = [];

          for (let i = 0; i < allTrades.length; i++) {
            const trade = allTrades[i];

            // Only fix OPEN trades (closed trades should keep their original entry price)
            if (trade.status !== "OPEN" && trade.status !== "TP_HIT_TRIM") {
              continue;
            }

            // Get latest ticker data
            const tickerData = await kvGetJSON(
              KV,
              `timed:latest:${trade.ticker}`,
            );
            if (!tickerData || !tickerData.price) {
              console.log(
                `[FIX ENTRY PRICES] Skipping ${trade.ticker} - no current price data`,
              );
              continue;
            }

            const currentPrice = Number(tickerData.price);
            const entryPrice = Number(trade.entryPrice);

            if (
              !Number.isFinite(currentPrice) ||
              !Number.isFinite(entryPrice)
            ) {
              continue;
            }

            // Check if entry price differs significantly from current price (>1%)
            const priceDiffPct =
              Math.abs(currentPrice - entryPrice) / entryPrice;
            if (priceDiffPct <= 0.01) {
              // Entry price is close to current price - likely correct
              continue;
            }

            // Check if this looks like it was created from trigger_price
            // (entry price matches trigger_price or is significantly different from current)
            const triggerPrice = tickerData.trigger_price
              ? Number(tickerData.trigger_price)
              : null;
            const entryMatchesTrigger =
              triggerPrice &&
              Math.abs(entryPrice - triggerPrice) / triggerPrice < 0.001;

            // Also check if trade is old (more than 1 hour)
            const entryTime = trade.entryTime
              ? new Date(trade.entryTime).getTime()
              : null;
            const now = Date.now();
            const isOldTrade = entryTime && now - entryTime > 60 * 60 * 1000;

            if (entryMatchesTrigger || isOldTrade || priceDiffPct > 0.05) {
              // Fix entry price to current price
              const correctedEntryPrice = currentPrice;

              // Recalculate shares based on new entry price
              const tickerUpper = String(trade.ticker || "").toUpperCase();
              const isFutures =
                FUTURES_SPECS[tickerUpper] || tickerUpper.endsWith("1!");
              const correctedShares =
                isFutures && FUTURES_SPECS[tickerUpper]
                  ? 1
                  : TRADE_SIZE / correctedEntryPrice;

              // Recalculate P&L with corrected entry price
              const tradeCalc = calculateTradePnl(
                tickerData,
                correctedEntryPrice,
                trade,
              );

              if (!tradeCalc) {
                console.log(
                  `[FIX ENTRY PRICES] Skipping ${trade.ticker} - cannot recalculate P&L`,
                );
                continue;
              }

              // Update trade
              const updatedTrade = {
                ...trade,
                entryPrice: correctedEntryPrice,
                shares: correctedShares,
                entryPriceCorrected: true,
                ...tradeCalc,
                history: [
                  ...(trade.history || []),
                  {
                    type: "ENTRY_PRICE_CORRECTION",
                    timestamp: new Date().toISOString(),
                    price: correctedEntryPrice,
                    shares: correctedShares,
                    value: correctedEntryPrice * correctedShares,
                    note: `Entry price corrected from $${entryPrice.toFixed(
                      2,
                    )} to $${correctedEntryPrice.toFixed(
                      2,
                    )} (was using trigger_price or outdated price)`,
                  },
                ],
                lastUpdate: new Date().toISOString(),
              };

              allTrades[i] = updatedTrade;
              fixed++;
              fixedTrades.push({
                ticker: trade.ticker,
                direction: trade.direction,
                oldEntryPrice: entryPrice.toFixed(2),
                newEntryPrice: correctedEntryPrice.toFixed(2),
                oldPnl: trade.pnl?.toFixed(2) || "0.00",
                newPnl: tradeCalc.pnl?.toFixed(2) || "0.00",
              });

              console.log(
                `[FIX ENTRY PRICES] Fixed ${trade.ticker} ${
                  trade.direction
                }: $${entryPrice.toFixed(2)} -> $${correctedEntryPrice.toFixed(
                  2,
                )} (P&L: $${(trade.pnl || 0).toFixed(
                  2,
                )} -> $${tradeCalc.pnl.toFixed(2)})`,
              );
            }
          }

          if (fixed > 0) {
            await kvPutJSON(KV, tradesKey, allTrades);
            console.log(
              `[FIX ENTRY PRICES] Fixed ${fixed} trades with incorrect entry prices`,
            );
          }

          return sendJSON(
            {
              ok: true,
              message: `Fixed ${fixed} trades with incorrect entry prices`,
              fixed,
              fixedTrades,
            },
            200,
            corsHeaders(env, req, true),
          );
        } catch (err) {
          console.error(`[FIX ENTRY PRICES ERROR]`, {
            error: String(err),
            message: err.message,
            stack: err.stack,
          });
          return sendJSON(
            { ok: false, error: "internal_error", message: err.message },
            500,
            corsHeaders(env, req, true),
          );
        }
      }

      // POST /timed/debug/fix-backfill-trades?key=... - Fix entryTime for backfilled trades
      if (
        url.pathname === "/timed/debug/fix-backfill-trades" &&
        req.method === "POST"
      ) {
        const authFail = requireKeyOr401(req, env);
        if (authFail) return authFail;

        try {
          const tradesKey = "timed:trades:all";
          const allTrades = (await kvGetJSON(KV, tradesKey)) || [];
          const now = Date.now();
          let fixed = 0;
          const fixedTrades = [];

          const threeDaysAgo = now - 3 * 24 * 60 * 60 * 1000; // 3 days ago

          for (const trade of allTrades) {
            let updated = false;
            const updatedTrade = { ...trade };
            let bestMatchTimestamp = null;
            let bestMatchPrice = null;
            let matchMethod = null;

            // Method 1: Check if trade has triggerTimestamp that's significantly older than entryTime
            if (trade.triggerTimestamp && trade.entryTime) {
              const triggerTime = new Date(trade.triggerTimestamp).getTime();
              const entryTime = new Date(trade.entryTime).getTime();
              const isBackfill =
                triggerTime && now - triggerTime > 60 * 60 * 1000; // More than 1 hour old

              if (isBackfill && triggerTime < entryTime) {
                bestMatchTimestamp = trade.triggerTimestamp;
                bestMatchPrice = trade.entryPrice;
                matchMethod = "triggerTimestamp";
              }
            }

            // Method 2: Search trail data for when entry price was actually touched (last 3 days)
            if (!bestMatchTimestamp && trade.ticker && trade.entryPrice) {
              try {
                const trail =
                  (await kvGetJSON(KV, `timed:trail:${trade.ticker}`)) || [];
                const entryPrice = Number(trade.entryPrice);
                const priceTolerance = entryPrice * 0.005; // 0.5% tolerance

                // Search through trail points in reverse (most recent first)
                // Find the point where price matches entryPrice within tolerance
                for (let i = trail.length - 1; i >= 0; i--) {
                  const point = trail[i];
                  if (!point.ts || !point.price) continue;

                  const pointTime = Number(point.ts);
                  const pointPrice = Number(point.price);

                  // Only consider points from last 3 days
                  if (pointTime < threeDaysAgo) continue;

                  // Check if price matches entry price (within tolerance)
                  const priceDiff = Math.abs(pointPrice - entryPrice);
                  if (priceDiff <= priceTolerance) {
                    // Found a match - use this timestamp
                    bestMatchTimestamp = new Date(pointTime).toISOString();
                    bestMatchPrice = pointPrice;
                    matchMethod = "trail_price_match";
                    break; // Use first match (most recent)
                  }
                }

                // If no exact match, find closest price match in last 3 days
                if (!bestMatchTimestamp) {
                  let closestDiff = Infinity;
                  let closestPoint = null;
                  for (const point of trail) {
                    if (!point.ts || !point.price) continue;
                    const pointTime = Number(point.ts);
                    const pointPrice = Number(point.price);
                    if (pointTime < threeDaysAgo) continue;

                    const priceDiff = Math.abs(pointPrice - entryPrice);
                    if (priceDiff < closestDiff) {
                      closestDiff = priceDiff;
                      closestPoint = point;
                    }
                  }

                  // Use closest match if it's within 2% of entry price
                  if (closestPoint && closestDiff <= entryPrice * 0.02) {
                    bestMatchTimestamp = new Date(
                      Number(closestPoint.ts),
                    ).toISOString();
                    bestMatchPrice = Number(closestPoint.price);
                    matchMethod = "trail_closest_match";
                  }
                }
              } catch (err) {
                // Ignore errors - trail data might not exist
              }
            }

            // Method 3: Try to get triggerTimestamp from ticker's latest data
            if (!bestMatchTimestamp && trade.ticker) {
              try {
                const tickerData = await kvGetJSON(
                  KV,
                  `timed:latest:${trade.ticker}`,
                );
                if (tickerData && tickerData.trigger_ts) {
                  const triggerTime = Number(tickerData.trigger_ts);
                  // Only use if it's from last 3 days and older than current entryTime
                  if (triggerTime >= threeDaysAgo) {
                    const entryTime = trade.entryTime
                      ? new Date(trade.entryTime).getTime()
                      : now;
                    if (triggerTime < entryTime) {
                      bestMatchTimestamp = new Date(triggerTime).toISOString();
                      bestMatchPrice =
                        tickerData.trigger_price || trade.entryPrice;
                      matchMethod = "ticker_trigger_ts";
                      // Store it in the trade for future reference
                      updatedTrade.triggerTimestamp = bestMatchTimestamp;
                    }
                  }
                }
              } catch (err) {
                // Ignore errors
              }
            }

            // Update entryTime if we found a better match
            if (bestMatchTimestamp && trade.entryTime) {
              const currentEntryTime = new Date(trade.entryTime).getTime();
              const newEntryTime = new Date(bestMatchTimestamp).getTime();

              // Only update if new time is significantly different (more than 5 minutes) and older
              if (
                Math.abs(newEntryTime - currentEntryTime) > 5 * 60 * 1000 &&
                newEntryTime < currentEntryTime
              ) {
                updatedTrade.entryTime = bestMatchTimestamp;
                updated = true;

                // Also update entry price if we found a better match from trail
                if (
                  bestMatchPrice &&
                  matchMethod.includes("trail") &&
                  Math.abs(bestMatchPrice - trade.entryPrice) >
                    trade.entryPrice * 0.01
                ) {
                  updatedTrade.entryPrice = bestMatchPrice;
                }
              }
            }

            // Update history entry timestamp if it matches the old entryTime
            if (
              updated &&
              updatedTrade.history &&
              Array.isArray(updatedTrade.history)
            ) {
              updatedTrade.history = updatedTrade.history.map((event) => {
                if (
                  event.type === "ENTRY" &&
                  event.timestamp === trade.entryTime
                ) {
                  return {
                    ...event,
                    timestamp: updatedTrade.entryTime,
                    price: updatedTrade.entryPrice || event.price,
                  };
                }
                return event;
              });
            }

            if (updated) {
              fixed++;
              fixedTrades.push({
                id: trade.id,
                ticker: trade.ticker,
                oldEntryTime: trade.entryTime,
                newEntryTime: updatedTrade.entryTime,
                oldEntryPrice: trade.entryPrice,
                newEntryPrice: updatedTrade.entryPrice,
                matchMethod: matchMethod,
              });
              const index = allTrades.findIndex((t) => t.id === trade.id);
              if (index >= 0) {
                allTrades[index] = updatedTrade;
              }
            }
          }

          if (fixed > 0) {
            await kvPutJSON(KV, tradesKey, allTrades);
          }

          return sendJSON(
            {
              ok: true,
              fixed,
              totalTrades: allTrades.length,
              fixedTrades: fixedTrades.slice(0, 50), // Show first 50
            },
            200,
            corsHeaders(env, req),
          );
        } catch (err) {
          return sendJSON(
            { ok: false, error: err.message },
            500,
            corsHeaders(env, req),
          );
        }
      }

      // POST /timed/debug/clear-all-trades?key=... - Clear all trades and start fresh
      if (
        url.pathname === "/timed/debug/clear-all-trades" &&
        req.method === "POST"
      ) {
        const authFail = requireKeyOr401(req, env);
        if (authFail) return authFail;

        try {
          const tradesKey = "timed:trades:all";
          const allTrades = (await kvGetJSON(KV, tradesKey)) || [];
          const tradeCount = allTrades.length;

          // Clear all trades
          await KV.delete(tradesKey);

          return sendJSON(
            {
              ok: true,
              message: "All trades cleared successfully",
              clearedCount: tradeCount,
              note: "New trades will be created automatically as TradingView alerts come in",
            },
            200,
            corsHeaders(env, req),
          );
        } catch (err) {
          return sendJSON(
            { ok: false, error: err.message },
            500,
            corsHeaders(env, req),
          );
        }
      }

      // POST /timed/debug/simulate-trades?key=... - Manually simulate trades for all tickers
      if (
        url.pathname === "/timed/debug/simulate-trades" &&
        req.method === "POST"
      ) {
        const authFail = requireKeyOr401(req, env);
        if (authFail) return authFail;

        try {
          const tickerIndex = (await kvGetJSON(KV, "timed:tickers")) || [];
          const results = {
            processed: 0,
            created: 0,
            updated: 0,
            skipped: 0,
            errors: [],
          };

          // Process first 50 tickers to avoid timeout
          for (const ticker of tickerIndex.slice(0, 50)) {
            try {
              const latestData = await kvGetJSON(KV, `timed:latest:${ticker}`);
              if (latestData) {
                const prevLatest = null; // No previous data for manual simulation
                await processTradeSimulation(
                  KV,
                  ticker,
                  latestData,
                  prevLatest,
                  env,
                );
                results.processed++;
              } else {
                results.skipped++;
              }
            } catch (err) {
              results.errors.push({ ticker, error: err.message });
            }
          }

          // Get final trade count
          const tradesKey = "timed:trades:all";
          const allTrades = (await kvGetJSON(KV, tradesKey)) || [];
          const openTrades = allTrades.filter(
            (t) =>
              t.status === "OPEN" || !t.status || t.status === "TP_HIT_TRIM",
          );

          return sendJSON(
            {
              ok: true,
              message: `Processed ${results.processed} tickers`,
              results,
              currentTrades: {
                total: allTrades.length,
                open: openTrades.length,
              },
            },
            200,
            corsHeaders(env, req),
          );
        } catch (err) {
          return sendJSON(
            { ok: false, error: err.message },
            500,
            corsHeaders(env, req),
          );
        }
      }

      // POST /timed/ml/train?key=... - Trigger ML model training from labeled queue
      if (url.pathname === "/timed/ml/train" && req.method === "POST") {
        const authFail = requireKeyOr401(req, env);
        if (authFail) return authFail;

        try {
          const limit = Number(url.searchParams.get("limit")) || 75;
          const force = url.searchParams.get("force") === "1";
          const result = await mlV1TrainFromQueue(env, KV, limit, force);
          return sendJSON(result, 200, corsHeaders(env, req, true));
        } catch (error) {
          return sendJSON(
            { ok: false, error: String(error) },
            500,
            corsHeaders(env, req, true),
          );
        }
      }

      // POST /timed/ml/backfill-queue?key=... - Backfill ML queue from timed_trail
      if (url.pathname === "/timed/ml/backfill-queue" && req.method === "POST") {
        const authFail = requireKeyOr401(req, env);
        if (authFail) return authFail;

        try {
          const db = env?.DB;
          if (!db) {
            return sendJSON({ ok: false, error: "no_db_binding" }, 500, corsHeaders(env, req, true));
          }

          await d1EnsureMlV1Schema(env);
          
          const daysBack = Number(url.searchParams.get("days")) || 7;
          const cutoff = Date.now() - (daysBack * 24 * 60 * 60 * 1000);
          
          // Get recent trail data
          const rows = await db.prepare(
            `SELECT ticker, ts, payload_json FROM timed_trail 
             WHERE ts >= ?1 
             ORDER BY ts DESC 
             LIMIT 1000`
          ).bind(cutoff).all();

          let queued = 0;
          const horizons = [4 * 60 * 60 * 1000, 24 * 60 * 60 * 1000]; // 4h, 1d

          for (const row of (rows?.results || [])) {
            try {
              const payload = JSON.parse(row.payload_json);
              await d1EnqueueMlV1(env, row.ticker, payload, horizons);
              queued++;
            } catch (e) {
              // Skip invalid entries
            }
          }

          return sendJSON(
            { ok: true, queued, daysBack, processed: rows?.results?.length || 0 },
            200,
            corsHeaders(env, req, true),
          );
        } catch (error) {
          return sendJSON(
            { ok: false, error: String(error) },
            500,
            corsHeaders(env, req, true),
          );
        }
      }

      // POST /timed/admin/reprocess-kanban?key=...&limit=...&offset=...&ticker=...&resetTrades=1&from=YYYY-MM-DD&to=YYYY-MM-DD
      // Re-run Kanban classification + trade sim for all tickers. Batched to avoid subrequest limits.
      // Default limit=15 per call; use offset to process remaining (e.g. offset=15, offset=30).
      // resetTrades=1: purge open trades for batch tickers (optionally in from/to range) and clear entry state before reprocess.
      if (
        url.pathname === "/timed/admin/reprocess-kanban" &&
        req.method === "POST"
      ) {
        const authFail = requireKeyOr401(req, env);
        if (authFail) return authFail;

        const qLimit = Number(url.searchParams.get("limit") || "15");
        const qOffset = Number(url.searchParams.get("offset") || "0");
        const tickerFilter = normTicker(url.searchParams.get("ticker"));
        const resetTrades = url.searchParams.get("resetTrades") === "1" || url.searchParams.get("resetTrades") === "true";
        const fromDay = url.searchParams.get("from") || null; // YYYY-MM-DD
        const toDay = url.searchParams.get("to") || null;
        const DEFAULT_BATCH = 15;

        const tickersList = (await kvGetJSON(KV, "timed:tickers")) || [];
        const filtered = Array.isArray(tickersList)
          ? tickersList.filter((t) => {
              if (!t) return false;
              if (tickerFilter)
                return String(t).toUpperCase() === String(tickerFilter);
              return true;
            })
          : [];
        const limit = Math.min(
          qLimit > 0 ? qLimit : DEFAULT_BATCH,
          filtered.length,
          25,
        );
        const offset = Math.max(0, Number.isFinite(qOffset) ? qOffset : 0);
        const slice = filtered.slice(offset, offset + limit);

        // resetTrades: purge ALL trades (open + closed) for batch tickers in from/to window for clean slate
        let tradesPurged = 0;
        if (resetTrades && slice.length > 0) {
          const allTrades = (await kvGetJSON(KV, "timed:trades:all")) || [];
          const sliceSet = new Set(slice.map((t) => String(t || "").toUpperCase()));
          let tsMin = null;
          let tsMax = null;
          if (fromDay && /^\d{4}-\d{2}-\d{2}$/.test(fromDay)) {
            tsMin = nyWallMidnightToUtcMs(fromDay) ?? null;
          }
          if (toDay && /^\d{4}-\d{2}-\d{2}$/.test(toDay)) {
            const endOfDay = nyWallTimeToUtcMs(toDay, 23, 59, 59);
            tsMax = endOfDay != null ? endOfDay + 999 : null;
          }
          const kept = allTrades.filter((t) => {
            const ticker = String(t?.ticker || "").toUpperCase();
            if (!sliceSet.has(ticker)) return true;
            const entryTs = Number(t?.entry_ts ?? t?.entryTime);
            if (!Number.isFinite(entryTs)) return true;
            if (tsMin != null && entryTs < tsMin) return true;
            if (tsMax != null && entryTs > tsMax) return true;
            tradesPurged += 1;
            return false;
          });
          await kvPutJSON(KV, "timed:trades:all", kept);
        }

        let updated = 0;
        let tradesCreated = 0;
        const laneCounts = {};
        const errors = [];

        for (const t of slice) {
          try {
            const ticker = String(t || "").toUpperCase();
            if (!ticker) continue;
            const latest = await kvGetJSON(KV, `timed:latest:${ticker}`);
            if (!latest || typeof latest !== "object") continue;

            const existing = latest;
            const payload = { ...latest };

            // resetTrades: clear entry state so we reprocess from scratch (no phantom Enter Now -> Exit)
            if (resetTrades) {
              payload.entry_ts = null;
              payload.entry_price = null;
              payload.kanban_cycle_enter_now_ts = null;
              payload.kanban_cycle_trigger_ts = null;
              payload.kanban_cycle_side = null;
            } else {
              // Merge entry_ts/entry_price from existing + ledger (Hold vs Watch fix)
              if (existing?.entry_ts != null || existing?.entry_price != null) {
                if (payload.entry_ts == null && Number.isFinite(Number(existing?.entry_ts)))
                  payload.entry_ts = Number(existing.entry_ts);
                if (payload.entry_price == null && Number.isFinite(Number(existing?.entry_price)))
                  payload.entry_price = Number(existing.entry_price);
              }
              const openTrade = await findOpenTradeForTicker(KV, ticker, null);
              if ((payload.entry_ts == null || payload.entry_price == null) && openTrade) {
                const et = isoToMs(openTrade.entryTime) || Number(openTrade.entry_ts) || Number(openTrade.entryTs);
                const ep = Number(openTrade.entryPrice ?? openTrade.entry_price);
                if (payload.entry_ts == null && Number.isFinite(et)) payload.entry_ts = et;
                if (payload.entry_price == null && Number.isFinite(ep) && ep > 0)
                  payload.entry_price = ep;
              }
            }

            payload.move_status = computeMoveStatus(payload);
            if (payload.flags) {
              payload.flags.move_invalidated = payload.move_status?.status === "INVALIDATED";
              payload.flags.move_completed = payload.move_status?.status === "COMPLETED";
            }

            const prevStage = existing?.kanban_stage;
            const stage = classifyKanbanStage(payload);
            let finalStage = stage;

            if (
              prevStage === "archive" &&
              ["hold", "just_entered", "trim", "exit"].includes(stage)
            ) {
              finalStage = "watch";
              if (!payload.flags) payload.flags = {};
              payload.flags.recycled_from_archive = true;
            }

            const mgmt = ["hold", "just_entered", "trim", "exit"].includes(finalStage);
            if (mgmt) {
              const curTriggerTs = Number(payload?.trigger_ts);
              const curSide = sideFromStateOrScores(payload);
              const cycleEnterTs = Number(existing?.kanban_cycle_enter_now_ts);
              const cycleTrig = Number(existing?.kanban_cycle_trigger_ts);
              const cycleSide = existing?.kanban_cycle_side != null ? String(existing.kanban_cycle_side) : null;
              const sameTrig = Number.isFinite(curTriggerTs) && curTriggerTs > 0 &&
                Number.isFinite(cycleTrig) && cycleTrig > 0 && cycleTrig === curTriggerTs;
              const cycleOk = Number.isFinite(cycleEnterTs) && cycleEnterTs > 0 && sameTrig &&
                !!cycleSide && !!curSide && cycleSide === curSide;
              if (!Number.isFinite(curTriggerTs) || curTriggerTs <= 0) {
                finalStage = "watch";
                if (!payload.flags) payload.flags = {};
                payload.flags.forced_watch_missing_trigger = true;
              } else if (!cycleOk) {
                finalStage = "enter_now";
                if (!payload.flags) payload.flags = {};
                payload.flags.forced_enter_now_gate = true;
              }
            }

            const tsNow = Number(payload?.ts) || Date.now();
            if (finalStage === "enter_now") {
              payload.kanban_cycle_enter_now_ts = tsNow;
              payload.kanban_cycle_trigger_ts = Number.isFinite(Number(payload?.trigger_ts)) && payload.trigger_ts > 0 ? payload.trigger_ts : null;
              payload.kanban_cycle_side = sideFromStateOrScores(payload);
            } else if (["hold", "just_entered", "trim", "exit"].includes(finalStage)) {
              payload.kanban_cycle_enter_now_ts = existing?.kanban_cycle_enter_now_ts || null;
              payload.kanban_cycle_trigger_ts = existing?.kanban_cycle_trigger_ts || null;
              payload.kanban_cycle_side = existing?.kanban_cycle_side || null;
            } else {
              payload.kanban_cycle_enter_now_ts = null;
              payload.kanban_cycle_trigger_ts = null;
              payload.kanban_cycle_side = null;
            }

            if (prevStage != null && finalStage != null && String(prevStage) !== String(finalStage)) {
              payload.prev_kanban_stage = String(prevStage);
              payload.prev_kanban_stage_ts = tsNow;
            }

            if (finalStage === "enter_now" && prevStage !== "enter_now") {
              const price = Number(payload?.price);
              if (Number.isFinite(price) && price > 0) {
                payload.entry_price = price;
                payload.entry_ts = payload.ts;
              }
            }
            if (finalStage && existing?.entry_price) {
              payload.entry_price = existing.entry_price;
              payload.entry_ts = existing.entry_ts;
            }

            payload.kanban_stage = finalStage;
            payload.kanban_meta = deriveKanbanMeta(payload, finalStage);

            laneCounts[finalStage || "null"] = (laneCounts[finalStage || "null"] || 0) + 1;

            await kvPutJSON(KV, `timed:latest:${ticker}`, payload);
            updated += 1;

            const tradesBefore = (await kvGetJSON(KV, "timed:trades:all")) || [];
            const countBefore = tradesBefore.filter((x) => String(x?.ticker).toUpperCase() === ticker).length;
            await processTradeSimulation(KV, ticker, payload, existing, env, { forceUseIngestTs: true });
            const tradesAfter = (await kvGetJSON(KV, "timed:trades:all")) || [];
            const countAfter = tradesAfter.filter((x) => String(x?.ticker).toUpperCase() === ticker).length;
            if (countAfter > countBefore) tradesCreated += countAfter - countBefore;
          } catch (e) {
            errors.push({ ticker: t || null, error: String(e?.message || e) });
          }
        }

        try {
          await d1SyncLatestBatchFromKV(env, { waitUntil: () => {} }, 50);
        } catch (syncErr) {
          errors.push({ sync: String(syncErr?.message || syncErr) });
        }

        const nextOffset = offset + slice.length;
        const hasMore = nextOffset < filtered.length;

        return sendJSON(
          {
            ok: true,
            tickersProcessed: updated,
            tradesCreated,
            tradesPurged: resetTrades ? tradesPurged : undefined,
            laneCounts,
            offset,
            nextOffset: hasMore ? nextOffset : null,
            hasMore,
            total: filtered.length,
            errorsCount: errors.length,
            errors: errors.slice(0, 10),
          },
          200,
          corsHeaders(env, req),
        );
      }

      // POST /timed/admin/replay-ticker?key=...&ticker=BE&date=YYYY-MM-DD
      // Single-ticker replay: fetches trail via d1GetTrailRange (no payload_json), processes chronologically.
      // Use this for ticker-by-ticker replay; avoids D1 large-result limits.
      if (url.pathname === "/timed/admin/replay-ticker" && req.method === "POST") {
        const authFail = requireKeyOr401(req, env);
        if (authFail) return authFail;
        const tickerParam = (url.searchParams.get("ticker") || "").trim().toUpperCase();
        if (!tickerParam) {
          return sendJSON({ ok: false, error: "missing ticker" }, 400, corsHeaders(env, req));
        }
        const dateParam = url.searchParams.get("date") || null;
        const dayKey = dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? dateParam : nyTradingDayKey(Date.now());
        const marketOpen = nyWallTimeToUtcMs(dayKey, 9, 30, 0);
        const dayEnd = nyWallTimeToUtcMs(dayKey, 23, 59, 59);
        const tsStart = marketOpen != null ? marketOpen : Date.now() - 24 * 60 * 60 * 1000;
        const tsEnd = dayEnd != null ? dayEnd + 999 : Date.now();
        const cleanSlate = url.searchParams.get("cleanSlate") === "1" || url.searchParams.get("cleanSlate") === "true";

        const trailRes = await d1GetTrailRange(env, tickerParam, Math.floor(tsStart), 500);
        if (!trailRes?.ok) {
          return sendJSON(
            { ok: false, error: "trail_fetch_failed", detail: trailRes?.error || "unknown" },
            500,
            corsHeaders(env, req),
          );
        }
        const trail = (trailRes?.trail || []).filter(
          (p) => { const ts = Number(p?.ts); return Number.isFinite(ts) && ts >= tsStart && ts <= tsEnd; },
        );
        const rows = trail.map((p) => {
          const ts = Number(p?.ts);
          const obj = { ticker: tickerParam, ts, price: p?.price, htf_score: p?.htf_score, ltf_score: p?.ltf_score, completion: p?.completion, phase_pct: p?.phase_pct, state: p?.state, rank: p?.rank, flags: p?.flags || {}, trigger_reason: p?.trigger_reason, trigger_dir: p?.trigger_dir, trigger_ts: p?.trigger_ts ?? ts, sl: p?.sl, tp: p?.tp, tp_levels: p?.tp_levels };
          return { ticker: tickerParam, ts: obj.ts, payload_json: JSON.stringify(obj) };
        });

        let allTrades = (await kvGetJSON(KV, "timed:trades:all")) || [];
        let tradesPurged = 0;
        if (cleanSlate && rows.length > 0) {
          const kept = allTrades.filter((t) => {
            if (String(t?.ticker || "").toUpperCase() !== tickerParam) return true;
            const entryTs = isoToMs(t?.entry_ts ?? t?.entryTime) ?? Number(t?.entry_ts ?? t?.entryTs);
            if (!Number.isFinite(entryTs) || entryTs <= 0) return true;
            if (entryTs < tsStart || entryTs > tsEnd) return true;
            tradesPurged += 1;
            return false;
          });
          allTrades = kept;
          await kvPutJSON(KV, "timed:trades:all", kept);
        }

        const existing = (await kvGetJSON(KV, `timed:latest:${tickerParam}`)) || {};
        const stateMap = { [tickerParam]: cleanSlate ? { ...existing, entry_ts: null, entry_price: null, kanban_cycle_enter_now_ts: null, kanban_cycle_trigger_ts: null, kanban_cycle_side: null } : { ...existing } };
        const findOpenInArray = (trades, sym) => trades.find((x) => String(x?.ticker || "").toUpperCase() === sym && isOpenTradeStatus(x?.status)) || null;
        const replayCtx = { allTrades };
        let processed = 0, tradesCreated = 0;
        const laneCounts = {};

        for (const row of rows) {
          try {
            const ticker = tickerParam;
            let payload;
            try { payload = row.payload_json ? JSON.parse(row.payload_json) : null; } catch { continue; }
            if (!payload || typeof payload !== "object") continue;
            const rowTs = Number(row?.ts);
            if (!Number.isFinite(rowTs)) continue;
            payload.ts = rowTs;
            payload.ingest_ts = rowTs;
            const existingState = stateMap[ticker] || {};
            const existingTs = Number(existingState?.ts ?? existingState?.ingest_ts);
            const isEarlierThanStored = !Number.isFinite(existingTs) || rowTs < existingTs;
            if (isEarlierThanStored) {
              payload.entry_ts = null;
              payload.entry_price = null;
              payload.kanban_cycle_enter_now_ts = null;
              payload.kanban_cycle_trigger_ts = null;
              payload.kanban_cycle_side = null;
            } else {
              if (existingState?.entry_ts != null && payload.entry_ts == null) payload.entry_ts = Number(existingState.entry_ts);
              if (existingState?.entry_price != null && payload.entry_price == null) payload.entry_price = Number(existingState.entry_price);
              if (existingState?.kanban_cycle_enter_now_ts != null) payload.kanban_cycle_enter_now_ts = existingState.kanban_cycle_enter_now_ts;
              if (existingState?.kanban_cycle_trigger_ts != null) payload.kanban_cycle_trigger_ts = existingState.kanban_cycle_trigger_ts;
              if (existingState?.kanban_cycle_side != null) payload.kanban_cycle_side = existingState.kanban_cycle_side;
            }
            const openTrade = findOpenInArray(replayCtx.allTrades, ticker);
            if ((payload.entry_ts == null || payload.entry_price == null) && openTrade) {
              const et = isoToMs(openTrade.entryTime) || Number(openTrade.entry_ts) || Number(openTrade.entryTs);
              const ep = Number(openTrade.entryPrice ?? openTrade.entry_price);
              if (payload.entry_ts == null && Number.isFinite(et)) payload.entry_ts = et;
              if (payload.entry_price == null && Number.isFinite(ep) && ep > 0) payload.entry_price = ep;
            }
            payload.move_status = computeMoveStatus(payload);
            if (payload.flags) { payload.flags.move_invalidated = payload.move_status?.status === "INVALIDATED"; payload.flags.move_completed = payload.move_status?.status === "COMPLETED"; }
            const prevStage = existingState?.kanban_stage;
            const stage = classifyKanbanStage(payload);
            let finalStage = stage;
            if (prevStage === "archive" && ["hold", "just_entered", "trim", "exit"].includes(stage)) { finalStage = "watch"; if (!payload.flags) payload.flags = {}; payload.flags.recycled_from_archive = true; }
            const mgmt = ["hold", "just_entered", "trim", "exit"].includes(finalStage);
            if (mgmt) {
              const curTriggerTs = Number(payload?.trigger_ts);
              const curSide = sideFromStateOrScores(payload);
              const cycleEnterTs = Number(existingState?.kanban_cycle_enter_now_ts);
              const cycleTrig = Number(existingState?.kanban_cycle_trigger_ts);
              const cycleSide = existingState?.kanban_cycle_side != null ? String(existingState.kanban_cycle_side) : null;
              const sameTrig = Number.isFinite(curTriggerTs) && curTriggerTs > 0 && Number.isFinite(cycleTrig) && cycleTrig > 0 && cycleTrig === curTriggerTs;
              const cycleOk = Number.isFinite(cycleEnterTs) && cycleEnterTs > 0 && sameTrig && !!cycleSide && !!curSide && cycleSide === curSide;
              if (!Number.isFinite(curTriggerTs) || curTriggerTs <= 0) { finalStage = "watch"; if (!payload.flags) payload.flags = {}; payload.flags.forced_watch_missing_trigger = true; }
              else if (!cycleOk) { finalStage = "enter_now"; if (!payload.flags) payload.flags = {}; payload.flags.forced_enter_now_gate = true; }
            }
            if (finalStage === "enter_now") {
              payload.kanban_cycle_enter_now_ts = rowTs;
              payload.kanban_cycle_trigger_ts = Number.isFinite(Number(payload?.trigger_ts)) && payload.trigger_ts > 0 ? payload.trigger_ts : null;
              payload.kanban_cycle_side = sideFromStateOrScores(payload);
            } else if (["hold", "just_entered", "trim", "exit"].includes(finalStage)) {
              payload.kanban_cycle_enter_now_ts = existingState?.kanban_cycle_enter_now_ts ?? null;
              payload.kanban_cycle_trigger_ts = existingState?.kanban_cycle_trigger_ts ?? null;
              payload.kanban_cycle_side = existingState?.kanban_cycle_side ?? null;
            } else {
              payload.kanban_cycle_enter_now_ts = null;
              payload.kanban_cycle_trigger_ts = null;
              payload.kanban_cycle_side = null;
            }
            if (prevStage != null && finalStage != null && String(prevStage) !== String(finalStage)) {
              payload.prev_kanban_stage = String(prevStage);
              payload.prev_kanban_stage_ts = rowTs;
            }
            if (finalStage === "enter_now" && prevStage !== "enter_now") {
              const price = Number(payload?.price);
              if (Number.isFinite(price) && price > 0) { payload.entry_price = price; payload.entry_ts = rowTs; }
            }
            if (finalStage && existingState?.entry_price) { payload.entry_price = existingState.entry_price; payload.entry_ts = existingState.entry_ts; }
            payload.kanban_stage = finalStage;
            payload.kanban_meta = deriveKanbanMeta(payload, finalStage);
            laneCounts[finalStage || "null"] = (laneCounts[finalStage || "null"] || 0) + 1;
            stateMap[ticker] = payload;
            const countBefore = replayCtx.allTrades.filter((x) => String(x?.ticker).toUpperCase() === ticker).length;
            await processTradeSimulation(KV, ticker, payload, existingState, env, { forceUseIngestTs: true, replayBatchContext: replayCtx, asOfTs: rowTs });
            const countAfter = replayCtx.allTrades.filter((x) => String(x?.ticker).toUpperCase() === ticker).length;
            if (countAfter > countBefore) tradesCreated += countAfter - countBefore;
            processed += 1;
          } catch (e) {
            console.error(`[REPLAY-TICKER] ${tickerParam} row error:`, e);
          }
        }

        await kvPutJSON(KV, "timed:trades:all", replayCtx.allTrades);
        await kvPutJSON(KV, `timed:latest:${tickerParam}`, stateMap[tickerParam] || {});
        try { await d1SyncLatestBatchFromKV(env, { waitUntil: () => {} }, 50); } catch {}
        return sendJSON({
          ok: true,
          ticker: tickerParam,
          day: dayKey,
          rowsProcessed: processed,
          tradesCreated,
          tradesPurged,
          laneCounts,
        }, 200, corsHeaders(env, req));
      }

      // POST /timed/admin/replay-ingest?key=...&date=YYYY-MM-DD&bucket=...&ticker=...&scriptVersion=2.5.0&cleanSlate=1
      // Bucket-by-bucket replay from ingest_receipts (Script Version 2.5.0). Avoids D1 memory limits.
      // Client iterates buckets from 9:30 ET; pass bucket= to process one bucket per request.
      if (url.pathname === "/timed/admin/replay-ingest" && req.method === "POST") {
        const authFail = requireKeyOr401(req, env);
        if (authFail) return authFail;

        const db = env?.DB;
        if (!db) {
          return sendJSON({ ok: false, error: "no_db_binding" }, 500, corsHeaders(env, req));
        }

        const dateParam = url.searchParams.get("date") || null;
        const dayKey = dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? dateParam : nyTradingDayKey(Date.now());
        const marketOpen = nyWallTimeToUtcMs(dayKey, 9, 30, 0);
        const dayEnd = nyWallTimeToUtcMs(dayKey, 16, 0, 0);
        const tsStart = marketOpen != null ? marketOpen : Date.now() - 24 * 60 * 60 * 1000;
        const tsEnd = dayEnd != null ? dayEnd : Date.now();
        const bucketParam = url.searchParams.get("bucket");
        const bucketMs = 5 * 60 * 1000;
        const tickerFilter = (url.searchParams.get("ticker") || "").trim().toUpperCase() || null;
        const scriptVersion = url.searchParams.get("scriptVersion") || "2.5.0";
        const cleanSlate = url.searchParams.get("cleanSlate") === "1" || url.searchParams.get("cleanSlate") === "true";
        const debug = url.searchParams.get("debug") === "1" || url.searchParams.get("debug") === "true";
        const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get("limit") || "100", 10)));
        const bucketOffset = Math.max(0, parseInt(url.searchParams.get("bucketOffset") || "0", 10));

        let currentBucket;
        if (bucketParam != null && bucketParam !== "") {
          currentBucket = parseInt(bucketParam, 10);
          if (!Number.isFinite(currentBucket)) {
            return sendJSON({ ok: false, error: "invalid_bucket" }, 400, corsHeaders(env, req));
          }
        } else {
          currentBucket = Math.floor(tsStart / bucketMs) * bucketMs;
        }

        if (currentBucket < tsStart || currentBucket > tsEnd) {
          return sendJSON({
            ok: true,
            date: dayKey,
            bucketProcessed: currentBucket,
            rowsProcessed: 0,
            tradesCreated: 0,
            tradesPurged: 0,
            nextBucket: null,
            hasMore: false,
            hasMoreInBucket: false,
          }, 200, corsHeaders(env, req));
        }

        try {
          const metaStmt = db.prepare(
            tickerFilter
              ? `SELECT receipt_id, ticker, ts FROM ingest_receipts
                 WHERE bucket_5m = ?1 AND (script_version = ?2 OR script_version IS NULL)
                 AND ticker = ?3
                 ORDER BY ts ASC LIMIT ?4 OFFSET ?5`
              : `SELECT receipt_id, ticker, ts FROM ingest_receipts
                 WHERE bucket_5m = ?1 AND (script_version = ?2 OR script_version IS NULL)
                 ORDER BY ts ASC LIMIT ?3 OFFSET ?4`,
          );
          const metaResult = tickerFilter
            ? await metaStmt.bind(currentBucket, scriptVersion, tickerFilter, limit, bucketOffset).all()
            : await metaStmt.bind(currentBucket, scriptVersion, limit, bucketOffset).all();
          const metaRows = metaResult?.results || [];

          const rows = [];
          for (const m of metaRows) {
            const receiptId = m?.receipt_id;
            if (!receiptId) continue;
            try {
              const payRow = await db.prepare(
                `SELECT payload_json FROM ingest_receipts WHERE receipt_id = ?1 LIMIT 1`,
              ).bind(String(receiptId)).first();
              const ticker = String(m?.ticker || "").toUpperCase();
              const ts = Number(m?.ts);
              if (ticker && Number.isFinite(ts)) {
                rows.push({ ticker, ts, payload_json: payRow?.payload_json ?? null });
              }
            } catch {
              // skip
            }
          }

          let allTrades = (await kvGetJSON(KV, "timed:trades:all")) || [];
          let tradesPurged = 0;
          const tickersInBucket = [...new Set(rows.map((r) => r.ticker))];

          if (cleanSlate && bucketOffset === 0) {
            const toRemove = allTrades.filter((t) => {
              const tkr = String(t?.ticker || "").toUpperCase();
              if (tickerFilter && tkr !== tickerFilter) return false;
              const entryTs = isoToMs(t?.entry_ts ?? t?.entryTime) ?? Number(t?.entry_ts ?? t?.entryTs);
              if (!Number.isFinite(entryTs) || entryTs <= 0) return false;
              if (entryTs < tsStart || entryTs > tsEnd + 86400000) return false;
              return true;
            });
            tradesPurged = toRemove.length;
            const purgedTickers = new Set(toRemove.map((t) => String(t?.ticker || "").toUpperCase()).filter(Boolean));
            tickersInBucket.forEach((t) => purgedTickers.add(t));
            allTrades = allTrades.filter((t) => !toRemove.includes(t));
            await kvPutJSON(KV, "timed:trades:all", allTrades);
            for (const tkr of purgedTickers) {
              if (!tkr) continue;
              const existing = (await kvGetJSON(KV, `timed:latest:${tkr}`)) || {};
              const reset = { ...existing, entry_ts: null, entry_price: null, kanban_cycle_enter_now_ts: null, kanban_cycle_trigger_ts: null, kanban_cycle_side: null };
              await kvPutJSON(KV, `timed:latest:${tkr}`, reset);
            }
          }

          const stateMap = {};
          const findOpenInArray = (trades, sym) => trades.find((x) => String(x?.ticker || "").toUpperCase() === sym && isOpenTradeStatus(x?.status)) || null;
          const replayCtx = { allTrades };
          let tradesCreated = 0;

          for (const row of rows) {
            try {
              const ticker = row.ticker;
              let payload;
              try {
                payload = row.payload_json ? JSON.parse(row.payload_json) : null;
              } catch {
                continue;
              }
              if (!payload || typeof payload !== "object") continue;
              const rowTs = row.ts;
              payload.ts = rowTs;
              payload.ingest_ts = rowTs;
              // Replay: ensure trigger_ts for lifecycle gate (use ingest ts if missing)
              if ((payload.trigger_ts == null || !Number.isFinite(Number(payload.trigger_ts))) && Number.isFinite(rowTs)) {
                payload.trigger_ts = rowTs < 1e12 ? rowTs * 1000 : rowTs;
              }
              // Normalize SL/TP from alternate field names (ingest payload may vary)
              if ((payload.sl == null || !Number.isFinite(Number(payload.sl))) && payload.sl_price != null) payload.sl = payload.sl_price;
              if ((payload.sl == null || !Number.isFinite(Number(payload.sl))) && payload.stop_loss != null) payload.sl = payload.stop_loss;
              const tpVal = payload.tp ?? payload.tp_max_price ?? payload.tp_target_price ?? payload.tp_target;
              if ((payload.tp == null || !Number.isFinite(Number(payload.tp))) && tpVal != null && Number.isFinite(Number(tpVal))) payload.tp = Number(tpVal);
              const existingState = stateMap[ticker] || (await kvGetJSON(KV, `timed:latest:${ticker}`)) || {};
              const existingTs = Number(existingState?.ts ?? existingState?.ingest_ts);
              const isEarlierThanStored = !Number.isFinite(existingTs) || rowTs < existingTs;
              if (isEarlierThanStored) {
                payload.entry_ts = null;
                payload.entry_price = null;
                payload.kanban_cycle_enter_now_ts = null;
                payload.kanban_cycle_trigger_ts = null;
                payload.kanban_cycle_side = null;
              } else {
                if (existingState?.entry_ts != null && payload.entry_ts == null) payload.entry_ts = Number(existingState.entry_ts);
                if (existingState?.entry_price != null && payload.entry_price == null) payload.entry_price = Number(existingState.entry_price);
                if (existingState?.kanban_cycle_enter_now_ts != null) payload.kanban_cycle_enter_now_ts = existingState.kanban_cycle_enter_now_ts;
                if (existingState?.kanban_cycle_trigger_ts != null) payload.kanban_cycle_trigger_ts = existingState.kanban_cycle_trigger_ts;
                if (existingState?.kanban_cycle_side != null) payload.kanban_cycle_side = existingState.kanban_cycle_side;
              }
              const openTrade = findOpenInArray(replayCtx.allTrades, ticker);
              if ((payload.entry_ts == null || payload.entry_price == null) && openTrade) {
                const et = isoToMs(openTrade.entryTime) || Number(openTrade.entry_ts) || Number(openTrade.entryTs);
                const ep = Number(openTrade.entryPrice ?? openTrade.entry_price);
                if (payload.entry_ts == null && Number.isFinite(et)) payload.entry_ts = et;
                if (payload.entry_price == null && Number.isFinite(ep) && ep > 0) payload.entry_price = ep;
              }
              payload.move_status = computeMoveStatus(payload);
              if (payload.flags) {
                payload.flags.move_invalidated = payload.move_status?.status === "INVALIDATED";
                payload.flags.move_completed = payload.move_status?.status === "COMPLETED";
              }
              if (payload.score == null && payload.rank == null && payload.rank_position == null) {
                const dyn = computeDynamicScore(payload);
                payload.score = dyn;
                if (dyn >= 70) payload.rank_position = Math.max(1, Math.min(50, Math.round(160 - dyn)));
              }
              const prevStage = existingState?.kanban_stage;
              const stage = classifyKanbanStage(payload);
              let finalStage = stage;
              if (prevStage === "archive" && ["hold", "just_entered", "trim", "exit"].includes(stage)) {
                finalStage = "watch";
                if (!payload.flags) payload.flags = {};
                payload.flags.recycled_from_archive = true;
              }
              const mgmt = ["hold", "just_entered", "trim", "exit"].includes(finalStage);
              if (mgmt) {
                const curTriggerTs = Number(payload?.trigger_ts);
                const curSide = sideFromStateOrScores(payload);
                const cycleEnterTs = Number(existingState?.kanban_cycle_enter_now_ts);
                const cycleTrig = Number(existingState?.kanban_cycle_trigger_ts);
                const cycleSide = existingState?.kanban_cycle_side != null ? String(existingState.kanban_cycle_side) : null;
                const sameTrig = Number.isFinite(curTriggerTs) && curTriggerTs > 0 && Number.isFinite(cycleTrig) && cycleTrig > 0 && cycleTrig === curTriggerTs;
                const cycleOk = Number.isFinite(cycleEnterTs) && cycleEnterTs > 0 && sameTrig && !!cycleSide && !!curSide && cycleSide === curSide;
                if (!Number.isFinite(curTriggerTs) || curTriggerTs <= 0) {
                  finalStage = "watch";
                  if (!payload.flags) payload.flags = {};
                  payload.flags.forced_watch_missing_trigger = true;
                } else if (!cycleOk) {
                  finalStage = "enter_now";
                  if (!payload.flags) payload.flags = {};
                  payload.flags.forced_enter_now_gate = true;
                }
              }
              if (finalStage === "enter_now") {
                payload.kanban_cycle_enter_now_ts = rowTs;
                payload.kanban_cycle_trigger_ts = Number.isFinite(Number(payload?.trigger_ts)) && payload.trigger_ts > 0 ? payload.trigger_ts : null;
                payload.kanban_cycle_side = sideFromStateOrScores(payload);
              } else if (["hold", "just_entered", "trim", "exit"].includes(finalStage)) {
                payload.kanban_cycle_enter_now_ts = existingState?.kanban_cycle_enter_now_ts ?? null;
                payload.kanban_cycle_trigger_ts = existingState?.kanban_cycle_trigger_ts ?? null;
                payload.kanban_cycle_side = existingState?.kanban_cycle_side ?? null;
              } else {
                payload.kanban_cycle_enter_now_ts = null;
                payload.kanban_cycle_trigger_ts = null;
                payload.kanban_cycle_side = null;
              }
              if (prevStage != null && finalStage != null && String(prevStage) !== String(finalStage)) {
                payload.prev_kanban_stage = String(prevStage);
                payload.prev_kanban_stage_ts = rowTs;
              }
              if (finalStage === "enter_now" && prevStage !== "enter_now") {
                const price = Number(payload?.price);
                if (Number.isFinite(price) && price > 0) {
                  payload.entry_price = price;
                  payload.entry_ts = rowTs;
                }
              }
              if (finalStage && existingState?.entry_price) {
                payload.entry_price = existingState.entry_price;
                payload.entry_ts = existingState.entry_ts;
              }
              payload.kanban_stage = finalStage;
              payload.kanban_meta = deriveKanbanMeta(payload, finalStage);
              stateMap[ticker] = payload;
              const countBefore = replayCtx.allTrades.filter((x) => String(x?.ticker).toUpperCase() === ticker).length;
              const shouldTrigger = finalStage === "enter_now" ? shouldTriggerTradeSimulation(ticker, payload, existingState) : false;
              if (debug && tickerFilter) {
                replayCtx.debugRows = replayCtx.debugRows || [];
                replayCtx.debugEnterNow = (replayCtx.debugEnterNow || 0) + (finalStage === "enter_now" ? 1 : 0);
                if (finalStage === "enter_now" && replayCtx.debugRows.length < 15) {
                  const blockers = getEntryBlockers(ticker, payload, existingState);
                  replayCtx.debugRows.push({ ticker, ts: rowTs, stage: finalStage, shouldTrigger, blockers, rank: payload.rank ?? payload.rank_position, rr: payload.rr, comp: payload.completion, trigger_reason: payload.trigger_reason });
                } else if (finalStage === "watch" && payload.state === "HTF_BULL_LTF_BULL" && replayCtx.debugRows.length < 5) {
                  const ent = entryType(payload);
                  if (ent?.corridor) {
                    replayCtx.debugRows.push({ ticker, ts: rowTs, stage: "watch", reason: "momentum_in_corridor_but_watch", rank: payload.rank ?? payload.rank_position, score: payload.score, trigger_reason: payload.trigger_reason });
                  }
                }
              }
              await processTradeSimulation(KV, ticker, payload, existingState, env, { forceUseIngestTs: true, replayBatchContext: replayCtx, asOfTs: rowTs });
              const countAfter = replayCtx.allTrades.filter((x) => String(x?.ticker).toUpperCase() === ticker).length;
              if (countAfter > countBefore) tradesCreated += countAfter - countBefore;
            } catch (e) {
              console.error(`[REPLAY-INGEST] row error:`, e);
            }
          }

          for (const [ticker, payload] of Object.entries(stateMap)) {
            await kvPutJSON(KV, `timed:latest:${ticker}`, payload);
          }
          await kvPutJSON(KV, "timed:trades:all", replayCtx.allTrades);

          const nextBucket = currentBucket + bucketMs;
          const hasMoreInBucket = rows.length >= limit;
          const nextBucketOffset = hasMoreInBucket ? bucketOffset + rows.length : null;
          const hasMore = hasMoreInBucket || nextBucket <= tsEnd;

          const resp = {
            ok: true,
            date: dayKey,
            ticker: tickerFilter || null,
            bucketProcessed: currentBucket,
            bucketOffset,
            rowsProcessed: rows.length,
            tradesCreated,
            tradesPurged,
            nextBucket: !hasMoreInBucket && nextBucket <= tsEnd ? nextBucket : null,
            nextBucketOffset: hasMoreInBucket ? nextBucketOffset : null,
            hasMore,
            hasMoreInBucket,
          };
          if (debug) {
            resp.debug = { rows: replayCtx?.debugRows || [], enterNowCount: replayCtx?.debugEnterNow || 0 };
          }
          return sendJSON(resp, 200, corsHeaders(env, req));
        } catch (e) {
          console.error("[REPLAY-INGEST] error:", e);
          return sendJSON({ ok: false, error: String(e?.message || e) }, 500, corsHeaders(env, req));
        }
      }

      // POST /timed/admin/replay-day?key=...&date=YYYY-MM-DD&limit=...&offset=...&cleanSlate=1&bucketMinutes=5
      // Replay a day's timed_trail ingests from 9:30 AM ET, chronologically. Kanban + trade simulation.
      // cleanSlate=1: purge ALL trades and reset entry state for a clean simulation of the day only.
      // bucketMinutes=5: group ingests into 5-min buckets (latest per ticker per bucket) for structured progression.
      if (url.pathname === "/timed/admin/replay-day" && req.method === "POST") {
        const authFail = requireKeyOr401(req, env);
        if (authFail) return authFail;

        const db = env?.DB;
        if (!db) {
          return sendJSON(
            { ok: false, error: "no_db_binding" },
            500,
            corsHeaders(env, req),
          );
        }

        const dateParam = url.searchParams.get("date") || null;
        const dayKey =
          dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)
            ? dateParam
            : nyTradingDayKey(Date.now());
        const marketOpen = nyWallTimeToUtcMs(dayKey, 9, 30, 0);
        const dayEnd = nyWallTimeToUtcMs(dayKey, 23, 59, 59);
        const tsEnd = dayEnd != null ? dayEnd + 999 : Date.now();
        const tsStart = marketOpen != null ? marketOpen : Date.now() - 24 * 60 * 60 * 1000;
        const tsStartInt = Math.floor(Number(tsStart));
        const tsEndInt = Math.floor(Number(tsEnd));

        const cleanSlate = url.searchParams.get("cleanSlate") === "1" || url.searchParams.get("cleanSlate") === "true";
        const bucketMinutes = Math.max(1, Math.min(60, Number(url.searchParams.get("bucketMinutes")) || 0));
        const tickerFilter = (url.searchParams.get("ticker") || "").trim().toUpperCase();
        const qLimit = tickerFilter ? 200 : Math.min(Number(url.searchParams.get("limit")) || 50, 100);
        const qOffset = Number(url.searchParams.get("offset")) || 0;

        let rows = [];
        let totalRows = null;
        try {
          if (bucketMinutes > 0) {
            // Bucket mode: fetch all rows, group by 5-min (or N-min) buckets, latest per ticker per bucket
            const allRes = await db.prepare(
              `SELECT ticker, ts, payload_json FROM ingest_receipts
               WHERE ts >= ?1 AND ts <= ?2
               ORDER BY ts ASC`,
            ).bind(tsStart, tsEnd).all();
            const rawRows = allRes?.results || [];
            const bucketMs = bucketMinutes * 60 * 1000;
            const byBucket = {};
            for (const r of rawRows) {
              const ts = Number(r?.ts);
              if (!Number.isFinite(ts)) continue;
              const bucketTs = Math.floor(ts / bucketMs) * bucketMs;
              if (!byBucket[bucketTs]) byBucket[bucketTs] = {};
              const tkr = String(r?.ticker || "").toUpperCase();
              if (!tkr) continue;
              byBucket[bucketTs][tkr] = r;
            }
            const buckets = Object.keys(byBucket).map(Number).sort((a, b) => a - b);
            const bucketedRows = [];
            for (const bt of buckets) {
              for (const r of Object.values(byBucket[bt])) bucketedRows.push(r);
            }
            totalRows = bucketedRows.length;
            rows = bucketedRows.slice(qOffset, qOffset + qLimit);
          } else if (tickerFilter) {
            // Single-ticker: use d1GetTrailRange (NO payload_json - avoids D1 string limits), build minimal payload
            let trailRes;
            try {
              trailRes = await d1GetTrailRange(env, tickerFilter, tsStartInt, 500);
              if (!trailRes?.ok) {
                return sendJSON(
                  { ok: false, error: "trail_range_failed", detail: trailRes?.error || "unknown" },
                  500,
                  corsHeaders(env, req),
                );
              }
            } catch (trailErr) {
              return sendJSON(
                { ok: false, error: "trail_fetch_failed", detail: String(trailErr?.message || trailErr) },
                500,
                corsHeaders(env, req),
              );
            }
            const trail = trailRes?.trail || [];
            const inRange = trail.filter((p) => {
              const ts = Number(p?.ts);
              return Number.isFinite(ts) && ts >= tsStartInt && ts <= tsEndInt;
            });
            rows = inRange.map((p) => {
              const obj = {
                ticker: tickerFilter,
                ts: Number(p?.ts),
                price: p?.price,
                htf_score: p?.htf_score,
                ltf_score: p?.ltf_score,
                completion: p?.completion,
                phase_pct: p?.phase_pct,
                state: p?.state,
                rank: p?.rank,
                flags: p?.flags || {},
                trigger_reason: p?.trigger_reason,
                trigger_dir: p?.trigger_dir,
              };
              return { ticker: tickerFilter, ts: obj.ts, payload_json: JSON.stringify(obj) };
            });
            totalRows = rows.length;
          } else {
            // Multi-ticker: lightweight meta then fetch payload per row
            const metaStmt = db.prepare(
              `SELECT ticker, ts FROM timed_trail
               WHERE ts >= ?1 AND ts <= ?2
               ORDER BY ts ASC
               LIMIT ?3 OFFSET ?4`,
            );
            const metaResult = await metaStmt.bind(
              tsStartInt,
              tsEndInt,
              Math.min(20, Math.floor(qLimit)),
              Math.floor(qOffset),
            ).all();
            const metaRows = metaResult?.results || [];
            rows = [];
            for (const m of metaRows) {
              const rawTicker = String(m?.ticker || "").trim();
              const tsVal = Number(m?.ts);
              if (!rawTicker || !Number.isFinite(tsVal)) continue;
              try {
                const payRow = await db.prepare(
                  `SELECT payload_json FROM timed_trail WHERE ticker = ?1 AND ts = ?2 LIMIT 1`,
                ).bind(rawTicker, tsVal).first();
                rows.push({ ticker: rawTicker, ts: tsVal, payload_json: payRow?.payload_json ?? null });
              } catch {
                rows.push({ ticker: rawTicker, ts: tsVal, payload_json: null });
              }
            }
            if (qOffset === 0) totalRows = rows.length;
          }
        } catch (e) {
          return sendJSON(
            { ok: false, error: String(e?.message || e) },
            500,
            corsHeaders(env, req),
          );
        }

        let allTrades = (await kvGetJSON(KV, "timed:trades:all")) || [];
        let tradesPurged = 0;
        if (qOffset === 0 && rows.length > 0) {
          if (cleanSlate) {
            if (tickerFilter) {
              // Single-ticker mode: purge only this ticker's trades in the day range
              const kept = allTrades.filter((t) => {
                const tkr = String(t?.ticker || "").toUpperCase();
                if (tkr !== tickerFilter) return true;
                const entryTs = isoToMs(t?.entry_ts ?? t?.entryTime) ?? Number(t?.entry_ts ?? t?.entryTs);
                if (!Number.isFinite(entryTs) || entryTs <= 0) return true;
                if (entryTs < tsStart || entryTs > tsEnd) return true;
                tradesPurged += 1;
                return false;
              });
              allTrades = kept;
              await kvPutJSON(KV, "timed:trades:all", kept);
            } else {
              // Full replay: purge ALL trades
              tradesPurged = allTrades.length;
              allTrades = [];
              await kvPutJSON(KV, "timed:trades:all", []);
            }
          } else {
            // Purge trades in the day window only
            const kept = allTrades.filter((t) => {
              const entryTs = isoToMs(t?.entry_ts ?? t?.entryTime) ?? Number(t?.entry_ts ?? t?.entryTs);
              if (!Number.isFinite(entryTs) || entryTs <= 0) return true;
              if (entryTs < tsStart || entryTs > tsEnd) return true;
              tradesPurged += 1;
              return false;
            });
            allTrades = kept;
            await kvPutJSON(KV, "timed:trades:all", kept);
          }
        }

        const uniqueTickers = [...new Set(rows.map((r) => String(r?.ticker || "").toUpperCase()).filter(Boolean))];
        const existingMap = await Promise.all(
          uniqueTickers.map((t) => kvGetJSON(KV, `timed:latest:${t}`)),
        ).then((arr) => Object.fromEntries(uniqueTickers.map((t, i) => [t, arr[i] || {}])));
        const stateMap = {};
        for (const t of uniqueTickers) {
          const ex = existingMap[t] || {};
          const exEntryTs = Number(ex?.entry_ts ?? ex?.entryTs);
          const shouldReset = cleanSlate && (qOffset === 0 || (Number.isFinite(exEntryTs) && exEntryTs < tsStart));
          if (shouldReset) {
            stateMap[t] = { ...ex, entry_ts: null, entry_price: null, kanban_cycle_enter_now_ts: null, kanban_cycle_trigger_ts: null, kanban_cycle_side: null };
          } else {
            stateMap[t] = ex ? { ...ex } : {};
          }
        }

        const findOpenInArray = (trades, sym) =>
          trades.find(
            (x) =>
              String(x?.ticker || "").toUpperCase() === sym &&
              isOpenTradeStatus(x?.status),
          ) || null;

        const replayCtx = { allTrades };

        let processed = 0;
        let tradesCreated = 0;
        const laneCounts = {};
        const errors = [];

        for (const row of rows) {
          try {
            const ticker = String(row?.ticker || "").toUpperCase();
            if (!ticker) continue;
            let payload;
            try {
              payload = row.payload_json ? JSON.parse(row.payload_json) : null;
            } catch {
              continue;
            }
            if (!payload || typeof payload !== "object") continue;

            const rowTs = Number(row?.ts);
            if (!Number.isFinite(rowTs)) continue;
            payload.ts = rowTs;
            payload.ingest_ts = rowTs;
            // Replay: ensure trigger_ts for lifecycle gate (use ingest ts if missing)
            if ((payload.trigger_ts == null || !Number.isFinite(Number(payload.trigger_ts))) && Number.isFinite(rowTs)) {
              payload.trigger_ts = rowTs < 1e12 ? rowTs * 1000 : rowTs;
            }
            // Normalize SL/TP from alternate field names
            if ((payload.sl == null || !Number.isFinite(Number(payload.sl))) && payload.sl_price != null) payload.sl = payload.sl_price;
            if ((payload.sl == null || !Number.isFinite(Number(payload.sl))) && payload.stop_loss != null) payload.sl = payload.stop_loss;
            const tpVal = payload.tp ?? payload.tp_max_price ?? payload.tp_target_price ?? payload.tp_target;
            if ((payload.tp == null || !Number.isFinite(Number(payload.tp))) && tpVal != null && Number.isFinite(Number(tpVal))) payload.tp = Number(tpVal);

            const existing = stateMap[ticker] || {};
            const existingTs = Number(existing?.ts ?? existing?.ingest_ts);
            const isEarlierThanStored = !Number.isFinite(existingTs) || rowTs < existingTs;

            if (isEarlierThanStored) {
              payload.entry_ts = null;
              payload.entry_price = null;
              payload.kanban_cycle_enter_now_ts = null;
              payload.kanban_cycle_trigger_ts = null;
              payload.kanban_cycle_side = null;
            } else {
              if (existing?.entry_ts != null && payload.entry_ts == null)
                payload.entry_ts = Number(existing.entry_ts);
              if (existing?.entry_price != null && payload.entry_price == null)
                payload.entry_price = Number(existing.entry_price);
              if (existing?.kanban_cycle_enter_now_ts != null)
                payload.kanban_cycle_enter_now_ts = existing.kanban_cycle_enter_now_ts;
              if (existing?.kanban_cycle_trigger_ts != null)
                payload.kanban_cycle_trigger_ts = existing.kanban_cycle_trigger_ts;
              if (existing?.kanban_cycle_side != null)
                payload.kanban_cycle_side = existing.kanban_cycle_side;
            }

            const openTrade = findOpenInArray(replayCtx.allTrades, ticker);
            if ((payload.entry_ts == null || payload.entry_price == null) && openTrade) {
              const et = isoToMs(openTrade.entryTime) || Number(openTrade.entry_ts) || Number(openTrade.entryTs);
              const ep = Number(openTrade.entryPrice ?? openTrade.entry_price);
              if (payload.entry_ts == null && Number.isFinite(et)) payload.entry_ts = et;
              if (payload.entry_price == null && Number.isFinite(ep) && ep > 0)
                payload.entry_price = ep;
            }

            payload.move_status = computeMoveStatus(payload);
            if (payload.flags) {
              payload.flags.move_invalidated = payload.move_status?.status === "INVALIDATED";
              payload.flags.move_completed = payload.move_status?.status === "COMPLETED";
            }

            const prevStage = existing?.kanban_stage;
            const stage = classifyKanbanStage(payload);
            let finalStage = stage;

            if (
              prevStage === "archive" &&
              ["hold", "just_entered", "trim", "exit"].includes(stage)
            ) {
              finalStage = "watch";
              if (!payload.flags) payload.flags = {};
              payload.flags.recycled_from_archive = true;
            }

            const mgmt = ["hold", "just_entered", "trim", "exit"].includes(finalStage);
            if (mgmt) {
              const curTriggerTs = Number(payload?.trigger_ts);
              const curSide = sideFromStateOrScores(payload);
              const cycleEnterTs = Number(existing?.kanban_cycle_enter_now_ts);
              const cycleTrig = Number(existing?.kanban_cycle_trigger_ts);
              const cycleSide = existing?.kanban_cycle_side != null ? String(existing.kanban_cycle_side) : null;
              const sameTrig =
                Number.isFinite(curTriggerTs) &&
                curTriggerTs > 0 &&
                Number.isFinite(cycleTrig) &&
                cycleTrig > 0 &&
                cycleTrig === curTriggerTs;
              const cycleOk =
                Number.isFinite(cycleEnterTs) &&
                cycleEnterTs > 0 &&
                sameTrig &&
                !!cycleSide &&
                !!curSide &&
                cycleSide === curSide;

              if (!Number.isFinite(curTriggerTs) || curTriggerTs <= 0) {
                finalStage = "watch";
                if (!payload.flags) payload.flags = {};
                payload.flags.forced_watch_missing_trigger = true;
              } else if (!cycleOk) {
                finalStage = "enter_now";
                if (!payload.flags) payload.flags = {};
                payload.flags.forced_enter_now_gate = true;
              }
            }

            if (finalStage === "enter_now") {
              payload.kanban_cycle_enter_now_ts = rowTs;
              payload.kanban_cycle_trigger_ts =
                Number.isFinite(Number(payload?.trigger_ts)) && payload.trigger_ts > 0
                  ? payload.trigger_ts
                  : null;
              payload.kanban_cycle_side = sideFromStateOrScores(payload);
            } else if (["hold", "just_entered", "trim", "exit"].includes(finalStage)) {
              payload.kanban_cycle_enter_now_ts = existing?.kanban_cycle_enter_now_ts ?? null;
              payload.kanban_cycle_trigger_ts = existing?.kanban_cycle_trigger_ts ?? null;
              payload.kanban_cycle_side = existing?.kanban_cycle_side ?? null;
            } else {
              payload.kanban_cycle_enter_now_ts = null;
              payload.kanban_cycle_trigger_ts = null;
              payload.kanban_cycle_side = null;
            }

            if (
              prevStage != null &&
              finalStage != null &&
              String(prevStage) !== String(finalStage)
            ) {
              payload.prev_kanban_stage = String(prevStage);
              payload.prev_kanban_stage_ts = rowTs;
            }

            if (finalStage === "enter_now" && prevStage !== "enter_now") {
              const price = Number(payload?.price);
              if (Number.isFinite(price) && price > 0) {
                payload.entry_price = price;
                payload.entry_ts = rowTs;
              }
            }
            if (finalStage && existing?.entry_price) {
              payload.entry_price = existing.entry_price;
              payload.entry_ts = existing.entry_ts;
            }

            payload.kanban_stage = finalStage;
            payload.kanban_meta = deriveKanbanMeta(payload, finalStage);

            laneCounts[finalStage || "null"] = (laneCounts[finalStage || "null"] || 0) + 1;

            stateMap[ticker] = payload;

            const countBefore = replayCtx.allTrades.filter(
              (x) => String(x?.ticker).toUpperCase() === ticker,
            ).length;
            await processTradeSimulation(KV, ticker, payload, existing, env, {
              forceUseIngestTs: true,
              replayBatchContext: replayCtx,
              asOfTs: rowTs,
            });
            const countAfter = replayCtx.allTrades.filter(
              (x) => String(x?.ticker).toUpperCase() === ticker,
            ).length;
            if (countAfter > countBefore) tradesCreated += countAfter - countBefore;

            processed += 1;
          } catch (e) {
            errors.push({ ticker: row?.ticker || null, error: String(e?.message || e) });
          }
        }

        await kvPutJSON(KV, "timed:trades:all", replayCtx.allTrades);
        await Promise.all(
          Object.entries(stateMap).map(([t, p]) =>
            kvPutJSON(KV, `timed:latest:${t}`, p),
          ),
        );

        const nextOffset = qOffset + rows.length;
        const hasMore = rows.length >= qLimit;

        try {
          await d1SyncLatestBatchFromKV(env, { waitUntil: () => {} }, 50);
        } catch (syncErr) {
          errors.push({ sync: String(syncErr?.message || syncErr) });
        }

        return sendJSON(
          {
            ok: true,
            day: dayKey,
            ticker: tickerFilter || undefined,
            cleanSlate: cleanSlate || undefined,
            bucketMinutes: bucketMinutes > 0 ? bucketMinutes : undefined,
            tsStart,
            tsEnd,
            totalRows: totalRows ?? undefined,
            rowsProcessed: processed,
            tradesCreated,
            tradesPurged: qOffset === 0 ? tradesPurged : undefined,
            laneCounts,
            offset: qOffset,
            nextOffset: hasMore ? nextOffset : null,
            hasMore,
            errorsCount: errors.length,
            errors: errors.slice(0, 10),
          },
          200,
          corsHeaders(env, req),
        );
      }

      // POST /timed/admin/dedupe-trades?key=... - Remove duplicate trades (same ticker+direction+entry_ts)
      if (url.pathname === "/timed/admin/dedupe-trades" && req.method === "POST") {
        const authFail = requireKeyOr401(req, env);
        if (authFail) return authFail;

        try {
          const tradesKey = "timed:trades:all";
          const allTrades = (await kvGetJSON(KV, tradesKey)) || [];
          const entryTsFor = (t) => {
            const et = Number(t?.entry_ts ?? t?.entryTs);
            if (Number.isFinite(et)) return et;
            const iso = t?.entryTime;
            if (iso) return isoToMs(iso) || null;
            const hist = Array.isArray(t?.history) ? t.history : [];
            const ent = hist.find((e) => String(e?.type || "").toUpperCase() === "ENTRY");
            return ent ? isoToMs(ent.timestamp ?? ent.ts) || null : null;
          };
          const seen = new Set();
          const deduped = [];
          for (const t of allTrades) {
            const ticker = String(t?.ticker || "").toUpperCase();
            const dir = String(t?.direction || "").toUpperCase();
            const et = entryTsFor(t);
            const key = `${ticker}:${dir}:${et != null ? et : t?.id || ""}`;
            if (seen.has(key)) continue;
            seen.add(key);
            deduped.push(t);
          }
          const removed = allTrades.length - deduped.length;
          if (removed > 0) await kvPutJSON(KV, tradesKey, deduped);
          return sendJSON(
            { ok: true, before: allTrades.length, after: deduped.length, removed },
            200,
            corsHeaders(env, req),
          );
        } catch (e) {
          return sendJSON(
            { ok: false, error: String(e?.message || e) },
            500,
            corsHeaders(env, req),
          );
        }
      }

      // POST /timed/admin/refresh-latest-from-ingest?key=... - Restore KV from actual latest ingest_receipts per ticker.
      // Use after replay to fix stale data (replay only keeps last-seen-per-bucket; this gets true latest).
      if (url.pathname === "/timed/admin/refresh-latest-from-ingest" && req.method === "POST") {
        const authFail = requireKeyOr401(req, env);
        if (authFail) return authFail;

        const db = env?.DB;
        const KV = env?.KV_TIMED;
        if (!db || !KV) {
          return sendJSON({ ok: false, error: "missing_db_or_kv" }, 500, corsHeaders(env, req, true));
        }

        const scriptVersion = url.searchParams.get("scriptVersion") || "2.5.0";
        const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get("limit") || "25", 10)));
        const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10));
        const tickers = (await kvGetJSON(KV, "timed:tickers")) || [];
        const toProcess = Array.isArray(tickers) ? tickers.slice(offset, offset + limit) : [];

        let refreshed = 0;
        let errors = 0;
        for (const t of toProcess) {
          const ticker = String(t || "").toUpperCase();
          if (!ticker) continue;
          try {
            const row = await db.prepare(
              `SELECT payload_json, ts FROM ingest_receipts
               WHERE ticker = ?1 AND (script_version = ?2 OR script_version IS NULL)
               ORDER BY ts DESC LIMIT 1`
            ).bind(ticker, scriptVersion).first();
            if (!row?.payload_json) continue;
            let payload;
            try {
              payload = JSON.parse(String(row.payload_json));
            } catch {
              continue;
            }
            if (!payload || typeof payload !== "object") continue;
            const rowTs = Number(row.ts);
            payload.ts = rowTs;
            payload.ingest_ts = rowTs;
            if ((payload.trigger_ts == null || !Number.isFinite(Number(payload.trigger_ts))) && Number.isFinite(rowTs)) {
              payload.trigger_ts = rowTs < 1e12 ? rowTs * 1000 : rowTs;
            }
            if ((payload.sl == null || !Number.isFinite(Number(payload.sl))) && payload.sl_price != null) payload.sl = payload.sl_price;
            if ((payload.sl == null || !Number.isFinite(Number(payload.sl))) && payload.stop_loss != null) payload.sl = payload.stop_loss;
            const tpVal = payload.tp ?? payload.tp_max_price ?? payload.tp_target_price ?? payload.tp_target;
            if ((payload.tp == null || !Number.isFinite(Number(payload.tp))) && tpVal != null && Number.isFinite(Number(tpVal))) payload.tp = Number(tpVal);
            const existing = (await kvGetJSON(KV, `timed:latest:${ticker}`)) || {};
            if (existing?.entry_ts != null) payload.entry_ts = existing.entry_ts;
            if (existing?.entry_price != null) payload.entry_price = existing.entry_price;
            if (existing?.kanban_cycle_enter_now_ts != null) payload.kanban_cycle_enter_now_ts = existing.kanban_cycle_enter_now_ts;
            if (existing?.kanban_cycle_trigger_ts != null) payload.kanban_cycle_trigger_ts = existing.kanban_cycle_trigger_ts;
            if (existing?.kanban_cycle_side != null) payload.kanban_cycle_side = existing.kanban_cycle_side;
            payload.move_status = computeMoveStatus(payload);
            if (payload.flags) {
              payload.flags.move_invalidated = payload.move_status?.status === "INVALIDATED";
              payload.flags.move_completed = payload.move_status?.status === "COMPLETED";
            }
            const prevStage = existing?.kanban_stage;
            const stage = classifyKanbanStage(payload);
            payload.kanban_stage = stage;
            payload.kanban_meta = deriveKanbanMeta(payload, stage);
            if (prevStage != null && stage != null && String(prevStage) !== String(stage)) {
              payload.prev_kanban_stage = String(prevStage);
              payload.prev_kanban_stage_ts = rowTs;
            }
            await kvPutJSON(KV, `timed:latest:${ticker}`, payload);
            refreshed++;
          } catch (e) {
            errors++;
          }
        }

        const syncResult = refreshed > 0
          ? await d1SyncLatestBatchFromKV(env, { waitUntil: () => {} }, 200).catch(() => ({}))
          : {};
        return sendJSON({
          ok: true,
          refreshed,
          errors,
          total: toProcess.length,
          offset,
          hasMore: offset + toProcess.length < (Array.isArray(tickers) ? tickers.length : 0),
          sync: syncResult,
        }, 200, corsHeaders(env, req, true));
      }

      // POST /timed/admin/force-sync?key=... - Force D1 sync from KV (refresh all tickers)
      if (url.pathname === "/timed/admin/force-sync" && req.method === "POST") {
        const authFail = requireKeyOr401(req, env);
        if (authFail) return authFail;

        try {
          const result = await d1SyncLatestBatchFromKV(env, { waitUntil: () => {} }, 200);
          return sendJSON(result, 200, corsHeaders(env, req, true));
        } catch (error) {
          return sendJSON(
            { ok: false, error: String(error) },
            500,
            corsHeaders(env, req, true),
          );
        }
      }

      // POST /timed/admin/reset?key=... - Reset system state as if freshly launched (SAFE by default)
      // Default behavior (safe):
      // - Clears KV simulated trades + paper portfolio + activity feed
      // - Clears per-ticker Kanban entry stamps + lane transition memory + flip-watch stickiness
      // - Recomputes kanban_stage immediately (so UI is clean right away)
      // Optional (DANGEROUS; opt-in via query params):
      // - resetMl=1      -> clears ML model + training queue
      // - resetLedger=1  -> clears D1 ledger tables (alerts/trades/events)
      if (url.pathname === "/timed/admin/reset" && req.method === "POST") {
        const authFail = requireKeyOr401(req, env);
        if (authFail) return authFail;

        const resetLedger =
          url.searchParams.get("resetLedger") === "1" ||
          url.searchParams.get("resetLedger") === "true";

        const resetMl =
          url.searchParams.get("resetMl") === "1" ||
          url.searchParams.get("resetMl") === "true";

        const now = Date.now();
        const tickerIndex = (await kvGetJSON(KV, "timed:tickers")) || [];
        const tickers = Array.isArray(tickerIndex) ? tickerIndex : [];

        const resetPayload = (p) => {
          if (!p || typeof p !== "object") return p;

          // Clear Kanban state + entry stamps
          p.kanban_stage = null;
          p.prev_kanban_stage = null;
          p.prev_kanban_stage_ts = null;
          p.kanban_meta = null;
          p.kanban_cycle_enter_now_ts = null;
          p.kanban_cycle_trigger_ts = null;
          p.kanban_cycle_side = null;

          p.entry_price = null;
          p.entry_ts = null;
          p.entry_change_pct = null;

          // Clear flip watch stickiness
          p.flip_watch_score = null;
          p.flip_watch_reasons = null;
          p.flip_watch_until_ts = null;

          // Force recompute on next read/ingest
          p.move_status = null;

          // Clear forcing flags
          p.flags = p.flags && typeof p.flags === "object" ? p.flags : {};
          p.flags.flip_watch = false;
          for (const k of Object.keys(p.flags)) {
            if (
              k.startsWith("forced_") ||
              k === "recycled_from_archive" ||
              k === "move_invalidated" ||
              k === "move_completed"
            ) {
              try {
                delete p.flags[k];
              } catch {}
            }
          }

          // Recompute stage immediately so UI is clean after reset
          try {
            const stage = classifyKanbanStage(p);
            p.kanban_stage = stage;
            p.kanban_meta = deriveKanbanMeta(p, stage);
          } catch {
            p.kanban_stage = null;
            p.kanban_meta = null;
          }

          p.reset_at = now;
          return p;
        };

        // Clear KV simulated trades + paper portfolio + activity feed
        const kvCleared = [];
        try {
          await KV.delete("timed:trades:all");
          kvCleared.push("timed:trades:all");
        } catch {}
        try {
          await KV.delete(PORTFOLIO_KEY);
          kvCleared.push(PORTFOLIO_KEY);
        } catch {}
        try {
          await KV.delete("timed:activity:feed");
          kvCleared.push("timed:activity:feed");
        } catch {}

        // Clear ML model (optional; OFF by default)
        if (resetMl) {
          try {
            await KV.delete("timed:model:ml_v1");
            kvCleared.push("timed:model:ml_v1");
          } catch {}
          try {
            await KV.delete("timed:model:ml_v1:last_ts");
            kvCleared.push("timed:model:ml_v1:last_ts");
          } catch {}
        }

        // Archive open trades (always) + optionally clear ledger (OFF by default)
        let d1Cleared = [];
        try {
          if (env?.DB) {
            // Archive all open trades by default (non-destructive)
            try {
              const archiveSql = "UPDATE trades SET status = 'ARCHIVED' WHERE status NOT IN ('WIN', 'LOSS', 'ARCHIVED')";
              const archiveResult = await env.DB.prepare(archiveSql).run();
              d1Cleared.push({ sql: archiveSql, changes: archiveResult?.meta?.changes ?? 0 });
            } catch (archiveErr) {
              // ignore if table doesn't exist
            }
            
            if (resetLedger) {
              // Full ledger clear (DANGEROUS; opt-in only)
              for (const sql of [
                "DELETE FROM trade_events",
                "DELETE FROM trades",
                "DELETE FROM alerts",
              ]) {
                try {
                  const r = await env.DB.prepare(sql).run();
                  d1Cleared.push({ sql, changes: r?.meta?.changes ?? null });
                } catch {
                  // ignore missing tables
                }
              }
            }
            // ML queue
            if (resetMl) {
              try {
                const r = await env.DB.prepare("DELETE FROM ml_v1_queue").run();
                d1Cleared.push({
                  sql: "DELETE FROM ml_v1_queue",
                  changes: r?.meta?.changes ?? null,
                });
              } catch {}
            }
          }
        } catch {}

        // Reset per-ticker latest payloads (KV + D1 latest)
        const results = { processed: 0, updated: 0, skipped: 0, errors: [] };
        for (const t of tickers) {
          const ticker = normTicker(t);
          if (!ticker) continue;
          try {
            const latest = await kvGetJSON(KV, `timed:latest:${ticker}`);
            if (!latest || typeof latest !== "object") {
              results.skipped++;
              continue;
            }
            const next = resetPayload({ ...latest });
            await kvPutJSON(KV, `timed:latest:${ticker}`, next);
            try {
              ctx.waitUntil(d1UpsertTickerLatest(env, ticker, next));
              ctx.waitUntil(d1UpsertTickerIndex(env, ticker, next?.ts));
            } catch {}
            results.updated++;
            results.processed++;
          } catch (e) {
            results.errors.push({ ticker: String(t), error: String(e?.message || e) });
          }
        }

        return sendJSON(
          {
            ok: true,
            message: "System reset complete (as-of now).",
            now,
            tickers: { total: tickers.length, ...results },
            kvCleared,
            d1Cleared,
            resetMl,
            resetLedger,
            note: "Lanes recompute from fresh state; new KV simulated trades will be created as new data/alerts come in. D1 ledger is preserved unless resetLedger=1.",
          },
          200,
          corsHeaders(env, req),
        );
      }

      return sendJSON(
        { ok: false, error: "not_found" },
        404,
        corsHeaders(env, req),
      );
    } catch (topLevelErr) {
      // Catch any unhandled errors and return a proper response with CORS headers
      console.error(`[FETCH ERROR] Unhandled error in fetch handler:`, {
        error: String(topLevelErr),
        message: topLevelErr?.message,
        stack: topLevelErr?.stack,
        url: req?.url,
        method: req?.method,
        hasKV: !!env?.KV_TIMED,
        pathname: new URL(req?.url || "").pathname,
      });
      return sendJSON(
        {
          ok: false,
          error: "internal_error",
          message: "An unexpected error occurred",
          details:
            process.env.NODE_ENV === "development"
              ? String(topLevelErr)
              : undefined,
        },
        500,
        corsHeaders(env, req),
      );
    }
  },

  // Scheduled handler for periodic AI updates (9:45 AM, noon, 3:30 PM ET) and trade updates (every 5 min)
  async scheduled(event, env, ctx) {
    const KV = env.KV_TIMED;
    const now = new Date();
    const hour = now.getUTCHours();
    const minute = now.getUTCMinutes();
    const processedTickers = new Set();

    // KV → D1 warm-up (every run) so UI reads are fast/complete
    try {
      // Run in background so it doesn't block other scheduled work
      ctx.waitUntil(d1SyncLatestBatchFromKV(env, ctx, 75));
    } catch (e) {
      console.error("[D1 SYNC] scheduled kickoff failed:", String(e));
    }

    // Note: /timed/all now reads from D1 (single query). No KV cache build needed here.

    // Always update open trades (runs every 5 minutes)
    try {
      const tradesKey = "timed:trades:all";
      const allTrades = (await kvGetJSON(KV, tradesKey)) || [];
      const openTrades = allTrades.filter(
        (t) => t.status === "OPEN" || !t.status || t.status === "TP_HIT_TRIM",
      );

      if (openTrades.length > 0) {
        console.log(
          `[TRADE UPDATE CRON] Updating ${openTrades.length} open trades`,
        );

        for (const trade of openTrades) {
          try {
            processedTickers.add(String(trade.ticker || "").toUpperCase());
            const latestData = await kvGetJSON(
              KV,
              `timed:latest:${trade.ticker}`,
            );
            if (latestData) {
              // Use processTradeSimulation to ensure entry price correction logic runs
              const prevLatest = null; // No previous data for scheduled updates
              await processTradeSimulation(
                KV,
                trade.ticker,
                latestData,
                prevLatest,
                env,
              );
            }
          } catch (err) {
            console.error(
              `[TRADE UPDATE CRON] Error updating trade ${trade.ticker}:`,
              err,
            );
          }
        }

        // Re-read trades to get latest state (processTradeSimulation saves them)
        const finalTrades = (await kvGetJSON(KV, tradesKey)) || [];
        // Sort and save (in case processTradeSimulation doesn't sort)
        finalTrades.sort((a, b) => {
          const timeA = new Date(a.entryTime || 0).getTime();
          const timeB = new Date(b.entryTime || 0).getTime();
          return timeB - timeA;
        });
        await kvPutJSON(KV, tradesKey, finalTrades);
        console.log(`[TRADE UPDATE CRON] Updated ${openTrades.length} trades`);
      }
    } catch (error) {
      console.error("[TRADE UPDATE CRON ERROR]", error);
    }

    // Always evaluate Kanban-driven executions for all tickers (covers missed/absent ingests).
    // This is critical for reliability: entries/trims/exits should still happen even if a watchlist alert didn’t fire.
    try {
      const tickers = (await kvGetJSON(KV, "timed:tickers")) || [];
      if (Array.isArray(tickers) && tickers.length > 0) {
        console.log(`[KANBAN CRON] Evaluating ${tickers.length} tickers`);
        for (const t of tickers) {
          const sym = String(t || "").toUpperCase();
          if (!sym) continue;
          if (processedTickers.has(sym)) continue;
          try {
            const latestData = await kvGetJSON(KV, `timed:latest:${sym}`);
            if (!latestData) continue;
            await processTradeSimulation(KV, sym, latestData, null, env);
          } catch (e) {
            console.error(`[KANBAN CRON] Error processing ${sym}:`, e);
          }
        }
      } else {
        console.log("[KANBAN CRON] No tickers list found (timed:tickers empty)");
      }
    } catch (e) {
      console.error("[KANBAN CRON] top-level error:", e);
    }

    // Ingest coverage check (every 5 min during market hours)
    try {
      await checkIngestCoverage(KV, now);
    } catch (err) {
      console.error("[INGEST COVERAGE ERROR]", err);
    }

    // Proactive Alerts & Pattern Recognition (every 15 minutes during market hours)
    // This runs more frequently to catch time-sensitive conditions
    const isProactiveAlertTime = minute % 15 === 0; // Every 15 minutes

    if (isProactiveAlertTime) {
      try {
        const tradesKey = "timed:trades:all";
        const allTrades = (await kvGetJSON(KV, tradesKey)) || [];
        const openTrades = allTrades.filter(
          (t) => t.status === "OPEN" || t.status === "TP_HIT_TRIM",
        );

        // Fetch current ticker data for alert generation (use tickers index; don't arbitrarily truncate to 50)
        const tickers = (await kvGetJSON(KV, "timed:tickers")) || [];
        const tickerDataPromises = (Array.isArray(tickers) ? tickers : [])
          .slice(0, 600) // safety cap
          .map(async (t) => {
            try {
              const sym = String(t || "").toUpperCase();
              if (!sym) return null;
              const data = await kvGetJSON(KV, `timed:latest:${sym}`);
              if (!data) return null;
              return {
                ticker: sym,
                rank: Number(data.rank) || 0,
                rr: Number(data.rr) || 0,
                price: Number(data.price) || 0,
                completion: Number(data.completion) || 0,
                phase_pct: Number(data.phase_pct) || 0,
                flags: data.flags || {},
              };
            } catch {
              return null;
            }
          });

        const allTickers = (await Promise.all(tickerDataPromises)).filter(Boolean);

        // Generate proactive alerts
        const proactiveAlerts = generateProactiveAlerts(allTickers, allTrades);

        // Store high-priority alerts in KV for retrieval
        if (proactiveAlerts.filter((a) => a.priority === "high").length > 0) {
          const alertsKey = `timed:ai:alerts:${
            now.toISOString().split("T")[0]
          }`;
          const existingAlerts = (await kvGetJSON(KV, alertsKey)) || [];
          const newHighPriorityAlerts = proactiveAlerts
            .filter((a) => a.priority === "high")
            .map((a) => ({
              ...a,
              timestamp: now.toISOString(),
            }));

          // Merge and keep only last 50 alerts
          const updatedAlerts = [
            ...newHighPriorityAlerts,
            ...existingAlerts,
          ].slice(0, 50);
          await kvPutJSON(KV, alertsKey, updatedAlerts);

          console.log(
            `[PROACTIVE ALERTS] Generated ${proactiveAlerts.length} alerts, ${newHighPriorityAlerts.length} high-priority`,
          );
        }
      } catch (error) {
        console.error("[PROACTIVE ALERTS ERROR]", error);
      }
    }

    // AI Updates (only at specific times: 9:45 AM, noon, 3:30 PM ET)
    const isAITime =
      (hour === 14 && minute === 45) || // 9:45 AM ET
      (hour === 17 && minute === 0) || // 12:00 PM ET
      (hour === 20 && minute === 30); // 3:30 PM ET

    if (!isAITime) {
      return; // Only do AI updates at specific times
    }

    const openaiApiKey = env.OPENAI_API_KEY;
    if (!openaiApiKey) {
      console.error("[SCHEDULED] OpenAI API key not configured");
      return;
    }

    try {
      // Determine update time label
      let updateTime = "Market Update";
      if (hour === 14 && minute === 45) {
        updateTime = "Morning Market Update (9:45 AM ET)";
      } else if (hour === 17 && minute === 0) {
        updateTime = "Midday Market Update (12:00 PM ET)";
      } else if (hour === 20 && minute === 30) {
        updateTime = "Afternoon Market Update (3:30 PM ET)";
      }

      // Fetch all ticker data
      const allKeys = await KV.list({ prefix: "timed:latest:" });
      const tickerDataPromises = allKeys.keys.slice(0, 50).map(async (key) => {
        try {
          const data = await kvGetJSON(KV, key.name);
          if (data) {
            const ticker = key.name.replace("timed:latest:", "");
            return {
              ticker,
              rank: Number(data.rank) || 0,
              rr: Number(data.rr) || 0,
              price: Number(data.price) || 0,
              state: String(data.state || ""),
              phase_pct: Number(data.phase_pct) || 0,
              completion: Number(data.completion) || 0,
              flags: data.flags || {},
            };
          }
          return null;
        } catch (err) {
          return null;
        }
      });

      const allTickers = (await Promise.all(tickerDataPromises))
        .filter(Boolean)
        .sort((a, b) => (b.rank || 0) - (a.rank || 0));

      // Fetch recent activity
      const activityKeys = await KV.list({ prefix: "timed:activity:" });
      const activityPromises = activityKeys.keys.slice(-20).map(async (key) => {
        try {
          const data = await kvGetJSON(KV, key.name);
          if (data) {
            return {
              ticker: String(data.ticker || "UNKNOWN"),
              type: String(data.type || "event"),
              ts: Number(data.ts) || Date.now(),
              price: Number(data.price) || 0,
            };
          }
          return null;
        } catch (err) {
          return null;
        }
      });

      const activityEvents = (await Promise.all(activityPromises))
        .filter(Boolean)
        .sort((a, b) => b.ts - a.ts)
        .slice(0, 10);

      // Analyze for proactive alerts
      const primeSetups = allTickers.filter(
        (t) =>
          t.rank >= 75 &&
          t.rr >= 1.5 &&
          t.completion < 0.4 &&
          t.phase_pct < 0.6,
      );

      const highRiskPositions = allTickers.filter(
        (t) => t.completion > 0.7 || t.phase_pct > 0.8,
      );

      // Build monitoring prompt
      const monitoringPrompt = `You are providing a ${updateTime} for the Timed Trading platform.

## CURRENT MARKET DATA
- **${allTickers.length} total tickers** being monitored
- **${
        primeSetups.length
      } prime setups** (Rank ≥75, RR ≥1.5, Completion <40%, Phase <60%)
- **${
        highRiskPositions.length
      } high-risk positions** (Completion >70% or Phase >80%)
- **${activityEvents.length} recent activity events**

### Top Prime Setups:
${
  primeSetups
    .slice(0, 10)
    .map((t) => {
      const rr = Number(t.rr) || 0;
      const rrFormatted =
        rr >= 1 ? `${rr.toFixed(2)}:1` : `1:${(1 / rr).toFixed(2)}`;
      return `- **${t.ticker}**: Rank ${
        t.rank
      } | RR ${rrFormatted} | Price $${t.price.toFixed(2)} | Phase ${(
        t.phase_pct * 100
      ).toFixed(0)}% | Completion ${(t.completion * 100).toFixed(0)}%`;
    })
    .join("\n") || "None"
}

### Recent Activity:
${
  activityEvents
    .slice(0, 10)
    .map(
      (a) =>
        `- ${new Date(a.ts).toLocaleTimeString()}: **${a.ticker}** ${
          a.type
        } at $${a.price.toFixed(2)}`,
    )
    .join("\n") || "None"
}

Provide a concise market update with:
1. **🎯 Key Opportunities** (Top 3-5 setups to watch)
2. **⚠️ Warnings** (High-risk positions or market conditions)
3. **📊 Market Insights** (Overall conditions, trends)

Be concise (3-5 sentences per section).`;

      // Call OpenAI API
      const aiResponse = await fetch(
        "https://api.openai.com/v1/chat/completions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${openaiApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model:
              env.OPENAI_MODEL && env.OPENAI_MODEL !== "gpt-4"
                ? env.OPENAI_MODEL
                : "gpt-3.5-turbo",
            messages: [{ role: "system", content: monitoringPrompt }],
            temperature: 0.7,
            max_tokens: 800,
          }),
        },
      );

      if (!aiResponse.ok) {
        throw new Error(`OpenAI API error: ${aiResponse.status}`);
      }

      const aiData = await aiResponse.json();
      const aiMessage =
        aiData.choices?.[0]?.message?.content || "Market update unavailable.";

      // Store update in KV
      const updateKey = `timed:ai:update:${
        now.toISOString().split("T")[0]
      }:${hour}:${minute}`;
      const updateData = {
        timestamp: now.toISOString(),
        updateTime,
        analysis: aiMessage,
        stats: {
          totalTickers: allTickers.length,
          primeSetups: primeSetups.length,
          highRiskPositions: highRiskPositions.length,
          recentActivity: activityEvents.length,
        },
      };

      await KV.put(updateKey, JSON.stringify(updateData));

      // Also store in a list for easy retrieval
      const updatesListKey = `timed:ai:updates:list`;
      const existingList = (await kvGetJSON(KV, updatesListKey)) || [];
      existingList.unshift({
        key: updateKey,
        timestamp: now.toISOString(),
        updateTime,
      });
      // Keep only last 30 updates
      await KV.put(updatesListKey, JSON.stringify(existingList.slice(0, 30)));

      console.log(
        `[SCHEDULED] Generated ${updateTime} at ${now.toISOString()}`,
      );
    } catch (error) {
      console.error("[SCHEDULED ERROR]", error);
    }

    // ML Model Training (every 6 hours)
    // Train model from labeled queue entries
    try {
      const result = await mlV1TrainFromQueue(env, KV, 75);
      if (result.ok && result.trained > 0) {
        console.log(
          `[ML TRAINING] Trained on ${result.trained} examples, model n=${result.model_n}`,
        );
      } else if (result.ok) {
        console.log(`[ML TRAINING] No new labels ready for training`);
      }
    } catch (error) {
      console.error("[ML TRAINING ERROR]", error);
    }
  },
};
