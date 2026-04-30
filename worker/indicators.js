// ─────────────────────────────────────────────────────────────────────────────
// Server-side indicator computation engine
// Replicates TimedTrading_ScoreEngine_v2.1.0 Pine Script logic in JavaScript
// ─────────────────────────────────────────────────────────────────────────────

import { normalizeTfKey } from "./ingest.js";
import {
  normalizeLearnedTickerProfile,
  resolveTickerProfileContext,
  buildLegacyLearnedProfileView,
} from "./profile-resolution.js";
import { resolveRegimeVocabulary } from "./regime-vocabulary.js";
import { recordAdaptiveLineageFact } from "./adaptive-lineage.js";

// Bump this whenever scoring logic changes (indicator weights, TF architecture,
// regime classification, entry quality formula, etc.). Snapshots tagged with
// this version let us know exactly which logic produced them.
export const SCORING_VERSION = "2.1.0-2026-03-20";

// ═══════════════════════════════════════════════════════════════════════════════
// PRIMITIVE INDICATORS (from OHLCV bar arrays)
// Each bar: { ts, o, h, l, c, v }
// Bars must be sorted ascending by ts (oldest first)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Simple Moving Average over the last `period` closes.
 * @param {number[]} closes - array of close prices
 * @param {number} period
 * @returns {number} SMA value at the end of the array
 */
export function sma(closes, period) {
  if (!closes || closes.length < period) return NaN;
  let sum = 0;
  for (let i = closes.length - period; i < closes.length; i++) sum += closes[i];
  return sum / period;
}

/**
 * Full SMA series (returns array same length as input, NaN for insufficient data).
 */
export function smaSeries(closes, period) {
  const out = new Array(closes.length).fill(NaN);
  if (closes.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += closes[i];
  out[period - 1] = sum / period;
  for (let i = period; i < closes.length; i++) {
    sum += closes[i] - closes[i - period];
    out[i] = sum / period;
  }
  return out;
}

/**
 * Exponential Moving Average series.
 * @param {number[]} closes
 * @param {number} period
 * @returns {number[]} EMA series (same length, NaN until warm)
 */
export function emaSeries(closes, period) {
  const out = new Array(closes.length).fill(NaN);
  if (!closes || closes.length < period) return out;
  const k = 2 / (period + 1);
  // Seed with SMA
  let sum = 0;
  for (let i = 0; i < period; i++) sum += closes[i];
  out[period - 1] = sum / period;
  for (let i = period; i < closes.length; i++) {
    out[i] = closes[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}

/**
 * Latest EMA value (last element of the series).
 */
export function emaLatest(closes, period) {
  const s = emaSeries(closes, period);
  return s[s.length - 1];
}

/**
 * True Range series.
 * @param {Array<{h:number,l:number,c:number}>} bars
 * @returns {number[]}
 */
export function trSeries(bars) {
  const out = new Array(bars.length).fill(NaN);
  out[0] = bars[0].h - bars[0].l;
  for (let i = 1; i < bars.length; i++) {
    const hl = bars[i].h - bars[i].l;
    const hc = Math.abs(bars[i].h - bars[i - 1].c);
    const lc = Math.abs(bars[i].l - bars[i - 1].c);
    out[i] = Math.max(hl, hc, lc);
  }
  return out;
}

/**
 * ATR series (SMA of True Range, matching Pine ta.atr).
 * Pine uses RMA (Wilder's smoothing) for ATR, which is equivalent to EMA with period = 2*period-1.
 * Actually Pine ta.atr uses ta.rma which is a modified EMA: alpha = 1/period.
 */
export function atrSeries(bars, period = 14) {
  const tr = trSeries(bars);
  // Pine's ta.rma uses alpha = 1/period (not 2/(period+1))
  return rmaSeries(tr, period);
}

/**
 * RMA (Wilder's Moving Average / Running Moving Average) series.
 * Pine's ta.rma: alpha = 1/period
 */
export function rmaSeries(values, period) {
  const out = new Array(values.length).fill(NaN);
  if (values.length < period) return out;
  const alpha = 1 / period;
  // Seed with SMA
  let sum = 0;
  for (let i = 0; i < period; i++) sum += (Number.isFinite(values[i]) ? values[i] : 0);
  out[period - 1] = sum / period;
  for (let i = period; i < values.length; i++) {
    const v = Number.isFinite(values[i]) ? values[i] : 0;
    out[i] = alpha * v + (1 - alpha) * out[i - 1];
  }
  return out;
}

/**
 * TT Phase Oscillator series (internal name: satyPhase) — pure price-displacement formula:
 *   raw[i] = ((close[i] - EMA(close,21)[i]) / (3 * ATR(14)[i])) * 100
 *   osc = EMA(raw, smoothPeriod)
 * Returns { series, zones } where zones has zone-exit flags for the latest bar.
 * @param {Array<{h:number,l:number,c:number}>} bars - OHLC bars
 * @param {number[]} closes
 * @param {number[]|null} ema21Arr - pre-computed EMA(21) series (or null to compute)
 * @param {number[]|null} atr14Arr - pre-computed ATR(14) series (or null to compute)
 * @param {number} smoothPeriod - EMA smoothing for raw oscillator (default 3)
 */
export function satyPhaseSeries(bars, closes, ema21Arr, atr14Arr, smoothPeriod = 3) {
  const len = closes.length;
  const e21 = ema21Arr || emaSeries(closes, 21);
  const atr = atr14Arr || atrSeries(bars, 14);
  const raw = new Array(len).fill(NaN);
  for (let i = 0; i < len; i++) {
    if (Number.isFinite(e21[i]) && Number.isFinite(atr[i]) && atr[i] > 0) {
      raw[i] = ((closes[i] - e21[i]) / (3.0 * atr[i])) * 100.0;
    }
  }
  const osc = emaSeries(raw.map(v => Number.isFinite(v) ? v : 0), smoothPeriod);

  const last = len - 1;
  const curr = last >= 0 ? osc[last] : NaN;
  const prev = last >= 1 ? osc[last - 1] : NaN;

  const zone = !Number.isFinite(curr) ? "NEUTRAL"
    : Math.abs(curr) >= 100 ? "EXTREME"
    : Math.abs(curr) >= 61.8 ? "HIGH"
    : Math.abs(curr) >= 23.6 ? "MEDIUM"
    : "LOW";

  const leavingExtUp  = Number.isFinite(prev) && Number.isFinite(curr) && prev >= 100  && curr < 100;
  const leavingDistrib = Number.isFinite(prev) && Number.isFinite(curr) && prev >= 61.8 && curr < 61.8;
  const leavingAccum  = Number.isFinite(prev) && Number.isFinite(curr) && prev <= -61.8 && curr > -61.8;
  const leavingExtDn  = Number.isFinite(prev) && Number.isFinite(curr) && prev <= -100  && curr > -100;

  return {
    series: osc,
    value: Number.isFinite(curr) ? Math.round(curr * 100) / 100 : 0,
    prev: Number.isFinite(prev) ? Math.round(prev * 100) / 100 : 0,
    zone,
    leaving: {
      extUp: leavingExtUp,
      distrib: leavingDistrib,
      accum: leavingAccum,
      extDn: leavingExtDn,
    },
  };
}

/**
 * Detect regular divergence by comparing the last two price swing pivots
 * against an aligned oscillator series.
 *
 * Bearish regular: price higher-high + oscillator lower-high
 * Bullish regular: price lower-low  + oscillator higher-low
 *
 * @param {Array} bars         - OHLC bars sorted ascending { o, h, l, c, ts }
 * @param {number[]} valueArr  - oscillator series aligned with bars
 * @param {number} pivotLookback - bars on each side for swing pivot
 * @param {number} maxAge      - max bars since most-recent pivot to consider active
 * @returns {{ bear: {active,strength,barsSince}|null, bull: {active,strength,barsSince}|null }}
 */
export function detectSeriesDivergence(bars, valueArr, pivotLookback = 5, maxAge = 10) {
  const result = { bear: null, bull: null };
  if (!bars || !valueArr || bars.length < pivotLookback * 2 + 2) return result;

  const pivots = findSwingPivots(bars, pivotLookback);
  const lastIdx = bars.length - 1;

  if (pivots.highs.length >= 2) {
    const h1 = pivots.highs[pivots.highs.length - 2];
    const h2 = pivots.highs[pivots.highs.length - 1];
    const barsSince = lastIdx - h2.idx;
    const v1 = valueArr[h1.idx];
    const v2 = valueArr[h2.idx];
    if (Number.isFinite(v1) && Number.isFinite(v2) && h2.price > h1.price && v2 < v1) {
      result.bear = {
        active: barsSince <= maxAge,
        strength: Math.round((v1 - v2) * 10) / 10,
        barsSince,
      };
    }
  }

  if (pivots.lows.length >= 2) {
    const l1 = pivots.lows[pivots.lows.length - 2];
    const l2 = pivots.lows[pivots.lows.length - 1];
    const barsSince = lastIdx - l2.idx;
    const v1 = valueArr[l1.idx];
    const v2 = valueArr[l2.idx];
    if (Number.isFinite(v1) && Number.isFinite(v2) && l2.price < l1.price && v2 > v1) {
      result.bull = {
        active: barsSince <= maxAge,
        strength: Math.round((v2 - v1) * 10) / 10,
        barsSince,
      };
    }
  }

  return result;
}

/**
 * Detect RSI divergence by comparing last two swing pivots (price vs RSI).
 */
export function detectRsiDivergence(bars, rsiArr, pivotLookback = 5, maxAge = 10) {
  return detectSeriesDivergence(bars, rsiArr, pivotLookback, maxAge);
}

/**
 * Standard deviation series (population stdev, matching Pine ta.stdev).
 */
export function stdevSeries(values, period) {
  const out = new Array(values.length).fill(NaN);
  if (values.length < period) return out;
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += values[j];
    const mean = sum / period;
    let sqSum = 0;
    for (let j = i - period + 1; j <= i; j++) sqSum += (values[j] - mean) ** 2;
    out[i] = Math.sqrt(sqSum / period);
  }
  return out;
}

/**
 * RSI series (Wilder's RSI, matching Pine ta.rsi).
 * @param {number[]} closes
 * @param {number} period
 * @returns {number[]}
 */
export function rsiSeries(closes, period = 14) {
  const out = new Array(closes.length).fill(NaN);
  if (closes.length < period + 1) return out;

  const gains = new Array(closes.length).fill(0);
  const losses = new Array(closes.length).fill(0);
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    gains[i] = diff > 0 ? diff : 0;
    losses[i] = diff < 0 ? -diff : 0;
  }

  // RMA of gains and losses (Pine uses ta.rma internally)
  const avgGain = rmaSeries(gains, period);
  const avgLoss = rmaSeries(losses, period);

  for (let i = 0; i < closes.length; i++) {
    if (!Number.isFinite(avgGain[i]) || !Number.isFinite(avgLoss[i])) continue;
    if (avgLoss[i] === 0) {
      out[i] = 100;
    } else {
      const rs = avgGain[i] / avgLoss[i];
      out[i] = 100 - 100 / (1 + rs);
    }
  }
  return out;
}

/**
 * SuperTrend series (matching Pine ta.supertrend).
 * @param {Array<{h:number,l:number,c:number}>} bars
 * @param {number} factor - ATR multiplier (default 3.0)
 * @param {number} atrLen - ATR period (default 10)
 * @returns {{ line: number[], dir: number[] }} line values and direction (-1 = bull, +1 = bear)
 */
export function superTrendSeries(bars, factor = 3.0, atrLen = 10) {
  const n = bars.length;
  const line = new Array(n).fill(NaN);
  const dir = new Array(n).fill(0);
  const atr = atrSeries(bars, atrLen);

  const upperBand = new Array(n).fill(NaN);
  const lowerBand = new Array(n).fill(NaN);

  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(atr[i])) continue;
    const hl2 = (bars[i].h + bars[i].l) / 2;
    upperBand[i] = hl2 + factor * atr[i];
    lowerBand[i] = hl2 - factor * atr[i];
  }

  // Initialize
  const firstValid = atrLen; // first bar with valid ATR
  if (firstValid >= n) return { line, dir };

  dir[firstValid] = -1; // start bullish
  line[firstValid] = lowerBand[firstValid];

  for (let i = firstValid + 1; i < n; i++) {
    if (!Number.isFinite(upperBand[i]) || !Number.isFinite(lowerBand[i])) {
      dir[i] = dir[i - 1];
      line[i] = line[i - 1];
      continue;
    }

    // Constrain bands
    if (Number.isFinite(lowerBand[i - 1]) && lowerBand[i] < lowerBand[i - 1] && bars[i - 1].c > lowerBand[i - 1]) {
      lowerBand[i] = lowerBand[i - 1];
    }
    if (Number.isFinite(upperBand[i - 1]) && upperBand[i] > upperBand[i - 1] && bars[i - 1].c < upperBand[i - 1]) {
      upperBand[i] = upperBand[i - 1];
    }

    const prevDir = dir[i - 1];
    if (prevDir === -1) {
      // Was bullish
      if (bars[i].c < lowerBand[i]) {
        dir[i] = 1; // flip to bearish
        line[i] = upperBand[i];
      } else {
        dir[i] = -1;
        line[i] = lowerBand[i];
      }
    } else {
      // Was bearish
      if (bars[i].c > upperBand[i]) {
        dir[i] = -1; // flip to bullish
        line[i] = lowerBand[i];
      } else {
        dir[i] = 1;
        line[i] = upperBand[i];
      }
    }
  }
  return { line, dir };
}

/**
 * Linear regression value (matching Pine ta.linreg).
 * Returns the linear regression value at the end of the lookback window for each point.
 * @param {number[]} values
 * @param {number} period
 * @returns {number[]}
 */
export function linregSeries(values, period) {
  const out = new Array(values.length).fill(NaN);
  if (values.length < period) return out;
  for (let i = period - 1; i < values.length; i++) {
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    for (let j = 0; j < period; j++) {
      const x = j;
      const y = values[i - period + 1 + j];
      sumX += x;
      sumY += y;
      sumXY += x * y;
      sumX2 += x * x;
    }
    const denom = period * sumX2 - sumX * sumX;
    if (denom === 0) { out[i] = values[i]; continue; }
    const slope = (period * sumXY - sumX * sumY) / denom;
    const intercept = (sumY - slope * sumX) / period;
    out[i] = intercept + slope * (period - 1); // value at last point
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ICHIMOKU KINKO HYO — Full native computation
// Components: Tenkan-Sen, Kijun-Sen, Senkou Span A/B, Chikou Span
// Derived signals: TK Cross, Price vs Cloud, Cloud Color/Thickness,
//   Chikou Confirmation, Kumo Twist, Kijun Slope, Overextension
// ═══════════════════════════════════════════════════════════════════════════════

function highestHigh(bars, period, endIdx) {
  let max = -Infinity;
  const start = Math.max(0, endIdx - period + 1);
  for (let i = start; i <= endIdx; i++) max = Math.max(max, bars[i].h);
  return max;
}

function lowestLow(bars, period, endIdx) {
  let min = Infinity;
  const start = Math.max(0, endIdx - period + 1);
  for (let i = start; i <= endIdx; i++) min = Math.min(min, bars[i].l);
  return min;
}

/**
 * Full Ichimoku computation from OHLCV bars.
 * Returns all 5 lines + derived signals for the most recent bar.
 *
 * Periods: Tenkan=9, Kijun=26, Senkou B=52, displacement=26
 * Minimum bars needed: 78 (52 + 26 for full cloud displacement).
 * Gracefully degrades with fewer bars (returns partial data with flags).
 *
 * @param {Array<{h:number,l:number,c:number}>} bars - sorted ascending by time
 * @param {number} [atr14] - ATR(14) for normalization (optional, for thickness/spread)
 * @returns {object|null} Ichimoku state or null if insufficient data
 */
export function computeIchimoku(bars, atr14 = 0) {
  if (!bars || bars.length < 26) return null;

  const n = bars.length;
  const last = n - 1;
  const px = bars[last].c;

  // ── Core Lines ──
  const tenkan = (highestHigh(bars, 9, last) + lowestLow(bars, 9, last)) / 2;
  const kijun  = (highestHigh(bars, 26, last) + lowestLow(bars, 26, last)) / 2;

  // Senkou Span A = (Tenkan + Kijun) / 2 (current value; would be plotted 26 ahead)
  const senkouA = (tenkan + kijun) / 2;

  // Senkou Span B = midpoint of 52-period high/low (current; plotted 26 ahead)
  const hasFull52 = n >= 52;
  const senkouB = hasFull52
    ? (highestHigh(bars, 52, last) + lowestLow(bars, 52, last)) / 2
    : (highestHigh(bars, n, last) + lowestLow(bars, n, last)) / 2;

  // Chikou Span = current close compared to price 26 bars ago
  const chikouRef = last >= 26 ? bars[last - 26].c : null;

  // ── Previous-bar values (for cross detection) ──
  let tenkanPrev = NaN, kijunPrev = NaN;
  if (last >= 1) {
    const p = last - 1;
    tenkanPrev = (highestHigh(bars, 9, p) + lowestLow(bars, 9, p)) / 2;
    kijunPrev  = (highestHigh(bars, 26, p) + lowestLow(bars, 26, p)) / 2;
  }

  // Kijun 5 bars ago (for slope)
  let kijun5Ago = NaN;
  if (last >= 5) {
    const p5 = last - 5;
    kijun5Ago = (highestHigh(bars, 26, p5) + lowestLow(bars, 26, p5)) / 2;
  }

  // ── Derived Signals ──

  // TK Cross: Tenkan crossing Kijun
  const tkBull = tenkan > kijun;
  const tkCrossUp = Number.isFinite(tenkanPrev) && tenkanPrev <= kijunPrev && tenkan > kijun;
  const tkCrossDn = Number.isFinite(tenkanPrev) && tenkanPrev >= kijunPrev && tenkan < kijun;

  // Cloud boundaries (the cloud that price is interacting with NOW is the one
  // computed 26 bars ago — i.e., Senkou A/B from bar[last-26])
  let cloudTop, cloudBase;
  if (last >= 26 && n >= 52) {
    const sA26 = ((highestHigh(bars, 9, last - 26) + lowestLow(bars, 9, last - 26)) / 2
                + (highestHigh(bars, 26, last - 26) + lowestLow(bars, 26, last - 26)) / 2) / 2;
    const sB26 = last >= 52
      ? (highestHigh(bars, 52, last - 26) + lowestLow(bars, 52, last - 26)) / 2
      : senkouB;
    cloudTop  = Math.max(sA26, sB26);
    cloudBase = Math.min(sA26, sB26);
  } else {
    cloudTop  = Math.max(senkouA, senkouB);
    cloudBase = Math.min(senkouA, senkouB);
  }

  // Price vs Cloud
  let priceVsCloud = "inside";
  if (px > cloudTop) priceVsCloud = "above";
  else if (px < cloudBase) priceVsCloud = "below";

  // Cloud color (future cloud — the one being projected now)
  const cloudBullish = senkouA > senkouB;

  // Cloud thickness normalized by ATR (0 = razor thin, >2 = very thick)
  const rawThickness = Math.abs(senkouA - senkouB);
  const cloudThickness = (atr14 > 0) ? rawThickness / atr14 : 0;

  // Chikou confirmation: current close vs price 26 bars ago
  let chikouAbove = null;
  if (chikouRef != null) {
    chikouAbove = px > chikouRef;
  }

  // Kumo twist detection (future cloud color change)
  // Compare current Senkou A vs B relationship to 5 bars ago
  let kumoTwist = false;
  if (last >= 5 && n >= 52) {
    const p5 = last - 5;
    const sA5ago = ((highestHigh(bars, 9, p5) + lowestLow(bars, 9, p5)) / 2
                  + (highestHigh(bars, 26, p5) + lowestLow(bars, 26, p5)) / 2) / 2;
    const sB5ago = (highestHigh(bars, 52, p5) + lowestLow(bars, 52, p5)) / 2;
    const wasBullish = sA5ago > sB5ago;
    if (wasBullish !== cloudBullish) kumoTwist = true;
  }

  // TK Spread: how far apart Tenkan and Kijun are (normalized by ATR)
  // Wide = trending, narrow = consolidating/choppy
  const tkSpread = (atr14 > 0) ? (tenkan - kijun) / atr14 : 0;

  // Kijun slope: rising/falling/flat
  let kijunSlope = 0;
  if (Number.isFinite(kijun5Ago) && atr14 > 0) {
    kijunSlope = (kijun - kijun5Ago) / atr14;
  }

  // Price-to-Kijun distance (overextension gauge)
  const priceToKijun = (atr14 > 0) ? (px - kijun) / atr14 : 0;

  return {
    tenkan, kijun, senkouA, senkouB, chikouRef,
    cloudTop, cloudBase,
    tkBull, tkCrossUp, tkCrossDn,
    priceVsCloud,       // "above" | "below" | "inside"
    cloudBullish,       // Senkou A > Senkou B (future cloud is green)
    cloudThickness,     // ATR-normalized, 0 = thin, >2 = thick
    chikouAbove,        // true/false/null
    kumoTwist,          // recent Senkou A/B crossover
    tkSpread,           // ATR-normalized, + = bull, - = bear, near 0 = chop
    kijunSlope,         // ATR-normalized, + = rising, - = falling
    priceToKijun,       // ATR-normalized distance from equilibrium
  };
}

/**
 * Ichimoku score for a single timeframe.
 * Converts the qualitative Ichimoku signals into a numerical score.
 * Range: -43 to +43 (clamped to ±50 for safety).
 *
 * Scoring breakdown:
 *   TK relationship (±8): Tenkan above/below Kijun
 *   Price vs Cloud (±12): Above/below/inside the Kumo
 *   Cloud color (±5): Future cloud bullish/bearish
 *   Chikou confirmation (±8): Price vs 26-bar-ago price
 *   Kijun slope (±5): Equilibrium line direction
 *   Cloud thickness bonus (0-5): Thick cloud = strong conviction
 *   Overextension penalty (-5 to 0): Too far from Kijun = mean reversion risk
 */
export function computeIchimokuScore(ich) {
  if (!ich) return 0;

  let score = 0;

  // TK relationship: ±8
  score += ich.tkBull ? 8 : -8;

  // Price vs Cloud: ±12
  if (ich.priceVsCloud === "above") score += 12;
  else if (ich.priceVsCloud === "below") score -= 12;
  // "inside" = 0, intentionally neutral

  // Cloud color (future trend direction): ±5
  score += ich.cloudBullish ? 5 : -5;

  // Chikou confirmation: ±8
  if (ich.chikouAbove === true) score += 8;
  else if (ich.chikouAbove === false) score -= 8;
  // null (insufficient data) = 0

  // Kijun slope: ±5 (clamped, normalized by ATR)
  if (Number.isFinite(ich.kijunSlope)) {
    const slopeContrib = Math.max(-1, Math.min(1, ich.kijunSlope * 2)) * 5;
    score += slopeContrib;
  }

  // Cloud thickness bonus: 0-5 (thick cloud amplifies conviction)
  if (Number.isFinite(ich.cloudThickness) && ich.cloudThickness > 0.5) {
    const thickBonus = Math.min(5, (ich.cloudThickness - 0.5) * 3.33);
    // Bonus is directional: amplifies the current trend
    score += (score > 0 ? thickBonus : -thickBonus);
  }

  // Overextension penalty: 0 to -5 (too far from Kijun = reversion risk)
  if (Number.isFinite(ich.priceToKijun)) {
    const dist = Math.abs(ich.priceToKijun);
    if (dist > 2.0) {
      const penalty = Math.min(5, (dist - 2.0) * 2.5);
      // Penalty always pulls toward zero
      score += (score > 0 ? -penalty : penalty);
    }
  }

  return Math.max(-50, Math.min(50, score));
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPOSITE BUNDLE: Mirrors Pine Script f_tf_bundle()
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// SMC / ICT INDICATORS
// Premium/Discount Zones, Fair Value Gaps, Liquidity Zone Detection
// Ported from LuxAlgo Smart Money Concepts & ICT Concepts Pine Scripts
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Premium / Discount Zone detection.
 * Uses trailing swing extremes (highest high / lowest low over lookback)
 * to define PDZ zones matching the LuxAlgo Pine implementation.
 *
 * Premium  = top 5% of swing range  (sell/trim territory)
 * Discount = bottom 5% of swing range (buy/hold territory)
 * Equilibrium = middle band around 50% of range
 *
 * @param {Array} bars - OHLCV candle array sorted ascending
 * @param {number} atr - ATR(14) for the timeframe
 * @returns {{ zone: string, pct: number, swingHigh: number, swingLow: number,
 *             premiumLine: number, discountLine: number, eqHigh: number, eqLow: number }}
 */
export function computePDZ(bars, atr) {
  const DEFAULT = { zone: "unknown", pct: 50, swingHigh: 0, swingLow: 0,
    premiumLine: 0, discountLine: 0, eqHigh: 0, eqLow: 0 };
  if (!bars || bars.length < 20) return DEFAULT;

  // Lookback: 50 bars (matches Pine swingsLengthInput default)
  const lookback = Math.min(50, bars.length);
  const recentBars = bars.slice(-lookback);

  let swingHigh = -Infinity;
  let swingLow = Infinity;
  for (const b of recentBars) {
    if (b.h > swingHigh) swingHigh = b.h;
    if (b.l < swingLow) swingLow = b.l;
  }

  const range = swingHigh - swingLow;
  if (range <= 0 || !Number.isFinite(range)) return DEFAULT;

  const px = bars[bars.length - 1].c;

  // Zone boundaries matching Pine: 95% from bottom = premium line, 5% = discount line
  const premiumLine = swingLow + 0.95 * range;   // = 0.95*top + 0.05*bottom
  const discountLine = swingLow + 0.05 * range;  // = 0.05*top + 0.95*bottom
  const eqHigh = swingLow + 0.525 * range;       // equilibrium upper
  const eqLow = swingLow + 0.475 * range;        // equilibrium lower

  // Price position as percentage of range (0 = at swing low, 100 = at swing high)
  const pct = Math.max(0, Math.min(100, Math.round(((px - swingLow) / range) * 1000) / 10));

  let zone;
  if (px >= premiumLine) zone = "premium";
  else if (px <= discountLine) zone = "discount";
  else if (px >= eqLow && px <= eqHigh) zone = "equilibrium";
  else if (px > eqHigh) zone = "premium_approach";
  else zone = "discount_approach";

  return { zone, pct, swingHigh, swingLow, premiumLine, discountLine, eqHigh, eqLow };
}

/**
 * Fair Value Gap detection.
 * 3-candle pattern: a gap between candle[i].low and candle[i-2].high (bullish)
 * or candle[i].high and candle[i-2].low (bearish).
 *
 * Tracks active (unfilled) vs mitigated FVGs within recent history.
 *
 * @param {Array} bars - OHLCV candle array sorted ascending
 * @param {number} atr - ATR(14) for significance filtering
 * @returns {{ activeBull: number, activeBear: number, inBullGap: boolean, inBearGap: boolean,
 *             nearestBullDist: number, nearestBearDist: number, fvgs: Array }}
 */
export function detectFVGs(bars, atr) {
  const DEFAULT = { activeBull: 0, activeBear: 0, inBullGap: false, inBearGap: false,
    nearestBullDist: Infinity, nearestBearDist: Infinity, fvgs: [] };
  if (!bars || bars.length < 10) return DEFAULT;

  const fvgs = [];
  // Scan last 100 bars for FVG formation (matching LuxAlgo's reasonable window)
  const scanStart = Math.max(2, bars.length - 100);

  for (let i = scanStart; i < bars.length; i++) {
    const curr = bars[i];
    const prev = bars[i - 1]; // middle candle
    const prev2 = bars[i - 2];

    // Bullish FVG: current candle's low > two-candles-ago high (gap up)
    if (curr.l > prev2.h) {
      const gapSize = curr.l - prev2.h;
      // Auto-threshold: filter out insignificant gaps (< 10% of ATR)
      if (atr > 0 && gapSize < atr * 0.1) continue;
      fvgs.push({
        type: "bull",
        top: curr.l,
        bottom: prev2.h,
        mid: (curr.l + prev2.h) / 2,
        ts: prev.ts || 0,
        mitigated: false,
      });
    }

    // Bearish FVG: current candle's high < two-candles-ago low (gap down)
    if (curr.h < prev2.l) {
      const gapSize = prev2.l - curr.h;
      if (atr > 0 && gapSize < atr * 0.1) continue;
      fvgs.push({
        type: "bear",
        top: prev2.l,
        bottom: curr.h,
        mid: (prev2.l + curr.h) / 2,
        ts: prev.ts || 0,
        mitigated: false,
      });
    }
  }

  // Check mitigation: FVG is mitigated when price returns through it
  // For each FVG, scan bars AFTER its formation to see if price filled the gap
  const px = bars[bars.length - 1].c;
  for (const gap of fvgs) {
    // Find the bar index where this FVG formed (the middle candle timestamp)
    let formIdx = scanStart;
    for (let k = scanStart; k < bars.length; k++) {
      if ((bars[k].ts || 0) >= gap.ts) { formIdx = k; break; }
    }
    if (gap.type === "bull") {
      for (let k = formIdx + 1; k < bars.length; k++) {
        if (bars[k].l < gap.bottom) { gap.mitigated = true; break; }
      }
    } else {
      for (let k = formIdx + 1; k < bars.length; k++) {
        if (bars[k].h > gap.top) { gap.mitigated = true; break; }
      }
    }
  }

  // Separate active gaps
  const activeBull = fvgs.filter(g => g.type === "bull" && !g.mitigated);
  const activeBear = fvgs.filter(g => g.type === "bear" && !g.mitigated);

  // Check if price is currently inside an active FVG
  const inBullGap = activeBull.some(g => px >= g.bottom && px <= g.top);
  const inBearGap = activeBear.some(g => px >= g.bottom && px <= g.top);

  // Nearest active FVG distance (in ATR units)
  let nearestBullDist = Infinity;
  let nearestBearDist = Infinity;
  for (const g of activeBull) {
    const dist = px > g.top ? (px - g.top) : px < g.bottom ? (g.bottom - px) : 0;
    const distAtr = atr > 0 ? dist / atr : dist;
    if (distAtr < nearestBullDist) nearestBullDist = distAtr;
  }
  for (const g of activeBear) {
    const dist = px > g.top ? (px - g.top) : px < g.bottom ? (g.bottom - px) : 0;
    const distAtr = atr > 0 ? dist / atr : dist;
    if (distAtr < nearestBearDist) nearestBearDist = distAtr;
  }

  return {
    activeBull: activeBull.length,
    activeBear: activeBear.length,
    inBullGap,
    inBearGap,
    nearestBullDist: Number.isFinite(nearestBullDist) ? Math.round(nearestBullDist * 100) / 100 : -1,
    nearestBearDist: Number.isFinite(nearestBearDist) ? Math.round(nearestBearDist * 100) / 100 : -1,
    fvgs: fvgs.filter(g => !g.mitigated).slice(-10), // keep last 10 active
  };
}

/**
 * FVG Imbalance Detector — combines unfilled FVGs and unswept liquidity
 * with 21 EMA proximity to produce a structural imbalance score.
 *
 * @param {Array} bars - OHLCV candle array (Daily or 1H) sorted ascending
 * @param {number} atr - ATR(14)
 * @returns {{ unfilled_below: number, unfilled_above: number,
 *             ssl_below: number, bsl_above: number,
 *             downside_magnets: number, upside_magnets: number,
 *             ema21_dist_pct: number, ema21_price: number,
 *             imbalance_direction: string }}
 */
/**
 * Overload 1: raw bars → compute from scratch.
 * Overload 2: pre-computed bundle → assemble from fvg/liq/ema already on bundle.
 */
export function computeFVGImbalance(barsOrBundle, atrOrNull) {
  const DEFAULT = {
    unfilled_below: 0, unfilled_above: 0,
    ssl_below: 0, bsl_above: 0,
    downside_magnets: 0, upside_magnets: 0,
    ema21_dist_pct: 0, ema21_price: 0,
    imbalance_direction: "NEUTRAL",
  };

  if (!barsOrBundle) return DEFAULT;

  let px, fvgData, liqData, ema21;

  if (Array.isArray(barsOrBundle)) {
    const bars = barsOrBundle;
    const atr = atrOrNull || 0;
    if (bars.length < 25) return DEFAULT;
    px = bars[bars.length - 1].c;
    fvgData = detectFVGs(bars, atr);
    liqData = detectLiquidityZones(bars, atr);
    const closes = bars.map(b => b.c);
    const ema21Arr = emaSeries(closes, 21);
    ema21 = ema21Arr[ema21Arr.length - 1] || px;
  } else {
    const b = barsOrBundle;
    px = b.px || 0;
    if (!px) return DEFAULT;
    fvgData = b.fvg || {};
    liqData = b.liq || {};
    ema21 = b.ema21 || b.ema?.ema21 || 0;
    if (!ema21 && b.emas) {
      const e21 = b.emas.find(e => e.period === 21);
      ema21 = e21?.value || px;
    }
  }

  const ema21DistPct = ema21 > 0 ? ((px - ema21) / ema21) * 100 : 0;

  const activeFvgs = fvgData.fvgs || [];
  const unfilledBelow = activeFvgs.filter(g => g.type === "bull" && g.mid < px).length;
  const unfilledAbove = activeFvgs.filter(g => g.type === "bear" && g.mid > px).length;

  const sslBelow = (liqData.sellside || []).filter(z => !z.swept).length;
  const bslAbove = (liqData.buyside || []).filter(z => !z.swept).length;

  const downsideMagnets = unfilledBelow + sslBelow;
  const upsideMagnets = unfilledAbove + bslAbove;

  let imbalanceDir = "NEUTRAL";
  if (downsideMagnets >= 6 && px < ema21) imbalanceDir = "SHORT_OPPORTUNITY";
  else if (upsideMagnets >= 6 && px > ema21) imbalanceDir = "LONG_OPPORTUNITY";
  else if (downsideMagnets >= 4 && downsideMagnets > upsideMagnets * 2) imbalanceDir = "BEARISH_LEAN";
  else if (upsideMagnets >= 4 && upsideMagnets > downsideMagnets * 2) imbalanceDir = "BULLISH_LEAN";

  return {
    unfilled_below: unfilledBelow,
    unfilled_above: unfilledAbove,
    ssl_below: sslBelow,
    bsl_above: bslAbove,
    downside_magnets: downsideMagnets,
    upside_magnets: upsideMagnets,
    ema21_dist_pct: Math.round(ema21DistPct * 100) / 100,
    ema21_price: Math.round(ema21 * 100) / 100,
    imbalance_direction: imbalanceDir,
  };
}

/**
 * Liquidity Zone detection.
 * Clusters pivot highs and lows at similar price levels.
 * 3+ pivots within ATR/2.5 = liquidity zone (matching ICT Pine logic where a = 10/4 = 2.5).
 * Zones are "swept" when price closes through them.
 *
 * @param {Array} bars - OHLCV candle array sorted ascending
 * @param {number} atr - ATR(14) for clustering threshold
 * @returns {{ buyside: Array, sellside: Array, nearestBuysideDist: number,
 *             nearestSellsideDist: number, buysideCount: number, sellsideCount: number }}
 */
export function detectLiquidityZones(bars, atr) {
  const DEFAULT = { buyside: [], sellside: [], nearestBuysideDist: -1,
    nearestSellsideDist: -1, buysideCount: 0, sellsideCount: 0 };
  if (!bars || bars.length < 20 || !Number.isFinite(atr) || atr <= 0) return DEFAULT;

  // Find swing pivots with lookback of 3 (matching ICT Pine left=3)
  const pivots = findSwingPivots(bars, 3);
  const threshold = atr / 2.5; // clustering margin, matches Pine atr/a where a=10/4

  // Cluster pivot highs (buyside liquidity = stops above equal highs)
  const buyside = clusterPivots(pivots.highs, threshold);
  // Cluster pivot lows (sellside liquidity = stops below equal lows)
  const sellside = clusterPivots(pivots.lows, threshold);

  const px = bars[bars.length - 1].c;

  // Check if zones have been swept
  for (const zone of buyside) {
    zone.swept = px > zone.level + threshold * 0.5;
  }
  for (const zone of sellside) {
    zone.swept = px < zone.level - threshold * 0.5;
  }

  // Filter to active (unswept) zones
  const activeBuyside = buyside.filter(z => !z.swept);
  const activeSellside = sellside.filter(z => !z.swept);

  // Nearest distances in ATR units
  let nearestBuysideDist = -1;
  let nearestSellsideDist = -1;
  for (const z of activeBuyside) {
    const dist = (z.level - px) / atr;
    if (dist > 0 && (nearestBuysideDist < 0 || dist < nearestBuysideDist)) {
      nearestBuysideDist = Math.round(dist * 100) / 100;
    }
  }
  for (const z of activeSellside) {
    const dist = (px - z.level) / atr;
    if (dist > 0 && (nearestSellsideDist < 0 || dist < nearestSellsideDist)) {
      nearestSellsideDist = Math.round(dist * 100) / 100;
    }
  }

  return {
    buyside: activeBuyside.slice(0, 5),
    sellside: activeSellside.slice(0, 5),
    nearestBuysideDist,
    nearestSellsideDist,
    buysideCount: activeBuyside.length,
    sellsideCount: activeSellside.length,
  };
}

/**
 * Cluster pivot points at similar price levels.
 * Groups pivots within `threshold` of each other into zones.
 * @param {Array<{price:number, idx:number, ts:number}>} pivots
 * @param {number} threshold - maximum price distance for same cluster
 * @returns {Array<{level:number, count:number, firstTs:number, lastTs:number}>}
 */
function clusterPivots(pivots, threshold) {
  if (!pivots || pivots.length < 2) return [];

  // Sort by price for clustering
  const sorted = [...pivots].sort((a, b) => a.price - b.price);
  const clusters = [];
  let cluster = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].price - cluster[0].price <= threshold) {
      cluster.push(sorted[i]);
    } else {
      if (cluster.length >= 3) {
        const avg = cluster.reduce((s, p) => s + p.price, 0) / cluster.length;
        clusters.push({
          level: Math.round(avg * 100) / 100,
          count: cluster.length,
          firstTs: Math.min(...cluster.map(p => p.ts)),
          lastTs: Math.max(...cluster.map(p => p.ts)),
          swept: false,
        });
      }
      cluster = [sorted[i]];
    }
  }
  // Final cluster
  if (cluster.length >= 3) {
    const avg = cluster.reduce((s, p) => s + p.price, 0) / cluster.length;
    clusters.push({
      level: Math.round(avg * 100) / 100,
      count: cluster.length,
      firstTs: Math.min(...cluster.map(p => p.ts)),
      lastTs: Math.max(...cluster.map(p => p.ts)),
      swept: false,
    });
  }

  return clusters;
}

/**
 * Compute the full indicator bundle for a single timeframe.
 * Mirrors Pine's f_tf_bundle() which returns 25 values.
 *
 * @param {Array<{ts:number, o:number, h:number, l:number, c:number, v:number|null}>} bars
 *   Sorted ascending by ts. Need at least ~250 bars for EMA(200).
 * @param {{ PCd: number, ATRd: number, GGup: number, GGdn: number }} anchors
 *   Daily anchors for Golden Gate computation (may be null for HTF timeframes).
 * @returns {object|null} Bundle with all indicator values at the latest bar.
 */
export function computeTfBundle(bars, anchors = null) {
  // Allow short replay windows to still emit usable TF context (notably 1H).
  // EMA(48/200) fields may remain unavailable early, but RSI/ST/structure can still be computed.
  if (!bars || bars.length < 15) return null;

  const closes = bars.map(b => b.c);
  const n = bars.length;
  const last = n - 1;

  const px = closes[last];
  // Track the timestamp of the most recent bar for freshness comparison
  const lastTs = bars[last]?.ts || bars[last]?.t || 0;

  // EMAs — full TT EMA cloud set + gradient ribbon
  const e3s = emaSeries(closes, 3);
  const e5s = emaSeries(closes, 5);
  const e8s = emaSeries(closes, 8);
  const e9s = emaSeries(closes, 9);
  const e12s = emaSeries(closes, 12);
  const e13s = emaSeries(closes, 13);
  const e21s = emaSeries(closes, 21);
  const e34s = emaSeries(closes, 34);
  const e48s = emaSeries(closes, 48);
  const e50s = emaSeries(closes, 50);
  const e72s = emaSeries(closes, 72);
  const e89s = emaSeries(closes, 89);
  const e180s = emaSeries(closes, 180);
  const e200s = emaSeries(closes, 200);
  const e233s = emaSeries(closes, 233);

  const e3 = e3s[last];
  const e5 = e5s[last];
  const e8 = e8s[last];
  const e9 = e9s[last];
  const e12 = e12s[last];
  const e13 = e13s[last]; // eFast (emaFastLen=13)
  const e21 = e21s[last];
  const e34 = e34s[last];
  const e48 = e48s[last]; // eSlow (emaSlowLen=48)
  const e50 = e50s[last];
  const e72 = e72s[last];
  const e89 = e89s[last];
  const e180 = e180s[last];
  const e200 = e200s[last];
  const e233 = e233s[last];
  const eFast = e13; // Pine default emaFastLen=13
  const eSlow = e48; // Pine default emaSlowLen=48

  // ── EMA slopes (5-bar / 10-bar look-back) for structural trend detection ──
  // Used by Phase-E daily-structure gates. Compared as percent change so the
  // value is cross-ticker comparable. Daily look-backs translate to: 5-bar =
  // ~1 trading week, 10-bar = ~2 weeks.
  const slopeBars5 = Math.min(5, last);
  const slopeBars10 = Math.min(10, last);
  const e21_5bar_ago = Number.isFinite(e21s[last - slopeBars5]) ? e21s[last - slopeBars5] : null;
  const e48_10bar_ago = Number.isFinite(e48s[last - slopeBars10]) ? e48s[last - slopeBars10] : null;
  const e21_slope_5bar_pct = (Number.isFinite(e21) && Number.isFinite(e21_5bar_ago) && e21_5bar_ago > 0)
    ? ((e21 - e21_5bar_ago) / e21_5bar_ago) * 100
    : null;
  const e48_slope_10bar_pct = (Number.isFinite(e48) && Number.isFinite(e48_10bar_ago) && e48_10bar_ago > 0)
    ? ((e48 - e48_10bar_ago) / e48_10bar_ago) * 100
    : null;

  // ── EMA TRIPLET: depth, structure, momentum ──
  //
  // emaDepth (0-10): How many EMAs price is above. Direct conviction ladder.
  //   10 = extremely bullish (above 3 EMA), 0 = extremely bearish (below 233 EMA)
  //   5 = pivot zone (around 21 EMA). Fluid — expect pullbacks on shorter EMAs.
  //
  // emaStructure (-1 to +1): Macro trend from long EMAs (34/48/89/200/233).
  //   Changes slowly. Used for HTF scoring and entry qualification.
  //   200/233 get heaviest weight — they define the structural regime.
  //
  // emaMomentum (-1 to +1): Current impulse from short EMAs (3/5/8/13/21).
  //   Fluid, expects pullbacks. Used for timing entries/exits.
  //   21/13 get heaviest weight — they define the swing direction.
  //
  // Key insight: divergence between structure and momentum = pullback signal.
  //   Structure > 0.5 AND Momentum < 0 = bullish pullback (gold_long zone)
  //   Structure < -0.5 AND Momentum > 0 = bearish pullback (gold_short zone)

  const ALL_EMAS = [e3, e5, e8, e9, e12, e13, e21, e34, e48, e50, e72, e89, e180, e200, e233];
  let emaDepth = 0;
  for (const val of ALL_EMAS) {
    if (Number.isFinite(val) && px > val) emaDepth++;
  }

  // Structure: macro trend from long EMAs
  const STRUCT_EMAS = [
    { val: e34,  w: 0.12 },
    { val: e48,  w: 0.18 },
    { val: e89,  w: 0.22 },
    { val: e200, w: 0.25 },
    { val: e233, w: 0.23 },
  ];
  let emaStructure = 0;
  let structWeightSum = 0;
  for (const { val, w } of STRUCT_EMAS) {
    if (!Number.isFinite(val)) continue;
    structWeightSum += w;
    if (px > val) emaStructure += w;
    else if (px < val) emaStructure -= w;
  }
  emaStructure = structWeightSum > 0 ? emaStructure / structWeightSum : 0;

  // Momentum: current impulse from short EMAs
  const MOMENTUM_EMAS = [
    { val: e3,  w: 0.10 },
    { val: e5,  w: 0.15 },
    { val: e8,  w: 0.20 },
    { val: e13, w: 0.25 },
    { val: e21, w: 0.30 },
  ];
  let emaMomentum = 0;
  let momWeightSum = 0;
  for (const { val, w } of MOMENTUM_EMAS) {
    if (!Number.isFinite(val)) continue;
    momWeightSum += w;
    if (px > val) emaMomentum += w;
    else if (px < val) emaMomentum -= w;
  }
  emaMomentum = momWeightSum > 0 ? emaMomentum / momWeightSum : 0;

  // Ribbon spread: distance between fastest and slowest EMA as % of price
  const ribbonSpread = (Number.isFinite(e3) && Number.isFinite(e233) && px > 0)
    ? Math.abs(e3 - e233) / px
    : 0;

  // SuperTrend (length=10, factor=3.0)
  const st = superTrendSeries(bars, 3.0, 10);
  const stLine = st.line[last];
  const stDir = st.dir[last];
  const stLinePrev = last > 0 ? st.line[last - 1] : stLine;

  // TTM Squeeze
  const sqLen = 20;
  const bbMult = 2.0;
  const kcMult = 1.5;
  const basisArr = smaSeries(closes, sqLen);
  const devArr = stdevSeries(closes, sqLen);
  const atrKCArr = atrSeries(bars, sqLen);

  const basis = basisArr[last];
  const dev = devArr[last];
  const atrKC = atrKCArr[last];
  let sqOn = false;
  if (Number.isFinite(basis) && Number.isFinite(dev) && Number.isFinite(atrKC)) {
    const bbU = basis + bbMult * dev;
    const bbL = basis - bbMult * dev;
    const kcU = basis + kcMult * atrKC;
    const kcL = basis - kcMult * atrKC;
    sqOn = (bbU < kcU) && (bbL > kcL);
  }

  // Previous sqOn for release detection
  let sqOnPrev = false;
  if (last > 0 && Number.isFinite(basisArr[last - 1]) && Number.isFinite(devArr[last - 1]) && Number.isFinite(atrKCArr[last - 1])) {
    const bbU2 = basisArr[last - 1] + bbMult * devArr[last - 1];
    const bbL2 = basisArr[last - 1] - bbMult * devArr[last - 1];
    const kcU2 = basisArr[last - 1] + kcMult * atrKCArr[last - 1];
    const kcL2 = basisArr[last - 1] - kcMult * atrKCArr[last - 1];
    sqOnPrev = (bbU2 < kcU2) && (bbL2 > kcL2);
  }

  const sqRelease = sqOnPrev && !sqOn;
  const sqRelease_ts = sqRelease ? bars[last].ts : 0;

  // Momentum: linreg(close - SMA(close, 20), 20, 0)
  const momLen = 20;
  const sma20Arr = smaSeries(closes, momLen);
  const diff = closes.map((c, i) => Number.isFinite(sma20Arr[i]) ? c - sma20Arr[i] : NaN);
  const momArr = linregSeries(diff, momLen);
  const mom = momArr[last];
  const momStdArr = stdevSeries(momArr.map(v => Number.isFinite(v) ? v : 0), 20);
  const momStd = momStdArr[last];

  // Volume + Enhanced RVOL
  const vols = bars.map(b => b.v || 0);
  const volSmaArr = smaSeries(vols, 20);
  const volSma = volSmaArr[last];
  const volRatio = (volSma > 0 && vols[last] > 0) ? vols[last] / volSma : 1.0;

  // ── VWAP (V15 P0.7.33, 2026-04-30) ─────────────────────────────────────
  //
  // Volume-weighted average price. Two flavors:
  //   - Cumulative (from start of bar series): useful on Daily+ for
  //     long-term anchored reference
  //   - Session/rolling 20-bar: approximates intraday session VWAP on
  //     LTF (10m/30m). On 30m TF, 20 bars ≈ 10 hours = ~1.5 sessions
  //
  // Per-bar typical price: (h+l+c)/3. Standard formula.
  // Distance: (px - vwap) / vwap * 100 — % above/below.
  // Slope: 5-bar % change of VWAP series.
  // touchedVwapBars: bars-since the close last crossed VWAP (i.e. a
  //   reaction to VWAP). Useful entry/exit signal.
  //
  // No-volume defenses: when vols are all 0 (some TFs may not carry
  // volume), VWAP collapses to typical-price SMA — still useful as
  // an "average price" reference.
  let vwap = null;
  let vwapRolling20 = null;
  let vwapDistPct = null;
  let vwapSlope5bar = null;
  let vwapAbove = null;
  let vwapTouchBars = null;
  try {
    const typPrice = (i) => {
      const h = Number(bars[i]?.h);
      const l = Number(bars[i]?.l);
      const c = Number(bars[i]?.c);
      const o = Number(bars[i]?.o);
      const goodH = Number.isFinite(h) ? h : c;
      const goodL = Number.isFinite(l) ? l : c;
      const goodC = Number.isFinite(c) ? c : o;
      return (goodH + goodL + goodC) / 3;
    };
    // Cumulative VWAP — running weighted avg over full bar series
    let cumPv = 0; let cumV = 0;
    const vwapSeries = [];
    for (let i = 0; i < n; i++) {
      const tp = typPrice(i);
      const v = vols[i] || 1; // when vols is empty, fall back to typPrice SMA
      cumPv += tp * v;
      cumV += v;
      vwapSeries.push(cumV > 0 ? cumPv / cumV : null);
    }
    vwap = vwapSeries[last];

    // Rolling 20-bar VWAP — closer approximation to intraday session VWAP
    if (n >= 20) {
      let pv20 = 0; let v20 = 0;
      for (let i = last - 19; i <= last; i++) {
        const tp = typPrice(i);
        const v = vols[i] || 1;
        pv20 += tp * v;
        v20 += v;
      }
      vwapRolling20 = v20 > 0 ? pv20 / v20 : null;
    }

    // Distance and slope (using cumulative VWAP as primary reference)
    if (Number.isFinite(vwap) && vwap > 0 && Number.isFinite(px)) {
      vwapDistPct = ((px - vwap) / vwap) * 100;
      vwapAbove = px > vwap;
    }
    if (n >= 6) {
      const vwapPrev = vwapSeries[last - 5];
      if (Number.isFinite(vwap) && Number.isFinite(vwapPrev) && vwapPrev > 0) {
        vwapSlope5bar = ((vwap - vwapPrev) / vwapPrev) * 100;
      }
    }

    // Touch detection — bars-since price last crossed VWAP (close)
    if (n >= 2 && Number.isFinite(vwap)) {
      let bSince = 0;
      const aboveNow = closes[last] >= (vwapSeries[last] || vwap);
      for (let i = last - 1; i >= 0 && i >= last - 50; i--) {
        const v = vwapSeries[i];
        if (!Number.isFinite(v)) break;
        const aboveThen = closes[i] >= v;
        if (aboveThen !== aboveNow) {
          // Found the most-recent cross
          break;
        }
        bSince++;
      }
      vwapTouchBars = bSince;
    }
  } catch (_) { /* silent — vwap stays null */ }
  // ── END VWAP ──────────────────────────────────────────────────────────

  // RVOL 5-bar: recent volume trend vs 20-bar average
  let rvol5 = 1.0;
  if (volSma > 0 && last >= 4) {
    let sum5 = 0;
    for (let i = last - 4; i <= last; i++) sum5 += (vols[i] || 0);
    rvol5 = (sum5 / 5) / volSma;
  }

  // RVOL spike: current bar vs max of last 20 bars (breakout detection)
  let rvolSpike = 0;
  if (last >= 19 && vols[last] > 0) {
    let maxVol = 0;
    for (let i = last - 19; i < last; i++) maxVol = Math.max(maxVol, vols[i] || 0);
    rvolSpike = maxVol > 0 ? vols[last] / maxVol : 0;
  }

  // RSI
  const rsiArr = rsiSeries(closes, 14);
  const rsi = rsiArr[last];

  // V15 P0.2 — RSI 5-bar slope (in RSI points per bar). Used by the
  // focus-tier slope alignment signal: a SHORT entered when RSI is
  // sloping up against direction is a fade trap.
  let rsi_slope_5bar = null;
  if (rsiArr.length >= 6) {
    const _rsiNow = rsiArr[rsiArr.length - 1];
    const _rsiThen = rsiArr[rsiArr.length - 6];
    if (Number.isFinite(_rsiNow) && Number.isFinite(_rsiThen)) {
      rsi_slope_5bar = Math.round(((_rsiNow - _rsiThen) / 5) * 100) / 100;
    }
  }

  // RSI Divergence
  const rsiDiv = detectRsiDivergence(bars, rsiArr, 5, 10);

  // Multi-factor Phase
  const piv = e21;
  const atr14Arr = atrSeries(bars, 14);
  const atr14 = atr14Arr[last];
  const atr14Prev = last > 0 ? atr14Arr[last - 1] : atr14;

  let pricePhase = 0;
  if (Number.isFinite(atr14) && atr14 > 0 && Number.isFinite(piv)) {
    pricePhase = ((px - piv) / (3.0 * atr14)) * 100.0;
  }
  const momentumPhase = (Number.isFinite(momStd) && momStd > 0 && Number.isFinite(mom)) ? (mom / momStd) * 20.0 : 0;
  const volumePhase = (volRatio - 1.0) * 30.0;

  const rawPhase = pricePhase * 0.6 + momentumPhase * 0.3 + volumePhase * 0.1;

  // Phase oscillator (EMA(3) of rawPhase) — approximate using latest value
  // For a proper series we'd compute rawPhase for all bars; approximate with single value
  const phaseOsc = rawPhase; // simplified; EMA(3) ≈ raw for latest bar
  const phaseAbs = Math.abs(phaseOsc);
  const phaseZone = phaseAbs > 100 ? "EXTREME" : phaseAbs > 61.8 ? "HIGH" : phaseAbs > 38.2 ? "MEDIUM" : "LOW";

  // Phase velocity (approximate)
  const phaseVelocity = 0; // Would need previous rawPhase; set to 0

  // V15 P0.2 — Phase slope (5-bar). Derived from the momentum series
  // since phase is mostly driven by mom/momStd. Sign tells us direction:
  //   positive → phase trending up (bullish-aligned)
  //   negative → phase trending down (bearish-aligned)
  // Used by focus-tier slope alignment signal.
  let phase_slope_5bar = null;
  if (momArr.length >= 6 && Number.isFinite(momStd) && momStd > 0) {
    const _momNow = momArr[momArr.length - 1];
    const _momThen = momArr[momArr.length - 6];
    if (Number.isFinite(_momNow) && Number.isFinite(_momThen)) {
      // Normalize by momStd so cross-ticker comparable; scale to phase units
      phase_slope_5bar = Math.round((((_momNow - _momThen) / 5) / momStd) * 20 * 100) / 100;
    }
  }

  // TT Phase Oscillator — pure price-displacement with EMA(3) smoothing
  // Computes full series for proper zone-exit detection (prev bar vs current bar)
  const satyPhase = satyPhaseSeries(bars, closes, e21s, atr14Arr, 3);
  const phaseDiv = detectSeriesDivergence(bars, satyPhase.series, 2, 12);

  // Compression (Bollinger expansion logic from Pine)
  let compressed = false;
  if (Number.isFinite(piv) && Number.isFinite(atr14)) {
    const bbo = 2.0 * (Number.isFinite(dev) ? dev : 0);
    const bup = piv + bbo;
    const bdn = piv - bbo;
    const ctU = piv + 2.0 * atr14;
    const ctD = piv - 2.0 * atr14;
    const exU = piv + 1.854 * atr14;
    const exD = piv - 1.854 * atr14;
    const above = px >= piv;
    const comp = above ? (bup - ctU) : (ctD - bdn);
    const inExp = above ? (bup - exU) : (exD - bdn);
    // Approximate expanding from previous bar (simplified)
    compressed = comp <= 0;
  }

  // ATR ratio
  const atrSma20Arr = smaSeries(atr14Arr.filter(Number.isFinite), 20);
  const atrSma20 = atrSma20Arr[atrSma20Arr.length - 1];
  const atrRatio = (Number.isFinite(atrSma20) && atrSma20 > 0) ? atr14 / atrSma20 : 1.0;

  // Golden Gate (only meaningful if daily anchors provided)
  let ggUpCross = false;
  let ggDnCross = false;
  let ggDist = 0.5;
  if (anchors && Number.isFinite(anchors.GGup) && Number.isFinite(anchors.GGdn) && Number.isFinite(anchors.PCd)) {
    const range = anchors.GGup - anchors.GGdn;
    if (range > 0) {
      ggDist = Math.max(0, Math.min(1, px >= anchors.PCd
        ? (px - anchors.GGdn) / range
        : (anchors.GGup - px) / range));
    }
    // Cross detection
    if (last > 0) {
      ggUpCross = closes[last - 1] < anchors.GGup && closes[last] >= anchors.GGup;
      ggDnCross = closes[last - 1] > anchors.GGdn && closes[last] <= anchors.GGdn;
    }
  }
  const ggUpCross_ts = ggUpCross ? bars[last].ts : 0;
  const ggDnCross_ts = ggDnCross ? bars[last].ts : 0;

  // EMA stack score (for tf_tech compatibility)
  let emaStack = 0;
  if (Number.isFinite(e5) && Number.isFinite(e8) && Number.isFinite(e13) && Number.isFinite(e21) && Number.isFinite(e48)) {
    if (e5 > e8) emaStack++;
    if (e8 > e13) emaStack++;
    if (e13 > e21) emaStack++;
    if (e21 > e48) emaStack++;
    if (e5 < e8) emaStack--;
    if (e8 < e13) emaStack--;
    if (e13 < e21) emaStack--;
    if (e21 < e48) emaStack--;
  }

  // EMA crosses (5/48) — early trend signal
  let emaCross5_48_up = false, emaCross5_48_dn = false;
  let emaCross5_48_up_ts = 0, emaCross5_48_dn_ts = 0;
  if (last > 0 && Number.isFinite(e5s[last - 1]) && Number.isFinite(e48s[last - 1])) {
    emaCross5_48_up = e5s[last - 1] <= e48s[last - 1] && e5 > e48;
    emaCross5_48_dn = e5s[last - 1] >= e48s[last - 1] && e5 < e48;
    if (emaCross5_48_up) emaCross5_48_up_ts = bars[last].ts;
    if (emaCross5_48_dn) emaCross5_48_dn_ts = bars[last].ts;
  }

  // EMA crosses (13/21) — confirmation signal
  let emaCross13_21_up = false, emaCross13_21_dn = false;
  let emaCross13_21_up_ts = 0, emaCross13_21_dn_ts = 0;
  if (last > 0 && Number.isFinite(e13s[last - 1]) && Number.isFinite(e21s[last - 1])) {
    emaCross13_21_up = e13s[last - 1] <= e21s[last - 1] && e13 > e21;
    emaCross13_21_dn = e13s[last - 1] >= e21s[last - 1] && e13 < e21;
    if (emaCross13_21_up) emaCross13_21_up_ts = bars[last].ts;
    if (emaCross13_21_dn) emaCross13_21_dn_ts = bars[last].ts;
  }

  // EMA crosses (13/48)
  let emaCross13_48_up = false;
  let emaCross13_48_dn = false;
  let emaCross13_48_up_ts = 0;
  let emaCross13_48_dn_ts = 0;
  if (last > 0 && Number.isFinite(e13s[last - 1]) && Number.isFinite(e48s[last - 1])) {
    emaCross13_48_up = e13s[last - 1] <= e48s[last - 1] && e13 > e48;
    emaCross13_48_dn = e13s[last - 1] >= e48s[last - 1] && e13 < e48;
    if (emaCross13_48_up) emaCross13_48_up_ts = bars[last].ts;
    if (emaCross13_48_dn) emaCross13_48_dn_ts = bars[last].ts;
  }

  // EMA position state (current relationship, not just cross event)
  const ema5above48 = Number.isFinite(e5) && Number.isFinite(e48) && e5 > e48;
  const ema13above21 = Number.isFinite(e13) && Number.isFinite(e21) && e13 > e21;
  const ema8above21 = Number.isFinite(e8) && Number.isFinite(e21) && e8 > e21;

  // EMA Regime: -2 (confirmed bear) to +2 (confirmed bull)
  let emaRegime = 0;
  if (ema5above48 && ema13above21) emaRegime = 2;
  else if (ema5above48 && !ema13above21) emaRegime = 1;
  else if (!ema5above48 && ema13above21) emaRegime = -1;
  else if (!ema5above48 && !ema13above21) emaRegime = -2;

  // SuperTrend slope
  const stSlopeUp = Number.isFinite(stLinePrev) ? stLine > stLinePrev : false;
  const stSlopeDn = Number.isFinite(stLinePrev) ? stLine < stLinePrev : false;

  // SuperTrend flip detection
  let stFlip = false;
  let stFlipDir = 0; // 1 = flipped to bull, -1 = flipped to bear
  let stFlip_ts = 0;
  if (last > 0) {
    const prevDir = st.dir[last - 1];
    if (prevDir !== stDir) {
      stFlip = true;
      stFlipDir = stDir === -1 ? 1 : -1; // -1 dir = bull in Pine convention
      stFlip_ts = bars[last].ts;
    }
  }

  // Bars since last ST direction change (sustained conviction measure)
  let stBarsSinceFlip = 0;
  for (let k = last; k >= Math.max(0, last - 200); k--) {
    if (st.dir[k] === stDir) stBarsSinceFlip++;
    else break;
  }

  // ── SMC: Premium / Discount Zones (PDZ) ──
  const pdz = computePDZ(bars, atr14);

  // ── SMC: Fair Value Gaps (FVG) ──
  const fvg = detectFVGs(bars, atr14);

  // ── SMC: Liquidity Zone Detection ──
  const liq = detectLiquidityZones(bars, atr14);

  // ── Ichimoku Kinko Hyo (native computation) ──
  const ichimoku = computeIchimoku(bars, atr14);

  // ── TT EMA Cloud primitives ──
  const cloudState = (fastNow, slowNow, fastPrev, slowPrev) => {
    if (!Number.isFinite(fastNow) || !Number.isFinite(slowNow)) return null;
    const lo = Math.min(fastNow, slowNow);
    const hi = Math.max(fastNow, slowNow);
    const inCloud = Number.isFinite(px) && px >= lo && px <= hi;
    const above = Number.isFinite(px) && px > hi;
    const below = Number.isFinite(px) && px < lo;
    const spread = Math.abs(fastNow - slowNow);
    const distToCloudPct = Number.isFinite(px) && px > 0
      ? Math.max(0, (above ? (px - hi) : below ? (lo - px) : 0) / px)
      : 0;
    const fastSlope = Number.isFinite(fastPrev) ? fastNow - fastPrev : 0;
    const slowSlope = Number.isFinite(slowPrev) ? slowNow - slowPrev : 0;
    const crossUp = Number.isFinite(fastPrev) && Number.isFinite(slowPrev) && fastPrev <= slowPrev && fastNow > slowNow;
    const crossDn = Number.isFinite(fastPrev) && Number.isFinite(slowPrev) && fastPrev >= slowPrev && fastNow < slowNow;
    return {
      bull: fastNow >= slowNow,
      bear: fastNow < slowNow,
      above, below, inCloud,
      lo, hi,
      spreadPct: Number.isFinite(px) && px > 0 ? spread / px : 0,
      distToCloudPct,
      fastSlope, slowSlope,
      crossUp, crossDn,
    };
  };
  const ripsterClouds = {
    c5_12: cloudState(e5, e12, e5s[last - 1], e12s[last - 1]),
    c8_9: cloudState(e8, e9, e8s[last - 1], e9s[last - 1]),
    c34_50: cloudState(e34, e50, e34s[last - 1], e50s[last - 1]),
    c72_89: cloudState(e72, e89, e72s[last - 1], e89s[last - 1]),
    c180_200: cloudState(e180, e200, e180s[last - 1], e200s[last - 1]),
  };

  // Previous bar close and current bar high/low for ATR Levels anchor data
  const pxPrev = last >= 1 ? closes[last - 1] : px;
  const barHigh = bars[last]?.h || px;
  const barLow = bars[last]?.l || px;

  // ── Lookback features for setup stalking ──
  const lookbackFeatures = {};

  // RSI extreme in last 15 bars
  if (rsiArr && rsiArr.length >= 15) {
    const recentRsi = rsiArr.slice(-15);
    const wasExtremeLo = recentRsi.some(r => r < 30);
    const wasExtremeHi = recentRsi.some(r => r > 70);
    const currentRsi = rsiArr[rsiArr.length - 1];
    lookbackFeatures.rsiWasExtremeLo15 = wasExtremeLo && currentRsi >= 35;
    lookbackFeatures.rsiWasExtremeHi15 = wasExtremeHi && currentRsi <= 65;
  }

  // ST flip freshness
  if (Number.isFinite(stBarsSinceFlip)) {
    lookbackFeatures.stFlipFresh = stBarsSinceFlip >= 3 && stBarsSinceFlip <= 15;
    lookbackFeatures.stBarsSinceFlip = stBarsSinceFlip;
  }

  // ── V16 Setup #4: 52w / ATH proximity (daily TF only) ──
  //
  // Track 52w high/low + 5-day base tightness for the ATH-breakout
  // setup (Ripster Setup #4). The TF needs at least 252 bars of
  // history; on lower TFs it's just rolling N-bar hi/lo. On daily,
  // 252 bars = ~1 year. SHORT mirror tracks 52w low for breakdowns.
  const lookback252 = Math.min(252, n);
  let high252 = -Infinity, low252 = Infinity;
  let high252Idx = -1, low252Idx = -1;
  for (let i = Math.max(0, last - lookback252 + 1); i <= last; i++) {
    const bh = bars[i]?.h ?? closes[i];
    const bl = bars[i]?.l ?? closes[i];
    if (Number.isFinite(bh) && bh > high252) { high252 = bh; high252Idx = i; }
    if (Number.isFinite(bl) && bl < low252) { low252 = bl; low252Idx = i; }
  }
  const pctBelowHigh252 = Number.isFinite(high252) && high252 > 0
    ? ((high252 - px) / high252) * 100
    : null;
  const pctAboveLow252 = Number.isFinite(low252) && low252 > 0
    ? ((px - low252) / low252) * 100
    : null;
  const daysFromHigh252 = high252Idx >= 0 ? (last - high252Idx) : null;
  const daysFromLow252 = low252Idx >= 0 ? (last - low252Idx) : null;

  // Tight base: 5-bar high/low range as % of price. <3% = tight.
  let tightBase5d = null;
  if (n >= 5) {
    let hi5 = -Infinity, lo5 = Infinity;
    for (let i = last - 4; i <= last; i++) {
      const bh = bars[i]?.h ?? closes[i];
      const bl = bars[i]?.l ?? closes[i];
      if (Number.isFinite(bh) && bh > hi5) hi5 = bh;
      if (Number.isFinite(bl) && bl < lo5) lo5 = bl;
    }
    if (Number.isFinite(hi5) && Number.isFinite(lo5) && px > 0) {
      tightBase5d = ((hi5 - lo5) / px) * 100;
    }
  }

  // Breakout detection: today's bar exceeds yesterday's high (LONG)
  // or breaks below yesterday's low (SHORT).
  const prevHigh = last >= 1 ? (bars[last - 1]?.h ?? closes[last - 1]) : null;
  const prevLow = last >= 1 ? (bars[last - 1]?.l ?? closes[last - 1]) : null;
  const breakoutAbovePrevHigh = Number.isFinite(prevHigh) && barHigh > prevHigh;
  const breakdownBelowPrevLow = Number.isFinite(prevLow) && barLow < prevLow;

  const ath52w = {
    high_252: Number.isFinite(high252) ? Math.round(high252 * 10000) / 10000 : null,
    low_252: Number.isFinite(low252) ? Math.round(low252 * 10000) / 10000 : null,
    pct_below_high_252: pctBelowHigh252 != null ? Math.round(pctBelowHigh252 * 100) / 100 : null,
    pct_above_low_252: pctAboveLow252 != null ? Math.round(pctAboveLow252 * 100) / 100 : null,
    days_from_high_252: daysFromHigh252,
    days_from_low_252: daysFromLow252,
    tight_base_5d_pct: tightBase5d != null ? Math.round(tightBase5d * 100) / 100 : null,
    breakout_above_prev_high: breakoutAbovePrevHigh,
    breakdown_below_prev_low: breakdownBelowPrevLow,
    // V16 Setup #4: 3% threshold for our universe (heavily growth-stock
    // loaded; tickers rarely sit within 1.5% of ATH but often within 3%
    // before breakout). 5% threshold for tight_base (loosened from 3%
    // to admit consolidation patterns common to high-momentum names).
    // Trigger logic in tt-core-entry.js uses the DA-keyed thresholds
    // for the actual gate; these flags are convenience for callers.
    is_near_ath: pctBelowHigh252 != null && pctBelowHigh252 < 3.0,
    is_near_atl: pctAboveLow252 != null && pctAboveLow252 < 3.0,
    has_tight_base: tightBase5d != null && tightBase5d < 5.0,
    sample_size: lookback252,
  };

  // ── V16 Setup #2: N-TEST SUPPORT/RESISTANCE detection (Ripster Setup #2) ──
  //
  // Cluster lows (or highs) within tight bands (default 0.75% of price)
  // across last 30 bars. A cluster with N≥3 touches that has held (most
  // recent test held above the cluster level) IS a valid Nth-test setup.
  //
  // LONG: Nth test of horizontal SUPPORT (price came near level N times,
  //       latest test held — the bounce off the Nth touch is the entry).
  // SHORT: mirror at horizontal RESISTANCE.
  let nTestSupport = null;
  const lookbackN = Math.min(30, n);
  if (n >= 5 && lookbackN >= 5) {
    const supportTol = px * 0.0075; // 0.75% of price = same level
    const recentLows = [];
    const recentHighs = [];
    for (let i = last - lookbackN + 1; i <= last; i++) {
      if (i < 0) continue;
      const bl = bars[i]?.l;
      const bh = bars[i]?.h;
      const bc = bars[i]?.c;
      if (Number.isFinite(bl)) recentLows.push({ price: bl, idx: i, close: bc });
      if (Number.isFinite(bh)) recentHighs.push({ price: bh, idx: i, close: bc });
    }
    // Find largest cluster of lows (most touches near same price).
    // Greedy clustering: sort by price, group adjacent within tolerance.
    function clusterByPrice(points, tol) {
      if (!points.length) return [];
      const sorted = [...points].sort((a, b) => a.price - b.price);
      const clusters = [];
      let current = [sorted[0]];
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i].price - current[0].price <= tol) {
          current.push(sorted[i]);
        } else {
          clusters.push(current);
          current = [sorted[i]];
        }
      }
      clusters.push(current);
      return clusters;
    }
    const lowClusters = clusterByPrice(recentLows, supportTol);
    const highClusters = clusterByPrice(recentHighs, supportTol);
    // Pick the cluster with the most touches (n-test)
    const bestSupport = lowClusters.reduce((best, c) =>
      c.length > (best?.length || 0) ? c : best, null);
    const bestResistance = highClusters.reduce((best, c) =>
      c.length > (best?.length || 0) ? c : best, null);

    // Support stats
    let supportInfo = null;
    if (bestSupport && bestSupport.length >= 3) {
      const supportPrice = bestSupport.reduce((s, p) => s + p.price, 0) / bestSupport.length;
      const lastTouchIdx = Math.max(...bestSupport.map(p => p.idx));
      const barsSinceLastTouch = last - lastTouchIdx;
      // Held: today's close > support cluster price (we're above the level)
      const heldAboveSupport = px > supportPrice;
      // Recent test: latest support touch in last 5 bars
      const recentTest = barsSinceLastTouch <= 5;
      supportInfo = {
        price: Math.round(supportPrice * 10000) / 10000,
        n_touches: bestSupport.length,
        last_touch_idx: lastTouchIdx,
        bars_since_last_touch: barsSinceLastTouch,
        held: heldAboveSupport,
        recent_test: recentTest,
        // LONG setup: ≥3 touches, recent test, held, today's price within
        // 1.5% above support (close to bouncing).
        long_setup_active: bestSupport.length >= 3
          && recentTest
          && heldAboveSupport
          && supportPrice > 0
          && (px - supportPrice) / supportPrice < 0.015,
      };
    }
    // Resistance stats
    let resistanceInfo = null;
    if (bestResistance && bestResistance.length >= 3) {
      const resistancePrice = bestResistance.reduce((s, p) => s + p.price, 0) / bestResistance.length;
      const lastTouchIdx = Math.max(...bestResistance.map(p => p.idx));
      const barsSinceLastTouch = last - lastTouchIdx;
      const heldBelowResistance = px < resistancePrice;
      const recentTest = barsSinceLastTouch <= 5;
      resistanceInfo = {
        price: Math.round(resistancePrice * 10000) / 10000,
        n_touches: bestResistance.length,
        last_touch_idx: lastTouchIdx,
        bars_since_last_touch: barsSinceLastTouch,
        held: heldBelowResistance,
        recent_test: recentTest,
        short_setup_active: bestResistance.length >= 3
          && recentTest
          && heldBelowResistance
          && resistancePrice > 0
          && (resistancePrice - px) / resistancePrice < 0.015,
      };
    }
    nTestSupport = {
      support: supportInfo,
      resistance: resistanceInfo,
      sample_size: lookbackN,
    };
  }

  // ── V16 Setup #5: GAP REVERSAL detection (Ripster Setup #5) ──
  //
  // Detects a gap-down on today's open that reverses higher (LONG)
  // OR a gap-up that fades lower (SHORT).
  //
  // Computed from the daily TF only (caller checks tf=='D'). Captures:
  //   - gap_pct: today's open vs prior close
  //   - is_gap_down / is_gap_up (configurable thresholds)
  //   - reclaimed_open_to_prev_close: today's price > today's open
  //     AND > prior close (for LONG reclaim signal)
  //   - faded_open_to_prev_close: mirror for SHORT
  //   - reclaim_strength: how far above (or below) the prior close
  let gapReversal = null;
  if (n >= 2) {
    const todayBarG = bars[last];
    const prevBarG = bars[last - 1];
    const todayOpen = Number(todayBarG?.o);
    const todayClose = Number(todayBarG?.c);
    const todayHigh = Number(todayBarG?.h);
    const todayLow = Number(todayBarG?.l);
    const prevCloseG = Number(prevBarG?.c);
    if (Number.isFinite(todayOpen) && Number.isFinite(prevCloseG) && prevCloseG > 0) {
      const gapPct = ((todayOpen - prevCloseG) / prevCloseG) * 100;
      const isGapDown = gapPct <= -1.5;
      const isGapUp = gapPct >= 1.5;
      // Reclaim: gap-down then today closes above prior close
      const reclaimedFromDown = isGapDown
        && Number.isFinite(todayClose)
        && todayClose > prevCloseG;
      // Partial reclaim: gap-down, current price above today's open
      // (recovering from the gap even if not fully)
      const partialReclaimDown = isGapDown
        && Number.isFinite(todayClose)
        && todayClose > todayOpen
        && (todayClose - todayOpen) / todayOpen > 0.005; // >0.5% above open
      // Fade: gap-up then today closes below prior close
      const fadedFromUp = isGapUp
        && Number.isFinite(todayClose)
        && todayClose < prevCloseG;
      const partialFadeUp = isGapUp
        && Number.isFinite(todayClose)
        && todayClose < todayOpen
        && (todayOpen - todayClose) / todayOpen > 0.005;

      gapReversal = {
        gap_pct: Math.round(gapPct * 100) / 100,
        is_gap_down: isGapDown,
        is_gap_up: isGapUp,
        prev_close: prevCloseG,
        today_open: todayOpen,
        today_close: todayClose,
        today_low: todayLow,
        today_high: todayHigh,
        reclaimed_from_down: reclaimedFromDown,
        partial_reclaim_down: partialReclaimDown,
        faded_from_up: fadedFromUp,
        partial_fade_up: partialFadeUp,
        // Setup #5 LONG: gap-down + (full reclaim OR strong partial)
        long_setup_active: reclaimedFromDown || partialReclaimDown,
        // Setup #5 SHORT: gap-up + (full fade OR strong partial)
        short_setup_active: fadedFromUp || partialFadeUp,
      };
    }
  }

  // ── V16 Setup #1: RANGE BOX detection (Ripster Setup #1: Range Reversal) ──
  //
  // Detect a horizontal range over the last N bars (default 12). The
  // pattern: ticker oscillates between a high and low for 10-15 bars,
  // then dips to the bottom of the range and reverses. The Setup #1
  // entry is the bounce off the range low.
  //
  // Range-box is "valid" when:
  //   - range_pct (high-low / mid_price) is moderate: 3-15%
  //     (too tight = Setup #4 base; too wide = trending, not ranging)
  //   - the high and low were touched at LEAST `min_touches` times
  //     (i.e. the range is real, not a single spike)
  //
  // SHORT mirror: same range, price near top, bearish reversal.
  let rangeBox = null;
  const rangeWindow = Math.min(12, n);
  if (n >= rangeWindow + 2) {
    let rangeHigh = -Infinity, rangeLow = Infinity;
    for (let i = last - rangeWindow + 1; i <= last; i++) {
      const bh = bars[i]?.h ?? closes[i];
      const bl = bars[i]?.l ?? closes[i];
      if (Number.isFinite(bh) && bh > rangeHigh) rangeHigh = bh;
      if (Number.isFinite(bl) && bl < rangeLow) rangeLow = bl;
    }
    if (Number.isFinite(rangeHigh) && Number.isFinite(rangeLow) && rangeHigh > rangeLow) {
      const rangeMid = (rangeHigh + rangeLow) / 2;
      const rangePct = ((rangeHigh - rangeLow) / rangeMid) * 100;
      // Position in range: 0 = at low, 1 = at high
      const positionInRange = (px - rangeLow) / (rangeHigh - rangeLow);
      // Touch counts: how many bars came within 0.5% of high/low
      const touchTol = (rangeHigh - rangeLow) * 0.05; // 5% of range = touch
      let highTouches = 0, lowTouches = 0;
      let lastLowTouchIdx = -1, lastHighTouchIdx = -1;
      for (let i = last - rangeWindow + 1; i <= last; i++) {
        const bh = bars[i]?.h ?? closes[i];
        const bl = bars[i]?.l ?? closes[i];
        if (Number.isFinite(bh) && Math.abs(bh - rangeHigh) <= touchTol) {
          highTouches++;
          lastHighTouchIdx = i;
        }
        if (Number.isFinite(bl) && Math.abs(bl - rangeLow) <= touchTol) {
          lowTouches++;
          lastLowTouchIdx = i;
        }
      }
      const barsSinceLowTouch = lastLowTouchIdx >= 0 ? (last - lastLowTouchIdx) : null;
      const barsSinceHighTouch = lastHighTouchIdx >= 0 ? (last - lastHighTouchIdx) : null;

      // Bullish reversal candle: today's close > open AND close in upper
      // 50% of bar.
      const todayBar = bars[last];
      const bullishReversal = todayBar
        && Number.isFinite(todayBar.c) && Number.isFinite(todayBar.o)
        && Number.isFinite(todayBar.h) && Number.isFinite(todayBar.l)
        && todayBar.c > todayBar.o
        && (todayBar.h - todayBar.l > 0)
        && ((todayBar.c - todayBar.l) / (todayBar.h - todayBar.l) >= 0.55);
      const bearishReversal = todayBar
        && Number.isFinite(todayBar.c) && Number.isFinite(todayBar.o)
        && Number.isFinite(todayBar.h) && Number.isFinite(todayBar.l)
        && todayBar.c < todayBar.o
        && (todayBar.h - todayBar.l > 0)
        && ((todayBar.h - todayBar.c) / (todayBar.h - todayBar.l) >= 0.55);

      // V16 Setup #1 — define "in lower zone" as:
      //   - position < 0.50 (lower half of range), OR
      //   - close > prev close (today's daily bar is a green candle —
      //     valid bounce signal even if pos has already moved up)
      //
      // The reversal candle definition is too strict for daily bars
      // (intraday wicks distort close-vs-range ratio). Use a softer
      // signal: today's close > prior close = bullish day-frame.
      const todayClose = Number.isFinite(todayBar?.c) ? todayBar.c : null;
      const prevClose = last >= 1 ? closes[last - 1] : null;
      const todayBullishDay = todayClose != null && prevClose != null && todayClose > prevClose;
      const todayBearishDay = todayClose != null && prevClose != null && todayClose < prevClose;

      rangeBox = {
        high: Math.round(rangeHigh * 10000) / 10000,
        low: Math.round(rangeLow * 10000) / 10000,
        mid: Math.round(rangeMid * 10000) / 10000,
        range_pct: Math.round(rangePct * 100) / 100,
        position_in_range: Math.round(positionInRange * 1000) / 1000,
        bars_in_range: rangeWindow,
        high_touches: highTouches,
        low_touches: lowTouches,
        bars_since_low_touch: barsSinceLowTouch,
        bars_since_high_touch: barsSinceHighTouch,
        is_valid_range: rangePct >= 3 && rangePct <= 15
          && (lowTouches >= 2 || highTouches >= 2),
        // Setup #1 LONG conditions: in lower half of range, recently
        // touched low, bullish reversal — using softer/relaxed criteria.
        long_setup_active: rangePct >= 3 && rangePct <= 15
          && positionInRange < 0.55
          && lowTouches >= 2
          && barsSinceLowTouch != null && barsSinceLowTouch <= 6
          && (bullishReversal || todayBullishDay),
        short_setup_active: rangePct >= 3 && rangePct <= 15
          && positionInRange > 0.45
          && highTouches >= 2
          && barsSinceHighTouch != null && barsSinceHighTouch <= 6
          && (bearishReversal || todayBearishDay),
        bullish_reversal: bullishReversal,
        bearish_reversal: bearishReversal,
        today_bullish_day: todayBullishDay,
        today_bearish_day: todayBearishDay,
      };
    }
  }

  return {
    px, pxPrev, barHigh, barLow, lastTs,
    e3, e5, e8, e9, e12, e13, e21, e34, e48, e50, e72, e89, e180, e200, e233,
    eFast, eSlow,
    e21_slope_5bar_pct, e48_slope_10bar_pct,
    emaDepth, emaStructure, emaMomentum, ribbonSpread,
    stLine, stDir, stLinePrev, stSlopeUp, stSlopeDn,
    stFlip, stFlipDir, stFlip_ts, stBarsSinceFlip,
    sqOn, sqOnPrev, sqRelease, sqRelease_ts, mom, momStd,
    phaseOsc, phaseVelocity, phaseZone,
    satyPhase,
    compressed,
    atr14, atrRatio,
    volRatio, rvol5, rvolSpike,
    // V15 P0.7.33 — VWAP fields (cumulative + rolling 20-bar)
    vwap, vwapRolling20, vwapDistPct, vwapSlope5bar, vwapAbove, vwapTouchBars,
    rsi, rsi_slope_5bar, rsiDiv, phaseDiv,
    phase_slope_5bar,
    ggUpCross, ggDnCross, ggDist,
    ggUpCross_ts, ggDnCross_ts,
    emaStack,
    emaCross5_48_up, emaCross5_48_dn, emaCross5_48_up_ts, emaCross5_48_dn_ts,
    emaCross13_21_up, emaCross13_21_dn, emaCross13_21_up_ts, emaCross13_21_dn_ts,
    emaCross13_48_up, emaCross13_48_dn, emaCross13_48_up_ts, emaCross13_48_dn_ts,
    ema5above48, ema13above21, ema8above21, emaRegime,
    ripsterClouds,
    pdz, fvg, liq,
    ichimoku,
    lookback: lookbackFeatures,
    ath52w,
    rangeBox,
    gapReversal,
    nTestSupport,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// HTF / LTF SCORING (mirrors Pine f_htf_from_bundle / f_ltf_from_bundle)
// ═══════════════════════════════════════════════════════════════════════════════

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

/**
 * HTF score from a bundle (mirrors Pine lines 222-271).
 * @param {object} b - bundle from computeTfBundle
 * @returns {number} score in [-50, 50]
 */
export function computeHTFBundleScore(b) {
  if (!b) return 0;
  const { px, e200, stDir, e5, e8, e13, e21, e48, compressed, phaseOsc, eFast, eSlow, volRatio, atrRatio, emaStructure, emaDepth } = b;

  // Trend bias
  const trendBias = (px >= e200 ? 10.0 : -10.0) + (stDir < 0 ? 10.0 : -10.0);

  // Graduated structure scoring (EMA-vs-EMA ordering)
  let stackScore = 0;
  if (e5 > e8) stackScore += 2.0;
  if (e8 > e13) stackScore += 2.5;
  if (e13 > e21) stackScore += 2.5;
  if (e21 > e48) stackScore += 3.0;
  const slope48Up = eFast >= eSlow;
  const structure = stackScore + (slope48Up ? 5.0 : -5.0);

  // EMA Structure bias: continuous measure of macro trend alignment
  // emaStructure (-1 to +1) from price vs long EMAs (34/48/89/200/233)
  // Adds up to ±5 points of structural conviction beyond discrete stack checks
  const structBias = Number.isFinite(emaStructure) ? emaStructure * 5.0 : 0;

  // Multi-factor regime detection
  const bias = trendBias >= 0 ? 1 : -1;
  let regimeScore = 0;
  if (compressed) regimeScore += (bias === 1 ? 5.0 : -5.0);
  const phaseExtreme = Math.abs(phaseOsc) > 61.8;
  if (phaseExtreme) regimeScore -= 3.0;
  if (atrRatio > 1.1 && !compressed) regimeScore += 2.0;
  if (volRatio > 1.3) regimeScore += 1.0;
  if (volRatio < 0.7) regimeScore -= 0.5;

  // Momentum component
  let momC = eFast >= eSlow ? 5.0 : -5.0;
  const volBoost = volRatio > 1.2 ? 3.0 : (volRatio < 0.8 ? -2.0 : 0.0);
  momC += volBoost;

  return clamp(trendBias + structure + structBias + regimeScore + momC, -50, 50);
}

/**
 * LTF score from a bundle (mirrors Pine lines 276-326).
 * @param {object} b - bundle from computeTfBundle
 * @param {{ ATRd: number }} anchors - daily ATR for SuperTrend distance normalization
 * @returns {number} score in [-50, 50]
 */
export function computeLTFBundleScore(b, anchors = null) {
  if (!b) return 0;
  const {
    px, sqOn, sqOnPrev, mom, momStd,
    ggUpCross, ggDnCross, ggDist,
    e5, e13, e21, e48,
    stLine, stDir, stSlopeUp, stSlopeDn,
    compressed, volRatio, rsi, atrRatio,
    emaMomentum, emaDepth,
  } = b;

  // Squeeze release trigger (momentum-normalized)
  const release = sqOnPrev && !sqOn;
  let trig = 0;
  if (release) {
    const relDir = mom >= 0 ? 1 : -1;
    const momStrength = (momStd > 0) ? Math.min(1.5, Math.abs(mom) / momStd) : 1.0;
    trig = (relDir === 1 ? 8.0 : -8.0) * momStrength;
  }

  // Distance-based Golden Gate
  let gg = 0;
  if (ggDist > 0.8) gg += 6.0;
  if (ggDist < 0.2) gg -= 4.0;
  const ATRd = anchors?.ATRd || 0;
  if (ATRd > 0 && anchors?.GGup) {
    if (Math.abs(px - anchors.GGup) < ATRd * 0.1) gg += 2.0;
    if (Math.abs(px - anchors.GGdn) < ATRd * 0.1) gg -= 2.0;
  }
  const trigger = trig + gg;

  // Alignment
  let align = (px >= e21 ? 6.0 : -6.0) + (px >= e48 ? 6.0 : -6.0);
  const bullStack = e5 > e13 && e13 > e21 && e21 > e48;
  const bearStack = e5 < e13 && e13 < e21 && e21 < e48;
  align += bullStack ? 3.0 : (bearStack ? -3.0 : 0.0);

  // Graduated SuperTrend support (distance-based)
  let stSupport = 0;
  const normATRd = (Number.isFinite(atrRatio) && atrRatio > 0 && ATRd > 0) ? atrRatio * ATRd : 1;
  const stDist = normATRd > 0 ? Math.abs(px - stLine) / normATRd : 999;
  if (stDir < 0 && stSlopeUp && px > stLine) {
    stSupport = 10.0 * Math.max(0, 1.0 - stDist / 2.0);
  }
  if (stDir > 0 && stSlopeDn && px < stLine) {
    stSupport = -10.0 * Math.max(0, 1.0 - stDist / 2.0);
  }

  // ST + EMA Momentum alignment boost: when SuperTrend is supportive AND
  // EMA momentum confirms the direction, add a conviction boost (up to ±4 pts).
  // This captures the "LTF ST supportive should boost LTF score" insight.
  let stMomBoost = 0;
  if (Number.isFinite(emaMomentum)) {
    if (stSupport > 0 && emaMomentum > 0) {
      // Bull ST support + bull momentum = strong alignment boost
      stMomBoost = Math.min(4.0, stSupport * 0.4 * emaMomentum);
    } else if (stSupport < 0 && emaMomentum < 0) {
      // Bear ST support + bear momentum = strong alignment boost
      stMomBoost = Math.max(-4.0, stSupport * 0.4 * Math.abs(emaMomentum));
    }
  }

  // RSI mean reversion
  const meanRev = rsi > 70 ? -4.0 : (rsi < 30 ? 4.0 : 0.0);

  // Guard
  const guard = (sqOn ? -3.0 : 0.0) + (compressed ? -2.0 : 0.0);

  return clamp(trigger + align + stSupport + stMomBoost + meanRev + guard, -50, 50);
}

// ═══════════════════════════════════════════════════════════════════════════════
// WEIGHTED BLENDING — v3 Timeframe Architecture
//
// HTF: M(10%) → W(20%) → D(40%) → 4H(30%)
//   Daily is the anchor (healthy change rate). Weekly/Monthly confirm but lag.
//   4H catches early flip detection.
//
// LTF: 1H(35%) → 30m(30%) → 10m(20%) → 5m(15%)
//   1H stabilizes the LTF bundle, reducing noise sensitivity.
//   30m provides swing context, 10m/5m for precise timing.
//
// Ichimoku blending: 30% of HTF bundle, 20% of LTF bundle.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Volatility-adjusted HTF weights.
 * Base: D(40%), 4H(30%), W(20%), M(10%)
 * High-ATR timeframes get boosted (more signal), low-ATR get dampened.
 */
function volatilityAdjustedHTFWeights(atrRM, atrRW, atrRD, atrR4, learnedAdj = null) {
  let wM_base = 0.10, wW_base = 0.20, wD_base = 0.40, w4H_base = 0.30;
  if (learnedAdj) {
    wM_base  *= (learnedAdj.M   || 1.0);
    wW_base  *= (learnedAdj.W   || 1.0);
    wD_base  *= (learnedAdj.D   || 1.0);
    w4H_base *= (learnedAdj["240"] || 1.0);
  }
  // High volatility = more signal, boost weight. Low = dampen.
  let wM  = (atrRM > 1.3) ? wM_base * 0.8  : wM_base * 1.1;   // M lags, dampen in vol
  let wW  = (atrRW > 1.5) ? wW_base * 0.85 : wW_base * 1.1;   // W confirms, slight dampen in vol
  let wD  = (atrRD > 1.3) ? wD_base * 1.15 : wD_base * 0.95;  // D is anchor, boost in vol
  let w4H = (atrR4 > 1.2) ? w4H_base * 1.2 : w4H_base * 0.9;  // 4H detects flips, boost in vol
  const total = wM + wW + wD + w4H;
  return { wM: wM / total, wW: wW / total, wD: wD / total, w4H: w4H / total };
}

/**
 * Session-aware LTF weights (swing-first: no 5m).
 * Base: 1H(50%), 30m(30%), 10m(20%)
 * During RTH, slightly boost 1H (most liquid swing signal).
 */
function sessionAdjustedLTFWeights(isRTH, learnedAdj = null) {
  let w1H_base = 0.50, w30_base = 0.30, w10_base = 0.20;
  if (learnedAdj) {
    w1H_base *= (learnedAdj["60"] || 1.0);
    w30_base *= (learnedAdj["30"] || 1.0);
    w10_base *= (learnedAdj["10"] || 1.0);
  }
  if (!isRTH) return { w1H: w1H_base, w30: w30_base, w10: w10_base };
  let w1H = w1H_base * 1.08;
  let w30 = w30_base * 1.03;
  let w10 = w10_base * 0.92;
  const total = w1H + w30 + w10;
  return { w1H: w1H / total, w30: w30 / total, w10: w10 / total };
}

/**
 * Compute final HTF score from 4 timeframe bundles + Ichimoku.
 *
 * Architecture: M(10%) → W(20%) → D(40%) → 4H(30%)
 * Ichimoku contributes 30% of final score, existing EMA/ST/squeeze 70%.
 *
 * @param {object} mBundle  - Monthly bundle (may be null for sparse data)
 * @param {object} wBundle  - Weekly bundle
 * @param {object} dBundle  - Daily bundle (anchor)
 * @param {object} h4Bundle - 4H bundle (early flip detection)
 * @param {object} [learnedAdj] - calibration weight adjustments
 * @returns {number} weighted HTF score in [-50, 50]
 */
export function computeWeightedHTFScore(mBundle, wBundle, dBundle, h4Bundle, learnedAdj = null) {
  // Existing EMA/ST/squeeze bundle scores
  const htfM  = computeHTFBundleScore(mBundle);
  const htfW  = computeHTFBundleScore(wBundle);
  const htfD  = computeHTFBundleScore(dBundle);
  const htf4H = computeHTFBundleScore(h4Bundle);

  const atrRM = mBundle?.atrRatio  || 1.0;
  const atrRW = wBundle?.atrRatio  || 1.0;
  const atrRD = dBundle?.atrRatio  || 1.0;
  const atrR4 = h4Bundle?.atrRatio || 1.0;

  const { wM, wW, wD, w4H } = volatilityAdjustedHTFWeights(atrRM, atrRW, atrRD, atrR4, learnedAdj);
  const existingScore = htfM * wM + htfW * wW + htfD * wD + htf4H * w4H;

  // Ichimoku component: weighted average of per-TF Ichimoku scores
  // Same TF weights but Ichimoku naturally strongest on D/W
  const ichM  = computeIchimokuScore(mBundle?.ichimoku);
  const ichW  = computeIchimokuScore(wBundle?.ichimoku);
  const ichD  = computeIchimokuScore(dBundle?.ichimoku);
  const ich4H = computeIchimokuScore(h4Bundle?.ichimoku);

  const ichScore = ichM * wM + ichW * wW + ichD * wD + ich4H * w4H;

  // Blend: 70% existing signals + 30% Ichimoku
  // If no Ichimoku data available (all return 0), blend is pure existing
  const hasIchimoku = (mBundle?.ichimoku || wBundle?.ichimoku || dBundle?.ichimoku || h4Bundle?.ichimoku);
  const ichWeight = hasIchimoku ? 0.30 : 0.0;
  const blended = existingScore * (1 - ichWeight) + ichScore * ichWeight;

  return clamp(blended, -50, 50);
}

/**
 * Compute final LTF score from 3 timeframe bundles + Ichimoku (swing-first: no 5m).
 *
 * Architecture: 1H(50%) → 30m(30%) → 10m(20%)
 * Ichimoku contributes 20% of final score, existing signals 80%.
 *
 * @param {object} h1Bundle  - 1H bundle (anchor for LTF stability)
 * @param {object} m30Bundle - 30m bundle
 * @param {object} m10Bundle - 10m bundle
 * @param {{ ATRd: number }} anchors - daily anchors for Golden Gate normalization
 * @param {boolean} isRTH - Regular Trading Hours flag
 * @param {object} [learnedAdj] - calibration weight adjustments
 * @returns {number} weighted LTF score in [-50, 50]
 */
export function computeWeightedLTFScore(h1Bundle, m30Bundle, m10Bundle, anchors = null, isRTH = true, learnedAdj = null) {
  const ltf1H = computeLTFBundleScore(h1Bundle, anchors);
  const ltf30 = computeLTFBundleScore(m30Bundle, anchors);
  const ltf10 = computeLTFBundleScore(m10Bundle, anchors);

  const { w1H, w30, w10 } = sessionAdjustedLTFWeights(isRTH, learnedAdj);
  const existingScore = ltf1H * w1H + ltf30 * w30 + ltf10 * w10;

  const ich1H = computeIchimokuScore(h1Bundle?.ichimoku);
  const ich30 = computeIchimokuScore(m30Bundle?.ichimoku);
  const ich10 = computeIchimokuScore(m10Bundle?.ichimoku);

  const ichScore = ich1H * 0.50 + ich30 * 0.30 + ich10 * 0.20;

  const hasIchimoku = (h1Bundle?.ichimoku || m30Bundle?.ichimoku);
  const ichWeight = hasIchimoku ? 0.20 : 0.0;
  const blended = existingScore * (1 - ichWeight) + ichScore * ichWeight;

  return clamp(blended, -50, 50);
}

/**
 * Classify state from scores (mirrors Pine lines 384-391).
 */
export function classifyState(htfScore, ltfScore) {
  const htfBull = htfScore >= 0;
  const ltfBull = ltfScore >= 0;
  if (htfBull && ltfBull) return "HTF_BULL_LTF_BULL";
  if (htfBull && !ltfBull) return "HTF_BULL_LTF_PULLBACK";
  if (!htfBull && !ltfBull) return "HTF_BEAR_LTF_BEAR";
  return "HTF_BEAR_LTF_PULLBACK";
}

// ═══════════════════════════════════════════════════════════════════════════════
// REGIME CLASSIFIER — Chop Detection Engine
//
// Classifies each ticker into TRENDING / TRANSITIONAL / CHOPPY based on
// multi-signal confluence from Ichimoku, EMA structure, SuperTrend stability,
// squeeze state, and relative volume.
//
// This is the single biggest lever for the scoring overhaul:
//   - Jul–Oct 2025 (trending): 53-62% win rate, profitable
//   - Nov–Feb 2026 (choppy):   41-49% win rate, losing money
//   - Trade count doubled while quality dropped
//
// The regime classifier enables:
//   - Adaptive entry thresholds (higher bar in chop)
//   - Trade frequency governance (fewer entries in chop)
//   - SHORT blocking in chop
//   - SL width adjustment
//   - Position size scaling
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Classify the market regime for a single ticker.
 *
 * Uses the Daily bundle as primary (most weight) with 4H and Weekly as
 * confirmation/early-warning. Returns a regime enum + numeric score.
 *
 * @param {object} dBundle  - Daily computeTfBundle output
 * @param {object} [h4Bundle] - 4H bundle (optional, for early detection)
 * @param {object} [wBundle]  - Weekly bundle (optional, for confirmation)
 * @returns {{ regime: string, score: number, factors: object }}
 *   regime: "TRENDING" | "TRANSITIONAL" | "CHOPPY"
 *   score:  -15 (extreme chop) to +15 (strong trend)
 *   factors: breakdown of what contributed to the score
 */
function normalizeMarketInternals(internals = null) {
  if (!internals || typeof internals !== "object") return null;
  return {
    overall: String(internals.overall || "").toLowerCase() || "balanced",
    score: Number(internals.score || 0),
    vix: internals.vix || null,
    tick: internals.tick || null,
    fx_barometer: internals.fx_barometer || null,
    sector_rotation: internals.sector_rotation || null,
    squeeze: internals.squeeze || null,
    evidence: Array.isArray(internals.evidence) ? internals.evidence : [],
  };
}

export function classifyTickerRegime(dBundle, h4Bundle = null, wBundle = null, marketInternals = null) {
  let score = 0;
  const factors = {};
  const internals = normalizeMarketInternals(marketInternals);

  // ── 1. Ichimoku Cloud Thickness (Daily) — strongest chop signal ──
  // Thick cloud = strong trend support/resistance. Thin = no conviction.
  const ichD = dBundle?.ichimoku;
  if (ichD) {
    const ct = ichD.cloudThickness || 0;
    if (ct > 1.5)      { score += 3; factors.cloud_thickness = "+3 (thick: " + ct.toFixed(2) + ")"; }
    else if (ct > 0.8)  { score += 1; factors.cloud_thickness = "+1 (moderate: " + ct.toFixed(2) + ")"; }
    else if (ct < 0.3)  { score -= 3; factors.cloud_thickness = "-3 (thin: " + ct.toFixed(2) + ")"; }
    else                { score -= 1; factors.cloud_thickness = "-1 (narrow: " + ct.toFixed(2) + ")"; }

    // Price inside cloud = regime uncertainty
    if (ichD.priceVsCloud === "inside") {
      score -= 2;
      factors.price_in_cloud = "-2 (inside kumo)";
    }

    // TK Spread: wide = trending, narrow = choppy
    const tks = Math.abs(ichD.tkSpread || 0);
    if (tks > 0.5)      { score += 2; factors.tk_spread = "+2 (wide: " + tks.toFixed(2) + ")"; }
    else if (tks > 0.2)  { score += 1; factors.tk_spread = "+1 (moderate: " + tks.toFixed(2) + ")"; }
    else if (tks < 0.1)  { score -= 2; factors.tk_spread = "-2 (flat: " + tks.toFixed(2) + ")"; }

    // Kijun slope: flat = range
    const ks = Math.abs(ichD.kijunSlope || 0);
    if (ks > 0.3)       { score += 1; factors.kijun_slope = "+1 (moving)"; }
    else if (ks < 0.05)  { score -= 1; factors.kijun_slope = "-1 (flat)"; }

    // Kumo twist = potential regime change
    if (ichD.kumoTwist)  { score -= 1; factors.kumo_twist = "-1 (twist detected)"; }
  }

  // ── 2. EMA Structure Convergence (Daily) ──
  // Tangled EMAs = chop. Fanned out = trend.
  const emaStruct = dBundle?.emaStructure ?? 0;
  if (Math.abs(emaStruct) > 0.7) {
    score += 2;
    factors.ema_structure = "+2 (fanned: " + emaStruct.toFixed(2) + ")";
  } else if (Math.abs(emaStruct) < 0.3) {
    score -= 2;
    factors.ema_structure = "-2 (tangled: " + emaStruct.toFixed(2) + ")";
  }

  // ── 3. SuperTrend Stability (Daily) ──
  // Long-running ST direction = trending. Recent flips = chop.
  const stBars = dBundle?.stBarsSinceFlip ?? 0;
  if (stBars > 15)     { score += 2; factors.st_stability = "+2 (" + stBars + " bars since flip)"; }
  else if (stBars > 8) { score += 1; factors.st_stability = "+1 (" + stBars + " bars since flip)"; }
  else if (stBars < 3) { score -= 2; factors.st_stability = "-2 (recent flip: " + stBars + " bars)"; }

  // ── 4. Squeeze State (Daily) ──
  // Active squeeze = energy building but directionless. Dampens conviction.
  if (dBundle?.sqOn) {
    score -= 1;
    factors.squeeze = "-1 (squeeze active)";
  }

  // ── 5. Volume Conviction (Daily) ──
  // Low volume = unreliable signals. High volume = institutional participation.
  const rvol = dBundle?.rvol5 ?? dBundle?.volRatio ?? 1.0;
  if (rvol < 0.6) {
    score -= 2;
    factors.volume = "-2 (thin: rvol=" + rvol.toFixed(2) + ")";
  } else if (rvol > 1.5) {
    score += 1;
    factors.volume = "+1 (strong: rvol=" + rvol.toFixed(2) + ")";
  }

  // ── 6. 4H Early Warning (optional) ──
  // 4H flips faster than daily — use as leading indicator
  if (h4Bundle) {
    const ich4H = h4Bundle.ichimoku;
    if (ich4H?.priceVsCloud === "inside") {
      score -= 1;
      factors.h4_cloud = "-1 (4H inside cloud)";
    }
    // 4H SuperTrend recently flipped while daily hasn't = divergence = chop
    if (h4Bundle.stBarsSinceFlip != null && h4Bundle.stBarsSinceFlip < 3 && stBars > 5) {
      score -= 1;
      factors.h4_st_diverge = "-1 (4H ST flipped, daily hasn't)";
    }
  }

  // ── 7. Weekly Confirmation (optional) ──
  // Weekly inside cloud or thin cloud = macro uncertainty
  if (wBundle?.ichimoku) {
    if (wBundle.ichimoku.priceVsCloud === "inside") {
      score -= 1;
      factors.w_cloud = "-1 (weekly inside cloud)";
    }
    if ((wBundle.ichimoku.cloudThickness || 0) < 0.3) {
      score -= 1;
      factors.w_thin = "-1 (weekly cloud thin)";
    }
  }

  // ── 8. Higher-level market internals overlay ──
  if (internals) {
    if (internals.overall === "risk_on") {
      score += 1;
      factors.market_internals = "+1 (risk-on internals)";
    } else if (internals.overall === "risk_off") {
      score -= 2;
      factors.market_internals = "-2 (risk-off internals)";
    }
    if (internals.vix?.state === "fear") {
      score -= 2;
      factors.vix = "-2 (fear regime)";
    } else if (internals.vix?.state === "elevated") {
      score -= 1;
      factors.vix = "-1 (elevated vol)";
    } else if (internals.vix?.state === "low_fear") {
      score += 1;
      factors.vix = "+1 (low-vol trend-friendly)";
    }
    if (internals.sector_rotation?.state === "risk_on") {
      score += 1;
      factors.sector_rotation = "+1 (offense leading)";
    } else if (internals.sector_rotation?.state === "risk_off") {
      score -= 1;
      factors.sector_rotation = "-1 (defense leading)";
    }
    if (internals.tick?.state === "selling_extreme") {
      score -= 1;
      factors.tick = "-1 (broad selling pressure)";
    } else if (internals.tick?.state === "buying_extreme") {
      score += 1;
      factors.tick = "+1 (broad buying pressure)";
    }
    if (internals.squeeze?.release_30m || internals.squeeze?.release_1h) {
      score += 1;
      factors.squeeze_energy = "+1 (multi-tf squeeze fired)";
    } else if (internals.squeeze?.on_30m) {
      factors.squeeze_energy = "0 (compression building)";
    }
  }

  // ── Classify ──
  const regime = score >= 5 ? "TRENDING"
    : score >= 0 ? "TRANSITIONAL"
    : "CHOPPY";

  return { regime, score, factors, market_internals: internals };
}

/**
 * Classify the overall market regime using SPY (or QQQ) data.
 * This provides a global overlay — when the market itself is choppy,
 * all tickers should trade more conservatively regardless of their
 * individual regime.
 *
 * @param {object} spyDailyBundle - SPY daily computeTfBundle output
 * @param {object} [spyWeeklyBundle] - SPY weekly bundle
 * @returns {{ regime: string, score: number, factors: object }}
 */
export function classifyMarketRegime(spyDailyBundle, spyWeeklyBundle = null) {
  if (!spyDailyBundle) return { regime: "UNKNOWN", score: 0, factors: {} };
  return classifyTickerRegime(spyDailyBundle, null, spyWeeklyBundle);
}

/**
 * Get regime-adaptive trading parameters.
 * These are the guardrails that tighten or loosen based on regime.
 *
 * @param {string} tickerRegime - "TRENDING" | "TRANSITIONAL" | "CHOPPY"
 * @param {string} [marketRegime] - global overlay from SPY
 * @returns {object} adaptive parameters for entry/exit gates
 */
export function getRegimeParams(tickerRegime, marketRegime = null, marketInternals = null) {
  // If market is choppy, override ticker regime to at least TRANSITIONAL
  const effectiveRegime = (marketRegime === "CHOPPY" && tickerRegime === "TRENDING")
    ? "TRANSITIONAL"
    : (marketRegime === "CHOPPY" ? "CHOPPY" : tickerRegime);

  const params = {
    TRENDING: {
      regime: "TRENDING",
      minHTFScore: 10,
      minRR: 1.5,
      maxCompletion: 0.60,
      positionSizeMultiplier: 1.0,
      shortsAllowed: true,
      shortRvolMin: 1.0,     // SHORTs need at least normal volume
      maxDailyEntries: 10,
      maxWeeklyEntries: 15,
      slCushionMultiplier: 1.0,
      maxHoldDaysLosing: 20,
      rvolDeadZone: 0.4,     // RVOL below this = no entry
      rvolLowThreshold: 0.7, // Below this = elevated score requirement
      rvolLowScoreAdj: 5,    // Add this to minHTFScore when RVOL is low
    },
    TRANSITIONAL: {
      regime: "TRANSITIONAL",
      minHTFScore: 15,
      minRR: 2.0,
      maxCompletion: 0.45,
      positionSizeMultiplier: 0.75,
      shortsAllowed: true,
      shortRvolMin: 0.7,
      maxDailyEntries: 5,
      maxWeeklyEntries: 8,
      slCushionMultiplier: 1.15,  // 15% wider stops
      maxHoldDaysLosing: 12,
      rvolDeadZone: 0.5,
      rvolLowThreshold: 0.8,
      rvolLowScoreAdj: 5,
    },
    CHOPPY: {
      regime: "CHOPPY",
      minHTFScore: 15,
      minRR: 3.0,
      maxCompletion: 0.30,
      positionSizeMultiplier: 0.50,
      shortsAllowed: true,
      shortRvolMin: 1.0,
      maxDailyEntries: 2,
      maxWeeklyEntries: 3,
      slCushionMultiplier: 1.30,  // 30% wider stops
      maxHoldDaysLosing: 7,
      rvolDeadZone: 0.5,
      rvolLowThreshold: 0.8,
      rvolLowScoreAdj: 10,
    },
  };

  const selected = { ...(params[effectiveRegime] || params.TRANSITIONAL) };
  const internals = normalizeMarketInternals(marketInternals);
  if (internals) {
    selected.marketInternals = internals;
    if (internals.overall === "risk_off") {
      selected.positionSizeMultiplier = Math.max(0.35, selected.positionSizeMultiplier * 0.75);
      selected.minHTFScore += 5;
      selected.minRR += 0.25;
      selected.maxDailyEntries = Math.max(1, Math.floor(selected.maxDailyEntries * 0.6));
      selected.maxWeeklyEntries = Math.max(2, Math.floor(selected.maxWeeklyEntries * 0.6));
      selected.slCushionMultiplier = Math.max(selected.slCushionMultiplier, 1.2);
    } else if (internals.overall === "risk_on" && selected.regime === "TRENDING") {
      selected.positionSizeMultiplier = Math.min(1.15, selected.positionSizeMultiplier * 1.05);
    }
    if (internals.vix?.state === "fear") {
      selected.positionSizeMultiplier = Math.max(0.30, selected.positionSizeMultiplier * 0.7);
      selected.minRR += 0.25;
      selected.minHTFScore += 3;
    } else if (internals.vix?.state === "low_fear" && selected.regime === "TRENDING") {
      selected.maxCompletion = Math.min(0.7, selected.maxCompletion + 0.05);
    }
    if (internals.squeeze?.release_30m || internals.squeeze?.release_1h) {
      selected.maxCompletion = Math.min(0.75, selected.maxCompletion + 0.05);
    }
  }
  return selected;
}

function normalizeTickerProfileForSelection(rawProfile = null) {
  if (!rawProfile || typeof rawProfile !== "object") return null;
  const learning = rawProfile.learning_json
    ? (typeof rawProfile.learning_json === "string" ? (() => { try { return JSON.parse(rawProfile.learning_json); } catch { return null; } })() : rawProfile.learning_json)
    : rawProfile.learning || null;
  const personality = learning?.personality || rawProfile.personality || rawProfile.behaviorType || rawProfile.behavior_type || null;
  const entryParams = learning?.entry_params || null;
  return {
    personality,
    behaviorType: rawProfile.behaviorType || rawProfile.behavior_type || null,
    trendPersistence: Number(rawProfile.trendPersistence ?? rawProfile.trend_persistence ?? 0),
    meanReversionSpeed: Number(rawProfile.meanReversionSpeed ?? rawProfile.mean_reversion_speed ?? 0),
    slMult: Number(rawProfile.slMult ?? rawProfile.sl_mult ?? 1),
    tpMult: Number(rawProfile.tpMult ?? rawProfile.tp_mult ?? 1),
    entryThresholdAdj: Number(rawProfile.entryThresholdAdj ?? rawProfile.entry_threshold_adj ?? 0),
    entryParams,
  };
}

export function selectExecutionProfile({
  tickerRegime = "TRANSITIONAL",
  marketInternals = null,
  tickerProfile = null,
  state = "unknown",
  flags = {},
  entryQuality = null,
  regimeScore = null,
} = {}) {
  const internals = normalizeMarketInternals(marketInternals);
  const profile = normalizeTickerProfileForSelection(tickerProfile);
  const reasons = [];
  let activeProfile = "correction_transition";
  let confidence = 0.5;

  const eqScore = Number(entryQuality?.score || 0);
  const trendPersistence = Number(profile?.trendPersistence || 0);
  const personality = String(profile?.personality || profile?.behaviorType || "").toUpperCase();
  const riskState = internals?.overall || "balanced";

  if (
    tickerRegime === "TRENDING" &&
    riskState === "risk_on" &&
    (trendPersistence >= 0.58 || personality === "TREND_FOLLOWER" || personality === "MOMENTUM")
  ) {
    activeProfile = "trend_riding";
    confidence = 0.82;
    reasons.push("Ticker regime is trending");
    reasons.push("Market internals are risk-on");
    if (trendPersistence >= 0.58) reasons.push(`Trend persistence ${trendPersistence.toFixed(2)}`);
    if (flags?.sq30_release || flags?.sq1h_release) reasons.push("Squeeze has fired");
  } else if (
    tickerRegime === "CHOPPY" ||
    riskState === "risk_off" ||
    internals?.vix?.state === "fear" ||
    internals?.sector_rotation?.state === "risk_off"
  ) {
    activeProfile = "choppy_selective";
    confidence = 0.84;
    if (tickerRegime === "CHOPPY") reasons.push("Ticker regime is choppy");
    if (riskState === "risk_off") reasons.push("Market internals are risk-off");
    if (internals?.vix?.state === "fear") reasons.push("VIX is in fear mode");
    if (internals?.sector_rotation?.state === "risk_off") reasons.push("Defense sectors are leading");
  } else {
    const _rs = Number(regimeScore);
    if (Number.isFinite(_rs) && _rs < 3) {
      activeProfile = "choppy_selective";
      confidence = 0.76;
      reasons.push("Regime score below 3 — promote to choppy_selective for capital protection");
    } else {
      activeProfile = "correction_transition";
      confidence = 0.68;
      reasons.push("Mixed trend and transition evidence");
    }
    if (tickerRegime === "TRANSITIONAL") reasons.push("Ticker regime is transitional");
    if (riskState === "balanced") reasons.push("Market internals are balanced");
    if (personality === "PULLBACK_PLAYER" || personality === "MEAN_REVERT") reasons.push("Ticker character favors pullback entries");
  }

  const adjustments = {
    trend_riding: {
      minHTFScoreAdj: 0,
      minRRAdj: 0,
      maxCompletionAdj: 0.08,
      positionSizeMultiplierAdj: 1.05,
      slCushionMultiplierAdj: 1.0,
      requireSqueezeRelease: false,
      defendWinnerBias: "hold_runner",
    },
    correction_transition: {
      minHTFScoreAdj: 3,
      minRRAdj: 0.15,
      maxCompletionAdj: -0.02,
      positionSizeMultiplierAdj: 0.9,
      slCushionMultiplierAdj: 1.05,
      requireSqueezeRelease: false,
      defendWinnerBias: "trim_then_reassess",
    },
    choppy_selective: {
      minHTFScoreAdj: 8,
      minRRAdj: 0.4,
      maxCompletionAdj: -0.1,
      positionSizeMultiplierAdj: 0.7,
      slCushionMultiplierAdj: 1.1,
      requireSqueezeRelease: true,
      defendWinnerBias: "quick_defend",
    },
  }[activeProfile];

  if (eqScore >= 75) confidence = Math.min(0.92, confidence + 0.05);
  if (profile?.entryThresholdAdj > 0 && activeProfile !== "trend_riding") {
    reasons.push(`Ticker-specific threshold adjustment ${profile.entryThresholdAdj}`);
  }

  return {
    active_profile: activeProfile,
    confidence: Math.round(confidence * 100) / 100,
    reasons,
    ticker_regime: tickerRegime,
    market_state: riskState,
    state,
    personality: profile?.personality || profile?.behaviorType || null,
    adjustments,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ENTRY QUALITY SCORE — Phoenix-Inspired, Swing-Calibrated (0-100)
//
// Adapted from Phoenix v2 Cross Quality Score for swing/position trading.
// Timeframe mapping: Phoenix LTF(1m/3m) → TT LTF(10m/30m),
//                    Phoenix chart(3m)  → TT decision(30m/1H),
//                    Phoenix HTF(10m/30m/60m) → TT HTF(4H/D/W)
//
// Three pillars:
//   Structure (35 pts): Multi-TF EMA alignment across the swing stack
//   Momentum  (35 pts): SuperTrend Matrix across 10m/30m/1H/4H
//   Confirm   (30 pts): Regime + Phase + RSI confluence
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Compute Entry Quality Score (0-100) for swing/position trading.
 *
 * @param {object} bundles - { W, D, "240", "60", "30", "10" }
 * @param {string} side - "LONG" or "SHORT"
 * @param {object} regime - { daily, weekly, combined } from computeSwingRegime
 * @returns {{ score: number, structure: number, momentum: number, confirmation: number, details: object }}
 */
export function computeEntryQualityScore(bundles, side, regime = null, liqData = null) {
  const isLong = side === "LONG";

  const leadingTf = bundles?.["15"] ? "15" : "10";
  const leadLabel = leadingTf === "15" ? "15m" : "10m";
  const b10  = bundles?.[leadingTf];
  const b30  = bundles?.["30"];
  const b1H  = bundles?.["60"];
  const b4H  = bundles?.["240"];
  const bD   = bundles?.D;

  // ── HTF FOUNDATION (30 pts): 4H + D alignment ──
  // Best entries have strong HTF structure. Only count the anchor timeframes
  // that define the macro trend — NOT the LTF which should be in pullback.
  let htfFoundation = 0;
  const emaAligned = {};

  const htfChecks = [
    { b: b4H,  pts: 13,  label: "4H"  },
    { b: bD,   pts: 12,  label: "D"   },
  ];
  for (const { b, pts, label } of htfChecks) {
    if (!b || !Number.isFinite(b.e13) || !Number.isFinite(b.e48)) continue;
    const bullish = b.e13 > b.e48;
    const aligned = isLong ? bullish : !bullish;
    emaAligned[label] = aligned;
    if (aligned) htfFoundation += pts;
  }
  // 4H SuperTrend supportive = +5
  if (b4H && Number.isFinite(b4H.stDir)) {
    const st4HBull = b4H.stDir < 0;
    const st4HSupport = isLong ? st4HBull : !st4HBull;
    if (st4HSupport) htfFoundation += 5;
  }

  // ── LTF RECOVERY (35 pts): Reward pullback recovery, NOT full alignment ──
  // The best entries are when LTF is recovering FROM a pullback into HTF support.
  // Penalize full LTF alignment (late entry). Reward recent ST flips, RSI bounce.
  let ltfRecovery = 0;
  const recoveryDetails = {};

  // 15m/30m SuperTrend: supportive = moderate points, but opposing = actually fine
  // (means we're entering on the pullback itself, which is ideal IF recovering)
  const stLead = b10 && Number.isFinite(b10.stDir) ? (isLong ? b10.stDir < 0 : b10.stDir > 0) : null;
  const st30   = b30 && Number.isFinite(b30.stDir) ? (isLong ? b30.stDir < 0 : b30.stDir > 0) : null;
  const st1H   = b1H && Number.isFinite(b1H.stDir) ? (isLong ? b1H.stDir < 0 : b1H.stDir > 0) : null;

  // Ideal pattern: 1H ST bearish (pullback in progress) while 15m flips bullish (recovery)
  if (stLead === true && st1H === false) {
    ltfRecovery += 15; // pullback recovery — highest conviction entry
    recoveryDetails.pattern = "pullback_recovery";
  } else if (stLead === true && st30 === false) {
    ltfRecovery += 12; // partial recovery — 15m leading while 30m still pulling back
    recoveryDetails.pattern = "partial_recovery";
  } else if (stLead === true && st30 === true && st1H === true) {
    ltfRecovery += 5; // full alignment = late entry — minimal points
    recoveryDetails.pattern = "full_alignment_late";
  } else if (stLead === true) {
    ltfRecovery += 8;
    recoveryDetails.pattern = "lead_supportive";
  } else {
    ltfRecovery += 2; // lead TF opposing — very early or failing
    recoveryDetails.pattern = "early_or_failing";
  }

  // 15m EMA(13)/EMA(48) alignment: points for LTF structure
  if (b10 && Number.isFinite(b10.e13) && Number.isFinite(b10.e48)) {
    const ltfEmaBull = b10.e13 > b10.e48;
    const ltfEmaAligned = isLong ? ltfEmaBull : !ltfEmaBull;
    emaAligned[leadLabel] = ltfEmaAligned;
    if (ltfEmaAligned) ltfRecovery += 5;
  }

  // 30m structure
  if (b30 && Number.isFinite(b30.e13) && Number.isFinite(b30.e48)) {
    const m30Bull = b30.e13 > b30.e48;
    const m30Aligned = isLong ? m30Bull : !m30Bull;
    emaAligned["30m"] = m30Aligned;
    if (m30Aligned) ltfRecovery += 5;
  }

  // 1H EMA alignment — moderate weight (transition TF between LTF and HTF)
  if (b1H && Number.isFinite(b1H.e13) && Number.isFinite(b1H.e48)) {
    const h1Bull = b1H.e13 > b1H.e48;
    const h1Aligned = isLong ? h1Bull : !h1Bull;
    emaAligned["1H"] = h1Aligned;
    if (h1Aligned) ltfRecovery += 5;
  }

  // RSI recovery bonus: 15m RSI bouncing from oversold (LONG) or overbought (SHORT)
  const rsi15 = b10?.rsi ?? 50;
  if (isLong) {
    if (rsi15 >= 40 && rsi15 <= 60) { ltfRecovery += 5; recoveryDetails.rsi15 = "recovery_zone"; }
    else if (rsi15 >= 30 && rsi15 < 40) { ltfRecovery += 3; recoveryDetails.rsi15 = "oversold_bounce"; }
  } else {
    if (rsi15 >= 40 && rsi15 <= 60) { ltfRecovery += 5; recoveryDetails.rsi15 = "recovery_zone"; }
    else if (rsi15 > 60 && rsi15 <= 70) { ltfRecovery += 3; recoveryDetails.rsi15 = "overbought_bounce"; }
  }

  // ── CONFIRMATION (35 pts): Regime + Phase + RSI 1H + Squeeze ──
  let confirmation = 0;
  const confirmDetails = {};

  // Daily regime (12 pts)
  if (regime) {
    const dReg = regime.daily;
    const wantUp = isLong ? "uptrend" : "downtrend";
    if (dReg === wantUp) {
      confirmation += 12;
      confirmDetails.regime = "aligned";
    } else if (dReg === "transition") {
      confirmation += 6;
      confirmDetails.regime = "transition";
    } else {
      confirmDetails.regime = "opposing";
    }
  } else {
    const htfScore = computeWeightedHTFScore(bundles?.M, bundles?.W, bD, b4H);
    if ((isLong && htfScore > 10) || (!isLong && htfScore < -10)) {
      confirmation += 10;
      confirmDetails.regime = "score_aligned";
    } else if (Math.abs(htfScore) <= 10) {
      confirmation += 5;
      confirmDetails.regime = "score_neutral";
    }
  }

  // Phase oscillator not at extreme (8 pts)
  const phaseOsc1H = b1H?.phaseOsc ?? 0;
  const phaseAbs = Math.abs(phaseOsc1H);
  if (phaseAbs < 61.8) {
    confirmation += 8;
    confirmDetails.phase = "healthy";
  } else if (phaseAbs < 80) {
    confirmation += 4;
    confirmDetails.phase = "elevated";
  } else {
    confirmDetails.phase = "extreme";
  }

  // 1H RSI positioning (10 pts)
  const rsi1H = b1H?.rsi ?? 50;
  if (isLong) {
    if (rsi1H >= 40 && rsi1H <= 65) { confirmation += 10; confirmDetails.rsi = "ideal"; }
    else if (rsi1H >= 30 && rsi1H <= 72) { confirmation += 5; confirmDetails.rsi = "acceptable"; }
    else { confirmDetails.rsi = "extreme"; }
  } else {
    if (rsi1H >= 35 && rsi1H <= 60) { confirmation += 10; confirmDetails.rsi = "ideal"; }
    else if (rsi1H >= 28 && rsi1H <= 70) { confirmation += 5; confirmDetails.rsi = "acceptable"; }
    else { confirmDetails.rsi = "extreme"; }
  }

  // Squeeze release bonus (5 pts)
  const sq30Release = b30?.sqRelease || false;
  const sq1HRelease = b1H?.sqRelease || false;
  if (sq30Release || sq1HRelease) {
    confirmation = Math.min(35, confirmation + 5);
    confirmDetails.squeeze_release = true;
  }

  // ── LIQUIDITY ZONE ADJUSTMENT (±10 pts): Penalize congestion, reward room ──
  let liqAdj = 0;
  const liqDetails = {};
  if (liqData) {
    const liq4H = liqData.liq_4h;
    const liqD = liqData.liq_D;
    const primaryLiq = liq4H || liqD;
    if (primaryLiq) {
      const targetDist = isLong ? primaryLiq.nearestBuysideDist : primaryLiq.nearestSellsideDist;
      if (targetDist > 0) {
        if (targetDist < 0.5) {
          liqAdj = -10;
          liqDetails.zone = "congested";
        } else if (targetDist < 1.0) {
          liqAdj = -5;
          liqDetails.zone = "near_zone";
        } else if (targetDist >= 1.5 && targetDist <= 4.0) {
          liqAdj = 5;
          liqDetails.zone = "room_to_run";
        } else {
          liqDetails.zone = "far";
        }
        liqDetails.dist = Math.round(targetDist * 100) / 100;
        liqDetails.tf = liq4H ? "4H" : "D";
      }
    }
  }

  // ── LOOKBACK BONUS (up to +12 pts): Reward setup stalking signals ──
  let lookbackBonus = 0;
  const lookbackDetails = {};
  const b10Lb = b10?.lookback;
  const b30Lb = b30?.lookback;
  const b1HLb = b1H?.lookback;

  const td9Opposite = isLong
    ? (b1HLb?.td9BearIn20 || b30Lb?.td9BearIn20)
    : (b1HLb?.td9BullIn20 || b30Lb?.td9BullIn20);
  if (td9Opposite) { lookbackBonus += 5; lookbackDetails.td9_opposite = true; }

  const rsiRecovery = isLong
    ? (b10Lb?.rsiWasExtremeLo15 || b30Lb?.rsiWasExtremeLo15)
    : (b10Lb?.rsiWasExtremeHi15 || b30Lb?.rsiWasExtremeHi15);
  if (rsiRecovery) { lookbackBonus += 4; lookbackDetails.rsi_recovery = true; }

  if (b10Lb?.stFlipFresh) { lookbackBonus += 3; lookbackDetails.st_flip_fresh = true; }

  lookbackBonus = Math.min(12, lookbackBonus);

  const total = htfFoundation + ltfRecovery + confirmation + liqAdj + lookbackBonus;

  return {
    score: Math.min(100, Math.max(0, total)),
    structure: htfFoundation,
    momentum: ltfRecovery,
    confirmation,
    liqAdj,
    lookbackBonus,
    details: {
      emaAligned,
      confirmDetails,
      recoveryDetails,
      liqDetails,
      lookbackDetails,
      rsi1H: Math.round(rsi1H * 10) / 10,
      rsi15: Math.round(rsi15 * 10) / 10,
      phaseOsc1H: Math.round(phaseOsc1H * 10) / 10,
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SWING STRUCTURE REGIME DETECTION (Phase 2a)
//
// Port of Phoenix v2 Regime Structure, but on Daily and Weekly timeframes.
// Detects Higher Highs / Higher Lows (uptrend) vs Lower Highs / Lower Lows
// (downtrend) to catch trend turns earlier than EMA-weighted scores.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Find swing pivots (highs and lows) from OHLC bars.
 * Uses lookback bars on each side to confirm a pivot.
 *
 * @param {Array} bars - sorted ascending by time, { o, h, l, c, ts }
 * @param {number} lookback - bars on each side required for pivot confirmation
 * @returns {{ highs: Array<{price:number, idx:number, ts:number}>, lows: Array<{price:number, idx:number, ts:number}> }}
 */
function findSwingPivots(bars, lookback) {
  const highs = [];
  const lows = [];
  if (!bars || bars.length < lookback * 2 + 1) return { highs, lows };

  for (let i = lookback; i < bars.length - lookback; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= lookback; j++) {
      if (bars[i].h <= bars[i - j].h || bars[i].h <= bars[i + j].h) isHigh = false;
      if (bars[i].l >= bars[i - j].l || bars[i].l >= bars[i + j].l) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) highs.push({ price: bars[i].h, idx: i, ts: bars[i].ts || 0 });
    if (isLow)  lows.push({ price: bars[i].l, idx: i, ts: bars[i].ts || 0 });
  }
  return { highs, lows };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Elliott Wave Impulse Detection
// Ported from TradingView "Elliot Wave - Impulse" by HeWhoMustNotBeNamed.
// Detects Wave 1-2 completion via zigzag + Fibonacci retracement validation,
// then projects Wave 3 targets and invalidation levels.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build a zigzag from OHLC bars with strict alternation (H→L→H→L).
 * Consecutive same-direction pivots are merged (keep the more extreme value).
 *
 * @param {Array} bars - sorted ascending, { o, h, l, c, ts }
 * @param {number} length - lookback for pivot confirmation
 * @returns {Array<{price:number, idx:number, ts:number, dir:number}>}
 *          dir: 1 = swing high, -1 = swing low
 */
function computeZigzag(bars, length) {
  if (!bars || bars.length < length * 2 + 1) return [];

  const raw = [];
  for (let i = length; i < bars.length - length; i++) {
    let isHigh = true, isLow = true;
    for (let j = 1; j <= length; j++) {
      if (bars[i].h <= bars[i - j].h || bars[i].h <= bars[i + j].h) isHigh = false;
      if (bars[i].l >= bars[i - j].l || bars[i].l >= bars[i + j].l) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) raw.push({ price: bars[i].h, idx: i, ts: bars[i].ts || 0, dir: 1 });
    if (isLow)  raw.push({ price: bars[i].l, idx: i, ts: bars[i].ts || 0, dir: -1 });
  }

  raw.sort((a, b) => a.idx - b.idx);

  const zz = [];
  for (const p of raw) {
    if (zz.length === 0) { zz.push(p); continue; }
    const last = zz[zz.length - 1];
    if (p.dir === last.dir) {
      if ((p.dir === 1 && p.price > last.price) || (p.dir === -1 && p.price < last.price)) {
        zz[zz.length - 1] = p;
      }
    } else {
      zz.push(p);
    }
  }
  return zz;
}

/**
 * Detect Elliott Wave impulse (Wave 1-2 completion → Wave 3 ready).
 * Validates Wave 2 retracement against Fibonacci ratios, then projects
 * Wave 3 targets using Fibonacci extensions of Wave 1 length.
 *
 * @param {Array} bars - OHLC bars sorted ascending
 * @param {number} [zigzagLength=10] - lookback for zigzag pivots
 * @param {number} [errorPct=5] - tolerance % for Fibonacci matching
 * @returns {object|null} EW impulse descriptor or null
 */
function detectEWImpulse(bars, zigzagLength = 10, errorPct = 5) {
  const zz = computeZigzag(bars, zigzagLength);
  if (zz.length < 3) return null;

  const p0 = zz[zz.length - 3]; // Wave 1 start
  const p1 = zz[zz.length - 2]; // Wave 1 end = Wave 2 start
  const p2 = zz[zz.length - 1]; // Wave 2 end = Wave 3 start

  const w1Len = Math.abs(p1.price - p0.price);
  const w2Len = Math.abs(p2.price - p1.price);
  if (w1Len <= 0) return null;

  const r2 = w2Len / w1Len;
  const errMin = (100 - errorPct) / 100;
  const errMax = (100 + errorPct) / 100;

  const fiboLevels = [0.382, 0.50, 0.618, 0.764, 0.854];
  let matchedFibo = null;
  for (const fib of fiboLevels) {
    if (r2 > fib * errMin && r2 < fib * errMax) { matchedFibo = fib; break; }
  }
  if (!matchedFibo) return { detected: false };

  // dir: 1 = bullish impulse (W1 went up), -1 = bearish impulse
  const dir = p1.price > p0.price ? 1 : -1;

  return {
    detected: true,
    dir,
    r2: Math.round(r2 * 1000) / 1000,
    fiboMatch: matchedFibo,
    w1: { s: +p0.price.toFixed(2), e: +p1.price.toFixed(2) },
    w2End: +p2.price.toFixed(2),
    stop: +p0.price.toFixed(2),
    targets: {
      t1: +(p2.price + dir * 1.618 * w1Len).toFixed(2),
      t2: +(p2.price + dir * 2.0   * w1Len).toFixed(2),
      t3: +(p2.price + dir * 2.618 * w1Len).toFixed(2),
      t4: +(p2.price + dir * 3.236 * w1Len).toFixed(2),
    },
  };
}

/**
 * Classify regime from the last N swing pivots.
 * @param {{ highs: Array, lows: Array }} pivots
 * @returns {"uptrend"|"downtrend"|"transition"}
 */
function classifyRegimeFromPivots(pivots) {
  const { highs, lows } = pivots;
  if (highs.length < 2 || lows.length < 2) return "transition";

  const lastH = highs[highs.length - 1].price;
  const prevH = highs[highs.length - 2].price;
  const lastL = lows[lows.length - 1].price;
  const prevL = lows[lows.length - 2].price;

  const hh = lastH > prevH; // higher high
  const hl = lastL > prevL; // higher low
  const lh = lastH < prevH; // lower high
  const ll = lastL < prevL; // lower low

  if (hh && hl) return "uptrend";
  if (lh && ll) return "downtrend";
  return "transition";
}

/**
 * Compute swing regime on Daily and Weekly bars.
 *
 * @param {Array} dailyBars - sorted ascending, min ~30 bars
 * @param {Array} weeklyBars - sorted ascending, min ~20 bars
 * @returns {{ daily: string, weekly: string, combined: string }}
 */
export function computeSwingRegime(dailyBars, weeklyBars) {
  // Daily: 15-bar lookback (~3 weeks of trading days)
  const dailyPivots = findSwingPivots(dailyBars, 15);
  const daily = classifyRegimeFromPivots(dailyPivots);

  // Weekly: 10-bar lookback (~10 weeks)
  const weeklyPivots = findSwingPivots(weeklyBars, 10);
  const weekly = classifyRegimeFromPivots(weeklyPivots);

  // Combined regime label
  const COMBINED = {
    "uptrend_uptrend": "STRONG_BULL",
    "uptrend_transition": "EARLY_BULL",
    "uptrend_downtrend": "COUNTER_TREND_BULL",
    "transition_uptrend": "LATE_BULL",
    "transition_transition": "NEUTRAL",
    "transition_downtrend": "EARLY_BEAR",
    "downtrend_uptrend": "COUNTER_TREND_BEAR",
    "downtrend_transition": "LATE_BEAR",
    "downtrend_downtrend": "STRONG_BEAR",
  };
  const combined = COMBINED[`${daily}_${weekly}`] || "NEUTRAL";

  return {
    daily,
    weekly,
    combined,
    pivots: {
      daily: {
        lastHigh: dailyPivots.highs[dailyPivots.highs.length - 1] || null,
        lastLow: dailyPivots.lows[dailyPivots.lows.length - 1] || null,
        prevHigh: dailyPivots.highs[dailyPivots.highs.length - 2] || null,
        prevLow: dailyPivots.lows[dailyPivots.lows.length - 2] || null,
      },
      weekly: {
        lastHigh: weeklyPivots.highs[weeklyPivots.highs.length - 1] || null,
        lastLow: weeklyPivots.lows[weeklyPivots.lows.length - 1] || null,
      },
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SWING-TF DIRECTION CONSENSUS (Phase 2b)
//
// Count EMA(13)/EMA(48) alignment across the 5 swing timeframes:
// 10m, 30m, 1H, 4H, Daily — if >= 4/5 agree, that's the direction.
// Also tracks EMA cross freshness per TF (Phase 2c).
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Compute swing-TF direction consensus and per-TF EMA cross tracking.
 *
 * @param {object} bundles - { "10", "30", "60", "240", D }
 * @param {object} regime - from computeSwingRegime (optional)
 * @returns {{ direction: "LONG"|"SHORT"|null, bullishCount: number, bearishCount: number,
 *             tfStack: object[], freshestCrossTf: string|null, freshestCrossAge: number }}
 */
/**
 * Per-TF bias: continuous score from -1.0 (bearish) to +1.0 (bullish).
 * Uses all available bundle signals instead of a single EMA cross.
 * For Daily: prioritizes 5/48 EMA cross + ST slope (bias/continuation).
 * For LTF: uses 13/48 for timing.
 */
function computeTfBias(b, signalW = null, isDaily = false) {
  const sw = signalW || {};
  const wEmaCross    = Number(sw.ema_cross)     || 0.15;
  const wEma5_48     = Number(sw.ema5_48)       || (isDaily ? 0.20 : 0); // Daily: 5/48 cross gets extra weight
  const wStSlope     = Number(sw.st_slope)      || (isDaily ? 0.15 : 0.08); // ST sloping = continuation
  const wSuperTrend  = Number(sw.supertrend)    || 0.25;
  const wEmaStruct   = Number(sw.ema_structure) || 0.25;
  const wEmaDepth    = Number(sw.ema_depth)     || 0.20;
  const wRsi         = Number(sw.rsi)            || 0.15;

  let score = 0, weight = 0;
  const signals = {};

  // EMA cross: Daily uses 5/48 (bias/continuation), LTF uses 13/48 (timing)
  if (isDaily && isFinite(b.e5) && isFinite(b.e48) && wEma5_48 > 0) {
    const s = b.e5 > b.e48 ? 1 : -1;
    score += s * wEma5_48; weight += wEma5_48;
    signals.ema5_48 = s;
  }
  if (!isDaily && isFinite(b.e13) && isFinite(b.e48)) {
    const s = b.e13 > b.e48 ? 1 : -1;
    score += s * wEmaCross; weight += wEmaCross;
    signals.ema_cross = s;
  }
  if (isDaily && isFinite(b.e13) && isFinite(b.e48)) {
    // Daily: 13/48 as confirmation (regime: 5>48 AND 13>21)
    const s = b.e13 > b.e48 ? 1 : -1;
    score += s * wEmaCross; weight += wEmaCross;
    signals.ema_cross = s;
  }

  // ST slope: sloping in trend direction = strong continuation (Daily gets higher weight)
  const stSlopeAlign = (b.stDir === -1 && b.stSlopeUp) || (b.stDir === 1 && b.stSlopeDn);
  if (stSlopeAlign && wStSlope > 0) {
    const s = b.stDir === -1 ? 1 : -1;
    score += s * wStSlope; weight += wStSlope;
    signals.st_slope = s;
  }

  if (b.stDir === -1 || b.stDir === 1) {
    const s = b.stDir === -1 ? 1 : -1;
    score += s * wSuperTrend; weight += wSuperTrend;
    signals.supertrend = s;
  }
  if (isFinite(b.emaStructure)) {
    score += b.emaStructure * wEmaStruct; weight += wEmaStruct;
    signals.ema_structure = Math.round(b.emaStructure * 1000) / 1000;
  }
  if (isFinite(b.emaDepth)) {
    const s = (b.emaDepth - 5) / 5;
    score += s * wEmaDepth; weight += wEmaDepth;
    signals.ema_depth = b.emaDepth;
  }
  if (isFinite(b.rsi)) {
    const s = clamp((b.rsi - 50) / 30, -1, 1);
    score += s * wRsi; weight += wRsi;
    signals.rsi = Math.round(b.rsi * 10) / 10;
  }

  const bias = weight > 0 ? clamp(score / weight, -1, 1) : 0;
  return { bias: Math.round(bias * 1000) / 1000, signals };
}

export function computeSwingConsensus(bundles, regime = null, tfWeights = null, signalWeights = null) {
  // Daily gets higher weight: 5/48 cross + ST slope = strong bias/continuation
  const leadingTf = bundles?.["15"] ? "15" : "10";
  const DEFAULT_WEIGHTS = { "10": 1, "15": 1, "30": 1, "60": 1, "240": 1, "D": 1.5 };
  const w = tfWeights && typeof tfWeights === "object" ? { ...DEFAULT_WEIGHTS, ...tfWeights } : DEFAULT_WEIGHTS;

  const TFS = [
    { key: leadingTf, label: leadingTf === "15" ? "15m" : "10m", b: bundles?.[leadingTf], isDaily: false },
    { key: "30",  label: "30m", b: bundles?.["30"], isDaily: false },
    { key: "60",  label: "1H",  b: bundles?.["60"], isDaily: false },
    { key: "240", label: "4H",  b: bundles?.["240"], isDaily: false },
    { key: "D",   label: "D",   b: bundles?.D, isDaily: true },
  ];

  let bullishCount = 0;
  let bearishCount = 0;
  let totalBiasWeighted = 0;
  let totalWeight = 0;
  const tfStack = [];
  let freshestCrossTf = null;
  let freshestCrossAge = Infinity;

  for (const { key, label, b, isDaily } of TFS) {
    const tfW = Number(w[key]) || 1;
    const hasSignalInputs = !!b && (
      Number.isFinite(b?.e13) ||
      Number.isFinite(b?.e48) ||
      Number.isFinite(b?.stDir) ||
      Number.isFinite(b?.emaStructure) ||
      Number.isFinite(b?.emaDepth) ||
      Number.isFinite(b?.rsi)
    );
    if (!hasSignalInputs) {
      tfStack.push({ tf: label, bias: "unknown", biasScore: 0, weight: tfW, signals: {}, crossAge: null, crossDir: null });
      continue;
    }

    const { bias: biasScore, signals } = computeTfBias(b, signalWeights, isDaily);

    totalWeight += tfW;
    totalBiasWeighted += biasScore * tfW;

    const bullish = biasScore > 0;
    if (biasScore > 0) bullishCount++;
    else if (biasScore < 0) bearishCount++;

    // Daily: prefer 5/48 cross; LTF: use 13/48 cross
    const crossUp = isDaily ? (b.emaCross5_48_up || b.emaCross13_48_up) : b.emaCross13_48_up;
    const crossDn = isDaily ? (b.emaCross5_48_dn || b.emaCross13_48_dn) : b.emaCross13_48_dn;
    const crossDir = crossUp ? "up" : crossDn ? "down" : null;

    const crossTs = crossUp
      ? (b.emaCross5_48_up_ts || b.emaCross13_48_up_ts || 0)
      : crossDn
        ? (b.emaCross5_48_dn_ts || b.emaCross13_48_dn_ts || 0)
        : 0;
    const crossAge = (crossTs > 0 && b.lastTs > 0) ? Math.max(0, b.lastTs - crossTs) : null;

    if (crossTs > 0 && crossAge !== null && crossAge < freshestCrossAge) {
      freshestCrossAge = crossAge;
      freshestCrossTf = label;
    }

    tfStack.push({
      tf: label,
      bias: bullish ? "bullish" : "bearish",
      biasScore,
      weight: tfW,
      signals,
      crossDir,
      crossAge: crossAge !== null ? Math.round(crossAge / 60000) : null,
    });
  }

  const avgBias = totalWeight > 0 ? totalBiasWeighted / totalWeight : 0;
  const regimeDaily = regime?.daily || "transition";

  let direction = null;
  if (avgBias > 0.3 && regimeDaily !== "downtrend") {
    direction = "LONG";
  } else if (avgBias < -0.3 && regimeDaily !== "uptrend") {
    direction = "SHORT";
  } else if (avgBias > 0.15 && (regimeDaily === "uptrend" || regimeDaily === "transition")) {
    direction = "LONG";
  } else if (avgBias < -0.15 && (regimeDaily === "downtrend" || regimeDaily === "transition")) {
    direction = "SHORT";
  }

  const bullishPct = totalWeight > 0 ? Math.round(((avgBias + 1) / 2) * 100) : null;
  const bearishPct = bullishPct != null ? 100 - bullishPct : null;

  return {
    direction,
    bullishCount,
    bearishCount,
    bullishPct,
    bearishPct,
    avgBias: Math.round(avgBias * 1000) / 1000,
    tfStack,
    freshestCrossTf,
    freshestCrossAge: freshestCrossAge === Infinity ? null : Math.round(freshestCrossAge / 60000),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// VOLATILITY TIER CLASSIFICATION (Phase 3a)
//
// Based on 20-day Daily ATR/price ratio.
// LOW (< 1.5%): WMT, COST — steady compounders
// MEDIUM (1.5-3%): AAPL, MSFT — standard swing candidates
// HIGH (3-5%): TSLA, NVDA — bigger moves, bigger risk
// EXTREME (> 5%): MSTR, IONQ — position-size carefully
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Classify ticker volatility tier from Daily ATR and price.
 *
 * @param {number} atr14Daily - 14-period ATR on Daily candles
 * @param {number} price - current price
 * @returns {{ tier: "LOW"|"MEDIUM"|"HIGH"|"EXTREME", atrPct: number,
 *             slCap: {min:number, max:number}, entryQualityMin: number }}
 */
export function classifyVolatilityTier(atr14Daily, price) {
  if (!Number.isFinite(atr14Daily) || !Number.isFinite(price) || price <= 0) {
    return { tier: "MEDIUM", atrPct: 0, slCap: { min: 0.01, max: 0.03 }, entryQualityMin: 55 };
  }

  const atrPct = (atr14Daily / price) * 100;

  if (atrPct < 1.5) {
    return { tier: "LOW", atrPct: Math.round(atrPct * 100) / 100, slCap: { min: 0.008, max: 0.02 }, entryQualityMin: 50 };
  }
  if (atrPct < 3.0) {
    return { tier: "MEDIUM", atrPct: Math.round(atrPct * 100) / 100, slCap: { min: 0.01, max: 0.03 }, entryQualityMin: 55 };
  }
  if (atrPct < 5.0) {
    return { tier: "HIGH", atrPct: Math.round(atrPct * 100) / 100, slCap: { min: 0.015, max: 0.04 }, entryQualityMin: 65 };
  }
  return { tier: "EXTREME", atrPct: Math.round(atrPct * 100) / 100, slCap: { min: 0.02, max: 0.05 }, entryQualityMin: 70 };
}

// ═══════════════════════════════════════════════════════════════════════════════
// FLAG DETECTION (compares current and previous bundles)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Detect event-based flags from bundles across all timeframes.
 * @param {object} bundles - { W, D, "240", "60", "30", "10" } current bundles
 * @returns {object} flags matching the shape expected by qualifiesForEnter / classifyKanbanStage
 */
export function detectFlags(bundles) {
  const flags = {};
  const b5 = bundles?.["5"];
  const b10 = bundles?.["10"];
  const b30 = bundles?.["30"];
  const b60 = bundles?.["60"];
  const bD = bundles?.["D"];
  const b4H = bundles?.["240"];

  // SuperTrend flips (with timestamps)
  if (b30?.stFlip) { flags.st_flip_30m = true; flags.st_flip_30m_ts = b30.stFlip_ts; }
  if (b60?.stFlip) { flags.st_flip_1h = true; flags.st_flip_1h_ts = b60.stFlip_ts; }
  if (b4H?.stFlip) { flags.st_flip_4h = true; flags.st_flip_4h_ts = b4H.stFlip_ts; }
  if (b10?.stFlip) { flags.st_flip_10m = true; flags.st_flip_10m_ts = b10.stFlip_ts; }
  // Bear-side ST flip (30m/1H/4H — timestamp is the most recent bear flip)
  if (b30?.stFlipDir === -1 || b60?.stFlipDir === -1 || b4H?.stFlipDir === -1) {
    flags.st_flip_bear = true;
    flags.st_flip_bear_ts = Math.max(
      b30?.stFlipDir === -1 ? (b30.stFlip_ts || 0) : 0,
      b60?.stFlipDir === -1 ? (b60.stFlip_ts || 0) : 0,
      b4H?.stFlipDir === -1 ? (b4H.stFlip_ts || 0) : 0
    );
  }
  // Bull-side ST flip (30m/1H/4H — needed for SHORT exit logic)
  if (b30?.stFlipDir === 1 || b60?.stFlipDir === 1 || b4H?.stFlipDir === 1) {
    flags.st_flip_bull = true;
    flags.st_flip_bull_ts = Math.max(
      b30?.stFlipDir === 1 ? (b30.stFlip_ts || 0) : 0,
      b60?.stFlipDir === 1 ? (b60.stFlip_ts || 0) : 0,
      b4H?.stFlipDir === 1 ? (b4H.stFlip_ts || 0) : 0
    );
  }

  // EMA 13/48 crosses (with timestamps)
  if (b60?.emaCross13_48_up || b60?.emaCross13_48_dn) {
    flags.ema_cross_1h_13_48 = true;
    flags.ema_cross_1h_13_48_ts = b60.emaCross13_48_up_ts || b60.emaCross13_48_dn_ts || 0;
  }
  if (b30?.emaCross13_48_up || b30?.emaCross13_48_dn) {
    flags.ema_cross_30m_13_48 = true;
    flags.ema_cross_30m_13_48_ts = b30.emaCross13_48_up_ts || b30.emaCross13_48_dn_ts || 0;
  }

  // Daily EMA crosses (5/48 = early signal, 13/21 = confirmation)
  if (bD?.emaCross5_48_up) { flags.ema_cross_D_5_48_bull = true; flags.ema_cross_D_5_48_bull_ts = bD.emaCross5_48_up_ts; }
  if (bD?.emaCross5_48_dn) { flags.ema_cross_D_5_48_bear = true; flags.ema_cross_D_5_48_bear_ts = bD.emaCross5_48_dn_ts; }
  if (bD?.emaCross13_21_up) { flags.ema_cross_D_13_21_bull = true; flags.ema_cross_D_13_21_bull_ts = bD.emaCross13_21_up_ts; }
  if (bD?.emaCross13_21_dn) { flags.ema_cross_D_13_21_bear = true; flags.ema_cross_D_13_21_bear_ts = bD.emaCross13_21_dn_ts; }

  // EMA regime per timeframe (-2 to +2)
  flags.ema_regime_D = bD?.emaRegime ?? 0;
  flags.ema_regime_4H = b4H?.emaRegime ?? 0;
  flags.ema_regime_1H = b60?.emaRegime ?? 0;
  // EMA position state (current, not just cross events)
  flags.ema5above48_D = bD?.ema5above48 ?? false;
  flags.ema13above21_D = bD?.ema13above21 ?? false;

  // Squeeze state and releases (with timestamps)
  if (b30?.sqOn) { flags.sq30_on = true; }
  if (b30?.sqRelease) { flags.sq30_release = true; flags.sq30_release_ts = b30.sqRelease_ts; }
  if (b60?.sqOn) { flags.sq1h_on = true; }
  if (b60?.sqRelease) { flags.sq1h_release = true; flags.sq1h_release_ts = b60.sqRelease_ts; }

  // Momentum elite: strong momentum across multiple TFs
  const strongMom = [b30, b10, b5].filter(b => {
    if (!b || !Number.isFinite(b.mom) || !Number.isFinite(b.momStd) || b.momStd <= 0) return false;
    return Math.abs(b.mom / b.momStd) > 1.0;
  });
  if (strongMom.length >= 2) flags.momentum_elite = true;

  // Phase zone change (simplified: check if any LTF is in EXTREME zone)
  if (b30?.phaseZone === "EXTREME" || b10?.phaseZone === "EXTREME") {
    flags.phase_zone_change = true;
  }

  // SMC / ICT indicators: PDZ, FVG, Liquidity (for trail_5m_facts aggregation)
  if (bD?.pdz) {
    flags.pdz_zone_D = bD.pdz.zone;
    flags.pdz_pct_D = bD.pdz.pct;
  }
  if (b4H?.pdz) {
    flags.pdz_zone_4h = b4H.pdz.zone;
    flags.pdz_pct_4h = b4H.pdz.pct;
  }
  if (bD?.fvg) {
    flags.fvg_bull_D = bD.fvg.activeBull || 0;
    flags.fvg_bear_D = bD.fvg.activeBear || 0;
    flags.fvg_in_bull_D = bD.fvg.inBullGap ? 1 : 0;
    flags.fvg_in_bear_D = bD.fvg.inBearGap ? 1 : 0;
  }
  if (bD?.liq) {
    flags.liq_bs_D = bD.liq.buysideCount || 0;
    flags.liq_ss_D = bD.liq.sellsideCount || 0;
    flags.liq_bs_dist_D = bD.liq.nearestBuysideDist ?? -1;
    flags.liq_ss_dist_D = bD.liq.nearestSellsideDist ?? -1;
  }

  return flags;
}

// ═══════════════════════════════════════════════════════════════════════════════
// LAYER 2: MULTI-TF SUPERTREND SUPPORT MAP
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Synthesize SuperTrend direction + slope across all timeframes into a
 * single support assessment.
 *
 * @param {object} bundles - { W, D, "240", "60", "30", "10" }
 * @returns {object} { map, bullCount, bearCount, slopeAligned, supportScore }
 */
export function buildSTSupportMap(bundles) {
  const leadingTf = bundles?.["15"] ? "15" : "10";
  const TF_WEIGHTS = { W: 0.26, D: 0.23, "240": 0.19, "60": 0.15, "30": 0.10, [leadingTf]: 0.07 };
  const map = {};
  let bullCount = 0;
  let bearCount = 0;
  let slopeAligned = 0;
  let weightedScore = 0;
  let totalWeight = 0;

  for (const [tf, w] of Object.entries(TF_WEIGHTS)) {
    const b = bundles?.[tf];
    if (!b || !Number.isFinite(b.stDir)) continue;

    const dir = b.stDir < 0 ? "bull" : "bear"; // Pine convention: -1 = bull
    const slope = b.stSlopeUp ? "rising" : b.stSlopeDn ? "falling" : "flat";
    const dirSign = dir === "bull" ? 1 : -1;
    const slopeSign = slope === "rising" ? 1 : slope === "falling" ? -1 : 0;
    const aligned = (dirSign === 1 && slopeSign >= 0) || (dirSign === -1 && slopeSign <= 0);

    map[tf] = { dir, slope, aligned };
    if (dir === "bull") bullCount++;
    else bearCount++;
    if (aligned) slopeAligned++;

    // Weighted contribution: direction match + slope bonus
    let tfScore = dirSign * w;
    if (aligned) tfScore += Math.abs(w) * 0.3; // 30% slope alignment bonus
    weightedScore += tfScore;
    totalWeight += w;
  }

  // Normalize to 0.0–1.0 (0.5 = neutral, 1.0 = fully bullish aligned, 0.0 = fully bearish)
  const rawScore = totalWeight > 0 ? (weightedScore / totalWeight) : 0;
  const supportScore = Math.max(0, Math.min(1, (rawScore + 1.3) / 2.6)); // map [-1.3, 1.3] → [0, 1]

  return { map, bullCount, bearCount, slopeAligned, supportScore: Math.round(supportScore * 1000) / 1000 };
}

// ═══════════════════════════════════════════════════════════════════════════════
// LAYER 3: ATR FIBONACCI LEVEL MAPS (TT ATR Levels)
// ═══════════════════════════════════════════════════════════════════════════════

const FIB_RATIOS = [0.236, 0.382, 0.500, 0.618, 0.786, 1.000, 1.236, 1.618, 2.000, 2.618, 3.000];

/**
 * Compute Fibonacci-based ATR levels for a given horizon (TT ATR Levels).
 *
 * Modes map scoring TF → anchor TF:
 *   Day (15m → Daily), Multiday (30m → Weekly), Swing (1H → Monthly),
 *   Position (4H → Quarterly), Long-term (D/W → Yearly)
 *
 * @param {number} prevClose - previous period close of the anchor TF
 * @param {number} atr - ATR(14) for this horizon's timeframe
 * @param {number} currentPrice - current price for gate/band detection
 * @param {string} horizonLabel - "day"|"week"|"month"|"quarter"|"longterm"
 * @param {number} [periodHigh=0] - high of current anchor period (for range exhaustion)
 * @param {number} [periodLow=0] - low of current anchor period (for range exhaustion)
 * @returns {object}
 */
export function computeATRLevels(prevClose, atr, currentPrice, horizonLabel, periodHigh = 0, periodLow = 0) {
  if (!Number.isFinite(prevClose) || !Number.isFinite(atr) || atr <= 0) {
    return { prevClose: 0, atr: 0, levels_up: [], levels_dn: [], gate: null, disp: 0, band: "NEUTRAL", rangeOfATR: 0 };
  }

  const levels_up = [];
  const levels_dn = [];
  for (const ratio of FIB_RATIOS) {
    const up = Math.round((prevClose + ratio * atr) * 100) / 100;
    const dn = Math.round((prevClose - ratio * atr) * 100) / 100;
    levels_up.push({ ratio, price: up, label: `+${(ratio * 100).toFixed(1)}%` });
    levels_dn.push({ ratio, price: dn, label: `-${(ratio * 100).toFixed(1)}%` });
  }

  // Displacement: how far price has moved from anchor in ATR multiples
  const displacement = Number.isFinite(currentPrice) ? (currentPrice - prevClose) / atr : 0;
  const absDisp = Math.abs(displacement);

  // Current band classification
  let band = "NEUTRAL";
  if (absDisp >= 3.0) band = "EXT_300";
  else if (absDisp >= 2.0) band = "EXT_200";
  else if (absDisp >= 1.0) band = "ATR_100";
  else if (absDisp >= 0.618) band = "KEY_618";
  else if (absDisp >= 0.382) band = "GATE_382";
  else if (absDisp >= 0.236) band = "TRIGGER";

  // Range exhaustion: what % of ATR has the period's range consumed
  const periodRange = (Number.isFinite(periodHigh) && Number.isFinite(periodLow) && periodHigh > periodLow)
    ? periodHigh - periodLow : 0;
  const rangeOfATR = periodRange > 0 ? Math.round((periodRange / atr) * 1000) / 10 : 0;

  // Golden Gate tracker: 38.2% entry → 61.8% completion
  const gate382_up = prevClose + 0.382 * atr;
  const gate618_up = prevClose + 0.618 * atr;
  const gate382_dn = prevClose - 0.382 * atr;
  const gate618_dn = prevClose - 0.618 * atr;

  let gate = null;
  if (Number.isFinite(currentPrice)) {
    const px = currentPrice;
    if (px >= gate382_up) {
      const completed = px >= gate618_up;
      const range = gate618_up - gate382_up;
      const progress = range > 0 ? Math.min(1, Math.max(0, (px - gate382_up) / range)) : 0;
      gate = {
        side: "bull",
        entered: true,
        completed,
        entry_level: Math.round(gate382_up * 100) / 100,
        target_level: Math.round(gate618_up * 100) / 100,
        progress_pct: Math.round(progress * 1000) / 1000,
        horizon: horizonLabel,
      };
    } else if (px <= gate382_dn) {
      const completed = px <= gate618_dn;
      const range = gate382_dn - gate618_dn;
      const progress = range > 0 ? Math.min(1, Math.max(0, (gate382_dn - px) / range)) : 0;
      gate = {
        side: "bear",
        entered: true,
        completed,
        entry_level: Math.round(gate382_dn * 100) / 100,
        target_level: Math.round(gate618_dn * 100) / 100,
        progress_pct: Math.round(progress * 1000) / 1000,
        horizon: horizonLabel,
      };
    }
  }

  return {
    prevClose: Math.round(prevClose * 100) / 100,
    atr: Math.round(atr * 100) / 100,
    trigger_up: Math.round((prevClose + 0.236 * atr) * 100) / 100,
    trigger_dn: Math.round((prevClose - 0.236 * atr) * 100) / 100,
    disp: Math.round(displacement * 1000) / 1000,
    band,
    rangeOfATR,
    levels_up,
    levels_dn,
    gate,
  };
}

/**
 * Build ATR level maps for all 5 horizons from bundles.
 * Uses the second-to-last candle's close as the previous-period close.
 *
 * @param {object} bundles - { W, D, "240", "60", "30", "10", "3" }
 * @param {number} currentPrice - latest price
 * @returns {object} { day, week, month, quarter, longterm }
 */
export function buildATRLevelMaps(bundles, currentPrice) {
  const bD = bundles?.D;
  const bW = bundles?.W;
  const bM = bundles?.M;

  const maps = {};

  // Day mode (15m anchor): previous daily close + Daily ATR(14)
  if (bD && Number.isFinite(bD.atr14)) {
    const pc = Number.isFinite(bD.pxPrev) ? bD.pxPrev : bD.px;
    maps.day = computeATRLevels(pc, bD.atr14, currentPrice, "day", bD.barHigh, bD.barLow);
  }

  // Multiday mode (30m anchor): previous weekly close + Weekly ATR(14)
  if (bW && Number.isFinite(bW.atr14)) {
    const pc = Number.isFinite(bW.pxPrev) ? bW.pxPrev : bW.px;
    maps.week = computeATRLevels(pc, bW.atr14, currentPrice, "week", bW.barHigh, bW.barLow);
  }

  // Swing mode (1H anchor): Monthly close + Monthly ATR
  if (bM && Number.isFinite(bM.atr14)) {
    const pc = Number.isFinite(bM.pxPrev) ? bM.pxPrev : bM.px;
    maps.month = computeATRLevels(pc, bM.atr14, currentPrice, "month", bM.barHigh, bM.barLow);
  } else if (bW && Number.isFinite(bW.atr14)) {
    const monthlyATR = bW.atr14 * Math.sqrt(4.33);
    const pc = Number.isFinite(bW.pxPrev) ? bW.pxPrev : bW.px;
    maps.month = computeATRLevels(pc, monthlyATR, currentPrice, "month");
  }

  // Position mode (4H anchor): Quarterly ≈ sqrt(13) × Weekly ATR
  if (bW && Number.isFinite(bW.atr14)) {
    const quarterlyATR = bW.atr14 * Math.sqrt(13);
    const pc = Number.isFinite(bW.pxPrev) ? bW.pxPrev : bW.px;
    maps.quarter = computeATRLevels(pc, quarterlyATR, currentPrice, "quarter");
  }

  // Long-term mode (D/W anchor): Yearly ≈ sqrt(52) × Weekly ATR
  if (bW && Number.isFinite(bW.atr14)) {
    const yearlyATR = bW.atr14 * Math.sqrt(52);
    const pc = Number.isFinite(bW.pxPrev) ? bW.pxPrev : bW.px;
    maps.longterm = computeATRLevels(pc, yearlyATR, currentPrice, "longterm");
  }

  return maps;
}

// ═══════════════════════════════════════════════════════════════════════════════
// LAYER 4: PHASE/RSI FUEL GAUGE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Compute a continuous fuel gauge from phase and RSI.
 * 100% = fresh move with maximum room to run, 0% = fully exhausted.
 *
 * @param {object} bundle - TF bundle from computeTfBundle
 * @returns {{ fuelPct: number, phaseFuel: number, rsiFuel: number, status: string }}
 */
export function computeFuelGauge(bundle) {
  if (!bundle) return { fuelPct: 50, phaseFuel: 50, rsiFuel: 50, satyFuel: 50, status: "healthy" };

  const { phaseOsc, rsi, satyPhase } = bundle;

  // Saty Phase fuel: pure price-displacement from EMA21 normalized by ATR
  // |satyPhase| near 0 = full tank, near ±100+ = empty
  const satyVal = Math.abs(satyPhase?.value ?? 0);
  const satyFuel = Math.max(0, Math.min(100, 100 - satyVal));

  // Multi-factor Phase fuel (legacy)
  const phaseAbs = Math.abs(Number.isFinite(phaseOsc) ? phaseOsc : 0);
  const phaseFuel = Math.max(0, Math.min(100, 100 - phaseAbs));

  // RSI fuel: RSI near 50 = full tank, RSI near 20 or 80 = empty
  const rsiVal = Number.isFinite(rsi) ? rsi : 50;
  const rsiDistFromCenter = Math.abs(rsiVal - 50);
  const rsiFuel = Math.max(0, Math.min(100, 100 - (rsiDistFromCenter * 2)));

  // Combined: Saty Phase 40%, multi-factor Phase 20%, RSI 40%
  const fuelPct = Math.round(satyFuel * 0.4 + phaseFuel * 0.2 + rsiFuel * 0.4);

  let status;
  if (fuelPct >= 50) status = "healthy";
  else if (fuelPct >= 25) status = "low";
  else status = "critical";

  return {
    fuelPct,
    phaseFuel: Math.round(phaseFuel),
    rsiFuel: Math.round(rsiFuel),
    satyFuel: Math.round(satyFuel),
    status,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// FULL TICKER DATA ASSEMBLY
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Assemble a complete tickerData payload from Alpaca-computed bundles.
 * This produces the same shape that TradingView's ScoreEngine sends.
 *
 * @param {string} ticker
 * @param {object} bundles - { W, D, "240", "60", "30", "10", "3" }
 * @param {object} existingData - existing KV timed:latest data (for merge)
 * @param {object} [opts] - Optional: { rawBars: { D: [], W: [] }, regime: object }
 * @returns {object} tickerData payload
 */

// ═══════════════════════════════════════════════════════════════════════════════
// BREAKOUT DETECTION — Three detection methods for identifying early breakout
// setups that the reactive scoring engine misses (low rank at move start).
// Each returns a breakout descriptor { type, dir, ... } or null.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Detect daily level breakout: price breaking above lastHigh or below lastLow
 * from swing pivot analysis, with volume confirmation.
 *
 * @param {object} dailyBundle - daily TF bundle (from computeTfBundle)
 * @param {object} regime - from computeSwingRegime (has pivots.daily.lastHigh/lastLow)
 * @param {number} price - current price
 * @returns {object|null} breakout descriptor or null
 */
function detectDailyLevelBreak(dailyBundle, regime, price) {
  if (!dailyBundle || !regime?.pivots?.daily || !Number.isFinite(price) || price <= 0) return null;

  const lastHigh = regime.pivots.daily.lastHigh?.price;
  const lastLow = regime.pivots.daily.lastLow?.price;
  const atr = dailyBundle.atr14;
  const rvolSp = dailyBundle.rvolSpike || 0;
  const rvol5Val = dailyBundle.rvol5 || 1;
  const rvolBest = Math.max(rvolSp, rvol5Val);

  if (!Number.isFinite(atr) || atr <= 0) return null;
  if (rvolBest < 1.3) return null;

  // Bullish breakout: price above last swing high
  if (Number.isFinite(lastHigh) && lastHigh > 0 && price > lastHigh) {
    const dist = (price - lastHigh) / atr;
    if (dist >= 0 && dist < 1.5) {
      return {
        type: "daily_level",
        dir: "LONG",
        level: Math.round(lastHigh * 100) / 100,
        distance_atr: Math.round(dist * 100) / 100,
        rvol: Math.round(rvolBest * 100) / 100,
      };
    }
  }

  // Bearish breakout: price below last swing low
  if (Number.isFinite(lastLow) && lastLow > 0 && price < lastLow) {
    const dist = (lastLow - price) / atr;
    if (dist >= 0 && dist < 1.5) {
      return {
        type: "daily_level",
        dir: "SHORT",
        level: Math.round(lastLow * 100) / 100,
        distance_atr: Math.round(dist * 100) / 100,
        rvol: Math.round(rvolBest * 100) / 100,
      };
    }
  }

  return null;
}

/**
 * Detect ATR-relative breakout: price breaking out of an N-day range
 * with the move >= 2x ATR and volume confirmation.
 *
 * @param {object} dailyBundle - daily TF bundle
 * @param {Array} dailyBars - raw daily bars sorted ascending
 * @param {number} price - current price
 * @param {number} [lookback=10] - number of bars for range computation
 * @returns {object|null} breakout descriptor or null
 */
function detectATRBreakout(dailyBundle, dailyBars, price, lookback = 10) {
  if (!dailyBundle || !Array.isArray(dailyBars) || dailyBars.length < lookback + 1) return null;
  if (!Number.isFinite(price) || price <= 0) return null;

  const atr = dailyBundle.atr14;
  if (!Number.isFinite(atr) || atr <= 0) return null;

  const rvolSp = dailyBundle.rvolSpike || 0;
  const rvol5Val = dailyBundle.rvol5 || 1;
  const rvolBest = Math.max(rvolSp, rvol5Val);
  if (rvolBest < 1.2) return null;

  // Compute N-day range (excluding the latest bar, which is the breakout bar)
  const rangeSlice = dailyBars.slice(-(lookback + 1), -1);
  if (rangeSlice.length < lookback) return null;

  let rangeHigh = -Infinity, rangeLow = Infinity;
  for (const bar of rangeSlice) {
    if (Number.isFinite(bar.h)) rangeHigh = Math.max(rangeHigh, bar.h);
    if (Number.isFinite(bar.l)) rangeLow = Math.min(rangeLow, bar.l);
  }

  if (!Number.isFinite(rangeHigh) || !Number.isFinite(rangeLow)) return null;

  // Bullish ATR breakout
  if (price > rangeHigh) {
    const moveAtr = (price - rangeLow) / atr;
    if (moveAtr >= 2.0) {
      return {
        type: "atr_breakout",
        dir: "LONG",
        range_high: Math.round(rangeHigh * 100) / 100,
        range_low: Math.round(rangeLow * 100) / 100,
        range_atr: Math.round(moveAtr * 100) / 100,
        rvol: Math.round(rvolBest * 100) / 100,
      };
    }
  }

  // Bearish ATR breakout
  if (price < rangeLow) {
    const moveAtr = (rangeHigh - price) / atr;
    if (moveAtr >= 2.0) {
      return {
        type: "atr_breakout",
        dir: "SHORT",
        range_high: Math.round(rangeHigh * 100) / 100,
        range_low: Math.round(rangeLow * 100) / 100,
        range_atr: Math.round(moveAtr * 100) / 100,
        rvol: Math.round(rvolBest * 100) / 100,
      };
    }
  }

  return null;
}

/**
 * Detect EMA stack breakout: fully aligned EMA stack (5>8>13>21>48 or inverse)
 * with price above/below the fastest EMA and volume confirmation.
 *
 * @param {object} dailyBundle - daily TF bundle (has emaStack, emaRegime, e5, px)
 * @param {number} price - current price
 * @returns {object|null} breakout descriptor or null
 */
function detectEMAStackBreakout(dailyBundle, price) {
  if (!dailyBundle || !Number.isFinite(price) || price <= 0) return null;

  const stack = dailyBundle.emaStack || 0;
  const regime = dailyBundle.emaRegime || 0;
  const e5 = dailyBundle.e5;
  const rvolSp = dailyBundle.rvolSpike || 0;
  const rvol5Val = dailyBundle.rvol5 || 1;
  const rvolBest = Math.max(rvolSp, rvol5Val);

  if (rvolBest < 1.0) return null;
  if (!Number.isFinite(e5)) return null;

  // Bullish: 3+ aligned EMAs, regime at least +1, price above EMA5
  if (stack >= 3 && regime >= 1 && price > e5) {
    return {
      type: "ema_stack",
      dir: "LONG",
      stack,
      regime,
      rvol: Math.round(rvolBest * 100) / 100,
    };
  }

  // Bearish: 3+ bearish aligned EMAs, regime at least -1, price below EMA5
  if (stack <= -3 && regime <= -1 && price < e5) {
    return {
      type: "ema_stack",
      dir: "SHORT",
      stack,
      regime,
      rvol: Math.round(rvolBest * 100) / 100,
    };
  }

  return null;
}

/**
 * Run all three breakout detectors, returning the first match (priority order:
 * daily level > ATR > EMA stack — most specific first).
 *
 * @param {object} dailyBundle - daily TF bundle
 * @param {object} regime - from computeSwingRegime
 * @param {number} price - current price
 * @param {Array} dailyBars - raw daily bars
 * @returns {object|null} breakout descriptor or null
 */
function detectBreakout(dailyBundle, regime, price, dailyBars) {
  return detectDailyLevelBreak(dailyBundle, regime, price)
      || detectATRBreakout(dailyBundle, dailyBars, price)
      || detectEMAStackBreakout(dailyBundle, price);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Opening Range Breakout (ORB) Detection
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Convert a UTC epoch-ms timestamp to ET minutes since midnight.
 * Handles EST/EDT automatically.
 */
function tsToEtMinutes(tsMs) {
  const d = new Date(tsMs);
  const month = d.getUTCMonth();
  const day = d.getUTCDate();
  let isEDT = false;
  if (month > 2 && month < 10) {
    isEDT = true;
  } else if (month === 2) {
    const secondSun = 14 - ((new Date(d.getUTCFullYear(), 2, 1).getUTCDay() + 6) % 7);
    isEDT = day > secondSun || (day === secondSun && d.getUTCHours() >= 7);
  } else if (month === 10) {
    const firstSun = 7 - ((new Date(d.getUTCFullYear(), 10, 1).getUTCDay() + 6) % 7);
    isEDT = day < firstSun || (day === firstSun && d.getUTCHours() < 6);
  }
  const offsetHrs = isEDT ? -4 : -5;
  const etDate = new Date(tsMs + offsetHrs * 3600000);
  return etDate.getUTCHours() * 60 + etDate.getUTCMinutes();
}

/**
 * Get the ET calendar date string (YYYY-MM-DD) for a UTC timestamp.
 */
function tsToEtDateKey(tsMs) {
  const d = new Date(tsMs);
  const month = d.getUTCMonth();
  const day = d.getUTCDate();
  let isEDT = false;
  if (month > 2 && month < 10) {
    isEDT = true;
  } else if (month === 2) {
    const secondSun = 14 - ((new Date(d.getUTCFullYear(), 2, 1).getUTCDay() + 6) % 7);
    isEDT = day > secondSun || (day === secondSun && d.getUTCHours() >= 7);
  } else if (month === 10) {
    const firstSun = 7 - ((new Date(d.getUTCFullYear(), 10, 1).getUTCDay() + 6) % 7);
    isEDT = day < firstSun || (day === firstSun && d.getUTCHours() < 6);
  }
  const offsetHrs = isEDT ? -4 : -5;
  const etDate = new Date(tsMs + offsetHrs * 3600000);
  return etDate.toISOString().slice(0, 10);
}

// ORB window durations in minutes from 9:30 AM ET
const ORB_WINDOWS = [
  { label: "5m",  minutes: 5 },
  { label: "15m", minutes: 15 },
  { label: "30m", minutes: 30 },
  { label: "60m", minutes: 60 },
];

const RTH_OPEN_ET = 570;  // 9:30 AM ET in minutes
const RTH_CLOSE_ET = 960; // 4:00 PM ET in minutes

/**
 * Compute overnight gap context from the previous RTH close and today's open.
 *
 * This powers entry guards that need to know whether an opening gap remains
 * untested or has already been meaningfully reclaimed/filled.
 *
 * @param {Array} intradayBars - intraday bars (5m/10m/15m) sorted ascending by ts
 * @param {Array} dailyBars - daily bars sorted ascending by ts
 * @param {number} price - current price
 * @param {number} [asOfTs] - optional "now" timestamp for replay (default: Date.now())
 * @returns {object|null}
 */
export function computeOvernightGapContext(intradayBars, dailyBars, price, asOfTs = null) {
  if (!Array.isArray(intradayBars) || intradayBars.length < 2 || !Number.isFinite(price) || price <= 0) return null;

  const now = asOfTs || Date.now();
  const todayKey = tsToEtDateKey(now);

  const todayBars = [];
  for (const bar of intradayBars) {
    const ts = bar.ts || bar.t || 0;
    if (!ts) continue;
    const barDateKey = tsToEtDateKey(ts);
    const etMin = tsToEtMinutes(ts);
    if (barDateKey === todayKey && etMin >= RTH_OPEN_ET && etMin < RTH_CLOSE_ET) {
      todayBars.push({ ...bar, _etMin: etMin, _ts: ts });
    }
  }
  if (todayBars.length === 0) return null;

  const visibleBars = todayBars.filter((bar) => bar._ts <= now);
  const activeBars = visibleBars.length > 0 ? visibleBars : [todayBars[0]];
  const openBar = activeBars[0];
  const sessionOpen = Number(openBar?.o);
  if (!Number.isFinite(sessionOpen) || sessionOpen <= 0) return null;

  let prevClose = null;
  if (Array.isArray(dailyBars) && dailyBars.length > 0) {
    for (let i = dailyBars.length - 1; i >= 0; i--) {
      const bar = dailyBars[i];
      const ts = bar?.ts || bar?.t || 0;
      if (!ts || tsToEtDateKey(ts) >= todayKey) continue;
      const close = Number(bar?.c);
      if (Number.isFinite(close) && close > 0) {
        prevClose = close;
        break;
      }
    }
  }
  if (!Number.isFinite(prevClose) || prevClose <= 0) return null;

  const gap = sessionOpen - prevClose;
  const absGap = Math.abs(gap);
  const absGapPct = prevClose > 0 ? (absGap / prevClose) * 100 : 0;
  const direction = gap > 0 ? "up" : gap < 0 ? "down" : "flat";
  if (!Number.isFinite(absGapPct)) return null;

  const gapTop = Math.max(sessionOpen, prevClose);
  const gapBottom = Math.min(sessionOpen, prevClose);
  const gapMid = (gapTop + gapBottom) / 2;

  let highSinceOpen = -Infinity;
  let lowSinceOpen = Infinity;
  for (const bar of activeBars) {
    const high = Number(bar?.h);
    const low = Number(bar?.l);
    if (Number.isFinite(high)) highSinceOpen = Math.max(highSinceOpen, high);
    if (Number.isFinite(low)) lowSinceOpen = Math.min(lowSinceOpen, low);
  }
  if (!Number.isFinite(highSinceOpen) || !Number.isFinite(lowSinceOpen)) return null;

  const rangeTouchesGap = highSinceOpen >= gapBottom && lowSinceOpen <= gapTop;
  const enteredGapBody = direction === "flat"
    ? false
    : rangeTouchesGap && (
      (direction === "up" && lowSinceOpen < sessionOpen)
      || (direction === "down" && highSinceOpen > sessionOpen)
    );
  const halfGapTouched = direction === "up"
    ? lowSinceOpen <= gapMid
    : direction === "down"
      ? highSinceOpen >= gapMid
      : false;
  const halfGapHeld = direction === "up"
    ? (halfGapTouched && price >= gapMid)
    : direction === "down"
      ? (halfGapTouched && price <= gapMid)
      : false;
  const fullGapFilled = direction === "up"
    ? lowSinceOpen <= gapBottom
    : direction === "down"
      ? highSinceOpen >= gapTop
      : true;
  const untestedImpulse = direction === "flat" ? false : !enteredGapBody;
  const priceVsOpenPct = sessionOpen > 0 ? ((price - sessionOpen) / sessionOpen) * 100 : 0;

  return {
    direction,
    gapPct: Math.round((sessionOpen > 0 ? (gap / prevClose) * 100 : 0) * 1000) / 1000,
    absGapPct: Math.round(absGapPct * 1000) / 1000,
    prevClose: Math.round(prevClose * 100) / 100,
    sessionOpen: Math.round(sessionOpen * 100) / 100,
    gapTop: Math.round(gapTop * 100) / 100,
    gapBottom: Math.round(gapBottom * 100) / 100,
    gapMid: Math.round(gapMid * 100) / 100,
    enteredGapBody,
    halfGapTouched,
    halfGapHeld,
    fullGapFilled,
    untestedImpulse,
    priceVsOpenPct: Math.round(priceVsOpenPct * 1000) / 1000,
    barsSinceOpen: Math.max(0, activeBars.length - 1),
  };
}

/**
 * Compute Opening Range levels for the current trading day.
 *
 * For each ORB window (5m, 15m, 30m, 60m), tracks the high and low
 * of the first N minutes after market open (9:30 AM ET).
 *
 * Returns ORB data for each window plus composite signals:
 * - orh/orl/orm: Opening Range High, Low, Midpoint
 * - width: range width in dollars
 * - widthPct: range width as % of midpoint
 * - breakout: "LONG" | "SHORT" | null — price broke above ORH or below ORL
 * - reclaim: true if price reclaimed the range after a breakout
 * - holdingAbove/holdingBelow: price currently above ORH / below ORL
 * - targets: extension levels at 50%, 100%, 150%, 200% of range width
 * - priceVsORM: 1 (above mid), -1 (below mid), 0 (inside noise band)
 * - dayBias: 1 if today's ORM > yesterday's ORM, -1 if below, 0 if no data
 * - resolved: true when the ORB window time has passed
 *
 * @param {Array} intradayBars - intraday bars (5m or 10m TF) sorted ascending by ts
 * @param {number} price - current price
 * @param {number} [asOfTs] - optional "now" timestamp for replay (default: Date.now())
 * @returns {object|null} ORB data keyed by window label, or null if insufficient data
 */
export function computeORB(intradayBars, price, asOfTs = null) {
  if (!Array.isArray(intradayBars) || intradayBars.length < 3 || !Number.isFinite(price) || price <= 0) return null;

  const now = asOfTs || Date.now();
  const todayKey = tsToEtDateKey(now);

  // Find today's bars (same ET date) that fall within RTH
  const todayBars = [];
  let prevDayBars = [];
  for (const bar of intradayBars) {
    const ts = bar.ts || bar.t || 0;
    if (!ts) continue;
    const barDateKey = tsToEtDateKey(ts);
    const etMin = tsToEtMinutes(ts);
    if (barDateKey === todayKey && etMin >= RTH_OPEN_ET && etMin < RTH_CLOSE_ET) {
      todayBars.push({ ...bar, _etMin: etMin });
    } else if (barDateKey < todayKey && etMin >= RTH_OPEN_ET && etMin < RTH_CLOSE_ET) {
      prevDayBars.push({ ...bar, _etMin: etMin, _dateKey: barDateKey });
    }
  }

  if (todayBars.length === 0) return null;

  // Compute previous day's ORM for day bias comparison
  let prevORM = null;
  if (prevDayBars.length > 0) {
    const lastPrevDate = prevDayBars[prevDayBars.length - 1]._dateKey;
    const lastDayBars = prevDayBars.filter(b => b._dateKey === lastPrevDate);
    // Use the 30m OR window from previous day for bias
    const prevOrBars = lastDayBars.filter(b => b._etMin >= RTH_OPEN_ET && b._etMin < RTH_OPEN_ET + 30);
    if (prevOrBars.length > 0) {
      let pH = -Infinity, pL = Infinity;
      for (const b of prevOrBars) {
        if (Number.isFinite(b.h)) pH = Math.max(pH, b.h);
        if (Number.isFinite(b.l)) pL = Math.min(pL, b.l);
      }
      if (Number.isFinite(pH) && Number.isFinite(pL) && pH > pL) {
        prevORM = (pH + pL) / 2;
      }
    }
  }

  const nowEtMin = tsToEtMinutes(now);
  const result = {};

  for (const win of ORB_WINDOWS) {
    const windowEnd = RTH_OPEN_ET + win.minutes;
    const resolved = nowEtMin >= windowEnd;

    // Collect bars in the opening range window
    const orBars = todayBars.filter(b => b._etMin >= RTH_OPEN_ET && b._etMin < windowEnd);
    if (orBars.length === 0) {
      result[win.label] = null;
      continue;
    }

    let orh = -Infinity, orl = Infinity;
    for (const b of orBars) {
      if (Number.isFinite(b.h)) orh = Math.max(orh, b.h);
      if (Number.isFinite(b.l)) orl = Math.min(orl, b.l);
    }

    if (!Number.isFinite(orh) || !Number.isFinite(orl) || orh <= orl) {
      result[win.label] = null;
      continue;
    }

    const orm = (orh + orl) / 2;
    const width = orh - orl;
    const widthPct = orm > 0 ? (width / orm) * 100 : 0;

    // Breakout detection: only after OR window resolves
    let breakout = null;
    let holdingAbove = false;
    let holdingBelow = false;
    let reclaim = false;
    let highSinceOR = orh;
    let lowSinceOR = orl;

    if (resolved) {
      // Scan post-OR bars for breakout tracking
      const postOrBars = todayBars.filter(b => b._etMin >= windowEnd);
      let brokeAbove = false;
      let brokeBelowOnce = false;

      for (const b of postOrBars) {
        if (Number.isFinite(b.h)) highSinceOR = Math.max(highSinceOR, b.h);
        if (Number.isFinite(b.l)) lowSinceOR = Math.min(lowSinceOR, b.l);
        if (b.h > orh) brokeAbove = true;
        if (b.l < orl) brokeBelowOnce = true;
      }

      holdingAbove = price > orh;
      holdingBelow = price < orl;

      if (holdingAbove && brokeAbove) {
        breakout = "LONG";
      } else if (holdingBelow && brokeBelowOnce) {
        breakout = "SHORT";
      }

      // Reclaim: price broke out but came back inside the range
      if (brokeAbove && price < orh && price >= orl) reclaim = true;
      if (brokeBelowOnce && price > orl && price <= orh) reclaim = true;
    }

    // Price position relative to ORM
    const noiseBand = width * 0.1;
    const priceVsORM = price > orm + noiseBand ? 1 : price < orm - noiseBand ? -1 : 0;

    // Day bias: compare today's ORM to yesterday's ORM
    const dayBias = prevORM != null ? (orm > prevORM ? 1 : orm < prevORM ? -1 : 0) : 0;

    // Target extensions
    const tPer = 0.5; // 50% of range per target level, matching Pine Script default
    const targets = {
      t1_up: Math.round((orh + width * tPer) * 100) / 100,
      t2_up: Math.round((orh + width * tPer * 2) * 100) / 100,
      t3_up: Math.round((orh + width * tPer * 3) * 100) / 100,
      t4_up: Math.round((orh + width * tPer * 4) * 100) / 100,
      t1_dn: Math.round((orl - width * tPer) * 100) / 100,
      t2_dn: Math.round((orl - width * tPer * 2) * 100) / 100,
      t3_dn: Math.round((orl - width * tPer * 3) * 100) / 100,
      t4_dn: Math.round((orl - width * tPer * 4) * 100) / 100,
    };

    // Count how many upside/downside targets have been hit
    let targetsHitUp = 0, targetsHitDn = 0;
    if (highSinceOR >= targets.t1_up) targetsHitUp = 1;
    if (highSinceOR >= targets.t2_up) targetsHitUp = 2;
    if (highSinceOR >= targets.t3_up) targetsHitUp = 3;
    if (highSinceOR >= targets.t4_up) targetsHitUp = 4;
    if (lowSinceOR <= targets.t1_dn) targetsHitDn = 1;
    if (lowSinceOR <= targets.t2_dn) targetsHitDn = 2;
    if (lowSinceOR <= targets.t3_dn) targetsHitDn = 3;
    if (lowSinceOR <= targets.t4_dn) targetsHitDn = 4;

    result[win.label] = {
      orh: Math.round(orh * 100) / 100,
      orl: Math.round(orl * 100) / 100,
      orm: Math.round(orm * 100) / 100,
      width: Math.round(width * 100) / 100,
      widthPct: Math.round(widthPct * 100) / 100,
      resolved,
      breakout,
      holdingAbove,
      holdingBelow,
      reclaim,
      priceVsORM,
      dayBias,
      targets,
      targetsHitUp,
      targetsHitDn,
    };
  }

  // Composite signal: consensus across windows
  const windows = Object.values(result).filter(Boolean);
  if (windows.length === 0) return null;

  const resolvedWindows = windows.filter(w => w.resolved);
  const longBreakouts = resolvedWindows.filter(w => w.breakout === "LONG").length;
  const shortBreakouts = resolvedWindows.filter(w => w.breakout === "SHORT").length;
  const aboveCount = resolvedWindows.filter(w => w.holdingAbove).length;
  const belowCount = resolvedWindows.filter(w => w.holdingBelow).length;
  const reclaimCount = resolvedWindows.filter(w => w.reclaim).length;

  // ORB bias: strong when multiple windows agree
  let orbBias = 0;
  if (longBreakouts >= 2) orbBias = 1;
  else if (shortBreakouts >= 2) orbBias = -1;
  else if (longBreakouts === 1 && aboveCount >= 2) orbBias = 1;
  else if (shortBreakouts === 1 && belowCount >= 2) orbBias = -1;

  // Use the 15m OR as the primary reference (balances noise vs. information)
  const primary = result["15m"] || result["30m"] || result["5m"] || null;

  return {
    windows: result,
    primary,
    orbBias,
    longBreakouts,
    shortBreakouts,
    reclaimCount,
    resolvedCount: resolvedWindows.length,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Mean Reversion TD9 Alignment — Primitives
// ═══════════════════════════════════════════════════════════════════════════════

function isNearPsychLevel(price, pctTolerance = 0.01) {
  const levels = [50, 100, 150, 200, 250, 300, 400, 500, 750, 1000, 1500, 2000];
  for (const lvl of levels) {
    if (Math.abs(price - lvl) / lvl <= pctTolerance) return { near: true, level: lvl };
  }
  return { near: false, level: null };
}

function td9AlignedLong(tdSeq) {
  const ptf = tdSeq?.per_tf;
  if (!ptf) return false;
  return !!(ptf.D?.td9_bullish && ptf.W?.td9_bullish && ptf["60"]?.td9_bullish);
}

function td9AlignedShort(tdSeq) {
  const ptf = tdSeq?.per_tf;
  if (!ptf) return false;
  return !!(ptf.D?.td9_bearish && ptf.W?.td9_bearish && ptf["60"]?.td9_bearish);
}

function countRecentBearishFVGs(fvgResult, lookbackBars) {
  if (!fvgResult?.fvgs) return 0;
  return fvgResult.fvgs.filter(g => g.type === "bear").length;
}

function detectMeanReversionTD9(bundles, tdSeq, price) {
  const bD = bundles?.D;
  const b1H = bundles?.["60"];
  const b4H = bundles?.["240"];
  const bW = bundles?.W;
  if (!bD || !b1H) return null;

  const aligned = td9AlignedLong(tdSeq);
  if (!aligned) return null;

  const rsiD = bD.rsi;
  const rsi4H = b4H?.rsi;
  const rsi1H = b1H.rsi;
  if (!Number.isFinite(rsiD) || rsiD > 30) return null;
  if (Number.isFinite(rsi1H) && rsi1H > 40) return null;

  // Phase leaving dot: Saty Phase was in ext-down zone and is now recovering
  const spD = bD.satyPhase;
  const sp1H = b1H.satyPhase;
  let phaseLeavingDot = false;
  if (spD?.leaving?.extDn || spD?.leaving?.accum) phaseLeavingDot = true;
  if (sp1H?.leaving?.extDn || sp1H?.leaving?.accum) phaseLeavingDot = true;
  if (!phaseLeavingDot) return null;

  // Support confluence: at least 2 of 3 conditions
  let supportScore = 0;
  const reasons = [];

  const fvgD = bD.fvg;
  if (fvgD && (fvgD.inBullGap || (Number.isFinite(fvgD.nearestBullDist) && fvgD.nearestBullDist >= 0 && fvgD.nearestBullDist < 0.5))) {
    supportScore++;
    reasons.push("fvg_daily");
  }

  const liqW = bW?.liq;
  if (liqW && Number.isFinite(liqW.nearestSellsideDist) && liqW.nearestSellsideDist >= 0 && liqW.nearestSellsideDist < 0.5) {
    supportScore++;
    reasons.push("ssl_weekly");
  }

  const psych = isNearPsychLevel(price);
  if (psych.near) {
    supportScore++;
    reasons.push(`psych_${psych.level}`);
  }

  if (supportScore < 2) return null;

  return {
    active: true,
    direction: "LONG",
    td9_aligned: true,
    phase_leaving: true,
    rsi_d: Math.round(rsiD * 10) / 10,
    rsi_1h: Number.isFinite(rsi1H) ? Math.round(rsi1H * 10) / 10 : null,
    rsi_4h: Number.isFinite(rsi4H) ? Math.round(rsi4H * 10) / 10 : null,
    support_score: supportScore,
    support_reasons: reasons,
    psych_level: psych.level,
  };
}

function detectMeanReversionTD9Short(bundles, tdSeq, price) {
  const bD = bundles?.D;
  const b1H = bundles?.["60"];
  const b4H = bundles?.["240"];
  const bW = bundles?.W;
  if (!bD || !b1H) return null;

  const aligned = td9AlignedShort(tdSeq);
  if (!aligned) return null;

  const rsiD = bD.rsi;
  const rsi4H = b4H?.rsi;
  const rsi1H = b1H.rsi;
  if (!Number.isFinite(rsiD) || rsiD < 70) return null;
  if (Number.isFinite(rsi1H) && rsi1H < 60) return null;

  const spD = bD.satyPhase;
  const sp1H = b1H.satyPhase;
  let phaseLeavingDot = false;
  if (spD?.leaving?.extUp || spD?.leaving?.dist) phaseLeavingDot = true;
  if (sp1H?.leaving?.extUp || sp1H?.leaving?.dist) phaseLeavingDot = true;
  if (!phaseLeavingDot) return null;

  let resistanceScore = 0;
  const reasons = [];

  const fvgD = bD.fvg;
  if (fvgD && (fvgD.inBearGap || (Number.isFinite(fvgD.nearestBearDist) && fvgD.nearestBearDist >= 0 && fvgD.nearestBearDist < 0.5))) {
    resistanceScore++;
    reasons.push("fvg_daily");
  }

  const liqW = bW?.liq;
  if (liqW && Number.isFinite(liqW.nearestBuysideDist) && liqW.nearestBuysideDist >= 0 && liqW.nearestBuysideDist < 0.5) {
    resistanceScore++;
    reasons.push("bsl_weekly");
  }

  const psych = isNearPsychLevel(price);
  if (psych.near) {
    resistanceScore++;
    reasons.push(`psych_${psych.level}`);
  }

  if (resistanceScore < 2) return null;

  return {
    active: true,
    direction: "SHORT",
    td9_aligned: true,
    phase_leaving: true,
    rsi_d: Math.round(rsiD * 10) / 10,
    rsi_1h: Number.isFinite(rsi1H) ? Math.round(rsi1H * 10) / 10 : null,
    rsi_4h: Number.isFinite(rsi4H) ? Math.round(rsi4H * 10) / 10 : null,
    resistance_score: resistanceScore,
    resistance_reasons: reasons,
    psych_level: psych.level,
  };
}

export function assembleTickerData(ticker, bundles, existingData = null, opts = null) {
  const bM = bundles?.M;
  const bW = bundles?.W;
  const bD = bundles?.D;
  const b4H = bundles?.["240"];
  const b1H = bundles?.["60"];
  const b30 = bundles?.["30"];
  const b15 = bundles?.["15"];
  const b10 = bundles?.["10"];
  const b5 = bundles?.["5"];
  const requestedLeadingLtf = normalizeTfKey(opts?.leadingLtf || existingData?.leading_ltf || "10") || "10";
  const leadingLtf = requestedLeadingLtf === "30" && b30
    ? "30"
    : requestedLeadingLtf === "15" && b15
      ? "15"
      : requestedLeadingLtf === "10" && b10
        ? "10"
        : b15
          ? "15"
          : b10
            ? "10"
            : b30
              ? "30"
              : "10";
  const bLead = leadingLtf === "30" ? b30 : leadingLtf === "15" ? b15 : b10;

  // Compute daily anchors for Golden Gate
  let anchors = null;
  if (bD && Number.isFinite(bD.atr14)) {
    const PCd = bD.px; // Previous close is approximated as current daily close
    const ATRd = bD.atr14;
    const ggATRmult = 0.382;
    const GGup = PCd + ggATRmult * ATRd;
    const GGdn = PCd - ggATRmult * ATRd;
    anchors = { PCd, ATRd, GGup, GGdn };
  }

  // Compute scores (pass learned weight adjustments if available)
  // v3 TF architecture: HTF = M/W/D/4H, LTF = 1H/30m/leading intraday TF
  const _learnedScoreAdj = opts?.scoreWeights || null;
  const htfScore = computeWeightedHTFScore(bM, bW, bD, b4H, _learnedScoreAdj);
  const ltfScore = computeWeightedLTFScore(b1H, b30, bLead, anchors, isRTHNow(), _learnedScoreAdj);
  const state = classifyState(htfScore, ltfScore);

  // Detect flags
  const flags = detectFlags(bundles);

  // ── Early: Regime + Swing Consensus (for TP/SL direction alignment) ──
  // Must match worker sideFromStateOrScores: consensus overrides htfScore.
  // TP/SL must use the same direction we'll trade, else SHORT alerts show LONG-style TP.
  const rawBarsEarly = opts?.rawBars || null;
  let regimeEarly = opts?.regime || null;
  const marketInternals = opts?.marketInternals || existingData?._marketInternals || null;
  const liveTickerProfile = normalizeLearnedTickerProfile(existingData?._tickerProfile || null, {
    ticker,
    source: existingData?.__profile_resolution?.learned_profile_source || "runtime",
  });
  const enableExecutionProfileRuntime = opts?.enableExecutionProfileRuntime === true;
  if (!regimeEarly && rawBarsEarly) {
    const dailyBars = rawBarsEarly.D || rawBarsEarly.daily || [];
    const weeklyBars = rawBarsEarly.W || rawBarsEarly.weekly || [];
    if (dailyBars.length >= 35 && weeklyBars.length >= 25) {
      regimeEarly = computeSwingRegime(dailyBars, weeklyBars);
    }
  }
  const swingConsensusEarly = computeSwingConsensus(bundles, regimeEarly, opts?.tfWeights || null, opts?.signalWeights || null);

  // Phase from daily
  const phaseOsc = bD?.phaseOsc || 0;
  const phasePct = Math.min(1, Math.abs(phaseOsc) / 100);
  const phaseDir = phaseOsc > 0 ? "bull" : phaseOsc < 0 ? "bear" : "flat";
  const phaseZone = bD?.phaseZone || "LOW";

  // Saty Phase completion: pure price-displacement metric from multiple TFs
  // Uses leading LTF for immediate signal, 1H for intermediate, Daily for macro
  const _spLead = bLead?.satyPhase;
  const _sp1H = b1H?.satyPhase;
  const _sp30 = b30?.satyPhase;
  const _spD = bD?.satyPhase;
  const satyPhasePct = (() => {
    const v1H = Math.abs(_sp1H?.value ?? 0);
    const v30 = Math.abs(_sp30?.value ?? 0);
    const vD = Math.abs(_spD?.value ?? 0);
    const primary = Math.max(v1H, v30);
    const pct = primary > 0 ? Math.min(1, primary / 100) : Math.min(1, vD / 100);
    return Math.round(pct * 1000) / 1000;
  })();

  // Saty Phase zone-exit aggregation: check 1H and 30m for leaving signals
  const satyPhaseExitSignal = {
    leaving1H: _sp1H?.leaving || null,
    leaving30: _sp30?.leaving || null,
    value1H: _sp1H?.value ?? null,
    value30: _sp30?.value ?? null,
  };

  // ── Price: use the most recent close across all timeframes (by timestamp).
  // Previously `b30?.px || b10?.px || bD?.px` which silently used stale intraday
  // prices when intraday data had gaps but daily was current.
  const priceCandidates = [
    { px: b5?.px,  ts: b5?.lastTs  || 0 },
    { px: b15?.px, ts: b15?.lastTs || 0 },
    { px: b10?.px, ts: b10?.lastTs || 0 },
    { px: b30?.px, ts: b30?.lastTs || 0 },
    { px: b1H?.px, ts: b1H?.lastTs || 0 },
    { px: b4H?.px, ts: b4H?.lastTs || 0 },
    { px: bD?.px,  ts: bD?.lastTs  || 0 },
  ].filter(c => Number.isFinite(c.px) && c.px > 0 && c.ts > 0);
  const freshest = priceCandidates.reduce((a, b) => b.ts > a.ts ? b : a, priceCandidates[0] || { px: 0 });
  const price = freshest?.px || bLead?.px || b30?.px || b10?.px || bD?.px || 0;

  // ── NEW: SuperTrend Support Map ──
  const stSupport = buildSTSupportMap(bundles);

  // ── NEW: ATR Fibonacci Level Maps (5 horizons) ──
  const atrLevels = buildATRLevelMaps(bundles, price);

  // ── NEW: Fuel Gauges per key timeframe ──
  const fuel = {
    "30": computeFuelGauge(b30),
    "15": computeFuelGauge(b15),
    "10": computeFuelGauge(b10),
    "60": computeFuelGauge(b1H),
    D:    computeFuelGauge(bD),
  };

  // ── EMA Triplet Map per key timeframe ──
  const emaMap = {};
  const tfEmaSources = { M: bM, W: bW, D: bD, "240": b4H, "60": b1H, "30": b30, "15": b15, "10": b10 };
  for (const [tf, b] of Object.entries(tfEmaSources)) {
    if (b && Number.isFinite(b.emaDepth)) {
      emaMap[tf] = {
        depth: b.emaDepth,                                                    // 0-10 conviction ladder
        structure: Math.round((b.emaStructure || 0) * 1000) / 1000,          // -1 to +1 macro trend
        momentum: Math.round((b.emaMomentum || 0) * 1000) / 1000,           // -1 to +1 current impulse
        spread: Math.round((b.ribbonSpread || 0) * 10000) / 10000,          // ribbon width as % of price
      };
    }
  }

  // ── NEW: Active Golden Gates (collect from all horizons) ──
  const activeGates = [];
  for (const [hz, lvl] of Object.entries(atrLevels)) {
    if (lvl?.gate?.entered && !lvl.gate.completed) {
      activeGates.push(lvl.gate);
    }
  }

  // TP/SL — SWING-TRADE HORIZON: Weekly ATR is the primary reference because
  // we hold for days/weeks, not hours.  Daily ATR produces targets too tight
  // (XLF current price above TP1, BABA TPs clustered within $1, CSCO R:R 95:1).
  //
  // Hierarchy: Weekly ATR → Daily ATR × √5 → Intraday scaled up.
  // TP1 (Trim 60%)  = 0.618 × swingATR   ~3-day move
  // TP2 (Exit 85%)  = 1.000 × swingATR   ~5-day move (full week)
  // TP3 (Runner 15%) = 1.618 × swingATR  ~8-day extended move
  const ATRw = bW?.atr14 || 0;
  const ATRd = bD?.atr14 || 0;
  const ATR1H = b1H?.atr14 || 0;
  const ATR30 = b30?.atr14 || 0;
  // Use swing consensus direction for TP/SL so they match trade direction (fixes CRS/FIX SHORT with LONG-style TP)
  const dir = swingConsensusEarly.direction === "SHORT" ? -1
    : swingConsensusEarly.direction === "LONG" ? 1
    : (htfScore >= 0 ? 1 : -1);

  let tp, sl, tp_trim, tp_exit, tp_runner;

  // Determine the swing-scale ATR (weekly-equivalent)
  // Priority: Weekly ATR (direct) → Daily ATR × √5 → Intraday scaled
  const swingATR = ATRw > 0 ? ATRw
    : ATRd > 0 ? ATRd * Math.sqrt(5)
    : ATR1H > 0 ? ATR1H * Math.sqrt(6.5) * Math.sqrt(5)
    : ATR30 > 0 ? ATR30 * Math.sqrt(13) * Math.sqrt(5)
    : 0;

  if (swingATR > 0 && Number.isFinite(price) && price > 0) {
    tp_trim  = Math.round((price + dir * 0.618 * swingATR) * 100) / 100;
    tp_exit  = Math.round((price + dir * 1.0   * swingATR) * 100) / 100;
    tp_runner = Math.round((price + dir * 1.618 * swingATR) * 100) / 100;
    tp = tp_trim;
  }

  // SL: use best available ATR (daily preferred, then scaled weekly/intraday)
  const slATR = ATRd > 0 ? ATRd
    : ATRw > 0 ? ATRw / Math.sqrt(5)
    : ATR1H > 0 ? ATR1H * Math.sqrt(6.5)
    : ATR30 > 0 ? ATR30 * Math.sqrt(13)
    : 0;
  const rawSL = slATR > 0
    ? Math.round((price - dir * 1.5 * slATR) * 100) / 100
    : 0;

  // Phase 1b: Clamp SL to [min%, max%] of price — prevents noise stops and ruin stops
  // Volatility tier provides per-tier caps; fall back to 1%-5% universal range
  const volTier = classifyVolatilityTier(ATRd, price);
  const slMinPct = volTier.slCap.min; // e.g. 0.008 for LOW, 0.02 for EXTREME
  const slMaxPct = volTier.slCap.max; // e.g. 0.02 for LOW, 0.05 for EXTREME
  if (rawSL && Number.isFinite(price) && price > 0) {
    const slDist = Math.abs(rawSL - price);
    const clampedDist = Math.max(slMinPct * price, Math.min(slMaxPct * price, slDist));
    sl = Math.round((price - dir * clampedDist) * 100) / 100;
  } else {
    sl = rawSL;
  }
  // R:R uses tp_exit (1.0× weekly ATR = full-week move) as the reward reference,
  // not tp_trim (partial target). This gives a realistic risk/reward for the trade.
  const rrTarget = tp_exit || tp_runner || tp;
  const rr = (rrTarget && sl && Math.abs(price - sl) > 0) ? Math.abs(rrTarget - price) / Math.abs(price - sl) : 0;

  // Build tf_tech for compatibility with existing worker logic
  const tfTech = {};
  const tfMap = { M: bM, W: bW, D: bD, "4H": b4H, "1H": b1H, "30": b30, "15": b15, "10": b10 };
  for (const [tfLabel, b] of Object.entries(tfMap)) {
    if (!b) continue;
    // ATR band: which Fibonacci ATR zone price is in
    // s: direction (-1=below pivot, +1=above), lo/hi: zone labels
    const atrBand = (() => {
      if (!Number.isFinite(b.atr14) || !Number.isFinite(b.px)) return null;
      const piv = b.e21 || b.e48 || b.px;
      if (!Number.isFinite(piv)) return null;
      const dist = b.px - piv;
      const atrU = b.atr14;
      const side = dist >= 0 ? 1 : -1;
      const absDist = Math.abs(dist);
      // Map to ATR zones: 0-0.5, 0.5-1.0, 1.0-1.5, 1.5-2.0, 2.0+
      const zone = atrU > 0 ? absDist / atrU : 0;
      const lo = zone < 0.5 ? "0" : zone < 1.0 ? "0.5" : zone < 1.5 ? "1.0" : zone < 2.0 ? "1.5" : "2.0";
      const hi = zone < 0.5 ? "0.5" : zone < 1.0 ? "1.0" : zone < 1.5 ? "1.5" : zone < 2.0 ? "2.0" : null;
      return { s: side, lo, hi: hi || undefined };
    })();

    // ATR last cross: SuperTrend flip direction and recency
    const atrCross = (() => {
      if (!b.stFlip) return null;
      return {
        x: b.stFlipDir === 1 ? "bull" : "bear",
        xd: b.stFlipDir === 1 ? "up" : "dn",
        xs: b.stDir < 0 ? -1 : 1,
      };
    })();

    // Phase dots: classify phase zones from recent phase oscillator values
    // Since we only have the latest bar's phaseOsc, derive zone code
    const phaseDotCode = (() => {
      const po = b.phaseOsc;
      if (!Number.isFinite(po)) return null;
      if (po >= 100) return "P100";
      if (po >= 61.8) return "P618";
      if (po <= -100) return "N100";
      if (po <= -61.8) return "N618";
      return null;
    })();

    // Price vs 21 EMA: required for entry guards (LONG: price above 21 EMA, SHORT: price below)
    const priceAboveEma21 = Number.isFinite(b.px) && Number.isFinite(b.e21) ? b.px >= b.e21 : null;

    tfTech[tfLabel] = {
      ema: {
        stack: b.emaStack,
        depth: b.emaDepth || 0,
        structure: Math.round((b.emaStructure || 0) * 1000) / 1000,
        momentum: Math.round((b.emaMomentum || 0) * 1000) / 1000,
        priceAboveEma21,
      },
      stDir: Number.isFinite(b.stDir) ? b.stDir : 0,
      stSlope: b.stSlopeUp ? 1 : b.stSlopeDn ? -1 : 0,
      atr: atrBand ? { ...atrBand, ...(atrCross || {}) } : (atrCross || undefined),
      sq: { s: b.sqOn ? 1 : 0, r: b.sqRelease ? 1 : 0, c: b.compressed ? 1 : 0 },
      rsi: {
        r5: Number.isFinite(b.rsi) ? Math.round(b.rsi * 10) / 10 : undefined,
        // V15 P0.2 — 5-bar slope (RSI points / bar)
        slope5: Number.isFinite(b.rsi_slope_5bar) ? b.rsi_slope_5bar : undefined,
      },
      rsiDiv: b.rsiDiv && (b.rsiDiv.bear || b.rsiDiv.bull) ? {
        bear: b.rsiDiv.bear ? { s: b.rsiDiv.bear.strength, bs: b.rsiDiv.bear.barsSince, a: b.rsiDiv.bear.active } : undefined,
        bull: b.rsiDiv.bull ? { s: b.rsiDiv.bull.strength, bs: b.rsiDiv.bull.barsSince, a: b.rsiDiv.bull.active } : undefined,
      } : undefined,
      phaseDiv: b.phaseDiv && (b.phaseDiv.bear || b.phaseDiv.bull) ? {
        bear: b.phaseDiv.bear ? { s: b.phaseDiv.bear.strength, bs: b.phaseDiv.bear.barsSince, a: b.phaseDiv.bear.active } : undefined,
        bull: b.phaseDiv.bull ? { s: b.phaseDiv.bull.strength, bs: b.phaseDiv.bull.barsSince, a: b.phaseDiv.bull.active } : undefined,
      } : undefined,
      ripster: b.ripsterClouds || undefined,
      ich: b.ichimoku ? {
        pvc: b.ichimoku.priceVsCloud || undefined,
        cb: b.ichimoku.cloudBullish ? 1 : 0,
        tk: b.ichimoku.tkBull ? 1 : 0,
        xu: b.ichimoku.tkCrossUp ? 1 : 0,
        xd: b.ichimoku.tkCrossDn ? 1 : 0,
        ca: b.ichimoku.chikouAbove == null ? undefined : (b.ichimoku.chikouAbove ? 1 : 0),
        ks: Number.isFinite(b.ichimoku.kijunSlope) ? Math.round(b.ichimoku.kijunSlope * 1000) / 1000 : undefined,
        tksp: Number.isFinite(b.ichimoku.tkSpread) ? Math.round(b.ichimoku.tkSpread * 1000) / 1000 : undefined,
        pt: Number.isFinite(b.ichimoku.priceToKijun) ? Math.round(b.ichimoku.priceToKijun * 1000) / 1000 : undefined,
        ct: Number.isFinite(b.ichimoku.cloudThickness) ? Math.round(b.ichimoku.cloudThickness * 1000) / 1000 : undefined,
        kw: b.ichimoku.kumoTwist ? 1 : 0,
      } : undefined,
      ph: {
        v: Number.isFinite(b.phaseOsc) ? Math.round(b.phaseOsc * 10) / 10 : undefined,
        z: b.phaseZone || undefined,
        dots: phaseDotCode ? [phaseDotCode] : [],
      },
      saty: b.satyPhase ? {
        v: b.satyPhase.value,
        p: b.satyPhase.prev,
        z: b.satyPhase.zone,
        l: b.satyPhase.leaving,
      } : undefined,
      satyATR: (() => {
        const anchorMap = { "15": "day", "10": "day", "30": "week", "1H": "month", "4H": "quarter", D: "longterm", W: "longterm" };
        const anchor = anchorMap[tfLabel];
        if (!anchor || !atrLevels?.[anchor]) return undefined;
        const al = atrLevels[anchor];
        return { disp: al.disp, band: al.band, gg: al.gate?.entered || false, rangeOfATR: al.rangeOfATR, horizon: anchor };
      })(),
      fuel: fuel[tfLabel] || undefined,
      pdz: b.pdz ? { zone: b.pdz.zone, pct: b.pdz.pct } : undefined,
      fvg: b.fvg ? {
        ab: b.fvg.activeBull, abr: b.fvg.activeBear,
        ib: b.fvg.inBullGap ? 1 : 0, ibr: b.fvg.inBearGap ? 1 : 0,
        nbd: b.fvg.nearestBullDist, nbrd: b.fvg.nearestBearDist,
      } : undefined,
      liq: b.liq ? {
        bs: b.liq.buysideCount, ss: b.liq.sellsideCount,
        bsd: b.liq.nearestBuysideDist, ssd: b.liq.nearestSellsideDist,
      } : undefined,
    };
  }

  // Elliott Wave impulse detection on HTF (Daily, Weekly)
  const rawBarsForEW = rawBarsEarly || {};
  const ewDailyBars = rawBarsForEW.D || rawBarsForEW.daily || [];
  const ewWeeklyBars = rawBarsForEW.W || rawBarsForEW.weekly || [];
  if (ewDailyBars.length >= 25 && tfTech.D) {
    const ewD = detectEWImpulse(ewDailyBars, 10, 5);
    if (ewD) tfTech.D.ew = ewD;
  }
  if (ewWeeklyBars.length >= 25 && tfTech.W) {
    const ewW = detectEWImpulse(ewWeeklyBars, 10, 5);
    if (ewW) tfTech.W.ew = ewW;
  }

  // Multi-TF Saty Phase compression: majority of timeframes in LOW zone (|osc| < 23.6)
  const _satyCompTfs = ["10", "15", "30", "1H", "4H", "D", "W"];
  let _satyCompCount = 0, _satyCompTotal = 0;
  for (const tf of _satyCompTfs) {
    const saty = tfTech[tf]?.saty;
    if (!saty || saty.v == null) continue;
    _satyCompTotal++;
    if (saty.z === "LOW" || Math.abs(saty.v) < 23.6) _satyCompCount++;
  }
  if (_satyCompTotal >= 3 && _satyCompCount >= Math.ceil(_satyCompTotal / 2)) {
    flags.saty_compression_multi_tf = true;
    flags.saty_compression_count = _satyCompCount;
    flags.saty_compression_total = _satyCompTotal;
  }

  // Merge: keep existing fields that we don't compute (e.g., Ichimoku, daily EMA cloud)
  const base = existingData || {};

  // ── Phase 2a/2b: Reuse regime + swing consensus (computed early for TP/SL direction) ──
  const regime = regimeEarly;
  const swingConsensus = swingConsensusEarly;

  // ── Phase 3a: Volatility Tier (already computed above for SL clamp) ──
  // volTier = classifyVolatilityTier(ATRd, price); -- computed at SL section

  // ── Phase 1a: Entry Quality Score ──
  // Use the swing consensus direction as the basis for quality scoring.
  // Fall back to HTF score if consensus has no opinion.
  const eqSide = swingConsensus.direction
    || (htfScore >= 0 ? "LONG" : "SHORT");
  const liqData = {
    liq_4h: b4H?.liq ? { nearestBuysideDist: b4H.liq.nearestBuysideDist, nearestSellsideDist: b4H.liq.nearestSellsideDist } : null,
    liq_D: bD?.liq ? { nearestBuysideDist: bD.liq.nearestBuysideDist, nearestSellsideDist: bD.liq.nearestSellsideDist } : null,
  };
  const entryQuality = computeEntryQualityScore(bundles, eqSide, regime, liqData);

  // ── Regime Classification (v3 chop filter) ──
  const runtimeMarketInternals = enableExecutionProfileRuntime ? marketInternals : null;
  const regimeClass = classifyTickerRegime(bD, b4H, bW, runtimeMarketInternals);
  const executionProfile = selectExecutionProfile({
    tickerRegime: regimeClass.regime,
    marketInternals,
    tickerProfile: liveTickerProfile,
    state,
    flags,
    entryQuality,
    regimeScore: regimeClass.score,
  });
  const regimeParams = getRegimeParams(
    regimeClass.regime,
    runtimeMarketInternals?.overall === "risk_off" ? "CHOPPY" : null,
    runtimeMarketInternals,
  );
  const baseRegimeParams = { ...regimeParams };
  const regimeVocabulary = resolveRegimeVocabulary({
    ...existingData,
    regime_class: regimeClass.regime,
    regime_score: regimeClass.score,
    regime,
    _vix: existingData?._vix ?? existingData?._vixLevel ?? null,
    _env: existingData?._env || {},
  }, { executionFallback: regimeClass.regime });
  if (enableExecutionProfileRuntime && executionProfile?.adjustments) {
    const adj = executionProfile.adjustments;
    regimeParams.minHTFScore = Math.max(0, (regimeParams.minHTFScore || 0) + (adj.minHTFScoreAdj || 0));
    regimeParams.minRR = Math.max(0.5, (regimeParams.minRR || 0) + (adj.minRRAdj || 0));
    regimeParams.maxCompletion = Math.max(0.15, Math.min(0.85, (regimeParams.maxCompletion || 0.5) + (adj.maxCompletionAdj || 0)));
    regimeParams.positionSizeMultiplier = Math.max(0.2, Math.min(1.25, (regimeParams.positionSizeMultiplier || 1) * (adj.positionSizeMultiplierAdj || 1)));
    regimeParams.slCushionMultiplier = Math.max(0.8, (regimeParams.slCushionMultiplier || 1) * (adj.slCushionMultiplierAdj || 1));
    regimeParams.requireSqueezeRelease = !!adj.requireSqueezeRelease;
    regimeParams.defendWinnerBias = adj.defendWinnerBias || regimeParams.defendWinnerBias || "standard";
    recordAdaptiveLineageFact(tickerData, "execution_profile_runtime_overlay", {
      source: "execution_profile_runtime",
      active_profile: executionProfile.active_profile || null,
      adjustments: adj,
      regime_params_before: baseRegimeParams,
      regime_params_after: regimeParams,
    });
  }

  // ── Breakout Detection (daily level, ATR-relative, EMA stack) ──
  const rawDailyBars = rawBarsEarly?.D || rawBarsEarly?.daily || [];
  const breakout = detectBreakout(bD, regime, price, rawDailyBars);

  // ── Opening Range Breakout (ORB) ──
  const orbIntradayBars = rawBarsEarly?.["10"] || rawBarsEarly?.["15"] || rawBarsEarly?.["5"] || [];
  const overnightGap = computeOvernightGapContext(orbIntradayBars, rawDailyBars, price, opts?.asOfTs || null);
  const orb = computeORB(orbIntradayBars, price, opts?.asOfTs || null);

  return {
    ...base,
    ticker: ticker.toUpperCase(),
    ts: Date.now(),
    script_version: "alpaca_server_v2.0",
    scoring_version: SCORING_VERSION,
    htf_score: Math.round(htfScore * 10) / 10,
    ltf_score: Math.round(ltfScore * 10) / 10,
    state,
    price,
    sl: sl ? Math.round(sl * 100) / 100 : undefined,
    tp: tp ? Math.round(tp * 100) / 100 : undefined,
    tp_trim: tp_trim ? Math.round(tp_trim * 100) / 100 : undefined,
    tp_exit: tp_exit ? Math.round(tp_exit * 100) / 100 : undefined,
    tp_runner: tp_runner ? Math.round(tp_runner * 100) / 100 : undefined,
    rr: Math.round(rr * 100) / 100,
    // Live completion: CP position from SL toward XP (tp_runner)
    // 0 = at SL, 1 = at XP. Updates in real-time with price.
    completion: (() => {
      const target = tp_runner || tp_exit || tp;
      const totalRange = Math.abs(target - sl);
      if (!totalRange || !Number.isFinite(price) || price <= 0) return 0;
      const progress = dir === 1 ? (price - sl) : (sl - price);
      return Math.max(0, Math.min(1, Math.round((progress / totalRange) * 1000) / 1000));
    })(),
    phase_pct: Math.round(phasePct * 1000) / 1000,
    saty_phase_pct: satyPhasePct,
    phase_dir: phaseDir,
    phase_zone: phaseZone,
    // V15 P0.2 — phase 5-bar slope (used by focus-tier slope alignment).
    // Read from daily bundle since phase is daily-derived.
    phase_slope_5bar: bD?.phase_slope_5bar ?? null,
    saty_phase_exit: satyPhaseExitSignal,
    rsi_divergence: (() => {
      const out = {};
      for (const [label, b] of Object.entries(tfMap)) {
        if (!b?.rsiDiv) continue;
        const hasPrimary = !!(b.rsiDiv.bear || b.rsiDiv.bull);
        const hasRecent = !!(b.rsiDiv.recentBear || b.rsiDiv.recentBull);
        if (hasPrimary || hasRecent) out[label] = b.rsiDiv;
      }
      return Object.keys(out).length > 0 ? out : undefined;
    })(),
    phase_divergence: (() => {
      const out = {};
      for (const [label, b] of Object.entries(tfMap)) {
        if (!b?.phaseDiv) continue;
        const hasPrimary = !!(b.phaseDiv.bear || b.phaseDiv.bull);
        if (hasPrimary) out[label] = b.phaseDiv;
      }
      return Object.keys(out).length > 0 ? out : undefined;
    })(),
    leading_ltf: leadingLtf,
    lead_intraday_tf: leadingLtf,
    flags,
    tf_tech: tfTech,
    atr_d: ATRd ? Math.round(ATRd * 100) / 100 : undefined,
    atr_w: ATRw ? Math.round(ATRw * 100) / 100 : undefined,
    // ── Precision scoring fields ──
    st_support: stSupport,
    atr_levels: atrLevels,
    fuel,
    ema_map: emaMap,
    ema_regime_daily: bD?.emaRegime ?? 0,
    ema_regime_4h: b4H?.emaRegime ?? 0,
    ema_regime_1h: b1H?.emaRegime ?? 0,
    st_bars_since_flip_D: bD?.stBarsSinceFlip ?? 0,
    active_gates: activeGates.length > 0 ? activeGates : undefined,
    // ── SMC / ICT indicators (top-level convenience) ──
    pdz_zone_D: bD?.pdz?.zone || "unknown",
    pdz_pct_D: bD?.pdz?.pct ?? 50,
    pdz_zone_4h: b4H?.pdz?.zone || "unknown",
    pdz_pct_4h: b4H?.pdz?.pct ?? 50,
    pdz_D: bD?.pdz || undefined,
    pdz_4h: b4H?.pdz || undefined,
    fvg_D: bD?.fvg ? { activeBull: bD.fvg.activeBull, activeBear: bD.fvg.activeBear,
      inBullGap: bD.fvg.inBullGap, inBearGap: bD.fvg.inBearGap,
      nearestBullDist: bD.fvg.nearestBullDist, nearestBearDist: bD.fvg.nearestBearDist } : undefined,
    fvg_4h: b4H?.fvg ? { activeBull: b4H.fvg.activeBull, activeBear: b4H.fvg.activeBear,
      inBullGap: b4H.fvg.inBullGap, inBearGap: b4H.fvg.inBearGap,
      nearestBullDist: b4H.fvg.nearestBullDist, nearestBearDist: b4H.fvg.nearestBearDist } : undefined,
    fvg_imbalance_D: bD ? computeFVGImbalance(bD) : undefined,
    liq_D: bD?.liq ? { buysideCount: bD.liq.buysideCount, sellsideCount: bD.liq.sellsideCount,
      nearestBuysideDist: bD.liq.nearestBuysideDist, nearestSellsideDist: bD.liq.nearestSellsideDist,
      buyside: bD.liq.buyside, sellside: bD.liq.sellside } : undefined,
    liq_4h: b4H?.liq ? { buysideCount: b4H.liq.buysideCount, sellsideCount: b4H.liq.sellsideCount,
      nearestBuysideDist: b4H.liq.nearestBuysideDist, nearestSellsideDist: b4H.liq.nearestSellsideDist,
      buyside: b4H.liq.buyside, sellside: b4H.liq.sellside } : undefined,
    liq_W: bW?.liq ? { buysideCount: bW.liq.buysideCount, sellsideCount: bW.liq.sellsideCount,
      nearestBuysideDist: bW.liq.nearestBuysideDist, nearestSellsideDist: bW.liq.nearestSellsideDist,
      buyside: bW.liq.buyside, sellside: bW.liq.sellside } : undefined,
    // ── Phoenix-inspired swing fields (Phase 1a, 2b, 3a) ──
    entry_quality: {
      score: entryQuality.score,
      structure: entryQuality.structure,
      momentum: entryQuality.momentum,
      confirmation: entryQuality.confirmation,
      details: entryQuality.details,
    },
    swing_consensus: {
      direction: swingConsensus.direction,
      bullish_count: swingConsensus.bullishCount,
      bearish_count: swingConsensus.bearishCount,
      avg_bias: swingConsensus.avgBias,
      tf_stack: swingConsensus.tfStack,
      freshest_cross_tf: swingConsensus.freshestCrossTf,
      freshest_cross_age: swingConsensus.freshestCrossAge,
    },
    direction_source: swingConsensus.direction
      ? "consensus"
      : (state.includes("BULL") ? "state_bull" : state.includes("BEAR") ? "state_bear" : "htf_score"),
    // Phase 2a: Swing regime from Daily/Weekly pivot detection
    regime: regime ? {
      daily: regime.daily,
      weekly: regime.weekly,
      combined: regime.combined,
    } : undefined,
    volatility_tier: volTier.tier,
    volatility_atr_pct: volTier.atrPct,
    // ── v3 Regime Classification (chop filter) ──
    regime_class: regimeClass.regime,          // "TRENDING" | "TRANSITIONAL" | "CHOPPY"
    regime_score: regimeClass.score,           // -15 to +15
    regime_factors: regimeClass.factors,       // breakdown for debugging/UI
    regime_params: regimeParams,               // adaptive trading parameters
    regimeVocabulary,
    market_internals: marketInternals || regimeClass.market_internals || undefined,
    execution_profile: executionProfile || undefined,
    breakout: breakout || undefined,           // breakout detection result
    overnight_gap: overnightGap || undefined,  // prior-close vs open gap context
    orb: orb || undefined,                     // Opening Range Breakout levels + signals
    data_source: "alpaca",
    // ── Ichimoku native data (replaces external ichimoku_d/ichimoku_w) ──
    ichimoku_d: bD?.ichimoku ? {
      position: bD.ichimoku.priceVsCloud,
      tenkan: Math.round(bD.ichimoku.tenkan * 100) / 100,
      kijun: Math.round(bD.ichimoku.kijun * 100) / 100,
      senkouA: Math.round(bD.ichimoku.senkouA * 100) / 100,
      senkouB: Math.round(bD.ichimoku.senkouB * 100) / 100,
      cloudTop: Math.round(bD.ichimoku.cloudTop * 100) / 100,
      cloudBase: Math.round(bD.ichimoku.cloudBase * 100) / 100,
      tkBull: bD.ichimoku.tkBull,
      tkCrossUp: bD.ichimoku.tkCrossUp,
      tkCrossDn: bD.ichimoku.tkCrossDn,
      cloudBullish: bD.ichimoku.cloudBullish,
      cloudThickness: Math.round(bD.ichimoku.cloudThickness * 100) / 100,
      chikouAbove: bD.ichimoku.chikouAbove,
      kumoTwist: bD.ichimoku.kumoTwist,
      tkSpread: Math.round(bD.ichimoku.tkSpread * 100) / 100,
      kijunSlope: Math.round(bD.ichimoku.kijunSlope * 100) / 100,
      priceToKijun: Math.round(bD.ichimoku.priceToKijun * 100) / 100,
      score: computeIchimokuScore(bD.ichimoku),
      // Kijun SL anchor: Kijun ± ATR cushion (for adaptive SL in worker)
      kijunSL_long:  ATRd > 0 ? Math.round((bD.ichimoku.kijun - ATRd * 0.2) * 100) / 100 : undefined,
      kijunSL_short: ATRd > 0 ? Math.round((bD.ichimoku.kijun + ATRd * 0.2) * 100) / 100 : undefined,
      cloudSL_long:  Math.round(bD.ichimoku.cloudBase * 100) / 100,
      cloudSL_short: Math.round(bD.ichimoku.cloudTop * 100) / 100,
    } : undefined,
    ichimoku_w: bW?.ichimoku ? {
      position: bW.ichimoku.priceVsCloud,
      tenkan: Math.round(bW.ichimoku.tenkan * 100) / 100,
      kijun: Math.round(bW.ichimoku.kijun * 100) / 100,
      cloudBullish: bW.ichimoku.cloudBullish,
      cloudThickness: Math.round(bW.ichimoku.cloudThickness * 100) / 100,
      chikouAbove: bW.ichimoku.chikouAbove,
      tkBull: bW.ichimoku.tkBull,
      score: computeIchimokuScore(bW.ichimoku),
    } : undefined,
    // ── Ichimoku map for all TFs (compact) ──
    ichimoku_map: (() => {
      const map = {};
      const ichSources = { M: bM, W: bW, D: bD, "240": b4H, "60": b1H, "30": b30, "10": b10 };
      for (const [tf, b] of Object.entries(ichSources)) {
        if (b?.ichimoku) {
          map[tf] = {
            pos: b.ichimoku.priceVsCloud,    // "above" | "below" | "inside"
            tkB: b.ichimoku.tkBull,           // Tenkan > Kijun
            cB: b.ichimoku.cloudBullish,      // future cloud is green
            cT: Math.round(b.ichimoku.cloudThickness * 100) / 100,
            chi: b.ichimoku.chikouAbove,      // Chikou confirmation
            ks: Math.round(b.ichimoku.kijunSlope * 100) / 100,
            sc: computeIchimokuScore(b.ichimoku), // score ±50
          };
        }
      }
      return Object.keys(map).length > 0 ? map : undefined;
    })(),
    // ── RVOL map for all TFs ──
    rvol_map: (() => {
      const map = {};
      const rvolSources = { M: bM, W: bW, D: bD, "240": b4H, "60": b1H, "30": b30, "10": b10 };
      for (const [tf, b] of Object.entries(rvolSources)) {
        if (b && Number.isFinite(b.volRatio)) {
          map[tf] = {
            vr: Math.round(b.volRatio * 100) / 100,     // current bar vs SMA20
            r5: Math.round((b.rvol5 || 1) * 100) / 100, // 5-bar avg vs SMA20
            sp: Math.round((b.rvolSpike || 0) * 100) / 100, // vs 20-bar max
          };
        }
      }
      return Object.keys(map).length > 0 ? map : undefined;
    })(),
    // ── Investor-grade monthly data (Phase 1A) ──
    monthly_bundle: bM ? {
      supertrend_dir: bM.stDir,       // 1 = bullish, -1 = bearish
      supertrend_line: bM.stLine ? Math.round(bM.stLine * 100) / 100 : undefined,
      ema_depth: bM.emaDepth,         // 0-10 conviction ladder
      ema_structure: Math.round((bM.emaStructure || 0) * 1000) / 1000,
      ema_momentum: Math.round((bM.emaMomentum || 0) * 1000) / 1000,
      ema200: bM.e200 ? Math.round(bM.e200 * 100) / 100 : undefined,
      rsi: bM.rsi ? Math.round(bM.rsi * 10) / 10 : undefined,
      atr14: bM.atr14 ? Math.round(bM.atr14 * 100) / 100 : undefined,
      phase_osc: bM.phaseOsc ? Math.round(bM.phaseOsc * 10) / 10 : undefined,
      px: bM.px ? Math.round(bM.px * 100) / 100 : undefined,
    } : undefined,
    // ── Daily structural profile (Phase E 2026-04-19) ──
    // Surfaces the raw D-EMA values + derived position/slope metrics the
    // entry engine needs for the Daily-Brief-aligned index-ETF swing path,
    // the D-EMA overextension fakeout gate, and the SPY-regime-activated
    // short-side relaxation. Computed from the same D bundle that powers
    // `ema_regime_daily` and `ema_map.D` so it stays consistent.
    daily_structure: bD ? (() => {
      const dpx = Number.isFinite(bD.px) ? bD.px : null;
      const de5 = Number.isFinite(bD.e5) ? bD.e5 : null;
      const de12 = Number.isFinite(bD.e12) ? bD.e12 : null;
      const de21 = Number.isFinite(bD.e21) ? bD.e21 : null;
      const de48 = Number.isFinite(bD.e48) ? bD.e48 : null;
      const de200 = Number.isFinite(bD.e200) ? bD.e200 : null;
      const pct = (ref) => (dpx != null && ref != null && ref > 0)
        ? Math.round(((dpx - ref) / ref) * 10000) / 100
        : null;
      const bullStack = (de21 != null && de48 != null && de200 != null)
        ? (de21 > de48 && de48 > de200) : null;
      const bearStack = (de21 != null && de48 != null && de200 != null)
        ? (de21 < de48 && de48 < de200) : null;
      return {
        px: dpx != null ? Math.round(dpx * 100) / 100 : undefined,
        // V15 P0.6 (2026-04-26): expose daily EMA5 and EMA12 for the
        // peak-detection exit logic. The 5/12 cloud distinguishes
        // "stretched away from EMA5 = peak risk" from
        // "testing/holding EMA12 = healthy pullback in trend".
        e5: de5 != null ? Math.round(de5 * 100) / 100 : undefined,
        e12: de12 != null ? Math.round(de12 * 100) / 100 : undefined,
        e21: de21 != null ? Math.round(de21 * 100) / 100 : undefined,
        e48: de48 != null ? Math.round(de48 * 100) / 100 : undefined,
        e200: de200 != null ? Math.round(de200 * 100) / 100 : undefined,
        pct_above_e5: pct(de5),
        pct_above_e12: pct(de12),
        pct_above_e21: pct(de21),
        pct_above_e48: pct(de48),
        pct_above_e200: pct(de200),
        e21_slope_5d_pct: Number.isFinite(bD.e21_slope_5bar_pct)
          ? Math.round(bD.e21_slope_5bar_pct * 100) / 100 : null,
        e48_slope_10d_pct: Number.isFinite(bD.e48_slope_10bar_pct)
          ? Math.round(bD.e48_slope_10bar_pct * 100) / 100 : null,
        bull_stack: bullStack,
        bear_stack: bearStack,
        above_e200: (dpx != null && de200 != null) ? dpx > de200 : null,
        ema_regime_daily: Number.isFinite(bD.emaRegime) ? bD.emaRegime : null,
        // V16 Setup #4: 52w high/low proximity for ATH-breakout / ATL-breakdown
        ath52w: bD.ath52w || null,
        // V16 Setup #1: range box for range-reversal LONG/SHORT entries
        range_box: bD.rangeBox || null,
        // V16 Setup #5: gap-down-reclaim / gap-up-fade detection
        gap_reversal: bD.gapReversal || null,
        // V16 Setup #2: N-test support/resistance for n-touch bounces
        n_test_support: bD.nTestSupport || null,
      };
    })() : undefined,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check if current time is Regular Trading Hours (9:00 AM - 4:00 PM ET).
 */
function isRTHNow() {
  const now = new Date();
  const etHour = now.getUTCHours() - 5; // EST offset (approximate; doesn't handle DST)
  return etHour >= 9 && etHour < 16;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TD SEQUENTIAL (DeMark Sequential) — Server-side computation
// Replicates the LuxAlgo Sequencer / Standard DeMark logic from Pine Script.
// Inputs: sorted OHLC candles (oldest first). Minimum ~30 candles recommended.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Compute TD Sequential (DeMark Sequencer) for a single timeframe.
 *
 * Algorithm (Standard DeMark):
 *   Preparation Phase (9 bars):
 *     Bullish: count consecutive closes below close[4]
 *     Bearish: count consecutive closes above close[4]
 *     Phase completes at count == 9 → td9 signal
 *
 *   Lead-up Phase (13 bars):
 *     Bullish: after bullish prep completes, count consecutive closes below low[2]
 *     Bearish: after bearish prep completes, count consecutive closes above high[2]
 *     Opposite prep completion resets the lead-up counter.
 *     Phase completes at count == 13 → td13 signal
 *
 * @param {Array<{o:number, h:number, l:number, c:number, ts?:number}>} candles
 *   Sorted ascending by time (oldest first). Must have at least prepComp + 1 bars.
 * @param {string} tf - Timeframe label ("D", "W", "M")
 * @param {object} [opts] - Options
 * @param {boolean} [opts.htfBull] - Higher-timeframe bullish bias (for boost calc)
 * @returns {object} td_sequential object matching existing schema
 */
export function computeTDSequential(candles, tf, opts = {}) {
  const PREP_LEN = 9;
  const PREP_COMP = 4;
  const LEADUP_LEN = 13;
  const LEADUP_COMP = 2;

  const result = {
    tf: tf || "D",
    timeframe: tf || "D",
    td9_bullish: false,
    td9_bearish: false,
    td13_bullish: false,
    td13_bearish: false,
    exit_long: false,
    exit_short: false,
    boost: 0,
    bullish_prep_count: 0,
    bearish_prep_count: 0,
    bullish_leadup_count: 0,
    bearish_leadup_count: 0,
  };

  if (!candles || candles.length < PREP_COMP + PREP_LEN) return result;

  // Walk through all candles to build state (stateful counters, just like Pine)
  let bullPrepCount = 0;
  let bearPrepCount = 0;
  let bullLeadupCount = 0;
  let bearLeadupCount = 0;

  for (let i = PREP_COMP; i < candles.length; i++) {
    const c = candles[i].c;
    const cComp = candles[i - PREP_COMP].c; // close[4]

    // ── Preparation Phase ──
    bullPrepCount = c < cComp ? bullPrepCount + 1 : 0;
    bearPrepCount = c > cComp ? bearPrepCount + 1 : 0;

    const bullPrepComplete = bullPrepCount === PREP_LEN;
    const bearPrepComplete = bearPrepCount === PREP_LEN;

    // ── Lead-up Phase ──
    // Reset lead-up on opposite prep completion (cancellation)
    if (bearPrepComplete) bullLeadupCount = 0;
    if (bullPrepComplete) bearLeadupCount = 0;

    // Bullish lead-up: close < low[2]
    if (i >= LEADUP_COMP) {
      const lowComp = candles[i - LEADUP_COMP].l;
      const highComp = candles[i - LEADUP_COMP].h;

      if (bullPrepComplete && c < lowComp) {
        bullLeadupCount += 1;
      } else if (bullLeadupCount > 0 && c < lowComp) {
        bullLeadupCount += 1;
      } else if (bullLeadupCount > 0 && c >= lowComp) {
        bullLeadupCount = 0; // Reset if condition breaks
      }

      if (bearPrepComplete && c > highComp) {
        bearLeadupCount += 1;
      } else if (bearLeadupCount > 0 && c > highComp) {
        bearLeadupCount += 1;
      } else if (bearLeadupCount > 0 && c <= highComp) {
        bearLeadupCount = 0; // Reset if condition breaks
      }
    }
  }

  // Final state from the last bar
  result.bullish_prep_count = bullPrepCount;
  result.bearish_prep_count = bearPrepCount;
  result.bullish_leadup_count = bullLeadupCount;
  result.bearish_leadup_count = bearLeadupCount;

  // TD9: prep phase just completed (count == 9 on latest bar)
  result.td9_bullish = bullPrepCount === PREP_LEN;
  result.td9_bearish = bearPrepCount === PREP_LEN;

  // TD13: lead-up phase complete
  result.td13_bullish = bullLeadupCount === LEADUP_LEN;
  result.td13_bearish = bearLeadupCount === LEADUP_LEN;

  // Exit signals
  result.exit_long = result.td9_bearish || result.td13_bearish;
  result.exit_short = result.td9_bullish || result.td13_bullish;

  // Boost calculation (mirrors Pine Script logic)
  const htfBull = opts.htfBull != null ? opts.htfBull : true; // default to bull bias
  if (htfBull) {
    // For LONG bias: Bullish TD9/13 = boost, Bearish TD9/13 = penalty
    result.boost = result.td9_bullish ? 5.0
      : result.td13_bullish ? 8.0
      : result.td9_bearish ? -5.0
      : result.td13_bearish ? -8.0
      : 0.0;
    // Prep count approaching completion = additional boost
    if (bullPrepCount >= 6 && bullPrepCount < PREP_LEN) result.boost += 2.0;
    if (bullLeadupCount >= 6 && bullLeadupCount < LEADUP_LEN) result.boost += 3.0;
  } else {
    // For SHORT bias: Bearish TD9/13 = boost, Bullish TD9/13 = penalty
    result.boost = result.td9_bearish ? 5.0
      : result.td13_bearish ? 8.0
      : result.td9_bullish ? -5.0
      : result.td13_bullish ? -8.0
      : 0.0;
    if (bearPrepCount >= 6 && bearPrepCount < PREP_LEN) result.boost += 2.0;
    if (bearLeadupCount >= 6 && bearLeadupCount < LEADUP_LEN) result.boost += 3.0;
  }

  return result;
}

/**
 * Compute TD Sequential across ALL 9 timeframes and merge.
 *
 * Priority: Monthly provides long-term context, Weekly is primary signal,
 * Daily is most actionable. Merge logic:
 *   - Daily td9/td13 signals are used directly
 *   - Weekly td9/td13 override Daily (stronger signal)
 *   - Monthly td13 overrides everything (strongest exhaustion signal)
 *   - Boost is summed across D/W/M timeframes (capped at ±15)
 *   - Counts from the highest-tf active signal are preferred
 *   - per_tf breakdown includes ALL available TFs for chart overlays
 *
 * @param {object} candlesByTf - { "10": [...], "30": [...], "60": [...], "240": [...], D: [...], W: [...], M: [...] }
 * @param {boolean} htfBull - Higher-timeframe bullish bias
 * @returns {object} merged td_sequential object with per_tf breakdown for all TFs
 */
export function computeTDSequentialMultiTF(candlesByTf, htfBull = true) {
  const allTfs = ["10", "30", "60", "240", "D", "W", "M"];
  const results = {};
  const perTf = {};

  for (const tf of allTfs) {
    const candles = candlesByTf[tf];
    if (candles && candles.length >= 14) {
      results[tf] = computeTDSequential(candles, tf, { htfBull });
      perTf[tf] = results[tf];
    }
  }

  // Merge logic uses D/W/M for the primary merged signal (as before)
  const dR = results.D || null;
  const wR = results.W || null;
  const mR = results.M || null;

  // Start with Daily as the base (most actionable)
  const merged = dR
    ? { ...dR }
    : {
        tf: "D", timeframe: "D",
        td9_bullish: false, td9_bearish: false,
        td13_bullish: false, td13_bearish: false,
        exit_long: false, exit_short: false, boost: 0,
        bullish_prep_count: 0, bearish_prep_count: 0,
        bullish_leadup_count: 0, bearish_leadup_count: 0,
      };

  // Weekly overrides: if Weekly has a TD9/TD13 signal, it takes precedence
  if (wR) {
    if (wR.td9_bullish) { merged.td9_bullish = true; merged.tf = "W"; merged.timeframe = "W"; }
    if (wR.td9_bearish) { merged.td9_bearish = true; merged.tf = "W"; merged.timeframe = "W"; }
    if (wR.td13_bullish) { merged.td13_bullish = true; merged.tf = "W"; merged.timeframe = "W"; }
    if (wR.td13_bearish) { merged.td13_bearish = true; merged.tf = "W"; merged.timeframe = "W"; }
  }

  // Monthly overrides: strongest signal, overrides everything
  if (mR) {
    if (mR.td9_bullish) { merged.td9_bullish = true; merged.tf = "M"; merged.timeframe = "M"; }
    if (mR.td9_bearish) { merged.td9_bearish = true; merged.tf = "M"; merged.timeframe = "M"; }
    if (mR.td13_bullish) { merged.td13_bullish = true; merged.tf = "M"; merged.timeframe = "M"; }
    if (mR.td13_bearish) { merged.td13_bearish = true; merged.tf = "M"; merged.timeframe = "M"; }
  }

  // Recompute exit signals from merged TD9/TD13
  merged.exit_long = merged.td9_bearish || merged.td13_bearish;
  merged.exit_short = merged.td9_bullish || merged.td13_bullish;

  // Sum boosts across D/W/M timeframes, capped at ±15
  let totalBoost = (dR?.boost || 0) + (wR?.boost || 0) * 1.5 + (mR?.boost || 0) * 2.0;
  merged.boost = Math.max(-15, Math.min(15, Math.round(totalBoost * 10) / 10));

  // Use highest-TF counts for display (prefer M > W > D)
  if (mR && (mR.bullish_prep_count > 0 || mR.bearish_prep_count > 0)) {
    merged.bullish_prep_count = mR.bullish_prep_count;
    merged.bearish_prep_count = mR.bearish_prep_count;
    merged.bullish_leadup_count = mR.bullish_leadup_count;
    merged.bearish_leadup_count = mR.bearish_leadup_count;
  } else if (wR && (wR.bullish_prep_count > 0 || wR.bearish_prep_count > 0)) {
    merged.bullish_prep_count = wR.bullish_prep_count;
    merged.bearish_prep_count = wR.bearish_prep_count;
    merged.bullish_leadup_count = wR.bullish_leadup_count;
    merged.bearish_leadup_count = wR.bearish_leadup_count;
  }

  // Attach per-tf breakdown for ALL TFs (used by chart TD overlays)
  merged.per_tf = perTf;

  return merged;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CANDLE DEDUPLICATION
// Removes duplicate candles that share the same calendar period (day/week/month).
// Common cause: multiple Alpaca backfill runs store bars at 00:00 UTC and 04:00 UTC
// for the same trading day. Keeps the LAST entry per period (closest to market close).
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Deduplicate candles so there is at most one per calendar period.
 *
 * For Daily: one candle per calendar date (UTC).
 * For Weekly: one candle per ISO week.
 * For Monthly: one candle per year-month.
 * For intraday: deduplicate by exact timestamp (safety net).
 *
 * Candles must be sorted ascending by ts (oldest first) on input.
 * Returns a new array, sorted ascending, with duplicates removed.
 *
 * @param {Array<{ts:number, o:number, h:number, l:number, c:number}>} candles
 * @param {string} tf - Timeframe key ("D", "W", "M", "240", "60", "30", "10", "3")
 * @returns {Array} deduplicated candles, sorted ascending by ts
 */
export function deduplicateCandles(candles, tf) {
  if (!candles || candles.length <= 1) return candles;

  const upperTf = String(tf).toUpperCase();

  if (upperTf === "D" || upperTf === "1D" || upperTf === "DAY") {
    // Group by calendar date (UTC)
    const byDate = new Map();
    for (const c of candles) {
      const d = new Date(c.ts);
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
      byDate.set(key, c); // last write wins (latest ts for that date)
    }
    return [...byDate.values()].sort((a, b) => a.ts - b.ts);
  }

  if (upperTf === "W" || upperTf === "1W" || upperTf === "WEEK") {
    // Group by ISO week (year + week number)
    const byWeek = new Map();
    for (const c of candles) {
      const d = new Date(c.ts);
      // ISO week: Thursday-based
      const thu = new Date(d);
      thu.setUTCDate(thu.getUTCDate() + 4 - (thu.getUTCDay() || 7));
      const yearStart = new Date(Date.UTC(thu.getUTCFullYear(), 0, 1));
      const weekNum = Math.ceil((((thu - yearStart) / 86400000) + 1) / 7);
      const key = `${thu.getUTCFullYear()}-W${String(weekNum).padStart(2, "0")}`;
      byWeek.set(key, c);
    }
    return [...byWeek.values()].sort((a, b) => a.ts - b.ts);
  }

  if (upperTf === "M" || upperTf === "1M" || upperTf === "MONTH") {
    // Group by year-month
    const byMonth = new Map();
    for (const c of candles) {
      const d = new Date(c.ts);
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      byMonth.set(key, c);
    }
    return [...byMonth.values()].sort((a, b) => a.ts - b.ts);
  }

  // Intraday: deduplicate by exact timestamp
  const byTs = new Map();
  for (const c of candles) {
    byTs.set(c.ts, c);
  }
  return [...byTs.values()].sort((a, b) => a.ts - b.ts);
}

// ═══════════════════════════════════════════════════════════════════════════════
// ALPACA API CLIENT
// ═══════════════════════════════════════════════════════════════════════════════

const ALPACA_BASE = "https://data.alpaca.markets/v2";

// Map our internal TF keys to Alpaca timeframe format
const TF_TO_ALPACA = {
  "1": "1Min",
  "5": "5Min",
  "10": "10Min",
  "30": "30Min",
  "60": "1Hour",
  "240": "4Hour",
  "D": "1Day",
  "W": "1Week",
  "M": "1Month",
};

// Canonical 8 timeframes: 5m, 10m, 30m, 1H, 4H, D, W, M
// (1m + 3m dropped — 1m: Phase 2 cost optimization; 3m: too noisy)

// All timeframes we need for scoring
// M (Monthly) included for investor-grade scoring (computeInvestorScore)
const ALL_TFS = ["M", "W", "D", "240", "60", "30", "15", "10"];

// All timeframes we fetch from Alpaca for candle storage (5m dropped — swing focus)
const CRON_FETCH_TFS = ["M", "W", "D", "240", "60", "30", "10"];

// TD Sequential timeframes — computed on 7 TFs for chart overlays (5m dropped)
const TD_SEQ_TFS = ["10", "30", "60", "240", "D", "W", "M"];

/**
 * Fetch historical bars from Alpaca for multiple symbols.
 * @param {object} env - Worker env with ALPACA_API_KEY_ID, ALPACA_API_SECRET_KEY
 * @param {string[]} symbols - array of ticker symbols
 * @param {string} tfKey - internal timeframe key (e.g., "30", "D")
 * @param {string} start - ISO 8601 start time
 * @param {string} end - ISO 8601 end time (optional)
 * @param {number} limit - max bars per symbol (default 5)
 * @returns {Promise<object>} { bars: { AAPL: [...], ... }, next_page_token }
 */
export async function alpacaFetchBars(env, symbols, tfKey, start, end = null, limit = 5) {
  const apiKeyId = env?.ALPACA_API_KEY_ID;
  const apiSecret = env?.ALPACA_API_SECRET_KEY;
  if (!apiKeyId || !apiSecret) {
    console.warn("[ALPACA] Missing API credentials");
    return { bars: {}, error: "missing_credentials" };
  }

  const alpacaTf = TF_TO_ALPACA[tfKey];
  if (!alpacaTf) {
    console.warn(`[ALPACA] Unknown timeframe: ${tfKey}`);
    return { bars: {}, error: "bad_timeframe" };
  }

  const params = new URLSearchParams();
  params.set("symbols", symbols.join(","));
  params.set("timeframe", alpacaTf);
  params.set("start", start);
  if (end) params.set("end", end);
  params.set("limit", String(limit));
  params.set("adjustment", "split"); // split-adjusted
  params.set("feed", "sip"); // Algo Trader+ has SIP access
  params.set("sort", "asc");

  const url = `${ALPACA_BASE}/stocks/bars?${params.toString()}`;

  try {
    const resp = await fetch(url, {
      headers: {
        "APCA-API-KEY-ID": apiKeyId,
        "APCA-API-SECRET-KEY": apiSecret,
        "Accept": "application/json",
      },
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.error(`[ALPACA] HTTP ${resp.status}: ${text.slice(0, 300)}`);
      return { bars: {}, error: `http_${resp.status}`, detail: text.slice(0, 200) };
    }

    const data = await resp.json();
    return {
      bars: data.bars || {},
      next_page_token: data.next_page_token || null,
    };
  } catch (err) {
    console.error(`[ALPACA] Fetch error:`, err);
    return { bars: {}, error: String(err) };
  }
}

/**
 * Fetch all pages of bars for a given timeframe and symbols.
 * Handles pagination via next_page_token.
 */
export async function alpacaFetchAllBars(env, symbols, tfKey, start, end = null, limit = 1000) {
  const allBars = {};
  let pageToken = null;
  let pages = 0;
  const maxPages = 20; // safety cap

  // Symbol normalization: BRK-B → BRK.B (Alpaca format)
  const ALPACA_SYM_MAP = { "BRK-B": "BRK.B" };
  const reverseSymMap = {};
  for (const [ours, alpaca] of Object.entries(ALPACA_SYM_MAP)) reverseSymMap[alpaca] = ours;
  const alpacaSymbols = symbols.map(s => ALPACA_SYM_MAP[s] || s);

  do {
    const apiKeyId = env?.ALPACA_API_KEY_ID;
    const apiSecret = env?.ALPACA_API_SECRET_KEY;
    const alpacaTf = TF_TO_ALPACA[tfKey];
    if (!alpacaTf || !apiKeyId || !apiSecret) break;

    const params = new URLSearchParams();
    params.set("symbols", alpacaSymbols.join(","));
    params.set("timeframe", alpacaTf);
    params.set("start", start);
    if (end) params.set("end", end);
    params.set("limit", String(limit));
    params.set("adjustment", "split");
    params.set("feed", "sip");
    params.set("sort", "asc");
    if (pageToken) params.set("page_token", pageToken);

    const url = `${ALPACA_BASE}/stocks/bars?${params.toString()}`;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60000);
      const resp = await fetch(url, {
        headers: {
          "APCA-API-KEY-ID": apiKeyId,
          "APCA-API-SECRET-KEY": apiSecret,
          "Accept": "application/json",
        },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        console.warn(`[ALPACA] Fetch bars failed: ${resp.status} ${errText.slice(0, 200)}`);
        break;
      }
      const data = await resp.json();
      const bars = data.bars || {};
      let pageBars = 0;
      for (const [sym, barArr] of Object.entries(bars)) {
        const ourSym = reverseSymMap[sym] || sym;
        if (!allBars[ourSym]) allBars[ourSym] = [];
        allBars[ourSym].push(...barArr);
        pageBars += barArr.length;
      }
      console.log(`[ALPACA] TF=${tfKey} page ${pages}: ${Object.keys(bars).length} syms, ${pageBars} bars, token=${pageToken ? 'yes' : 'no'}`);
      pageToken = data.next_page_token || null;
    } catch (fetchErr) {
      console.warn(`[ALPACA] Fetch error (page ${pages}):`, String(fetchErr).slice(0, 200));
      break;
    }
    pages++;
  } while (pageToken && pages < maxPages);

  return allBars;
}

// ═══════════════════════════════════════════════════════════════════════
// Alpaca Crypto Bars — /v1beta3/crypto/us/bars (separate endpoint)
// ═══════════════════════════════════════════════════════════════════════

const ALPACA_CRYPTO_BASE = "https://data.alpaca.markets/v1beta3/crypto/us";

// Internal ticker → Alpaca crypto symbol format
const CRYPTO_SYMBOL_MAP = {
  "BTCUSD": "BTC/USD",
  "ETHUSD": "ETH/USD",
};
const REVERSE_CRYPTO_MAP = Object.fromEntries(
  Object.entries(CRYPTO_SYMBOL_MAP).map(([k, v]) => [v, k])
);

/**
 * Fetch bars from Alpaca's crypto endpoint for the given symbols and timeframe.
 * Handles pagination via next_page_token.
 * Returns { [internalSym]: bar[] } where bars have Alpaca format { t, o, h, l, c, v, ... }.
 */
export async function alpacaFetchCryptoBars(env, cryptoTickers, tfKey, start, end = null, limit = 10000) {
  const apiKeyId = env?.ALPACA_API_KEY_ID;
  const apiSecret = env?.ALPACA_API_SECRET_KEY;
  const alpacaTf = TF_TO_ALPACA[tfKey];
  if (!alpacaTf || !apiKeyId || !apiSecret) return {};

  // Map internal symbols to Alpaca crypto format
  const alpacaSyms = cryptoTickers
    .map(t => CRYPTO_SYMBOL_MAP[t])
    .filter(Boolean);
  if (alpacaSyms.length === 0) return {};

  const allBars = {};
  let pageToken = null;
  let pages = 0;
  const maxPages = 20;

  do {
    const params = new URLSearchParams();
    params.set("symbols", alpacaSyms.join(","));
    params.set("timeframe", alpacaTf);
    params.set("start", start);
    if (end) params.set("end", end);
    params.set("limit", String(limit));
    params.set("sort", "asc");
    if (pageToken) params.set("page_token", pageToken);

    const url = `${ALPACA_CRYPTO_BASE}/bars?${params.toString()}`;
    try {
      const resp = await fetch(url, {
        headers: {
          "APCA-API-KEY-ID": apiKeyId,
          "APCA-API-SECRET-KEY": apiSecret,
          "Accept": "application/json",
        },
      });
      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        console.warn(`[ALPACA CRYPTO] Fetch bars failed: ${resp.status} ${errText.slice(0, 200)}`);
        break;
      }
      const data = await resp.json();
      const bars = data.bars || {};
      let pageBars = 0;
      for (const [alpacaSym, barArr] of Object.entries(bars)) {
        // Reverse-map: "BTC/USD" → "BTCUSD"
        const ourSym = REVERSE_CRYPTO_MAP[alpacaSym] || alpacaSym.replace("/", "");
        if (!allBars[ourSym]) allBars[ourSym] = [];
        allBars[ourSym].push(...barArr);
        pageBars += barArr.length;
      }
      if (pages === 0) {
        console.log(`[ALPACA CRYPTO] TF=${tfKey} page 0: ${Object.keys(bars).length} symbols, ${pageBars} bars`);
      }
      pageToken = data.next_page_token || null;
    } catch (fetchErr) {
      console.warn(`[ALPACA CRYPTO] Fetch error:`, String(fetchErr).slice(0, 200));
      break;
    }
    pages++;
  } while (pageToken && pages < maxPages);

  return allBars;
}

/**
 * Cron job: fetch latest crypto bars from Alpaca and upsert into D1.
 * Mirrors alpacaCronFetchLatest but uses the crypto endpoint.
 * Crypto trades 24/7 so this should run on all cron ticks, not just equity hours.
 *
 * Uses the same 4-group TF rotation as the stock cron.
 */
export async function alpacaCronFetchCrypto(env) {
  if (!env?.ALPACA_API_KEY_ID || !env?.ALPACA_API_SECRET_KEY) {
    return { ok: false, error: "alpaca_not_configured" };
  }
  const db = env?.DB;
  if (!db) return { ok: false, error: "no_db_binding" };

  const CRYPTO_TICKERS = Object.keys(CRYPTO_SYMBOL_MAP);
  if (CRYPTO_TICKERS.length === 0) return { ok: true, upserted: 0 };

  // Phase 3: tiered TF refresh matching stock bar cron.
  // D/W/M hourly only (crypto bars rarely need sub-hourly D/W/M updates).
  // Intraday TFs every tick (only 2 tickers, very lightweight).
  const minuteOfHour = new Date().getUTCMinutes();
  const isTopOfHour = minuteOfHour < 5;
  const tfsThisCycle = isTopOfHour
    ? ["10", "30", "60", "240", "D", "W", "M"]
    : ["10", "30", "60", "240"];

  const TF_LOOKBACK_MS = {
    "10":  6 * 60 * 60 * 1000,      // 6 hours
    "30":  12 * 60 * 60 * 1000,     // 12 hours
    "60":  48 * 60 * 60 * 1000,     // 48 hours
    "240": 96 * 60 * 60 * 1000,     // 4 days
    "D":   14 * 24 * 60 * 60 * 1000,  // 2 weeks
    "W":   42 * 24 * 60 * 60 * 1000,  // 6 weeks
    "M":   95 * 24 * 60 * 60 * 1000,  // ~3 months
  };

  let totalUpserted = 0;
  let totalErrors = 0;

  for (const tf of tfsThisCycle) {
    try {
      const lookback = TF_LOOKBACK_MS[tf] || 48 * 60 * 60 * 1000;
      const start = new Date(Date.now() - lookback).toISOString();
      const barsBySymbol = await alpacaFetchCryptoBars(env, CRYPTO_TICKERS, tf, start, null, 10000);

      const updatedAt = Date.now();
      const stmts = [];
      for (const [sym, bars] of Object.entries(barsBySymbol)) {
        if (!Array.isArray(bars)) continue;
        for (const bar of bars) {
          const candle = alpacaBarToCandle(bar);
          if (!candle || !Number.isFinite(candle.ts)) continue;
          const { ts, o, h, l, c, v } = candle;
          if (![o, h, l, c].every(x => Number.isFinite(x))) continue;
          stmts.push(
            db.prepare(
              `INSERT INTO ticker_candles (ticker, tf, ts, o, h, l, c, v, updated_at)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
               ON CONFLICT(ticker, tf, ts) DO UPDATE SET
                 o=excluded.o, h=excluded.h, l=excluded.l, c=excluded.c, v=excluded.v,
                 updated_at=excluded.updated_at
               WHERE ticker_candles.c != excluded.c
                  OR ticker_candles.h != excluded.h
                  OR ticker_candles.l != excluded.l
                  OR ticker_candles.v IS NOT excluded.v`
            ).bind(sym.toUpperCase(), tf, ts, o, h, l, c, v != null ? v : null, updatedAt)
          );
        }
      }

      const BATCH_SIZE = 100; // D1 safe batch limit
      for (let i = 0; i < stmts.length; i += BATCH_SIZE) {
        const chunk = stmts.slice(i, i + BATCH_SIZE);
        try {
          await db.batch(chunk);
          totalUpserted += chunk.length;
        } catch (batchErr) {
          console.error(`[ALPACA CRYPTO CRON] Batch ${i / BATCH_SIZE} for TF ${tf} failed:`, String(batchErr).slice(0, 200));
          totalErrors += chunk.length;
        }
      }
    } catch (err) {
      console.error(`[ALPACA CRYPTO CRON] TF ${tf} failed:`, err);
      totalErrors++;
    }
  }

  console.log(`[ALPACA CRYPTO CRON] TFs=[${tfsThisCycle}] upserted=${totalUpserted} errors=${totalErrors}${isTopOfHour ? " (hourly D/W/M)" : ""}`);
  return { ok: true, upserted: totalUpserted, errors: totalErrors, tickers: CRYPTO_TICKERS.length, tfs: tfsThisCycle };
}

/**
 * Determine market session type from a UTC timestamp.
 * Uses US Eastern Time offsets (EST = UTC-5, EDT = UTC-4).
 *
 * Returns:
 *   "PM"  - Pre-market  (4:00 AM - 9:30 AM ET)
 *   "RTH" - Regular trading hours (9:30 AM - 4:00 PM ET)
 *   "AH"  - After-hours (4:00 PM - 8:00 PM ET)
 *   "CLOSED" - Market closed (8:00 PM - 4:00 AM ET)
 *
 * @param {number} tsMs - epoch milliseconds (UTC)
 * @returns {string}
 */
export function getSessionType(tsMs) {
  const d = new Date(tsMs);
  // Determine US Eastern offset: crude DST check (Mar second Sun – Nov first Sun)
  const month = d.getUTCMonth(); // 0-indexed
  const day = d.getUTCDate();
  const dow = d.getUTCDay(); // 0 = Sunday
  // DST roughly March 8-14 Sun through Nov 1-7 Sun
  let isEDT = false;
  if (month > 2 && month < 10) {
    isEDT = true; // Apr-Oct always EDT
  } else if (month === 2) {
    // March: EDT starts second Sunday
    const secondSun = 14 - ((new Date(d.getUTCFullYear(), 2, 1).getUTCDay() + 6) % 7);
    isEDT = day > secondSun || (day === secondSun && d.getUTCHours() >= 7); // 2AM ET = 7AM UTC in EST
  } else if (month === 10) {
    // November: EDT ends first Sunday
    const firstSun = 7 - ((new Date(d.getUTCFullYear(), 10, 1).getUTCDay() + 6) % 7);
    isEDT = day < firstSun || (day === firstSun && d.getUTCHours() < 6); // 2AM ET = 6AM UTC in EDT
  }

  const offsetHrs = isEDT ? -4 : -5;
  const etMs = tsMs + offsetHrs * 3600000;
  const etDate = new Date(etMs);
  const etMinutes = etDate.getUTCHours() * 60 + etDate.getUTCMinutes(); // minutes since midnight ET

  // 4:00 AM ET = 240, 9:30 AM ET = 570, 4:00 PM ET = 960, 8:00 PM ET = 1200
  if (etMinutes >= 240 && etMinutes < 570) return "PM";
  if (etMinutes >= 570 && etMinutes < 960) return "RTH";
  if (etMinutes >= 960 && etMinutes < 1200) return "AH";
  return "CLOSED";
}

/**
 * Convert Alpaca bar to our D1 candle format with session tag.
 * Alpaca bar: { t: "2026-02-05T14:30:00Z", o, h, l, c, v, n, vw }
 */
export function alpacaBarToCandle(bar) {
  const tsMs = new Date(bar.t).getTime();
  return {
    ts: tsMs,
    o: bar.o,
    h: bar.h,
    l: bar.l,
    c: bar.c,
    v: bar.v || 0,
    session: getSessionType(tsMs),
  };
}

/**
 * Fetch real-time snapshots from Alpaca for price display.
 * Uses GET /v2/stocks/snapshots (batch endpoint) for efficiency.
 * Returns: { AAPL: { price, dailyOpen, dailyHigh, dailyLow, dailyClose, dailyVolume, minuteBar, prevDailyClose }, ... }
 *
 * @param {object} env - Worker env with ALPACA_API_KEY_ID, ALPACA_API_SECRET_KEY
 * @param {string[]} symbols - array of ticker symbols (stocks only; crypto handled separately)
 * @returns {Promise<object>} { snapshots: {...}, error?: string }
 */
export async function alpacaFetchSnapshots(env, symbols) {
  const apiKeyId = env?.ALPACA_API_KEY_ID;
  const apiSecret = env?.ALPACA_API_SECRET_KEY;
  if (!apiKeyId || !apiSecret) {
    return { snapshots: {}, error: "missing_credentials" };
  }
  if (!symbols || symbols.length === 0) {
    return { snapshots: {}, error: "no_symbols" };
  }

  const headers = {
    "APCA-API-KEY-ID": apiKeyId,
    "APCA-API-SECRET-KEY": apiSecret,
    "Accept": "application/json",
  };

  // Crypto pairs that need the crypto endpoint (not the stocks endpoint)
  const CRYPTO_PAIRS = { "BTCUSD": "BTC/USD", "ETHUSD": "ETH/USD" };
  // Non-Alpaca tickers (futures/commodities from TradingView) — skip entirely
  const NON_ALPACA = new Set(["ES1!", "NQ1!", "GOLD", "SILVER", "VX1!", "US500", "GC1!", "SI1!"]);

  // Symbol normalization for Alpaca API: BRK-B → BRK.B, etc.
  const ALPACA_SYM_MAP = { "BRK-B": "BRK.B" };
  const reverseSymMap = {}; // Alpaca format → our format
  for (const [ours, alpaca] of Object.entries(ALPACA_SYM_MAP)) reverseSymMap[alpaca] = ours;

  const stockSymbols = [];
  const cryptoSymbols = [];
  for (const sym of symbols) {
    if (NON_ALPACA.has(sym)) continue;
    if (CRYPTO_PAIRS[sym]) { cryptoSymbols.push(sym); continue; }
    // Use Alpaca-compatible symbol format for the API call
    stockSymbols.push(ALPACA_SYM_MAP[sym] || sym);
  }

  const snapshots = {};

  // ── Helper: parse Alpaca stock snapshot into our standard format ──
  function parseStockSnap(sym, snap) {
    // Map Alpaca symbol back to our internal format (BRK.B → BRK-B)
    const ourSym = reverseSymMap[sym] || sym;
    const lt = snap.latestTrade;
    const lq = snap.latestQuote;
    const db = snap.dailyBar;
    const pdb = snap.prevDailyBar;
    const mb = snap.minuteBar;

    // Smart price selection: latestTrade can be a stale low-volume AH trade
    // (e.g. ULTA $675 when actual close was $679.28 and bid/ask is $679/$682).
    // Strategy:
    //   1. During RTH or if latestTrade is recent (<5 min) & decent volume: use latestTrade.p
    //   2. If quote midpoint available and latestTrade looks stale: prefer quote midpoint
    //   3. Fall back to dailyBar.c (official RTH close)
    const tradePrice = Number(lt?.p) || 0;
    const tradeTs = lt?.t ? new Date(lt.t).getTime() : 0;
    const tradeAgeMin = tradeTs > 0 ? (Date.now() - tradeTs) / 60000 : Infinity;
    const dailyClose = Number(db?.c) || 0;
    const bid = Number(lq?.bp) || 0;
    const ask = Number(lq?.ap) || 0;
    const quoteMid = (bid > 0 && ask > 0 && ask >= bid) ? Math.round((bid + ask) / 2 * 100) / 100 : 0;

    let price = tradePrice; // default: latestTrade.p

    // If latestTrade is stale (>5 min old), check for better sources
    if (tradeAgeMin > 5 && tradePrice > 0) {
      // Check if latestTrade diverges significantly from dailyBar.c or quote midpoint
      const refPrice = quoteMid > 0 ? quoteMid : dailyClose;
      if (refPrice > 0) {
        const divergePct = Math.abs(tradePrice - refPrice) / refPrice * 100;
        if (divergePct > 0.5) {
          // Stale trade diverges from quote/close — use quote midpoint or daily close
          price = quoteMid > 0 ? quoteMid : dailyClose;
        }
      }
    }

    // If no trade price at all, fall back to quote midpoint or daily close
    if (!(price > 0)) {
      price = quoteMid > 0 ? quoteMid : dailyClose;
    }

    snapshots[ourSym] = {
      price,
      trade_ts: tradeTs,
      dailyOpen: db?.o || 0,
      dailyHigh: db?.h || 0,
      dailyLow: db?.l || 0,
      dailyClose,
      dailyVolume: db?.v || 0,
      prevDailyClose: pdb?.c || 0,
      minuteBar: mb ? { o: mb.o, h: mb.h, l: mb.l, c: mb.c, v: mb.v, ts: new Date(mb.t).getTime() } : null,
    };
  }

  // ── Fetch stocks in batches (sip feed first, then iex fallback for missing) ──
  const BATCH_SIZE = 100;
  async function fetchStockBatch(syms, feed) {
    const returned = new Set();
    for (let i = 0; i < syms.length; i += BATCH_SIZE) {
      const batch = syms.slice(i, i + BATCH_SIZE);
      const params = new URLSearchParams();
      params.set("symbols", batch.join(","));
      params.set("feed", feed);
      const url = `${ALPACA_BASE}/stocks/snapshots?${params.toString()}`;
      try {
        const resp = await fetch(url, { headers });
        if (!resp.ok) {
          const text = await resp.text();
          console.error(`[ALPACA SNAPSHOTS] ${feed} HTTP ${resp.status}: ${text.slice(0, 200)}`);
          continue;
        }
        const data = await resp.json();
        for (const [sym, snap] of Object.entries(data)) {
          parseStockSnap(sym, snap);
          returned.add(sym);
        }
      } catch (err) {
        console.error(`[ALPACA SNAPSHOTS] ${feed} fetch error:`, err);
      }
    }
    return returned;
  }

  // Primary: SIP feed (most complete for paid plans)
  const sipReturned = await fetchStockBatch(stockSymbols, "sip");

  // Fallback: IEX feed for symbols missing from SIP (covers ETFs on free/basic plans)
  const missingSip = stockSymbols.filter(s => !sipReturned.has(s));
  if (missingSip.length > 0) {
    console.log(`[ALPACA SNAPSHOTS] ${missingSip.length} symbols missing from SIP, trying IEX fallback...`);
    await fetchStockBatch(missingSip, "iex");
  }

  // Retry: single-symbol fetch for symbols still missing (e.g. AEHR, small caps)
  const stillMissing = stockSymbols.filter(s => !snapshots[reverseSymMap[s] || s]?.price);
  if (stillMissing.length > 0 && stillMissing.length <= 25) {
    for (const sym of stillMissing.slice(0, 25)) {
      try {
        const url = `${ALPACA_BASE}/stocks/${sym}/snapshot?feed=sip`;
        const resp = await fetch(url, { headers });
        if (resp.ok) {
          const snap = await resp.json();
          if (snap?.latestTrade || snap?.dailyBar) {
            parseStockSnap(sym, snap);
          }
        }
      } catch (_) { /* skip */ }
    }
  }

  // ── Fetch crypto snapshots (separate endpoint) ──
  if (cryptoSymbols.length > 0) {
    try {
      const alpacaCryptoSyms = cryptoSymbols.map(s => CRYPTO_PAIRS[s]).filter(Boolean);
      const params = new URLSearchParams();
      params.set("symbols", alpacaCryptoSyms.join(","));
      const url = `https://data.alpaca.markets/v1beta3/crypto/us/snapshots?${params.toString()}`;
      const resp = await fetch(url, { headers });
      if (resp.ok) {
        const data = await resp.json();
        // Crypto response: { "snapshots": { "BTC/USD": { latestTrade, dailyBar, prevDailyBar, minuteBar } } }
        const cryptoSnaps = data.snapshots || data;
        // Map back from "BTC/USD" to "BTCUSD"
        const reverseMap = {};
        for (const [k, v] of Object.entries(CRYPTO_PAIRS)) reverseMap[v] = k;
        for (const [alpacaSym, snap] of Object.entries(cryptoSnaps)) {
          const ourSym = reverseMap[alpacaSym] || alpacaSym.replace("/", "");
          const lt = snap.latestTrade;
          const db = snap.dailyBar;
          const pdb = snap.prevDailyBar;
          const mb = snap.minuteBar;
          snapshots[ourSym] = {
            price: lt?.p || db?.c || 0,
            trade_ts: lt?.t ? new Date(lt.t).getTime() : 0,
            dailyOpen: db?.o || 0,
            dailyHigh: db?.h || 0,
            dailyLow: db?.l || 0,
            dailyClose: db?.c || 0,
            dailyVolume: db?.v || 0,
            prevDailyClose: pdb?.c || 0,
            minuteBar: mb ? { o: mb.o, h: mb.h, l: mb.l, c: mb.c, v: mb.v, ts: new Date(mb.t).getTime() } : null,
          };
        }
      } else {
        console.error(`[ALPACA SNAPSHOTS] Crypto HTTP ${resp.status}`);
      }
    } catch (err) {
      console.error(`[ALPACA SNAPSHOTS] Crypto fetch error:`, err);
    }
  }

  return { snapshots };
}

/**
 * Fetch latest bars (last 3-5) for all tickers across all timeframes and store in D1.
 * Simplified: no group rotation. Uses 2 groups on alternating minutes for load distribution.
 * Group A (even minutes): scoring TFs — D, 30, 10, 5 + higher TFs W, 240, M
 * Group B (odd minutes): supplementary — 60, 1
 *
 * @param {object} env - Worker environment
 * @param {string[]} allTickers - full list of tickers
 * @param {Function} upsertCandle - d1UpsertCandle function reference
 * @returns {Promise<object>} summary of fetch results
 */
export async function alpacaCronFetchLatest(env, allTickers, upsertCandle) {
  if (!env?.ALPACA_API_KEY_ID || !env?.ALPACA_API_SECRET_KEY) {
    return { ok: false, error: "alpaca_not_configured" };
  }
  if (!allTickers || allTickers.length === 0) {
    return { ok: false, error: "no_tickers" };
  }
  const db = env?.DB;
  if (!db) {
    return { ok: false, error: "no_db_binding" };
  }

  // Phase 3: 5-min cadence with tiered TF refresh.
  //   Every tick:    5m, 10m       — scoring-critical intraday (10-min refresh per ticker)
  //   Every tick:    30m, 60m, 240m — medium-frequency intraday (10-min refresh per ticker)
  //   Hourly only:   D, W, M       — daily+ TFs, rarely change intraday (2-hour refresh per ticker)
  //
  // Ticker halves: alternating by 5-min slot index to spread load.
  const minuteOfHour = new Date().getUTCMinutes();
  const slotIdx = Math.floor(minuteOfHour / 5); // 0-11 within the hour
  const isTopOfHour = minuteOfHour < 5;

  const tfsThisCycle = isTopOfHour
    ? ["10", "30", "60", "240", "D", "W", "M"]
    : ["10", "30", "60", "240"];

  const halfIdx = slotIdx % 2;
  const mid = Math.ceil(allTickers.length / 2);
  const tickersThisCycle = halfIdx === 0 ? allTickers.slice(0, mid) : allTickers.slice(mid);
  console.log(`[ALPACA CRON] TFs=[${tfsThisCycle}] half=${halfIdx} tickers=${tickersThisCycle.length}/${allTickers.length} slot=${slotIdx}${isTopOfHour ? " (hourly D/W/M)" : ""}`);

  const TF_LOOKBACK_MS = {
    "10":  3 * 60 * 60 * 1000,     // 3 hours
    "30":  6 * 60 * 60 * 1000,     // 6 hours
    "60":  24 * 60 * 60 * 1000,    // 24 hours
    "240": 48 * 60 * 60 * 1000,    // 48 hours
    "D":   7 * 24 * 60 * 60 * 1000,  // 7 days
    "W":   35 * 24 * 60 * 60 * 1000, // 5 weeks
    "M":   95 * 24 * 60 * 60 * 1000, // ~3 months
  };

  let totalUpserted = 0;
  let totalErrors = 0;

  for (const tf of tfsThisCycle) {
    try {
      const lookback = TF_LOOKBACK_MS[tf] || 24 * 60 * 60 * 1000;
      const start = new Date(Date.now() - lookback).toISOString();
      // Use paginated fetch — limit=10000 per page (Alpaca max), auto-paginates
      // Uses tickersThisCycle (half the full list) to stay within wall-clock time limits
      const barsBySymbol = await alpacaFetchAllBars(env, tickersThisCycle, tf, start, null, 10000);

      // Collect all candle statements for batch execution.
      // D1 batch() executes multiple statements in a single round trip,
      // avoiding the "Too many API requests by single worker invocation" error.
      const updatedAt = Date.now();
      const stmts = [];
      for (const [sym, bars] of Object.entries(barsBySymbol)) {
        if (!Array.isArray(bars)) continue;
        for (const bar of bars) {
          const candle = alpacaBarToCandle(bar);
          if (!candle || !Number.isFinite(candle.ts)) continue;
          const { ts, o, h, l, c, v } = candle;
          if (![o, h, l, c].every(x => Number.isFinite(x))) continue;
          stmts.push(
            db.prepare(
              `INSERT INTO ticker_candles (ticker, tf, ts, o, h, l, c, v, updated_at)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
               ON CONFLICT(ticker, tf, ts) DO UPDATE SET
                 o=excluded.o, h=excluded.h, l=excluded.l, c=excluded.c, v=excluded.v,
                 updated_at=excluded.updated_at
               WHERE ticker_candles.c != excluded.c
                  OR ticker_candles.h != excluded.h
                  OR ticker_candles.l != excluded.l
                  OR ticker_candles.v IS NOT excluded.v`
            ).bind(sym.toUpperCase(), tf, ts, o, h, l, c, v != null ? v : null, updatedAt)
          );
        }
      }

      // D1 batch limit: paid plans support up to 5000 statements per batch.
      // Use 500 to keep round-trips low while staying safe.
      const BATCH_SIZE = 500;
      for (let i = 0; i < stmts.length; i += BATCH_SIZE) {
        const chunk = stmts.slice(i, i + BATCH_SIZE);
        try {
          await db.batch(chunk);
          totalUpserted += chunk.length;
        } catch (batchErr) {
          // If large batch fails, retry with smaller chunks (100)
          console.warn(`[ALPACA CRON] Batch ${i / BATCH_SIZE} (${chunk.length} stmts) for TF ${tf} failed, retrying in smaller chunks:`, String(batchErr).slice(0, 200));
          for (let j = 0; j < chunk.length; j += 100) {
            const smallChunk = chunk.slice(j, j + 100);
            try {
              await db.batch(smallChunk);
              totalUpserted += smallChunk.length;
            } catch (smallErr) {
              console.error(`[ALPACA CRON] Small batch retry failed for TF ${tf}:`, String(smallErr).slice(0, 200));
              totalErrors += smallChunk.length;
            }
          }
        }
      }
    } catch (err) {
      console.error(`[ALPACA CRON] TF ${tf} failed:`, err);
      totalErrors++;
    }
  }

  console.log(`[ALPACA CRON] half=${halfIdx} TFs=[${tfsThisCycle}] tickers=${tickersThisCycle.length} upserted=${totalUpserted} errors=${totalErrors}${isTopOfHour ? " (hourly D/W/M)" : ""}`);
  return { ok: true, upserted: totalUpserted, errors: totalErrors, tickers: tickersThisCycle.length, totalTickers: allTickers.length, half: halfIdx, tfs: tfsThisCycle };
}

/**
 * Backfill historical bars for all tickers (for EMA200 warm-up).
 * Uses batch D1 writes (500 per chunk) to avoid hitting subrequest limits.
 * Reports progress to KV (`timed:backfill:status`) for UI polling.
 *
 * @param {object} env - Worker env with DB binding and optionally KV
 * @param {string[]} tickers
 * @param {object|Function} _unused - DEPRECATED: previously upsertCandle callback, now ignored
 * @param {string} tfKey - single timeframe to backfill (or "all")
 * @param {number|object} [opts] - sinceDays (number) or { sinceDays, startDate, endDate } for explicit range
 * @returns {Promise<object>}
 */
export async function alpacaBackfill(env, tickers, _unused, tfKey = "all", opts = null) {
  const db = env?.DB;
  if (!db) return { ok: false, error: "no_db_binding" };

  const optsObj = typeof opts === "object" && opts !== null ? opts : { sinceDays: opts };
  const { sinceDays, startDate: startDateStr, endDate: endDateStr } = optsObj;

  const tfsToBackfill = tfKey === "all" ? CRON_FETCH_TFS : [tfKey];
  let totalUpserted = 0;
  let totalErrors = 0;
  const perTfStats = {};

  // KV for progress reporting (optional — fails gracefully)
  const KV = env?.KV_TIMED || env?.TIMED_KV || env?.KV || null;
  const updateProgress = async (status) => {
    if (!KV) return;
    try {
      await KV.put("timed:backfill:status", JSON.stringify({
        ...status,
        updated_at: Date.now(),
      }), { expirationTtl: 3600 }); // auto-expire after 1 hour (deep backfills can take 20+ min per batch)
    } catch { /* best-effort */ }
  };

  const now = new Date();
  const DAY_MS = 24 * 60 * 60 * 1000;

  // When startDate/endDate provided, use explicit range. Else when sinceDays set, use lookback. Else deep history.
  const tradingCalDays = (bars, barMinutes) => Math.ceil(bars * barMinutes / 390 * 7 / 5) + 5;
  let startDates, endDates = null;
  if (startDateStr && endDateStr) {
    const start = new Date(startDateStr + "T00:00:00Z").toISOString();
    const end = new Date(endDateStr + "T23:59:59Z").toISOString();
    startDates = { "M": start, "W": start, "D": start, "240": start, "60": start, "30": start, "10": start };
    endDates = { "M": end, "W": end, "D": end, "240": end, "60": end, "30": end, "10": end };
  } else if (typeof sinceDays === "number" && sinceDays > 0) {
    const start = new Date(now.getTime() - sinceDays * DAY_MS).toISOString();
    startDates = { "M": start, "W": start, "D": start, "240": start, "60": start, "30": start, "10": start };
  } else {
    startDates = {
      "M": new Date(now.getTime() - 365 * 10 * DAY_MS).toISOString(),
      "W": new Date(now.getTime() - 300 * 7 * DAY_MS).toISOString(),
      "D": new Date(now.getTime() - 450 * DAY_MS).toISOString(),
      "240": new Date(now.getTime() - tradingCalDays(1000, 240) * DAY_MS).toISOString(),
      "60": new Date(now.getTime() - tradingCalDays(1000, 60) * DAY_MS).toISOString(),
      "30": new Date(now.getTime() - tradingCalDays(1000, 30) * DAY_MS).toISOString(),
      "10": new Date(now.getTime() - tradingCalDays(3000, 10) * DAY_MS).toISOString(),
    };
  }

  // Process in symbol batches; 4H uses smaller batches to avoid Alpaca pagination timeouts.
  // Deep lookbacks (sinceDays > 120) need smaller batches because Alpaca's limit=10000
  // is shared across all symbols per page. With 50 symbols, each gets only ~4k bars
  // (51 trading days of 5m). With 10 symbols, each gets ~20k bars (256 days).
  const needsDeepBatch = typeof sinceDays === "number" && sinceDays > 120;
  const getBatchSize = (tf) => {
    if (tf === "240") return 15;
    return needsDeepBatch ? 10 : 50;
  };
  const BATCH_SIZE = 500; // D1 supports up to ~500 bound statements per batch

  for (let tfIdx = 0; tfIdx < tfsToBackfill.length; tfIdx++) {
    const tf = tfsToBackfill[tfIdx];
    const start = startDates[tf];
    const end = endDates?.[tf] ?? null;
    if (!start) continue;
    const batchSize = getBatchSize(tf);
    let tfUpserted = 0;
    let tfErrors = 0;

    await updateProgress({
      phase: "fetching",
      tickers: tickers.length === 1 ? tickers[0] : `${tickers.length} tickers`,
      tf,
      tfIndex: tfIdx + 1,
      tfTotal: tfsToBackfill.length,
      upserted: totalUpserted,
      errors: totalErrors,
    });

    // Separate crypto tickers from stock tickers — crypto uses a different Alpaca endpoint
    const cryptoTickers = tickers.filter(t => CRYPTO_SYMBOL_MAP[t]);
    const stockTickers = tickers.filter(t => !CRYPTO_SYMBOL_MAP[t]);

    // Backfill crypto tickers first (separate endpoint)
    if (cryptoTickers.length > 0) {
      try {
        const cryptoBars = await alpacaFetchCryptoBars(env, cryptoTickers, tf, start, end, 10000);
        const stmts = [];
        const updatedAt = Date.now();
        for (const [sym, bars] of Object.entries(cryptoBars)) {
          if (!Array.isArray(bars)) continue;
          for (const bar of bars) {
            const candle = alpacaBarToCandle(bar);
            if (!candle || !Number.isFinite(candle.ts)) continue;
            const { ts, o, h, l, c, v } = candle;
            if (![o, h, l, c].every(x => Number.isFinite(x))) continue;
            stmts.push(
              db.prepare(
                `INSERT INTO ticker_candles (ticker, tf, ts, o, h, l, c, v, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                 ON CONFLICT(ticker, tf, ts) DO UPDATE SET
                   o=excluded.o, h=excluded.h, l=excluded.l, c=excluded.c, v=excluded.v,
                   updated_at=excluded.updated_at`
              ).bind(sym.toUpperCase(), tf, ts, o, h, l, c, v != null ? v : null, updatedAt)
            );
          }
        }
        for (let j = 0; j < stmts.length; j += BATCH_SIZE) {
          const chunk = stmts.slice(j, j + BATCH_SIZE);
          try {
            await db.batch(chunk);
            totalUpserted += chunk.length;
          } catch (batchErr) {
            console.error(`[ALPACA BACKFILL] Crypto TF ${tf} batch chunk failed:`, String(batchErr).slice(0, 200));
            totalErrors += chunk.length;
          }
        }
        console.log(`[ALPACA BACKFILL] Crypto TF ${tf}: ${stmts.length} candles`);
      } catch (cryptoErr) {
        console.error(`[ALPACA BACKFILL] Crypto TF ${tf} failed:`, String(cryptoErr).slice(0, 200));
      }
    }

    for (let i = 0; i < stockTickers.length; i += batchSize) {
      const batch = stockTickers.slice(i, i + batchSize);
      try {
        const allBars = await alpacaFetchAllBars(env, batch, tf, start, end, 10000);

        // Collect all candle INSERT statements for this Alpaca batch
        const stmts = [];
        const updatedAt = Date.now();
        for (const [sym, bars] of Object.entries(allBars)) {
          if (!Array.isArray(bars)) continue;
          for (const bar of bars) {
            const candle = alpacaBarToCandle(bar);
            if (!candle || !Number.isFinite(candle.ts)) continue;
            const { ts, o, h, l, c, v } = candle;
            if (![o, h, l, c].every(x => Number.isFinite(x))) continue;
            stmts.push(
              db.prepare(
                `INSERT INTO ticker_candles (ticker, tf, ts, o, h, l, c, v, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                 ON CONFLICT(ticker, tf, ts) DO UPDATE SET
                   o=excluded.o, h=excluded.h, l=excluded.l, c=excluded.c, v=excluded.v,
                   updated_at=excluded.updated_at`
              ).bind(sym.toUpperCase(), tf, ts, o, h, l, c, v != null ? v : null, updatedAt)
            );
          }
        }

        // Execute in D1-safe chunks of 500
        for (let j = 0; j < stmts.length; j += BATCH_SIZE) {
          const chunk = stmts.slice(j, j + BATCH_SIZE);
          try {
            await db.batch(chunk);
            tfUpserted += chunk.length;
            totalUpserted += chunk.length;
          } catch (batchErr) {
            console.error(`[ALPACA BACKFILL] TF ${tf} batch chunk ${j / BATCH_SIZE} failed:`, String(batchErr).slice(0, 200));
            tfErrors += chunk.length;
            totalErrors += chunk.length;
          }
        }

        // Report progress after each Alpaca API batch
        await updateProgress({
          phase: "writing",
          tickers: tickers.length === 1 ? tickers[0] : `${tickers.length} tickers`,
          tf,
          tfIndex: tfIdx + 1,
          tfTotal: tfsToBackfill.length,
          bars: stmts.length,
          upserted: totalUpserted,
          errors: totalErrors,
        });
      } catch (err) {
        console.error(`[ALPACA BACKFILL] TF ${tf} batch ${i} error:`, err);
        totalErrors++;
        tfErrors++;
      }
    }

    perTfStats[tf] = { upserted: tfUpserted, errors: tfErrors };
    console.log(`[ALPACA BACKFILL] TF ${tf} complete: ${tfUpserted} upserted, ${tfErrors} errors`);
  }

  // Final progress: done
  await updateProgress({
    phase: "done",
    tickers: tickers.length === 1 ? tickers[0] : `${tickers.length} tickers`,
    upserted: totalUpserted,
    errors: totalErrors,
    perTf: perTfStats,
  });

  return { ok: true, upserted: totalUpserted, errors: totalErrors, perTf: perTfStats };
}

/**
 * Compute full server-side scores for a single ticker from D1 candles.
 * @param {string} ticker
 * @param {Function} getCandles - d1GetCandles(env, ticker, tf, limit)
 * @param {object} env
 * @param {object} existingData - existing KV latest data for merge
 * @returns {Promise<object|null>} assembled tickerData or null if insufficient data
 */
export async function computeServerSideScores(ticker, getCandles, env, existingData = null) {
  const bundles = {};
  let hasData = false;
  const leadingLtf = normalizeTfKey(env?.LEADING_LTF || existingData?.leading_ltf || "10") || "10";

  // Fetch candles for all scoring timeframes + TD Sequential timeframes in PARALLEL
  // Scoring TFs: W, D, 240, 60, 30, leading intraday TF
  // TD Sequential TFs: all 9 TFs (1, 5, 10, 30, 60, 240, D, W, M)
  const scoringTfs = (leadingLtf === "15" || leadingLtf === "30") ? [...ALL_TFS, leadingLtf] : ALL_TFS;
  const allTfsToFetch = [...new Set([...scoringTfs, ...TD_SEQ_TFS])]; // union of scoring + TD TFs
  const tfResults = await Promise.all(
    allTfsToFetch.map(async (tf) => {
      try {
        // For TD Sequential, we need ~50 candles; for scoring we need 300
        const limit = TD_SEQ_TFS.includes(tf) && !scoringTfs.includes(tf) ? 60 : 300;
        const result = await getCandles(env, ticker, tf, limit);
        return { tf, result };
      } catch (e) {
        console.warn(`[COMPUTE] ${ticker} TF ${tf} error:`, e);
        return { tf, result: null };
      }
    })
  );

  // Separate scoring candles, TD Sequential candles, and raw bars for regime
  const tdSeqCandles = {};
  const rawBars = {}; // Phase 2a: raw OHLC bars for regime detection

  for (const { tf, result } of tfResults) {
    if (result?.ok && result.candles && result.candles.length > 0) {
      // Deduplicate candles BEFORE any computation (fixes duplicate daily bars
      // from multiple Alpaca backfill runs that store two entries per date)
      const deduped = deduplicateCandles(result.candles, tf);

      // Scoring bundles (need 50+ candles for indicator computation)
      if (scoringTfs.includes(tf) && deduped.length >= 50) {
        bundles[tf] = computeTfBundle(deduped);
        if (bundles[tf]) hasData = true;
      }
      // TD Sequential candles (need 14+ for minimal computation)
      if (TD_SEQ_TFS.includes(tf) && deduped.length >= 14) {
        tdSeqCandles[tf] = deduped;
      }
      // Collect raw bars for regime detection (D, W) and ORB computation (intraday)
      if (tf === "D" || tf === "W" || tf === "10" || tf === "15" || tf === "5") {
        rawBars[tf] = deduped;
      }
    }
  }

  if (!hasData) return null;

  // Map to the key format used by assembleTickerData
  const bundleMap = {
    M: bundles.M || null,
    W: bundles.W || null,
    D: bundles.D || null,
    "240": bundles["240"] || null,
    "60": bundles["60"] || null,
    "30": bundles["30"] || null,
    "15": bundles["15"] || null,
    "10": bundles["10"] || null,
  };

  // Pass raw bars + optional learned weights so assembleTickerData uses them
  const assembleOpts = { rawBars };
  const runtimeProfileFlag = String(
    env?.ENABLE_EXECUTION_PROFILE_RUNTIME
      || env?.TT_ENABLE_PROFILE_RUNTIME
      || "false"
  ).toLowerCase() === "true";
  if (leadingLtf) assembleOpts.leadingLtf = leadingLtf;
  if (existingData?._tfWeights) assembleOpts.tfWeights = existingData._tfWeights;
  if (existingData?._signalWeights) assembleOpts.signalWeights = existingData._signalWeights;
  if (existingData?._scoreWeights) assembleOpts.scoreWeights = existingData._scoreWeights;
  if (existingData?._marketInternals) assembleOpts.marketInternals = existingData._marketInternals;
  assembleOpts.enableExecutionProfileRuntime = runtimeProfileFlag;
  const tickerData = assembleTickerData(ticker, bundleMap, existingData, assembleOpts);
  if (!tickerData) return null;

  // ── Three-Tier Awareness: attach ticker profile if available ──
  const tickerProfile = normalizeLearnedTickerProfile(existingData?._tickerProfile || null, {
    ticker,
    source: existingData?.__profile_resolution?.learned_profile_source || "runtime",
  });
  const profileContext = resolveTickerProfileContext(ticker, tickerProfile, {
    learnedSource: existingData?.__profile_resolution?.learned_profile_source || "runtime",
  });
  tickerData.__static_behavior_profile = profileContext.staticBehaviorProfile;
  tickerData.__profile_resolution = profileContext.lineage;
  if (tickerProfile) {
    tickerData._tickerProfile = tickerProfile;
    tickerData._ticker_profile = buildLegacyLearnedProfileView(tickerProfile, {
      ticker,
      source: profileContext.lineage.learned_profile_source || "runtime",
    });
  }

  // ── Compute TD Sequential (D/W/M) and attach ──
  if (Object.keys(tdSeqCandles).length > 0) {
    const htfBull = (tickerData.htf_score || 0) >= 0;
    const tdSeq = computeTDSequentialMultiTF(tdSeqCandles, htfBull);
    tickerData.td_sequential = tdSeq;

    // Mean Reversion TD9 Aligned setup detection (LONG and SHORT)
    const price = bundleMap?.D?.px || bundleMap?.["60"]?.px;
    if (price) {
      const mrLong = detectMeanReversionTD9(bundleMap, tdSeq, price);
      if (mrLong) { tickerData.mean_revert_td9 = mrLong; }
      else {
        const mrShort = detectMeanReversionTD9Short(bundleMap, tdSeq, price);
        if (mrShort) tickerData.mean_revert_td9 = mrShort;
      }
    }
  }

  return tickerData;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SIGNAL FRESHNESS / DECAY
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Compute a freshness score (0.0 – 1.0) for a signal based on its age and type.
 *
 * Signal types & decay curves:
 *   "structural" — ST flip on 1H+, EMA cross on D/W.
 *     Full weight for 8 hours, then 0.7×, never below 0.5×.
 *
 *   "entry" — EMA cross on 30m/1H, GG cross.
 *     Full weight for 2 hours, 0.5× after 4 hours, 0.2× after 8 hours.
 *
 *   "momentum" — ST flip on 3m/10m, squeeze release on 30m.
 *     Full weight for 30 minutes, 0.5× after 2 hours, 0.1× after 4 hours.
 *
 * @param {number} signalTs - epoch ms when the signal fired
 * @param {number} nowTs    - epoch ms (current time)
 * @param {string} signalType - "structural" | "entry" | "momentum"
 * @returns {number} 0.0 – 1.0
 */
export function signalFreshness(signalTs, nowTs, signalType) {
  if (!signalTs || signalTs <= 0) return 0;
  const ageMs = nowTs - signalTs;
  if (ageMs < 0) return 1.0; // future timestamp — treat as fresh
  const ageHrs = ageMs / (3600 * 1000);

  switch (signalType) {
    case "structural":
      if (ageHrs <= 8) return 1.0;
      if (ageHrs <= 24) return 0.7;
      return 0.5;

    case "entry":
      if (ageHrs <= 2) return 1.0;
      if (ageHrs <= 4) return 0.5;
      if (ageHrs <= 8) return 0.2;
      return 0.0;

    case "momentum":
      if (ageHrs <= 0.5) return 1.0;
      if (ageHrs <= 2) return 0.5;
      if (ageHrs <= 4) return 0.1;
      return 0.0;

    default:
      // Unknown type — use entry decay as default
      if (ageHrs <= 2) return 1.0;
      if (ageHrs <= 4) return 0.5;
      return 0.0;
  }
}

/**
 * Session-aware signal weight multiplier.
 * Signals from PM/AH candles are less reliable (lower volume).
 *
 * @param {string} session - "PM" | "RTH" | "AH" | "CLOSED" | null
 * @returns {number} 0.0 – 1.0
 */
export function sessionWeight(session) {
  if (session === "RTH" || !session) return 1.0;
  if (session === "PM" || session === "AH") return 0.7;
  return 0.5; // CLOSED
}

// ═══════════════════════════════════════════════════════════════════════════════
// OVERNIGHT SIGNAL DETECTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Detect signals that fired during the overnight gap (PM + AH sessions).
 * Called once at market open (first scoring cycle after 9:30 AM ET).
 *
 * Fetches all available candles, runs computeTfBundle() on them, and returns
 * any signals that fired during the gap, tagged with their timestamps and
 * session type.
 *
 * @param {string} ticker
 * @param {number} lastRTHCloseTs - epoch ms of last RTH close (previous 4:00 PM ET)
 * @param {number} currentTs - epoch ms (now, should be shortly after 9:30 AM ET)
 * @param {Function} getCandles - async function(env, ticker, tf, limit) → { ok, candles }
 * @param {object} env - worker env
 * @returns {Promise<object>} { signals: [...], overnightFlags: {...} }
 */
export async function computeOvernightSignals(ticker, lastRTHCloseTs, currentTs, getCandles, env) {
  const signals = [];
  const overnightFlags = {};
  const leadingLtf = normalizeTfKey(env?.LEADING_LTF || "10") || "10";

  // Fetch candles for the key signal timeframes (30m, 60m, leading intraday TF)
  const signalTFs = [...new Set(["30", "60", leadingLtf])];

  for (const tf of signalTFs) {
    try {
      const result = await getCandles(env, ticker, tf, 300);
      if (!result?.ok || !result.candles || result.candles.length < 50) continue;

      const bundle = computeTfBundle(result.candles);
      if (!bundle) continue;

      const tfLabel = tf === "60" ? "1h" : tf === "30" ? "30m" : tf === "15" ? "15m" : tf === "10" ? "10m" : tf;

      // Check for EMA cross signals with timestamps in the overnight window
      if (bundle.emaCross13_48_up && bundle.emaCross13_48_up_ts > lastRTHCloseTs && bundle.emaCross13_48_up_ts < currentTs) {
        signals.push({
          type: "emaCross13_48_up",
          tf: tfLabel,
          ts: bundle.emaCross13_48_up_ts,
          session: getSessionType(bundle.emaCross13_48_up_ts),
        });
        overnightFlags[`ema_cross_${tfLabel}_13_48`] = true;
        overnightFlags[`ema_cross_${tfLabel}_13_48_ts`] = bundle.emaCross13_48_up_ts;
      }
      if (bundle.emaCross13_48_dn && bundle.emaCross13_48_dn_ts > lastRTHCloseTs && bundle.emaCross13_48_dn_ts < currentTs) {
        signals.push({
          type: "emaCross13_48_dn",
          tf: tfLabel,
          ts: bundle.emaCross13_48_dn_ts,
          session: getSessionType(bundle.emaCross13_48_dn_ts),
        });
        overnightFlags[`ema_cross_${tfLabel}_13_48`] = true;
        overnightFlags[`ema_cross_${tfLabel}_13_48_ts`] = bundle.emaCross13_48_dn_ts;
      }

      // SuperTrend flip
      if (bundle.stFlip && bundle.stFlip_ts > lastRTHCloseTs && bundle.stFlip_ts < currentTs) {
        const dir = bundle.stFlipDir === 1 ? "bull" : "bear";
        signals.push({
          type: `stFlip_${dir}`,
          tf: tfLabel,
          ts: bundle.stFlip_ts,
          session: getSessionType(bundle.stFlip_ts),
        });
        overnightFlags[`st_flip_${tfLabel}`] = true;
        overnightFlags[`st_flip_${tfLabel}_ts`] = bundle.stFlip_ts;
        if (dir === "bear") {
          overnightFlags.st_flip_bear = true;
          overnightFlags.st_flip_bear_ts = bundle.stFlip_ts;
        }
      }

      // Squeeze release
      if (bundle.sqRelease && bundle.sqRelease_ts > lastRTHCloseTs && bundle.sqRelease_ts < currentTs) {
        signals.push({
          type: "sqRelease",
          tf: tfLabel,
          ts: bundle.sqRelease_ts,
          session: getSessionType(bundle.sqRelease_ts),
        });
        const sqKey = tf === "60" ? "sq1h_release" : tf === "30" ? "sq30_release" : `sq${tfLabel}_release`;
        overnightFlags[sqKey] = true;
        overnightFlags[`${sqKey}_ts`] = bundle.sqRelease_ts;
      }
    } catch (e) {
      console.warn(`[OVERNIGHT] ${ticker} TF ${tf} error:`, e);
    }
  }

  return { signals, overnightFlags };
}

/**
 * Build a full snapshot payload for timed_trail.payload_json storage.
 *
 * INCLUSIVE by design: stores the entire assembled ticker data so any
 * indicator added in the future is automatically captured. Only strips:
 *   - Double-underscore runtime fields (__entry_block_reason, etc.)
 *   - _sparkline (large array, UI-only)
 *   - _pathPerfCache (runtime map reference)
 *   - Circular / non-serializable references
 *
 * The snapshot includes per-TF data for all timeframes:
 *   tf_tech[TF] → EMA stack/depth/structure/momentum, SuperTrend dir/slope,
 *     ATR bands, Squeeze, RSI, RSI divergence, Ripster clouds, Phase osc,
 *     Saty phase, Saty ATR, Fuel gauge, PDZ zone, FVG, Liquidity, Ichimoku
 *   Plus top-level: atr_levels, ichimoku_d, ichimoku_w, ichimoku_map,
 *     td_sequential, orb, breakout, liq_*, fvg_*, pdz_*, ema_map, fuel,
 *     rvol_map, st_support, active_gates, entry_quality, swing_consensus,
 *     regime, execution_profile, market_internals, pattern_match, etc.
 *
 * @param {object} d - Full ticker data from assembleTickerData + replay enrichment
 * @param {object} [meta] - Optional metadata (scoring_version override, git hash)
 * @returns {string} JSON string ready for payload_json column
 */
export function buildSnapshotPayload(d, meta = {}) {
  if (!d) return null;

  // Keys to exclude: runtime-only fields that shouldn't be persisted
  const EXCLUDE_KEYS = new Set([
    "_sparkline",           // large UI-only array
    "_pathPerfCache",       // runtime Map reference
    "_learnedTfWeights",    // per-session cache
    "_learnedScoreAdj",     // per-session cache
    "_learnedSignalWeights",// per-session cache
    "_tfWeights",           // per-session cache
    "_scoreWeights",        // per-session cache
    "_signalWeights",       // per-session cache
  ]);

  const snap = {};
  // Inject metadata header
  snap._snapshot_v = d.scoring_version || SCORING_VERSION;
  snap._git = meta.gitHash || null;

  for (const [key, val] of Object.entries(d)) {
    if (val === undefined || val === null) continue;
    if (EXCLUDE_KEYS.has(key)) continue;
    // Skip double-underscore runtime diagnostic fields (__entry_block_reason, etc.)
    // but preserve single-underscore context fields (_vix, _env, _marketInternals)
    if (key.startsWith("__")) continue;
    snap[key] = val;
  }

  return JSON.stringify(snap);
}
