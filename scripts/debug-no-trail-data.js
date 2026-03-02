#!/usr/bin/env node
/**
 * Debug NO_TRAIL_DATA — check if trail_5m_facts has data for sample missed moves.
 * Run after diagnose-missed-moves shows high NO_TRAIL_DATA. Verifies D1 query
 * and bucket_ts units (ms vs seconds).
 *
 * Usage: USE_D1=1 node scripts/debug-no-trail-data.js [--samples 5]
 */

const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const args = process.argv.slice(2);
const getArg = (name, dflt) => {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : dflt;
};
const SAMPLES = Math.min(20, Math.max(1, Number(getArg("samples", "5"))));

const WORKER_DIR = path.join(__dirname, "../worker");
const USE_D1 = process.env.USE_D1 === "1" || process.env.USE_D1 === "true";

if (!USE_D1) {
  console.error("Use: USE_D1=1 node scripts/debug-no-trail-data.js");
  process.exit(1);
}

function queryD1(sql, retries = 2) {
  const escaped = sql.replace(/"/g, '\\"');
  const cmd = `cd "${WORKER_DIR}" && npx wrangler d1 execute timed-trading-ledger --remote --env production --json --command "${escaped}"`;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const raw = execSync(cmd, { maxBuffer: 10 * 1024 * 1024, encoding: "utf-8" });
      const parsed = JSON.parse(raw);
      if (parsed?.error) return null;
      if (Array.isArray(parsed) && parsed[0]?.results) return parsed[0].results;
      if (parsed?.results) return parsed.results;
      return [];
    } catch (e) {
      if (attempt < retries) execSync("sleep 2");
      return null;
    }
  }
  return null;
}

const reportFiles = fs.readdirSync(path.join(__dirname, "../data"))
  .filter(f => f.startsWith("move-discovery-") && f.endsWith(".json"))
  .sort().reverse();
if (!reportFiles.length) {
  console.error("No move-discovery report. Run: USE_D1=1 node scripts/discover-moves.js");
  process.exit(1);
}

const report = JSON.parse(fs.readFileSync(path.join(__dirname, "../data", reportFiles[0]), "utf-8"));
const tradedTickers = new Set();
(report.moves || []).forEach(m => {
  if (m.capture !== "MISSED") tradedTickers.add(m.ticker);
});
const missedOnTraded = (report.moves || [])
  .filter(m => m.capture === "MISSED" && tradedTickers.has(m.ticker))
  .sort((a, b) => (b.move_atr || 0) - (a.move_atr || 0))
  .slice(0, SAMPLES);

console.log("Debug NO_TRAIL_DATA — sample missed moves (traded tickers)");
console.log(`Report: ${reportFiles[0]}  |  Samples: ${missedOnTraded.length}\n`);

// Quick sanity: total trail_5m_facts row count and sample ticker coverage
const totalRows = queryD1("SELECT COUNT(*) as n FROM trail_5m_facts");
const nTotal = totalRows && totalRows[0] ? (totalRows[0].n ?? totalRows[0].N) : "?";
console.log(`trail_5m_facts total rows in D1: ${nTotal}`);
const sampleTickers = [...new Set(missedOnTraded.map(m => m.ticker))].slice(0, 3);
for (const t of sampleTickers) {
  const r = queryD1(`SELECT COUNT(*) as n, MIN(bucket_ts) as lo, MAX(bucket_ts) as hi FROM trail_5m_facts WHERE ticker='${t}'`);
  const row = r && r[0] ? r[0] : null;
  const n = row ? (row.n ?? row.N) : "err";
  const lo = row ? (row.lo ?? row.LO) : null;
  const hi = row ? (row.hi ?? row.HI) : null;
  console.log(`  ${t}: count=${n}  bucket_ts range: ${lo} .. ${hi}  (digits: ${lo != null ? String(lo).length : "?"})`);
}
console.log("");

for (const move of missedOnTraded) {
  const ticker = move.ticker;
  const moveStartMs = new Date(move.start_date + "T00:00:00Z").getTime();
  const moveEndMs = new Date(move.end_date + "T23:59:59Z").getTime();

  // Query 1: count and min/max bucket_ts (ms range)
  const sqlMs = `SELECT COUNT(*) as cnt, MIN(bucket_ts) as lo, MAX(bucket_ts) as hi FROM trail_5m_facts WHERE ticker='${ticker}' AND bucket_ts >= ${moveStartMs} AND bucket_ts <= ${moveEndMs}`;
  const rowsMs = queryD1(sqlMs);
  const r1 = rowsMs && rowsMs[0] ? rowsMs[0] : null;

  // Query 2: if 0 rows with ms, try seconds range (in case D1 stores seconds)
  const moveStartSec = Math.floor(moveStartMs / 1000);
  const moveEndSec = Math.ceil(moveEndMs / 1000);
  const sqlSec = `SELECT COUNT(*) as cnt, MIN(bucket_ts) as lo, MAX(bucket_ts) as hi FROM trail_5m_facts WHERE ticker='${ticker}' AND bucket_ts >= ${moveStartSec} AND bucket_ts <= ${moveEndSec}`;
  const rowsSec = queryD1(sqlSec);
  const r2 = rowsSec && rowsSec[0] ? rowsSec[0] : null;

  const cntMs = r1 ? (r1.cnt ?? r1.CNT ?? Object.values(r1)[0] ?? 0) : "err";
  const cntSec = r2 ? (r2.cnt ?? r2.CNT ?? Object.values(r2)[0] ?? 0) : "err";
  const loMs = r1 ? (r1.lo ?? r1.LO ?? r1.min) : null;
  const hiMs = r1 ? (r1.hi ?? r1.HI ?? r1.max) : null;
  const loSec = r2 ? (r2.lo ?? r2.LO ?? r2.min) : null;
  const hiSec = r2 ? (r2.hi ?? r2.HI ?? r2.max) : null;

  const digits = v => v == null ? "?" : String(v).length;
  console.log(`${ticker}  ${move.start_date} → ${move.end_date}  move_atr=${move.move_atr}`);
  console.log(`  range_ms:  ${moveStartMs} .. ${moveEndMs}`);
  console.log(`  query(ms):  count=${cntMs}  min=${loMs}  max=${hiMs}  (digits: ${digits(loMs)} / ${digits(hiMs)})`);
  console.log(`  query(sec): count=${cntSec}  min=${loSec}  max=${hiSec}  (digits: ${digits(loSec)} / ${digits(hiSec)})`);
  if (Number(cntMs) === 0 && Number(cntSec) > 0) {
    console.log(`  → Data exists with bucket_ts in SECONDS; diagnosis script expects MILLISECONDS.`);
  } else if (Number(cntMs) > 0) {
    console.log(`  → Data exists in ms; diagnosis in-memory filter may be wrong.`);
  } else {
    console.log(`  → No rows in D1 for this ticker/range (backfill gap or ticker not in backfill).`);
  }
  console.log("");
}

console.log("Done. If bucket_ts is in seconds, fix diagnose-missed-moves to use seconds, or fix worker to store ms.");
