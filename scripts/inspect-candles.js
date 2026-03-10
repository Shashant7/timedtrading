#!/usr/bin/env node

/**
 * Inspect candles for a ticker at a specific date/time.
 * Useful for debugging entry price mismatches (e.g. Trade Autopsy vs TradingView).
 *
 * Usage:
 *   TICKER=FIX DATE=2025-09-18 TIME=12:10 node scripts/inspect-candles.js
 *   TICKER=FIX DATE=2025-09-18 TIME=12:10 node scripts/inspect-candles.js --d1
 *
 * Options:
 *   TICKER     - Ticker symbol (default: FIX)
 *   DATE       - YYYY-MM-DD (default: 2025-09-18)
 *   TIME       - HH:MM in Eastern (e.g. 12:10 = 12:10 PM ET)
 *   TF         - Timeframe to inspect (default: 10 for 10m bars)
 *   --d1       - Query D1 directly via wrangler (requires wrangler auth)
 *
 * The script:
 *   1. Converts DATE+TIME (Eastern) to UTC ms for asOfTs
 *   2. Fetches GET /timed/candles?ticker=X&tf=10&limit=50&asOfTs=...
 *   3. Prints candles around that time, highlighting the bar at 12:10
 *
 * With --d1: runs wrangler d1 execute to query ticker_candles directly.
 */

const API_BASE = process.env.TIMED_API_BASE || "https://timed-trading-ingest.shashant.workers.dev";
const API_KEY = process.env.TIMED_API_KEY || "";
const TICKER = (process.env.TICKER || "FIX").toUpperCase();
const DATE = process.env.DATE || "2025-09-18";
const TIME = process.env.TIME || "12:10";
const TF = process.env.TF || "10";
const USE_D1 = process.argv.includes("--d1");

// Parse "12:10" (ET) → UTC ms for that moment
// Sep 18 2025 12:10 PM ET (EDT = UTC-4) = 16:10 UTC
function etToUtcMs(dateStr, timeStr) {
  const [h, m] = timeStr.split(":").map(Number);
  const d = new Date(`${dateStr}T${String(h).padStart(2, "0")}:${String(m || 0).padStart(2, "0")}:00-04:00`);
  if (isNaN(d.getTime())) {
    // Fallback: assume UTC if parse fails
    return new Date(`${dateStr}T${String(h).padStart(2, "0")}:${String(m || 0).padStart(2, "0")}:00Z`).getTime();
  }
  return d.getTime();
}

function formatTs(ts) {
  if (!ts) return "N/A";
  const d = new Date(ts);
  return d.toISOString().replace("T", " ").slice(0, 19) + "Z";
}

async function fetchViaApi() {
  const asOfTs = etToUtcMs(DATE, TIME);
  const qs = new URLSearchParams({
    ticker: TICKER,
    tf: TF,
    limit: "50",
    asOfTs: String(asOfTs),
  });
  if (API_KEY) qs.set("key", API_KEY);

  const url = `${API_BASE}/timed/candles?${qs.toString()}`;
  console.log(`Fetching: ${url}\n`);

  const res = await fetch(url, { cache: "no-store" });
  const data = await res.json();

  if (!data?.ok || !Array.isArray(data.candles)) {
    console.error("Error:", data?.error || res.status, JSON.stringify(data).slice(0, 200));
    process.exit(1);
  }

  const candles = data.candles;
  console.log(`Found ${candles.length} candles for ${TICKER} tf=${TF} (asOfTs <= ${formatTs(asOfTs)})\n`);

  if (candles.length === 0) {
    console.log("No candles. Possible causes:");
    console.log("  - No backfill for this ticker/date");
    console.log("  - Date is outside backfill range");
    console.log("  - Wrong timezone (script uses Eastern)");
    return;
  }

  // Find the bar that would be used at asOfTs (last bar with ts <= asOfTs)
  const targetBar = candles.filter((c) => c.ts <= asOfTs).pop();
  const lastBar = candles[candles.length - 1];

  console.log("Candles around target time (last 15):");
  console.log("─".repeat(90));
  const start = Math.max(0, candles.length - 15);
  for (let i = start; i < candles.length; i++) {
    const c = candles[i];
    const marker = c === targetBar ? " ← used for entry" : c === lastBar ? " (last in set)" : "";
    console.log(
      `  ${formatTs(c.ts)}  O=${c.o?.toFixed(2)} H=${c.h?.toFixed(2)} L=${c.l?.toFixed(2)} C=${c.c?.toFixed(2)}${marker}`
    );
  }
  console.log("─".repeat(90));

  if (targetBar) {
    console.log(`\nEntry price source: 10m close = $${targetBar.c?.toFixed(2)} (bar ending ${formatTs(targetBar.ts)})`);
  } else {
    console.log("\nNo bar with ts <= asOfTs — entry would use fallback (result.price)");
  }
}

async function queryD1() {
  const asOfTs = etToUtcMs(DATE, TIME);
  // 9:30 AM ET = 13:30 UTC (EDT), 4:00 PM ET = 20:00 UTC
  const dayStart = new Date(`${DATE}T13:30:00Z`).getTime();
  const dayEnd = new Date(`${DATE}T20:00:00Z`).getTime();

  const scriptDir = process.cwd();
  const workerDir = scriptDir.replace(/\/scripts$/, "") + "/worker";
  const dbName = "timed-trading-ledger";
  const envFlag = "--env production";

  const sql = `SELECT ts, o, h, l, c, v FROM ticker_candles 
    WHERE ticker = '${TICKER}' AND tf = '${TF}' 
    AND ts >= ${dayStart} AND ts <= ${dayEnd}
    ORDER BY ts`;

  console.log(`Querying D1: ${sql}\n`);

  const { execSync } = require("child_process");
  try {
    const out = execSync(
      `npx wrangler d1 execute ${dbName} --remote ${envFlag} --json --command "${sql.replace(/"/g, '\\"')}"`,
      { cwd: workerDir, encoding: "utf-8" }
    );
    const parsed = JSON.parse(out);
    const rows = parsed?.[0]?.results || parsed?.results || [];
    console.log(`Found ${rows.length} rows for ${TICKER} tf=${TF} on ${DATE}\n`);

    if (rows.length === 0) {
      console.log("No rows. Run backfill for this ticker/date.");
      return;
    }

    const targetRow = rows.filter((r) => r.ts <= asOfTs).pop();
    console.log("Candles:");
    console.log("─".repeat(90));
    for (const r of rows.slice(-15)) {
      const marker = r.ts === targetRow?.ts ? " ← used for entry" : "";
      console.log(
        `  ${formatTs(r.ts)}  O=${Number(r.o).toFixed(2)} H=${Number(r.h).toFixed(2)} L=${Number(r.l).toFixed(2)} C=${Number(r.c).toFixed(2)}${marker}`
      );
    }
    console.log("─".repeat(90));
    if (targetRow) {
      console.log(`\nEntry price: 10m close = $${Number(targetRow.c).toFixed(2)} (bar ending ${formatTs(targetRow.ts)})`);
    }
  } catch (e) {
    console.error("D1 query failed:", e.message);
    console.error("Ensure: cd worker && npx wrangler d1 execute ... works (wrangler auth + production env)");
    process.exit(1);
  }
}

async function main() {
  console.log(`Inspect candles: ${TICKER} @ ${DATE} ${TIME} ET, tf=${TF}\n`);
  if (USE_D1) {
    await queryD1();
  } else {
    await fetchViaApi();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
