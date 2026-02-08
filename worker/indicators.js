// ─────────────────────────────────────────────────────────────────────────────
// Server-side indicator computation engine
// Replicates TimedTrading_ScoreEngine_v2.1.0 Pine Script logic in JavaScript
// ─────────────────────────────────────────────────────────────────────────────

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
// COMPOSITE BUNDLE: Mirrors Pine Script f_tf_bundle()
// ═══════════════════════════════════════════════════════════════════════════════

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
  if (!bars || bars.length < 50) return null; // need minimum data

  const closes = bars.map(b => b.c);
  const n = bars.length;
  const last = n - 1;

  const px = closes[last];

  // EMAs — 10-EMA gradient ribbon
  const e3s = emaSeries(closes, 3);
  const e5s = emaSeries(closes, 5);
  const e8s = emaSeries(closes, 8);
  const e13s = emaSeries(closes, 13);
  const e21s = emaSeries(closes, 21);
  const e34s = emaSeries(closes, 34);
  const e48s = emaSeries(closes, 48);
  const e89s = emaSeries(closes, 89);
  const e200s = emaSeries(closes, 200);
  const e233s = emaSeries(closes, 233);

  const e3 = e3s[last];
  const e5 = e5s[last];
  const e8 = e8s[last];
  const e13 = e13s[last]; // eFast (emaFastLen=13)
  const e21 = e21s[last];
  const e34 = e34s[last];
  const e48 = e48s[last]; // eSlow (emaSlowLen=48)
  const e89 = e89s[last];
  const e200 = e200s[last];
  const e233 = e233s[last];
  const eFast = e13; // Pine default emaFastLen=13
  const eSlow = e48; // Pine default emaSlowLen=48

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

  const ALL_EMAS = [e3, e5, e8, e13, e21, e34, e48, e89, e200, e233];
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

  // Volume
  const vols = bars.map(b => b.v || 0);
  const volSmaArr = smaSeries(vols, 20);
  const volSma = volSmaArr[last];
  const volRatio = (volSma > 0 && vols[last] > 0) ? vols[last] / volSma : 1.0;

  // RSI
  const rsiArr = rsiSeries(closes, 14);
  const rsi = rsiArr[last];

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

  return {
    px,
    e3, e5, e8, e13, e21, e34, e48, e89, e200, e233,
    eFast, eSlow,
    emaDepth, emaStructure, emaMomentum, ribbonSpread,
    stLine, stDir, stLinePrev, stSlopeUp, stSlopeDn,
    stFlip, stFlipDir, stFlip_ts,
    sqOn, sqOnPrev, sqRelease, sqRelease_ts, mom, momStd,
    phaseOsc, phaseVelocity, phaseZone,
    compressed,
    atr14, atrRatio,
    volRatio,
    rsi,
    ggUpCross, ggDnCross, ggDist,
    ggUpCross_ts, ggDnCross_ts,
    emaStack,
    emaCross13_48_up, emaCross13_48_dn,
    emaCross13_48_up_ts, emaCross13_48_dn_ts,
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
// WEIGHTED BLENDING (mirrors Pine lines 342-396)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Volatility-adjusted HTF weights (mirrors Pine f_volatility_adjusted_weights).
 */
function volatilityAdjustedHTFWeights(atrRW, atrRD, atrR4, atrR1) {
  const wW_base = 0.50, wD_base = 0.35, w4H_base = 0.10, w1H_base = 0.05;
  let wW = (atrRW > 1.5) ? wW_base * 0.7 : wW_base * 1.2;
  let wD = (atrRD > 1.3) ? wD_base * 1.2 : wD_base * 0.9;
  let w4H = (atrR4 > 1.2) ? w4H_base * 1.3 : w4H_base * 0.8;
  let w1H = (atrR1 > 1.1) ? w1H_base * 1.2 : w1H_base * 0.9;
  const total = wW + wD + w4H + w1H;
  return { wW: wW / total, wD: wD / total, w4H: w4H / total, w1H: w1H / total };
}

/**
 * Session-aware LTF weights (mirrors Pine f_session_adjusted_ltf_weights).
 * @param {boolean} isRTH - whether we're in Regular Trading Hours
 */
function sessionAdjustedLTFWeights(isRTH) {
  const w30_base = 0.60, w10_base = 0.30, w3_base = 0.10;
  if (!isRTH) return { w30: w30_base, w10: w10_base, w3: w3_base };
  let w30 = w30_base * 1.15;
  let w10 = w10_base * 1.0;
  let w3 = w3_base * 0.7;
  const total = w30 + w10 + w3;
  return { w30: w30 / total, w10: w10 / total, w3: w3 / total };
}

/**
 * Compute final HTF score from 4 timeframe bundles.
 * @param {object} wBundle - Weekly bundle
 * @param {object} dBundle - Daily bundle
 * @param {object} h4Bundle - 4H bundle
 * @param {object} h1Bundle - 1H bundle
 * @returns {number} weighted HTF score in [-50, 50]
 */
export function computeWeightedHTFScore(wBundle, dBundle, h4Bundle, h1Bundle) {
  const htfW = computeHTFBundleScore(wBundle);
  const htfD = computeHTFBundleScore(dBundle);
  const htf4H = computeHTFBundleScore(h4Bundle);
  const htf1H = computeHTFBundleScore(h1Bundle);

  const atrRW = wBundle?.atrRatio || 1.0;
  const atrRD = dBundle?.atrRatio || 1.0;
  const atrR4 = h4Bundle?.atrRatio || 1.0;
  const atrR1 = h1Bundle?.atrRatio || 1.0;

  const { wW, wD, w4H, w1H } = volatilityAdjustedHTFWeights(atrRW, atrRD, atrR4, atrR1);

  return clamp(htfW * wW + htfD * wD + htf4H * w4H + htf1H * w1H, -50, 50);
}

/**
 * Compute final LTF score from 3 timeframe bundles.
 * @param {object} m30Bundle - 30m bundle
 * @param {object} m10Bundle - 10m bundle
 * @param {object} m3Bundle - 3m bundle
 * @param {{ ATRd: number }} anchors - daily anchors
 * @param {boolean} isRTH - Regular Trading Hours flag
 * @returns {number} weighted LTF score in [-50, 50]
 */
export function computeWeightedLTFScore(m30Bundle, m10Bundle, m3Bundle, anchors = null, isRTH = true) {
  const ltf30 = computeLTFBundleScore(m30Bundle, anchors);
  const ltf10 = computeLTFBundleScore(m10Bundle, anchors);
  const ltf3 = computeLTFBundleScore(m3Bundle, anchors);

  const { w30, w10, w3 } = sessionAdjustedLTFWeights(isRTH);

  return clamp(ltf30 * w30 + ltf10 * w10 + ltf3 * w3, -50, 50);
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
// FLAG DETECTION (compares current and previous bundles)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Detect event-based flags from bundles across all timeframes.
 * @param {object} bundles - { W, D, "240", "60", "30", "10", "3" } current bundles
 * @returns {object} flags matching the shape expected by qualifiesForEnter / classifyKanbanStage
 */
export function detectFlags(bundles) {
  const flags = {};
  const b30 = bundles?.["30"];
  const b60 = bundles?.["60"];
  const b10 = bundles?.["10"];
  const b3 = bundles?.["3"];

  // SuperTrend flips (with timestamps)
  if (b30?.stFlip) { flags.st_flip_30m = true; flags.st_flip_30m_ts = b30.stFlip_ts; }
  if (b60?.stFlip) { flags.st_flip_1h = true; flags.st_flip_1h_ts = b60.stFlip_ts; }
  if (b10?.stFlip) { flags.st_flip_10m = true; flags.st_flip_10m_ts = b10.stFlip_ts; }
  if (b3?.stFlip) { flags.st_flip_3m = true; flags.st_flip_3m_ts = b3.stFlip_ts; }

  // Bear-side ST flip (timestamp is the most recent bear flip)
  if (b30?.stFlipDir === -1 || b60?.stFlipDir === -1) {
    flags.st_flip_bear = true;
    flags.st_flip_bear_ts = Math.max(
      b30?.stFlipDir === -1 ? (b30.stFlip_ts || 0) : 0,
      b60?.stFlipDir === -1 ? (b60.stFlip_ts || 0) : 0
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

  // Squeeze releases (with timestamps)
  if (b30?.sqRelease) { flags.sq30_release = true; flags.sq30_release_ts = b30.sqRelease_ts; }
  if (b60?.sqRelease) { flags.sq1h_release = true; flags.sq1h_release_ts = b60.sqRelease_ts; }

  // Momentum elite: strong momentum across multiple TFs
  const strongMom = [b30, b10, b3].filter(b => {
    if (!b || !Number.isFinite(b.mom) || !Number.isFinite(b.momStd) || b.momStd <= 0) return false;
    return Math.abs(b.mom / b.momStd) > 1.0;
  });
  if (strongMom.length >= 2) flags.momentum_elite = true;

  // Phase zone change (simplified: check if any LTF is in EXTREME zone)
  if (b30?.phaseZone === "EXTREME" || b10?.phaseZone === "EXTREME") {
    flags.phase_zone_change = true;
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
 * @param {object} bundles - { W, D, "240", "60", "30", "10", "3" }
 * @returns {object} { map, bullCount, bearCount, slopeAligned, supportScore }
 */
export function buildSTSupportMap(bundles) {
  const TF_WEIGHTS = { W: 0.25, D: 0.22, "240": 0.18, "60": 0.14, "30": 0.10, "10": 0.07, "3": 0.04 };
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
// LAYER 3: ATR FIBONACCI LEVEL MAPS (Saty ATR Levels)
// ═══════════════════════════════════════════════════════════════════════════════

const FIB_RATIOS = [0.236, 0.382, 0.500, 0.618, 0.786, 1.000, 1.236, 1.618, 2.000, 2.618, 3.000];

/**
 * Compute Fibonacci-based ATR levels for a given horizon.
 *
 * @param {number} prevClose - previous period close price
 * @param {number} atr - ATR(14) for this horizon's timeframe
 * @param {number} currentPrice - current price for gate detection
 * @param {string} horizonLabel - "day"|"week"|"month"|"quarter"|"longterm"
 * @returns {object} { prevClose, atr, levels_up, levels_dn, gate }
 */
export function computeATRLevels(prevClose, atr, currentPrice, horizonLabel) {
  if (!Number.isFinite(prevClose) || !Number.isFinite(atr) || atr <= 0) {
    return { prevClose: 0, atr: 0, levels_up: [], levels_dn: [], gate: null };
  }

  const levels_up = [];
  const levels_dn = [];
  for (const ratio of FIB_RATIOS) {
    const up = Math.round((prevClose + ratio * atr) * 100) / 100;
    const dn = Math.round((prevClose - ratio * atr) * 100) / 100;
    levels_up.push({ ratio, price: up, label: `+${(ratio * 100).toFixed(1)}%` });
    levels_dn.push({ ratio, price: dn, label: `-${(ratio * 100).toFixed(1)}%` });
  }

  // Golden Gate tracker: 38.2% entry → 61.8% completion
  const gate382_up = prevClose + 0.382 * atr;
  const gate618_up = prevClose + 0.618 * atr;
  const gate382_dn = prevClose - 0.382 * atr;
  const gate618_dn = prevClose - 0.618 * atr;

  let gate = null;
  if (Number.isFinite(currentPrice)) {
    const px = currentPrice;
    // Bull gate: price crossed above 38.2%
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
    }
    // Bear gate: price crossed below -38.2%
    else if (px <= gate382_dn) {
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
  // Map horizons to timeframe bundles
  // Day uses Daily ATR, Week uses Weekly ATR, etc.
  // For Month/Quarter/Longterm we approximate from higher TFs
  const bD = bundles?.D;
  const bW = bundles?.W;

  const maps = {};

  // Day: Daily ATR, previous day close (approximated as daily bundle's px)
  if (bD && Number.isFinite(bD.atr14)) {
    // prevClose: ideally the prior bar close, but we approximate with current daily px
    // since computeTfBundle uses the latest bar. A more precise approach would
    // pass in the second-to-last daily bar explicitly.
    maps.day = computeATRLevels(bD.px, bD.atr14, currentPrice, "day");
  }

  // Week: Weekly ATR
  if (bW && Number.isFinite(bW.atr14)) {
    maps.week = computeATRLevels(bW.px, bW.atr14, currentPrice, "week");
  }

  // Month: approximate as 4.33x Weekly ATR (sqrt(4.33) scaling for ATR)
  if (bW && Number.isFinite(bW.atr14)) {
    const monthlyATR = bW.atr14 * Math.sqrt(4.33);
    maps.month = computeATRLevels(bW.px, monthlyATR, currentPrice, "month");
  }

  // Quarter: approximate as 13x Weekly ATR (sqrt(13) scaling)
  if (bW && Number.isFinite(bW.atr14)) {
    const quarterlyATR = bW.atr14 * Math.sqrt(13);
    maps.quarter = computeATRLevels(bW.px, quarterlyATR, currentPrice, "quarter");
  }

  // Long-term: approximate as 52x Weekly ATR (sqrt(52) scaling)
  if (bW && Number.isFinite(bW.atr14)) {
    const yearlyATR = bW.atr14 * Math.sqrt(52);
    maps.longterm = computeATRLevels(bW.px, yearlyATR, currentPrice, "longterm");
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
  if (!bundle) return { fuelPct: 50, phaseFuel: 50, rsiFuel: 50, status: "healthy" };

  const { phaseOsc, rsi } = bundle;

  // Phase fuel: phase near 0 = full tank, near ±100 = empty
  // Map |phaseOsc| from 0..100+ to fuel 100..0
  const phaseAbs = Math.abs(Number.isFinite(phaseOsc) ? phaseOsc : 0);
  const phaseFuel = Math.max(0, Math.min(100, 100 - phaseAbs));

  // RSI fuel: RSI near 50 = full tank, RSI near 20 or 80 = empty
  // Map distance from 50 (range 0..50) to fuel 100..0
  const rsiVal = Number.isFinite(rsi) ? rsi : 50;
  const rsiDistFromCenter = Math.abs(rsiVal - 50);
  const rsiFuel = Math.max(0, Math.min(100, 100 - (rsiDistFromCenter * 2)));

  // Combined: phase 60%, RSI 40%
  const fuelPct = Math.round(phaseFuel * 0.6 + rsiFuel * 0.4);

  // Status thresholds
  let status;
  if (fuelPct >= 50) status = "healthy";
  else if (fuelPct >= 25) status = "low";
  else status = "critical";

  return {
    fuelPct,
    phaseFuel: Math.round(phaseFuel),
    rsiFuel: Math.round(rsiFuel),
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
 * @returns {object} tickerData payload
 */
export function assembleTickerData(ticker, bundles, existingData = null) {
  const bW = bundles?.W;
  const bD = bundles?.D;
  const b4H = bundles?.["240"];
  const b1H = bundles?.["60"];
  const b30 = bundles?.["30"];
  const b10 = bundles?.["10"];
  const b3 = bundles?.["3"];

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

  // Compute scores
  const htfScore = computeWeightedHTFScore(bW, bD, b4H, b1H);
  const ltfScore = computeWeightedLTFScore(b30, b10, b3, anchors, isRTHNow());
  const state = classifyState(htfScore, ltfScore);

  // Detect flags
  const flags = detectFlags(bundles);

  // Phase from daily
  const phaseOsc = bD?.phaseOsc || 0;
  const phasePct = Math.min(1, Math.abs(phaseOsc) / 100);
  const phaseDir = phaseOsc > 0 ? "bull" : phaseOsc < 0 ? "bear" : "flat";
  const phaseZone = bD?.phaseZone || "LOW";

  // Completion (approximate from 30m price movement since trigger)
  const price = b30?.px || b10?.px || bD?.px || 0;

  // ── NEW: SuperTrend Support Map ──
  const stSupport = buildSTSupportMap(bundles);

  // ── NEW: ATR Fibonacci Level Maps (5 horizons) ──
  const atrLevels = buildATRLevelMaps(bundles, price);

  // ── NEW: Fuel Gauges per key timeframe ──
  const fuel = {
    "30": computeFuelGauge(b30),
    "10": computeFuelGauge(b10),
    "60": computeFuelGauge(b1H),
    D:    computeFuelGauge(bD),
  };

  // ── EMA Triplet Map per key timeframe ──
  const emaMap = {};
  const tfEmaSources = { W: bW, D: bD, "240": b4H, "60": b1H, "30": b30, "10": b10, "3": b3 };
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

  // TP/SL — cascading ATR-based fallback so TP is never null when price + ATR exists
  const ATRw = bW?.atr14 || 0;
  const ATRd = bD?.atr14 || 0;
  const ATR1H = b1H?.atr14 || 0;
  const ATR30 = b30?.atr14 || 0;
  const dir = htfScore >= 0 ? 1 : -1;

  let tp, sl, tp_trim, tp_exit, tp_runner;

  // Priority 1: Daily ATR Fibonacci levels (most precise)
  // FIB_RATIOS = [0.236, 0.382, 0.500, 0.618, 0.786, 1.000, 1.236, 1.618, ...]
  // index:         0       1       2       3       4       5       6       7
  const dayLevels = atrLevels.day;
  if (dayLevels && dayLevels.levels_up?.length >= 8) {
    const levels = dir === 1 ? dayLevels.levels_up : dayLevels.levels_dn;
    tp_trim  = levels[3]?.price || 0; // 61.8% (gate completion) — primary trim target
    tp_exit  = levels[5]?.price || 0; // 100% (1 ATR) — exit target
    tp_runner = levels[7]?.price || 0; // 161.8% — runner target
    tp = tp_trim;
  }

  // Priority 2: Daily ATR simple multiples (if Fib levels failed but ATRd exists)
  if (!tp && ATRd > 0 && Number.isFinite(price) && price > 0) {
    tp_trim  = Math.round((price + dir * 0.618 * ATRd) * 100) / 100;
    tp_exit  = Math.round((price + dir * 1.0   * ATRd) * 100) / 100;
    tp_runner = Math.round((price + dir * 1.618 * ATRd) * 100) / 100;
    tp = tp_trim;
  }

  // Priority 3: Weekly ATR simple multiples (scaled down for daily targets)
  if (!tp && ATRw > 0 && Number.isFinite(price) && price > 0) {
    // Weekly ATR ≈ daily ATR × sqrt(5), so scale back: daily ≈ ATRw / 2.236
    const dailyProxy = ATRw / Math.sqrt(5);
    tp_trim  = Math.round((price + dir * 0.618 * dailyProxy) * 100) / 100;
    tp_exit  = Math.round((price + dir * 1.0   * dailyProxy) * 100) / 100;
    tp_runner = Math.round((price + dir * 1.618 * dailyProxy) * 100) / 100;
    tp = tp_trim;
  }

  // Priority 4: Intraday ATR scaled up (1H or 30m → daily estimate)
  if (!tp && Number.isFinite(price) && price > 0) {
    // Scale intraday ATR to daily: ATRd ≈ ATR_1H × sqrt(6.5) or ATR_30 × sqrt(13)
    const dailyFromIntraday = ATR1H > 0
      ? ATR1H * Math.sqrt(6.5)
      : ATR30 > 0
        ? ATR30 * Math.sqrt(13)
        : 0;
    if (dailyFromIntraday > 0) {
      tp_trim  = Math.round((price + dir * 0.618 * dailyFromIntraday) * 100) / 100;
      tp_exit  = Math.round((price + dir * 1.0   * dailyFromIntraday) * 100) / 100;
      tp_runner = Math.round((price + dir * 1.618 * dailyFromIntraday) * 100) / 100;
      tp = tp_trim;
    }
  }

  // SL: use best available ATR (daily preferred, then scaled weekly/intraday)
  const slATR = ATRd > 0 ? ATRd
    : ATRw > 0 ? ATRw / Math.sqrt(5)
    : ATR1H > 0 ? ATR1H * Math.sqrt(6.5)
    : ATR30 > 0 ? ATR30 * Math.sqrt(13)
    : 0;
  sl = slATR > 0
    ? Math.round((price - dir * 1.5 * slATR) * 100) / 100
    : 0;
  const rr = (tp && sl && Math.abs(price - sl) > 0) ? Math.abs(tp - price) / Math.abs(price - sl) : 0;

  // Build tf_tech for compatibility with existing worker logic
  const tfTech = {};
  const tfMap = { W: bW, D: bD, "4H": b4H, "1H": b1H, "30": b30, "10": b10, "3": b3 };
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

    tfTech[tfLabel] = {
      ema: {
        stack: b.emaStack,
        depth: b.emaDepth || 0,
        structure: Math.round((b.emaStructure || 0) * 1000) / 1000,
        momentum: Math.round((b.emaMomentum || 0) * 1000) / 1000,
      },
      atr: atrBand ? { ...atrBand, ...(atrCross || {}) } : (atrCross || undefined),
      sq: { s: b.sqOn ? 1 : 0, r: b.sqRelease ? 1 : 0, c: b.compressed ? 1 : 0 },
      rsi: { r5: Number.isFinite(b.rsi) ? Math.round(b.rsi * 10) / 10 : undefined },
      ph: {
        v: Number.isFinite(b.phaseOsc) ? Math.round(b.phaseOsc * 10) / 10 : undefined,
        z: b.phaseZone || undefined,
        dots: phaseDotCode ? [phaseDotCode] : [],
      },
      fuel: fuel[tfLabel] || undefined,
    };
  }

  // Merge: keep existing fields that we don't compute (e.g., Ichimoku, daily EMA cloud)
  const base = existingData || {};

  return {
    ...base,
    ticker: ticker.toUpperCase(),
    ts: Date.now(),
    script_version: "alpaca_server_v2.0",
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
    phase_dir: phaseDir,
    phase_zone: phaseZone,
    flags,
    tf_tech: tfTech,
    atr_d: ATRd ? Math.round(ATRd * 100) / 100 : undefined,
    atr_w: ATRw ? Math.round(ATRw * 100) / 100 : undefined,
    // ── NEW precision scoring fields ──
    st_support: stSupport,
    atr_levels: atrLevels,
    fuel,
    ema_map: emaMap,
    active_gates: activeGates.length > 0 ? activeGates : undefined,
    data_source: "alpaca",
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
 * Compute TD Sequential across multiple timeframes (D, W, M) and merge.
 *
 * Priority: Monthly provides long-term context, Weekly is primary signal,
 * Daily is most actionable. Merge logic:
 *   - Daily td9/td13 signals are used directly
 *   - Weekly td9/td13 override Daily (stronger signal)
 *   - Monthly td13 overrides everything (strongest exhaustion signal)
 *   - Boost is summed across timeframes (capped at ±15)
 *   - Counts from the highest-tf active signal are preferred
 *
 * @param {object} candlesByTf - { D: [...candles], W: [...candles], M: [...candles] }
 * @param {boolean} htfBull - Higher-timeframe bullish bias
 * @returns {object} merged td_sequential object
 */
export function computeTDSequentialMultiTF(candlesByTf, htfBull = true) {
  const tfs = ["D", "W", "M"];
  const results = {};
  const perTf = {};

  for (const tf of tfs) {
    const candles = candlesByTf[tf];
    if (candles && candles.length >= 14) {
      results[tf] = computeTDSequential(candles, tf, { htfBull });
      perTf[tf] = results[tf];
    }
  }

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

  // Sum boosts across timeframes, capped at ±15
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
  // else keep Daily counts (already in merged)

  // Attach per-tf breakdown for model and UI transparency
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
  "3": "3Min",
  "10": "10Min",
  "30": "30Min",
  "60": "1Hour",
  "240": "4Hour",
  "D": "1Day",
  "W": "1Week",
  "M": "1Month",
};

// All timeframes we need for scoring (M excluded — used only for TD Sequential)
const ALL_TFS = ["W", "D", "240", "60", "30", "10", "3"];

// TD Sequential timeframes (Daily, Weekly, Monthly)
const TD_SEQ_TFS = ["D", "W", "M"];

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

  do {
    const apiKeyId = env?.ALPACA_API_KEY_ID;
    const apiSecret = env?.ALPACA_API_SECRET_KEY;
    const alpacaTf = TF_TO_ALPACA[tfKey];
    if (!alpacaTf || !apiKeyId || !apiSecret) break;

    const params = new URLSearchParams();
    params.set("symbols", symbols.join(","));
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
      const resp = await fetch(url, {
        headers: {
          "APCA-API-KEY-ID": apiKeyId,
          "APCA-API-SECRET-KEY": apiSecret,
          "Accept": "application/json",
        },
      });
      if (!resp.ok) break;
      const data = await resp.json();
      const bars = data.bars || {};
      for (const [sym, barArr] of Object.entries(bars)) {
        if (!allBars[sym]) allBars[sym] = [];
        allBars[sym].push(...barArr);
      }
      pageToken = data.next_page_token || null;
    } catch {
      break;
    }
    pages++;
  } while (pageToken && pages < maxPages);

  return allBars;
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
 * Fetch latest bars (last 3) for all tickers across all timeframes and store in D1.
 * Designed to run every 1 minute during market hours.
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

  const start = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(); // last 24h
  let totalUpserted = 0;
  let totalErrors = 0;

  // For intraday TFs (3, 10, 30, 60, 240), fetch latest bars
  // For daily/weekly, just fetch latest 3
  for (const tf of ALL_TFS) {
    try {
      const limit = (tf === "W" || tf === "D") ? 3 : 5;
      const result = await alpacaFetchBars(env, allTickers, tf, start, null, limit);
      if (result.error) {
        console.warn(`[ALPACA CRON] TF ${tf} error: ${result.error}`);
        totalErrors++;
        continue;
      }

      for (const [sym, bars] of Object.entries(result.bars)) {
        if (!Array.isArray(bars)) continue;
        for (const bar of bars) {
          const candle = alpacaBarToCandle(bar);
          try {
            await upsertCandle(env, sym, tf, candle);
            totalUpserted++;
          } catch (e) {
            totalErrors++;
          }
        }
      }
    } catch (err) {
      console.error(`[ALPACA CRON] TF ${tf} failed:`, err);
      totalErrors++;
    }
  }

  return { ok: true, upserted: totalUpserted, errors: totalErrors, tickers: allTickers.length };
}

/**
 * Backfill historical bars for all tickers (for EMA200 warm-up).
 * Fetches 300 bars per timeframe per ticker.
 * Should be called once via admin endpoint.
 *
 * @param {object} env
 * @param {string[]} tickers
 * @param {Function} upsertCandle
 * @param {string} tfKey - single timeframe to backfill (or "all")
 * @returns {Promise<object>}
 */
export async function alpacaBackfill(env, tickers, upsertCandle, tfKey = "all") {
  const tfsToBackfill = tfKey === "all" ? ALL_TFS : [tfKey];
  let totalUpserted = 0;
  let totalErrors = 0;

  // Calculate start dates per timeframe for deep history.
  // Intraday TFs use 1000 bars for deeper backtesting coverage.
  // Intraday TFs: market is open ~6.5h/day (390 min), 5 days/week.
  // To get N bars: trading_days = N * bar_minutes / 390, calendar_days = trading_days * 7/5 + 5 (buffer).
  const now = new Date();
  const DAY_MS = 24 * 60 * 60 * 1000;
  const tradingCalDays = (bars, barMinutes) => Math.ceil(bars * barMinutes / 390 * 7 / 5) + 5;
  const startDates = {
    "M": new Date(now.getTime() - 365 * 10 * DAY_MS).toISOString(),                    // ~10 years of monthly bars (~120/ticker)
    "W": new Date(now.getTime() - 300 * 7 * DAY_MS).toISOString(),                     // ~5.8 years
    "D": new Date(now.getTime() - 450 * DAY_MS).toISOString(),                         // ~450 calendar days (~300 trading days)
    "240": new Date(now.getTime() - tradingCalDays(1000, 240) * DAY_MS).toISOString(),  // ~880 calendar days
    "60": new Date(now.getTime() - tradingCalDays(1000, 60) * DAY_MS).toISOString(),    // ~225 calendar days
    "30": new Date(now.getTime() - tradingCalDays(1000, 30) * DAY_MS).toISOString(),    // ~115 calendar days
    "10": new Date(now.getTime() - tradingCalDays(1000, 10) * DAY_MS).toISOString(),    // ~42 calendar days
    "3": new Date(now.getTime() - tradingCalDays(1000, 3) * DAY_MS).toISOString(),      // ~16 calendar days
  };

  // Process in symbol batches; 4H uses smaller batches to avoid Alpaca pagination timeouts
  const getBatchSize = (tf) => tf === "240" ? 15 : 50;

  for (const tf of tfsToBackfill) {
    const start = startDates[tf];
    if (!start) continue;
    const batchSize = getBatchSize(tf);

    for (let i = 0; i < tickers.length; i += batchSize) {
      const batch = tickers.slice(i, i + batchSize);
      try {
        const allBars = await alpacaFetchAllBars(env, batch, tf, start, null, 10000);

        for (const [sym, bars] of Object.entries(allBars)) {
          if (!Array.isArray(bars)) continue;
          for (const bar of bars) {
            const candle = alpacaBarToCandle(bar);
            try {
              await upsertCandle(env, sym, tf, candle);
              totalUpserted++;
            } catch {
              totalErrors++;
            }
          }
        }
      } catch (err) {
        console.error(`[ALPACA BACKFILL] TF ${tf} batch ${i} error:`, err);
        totalErrors++;
      }
    }

    console.log(`[ALPACA BACKFILL] TF ${tf} complete: ${totalUpserted} upserted, ${totalErrors} errors`);
  }

  return { ok: true, upserted: totalUpserted, errors: totalErrors };
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

  // Fetch candles for all 7 scoring timeframes + TD Sequential timeframes in PARALLEL
  // Scoring TFs: W, D, 240, 60, 30, 10, 3
  // TD Sequential TFs: D, W, M (D and W overlap with scoring — M is additional)
  const allTfsToFetch = [...new Set([...ALL_TFS, ...TD_SEQ_TFS])]; // adds "M"
  const tfResults = await Promise.all(
    allTfsToFetch.map(async (tf) => {
      try {
        // For TD Sequential, we need ~50 candles; for scoring we need 300
        const limit = TD_SEQ_TFS.includes(tf) && !ALL_TFS.includes(tf) ? 60 : 300;
        const result = await getCandles(env, ticker, tf, limit);
        return { tf, result };
      } catch (e) {
        console.warn(`[COMPUTE] ${ticker} TF ${tf} error:`, e);
        return { tf, result: null };
      }
    })
  );

  // Separate scoring candles and TD Sequential candles
  const tdSeqCandles = {};

  for (const { tf, result } of tfResults) {
    if (result?.ok && result.candles && result.candles.length > 0) {
      // Deduplicate candles BEFORE any computation (fixes duplicate daily bars
      // from multiple Alpaca backfill runs that store two entries per date)
      const deduped = deduplicateCandles(result.candles, tf);

      // Scoring bundles (need 50+ candles for indicator computation)
      if (ALL_TFS.includes(tf) && deduped.length >= 50) {
        bundles[tf] = computeTfBundle(deduped);
        if (bundles[tf]) hasData = true;
      }
      // TD Sequential candles (need 14+ for minimal computation)
      if (TD_SEQ_TFS.includes(tf) && deduped.length >= 14) {
        tdSeqCandles[tf] = deduped;
      }
    }
  }

  if (!hasData) return null;

  // Map to the key format used by assembleTickerData
  const bundleMap = {
    W: bundles.W || null,
    D: bundles.D || null,
    "240": bundles["240"] || null,
    "60": bundles["60"] || null,
    "30": bundles["30"] || null,
    "10": bundles["10"] || null,
    "3": bundles["3"] || null,
  };

  const tickerData = assembleTickerData(ticker, bundleMap, existingData);
  if (!tickerData) return null;

  // ── Compute TD Sequential (D/W/M) and attach ──
  if (Object.keys(tdSeqCandles).length > 0) {
    const htfBull = (tickerData.htf_score || 0) >= 0;
    const tdSeq = computeTDSequentialMultiTF(tdSeqCandles, htfBull);
    tickerData.td_sequential = tdSeq;
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

  // Fetch candles for the key signal timeframes (30m, 60m, 10m)
  const signalTFs = ["30", "60", "10"];

  for (const tf of signalTFs) {
    try {
      const result = await getCandles(env, ticker, tf, 300);
      if (!result?.ok || !result.candles || result.candles.length < 50) continue;

      const bundle = computeTfBundle(result.candles);
      if (!bundle) continue;

      const tfLabel = tf === "60" ? "1h" : tf === "30" ? "30m" : tf === "10" ? "10m" : tf;

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
