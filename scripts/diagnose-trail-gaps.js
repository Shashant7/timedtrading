#!/usr/bin/env node
/**
 * diagnose-trail-gaps.js — Find Missing trail_5m_facts Coverage
 *
 * Loads the move-discovery report, identifies missed moves with NO_TRAIL_DATA,
 * groups by ticker and date range, and cross-checks against trail_5m_facts.
 *
 * Usage:
 *   USE_D1=1 node scripts/diagnose-trail-gaps.js
 */

const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

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

function queryD1(sql, retries = 3) {
  const escaped = sql.replace(/"/g, '\\"');
  const cmd = `cd "${WORKER_DIR}" && npx wrangler d1 execute timed-trading-ledger --remote --env production --json --command "${escaped}"`;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const raw = execSync(cmd, { maxBuffer: 100 * 1024 * 1024, encoding: "utf-8" });
      const lines = raw.split("\n").filter(l => !l.startsWith("npm warn"));
      const parsed = JSON.parse(lines.join("\n"));
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

function query(sql) {
  if (db) return db.prepare(sql).all();
  return queryD1(sql);
}

const B = "\x1b[1m", G = "\x1b[32m", R = "\x1b[31m", Y = "\x1b[33m", C = "\x1b[36m", RST = "\x1b[0m";
const t0 = Date.now();
function elapsed() { return `${((Date.now() - t0) / 1000).toFixed(1)}s`; }

// ── Load move discovery report ──
const reportFiles = fs.readdirSync(path.join(__dirname, "../data"))
  .filter(f => f.startsWith("move-discovery-") && f.endsWith(".json"))
  .sort().reverse();

if (!reportFiles.length) {
  console.error("No move-discovery report found. Run discover-moves.js first.");
  process.exit(1);
}

const report = JSON.parse(fs.readFileSync(path.join(__dirname, "../data", reportFiles[0]), "utf-8"));

console.log(`\n${B}╔══════════════════════════════════════════════════════════════╗${RST}`);
console.log(`${B}║   Trail 5m Facts Gap Diagnosis                               ║${RST}`);
console.log(`${B}╚══════════════════════════════════════════════════════════════╝${RST}\n`);
console.log(`  Report: ${reportFiles[0]}`);
console.log(`  Source: ${USE_D1 ? "D1 (remote)" : "local SQLite"}\n`);

// Identify missed moves without trail data (check indicator snapshots)
const tradedTickers = new Set();
(report.moves || []).forEach(m => {
  if (m.capture !== "MISSED") tradedTickers.add(m.ticker);
});

const allMissed = (report.moves || []).filter(m => m.capture === "MISSED");
const missedOnTraded = allMissed.filter(m => tradedTickers.has(m.ticker));

const noDataMoves = missedOnTraded.filter(m => {
  const startSnap = (m.indicators || []).find(i => i.pct_through === 0);
  return !startSnap || startSnap.htf_score === undefined;
});

console.log(`  Total missed moves: ${allMissed.length}`);
console.log(`  Missed on traded tickers: ${missedOnTraded.length}`);
console.log(`  Missing trail data: ${noDataMoves.length}\n`);

// Group by ticker
const byTicker = {};
for (const m of noDataMoves) {
  (byTicker[m.ticker] = byTicker[m.ticker] || []).push(m);
}
const tickers = Object.keys(byTicker).sort();

console.log(`  Tickers with gaps: ${tickers.length}\n`);

// Verify against D1: check actual trail_5m_facts coverage per ticker
console.log(`  [${elapsed()}] Checking trail_5m_facts coverage per ticker...\n`);

const gapReport = [];
let queriedCount = 0;

for (const ticker of tickers) {
  const moves = byTicker[ticker];
  const earliestDate = moves.map(m => m.start_date).sort()[0];
  const latestDate = moves.map(m => m.end_date).sort().reverse()[0];
  const earliestMs = new Date(earliestDate + "T00:00:00Z").getTime();
  const latestMs = new Date(latestDate + "T23:59:59Z").getTime();

  const rows = query(
    `SELECT MIN(bucket_ts) AS min_ts, MAX(bucket_ts) AS max_ts, COUNT(*) AS cnt
     FROM trail_5m_facts
     WHERE ticker='${ticker}' AND bucket_ts >= ${earliestMs} AND bucket_ts <= ${latestMs}`
  );

  const row = rows[0] || {};
  const cnt = Number(row.cnt) || 0;

  gapReport.push({
    ticker,
    moveCount: moves.length,
    dateRange: `${earliestDate} → ${latestDate}`,
    trailRows: cnt,
    needsBackfill: cnt === 0,
    partialData: cnt > 0 && cnt < moves.length * 50,
  });

  queriedCount++;
  if (queriedCount % 10 === 0) {
    process.stdout.write(`\r  Checked: ${queriedCount}/${tickers.length} tickers...`);
  }
}

console.log(`\r  [${elapsed()}] Coverage check complete for ${tickers.length} tickers\n`);

// Summary
const needsBackfill = gapReport.filter(g => g.needsBackfill);
const partialData = gapReport.filter(g => g.partialData);
const hasData = gapReport.filter(g => !g.needsBackfill && !g.partialData);

console.log(`${B}═══ GAP SUMMARY ═══${RST}\n`);
console.log(`  ${R}No trail data at all:${RST}  ${needsBackfill.length} tickers`);
console.log(`  ${Y}Partial trail data:${RST}    ${partialData.length} tickers`);
console.log(`  ${G}Has trail data:${RST}        ${hasData.length} tickers\n`);

// Show tickers needing backfill
if (needsBackfill.length > 0) {
  console.log(`${B}═══ TICKERS NEEDING FULL BACKFILL (${needsBackfill.length}) ═══${RST}\n`);
  console.log("  " + "Ticker".padEnd(10) + "Moves".padStart(6) + "  " + "Date Range");
  console.log("  " + "─".repeat(50));
  for (const g of needsBackfill.sort((a, b) => b.moveCount - a.moveCount)) {
    console.log(`  ${g.ticker.padEnd(10)}${String(g.moveCount).padStart(6)}  ${g.dateRange}`);
  }
  console.log();
}

if (partialData.length > 0) {
  console.log(`${B}═══ TICKERS WITH PARTIAL DATA (${partialData.length}) ═══${RST}\n`);
  console.log("  " + "Ticker".padEnd(10) + "Moves".padStart(6) + "  Rows".padStart(7) + "  " + "Date Range");
  console.log("  " + "─".repeat(60));
  for (const g of partialData.sort((a, b) => b.moveCount - a.moveCount)) {
    console.log(`  ${g.ticker.padEnd(10)}${String(g.moveCount).padStart(6)}  ${String(g.trailRows).padStart(6)}  ${g.dateRange}`);
  }
  console.log();
}

// Determine overall backfill date range
const allDates = noDataMoves.flatMap(m => [m.start_date, m.end_date]).sort();
const backfillFrom = allDates[0];
const backfillTo = allDates[allDates.length - 1];

console.log(`${B}═══ RECOMMENDED BACKFILL ═══${RST}\n`);
console.log(`  Date range: ${backfillFrom} → ${backfillTo}`);
console.log(`  Tickers: ${needsBackfill.length + partialData.length}`);
console.log(`  Command:`);
console.log(`  ${C}TIMED_API_KEY=AwesomeSauce node scripts/backfill-trail-facts.js --from ${backfillFrom} --to ${backfillTo}${RST}`);
console.log();

// Save report
const outPath = path.join(__dirname, "..", "data", "trail-gaps-report.json");
fs.writeFileSync(outPath, JSON.stringify({
  generated: new Date().toISOString(),
  report: reportFiles[0],
  totalMissedNoData: noDataMoves.length,
  tickersNeedingBackfill: needsBackfill.map(g => g.ticker),
  tickersWithPartialData: partialData.map(g => g.ticker),
  backfillDateRange: { from: backfillFrom, to: backfillTo },
  details: gapReport,
}, null, 2));
console.log(`  ${G}Report saved:${RST} ${outPath}`);
console.log(`  Done in ${elapsed()}\n`);
