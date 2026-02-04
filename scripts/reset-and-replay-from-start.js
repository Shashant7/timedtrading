#!/usr/bin/env node
/**
 * Reset all trades (account back to $100k baseline) and replay from the first
 * date with valid data through today, using current scoring and execution logic.
 *
 * 1. Clear all trades (KV + D1)
 * 2. Discover first date with data (ingest_receipts, 7-day retention)
 * 3. Replay each trading day from first date to today
 *
 * Usage:
 *   TIMED_API_KEY=your_key node scripts/reset-and-replay-from-start.js
 *   TIMED_API_KEY=your_key FROM=2026-02-02 node scripts/reset-and-replay-from-start.js  # replay from this date to today
 *   TIMED_API_KEY=your_key TICKERS_FILE=tradingview/WATCHLIST_Q1_2026.txt node scripts/reset-and-replay-from-start.js
 *
 * Set TIMED_API_KEY in .env for convenience.
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

function todayKey() {
  const d = new Date();
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

async function replayDay(dayKey) {
  let offset = 0;
  let totalRows = 0;
  let totalTrades = 0;
  for (;;) {
    const params = new URLSearchParams({
      key: API_KEY,
      date: dayKey,
      cleanSlate: "0",
      bucketMinutes: "5",
      limit: "150",
      offset: String(offset),
    });
    const url = `${API_BASE}/timed/admin/replay-day?${params}`;
    const resp = await fetch(url, { method: "POST" });
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error || data.message || "replay-day failed");
    const rows = data.rowsProcessed ?? 0;
    const created = data.tradesCreated ?? 0;
    totalRows += rows;
    totalTrades += created;
    if (!data.hasMore || data.nextOffset == null) break;
    offset = data.nextOffset;
    await new Promise((r) => setTimeout(r, 100));
  }
  return { totalRows, totalTrades };
}

async function main() {
  if (!API_KEY) {
    console.error("TIMED_API_KEY is required");
    process.exit(1);
  }

  console.log("1. Resetting system (clear all trades; account restarts at $100,000)...");
  const resetUrl = `${API_BASE}/timed/admin/reset?key=${encodeURIComponent(API_KEY)}&resetLedger=1`;
  const resetRes = await fetch(resetUrl, { method: "POST" });
  const resetData = await resetRes.json();
  if (!resetData.ok) {
    console.error("Reset failed:", resetData);
    process.exit(1);
  }
  console.log("   OK. KV and D1 cleared.");

  const today = todayKey();
  let days;

  if (FROM && /^\d{4}-\d{2}-\d{2}$/.test(FROM)) {
    days = tradingDaysBetween(FROM, today);
    console.log(`\n2. Replay from ${FROM} to ${today} (${days.length} trading days).`);
  } else {
    console.log("\n2. Discovering date range with valid data...");
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
      console.log("   No replayable data found (ingest_receipts empty or outside 7-day retention).");
      console.log("   Run ingest from TradingView, then retry. Or set FROM=YYYY-MM-DD to replay from a specific date.");
      process.exit(0);
    }

    const endDate = lastDate > today ? today : lastDate;
    days = tradingDaysBetween(firstDate, endDate);
    console.log(`   First: ${firstDate} | Last: ${lastDate} | Trading days to replay: ${days.length}`);
  }

  console.log("\n3. Replaying each day (current scoring + execution logic)...");
  let grandTotalTrades = 0;
  for (let i = 0; i < days.length; i++) {
    const day = days[i];
    const { totalRows: rows, totalTrades: trades } = await replayDay(day);
    grandTotalTrades += trades;
    console.log(`   [${i + 1}/${days.length}] ${day} — ${rows} rows, +${trades} trades`);
    if (i < days.length - 1) await new Promise((r) => setTimeout(r, 500));
  }

  console.log("\n4. Syncing to D1...");
  const syncUrl = `${API_BASE}/timed/admin/force-sync?key=${encodeURIComponent(API_KEY)}`;
  await fetch(syncUrl, { method: "POST" });

  console.log("\nDone. Days replayed:", days.length, "| Total trades:", grandTotalTrades);
  console.log("Open the Trade Tracker / simulation dashboard to view positions and P&L.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
