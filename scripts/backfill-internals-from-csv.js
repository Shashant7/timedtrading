#!/usr/bin/env node
/**
 * scripts/backfill-internals-from-csv.js
 *
 * Loads TradingView USI:TICK / USI:ADD CSVs into KV under
 * `timed:internals:historical:{TICK|ADD}:{day}` for the replay engine
 * to consume during backtest.
 *
 * The data is grouped by UTC date — each KV value is an array of
 * 5min OHLC bars for that day, sorted by ts ascending.
 *
 * Usage:
 *   node scripts/backfill-internals-from-csv.js \
 *     --tick=/path/to/USI_TICK_5m.csv \
 *     --add=/path/to/USI_ADD_5m.csv
 *
 * The CSV format expected:
 *   time,open,high,low,close
 *   1745847000,293,603,250,497
 *   ...
 * (time = unix seconds)
 */
const fs = require("fs");
const { execSync } = require("child_process");
const path = require("path");

function parseArgs(argv) {
  const out = {};
  for (const a of argv.slice(2)) {
    if (a.startsWith("--")) {
      const [k, v] = a.replace(/^--/, "").split("=");
      out[k] = v ?? true;
    }
  }
  return out;
}

function loadCsv(path) {
  const text = fs.readFileSync(path, "utf8");
  const lines = text.split(/\r?\n/).filter(Boolean);
  const header = lines.shift().toLowerCase().split(",");
  const ti = header.indexOf("time");
  const oi = header.indexOf("open");
  const hi = header.indexOf("high");
  const li = header.indexOf("low");
  const ci = header.indexOf("close");
  if (ti < 0) throw new Error(`No 'time' column in ${path}`);
  return lines.map((line) => {
    const cols = line.split(",");
    return {
      ts: Number(cols[ti]) * 1000,  // seconds → ms
      o: Number(cols[oi]),
      h: Number(cols[hi]),
      l: Number(cols[li]),
      c: Number(cols[ci]),
    };
  });
}

function groupByDay(bars) {
  const byDay = {};
  for (const b of bars) {
    const day = new Date(b.ts).toISOString().slice(0, 10);
    (byDay[day] = byDay[day] || []).push(b);
  }
  // Sort each day ascending
  for (const day of Object.keys(byDay)) {
    byDay[day].sort((a, b) => a.ts - b.ts);
  }
  return byDay;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.tick && !args.add) {
    console.error("Usage: backfill-internals-from-csv.js --tick=<path> --add=<path>");
    process.exit(1);
  }

  const namespaceId = args.namespace || "e48593af3ef74bf986b2592909ed40cb";
  const dryRun = args["dry-run"] === true || args["dry-run"] === "true";

  const sources = [];
  if (args.tick) sources.push({ indicator: "TICK", path: args.tick });
  if (args.add) sources.push({ indicator: "ADD", path: args.add });

  for (const { indicator, path: csvPath } of sources) {
    console.log(`\n=== Loading ${indicator} from ${csvPath} ===`);
    const bars = loadCsv(csvPath);
    console.log(`  Total bars: ${bars.length}`);
    if (bars.length === 0) continue;
    console.log(`  Range: ${new Date(bars[0].ts).toISOString()} → ${new Date(bars[bars.length-1].ts).toISOString()}`);

    const byDay = groupByDay(bars);
    const days = Object.keys(byDay).sort();
    console.log(`  Days: ${days.length}`);

    if (dryRun) {
      console.log(`  DRY RUN — would write ${days.length} KV keys`);
      continue;
    }

    let written = 0;
    let failed = 0;
    for (const day of days) {
      const dayBars = byDay[day];
      const key = `timed:internals:historical:${indicator}:${day}`;
      const valueJson = JSON.stringify(dayBars);
      // Use wrangler kv key put. We pipe the value via stdin to handle large payloads.
      try {
        // Write to temp file then use --path flag
        const tmpPath = `/tmp/_kv_internals_${indicator}_${day}.json`;
        fs.writeFileSync(tmpPath, valueJson);
        execSync(
          `wrangler kv key put --remote --namespace-id=${namespaceId} '${key}' --path="${tmpPath}"`,
          { stdio: ["ignore", "ignore", "pipe"], env: process.env }
        );
        fs.unlinkSync(tmpPath);
        written++;
        if (written % 25 === 0) {
          console.log(`    [${indicator}] Written ${written}/${days.length}...`);
        }
      } catch (e) {
        failed++;
        console.error(`    [${indicator}] FAILED ${day}: ${String(e?.message || e).slice(0, 200)}`);
      }
    }
    console.log(`  ${indicator} backfill done: written=${written}, failed=${failed}`);
  }
}

main().catch((e) => {
  console.error("backfill error:", e);
  process.exit(1);
});
