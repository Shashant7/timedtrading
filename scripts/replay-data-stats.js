#!/usr/bin/env node
/**
 * Check D1 replay data: timed_trail vs ingest_receipts row counts and payload_json presence.
 * Use to confirm if replay-ticker-d1 (timed_trail) is a better alternative for single-ticker replay.
 *
 * Run:
 *   TIMED_API_KEY=your_key node scripts/replay-data-stats.js
 *   DATE=2026-02-02 TICKER=AAPL TIMED_API_KEY=your_key node scripts/replay-data-stats.js
 */
const API_BASE =
  process.env.TIMED_API_BASE || "https://timed-trading-ingest.shashant.workers.dev";
const API_KEY = process.env.TIMED_API_KEY || "";
const DATE = process.env.DATE || "";
const TICKER = (process.env.TICKER || "").trim().toUpperCase();

if (!API_KEY) {
  console.error("Error: TIMED_API_KEY is required");
  process.exit(1);
}

function nyTradingDayKey() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function main() {
  const dayKey = DATE && /^\d{4}-\d{2}-\d{2}$/.test(DATE) ? DATE : nyTradingDayKey();
  const params = new URLSearchParams({ key: API_KEY, date: dayKey });
  if (TICKER) params.set("ticker", TICKER);

  const url = `${API_BASE}/timed/admin/replay-data-stats?${params}`;
  const resp = await fetch(url);
  const data = await resp.json();

  if (!data.ok) {
    console.error("Error:", data);
    process.exit(1);
  }

  console.log(JSON.stringify(data, null, 2));
  if (data.recommendation) console.log("\nRecommendation:", data.recommendation);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
