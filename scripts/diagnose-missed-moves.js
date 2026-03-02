#!/usr/bin/env node
/**
 * diagnose-missed-moves.js — Why Did We Miss Valid Moves?
 *
 * Cross-references missed moves from move-discovery with trail_5m_facts
 * to determine what the scoring engine was showing during those periods.
 *
 * Usage:
 *   USE_D1=1 node scripts/diagnose-missed-moves.js [--ticker AMZN] [--limit 200]
 */

const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const args = process.argv.slice(2);
const getArg = (name, dflt) => {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : dflt;
};

const TICKER_FILTER = getArg("ticker", null);
const LIMIT = Number(getArg("limit", "200"));

const WORKER_DIR = path.join(__dirname, "../worker");
const USE_D1 = process.env.USE_D1 === "1" || process.env.USE_D1 === "true";

let db = null;
if (!USE_D1) {
  try {
    const Database = require("better-sqlite3");
    db = new Database(path.join(__dirname, "../data/timed-local.db"), { readonly: true });
  } catch (e) {
    console.error("Local DB not found. Use USE_D1=1");
    process.exit(1);
  }
}

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

function rnd(v, dp = 1) { return Math.round(v * Math.pow(10, dp)) / Math.pow(10, dp); }
function pct(n, d) { return d > 0 ? rnd(n / d * 100) : 0; }

const B = "\x1b[1m", G = "\x1b[32m", R = "\x1b[31m", Y = "\x1b[33m", C = "\x1b[36m", RST = "\x1b[0m";
const t0 = Date.now();
function elapsed() { return `${((Date.now() - t0) / 1000).toFixed(1)}s`; }

// ── Load move discovery report ──────────────────────────────────────────────

const reportFiles = fs.readdirSync(path.join(__dirname, "../data"))
  .filter(f => f.startsWith("move-discovery-") && f.endsWith(".json"))
  .sort().reverse();

if (!reportFiles.length) {
  console.error("No move-discovery report found. Run discover-moves.js first.");
  process.exit(1);
}

const report = JSON.parse(fs.readFileSync(path.join(__dirname, "../data", reportFiles[0]), "utf-8"));
console.log(`\n${B}╔══════════════════════════════════════════════════════════════╗${RST}`);
console.log(`${B}║   Missed Move Diagnosis                                      ║${RST}`);
console.log(`${B}╚══════════════════════════════════════════════════════════════╝${RST}\n`);
console.log(`  Report: ${reportFiles[0]}`);
console.log(`  Source: ${USE_D1 ? "D1 (worker)" : "local SQLite"}\n`);

// Get tickers we actually traded
const tradedTickers = new Set();
(report.moves || []).forEach(m => {
  if (m.capture !== "MISSED") tradedTickers.add(m.ticker);
});

// Filter to missed moves on traded tickers only
let missedMoves = (report.moves || []).filter(m =>
  m.capture === "MISSED" && tradedTickers.has(m.ticker)
);

if (TICKER_FILTER) {
  missedMoves = missedMoves.filter(m => m.ticker === TICKER_FILTER.toUpperCase());
}

// Sort by move_atr desc and limit
missedMoves.sort((a, b) => b.move_atr - a.move_atr);
missedMoves = missedMoves.slice(0, LIMIT);

console.log(`  Missed moves to diagnose: ${missedMoves.length} (of ${(report.moves || []).filter(m => m.capture === "MISSED" && tradedTickers.has(m.ticker)).length} total)`);

// Group by ticker for batch querying
const byTicker = {};
for (const m of missedMoves) {
  (byTicker[m.ticker] = byTicker[m.ticker] || []).push(m);
}
const tickers = Object.keys(byTicker);
console.log(`  Tickers: ${tickers.length}\n`);

// ── Query trail_5m_facts for each ticker ─────────────────────────────────────

console.log(`  [${elapsed()}] Fetching trail_5m_facts for missed move windows...\n`);

const diagnosis = {
  low_rank: 0,       // rank < 60
  low_htf: 0,        // htf_score < 15
  wrong_state: 0,    // state doesn't match direction
  no_trail_data: 0,  // no trail_5m_facts at all
  low_completion: 0, // completion < 50%
  no_signals: 0,     // no squeeze/ema_cross/st_flip
  should_have_entered: 0, // everything looks good
};

const tickerDiagnosis = {};
let processed = 0;

for (const ticker of tickers) {
  const moves = byTicker[ticker];
  const earliestTs = Math.min(...moves.map(m => new Date(m.start_date + "T00:00:00Z").getTime()));
  const latestTs = Math.max(...moves.map(m => new Date(m.end_date + "T23:59:59Z").getTime()));

  const startSec = Math.floor(earliestTs / 1000);
  const endSec = Math.ceil(latestTs / 1000);

  const trailRows = queryChunked(
    `SELECT bucket_ts, htf_score_avg, ltf_score_avg, state, rank,
            completion, phase_pct, had_squeeze_release, had_ema_cross,
            had_st_flip, had_momentum_elite, ema_regime_D, pdz_zone,
            kanban_stage_end
     FROM trail_5m_facts
     WHERE ticker='${ticker}' AND bucket_ts >= ${earliestTs} AND bucket_ts <= ${latestTs}
     ORDER BY bucket_ts`
  );

  const tickerResults = [];

  for (const move of moves) {
    const moveStartMs = new Date(move.start_date + "T00:00:00Z").getTime();
    const moveEndMs = new Date(move.end_date + "T23:59:59Z").getTime();

    // Find trail rows during this move (bucket_ts is in milliseconds)
    const during = trailRows.filter(r => {
      const ts = Number(r.bucket_ts);
      return ts >= moveStartMs && ts <= moveEndMs;
    });

    if (during.length === 0) {
      diagnosis.no_trail_data++;
      tickerResults.push({ move, reason: "NO_TRAIL_DATA", detail: "No trail_5m_facts during move window" });
      continue;
    }

    // Analyze what the scoring engine was showing during the move
    const avgRank = during.reduce((s, r) => s + (Number(r.rank) || 0), 0) / during.length;
    const avgHtf = during.reduce((s, r) => s + (Number(r.htf_score_avg) || 0), 0) / during.length;
    const avgLtf = during.reduce((s, r) => s + (Number(r.ltf_score_avg) || 0), 0) / during.length;
    const avgCompletion = during.reduce((s, r) => s + (Number(r.completion) || 0), 0) / during.length;
    const hadSqueeze = during.some(r => r.had_squeeze_release);
    const hadEmaCross = during.some(r => r.had_ema_cross);
    const hadStFlip = during.some(r => r.had_st_flip);
    const hadMomentumElite = during.some(r => r.had_momentum_elite);
    const signalCount = (hadSqueeze ? 1 : 0) + (hadEmaCross ? 1 : 0) + (hadStFlip ? 1 : 0) + (hadMomentumElite ? 1 : 0);

    // Check states
    const states = during.map(r => r.state || "unknown");
    const stateFreq = {};
    states.forEach(s => stateFreq[s] = (stateFreq[s] || 0) + 1);
    const dominantState = Object.entries(stateFreq).sort((a, b) => b[1] - a[1])[0]?.[0] || "unknown";

    // Kanban stages
    const kanbanStages = during.map(r => r.kanban_stage_end || "unknown");
    const kanbanFreq = {};
    kanbanStages.forEach(s => kanbanFreq[s] = (kanbanFreq[s] || 0) + 1);
    const dominantKanban = Object.entries(kanbanFreq).sort((a, b) => b[1] - a[1])[0]?.[0] || "unknown";

    // EMA regime
    const regimes = during.map(r => Number(r.ema_regime_D) || 0);
    const avgRegime = regimes.reduce((s, v) => s + v, 0) / regimes.length;

    // Diagnose
    let reason = "UNKNOWN";
    let detail = "";

    const wantedDir = move.direction === "UP" ? "BULL" : "BEAR";

    if (avgRank < 60) {
      reason = "LOW_RANK";
      detail = `avg rank=${rnd(avgRank, 0)} (need >=60)`;
      diagnosis.low_rank++;
    } else if (avgHtf < 15) {
      reason = "LOW_HTF";
      detail = `avg htf=${rnd(avgHtf)} (need >=15)`;
      diagnosis.low_htf++;
    } else if (!dominantState.includes(wantedDir)) {
      reason = "WRONG_STATE";
      detail = `state=${dominantState} but move=${move.direction}`;
      diagnosis.wrong_state++;
    } else if (avgCompletion < 50) {
      reason = "LOW_COMPLETION";
      detail = `avg completion=${rnd(avgCompletion)}% (need >=50)`;
      diagnosis.low_completion++;
    } else if (signalCount === 0) {
      reason = "NO_SIGNALS";
      detail = "no squeeze/ema_cross/st_flip/momentum_elite";
      diagnosis.no_signals++;
    } else {
      reason = "SHOULD_HAVE_ENTERED";
      detail = `rank=${rnd(avgRank, 0)} htf=${rnd(avgHtf)} completion=${rnd(avgCompletion)}% signals=${signalCount} kanban=${dominantKanban}`;
      diagnosis.should_have_entered++;
    }

    tickerResults.push({
      move,
      reason,
      detail,
      metrics: {
        avg_rank: rnd(avgRank, 0),
        avg_htf: rnd(avgHtf),
        avg_ltf: rnd(avgLtf),
        avg_completion: rnd(avgCompletion),
        dominant_state: dominantState,
        dominant_kanban: dominantKanban,
        avg_regime: rnd(avgRegime),
        had_squeeze: hadSqueeze,
        had_ema_cross: hadEmaCross,
        had_st_flip: hadStFlip,
        had_momentum_elite: hadMomentumElite,
        signal_count: signalCount,
        trail_rows: during.length,
      },
    });
  }

  tickerDiagnosis[ticker] = tickerResults;
  processed++;
  process.stdout.write(`\r  Processed: ${processed}/${tickers.length} tickers...`);
}

console.log(`\n\n  [${elapsed()}] Diagnosis complete\n`);

// ── Print Results ────────────────────────────────────────────────────────────

const total = Object.values(diagnosis).reduce((s, v) => s + v, 0);

console.log(`${B}═══ WHY WE MISSED: BREAKDOWN ═══${RST}\n`);
console.log(`  ${Y}LOW_RANK${RST}            ${diagnosis.low_rank.toString().padStart(4)} (${pct(diagnosis.low_rank, total)}%)  — Rank below 60, scoring engine didn't rate highly enough`);
console.log(`  ${Y}LOW_HTF${RST}             ${diagnosis.low_htf.toString().padStart(4)} (${pct(diagnosis.low_htf, total)}%)  — HTF score below 15, timeframes not aligned`);
console.log(`  ${R}WRONG_STATE${RST}         ${diagnosis.wrong_state.toString().padStart(4)} (${pct(diagnosis.wrong_state, total)}%)  — State didn't match move direction (scoring vs reality)`);
console.log(`  ${Y}LOW_COMPLETION${RST}      ${diagnosis.low_completion.toString().padStart(4)} (${pct(diagnosis.low_completion, total)}%)  — Pattern completion too low`);
console.log(`  ${Y}NO_SIGNALS${RST}          ${diagnosis.no_signals.toString().padStart(4)} (${pct(diagnosis.no_signals, total)}%)  — No entry signals fired (squeeze/ema/st/momentum)`);
console.log(`  ${R}NO_TRAIL_DATA${RST}       ${diagnosis.no_trail_data.toString().padStart(4)} (${pct(diagnosis.no_trail_data, total)}%)  — No trail_5m_facts data during move`);
console.log(`  ${G}SHOULD_HAVE_ENTERED${RST} ${diagnosis.should_have_entered.toString().padStart(4)} (${pct(diagnosis.should_have_entered, total)}%)  — Everything looked good, unclear why no entry`);
console.log();

// Show the "should have entered" cases — these are the real mystery
const shouldHave = [];
for (const [ticker, results] of Object.entries(tickerDiagnosis)) {
  for (const r of results) {
    if (r.reason === "SHOULD_HAVE_ENTERED") shouldHave.push(r);
  }
}

if (shouldHave.length > 0) {
  console.log(`${B}═══ SHOULD HAVE ENTERED (${shouldHave.length}) — Need Further Investigation ═══${RST}\n`);
  console.log("  " + "Ticker".padEnd(8) + " Dir  MovePct  MoveATR  Rank  HTF   Comp%  Signals  Kanban        State");
  console.log("  " + "─".repeat(95));
  for (const r of shouldHave.sort((a, b) => b.move.move_atr - a.move.move_atr).slice(0, 30)) {
    const m = r.move, met = r.metrics;
    console.log(`  ${m.ticker.padEnd(8)} ${m.direction.padEnd(4)} ${String(m.move_pct).padStart(7)}%  ${String(m.move_atr).padStart(7)}  ${String(met.avg_rank).padStart(4)}  ${String(met.avg_htf).padStart(5)}  ${String(met.avg_completion).padStart(5)}%  ${String(met.signal_count).padStart(5)}    ${(met.dominant_kanban || "?").padEnd(13)} ${met.dominant_state}`);
  }
  console.log();
}

// Kanban stage distribution for all diagnosed moves
const kanbanDist = {};
for (const results of Object.values(tickerDiagnosis)) {
  for (const r of results) {
    const k = r.metrics?.dominant_kanban || "unknown";
    kanbanDist[k] = (kanbanDist[k] || 0) + 1;
  }
}
console.log(`${B}═══ KANBAN STAGE DISTRIBUTION (during missed moves) ═══${RST}\n`);
Object.entries(kanbanDist).sort((a, b) => b[1] - a[1]).forEach(([stage, n]) => {
  const bar = "█".repeat(Math.round(n / total * 40));
  console.log(`  ${stage.padEnd(18)} ${String(n).padStart(4)} (${pct(n, total).toString().padStart(5)}%) ${bar}`);
});
console.log();

// Save report
const outPath = path.join(__dirname, "..", "data", "missed-move-diagnosis.json");
fs.writeFileSync(outPath, JSON.stringify({
  generated: new Date().toISOString(),
  total_diagnosed: total,
  breakdown: diagnosis,
  kanban_distribution: kanbanDist,
  should_have_entered: shouldHave.map(r => ({
    ticker: r.move.ticker, direction: r.move.direction,
    move_pct: r.move.move_pct, move_atr: r.move.move_atr,
    start_date: r.move.start_date, end_date: r.move.end_date,
    ...r.metrics,
  })),
}, null, 2));
console.log(`  ${G}Report saved:${RST} ${outPath}`);
console.log(`  Done in ${elapsed()}\n`);
