#!/usr/bin/env node
/**
 * build-ticker-learning.js — Ticker-Level Learning System (Phases 2-5)
 *
 * Scans all daily candles (2020+), computes indicators locally, discovers
 * significant moves, extracts lifecycle signals, classifies ticker personality,
 * and stores everything in D1 for the entry/exit engine to consume.
 *
 * Usage:
 *   USE_D1=1 node scripts/build-ticker-learning.js [--ticker AAPL] [--min-atr 3] [--since 2020-01-01]
 *
 * Tables populated:
 *   ticker_moves          — every significant move per ticker
 *   ticker_move_signals   — indicator snapshot at each lifecycle phase
 */

const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { SECTOR_MAP } = require("../worker/sector-mapping.js");

// ── CLI args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (name, dflt) => {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : dflt;
};
const hasFlag = (name) => args.includes(`--${name}`);

const SINCE_DATE = getArg("since", "2020-01-01");
const SINCE_TS = new Date(SINCE_DATE + "T00:00:00Z").getTime();
const MIN_ATR_MULT = Number(getArg("min-atr", "3"));
const TICKER_FILTER = getArg("ticker", null);
const DRY_RUN = hasFlag("dry-run");
const WINDOWS = [5, 10, 20, 40, 60];

const WORKER_DIR = path.join(__dirname, "../worker");

// ── D1 helpers ──────────────────────────────────────────────────────────────

function queryD1(sql, retries = 3) {
  const escaped = sql.replace(/"/g, '\\"');
  const cmd = `cd "${WORKER_DIR}" && npx wrangler d1 execute timed-trading-ledger --remote --env production --json --command "${escaped}"`;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const raw = execSync(cmd, { maxBuffer: 100 * 1024 * 1024, encoding: "utf-8" });
      const parsed = JSON.parse(raw);
      if (parsed?.error) { if (attempt < retries) continue; return []; }
      if (Array.isArray(parsed) && parsed[0]?.results) return parsed[0].results;
      if (parsed?.results) return parsed.results;
      return [];
    } catch (e) {
      if (attempt < retries) { execSync("sleep 2"); continue; }
      return [];
    }
  }
  return [];
}

function queryChunked(baseSql, chunkSize = 15000) {
  let all = [];
  let offset = 0;
  while (true) {
    const rows = queryD1(`${baseSql} LIMIT ${chunkSize} OFFSET ${offset}`);
    all = all.concat(rows);
    if (rows.length < chunkSize) break;
    offset += chunkSize;
  }
  return all;
}

function execD1(sql) {
  const escaped = sql.replace(/"/g, '\\"');
  const cmd = `cd "${WORKER_DIR}" && npx wrangler d1 execute timed-trading-ledger --remote --env production --json --command "${escaped}"`;
  try {
    execSync(cmd, { maxBuffer: 10 * 1024 * 1024, encoding: "utf-8" });
    return true;
  } catch { return false; }
}

// ── Formatting helpers ──────────────────────────────────────────────────────

function rnd(v, dp = 2) { return Math.round(v * Math.pow(10, dp)) / Math.pow(10, dp); }
function pct(n, d) { return d > 0 ? rnd(n / d * 100, 1) : 0; }
function dateStr(ts) { return new Date(ts > 1e12 ? ts : ts * 1000).toISOString().slice(0, 10); }
function uid() { return crypto.randomUUID(); }

const t0 = Date.now();
function elapsed() { return `${((Date.now() - t0) / 1000).toFixed(1)}s`; }
const B = "\x1b[1m", G = "\x1b[32m", R = "\x1b[31m", Y = "\x1b[33m", C = "\x1b[36m", RST = "\x1b[0m";
const MAX_REASONABLE_TS = Date.now() + (45 * 86400000);
const TF_WARMUP_BARS = {
  D: 400,
  W: 260,
  "10": 800,
  "30": 800,
  "1H": 800,
};

function sanitizeCandlesForSince(candles, tfLabel, sinceTs = SINCE_TS) {
  if (!Array.isArray(candles) || candles.length === 0) return [];
  const sane = candles
    .filter((b) =>
      Number.isFinite(b?.ts) &&
      b.ts > 0 &&
      b.ts <= MAX_REASONABLE_TS &&
      Number.isFinite(b?.o) &&
      Number.isFinite(b?.h) &&
      Number.isFinite(b?.l) &&
      Number.isFinite(b?.c)
    )
    .sort((a, b) => a.ts - b.ts);
  if (!sane.length) return [];
  const sinceIdx = sane.findIndex((b) => b.ts >= sinceTs);
  if (sinceIdx <= 0) return sane;
  const warmupBars = TF_WARMUP_BARS[tfLabel] || 400;
  return sane.slice(Math.max(0, sinceIdx - warmupBars));
}

function compactIchimokuState(ich) {
  if (!ich || typeof ich !== 'object') return null;
  return {
    pvc: ich.priceVsCloud || null,
    cb: ich.cloudBullish ? 1 : 0,
    tk: ich.tkBull ? 1 : 0,
    xu: ich.tkCrossUp ? 1 : 0,
    xd: ich.tkCrossDn ? 1 : 0,
    ca: ich.chikouAbove == null ? null : (ich.chikouAbove ? 1 : 0),
    ks: Number.isFinite(ich.kijunSlope) ? rnd(ich.kijunSlope, 3) : null,
    tksp: Number.isFinite(ich.tkSpread) ? rnd(ich.tkSpread, 3) : null,
    pt: Number.isFinite(ich.priceToKijun) ? rnd(ich.priceToKijun, 3) : null,
    ct: Number.isFinite(ich.cloudThickness) ? rnd(ich.cloudThickness, 3) : null,
    kw: ich.kumoTwist ? 1 : 0,
  };
}

function nearestBarIndex(candles, targetTs, maxDiffMs = 2 * 86400000) {
  let bestIdx = -1, bestDiff = Infinity;
  for (let j = 0; j < candles.length; j++) {
    const diff = Math.abs(candles[j].ts - targetTs);
    if (diff < bestDiff) { bestDiff = diff; bestIdx = j; }
    if (candles[j].ts > targetTs + maxDiffMs) break;
  }
  return bestDiff < maxDiffMs ? bestIdx : -1;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function bucketLabel(value, buckets, dflt = null) {
  if (!Number.isFinite(value)) return dflt;
  for (const bucket of buckets) {
    if (value < bucket.lt) return bucket.label;
  }
  return buckets.length ? buckets[buckets.length - 1].label : dflt;
}

function directionalEfficiency(candles, startIdx, endIdx) {
  if (!Array.isArray(candles) || endIdx <= startIdx) return 0;
  let path = 0;
  for (let i = startIdx + 1; i <= endIdx; i++) {
    path += Math.abs((candles[i]?.c || 0) - (candles[i - 1]?.c || 0));
  }
  const net = Math.abs((candles[endIdx]?.c || 0) - (candles[startIdx]?.c || 0));
  return path > 0 ? net / path : 0;
}

function computeMoveExcursions(direction, startPrice, peakPrice, troughPrice, atrVal) {
  const favorablePx = direction === "UP" ? (peakPrice - startPrice) : (startPrice - troughPrice);
  const adversePx = direction === "UP" ? (startPrice - troughPrice) : (peakPrice - startPrice);
  const mfePct = startPrice > 0 ? (favorablePx / startPrice) * 100 : 0;
  const maePct = startPrice > 0 ? Math.max(0, (adversePx / startPrice) * 100) : 0;
  const mfeAtr = atrVal > 0 ? favorablePx / atrVal : 0;
  const maeAtr = atrVal > 0 ? Math.max(0, adversePx / atrVal) : 0;
  return {
    mfe_pct: rnd(mfePct),
    mae_pct: rnd(maePct),
    mfe_atr: rnd(mfeAtr),
    mae_atr: rnd(maeAtr),
    mfe_mae_ratio: maeAtr > 0 ? rnd(mfeAtr / maeAtr, 2) : null,
  };
}

function compactCloudState(cloud) {
  if (!cloud || typeof cloud !== "object") return null;
  return {
    bull: cloud.bull ? 1 : 0,
    bear: cloud.bear ? 1 : 0,
    above: cloud.above ? 1 : 0,
    below: cloud.below ? 1 : 0,
    in_cloud: cloud.inCloud ? 1 : 0,
    spread_pct: Number.isFinite(cloud.spreadPct) ? rnd(cloud.spreadPct * 100, 2) : null,
    dist_to_cloud_pct: Number.isFinite(cloud.distToCloudPct) ? rnd(cloud.distToCloudPct * 100, 2) : null,
    cross_up: cloud.crossUp ? 1 : 0,
    cross_dn: cloud.crossDn ? 1 : 0,
  };
}

function compactTdState(td) {
  if (!td || typeof td !== "object") return null;
  return {
    td9_bullish: td.td9_bullish ? 1 : 0,
    td9_bearish: td.td9_bearish ? 1 : 0,
    td13_bullish: td.td13_bullish ? 1 : 0,
    td13_bearish: td.td13_bearish ? 1 : 0,
    bullish_prep_count: Number(td.bullish_prep_count || 0),
    bearish_prep_count: Number(td.bearish_prep_count || 0),
    bullish_leadup_count: Number(td.bullish_leadup_count || 0),
    bearish_leadup_count: Number(td.bearish_leadup_count || 0),
    boost: Number.isFinite(td.boost) ? rnd(td.boost, 2) : null,
  };
}

function compactOrbState(orb) {
  if (!orb || typeof orb !== "object") return null;
  const primary = orb.primary || orb["15m"] || orb["30m"] || orb["5m"] || null;
  return {
    bias: Number.isFinite(orb.orbBias) ? orb.orbBias : null,
    long_breakouts: Number(orb.longBreakouts || 0),
    short_breakouts: Number(orb.shortBreakouts || 0),
    reclaim_count: Number(orb.reclaimCount || 0),
    primary: primary ? {
      breakout: primary.breakout || null,
      reclaim: primary.reclaim ? 1 : 0,
      resolved: primary.resolved ? 1 : 0,
      width_pct: Number.isFinite(primary.widthPct) ? rnd(primary.widthPct, 2) : null,
      price_vs_orm: Number.isFinite(primary.priceVsORM) ? primary.priceVsORM : null,
      targets_hit_up: Number(primary.targetsHitUp || 0),
      targets_hit_dn: Number(primary.targetsHitDn || 0),
    } : null,
  };
}

function compactTfSnapshot(tfLabel, bundle, tdState = null, orbState = null) {
  if (!bundle || typeof bundle !== "object") return null;
  return {
    tf: tfLabel,
    price: Number.isFinite(bundle.px) ? rnd(bundle.px, 4) : null,
    ema: {
      depth: Number.isFinite(bundle.emaDepth) ? bundle.emaDepth : null,
      structure: Number.isFinite(bundle.emaStructure) ? rnd(bundle.emaStructure, 3) : null,
      momentum: Number.isFinite(bundle.emaMomentum) ? rnd(bundle.emaMomentum, 3) : null,
      regime: Number.isFinite(bundle.emaRegime) ? bundle.emaRegime : null,
      stack_bull: bundle.emaStack ? 1 : 0,
      ribbon_spread_pct: Number.isFinite(bundle.ribbonSpread) ? rnd(bundle.ribbonSpread * 100, 2) : null,
      c34_50: compactCloudState(bundle.ripsterClouds?.c34_50),
      c72_89: compactCloudState(bundle.ripsterClouds?.c72_89),
    },
    supertrend: {
      dir: Number.isFinite(bundle.stDir) ? bundle.stDir : null,
      flip: bundle.stFlip ? 1 : 0,
      bars_since_flip: Number.isFinite(bundle.stBarsSinceFlip) ? bundle.stBarsSinceFlip : null,
      slope_up: bundle.stSlopeUp ? 1 : 0,
      slope_dn: bundle.stSlopeDn ? 1 : 0,
    },
    rsi: {
      value: Number.isFinite(bundle.rsi) ? rnd(bundle.rsi, 1) : null,
      bull_div: bundle.rsiDiv?.bull?.active ? 1 : 0,
      bear_div: bundle.rsiDiv?.bear?.active ? 1 : 0,
    },
    phase: {
      osc: Number.isFinite(bundle.phaseOsc) ? rnd(bundle.phaseOsc, 2) : null,
      zone: bundle.phaseZone || null,
      saty: bundle.satyPhase ? {
        value: Number.isFinite(bundle.satyPhase.value) ? rnd(bundle.satyPhase.value, 2) : null,
        zone: bundle.satyPhase.zone || null,
      } : null,
    },
    atr: {
      value: Number.isFinite(bundle.atr14) ? rnd(bundle.atr14, 4) : null,
      ratio: Number.isFinite(bundle.atrRatio) ? rnd(bundle.atrRatio, 3) : null,
      compressed: bundle.compressed ? 1 : 0,
    },
    rvol: {
      vol_ratio: Number.isFinite(bundle.volRatio) ? rnd(bundle.volRatio, 2) : null,
      rvol5: Number.isFinite(bundle.rvol5) ? rnd(bundle.rvol5, 2) : null,
      spike: Number.isFinite(bundle.rvolSpike) ? rnd(bundle.rvolSpike, 2) : null,
    },
    pdz: bundle.pdz ? { zone: bundle.pdz.zone || null, pct: Number.isFinite(bundle.pdz.pct) ? rnd(bundle.pdz.pct, 1) : null } : null,
    fvg: bundle.fvg ? {
      active_bull: Number(bundle.fvg.activeBull || 0),
      active_bear: Number(bundle.fvg.activeBear || 0),
      in_bull_gap: bundle.fvg.inBullGap ? 1 : 0,
      in_bear_gap: bundle.fvg.inBearGap ? 1 : 0,
      nearest_bull_dist: Number.isFinite(bundle.fvg.nearestBullDist) ? rnd(bundle.fvg.nearestBullDist, 2) : null,
      nearest_bear_dist: Number.isFinite(bundle.fvg.nearestBearDist) ? rnd(bundle.fvg.nearestBearDist, 2) : null,
    } : null,
    liquidity: bundle.liq ? {
      buyside_count: Number(bundle.liq.buysideCount || 0),
      sellside_count: Number(bundle.liq.sellsideCount || 0),
      nearest_buyside_dist: Number.isFinite(bundle.liq.nearestBuysideDist) ? rnd(bundle.liq.nearestBuysideDist, 2) : null,
      nearest_sellside_dist: Number.isFinite(bundle.liq.nearestSellsideDist) ? rnd(bundle.liq.nearestSellsideDist, 2) : null,
    } : null,
    ichimoku: compactIchimokuState(bundle.ichimoku),
    td: tdState,
    orb: orbState,
  };
}

function classifyTrendRegime(bundle) {
  if (!bundle) return null;
  if (bundle.emaStructure >= 0.45 && bundle.stDir === -1) return "TRENDING_BULL";
  if (bundle.emaStructure <= -0.45 && bundle.stDir === 1) return "TRENDING_BEAR";
  if (Math.abs(bundle.emaMomentum || 0) >= 0.5) return "TRANSITIONAL";
  return "MIXED";
}

function classifyVolatilityRegime(bundle) {
  if (!bundle) return null;
  if (Number(bundle.atrRatio) >= 1.4) return "EXPANDING";
  if (bundle.compressed) return "COMPRESSED";
  if (Number(bundle.atrRatio) <= 0.8) return "QUIET";
  return "NORMAL";
}

function classifyVixBucket(vixPx) {
  return bucketLabel(vixPx, [
    { lt: 16, label: "CALM" },
    { lt: 22, label: "NORMAL" },
    { lt: 30, label: "ELEVATED" },
    { lt: Infinity, label: "STRESSED" },
  ], null);
}

function classifyRvolBucket(bundle) {
  if (!bundle) return null;
  const probe = Math.max(Number(bundle.rvolSpike) || 0, Number(bundle.rvol5) || 0, Number(bundle.volRatio) || 0);
  return bucketLabel(probe, [
    { lt: 0.9, label: "LIGHT" },
    { lt: 1.25, label: "NORMAL" },
    { lt: 1.8, label: "ELEVATED" },
    { lt: Infinity, label: "SURGING" },
  ], null);
}

function classifyMarketPulse(refs, vixPx) {
  const bundles = [refs?.spy, refs?.qqq, refs?.iwm].filter(Boolean);
  if (!bundles.length) return null;
  const structAvg = bundles.reduce((sum, b) => sum + (Number.isFinite(b.emaStructure) ? b.emaStructure : 0), 0) / bundles.length;
  const bullCount = bundles.filter(b => b.emaStructure >= 0.25 && b.stDir === -1).length;
  const bearCount = bundles.filter(b => b.emaStructure <= -0.25 && b.stDir === 1).length;
  if (bullCount >= 2 && structAvg > 0.2 && (!Number.isFinite(vixPx) || vixPx < 28)) return "RISK_ON";
  if (bearCount >= 2 && structAvg < -0.2) return "RISK_OFF";
  return "MIXED";
}

function buildCanonicalMovePayload(move) {
  const phases = {};
  for (const sig of move.signals || []) {
    phases[sig.phase] = {
      ts: sig.ts,
      phase_pct: sig.phase_pct,
      price: Number.isFinite(sig.price) ? rnd(sig.price, 4) : null,
      tf: sig.tf_canonical || null,
    };
  }
  return {
    summary: {
      ticker: move.ticker,
      direction: move.direction,
      start_ts: move.start_ts,
      end_ts: move.end_ts,
      peak_ts: move.peak_ts,
      duration_days: move.duration_days,
      start_price: move.start_price,
      end_price: move.end_price,
      peak_price: move.peak_price,
    },
    quality: {
      move_pct: move.move_pct,
      move_atr: move.move_atr,
      mfe_pct: move.mfe_pct,
      mae_pct: move.mae_pct,
      mfe_atr: move.mfe_atr,
      mae_atr: move.mae_atr,
      mfe_mae_ratio: move.mfe_mae_ratio,
      max_pullback_pct: move.max_pullback_pct,
      pullback_count: move.pullback_count,
      directional_efficiency: move.directional_efficiency,
      clean_expansion_score: move.clean_expansion_score,
    },
    context: move.context || null,
    phases,
  };
}

function runStatementChunks(statements, opts = {}) {
  const sqlDir = opts.sqlDir;
  const filePrefix = opts.filePrefix || "_chunk";
  const chunkSize = Math.max(1, Number(opts.chunkSize || 10));
  const timeoutMs = Math.max(30000, Number(opts.timeoutMs || 180000));
  const maxBuffer = Math.max(10 * 1024 * 1024, Number(opts.maxBuffer || 20 * 1024 * 1024));
  const retries = Math.max(1, Number(opts.retries || 2));
  const totalChunks = Math.ceil(statements.length / chunkSize);
  let ok = 0;
  let fail = 0;
  for (let ci = 0; ci < statements.length; ci += chunkSize) {
    const chunk = statements.slice(ci, ci + chunkSize).join(";\n") + ";\n";
    const chunkNum = Math.floor(ci / chunkSize) + 1;
    const chunkPath = path.join(sqlDir, `${filePrefix}_${chunkNum}.sql`);
    fs.writeFileSync(chunkPath, chunk);
    let success = false;
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        execSync(
          `cd "${WORKER_DIR}" && npx wrangler d1 execute timed-trading-ledger --remote --env production --file "${chunkPath}"`,
          { maxBuffer, encoding: "utf-8", timeout: timeoutMs }
        );
        success = true;
        break;
      } catch (e) {
        if (attempt >= retries) {
          fail++;
          if (fail <= 3) console.log(`
  ${R}${filePrefix} chunk ${chunkNum} failed: ${e.message?.slice(0, 150)}${RST}`);
        } else {
          execSync("sleep 2");
        }
      }
    }
    if (success) ok++;
    try { fs.unlinkSync(chunkPath); } catch {}
    if (chunkNum % 20 === 0 || chunkNum === totalChunks) {
      process.stdout.write(`
  [${elapsed()}] ${filePrefix} chunk ${chunkNum}/${totalChunks} (${ok} ok, ${fail} fail)...`);
    }
  }
  return { ok, fail, total: totalChunks };
}

// ════════════════════════════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════════════════════════════

async function main() {
  const ind = await import("../worker/indicators.js");
  const { rsiSeries, superTrendSeries, atrSeries, emaSeries, computeIchimoku, computeTfBundle, computeTDSequential, computeORB } = ind;

  console.log(`\n${B}╔══════════════════════════════════════════════════════════════╗${RST}`);
  console.log(`${B}║   Ticker-Level Learning System: Build Pipeline              ║${RST}`);
  console.log(`${B}╚══════════════════════════════════════════════════════════════╝${RST}\n`);
  console.log(`  Since: ${SINCE_DATE}  |  Min ATR: ${MIN_ATR_MULT}x  |  Windows: ${WINDOWS.join(", ")}d`);
  console.log(`  Ticker: ${TICKER_FILTER || "ALL"}  |  Dry run: ${DRY_RUN}\n`);

  // ── Step 1: Load daily candles (batch by ticker to avoid OFFSET scans) ──

  console.log(`${B}═══ Step 1: Loading Daily Candles ═══${RST}\n`);
  console.log(`  [${elapsed()}] Fetching ticker list from D1...`);

  const tickerList = TICKER_FILTER
    ? [{ ticker: TICKER_FILTER }]
    : queryD1(`SELECT DISTINCT ticker FROM ticker_candles WHERE tf='D' ORDER BY ticker`);
  console.log(`  [${elapsed()}] ${tickerList.length} tickers found`);

  const fullByTicker = {};
  const TICKER_BATCH = 15;
  let totalCandles = 0;

  for (let bi = 0; bi < tickerList.length; bi += TICKER_BATCH) {
    const batch = tickerList.slice(bi, bi + TICKER_BATCH);
    const inClause = batch.map(r => `'${r.ticker}'`).join(",");
    const rows = queryD1(
      `SELECT ticker, ts, o, h, l, c, v FROM ticker_candles WHERE tf='D' AND ticker IN (${inClause}) ORDER BY ticker, ts`
    );
    for (const c of rows) {
      const ts = Number(c.ts);
      const tsMs = ts > 1e12 ? ts : ts * 1000;
      const t = String(c.ticker).toUpperCase();
      (fullByTicker[t] = fullByTicker[t] || []).push({
        ts: tsMs, o: Number(c.o), h: Number(c.h), l: Number(c.l), c: Number(c.c), v: Number(c.v || 0),
      });
    }
    totalCandles += rows.length;
    if ((bi / TICKER_BATCH) % 5 === 0) {
      process.stdout.write(`\r  [${elapsed()}] ${Math.min(bi + TICKER_BATCH, tickerList.length)}/${tickerList.length} tickers loaded (${totalCandles} candles)...`);
    }
  }
  for (const t of Object.keys(fullByTicker)) fullByTicker[t] = sanitizeCandlesForSince(fullByTicker[t], "D");
  console.log(`\n  [${elapsed()}] ${totalCandles} daily candles loaded`);

  const tickers = Object.keys(fullByTicker).filter(t => fullByTicker[t].length >= 60);
  console.log(`  ${tickers.length} tickers with 60+ daily candles\n`);

  // ── Step 2: Compute indicators + discover moves ─────────────────────────

  console.log(`${B}═══ Step 2: Discover Moves + Compute Indicators ═══${RST}\n`);

  let allMoves = [];
  let tickerStats = {};

  for (const ticker of tickers) {
    const candles = fullByTicker[ticker];
    const closes = candles.map(b => b.c);

    // Compute indicators from full history (warmup needs early data)
    const rsi = rsiSeries(closes, 14);
    const st = superTrendSeries(candles, 3.0, 10);
    const atr = atrSeries(candles, 14);
    const ema21 = emaSeries(closes, 21);
    const ema48 = emaSeries(closes, 48);

    // Find the index where SINCE_DATE starts for move discovery
    const sinceIdx = candles.findIndex(b => b.ts >= SINCE_TS);
    if (sinceIdx < 0) continue;
    const searchStartIdx = Math.max(sinceIdx, 60);

    const tickerMoves = [];
    const ichDailyCache = new Map();
    const ichimokuDailyAt = (idx) => {
      if (ichDailyCache.has(idx)) return ichDailyCache.get(idx);
      const state = compactIchimokuState(computeIchimoku(candles.slice(0, idx + 1), atr[idx] || 0));
      ichDailyCache.set(idx, state);
      return state;
    };

    for (const window of WINDOWS) {
      for (let i = searchStartIdx + window; i < candles.length; i++) {
        const startIdx = i - window;
        const atrVal = atr[startIdx];
        if (!Number.isFinite(atrVal) || atrVal <= 0) continue;

        const startPrice = candles[startIdx].c;
        const endPrice = candles[i].c;
        if (startPrice <= 0) continue;

        const movePct = ((endPrice - startPrice) / startPrice) * 100;
        const moveAtr = Math.abs(endPrice - startPrice) / atrVal;
        if (moveAtr < MIN_ATR_MULT) continue;

        const direction = movePct > 0 ? "UP" : "DOWN";

        // Intra-move analysis
        let peakPrice = startPrice, troughPrice = startPrice;
        let peakIdx = startIdx, troughIdx = startIdx;
        let maxPullbackPct = 0, pullbackCount = 0, prevExtreme = startPrice;

        for (let j = startIdx + 1; j <= i; j++) {
          if (candles[j].h > peakPrice) { peakPrice = candles[j].h; peakIdx = j; }
          if (candles[j].l < troughPrice) { troughPrice = candles[j].l; troughIdx = j; }

          if (direction === "UP") {
            const pb = prevExtreme > 0 ? (prevExtreme - candles[j].l) / prevExtreme * 100 : 0;
            if (pb > maxPullbackPct) maxPullbackPct = pb;
            if (pb > atrVal / startPrice * 100) pullbackCount++;
            prevExtreme = Math.max(prevExtreme, candles[j].h);
          } else {
            const pb = troughPrice > 0 ? (candles[j].h - troughPrice) / troughPrice * 100 : 0;
            if (pb > maxPullbackPct) maxPullbackPct = pb;
            if (pb > atrVal / startPrice * 100) pullbackCount++;
            prevExtreme = Math.min(prevExtreme, candles[j].l);
          }
        }

        const rsiStart = rsi[startIdx];
        const e21 = ema21[startIdx];
        const e48 = ema48[startIdx];
        const emaAligned = direction === "UP" ? (e21 > e48) : (e21 < e48);
        const emaState = e21 > e48 ? "BULL" : "BEAR";
        const stDirStart = st.dir[startIdx];

        // Canonical move-profiler phases used downstream for archetype learning.
        const phases = [
          { name: "origin", pct: 0.0 },
          { name: "confirmation", pct: 0.2 },
          { name: "expansion", pct: 0.45 },
          { name: "maturity", pct: 0.7 },
          { name: "termination", pct: 1.0 },
        ];

        const signals = phases.map(p => {
          const idx = Math.min(startIdx + Math.round(window * p.pct), i);
          return {
            phase: p.name,
            phase_pct: p.pct,
            ts: candles[idx].ts,
            price: candles[idx].c,
            rsi_d: Number.isFinite(rsi[idx]) ? rnd(rsi[idx], 1) : null,
            st_dir_d: st.dir[idx] || 0,
            atr_d: Number.isFinite(atr[idx]) ? rnd(atr[idx], 4) : null,
            ema21_d: Number.isFinite(ema21[idx]) ? rnd(ema21[idx], 2) : null,
            ema48_d: Number.isFinite(ema48[idx]) ? rnd(ema48[idx], 2) : null,
            ema_cross_d: ema21[idx] > ema48[idx] ? 1 : 0,
            ichimoku_d: ichimokuDailyAt(idx),
          };
        });

        const moveExcursions = computeMoveExcursions(direction, startPrice, peakPrice, troughPrice, atrVal);
        const moveEfficiency = directionalEfficiency(candles, startIdx, i);
        const cleanExpansionScore = clamp((moveEfficiency * 100) - (maxPullbackPct * 1.2) - (pullbackCount * 3), 0, 100);

        const moveId = uid();
        tickerMoves.push({
          id: moveId,
          ticker,
          direction,
          window,
          start_ts: candles[startIdx].ts,
          end_ts: candles[i].ts,
          peak_ts: candles[direction === "UP" ? peakIdx : troughIdx].ts,
          duration_days: window,
          move_pct: rnd(movePct),
          move_atr: rnd(moveAtr),
          start_price: rnd(startPrice, 4),
          end_price: rnd(endPrice, 4),
          peak_price: rnd(direction === "UP" ? peakPrice : troughPrice, 4),
          atr_at_start: rnd(atrVal, 4),
          max_pullback_pct: rnd(maxPullbackPct),
          pullback_count: pullbackCount,
          mfe_pct: moveExcursions.mfe_pct,
          mae_pct: moveExcursions.mae_pct,
          mfe_atr: moveExcursions.mfe_atr,
          mae_atr: moveExcursions.mae_atr,
          mfe_mae_ratio: moveExcursions.mfe_mae_ratio,
          directional_efficiency: rnd(moveEfficiency, 3),
          clean_expansion_score: rnd(cleanExpansionScore, 1),
          rsi_at_start: Number.isFinite(rsiStart) ? rnd(rsiStart, 0) : 50,
          ema_aligned: emaAligned ? 1 : 0,
          ema_state: emaState,
          st_dir_start: stDirStart,
          context: null,
          move_json: null,
          signals,
        });
      }
    }

    // Dedup: keep largest move per direction per 5-day bucket
    tickerMoves.sort((a, b) => b.move_atr - a.move_atr);
    const seen = new Set();
    const deduped = [];
    for (const m of tickerMoves) {
      const bucket = Math.floor(m.start_ts / (5 * 86400000));
      const key = `${m.direction}:${bucket}`;
      if (seen.has(key)) continue;
      seen.add(key);
      seen.add(`${m.direction}:${bucket - 1}`);
      seen.add(`${m.direction}:${bucket + 1}`);
      deduped.push(m);
    }

    allMoves.push(...deduped);

    // Per-ticker stats for personality classification
    if (deduped.length > 0) {
      const upMoves = deduped.filter(m => m.direction === "UP");
      const dnMoves = deduped.filter(m => m.direction === "DOWN");

      const avgMovePct = deduped.reduce((s, m) => s + Math.abs(m.move_pct), 0) / deduped.length;
      const avgPullback = deduped.reduce((s, m) => s + m.max_pullback_pct, 0) / deduped.length;
      const avgDuration = deduped.reduce((s, m) => s + m.duration_days, 0) / deduped.length;
      const avgATR = deduped.reduce((s, m) => s + m.move_atr, 0) / deduped.length;

      // Volatility ratio: how large are the moves relative to price?
      const avgAtrPct = deduped.reduce((s, m) => s + (m.atr_at_start / m.start_price * 100), 0) / deduped.length;

      tickerStats[ticker] = {
        total_moves: deduped.length,
        up_moves: upMoves.length,
        dn_moves: dnMoves.length,
        avg_move_pct: rnd(avgMovePct),
        avg_pullback_pct: rnd(avgPullback),
        avg_duration: rnd(avgDuration, 0),
        avg_atr_mult: rnd(avgATR),
        avg_atr_pct: rnd(avgAtrPct),
        ema_aligned_rate: pct(deduped.filter(m => m.ema_aligned).length, deduped.length),
      };
    }

    if (tickers.indexOf(ticker) % 20 === 0 || tickers.indexOf(ticker) === tickers.length - 1) {
      process.stdout.write(`\r  [${elapsed()}] ${tickers.indexOf(ticker) + 1}/${tickers.length} tickers processed (${allMoves.length} moves)...`);
    }
  }
  console.log(`\n\n  Total moves: ${allMoves.length}`);
  console.log(`  UP: ${allMoves.filter(m => m.direction === "UP").length}  |  DOWN: ${allMoves.filter(m => m.direction === "DOWN").length}`);
  console.log(`  Tickers with moves: ${Object.keys(tickerStats).length}\n`);

  if (allMoves.length === 0) {
    console.log(`  ${R}No moves found — check date range and ATR threshold${RST}`);
    return;
  }

  const allMovesByTicker = {};
  for (const move of allMoves) {
    (allMovesByTicker[move.ticker] = allMovesByTicker[move.ticker] || []).push(move);
  }

  // ── Step 2b: LTF Signal Enrichment (30m candles, Feb 2024+) ────────────

  const LTF_SINCE = new Date("2024-02-27T00:00:00Z").getTime();
  const ltfMoves = allMoves.filter(m => m.start_ts >= LTF_SINCE);
  console.log(`
${B}═══ Step 2b: LTF Signal Enrichment (30m) ═══${RST}
`);
  console.log(`  ${ltfMoves.length}/${allMoves.length} moves within 30m data range (since 2024-02-27)
`);

  if (ltfMoves.length > 0) {
    const ltfByTicker = {};
    for (const m of ltfMoves) (ltfByTicker[m.ticker] = ltfByTicker[m.ticker] || []).push(m);
    const ltfTickers = Object.keys(ltfByTicker).sort();
    console.log(`  Processing ${ltfTickers.length} tickers (load → compute → enrich → free per batch)...`);

    let enriched = 0;
    for (let bi = 0; bi < ltfTickers.length; bi += TICKER_BATCH) {
      const batch = ltfTickers.slice(bi, bi + TICKER_BATCH);
      const inClause = batch.map(t => `'${t}'`).join(",");
      const rows = queryD1(
        `SELECT ticker, ts, o, h, l, c, v FROM ticker_candles WHERE tf='30' AND ticker IN (${inClause}) ORDER BY ticker, ts`
      );

      const batchCandles = {};
      for (const c of rows) {
        const t = String(c.ticker).toUpperCase();
        const tsMs = Number(c.ts) > 1e12 ? Number(c.ts) : Number(c.ts) * 1000;
        (batchCandles[t] = batchCandles[t] || []).push({ ts: tsMs, o: Number(c.o), h: Number(c.h), l: Number(c.l), c: Number(c.c), v: Number(c.v || 0) });
      }

      for (const ticker of batch) {
        const candles30m = batchCandles[ticker];
        if (!candles30m || candles30m.length < 30) continue;
        candles30m.sort((a, b) => a.ts - b.ts);
        const closes30m = candles30m.map(b => b.c);
        const rsi30m = rsiSeries(closes30m, 14);
        const st30m = superTrendSeries(candles30m, 3.0, 10);
        const atr30m = atrSeries(candles30m, 14);
        const ichi30mCache = new Map();
        const ichimoku30mAt = (idx) => {
          if (ichi30mCache.has(idx)) return ichi30mCache.get(idx);
          const state = compactIchimokuState(computeIchimoku(candles30m.slice(0, idx + 1), atr30m[idx] || 0));
          ichi30mCache.set(idx, state);
          return state;
        };

        for (const move of (ltfByTicker[ticker] || [])) {
          for (const sig of move.signals) {
            const bestIdx = nearestBarIndex(candles30m, sig.ts);
            if (bestIdx >= 14) {
              sig.rsi_30m = Number.isFinite(rsi30m[bestIdx]) ? rnd(rsi30m[bestIdx], 1) : null;
              sig.st_dir_30m = st30m.dir[bestIdx] || null;
              sig.ichimoku_30m = ichimoku30mAt(bestIdx);
              if (sig.rsi_30m != null || sig.st_dir_30m != null || sig.ichimoku_30m) enriched++;
            }
          }
        }
      }

      if ((bi / TICKER_BATCH) % 3 === 0) {
        process.stdout.write(`
  [${elapsed()}] ${Math.min(bi + TICKER_BATCH, ltfTickers.length)}/${ltfTickers.length} tickers (${enriched} signals enriched)...`);
      }
    }
    console.log(`
  [${elapsed()}] ${enriched} LTF signals enriched (all canonical phases)
`);
  }

  // ── Step 2c: HTF Signal Enrichment (Weekly) ──────────────────────────────

  console.log(`
${B}═══ Step 2c: HTF Signal Enrichment (Weekly) ═══${RST}
`);
  console.log(`  Processing ${tickers.length} tickers for weekly context...
`);

  let weeklyEnriched = 0;
  for (let bi = 0; bi < tickers.length; bi += TICKER_BATCH) {
    const batch = tickers.slice(bi, bi + TICKER_BATCH);
    const inClause = batch.map(t => `'${t}'`).join(',');
    const rows = queryD1(
      `SELECT ticker, ts, o, h, l, c, v FROM ticker_candles WHERE tf='W' AND ticker IN (${inClause}) ORDER BY ticker, ts`
    );

    const batchCandles = {};
    for (const c of rows) {
      const t = String(c.ticker).toUpperCase();
      const tsMs = Number(c.ts) > 1e12 ? Number(c.ts) : Number(c.ts) * 1000;
      (batchCandles[t] = batchCandles[t] || []).push({ ts: tsMs, o: Number(c.o), h: Number(c.h), l: Number(c.l), c: Number(c.c), v: Number(c.v || 0) });
    }

    for (const ticker of batch) {
      const weeklyCandles = batchCandles[ticker];
      if (!weeklyCandles || weeklyCandles.length < 14) continue;
      weeklyCandles.sort((a, b) => a.ts - b.ts);
      const closesW = weeklyCandles.map(b => b.c);
      const rsiW = rsiSeries(closesW, 14);
      const stW = superTrendSeries(weeklyCandles, 3.0, 10);
      const atrW = atrSeries(weeklyCandles, 14);
      const ema21W = emaSeries(closesW, 21);
      const ema48W = emaSeries(closesW, 48);
      const ichiWCache = new Map();
      const ichimokuWAt = (idx) => {
        if (ichiWCache.has(idx)) return ichiWCache.get(idx);
        const state = compactIchimokuState(computeIchimoku(weeklyCandles.slice(0, idx + 1), atrW[idx] || 0));
        ichiWCache.set(idx, state);
        return state;
      };

      for (const move of (allMovesByTicker[ticker] || [])) {
        for (const sig of move.signals) {
          const bestIdx = nearestBarIndex(weeklyCandles, sig.ts, 10 * 86400000);
          if (bestIdx < 13) continue;
          sig.rsi_w = Number.isFinite(rsiW[bestIdx]) ? rnd(rsiW[bestIdx], 1) : null;
          sig.st_dir_w = stW.dir[bestIdx] || null;
          sig.ema21_w = Number.isFinite(ema21W[bestIdx]) ? rnd(ema21W[bestIdx], 2) : null;
          sig.ema48_w = Number.isFinite(ema48W[bestIdx]) ? rnd(ema48W[bestIdx], 2) : null;
          sig.ema_cross_w = Number.isFinite(ema21W[bestIdx]) && Number.isFinite(ema48W[bestIdx]) ? (ema21W[bestIdx] > ema48W[bestIdx] ? 1 : 0) : null;
          sig.ichimoku_w = ichimokuWAt(bestIdx);
          if (sig.rsi_w != null || sig.st_dir_w != null || sig.ichimoku_w) weeklyEnriched++;
        }
      }
    }

    if ((bi / TICKER_BATCH) % 3 === 0) {
      process.stdout.write(`
  [${elapsed()}] ${Math.min(bi + TICKER_BATCH, tickers.length)}/${tickers.length} tickers (${weeklyEnriched} weekly enrichments)...`);
    }
  }
  console.log(`
  [${elapsed()}] ${weeklyEnriched} weekly signals enriched (all canonical phases)
`);

  // ── Step 2d: Canonical multi-timeframe move-profiler enrichment ──────────

  console.log(`
${B}═══ Step 2d: Canonical Move Profiler Enrichment ═══${RST}
`);
  const canonicalTfDefs = [
    { dbTf: "10", label: "10", maxDiffMs: 2 * 86400000 },
    { dbTf: "30", label: "30", maxDiffMs: 2 * 86400000 },
    { dbTf: "60", label: "1H", maxDiffMs: 2 * 86400000 },
    { dbTf: "W", label: "W", maxDiffMs: 10 * 86400000 },
  ];
  const referenceTickers = ["SPY", "QQQ", "IWM", "VX1!", "VIXY"];
  const referenceDaily = {};
  for (const refTicker of referenceTickers) {
    if (fullByTicker[refTicker]?.length) referenceDaily[refTicker] = fullByTicker[refTicker];
  }
  const referenceBundleCache = new Map();
  const getReferenceBundle = (ticker, targetTs, maxDiffMs = 5 * 86400000) => {
    const candles = referenceDaily[ticker];
    if (!candles || candles.length < 15) return null;
    const idx = nearestBarIndex(candles, targetTs, maxDiffMs);
    if (idx < 14) return null;
    const key = `${ticker}:${idx}`;
    if (referenceBundleCache.has(key)) return referenceBundleCache.get(key);
    const bundle = computeTfBundle(candles.slice(0, idx + 1), null);
    referenceBundleCache.set(key, bundle || null);
    return bundle || null;
  };

  let canonicalEnriched = 0;
  for (let bi = 0; bi < tickers.length; bi += TICKER_BATCH) {
    const batch = tickers.slice(bi, bi + TICKER_BATCH);
    const inClause = batch.map(t => `'${t}'`).join(',');
    const tfRows = queryD1(
      `SELECT ticker, tf, ts, o, h, l, c, v FROM ticker_candles WHERE tf IN ('10','30','60','W') AND ticker IN (${inClause}) ORDER BY ticker, tf, ts`
    );
    const batchTfCandles = {};
    for (const row of tfRows) {
      const ticker = String(row.ticker).toUpperCase();
      const tf = String(row.tf);
      const tsMs = Number(row.ts) > 1e12 ? Number(row.ts) : Number(row.ts) * 1000;
      const outTf = tf === '60' ? '1H' : tf;
      (((batchTfCandles[ticker] = batchTfCandles[ticker] || {})[outTf] = batchTfCandles[ticker][outTf] || [])).push({
        ts: tsMs,
        o: Number(row.o),
        h: Number(row.h),
        l: Number(row.l),
        c: Number(row.c),
        v: Number(row.v || 0),
      });
    }

    for (const ticker of batch) {
      const candlesByTf = { D: fullByTicker[ticker] || [] };
      for (const tfDef of canonicalTfDefs) {
        candlesByTf[tfDef.label] = sanitizeCandlesForSince((((batchTfCandles[ticker] || {})[tfDef.label]) || []), tfDef.label);
      }
      const tfStateCache = new Map();
      const getTfState = (tfLabel, phaseTs) => {
        const candles = candlesByTf[tfLabel];
        const maxDiffMs = tfLabel === 'W' ? 10 * 86400000 : tfLabel === 'D' ? 3 * 86400000 : 2 * 86400000;
        if (!candles || candles.length < 15) return null;
        const idx = nearestBarIndex(candles, phaseTs, maxDiffMs);
        if (idx < 14) return null;
        const key = `${tfLabel}:${idx}`;
        if (tfStateCache.has(key)) return tfStateCache.get(key);
        const slice = candles.slice(0, idx + 1);
        const bundle = computeTfBundle(slice, null);
        if (!bundle) {
          tfStateCache.set(key, null);
          return null;
        }
        const td = compactTdState(computeTDSequential(slice, tfLabel === '1H' ? '60' : tfLabel));
        const orb = (tfLabel === '10' || tfLabel === '30' || tfLabel === '1H')
          ? compactOrbState(computeORB(slice, bundle.px, phaseTs))
          : null;
        const state = { bundle, snapshot: compactTfSnapshot(tfLabel, bundle, td, orb) };
        tfStateCache.set(key, state);
        return state;
      };

      for (const move of (allMovesByTicker[ticker] || [])) {
        const ownDailyState = getTfState('D', move.start_ts);
        const spyBundle = getReferenceBundle('SPY', move.start_ts) || ownDailyState?.bundle || null;
        const qqqBundle = getReferenceBundle('QQQ', move.start_ts);
        const iwmBundle = getReferenceBundle('IWM', move.start_ts);
        const vixBundle = getReferenceBundle('VX1!', move.start_ts) || getReferenceBundle('VIXY', move.start_ts);
        const vixPx = Number.isFinite(vixBundle?.px) ? vixBundle.px : null;
        const context = {
          sector: SECTOR_MAP[ticker] || null,
          regime: classifyTrendRegime(spyBundle || ownDailyState?.bundle || null),
          volatility_regime: classifyVolatilityRegime(ownDailyState?.bundle || spyBundle || null),
          market_pulse: classifyMarketPulse({ spy: spyBundle, qqq: qqqBundle, iwm: iwmBundle }, vixPx),
          vix_bucket: classifyVixBucket(vixPx),
          vix_value: Number.isFinite(vixPx) ? rnd(vixPx, 2) : null,
          rvol_bucket: classifyRvolBucket(ownDailyState?.bundle || null),
        };
        context.market_state = [context.market_pulse, context.regime].filter(Boolean).join('_') || null;
        move.context = context;
        for (const sig of move.signals) {
          const tfCanonical = {};
          for (const tfLabel of ['10', '30', '1H', 'D', 'W']) {
            const state = tfLabel === 'D' ? getTfState('D', sig.ts) : getTfState(tfLabel, sig.ts);
            if (state?.snapshot) tfCanonical[tfLabel] = state.snapshot;
          }
          sig.tf_canonical = Object.keys(tfCanonical).length ? tfCanonical : null;
          sig.market_context = context;
          canonicalEnriched++;
        }
        move.move_json = buildCanonicalMovePayload(move);
      }
    }

    if ((bi / TICKER_BATCH) % 3 === 0) {
      process.stdout.write(`
  [${elapsed()}] ${Math.min(bi + TICKER_BATCH, tickers.length)}/${tickers.length} tickers (${canonicalEnriched} canonical snapshots)...`);
    }
  }
  console.log(`
  [${elapsed()}] ${canonicalEnriched} canonical phase snapshots enriched
`);

  // ── Step 3: Classify ticker personalities ───────────────────────────────

  console.log(`${B}═══ Step 3: Classify Ticker Personalities ═══${RST}\n`);

  for (const [ticker, stats] of Object.entries(tickerStats)) {
    let personality = "MODERATE";

    if (stats.avg_atr_pct > 3.0 && stats.avg_move_pct > 15) {
      personality = "VOLATILE_RUNNER";
    } else if (stats.avg_atr_pct > 2.0 && stats.avg_pullback_pct > 5) {
      personality = "PULLBACK_PLAYER";
    } else if (stats.avg_duration >= 30 && stats.avg_move_pct < 10) {
      personality = "SLOW_GRINDER";
    } else if (stats.avg_atr_pct > 2.5) {
      personality = "VOLATILE";
    } else if (stats.avg_pullback_pct < 2 && stats.avg_move_pct > 8) {
      personality = "CLEAN_RUNNER";
    } else if (stats.ema_aligned_rate > 70) {
      personality = "TREND_FOLLOWER";
    }

    stats.personality = personality;
  }

  // Personality distribution
  const personalityCounts = {};
  for (const s of Object.values(tickerStats)) {
    personalityCounts[s.personality] = (personalityCounts[s.personality] || 0) + 1;
  }
  for (const [p, c] of Object.entries(personalityCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${p.padEnd(20)} ${c} tickers`);
  }
  console.log();

  // Top volatile runners
  const runners = Object.entries(tickerStats)
    .filter(([, s]) => s.personality === "VOLATILE_RUNNER" || s.personality === "VOLATILE")
    .sort((a, b) => b[1].avg_atr_pct - a[1].avg_atr_pct)
    .slice(0, 10);
  if (runners.length) {
    console.log(`  ${B}Top Volatile Tickers:${RST}`);
    for (const [t, s] of runners) {
      console.log(`    ${t.padEnd(8)} avg_move=${s.avg_move_pct}%  atr_pct=${s.avg_atr_pct}%  pullback=${s.avg_pullback_pct}%  personality=${s.personality}`);
    }
    console.log();
  }

  // ── Step 4: Write to D1 ─────────────────────────────────────────────────

  if (DRY_RUN) {
    console.log(`${B}═══ DRY RUN — skipping D1 writes ═══${RST}\n`);
    console.log(`  Would write: ${allMoves.length} moves + ${allMoves.length * 5} signals\n`);

    // Save local report
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 15);
    const report = {
      generated: new Date().toISOString(),
      since: SINCE_DATE,
      min_atr: MIN_ATR_MULT,
      summary: {
        total_moves: allMoves.length,
        tickers: Object.keys(tickerStats).length,
        up: allMoves.filter(m => m.direction === "UP").length,
        down: allMoves.filter(m => m.direction === "DOWN").length,
      },
      personalities: tickerStats,
      moves_sample: allMoves.slice(0, 50),
    };
    const outPath = path.join(__dirname, "..", "data", `ticker-learning-${ts}.json`);
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.log(`  ${G}Report saved:${RST} ${outPath}\n`);
    return;
  }

  console.log(`${B}═══ Step 4: Writing to D1 (chunked SQL files) ═══${RST}\n`);

  const sqlDir = path.join(__dirname, "..", "data");
  let movesWritten = 0;
  let signalsWritten = 0;
  const now = Date.now();
  const personality = (t) => tickerStats[t]?.personality || "MODERATE";

  execD1(`ALTER TABLE ticker_moves ADD COLUMN move_json TEXT`);

  // Clear existing data
  console.log(`  [${elapsed()}] Clearing old data${TICKER_FILTER ? ` for ${TICKER_FILTER}` : ""}...`);
  if (TICKER_FILTER) {
    execD1(`DELETE FROM ticker_move_signals WHERE move_id IN (SELECT id FROM ticker_moves WHERE ticker='${TICKER_FILTER}')`);
    execD1(`DELETE FROM ticker_moves WHERE ticker='${TICKER_FILTER}'`);
  } else {
    execD1(`DELETE FROM ticker_move_signals`);
    execD1(`DELETE FROM ticker_moves`);
  }

  const MOVE_ROWS_PER_INSERT = 1;
  const SIG_ROWS_PER_INSERT = 5;
  const MOVE_STMTS_PER_FILE = 4;
  const SIG_STMTS_PER_FILE = 4;

  const moveStatements = [];
  const signalStatements = [];

  for (let i = 0; i < allMoves.length; i += MOVE_ROWS_PER_INSERT) {
    const batch = allMoves.slice(i, i + MOVE_ROWS_PER_INSERT);
    const moveValues = batch.map(m => {
      const moveJson = JSON.stringify(m.move_json || buildCanonicalMovePayload(m)).replace(/'/g, "''");
      return `('${m.id}','${m.ticker}','${m.direction}',${m.start_ts},${m.end_ts},${m.peak_ts},${m.duration_days},${m.move_pct},${m.move_atr},${m.start_price},${m.end_price},${m.peak_price},${m.atr_at_start},${m.max_pullback_pct},${m.pullback_count},${m.rsi_at_start},${m.ema_aligned},'${m.ema_state}','${personality(m.ticker)}','${moveJson}',${now})`;
    }).join(",");
    moveStatements.push(`INSERT INTO ticker_moves (id,ticker,direction,start_ts,end_ts,peak_ts,duration_days,move_pct,move_atr,start_price,end_price,peak_price,atr_at_start,max_pullback_pct,pullback_count,rsi_at_start,ema_aligned,ema_state,personality,move_json,created_at) VALUES ${moveValues}`);
    movesWritten += batch.length;
  }

  for (const m of allMoves) {
    for (const s of m.signals) {
      const sId = uid();
      const sigJson = JSON.stringify({
        st_dir: s.st_dir_d, rsi: s.rsi_d, atr: s.atr_d,
        ema21: s.ema21_d, ema48: s.ema48_d, ema_cross: s.ema_cross_d,
        ichimoku_d: s.ichimoku_d ?? null,
        rsi_30m: s.rsi_30m ?? null, st_dir_30m: s.st_dir_30m ?? null,
        ichimoku_30m: s.ichimoku_30m ?? null,
        rsi_w: s.rsi_w ?? null, st_dir_w: s.st_dir_w ?? null,
        ema21_w: s.ema21_w ?? null, ema48_w: s.ema48_w ?? null,
        ema_cross_w: s.ema_cross_w ?? null,
        ichimoku_w: s.ichimoku_w ?? null,
        canonical_phase: s.phase,
        market_context: s.market_context || null,
        tf_canonical: s.tf_canonical || null,
      }).replace(/'/g, "''");
      signalStatements.push(`INSERT INTO ticker_move_signals (id,move_id,phase,phase_pct,ts,rsi_d,rsi_30m,st_dir_d,st_dir_30m,st_slope_d,atr_d,ema21_d,ema48_d,ema_cross_d,price,signals_json) VALUES ('${sId}','${m.id}','${s.phase}',${s.phase_pct},${s.ts},${s.rsi_d ?? "NULL"},${s.rsi_30m ?? "NULL"},${s.st_dir_d ?? "NULL"},${s.st_dir_30m ?? "NULL"},NULL,${s.atr_d ?? "NULL"},${s.ema21_d ?? "NULL"},${s.ema48_d ?? "NULL"},${s.ema_cross_d ?? "NULL"},${rnd(s.price, 4)},'${sigJson}')`);
      signalsWritten += 1;
    }
  }
  const batchedSignalStatements = [];
  for (let si = 0; si < signalStatements.length; si += SIG_ROWS_PER_INSERT) {
    batchedSignalStatements.push(signalStatements.slice(si, si + SIG_ROWS_PER_INSERT).join(";\n"));
  }

  console.log(`  [${elapsed()}] ${moveStatements.length + batchedSignalStatements.length} SQL statements → move/signals chunk files`);
  console.log(`  Moves: ${movesWritten}  Signals: ${signalsWritten}\n`);

  const moveChunkStats = runStatementChunks(moveStatements, { sqlDir, filePrefix: '_tl_moves', chunkSize: MOVE_STMTS_PER_FILE, timeoutMs: 180000, retries: 2 });
  console.log();
  const signalChunkStats = runStatementChunks(batchedSignalStatements, { sqlDir, filePrefix: '_tl_signals', chunkSize: SIG_STMTS_PER_FILE, timeoutMs: 180000, retries: 2 });
  console.log(`\n\n  ${G}D1 writes complete:${RST} ${moveChunkStats.ok + signalChunkStats.ok}/${moveChunkStats.total + signalChunkStats.total} chunks ok, ${moveChunkStats.fail + signalChunkStats.fail} failed`);
  console.log(`  ${movesWritten} moves + ${signalsWritten} signals\n`);

  // ── Step 5: Summary ─────────────────────────────────────────────────────

  console.log(`${B}═══ Summary ═══${RST}\n`);

  const avgMovePct = allMoves.reduce((s, m) => s + Math.abs(m.move_pct), 0) / allMoves.length;
  const avgMoveAtr = allMoves.reduce((s, m) => s + m.move_atr, 0) / allMoves.length;
  const emaAlignedPct = pct(allMoves.filter(m => m.ema_aligned).length, allMoves.length);

  console.log(`  Total moves:       ${allMoves.length}`);
  console.log(`  Unique tickers:    ${Object.keys(tickerStats).length}`);
  console.log(`  Avg move size:     ${rnd(avgMovePct)}% (${rnd(avgMoveAtr)} ATR)`);
  console.log(`  EMA aligned:       ${emaAlignedPct}%`);
  console.log(`  Personality dist:  ${JSON.stringify(personalityCounts)}`);
  console.log();

  // Save local report
  const tsStr = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 15);
  const report = {
    generated: new Date().toISOString(),
    since: SINCE_DATE,
    min_atr: MIN_ATR_MULT,
    summary: {
      total_moves: allMoves.length,
      tickers: Object.keys(tickerStats).length,
      moves_written: movesWritten,
      signals_written: signalsWritten,
      up: allMoves.filter(m => m.direction === "UP").length,
      down: allMoves.filter(m => m.direction === "DOWN").length,
      avg_move_pct: rnd(avgMovePct),
      avg_move_atr: rnd(avgMoveAtr),
      ema_aligned_pct: emaAlignedPct,
    },
    personality_distribution: personalityCounts,
    ticker_profiles: tickerStats,
  };
  const outPath = path.join(__dirname, "..", "data", `ticker-learning-${tsStr}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`  ${G}Report saved:${RST} ${outPath}`);
  console.log(`  ${G}Runtime:${RST} ${elapsed()}\n`);
}

main().catch(e => {
  console.error("Fatal:", e);
  process.exit(1);
});
