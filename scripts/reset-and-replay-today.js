#!/usr/bin/env node
/**
 * Clear all trade ledgers (KV + D1) and replay one trading day as if first day live.
 * "First day" = trading day starting at 9:30 AM ET on the given date (e.g. Feb 2, 2026).
 *
 * Usage:
 *   TIMED_API_KEY=your_key node scripts/reset-and-replay-today.js
 *   TIMED_API_KEY=your_key DATE=2026-02-02 TICKERS=AAPL,AMD,AMZN,BE,GOLD node scripts/reset-and-replay-today.js
 *   Or set TIMED_API_KEY in .env in project root (loaded automatically if present).
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
const DATE = process.env.DATE || "";
const TICKERS_STR = process.env.TICKERS || "AAPL,AMD,AMZN,BE,GOLD";

function todayKey() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function main() {
  if (!API_KEY) {
    console.error("TIMED_API_KEY is required");
    process.exit(1);
  }

  const dayKey = DATE && /^\d{4}-\d{2}-\d{2}$/.test(DATE) ? DATE : todayKey();
  const tickers = TICKERS_STR.split(",").map((t) => t.trim().toUpperCase()).filter(Boolean);
  if (tickers.length === 0) {
    console.error("TICKERS is required (e.g. TICKERS=AAPL,AMD)");
    process.exit(1);
  }

  console.log("1. Resetting system (clear all trade ledgers: KV + D1)...");
  const resetUrl = `${API_BASE}/timed/admin/reset?key=${encodeURIComponent(API_KEY)}&resetLedger=1`;
  const resetRes = await fetch(resetUrl, { method: "POST" });
  const resetData = await resetRes.json();
  if (!resetData.ok) {
    console.error("Reset failed:", resetData);
    process.exit(1);
  }
  console.log("   OK. KV cleared:", resetData.kvCleared?.join(", ") || "—");
  console.log("   D1 cleared:", resetData.d1Cleared?.length ? "yes" : "no");
  console.log("   Tickers reset:", resetData.tickers?.processed ?? 0);

  console.log("\n2. Replaying", dayKey, "for", tickers.length, "tickers (clean slate = first day)...");
  let totalTrades = 0;
  for (const ticker of tickers) {
    const params = new URLSearchParams({
      key: API_KEY,
      date: dayKey,
      ticker,
      cleanSlate: "1",
    });
    const url = `${API_BASE}/timed/admin/replay-ticker-d1?${params}`;
    const resp = await fetch(url, { method: "POST" });
    const data = await resp.json();
    const created = data.tradesCreated ?? 0;
    totalTrades += created;
    const status = data.ok ? `OK (${data.rowsProcessed ?? 0} rows, +${created} trades)` : `FAIL: ${data.error || JSON.stringify(data)}`;
    console.log("   ", ticker, "—", status);
  }

  console.log("\nDone. Date:", dayKey, "| Tickers:", tickers.length, "| Total trades created:", totalTrades);
  console.log("Open the Trade Tracker / simulation dashboard to see open positions, account value, trades by day, P&L by ticker.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
