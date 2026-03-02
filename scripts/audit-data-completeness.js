#!/usr/bin/env node
/**
 * audit-data-completeness.js — Full Universe Data Audit
 *
 * Checks EVERY SECTOR_MAP ticker for:
 *   1. Candle completeness (all 7 TFs back to 2025-07-01)
 *   2. Trail_5m_facts coverage (date range, row count)
 *
 * Outputs a structured report to data/audit-data-completeness.json
 * and a console summary with actionable gap list.
 *
 * Usage:
 *   USE_D1=1 node scripts/audit-data-completeness.js [--since 2025-07-01]
 */

const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const args = process.argv.slice(2);
const getArg = (name, dflt) => {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : dflt;
};

const SINCE = getArg("since", "2025-07-01");
const SINCE_MS = new Date(SINCE + "T00:00:00Z").getTime();
const WORKER_DIR = path.join(__dirname, "../worker");
const USE_D1 = process.env.USE_D1 === "1" || process.env.USE_D1 === "true";

if (!USE_D1) { console.error("Usage: USE_D1=1 node scripts/audit-data-completeness.js"); process.exit(1); }

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

const B = "\x1b[1m", G = "\x1b[32m", R = "\x1b[31m", Y = "\x1b[33m", C = "\x1b[36m", RST = "\x1b[0m";
const t0 = Date.now();
function elapsed() { return `${((Date.now() - t0) / 1000).toFixed(1)}s`; }

const TFS = ["M", "W", "D", "240", "60", "30", "10"];
const MIN_BARS = { M: 6, W: 30, D: 150, "240": 500, "60": 1000, "30": 1000, "10": 1000 };

console.log(`\n${B}╔══════════════════════════════════════════════════════════════╗${RST}`);
console.log(`${B}║   Full Universe Data Completeness Audit                       ║${RST}`);
console.log(`${B}╚══════════════════════════════════════════════════════════════╝${RST}\n`);
console.log(`  Since: ${SINCE}  |  Source: D1 (production)\n`);

// Step 1: Get the SECTOR_MAP tickers from the worker
const sectorMapPath = path.join(__dirname, "../worker/sector-mapping.js");
let SECTOR_MAP = {};
if (fs.existsSync(sectorMapPath)) {
  const mod = require(sectorMapPath);
  SECTOR_MAP = mod.SECTOR_MAP || mod.default || {};
}
if (Object.keys(SECTOR_MAP).length === 0) {
  // Fallback: extract from worker/index.js
  const workerSrc = fs.readFileSync(path.join(__dirname, "../worker/index.js"), "utf-8");
  const match = workerSrc.match(/const SECTOR_MAP\s*=\s*\{/);
  if (match) {
    console.error("Could not load SECTOR_MAP from sector-mapping.js, and inline extraction is complex. Aborting.");
    process.exit(1);
  }
}

const allTickers = Object.keys(SECTOR_MAP).filter(t => /^[A-Z]/.test(t));
console.log(`  Universe: ${allTickers.length} tickers in SECTOR_MAP\n`);

// Step 2: Query candle coverage per ticker/TF (batch by TF)
console.log(`  [${elapsed()}] Auditing candle coverage...\n`);

const candleAudit = {};
for (const tf of TFS) {
  process.stdout.write(`    TF=${tf}: querying...`);
  const rows = queryD1(
    `SELECT ticker, COUNT(*) as cnt, MIN(ts) as min_ts, MAX(ts) as max_ts FROM ticker_candles WHERE tf='${tf}' GROUP BY ticker`
  );
  for (const r of rows) {
    const t = String(r.ticker).toUpperCase();
    if (!candleAudit[t]) candleAudit[t] = {};
    const minTs = Number(r.min_ts);
    const maxTs = Number(r.max_ts);
    candleAudit[t][tf] = {
      count: r.cnt,
      min_ts: minTs,
      max_ts: maxTs,
      min_date: new Date(minTs > 1e12 ? minTs : minTs * 1000).toISOString().slice(0, 10),
      max_date: new Date(maxTs > 1e12 ? maxTs : maxTs * 1000).toISOString().slice(0, 10),
    };
  }
  console.log(` ${rows.length} tickers`);
}

// Step 3: Query trail_5m_facts coverage per ticker
console.log(`\n  [${elapsed()}] Auditing trail_5m_facts coverage...\n`);

const trailAudit = {};
const TRAIL_BATCH = 30;
const tickerList = [...allTickers]; // only audit SECTOR_MAP tickers
for (let i = 0; i < tickerList.length; i += TRAIL_BATCH) {
  const batch = tickerList.slice(i, i + TRAIL_BATCH);
  const inClause = batch.map(t => `'${t}'`).join(",");
  const rows = queryD1(
    `SELECT ticker, COUNT(*) as cnt, MIN(bucket_ts) as min_ts, MAX(bucket_ts) as max_ts FROM trail_5m_facts WHERE ticker IN (${inClause}) GROUP BY ticker`
  );
  for (const r of rows) {
    const t = String(r.ticker).toUpperCase();
    const minTs = Number(r.min_ts);
    const maxTs = Number(r.max_ts);
    trailAudit[t] = {
      count: r.cnt,
      min_ts: minTs,
      max_ts: maxTs,
      min_date: new Date(minTs).toISOString().slice(0, 10),
      max_date: new Date(maxTs).toISOString().slice(0, 10),
    };
  }
  process.stdout.write(`\r    trail: ${Math.min(i + TRAIL_BATCH, tickerList.length)}/${tickerList.length} tickers...`);
}
console.log("\n");

// Step 4: Analyze gaps
console.log(`  [${elapsed()}] Analyzing gaps...\n`);

const report = {
  generated: new Date().toISOString(),
  since: SINCE,
  universe_size: allTickers.length,
  candle_gaps: [],
  trail_gaps: [],
  summary: {},
};

let candleOk = 0, candleGap = 0;
let trailOk = 0, trailMissing = 0, trailLate = 0;

for (const ticker of allTickers) {
  const ca = candleAudit[ticker] || {};
  const missingTfs = [];
  const lateTfs = [];

  for (const tf of TFS) {
    if (!ca[tf] || ca[tf].count === 0) {
      missingTfs.push({ tf, reason: "no_data" });
    } else if (ca[tf].count < MIN_BARS[tf]) {
      missingTfs.push({ tf, reason: "insufficient", count: ca[tf].count, need: MIN_BARS[tf], earliest: ca[tf].min_date });
    } else {
      // Check if earliest data is close enough to SINCE date (within 30 days for D and higher TFs)
      const earliestMs = ca[tf].min_ts > 1e12 ? ca[tf].min_ts : ca[tf].min_ts * 1000;
      const allowedLateMs = tf === "M" ? 60 * 86400000 : tf === "W" ? 30 * 86400000 : 14 * 86400000;
      if (earliestMs > SINCE_MS + allowedLateMs) {
        lateTfs.push({ tf, earliest: ca[tf].min_date, needed: SINCE });
      }
    }
  }

  if (missingTfs.length > 0 || lateTfs.length > 0) {
    candleGap++;
    report.candle_gaps.push({ ticker, missing: missingTfs, late: lateTfs });
  } else {
    candleOk++;
  }

  // Trail check
  const tr = trailAudit[ticker];
  if (!tr || tr.count === 0) {
    trailMissing++;
    report.trail_gaps.push({ ticker, reason: "no_data", count: 0 });
  } else {
    // Trail should start within 14 days of SINCE
    if (tr.min_ts > SINCE_MS + 14 * 86400000) {
      trailLate++;
      report.trail_gaps.push({ ticker, reason: "late_start", earliest: tr.min_date, needed: SINCE, count: tr.count });
    } else {
      trailOk++;
    }
  }
}

report.summary = {
  candles: { ok: candleOk, gaps: candleGap, total: allTickers.length },
  trail: { ok: trailOk, missing: trailMissing, late_start: trailLate, total: allTickers.length },
};

// Step 5: Console report
console.log(`${B}═══ CANDLE COVERAGE ═══${RST}\n`);
console.log(`  ${G}Complete:${RST}  ${candleOk}/${allTickers.length}`);
console.log(`  ${R}Gaps:${RST}      ${candleGap}/${allTickers.length}\n`);

if (report.candle_gaps.length > 0) {
  console.log(`  ${Y}Tickers with candle gaps:${RST}`);
  for (const g of report.candle_gaps.slice(0, 30)) {
    const parts = [];
    for (const m of g.missing) {
      if (m.reason === "no_data") parts.push(`${R}${m.tf}:NONE${RST}`);
      else parts.push(`${Y}${m.tf}:${m.count}/${m.need}${RST}`);
    }
    for (const l of g.late) parts.push(`${Y}${l.tf}:late(${l.earliest})${RST}`);
    console.log(`    ${g.ticker.padEnd(8)} ${parts.join("  ")}`);
  }
  if (report.candle_gaps.length > 30) console.log(`    ... and ${report.candle_gaps.length - 30} more`);
}

console.log(`\n${B}═══ TRAIL_5M_FACTS COVERAGE ═══${RST}\n`);
console.log(`  ${G}Complete:${RST}     ${trailOk}/${allTickers.length}`);
console.log(`  ${R}Missing:${RST}      ${trailMissing}/${allTickers.length}`);
console.log(`  ${Y}Late start:${RST}   ${trailLate}/${allTickers.length}\n`);

if (trailMissing > 0) {
  const missing = report.trail_gaps.filter(g => g.reason === "no_data").map(g => g.ticker);
  console.log(`  ${R}No trail data:${RST} ${missing.join(", ")}`);
}
if (trailLate > 0) {
  const late = report.trail_gaps.filter(g => g.reason === "late_start").slice(0, 20);
  console.log(`  ${Y}Late start tickers:${RST}`);
  for (const g of late) {
    console.log(`    ${g.ticker.padEnd(8)} starts ${g.earliest} (need ${g.needed}), ${g.count} rows`);
  }
  if (report.trail_gaps.filter(g => g.reason === "late_start").length > 20)
    console.log(`    ... and more`);
}

// Save report
const outPath = path.join(__dirname, "..", "data", "audit-data-completeness.json");
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(`\n  ${G}Report saved:${RST} ${outPath}`);
console.log(`  Done in ${elapsed()}\n`);
