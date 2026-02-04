#!/usr/bin/env node
/**
 * Check replay progress: how many trading days have been replayed vs total in the window.
 * Infers progress from trades (latest entry date) and data-range (available dates).
 *
 * Usage:
 *   TIMED_API_KEY=your_key node scripts/check-replay-progress.js
 *   FROM=2026-02-02 TIMED_API_KEY=your_key node scripts/check-replay-progress.js   # progress for Feb 2 → today only
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
const FROM = (process.env.FROM || "").trim();

function msToDateKey(ms) {
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function isWeekend(dateStr) {
  const d = new Date(dateStr + "T12:00:00Z");
  const day = d.getUTCDay();
  return day === 0 || day === 6;
}

function tradingDaysBetween(first, last) {
  const days = [];
  const start = new Date(first + "T12:00:00Z");
  const end = new Date(last + "T12:00:00Z");
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    const key = `${y}-${m}-${day}`;
    if (!isWeekend(key)) days.push(key);
  }
  return days;
}

async function main() {
  if (!API_KEY) {
    console.error("TIMED_API_KEY is required");
    process.exit(1);
  }

  // 1. Get data range (what dates have replayable data)
  const rangeUrl = `${API_BASE}/timed/admin/data-range?key=${encodeURIComponent(API_KEY)}`;
  const rangeRes = await fetch(rangeUrl);
  const rangeData = await rangeRes.json();
  if (!rangeData.ok) {
    console.error("Data range failed:", rangeData);
    process.exit(1);
  }
  const firstDate = rangeData.firstDate;
  const lastDate = rangeData.lastDate;
  const totalRows = rangeData.totalRows ?? 0;

  if (!firstDate || !lastDate || totalRows === 0) {
    console.log("No replayable data (ingest_receipts empty).");
    process.exit(0);
  }

  const today = msToDateKey(Date.now());
  const endDate = lastDate > today ? today : lastDate;
  const windowStart = FROM && /^\d{4}-\d{2}-\d{2}$/.test(FROM) ? FROM : firstDate;
  const allDays = tradingDaysBetween(windowStart, endDate);

  // 2. Get trades to infer last processed date
  const tradesUrl = `${API_BASE}/timed/trades?source=d1`;
  const tradesRes = await fetch(tradesUrl);
  const tradesData = await tradesRes.json();
  const trades = Array.isArray(tradesData?.trades) ? tradesData.trades : (tradesData?.data && Array.isArray(tradesData.data) ? tradesData.data : []);

  let latestEntryMs = 0;
  let tradeCount = 0;
  for (const t of trades) {
    const et = t?.entry_ts ?? t?.entryTime ?? t?.entryTs;
    let ms = typeof et === "number" ? et : null;
    if (ms == null && typeof et === "string") ms = Date.parse(et);
    if (Number.isFinite(ms) && ms > latestEntryMs) latestEntryMs = ms;
    tradeCount++;
  }

  const lastTradeDate = msToDateKey(latestEntryMs);
  const daysReplayed = lastTradeDate ? tradingDaysBetween(windowStart, lastTradeDate).length : 0;

  console.log("Replay progress");
  console.log("──────────────");
  console.log(`Data range:     ${firstDate} → ${lastDate} (${totalRows.toLocaleString()} ingest rows)`);
  if (FROM && windowStart === FROM) {
    console.log(`Replay window:  ${windowStart} → ${endDate} (FROM=... set)`);
  }
  console.log(`Trading days:   ${allDays.length} days`);
  console.log(`Trades:         ${tradeCount}`);
  console.log(`Last trade:     ${lastTradeDate || "none"}`);
  console.log(`Days replayed:  ~${daysReplayed} of ${allDays.length}`);
  if (daysReplayed >= allDays.length) {
    console.log("\n✓ Replay appears complete.");
  } else if (daysReplayed > 0) {
    console.log(`\n~${allDays.length - daysReplayed} days remaining. Run: TIMED_API_KEY=... node scripts/reset-and-replay-from-start.js`);
  } else {
    console.log("\nReplay not started or no trades yet. Run reset-and-replay-from-start.js to begin.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
