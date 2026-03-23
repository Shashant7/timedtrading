#!/usr/bin/env node
// scripts/mfe-peak-autopsy.js
//
// Reconstructs signal snapshots at MFE peak for completed backtest trades.
// For each trade with MFE >= 1%, finds the candle bar at peak price,
// recomputes indicators (RSI, Phase, TD9, SuperTrend, Cloud) at that timestamp.
//
// Usage:
//   node scripts/mfe-peak-autopsy.js --run <artifact-dir-name>
//   node scripts/mfe-peak-autopsy.js --run 10m-ltf-validation--2026-03-20T0108 --min-mfe 0.5
//   node scripts/mfe-peak-autopsy.js --all   # process all three comparison runs

import Database from "better-sqlite3";
import { existsSync, readFileSync } from "fs";
import { writeFile } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { performance } from "perf_hooks";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, "..");
const ARTIFACTS = join(ROOT, "data", "backtest-artifacts");

import { computeTfBundle, assembleTickerData, computeTDSequentialMultiTF } from "../worker/indicators.js";

// ── CLI ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) { out[key] = true; }
      else { out[key] = next; i++; }
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const MIN_MFE = Number(args["min-mfe"]) || 1.0;
const LEADING_LTF = args.ltf || "10";

const COMPARISON_RUNS = [
  "10m-ltf-validation--2026-03-20T0108",
  "legacy-baseline--2026-03-20T0156",
  "tt-core-context-v1--2026-03-20T0205",
];

const runDirs = args.all
  ? COMPARISON_RUNS
  : args.run
    ? [args.run]
    : [];

if (runDirs.length === 0) {
  console.error("Usage: node scripts/mfe-peak-autopsy.js --run <dir> | --all");
  process.exit(1);
}

// ── Database ────────────────────────────────────────────────────────────────
const DB_PATH = join(ROOT, "data", "timed-local.db");
if (!existsSync(DB_PATH)) {
  console.error(`Database not found: ${DB_PATH}`);
  process.exit(1);
}
const db = new Database(DB_PATH, { readonly: true });
db.pragma("cache_size = -200000");

const stmtCandles = db.prepare(
  "SELECT ts, o, h, l, c, v FROM ticker_candles WHERE ticker = ? AND tf = ? AND ts <= ? ORDER BY ts ASC LIMIT ?"
);

const stmtFindPeak = db.prepare(
  `SELECT ts, o, h, l, c FROM ticker_candles
   WHERE ticker = ? AND tf = ? AND ts >= ? AND ts <= ?
   ORDER BY ts ASC`
);

function getCandles(ticker, tf, beforeTs, limit) {
  return stmtCandles.all(ticker, tf, beforeTs, limit);
}

const TF_CONFIGS = [
  { tf: "D",   limit: 600 },
  { tf: "240", limit: 500 },
  { tf: "60",  limit: 500 },
  { tf: "30",  limit: 500 },
  { tf: LEADING_LTF, limit: 600 },
];

// ── Find MFE peak bar ──────────────────────────────────────────────────────
function findPeakBar(ticker, direction, entryPrice, mfePct, entryTs, holdHoursRaw) {
  const holdHours = holdHoursRaw || 120;
  const holdMs = holdHours * 3600000;
  const exitTs = entryTs + holdMs;

  const isLong = direction === "LONG";
  const peakPrice = isLong
    ? entryPrice * (1 + mfePct / 100)
    : entryPrice * (1 - mfePct / 100);

  const bars = stmtFindPeak.all(ticker, LEADING_LTF, entryTs, exitTs);
  if (!bars.length) return null;

  let bestBar = bars[0];
  let bestDist = Math.abs(bars[0].h - peakPrice);

  for (const bar of bars) {
    const candidatePrice = isLong ? bar.h : bar.l;
    const dist = Math.abs(candidatePrice - peakPrice);
    if (dist < bestDist) {
      bestDist = dist;
      bestBar = bar;
    }
  }

  const barsFromEntry = bars.indexOf(bestBar);
  const hoursToMfe = (bestBar.ts - entryTs) / 3600000;

  return { ts: bestBar.ts, price: isLong ? bestBar.h : bestBar.l, barsFromEntry, hoursToMfe };
}

// ── Compute signal snapshot at a timestamp ──────────────────────────────────
function computeSignalsAt(ticker, ts) {
  const bundles = {};
  for (const cfg of TF_CONFIGS) {
    const candles = getCandles(ticker, cfg.tf, ts, cfg.limit);
    if (candles.length >= 50) {
      bundles[cfg.tf] = computeTfBundle(candles);
    }
  }

  if (!bundles["D"]) return null;

  const bD = bundles["D"];
  const b4H = bundles["240"];
  const b1H = bundles["60"];
  const b30 = bundles["30"];
  const bLtf = bundles[LEADING_LTF];

  const rsiVal = (b) => b && Number.isFinite(b.rsi) ? Math.round(b.rsi * 10) / 10 : null;
  const phaseVal = (b) => b?.satyPhase?.value ?? null;
  const phaseZone = (b) => b?.satyPhase?.zone ?? null;
  const phaseLeaving = (b) => b?.satyPhase?.leaving ?? null;

  const snapshot = {
    rsi_D: rsiVal(bD),
    rsi_4H: rsiVal(b4H),
    rsi_1H: rsiVal(b1H),
    rsi_30: rsiVal(b30),
    rsi_ltf: rsiVal(bLtf),

    phase_D: phaseVal(bD),
    phase_D_zone: phaseZone(bD),
    phase_D_leaving: phaseLeaving(bD),
    phase_1H: phaseVal(b1H),
    phase_1H_zone: phaseZone(b1H),
    phase_1H_leaving: phaseLeaving(b1H),
    phase_30: phaseVal(b30),
    phase_30_zone: phaseZone(b30),

    st_D: bD?.stDir ?? null,
    st_4H: b4H?.stDir ?? null,
    st_1H: b1H?.stDir ?? null,
    st_30: b30?.stDir ?? null,
    st_ltf: bLtf?.stDir ?? null,

    ema_depth_D: bD?.emaDepth ?? null,
    ema_depth_4H: b4H?.emaDepth ?? null,
    ema_depth_1H: b1H?.emaDepth ?? null,
    ema_structure_D: bD?.emaStructure != null ? Math.round(bD.emaStructure * 1000) / 1000 : null,
    ema_momentum_1H: b1H?.emaMomentum != null ? Math.round(b1H.emaMomentum * 1000) / 1000 : null,

    cloud_c5_12_D: bD?.ripsterClouds?.c5_12 ?? null,
    cloud_c34_50_D: bD?.ripsterClouds?.c34_50 ?? null,
    cloud_c5_12_1H: b1H?.ripsterClouds?.c5_12 ?? null,
    cloud_c34_50_1H: b1H?.ripsterClouds?.c34_50 ?? null,

    atr_D: bD?.atr14 != null ? Math.round(bD.atr14 * 100) / 100 : null,
    atr_ratio_D: bD?.atrRatio != null ? Math.round(bD.atrRatio * 100) / 100 : null,

    phase_osc_D: bD?.phaseOsc != null ? Math.round(bD.phaseOsc * 10) / 10 : null,
    phase_osc_1H: b1H?.phaseOsc != null ? Math.round(b1H.phaseOsc * 10) / 10 : null,
  };

  // TD Sequential - use production function
  const dCandles = getCandles(ticker, "D", ts, 200);
  const h1Candles = getCandles(ticker, "60", ts, 200);
  if (dCandles.length >= 20) {
    const tdD = computeTDSeq(dCandles);
    snapshot.td_D_bull_prep = tdD.bullish_prep_count;
    snapshot.td_D_bear_prep = tdD.bearish_prep_count;
    snapshot.td_D_td9_bull = tdD.bullish_prep_count === 9;
    snapshot.td_D_td9_bear = tdD.bearish_prep_count === 9;
  }
  if (h1Candles.length >= 20) {
    const td1H = computeTDSeq(h1Candles);
    snapshot.td_1H_bull_prep = td1H.bullish_prep_count;
    snapshot.td_1H_bear_prep = td1H.bearish_prep_count;
    snapshot.td_1H_td9_bull = td1H.bullish_prep_count === 9;
    snapshot.td_1H_td9_bear = td1H.bearish_prep_count === 9;
  }

  return snapshot;
}

// TD Sequential: track prep count (close vs close[4] ago)
function computeTDSeq(candles) {
  const PREP_COMP = 4;
  let bullPrep = 0, bearPrep = 0;

  for (let i = PREP_COMP; i < candles.length; i++) {
    const c = candles[i].c;
    const cComp = candles[i - PREP_COMP].c;

    if (c < cComp) { bullPrep++; bearPrep = 0; }
    else if (c > cComp) { bearPrep++; bullPrep = 0; }
    else { bullPrep = 0; bearPrep = 0; }
  }

  return { bullish_prep_count: bullPrep, bearish_prep_count: bearPrep };
}

// ── Would production exits fire? ────────────────────────────────────────────
function wouldExitsFire(trade, s) {
  const isLong = trade.direction === "LONG";
  const exits = {};

  // Hard RSI Fuse: RSI > 85 (LONG) or < 15 (SHORT) on 1H
  const rsi1H = s.rsi_1H;
  if (rsi1H != null) {
    exits.hard_fuse_rsi = isLong ? rsi1H > 85 : rsi1H < 15;
    exits.rsi_1H_at_peak = rsi1H;
  }

  // Soft RSI Fuse: RSI > 70 (LONG) or < 30 (SHORT) on 1H
  if (rsi1H != null) {
    exits.soft_fuse_rsi = isLong ? rsi1H > 70 : rsi1H < 30;
  }

  // Phase Leave: saty phase extreme zone + leaving signal on 1H
  const phase1H = s.phase_1H;
  if (phase1H != null) {
    const isExtreme = isLong ? phase1H > 100 : phase1H < -100;
    exits.phase_extreme_1H = isExtreme;
    exits.phase_1H_value = phase1H;
  }

  // Phase oscillator extreme on 1H (multi-factor phase)
  const phaseOsc1H = s.phase_osc_1H;
  if (phaseOsc1H != null) {
    exits.phase_osc_extreme_1H = Math.abs(phaseOsc1H) > 61.8;
    exits.phase_osc_1H_value = phaseOsc1H;
  }

  // Saty Phase leaving signal (zone exit in progress)
  const leaving1H = s.phase_1H_leaving;
  if (leaving1H) {
    exits.phase_leaving_1H = !!(leaving1H.leaving100 || leaving1H.leaving618);
  }

  // TD9 exhaustion: current prep count exactly 9 on daily (counter-trend signal)
  // For a LONG, bearish TD9 (9 consecutive closes > close[4]) = exhaustion
  exits.td9_daily_exhaustion = isLong
    ? s.td_D_td9_bear === true
    : s.td_D_td9_bull === true;

  exits.td9_1h_exhaustion = isLong
    ? s.td_1H_td9_bear === true
    : s.td_1H_td9_bull === true;

  // SuperTrend flip against direction on LTF
  const stLtf = s.st_ltf;
  if (stLtf != null && stLtf !== 0) {
    exits.st_ltf_against = isLong ? stLtf > 0 : stLtf < 0;
  }

  // SuperTrend 1H against
  const st1H = s.st_1H;
  if (st1H != null && st1H !== 0) {
    exits.st_1h_against = isLong ? st1H > 0 : st1H < 0;
  }

  // Cloud state against on 1H (c5_12 bearish for LONG)
  const cloud1H = s.cloud_c5_12_1H;
  if (cloud1H != null) {
    exits.cloud_1h_against = isLong ? cloud1H < 0 : cloud1H > 0;
  }

  // MFE safety trim would fire at >= 2% MFE
  exits.mfe_safety_trim = trade.mfe_pct >= 2;

  // Three-tier trim TP (0.618x Weekly ATR equivalent for first trim)
  const atrD = s.atr_D;
  if (atrD && trade.entry_price) {
    const swingATR = atrD * Math.sqrt(5);
    const trim1Dist = swingATR * 0.618;
    const trim1Price = isLong
      ? trade.entry_price + trim1Dist
      : trade.entry_price - trim1Dist;
    const peakPrice = isLong
      ? trade.entry_price * (1 + trade.mfe_pct / 100)
      : trade.entry_price * (1 - trade.mfe_pct / 100);
    exits.three_tier_trim1 = isLong ? peakPrice >= trim1Price : peakPrice <= trim1Price;
  }

  // EMA depth degradation: depth below 5 on 1H suggests momentum fading
  if (s.ema_depth_1H != null) {
    exits.ema_depth_shallow_1H = isLong ? s.ema_depth_1H < 5 : s.ema_depth_1H > 7;
    exits.ema_depth_1H_value = s.ema_depth_1H;
  }

  exits.any_exit_would_fire = Object.values(exits).some(v => v === true);

  return exits;
}

// ── Process a single run ────────────────────────────────────────────────────
async function processRun(runDirName) {
  const runPath = join(ARTIFACTS, runDirName);
  const tradesFile = join(runPath, "trades.json");

  if (!existsSync(tradesFile)) {
    console.error(`  trades.json not found in ${runDirName}`);
    return;
  }

  const trades = JSON.parse(readFileSync(tradesFile, "utf-8"));
  const eligible = trades.filter(t => t.mfe_pct >= MIN_MFE && t.entry_date < "2026-03");
  console.log(`  ${runDirName}: ${trades.length} total, ${eligible.length} eligible (MFE >= ${MIN_MFE}%, excl March)`);

  const results = [];
  let processed = 0;
  const start = performance.now();

  for (const trade of eligible) {
    const entryTs = new Date(trade.entry_date + "T14:30:00Z").getTime();
    const peak = findPeakBar(trade.ticker, trade.direction, trade.entry_price, trade.mfe_pct, entryTs, trade.hold_hours);

    if (!peak) {
      results.push({ trade_id: trade.id, ticker: trade.ticker, error: "no_peak_bar" });
      continue;
    }

    const signals = computeSignalsAt(trade.ticker, peak.ts);
    if (!signals) {
      results.push({ trade_id: trade.id, ticker: trade.ticker, error: "no_signals" });
      continue;
    }

    const exitAnalysis = wouldExitsFire(trade, signals);

    results.push({
      trade_id: trade.id,
      ticker: trade.ticker,
      direction: trade.direction,
      entry_price: trade.entry_price,
      entry_date: trade.entry_date,
      path: trade.path,
      status: trade.status,
      pnl: trade.pnl,
      pnl_pct: trade.pnl_pct,
      mfe_pct: trade.mfe_pct,
      mae_pct: trade.mae_pct,
      hold_hours: trade.hold_hours,
      exit_reason: trade.exit_reason,

      peak_ts: peak.ts,
      peak_price: peak.price,
      bars_to_peak: peak.barsFromEntry,
      hours_to_peak: Math.round(peak.hoursToMfe * 10) / 10,

      signals_at_peak: signals,
      exit_analysis: exitAnalysis,
    });

    processed++;
    if (processed % 25 === 0) {
      const elapsed = ((performance.now() - start) / 1000).toFixed(1);
      console.log(`    processed ${processed}/${eligible.length} (${elapsed}s)`);
    }
  }

  const outputPath = join(runPath, "trade-autopsy-signals.json");
  await writeFile(outputPath, JSON.stringify(results, null, 2));

  const elapsed = ((performance.now() - start) / 1000).toFixed(1);
  console.log(`  Done: ${processed} trades analyzed in ${elapsed}s → ${outputPath}`);

  // Summary statistics
  const withExits = results.filter(r => r.exit_analysis?.any_exit_would_fire);
  const gaveBack = results.filter(r => r.status === "LOSS" && r.mfe_pct >= 2);
  const gaveBackSaved = gaveBack.filter(r => r.exit_analysis?.any_exit_would_fire);
  const hardFuse = results.filter(r => r.exit_analysis?.hard_fuse_rsi);
  const softFuse = results.filter(r => r.exit_analysis?.soft_fuse_rsi);
  const phaseExtreme1H = results.filter(r => r.exit_analysis?.phase_extreme_1H);
  const phaseOscExtreme = results.filter(r => r.exit_analysis?.phase_osc_extreme_1H);
  const phaseLeaving = results.filter(r => r.exit_analysis?.phase_leaving_1H);
  const td9D = results.filter(r => r.exit_analysis?.td9_daily_exhaustion);
  const td91H = results.filter(r => r.exit_analysis?.td9_1h_exhaustion);
  const stLtfAgainst = results.filter(r => r.exit_analysis?.st_ltf_against);
  const st1HAgainst = results.filter(r => r.exit_analysis?.st_1h_against);
  const cloud1HAgainst = results.filter(r => r.exit_analysis?.cloud_1h_against);
  const mfeTrim = results.filter(r => r.exit_analysis?.mfe_safety_trim);
  const threeTier = results.filter(r => r.exit_analysis?.three_tier_trim1);
  const emaShallow = results.filter(r => r.exit_analysis?.ema_depth_shallow_1H);

  console.log(`\n  ── EXIT SIGNAL SUMMARY ──`);
  console.log(`  Trades with MFE >= ${MIN_MFE}%: ${results.length}`);
  console.log(`  At least one exit signal at peak: ${withExits.length} (${pct(withExits.length, results.length)}%)`);
  console.log(`  Gave-back (MFE>=2% → LOSS): ${gaveBack.length}, saved by any exit: ${gaveBackSaved.length}`);
  console.log(`  Hard RSI Fuse (>85/<15): ${hardFuse.length}`);
  console.log(`  Soft RSI Fuse (>70/<30): ${softFuse.length}`);
  console.log(`  Saty Phase Extreme 1H: ${phaseExtreme1H.length}`);
  console.log(`  Phase Osc Extreme 1H (|v|>61.8): ${phaseOscExtreme.length}`);
  console.log(`  Phase Leaving 1H: ${phaseLeaving.length}`);
  console.log(`  TD9 Daily Exhaustion: ${td9D.length}`);
  console.log(`  TD9 1H Exhaustion: ${td91H.length}`);
  console.log(`  ST LTF Against: ${stLtfAgainst.length}`);
  console.log(`  ST 1H Against: ${st1HAgainst.length}`);
  console.log(`  Cloud 1H Against: ${cloud1HAgainst.length}`);
  console.log(`  MFE Safety Trim (>=2%): ${mfeTrim.length}`);
  console.log(`  Three-Tier Trim1 (0.618x wkATR): ${threeTier.length}`);
  console.log(`  EMA Depth Shallow 1H: ${emaShallow.length}`);

  // Average hours-to-peak
  const validPeaks = results.filter(r => r.hours_to_peak != null && r.hours_to_peak > 0);
  if (validPeaks.length > 0) {
    const avgHours = validPeaks.reduce((s, r) => s + r.hours_to_peak, 0) / validPeaks.length;
    console.log(`  Avg hours to MFE peak: ${avgHours.toFixed(1)}h`);
    const medianHours = validPeaks.map(r => r.hours_to_peak).sort((a, b) => a - b)[Math.floor(validPeaks.length / 2)];
    console.log(`  Median hours to MFE peak: ${medianHours}h`);
  }

  return results;
}

function pct(n, d) { return d ? Math.round(n / d * 1000) / 10 : 0; }

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  MFE PEAK AUTOPSY`);
  console.log(`  Min MFE: ${MIN_MFE}% | LTF: ${LEADING_LTF}`);
  console.log(`${"═".repeat(60)}\n`);

  const allResults = {};

  for (const runDir of runDirs) {
    console.log(`\nProcessing: ${runDir}`);
    allResults[runDir] = await processRun(runDir);
  }

  if (runDirs.length > 1) {
    console.log(`\n${"═".repeat(60)}`);
    console.log(`  CROSS-RUN EXIT SIGNAL COMPARISON`);
    console.log(`${"═".repeat(60)}`);

    for (const [runDir, results] of Object.entries(allResults)) {
      if (!results) continue;
      const gaveBack = results.filter(r => r.status === "LOSS" && r.mfe_pct >= 2);
      const saved = gaveBack.filter(r => r.exit_analysis?.any_exit_would_fire);
      const totalLost = gaveBack.reduce((s, r) => s + Math.abs(r.pnl), 0);
      const savedPnl = saved.reduce((s, r) => s + Math.abs(r.pnl), 0);
      console.log(`\n  ${runDir}:`);
      console.log(`    Gave-back trades: ${gaveBack.length}, lost $${totalLost.toFixed(0)}`);
      console.log(`    Would be saved: ${saved.length}/${gaveBack.length} (recoverable $${savedPnl.toFixed(0)})`);
    }
  }

  console.log("\nDone.");
}

main().catch(e => { console.error(e); process.exit(1); });
