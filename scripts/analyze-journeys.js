#!/usr/bin/env node
/**
 * Journey Analysis Engine
 *
 * Multi-resolution analysis of sustained price moves to derive:
 *   - Entry signal clusters
 *   - Pullback profiles (TRIM/SL placement)
 *   - Peak/exhaustion exit signals
 *
 * Usage:
 *   node scripts/analyze-journeys.js [--top 30] [--archetypes AMD,MU,AAPL,AXON]
 *
 * Phases:
 *   2a: Macro scan (D/W candles) → identify sustained moves across 275 tickers
 *   2b: Entry zoom (10m) → common signals at move origin
 *   2c: Pullback walk (10m) → map pullbacks, derive TRIM/SL rules
 *   2d: Peak analysis (10m) → exhaustion signals for final exit
 */

const TIMED_KEY = process.env.TIMED_API_KEY || "AwesomeSauce";
const BASE = process.env.WORKER_BASE || "https://timed-trading-ingest.shashant.workers.dev";
const { SECTOR_MAP } = require("../worker/sector-mapping.js");
const ALL_TICKERS = [...new Set(Object.keys(SECTOR_MAP))];
const fs = require("fs");

// ────────────────────────────────────────────────────────────────────────────
// Indicator Functions (mirroring worker/indicators.js)
// ────────────────────────────────────────────────────────────────────────────

function emaSeries(closes, period) {
  const out = new Array(closes.length).fill(NaN);
  if (!closes || closes.length < period) return out;
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += closes[i];
  out[period - 1] = sum / period;
  for (let i = period; i < closes.length; i++) {
    out[i] = closes[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}

function rmaSeries(values, period) {
  const out = new Array(values.length).fill(NaN);
  if (values.length < period) return out;
  const alpha = 1 / period;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += (Number.isFinite(values[i]) ? values[i] : 0);
  out[period - 1] = sum / period;
  for (let i = period; i < values.length; i++) {
    const v = Number.isFinite(values[i]) ? values[i] : 0;
    out[i] = alpha * v + (1 - alpha) * out[i - 1];
  }
  return out;
}

function trSeries(bars) {
  const out = new Array(bars.length).fill(NaN);
  out[0] = bars[0].h - bars[0].l;
  for (let i = 1; i < bars.length; i++) {
    out[i] = Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c));
  }
  return out;
}

function atrSeries(bars, period = 14) { return rmaSeries(trSeries(bars), period); }

function rsiSeries(closes, period = 14) {
  const out = new Array(closes.length).fill(NaN);
  if (closes.length < period + 1) return out;
  const gains = new Array(closes.length).fill(0);
  const losses = new Array(closes.length).fill(0);
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gains[i] = d > 0 ? d : 0;
    losses[i] = d < 0 ? -d : 0;
  }
  const avgG = rmaSeries(gains, period);
  const avgL = rmaSeries(losses, period);
  for (let i = 0; i < closes.length; i++) {
    if (!Number.isFinite(avgG[i]) || !Number.isFinite(avgL[i])) continue;
    out[i] = avgL[i] === 0 ? 100 : 100 - 100 / (1 + avgG[i] / avgL[i]);
  }
  return out;
}

function superTrendSeries(bars, factor = 3.0, atrLen = 10) {
  const n = bars.length;
  const line = new Array(n).fill(NaN);
  const dir = new Array(n).fill(0);
  const atr = atrSeries(bars, atrLen);
  const ub = new Array(n).fill(NaN);
  const lb = new Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(atr[i])) continue;
    const hl2 = (bars[i].h + bars[i].l) / 2;
    ub[i] = hl2 + factor * atr[i];
    lb[i] = hl2 - factor * atr[i];
  }
  const fv = atrLen;
  if (fv >= n) return { line, dir };
  dir[fv] = -1; line[fv] = lb[fv];
  for (let i = fv + 1; i < n; i++) {
    if (!Number.isFinite(ub[i]) || !Number.isFinite(lb[i])) { dir[i] = dir[i - 1]; line[i] = line[i - 1]; continue; }
    if (Number.isFinite(lb[i - 1]) && lb[i] < lb[i - 1] && bars[i - 1].c > lb[i - 1]) lb[i] = lb[i - 1];
    if (Number.isFinite(ub[i - 1]) && ub[i] > ub[i - 1] && bars[i - 1].c < ub[i - 1]) ub[i] = ub[i - 1];
    if (dir[i - 1] === -1) {
      if (bars[i].c < lb[i]) { dir[i] = 1; line[i] = ub[i]; } else { dir[i] = -1; line[i] = lb[i]; }
    } else {
      if (bars[i].c > ub[i]) { dir[i] = -1; line[i] = lb[i]; } else { dir[i] = 1; line[i] = ub[i]; }
    }
  }
  return { line, dir };
}

/** Detect Fair Value Gaps (FVGs) in a candle array. */
function detectFVGs(bars) {
  const fvgs = [];
  for (let i = 1; i < bars.length - 1; i++) {
    // Bullish FVG: candle[i-1].high < candle[i+1].low (gap up)
    if (bars[i - 1].h < bars[i + 1].l) {
      fvgs.push({ type: "bull", idx: i, ts: bars[i].ts, top: bars[i + 1].l, bot: bars[i - 1].h, size: bars[i + 1].l - bars[i - 1].h });
    }
    // Bearish FVG: candle[i-1].low > candle[i+1].high (gap down)
    if (bars[i - 1].l > bars[i + 1].h) {
      fvgs.push({ type: "bear", idx: i, ts: bars[i].ts, top: bars[i - 1].l, bot: bars[i + 1].h, size: bars[i - 1].l - bars[i + 1].h });
    }
  }
  return fvgs;
}

/** Compute all indicators for a candle array. Returns per-bar indicator arrays. */
function computeIndicators(bars) {
  if (!bars || bars.length < 50) return null;
  const closes = bars.map(b => b.c);
  const ema8 = emaSeries(closes, 8);
  const ema21 = emaSeries(closes, 21);
  const ema50 = emaSeries(closes, 50);
  const atr = atrSeries(bars, 14);
  const rsi = rsiSeries(closes, 14);
  const st = superTrendSeries(bars, 3.0, 10);
  const fvgs = detectFVGs(bars);
  return { closes, ema8, ema21, ema50, atr, rsi, st, fvgs, bars };
}

/** Get indicator snapshot at a specific bar index. */
function snapshotAt(ind, i) {
  if (!ind || i < 0 || i >= ind.bars.length) return null;
  const bar = ind.bars[i];
  const prevStDir = i > 0 ? ind.st.dir[i - 1] : ind.st.dir[i];
  const stFlip = prevStDir !== ind.st.dir[i];
  return {
    ts: bar.ts, price: bar.c, o: bar.o, h: bar.h, l: bar.l,
    ema8: ind.ema8[i], ema21: ind.ema21[i], ema50: ind.ema50[i],
    atr: ind.atr[i], rsi: ind.rsi[i],
    stLine: ind.st.line[i], stDir: ind.st.dir[i], stFlip, stFlipDir: stFlip ? (ind.st.dir[i] === -1 ? 1 : -1) : 0,
    emaStacked: ind.ema8[i] > ind.ema21[i] && ind.ema21[i] > ind.ema50[i] ? "bull" :
                ind.ema8[i] < ind.ema21[i] && ind.ema21[i] < ind.ema50[i] ? "bear" : "mixed",
    priceVsEma8: bar.c > ind.ema8[i] ? "above" : "below",
    priceVsEma21: bar.c > ind.ema21[i] ? "above" : "below",
    priceVsEma50: bar.c > ind.ema50[i] ? "above" : "below",
    atrPct: ind.atr[i] / bar.c * 100,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Data Fetching
// ────────────────────────────────────────────────────────────────────────────

async function fetchCandles(ticker, tf, limit = 300) {
  const url = `${BASE}/timed/candles?ticker=${ticker}&tf=${tf}&limit=${limit}&key=${TIMED_KEY}`;
  try {
    const resp = await fetch(url);
    const data = await resp.json();
    if (data.ok && data.candles) return data.candles;
    return [];
  } catch { return []; }
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ────────────────────────────────────────────────────────────────────────────
// Phase 2a: Identify Sustained Moves (Macro Scan)
// ────────────────────────────────────────────────────────────────────────────

/** Scan daily candles for sustained directional moves. */
function findSustainedMoves(ticker, dailyBars) {
  if (!dailyBars || dailyBars.length < 10) return [];

  const moves = [];
  const durations = [
    { label: ">1D", minBars: 1, minPct: 2.0, maxRetrace: 1.0 },
    { label: ">3D", minBars: 3, minPct: 4.0, maxRetrace: 2.0 },
    { label: ">1W", minBars: 5, minPct: 6.0, maxRetrace: 3.0 },
    { label: ">1M", minBars: 20, minPct: 10.0, maxRetrace: 5.0 },
  ];

  const n = dailyBars.length;

  for (const dur of durations) {
    // Scan forward from each bar looking for sustained moves
    for (let start = 0; start < n - dur.minBars; start++) {
      const startPrice = dailyBars[start].c;

      // Look for UP moves
      let maxHigh = startPrice;
      let maxRetrace = 0;
      let peakIdx = start;

      for (let end = start + 1; end < Math.min(start + dur.minBars * 4, n); end++) {
        const bar = dailyBars[end];
        if (bar.h > maxHigh) { maxHigh = bar.h; peakIdx = end; }
        const retrace = (maxHigh - bar.l) / startPrice * 100;
        if (retrace > dur.maxRetrace) break;
        maxRetrace = Math.max(maxRetrace, retrace);

        const movePct = (maxHigh - startPrice) / startPrice * 100;
        if (end - start >= dur.minBars && movePct >= dur.minPct) {
          moves.push({
            ticker, dir: "LONG", duration: dur.label,
            startIdx: start, peakIdx, endIdx: end,
            startTs: dailyBars[start].ts, peakTs: dailyBars[peakIdx].ts, endTs: dailyBars[end].ts,
            startPrice, peakPrice: maxHigh, endPrice: dailyBars[end].c,
            movePct: +movePct.toFixed(2), maxRetracePct: +maxRetrace.toFixed(2),
            bars: end - start,
          });
          break; // Found move at this duration, skip to next start
        }
      }

      // Look for DOWN moves (SHORT candidates)
      let minLow = startPrice;
      maxRetrace = 0;
      let troughIdx = start;

      for (let end = start + 1; end < Math.min(start + dur.minBars * 4, n); end++) {
        const bar = dailyBars[end];
        if (bar.l < minLow) { minLow = bar.l; troughIdx = end; }
        const retrace = (bar.h - minLow) / startPrice * 100;
        if (retrace > dur.maxRetrace) break;
        maxRetrace = Math.max(maxRetrace, retrace);

        const movePct = (startPrice - minLow) / startPrice * 100;
        if (end - start >= dur.minBars && movePct >= dur.minPct) {
          moves.push({
            ticker, dir: "SHORT", duration: dur.label,
            startIdx: start, peakIdx: troughIdx, endIdx: end,
            startTs: dailyBars[start].ts, peakTs: dailyBars[troughIdx].ts, endTs: dailyBars[end].ts,
            startPrice, peakPrice: minLow, endPrice: dailyBars[end].c,
            movePct: +movePct.toFixed(2), maxRetracePct: +maxRetrace.toFixed(2),
            bars: end - start,
          });
          break;
        }
      }
    }
  }

  // Deduplicate: keep the best (largest) move per duration per direction
  const best = {};
  for (const m of moves) {
    const key = `${m.ticker}:${m.dir}:${m.duration}`;
    if (!best[key] || m.movePct > best[key].movePct) best[key] = m;
  }

  return Object.values(best).sort((a, b) => b.movePct - a.movePct);
}

/** Classify move archetype based on what happened after the peak. */
function classifyArchetype(move, dailyBars) {
  if (move.dir === "SHORT") return "short_candidate";
  const peakIdx = move.peakIdx;
  const endIdx = Math.min(peakIdx + 10, dailyBars.length - 1);
  if (endIdx <= peakIdx) return "run_and_hold";

  const peakPrice = move.peakPrice;
  const postPeakMin = Math.min(...dailyBars.slice(peakIdx, endIdx + 1).map(b => b.l));
  const giveBackPct = (peakPrice - postPeakMin) / peakPrice * 100;
  const lastPrice = dailyBars[endIdx].c;
  const holdPct = (lastPrice - move.startPrice) / move.startPrice * 100;

  // Did price come back near start?  → "run_and_peak" (AMD pattern)
  if (giveBackPct > move.movePct * 0.6) return "run_and_peak";
  // Did price hold most gains?  → "run_and_hold" (MU pattern)
  if (holdPct > move.movePct * 0.5) return "run_and_hold";
  // Was there a base before the move?
  const preStart = Math.max(0, move.startIdx - 10);
  const preBars = dailyBars.slice(preStart, move.startIdx);
  if (preBars.length >= 5) {
    const preRange = Math.max(...preBars.map(b => b.h)) - Math.min(...preBars.map(b => b.l));
    const preRangePct = preRange / move.startPrice * 100;
    if (preRangePct < 3) return "base_and_explode"; // Tight base before move (AAPL pattern)
  }
  return "run_and_hold";
}

// ────────────────────────────────────────────────────────────────────────────
// Phase 2b: Entry Signal Analysis (10m zoom)
// ────────────────────────────────────────────────────────────────────────────

/** Analyze signals at the start of a move using intraday candles. */
function analyzeEntry(ind, moveStartTs) {
  if (!ind) return null;
  // Find the bar closest to the move start
  let startIdx = -1;
  for (let i = 0; i < ind.bars.length; i++) {
    if (ind.bars[i].ts >= moveStartTs) { startIdx = i; break; }
  }
  if (startIdx < 5) return null; // Need lookback context

  // Capture signals in a window: 5 bars before to 10 bars after move start
  const from = Math.max(0, startIdx - 5);
  const to = Math.min(ind.bars.length - 1, startIdx + 10);
  const signals = [];

  for (let i = from; i <= to; i++) {
    const snap = snapshotAt(ind, i);
    if (!snap) continue;
    const isOrigin = i >= startIdx && i <= startIdx + 2;

    // Check for key entry signals
    const entrySignals = [];
    if (snap.stFlip && snap.stFlipDir === 1) entrySignals.push("supertrend_flip_bull");
    if (snap.stFlip && snap.stFlipDir === -1) entrySignals.push("supertrend_flip_bear");
    if (snap.emaStacked === "bull") entrySignals.push("ema_stacked_bull");
    if (snap.emaStacked === "bear") entrySignals.push("ema_stacked_bear");
    if (snap.rsi > 50 && snap.rsi < 70) entrySignals.push("rsi_bullish_momentum");
    if (snap.rsi < 50 && snap.rsi > 30) entrySignals.push("rsi_bearish_momentum");
    if (snap.rsi < 30) entrySignals.push("rsi_oversold");
    if (snap.rsi > 70) entrySignals.push("rsi_overbought");

    // EMA cross detection
    if (i > 0) {
      if (ind.ema8[i - 1] <= ind.ema21[i - 1] && ind.ema8[i] > ind.ema21[i]) entrySignals.push("ema8_cross_above_ema21");
      if (ind.ema8[i - 1] >= ind.ema21[i - 1] && ind.ema8[i] < ind.ema21[i]) entrySignals.push("ema8_cross_below_ema21");
      if (ind.ema21[i - 1] <= ind.ema50[i - 1] && ind.ema21[i] > ind.ema50[i]) entrySignals.push("ema21_cross_above_ema50");
      if (ind.ema21[i - 1] >= ind.ema50[i - 1] && ind.ema21[i] < ind.ema50[i]) entrySignals.push("ema21_cross_below_ema50");
    }

    // ATR expansion
    if (i > 1 && Number.isFinite(ind.atr[i]) && Number.isFinite(ind.atr[i - 1])) {
      if (ind.atr[i] > ind.atr[i - 1] * 1.3) entrySignals.push("atr_expanding");
      if (ind.atr[i] < ind.atr[i - 1] * 0.7) entrySignals.push("atr_contracting");
    }

    // FVG proximity
    for (const fvg of ind.fvgs) {
      if (Math.abs(fvg.idx - i) <= 3) {
        entrySignals.push(`fvg_${fvg.type}_nearby`);
      }
    }

    // Price vs EMA distances (ATR multiples)
    if (Number.isFinite(snap.atr) && snap.atr > 0) {
      const distEma21 = (snap.price - snap.ema21) / snap.atr;
      if (Math.abs(distEma21) < 0.5) entrySignals.push("price_near_ema21");
      if (distEma21 > 2) entrySignals.push("price_extended_above_ema21");
      if (distEma21 < -2) entrySignals.push("price_extended_below_ema21");
    }

    signals.push({
      barOffset: i - startIdx, ts: snap.ts, price: snap.price,
      rsi: +snap.rsi?.toFixed(1), atrPct: +snap.atrPct?.toFixed(3),
      emaStacked: snap.emaStacked, stDir: snap.stDir,
      signals: entrySignals, isOrigin,
    });
  }

  return { moveStartTs, signals };
}

// ────────────────────────────────────────────────────────────────────────────
// Phase 2c: Pullback Analysis (walk the journey at 10m)
// ────────────────────────────────────────────────────────────────────────────

/** Walk a journey and identify pullbacks. */
function analyzePullbacks(ind, moveStartTs, movePeakTs, dir) {
  if (!ind) return null;
  const isLong = dir === "LONG";

  // Find move boundaries in the intraday data
  let startIdx = -1, peakIdx = -1;
  for (let i = 0; i < ind.bars.length; i++) {
    if (startIdx < 0 && ind.bars[i].ts >= moveStartTs) startIdx = i;
    if (ind.bars[i].ts <= movePeakTs) peakIdx = i;
  }
  if (startIdx < 0 || peakIdx <= startIdx) return null;

  // Walk the journey tracking pullbacks
  const pullbacks = [];
  let trendHigh = ind.bars[startIdx].c;
  let trendLow = ind.bars[startIdx].c;
  let inPullback = false;
  let pbStart = -1;
  let pbDepth = 0;
  let pbDeepestIdx = -1;

  for (let i = startIdx; i <= peakIdx; i++) {
    const bar = ind.bars[i];
    const snap = snapshotAt(ind, i);

    if (isLong) {
      if (bar.h > trendHigh) { trendHigh = bar.h; }
      const drawdown = (trendHigh - bar.l) / trendHigh * 100;

      if (!inPullback && drawdown > 0.3) {
        inPullback = true; pbStart = i; pbDepth = drawdown; pbDeepestIdx = i;
      } else if (inPullback) {
        if (drawdown > pbDepth) { pbDepth = drawdown; pbDeepestIdx = i; }
        // Pullback ends when price makes new high
        if (bar.h >= trendHigh) {
          const deepSnap = snapshotAt(ind, pbDeepestIdx);
          pullbacks.push({
            startIdx: pbStart, deepestIdx: pbDeepestIdx, endIdx: i,
            startTs: ind.bars[pbStart].ts, deepestTs: ind.bars[pbDeepestIdx].ts, endTs: bar.ts,
            depthPct: +pbDepth.toFixed(3),
            depthATR: deepSnap?.atr > 0 ? +((trendHigh - ind.bars[pbDeepestIdx].l) / deepSnap.atr).toFixed(2) : null,
            durationBars: i - pbStart,
            supportLevel: determineSupportLevel(ind, pbDeepestIdx),
            preSignals: getPrePullbackSignals(ind, pbStart),
          });
          inPullback = false; pbDepth = 0;
        }
      }
    } else {
      // SHORT: tracking rally pullbacks (bounces up)
      if (bar.l < trendLow) { trendLow = bar.l; }
      const bounce = (bar.h - trendLow) / trendLow * 100;

      if (!inPullback && bounce > 0.3) {
        inPullback = true; pbStart = i; pbDepth = bounce; pbDeepestIdx = i;
      } else if (inPullback) {
        if (bounce > pbDepth) { pbDepth = bounce; pbDeepestIdx = i; }
        if (bar.l <= trendLow) {
          const deepSnap = snapshotAt(ind, pbDeepestIdx);
          pullbacks.push({
            startIdx: pbStart, deepestIdx: pbDeepestIdx, endIdx: i,
            startTs: ind.bars[pbStart].ts, deepestTs: ind.bars[pbDeepestIdx].ts, endTs: bar.ts,
            depthPct: +pbDepth.toFixed(3),
            depthATR: deepSnap?.atr > 0 ? +((ind.bars[pbDeepestIdx].h - trendLow) / deepSnap.atr).toFixed(2) : null,
            durationBars: i - pbStart,
            supportLevel: determineSupportLevel(ind, pbDeepestIdx),
            preSignals: getPrePullbackSignals(ind, pbStart),
          });
          inPullback = false; pbDepth = 0;
        }
      }
    }
  }

  return { pullbacks, moveStartTs, movePeakTs, dir };
}

/** What held as support at the pullback bottom? */
function determineSupportLevel(ind, idx) {
  if (!ind || idx < 0) return "none";
  const bar = ind.bars[idx];
  const levels = [];

  // Check if price bounced off EMAs
  if (Number.isFinite(ind.ema8[idx]) && bar.l <= ind.ema8[idx] * 1.002 && bar.c >= ind.ema8[idx]) levels.push("ema8");
  if (Number.isFinite(ind.ema21[idx]) && bar.l <= ind.ema21[idx] * 1.003 && bar.c >= ind.ema21[idx]) levels.push("ema21");
  if (Number.isFinite(ind.ema50[idx]) && bar.l <= ind.ema50[idx] * 1.005 && bar.c >= ind.ema50[idx]) levels.push("ema50");

  // Check SuperTrend support
  if (ind.st.dir[idx] === -1 && Number.isFinite(ind.st.line[idx]) && bar.l <= ind.st.line[idx] * 1.003 && bar.c >= ind.st.line[idx]) {
    levels.push("supertrend");
  }

  // Check FVG zone
  for (const fvg of ind.fvgs) {
    if (fvg.type === "bull" && bar.l >= fvg.bot * 0.998 && bar.l <= fvg.top * 1.002) levels.push("fvg_bull");
    if (fvg.type === "bear" && bar.h >= fvg.bot * 0.998 && bar.h <= fvg.top * 1.002) levels.push("fvg_bear");
  }

  return levels.length > 0 ? levels.join("+") : "none";
}

/** What signals appeared just before a pullback started? */
function getPrePullbackSignals(ind, pbStartIdx) {
  const signals = [];
  // Look at 3 bars before pullback
  for (let i = Math.max(0, pbStartIdx - 3); i <= pbStartIdx; i++) {
    const snap = snapshotAt(ind, i);
    if (!snap) continue;
    if (snap.rsi > 70) signals.push("rsi_overbought");
    if (snap.rsi > 80) signals.push("rsi_extreme");
    if (snap.stFlip) signals.push("st_flip");
    if (Number.isFinite(snap.atr) && i > 0 && Number.isFinite(ind.atr[i - 1]) && snap.atr > ind.atr[i - 1] * 1.4) signals.push("atr_spike");
  }
  return [...new Set(signals)];
}

// ────────────────────────────────────────────────────────────────────────────
// Phase 2d: Peak/Exhaustion Analysis
// ────────────────────────────────────────────────────────────────────────────

/** Analyze signals at the peak/end of a move. */
function analyzePeak(ind, movePeakTs, dir) {
  if (!ind) return null;

  let peakIdx = -1;
  for (let i = 0; i < ind.bars.length; i++) {
    if (ind.bars[i].ts <= movePeakTs) peakIdx = i;
  }
  if (peakIdx < 10) return null;

  const from = Math.max(0, peakIdx - 10);
  const to = Math.min(ind.bars.length - 1, peakIdx + 10);
  const signals = [];
  const isLong = dir === "LONG";

  for (let i = from; i <= to; i++) {
    const snap = snapshotAt(ind, i);
    if (!snap) continue;
    const isPeak = i >= peakIdx - 1 && i <= peakIdx + 1;
    const peakSignals = [];

    // RSI divergence check (for LONG peaks: price higher, RSI lower)
    if (isLong) {
      if (i > 5 && snap.rsi < ind.rsi[i - 5] && snap.price > ind.bars[i - 5].c) peakSignals.push("rsi_bearish_divergence");
      if (snap.rsi > 70) peakSignals.push("rsi_overbought");
      if (snap.rsi > 80) peakSignals.push("rsi_extreme_overbought");
    } else {
      if (i > 5 && snap.rsi > ind.rsi[i - 5] && snap.price < ind.bars[i - 5].c) peakSignals.push("rsi_bullish_divergence");
      if (snap.rsi < 30) peakSignals.push("rsi_oversold");
      if (snap.rsi < 20) peakSignals.push("rsi_extreme_oversold");
    }

    // SuperTrend flip at peak
    if (snap.stFlip) {
      peakSignals.push(snap.stFlipDir === -1 ? "st_flip_to_bear" : "st_flip_to_bull");
    }

    // EMA rejection
    if (isLong && snap.price < snap.ema8 && i > 0 && ind.bars[i - 1].c >= ind.ema8[i - 1]) peakSignals.push("rejected_at_ema8");
    if (!isLong && snap.price > snap.ema8 && i > 0 && ind.bars[i - 1].c <= ind.ema8[i - 1]) peakSignals.push("rejected_at_ema8");

    // EMA crossover (bearish for LONG peak)
    if (i > 0) {
      if (ind.ema8[i - 1] >= ind.ema21[i - 1] && ind.ema8[i] < ind.ema21[i]) peakSignals.push("ema8_cross_below_ema21");
      if (ind.ema8[i - 1] <= ind.ema21[i - 1] && ind.ema8[i] > ind.ema21[i]) peakSignals.push("ema8_cross_above_ema21");
    }

    // ATR changes
    if (i > 1 && Number.isFinite(ind.atr[i]) && Number.isFinite(ind.atr[i - 1])) {
      if (ind.atr[i] < ind.atr[i - 1] * 0.75) peakSignals.push("atr_contracting");
      if (ind.atr[i] > ind.atr[i - 1] * 1.5) peakSignals.push("atr_spike_exhaustion");
    }

    // FVG fill near peak
    for (const fvg of ind.fvgs) {
      if (Math.abs(fvg.idx - i) <= 3) {
        peakSignals.push(`fvg_${fvg.type}_near_peak`);
      }
    }

    // Price extended from EMAs
    if (Number.isFinite(snap.atr) && snap.atr > 0) {
      const distEma21 = (snap.price - snap.ema21) / snap.atr;
      if (isLong && distEma21 > 2.5) peakSignals.push("price_overextended_above_ema21");
      if (!isLong && distEma21 < -2.5) peakSignals.push("price_overextended_below_ema21");
    }

    signals.push({
      barOffset: i - peakIdx, ts: snap.ts, price: snap.price,
      rsi: +snap.rsi?.toFixed(1), atrPct: +snap.atrPct?.toFixed(3),
      emaStacked: snap.emaStacked, stDir: snap.stDir,
      signals: peakSignals, isPeak,
    });
  }

  return { movePeakTs, signals, dir };
}

// ────────────────────────────────────────────────────────────────────────────
// Report Generation
// ────────────────────────────────────────────────────────────────────────────

function generateMarkdown(allResults) {
  const lines = [];
  lines.push("# Journey Analysis Report");
  lines.push(`\nGenerated: ${new Date().toISOString()}`);
  lines.push(`\nTickers analyzed: ${allResults.macroScan.totalTickers}`);
  lines.push(`Sustained moves found: ${allResults.macroScan.totalMoves}`);
  lines.push(`Detailed journeys analyzed: ${allResults.journeys.length}`);

  // Summary of archetypes
  lines.push("\n## Move Archetypes Found\n");
  const archCounts = {};
  for (const j of allResults.journeys) { archCounts[j.archetype] = (archCounts[j.archetype] || 0) + 1; }
  for (const [arch, count] of Object.entries(archCounts).sort((a, b) => b[1] - a[1])) {
    lines.push(`- **${arch}**: ${count} moves`);
  }

  // Top moves
  lines.push("\n## Top Sustained Moves\n");
  lines.push("| Ticker | Dir | Duration | Move% | MaxRetrace% | Archetype |");
  lines.push("|--------|-----|----------|-------|-------------|-----------|");
  for (const j of allResults.journeys.slice(0, 30)) {
    lines.push(`| ${j.ticker} | ${j.dir} | ${j.duration} | ${j.movePct}% | ${j.maxRetracePct}% | ${j.archetype} |`);
  }

  // Entry Signal Consensus
  lines.push("\n## Entry Signal Consensus\n");
  lines.push("Signals most frequently present at the start of sustained moves:\n");
  const entrySignalCounts = {};
  let totalEntryAnalyzed = 0;
  for (const j of allResults.journeys) {
    if (!j.entryAnalysis?.signals) continue;
    totalEntryAnalyzed++;
    const originSignals = j.entryAnalysis.signals.filter(s => s.isOrigin).flatMap(s => s.signals);
    for (const sig of originSignals) { entrySignalCounts[sig] = (entrySignalCounts[sig] || 0) + 1; }
  }
  const sortedEntry = Object.entries(entrySignalCounts).sort((a, b) => b[1] - a[1]);
  for (const [sig, count] of sortedEntry.slice(0, 20)) {
    lines.push(`- **${sig}**: ${count}/${totalEntryAnalyzed} (${(count / totalEntryAnalyzed * 100).toFixed(0)}%)`);
  }

  // Pullback Profile
  lines.push("\n## Pullback Profile\n");
  const allPullbacks = allResults.journeys.flatMap(j => j.pullbackAnalysis?.pullbacks || []);
  const prePBSigs = {};
  if (allPullbacks.length > 0) {
    const depths = allPullbacks.map(p => p.depthPct).sort((a, b) => a - b);
    const atrDepths = allPullbacks.map(p => p.depthATR).filter(Number.isFinite).sort((a, b) => a - b);
    const durations = allPullbacks.map(p => p.durationBars).sort((a, b) => a - b);
    const pct = (arr, p) => arr[Math.floor(arr.length * p)] || 0;

    lines.push(`Total pullbacks analyzed: ${allPullbacks.length}\n`);
    lines.push("| Metric | P25 | Median | P75 | P90 |");
    lines.push("|--------|-----|--------|-----|-----|");
    lines.push(`| Depth (%) | ${pct(depths, 0.25).toFixed(2)} | ${pct(depths, 0.5).toFixed(2)} | ${pct(depths, 0.75).toFixed(2)} | ${pct(depths, 0.9).toFixed(2)} |`);
    lines.push(`| Depth (ATR) | ${pct(atrDepths, 0.25).toFixed(2)} | ${pct(atrDepths, 0.5).toFixed(2)} | ${pct(atrDepths, 0.75).toFixed(2)} | ${pct(atrDepths, 0.9).toFixed(2)} |`);
    lines.push(`| Duration (bars) | ${pct(durations, 0.25).toFixed(0)} | ${pct(durations, 0.5).toFixed(0)} | ${pct(durations, 0.75).toFixed(0)} | ${pct(durations, 0.9).toFixed(0)} |`);

    // Support levels
    lines.push("\n### What Held as Support During Pullbacks\n");
    const supportCounts = {};
    for (const pb of allPullbacks) {
      const levels = (pb.supportLevel || "none").split("+");
      for (const l of levels) supportCounts[l] = (supportCounts[l] || 0) + 1;
    }
    for (const [level, count] of Object.entries(supportCounts).sort((a, b) => b[1] - a[1])) {
      lines.push(`- **${level}**: ${count}/${allPullbacks.length} (${(count / allPullbacks.length * 100).toFixed(0)}%)`);
    }

    // Pre-pullback signals
    lines.push("\n### Signals Before Pullbacks (TRIM timing)\n");
    for (const pb of allPullbacks) {
      for (const sig of pb.preSignals || []) prePBSigs[sig] = (prePBSigs[sig] || 0) + 1;
    }
    for (const [sig, count] of Object.entries(prePBSigs).sort((a, b) => b[1] - a[1])) {
      lines.push(`- **${sig}**: ${count}/${allPullbacks.length} (${(count / allPullbacks.length * 100).toFixed(0)}%)`);
    }
  }

  // Peak/Exhaustion Signals
  lines.push("\n## Peak/Exhaustion Signal Consensus\n");
  const peakSignalCounts = {};
  let totalPeaksAnalyzed = 0;
  for (const j of allResults.journeys) {
    if (!j.peakAnalysis?.signals) continue;
    totalPeaksAnalyzed++;
    const peakSigs = j.peakAnalysis.signals.filter(s => s.isPeak).flatMap(s => s.signals);
    for (const sig of peakSigs) { peakSignalCounts[sig] = (peakSignalCounts[sig] || 0) + 1; }
  }
  const sortedPeak = Object.entries(peakSignalCounts).sort((a, b) => b[1] - a[1]);
  for (const [sig, count] of sortedPeak.slice(0, 20)) {
    lines.push(`- **${sig}**: ${count}/${totalPeaksAnalyzed} (${(count / totalPeaksAnalyzed * 100).toFixed(0)}%)`);
  }

  // Detailed Archetype Case Studies
  const archetypeExamples = { run_and_peak: null, run_and_hold: null, base_and_explode: null, short_candidate: null };
  for (const j of allResults.journeys) {
    if (archetypeExamples[j.archetype] === null || j.movePct > (archetypeExamples[j.archetype]?.movePct || 0)) {
      archetypeExamples[j.archetype] = j;
    }
  }

  lines.push("\n## Archetype Case Studies\n");
  for (const [arch, j] of Object.entries(archetypeExamples)) {
    if (!j) continue;
    lines.push(`### ${arch}: ${j.ticker} (${j.dir}, ${j.movePct}% over ${j.duration})\n`);
    lines.push(`- Start: ${new Date(j.startTs).toISOString().split("T")[0]} @ $${j.startPrice.toFixed(2)}`);
    lines.push(`- Peak: ${new Date(j.peakTs).toISOString().split("T")[0]} @ $${j.peakPrice.toFixed(2)}`);
    lines.push(`- Max retrace during move: ${j.maxRetracePct}%`);
    if (j.pullbackAnalysis?.pullbacks?.length) {
      lines.push(`- Pullbacks during journey: ${j.pullbackAnalysis.pullbacks.length}`);
      for (let pi = 0; pi < Math.min(3, j.pullbackAnalysis.pullbacks.length); pi++) {
        const pb = j.pullbackAnalysis.pullbacks[pi];
        lines.push(`  - PB${pi + 1}: -${pb.depthPct}% (${pb.depthATR || "?"} ATR), ${pb.durationBars} bars, held at: ${pb.supportLevel}`);
      }
    }
    if (j.entryAnalysis?.signals) {
      const origin = j.entryAnalysis.signals.filter(s => s.isOrigin).flatMap(s => s.signals);
      if (origin.length) lines.push(`- Entry signals: ${[...new Set(origin)].join(", ")}`);
    }
    if (j.peakAnalysis?.signals) {
      const peak = j.peakAnalysis.signals.filter(s => s.isPeak).flatMap(s => s.signals);
      if (peak.length) lines.push(`- Peak signals: ${[...new Set(peak)].join(", ")}`);
    }
    lines.push("");
  }

  // SL/TRIM/EXIT Recommendations
  lines.push("\n## Derived Rules (Data-Backed)\n");
  lines.push("### Entry\n");
  lines.push("Top entry signal cluster (present at move origin):\n");
  for (const [sig, count] of sortedEntry.slice(0, 5)) {
    lines.push(`1. ${sig} (${(count / totalEntryAnalyzed * 100).toFixed(0)}%)`);
  }

  if (allPullbacks.length > 0) {
    const depths = allPullbacks.map(p => p.depthPct).sort((a, b) => a - b);
    const atrDepths = allPullbacks.map(p => p.depthATR).filter(Number.isFinite).sort((a, b) => a - b);
    const medianDepth = depths[Math.floor(depths.length * 0.5)];
    const p75Depth = depths[Math.floor(depths.length * 0.75)];
    const medianATR = atrDepths[Math.floor(atrDepths.length * 0.5)];

    lines.push("\n### Stop Loss\n");
    lines.push(`- Initial SL: Set below median pullback depth (${medianDepth.toFixed(2)}%) + buffer = **${(p75Depth * 1.1).toFixed(2)}%** from entry`);
    lines.push(`- In ATR terms: **${(medianATR * 1.2).toFixed(2)} ATR** below entry`);

    lines.push("\n### TRIM\n");
    lines.push("TRIM before pullbacks when these signals appear:");
    for (const [sig, count] of Object.entries(prePBSigs || {}).sort((a, b) => b[1] - a[1]).slice(0, 3)) {
      lines.push(`- ${sig} (preceded ${(count / allPullbacks.length * 100).toFixed(0)}% of pullbacks)`);
    }

    lines.push("\n### Final Exit\n");
    lines.push("Exit when these peak signals appear:");
    for (const [sig, count] of sortedPeak.slice(0, 5)) {
      lines.push(`- ${sig} (present at ${(count / totalPeaksAnalyzed * 100).toFixed(0)}% of peaks)`);
    }
  }

  return lines.join("\n");
}

// ────────────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  let topN = 30;
  let archetypeTickers = ["AMD", "MU", "AAPL", "AXON"];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--top" && args[i + 1]) topN = parseInt(args[++i]);
    if (args[i] === "--archetypes" && args[i + 1]) archetypeTickers = args[++i].split(",").map(t => t.trim().toUpperCase());
  }

  console.log(`Journey Analysis: scanning ${ALL_TICKERS.length} tickers`);
  console.log(`Top ${topN} moves will get detailed 10m analysis`);
  console.log(`Archetype tickers: ${archetypeTickers.join(", ")}\n`);

  // ── Phase 2a: Macro Scan ──
  console.log("=== Phase 2a: Identifying sustained moves (D candles) ===\n");
  const allMoves = [];

  for (let i = 0; i < ALL_TICKERS.length; i++) {
    const ticker = ALL_TICKERS[i];
    if ((i + 1) % 20 === 0) process.stdout.write(`  Scanning ${i + 1}/${ALL_TICKERS.length}...\r`);

    const daily = await fetchCandles(ticker, "D", 300);
    if (daily.length < 20) continue;
    await sleep(50); // Rate limit courtesy

    const moves = findSustainedMoves(ticker, daily);
    for (const m of moves) {
      m.archetype = classifyArchetype(m, daily);
      allMoves.push(m);
    }
  }

  console.log(`\nFound ${allMoves.length} sustained moves across all tickers\n`);

  // Sort by move magnitude, but ensure archetype tickers are included
  allMoves.sort((a, b) => b.movePct - a.movePct);
  const topMoves = [];
  const seen = new Set();

  // Force-include archetype tickers
  for (const ticker of archetypeTickers) {
    const tickerMoves = allMoves.filter(m => m.ticker === ticker);
    if (tickerMoves.length > 0) {
      topMoves.push(tickerMoves[0]);
      seen.add(`${ticker}:${tickerMoves[0].dir}:${tickerMoves[0].duration}`);
    }
  }

  // Fill remaining slots with top moves
  for (const m of allMoves) {
    const key = `${m.ticker}:${m.dir}:${m.duration}`;
    if (!seen.has(key) && topMoves.length < topN) {
      topMoves.push(m);
      seen.add(key);
    }
  }

  console.log(`Selected ${topMoves.length} moves for detailed analysis\n`);

  // ── Phase 2b-2d: Detailed Journey Analysis ──
  console.log("=== Phase 2b-2d: Detailed journey analysis (10m candles) ===\n");

  const journeys = [];
  for (let i = 0; i < topMoves.length; i++) {
    const move = topMoves[i];
    process.stdout.write(`  [${i + 1}/${topMoves.length}] ${move.ticker} ${move.dir} ${move.duration} (${move.movePct}%)...`);

    // Determine best TF for micro-structure based on move recency
    // With 60-day 10m backfill, use 10m for everything within 60 days
    const now = Date.now();
    const moveAge = (now - move.startTs) / (24 * 60 * 60 * 1000); // days
    let microTF, microLimit;
    if (moveAge <= 60) { microTF = "10"; microLimit = 2500; }
    else if (moveAge <= 120) { microTF = "30"; microLimit = 2500; }
    else if (moveAge <= 200) { microTF = "60"; microLimit = 2500; }
    else { microTF = "240"; microLimit = 2500; }

    const microBars = await fetchCandles(move.ticker, microTF, microLimit);
    await sleep(100);

    if (microBars.length < 50) {
      console.log(` skipped (only ${microBars.length} ${microTF}m bars)`);
      continue;
    }

    const ind = computeIndicators(microBars);
    if (!ind) { console.log(" skipped (insufficient indicator data)"); continue; }

    const entryAnalysis = analyzeEntry(ind, move.startTs);
    const pullbackAnalysis = analyzePullbacks(ind, move.startTs, move.peakTs, move.dir);
    const peakAnalysis = analyzePeak(ind, move.peakTs, move.dir);

    journeys.push({
      ...move, microTF, microBars: microBars.length,
      entryAnalysis, pullbackAnalysis, peakAnalysis,
    });

    console.log(` done (${microTF}m, ${microBars.length} bars)`);
  }

  console.log(`\nDetailed analysis complete for ${journeys.length} journeys\n`);

  // ── Generate Report ──
  const results = {
    macroScan: { totalTickers: ALL_TICKERS.length, totalMoves: allMoves.length },
    journeys,
    allMoves: allMoves.slice(0, 100), // Keep top 100 for JSON
  };

  const md = generateMarkdown(results);
  const jsonPath = "docs/JOURNEY_ANALYSIS.json";
  const mdPath = "docs/JOURNEY_ANALYSIS.md";

  fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2));
  fs.writeFileSync(mdPath, md);

  console.log(`Report written to: ${mdPath}`);
  console.log(`Data written to: ${jsonPath}`);
  console.log("\n" + md.split("\n").slice(0, 30).join("\n") + "\n...(truncated)");
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
