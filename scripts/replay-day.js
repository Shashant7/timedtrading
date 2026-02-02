#!/usr/bin/env node
/**
 * Replay today's (or date's) timed_trail ingests in chronological order.
 * Run: TIMED_API_KEY=your_key node scripts/replay-day.js
 *      DATE=2026-02-02 TIMED_API_KEY=your_key node scripts/replay-day.js
 */
const API_BASE =
  process.env.TIMED_API_BASE || "https://timed-trading-ingest.shashant.workers.dev";
const API_KEY = process.env.TIMED_API_KEY || "";
const DATE = process.env.DATE || "";
const START_OFFSET = parseInt(process.env.OFFSET || "0", 10) || 0;
const CLEAN_SLATE = process.env.CLEAN_SLATE !== "0" && process.env.CLEAN_SLATE !== "false";
const BUCKET_MINUTES = parseInt(process.env.BUCKET_MINUTES || "0", 10) || 0;
const TICKER = (process.env.TICKER || "").trim().toUpperCase();

if (!API_KEY) {
  console.error("Error: TIMED_API_KEY is required");
  console.error("  TIMED_API_KEY=your_key node scripts/replay-day.js");
  process.exit(1);
}

async function replay() {
  const query = new URLSearchParams({ key: API_KEY });
  if (DATE) query.set("date", DATE);
  if (TICKER) query.set("ticker", TICKER);
  if (CLEAN_SLATE) query.set("cleanSlate", "1");
  if (BUCKET_MINUTES > 0) query.set("bucketMinutes", String(BUCKET_MINUTES));
  const baseUrl = `${API_BASE}/timed/admin/replay-day`;

  let offset = START_OFFSET;
  let totalRows = 0;
  let totalTrades = 0;
  let totalPurged = 0;

  console.log(`Replaying day (date=${DATE || "today"})${TICKER ? ` ticker=${TICKER}` : ""}${CLEAN_SLATE ? " [clean slate]" : ""}${BUCKET_MINUTES ? ` [${BUCKET_MINUTES}m buckets]` : ""}${START_OFFSET ? ` from offset ${START_OFFSET}` : ""}...`);

  while (true) {
    const url = `${baseUrl}?${query}&limit=25&offset=${offset}`;
    const resp = await fetch(url, { method: "POST" });
    const data = await resp.json();

    console.log(JSON.stringify(data, null, 2));

    if (!data.ok) {
      console.error("Stopping: response ok=", data.ok);
      process.exit(1);
    }

    totalRows += data.rowsProcessed || 0;
    totalTrades += data.tradesCreated || 0;
    if (data.tradesPurged) totalPurged += data.tradesPurged;

    if (!data.hasMore || data.nextOffset == null) break;

    offset = data.nextOffset;
    console.log(`--- Batch done. Next offset: ${offset} ---`);
    await new Promise((r) => setTimeout(r, 500));
  }

  const purgedMsg = totalPurged > 0 ? `, trades purged: ${totalPurged}` : "";
  console.log(
    `\nDone. Rows processed: ${totalRows}, trades created: ${totalTrades}${purgedMsg}\n`
  );

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
