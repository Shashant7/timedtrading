#!/usr/bin/env node
/**
 * Run ticker-specific replay with debug=1 to trace why trades aren't created.
 * Aggregates debug output across buckets.
 *
 * Usage:
 *   TICKER=AMD DATE=2026-02-02 TIMED_API_KEY=... node scripts/replay-debug.js
 */
const API_BASE =
  process.env.TIMED_API_BASE || "https://timed-trading-ingest.shashant.workers.dev";
const API_KEY = process.env.TIMED_API_KEY || "";
const TICKER = (process.env.TICKER || "").trim().toUpperCase();
const DATE = process.env.DATE || "";

if (!API_KEY || !TICKER) {
  console.error("Usage: TICKER=AMD DATE=2026-02-02 TIMED_API_KEY=... node scripts/replay-debug.js");
  process.exit(1);
}

function nyDay() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")}`;
}

const dayKey = DATE && /^\d{4}-\d{2}-\d{2}$/.test(DATE) ? DATE : nyDay();

async function main() {
  let bucket = null;
  const allDebug = [];
  let enterNowTotal = 0;

  console.log(`Replay debug for ${TICKER} (date=${dayKey})...\n`);

  while (true) {
    const params = new URLSearchParams({ key: API_KEY, date: dayKey, ticker: TICKER, debug: "1" });
    if (bucket != null) params.set("bucket", String(bucket));

    const res = await fetch(`${API_BASE}/timed/admin/replay-ingest?${params}`, { method: "POST" });
    const data = await res.json();

    if (!data.ok) {
      console.error("Error:", data);
      process.exit(1);
    }

    if (data.debug) {
      enterNowTotal += data.debug.enterNowCount || 0;
      (data.debug.rows || []).forEach((r) => allDebug.push(r));
    }

    if (!data.hasMore || data.nextBucket == null) break;
    bucket = data.nextBucket;
    await new Promise((r) => setTimeout(r, 100));
  }

  console.log("=== DEBUG SUMMARY ===\n");
  console.log(`Rows with stage=enter_now: ${enterNowTotal}`);
  console.log(`Sample debug rows: ${allDebug.length}\n`);

  const enterNowSamples = allDebug.filter((r) => r.stage === "enter_now");
  const watchSamples = allDebug.filter((r) => r.stage === "watch" || r.reason?.includes("watch"));

  if (enterNowSamples.length > 0) {
    console.log("--- enter_now samples (blockers when shouldTrigger=false) ---");
    enterNowSamples.forEach((r, i) => {
      const ts = r.ts ? new Date(r.ts).toISOString().slice(11, 19) : "?";
      console.log(`  ${i + 1}. ts=${ts} shouldTrigger=${r.shouldTrigger} rank=${r.rank} rr=${r.rr} comp=${r.comp}`);
      if (r.blockers?.length) console.log(`     blockers: ${r.blockers.join(", ")}`);
    });
    console.log("");
  }

  if (watchSamples.length > 0) {
    console.log("--- watch samples (momentum+corridor but not enter_now) ---");
    watchSamples.forEach((r, i) => {
      console.log(`  ${i + 1}. ts=${r.ts ? new Date(r.ts).toISOString().slice(11, 19) : "?"} rank=${r.rank} score=${r.score} trigger=${r.trigger_reason} reason=${r.reason || ""}`);
    });
  }

  if (enterNowTotal === 0 && watchSamples.length === 0) {
    console.log("No enter_now or watch samples captured. classifyKanbanStage may never return enter_now for this ticker.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
