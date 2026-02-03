#!/usr/bin/env node
/**
 * Replay a single ticker from D1 timed_trail (payload_json).
 * One request: reads all rows for the day from D1, processes in memory, writes KV only at end (avoids 429).
 *
 * Run:
 *   TIMED_API_KEY=your_key TICKER=AAPL node scripts/replay-ticker-d1.js
 *   DATE=2026-02-02 CLEAN_SLATE=1 TIMED_API_KEY=your_key TICKER=AAPL node scripts/replay-ticker-d1.js
 *
 * By default we seed with last known state before 9:30am (bridge 4pm–9:30am). To disable: includePrevPeriod=0.
 */
const API_BASE =
  process.env.TIMED_API_BASE || "https://timed-trading-ingest.shashant.workers.dev";
const API_KEY = process.env.TIMED_API_KEY || "";
const DATE = process.env.DATE || "";
const TICKER = (process.env.TICKER || "").trim().toUpperCase();
const CLEAN_SLATE = process.env.CLEAN_SLATE !== "0" && process.env.CLEAN_SLATE !== "false";

if (!API_KEY) {
  console.error("Error: TIMED_API_KEY is required");
  process.exit(1);
}
if (!TICKER) {
  console.error("Error: TICKER is required (e.g. TICKER=AAPL)");
  process.exit(1);
}

function nyTradingDayKey() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const DEBUG = process.env.DEBUG === "1" || process.env.DEBUG === "true";

async function main() {
  const dayKey = DATE && /^\d{4}-\d{2}-\d{2}$/.test(DATE) ? DATE : nyTradingDayKey();
  const params = new URLSearchParams({ key: API_KEY, date: dayKey, ticker: TICKER });
  if (CLEAN_SLATE) params.set("cleanSlate", "1");
  if (DEBUG) params.set("debug", "1");

  const url = `${API_BASE}/timed/admin/replay-ticker-d1?${params}`;
  const resp = await fetch(url, { method: "POST" });
  const data = await resp.json();

  if (!data.ok) {
    console.error("Error:", data);
    process.exit(1);
  }

  console.log(`Replay (D1 timed_trail) ${TICKER} date=${dayKey}${CLEAN_SLATE ? " [clean slate]" : ""}${DEBUG ? " [debug]" : ""}`);
  if (DEBUG && data.analysis) {
    console.log("\n--- Analysis ---");
    console.log(`Enter Now moments: ${data.analysis.enterNowCount}`);
    console.log(`Forced to Watch (missing trigger): ${data.analysis.forcedWatchCount}`);
    console.log(`Forced to Enter Now (cycle gate): ${data.analysis.forcedEnterNowCount}`);
    console.log(`First-bar-of-day bridge: ${data.analysis.firstBarBridgeCount}`);
    if (data.analysis.rows && data.analysis.rows.length > 0) {
      const enterNow = data.analysis.rows.filter((r) => r.finalStage === "enter_now");
      if (enterNow.length > 0) {
        console.log("\n--- Enter Now rows (blockers / shouldTrigger) ---");
        enterNow.forEach((r, i) => {
          console.log(`${i + 1}. ${r.time} stage=${r.stage}→${r.finalStage} shouldTrigger=${r.shouldTrigger} blockers=${JSON.stringify(r.blockers || [])} rank=${r.rank} rr=${r.rr} comp=${r.comp != null ? (r.comp * 100).toFixed(0) + "%" : "—"} trigger_reason=${r.trigger_reason || "—"}`);
        });
      }
      const forced = data.analysis.rows.filter((r) => r.forcedReason);
      if (forced.length > 0) {
        console.log("\n--- Forced lane changes ---");
        forced.slice(0, 20).forEach((r, i) => {
          console.log(`${i + 1}. ${r.time} ${r.stage}→${r.finalStage} reason=${r.forcedReason} state=${r.state}`);
        });
        if (forced.length > 20) console.log(`... and ${forced.length - 20} more`);
      }
    }
    console.log("\n--- Full response (analysis.rows truncated in log) ---");
    const { analysis, ...rest } = data;
    console.log(JSON.stringify({ ...rest, analysis: analysis ? { ...analysis, rowCount: analysis.rows?.length } : null }, null, 2));
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
  console.log(`\nDone. Rows: ${data.rowsProcessed || 0}, trades created: ${data.tradesCreated || 0}, purged: ${data.tradesPurged || 0}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
