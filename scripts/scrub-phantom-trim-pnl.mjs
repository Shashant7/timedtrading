#!/usr/bin/env node
/**
 * Scrub phantom trim P&L from trade_events + account_ledger (SNDK/NFLX May 2026).
 *
 * Dry-run (default):
 *   node scripts/scrub-phantom-trim-pnl.mjs
 *
 * Apply via production worker admin route:
 *   node scripts/scrub-phantom-trim-pnl.mjs --apply
 *
 * Env:
 *   WORKER_URL  — default https://timed-trading.com
 *   TIMED_API_KEY — required for --apply
 */
const WORKER_URL = process.env.WORKER_URL || "https://timed-trading.com";
const API_KEY = process.env.TIMED_API_KEY || "";
const tickers = (process.env.TICKERS || "SNDK,NFLX").toUpperCase();
const apply = process.argv.includes("--apply");

const url = new URL("/timed/admin/trade-events/scrub-phantom-trims", WORKER_URL);
url.searchParams.set("tickers", tickers);
url.searchParams.set("dryRun", apply ? "false" : "true");

if (apply && !API_KEY) {
  console.error("TIMED_API_KEY required for --apply");
  process.exit(1);
}

const headers = { Accept: "application/json" };
if (API_KEY) headers["X-API-Key"] = API_KEY;

const res = await fetch(url.toString(), { method: "POST", headers });
const body = await res.json().catch(() => ({}));

console.log(JSON.stringify(body, null, 2));
if (!res.ok) process.exit(1);

if (!apply && body.phantom_event_updates > 0) {
  console.error("\nRe-run with --apply and TIMED_API_KEY to write fixes.");
}
