#!/usr/bin/env node
/**
 * Refresh KV from actual latest ingest_receipts per ticker.
 * Use after replay to fix stale data (replay keeps last-seen-per-bucket; this gets true latest).
 *
 * Usage:
 *   TIMED_API_KEY=your_key node scripts/refresh-latest-from-ingest.js
 */
const API_BASE =
  process.env.TIMED_API_BASE || "https://timed-trading-ingest.shashant.workers.dev";
const API_KEY = process.env.TIMED_API_KEY || "";

if (!API_KEY) {
  console.error("Error: TIMED_API_KEY is required");
  process.exit(1);
}

async function main() {
  const limit = parseInt(process.env.LIMIT || "25", 10) || 25;
  let totalRefreshed = 0;
  let offset = 0;
  while (true) {
    const url = `${API_BASE}/timed/admin/refresh-latest-from-ingest?key=${API_KEY}&limit=${limit}&offset=${offset}`;
    const res = await fetch(url, { method: "POST" });
    const data = await res.json();
    if (!data.ok) {
      console.error(data);
      process.exit(1);
    }
    totalRefreshed += data.refreshed || 0;
    console.log(`Batch offset=${offset}: refreshed=${data.refreshed}, total=${totalRefreshed}`);
    if (!data.hasMore || data.refreshed === 0) break;
    offset += limit;
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log(`Done. Total refreshed: ${totalRefreshed}`);
  const syncUrl = `${API_BASE}/timed/admin/force-sync?key=${API_KEY}`;
  const syncRes = await fetch(syncUrl, { method: "POST" });
  const syncData = await syncRes.json();
  console.log("Force-sync:", JSON.stringify(syncData));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
