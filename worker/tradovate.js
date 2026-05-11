// ═══════════════════════════════════════════════════════════════════════════════
// Tradovate REST helpers — auth, token cache, symbol mapping
//
// Used by:
//   - TradovateStream (worker/tradovate-stream.js) — the live-data DO
//   - Admin endpoints in worker/index.js for status / manual control
//
// Auth model (from docs/openapi.json + Tradovate WS docs):
//   1. POST /auth/accesstokenrequest { name, password, appId, appVersion, sec, cid, deviceId }
//   2. Response includes { accessToken, mdAccessToken, expirationTime, hasLive, hasMarketData }
//      - accessToken   → general REST API
//      - mdAccessToken → market data WebSocket (this is the one we send to wss://md-live...)
//   3. Tokens valid 90 min. Renew at GET /auth/renewaccesstoken ~5 min before expiry.
//   4. KV cache the token under `timed:tradovate:token` with TTL = (expiry - 5 min).
//
// Symbol mapping:
//   TradingView writes continuous symbols like "ES1!", "NQ1!". Tradovate uses
//   contract-specific symbols ("ESM6" = ES June 2026). For our use case
//   (Daily Brief reference + Bubble Map context), the front-month contract is
//   what we want for every futures ticker. The mapping rolls quarterly for index
//   futures (H/M/U/Z = Mar/Jun/Sep/Dec) and monthly for energy/metals.
// ═══════════════════════════════════════════════════════════════════════════════

const TD_AUTH_URL_LIVE = "https://live.tradovateapi.com/v1/auth/accesstokenrequest";
const TD_AUTH_URL_DEMO = "https://demo.tradovateapi.com/v1/auth/accesstokenrequest";
const TD_RENEW_URL_LIVE = "https://live.tradovateapi.com/v1/auth/renewaccesstoken";
const TD_RENEW_URL_DEMO = "https://demo.tradovateapi.com/v1/auth/renewaccesstoken";

export const TRADOVATE_WS_URL_LIVE = "wss://md-live.tradovateapi.com/v1/websocket";
export const TRADOVATE_WS_URL_DEMO = "wss://md-demo.tradovateapi.com/v1/websocket";

const KV_TOKEN_KEY = "timed:tradovate:token";

// ── Symbol mapping ────────────────────────────────────────────────────────────

// TV continuous → Tradovate product code (the root before the contract month).
// Quarterly = uses index-future cycle (H/M/U/Z). Monthly = energy/metals (every month).
const TV_TO_TRADOVATE_PRODUCT = {
  "ES1!":  { product: "ES",  cycle: "quarterly", desc: "S&P 500 E-mini" },
  "NQ1!":  { product: "NQ",  cycle: "quarterly", desc: "Nasdaq 100 E-mini" },
  "YM1!":  { product: "YM",  cycle: "quarterly", desc: "Dow E-mini" },
  "RTY1!": { product: "RTY", cycle: "quarterly", desc: "Russell 2000 E-mini" },
  "MES1!": { product: "MES", cycle: "quarterly", desc: "Micro S&P 500" },
  "MNQ1!": { product: "MNQ", cycle: "quarterly", desc: "Micro Nasdaq 100" },
  "MYM1!": { product: "MYM", cycle: "quarterly", desc: "Micro Dow" },
  "CL1!":  { product: "CL",  cycle: "monthly",   desc: "Crude Oil" },
  "GC1!":  { product: "GC",  cycle: "evenmonths", desc: "Gold" }, // GC trades G/J/M/Q/V/Z
  "SI1!":  { product: "SI",  cycle: "evenmonths", desc: "Silver" },
  "HG1!":  { product: "HG",  cycle: "evenmonths", desc: "Copper" },
  "NG1!":  { product: "NG",  cycle: "monthly",   desc: "Natural Gas" },
  // VX1! (VIX) intentionally omitted — being routed to TwelveData REST per
  // P0.7.132. The CFE VIX futures are technically on Tradovate but the
  // underlying VIX index is more useful for our use case.
};

// CME contract month codes (single letter)
const MONTH_CODES = {
  1: "F", 2: "G", 3: "H", 4: "J", 5: "K", 6: "M",
  7: "N", 8: "Q", 9: "U", 10: "V", 11: "X", 12: "Z",
};

// Quarterly cycle for index futures: only Mar/Jun/Sep/Dec contracts trade.
// Roll happens ~8 trading days before contract expiry (3rd Friday of contract
// month). For simplicity, we roll on the 8th of the contract month itself —
// close enough to the official roll, no edge case at the start of the month.
function nextQuarterlyContract(now) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1;     // 1-12
  const d = now.getUTCDate();
  // Quarterly months: 3, 6, 9, 12
  const quarterlies = [3, 6, 9, 12];
  let pickMonth = null;
  let pickYear = y;
  for (const qm of quarterlies) {
    if (m < qm || (m === qm && d < 8)) { pickMonth = qm; break; }
  }
  if (pickMonth == null) {
    // Past Dec roll → use March of next year
    pickMonth = 3;
    pickYear = y + 1;
  }
  return { month: pickMonth, year: pickYear };
}

// Even-months cycle for GC / SI / HG (gold/silver/copper):
// Trades G(2), J(4), M(6), Q(8), V(10), Z(12). Roll ~end of contract month.
function nextEvenMonthContract(now) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1;
  const d = now.getUTCDate();
  const evens = [2, 4, 6, 8, 10, 12];
  let pickMonth = null;
  let pickYear = y;
  for (const em of evens) {
    // Roll on the 25th (close enough to actual delivery first-notice day)
    if (m < em || (m === em && d < 25)) { pickMonth = em; break; }
  }
  if (pickMonth == null) {
    pickMonth = 2;
    pickYear = y + 1;
  }
  return { month: pickMonth, year: pickYear };
}

// Monthly cycle (CL, NG): energy futures roll a full month BEFORE expiry.
// CL May expires ~April 22 → during May the front month is already June.
// So during month M (current calendar month), the active contract is
// M+1 (most of the month) or M+2 (after the ~20th, when the next roll
// is imminent). E.g., May 11 → CLM6 (June), May 25 → CLN6 (July).
function nextMonthlyContract(now) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1; // 1-12
  const d = now.getUTCDate();
  let mm = m + (d < 20 ? 1 : 2);
  let yy = y;
  while (mm > 12) { mm -= 12; yy += 1; }
  return { month: mm, year: yy };
}

/**
 * Map a TradingView continuous symbol to the current Tradovate front-month
 * contract. Returns null if the TV symbol isn't tracked.
 *
 * Examples (approximate, depending on the date):
 *   tradovateSymbolFor("ES1!", new Date("2026-05-11"))  → "ESM6"  (June 2026)
 *   tradovateSymbolFor("CL1!", new Date("2026-05-11"))  → "CLM6"  (June 2026)
 *   tradovateSymbolFor("GC1!", new Date("2026-05-11"))  → "GCM6"  (June 2026)
 */
export function tradovateSymbolFor(tvSym, now = new Date()) {
  const cfg = TV_TO_TRADOVATE_PRODUCT[String(tvSym || "").toUpperCase()];
  if (!cfg) return null;
  let pick;
  if (cfg.cycle === "quarterly")  pick = nextQuarterlyContract(now);
  else if (cfg.cycle === "evenmonths") pick = nextEvenMonthContract(now);
  else                                  pick = nextMonthlyContract(now);
  const monthCode = MONTH_CODES[pick.month];
  // Tradovate uses single-digit year (last digit of YYYY). 2026 → "6".
  const yearDigit = String(pick.year).slice(-1);
  return `${cfg.product}${monthCode}${yearDigit}`;
}

/** All TV futures symbols we map to Tradovate (excludes VX1!, see comment above). */
export function tradovateTrackedTvSymbols() {
  return Object.keys(TV_TO_TRADOVATE_PRODUCT);
}

/** Get the Tradovate product code (root) for a TV symbol. Used for inverse lookup. */
export function tradovateProductFor(tvSym) {
  const cfg = TV_TO_TRADOVATE_PRODUCT[String(tvSym || "").toUpperCase()];
  return cfg?.product || null;
}

/** Inverse: a current Tradovate contract symbol back to its TV continuous form. */
export function tvSymbolForTradovate(tdSym, now = new Date()) {
  if (!tdSym) return null;
  const upper = String(tdSym).toUpperCase();
  // Try matching any tracked TV symbol's current front-month
  for (const tv of Object.keys(TV_TO_TRADOVATE_PRODUCT)) {
    if (tradovateSymbolFor(tv, now) === upper) return tv;
  }
  return null;
}

// ── Auth ──────────────────────────────────────────────────────────────────────

function isLiveEnv(env) {
  // Default to live. Switch to demo by setting TRADOVATE_ENV=demo (gives
  // 15-min delayed data — useful for dev / pre-prod).
  return String(env?.TRADOVATE_ENV || "live").toLowerCase() !== "demo";
}

function authUrl(env)  { return isLiveEnv(env) ? TD_AUTH_URL_LIVE : TD_AUTH_URL_DEMO; }
function renewUrl(env) { return isLiveEnv(env) ? TD_RENEW_URL_LIVE : TD_RENEW_URL_DEMO; }
export function tradovateWsUrl(env) {
  return isLiveEnv(env) ? TRADOVATE_WS_URL_LIVE : TRADOVATE_WS_URL_DEMO;
}

/**
 * Fetch a fresh access token from /auth/accesstokenrequest. Does NOT touch the
 * cache; callers should prefer tradovateGetAccessToken() which goes through KV.
 *
 * Returns the full response: { accessToken, mdAccessToken, expirationTime, ... }
 * or throws on failure.
 */
async function tradovateAuthRequest(env) {
  const body = {
    name:        env?.TRADOVATE_USERNAME,
    password:    env?.TRADOVATE_PASSWORD,
    appId:       env?.TRADOVATE_APP_ID,
    appVersion:  env?.TRADOVATE_APP_VERSION || "1.0",
    deviceId:    env?.TRADOVATE_DEVICE_ID || "timed-trading-cf-worker",
    cid:         Number(env?.TRADOVATE_CID || 0),
    sec:         env?.TRADOVATE_SEC,
  };
  if (!body.name || !body.password || !body.appId || !body.sec) {
    throw new Error("tradovate_credentials_missing");
  }
  const res = await fetch(authUrl(env), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`tradovate_auth_http_${res.status}: ${txt.slice(0, 200)}`);
  }
  const json = await res.json();
  if (json?.errorText) {
    throw new Error(`tradovate_auth_error: ${json.errorText}`);
  }
  if (!json?.mdAccessToken) {
    throw new Error("tradovate_auth_no_md_token");
  }
  return json;
}

/**
 * Renew an existing access token via /auth/renewaccesstoken. Returns the
 * refreshed response. Throws on failure (caller can fall back to a full
 * accesstokenrequest).
 */
async function tradovateRenewToken(env, accessToken) {
  const res = await fetch(renewUrl(env), {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`tradovate_renew_http_${res.status}: ${txt.slice(0, 200)}`);
  }
  const json = await res.json();
  if (json?.errorText) throw new Error(`tradovate_renew_error: ${json.errorText}`);
  if (!json?.mdAccessToken) throw new Error("tradovate_renew_no_md_token");
  return json;
}

/**
 * Get a valid market-data access token. Uses KV cache; refreshes 5 min before
 * expiry. Falls through to full auth if renewal fails.
 *
 * Returns the mdAccessToken string (the one used for the WebSocket auth frame),
 * or throws if credentials are missing / both renewal and fresh auth fail.
 */
export async function tradovateGetMdAccessToken(env) {
  const KV = env?.KV_TIMED;
  if (!KV) throw new Error("tradovate_no_kv");

  const REFRESH_BUFFER_MS = 5 * 60 * 1000;
  const cached = await KV.get(KV_TOKEN_KEY, { type: "json" }).catch(() => null);

  if (cached && cached.mdAccessToken && cached.expirationMs) {
    const remainingMs = cached.expirationMs - Date.now();
    if (remainingMs > REFRESH_BUFFER_MS) {
      return cached.mdAccessToken; // still valid with > 5 min headroom
    }
    // Try renewal first (cheaper than full auth)
    if (remainingMs > 0 && cached.accessToken) {
      try {
        const renewed = await tradovateRenewToken(env, cached.accessToken);
        await _persistToken(env, renewed);
        return renewed.mdAccessToken;
      } catch (e) {
        console.warn("[Tradovate] renew failed, falling back to full auth:", String(e).slice(0, 120));
      }
    }
  }

  // No cache, expired, or renewal failed — full auth request
  const fresh = await tradovateAuthRequest(env);
  await _persistToken(env, fresh);
  return fresh.mdAccessToken;
}

async function _persistToken(env, tokenResponse) {
  const KV = env?.KV_TIMED;
  if (!KV) return;
  const expirationMs = new Date(tokenResponse.expirationTime).getTime();
  // Cache TTL: until 5 min before expiry. Min 60s (so we don't write a
  // dead-on-arrival token), max 90 min.
  const ttlSec = Math.max(60, Math.min(90 * 60,
    Math.floor((expirationMs - Date.now() - 5 * 60 * 1000) / 1000)));
  await KV.put(KV_TOKEN_KEY, JSON.stringify({
    mdAccessToken: tokenResponse.mdAccessToken,
    accessToken:   tokenResponse.accessToken,
    expirationMs,
    userId:        tokenResponse.userId,
    name:          tokenResponse.name,
    hasLive:       !!tokenResponse.hasLive,
    hasMarketData: !!tokenResponse.hasMarketData,
    fetchedAt:     Date.now(),
  }), { expirationTtl: ttlSec });
}

/**
 * Status / health-check helper — returns what we know about the cached token
 * + a health flag, without doing any network calls. Useful for /status
 * responses.
 */
export async function tradovateTokenStatus(env) {
  const KV = env?.KV_TIMED;
  if (!KV) return { ok: false, error: "no_kv" };
  const cached = await KV.get(KV_TOKEN_KEY, { type: "json" }).catch(() => null);
  if (!cached) return { ok: true, cached: false };
  const remainingMs = (cached.expirationMs || 0) - Date.now();
  return {
    ok: true,
    cached: true,
    name: cached.name || null,
    userId: cached.userId || null,
    hasLive: !!cached.hasLive,
    hasMarketData: !!cached.hasMarketData,
    expiresInMs: remainingMs,
    expiresInMin: Math.round(remainingMs / 60000),
    fetchedAt: cached.fetchedAt || 0,
    env: isLiveEnv(env) ? "live" : "demo",
  };
}

/**
 * P0.7.132 diag — bypass cache and call /auth/accesstokenrequest directly,
 * returning whatever Tradovate says. Surfaces auth failures (wrong creds,
 * wrong app id, account not entitled, etc.) so we can debug without
 * wrangler tail. Also reports which env (live/demo) was used.
 *
 * Returns either:
 *   { ok: true, env, response: { mdAccessToken, expirationTime, hasLive, ... } }
 *   { ok: false, env, error, status?, body? }
 */
export async function tradovateAuthDebug(env) {
  const which = isLiveEnv(env) ? "live" : "demo";
  // Surface which credentials are actually present (not values, just presence)
  const credPresence = {
    TRADOVATE_USERNAME:    !!env?.TRADOVATE_USERNAME,
    TRADOVATE_PASSWORD:    !!env?.TRADOVATE_PASSWORD,
    TRADOVATE_APP_ID:      !!env?.TRADOVATE_APP_ID,
    TRADOVATE_APP_VERSION: !!env?.TRADOVATE_APP_VERSION,
    TRADOVATE_DEVICE_ID:   !!env?.TRADOVATE_DEVICE_ID,
    TRADOVATE_CID:         env?.TRADOVATE_CID != null && env.TRADOVATE_CID !== "",
    TRADOVATE_SEC:         !!env?.TRADOVATE_SEC,
  };
  const missing = Object.entries(credPresence).filter(([_, v]) => !v).map(([k]) => k);
  if (missing.length > 0) {
    return {
      ok: false,
      env: which,
      error: "missing_credentials",
      missing,
      credPresence,
    };
  }
  const body = {
    name:        env.TRADOVATE_USERNAME,
    password:    env.TRADOVATE_PASSWORD,
    appId:       env.TRADOVATE_APP_ID,
    appVersion:  env.TRADOVATE_APP_VERSION || "1.0",
    deviceId:    env.TRADOVATE_DEVICE_ID || "timed-trading-cf-worker",
    cid:         Number(env.TRADOVATE_CID),
    sec:         env.TRADOVATE_SEC,
  };
  const url = authUrl(env);
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { ok: false, env: which, url, error: "fetch_failed", message: String(e).slice(0, 200) };
  }
  const txt = await res.text().catch(() => "");
  let parsed = null;
  try { parsed = JSON.parse(txt); } catch {}
  if (!res.ok) {
    return {
      ok: false, env: which, url,
      error: "http_error", status: res.status,
      body: parsed || txt.slice(0, 500),
    };
  }
  // Success-shape check
  if (parsed?.errorText) {
    return { ok: false, env: which, url, error: "tradovate_error", errorText: parsed.errorText };
  }
  if (!parsed?.mdAccessToken) {
    return {
      ok: false, env: which, url,
      error: "no_md_token",
      response: {
        ...parsed,
        accessToken: parsed?.accessToken ? "<present>" : null,
        mdAccessToken: parsed?.mdAccessToken ? "<present>" : null,
      },
    };
  }
  // SUCCESS — cache the token (so the WS path can reuse it)
  await _persistToken(env, parsed);
  return {
    ok: true, env: which, url,
    response: {
      userId: parsed.userId,
      name: parsed.name,
      hasLive: parsed.hasLive,
      hasMarketData: parsed.hasMarketData,
      expirationTime: parsed.expirationTime,
      mdAccessToken: "<present>",
      accessToken: "<present>",
    },
  };
}
