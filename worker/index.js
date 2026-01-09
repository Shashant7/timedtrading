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
  });

  // If no allowed origins configured, default to "*" (backward compatible)
  // Otherwise, only allow configured origins
  let allowed;
  if (allowedOrigins.length === 0) {
    allowed = "*";
  } else if (origin === "" && allowNoOrigin) {
    // Allow requests without origin (e.g., curl, direct API calls) for debug endpoints
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
          }
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
            `[TICKER INDEX] Added ${ticker} to index. New count: ${cur.length}, Verified: ${wasAdded}`
          );
          success = true;
        } else {
          // Retry if verification failed (possible race condition)
          console.warn(
            `[TICKER INDEX] ${ticker} verification failed, retrying... (retries left: ${
              retries - 1
            })`
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
            }
          );
        }
      } else {
        // Already in index - success
        if (ticker === "BMNR" || ticker === "BABA" || ticker === "ETHT") {
          console.log(
            `[TICKER INDEX DEBUG] ${ticker} already in index (count: ${cur.length})`
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

// ─────────────────────────────────────────────────────────────
// Trade Simulation Functions (Worker-Level)
// ─────────────────────────────────────────────────────────────

const TRADE_SIZE = 1000; // $1000 per trade
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

  // Must have valid entry/exit levels
  if (!tickerData.price || !tickerData.sl || !tickerData.tp) return false;

  const flags = tickerData.flags || {};
  const state = String(tickerData.state || "");
  const alignedLong = state === "HTF_BULL_LTF_BULL";
  const alignedShort = state === "HTF_BEAR_LTF_BEAR";
  const aligned = alignedLong || alignedShort;

  const h = Number(tickerData.htf_score);
  const l = Number(tickerData.ltf_score);
  const inCorridor =
    Number.isFinite(h) &&
    Number.isFinite(l) &&
    ((h > 0 && l >= -8 && l <= 12) || // LONG corridor
      (h < 0 && l >= -12 && l <= 8)); // SHORT corridor

  const side =
    h > 0 && l >= -8 && l <= 12
      ? "LONG"
      : h < 0 && l >= -12 && l <= 8
      ? "SHORT"
      : null;
  const corridorAlignedOK =
    (side === "LONG" && alignedLong) || (side === "SHORT" && alignedShort);

  if (!inCorridor || !corridorAlignedOK) return false;

  // Check for trigger conditions
  const enteredAligned = prevData && prevData.state !== state && aligned;
  const trigReason = String(tickerData.trigger_reason || "");
  const trigOk = trigReason === "EMA_CROSS" || trigReason === "SQUEEZE_RELEASE";
  const sqRelease = !!flags.sq30_release;
  const hasTrigger = !!tickerData.trigger_price && !!tickerData.trigger_ts;

  const shouldConsiderAlert =
    inCorridor &&
    corridorAlignedOK &&
    (enteredAligned || trigOk || sqRelease || hasTrigger);

  const momentumElite = !!flags.momentum_elite;
  const baseMinRR = 1.5;
  const baseMaxComp = 0.4;
  const baseMaxPhase = 0.6;
  const baseMinRank = 70;

  const minRR = momentumElite ? Math.max(1.2, baseMinRR * 0.9) : baseMinRR;
  const maxComp = momentumElite
    ? Math.min(0.5, baseMaxComp * 1.25)
    : baseMaxComp;
  const maxPhase = momentumElite
    ? Math.min(0.7, baseMaxPhase * 1.17)
    : baseMaxPhase;
  const minRank = momentumElite ? Math.max(60, baseMinRank - 10) : baseMinRank;

  const rr = Number(tickerData.rr) || 0;
  const comp = Number(tickerData.completion) || 0;
  const phase = Number(tickerData.phase_pct) || 0;
  const rank = Number(tickerData.rank) || 0;

  const rrOk = rr >= minRR;
  const compOk = comp <= maxComp;
  const phaseOk = phase <= maxPhase;
  const rankOk = rank >= minRank;

  const momentumEliteTrigger = momentumElite && inCorridor && corridorAlignedOK;
  const enhancedTrigger = shouldConsiderAlert || momentumEliteTrigger;

  return enhancedTrigger && rrOk && compOk && phaseOk && rankOk;
}

// Get direction from state
function getTradeDirection(state) {
  const s = String(state || "");
  if (s.includes("BULL")) return "LONG";
  if (s.includes("BEAR")) return "SHORT";
  return null;
}

// Helper: Score TP level for intelligent selection
function scoreTPLevel(tpLevel, entryPrice, direction, allTPs) {
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

  // Distance from entry (sweet spot: 2-5% for swing trades, prefer not too close or too far)
  const distancePct = Math.abs(price - entryPrice) / entryPrice;
  if (distancePct >= 0.02 && distancePct <= 0.05) {
    score += 0.2; // Sweet spot
  } else if (distancePct >= 0.01 && distancePct <= 0.08) {
    score += 0.1; // Acceptable range
  } else if (distancePct < 0.01) {
    score -= 0.2; // Too close - penalize
  } else if (distancePct > 0.15) {
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

// Helper: Get intelligent TP (best single or weighted blend)
function getIntelligentTP(tickerData, entryPrice, direction) {
  const isLong = direction === "LONG";

  // Get TP from tickerData
  let tp = Number(tickerData.tp);

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
  if (Number.isFinite(tp) && tp > 0) {
    tpLevels.push({
      price: tp,
      source: "Primary TP",
      type: "ATR_FIB",
      timeframe: "D",
      confidence: 0.75,
      multiplier: null,
      label: "TP",
    });
  }

  // Filter by direction
  const validTPs = tpLevels.filter((item) => {
    if (isLong) return item.price > entryPrice;
    return item.price < entryPrice;
  });

  if (validTPs.length === 0) {
    // Fallback to original logic
    return getValidTP(tickerData, entryPrice, direction);
  }

  // Score all valid TPs
  const scoredTPs = validTPs.map((tpItem) => ({
    ...tpItem,
    score: scoreTPLevel(tpItem, entryPrice, direction, validTPs),
  }));

  // Sort by score (descending)
  scoredTPs.sort((a, b) => b.score - a.score);

  // Strategy: Use weighted blend of top 3 TPs if they're reasonably close, otherwise use best single
  const topTP = scoredTPs[0];
  const top3TPs = scoredTPs.slice(0, 3);

  // Check if top 3 are clustered (within 2% of each other)
  const priceRange =
    Math.max(...top3TPs.map((t) => t.price)) -
    Math.min(...top3TPs.map((t) => t.price));
  const avgPrice =
    top3TPs.reduce((sum, t) => sum + t.price, 0) / top3TPs.length;
  const clusteringPct = priceRange / avgPrice;

  if (top3TPs.length >= 3 && clusteringPct < 0.02 && top3TPs[0].score > 0.5) {
    // Use weighted blend of top 3 (weighted by score)
    const totalScore = top3TPs.reduce((sum, t) => sum + t.score, 0);
    const blendedPrice =
      top3TPs.reduce((sum, t) => sum + t.price * t.score, 0) / totalScore;

    console.log(
      `[TP INTELLIGENT] ${
        tickerData.ticker || "UNKNOWN"
      } ${direction}: Using blended TP $${blendedPrice.toFixed(
        2
      )} from top 3 (scores: ${top3TPs
        .map((t) => t.score.toFixed(2))
        .join(", ")})`
    );

    return blendedPrice;
  } else {
    // Use best single TP
    console.log(
      `[TP INTELLIGENT] ${
        tickerData.ticker || "UNKNOWN"
      } ${direction}: Using best TP $${topTP.price.toFixed(
        2
      )} (score: ${topTP.score.toFixed(2)}, ${topTP.source}, ${
        topTP.timeframe
      })`
    );

    return topTP.price;
  }
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
          2
        )}. Using highest TP: $${Math.max(...tpPrices).toFixed(2)}`
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
          2
        )}. Using lowest TP: $${Math.min(...tpPrices).toFixed(2)}`
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
        2
      )} (entry: $${entryPrice.toFixed(2)})`
    );
    return tp;
  }

  return null;
}

// Calculate RR at entry price (for trade creation) instead of current price
function calculateRRAtEntry(tickerData, entryPrice) {
  const direction = getTradeDirection(tickerData.state);
  const tp = getIntelligentTP(tickerData, entryPrice, direction);
  const sl = Number(tickerData.sl);

  if (
    !Number.isFinite(entryPrice) ||
    !Number.isFinite(sl) ||
    !Number.isFinite(tp)
  ) {
    return null;
  }

  // Use MAX TP from tp_levels if available (for RR calculation, use max valid TP)
  let maxTP = tp;
  if (
    tickerData.tp_levels &&
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
      // For LONG: use max TP above entry; for SHORT: use min TP below entry
      if (direction === "LONG") {
        const validTPs = tpPrices.filter((p) => p > entryPrice);
        maxTP = validTPs.length > 0 ? Math.max(...validTPs) : tp;
      } else if (direction === "SHORT") {
        const validTPs = tpPrices.filter((p) => p < entryPrice);
        maxTP = validTPs.length > 0 ? Math.min(...validTPs) : tp;
      } else {
        maxTP = Math.max(...tpPrices);
      }
    }
  }

  const state = String(tickerData.state || "");
  const isLong = state.includes("BULL");
  const isShort = state.includes("BEAR");

  let risk, gain;

  if (isLong) {
    risk = entryPrice - sl; // Risk from entry to SL
    gain = maxTP - entryPrice; // Gain from entry to TP
  } else if (isShort) {
    risk = sl - entryPrice; // Risk from entry to SL
    gain = entryPrice - maxTP; // Gain from entry to TP
  } else {
    risk = Math.abs(entryPrice - sl);
    gain = Math.abs(maxTP - entryPrice);
  }

  if (risk <= 0 || gain <= 0) return null;
  return gain / risk;
}

// Calculate trade P&L and status
function calculateTradePnl(tickerData, entryPrice, existingTrade = null) {
  const direction = getTradeDirection(tickerData.state);
  if (!direction) return null;

  const sl = Number(tickerData.sl);
  // Use validated TP from existing trade if available, otherwise get intelligent TP
  const tp =
    existingTrade && existingTrade.tp
      ? Number(existingTrade.tp)
      : getIntelligentTP(tickerData, entryPrice, direction);
  const currentPrice = Number(tickerData.price);

  if (
    !Number.isFinite(sl) ||
    !Number.isFinite(tp) ||
    !Number.isFinite(currentPrice)
  ) {
    return null;
  }

  const shares = TRADE_SIZE / entryPrice; // Allow fractional shares for high-priced tickers
  let pnl = 0;
  let pnlPct = 0;
  let status = "OPEN";
  const trimmedPct = existingTrade ? existingTrade.trimmedPct || 0 : 0;

  if (direction === "LONG") {
    const hitTP = currentPrice >= tp;
    const hitSL = currentPrice <= sl;

    if (hitTP) {
      if (trimmedPct === 0) {
        // First TP hit - trim 50%
        const trimPnl = (tp - entryPrice) * shares * 0.5;
        const trimPnlPct = ((tp - entryPrice) / entryPrice) * 100;
        return {
          shares,
          pnl: trimPnl,
          pnlPct: trimPnlPct,
          status: "TP_HIT_TRIM",
          currentPrice,
          trimmedPct: 0.5,
        };
      } else {
        // Already trimmed - full exit at TP
        pnl = (tp - entryPrice) * shares;
        pnlPct = ((tp - entryPrice) / entryPrice) * 100;
        // CRITICAL: Status must be based on actual P&L, not just TP hit
        // If entry price was worse than TP (slippage, bad fill), P&L can be negative
        status = pnl >= 0 ? "WIN" : "LOSS";
      }
    } else if (hitSL) {
      pnl = (sl - entryPrice) * shares;
      pnlPct = ((sl - entryPrice) / entryPrice) * 100;
      // SL hit is always a loss
      status = "LOSS";
    } else {
      pnl = (currentPrice - entryPrice) * shares;
      pnlPct = ((currentPrice - entryPrice) / entryPrice) * 100;
      status = "OPEN";
    }
  } else {
    // SHORT
    const hitTP = currentPrice <= tp;
    const hitSL = currentPrice >= sl;

    if (hitTP) {
      if (trimmedPct === 0) {
        return {
          shares,
          pnl: (entryPrice - tp) * shares * 0.5,
          pnlPct: ((entryPrice - tp) / entryPrice) * 100,
          status: "TP_HIT_TRIM",
          currentPrice,
          trimmedPct: 0.5,
        };
      } else {
        pnl = (entryPrice - tp) * shares;
        pnlPct = ((entryPrice - tp) / entryPrice) * 100;
        status = pnl >= 0 ? "WIN" : "LOSS";
      }
    } else if (hitSL) {
      pnl = (entryPrice - sl) * shares;
      pnlPct = ((entryPrice - sl) / entryPrice) * 100;
      status = "LOSS";
    } else {
      pnl = (entryPrice - currentPrice) * shares;
      pnlPct = ((entryPrice - currentPrice) / entryPrice) * 100;
      status = "OPEN";
    }
  }

  return {
    shares,
    pnl,
    pnlPct,
    status,
    currentPrice,
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
    (t) => t.status === "OPEN" || t.status === "TP_HIT_TRIM"
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
            1
          )}% of TP ($${tp.toFixed(2)}). Current: $${currentPrice.toFixed(
            2
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
            1
          )}% of SL ($${sl.toFixed(2)}). Current: $${currentPrice.toFixed(
            2
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
          0
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
          0
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
      !openTrades.find((ot) => ot.ticker === t.ticker)
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
      !openTrades.find((ot) => ot.ticker === t.ticker)
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
async function processTradeSimulation(
  KV,
  ticker,
  tickerData,
  prevData,
  env = null
) {
  try {
    const tradesKey = "timed:trades:all";
    const allTrades = (await kvGetJSON(KV, tradesKey)) || [];

    // Get direction
    const direction = getTradeDirection(tickerData.state);
    if (!direction) return;

    // Check for existing open trade
    const existingOpenTrade = allTrades.find(
      (t) =>
        t.ticker === ticker &&
        t.direction === direction &&
        (t.status === "OPEN" || !t.status || t.status === "TP_HIT_TRIM")
    );

    if (existingOpenTrade) {
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
            2
          )}, current=$${currentPrice.toFixed(2)}, trigger=${
            triggerPrice ? "$" + triggerPrice.toFixed(2) : "null"
          }, differs=${entryPriceDiffers}, corrected=${entryPriceCorrected}`
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
            `[TRADE SIM] ${ticker} correction check: isOldTrade=${isOldTrade}, isBackfill=${isBackfill}, entryMatchesTrigger=${entryMatchesTrigger}, entryTime=${existingOpenTrade.entryTime}`
          );

          // For old trades: ALWAYS use current price (entry was likely wrong)
          // For trades where entry matches trigger_price: use current price (entry was likely wrong)
          // If entry differs significantly from current price, it's likely wrong
          if (isOldTrade || entryMatchesTrigger || entryPriceDiffers) {
            // For old trades or mismatched prices: ALWAYS use current price, never trigger_price
            correctedEntryPrice = currentPrice;
            console.log(
              `[TRADE SIM] 🔧 Correcting ${ticker} ${direction} entry price: $${currentEntryPrice.toFixed(
                2
              )} -> $${correctedEntryPrice.toFixed(2)} (reason: ${
                isOldTrade
                  ? "old trade"
                  : entryMatchesTrigger
                  ? "matches trigger_price"
                  : "differs from current price"
              }, using current price)`
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
                  2
                )} -> $${correctedEntryPrice.toFixed(
                  2
                )} (backfill, using trigger_price)`
              );
            } else {
              // Price is close - use current price even for backfills
              correctedEntryPrice = currentPrice;
              console.log(
                `[TRADE SIM] 🔧 Correcting ${ticker} ${direction} entry price: $${currentEntryPrice.toFixed(
                  2
                )} -> $${correctedEntryPrice.toFixed(
                  2
                )} (backfill, trigger_price close, using current price)`
              );
            }
          }
        }
      }

      // Recalculate shares if entry price was corrected (to maintain $1000 position size)
      let correctedShares = existingOpenTrade.shares;
      if (
        correctedEntryPrice !== existingOpenTrade.entryPrice &&
        !entryPriceCorrected
      ) {
        correctedShares = TRADE_SIZE / correctedEntryPrice;
        console.log(
          `[TRADE SIM] 🔧 Recalculating ${ticker} ${direction} shares: ${existingOpenTrade.shares?.toFixed(
            4
          )} -> ${correctedShares.toFixed(4)} (due to entry price correction)`
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
      const shouldExitFromTDSeq =
        (direction === "LONG" && tdSeqExitLong) ||
        (direction === "SHORT" && tdSeqExitShort);

      let tradeCalc;
      if (shouldExitFromTDSeq) {
        console.log(
          `[TRADE SIM] 🚨 TD Sequential exit signal for ${ticker} ${direction}: ` +
            `TD9/TD13 ${
              direction === "LONG" ? "bearish" : "bullish"
            } reversal detected`
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
                2
              )}) -> LOSS`
            );
            newStatus = "LOSS";
          } else if (newStatus === "LOSS" && tradeCalc.pnl > 0) {
            console.log(
              `[TRADE SIM] ⚠️ Correcting ${ticker} ${direction}: LOSS with positive P&L (${tradeCalc.pnl.toFixed(
                2
              )}) -> WIN`
            );
            newStatus = "WIN";
          }
        }

        // Update history for status changes
        const history = existingOpenTrade.history || [
          {
            type: "ENTRY",
            timestamp: existingOpenTrade.entryTime,
            price: existingOpenTrade.entryPrice,
            shares: existingOpenTrade.shares || 0,
            value:
              existingOpenTrade.entryPrice * (existingOpenTrade.shares || 0),
            note: `Initial entry at $${existingOpenTrade.entryPrice.toFixed(
              2
            )}`,
          },
        ];

        // Add history entry if entry price was corrected
        if (
          correctedEntryPrice !== existingOpenTrade.entryPrice &&
          !entryPriceCorrected
        ) {
          history.push({
            type: "ENTRY_CORRECTION",
            timestamp: new Date().toISOString(),
            price: correctedEntryPrice,
            shares: correctedShares,
            value: correctedEntryPrice * correctedShares,
            note: `Entry price corrected from $${existingOpenTrade.entryPrice.toFixed(
              2
            )} to $${correctedEntryPrice.toFixed(
              2
            )} (was incorrectly using trigger_price)`,
          });
        }

        const currentPrice = Number(tickerData.price || 0);
        const oldStatus = existingOpenTrade.status || "OPEN";

        // Add history entry for trim
        if (newStatus === "TP_HIT_TRIM" && oldStatus !== "TP_HIT_TRIM") {
          const trimmedShares = (existingOpenTrade.shares || 0) * 0.5; // Allow fractional shares
          history.push({
            type: "TRIM",
            timestamp: new Date().toISOString(),
            price: Number(tickerData.tp || existingOpenTrade.tp),
            shares: trimmedShares,
            value:
              Number(tickerData.tp || existingOpenTrade.tp) * trimmedShares,
            note: `Trimmed 50% at TP $${Number(
              tickerData.tp || existingOpenTrade.tp
            ).toFixed(2)}`,
          });
        }

        // Add history entry for close
        if (
          (newStatus === "WIN" || newStatus === "LOSS") &&
          oldStatus !== "WIN" &&
          oldStatus !== "LOSS"
        ) {
          const remainingShares = existingOpenTrade.shares || 0;
          history.push({
            type: "EXIT",
            timestamp: new Date().toISOString(),
            price: currentPrice,
            shares: remainingShares,
            value: currentPrice * remainingShares,
            note: `Closed ${
              newStatus === "WIN" ? "profitably" : "at loss"
            } at $${currentPrice.toFixed(2)}`,
          });
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
          lastUpdate: new Date().toISOString(),
          sl: Number(tickerData.sl) || existingOpenTrade.sl,
          tp: Number(tickerData.tp) || existingOpenTrade.tp,
          rr: Number(tickerData.rr) || existingOpenTrade.rr,
          rank: Number(tickerData.rank) || existingOpenTrade.rank,
          history: history,
        };

        const tradeIndex = allTrades.findIndex(
          (t) => t.id === existingOpenTrade.id
        );
        if (tradeIndex >= 0) {
          allTrades[tradeIndex] = updatedTrade;
          await kvPutJSON(KV, tradesKey, allTrades);
          console.log(
            `[TRADE SIM] Updated trade ${ticker} ${direction}: ${oldStatus} -> ${newStatus}`
          );

          // Send Discord notifications for status changes
          if (env && newStatus !== oldStatus) {
            const currentPrice = Number(
              tickerData.price || updatedTrade.currentPrice || 0
            );
            const pnl = updatedTrade.pnl || 0;
            const pnlPct = updatedTrade.pnlPct || 0;

            if (newStatus === "TP_HIT_TRIM" && oldStatus !== "TP_HIT_TRIM") {
              // Trade trimmed
              const embed = createTradeTrimmedEmbed(
                ticker,
                direction,
                existingOpenTrade.entryPrice,
                currentPrice,
                Number(tickerData.tp || updatedTrade.tp),
                pnl,
                pnlPct
              );
              await notifyDiscord(env, embed).catch(() => {}); // Don't let Discord errors break trade updates
            } else if (
              (newStatus === "WIN" || newStatus === "LOSS") &&
              oldStatus !== "WIN" &&
              oldStatus !== "LOSS"
            ) {
              // Trade closed
              const embed = createTradeClosedEmbed(
                ticker,
                direction,
                newStatus,
                existingOpenTrade.entryPrice,
                currentPrice,
                pnl,
                pnlPct,
                updatedTrade.rank || existingOpenTrade.rank || 0,
                updatedTrade.rr || existingOpenTrade.rr || 0
              );
              await notifyDiscord(env, embed).catch(() => {}); // Don't let Discord errors break trade updates

              // If this was a TD9 exit, send additional TD9 alert
              if (shouldExitFromTDSeq) {
                const tdSeq = tickerData.td_sequential || {};
                const td9Embed = createTD9ExitEmbed(
                  ticker,
                  direction,
                  existingOpenTrade.entryPrice,
                  currentPrice,
                  pnl,
                  pnlPct,
                  tdSeq
                );
                await notifyDiscord(env, td9Embed).catch(() => {});
              }
            }
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
      if (currentPrice && currentPrice > 0) {
        entryPrice = currentPrice;
        priceSource = "price";

        // For backfills: only consider trigger_price if it's significantly different
        if (isBackfill && triggerPrice && triggerPrice > 0) {
          const priceDiff =
            Math.abs(triggerPrice - currentPrice) / currentPrice;
          if (priceDiff > 0.01) {
            // More than 1% difference - use trigger_price for backfill
            entryPrice = triggerPrice;
            priceSource = "trigger_price (backfill)";
            console.log(
              `[TRADE SIM] Using trigger_price $${triggerPrice.toFixed(
                2
              )} for backfill (current: $${currentPrice.toFixed(2)})`
            );
          } else {
            // Price is close - use current price even for backfills (more accurate)
            console.log(
              `[TRADE SIM] Using current price $${currentPrice.toFixed(
                2
              )} (trigger_price $${triggerPrice.toFixed(
                2
              )} is close, not using for backfill)`
            );
          }
        } else {
          // Real-time alert: ALWAYS use current market price
          console.log(
            `[TRADE SIM] Real-time alert: using current price $${entryPrice.toFixed(
              2
            )} (not trigger_price)`
          );
        }
      } else if (triggerPrice && triggerPrice > 0) {
        // Fallback: only use trigger_price if price is not available
        entryPrice = triggerPrice;
        priceSource = "trigger_price (fallback)";
        console.log(
          `[TRADE SIM] ⚠️ Using trigger_price $${triggerPrice.toFixed(
            2
          )} as fallback (price not available)`
        );
      } else {
        // No valid price available - cannot create trade
        console.log(
          `[TRADE SIM] ⚠️ Cannot create trade for ${ticker}: no valid price or trigger_price`
        );
        return; // Exit early if no valid price
      }

      console.log(
        `[TRADE SIM] ${ticker} entry price: $${entryPrice.toFixed(
          2
        )} (from ${priceSource}${
          isBackfill ? ", BACKFILL" : ""
        }), current price: $${Number(tickerData.price || 0).toFixed(
          2
        )}, trigger_price: ${
          tickerData.trigger_price
            ? "$" + Number(tickerData.trigger_price).toFixed(2)
            : "null"
        }`
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
        prevData
      );
      console.log(
        `[TRADE SIM] ${ticker} ${direction}: shouldTrigger=${shouldTrigger}, entryRR=${
          entryRR?.toFixed(2) || "null"
        }, currentRR=${tickerData.rr?.toFixed(2) || "null"}`
      );

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
            now - new Date(t.entryTime).getTime() < recentCloseWindow
        );

        // Check for existing open trade
        // Allow new position if entry price is significantly different (>5%) - enables scaling in
        const anyOpenTrade = allTrades.find(
          (t) =>
            t.ticker === ticker &&
            t.direction === direction &&
            (t.status === "OPEN" || !t.status || t.status === "TP_HIT_TRIM")
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
                2
              )} vs ${entryPrice.toFixed(2)}, diff: ${(
                priceDiffPct * 100
              ).toFixed(2)}%)`
            );
          } else {
            // Scaling in - merge into existing trade
            console.log(
              `[TRADE SIM] ℹ️ ${ticker} ${direction}: Scaling in - entry price differs significantly (${existingEntryPrice.toFixed(
                2
              )} vs ${entryPrice.toFixed(2)}, diff: ${(
                priceDiffPct * 100
              ).toFixed(2)}%)`
            );

            // Calculate new average entry price and total shares
            const existingShares = anyOpenTrade.shares || 0;
            const existingValue = existingEntryPrice * existingShares;
            const newShares = TRADE_SIZE / entryPrice; // Allow fractional shares for high-priced tickers
            const newValue = entryPrice * newShares;
            const totalShares = existingShares + newShares;
            const totalValue = existingValue + newValue;
            const avgEntryPrice =
              totalShares > 0 ? totalValue / totalShares : entryPrice;

            // Update existing trade with scaled-in position
            const tradeCalc = calculateTradePnl(
              tickerData,
              avgEntryPrice,
              anyOpenTrade
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
                timestamp: new Date().toISOString(),
                price: entryPrice,
                shares: newShares,
                value: newValue,
                note: `Scaled in at $${entryPrice.toFixed(
                  2
                )} (avg entry now $${avgEntryPrice.toFixed(2)})`,
              });

              const updatedTrade = {
                ...anyOpenTrade,
                entryPrice: avgEntryPrice, // Update to average entry price
                shares: totalShares,
                ...tradeCalc,
                history: history,
                lastUpdate: new Date().toISOString(),
              };

              const tradeIndex = allTrades.findIndex(
                (t) => t.id === anyOpenTrade.id
              );
              if (tradeIndex >= 0) {
                allTrades[tradeIndex] = updatedTrade;
                await kvPutJSON(KV, tradesKey, allTrades);
                console.log(
                  `[TRADE SIM] ✅ Scaled in ${ticker} ${direction} - Avg Entry: $${avgEntryPrice.toFixed(
                    2
                  )}, Total Shares: ${totalShares}`
                );

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
                  await notifyDiscord(env, embed).catch(() => {});
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

        // Additional check: prevent multiple trades for same ticker/direction within 1 hour
        // This catches cases where multiple alerts come in over time but shouldn't create multiple positions
        const oneHourAgo = now - 60 * 60 * 1000; // 1 hour (reduced from 24 hours)
        const recentTrade = allTrades.find(
          (t) =>
            t.ticker === ticker &&
            t.direction === direction &&
            t.entryTime &&
            new Date(t.entryTime).getTime() > oneHourAgo
        );

        // Also check for trades with very similar entry price (within 0.5% to catch duplicates)
        // This prevents duplicate alerts even if timestamps differ slightly
        const priceThreshold = entryPrice * 0.005; // 0.5% of entry price
        const similarPriceTrade = allTrades.find(
          (t) =>
            t.ticker === ticker &&
            t.direction === direction &&
            t.entryPrice &&
            Math.abs(Number(t.entryPrice) - entryPrice) < priceThreshold
        );

        // Log why trade was rejected if applicable
        if (recentlyClosedTrade) {
          console.log(
            `[TRADE SIM] ⚠️ ${ticker} ${direction}: Skipping - recently closed trade (within 5 min)`
          );
        } else if (shouldBlockOpenTrade) {
          console.log(
            `[TRADE SIM] ⚠️ ${ticker} ${direction}: Skipping - open trade already exists with similar entry price`
          );
        } else if (recentTrade) {
          console.log(
            `[TRADE SIM] ⚠️ ${ticker} ${direction}: Skipping - recent trade exists (within 1 hour)`
          );
        } else if (similarPriceTrade) {
          console.log(
            `[TRADE SIM] ⚠️ ${ticker} ${direction}: Skipping - duplicate trade with similar entry price (${Number(
              similarPriceTrade.entryPrice
            ).toFixed(2)} vs ${entryPrice.toFixed(2)})`
          );
        }

        if (
          !recentlyClosedTrade &&
          !shouldBlockOpenTrade &&
          !recentTrade &&
          !similarPriceTrade
        ) {
          const tradeCalc = calculateTradePnl(tickerData, entryPrice);

          if (tradeCalc) {
            console.log(
              `[TRADE SIM] ✅ Creating new trade ${ticker} ${direction} - Entry: $${entryPrice.toFixed(
                2
              )}, RR: ${entryRR?.toFixed(2) || "N/A"}`
            );
            // Determine entry time: use trigger_ts if it's a backfill (already detected above), otherwise use current time
            // Use trigger_ts for entryTime if it's a backfill, otherwise use current time
            const entryTime =
              isBackfill && triggerTimestamp
                ? triggerTimestamp
                : new Date().toISOString();

            // Get intelligent TP based on direction
            const validTP = getIntelligentTP(tickerData, entryPrice, direction);
            if (!validTP) {
              console.error(
                `[TRADE SIM] ❌ ${ticker} ${direction}: Cannot create trade - no valid TP found`
              );
              return; // Exit early if no valid TP
            }

            const trade = {
              id: `${ticker}-${now}-${Math.random().toString(36).substr(2, 9)}`,
              ticker,
              direction,
              entryPrice,
              entryTime: entryTime, // When trade was actually created
              triggerTimestamp: triggerTimestamp, // When signal was generated (for reference)
              sl: Number(tickerData.sl),
              tp: validTP, // Use validated TP
              rr: entryRR || Number(tickerData.rr) || 0, // Use entry RR
              rank: Number(tickerData.rank) || 0,
              state: tickerData.state,
              flags: tickerData.flags || {},
              scriptVersion: tickerData.script_version || "unknown",
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
                          triggerTimestamp
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

            await kvPutJSON(KV, tradesKey, allTrades);
            console.log(
              `[TRADE SIM] ✅ Created new trade ${ticker} ${direction} (Rank ${
                trade.rank
              }, Entry RR ${trade.rr.toFixed(2)})`
            );

            // Send Discord notification for new trade entry
            if (env) {
              const embed = createTradeEntryEmbed(
                ticker,
                direction,
                entryPrice,
                Number(tickerData.sl),
                validTP, // Use validated TP
                entryRR || 0,
                trade.rank || 0,
                tickerData.state || "N/A"
              );
              await notifyDiscord(env, embed).catch(() => {}); // Don't let Discord errors break trade creation
            }
          } else {
            console.log(
              `[TRADE SIM] ⚠️ ${ticker} ${direction}: tradeCalc returned null`
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
        const inCorridor =
          Number.isFinite(h) &&
          Number.isFinite(l) &&
          ((h > 0 && l >= -8 && l <= 12) || (h < 0 && l >= -12 && l <= 8));
        const aligned =
          tickerData.state === "HTF_BULL_LTF_BULL" ||
          tickerData.state === "HTF_BEAR_LTF_BEAR";

        console.log(
          `[TRADE SIM] ❌ ${ticker} ${direction}: Conditions not met`,
          {
            entryRR: entryRR?.toFixed(2),
            currentRR: tickerData.rr?.toFixed(2),
            comp,
            phase,
            rank,
            state: tickerData.state,
            inCorridor,
            aligned,
          }
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

  // ADJUSTED SCORING: More discriminating, lower base
  let score = 30; // Reduced from 50 to make scoring more selective

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
    if (comp <= 0.2) score += 15; // Excellent (0-20% completion)
    else if (comp <= 0.4) score += 10; // Good (20-40% completion)
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
  if (sqRel) score += 12; // Reduced from 15
  else if (sqOn) score += 4; // Reduced from 6

  // Phase zone change bonus (reduced)
  if (phaseZoneChange) score += 2; // Reduced from 3

  // RR contribution (more selective - requires better RR)
  if (Number.isFinite(rr)) {
    if (rr >= 2.0) score += 10; // Excellent RR (2.0+)
    else if (rr >= 1.5) score += 7; // Good RR (1.5-2.0)
    else if (rr >= 1.2) score += 4; // Acceptable RR (1.2-1.5)
    // No bonus for RR < 1.2
  }

  // Momentum Elite boost (reduced but still significant)
  if (momentumElite) score += 15; // Reduced from 20

  // TD Sequential boost/penalty (from Pine Script calculation)
  const tdSeq = d.td_sequential || {};
  const tdSeqBoost = Number(tdSeq.boost) || 0;
  if (Number.isFinite(tdSeqBoost) && tdSeqBoost !== 0) {
    score += tdSeqBoost;
  }

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

// Send Discord notification with embed card styling
async function notifyDiscord(env, embed) {
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

  console.log(`[DISCORD] Sending notification: ${embed.title || "Untitled"}`);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [embed] }),
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

// Helper: Create Discord embed for trade entry
function createTradeEntryEmbed(
  ticker,
  direction,
  entryPrice,
  sl,
  tp,
  rr,
  rank,
  state
) {
  const color = direction === "LONG" ? 0x00ff00 : 0xff0000; // Green for LONG, Red for SHORT
  return {
    title: `🎯 Trade Entered: ${ticker} ${direction}`,
    color: color,
    fields: [
      {
        name: "Entry Price",
        value: `$${entryPrice.toFixed(2)}`,
        inline: true,
      },
      {
        name: "Stop Loss",
        value: `$${sl.toFixed(2)}`,
        inline: true,
      },
      {
        name: "Take Profit",
        value: `$${tp.toFixed(2)}`,
        inline: true,
      },
      {
        name: "Risk/Reward",
        value: `${rr.toFixed(2)}:1`,
        inline: true,
      },
      {
        name: "Rank",
        value: `${rank}`,
        inline: true,
      },
      {
        name: "State",
        value: state || "N/A",
        inline: true,
      },
    ],
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
  pnlPct
) {
  return {
    title: `✂️ Trade Trimmed: ${ticker} ${direction}`,
    color: 0xffaa00, // Orange
    fields: [
      {
        name: "Entry Price",
        value: `$${entryPrice.toFixed(2)}`,
        inline: true,
      },
      {
        name: "Current Price",
        value: `$${currentPrice.toFixed(2)}`,
        inline: true,
      },
      {
        name: "TP Hit",
        value: `$${tp.toFixed(2)}`,
        inline: true,
      },
      {
        name: "Realized P&L",
        value: `$${pnl.toFixed(2)}`,
        inline: true,
      },
      {
        name: "P&L %",
        value: `${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%`,
        inline: true,
      },
      {
        name: "Status",
        value: "50% trimmed, 50% remaining",
        inline: true,
      },
    ],
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
  rr
) {
  const color = status === "WIN" ? 0x00ff00 : 0xff0000; // Green for WIN, Red for LOSS
  const emoji = status === "WIN" ? "✅" : "❌";
  return {
    title: `${emoji} Trade Closed: ${ticker} ${direction} - ${status}`,
    color: color,
    fields: [
      {
        name: "Entry Price",
        value: `$${entryPrice.toFixed(2)}`,
        inline: true,
      },
      {
        name: "Exit Price",
        value: `$${exitPrice.toFixed(2)}`,
        inline: true,
      },
      {
        name: "Final P&L",
        value: `$${pnl.toFixed(2)}`,
        inline: true,
      },
      {
        name: "P&L %",
        value: `${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%`,
        inline: true,
      },
      {
        name: "Rank",
        value: `${rank || "N/A"}`,
        inline: true,
      },
      {
        name: "RR",
        value: `${rr.toFixed(2)}:1`,
        inline: true,
      },
    ],
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
  tdSeq
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

  return {
    title: `🔢 TD Sequential ${signalType} Exit: ${ticker} ${direction}`,
    description: `${signalType} ${signalDirection} reversal detected - Consider ${oppositeDirection} entry`,
    color: 0xffaa00, // Orange
    fields: [
      {
        name: "Exit Reason",
        value: `TD Sequential ${signalType} ${signalDirection} Exhaustion`,
        inline: false,
      },
      {
        name: "Entry Price",
        value: `$${entryPrice.toFixed(2)}`,
        inline: true,
      },
      {
        name: "Exit Price",
        value: `$${exitPrice.toFixed(2)}`,
        inline: true,
      },
      {
        name: "P&L",
        value: `$${pnl.toFixed(2)} (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(
          2
        )}%)`,
        inline: true,
      },
      {
        name: "TD9 Bullish",
        value: td9Bullish ? "✅" : "❌",
        inline: true,
      },
      {
        name: "TD9 Bearish",
        value: td9Bearish ? "✅" : "❌",
        inline: true,
      },
      {
        name: "TD13 Bullish",
        value: td13Bullish ? "✅" : "❌",
        inline: true,
      },
      {
        name: "TD13 Bearish",
        value: td13Bearish ? "✅" : "❌",
        inline: true,
      },
      {
        name: "Potential Entry",
        value: `Consider ${oppositeDirection} setup if conditions align`,
        inline: false,
      },
    ],
    timestamp: new Date().toISOString(),
    footer: {
      text: "TD Sequential Exhaustion Signal",
    },
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
  tdSeq
) {
  const td9Bullish = tdSeq.td9_bullish === true || tdSeq.td9_bullish === "true";
  const td9Bearish = tdSeq.td9_bearish === true || tdSeq.td9_bearish === "true";
  const td13Bullish =
    tdSeq.td13_bullish === true || tdSeq.td13_bullish === "true";
  const td13Bearish =
    tdSeq.td13_bearish === true || tdSeq.td13_bearish === "true";

  const signalType = td13Bullish || td13Bearish ? "TD13" : "TD9";
  const signalDirection = direction === "LONG" ? "Bullish" : "Bearish";

  return {
    title: `🔢 TD Sequential ${signalType} Entry Signal: ${ticker} ${direction}`,
    description: `${signalType} ${signalDirection} setup detected - Potential reversal entry`,
    color: direction === "LONG" ? 0x00ff00 : 0xff0000,
    fields: [
      {
        name: "Signal Type",
        value: `${signalType} ${signalDirection}`,
        inline: false,
      },
      {
        name: "Current Price",
        value: `$${price.toFixed(2)}`,
        inline: true,
      },
      {
        name: "Stop Loss",
        value: `$${sl.toFixed(2)}`,
        inline: true,
      },
      {
        name: "Take Profit",
        value: `$${tp.toFixed(2)}`,
        inline: true,
      },
      {
        name: "Risk/Reward",
        value: `${rr.toFixed(2)}:1`,
        inline: true,
      },
      {
        name: "Rank",
        value: `${rank || "N/A"}`,
        inline: true,
      },
      {
        name: "TD9 Bullish",
        value: td9Bullish ? "✅" : "❌",
        inline: true,
      },
      {
        name: "TD9 Bearish",
        value: td9Bearish ? "✅" : "❌",
        inline: true,
      },
      {
        name: "TD13 Bullish",
        value: td13Bullish ? "✅" : "❌",
        inline: true,
      },
      {
        name: "TD13 Bearish",
        value: td13Bearish ? "✅" : "❌",
        inline: true,
      },
    ],
    timestamp: new Date().toISOString(),
    footer: {
      text: "TD Sequential Entry Signal",
    },
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
  "Health Care": { rating: "overweight", boost: 5 },
  Utilities: { rating: "overweight", boost: 5 },
};

function getSector(ticker) {
  return SECTOR_MAP[ticker?.toUpperCase()] || null;
}

// Load sector mappings from KV (called on startup)
async function loadSectorMappingsFromKV(KV) {
  try {
    // Get all tickers from watchlist
    const tickersList = await KV.get("timed:tickers", "json");
    if (!tickersList || !Array.isArray(tickersList)) return;

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
        `[SECTOR LOAD] Loaded ${loadedCount} sector mappings from KV`
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
    (ticker) => SECTOR_MAP[ticker] === sector
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
  percentiles
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
        `Price ${Math.abs(premiumDiscount).toFixed(1)}% below fair value`
      );
    } else if (premiumDiscount > OVERVALUED_THRESHOLD) {
      signals.is_overvalued = true;
      signals.reasons.push(
        `Price ${premiumDiscount.toFixed(1)}% above fair value`
      );
    }
  }

  // Factor 2: PEG Ratio
  if (pegRatio !== null) {
    if (pegRatio < PEG_UNDERVALUED) {
      signals.is_undervalued = true;
      signals.reasons.push(
        `PEG ratio ${pegRatio.toFixed(2)} suggests undervalued growth`
      );
    } else if (pegRatio > PEG_OVERVALUED) {
      signals.is_overvalued = true;
      signals.reasons.push(
        `PEG ratio ${pegRatio.toFixed(2)} suggests overvalued`
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
  async fetch(req, env) {
    const KV = env.KV_TIMED;

    // Load sector mappings from KV on first request (lazy initialization)
    if (!sectorMappingsLoaded) {
      await loadSectorMappingsFromKV(KV);
      sectorMappingsLoaded = true;
    }

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
            (!newData || (oldData.ts && newData.ts && oldData.ts > newData.ts))
          ) {
            console.log(
              `[MIGRATE BRK] Migrating BRK.B data to BRK-B (old ts: ${
                oldData.ts
              }, new ts: ${newData?.ts || "none"})`
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
                `[MIGRATE BRK] Migration complete: BRK.B → BRK-B (deleted old BRK.B)`
              );
            } else {
              console.log(
                `[MIGRATE BRK] BRK-B already has newer data, keeping both`
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
                notifyDiscord(env, migrationEmbed).catch(() => {}); // Don't let Discord notification errors break anything
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

          // Store version-specific snapshot for historical access
          const snapshotVersion = payload.script_version || "unknown";
          if (snapshotVersion !== "unknown") {
            await kvPutJSON(
              KV,
              `timed:snapshot:${ticker}:${snapshotVersion}`,
              payload
            );
            // Also store timestamp of when this version was last seen
            await kvPutText(
              KV,
              `timed:version:${ticker}:${snapshotVersion}:last_seen`,
              String(payload.ts || Date.now())
            );
          }

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
        if (ticker === "ETHT") {
          console.log(`[ETHT DEBUG] About to compute Momentum Elite`);
        }
        const momentumEliteData = await computeMomentumElite(
          KV,
          ticker,
          payload
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

        payload.rank = computeRank(payload);

        // Auto-populate sector from TradingView data if provided
        if (
          payload.sector &&
          typeof payload.sector === "string" &&
          payload.sector.trim() !== ""
        ) {
          const tickerUpper = String(payload.ticker || ticker).toUpperCase();
          const sectorFromTV = payload.sector.trim();

          // Only update if not already mapped or if different
          const currentSector = getSector(tickerUpper);
          if (!currentSector || currentSector !== sectorFromTV) {
            // Auto-populate SECTOR_MAP (in-memory, will persist in KV)
            SECTOR_MAP[tickerUpper] = sectorFromTV;
            console.log(
              `[SECTOR AUTO-MAP] ${tickerUpper} → ${sectorFromTV}${
                currentSector ? ` (was: ${currentSector})` : " (new)"
              }`
            );

            // Store sector mapping in KV for persistence
            const sectorMapKey = `timed:sector_map:${tickerUpper}`;
            await kvPutText(KV, sectorMapKey, sectorFromTV);
          }
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
          const currentPE = payload.pe_ratio ? Number(payload.pe_ratio) : null;
          const eps = payload.eps ? Number(payload.eps) : null;
          const epsGrowthRate = payload.eps_growth_rate
            ? Number(payload.eps_growth_rate)
            : null;
          const pegRatio = payload.peg_ratio ? Number(payload.peg_ratio) : null;
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
                percentiles
              );
            }
          }

          // ─────────────────────────────────────────────────────────────
          // Fair Value Calculation
          // ─────────────────────────────────────────────────────────────
          const fairValuePE = calculateFairValuePE(peHistory, epsGrowthRate);
          const fairValuePrice = calculateFairValuePrice(
            eps,
            fairValuePE?.preferred
          );
          const premiumDiscount = calculatePremiumDiscount(
            currentPrice,
            fairValuePrice
          );

          // ─────────────────────────────────────────────────────────────
          // Valuation Signals
          // ─────────────────────────────────────────────────────────────
          const valuationSignals = calculateValuationSignal(
            currentPE,
            fairValuePE?.preferred,
            pegRatio,
            premiumDiscount,
            percentiles
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
            market_cap: payload.market_cap ? Number(payload.market_cap) : null,
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
              payload.fundamentals
            );
            if (valuationBoost !== 0) {
              const baseRank = payload.rank || 0;
              payload.rank = Math.max(
                0,
                Math.min(100, baseRank + valuationBoost)
              );

              // Store valuation boost for debugging/display
              if (!payload.rank_components) payload.rank_components = {};
              payload.rank_components.valuation_boost = valuationBoost;
              payload.rank_components.base_rank = baseRank;

              console.log(
                `[RANK] ${ticker}: Base=${baseRank}, Valuation Boost=${valuationBoost}, Final=${payload.rank}`
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
        if (ticker === "ETHT") {
          console.log(`[ETHT DEBUG] About to load activity tracking state`);
        }
        const prevCorridorKey = `timed:prevcorridor:${ticker}`;
        const prevInCorridor = await KV.get(prevCorridorKey);
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

        if (ticker === "ETHT") {
          console.log(`[ETHT DEBUG] About to get previous data and store`);
        }

        // Get previous data BEFORE storing new data (for trade simulation comparison)
        const prevLatest = await kvGetJSON(KV, `timed:latest:${ticker}`);

        if (ticker === "ETHT") {
          console.log(
            `[ETHT DEBUG] Previous data retrieved, about to store latest`
          );
        }

        // Store latest (do this BEFORE alert so UI has it)
        await kvPutJSON(KV, `timed:latest:${ticker}`, payload);

        if (ticker === "ETHT") {
          console.log(`[ETHT DEBUG] Successfully stored latest data`);
        }

        // Store version-specific snapshot for historical access
        const snapshotVersion = payload.script_version || "unknown";
        if (snapshotVersion !== "unknown") {
          await kvPutJSON(
            KV,
            `timed:snapshot:${ticker}:${snapshotVersion}`,
            payload
          );
          // Also store timestamp of when this version was last seen
          await kvPutText(
            KV,
            `timed:version:${ticker}:${snapshotVersion}:last_seen`,
            String(payload.ts || Date.now())
          );
        }

        console.log(
          `[INGEST STORED] ${ticker} - latest data saved at ${new Date(
            now
          ).toISOString()}`
        );

        // CRITICAL: Ensure ticker is in index IMMEDIATELY after storage
        // This ensures ticker appears on dashboard even if request is canceled later
        await ensureTickerIndex(KV, ticker);
        if (ticker === "ETHT") {
          console.log(`[ETHT DEBUG] Indexing completed`);
        }

        // Process trade simulation (create/update trades automatically)
        await processTradeSimulation(KV, ticker, payload, prevLatest, env);

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

        // Store version-specific snapshot for historical access
        const version = payload.script_version || "unknown";
        if (version !== "unknown") {
          await kvPutJSON(KV, `timed:snapshot:${ticker}:${version}`, payload);
          // Also store timestamp of when this version was last seen
          await kvPutText(
            KV,
            `timed:version:${ticker}:${version}:last_seen`,
            String(payload.ts || Date.now())
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

        // Trade simulation already processed above (before alert logic)

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

            // Create Discord embed for trading opportunity
            const rr = payload.rr || 0;
            const rrFormatted =
              rr >= 1 ? `${rr.toFixed(2)}:1` : `1:${(1 / rr).toFixed(2)}`;
            const opportunityEmbed = {
              title: `🎯 Trading Opportunity: ${ticker} ${side}`,
              color: side === "LONG" ? 0x00ff00 : 0xff0000, // Green for LONG, Red for SHORT
              fields: [
                {
                  name: "Rank",
                  value: `${payload.rank}`,
                  inline: true,
                },
                {
                  name: "State",
                  value: payload.state || "N/A",
                  inline: true,
                },
                {
                  name: "Why",
                  value: why || "N/A",
                  inline: false,
                },
                {
                  name: "HTF Score",
                  value: `${fmt2(payload.htf_score)}`,
                  inline: true,
                },
                {
                  name: "LTF Score",
                  value: `${fmt2(payload.ltf_score)}`,
                  inline: true,
                },
                {
                  name: "Risk/Reward",
                  value: rrFormatted,
                  inline: true,
                },
                {
                  name: "Trigger Price",
                  value: `$${fmt2(payload.trigger_price)}`,
                  inline: true,
                },
                {
                  name: "Current Price",
                  value: `$${fmt2(payload.price)}`,
                  inline: true,
                },
                {
                  name: "ETA",
                  value:
                    payload.eta_days != null
                      ? `${Number(payload.eta_days).toFixed(1)}d`
                      : "—",
                  inline: true,
                },
                {
                  name: "Stop Loss",
                  value: `$${fmt2(payload.sl)}`,
                  inline: true,
                },
                {
                  name: "Take Profit",
                  value: `$${fmt2(payload.tp)}`,
                  inline: true,
                },
                {
                  name: "Completion",
                  value: `${pct01(payload.completion)}`,
                  inline: true,
                },
                {
                  name: "Phase",
                  value: `${pct01(payload.phase_pct)}`,
                  inline: true,
                },
              ],
              timestamp: new Date().toISOString(),
              footer: {
                text: "Timed Trading Alert",
              },
              url: tv, // Make the title clickable to open TradingView
            };
            await notifyDiscord(env, opportunityEmbed);
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

              // Send Discord alert
              const td9Embed = createTD9EntryEmbed(
                ticker,
                suggestedDirection,
                payload.price,
                payload.sl,
                payload.tp,
                payload.rr,
                payload.rank,
                tdSeq
              );
              await notifyDiscord(env, td9Embed).catch(() => {});

              console.log(
                `[TD9 ENTRY ALERT] ${ticker} ${suggestedDirection} - ${signalType} signal`
              );
            }
          }
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
        return sendJSON(
          { ok: true, ticker, latestData: data, data },
          200,
          corsHeaders(env, req)
        );
      }
      return sendJSON(
        { ok: false, error: "ticker_not_found", ticker },
        404,
        corsHeaders(env, req)
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

    // GET /timed/all?version=2.5.0 (optional version parameter)
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
        } else {
          // Default: get latest data
          value = await kvGetJSON(KV, `timed:latest:${t}`);

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
            // Always recompute RR to ensure it uses the latest max TP from tp_levels
            value.rr = computeRR(value);

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

      // Log summary if any data was filtered
      if (versionFilteredCount > 0) {
        console.log(
          `[FILTER] Filtered ${versionFilteredCount} tickers by version. Breakdown:`,
          versionBreakdown
        );
      }
      return sendJSON(
        {
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
        Math.min(50, Number(url.searchParams.get("limit") || "10"))
      );

      if (!getAllSectors().includes(sector)) {
        return sendJSON(
          { ok: false, error: `Invalid sector: ${sector}` },
          400,
          corsHeaders(env, req)
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
        corsHeaders(env, req)
      );
    }

    // GET /timed/sectors/recommendations?limit=10 - Get top tickers across all overweight sectors
    if (
      url.pathname === "/timed/sectors/recommendations" &&
      req.method === "GET"
    ) {
      const limitPerSector = Math.max(
        1,
        Math.min(20, Number(url.searchParams.get("limit") || "10"))
      );
      const totalLimit = Math.max(
        1,
        Math.min(100, Number(url.searchParams.get("totalLimit") || "50"))
      );

      const overweightSectors = getAllSectors().filter(
        (sector) => getSectorRating(sector).rating === "overweight"
      );

      const allRecommendations = [];

      for (const sector of overweightSectors) {
        const topTickers = await rankTickersInSector(
          KV,
          sector,
          limitPerSector
        );
        allRecommendations.push(
          ...topTickers.map((t) => ({
            ...t,
            sector,
          }))
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
        corsHeaders(env, req)
      );
    }

    // POST /timed/debug/migrate-brk?key=... - Migrate BRK.B to BRK-B
    if (url.pathname === "/timed/debug/migrate-brk" && req.method === "POST") {
      const authFail = requireKeyOr401(req, env);
      if (authFail) return authFail;

      try {
        const oldData = await kvGetJSON(KV, `timed:latest:BRK.B`);
        const newData = await kvGetJSON(KV, `timed:latest:BRK-B`);

        if (!oldData && !newData) {
          return sendJSON(
            { ok: false, error: "No BRK data found" },
            404,
            corsHeaders(env, req)
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
          corsHeaders(env, req)
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
          corsHeaders(env, req)
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
          corsHeaders(env, req)
        );
      } catch (err) {
        return sendJSON(
          { ok: false, error: err.message },
          500,
          corsHeaders(env, req)
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
            cors
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
            cors
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
            cors
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
            cors
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
            corsHeaders(env, req)
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
          corsHeaders(env, req)
        );
      } catch (err) {
        return sendJSON(
          { ok: false, error: err.message },
          500,
          corsHeaders(env, req)
        );
      }
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

    // POST /timed/cleanup-no-scores?key=... (Remove tickers without score data from index)
    if (url.pathname === "/timed/cleanup-no-scores" && req.method === "POST") {
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
        corsHeaders(env, req)
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
        corsHeaders(env, req)
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
          corsHeaders(env, req)
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
      // Rate limiting - increased limits for UI polling (100 requests per minute)
      const ip = req.headers.get("CF-Connecting-IP") || "unknown";
      const rateLimit = await checkRateLimit(
        KV,
        ip,
        "/timed/trades",
        100, // 100 requests
        60 // per minute (instead of per hour)
      );

      if (!rateLimit.allowed) {
        return sendJSON(
          { ok: false, error: "rate_limit_exceeded", retryAfter: 60 },
          429,
          corsHeaders(env, req)
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
              }: WIN with negative P&L (${trade.pnl.toFixed(2)}) -> LOSS`
            );
            allTrades[i] = { ...trade, status: "LOSS" };
            corrected = true;
          } else if (trade.status === "LOSS" && trade.pnl > 0) {
            console.log(
              `[TRADE CORRECTION] Correcting ${trade.ticker} ${
                trade.direction
              }: LOSS with positive P&L (${trade.pnl.toFixed(2)}) -> WIN`
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
          `[TRADE CORRECTION] Saved ${allTrades.length} trades with corrections`
        );
      }

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
          corrected: corrected, // Indicate if corrections were made
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
              aiChatCorsHeaders
            );
          }
          body = result.obj;
        } catch (e) {
          return sendJSON(
            { ok: false, error: "Failed to parse request body" },
            400,
            aiChatCorsHeaders
          );
        }

        if (!body || !body.message) {
          return sendJSON(
            { ok: false, error: "missing message" },
            400,
            aiChatCorsHeaders
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
              aiChatCorsHeaders
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
                    `timed:latest:${ticker}`
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
                    err
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
                    e
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
              2
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
              a.ticker || "UNKNOWN"
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
              }
            );
          } catch (fetchError) {
            clearTimeout(timeoutId);
            if (fetchError.name === "AbortError") {
              throw new Error(
                "Request timeout - OpenAI API took too long to respond"
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
              errorData
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
            aiChatCorsHeaders
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
              aiChatCorsHeaders
            );
          } catch (sendError) {
            // If even sendJSON fails, return a basic response with CORS headers
            console.error(
              "[AI CHAT FATAL ERROR] Failed to send error response:",
              sendError
            );
            return new Response(
              JSON.stringify({ ok: false, error: "Internal server error" }),
              {
                status: 500,
                headers: {
                  "Content-Type": "application/json",
                  ...aiChatCorsHeaders,
                },
              }
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
            fatalCorsHeaders
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
            }
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
          aiChatCorsHeaders
        );
      } catch (error) {
        console.error("[AI UPDATES ERROR]", error);
        return sendJSON(
          {
            ok: false,
            error: error.message || "Failed to fetch updates",
          },
          500,
          aiChatCorsHeaders
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
            aiChatCorsHeaders
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
          (t) => t.status === "OPEN" || !t.status
        );
        const closedTrades = todayTrades.filter(
          (t) => t.status === "WIN" || t.status === "LOSS"
        );
        const trimmedTrades = todayTrades.filter(
          (t) => t.status === "TP_HIT_TRIM"
        );

        // Calculate P&L
        const closedPnl = closedTrades.reduce(
          (sum, t) => sum + (Number(t.pnl) || 0),
          0
        );
        const openPnl = newTrades.reduce(
          (sum, t) => sum + (Number(t.pnl) || 0),
          0
        );
        const trimmedPnl = trimmedTrades.reduce(
          (sum, t) => sum + (Number(t.pnl) || 0),
          0
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
            if (triggerReason === "EMA_CROSS") signals.push("EMA_CROSS_DAILY");
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
            ).toFixed(1)}% win rate) | P&L: $${stats.totalPnl.toFixed(2)}`
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
        }L | P&L: $${stats.totalPnl.toFixed(2)}`
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
        }L | P&L: $${stats.totalPnl.toFixed(2)}`
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
            2
          )} | Current $${currentPrice.toFixed(2)} | SL $${sl.toFixed(
            2
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
            }
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
          aiData.choices?.[0]?.message?.content || "Daily summary unavailable.";

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
          aiChatCorsHeaders
        );
      } catch (error) {
        console.error("[DAILY SUMMARY ERROR]", error);
        return sendJSON(
          {
            ok: false,
            error: error.message || "Daily summary service error",
          },
          500,
          aiChatCorsHeaders
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
            aiChatCorsHeaders
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
          allTickers
        );

        // Proactive Alerts: Detect conditions that need attention
        const proactiveAlerts = generateProactiveAlerts(
          allTickers,
          allTradesForHistory
        );

        // Analyze for proactive alerts
        const primeSetups = allTickers.filter(
          (t) =>
            t.rank >= 75 &&
            t.rr >= 1.5 &&
            t.completion < 0.4 &&
            t.phase_pct < 0.6
        );

        const highRiskPositions = allTickers.filter(
          (t) => t.completion > 0.7 || t.phase_pct > 0.8
        );

        const momentumEliteSetups = allTickers.filter(
          (t) => t.flags?.momentum_elite && t.rank >= 70
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
          0
        )}%, Price $${t.price.toFixed(2)}`
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
        } at $${a.price.toFixed(2)}`
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
            }
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
            errorData.error?.message || `OpenAI API error: ${aiResponse.status}`
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
          aiChatCorsHeaders
        );
      } catch (error) {
        console.error("[AI MONITOR ERROR]", error);
        return sendJSON(
          {
            ok: false,
            error: error.message || "Monitoring service error",
          },
          500,
          aiChatCorsHeaders
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
            (t) => String(t.ticker || "").toUpperCase() === tickerUpper
          );
        }

        const openTrades = filteredTrades.filter(
          (t) => t.status === "OPEN" || !t.status || t.status === "TP_HIT_TRIM"
        );
        const closedTrades = filteredTrades.filter(
          (t) => t.status === "WIN" || t.status === "LOSS"
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
          corsHeaders(env, req)
        );
      } catch (err) {
        return sendJSON(
          { ok: false, error: err.message },
          500,
          corsHeaders(env, req)
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

        const allData = (await Promise.all(tickerDataPromises)).filter(Boolean);

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
          corsHeaders(env, req)
        );
      } catch (err) {
        return sendJSON(
          { ok: false, error: err.message },
          500,
          corsHeaders(env, req)
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
          corsHeaders(env, req)
        );
      } catch (err) {
        return sendJSON(
          { ok: false, error: err.message },
          500,
          corsHeaders(env, req)
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
        corsHeaders(env, req)
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
            corsHeaders(env, req)
          );
        }

        const tickerUpper = String(tickerFilter).toUpperCase();
        const tickerTrades = allTrades.filter(
          (t) => String(t.ticker || "").toUpperCase() === tickerUpper
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
            corsHeaders(env, req)
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
              t.status === "OPEN" || !t.status || t.status === "TP_HIT_TRIM"
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
              ...dirTrades.filter((t) => !openTrades.includes(t))
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
          (t) => !tradeIdsToRemove.has(t.id)
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
          corsHeaders(env, req)
        );
      } catch (err) {
        return sendJSON(
          { ok: false, error: err.message },
          500,
          corsHeaders(env, req)
        );
      }
    }

    // POST /timed/debug/purge-ticker?key=...&ticker=RIOT - Delete ALL trades for a specific ticker
    if (url.pathname === "/timed/debug/purge-ticker" && req.method === "POST") {
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
            corsHeaders(env, req)
          );
        }

        const tickerUpper = String(tickerFilter).toUpperCase();
        const beforeCount = allTrades.length;

        // Filter out all trades for this ticker
        const filteredTrades = allTrades.filter(
          (t) => String(t.ticker || "").toUpperCase() !== tickerUpper
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
            corsHeaders(env, req)
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
          corsHeaders(env, req)
        );
      } catch (err) {
        return sendJSON(
          { ok: false, error: err.message },
          500,
          corsHeaders(env, req)
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
            corsHeaders(env, req)
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
          corsHeaders(env, req)
        );
      } catch (err) {
        return sendJSON(
          { ok: false, error: err.message },
          500,
          corsHeaders(env, req)
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
          corsHeaders(env, req)
        );
      } catch (err) {
        return sendJSON(
          { ok: false, error: err.message },
          500,
          corsHeaders(env, req)
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
                    Number(closestPoint.ts)
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
                `timed:latest:${trade.ticker}`
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
          corsHeaders(env, req)
        );
      } catch (err) {
        return sendJSON(
          { ok: false, error: err.message },
          500,
          corsHeaders(env, req)
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
          corsHeaders(env, req)
        );
      } catch (err) {
        return sendJSON(
          { ok: false, error: err.message },
          500,
          corsHeaders(env, req)
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
                env
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
          (t) => t.status === "OPEN" || !t.status || t.status === "TP_HIT_TRIM"
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
          corsHeaders(env, req)
        );
      } catch (err) {
        return sendJSON(
          { ok: false, error: err.message },
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

  // Scheduled handler for periodic AI updates (9:45 AM, noon, 3:30 PM ET) and trade updates (every 5 min)
  async scheduled(event, env, ctx) {
    const KV = env.KV_TIMED;
    const now = new Date();
    const hour = now.getUTCHours();
    const minute = now.getUTCMinutes();

    // Always update open trades (runs every 5 minutes)
    try {
      const tradesKey = "timed:trades:all";
      const allTrades = (await kvGetJSON(KV, tradesKey)) || [];
      const openTrades = allTrades.filter(
        (t) => t.status === "OPEN" || !t.status || t.status === "TP_HIT_TRIM"
      );

      if (openTrades.length > 0) {
        console.log(
          `[TRADE UPDATE CRON] Updating ${openTrades.length} open trades`
        );

        for (const trade of openTrades) {
          try {
            const latestData = await kvGetJSON(
              KV,
              `timed:latest:${trade.ticker}`
            );
            if (latestData) {
              // Use processTradeSimulation to ensure entry price correction logic runs
              const prevLatest = null; // No previous data for scheduled updates
              await processTradeSimulation(
                KV,
                trade.ticker,
                latestData,
                prevLatest,
                env
              );
            }
          } catch (err) {
            console.error(
              `[TRADE UPDATE CRON] Error updating trade ${trade.ticker}:`,
              err
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

    // Proactive Alerts & Pattern Recognition (every 15 minutes during market hours)
    // This runs more frequently to catch time-sensitive conditions
    const isProactiveAlertTime = minute % 15 === 0; // Every 15 minutes

    if (isProactiveAlertTime) {
      try {
        const tradesKey = "timed:trades:all";
        const allTrades = (await kvGetJSON(KV, tradesKey)) || [];
        const openTrades = allTrades.filter(
          (t) => t.status === "OPEN" || t.status === "TP_HIT_TRIM"
        );

        // Fetch current ticker data for alert generation
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
                  completion: Number(data.completion) || 0,
                  phase_pct: Number(data.phase_pct) || 0,
                  flags: data.flags || {},
                };
              }
              return null;
            } catch (err) {
              return null;
            }
          });

        const allTickers = (await Promise.all(tickerDataPromises)).filter(
          Boolean
        );

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
            `[PROACTIVE ALERTS] Generated ${proactiveAlerts.length} alerts, ${newHighPriorityAlerts.length} high-priority`
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
          t.rank >= 75 && t.rr >= 1.5 && t.completion < 0.4 && t.phase_pct < 0.6
      );

      const highRiskPositions = allTickers.filter(
        (t) => t.completion > 0.7 || t.phase_pct > 0.8
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
        } at $${a.price.toFixed(2)}`
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
        }
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
        `[SCHEDULED] Generated ${updateTime} at ${now.toISOString()}`
      );
    } catch (error) {
      console.error("[SCHEDULED ERROR]", error);
    }
  },
};
