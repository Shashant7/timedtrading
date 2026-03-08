#!/usr/bin/env node
/**
 * discover-moves.js — Universe Move Discovery & Trade Capture Analysis
 *
 * Scans the entire ticker universe for ATR-relative breakouts/breakdowns,
 * traces what our indicators showed during each move, cross-references
 * with our trades to detect capture rate and churning.
 *
 * A "valid move" is ticker-relative: 3x ATR for most stocks, which means
 * ~2.5% for SPY but ~40% for a volatile small-cap. This normalizes across
 * the universe so every ticker's breakouts are comparable.
 *
 * Usage:
 *   USE_D1=1 node scripts/discover-moves.js [--since 2025-07-01] [--min-atr 3] [--ticker AAPL] [--upload]
 *
 * Output:
 *   data/move-discovery-YYYYMMDD-HHmmss.json
 *   Console report with capture analysis
 */

const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const args = process.argv.slice(2);
const getArg = (name, dflt) => {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : dflt;
};
const hasFlag = (name) => args.includes(`--${name}`);

const SINCE_DATE = getArg("since", "2025-07-01");
const SINCE_TS_MS = new Date(SINCE_DATE + "T00:00:00Z").getTime();
const MIN_ATR_MULT = Number(getArg("min-atr", "3"));
const TICKER_FILTER = getArg("ticker", null);
const UPLOAD = hasFlag("upload");
const WINDOWS = [5, 10, 20, 40, 60];
const MIN_DURATION = 3;

const API_BASE = process.env.API_BASE || "https://timed-trading-ingest.shashant.workers.dev";
const API_KEY = process.env.TIMED_API_KEY || process.env.API_KEY || "AwesomeSauce";
const WORKER_DIR = path.join(__dirname, "../worker");
const LOCAL_DB_PATH = path.join(__dirname, "../data/timed-local.db");
const USE_D1 = process.env.USE_D1 === "1" || process.env.USE_D1 === "true";

let db = null;
if (!USE_D1) {
  try {
    const Database = require("better-sqlite3");
    db = new Database(LOCAL_DB_PATH, { readonly: true });
  } catch (e) {
    console.error("Local DB not found. Use USE_D1=1 or run ./scripts/export-d1.sh first.");
    process.exit(1);
  }
}

// ── DB helpers (same as calibrate.js) ──────────────────────────────────────

function query(sql) {
  if (db) return db.prepare(sql).all();
  return queryD1(sql);
}

function queryChunked(baseSql, chunkSize = 15000) {
  let all = [];
  let offset = 0;
  while (true) {
    const rows = query(`${baseSql} LIMIT ${chunkSize} OFFSET ${offset}`);
    all = all.concat(rows);
    if (rows.length < chunkSize) break;
    offset += chunkSize;
  }
  return all;
}

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

// ── Math helpers ───────────────────────────────────────────────────────────

function computeATR(candles, period = 14) {
  const atrs = new Array(candles.length).fill(0);
  for (let i = 1; i < candles.length; i++) {
    const tr = Math.max(candles[i].h - candles[i].l, Math.abs(candles[i].h - candles[i - 1].c), Math.abs(candles[i].l - candles[i - 1].c));
    if (i < period) atrs[i] = atrs[i - 1] + (tr - atrs[i - 1]) / i;
    else atrs[i] = atrs[i - 1] + (tr - atrs[i - 1]) / period;
  }
  return atrs;
}

function emaArr(arr, period) {
  const k = 2 / (period + 1);
  const out = [arr[0]];
  for (let i = 1; i < arr.length; i++) out.push(arr[i] * k + out[i - 1] * (1 - k));
  return out;
}

function computeRSI(closes, period = 14) {
  const rsi = new Array(closes.length).fill(50);
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= Math.min(period, closes.length - 1); i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d; else avgLoss += Math.abs(d);
  }
  avgGain /= period; avgLoss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? Math.abs(d) : 0)) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}

function findNearest(rows, tsField, targetTs, maxDistMs) {
  let closest = null, minDist = Infinity;
  for (const r of rows) {
    const d = Math.abs(Number(r[tsField]) - targetTs);
    if (d < minDist) { minDist = d; closest = r; }
  }
  return closest && minDist < maxDistMs ? closest : null;
}

function rnd(v, dp = 2) { return Math.round(v * Math.pow(10, dp)) / Math.pow(10, dp); }
function pct(n, d) { return d > 0 ? rnd(n / d * 100, 1) : 0; }
function dateStr(ts) { return new Date(ts > 1e12 ? ts : ts * 1000).toISOString().slice(0, 10); }

const t0 = Date.now();
function elapsed() { return `${((Date.now() - t0) / 1000).toFixed(1)}s`; }

const B = "\x1b[1m", G = "\x1b[32m", R = "\x1b[31m", Y = "\x1b[33m", C = "\x1b[36m", RST = "\x1b[0m";

// ════════════════════════════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════════════════════════════

console.log(`\n${B}╔══════════════════════════════════════════════════════════════╗${RST}`);
console.log(`${B}║   Move Discovery & Trade Capture Analysis                    ║${RST}`);
console.log(`${B}╚══════════════════════════════════════════════════════════════╝${RST}\n`);
console.log(`  Source: ${USE_D1 ? "D1 (worker)" : "local SQLite"}`);
console.log(`  Since: ${SINCE_DATE}  |  Min ATR: ${MIN_ATR_MULT}x  |  Windows: ${WINDOWS.join(", ")}d`);
console.log(`  Ticker: ${TICKER_FILTER || "ALL"}\n`);

// ── Step 1: Load daily candles ─────────────────────────────────────────────

console.log(`${B}═══ Step 1: Loading Data ═══${RST}\n`);
console.log(`  [${elapsed()}] Fetching daily candles...`);

const tickerWhere = TICKER_FILTER ? `AND ticker='${TICKER_FILTER}'` : "";
const rawCandles = queryChunked(
  `SELECT ticker, ts, o, h, l, c, v FROM ticker_candles WHERE tf='D' ${tickerWhere} ORDER BY ticker, ts`
);
console.log(`  [${elapsed()}] ${rawCandles.length} daily candles loaded`);

const byTicker = {};
for (const c of rawCandles) {
  const ts = Number(c.ts);
  const tsMs = ts > 1e12 ? ts : ts * 1000;
  if (tsMs < SINCE_TS_MS) continue;
  const t = String(c.ticker).toUpperCase();
  (byTicker[t] = byTicker[t] || []).push({
    ts: tsMs, o: Number(c.o), h: Number(c.h), l: Number(c.l), c: Number(c.c), v: Number(c.v || 0),
  });
}
for (const t of Object.keys(byTicker)) byTicker[t].sort((a, b) => a.ts - b.ts);

const tickers = Object.keys(byTicker).filter(t => byTicker[t].length >= 20);
console.log(`  ${tickers.length} tickers with sufficient history\n`);

// ── Step 2: Load trail_5m_facts for indicator enrichment ───────────────────

console.log(`  [${elapsed()}] Fetching trail_5m_facts (batched)...`);
const trailByTicker = {};
const BATCH_SZ = 15;
for (let b = 0; b < tickers.length; b += BATCH_SZ) {
  const batch = tickers.slice(b, b + BATCH_SZ);
  const inClause = batch.map(t => `'${t}'`).join(",");
  const rows = queryChunked(
    `SELECT ticker, bucket_ts, htf_score_avg, ltf_score_avg, state, rank,
            completion, phase_pct, had_squeeze_release, had_ema_cross,
            had_st_flip, had_momentum_elite, ema_regime_D, pdz_zone, pdz_pct,
            kanban_stage_end
     FROM trail_5m_facts WHERE ticker IN (${inClause}) ORDER BY ticker, bucket_ts`
  );
  for (const r of rows) {
    const t = String(r.ticker).toUpperCase();
    (trailByTicker[t] = trailByTicker[t] || []).push(r);
  }
  process.stdout.write(`\r  trail: ${Math.min(b + BATCH_SZ, tickers.length)}/${tickers.length} tickers...`);
}
console.log(`\n  [${elapsed()}] Trail tickers loaded: ${Object.keys(trailByTicker).length}\n`);

// ── Step 3: Load trades for matching ──────────────────────────────────────

console.log(`  [${elapsed()}] Fetching trades...`);
const tradesRaw = queryChunked(
  `SELECT trade_id, ticker, direction, entry_ts, exit_ts, entry_price, exit_price,
          pnl_pct, status, exit_reason, rank, rr
   FROM trades WHERE status IN ('WIN','LOSS','FLAT') AND entry_ts >= ${Math.floor(SINCE_TS_MS / 1000)}
   ORDER BY ticker, entry_ts`
);
console.log(`  [${elapsed()}] ${tradesRaw.length} closed trades loaded\n`);

const tradesByTicker = {};
for (const t of tradesRaw) {
  const sym = String(t.ticker).toUpperCase();
  (tradesByTicker[sym] = tradesByTicker[sym] || []).push({
    ...t,
    entry_ts: Number(t.entry_ts) > 1e12 ? Number(t.entry_ts) : Number(t.entry_ts) * 1000,
    exit_ts: Number(t.exit_ts) > 1e12 ? Number(t.exit_ts) : Number(t.exit_ts) * 1000,
    entry_price: Number(t.entry_price),
    exit_price: Number(t.exit_price),
    pnl_pct: Number(t.pnl_pct) || 0,
  });
}

// ════════════════════════════════════════════════════════════════════════════
// Step 4: DISCOVER MOVES
// ════════════════════════════════════════════════════════════════════════════

console.log(`${B}═══ Step 2: Discovering Moves (>= ${MIN_ATR_MULT}x ATR) ═══${RST}\n`);

let allMoves = [];

for (const ticker of tickers) {
  const candles = byTicker[ticker];
  const atrs = computeATR(candles);
  const closes = candles.map(c => c.c);
  const rsi = computeRSI(closes);
  const ema8 = emaArr(closes, 8);
  const ema21 = emaArr(closes, 21);
  const ema50 = emaArr(closes, 50);

  for (let window of WINDOWS) {
    for (let i = window; i < candles.length; i++) {
      const startIdx = i - window;
      const atr = atrs[startIdx] || atrs[Math.max(0, startIdx - 1)];
      if (!atr || atr <= 0) continue;

      const startPrice = candles[startIdx].c;
      const endPrice = candles[i].c;
      if (startPrice <= 0) continue;

      const movePct = ((endPrice - startPrice) / startPrice) * 100;
      const moveAtr = Math.abs(endPrice - startPrice) / atr;

      if (moveAtr < MIN_ATR_MULT) continue;

      const direction = movePct > 0 ? "UP" : "DOWN";

      // Find intra-move peak and trough
      let peakPrice = startPrice, troughPrice = startPrice;
      let peakIdx = startIdx, troughIdx = startIdx;
      let maxPullbackPct = 0;
      let pullbackCount = 0;
      let prevHigh = startPrice;

      for (let j = startIdx + 1; j <= i; j++) {
        if (candles[j].h > peakPrice) { peakPrice = candles[j].h; peakIdx = j; }
        if (candles[j].l < troughPrice) { troughPrice = candles[j].l; troughIdx = j; }

        if (direction === "UP") {
          const pullback = prevHigh > 0 ? (prevHigh - candles[j].l) / prevHigh * 100 : 0;
          if (pullback > maxPullbackPct) maxPullbackPct = pullback;
          if (pullback > atr / startPrice * 100) pullbackCount++;
          prevHigh = Math.max(prevHigh, candles[j].h);
        } else {
          const pullback = candles[j].h > 0 ? (candles[j].h - troughPrice) / troughPrice * 100 : 0;
          if (pullback > maxPullbackPct) maxPullbackPct = pullback;
        }
      }

      // EMA alignment at move start
      const e8 = ema8[startIdx], e21v = ema21[startIdx], e50v = ema50[startIdx];
      const emaAligned = direction === "UP"
        ? (e8 > e21v && e21v > e50v)
        : (e8 < e21v && e21v < e50v);

      // Trail indicator snapshots at 5 lifecycle points
      const lifecyclePoints = [0, 0.25, 0.5, 0.75, 1.0];
      const indicators = [];
      const trail = trailByTicker[ticker];

      for (const pctPoint of lifecyclePoints) {
        const candleIdx = Math.min(startIdx + Math.round(window * pctPoint), i);
        const targetTs = candles[candleIdx].ts;

        let snapshot = { pct_through: pctPoint, ts: targetTs, date: dateStr(targetTs) };

        if (trail) {
          const nearest = findNearest(trail, "bucket_ts", targetTs, 7 * 86400000);
          if (nearest) {
            snapshot = {
              ...snapshot,
              htf_score: rnd(Number(nearest.htf_score_avg) || 0, 1),
              ltf_score: rnd(Number(nearest.ltf_score_avg) || 0, 1),
              state: nearest.state || "unknown",
              rank: Number(nearest.rank) || 0,
              completion: rnd(Number(nearest.completion) || 0),
              phase_pct: rnd(Number(nearest.phase_pct) || 0),
              squeeze_release: nearest.had_squeeze_release ? 1 : 0,
              ema_cross: nearest.had_ema_cross ? 1 : 0,
              st_flip: nearest.had_st_flip ? 1 : 0,
              momentum_elite: nearest.had_momentum_elite ? 1 : 0,
              ema_regime: nearest.ema_regime_D != null ? Number(nearest.ema_regime_D) : null,
              pdz_zone: nearest.pdz_zone || null,
              kanban: nearest.kanban_stage_end || null,
            };
          }
        }
        indicators.push(snapshot);
      }

      allMoves.push({
        ticker,
        direction,
        window,
        start_ts: candles[startIdx].ts,
        start_date: dateStr(candles[startIdx].ts),
        end_ts: candles[i].ts,
        end_date: dateStr(candles[i].ts),
        peak_ts: candles[direction === "UP" ? peakIdx : troughIdx].ts,
        peak_date: dateStr(candles[direction === "UP" ? peakIdx : troughIdx].ts),
        duration_days: window,
        move_pct: rnd(movePct),
        move_atr: rnd(moveAtr),
        start_price: rnd(startPrice),
        end_price: rnd(endPrice),
        peak_price: rnd(direction === "UP" ? peakPrice : troughPrice),
        atr_at_start: rnd(atr),
        atr_pct: rnd(atr / startPrice * 100),
        max_pullback_pct: rnd(maxPullbackPct),
        pullback_count: pullbackCount,
        rsi_at_start: rnd(rsi[startIdx], 0),
        ema_aligned: emaAligned,
        ema_state: e8 > e21v ? (e21v > e50v ? "BULL_ALIGNED" : "BULL_CROSS") : (e21v < e50v ? "BEAR_ALIGNED" : "BEAR_CROSS"),
        indicators,
      });
    }
  }
}

// Dedup: keep largest move per ticker:direction per 5-day bucket
allMoves.sort((a, b) => b.move_atr - a.move_atr);
const seen = new Set();
const moves = [];
for (const m of allMoves) {
  const bucket = Math.floor(m.start_ts / (5 * 86400000));
  const key = `${m.ticker}:${m.direction}:${bucket}`;
  if (seen.has(key)) continue;
  seen.add(key);
  seen.add(`${m.ticker}:${m.direction}:${bucket - 1}`);
  seen.add(`${m.ticker}:${m.direction}:${bucket + 1}`);
  moves.push(m);
}

console.log(`  Discovered: ${allMoves.length} raw moves → ${moves.length} after dedup`);
console.log(`  UP: ${moves.filter(m => m.direction === "UP").length}  |  DOWN: ${moves.filter(m => m.direction === "DOWN").length}`);
if (moves.length) {
  const avgAtr = moves.reduce((s, m) => s + m.move_atr, 0) / moves.length;
  const avgPct = moves.reduce((s, m) => s + Math.abs(m.move_pct), 0) / moves.length;
  console.log(`  Avg size: ${rnd(avgAtr)} ATR  (${rnd(avgPct)}%)`);
  console.log(`  Unique tickers: ${new Set(moves.map(m => m.ticker)).size}`);
}
console.log();

// ════════════════════════════════════════════════════════════════════════════
// Step 5: MATCH TRADES TO MOVES
// ════════════════════════════════════════════════════════════════════════════

console.log(`${B}═══ Step 3: Trade Matching & Churning Detection ═══${RST}\n`);

let fullCapture = 0, partialCapture = 0, missed = 0, churned = 0;
const churnDetails = [];

for (const move of moves) {
  const trades = tradesByTicker[move.ticker] || [];
  const moveDir = move.direction === "UP" ? "LONG" : "SHORT";

  // Find trades that overlap with this move's time window
  const overlapping = trades.filter(t => {
    const dir = String(t.direction || "").toUpperCase();
    if (dir !== moveDir && dir !== move.direction) return false;
    return t.entry_ts >= move.start_ts - 2 * 86400000 && t.entry_ts <= move.end_ts + 2 * 86400000;
  });

  if (overlapping.length === 0) {
    move.capture = "MISSED";
    missed++;
    continue;
  }

  if (overlapping.length >= 2) {
    move.capture = "CHURNED";
    churned++;

    const individualPnl = overlapping.reduce((s, t) => s + t.pnl_pct, 0);
    const firstEntry = overlapping[0].entry_price;
    const lastExit = overlapping[overlapping.length - 1].exit_price;
    const holdPnl = moveDir === "LONG"
      ? ((lastExit - firstEntry) / firstEntry) * 100
      : ((firstEntry - lastExit) / firstEntry) * 100;
    const holdToPeakPnl = moveDir === "LONG"
      ? ((move.peak_price - firstEntry) / firstEntry) * 100
      : ((firstEntry - move.peak_price) / firstEntry) * 100;

    move.churn = {
      trade_count: overlapping.length,
      individual_pnl: rnd(individualPnl),
      hold_pnl: rnd(holdPnl),
      hold_to_peak_pnl: rnd(holdToPeakPnl),
      missed_upside: rnd(Math.max(0, holdToPeakPnl - individualPnl)),
      trades: overlapping.map(t => ({
        id: t.trade_id,
        entry: dateStr(t.entry_ts),
        exit: dateStr(t.exit_ts),
        pnl: rnd(t.pnl_pct),
        status: t.status,
      })),
    };
    churnDetails.push({ ticker: move.ticker, move_pct: move.move_pct, ...move.churn });
    continue;
  }

  // Single trade — check capture quality
  const trade = overlapping[0];
  const moveStartTs = move.start_ts;
  const moveEndTs = move.end_ts;
  const moveDuration = moveEndTs - moveStartTs;

  const entryTiming = moveDuration > 0 ? (trade.entry_ts - moveStartTs) / moveDuration : 0;
  const exitTiming = moveDuration > 0 ? (trade.exit_ts - moveStartTs) / moveDuration : 1;

  if (entryTiming <= 0.3 && exitTiming >= 0.6) {
    move.capture = "FULL";
    fullCapture++;
  } else {
    move.capture = "PARTIAL";
    partialCapture++;
  }

  move.trade_match = {
    id: trade.trade_id,
    entry_timing: rnd(entryTiming),
    exit_timing: rnd(exitTiming),
    pnl: rnd(trade.pnl_pct),
    status: trade.status,
    exit_reason: trade.exit_reason,
  };
}

const totalMoves = moves.length;
console.log(`  ${G}FULL CAPTURE:${RST}    ${fullCapture} (${pct(fullCapture, totalMoves)}%)`);
console.log(`  ${Y}PARTIAL:${RST}         ${partialCapture} (${pct(partialCapture, totalMoves)}%)`);
console.log(`  ${R}MISSED:${RST}          ${missed} (${pct(missed, totalMoves)}%)`);
console.log(`  CHURNED:         ${churned} (${pct(churned, totalMoves)}%)`);
console.log();

// ════════════════════════════════════════════════════════════════════════════
// Step 6: ANALYSIS & REPORT
// ════════════════════════════════════════════════════════════════════════════

console.log(`${B}═══ Step 4: Analysis ═══${RST}\n`);

// Indicator patterns at move start: captured vs missed
const capturedMoves = moves.filter(m => m.capture === "FULL" || m.capture === "PARTIAL");
const missedMoves = moves.filter(m => m.capture === "MISSED");

function analyzeGroup(group, label) {
  if (!group.length) return null;
  const withTrail = group.filter(m => m.indicators?.[0]?.htf_score != null);
  const stats = {
    count: group.length,
    avg_move_pct: rnd(group.reduce((s, m) => s + Math.abs(m.move_pct), 0) / group.length),
    avg_move_atr: rnd(group.reduce((s, m) => s + m.move_atr, 0) / group.length),
    ema_aligned_pct: pct(group.filter(m => m.ema_aligned).length, group.length),
    avg_rsi: rnd(group.reduce((s, m) => s + m.rsi_at_start, 0) / group.length, 0),
    avg_pullback_pct: rnd(group.reduce((s, m) => s + m.max_pullback_pct, 0) / group.length),
    up_pct: pct(group.filter(m => m.direction === "UP").length, group.length),
  };
  if (withTrail.length > 0) {
    const avgHtf = withTrail.reduce((s, m) => s + (m.indicators[0].htf_score || 0), 0) / withTrail.length;
    const avgLtf = withTrail.reduce((s, m) => s + (m.indicators[0].ltf_score || 0), 0) / withTrail.length;
    const avgRank = withTrail.reduce((s, m) => s + (m.indicators[0].rank || 0), 0) / withTrail.length;
    const sqPct = pct(withTrail.filter(m => m.indicators[0].squeeze_release).length, withTrail.length);
    const emaCrossPct = pct(withTrail.filter(m => m.indicators[0].ema_cross).length, withTrail.length);
    const mePct = pct(withTrail.filter(m => m.indicators[0].momentum_elite).length, withTrail.length);
    stats.trail = {
      sample: withTrail.length,
      avg_htf: rnd(avgHtf, 1), avg_ltf: rnd(avgLtf, 1), avg_rank: rnd(avgRank, 0),
      squeeze_release_pct: sqPct, ema_cross_pct: emaCrossPct, momentum_elite_pct: mePct,
    };
  }
  return stats;
}

const capturedStats = analyzeGroup(capturedMoves, "Captured");
const missedStats = analyzeGroup(missedMoves, "Missed");

function printStats(label, s) {
  if (!s) return;
  console.log(`  ${B}${label} (${s.count} moves):${RST}`);
  console.log(`    Avg size: ${s.avg_move_pct}% (${s.avg_move_atr} ATR)  |  EMA aligned: ${s.ema_aligned_pct}%  |  RSI: ${s.avg_rsi}`);
  console.log(`    Max pullback: ${s.avg_pullback_pct}%  |  Direction: ${s.up_pct}% UP`);
  if (s.trail) {
    console.log(`    Trail signals (${s.trail.sample} with data):`);
    console.log(`      HTF: ${s.trail.avg_htf}  LTF: ${s.trail.avg_ltf}  Rank: ${s.trail.avg_rank}`);
    console.log(`      Squeeze: ${s.trail.squeeze_release_pct}%  EMA cross: ${s.trail.ema_cross_pct}%  Mom Elite: ${s.trail.momentum_elite_pct}%`);
  }
  console.log();
}

printStats("Captured Moves", capturedStats);
printStats("Missed Moves", missedStats);

// Churning report
if (churnDetails.length > 0) {
  console.log(`  ${B}CHURNING REPORT (${churnDetails.length} tickers):${RST}\n`);
  console.log("  " + "Ticker".padEnd(8) + "  MovePct  Trades  IndivP&L  HoldP&L  MissedUpside");
  console.log("  " + "─".repeat(65));

  let totalMissedUpside = 0;
  for (const ch of churnDetails.sort((a, b) => b.missed_upside - a.missed_upside)) {
    const muColor = ch.missed_upside > 5 ? R : ch.missed_upside > 0 ? Y : G;
    console.log(`  ${ch.ticker.padEnd(8)}  ${String(rnd(ch.move_pct)).padStart(6)}%  ${String(ch.trade_count).padStart(5)}  ${String(ch.individual_pnl).padStart(8)}%  ${String(ch.hold_pnl).padStart(7)}%  ${muColor}${String(ch.missed_upside).padStart(12)}%${RST}`);
    totalMissedUpside += ch.missed_upside;
  }
  console.log(`\n  ${R}Total missed upside from churning: ${rnd(totalMissedUpside)}%${RST}\n`);
}

// Top moves by ATR magnitude
console.log(`  ${B}TOP 20 MOVES BY ATR MAGNITUDE:${RST}\n`);
console.log("  " + "Ticker".padEnd(8) + " Dir  Window  MovePct  MoveATR  Pullback  RSI  EMA       Capture");
console.log("  " + "─".repeat(85));

for (const m of moves.slice(0, 20)) {
  const cc = m.capture === "FULL" ? G : m.capture === "PARTIAL" ? Y : m.capture === "CHURNED" ? Y : R;
  console.log(`  ${m.ticker.padEnd(8)} ${m.direction.padEnd(4)} ${String(m.window + "d").padStart(5)}  ${String(m.move_pct).padStart(7)}%  ${String(m.move_atr).padStart(7)}  ${String(m.max_pullback_pct).padStart(8)}%  ${String(m.rsi_at_start).padStart(3)}  ${m.ema_state.padEnd(13)} ${cc}${m.capture}${RST}`);
}
console.log();

// ════════════════════════════════════════════════════════════════════════════
// Step 7: OUTPUT
// ════════════════════════════════════════════════════════════════════════════

const report = {
  generated: new Date().toISOString(),
  since: SINCE_DATE,
  min_atr_mult: MIN_ATR_MULT,
  windows: WINDOWS,
  summary: {
    total_moves: totalMoves,
    unique_tickers: new Set(moves.map(m => m.ticker)).size,
    full_capture: fullCapture,
    partial_capture: partialCapture,
    missed,
    churned,
    capture_rate: pct(fullCapture + partialCapture, totalMoves),
    missed_rate: pct(missed, totalMoves),
    churn_rate: pct(churned, totalMoves),
    total_missed_upside_from_churn: rnd(churnDetails.reduce((s, c) => s + c.missed_upside, 0)),
  },
  patterns: { captured: capturedStats, missed: missedStats },
  churning: churnDetails,
  moves: moves.map(m => ({
    ticker: m.ticker, direction: m.direction, window: m.window,
    start_date: m.start_date, end_date: m.end_date, peak_date: m.peak_date,
    move_pct: m.move_pct, move_atr: m.move_atr,
    start_price: m.start_price, end_price: m.end_price, peak_price: m.peak_price,
    atr_at_start: m.atr_at_start,
    atr_pct: m.atr_pct, max_pullback_pct: m.max_pullback_pct, pullback_count: m.pullback_count,
    rsi_at_start: m.rsi_at_start, ema_aligned: m.ema_aligned, ema_state: m.ema_state,
    capture: m.capture,
    trade_match: m.trade_match || null,
    churn: m.churn || null,
    indicators: m.indicators,
  })),
};

const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 15);
const outPath = path.join(__dirname, "..", "data", `move-discovery-${ts}.json`);
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(`  ${G}Report saved:${RST} ${outPath}`);

// Upload to KV for dashboard consumption
if (UPLOAD) {
  console.log(`\n  Uploading to worker...`);
  const uploadFn = async () => {
    try {
      const resp = await fetch(`${API_BASE}/timed/move-discovery?key=${API_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ report }),
      });
      const data = await resp.json();
      if (data.ok) console.log(`  ${G}Uploaded (${(data.size / 1024 / 1024).toFixed(1)} MB)${RST}`);
      else console.log(`  ${R}Upload failed: ${data.error}${RST}`);
    } catch (e) { console.log(`  ${R}Upload error: ${e.message}${RST}`); }
  };
  uploadFn();
} else {
  console.log(`\n  Run with ${C}--upload${RST} to push to KV for the dashboard`);
}

console.log(`\n  Done in ${elapsed()}\n`);
