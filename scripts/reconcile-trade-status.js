#!/usr/bin/env node

/**
 * Fix status for closed trades where status disagrees with pnl (e.g. LOSS with +P&L).
 *
 * Usage:
 *   TIMED_API_KEY=your_key node scripts/reconcile-trade-status.js
 *   TIMED_API_KEY=your_key node scripts/reconcile-trade-status.js --dry-run
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
  process.exit(1);
}

const dryRun = process.argv.includes("--dry-run");

async function run() {
  const url = `${API_BASE}/timed/admin/trade-autopsy/reconcile-status?${dryRun ? "dryRun=1&" : ""}key=${API_KEY}`;
  console.log(`${dryRun ? "[DRY RUN] " : ""}POST ${url}\n`);

  const res = await fetch(url, { method: "POST", cache: "no-store" });
  const data = await res.json();

  if (!data.ok) {
    console.error("Error:", data.error || res.status);
    process.exit(1);
  }

  console.log(`Processed: ${data.processed}`);
  console.log(`Fixed: ${data.fixed}`);
  if (data.details?.length > 0) {
    console.log("\nFixed trades (sample):");
    for (const d of data.details.slice(0, 15)) {
      console.log(`  ${d.ticker} ${d.trade_id}: ${d.old_status} → ${d.new_status} (pnl=$${Number(d.pnl).toFixed(2)})`);
    }
  }
  if (dryRun && data.fixed > 0) {
    console.log(`\nRun without --dry-run to apply.`);
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
