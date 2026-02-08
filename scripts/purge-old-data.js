#!/usr/bin/env node
/**
 * Purge Old Data - Clean up raw trail data older than retention period
 * 
 * Uses wrangler CLI to execute D1 queries directly.
 * 
 * Run: node scripts/purge-old-data.js --dry-run
 *      node scripts/purge-old-data.js
 *      RAW_RETENTION_DAYS=3 node scripts/purge-old-data.js
 */

const { execSync } = require("child_process");

const DRY_RUN = process.argv.includes("--dry-run");
const RAW_RETENTION_DAYS = parseInt(process.env.RAW_RETENTION_DAYS || "7", 10);
const DB_NAME = "timed-trading-ledger";
const ENV = "production";

function d1Query(sql) {
  const cmd = `cd worker && npx wrangler d1 execute ${DB_NAME} --remote --env ${ENV} --command "${sql.replace(/"/g, '\\"')}"`;
  try {
    const output = execSync(cmd, { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 });
    // Parse JSON result from wrangler output
    const jsonMatch = output.match(/\[\s*\{[\s\S]*\}\s*\]/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return { ok: true, results: parsed[0]?.results || [], meta: parsed[0]?.meta || {} };
    }
    return { ok: true, results: [], meta: {} };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function main() {
  const cutoffMs = Date.now() - RAW_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const cutoffDate = new Date(cutoffMs).toISOString();
  
  console.log(`╔══════════════════════════════════════════════════════════════╗`);
  console.log(`║  PURGE OLD DATA                                              ║`);
  console.log(`╠══════════════════════════════════════════════════════════════╣`);
  console.log(`║  Mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}                                                 ║`);
  console.log(`║  Retention: ${RAW_RETENTION_DAYS} days                                            ║`);
  console.log(`║  Cutoff: ${cutoffDate.slice(0, 19)}                            ║`);
  console.log(`╚══════════════════════════════════════════════════════════════╝`);
  console.log();

  // Get current counts
  console.log("[1/3] Counting data to purge...");
  
  const trailCount = d1Query(`SELECT COUNT(*) as cnt FROM timed_trail WHERE ts < ${cutoffMs}`);
  const trailOld = trailCount.results?.[0]?.cnt || 0;
  
  const receiptsCount = d1Query(`SELECT COUNT(*) as cnt FROM ingest_receipts WHERE received_ts < ${cutoffMs}`);
  const receiptsOld = receiptsCount.results?.[0]?.cnt || 0;

  console.log(`   timed_trail: ${trailOld.toLocaleString()} rows to delete`);
  console.log(`   ingest_receipts: ${receiptsOld.toLocaleString()} rows to delete`);
  
  const estimatedGB = ((trailOld * 3500 + receiptsOld * 2900) / (1024 ** 3)).toFixed(2);
  console.log(`   Estimated savings: ~${estimatedGB} GB`);
  console.log();

  if (DRY_RUN) {
    console.log("[DRY RUN] No changes made. Remove --dry-run to execute.");
    return;
  }

  // Delete old data
  console.log("[2/3] Deleting old data...");
  
  if (trailOld > 0) {
    console.log(`   Deleting from timed_trail...`);
    const result = d1Query(`DELETE FROM timed_trail WHERE ts < ${cutoffMs}`);
    console.log(`   timed_trail: ${result.ok ? `${result.meta?.changes || 0} deleted` : result.error}`);
  }
  
  if (receiptsOld > 0) {
    console.log(`   Deleting from ingest_receipts...`);
    const result = d1Query(`DELETE FROM ingest_receipts WHERE received_ts < ${cutoffMs}`);
    console.log(`   ingest_receipts: ${result.ok ? `${result.meta?.changes || 0} deleted` : result.error}`);
  }

  console.log();
  console.log(`[3/3] Verifying...`);
  const finalTrail = d1Query(`SELECT COUNT(*) as cnt FROM timed_trail`);
  const finalReceipts = d1Query(`SELECT COUNT(*) as cnt FROM ingest_receipts`);
  console.log(`   timed_trail remaining: ${(finalTrail.results?.[0]?.cnt || 0).toLocaleString()}`);
  console.log(`   ingest_receipts remaining: ${(finalReceipts.results?.[0]?.cnt || 0).toLocaleString()}`);
  console.log();
  console.log(`✓ Purge complete! D1 will automatically vacuum to reclaim space.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
