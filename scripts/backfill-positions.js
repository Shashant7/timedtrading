#!/usr/bin/env node
/**
 * Backfill positions/lots/execution_actions from existing D1 trades + trade_events.
 * Calls worker POST /timed/admin/backfill-positions (idempotent).
 *
 * Usage:
 *   TIMED_API_KEY=your_key node scripts/backfill-positions.js
 *   TIMED_API_KEY=your_key LIMIT=50 OFFSET=0 node scripts/backfill-positions.js
 *   TIMED_API_KEY=your_key TICKER=AAPL node scripts/backfill-positions.js
 */
const path = require("path");
const fs = require("fs");

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
const LIMIT = process.env.LIMIT || "";
const OFFSET = process.env.OFFSET || "";
const TICKER = process.env.TICKER ? process.env.TICKER.trim().toUpperCase() : "";

async function main() {
  if (!API_KEY) {
    console.error("TIMED_API_KEY is required");
    process.exit(1);
  }

  const params = new URLSearchParams({ key: API_KEY });
  if (LIMIT) params.set("limit", LIMIT);
  if (OFFSET) params.set("offset", OFFSET);
  if (TICKER) params.set("ticker", TICKER);

  const url = `${API_BASE}/timed/admin/backfill-positions?${params.toString()}`;
  console.log("POST", url.replace(API_KEY, "***"));
  const res = await fetch(url, { method: "POST" });
  const data = await res.json();

  if (!res.ok) {
    console.error("HTTP", res.status, data);
    process.exit(1);
  }
  if (!data.ok) {
    console.error("Backfill failed:", data);
    process.exit(1);
  }

  console.log("OK:", {
    tradesProcessed: data.tradesProcessed,
    positionsInserted: data.positionsInserted,
    lotsInserted: data.lotsInserted,
    actionsInserted: data.actionsInserted,
    errorsCount: data.errorsCount || 0,
  });
  if (data.errors && data.errors.length) {
    console.error("Errors:", data.errors.slice(0, 10));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
