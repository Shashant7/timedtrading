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
// GET  /timed/health
// GET  /timed/version
// POST /timed/purge?key=... (manual purge)
// POST /timed/clear-rate-limit?key=...&ip=...&endpoint=... (clear rate limit)
// GET  /timed/trades?version=2.1.0 (get trades, optional version filter)
// POST /timed/trades?key=... (create/update trade)
// DELETE /timed/trades/:id?key=... (delete trade)
// GET  /timed/alert-debug?ticker=XYZ (debug why alerts aren't firing)

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

function corsHeaders(env, req) {
  // Get allowed origins from environment variable (comma-separated)
  const corsConfig = env.CORS_ALLOW_ORIGIN || "";
  const allowedOrigins = corsConfig
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  const origin = req?.headers?.get("Origin") || "";

  // Debug logging (will appear in Cloudflare Worker logs)
  console.log("CORS check:", {
    hasConfig: !!corsConfig,
    configLength: corsConfig.length,
    configValue: corsConfig.substring(0, 50), // First 50 chars for safety
    allowedOriginsCount: allowedOrigins.length,
    allowedOrigins: allowedOrigins,
    requestedOrigin: origin,
    originLength: origin.length,
  });

  // If no allowed origins configured, default to "*" (backward compatible)
  // Otherwise, only allow configured origins
  let allowed;
  if (allowedOrigins.length === 0) {
    allowed = "*";
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
        (o) => o.toLowerCase() === origin.toLowerCase()
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

const normTicker = (t) =>
  String(t || "")
    .trim()
    .toUpperCase();
const isNum = (x) => Number.isFinite(Number(x));

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
  window = 3600
) {
  const key = `ratelimit:${identifier}:${endpoint}`;
  const count = await KV.get(key);
  const current = count ? Number(count) : 0;

  if (current >= limit) {
    return {
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + window * 1000,
    };
  }

  await KV.put(key, String(current + 1), { expirationTtl: window });
  return {
    allowed: true,
    remaining: limit - current - 1,
    resetAt: Date.now() + window * 1000,
  };
}

async function ensureTickerIndex(KV, ticker) {
  const key = "timed:tickers";
  const cur = (await kvGetJSON(KV, key)) || [];
  if (!cur.includes(ticker)) {
    cur.push(ticker);
    cur.sort();
    await kvPutJSON(KV, key, cur);
    console.log(
      `[TICKER INDEX] Added ${ticker} to index. New count: ${cur.length}`
    );
  }
}

function marketType(ticker) {
  const t = String(ticker || "").toUpperCase();
  if (t.endsWith("USDT") || t.endsWith("USD")) return "CRYPTO_24_7";
  if (t.endsWith("1!")) return "FUTURES_24_5";
  if (["DXY", "US500", "USOIL", "GOLD", "SILVER"].includes(t)) return "MACRO";
  return "EQUITY_RTH";
}

function minutesSince(ts) {
  if (!ts || typeof ts !== "number") return null;
  return (Date.now() - ts) / 60000;
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
  // Use current price (real-time) for RR calculation, not trigger price
  // d.price should be the current market price from TradingView
  const price = Number(d.price);
  const sl = Number(d.sl);
  if (!Number.isFinite(price) || !Number.isFinite(sl)) return null;

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
        return typeof tpItem === "number" ? tpItem : Number(tpItem);
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
    // For LONG: SL should be below price, TP should be above price
    risk = price - sl; // Risk is distance from current price to SL (down)
    gain = tp - price; // Gain is distance from current price to TP (up)
  } else if (isShort) {
    // For SHORT: SL should be above price, TP should be below price
    risk = sl - price; // Risk is distance from current price to SL (up)
    gain = price - tp; // Gain is distance from current price to TP (down)
  } else {
    // Fallback to absolute values if direction unclear
    risk = Math.abs(price - sl);
    gain = Math.abs(tp - price);
  }

  // Ensure both risk and gain are positive
  if (risk <= 0 || gain <= 0) return null;
  return gain / risk;
}

// ── Corridor helpers (must match UI corridors)
function inLongCorridor(d) {
  const h = Number(d.htf_score),
    l = Number(d.ltf_score);
  return (
    Number.isFinite(h) && Number.isFinite(l) && h > 0 && l >= -8 && l <= 12
  );
}
function inShortCorridor(d) {
  const h = Number(d.htf_score),
    l = Number(d.ltf_score);
  return (
    Number.isFinite(h) && Number.isFinite(l) && h < 0 && l >= -12 && l <= 8
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
        24 * 60 * 60
      );
    }
  }

  // 3. Average Daily Range > 2% (cached for 1 hour, calculated from recent data)
  // Note: We'd need historical daily data. For now, use current bar's range as proxy
  // In production, you'd fetch last 50 days of daily data
  const adrKey = `timed:momentum:adr:${ticker}`;
  let adrOver2Pct = false;
  const adrCache = await kvGetJSON(KV, adrKey);
  if (adrCache && now - adrCache.timestamp < 60 * 60 * 1000) {
    adrOver2Pct = adrCache.value;
  } else {
    // Calculate ADR from current data (simplified - in production, use 50-day average)
    // For now, we'll use a placeholder that checks if we have high/low data
    // TODO: Implement proper 50-day ADR calculation with historical data
    const high = Number(payload.high) || price;
    const low = Number(payload.low) || price;
    const adr = calculateADR(price, high, low);
    adrOver2Pct = adr !== null && adr >= 0.02;
    await kvPutJSON(
      KV,
      adrKey,
      { value: adrOver2Pct, timestamp: now },
      60 * 60
    );
  }

  // 4. Average Volume (50 days) > 2M (cached for 1 hour)
  const volumeKey = `timed:momentum:volume:${ticker}`;
  let volumeOver2M = false;
  const volumeCache = await kvGetJSON(KV, volumeKey);
  if (volumeCache && now - volumeCache.timestamp < 60 * 60 * 1000) {
    volumeOver2M = volumeCache.value;
  } else {
    // Use current volume as proxy (in production, calculate 50-day average)
    const volume = Number(payload.volume) || 0;
    volumeOver2M = volume >= 2000000;
    await kvPutJSON(
      KV,
      volumeKey,
      { value: volumeOver2M, timestamp: now },
      60 * 60
    );
  }

  // All base criteria
  const allBaseCriteria =
    priceOver4 && marketCapOver1B && adrOver2Pct && volumeOver2M;

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

    if (
      weekPct != null ||
      monthPct != null ||
      threeMonthsPct != null ||
      sixMonthsPct != null
    ) {
      // Use TradingView data (percentages are already in % form, e.g., 10.5 means 10.5%)
      const weekOver10Pct = weekPct != null && weekPct >= 10.0;
      const monthOver25Pct = monthPct != null && monthPct >= 25.0;
      const threeMonthOver50Pct =
        threeMonthsPct != null && threeMonthsPct >= 50.0;
      const sixMonthOver100Pct = sixMonthsPct != null && sixMonthsPct >= 100.0;

      anyMomentumCriteria =
        weekOver10Pct ||
        monthOver25Pct ||
        threeMonthOver50Pct ||
        sixMonthOver100Pct;
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
        const weekOver10Pct =
          priceWeekAgo && priceWeekAgo > 0
            ? (currentPrice - priceWeekAgo) / priceWeekAgo >= 0.1
            : false;

        const monthOver25Pct =
          priceMonthAgo && priceMonthAgo > 0
            ? (currentPrice - priceMonthAgo) / priceMonthAgo >= 0.25
            : false;

        const threeMonthOver50Pct =
          price3MonthsAgo && price3MonthsAgo > 0
            ? (currentPrice - price3MonthsAgo) / price3MonthsAgo >= 0.5
            : false;

        const sixMonthOver100Pct =
          price6MonthsAgo && price6MonthsAgo > 0
            ? (currentPrice - price6MonthsAgo) / price6MonthsAgo >= 1.0
            : false;

        anyMomentumCriteria =
          weekOver10Pct ||
          monthOver25Pct ||
          threeMonthOver50Pct ||
          sixMonthOver100Pct;
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
      15 * 60
    );
  }

  const momentumElite = allBaseCriteria && anyMomentumCriteria;

  // Store result with metadata
  const result = {
    momentum_elite: momentumElite,
    criteria: {
      priceOver4,
      marketCapOver1B,
      adrOver2Pct,
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

  // Cache result
  await kvPutJSON(KV, cacheKey, result, 5 * 60);

  return result;
}

function computeRank(d) {
  const htf = Number(d.htf_score);
  const ltf = Number(d.ltf_score);
  const comp = Number(d.completion);
  const phase = Number(d.phase_pct);
  const rr = d.rr != null ? Number(d.rr) : computeRR(d);

  const flags = d.flags || {};
  const sqRel = !!flags.sq30_release;
  const sqOn = !!flags.sq30_on;
  const phaseZoneChange = !!flags.phase_zone_change;
  const momentumElite = !!flags.momentum_elite;

  const state = String(d.state || "");
  const aligned =
    state === "HTF_BULL_LTF_BULL" || state === "HTF_BEAR_LTF_BEAR";
  const setup =
    state === "HTF_BULL_LTF_PULLBACK" || state === "HTF_BEAR_LTF_PULLBACK";

  let score = 50;

  if (aligned) score += 15;
  if (setup) score += 5;

  if (Number.isFinite(htf)) score += Math.min(10, Math.abs(htf) * 0.4);
  if (Number.isFinite(ltf)) score += Math.min(10, Math.abs(ltf) * 0.3);

  if (Number.isFinite(comp)) score += (1 - Math.min(1, comp)) * 20;

  if (Number.isFinite(phase)) score -= Math.max(0, phase - 0.6) * 25;

  if (sqRel) score += 15;
  else if (sqOn) score += 6;

  // Bonus for phase zone change (regime shift)
  if (phaseZoneChange) score += 3;

  if (Number.isFinite(rr)) score += Math.min(10, rr * 2);

  // Momentum Elite boost (significant boost for high-quality momentum stocks)
  if (momentumElite) score += 20;

  score = Math.max(0, Math.min(100, score));
  return Math.round(score);
}

async function appendTrail(KV, ticker, point, maxN = 8) {
  const key = `timed:trail:${ticker}`;
  const cur = (await kvGetJSON(KV, key)) || [];
  cur.push(point);
  const keep = cur.length > maxN ? cur.slice(cur.length - maxN) : cur;
  await kvPutJSON(KV, key, keep);
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
  incomingVersion
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
    `Version change detected: ${storedVersion} -> ${incomingVersion}`
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

async function notifyDiscord(env, title, lines = []) {
  if ((env.DISCORD_ENABLE || "false") !== "true") {
    console.log(
      `[DISCORD] Notifications disabled (DISCORD_ENABLE=${env.DISCORD_ENABLE})`
    );
    return;
  }
  const url = env.DISCORD_WEBHOOK_URL;
  if (!url) {
    console.log(`[DISCORD] Webhook URL not configured`);
    return;
  }
  const content = `**${title}**\n` + lines.map((x) => `• ${x}`).join("\n");
  console.log(`[DISCORD] Sending notification: ${title}`);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    if (!response.ok) {
      console.error(
        `[DISCORD] Failed to send notification: ${response.status} ${response.statusText}`
      );
    } else {
      console.log(`[DISCORD] Notification sent successfully`);
    }
  } catch (error) {
    console.error(`[DISCORD] Error sending notification:`, {
      error: String(error),
      message: error.message,
    });
  }
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
    corsHeaders(env, req)
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

export default {
  async fetch(req, env) {
    const KV = env.KV_TIMED;
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return new Response("", { status: 204, headers: corsHeaders(env, req) });
    }

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
          }`
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
              err || "unknown"
            )}, Raw sample: ${String(raw || "").slice(0, 200)}`
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
            req
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
            }
          );
          return ackJSON(env, v, 400, req);
        }

        const ticker = v.ticker;
        const payload = v.payload;

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
            `Version change detected: ${storedVersion} -> ${incomingVersion}, starting background migration`
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
            incomingVersion
          );
          migrationPromise
            .then((result) => {
              if (result.migrated) {
                console.log(
                  `Background migration completed: ${result.oldVersion} -> ${
                    result.newVersion
                  }, purged ${result.tickerCount || 0} tickers`
                );
                // Optionally notify Discord about migration
                notifyDiscord(env, `🔄 Data Model Migration`, [
                  `Version: ${result.oldVersion} → ${result.newVersion}`,
                  `Tickers purged: ${result.tickerCount || 0}`,
                  `Archive created: ${result.archived ? "Yes" : "No"}`,
                  `Migration completed in background`,
                ]).catch(() => {}); // Don't let Discord notification errors break anything
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
        if (alreadyDeduped) {
          console.log(
            `[INGEST DEDUPED] ${ticker} - same data within 60s (hash: ${hash.substring(
              0,
              8
            )})`
          );
          // Still update the ticker data and ensure it's in index (for Force Baseline broadcasts)
          // Recompute RR to ensure it's current (uses latest TP levels)
          payload.rr = payload.rr ?? computeRR(payload);
          if (payload.rr != null && Number(payload.rr) > 25) payload.rr = 25;

          // Add ingestion timestamp even for deduped (track when last seen)
          const now = Date.now();
          payload.ingest_ts = now;
          payload.ingest_time = new Date(now).toISOString();

          await kvPutJSON(KV, `timed:latest:${ticker}`, payload);
          await ensureTickerIndex(KV, ticker);
          console.log(
            `[INGEST DEDUPED BUT STORED] ${ticker} - updated latest data and ensured in index`
          );
          return ackJSON(env, { ok: true, deduped: true, ticker }, 200, req);
        }
        await kvPutText(KV, dedupeKey, "1", 60);
        console.log(
          `[INGEST NOT DEDUPED] ${ticker} - new or changed data (hash: ${hash.substring(
            0,
            8
          )})`
        );

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
        const momentumEliteData = await computeMomentumElite(
          KV,
          ticker,
          payload
        );
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

        payload.rank = computeRank(payload);

        // Detect state transition into aligned (enter Q2/Q3)
        const prevKey = `timed:prevstate:${ticker}`;
        const prevState = await KV.get(prevKey);
        await kvPutText(
          KV,
          prevKey,
          String(payload.state || ""),
          7 * 24 * 60 * 60
        );

        const state = String(payload.state || "");
        const alignedLong = state === "HTF_BULL_LTF_BULL";
        const alignedShort = state === "HTF_BEAR_LTF_BEAR";
        const aligned = alignedLong || alignedShort;
        const enteredAligned = aligned && prevState !== state;

        const trigReason = String(payload.trigger_reason || "");
        const trigOk =
          trigReason === "EMA_CROSS" || trigReason === "SQUEEZE_RELEASE";

        const flags = payload.flags || {};
        const sqRel = !!flags.sq30_release;

        // Corridor-only logic (must match UI)
        const side = corridorSide(payload); // LONG/SHORT/null
        const inCorridor = !!side;

        // corridor must match alignment
        const corridorAlignedOK =
          (side === "LONG" && alignedLong) ||
          (side === "SHORT" && alignedShort);

        // Allow alerts if:
        // 1. In corridor AND aligned AND (entered aligned OR trigger OR squeeze release)
        // 2. OR in corridor AND squeeze release (squeeze release is a strong signal even if not fully aligned)
        const shouldConsiderAlert =
          inCorridor &&
          ((corridorAlignedOK && (enteredAligned || trigOk || sqRel)) ||
            (sqRel && side)); // Squeeze release in corridor is a valid trigger even if not fully aligned

        // Activity feed tracking - detect events
        const prevCorridorKey = `timed:prevcorridor:${ticker}`;
        const prevInCorridor = await KV.get(prevCorridorKey);
        const prevSqueezeKey = `timed:prevsqueeze:${ticker}`;
        const prevSqueezeOn = await KV.get(prevSqueezeKey);
        const prevSqueezeRelKey = `timed:prevsqueezerel:${ticker}`;
        const prevSqueezeRel = await KV.get(prevSqueezeRelKey);
        const prevMomentumEliteKey = `timed:prevmomentumelite:${ticker}`;
        const prevMomentumElite = await KV.get(prevMomentumEliteKey);

        // Track corridor entry
        if (inCorridor && prevInCorridor !== "true") {
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
          await kvPutText(KV, prevCorridorKey, "true", 7 * 24 * 60 * 60);
        } else if (!inCorridor && prevInCorridor === "true") {
          await kvPutText(KV, prevCorridorKey, "false", 7 * 24 * 60 * 60);
        }

        // Track squeeze start
        if (flags.sq30_on && prevSqueezeOn !== "true") {
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
              side || (alignedLong ? "LONG" : alignedShort ? "SHORT" : null),
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

        // Track state change to aligned
        if (enteredAligned) {
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

        // Track Momentum Elite status change
        const currentMomentumElite = !!(
          payload.flags && payload.flags.momentum_elite
        );
        if (currentMomentumElite && prevMomentumElite !== "true") {
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
          await kvPutText(KV, prevMomentumEliteKey, "true", 7 * 24 * 60 * 60);
        } else if (!currentMomentumElite && prevMomentumElite === "true") {
          await kvPutText(KV, prevMomentumEliteKey, "false", 7 * 24 * 60 * 60);
        }

        // Add ingestion timestamp to payload for per-ticker tracking
        const now = Date.now();
        payload.ingest_ts = now; // Timestamp when this data was ingested
        payload.ingest_time = new Date(now).toISOString(); // Human-readable format

        // Store latest (do this BEFORE alert so UI has it)
        await kvPutJSON(KV, `timed:latest:${ticker}`, payload);
        console.log(
          `[INGEST STORED] ${ticker} - latest data saved at ${new Date(
            now
          ).toISOString()}`
        );

        // Trail (light)
        await appendTrail(
          KV,
          ticker,
          {
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
          },
          20
        ); // Increased to 20 points for better history

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
          }`
        );

        // Log all tickers in index if count is low (to debug missing tickers)
        if (currentTickers.length < 130) {
          console.log(
            `[INGEST INDEX DEBUG] Current tickers (${currentTickers.length}):`,
            currentTickers.slice(0, 30).join(", "),
            currentTickers.length > 30
              ? `... (showing first 30 of ${currentTickers.length})`
              : ""
          );
        }

        // Threshold gates (with Momentum Elite adjustments)
        const momentumElite = !!flags.momentum_elite;

        // Momentum Elite gets relaxed thresholds (higher quality stocks)
        const baseMinRR = Number(env.ALERT_MIN_RR || "1.5");
        const baseMaxComp = Number(env.ALERT_MAX_COMPLETION || "0.4");
        const baseMaxPhase = Number(env.ALERT_MAX_PHASE || "0.6");
        const baseMinRank = Number(env.ALERT_MIN_RANK || "70");

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
        const minRank = momentumElite
          ? Math.max(60, baseMinRank - 10)
          : baseMinRank; // Lower rank requirement

        const rrOk = payload.rr != null && Number(payload.rr) >= minRR;
        const compOk =
          payload.completion == null
            ? true
            : Number(payload.completion) <= maxComp;
        const phaseOk =
          payload.phase_pct == null
            ? true
            : Number(payload.phase_pct) <= maxPhase;
        const rankOk = Number(payload.rank || 0) >= minRank;

        // Also consider Momentum Elite as a trigger condition (quality signal)
        // Momentum Elite can trigger even if not fully aligned, as long as in corridor
        const momentumEliteTrigger =
          momentumElite && inCorridor && (corridorAlignedOK || sqRel);

        // Enhanced trigger: original conditions OR Momentum Elite in good setup
        const enhancedTrigger = shouldConsiderAlert || momentumEliteTrigger;

        // Debug logging for alert conditions - log all tickers in corridor
        if (inCorridor) {
          console.log(`[ALERT DEBUG] ${ticker}:`, {
            inCorridor,
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
            rr: payload.rr,
            minRR,
            compOk,
            completion: payload.completion,
            maxComp,
            phaseOk,
            phase: payload.phase_pct,
            maxPhase,
            rankOk,
            rank: payload.rank,
            minRank,
            momentumElite,
            flags: payload.flags,
          });
        }

        // Log alert evaluation summary
        console.log(`[ALERT EVAL] ${ticker}:`, {
          enhancedTrigger,
          rrOk,
          rr: payload.rr,
          compOk,
          completion: payload.completion,
          phaseOk,
          phase: payload.phase_pct,
          rankOk,
          rank: payload.rank,
          allConditionsMet:
            enhancedTrigger && rrOk && compOk && phaseOk && rankOk,
        });

        if (enhancedTrigger && rrOk && compOk && phaseOk && rankOk) {
          // Dedup alert by trigger_ts if present (best), else ts
          const keyTs =
            payload.trigger_ts != null
              ? String(payload.trigger_ts)
              : String(payload.ts);
          const akey = `timed:alerted:${ticker}:${keyTs}`;
          const alreadyAlerted = await KV.get(akey);

          if (!alreadyAlerted) {
            await kvPutText(KV, akey, "1", 24 * 60 * 60);

            console.log(`[DISCORD ALERT] Sending alert for ${ticker}`, {
              akey,
              keyTs,
              side,
              rank: payload.rank,
            });

            const why =
              (side === "LONG"
                ? "Entry corridor Q1→Q2"
                : "Entry corridor Q4→Q3") +
              (momentumElite ? " | 🚀 Momentum Elite" : "") +
              (enteredAligned ? " | Entered aligned" : "") +
              (trigReason
                ? ` | ${trigReason}${
                    payload.trigger_dir ? " (" + payload.trigger_dir + ")" : ""
                  }`
                : "") +
              (sqRel ? " | ⚡ squeeze release" : "");

            const tv = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(
              ticker
            )}`;

            await notifyDiscord(
              env,
              `TimedTrading 🎯 ${ticker} — ${side} (Rank ${payload.rank})`,
              [
                `Why: ${why}`,
                `State: ${payload.state}`,
                `HTF/LTF: ${fmt2(payload.htf_score)} / ${fmt2(
                  payload.ltf_score
                )}`,
                `Trigger: ${fmt2(payload.trigger_price)} | Price: ${fmt2(
                  payload.price
                )}`,
                `SL: ${fmt2(payload.sl)} | TP: ${fmt2(payload.tp)} | ETA: ${
                  payload.eta_days != null
                    ? Number(payload.eta_days).toFixed(1) + "d"
                    : "—"
                }`,
                `RR: ${
                  payload.rr != null ? Number(payload.rr).toFixed(2) : "—"
                } | Rank: ${payload.rank}`,
                `Completion: ${pct01(payload.completion)} | Phase: ${pct01(
                  payload.phase_pct
                )}`,
                `Link: ${tv}`,
              ]
            );
          } else {
            console.log(`[DISCORD ALERT] Skipped ${ticker} - already alerted`, {
              akey,
              keyTs,
            });
          }
        } else if (inCorridor && corridorAlignedOK) {
          // Log why alert didn't fire
          const reasons = [];
          if (!enhancedTrigger) reasons.push("no trigger condition");
          if (!rrOk) reasons.push(`RR ${payload.rr} < ${minRR}`);
          if (!compOk)
            reasons.push(`Completion ${payload.completion} > ${maxComp}`);
          if (!phaseOk)
            reasons.push(`Phase ${payload.phase_pct} > ${maxPhase}`);
          if (!rankOk) reasons.push(`Rank ${payload.rank} < ${minRank}`);
          console.log(`[ALERT SKIPPED] ${ticker}: ${reasons.join(", ")}`);
        }

        // Get final ticker count
        const finalTickers = (await kvGetJSON(KV, "timed:tickers")) || [];
        console.log(
          `[INGEST SUCCESS] ${ticker} - completed successfully. Total tickers: ${finalTickers.length}`
        );
        return ackJSON(
          env,
          { ok: true, ticker, totalTickers: finalTickers.length },
          200,
          req
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
          req
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
        3600
      );

      if (!rateLimit.allowed) {
        return sendJSON(
          { ok: false, error: "rate_limit_exceeded", retryAfter: 3600 },
          429,
          corsHeaders(env, req)
        );
      }

      const ticker = normTicker(url.searchParams.get("ticker"));
      if (!ticker)
        return sendJSON(
          { ok: false, error: "missing ticker" },
          400,
          corsHeaders(env, req)
        );
      const data = await kvGetJSON(KV, `timed:latest:${ticker}`);
      if (data) {
        // Always recompute RR to ensure it uses the latest max TP from tp_levels
        data.rr = computeRR(data);
      }
      return sendJSON({ ok: true, ticker, data }, 200, corsHeaders(env, req));
    }

    // GET /timed/tickers
    if (url.pathname === "/timed/tickers" && req.method === "GET") {
      // Rate limiting
      const ip = req.headers.get("CF-Connecting-IP") || "unknown";
      const rateLimit = await checkRateLimit(
        KV,
        ip,
        "/timed/tickers",
        1000, // Increased for single-user
        3600
      );

      if (!rateLimit.allowed) {
        return sendJSON(
          { ok: false, error: "rate_limit_exceeded", retryAfter: 3600 },
          429,
          corsHeaders(env, req)
        );
      }

      const tickers = (await kvGetJSON(KV, "timed:tickers")) || [];
      return sendJSON(
        { ok: true, tickers, count: tickers.length },
        200,
        corsHeaders(env, req)
      );
    }

    // GET /timed/all
    if (url.pathname === "/timed/all" && req.method === "GET") {
      // Rate limiting
      const ip = req.headers.get("CF-Connecting-IP") || "unknown";
      const rateLimit = await checkRateLimit(KV, ip, "/timed/all", 1000, 3600); // Increased for single-user

      if (!rateLimit.allowed) {
        return sendJSON(
          { ok: false, error: "rate_limit_exceeded", retryAfter: 3600 },
          429,
          corsHeaders(env, req)
        );
      }

      const tickers = (await kvGetJSON(KV, "timed:tickers")) || [];
      const storedVersion =
        (await getStoredVersion(KV)) || CURRENT_DATA_VERSION;

      // Use Promise.all for parallel KV reads instead of sequential
      const dataPromises = tickers.map((t) =>
        kvGetJSON(KV, `timed:latest:${t}`).then((value) => ({
          ticker: t,
          value,
        }))
      );
      const results = await Promise.all(dataPromises);
      const data = {};
      let versionFilteredCount = 0;
      for (const { ticker, value } of results) {
        if (value) {
          // Only return data matching the current version (filter out old version data)
          const tickerVersion = value.script_version || "unknown";
          if (tickerVersion === storedVersion) {
            // Always recompute RR to ensure it uses the latest max TP from tp_levels
            value.rr = computeRR(value);
            data[ticker] = value;
          } else {
            versionFilteredCount++;
          }
        }
      }
      return sendJSON(
        {
          ok: true,
          count: Object.keys(data).length,
          totalIndex: tickers.length,
          versionFiltered: versionFilteredCount,
          dataVersion: storedVersion,
          data,
        },
        200,
        corsHeaders(env, req)
      );
    }

    // GET /timed/trail?ticker=
    if (url.pathname === "/timed/trail" && req.method === "GET") {
      // Rate limiting
      const ip = req.headers.get("CF-Connecting-IP") || "unknown";
      const rateLimit = await checkRateLimit(
        KV,
        ip,
        "/timed/trail",
        1000,
        3600
      ); // Increased for single-user

      if (!rateLimit.allowed) {
        return sendJSON(
          { ok: false, error: "rate_limit_exceeded", retryAfter: 3600 },
          429,
          corsHeaders(env, req)
        );
      }

      const ticker = normTicker(url.searchParams.get("ticker"));
      if (!ticker)
        return sendJSON(
          { ok: false, error: "missing ticker" },
          400,
          corsHeaders(env, req)
        );
      const trail = (await kvGetJSON(KV, `timed:trail:${ticker}`)) || [];
      return sendJSON({ ok: true, ticker, trail }, 200, corsHeaders(env, req));
    }

    // GET /timed/top?bucket=long|short|setup&n=10
    if (url.pathname === "/timed/top" && req.method === "GET") {
      const n = Math.max(
        1,
        Math.min(50, Number(url.searchParams.get("n") || "10"))
      );
      const bucket = String(
        url.searchParams.get("bucket") || "long"
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
        corsHeaders(env, req)
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
        3600
      );

      if (!rateLimit.allowed) {
        return sendJSON(
          { ok: false, error: "rate_limit_exceeded", retryAfter: 3600 },
          429,
          corsHeaders(env, req)
        );
      }

      const ticker = normTicker(url.searchParams.get("ticker"));
      if (!ticker)
        return sendJSON(
          { ok: false, error: "missing ticker" },
          400,
          corsHeaders(env, req)
        );
      const data = await kvGetJSON(KV, `timed:momentum:${ticker}`);
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
        3600
      );

      if (!rateLimit.allowed) {
        return sendJSON(
          { ok: false, error: "rate_limit_exceeded", retryAfter: 3600 },
          429,
          corsHeaders(env, req)
        );
      }

      const ticker = normTicker(url.searchParams.get("ticker"));
      if (!ticker)
        return sendJSON(
          { ok: false, error: "missing ticker" },
          400,
          corsHeaders(env, req)
        );
      const history =
        (await kvGetJSON(KV, `timed:momentum:history:${ticker}`)) || [];
      return sendJSON(
        { ok: true, ticker, history },
        200,
        corsHeaders(env, req)
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
        3600
      );

      if (!rateLimit.allowed) {
        return sendJSON(
          { ok: false, error: "rate_limit_exceeded", retryAfter: 3600 },
          429,
          corsHeaders(env, req)
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
        corsHeaders(env, req)
      );
    }

    // GET /timed/activity
    if (url.pathname === "/timed/activity" && req.method === "GET") {
      // Rate limiting - aligned with 5-minute refresh interval (generous limit)
      const ip = req.headers.get("CF-Connecting-IP") || "unknown";
      const rateLimit = await checkRateLimit(
        KV,
        ip,
        "/timed/activity",
        1000, // Increased for single-user (plenty of headroom)
        3600
      );

      if (!rateLimit.allowed) {
        return sendJSON(
          { ok: false, error: "rate_limit_exceeded", retryAfter: 3600 },
          429,
          corsHeaders(env, req)
        );
      }

      const feed = (await kvGetJSON(KV, "timed:activity:feed")) || [];

      // Also generate events from current ticker states (for historical display)
      const tickers = (await kvGetJSON(KV, "timed:tickers")) || [];
      const now = Date.now();
      const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000;
      const currentEvents = [];

      // Generate events from current state (only if not already in feed)
      for (const ticker of tickers) {
        const latest = await kvGetJSON(KV, `timed:latest:${ticker}`);
        if (!latest) continue;

        const flags = latest.flags || {};
        const side = corridorSide(latest);
        const inCorridor = !!side;
        const state = String(latest.state || "");
        const alignedLong = state === "HTF_BULL_LTF_BULL";
        const alignedShort = state === "HTF_BEAR_LTF_BEAR";

        // Check if we already have recent events for this ticker+type combination
        const hasRecentEventOfType = (type) => {
          return feed.some(
            (e) => e.ticker === ticker && e.type === type && e.ts > oneWeekAgo
          );
        };

        // Generate corridor entry event if in corridor
        if (inCorridor && !hasRecentEventOfType("corridor_entry")) {
          currentEvents.push({
            type: "corridor_entry",
            ticker: ticker,
            side: side,
            price: latest.price,
            state: latest.state,
            rank: latest.rank,
            sl: latest.sl,
            tp: latest.tp,
            tp_levels: latest.tp_levels,
            rr: latest.rr,
            phase_pct: latest.phase_pct,
            completion: latest.completion,
            ts: latest.ts || now,
            id: `current-${ticker}-corridor-${now}`,
          });
        }

        // Generate squeeze start event if squeeze is on
        if (flags.sq30_on && !hasRecentEventOfType("squeeze_start")) {
          currentEvents.push({
            type: "squeeze_start",
            ticker: ticker,
            price: latest.price,
            state: latest.state,
            rank: latest.rank,
            sl: latest.sl,
            tp: latest.tp,
            tp_levels: latest.tp_levels,
            rr: latest.rr,
            phase_pct: latest.phase_pct,
            completion: latest.completion,
            ts: latest.ts || now,
            id: `current-${ticker}-squeeze-${now}`,
          });
        }

        // Generate squeeze release event if squeeze released
        if (flags.sq30_release && !hasRecentEventOfType("squeeze_release")) {
          currentEvents.push({
            type: "squeeze_release",
            ticker: ticker,
            side:
              side || (alignedLong ? "LONG" : alignedShort ? "SHORT" : null),
            price: latest.price,
            state: latest.state,
            rank: latest.rank,
            trigger_dir: latest.trigger_dir,
            sl: latest.sl,
            tp: latest.tp,
            tp_levels: latest.tp_levels,
            rr: latest.rr,
            phase_pct: latest.phase_pct,
            completion: latest.completion,
            ts: latest.ts || now,
            id: `current-${ticker}-squeeze-rel-${now}`,
          });
        }

        // Generate aligned state event
        if (
          (alignedLong || alignedShort) &&
          !hasRecentEventOfType("state_aligned")
        ) {
          currentEvents.push({
            type: "state_aligned",
            ticker: ticker,
            side: alignedLong ? "LONG" : "SHORT",
            price: latest.price,
            state: latest.state,
            rank: latest.rank,
            sl: latest.sl,
            tp: latest.tp,
            tp_levels: latest.tp_levels,
            rr: latest.rr,
            phase_pct: latest.phase_pct,
            completion: latest.completion,
            ts: latest.ts || now,
            id: `current-${ticker}-aligned-${now}`,
          });
        }

        // Generate Momentum Elite event
        if (flags.momentum_elite && !hasRecentEventOfType("momentum_elite")) {
          currentEvents.push({
            type: "momentum_elite",
            ticker: ticker,
            price: latest.price,
            state: latest.state,
            rank: latest.rank,
            sl: latest.sl,
            tp: latest.tp,
            tp_levels: latest.tp_levels,
            rr: latest.rr,
            phase_pct: latest.phase_pct,
            completion: latest.completion,
            ts: latest.ts || now,
            id: `current-${ticker}-momentum-${now}`,
          });
        }
      }

      // Merge feed events with current events, deduplicate by ticker+type
      const allEvents = [...feed, ...currentEvents];
      const seen = new Set();
      const uniqueEvents = allEvents.filter((e) => {
        const key = `${e.ticker}-${e.type}-${Math.floor(
          e.ts / (60 * 60 * 1000)
        )}`; // Group by hour
        if (seen.has(key)) return false;
        seen.add(key);
        return e.ts > oneWeekAgo; // Only keep events from last week
      });

      // Sort by timestamp descending
      uniqueEvents.sort((a, b) => b.ts - a.ts);

      const limit = Math.min(
        100,
        Number(url.searchParams.get("limit") || "100")
      );
      const filtered = uniqueEvents.slice(0, limit);

      return sendJSON(
        {
          ok: true,
          count: filtered.length,
          events: filtered,
        },
        200,
        corsHeaders(env, req)
      );
    }

    // GET /timed/check-ticker?ticker=AAPL
    if (url.pathname === "/timed/check-ticker" && req.method === "GET") {
      const ticker = url.searchParams.get("ticker");
      if (!ticker) {
        return sendJSON(
          { ok: false, error: "ticker parameter required" },
          400,
          corsHeaders(env, req)
        );
      }

      const tickerUpper = ticker.toUpperCase();
      const tickers = (await kvGetJSON(KV, "timed:tickers")) || [];
      const inIndex = tickers.includes(tickerUpper);
      const latest = await kvGetJSON(KV, `timed:latest:${tickerUpper}`);
      const trail = await kvGetJSON(KV, `timed:trail:${tickerUpper}`);

      return sendJSON(
        {
          ok: true,
          ticker: tickerUpper,
          inIndex,
          hasLatest: !!latest,
          hasTrail: !!trail,
          latestData: latest || null,
          trailLength: trail ? trail.length : 0,
        },
        200,
        corsHeaders(env, req)
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
        3600
      ); // Increased for single-user

      if (!rateLimit.allowed) {
        return sendJSON(
          { ok: false, error: "rate_limit_exceeded", retryAfter: 3600 },
          429,
          corsHeaders(env, req)
        );
      }

      const last = Number(await KV.get("timed:last_ingest_ms")) || 0;
      const tickers = (await kvGetJSON(KV, "timed:tickers")) || [];
      const storedVersion = await getStoredVersion(KV);
      return sendJSON(
        {
          ok: true,
          now: Date.now(),
          lastIngestMs: last,
          minutesSinceLast: last ? (Date.now() - last) / 60000 : null,
          tickers: tickers.length,
          dataVersion: storedVersion || "none",
          expectedVersion: CURRENT_DATA_VERSION,
        },
        200,
        corsHeaders(env, req)
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
        corsHeaders(env, req)
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
          corsHeaders(env, req)
        );
      } else if (ip && endpoint) {
        // Clear specific IP + endpoint combination
        const key = `ratelimit:${ip}:${endpoint}`;
        await KV.delete(key);
        cleared++;
        clearedKeys.push(key);
      } else if (ip) {
        // Clear all rate limits for a specific IP (all endpoints)
        for (const ep of allEndpoints) {
          const key = `ratelimit:${ip}:${ep}`;
          await KV.delete(key);
          cleared++;
          clearedKeys.push(key);
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
          corsHeaders(env, req)
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
          corsHeaders(env, req)
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
        corsHeaders(env, req)
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
        corsHeaders(env, req)
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
        corsHeaders(env, req)
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
        3600
      );

      if (!rateLimit.allowed) {
        return sendJSON(
          { ok: false, error: "rate_limit_exceeded", retryAfter: 3600 },
          429,
          corsHeaders(env, req)
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
        corsHeaders(env, req)
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
        3600
      );

      if (!rateLimit.allowed) {
        return sendJSON(
          { ok: false, error: "rate_limit_exceeded", retryAfter: 3600 },
          429,
          corsHeaders(env, req)
        );
      }

      const ticker = normTicker(url.searchParams.get("ticker"));
      if (!ticker) {
        return sendJSON(
          { ok: false, error: "missing ticker" },
          400,
          corsHeaders(env, req)
        );
      }

      const data = await kvGetJSON(KV, `timed:latest:${ticker}`);
      if (!data) {
        return sendJSON(
          { ok: false, error: "no data for ticker", ticker },
          404,
          corsHeaders(env, req)
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
        trigReason === "EMA_CROSS" || trigReason === "SQUEEZE_RELEASE";

      const flags = data.flags || {};
      const sqRel = !!flags.sq30_release;

      const side = corridorSide(data);
      const inCorridor = !!side;
      const corridorAlignedOK =
        (side === "LONG" && alignedLong) || (side === "SHORT" && alignedShort);

      const shouldConsiderAlert =
        inCorridor && corridorAlignedOK && (enteredAligned || trigOk || sqRel);

      // Threshold gates (with Momentum Elite adjustments)
      const momentumElite = !!flags.momentum_elite;

      // Momentum Elite gets relaxed thresholds (higher quality stocks)
      const baseMinRR = Number(env.ALERT_MIN_RR || "1.5");
      const baseMaxComp = Number(env.ALERT_MAX_COMPLETION || "0.4");
      const baseMaxPhase = Number(env.ALERT_MAX_PHASE || "0.6");
      const baseMinRank = Number(env.ALERT_MIN_RANK || "70");

      // Adjust thresholds for Momentum Elite (more lenient for quality stocks)
      const minRR = momentumElite ? Math.max(1.2, baseMinRR * 0.9) : baseMinRR; // Lower RR requirement
      const maxComp = momentumElite
        ? Math.min(0.5, baseMaxComp * 1.25)
        : baseMaxComp; // Allow higher completion
      const maxPhase = momentumElite
        ? Math.min(0.7, baseMaxPhase * 1.17)
        : baseMaxPhase; // Allow higher phase
      const minRank = momentumElite
        ? Math.max(60, baseMinRank - 10)
        : baseMinRank; // Lower rank requirement

      const rrOk = data.rr != null && Number(data.rr) >= minRR;
      const compOk =
        data.completion == null ? true : Number(data.completion) <= maxComp;
      const phaseOk =
        data.phase_pct == null ? true : Number(data.phase_pct) <= maxPhase;
      const rankOk = Number(data.rank || 0) >= minRank;

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
        rankOk &&
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
              value: data.rr,
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
            rankOk: {
              value: data.rank,
              baseRequired: baseMinRank,
              adjustedRequired: minRank,
              ok: rankOk,
            },
          },
          thresholds: {
            base: {
              minRR: baseMinRR,
              maxComp: baseMaxComp,
              maxPhase: baseMaxPhase,
              minRank: baseMinRank,
            },
            adjusted: { minRR, maxComp, maxPhase, minRank },
            momentumEliteAdjustments: momentumElite,
          },
          data: {
            state,
            htf_score: data.htf_score,
            ltf_score: data.ltf_score,
            rank: data.rank,
            rr: data.rr,
            completion: data.completion,
            phase_pct: data.phase_pct,
            trigger_reason: data.trigger_reason,
            flags: data.flags,
          },
        },
        200,
        corsHeaders(env, req)
      );
    }

    // GET /timed/trades?version=2.1.0 (Get all trades, optional version filter)
    if (url.pathname === "/timed/trades" && req.method === "GET") {
      // Rate limiting
      const ip = req.headers.get("CF-Connecting-IP") || "unknown";
      const rateLimit = await checkRateLimit(
        KV,
        ip,
        "/timed/trades",
        1000, // Increased for single-user
        3600
      );

      if (!rateLimit.allowed) {
        return sendJSON(
          { ok: false, error: "rate_limit_exceeded", retryAfter: 3600 },
          429,
          corsHeaders(env, req)
        );
      }
      const versionFilter = url.searchParams.get("version");
      const tradesKey = "timed:trades:all";
      const allTrades = (await kvGetJSON(KV, tradesKey)) || [];

      let filteredTrades = allTrades;
      if (versionFilter && versionFilter !== "all") {
        filteredTrades = allTrades.filter(
          (t) => (t.scriptVersion || "unknown") === versionFilter
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
        },
        200,
        corsHeaders(env, req)
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
          corsHeaders(env, req)
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
        corsHeaders(env, req)
      );
    }

    // DELETE /timed/trades/:id?key=... (Delete trade)
    if (url.pathname.startsWith("/timed/trades/") && req.method === "DELETE") {
      const authFail = requireKeyOr401(req, env);
      if (authFail) return authFail;

      const tradeId = url.pathname.split("/timed/trades/")[1];
      if (!tradeId) {
        return sendJSON(
          { ok: false, error: "missing trade id" },
          400,
          corsHeaders(env, req)
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
        corsHeaders(env, req)
      );
    }

    // POST /timed/ai/chat (AI Chat Assistant)
    if (url.pathname === "/timed/ai/chat" && req.method === "POST") {
      const { obj: body, err } = await readBodyAsJSON(req);
      if (!body || !body.message) {
        return sendJSON(
          { ok: false, error: "missing message" },
          400,
          corsHeaders(env, req)
        );
      }

      try {
        // TODO: Implement AI integration
        // For now, return a placeholder response
        // 
        // Example implementation with OpenAI:
        // const openaiApiKey = env.OPENAI_API_KEY;
        // if (!openaiApiKey) {
        //   return sendJSON(
        //     { ok: false, error: "AI service not configured" },
        //     503,
        //     corsHeaders(env, req)
        //   );
        // }
        //
        // const response = await fetch("https://api.openai.com/v1/chat/completions", {
        //   method: "POST",
        //   headers: {
        //     "Authorization": `Bearer ${openaiApiKey}`,
        //     "Content-Type": "application/json",
        //   },
        //   body: JSON.stringify({
        //     model: "gpt-3.5-turbo",
        //     messages: [
        //       {
        //         role: "system",
        //         content: "You are an expert trading analyst assistant..."
        //       },
        //       ...(body.conversationHistory || []).map(msg => ({
        //         role: msg.role,
        //         content: msg.content
        //       })),
        //       { role: "user", content: body.message }
        //     ],
        //     temperature: 0.7,
        //     max_tokens: 500,
        //   }),
        // });
        //
        // const aiData = await response.json();
        // const aiResponse = aiData.choices[0]?.message?.content || "Sorry, I couldn't process that.";

        // Placeholder response
        const placeholderResponse = `I understand you're asking: "${body.message}"

This is a placeholder response. To enable AI chat:

1. Set OPENAI_API_KEY in Cloudflare Workers secrets:
   wrangler secret put OPENAI_API_KEY

2. Uncomment and configure the AI integration code in worker/index.js

3. The AI will have access to:
   - Ticker data: ${body.tickerData?.length || 0} tickers
   - Activity feed: ${body.activityData?.length || 0} recent events
   - External news and social sentiment (when configured)

Would you like help setting this up?`;

        return sendJSON(
          {
            ok: true,
            response: placeholderResponse,
            sources: [],
            timestamp: Date.now(),
          },
          200,
          corsHeaders(env, req)
        );
      } catch (error) {
        console.error("[AI CHAT ERROR]", error);
        return sendJSON(
          {
            ok: false,
            error: error.message || "AI service error",
          },
          500,
          corsHeaders(env, req)
        );
      }
    }

    return sendJSON(
      { ok: false, error: "not_found" },
      404,
      corsHeaders(env, req)
    );
  },
};
