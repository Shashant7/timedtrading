#!/usr/bin/env node
/**
 * Remove tickers not in WATCHLIST_Q1_2026 from the system.
 * Call POST /timed/cleanup-tickers to filter out tickers from other TV watchlists.
 *
 * Usage:
 *   One-time purge (remove tickers not in watchlist):
 *     TIMED_API_KEY=your_key node scripts/cleanup-tickers-to-watchlist.js --strict
 *   Ongoing cleanup (accept new tickers into Social):
 *     TIMED_API_KEY=your_key node scripts/cleanup-tickers-to-watchlist.js
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

async function main() {
  if (!API_KEY) {
    console.error("TIMED_API_KEY is required");
    process.exit(1);
  }

  const strict = process.argv.includes("--strict");
  console.log(strict ? "One-time purge: removing tickers not in WATCHLIST_Q1_2026..." : "Cleanup: keeping watchlist + Social additions...");
  const url = `${API_BASE}/timed/cleanup-tickers?key=${encodeURIComponent(API_KEY)}${strict ? "&strict=1" : ""}`;
  const res = await fetch(url, { method: "POST" });
  const data = await res.json();

  if (!data.ok) {
    console.error("Cleanup failed:", data);
    process.exit(1);
  }

  console.log("OK.", data.message || "Cleanup complete.");
  console.log(`  Removed: ${data.removed ?? 0} tickers`);
  console.log(`  Kept: ${data.kept ?? 0} tickers`);
  if (data.tradesPurged != null && data.tradesPurged > 0) {
    console.log(`  Trades purged: ${data.tradesPurged} (tickers removed from ledger)`);
  }
  if (Array.isArray(data.addedToSocialTickers) && data.addedToSocialTickers.length > 0) {
    console.log(`  Added to Social: ${data.addedToSocial} —`, data.addedToSocialTickers.join(", "));
  }
  if (Array.isArray(data.removedTickers) && data.removedTickers.length > 0) {
    console.log("  Removed tickers:", data.removedTickers.join(", "));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
