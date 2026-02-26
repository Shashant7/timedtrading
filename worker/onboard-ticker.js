// Three-Tier Market Awareness — Unified Ticker Onboarding Pipeline
//
// Single entry point: onboardTicker(env, ticker, opts)
// Called from: watchlist-add, etfAutoAddTickers, admin/onboard
//
// Pipeline: backfill → compute indicators → harvest moves → fingerprint → calibrate → store → score

import {
  computeTfBundle,
  computeIchimoku,
  computeIchimokuScore,
  atrSeries,
  sma,
  classifyTickerRegime,
  classifyVolatilityTier,
  computeServerSideScores,
  alpacaBackfill,
  deduplicateCandles,
} from "./indicators.js";

import { SECTOR_MAP, SECTOR_ETF_MAP, getSector } from "./sector-mapping.js";

// ─── KV helpers ──────────────────────────────────────────────────────────────

async function kvPutJSON(KV, key, val, opts) {
  if (!KV) return;
  try { await KV.put(key, JSON.stringify(val), opts); } catch { /* best-effort */ }
}

async function kvGetJSON(KV, key) {
  if (!KV) return null;
  try {
    const raw = await KV.get(key, "text");
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

// ─── Progress reporter ──────────────────────────────────────────────────────

async function reportProgress(KV, ticker, step, progress, message, extra = {}) {
  if (!KV) return;
  const payload = { step, progress, message, ticker, ts: Date.now(), ...extra };
  try {
    await KV.put(`timed:onboard:${ticker}`, JSON.stringify(payload), { expirationTtl: 3600 });
  } catch { /* best-effort */ }
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 1: Harvest Moves — detect significant price moves from daily candles
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Scan daily candles for significant directional moves (>1.5 ATR).
 * Returns array of move objects with start/end, direction, magnitude, and
 * indicator snapshots at key lifecycle points.
 */
function harvestMoves(dailyCandles, weeklyCandles = null, opts = {}) {
  const minAtrMult = opts.minAtrMult || 1.5;
  const minBarsForMove = opts.minBarsForMove || 3;
  const maxBarsForMove = opts.maxBarsForMove || 60;

  if (!dailyCandles || dailyCandles.length < 60) return [];

  const closes = dailyCandles.map(b => b.c);
  const atr = atrSeries(dailyCandles, 14);
  const moves = [];

  // Sliding window approach: look for runs where price moves >minAtrMult * ATR
  let i = 20; // skip initial ATR warmup
  while (i < dailyCandles.length - 1) {
    const startPrice = dailyCandles[i].c;
    const startATR = atr[i] || atr[atr.length - 1];
    if (!startATR || startATR <= 0) { i++; continue; }

    let peakIdx = i, troughIdx = i;
    let peakPrice = startPrice, troughPrice = startPrice;
    let j = i + 1;

    // Extend the move forward
    while (j < dailyCandles.length && j - i < maxBarsForMove) {
      const c = dailyCandles[j].c;
      if (c > peakPrice) { peakPrice = c; peakIdx = j; }
      if (c < troughPrice) { troughPrice = c; troughIdx = j; }

      // Check if we've pulled back enough to end the move
      const moveUp = peakPrice - startPrice;
      const moveDn = startPrice - troughPrice;
      const currentATR = atr[j] || startATR;

      // Bullish move: price went up significantly, then pulled back >40%
      if (moveUp > minAtrMult * startATR && peakIdx < j) {
        const pullback = peakPrice - dailyCandles[j].c;
        if (pullback > moveUp * 0.4 || j - peakIdx > 5) {
          if (peakIdx - i >= minBarsForMove) {
            moves.push(buildMove(dailyCandles, atr, i, peakIdx, j, "LONG", weeklyCandles));
          }
          i = peakIdx;
          break;
        }
      }

      // Bearish move: price went down significantly, then bounced >40%
      if (moveDn > minAtrMult * startATR && troughIdx < j) {
        const bounce = dailyCandles[j].c - troughPrice;
        if (bounce > moveDn * 0.4 || j - troughIdx > 5) {
          if (troughIdx - i >= minBarsForMove) {
            moves.push(buildMove(dailyCandles, atr, i, troughIdx, j, "SHORT", weeklyCandles));
          }
          i = troughIdx;
          break;
        }
      }
      j++;
    }

    if (j >= dailyCandles.length || j - i >= maxBarsForMove) i++;
    else i++;
  }

  return moves;
}

function buildMove(candles, atr, startIdx, peakIdx, endIdx, direction, weeklyCandles) {
  const startBar = candles[startIdx];
  const peakBar = candles[peakIdx];
  const endBar = candles[endIdx];
  const startATR = atr[startIdx] || 1;
  const magnitude = Math.abs(peakBar.c - startBar.c) / startATR;

  // Compute indicator snapshots at key points (5 bars before start, at start, at peak)
  const preStartIdx = Math.max(0, startIdx - 50);
  const preMoveBars = candles.slice(preStartIdx, startIdx + 1);
  const atPeakBars = candles.slice(Math.max(0, peakIdx - 50), peakIdx + 1);

  const preMoveBundle = preMoveBars.length >= 50 ? computeTfBundle(preMoveBars) : null;
  const atPeakBundle = atPeakBars.length >= 50 ? computeTfBundle(atPeakBars) : null;

  // Volume analysis during the move
  const moveBars = candles.slice(startIdx, peakIdx + 1);
  const moveVols = moveBars.map(b => b.v || 0).filter(v => v > 0);
  const preVols = candles.slice(Math.max(0, startIdx - 20), startIdx).map(b => b.v || 0).filter(v => v > 0);
  const avgMoveVol = moveVols.length ? moveVols.reduce((s, v) => s + v, 0) / moveVols.length : 0;
  const avgPreVol = preVols.length ? preVols.reduce((s, v) => s + v, 0) / preVols.length : 1;
  const volExpansion = avgPreVol > 0 ? avgMoveVol / avgPreVol : 1;

  return {
    direction,
    startTs: startBar.ts,
    peakTs: peakBar.ts,
    endTs: endBar.ts,
    startPrice: startBar.c,
    peakPrice: peakBar.c,
    endPrice: endBar.c,
    magnitude: Math.round(magnitude * 100) / 100,
    durationBars: peakIdx - startIdx,
    durationDays: Math.round((peakBar.ts - startBar.ts) / 86400000),
    atrAtStart: Math.round(startATR * 100) / 100,
    volExpansion: Math.round(volExpansion * 100) / 100,
    preMove: preMoveBundle ? snapshotBundle(preMoveBundle) : null,
    atPeak: atPeakBundle ? snapshotBundle(atPeakBundle) : null,
  };
}

function snapshotBundle(b) {
  if (!b) return null;
  return {
    emaStructure: r4(b.emaStructure),
    emaDepth: b.emaDepth,
    emaMomentum: r4(b.emaMomentum),
    rsi14: r2(b.rsi14),
    sqOn: !!b.sqOn,
    sqMom: r4(b.sqMom),
    stDir: b.stDir,
    stBarsSinceFlip: b.stBarsSinceFlip,
    volRatio: r2(b.volRatio),
    rvol5: r2(b.rvol5),
    ichimoku: b.ichimoku ? {
      priceVsCloud: b.ichimoku.priceVsCloud,
      tkBull: b.ichimoku.tkBull,
      cloudBullish: b.ichimoku.cloudBullish,
      cloudThickness: r2(b.ichimoku.cloudThickness),
      kijunSlope: r4(b.ichimoku.kijunSlope),
      tkSpread: r4(b.ichimoku.tkSpread),
    } : null,
  };
}

function r2(v) { return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0; }
function r4(v) { return Number.isFinite(v) ? Math.round(v * 10000) / 10000 : 0; }

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 2: Fingerprint — compute behavioral profile from candles + moves
// ═══════════════════════════════════════════════════════════════════════════════

function computeFingerprint(dailyCandles, moves, ticker) {
  const sector = getSector(ticker) || "Unknown";
  const closes = dailyCandles.map(b => b.c);
  const atr = atrSeries(dailyCandles, 14);

  // --- Volatility Profile ---
  const price = closes[closes.length - 1] || 1;
  const atrPcts = atr.filter(a => a > 0).map((a, i) => {
    const p = closes[i + 13] || price; // ATR lags by period
    return p > 0 ? (a / p) * 100 : 0;
  }).filter(v => v > 0);
  atrPcts.sort((a, b) => a - b);

  const atrPctP50 = percentile(atrPcts, 50);
  const atrPctP90 = percentile(atrPcts, 90);

  // Daily range as % of price
  const ranges = dailyCandles.map(b => b.h > 0 && b.l > 0 ? ((b.h - b.l) / b.c) * 100 : 0).filter(v => v > 0);
  const dailyRangePct = ranges.length ? ranges.reduce((s, v) => s + v, 0) / ranges.length : 0;

  // Gap frequency: how often does the open gap >0.5% from prior close?
  let gapCount = 0;
  for (let i = 1; i < dailyCandles.length; i++) {
    const prevC = dailyCandles[i - 1].c;
    const curO = dailyCandles[i].o;
    if (prevC > 0 && Math.abs(curO - prevC) / prevC > 0.005) gapCount++;
  }
  const gapFrequency = dailyCandles.length > 1 ? gapCount / (dailyCandles.length - 1) : 0;

  // --- Behavior Type ---
  // Measure trend persistence: autocorrelation of daily returns
  const returns = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0) returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }

  let acSum = 0, acCount = 0;
  const retMean = returns.reduce((s, r) => s + r, 0) / (returns.length || 1);
  const retVar = returns.reduce((s, r) => s + (r - retMean) ** 2, 0) / (returns.length || 1);
  if (retVar > 0) {
    for (let i = 1; i < returns.length; i++) {
      acSum += (returns[i] - retMean) * (returns[i - 1] - retMean);
      acCount++;
    }
  }
  const autocorrelation = acCount > 0 && retVar > 0 ? acSum / (acCount * retVar) : 0;

  // Positive autocorrelation = momentum, negative = mean-reversion
  const trendPersistence = Math.max(0, Math.min(1, 0.5 + autocorrelation * 2));
  let behaviorType = "MIXED";
  if (autocorrelation > 0.08) behaviorType = "MOMENTUM";
  else if (autocorrelation < -0.08) behaviorType = "MEAN_REVERT";

  // Mean reversion speed: avg bars from local peak/trough to cross back through mean
  const sma20 = [];
  for (let i = 0; i < closes.length; i++) {
    const slice = closes.slice(Math.max(0, i - 19), i + 1);
    sma20.push(slice.reduce((s, v) => s + v, 0) / slice.length);
  }
  let revBars = [], inDeviation = false, devStart = 0;
  for (let i = 1; i < closes.length; i++) {
    const aboveMean = closes[i] > sma20[i];
    const prevAbove = closes[i - 1] > sma20[i - 1];
    if (aboveMean !== prevAbove) {
      if (inDeviation) { revBars.push(i - devStart); }
      inDeviation = true;
      devStart = i;
    }
  }
  const meanReversionSpeed = revBars.length ? revBars.reduce((s, v) => s + v, 0) / revBars.length : 10;

  // --- Move Profile ---
  const longMoves = moves.filter(m => m.direction === "LONG");
  const shortMoves = moves.filter(m => m.direction === "SHORT");
  const allMagnitudes = moves.map(m => m.magnitude);
  const allDurations = moves.map(m => m.durationBars);
  const allDurationDays = moves.map(m => m.durationDays);

  const avgMoveAtr = allMagnitudes.length ? allMagnitudes.reduce((s, v) => s + v, 0) / allMagnitudes.length : 0;
  const avgMoveDurationBars = allDurations.length ? allDurations.reduce((s, v) => s + v, 0) / allDurations.length : 0;
  const avgMoveDurationDays = allDurationDays.length ? allDurationDays.reduce((s, v) => s + v, 0) / allDurationDays.length : 0;

  // --- Volume Profile ---
  const volumes = dailyCandles.map(b => b.v || 0).filter(v => v > 0);
  const volSma20 = volumes.length >= 20 ? volumes.slice(-20).reduce((s, v) => s + v, 0) / 20 : (volumes.reduce((s, v) => s + v, 0) / (volumes.length || 1));
  const rvolBaseline = volSma20;
  const volRatios = volumes.map((v, i) => {
    const start = Math.max(0, i - 19);
    const window = volumes.slice(start, i + 1);
    const wAvg = window.reduce((s, x) => s + x, 0) / window.length;
    return wAvg > 0 ? v / wAvg : 1;
  });
  volRatios.sort((a, b) => a - b);
  const rvolSpikeThreshold = percentile(volRatios, 90);

  // Morning vs afternoon volume pattern (rough heuristic from daily bars — limited info)
  const volumePattern = "daily_only"; // can't determine intraday pattern from D candles

  // --- Indicator Responsiveness ---
  // Check how often signals preceded successful moves
  let ichHitCount = 0, ichCheckCount = 0;
  let stHitCount = 0, stCheckCount = 0;
  let emaHitCount = 0, emaCheckCount = 0;

  for (const move of moves) {
    const snap = move.preMove;
    if (!snap) continue;

    const isLong = move.direction === "LONG";

    // Ichimoku: was TK cross aligned before the move?
    if (snap.ichimoku) {
      ichCheckCount++;
      const tkAligned = isLong ? snap.ichimoku.tkBull : !snap.ichimoku.tkBull;
      const cloudAligned = isLong ? snap.ichimoku.priceVsCloud === "above" : snap.ichimoku.priceVsCloud === "below";
      if (tkAligned || cloudAligned) ichHitCount++;
    }

    // SuperTrend: was it aligned?
    stCheckCount++;
    const stAligned = isLong ? snap.stDir === 1 : snap.stDir === -1;
    if (stAligned) stHitCount++;

    // EMA structure: was it fanned in the right direction?
    emaCheckCount++;
    const emaAligned = isLong ? snap.emaStructure > 0.2 : snap.emaStructure < -0.2;
    if (emaAligned) emaHitCount++;
  }

  const ichimokuResponsiveness = ichCheckCount > 2 ? ichHitCount / ichCheckCount : 0.5;
  const supertrendFlipAccuracy = stCheckCount > 2 ? stHitCount / stCheckCount : 0.5;
  const emaCrossAccuracy = emaCheckCount > 2 ? emaHitCount / emaCheckCount : 0.5;

  return {
    ticker,
    sector,
    atrPctP50: r2(atrPctP50),
    atrPctP90: r2(atrPctP90),
    dailyRangePct: r2(dailyRangePct),
    gapFrequency: r2(gapFrequency),
    behaviorType,
    trendPersistence: r2(trendPersistence),
    meanReversionSpeed: Math.round(meanReversionSpeed),
    avgMoveAtr: r2(avgMoveAtr),
    avgMoveDurationBars: Math.round(avgMoveDurationBars),
    avgMoveDurationDays: Math.round(avgMoveDurationDays),
    moveCount2yr: moves.length,
    rvolBaseline: Math.round(rvolBaseline),
    rvolSpikeThreshold: r2(rvolSpikeThreshold),
    volumePattern,
    ichimokuResponsiveness: r2(ichimokuResponsiveness),
    supertrendFlipAccuracy: r2(supertrendFlipAccuracy),
    emaCrossAccuracy: r2(emaCrossAccuracy),
    longMoveCount: longMoves.length,
    shortMoveCount: shortMoves.length,
    avgVolExpansion: r2(moves.length ? moves.reduce((s, m) => s + m.volExpansion, 0) / moves.length : 1),
  };
}

function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 3: Calibrate — derive ticker-specific weights from fingerprint + moves
// ═══════════════════════════════════════════════════════════════════════════════

function calibrateTicker(fingerprint, moves) {
  const fp = fingerprint;

  // --- TF Weights ---
  // Base: 1H=0.50, 30m=0.30, 10m=0.20 (LTF), D=0.40, W=0.25, 4H=0.20, M=0.15 (HTF)
  const tfWeights = {
    htf: { M: 0.15, W: 0.25, D: 0.40, "240": 0.20 },
    ltf: { "60": 0.50, "30": 0.30, "10": 0.20 },
  };

  // Momentum tickers: boost longer TFs (trends persist, shorter TFs whipsaw)
  if (fp.behaviorType === "MOMENTUM") {
    tfWeights.htf.D += 0.05;
    tfWeights.htf.W += 0.03;
    tfWeights.htf["240"] -= 0.03;
    tfWeights.htf.M -= 0.02;
    // Slow down LTF (less reactive)
    tfWeights.ltf["60"] += 0.05;
    tfWeights.ltf["30"] -= 0.02;
    tfWeights.ltf["10"] -= 0.03;
  }

  // Mean-revert tickers: boost shorter TFs (catch reversals early)
  if (fp.behaviorType === "MEAN_REVERT") {
    tfWeights.ltf["10"] += 0.05;
    tfWeights.ltf["30"] += 0.03;
    tfWeights.ltf["60"] -= 0.05;
    tfWeights.htf["240"] += 0.03;
    tfWeights.htf.D -= 0.03;
  }

  // Normalize each group
  normalizeWeights(tfWeights.htf);
  normalizeWeights(tfWeights.ltf);

  // --- Signal Weights ---
  // Base weights, adjusted by indicator responsiveness
  const signalWeights = {
    ichimoku: 1.0,
    supertrend: 1.0,
    ema_cross: 1.0,
    ema_structure: 1.0,
    rsi: 1.0,
    squeeze: 1.0,
    rvol: 1.0,
  };

  // Boost signals that historically preceded this ticker's moves
  if (fp.ichimokuResponsiveness > 0.65) signalWeights.ichimoku = 1.3;
  else if (fp.ichimokuResponsiveness < 0.35) signalWeights.ichimoku = 0.7;

  if (fp.supertrendFlipAccuracy > 0.65) signalWeights.supertrend = 1.3;
  else if (fp.supertrendFlipAccuracy < 0.35) signalWeights.supertrend = 0.7;

  if (fp.emaCrossAccuracy > 0.65) {
    signalWeights.ema_cross = 1.3;
    signalWeights.ema_structure = 1.2;
  } else if (fp.emaCrossAccuracy < 0.35) {
    signalWeights.ema_cross = 0.7;
    signalWeights.ema_structure = 0.8;
  }

  // High-vol tickers: RVOL less discriminating (always volatile)
  if (fp.atrPctP50 > 4.0) signalWeights.rvol = 0.8;
  // Low-vol tickers: RVOL spikes are very meaningful
  if (fp.atrPctP50 < 1.5) signalWeights.rvol = 1.3;

  // --- SL/TP Multipliers ---
  // High-vol tickers need wider stops; low-vol need tighter
  let slMult = 1.0, tpMult = 1.0;

  if (fp.atrPctP50 > 4.0) { slMult = 1.4; tpMult = 1.3; }
  else if (fp.atrPctP50 > 3.0) { slMult = 1.2; tpMult = 1.15; }
  else if (fp.atrPctP50 < 1.5) { slMult = 0.8; tpMult = 0.85; }

  // Momentum tickers: wider TP (rides run), tighter SL (trend should hold)
  if (fp.behaviorType === "MOMENTUM") { tpMult *= 1.15; slMult *= 0.9; }
  // Mean-revert: tighter TP (takes profits early), wider SL (gives room)
  if (fp.behaviorType === "MEAN_REVERT") { tpMult *= 0.85; slMult *= 1.1; }

  // Scale TP by observed move magnitude
  if (fp.avgMoveAtr > 3.0) tpMult *= 1.1;
  else if (fp.avgMoveAtr < 1.5 && fp.avgMoveAtr > 0) tpMult *= 0.9;

  // --- Entry Threshold Adjustment ---
  // Mean-revert tickers: higher bar (be more selective)
  let entryThresholdAdj = 0;
  if (fp.behaviorType === "MEAN_REVERT") entryThresholdAdj = 5;
  if (fp.atrPctP50 > 5.0) entryThresholdAdj += 5; // extreme vol = extra selective

  // Determine best timeframes from move analysis
  const bestTimeframes = determineBestTimeframes(moves);

  return {
    tfWeights,
    signalWeights,
    slMult: r2(slMult),
    tpMult: r2(tpMult),
    entryThresholdAdj: Math.round(entryThresholdAdj),
    bestTimeframes,
  };
}

function normalizeWeights(obj) {
  const total = Object.values(obj).reduce((s, v) => s + v, 0);
  if (total <= 0) return;
  for (const k of Object.keys(obj)) {
    obj[k] = Math.round((obj[k] / total) * 1000) / 1000;
  }
}

function determineBestTimeframes(moves) {
  // Rank TFs by how often pre-move signals were aligned
  const tfScores = { "10": 0, "30": 0, "60": 0, "240": 0, D: 0, W: 0 };
  let counted = 0;

  for (const move of moves) {
    const snap = move.preMove;
    if (!snap) continue;
    counted++;

    // Strong EMA structure = good TF signal
    if (Math.abs(snap.emaStructure || 0) > 0.5) {
      tfScores.D += 1;
      tfScores["240"] += 0.5;
    }
    // SuperTrend aligned
    if (snap.stDir !== 0) {
      tfScores["60"] += 0.5;
      tfScores["30"] += 0.3;
    }
    // Ichimoku aligned
    if (snap.ichimoku?.tkBull != null) {
      tfScores.D += 0.8;
      tfScores.W += 0.5;
    }
  }

  if (counted === 0) return ["D", "60", "30"];

  return Object.entries(tfScores)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([tf]) => tf);
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 4: Update Sector Profile — aggregate from member tickers
// ═══════════════════════════════════════════════════════════════════════════════

async function updateSectorProfile(env, sector) {
  const db = env?.DB;
  const KV = env?.KV_TIMED;
  if (!db || !sector) return;

  try {
    const { results } = await db.prepare(
      `SELECT ticker, atr_pct_p50, behavior_type, sl_mult, tp_mult,
              tf_weights_json, signal_weights_json
       FROM ticker_profiles WHERE sector = ?1`
    ).bind(sector).all();

    if (!results || results.length === 0) return;

    const atrPcts = results.map(r => r.atr_pct_p50).filter(v => v > 0);
    const avgAtrPct = atrPcts.length ? atrPcts.reduce((s, v) => s + v, 0) / atrPcts.length : 0;

    // Dominant behavior type
    const typeCounts = {};
    for (const r of results) {
      const t = r.behavior_type || "MIXED";
      typeCounts[t] = (typeCounts[t] || 0) + 1;
    }
    const dominantType = Object.entries(typeCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || "MIXED";

    // Average SL/TP multipliers
    const slMults = results.map(r => r.sl_mult || 1).filter(v => v > 0);
    const tpMults = results.map(r => r.tp_mult || 1).filter(v => v > 0);
    const avgSlMult = slMults.length ? slMults.reduce((s, v) => s + v, 0) / slMults.length : 1;
    const avgTpMult = tpMults.length ? tpMults.reduce((s, v) => s + v, 0) / tpMults.length : 1;

    const etfTicker = SECTOR_ETF_MAP[sector] || null;
    const now = Date.now();

    await db.prepare(
      `INSERT INTO sector_profiles (sector, etf_ticker, avg_atr_pct, dominant_behavior_type,
         sl_mult_adj, tp_mult_adj, ticker_count, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT(sector) DO UPDATE SET
         etf_ticker=excluded.etf_ticker, avg_atr_pct=excluded.avg_atr_pct,
         dominant_behavior_type=excluded.dominant_behavior_type,
         sl_mult_adj=excluded.sl_mult_adj, tp_mult_adj=excluded.tp_mult_adj,
         ticker_count=excluded.ticker_count, updated_at=excluded.updated_at`
    ).bind(sector, etfTicker, r2(avgAtrPct), dominantType, r2(avgSlMult), r2(avgTpMult), results.length, now).run();

    // Cache in KV
    await kvPutJSON(KV, `timed:sector-profile:${sector}`, {
      sector, etfTicker, avgAtrPct: r2(avgAtrPct), dominantType,
      slMultAdj: r2(avgSlMult), tpMultAdj: r2(avgTpMult),
      tickerCount: results.length, updatedAt: now,
    }, { expirationTtl: 86400 });

  } catch (e) {
    console.error(`[SECTOR PROFILE] ${sector} update failed:`, String(e).slice(0, 200));
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN: onboardTicker — unified pipeline
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Full onboarding pipeline for a single ticker.
 *
 * @param {object} env - Cloudflare Worker env (DB, KV_TIMED, ALPACA_*)
 * @param {string} ticker - Uppercase ticker symbol
 * @param {object} opts - { ctx, getCandles, skipBackfill, sinceDays }
 * @returns {object} { ok, profile, scored }
 */
export async function onboardTicker(env, ticker, opts = {}) {
  const KV = env?.KV_TIMED;
  const db = env?.DB;
  const sym = String(ticker).toUpperCase().trim();
  if (!sym || !db) return { ok: false, error: "missing_ticker_or_db" };

  const getCandles = opts.getCandles || null;
  const sinceDays = opts.sinceDays || 730; // 2 years default

  console.log(`[ONBOARD] Starting pipeline for ${sym}`);

  // Ensure ticker_profiles + sector_profiles tables exist (run sequentially, not batched)
  try {
    await db.prepare(`CREATE TABLE IF NOT EXISTS ticker_profiles (
      ticker TEXT PRIMARY KEY, sector TEXT,
      atr_pct_p50 REAL, atr_pct_p90 REAL, daily_range_pct REAL, gap_frequency REAL,
      behavior_type TEXT, trend_persistence REAL, mean_reversion_speed REAL,
      avg_move_atr REAL, avg_move_duration_bars REAL, avg_move_duration_days REAL, move_count_2yr INTEGER,
      rvol_baseline REAL, rvol_spike_threshold REAL, volume_pattern TEXT,
      best_timeframes_json TEXT, ichimoku_responsiveness REAL, supertrend_flip_accuracy REAL, ema_cross_accuracy REAL,
      tf_weights_json TEXT, signal_weights_json TEXT, sl_mult REAL DEFAULT 1.0, tp_mult REAL DEFAULT 1.0,
      entry_threshold_adj REAL DEFAULT 0,
      sample_count INTEGER, calibrated_at INTEGER, calibration_version INTEGER DEFAULT 1
    )`).run();
  } catch (e) { console.warn("[ONBOARD] ticker_profiles DDL:", String(e).slice(0, 200)); }
  try {
    await db.prepare(`CREATE TABLE IF NOT EXISTS sector_profiles (
      sector TEXT PRIMARY KEY,
      ticker_count INTEGER, avg_atr_pct REAL, dominant_behavior_type TEXT,
      sl_mult_adj REAL DEFAULT 1.0, tp_mult_adj REAL DEFAULT 1.0,
      sector_etf TEXT, avg_trend_persistence REAL, avg_ichimoku_resp REAL,
      updated_at INTEGER
    )`).run();
  } catch (e) { console.warn("[ONBOARD] sector_profiles DDL:", String(e).slice(0, 200)); }

  try {
    // ── Step 1: Deep Backfill ──
    await reportProgress(KV, sym, "backfill", 0.1, "Fetching historical candle data...");

    if (!opts.skipBackfill) {
      try {
        const backfillResult = await alpacaBackfill(env, [sym], null, "all", sinceDays);
        console.log(`[ONBOARD] ${sym} backfill: ${JSON.stringify(backfillResult?.perTfStats || {})}`);
      } catch (e) {
        console.warn(`[ONBOARD] ${sym} backfill error (continuing):`, String(e).slice(0, 200));
      }
    }

    await reportProgress(KV, sym, "indicators", 0.3, "Computing indicators...");

    // ── Step 2: Load candles for analysis ──
    const d1GetCandles = async (_env, _ticker, tf, limit) => {
      if (getCandles) return getCandles(_env, _ticker, tf, limit);
      // Direct D1 query fallback
      const rows = await db.prepare(
        `SELECT ts, o, h, l, c, v FROM ticker_candles
         WHERE ticker = ?1 AND tf = ?2 ORDER BY ts DESC LIMIT ?3`
      ).bind(_ticker, tf, limit || 600).all();
      const candles = (rows?.results || [])
        .map(r => ({ ts: Number(r.ts), o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c), v: r.v != null ? Number(r.v) : null }))
        .filter(x => Number.isFinite(x.ts) && Number.isFinite(x.o))
        .sort((a, b) => a.ts - b.ts);
      return { ok: true, ticker: _ticker, tf, candles };
    };

    // Fetch daily and weekly candles for move harvesting
    const [dailyRes, weeklyRes] = await Promise.all([
      d1GetCandles(env, sym, "D", 600),
      d1GetCandles(env, sym, "W", 200),
    ]);

    const dailyCandles = dailyRes?.candles || [];
    const weeklyCandles = weeklyRes?.candles || [];

    if (dailyCandles.length < 60) {
      await reportProgress(KV, sym, "error", 0, `Insufficient data: ${dailyCandles.length} daily candles`);
      return { ok: false, error: "insufficient_data", dailyCount: dailyCandles.length };
    }

    // ── Step 3: Harvest Moves ──
    await reportProgress(KV, sym, "harvest", 0.5, "Analyzing significant price moves...");
    const moves = harvestMoves(dailyCandles, weeklyCandles);
    console.log(`[ONBOARD] ${sym}: harvested ${moves.length} significant moves`);

    // ── Step 4: Fingerprint ──
    await reportProgress(KV, sym, "fingerprint", 0.65, `Computing behavioral profile from ${moves.length} moves...`);
    const fingerprint = computeFingerprint(dailyCandles, moves, sym);
    console.log(`[ONBOARD] ${sym}: ${fingerprint.behaviorType}, ATR%=${fingerprint.atrPctP50}, moves=${fingerprint.moveCount2yr}`);

    // ── Step 5: Calibrate ──
    await reportProgress(KV, sym, "calibrate", 0.8, "Deriving ticker-specific weights...");
    const calibration = calibrateTicker(fingerprint, moves);

    // ── Step 6: Store Profile ──
    await reportProgress(KV, sym, "store", 0.9, "Saving ticker profile...");
    const now = Date.now();
    const profile = {
      ...fingerprint,
      ...calibration,
      calibratedAt: now,
      calibrationVersion: 1,
    };

    await db.prepare(
      `INSERT INTO ticker_profiles (
         ticker, sector, atr_pct_p50, atr_pct_p90, daily_range_pct, gap_frequency,
         behavior_type, trend_persistence, mean_reversion_speed,
         avg_move_atr, avg_move_duration_bars, avg_move_duration_days, move_count_2yr,
         rvol_baseline, rvol_spike_threshold, volume_pattern,
         best_timeframes_json, ichimoku_responsiveness, supertrend_flip_accuracy, ema_cross_accuracy,
         tf_weights_json, signal_weights_json, sl_mult, tp_mult, entry_threshold_adj,
         sample_count, calibrated_at, calibration_version
       ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26,?27,?28)
       ON CONFLICT(ticker) DO UPDATE SET
         sector=excluded.sector, atr_pct_p50=excluded.atr_pct_p50, atr_pct_p90=excluded.atr_pct_p90,
         daily_range_pct=excluded.daily_range_pct, gap_frequency=excluded.gap_frequency,
         behavior_type=excluded.behavior_type, trend_persistence=excluded.trend_persistence,
         mean_reversion_speed=excluded.mean_reversion_speed,
         avg_move_atr=excluded.avg_move_atr, avg_move_duration_bars=excluded.avg_move_duration_bars,
         avg_move_duration_days=excluded.avg_move_duration_days, move_count_2yr=excluded.move_count_2yr,
         rvol_baseline=excluded.rvol_baseline, rvol_spike_threshold=excluded.rvol_spike_threshold,
         volume_pattern=excluded.volume_pattern,
         best_timeframes_json=excluded.best_timeframes_json,
         ichimoku_responsiveness=excluded.ichimoku_responsiveness,
         supertrend_flip_accuracy=excluded.supertrend_flip_accuracy,
         ema_cross_accuracy=excluded.ema_cross_accuracy,
         tf_weights_json=excluded.tf_weights_json, signal_weights_json=excluded.signal_weights_json,
         sl_mult=excluded.sl_mult, tp_mult=excluded.tp_mult,
         entry_threshold_adj=excluded.entry_threshold_adj,
         sample_count=excluded.sample_count, calibrated_at=excluded.calibrated_at,
         calibration_version=excluded.calibration_version`
    ).bind(
      sym, fingerprint.sector,
      fingerprint.atrPctP50, fingerprint.atrPctP90, fingerprint.dailyRangePct, fingerprint.gapFrequency,
      fingerprint.behaviorType, fingerprint.trendPersistence, fingerprint.meanReversionSpeed,
      fingerprint.avgMoveAtr, fingerprint.avgMoveDurationBars, fingerprint.avgMoveDurationDays, fingerprint.moveCount2yr,
      fingerprint.rvolBaseline, fingerprint.rvolSpikeThreshold, fingerprint.volumePattern,
      JSON.stringify(calibration.bestTimeframes),
      fingerprint.ichimokuResponsiveness, fingerprint.supertrendFlipAccuracy, fingerprint.emaCrossAccuracy,
      JSON.stringify(calibration.tfWeights), JSON.stringify(calibration.signalWeights),
      calibration.slMult, calibration.tpMult, calibration.entryThresholdAdj,
      dailyCandles.length, now, 1
    ).run();

    // Cache in KV for fast reads during scoring
    await kvPutJSON(KV, `timed:profile:${sym}`, profile, { expirationTtl: 86400 * 7 });

    // ── Step 7: Update Sector Profile ──
    const sector = fingerprint.sector;
    if (sector && sector !== "Unknown") {
      await updateSectorProfile(env, sector);
    }

    // ── Step 8: Initial Scoring ──
    await reportProgress(KV, sym, "scoring", 0.95, "Running initial scoring...");

    let scored = null;
    try {
      const existing = await kvGetJSON(KV, `timed:latest:${sym}`);
      const withProfile = {
        ...(existing || {}),
        _tickerProfile: profile,
      };
      scored = await computeServerSideScores(sym, d1GetCandles, env, withProfile);
      if (scored) {
        scored._tickerProfile = { behaviorType: fingerprint.behaviorType, slMult: calibration.slMult, tpMult: calibration.tpMult };
        await kvPutJSON(KV, `timed:latest:${sym}`, scored);
        console.log(`[ONBOARD] ${sym}: scored, state=${scored.state}, price=${scored.price}`);
      }
    } catch (e) {
      console.warn(`[ONBOARD] ${sym} scoring error:`, String(e).slice(0, 200));
    }

    // ── Done ──
    await reportProgress(KV, sym, "complete", 1.0, "Ready", {
      profile: {
        behaviorType: fingerprint.behaviorType,
        atrPctP50: fingerprint.atrPctP50,
        moveCount: fingerprint.moveCount2yr,
        slMult: calibration.slMult,
        tpMult: calibration.tpMult,
      },
    });

    console.log(`[ONBOARD] ${sym} complete: ${fingerprint.behaviorType}, ${moves.length} moves, sl=${calibration.slMult}x tp=${calibration.tpMult}x`);

    return { ok: true, profile, scored: !!scored, moveCount: moves.length };

  } catch (e) {
    console.error(`[ONBOARD] ${sym} pipeline error:`, String(e).slice(0, 300));
    await reportProgress(KV, sym, "error", 0, String(e).slice(0, 200));
    return { ok: false, error: String(e).slice(0, 200) };
  }
}

/**
 * Load a ticker's profile from KV (fast) or D1 (fallback).
 */
export async function loadTickerProfile(env, ticker) {
  const KV = env?.KV_TIMED;
  const db = env?.DB;
  const sym = String(ticker).toUpperCase();

  // KV fast path
  const cached = await kvGetJSON(KV, `timed:profile:${sym}`);
  if (cached) return cached;

  // D1 fallback
  if (!db) return null;
  try {
    const row = await db.prepare(
      `SELECT * FROM ticker_profiles WHERE ticker = ?1`
    ).bind(sym).first();
    if (!row) return null;

    const profile = {
      ticker: row.ticker,
      sector: row.sector,
      behaviorType: row.behavior_type,
      atrPctP50: row.atr_pct_p50,
      atrPctP90: row.atr_pct_p90,
      dailyRangePct: row.daily_range_pct,
      gapFrequency: row.gap_frequency,
      trendPersistence: row.trend_persistence,
      meanReversionSpeed: row.mean_reversion_speed,
      avgMoveAtr: row.avg_move_atr,
      avgMoveDurationBars: row.avg_move_duration_bars,
      avgMoveDurationDays: row.avg_move_duration_days,
      moveCount2yr: row.move_count_2yr,
      ichimokuResponsiveness: row.ichimoku_responsiveness,
      supertrendFlipAccuracy: row.supertrend_flip_accuracy,
      emaCrossAccuracy: row.ema_cross_accuracy,
      tfWeights: row.tf_weights_json ? JSON.parse(row.tf_weights_json) : null,
      signalWeights: row.signal_weights_json ? JSON.parse(row.signal_weights_json) : null,
      bestTimeframes: row.best_timeframes_json ? JSON.parse(row.best_timeframes_json) : null,
      slMult: row.sl_mult || 1.0,
      tpMult: row.tp_mult || 1.0,
      entryThresholdAdj: row.entry_threshold_adj || 0,
      calibratedAt: row.calibrated_at,
      calibrationVersion: row.calibration_version,
    };

    // Re-cache in KV
    await kvPutJSON(KV, `timed:profile:${sym}`, profile, { expirationTtl: 86400 * 7 });
    return profile;
  } catch { return null; }
}

/**
 * Load a sector's profile from KV (fast) or D1 (fallback).
 */
export async function loadSectorProfile(env, sector) {
  const KV = env?.KV_TIMED;
  const db = env?.DB;

  const cached = await kvGetJSON(KV, `timed:sector-profile:${sector}`);
  if (cached) return cached;

  if (!db) return null;
  try {
    const row = await db.prepare(
      `SELECT * FROM sector_profiles WHERE sector = ?1`
    ).bind(sector).first();
    if (!row) return null;

    const profile = {
      sector: row.sector,
      currentRegime: row.current_regime,
      regimeScore: row.regime_score,
      etfTicker: row.etf_ticker,
      avgAtrPct: row.avg_atr_pct,
      dominantType: row.dominant_behavior_type,
      slMultAdj: row.sl_mult_adj || 1.0,
      tpMultAdj: row.tp_mult_adj || 1.0,
      tickerCount: row.ticker_count,
      updatedAt: row.updated_at,
    };

    await kvPutJSON(KV, `timed:sector-profile:${sector}`, profile, { expirationTtl: 86400 });
    return profile;
  } catch { return null; }
}

/**
 * Merge three tiers of weights: global <- sector <- ticker.
 * Returns merged scoring adjustment object.
 */
export function mergeProfileWeights(globalWeights, sectorProfile, tickerProfile) {
  const merged = {
    tfWeights: null,
    signalWeights: null,
    slMult: 1.0,
    tpMult: 1.0,
    entryThresholdAdj: 0,
    behaviorType: null,
  };

  // Sector layer
  if (sectorProfile) {
    merged.slMult *= (sectorProfile.slMultAdj || 1.0);
    merged.tpMult *= (sectorProfile.tpMultAdj || 1.0);
  }

  // Ticker layer (overrides sector)
  if (tickerProfile) {
    if (tickerProfile.tfWeights) merged.tfWeights = tickerProfile.tfWeights;
    if (tickerProfile.signalWeights) merged.signalWeights = tickerProfile.signalWeights;
    merged.slMult *= (tickerProfile.slMult || 1.0);
    merged.tpMult *= (tickerProfile.tpMult || 1.0);
    merged.entryThresholdAdj = tickerProfile.entryThresholdAdj || 0;
    merged.behaviorType = tickerProfile.behaviorType;
  }

  // Clamp multipliers to reasonable ranges
  merged.slMult = Math.max(0.5, Math.min(2.0, merged.slMult));
  merged.tpMult = Math.max(0.5, Math.min(2.0, merged.tpMult));

  return merged;
}

export { harvestMoves, computeFingerprint, calibrateTicker };
