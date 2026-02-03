#!/usr/bin/env node
/**
 * Replay ingestion from ingest_receipts bucket-by-bucket (Script Version 2.5.0).
 * Avoids D1 memory limits; processes as if ingestion were happening in real time.
 *
 * Run:
 *   TIMED_API_KEY=your_key node scripts/replay-ingest.js
 *   DATE=2026-02-02 CLEAN_SLATE=1 TIMED_API_KEY=your_key node scripts/replay-ingest.js
 *   TICKER=BE DATE=2026-02-02 CLEAN_SLATE=1 TIMED_API_KEY=your_key node scripts/replay-ingest.js
 */
const API_BASE =
  process.env.TIMED_API_BASE || "https://timed-trading-ingest.shashant.workers.dev";
const API_KEY = process.env.TIMED_API_KEY || "";
const DATE = process.env.DATE || "";
const TICKER = (process.env.TICKER || "").trim().toUpperCase();
const CLEAN_SLATE = process.env.CLEAN_SLATE !== "0" && process.env.CLEAN_SLATE !== "false";
const DELAY_MS = parseInt(process.env.DELAY_MS || "200", 10) || 0;
const DEBUG = process.env.DEBUG === "1" || process.env.DEBUG === "true";

if (!API_KEY) {
  console.error("Error: TIMED_API_KEY is required");
  console.error("  TIMED_API_KEY=your_key node scripts/replay-ingest.js");
  process.exit(1);
}

function nyTradingDayKey() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function replay() {
  const dayKey = DATE && /^\d{4}-\d{2}-\d{2}$/.test(DATE) ? DATE : nyTradingDayKey();
  let bucket = null;
  let totalRows = 0;
  let totalTrades = 0;
  let totalPurged = 0;
  let bucketCount = 0;
  let cleanSlate = CLEAN_SLATE;

  console.log(`Replaying ingest (date=${dayKey})${TICKER ? ` ticker=${TICKER}` : ""}${cleanSlate ? " [clean slate]" : ""}${DEBUG ? " [debug]" : ""}...`);

  let bucketOffset = 0;
  while (true) {
    const params = new URLSearchParams({ key: API_KEY, date: dayKey });
    if (TICKER) params.set("ticker", TICKER);
    if (cleanSlate) params.set("cleanSlate", "1");
    if (bucket != null) params.set("bucket", String(bucket));
    if (bucketOffset > 0) params.set("bucketOffset", String(bucketOffset));
    if (DEBUG) params.set("debug", "1");

    const url = `${API_BASE}/timed/admin/replay-ingest?${params}`;
    const resp = await fetch(url, { method: "POST" });
    const data = await resp.json();

    if (!data.ok) {
      console.error("Error:", data);
      process.exit(1);
    }

    totalRows += data.rowsProcessed || 0;
    totalTrades += data.tradesCreated || 0;
    totalPurged += data.tradesPurged || 0;

    const pageMsg = data.hasMoreInBucket ? ` (page to ${data.nextBucketOffset})` : "";
    const purgedMsg = data.tradesPurged ? `, purged: ${data.tradesPurged}` : "";
    console.log(
      `  bucket ${bucketCount + 1}: ${data.rowsProcessed || 0} rows, +${data.tradesCreated || 0} trades${pageMsg}${purgedMsg}`,
    );
    if (DEBUG && data.debug) {
      if (data.debug.enterNowCount) console.log(`    [debug] enter_now count this page: ${data.debug.enterNowCount}`);
      if (data.debug.rows?.length) data.debug.rows.forEach((r) => console.log(`    [debug] ${JSON.stringify(r)}`));
    }

    cleanSlate = false;

    if (data.hasMoreInBucket) {
      bucketOffset = data.nextBucketOffset;
      if (DELAY_MS > 0) await new Promise((r) => setTimeout(r, DELAY_MS));
      continue;
    }

    bucketCount += 1;
    bucketOffset = 0;
    if (!data.hasMore || data.nextBucket == null) break;
    bucket = data.nextBucket;
    if (DELAY_MS > 0) await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  const purgedMsg = totalPurged > 0 ? `, trades purged: ${totalPurged}` : "";
  console.log(`\nDone. Buckets: ${bucketCount}, rows: ${totalRows}, trades created: ${totalTrades}${purgedMsg}\n`);

  console.log("Refreshing latest from ingest (fixes stale data from replay)...");
  const refreshUrl = `${API_BASE}/timed/admin/refresh-latest-from-ingest?key=${API_KEY}`;
  const limit = parseInt(process.env.REFRESH_LIMIT || "25", 10) || 25;
  let totalRefreshed = 0;
  let offset = 0;
  while (true) {
    const url = `${refreshUrl}&limit=${limit}&offset=${offset}`;
    const r = await fetch(url, { method: "POST" });
    const d = await r.json();
    if (!d.ok) break;
    totalRefreshed += d.refreshed || 0;
    if (!d.hasMore || d.refreshed === 0) break;
    offset += limit;
    await new Promise((x) => setTimeout(x, 300));
  }
  console.log(`Refreshed ${totalRefreshed} tickers from latest ingest.\n`);

  console.log("Syncing to D1...");
  const syncUrl = `${API_BASE}/timed/admin/force-sync?key=${API_KEY}`;
  const syncResp = await fetch(syncUrl, { method: "POST" });
  const syncData = await syncResp.json();
  console.log(JSON.stringify(syncData, null, 2));
}

replay().catch((err) => {
  console.error(err);
  process.exit(1);
});
