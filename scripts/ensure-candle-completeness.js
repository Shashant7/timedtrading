#!/usr/bin/env node
/**
 * ensure-candle-completeness.js — Fill ALL candle gaps via worker API
 *
 * Reads the audit report and calls POST /timed/admin/alpaca-backfill
 * (which uses TwelveData, the primary provider) per-ticker for every gap.
 * The worker already has the TWELVEDATA_API_KEY in its secrets.
 *
 * Usage:
 *   node scripts/ensure-candle-completeness.js               # backfill all gaps
 *   node scripts/ensure-candle-completeness.js --dry-run      # show plan only
 *   node scripts/ensure-candle-completeness.js --batch 5      # tickers per API call
 *   node scripts/ensure-candle-completeness.js --tf 10        # only backfill one TF
 */

const path = require("path");
const fs = require("fs");

const args = process.argv.slice(2);
const getArg = (name, dflt) => {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : dflt;
};
const hasFlag = (name) => args.includes(`--${name}`);

const DRY_RUN = hasFlag("dry-run");
const BATCH_SIZE = Number(getArg("batch", "1"));
const TF_FILTER = getArg("tf", null);
const API_BASE = process.env.WORKER_BASE || "https://timed-trading-ingest.shashant.workers.dev";
const API_KEY = process.env.TIMED_API_KEY || "AwesomeSauce";

const B = "\x1b[1m", G = "\x1b[32m", R = "\x1b[31m", Y = "\x1b[33m", RST = "\x1b[0m";

const auditPath = path.join(__dirname, "..", "data", "audit-data-completeness.json");
if (!fs.existsSync(auditPath)) {
  console.error("No audit report. Run: USE_D1=1 node scripts/audit-data-completeness.js");
  process.exit(1);
}
const audit = JSON.parse(fs.readFileSync(auditPath, "utf-8"));

console.log(`\n${B}╔══════════════════════════════════════════════════════════════╗${RST}`);
console.log(`${B}║   Ensure Candle Completeness (via Worker API)                ║${RST}`);
console.log(`${B}╚══════════════════════════════════════════════════════════════╝${RST}\n`);
console.log(`  Audit: ${audit.generated}`);
console.log(`  Candle gaps: ${audit.candle_gaps.length} tickers`);
console.log(`  Batch: ${BATCH_SIZE}  |  TF filter: ${TF_FILTER || "all"}`);
if (DRY_RUN) console.log(`  ${Y}DRY RUN${RST}`);
console.log();

// Collect unique tickers needing backfill
const tickersToBackfill = new Set();
for (const gap of audit.candle_gaps) {
  const allGaps = [...(gap.missing || []), ...(gap.late || [])];
  for (const g of allGaps) {
    if (TF_FILTER && g.tf !== TF_FILTER) continue;
    tickersToBackfill.add(gap.ticker);
  }
}

const allTickers = [...tickersToBackfill].sort();
console.log(`  Tickers to backfill: ${allTickers.length}`);
if (allTickers.length === 0) {
  console.log(`  ${G}All candles complete!${RST}`);
  process.exit(0);
}
if (DRY_RUN) {
  console.log(`  Would backfill: ${allTickers.join(", ")}`);
  process.exit(0);
}

async function backfillTicker(ticker, tf = "all") {
  const params = new URLSearchParams({ key: API_KEY, ticker, tf });
  const url = `${API_BASE}/timed/admin/alpaca-backfill?${params}`;
  const resp = await fetch(url, { method: "POST" });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`HTTP ${resp.status}: ${text.slice(0, 300)}`);
  }
  return resp.json();
}

async function main() {
  const t0 = Date.now();
  let completed = 0, failed = 0, totalUpserted = 0;

  for (let i = 0; i < allTickers.length; i++) {
    const ticker = allTickers[i];
    const elapsed = ((Date.now() - t0) / 60000).toFixed(1);
    const eta = i > 0 ? (((Date.now() - t0) / i) * (allTickers.length - i) / 60000).toFixed(0) : "?";

    process.stdout.write(`  [${i + 1}/${allTickers.length}] ${ticker.padEnd(8)} (${elapsed}m, ~${eta}m left) `);

    try {
      const result = await backfillTicker(ticker, TF_FILTER || "all");
      if (result.ok) {
        const upserted = result.upserted || 0;
        totalUpserted += upserted;
        completed++;
        console.log(`${G}ok${RST} (${upserted} bars)`);
      } else {
        failed++;
        console.log(`${R}err: ${result.error || "unknown"}${RST}`);
      }
    } catch (e) {
      failed++;
      console.log(`${R}FAIL: ${String(e.message || e).slice(0, 150)}${RST}`);
    }

    // Pace: avoid overwhelming the worker / TwelveData rate limits
    if (i < allTickers.length - 1) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  const totalMin = ((Date.now() - t0) / 60000).toFixed(1);
  console.log(`\n${B}╔══════════════════════════════════════════════════════════════╗${RST}`);
  console.log(`${B}║   COMPLETE                                                   ║${RST}`);
  console.log(`${B}╚══════════════════════════════════════════════════════════════╝${RST}`);
  console.log(`  Completed: ${completed}  |  Failed: ${failed}  |  Bars: ${totalUpserted}  |  Time: ${totalMin}m`);
  console.log(`\n  Next: Re-run audit to verify:`);
  console.log(`    USE_D1=1 node scripts/audit-data-completeness.js\n`);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
