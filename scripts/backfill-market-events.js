#!/usr/bin/env node
/**
 * Seed historical market_events via the deployed worker admin route.
 *
 * Usage:
 *   TIMED_API_KEY=... node scripts/backfill-market-events.js
 *   TIMED_API_KEY=... node scripts/backfill-market-events.js --dry-run
 *   TIMED_API_KEY=... node scripts/backfill-market-events.js --earnings-only
 *   TIMED_API_KEY=... node scripts/backfill-market-events.js --macro-only
 *   TIMED_API_KEY=... node scripts/backfill-market-events.js --ticker LRN
 */

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const EARNINGS_ONLY = args.includes("--earnings-only");
const MACRO_ONLY = args.includes("--macro-only");

function getFlagValue(flag, fallback = "") {
  const idx = args.indexOf(flag);
  if (idx === -1) return fallback;
  return args[idx + 1] || fallback;
}

const API_BASE = process.env.TIMED_API_BASE || process.env.API_BASE || "https://timed-trading-ingest.shashant.workers.dev";
const API_KEY = process.env.TIMED_API_KEY || process.env.TIMED_ADMIN_KEY || process.env.API_KEY || "";
const START_DATE = getFlagValue("--start", "2025-07-01");
const END_DATE = getFlagValue("--end", "2026-04-02");
const TICKER = String(getFlagValue("--ticker", "") || "").toUpperCase().trim();

if (!API_KEY) {
  console.error("Missing admin key. Set TIMED_API_KEY, TIMED_ADMIN_KEY, or API_KEY.");
  process.exit(1);
}

async function postSeed(params) {
  const url = new URL(`${API_BASE}/timed/admin/backfill-market-events`);
  Object.entries(params).forEach(([key, value]) => {
    if (value == null || value === "") return;
    url.searchParams.set(key, String(value));
  });
  url.searchParams.set("key", API_KEY);
  const resp = await fetch(url, { method: "POST", headers: { Accept: "application/json" } });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data?.ok === false) {
    const msg = data?.error || `${resp.status} ${resp.statusText}`;
    throw new Error(msg);
  }
  return data;
}

async function main() {
  console.log(`Seeding market_events via worker (${START_DATE} -> ${END_DATE})${DRY_RUN ? " [DRY RUN]" : ""}`);

  if (!EARNINGS_ONLY) {
    const macro = await postSeed({
      startDate: START_DATE,
      endDate: END_DATE,
      macroOnly: 1,
      dryRun: DRY_RUN ? 1 : 0,
    });
    console.log(`Macro seed: ${macro.macroSeeded || 0} events`);
  }

  if (MACRO_ONLY) {
    console.log("Macro-only seed complete.");
    return;
  }

  if (TICKER) {
    const single = await postSeed({
      startDate: START_DATE,
      endDate: END_DATE,
      earningsOnly: 1,
      ticker: TICKER,
      dryRun: DRY_RUN ? 1 : 0,
    });
    console.log(`Ticker ${TICKER}: ${single.earningsSeeded || 0} earnings events`);
    if (Array.isArray(single.errors) && single.errors.length) {
      console.log(`Errors: ${JSON.stringify(single.errors.slice(0, 5), null, 2)}`);
    }
    return;
  }

  const bulk = await postSeed({
    startDate: START_DATE,
    endDate: END_DATE,
    earningsOnly: 1,
    allTickers: 1,
    dryRun: DRY_RUN ? 1 : 0,
  });
  console.log(`Earnings seed: tickers=${bulk.earningsTickersProcessed || 0}, events=${bulk.earningsSeeded || 0}`);
  if (Array.isArray(bulk.errors) && bulk.errors.length) {
    console.log(`Warnings: ${JSON.stringify(bulk.errors.slice(0, 5))}`);
  }
  console.log("Bulk earnings seed complete.");
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
