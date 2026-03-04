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

// ════════════════════════════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════════════════════════════

async function main() {
  const ind = await import("../worker/indicators.js");
  const { rsiSeries, superTrendSeries, atrSeries, emaSeries } = ind;

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
  for (const t of Object.keys(fullByTicker)) fullByTicker[t].sort((a, b) => a.ts - b.ts);
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

        // Lifecycle signal snapshots at 5 phases:
        // 0=origin, 0.25=growth, 0.5=maturity, 0.75=shakeout, 1.0=completion
        const phases = [
          { name: "origin",     pct: 0 },
          { name: "growth",     pct: 0.25 },
          { name: "maturity",   pct: 0.5 },
          { name: "shakeout",   pct: 0.75 },
          { name: "completion", pct: 1.0 },
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
          };
        });

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
          rsi_at_start: Number.isFinite(rsiStart) ? rnd(rsiStart, 0) : 50,
          ema_aligned: emaAligned ? 1 : 0,
          ema_state: emaState,
          st_dir_start: stDirStart,
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

  // Clear existing data
  console.log(`  [${elapsed()}] Clearing old data${TICKER_FILTER ? ` for ${TICKER_FILTER}` : ""}...`);
  if (TICKER_FILTER) {
    execD1(`DELETE FROM ticker_move_signals WHERE move_id IN (SELECT id FROM ticker_moves WHERE ticker='${TICKER_FILTER}')`);
    execD1(`DELETE FROM ticker_moves WHERE ticker='${TICKER_FILTER}'`);
  } else {
    execD1(`DELETE FROM ticker_move_signals`);
    execD1(`DELETE FROM ticker_moves`);
  }

  // Build SQL statements with small INSERT batches (20 rows each)
  // then group multiple statements into chunk files (~100KB each)
  const MOVE_ROWS_PER_INSERT = 20;
  const SIG_ROWS_PER_INSERT = 40;
  const STMTS_PER_FILE = 30;

  const allStatements = [];

  for (let i = 0; i < allMoves.length; i += MOVE_ROWS_PER_INSERT) {
    const batch = allMoves.slice(i, i + MOVE_ROWS_PER_INSERT);
    const moveValues = batch.map(m =>
      `('${m.id}','${m.ticker}','${m.direction}',${m.start_ts},${m.end_ts},${m.peak_ts},${m.duration_days},${m.move_pct},${m.move_atr},${m.start_price},${m.end_price},${m.peak_price},${m.atr_at_start},${m.max_pullback_pct},${m.pullback_count},${m.rsi_at_start},${m.ema_aligned},'${m.ema_state}','${personality(m.ticker)}',${now})`
    ).join(",");
    allStatements.push(`INSERT OR REPLACE INTO ticker_moves (id,ticker,direction,start_ts,end_ts,peak_ts,duration_days,move_pct,move_atr,start_price,end_price,peak_price,atr_at_start,max_pullback_pct,pullback_count,rsi_at_start,ema_aligned,ema_state,personality,created_at) VALUES ${moveValues}`);
    movesWritten += batch.length;
  }

  // Build signal INSERT statements
  const allSignalRows = [];
  for (const m of allMoves) {
    for (const s of m.signals) {
      const sId = uid();
      const sigJson = JSON.stringify({
        st_dir: s.st_dir_d, rsi: s.rsi_d, atr: s.atr_d,
        ema21: s.ema21_d, ema48: s.ema48_d, ema_cross: s.ema_cross_d,
      }).replace(/'/g, "''");
      allSignalRows.push(
        `('${sId}','${m.id}','${s.phase}',${s.phase_pct},${s.ts},${s.rsi_d ?? "NULL"},NULL,${s.st_dir_d ?? "NULL"},NULL,NULL,${s.atr_d ?? "NULL"},${s.ema21_d ?? "NULL"},${s.ema48_d ?? "NULL"},${s.ema_cross_d ?? "NULL"},${rnd(s.price, 4)},'${sigJson}')`
      );
    }
  }
  for (let si = 0; si < allSignalRows.length; si += SIG_ROWS_PER_INSERT) {
    const batch = allSignalRows.slice(si, si + SIG_ROWS_PER_INSERT);
    allStatements.push(`INSERT OR REPLACE INTO ticker_move_signals (id,move_id,phase,phase_pct,ts,rsi_d,rsi_30m,st_dir_d,st_dir_30m,st_slope_d,atr_d,ema21_d,ema48_d,ema_cross_d,price,signals_json) VALUES ${batch.join(",")}`);
    signalsWritten += batch.length;
  }

  const totalChunks = Math.ceil(allStatements.length / STMTS_PER_FILE);
  console.log(`  [${elapsed()}] ${allStatements.length} SQL statements → ${totalChunks} chunk files`);
  console.log(`  Moves: ${movesWritten}  Signals: ${signalsWritten}\n`);

  let chunkOk = 0, chunkFail = 0;
  for (let ci = 0; ci < allStatements.length; ci += STMTS_PER_FILE) {
    const chunk = allStatements.slice(ci, ci + STMTS_PER_FILE).join(";\n") + ";\n";
    const chunkPath = path.join(sqlDir, `_tl_chunk.sql`);
    fs.writeFileSync(chunkPath, chunk);
    try {
      execSync(
        `cd "${WORKER_DIR}" && npx wrangler d1 execute timed-trading-ledger --remote --env production --file "${chunkPath}"`,
        { maxBuffer: 20 * 1024 * 1024, encoding: "utf-8", timeout: 60000 }
      );
      chunkOk++;
    } catch (e2) {
      chunkFail++;
      if (chunkFail <= 3) console.log(`\n  ${R}Chunk ${ci / STMTS_PER_FILE} failed: ${e2.message?.slice(0, 120)}${RST}`);
    }
    try { fs.unlinkSync(chunkPath); } catch {}
    const chunkNum = Math.floor(ci / STMTS_PER_FILE) + 1;
    if (chunkNum % 20 === 0 || chunkNum === totalChunks) {
      process.stdout.write(`\r  [${elapsed()}] Chunk ${chunkNum}/${totalChunks} (${chunkOk} ok, ${chunkFail} fail)...`);
    }
  }
  console.log(`\n\n  ${G}D1 writes complete:${RST} ${chunkOk}/${totalChunks} chunks ok, ${chunkFail} failed`);
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
