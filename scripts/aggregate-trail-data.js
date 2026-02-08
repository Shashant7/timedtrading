#!/usr/bin/env node
/**
 * Aggregate Trail Data - Convert 1m raw data to 5m fact tables
 * 
 * Strategy:
 *   1. Aggregate timed_trail older than 48h into trail_5m_facts
 *   2. Purge old raw data (timed_trail, ingest_receipts) older than 48h
 *   3. Vacuum the database to reclaim space
 * 
 * Run: TIMED_API_KEY=xxx node scripts/aggregate-trail-data.js
 *      TIMED_API_KEY=xxx node scripts/aggregate-trail-data.js --dry-run
 */

const API_BASE = process.env.TIMED_API_BASE || "https://timed-trading-ingest.shashant.workers.dev";
const API_KEY = process.env.TIMED_API_KEY || "";
const DRY_RUN = process.argv.includes("--dry-run");
const RAW_RETENTION_HOURS = parseInt(process.env.RAW_RETENTION_HOURS || "48", 10);
const BATCH_SIZE = 1000;

if (!API_KEY) {
  console.error("Error: TIMED_API_KEY is required");
  process.exit(1);
}

async function apiPost(endpoint, body) {
  const resp = await fetch(`${API_BASE}${endpoint}?key=${API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return resp.json();
}

async function apiGet(endpoint) {
  const resp = await fetch(`${API_BASE}${endpoint}?key=${API_KEY}`);
  return resp.json();
}

async function main() {
  const cutoffMs = Date.now() - RAW_RETENTION_HOURS * 60 * 60 * 1000;
  const cutoffDate = new Date(cutoffMs).toISOString();
  
  console.log(`╔═══════════════════════════════════════════════════════════════════════════════╗`);
  console.log(`║  TRAIL DATA AGGREGATION                                                        ║`);
  console.log(`╠═══════════════════════════════════════════════════════════════════════════════╣`);
  console.log(`║  Mode: ${DRY_RUN ? "DRY RUN (no changes)" : "LIVE"}                                                          ║`);
  console.log(`║  Raw retention: ${RAW_RETENTION_HOURS} hours                                                      ║`);
  console.log(`║  Cutoff: ${cutoffDate}                                       ║`);
  console.log(`╚═══════════════════════════════════════════════════════════════════════════════╝`);
  console.log();

  // Step 1: Get current counts
  console.log("[1/5] Fetching current data counts...");
  const stats = await apiPost("/timed/admin/d1-query", {
    sql: `
      SELECT 
        (SELECT COUNT(*) FROM timed_trail) as trail_total,
        (SELECT COUNT(*) FROM timed_trail WHERE ts < ${cutoffMs}) as trail_old,
        (SELECT COUNT(*) FROM ingest_receipts) as receipts_total,
        (SELECT COUNT(*) FROM ingest_receipts WHERE received_ts < ${cutoffMs}) as receipts_old,
        (SELECT COUNT(*) FROM trail_5m_facts) as facts_total
    `,
  });
  
  if (!stats.ok) {
    // Table might not exist yet, try without facts_total
    const stats2 = await apiPost("/timed/admin/d1-query", {
      sql: `
        SELECT 
          (SELECT COUNT(*) FROM timed_trail) as trail_total,
          (SELECT COUNT(*) FROM timed_trail WHERE ts < ${cutoffMs}) as trail_old,
          (SELECT COUNT(*) FROM ingest_receipts) as receipts_total,
          (SELECT COUNT(*) FROM ingest_receipts WHERE received_ts < ${cutoffMs}) as receipts_old,
          0 as facts_total
      `,
    });
    if (stats2.ok && stats2.results?.[0]) {
      Object.assign(stats, stats2);
    }
  }
  
  const counts = stats.results?.[0] || {};
  console.log(`   timed_trail: ${counts.trail_total?.toLocaleString()} total, ${counts.trail_old?.toLocaleString()} old`);
  console.log(`   ingest_receipts: ${counts.receipts_total?.toLocaleString()} total, ${counts.receipts_old?.toLocaleString()} old`);
  console.log(`   trail_5m_facts: ${counts.facts_total?.toLocaleString() || 0}`);
  console.log();

  const estimatedSavings = ((counts.trail_old || 0) * 3500 + (counts.receipts_old || 0) * 2900) / (1024 * 1024 * 1024);
  console.log(`   Estimated space savings: ~${estimatedSavings.toFixed(2)} GB`);
  console.log();

  if (DRY_RUN) {
    console.log("[DRY RUN] Would aggregate and purge the following:");
    console.log(`   - ${counts.trail_old?.toLocaleString()} rows from timed_trail`);
    console.log(`   - ${counts.receipts_old?.toLocaleString()} rows from ingest_receipts`);
    console.log();
    console.log("Run without --dry-run to execute.");
    return;
  }

  // Step 2: Create fact tables if not exist
  console.log("[2/5] Ensuring fact tables exist...");
  const createResult = await apiPost("/timed/admin/d1-query", {
    sql: `
      CREATE TABLE IF NOT EXISTS trail_5m_facts (
        ticker TEXT NOT NULL,
        bucket_ts INTEGER NOT NULL,
        price_open REAL, price_high REAL, price_low REAL, price_close REAL,
        htf_score_avg REAL, htf_score_min REAL, htf_score_max REAL,
        ltf_score_avg REAL, ltf_score_min REAL, ltf_score_max REAL,
        state TEXT, rank INTEGER, completion REAL, phase_pct REAL,
        had_squeeze_release INTEGER DEFAULT 0, had_ema_cross INTEGER DEFAULT 0,
        had_st_flip INTEGER DEFAULT 0, had_momentum_elite INTEGER DEFAULT 0,
        had_flip_watch INTEGER DEFAULT 0,
        kanban_stage_start TEXT, kanban_stage_end TEXT, kanban_changed INTEGER DEFAULT 0,
        trade_entered INTEGER DEFAULT 0, trade_exited INTEGER DEFAULT 0,
        sample_count INTEGER NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY (ticker, bucket_ts)
      )
    `,
  });
  console.log(`   Result: ${createResult.ok ? "OK" : createResult.error}`);

  // Step 3: Aggregate old trail data into 5m buckets
  console.log("[3/5] Aggregating trail data into 5m facts...");
  const aggregateResult = await apiPost("/timed/admin/d1-query", {
    sql: `
      INSERT OR REPLACE INTO trail_5m_facts (
        ticker, bucket_ts,
        price_open, price_high, price_low, price_close,
        htf_score_avg, htf_score_min, htf_score_max,
        ltf_score_avg, ltf_score_min, ltf_score_max,
        state, rank, completion, phase_pct,
        sample_count, created_at
      )
      SELECT 
        ticker,
        (ts / 300000) * 300000 as bucket_ts,
        (SELECT price FROM timed_trail t2 WHERE t2.ticker = timed_trail.ticker AND t2.ts >= (timed_trail.ts / 300000) * 300000 AND t2.ts < (timed_trail.ts / 300000) * 300000 + 300000 ORDER BY t2.ts ASC LIMIT 1) as price_open,
        MAX(price) as price_high,
        MIN(price) as price_low,
        (SELECT price FROM timed_trail t2 WHERE t2.ticker = timed_trail.ticker AND t2.ts >= (timed_trail.ts / 300000) * 300000 AND t2.ts < (timed_trail.ts / 300000) * 300000 + 300000 ORDER BY t2.ts DESC LIMIT 1) as price_close,
        AVG(htf_score) as htf_score_avg,
        MIN(htf_score) as htf_score_min,
        MAX(htf_score) as htf_score_max,
        AVG(ltf_score) as ltf_score_avg,
        MIN(ltf_score) as ltf_score_min,
        MAX(ltf_score) as ltf_score_max,
        (SELECT state FROM timed_trail t2 WHERE t2.ticker = timed_trail.ticker AND t2.ts >= (timed_trail.ts / 300000) * 300000 AND t2.ts < (timed_trail.ts / 300000) * 300000 + 300000 ORDER BY t2.ts DESC LIMIT 1) as state,
        (SELECT rank FROM timed_trail t2 WHERE t2.ticker = timed_trail.ticker AND t2.ts >= (timed_trail.ts / 300000) * 300000 AND t2.ts < (timed_trail.ts / 300000) * 300000 + 300000 ORDER BY t2.ts DESC LIMIT 1) as rank,
        (SELECT completion FROM timed_trail t2 WHERE t2.ticker = timed_trail.ticker AND t2.ts >= (timed_trail.ts / 300000) * 300000 AND t2.ts < (timed_trail.ts / 300000) * 300000 + 300000 ORDER BY t2.ts DESC LIMIT 1) as completion,
        (SELECT phase_pct FROM timed_trail t2 WHERE t2.ticker = timed_trail.ticker AND t2.ts >= (timed_trail.ts / 300000) * 300000 AND t2.ts < (timed_trail.ts / 300000) * 300000 + 300000 ORDER BY t2.ts DESC LIMIT 1) as phase_pct,
        COUNT(*) as sample_count,
        ${Date.now()} as created_at
      FROM timed_trail
      WHERE ts < ${cutoffMs}
      GROUP BY ticker, (ts / 300000) * 300000
    `,
  });
  console.log(`   Result: ${aggregateResult.ok ? `OK (${aggregateResult.meta?.changes || 0} rows inserted)` : aggregateResult.error}`);

  // Step 4: Delete old raw data
  console.log("[4/5] Purging old raw data...");
  
  const deleteTrail = await apiPost("/timed/admin/d1-query", {
    sql: `DELETE FROM timed_trail WHERE ts < ${cutoffMs}`,
  });
  console.log(`   timed_trail: ${deleteTrail.ok ? `OK (${deleteTrail.meta?.changes || 0} deleted)` : deleteTrail.error}`);
  
  const deleteReceipts = await apiPost("/timed/admin/d1-query", {
    sql: `DELETE FROM ingest_receipts WHERE received_ts < ${cutoffMs}`,
  });
  console.log(`   ingest_receipts: ${deleteReceipts.ok ? `OK (${deleteReceipts.meta?.changes || 0} deleted)` : deleteReceipts.error}`);

  // Step 5: Show final stats
  console.log("[5/5] Final statistics...");
  const finalStats = await apiPost("/timed/admin/d1-query", {
    sql: `
      SELECT 
        (SELECT COUNT(*) FROM timed_trail) as trail_total,
        (SELECT COUNT(*) FROM ingest_receipts) as receipts_total,
        (SELECT COUNT(*) FROM trail_5m_facts) as facts_total
    `,
  });
  const final = finalStats.results?.[0] || {};
  console.log(`   timed_trail: ${final.trail_total?.toLocaleString()}`);
  console.log(`   ingest_receipts: ${final.receipts_total?.toLocaleString()}`);
  console.log(`   trail_5m_facts: ${final.facts_total?.toLocaleString()}`);
  console.log();
  console.log("✓ Aggregation complete! Run VACUUM to reclaim space (done automatically by D1).");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
