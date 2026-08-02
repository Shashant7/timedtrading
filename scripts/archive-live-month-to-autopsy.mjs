#!/usr/bin/env node
/**
 * Archive live short-term + long-term positions opened in a month into
 * Trade Autopsy for grading feedback.
 *
 * Usage:
 *   TIMED_API_KEY=… node scripts/archive-live-month-to-autopsy.mjs \
 *     --month=2026-07 \
 *     [--mode=both|trader|investor] \
 *     [--api-base=https://timed-trading-ingest.shashant.workers.dev]
 */

const MONTH = (() => {
  const a = process.argv.find((x) => x.startsWith("--month="));
  return a ? a.slice("--month=".length) : "2026-07";
})();
const MODE = (() => {
  const a = process.argv.find((x) => x.startsWith("--mode="));
  return a ? a.slice("--mode=".length) : "both";
})();
const API_BASE = (
  process.argv.find((x) => x.startsWith("--api-base="))?.slice("--api-base=".length)
  || process.env.TIMED_API_BASE
  || "https://timed-trading-ingest.shashant.workers.dev"
).replace(/\/$/, "");
const API_KEY = process.env.TIMED_API_KEY || process.env.TIMED_TRADING_API_KEY || "";

if (!API_KEY) {
  console.error("ERROR: TIMED_API_KEY required");
  process.exit(2);
}
if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(MONTH)) {
  console.error("ERROR: --month must be YYYY-MM");
  process.exit(2);
}

const body = {
  month: MONTH,
  mode: MODE,
  include_open: true,
  trader_run_id: `live-short-term-${MONTH}`,
  investor_run_id: `live-long-term-${MONTH}`,
};

console.log(`[archive-live-month] ${API_BASE} month=${MONTH} mode=${MODE}`);
const res = await fetch(`${API_BASE}/timed/admin/trade-autopsy/archive-live-month`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${API_KEY}`,
    "User-Agent": "TimedTradingAgent/archive-live-month",
  },
  body: JSON.stringify(body),
});
const json = await res.json().catch(() => ({}));
console.log(JSON.stringify(json, null, 2));
if (!res.ok || !json?.ok) process.exit(6);

for (const book of json.books || []) {
  if (book?.autopsy_url) {
    console.log(`Grade: https://timed-trading.com${book.autopsy_url}`);
  }
}
