#!/usr/bin/env node
/**
 * Backfill Trail 5m Facts — Extended
 * 
 * Orchestrates candle-replay with trailOnly=1 for trading days,
 * then triggers data lifecycle aggregation in chunks.
 *
 * Usage:
 *   TIMED_API_KEY=AwesomeSauce node scripts/backfill-trail-facts.js
 *   TIMED_API_KEY=AwesomeSauce node scripts/backfill-trail-facts.js --dates 2026-02-05,2026-02-06
 *   TIMED_API_KEY=AwesomeSauce node scripts/backfill-trail-facts.js --from 2025-10-01 --to 2026-02-06
 *   TIMED_API_KEY=AwesomeSauce node scripts/backfill-trail-facts.js --batch 20 --chunk 5
 */

const TIMED_KEY = process.env.TIMED_API_KEY || "AwesomeSauce";
const WORKER_BASE = process.env.WORKER_BASE || "https://timed-trading-ingest.shashant.workers.dev";

// US market holidays (NYSE closed)
const HOLIDAYS = new Set([
  "2025-09-01", "2025-11-27", "2025-12-25",
  "2026-01-01", "2026-01-19", "2026-02-16",
]);

function generateTradingDays(from, to) {
  const days = [];
  const d = new Date(from + "T12:00:00Z");
  const end = new Date(to + "T12:00:00Z");
  while (d <= end) {
    const ds = d.toISOString().slice(0, 10);
    const wd = d.getUTCDay(); // 0=Sun, 6=Sat
    if (wd > 0 && wd < 6 && !HOLIDAYS.has(ds)) {
      days.push(ds);
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return days;
}

async function runCandleReplay(date, tickerOffset, tickerBatch) {
  const params = new URLSearchParams({
    key: TIMED_KEY,
    date,
    tickerOffset: String(tickerOffset),
    tickerBatch: String(tickerBatch),
    intervalMinutes: "5",
    trailOnly: "1",
  });

  const url = `${WORKER_BASE}/timed/admin/candle-replay?${params}`;
  const resp = await fetch(url, { method: "POST" });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`HTTP ${resp.status}: ${text.slice(0, 300)}`);
  }

  return resp.json();
}

async function triggerLifecycle() {
  const url = `${WORKER_BASE}/timed/admin/run-lifecycle?key=${TIMED_KEY}`;
  const resp = await fetch(url, { method: "POST" });
  return resp.json();
}

async function replayOneDay(date, batchSize) {
  let offset = 0;
  let hasMore = true;
  let dayScored = 0;
  let daySkipped = 0;
  let batchNum = 0;

  while (hasMore) {
    batchNum++;
    process.stdout.write(`    B${batchNum}(${offset}): `);

    try {
      const result = await runCandleReplay(date, offset, batchSize);

      if (!result.ok && result.error) {
        console.error(`ERR: ${result.error}`);
        break;
      }

      const scored = result.scored || 0;
      const skipped = result.skipped || 0;
      dayScored += scored;
      daySkipped += skipped;

      process.stdout.write(`${scored}s `);

      hasMore = result.hasMore === true;
      offset = result.nextTickerOffset || (offset + batchSize);
    } catch (e) {
      process.stdout.write(`FAIL `);
      offset += batchSize;
      if (batchNum > 30) break;
    }

    // Small delay between batches
    await new Promise(r => setTimeout(r, 300));
  }

  return { scored: dayScored, skipped: daySkipped };
}

async function main() {
  const args = process.argv.slice(2);
  let dates = null;
  let fromDate = "2025-10-01";
  let toDate = "2026-02-06";
  let batchSize = 20;
  let chunkSize = 5; // aggregate after every N days

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dates" && args[i + 1]) {
      dates = args[++i].split(",").map(d => d.trim());
    }
    if (args[i] === "--from" && args[i + 1]) fromDate = args[++i];
    if (args[i] === "--to" && args[i + 1]) toDate = args[++i];
    if (args[i] === "--batch" && args[i + 1]) batchSize = parseInt(args[++i]);
    if (args[i] === "--chunk" && args[i + 1]) chunkSize = parseInt(args[++i]);
  }

  if (!dates) {
    dates = generateTradingDays(fromDate, toDate);
  }

  console.log(`\n╔══════════════════════════════════════════════╗`);
  console.log(`║   Trail 5m Facts Extended Backfill           ║`);
  console.log(`╚══════════════════════════════════════════════╝`);
  console.log(`  Dates: ${dates[0]} → ${dates[dates.length - 1]} (${dates.length} trading days)`);
  console.log(`  Batch: ${batchSize} tickers/request, Chunk: ${chunkSize} days before aggregation`);
  console.log(`  Worker: ${WORKER_BASE}`);
  console.log();

  let totalScored = 0;
  let totalDays = 0;
  const startTime = Date.now();

  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    const dayNum = i + 1;
    const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    const eta = i > 0 ? (((Date.now() - startTime) / i * (dates.length - i)) / 1000 / 60).toFixed(0) : "?";

    process.stdout.write(`  [${dayNum}/${dates.length}] ${date} (${elapsed}m elapsed, ~${eta}m left): `);

    const { scored, skipped } = await replayOneDay(date, batchSize);
    totalScored += scored;
    totalDays++;

    console.log(`→ ${scored} scored, ${skipped} skipped`);

    // Aggregate after every chunk to keep timed_trail manageable
    if ((i + 1) % chunkSize === 0 || i === dates.length - 1) {
      process.stdout.write(`  ⚡ Aggregating trail → 5m facts... `);
      try {
        const lifecycle = await triggerLifecycle();
        console.log(lifecycle.ok ? "✓" : `⚠ ${lifecycle.error || "unknown"}`);
      } catch (e) {
        console.log(`⚠ ${e.message}`);
      }
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  const totalMin = ((Date.now() - startTime) / 1000 / 60).toFixed(1);

  console.log(`\n╔══════════════════════════════════════════════╗`);
  console.log(`║   COMPLETE                                   ║`);
  console.log(`╚══════════════════════════════════════════════╝`);
  console.log(`  Days replayed: ${totalDays}`);
  console.log(`  Total scored snapshots: ${totalScored.toLocaleString()}`);
  console.log(`  Time: ${totalMin} minutes`);
  console.log(`  Avg: ${(totalScored / totalDays).toFixed(0)} snapshots/day`);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
