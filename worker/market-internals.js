/**
 * worker/market-internals.js
 *
 * Phase C — Stage 1 (2026-05-05) — Provider-agnostic Market Internals layer.
 *
 * Provides TICK / ADD / TRIN / VIX context to entry sizing, exit doctrine,
 * and short-admission logic. Per user direction:
 *
 *   1. PROVIDER-AGNOSTIC. Source priority chain:
 *      a) TradingView webhook captures (timed:capture:latest:TICK / ADD)
 *      b) Direct ingest (timed:latest:TICK / ADD) — for future direct feeds
 *      c) Synthetic computation from our 238-ticker universe — fallback
 *      d) Returns "unknown" if all sources fail (NEVER blocks trades)
 *
 *   2. NEVER USED AS A BINARY FILTER. Per user: "we should not block longs
 *      on shock open." Instead used for:
 *      - Entry sizing modulation (0.5× / 1.0× / 1.25×)
 *      - Exit doctrine tightening / capitulation detection
 *      - SHORT admission unlock during sustained negative tape
 *
 *   3. GRACEFUL DEGRADATION. If a source fails (TradingView webhook outage,
 *      stale data, malformed payload), the system FALLS BACK silently to
 *      the next source. If all sources fail, getTapeContext() returns a
 *      neutral "unknown" context that has zero effect on trading decisions.
 *
 *   4. REPLAY-AWARE. In backtest mode, reads historical TICK/ADD via the
 *      timestamp parameter. The backfill script populates `timed:internals:
 *      historical:TICK` / `:ADD` as a sorted ts→value map.
 *
 * Disabled via daCfg.deep_audit_market_internals_enabled = "false".
 */

// ─────────────────────────────────────────────────────────────────────
// Source priority + freshness thresholds
// ─────────────────────────────────────────────────────────────────────
const SOURCES = {
  TRADINGVIEW_CAPTURE: "tradingview_capture",
  DIRECT_LATEST: "direct_latest",
  SYNTHETIC: "synthetic",
  HISTORICAL: "historical_kv",
  UNKNOWN: "unknown",
};

// In LIVE mode, capture data older than this is considered stale.
const LIVE_STALENESS_MAX_MS = 5 * 60 * 1000; // 5 minutes

// Carter rule thresholds (calibrated from the validation work). These are
// SOFT signals — they modulate behavior, not block entries.
const TICK_THRESHOLDS = {
  EXTREME_NEG: -1000,    // sustained = real selling pressure
  STRONG_NEG: -600,      // bias is bearish
  NEUTRAL_LOW: -300,     // noise band
  NEUTRAL_HIGH: 300,
  STRONG_POS: 600,       // bias is bullish
  EXTREME_POS: 1000,
};
const ADD_THRESHOLDS = {
  EXTREME_NEG: -1500,    // broad capitulation
  STRONG_NEG: -800,      // broadly weak tape
  NEUTRAL_LOW: -300,
  NEUTRAL_HIGH: 300,
  STRONG_POS: 800,
  EXTREME_POS: 1500,
};

// Sustained = how many of the last N bars met the threshold.
const SUSTAINED_BARS_REQUIRED = 3; // 3 of 5 bars (15min on 5m feed)
const SUSTAINED_BARS_LOOKBACK = 5;

// ─────────────────────────────────────────────────────────────────────
// Source loaders — each tries to return the most recent N bars of the
// internal. Each returns null on failure (no exception).
// ─────────────────────────────────────────────────────────────────────

/**
 * Source 1: TradingView webhook captures.
 * Reads timed:capture:latest:{TICK|ADD} + timed:capture:trail:{TICK|ADD}
 * Returns: { source, freshness_ms, latest, history[] } | null
 */
async function loadFromTradingViewCapture(KV, indicator, opts = {}) {
  if (!KV) return null;
  try {
    const latestRaw = await KV.get(`timed:capture:latest:${indicator}`, { type: "json" });
    if (!latestRaw) return null;
    const trailRaw = await KV.get(`timed:capture:trail:${indicator}`, { type: "json" }) || [];
    const ts = Number(latestRaw?.ts) || 0;
    const nowMs = Number(opts.nowMs) || Date.now();
    const freshnessMs = nowMs - ts;
    // Live freshness check; in replay we accept any age (replay re-reads the
    // historical KV path instead).
    const isReplay = !!opts.isReplay;
    if (!isReplay && freshnessMs > LIVE_STALENESS_MAX_MS) {
      return null;
    }
    return {
      source: SOURCES.TRADINGVIEW_CAPTURE,
      freshness_ms: freshnessMs,
      latest: {
        ts,
        price: Number(latestRaw?.price ?? latestRaw?.close ?? latestRaw?.tf_candles?.["5"]?.c ?? 0),
        // Pull the 5min candle if present (best for Carter-style rules)
        candle_5m: latestRaw?.tf_candles?.["5"] || null,
        candle_1m: latestRaw?.tf_candles?.["1"] || null,
      },
      history: Array.isArray(trailRaw) ? trailRaw.slice(-SUSTAINED_BARS_LOOKBACK).map(t => ({
        ts: Number(t?.ts) || 0,
        price: Number(t?.price) || 0,
      })) : [],
    };
  } catch (_) {
    return null;
  }
}

/**
 * Source 2: Direct latest (for if we add a CME/Polygon direct feed later).
 * Reads timed:latest:{TICK|ADD}.
 */
async function loadFromDirectLatest(KV, indicator, opts = {}) {
  if (!KV) return null;
  try {
    const raw = await KV.get(`timed:latest:${indicator}`, { type: "json" });
    if (!raw) return null;
    const ts = Number(raw?.ts || raw?.ingest_ts) || 0;
    const nowMs = Number(opts.nowMs) || Date.now();
    const freshnessMs = nowMs - ts;
    const isReplay = !!opts.isReplay;
    if (!isReplay && freshnessMs > LIVE_STALENESS_MAX_MS) return null;
    return {
      source: SOURCES.DIRECT_LATEST,
      freshness_ms: freshnessMs,
      latest: { ts, price: Number(raw?.price) || 0, candle_5m: null, candle_1m: null },
      history: [],
    };
  } catch (_) { return null; }
}

/**
 * Source 3: Historical KV (for replay backfill).
 * Reads timed:internals:historical:{TICK|ADD}:{day} where day=YYYY-MM-DD.
 * Each day is an array of {ts, o, h, l, c} bars on 5min interval.
 *
 * The CSV backfill script populates these.
 */
async function loadFromHistorical(KV, indicator, opts = {}) {
  if (!KV) return null;
  const nowMs = Number(opts.nowMs) || Date.now();
  if (!nowMs) return null;
  try {
    const day = new Date(nowMs).toISOString().slice(0, 10);
    const dayBars = await KV.get(`timed:internals:historical:${indicator}:${day}`, { type: "json" });
    if (!Array.isArray(dayBars) || dayBars.length === 0) return null;
    // Find the bar at-or-just-before nowMs.
    // Bars are sorted by ts ascending.
    let latestIdx = -1;
    for (let i = dayBars.length - 1; i >= 0; i--) {
      if (Number(dayBars[i]?.ts) <= nowMs) { latestIdx = i; break; }
    }
    if (latestIdx < 0) return null;
    const latestBar = dayBars[latestIdx];
    // Take the last N bars for trend analysis
    const history = [];
    for (let i = Math.max(0, latestIdx - SUSTAINED_BARS_LOOKBACK + 1); i <= latestIdx; i++) {
      const b = dayBars[i];
      history.push({
        ts: Number(b.ts) || 0,
        price: Number(b.c) || 0,
        low: Number(b.l) || 0,
        high: Number(b.h) || 0,
        open: Number(b.o) || 0,
      });
    }
    return {
      source: SOURCES.HISTORICAL,
      freshness_ms: nowMs - Number(latestBar.ts),
      latest: {
        ts: Number(latestBar.ts),
        price: Number(latestBar.c) || 0,
        candle_5m: { ts: Number(latestBar.ts), o: Number(latestBar.o), h: Number(latestBar.h), l: Number(latestBar.l), c: Number(latestBar.c), v: 0 },
        candle_1m: null,
      },
      history,
    };
  } catch (_) { return null; }
}

/**
 * Source 4: Synthetic computation. Compute approximate TICK/ADD from
 * the 238-ticker universe data we already have. Lower precision than
 * real TradingView feed (correlation ~0.61 daily) but never goes stale.
 *
 * Caller must provide universeBars: array of {ticker, last_close, prev_close}
 * for the current bar. We compute:
 *   synth_TICK ≈ (count_up - count_down) * 1000 / total
 *   synth_ADD ≈ (count_up - count_down) raw
 */
function computeSynthetic(indicator, universeBars) {
  if (!Array.isArray(universeBars) || universeBars.length === 0) return null;
  let upCount = 0, downCount = 0, flatCount = 0;
  for (const b of universeBars) {
    const last = Number(b?.last_close);
    const prev = Number(b?.prev_close);
    if (!Number.isFinite(last) || !Number.isFinite(prev) || prev <= 0) {
      flatCount++;
      continue;
    }
    const ch = (last - prev) / prev;
    if (ch > 0.001) upCount++;
    else if (ch < -0.001) downCount++;
    else flatCount++;
  }
  const total = upCount + downCount + flatCount;
  if (total < 50) return null;
  const value = indicator === "TICK"
    ? Math.round((upCount - downCount) * 1000 / total)  // normalized to ±1000
    : (upCount - downCount);                              // raw ADD
  return {
    source: SOURCES.SYNTHETIC,
    freshness_ms: 0,
    latest: { ts: Date.now(), price: value, candle_5m: null, candle_1m: null },
    history: [],  // synthetic doesn't have history
  };
}

// ─────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────

/**
 * Get an internal indicator value with provider fallback.
 *
 * @param {object} KV
 * @param {string} indicator - "TICK" or "ADD"
 * @param {object} opts - { nowMs, isReplay, universeBars (for synthetic fallback) }
 * @returns {object|null} { source, latest, history, freshness_ms } or null if all sources fail
 */
export async function getInternalValue(KV, indicator, opts = {}) {
  const isReplay = !!opts.isReplay;

  // In replay mode: prefer historical KV first (matches simulated time)
  if (isReplay) {
    const histResult = await loadFromHistorical(KV, indicator, opts);
    if (histResult) return histResult;
    // If no historical data for this date, try synthetic
    if (Array.isArray(opts.universeBars)) {
      const synth = computeSynthetic(indicator, opts.universeBars);
      if (synth) return synth;
    }
    return null;
  }

  // Live mode: prefer TradingView webhook capture (most accurate)
  const captureResult = await loadFromTradingViewCapture(KV, indicator, opts);
  if (captureResult) return captureResult;

  // Fallback: direct latest (future feed providers)
  const directResult = await loadFromDirectLatest(KV, indicator, opts);
  if (directResult) return directResult;

  // Final fallback: synthetic
  if (Array.isArray(opts.universeBars)) {
    const synth = computeSynthetic(indicator, opts.universeBars);
    if (synth) return synth;
  }
  return null;
}

/**
 * Get the full tape context — both TICK and ADD with classification.
 *
 * @returns {object} {
 *   tone: 'broadly_bullish' | 'mixed' | 'broadly_bearish' | 'capitulating' | 'extreme_buying' | 'unknown',
 *   strength: 0..1,
 *   tick: { value, bias, sustained_bars_negative, sustained_bars_positive, trend_30min },
 *   add: { value, bias, sustained_bars_negative, sustained_bars_positive, trend_30min },
 *   sources: { tick, add },
 *   confirms: 'long' | 'short' | 'neutral' | 'capitulating',
 * }
 */
export async function getTapeContext(KV, opts = {}) {
  const tickRes = await getInternalValue(KV, "TICK", opts);
  const addRes = await getInternalValue(KV, "ADD", opts);

  const tick = tickRes?.latest?.price ?? null;
  const add = addRes?.latest?.price ?? null;

  // No data at all — return neutral context
  if (tick == null && add == null) {
    return {
      tone: "unknown",
      strength: 0,
      tick: null,
      add: null,
      sources: { tick: null, add: null },
      confirms: "neutral",
      reason: "no_data_available_silent_fallback",
    };
  }

  // Classify TICK bias
  const tickBias = tick == null ? "unknown"
    : tick <= TICK_THRESHOLDS.EXTREME_NEG ? "extreme_negative"
    : tick <= TICK_THRESHOLDS.STRONG_NEG ? "strong_negative"
    : tick <= TICK_THRESHOLDS.NEUTRAL_LOW ? "weak_negative"
    : tick >= TICK_THRESHOLDS.EXTREME_POS ? "extreme_positive"
    : tick >= TICK_THRESHOLDS.STRONG_POS ? "strong_positive"
    : tick >= TICK_THRESHOLDS.NEUTRAL_HIGH ? "weak_positive"
    : "neutral";

  const addBias = add == null ? "unknown"
    : add <= ADD_THRESHOLDS.EXTREME_NEG ? "extreme_negative"
    : add <= ADD_THRESHOLDS.STRONG_NEG ? "strong_negative"
    : add <= ADD_THRESHOLDS.NEUTRAL_LOW ? "weak_negative"
    : add >= ADD_THRESHOLDS.EXTREME_POS ? "extreme_positive"
    : add >= ADD_THRESHOLDS.STRONG_POS ? "strong_positive"
    : add >= ADD_THRESHOLDS.NEUTRAL_HIGH ? "weak_positive"
    : "neutral";

  // Sustained negative count from history (Carter "trending lower")
  const sustainedNegativeBars = (history) => {
    if (!Array.isArray(history) || history.length < 3) return 0;
    let count = 0;
    for (const h of history) {
      if (Number(h?.price ?? h?.low) < 0) count++;
    }
    return count;
  };
  const sustainedPositiveBars = (history) => {
    if (!Array.isArray(history) || history.length < 3) return 0;
    let count = 0;
    for (const h of history) {
      if (Number(h?.price ?? h?.high) > 0) count++;
    }
    return count;
  };

  const tickHistNeg = sustainedNegativeBars(tickRes?.history);
  const tickHistPos = sustainedPositiveBars(tickRes?.history);
  const addHistNeg = sustainedNegativeBars(addRes?.history);
  const addHistPos = sustainedPositiveBars(addRes?.history);

  // Trend: comparing latest to start-of-history
  const computeTrend = (res) => {
    if (!res?.history || res.history.length < 3) return "flat";
    const first = Number(res.history[0]?.price);
    const last = Number(res.latest?.price);
    if (!Number.isFinite(first) || !Number.isFinite(last)) return "flat";
    const delta = last - first;
    if (Math.abs(delta) < 100) return "flat";
    return delta > 0 ? "rising" : "falling";
  };
  const tickTrend = computeTrend(tickRes);
  const addTrend = computeTrend(addRes);

  // === Tape tone classification ===
  // Capitulating: BOTH at extreme negative AND falling
  const capitulating = (tickBias === "extreme_negative" && addBias === "extreme_negative")
    || (tickHistNeg >= 4 && addHistNeg >= 4 && tickTrend === "falling")
    || (add != null && add <= ADD_THRESHOLDS.EXTREME_NEG && tickTrend !== "rising");
  // Extreme buying: BOTH at extreme positive
  const extremeBuying = (tickBias === "extreme_positive" && addBias === "extreme_positive")
    || (tickHistPos >= 4 && addHistPos >= 4 && tickTrend === "rising");
  // Broadly bearish: ADD < strong_neg AND TICK trending lower
  const broadlyBearish = (add != null && add <= ADD_THRESHOLDS.STRONG_NEG)
    || (tick != null && tick <= TICK_THRESHOLDS.STRONG_NEG && tickHistNeg >= 3);
  // Broadly bullish
  const broadlyBullish = (add != null && add >= ADD_THRESHOLDS.STRONG_POS)
    || (tick != null && tick >= TICK_THRESHOLDS.STRONG_POS && tickHistPos >= 3);

  let tone = "mixed";
  let strength = 0.0;
  if (capitulating) { tone = "capitulating"; strength = 1.0; }
  else if (extremeBuying) { tone = "extreme_buying"; strength = 1.0; }
  else if (broadlyBearish) { tone = "broadly_bearish"; strength = 0.7; }
  else if (broadlyBullish) { tone = "broadly_bullish"; strength = 0.7; }
  else { tone = "mixed"; strength = 0.0; }

  let confirms = "neutral";
  if (tone === "broadly_bullish" || tone === "extreme_buying") confirms = "long";
  else if (tone === "broadly_bearish" || tone === "capitulating") confirms = "short";

  return {
    tone,
    strength,
    tick: { value: tick, bias: tickBias, sustained_neg: tickHistNeg, sustained_pos: tickHistPos, trend: tickTrend },
    add: { value: add, bias: addBias, sustained_neg: addHistNeg, sustained_pos: addHistPos, trend: addTrend },
    sources: { tick: tickRes?.source, add: addRes?.source },
    confirms,
  };
}

/**
 * Sizing modulation based on tape context.
 *
 * @param {object} args - { direction: 'LONG'|'SHORT', tapeContext }
 * @returns {object} { multiplier: 0.5..1.5, reason }
 */
export function getEntrySizeModulation(args) {
  const { direction, tapeContext } = args || {};
  if (!tapeContext || tapeContext.tone === "unknown") {
    return { multiplier: 1.0, reason: "tape_unknown_default_1x" };
  }
  const dir = String(direction || "").toUpperCase();
  // Aligned: LONG + bullish tape OR SHORT + bearish tape → SIZE UP
  if ((dir === "LONG" && tapeContext.confirms === "long")
      || (dir === "SHORT" && tapeContext.confirms === "short")) {
    return { multiplier: 1.25, reason: `tape_aligned_${dir}_with_${tapeContext.tone}` };
  }
  // Disagreeing: LONG + bearish tape OR SHORT + bullish tape → SIZE DOWN
  if ((dir === "LONG" && tapeContext.confirms === "short")
      || (dir === "SHORT" && tapeContext.confirms === "long")) {
    // Capitulating/extreme_buying = strong disagreement
    if (tapeContext.strength >= 1.0) {
      return { multiplier: 0.5, reason: `tape_strongly_disagrees: ${tapeContext.tone} vs ${dir}` };
    }
    return { multiplier: 0.7, reason: `tape_disagrees: ${tapeContext.tone} vs ${dir}` };
  }
  return { multiplier: 1.0, reason: `tape_neutral_default_1x: ${tapeContext.tone}` };
}

/**
 * Should the SHORT admission gate temporarily unlock during sustained
 * bearish tape? Caller (admission matrix) checks this when about to reject
 * a short due to non-bear regime.
 *
 * Returns true ONLY when tape is capitulating or strongly bearish AND
 * sustained for several bars (avoid one-bar dips).
 */
export function shouldUnlockShortAdmission(tapeContext) {
  if (!tapeContext) return false;
  if (tapeContext.tone === "capitulating") return true;
  if (tapeContext.tone === "broadly_bearish"
      && tapeContext.tick?.sustained_neg >= 4
      && tapeContext.add?.sustained_neg >= 4) return true;
  return false;
}

/**
 * Should the exit doctrine TIGHTEN existing LONG positions due to a
 * sudden tape collapse (real-time signal even before pnl turns red)?
 */
export function shouldTightenLongsForTape(tapeContext) {
  if (!tapeContext) return false;
  if (tapeContext.tone === "capitulating") return true;
  if (tapeContext.tone === "broadly_bearish" && tapeContext.tick?.sustained_neg >= 3) return true;
  return false;
}

export default {
  getInternalValue,
  getTapeContext,
  getEntrySizeModulation,
  shouldUnlockShortAdmission,
  shouldTightenLongsForTape,
  SOURCES,
  TICK_THRESHOLDS,
  ADD_THRESHOLDS,
};
