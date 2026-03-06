#!/usr/bin/env node

/**
 * Batch correct entry prices for all closed trades using 10m candle at entry_ts.
 * Fixes trades where stored entry_price differs from our candle data.
 *
 * Usage:
 *   TIMED_API_KEY=your_key node scripts/correct-all-entry-prices.js
 *   TIMED_API_KEY=your_key node scripts/correct-all-entry-prices.js --dry-run
 *   TIMED_API_KEY=your_key node scripts/correct-all-entry-prices.js --limit 100
 */

const fs = require("fs");
const path = require("path");
try {
  const envPath = path.resolve(process.cwd(), ".env");
  if (fs.existsSync(envPath)) {
    const buf = fs.readFileSync(envPath, "utf8");
    buf.split("\n").forEach((line) => {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
    });
  }
} catch (_) {}

const API_BASE = process.env.TIMED_API_BASE || "https://timed-trading-ingest.shashant.workers.dev";
const API_KEY = process.env.TIMED_API_KEY || "";

if (!API_KEY) {
  console.error("Error: TIMED_API_KEY is required");
  console.error("  TIMED_API_KEY=your_key node scripts/correct-all-entry-prices.js");
  process.exit(1);
}

const dryRun = process.argv.includes("--dry-run");
const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const limit = limitArg ? parseInt(limitArg.split("=")[1], 10) : 500;

async function run() {
  const url = `${API_BASE}/timed/admin/trade-autopsy/correct-all-entries?${dryRun ? "dryRun=1&" : ""}limit=${limit}&key=${API_KEY}`;
  console.log(`${dryRun ? "[DRY RUN] " : ""}POST ${url}\n`);

  const res = await fetch(url, { method: "POST", cache: "no-store" });
  const data = await res.json();

  if (!data.ok) {
    console.error("Error:", data.error || res.status);
    process.exit(1);
  }

  console.log(`Processed: ${data.processed}`);
  console.log(`Corrected: ${data.corrected}`);
  console.log(`Skipped: ${data.skipped}`);
  if (data.errors > 0) console.log(`Errors: ${data.errors}`);

  if (data.details?.length > 0) {
    console.log("\nCorrected trades (sample):");
    for (const d of data.details.slice(0, 15)) {
      console.log(`  ${d.ticker} ${d.trade_id}: $${d.old_entry_price?.toFixed(2)} → $${d.new_entry_price?.toFixed(2)} (${d.diff_pct}% diff)`);
    }
  }
  if (data.skipped_sample?.length > 0) {
    console.log("\nSkipped (sample):", data.skipped_sample);
  }

  if (dryRun && data.corrected > 0) {
    console.log(`\nRun without --dry-run to apply corrections.`);
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
