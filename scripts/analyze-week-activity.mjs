#!/usr/bin/env node
/**
 * Pull live trader activity from production D1 and print a week scorecard.
 * Used for Reflect & Refine / forward validation of decision_records.
 *
 * Usage:
 *   node scripts/analyze-week-activity.mjs [--days 7]
 */
import { execSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workerDir = path.join(__dirname, "../worker");

const args = process.argv.slice(2);
const daysIdx = args.indexOf("--days");
const DAYS = daysIdx >= 0 && args[daysIdx + 1] ? Number(args[daysIdx + 1]) : 7;

function queryD1(sql) {
  const oneLine = sql.replace(/\s+/g, " ").trim();
  const cmd = `cd "${workerDir}" && ../node_modules/.bin/wrangler d1 execute --env production timed-trading-ledger --remote --json --command "${oneLine.replace(/"/g, '\\"')}"`;
  const raw = execSync(cmd, { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
  const parsed = JSON.parse(raw);
  return parsed[0]?.results || [];
}

const sinceMs = `(strftime('%s','now') - ${DAYS}*86400)*1000`;

console.log(`\n=== Timed Trading — ${DAYS}-day activity scorecard ===\n`);

const byDay = queryD1(`
  SELECT date(te.ts/1000,'unixepoch') AS day, te.type,
    COUNT(*) AS n, ROUND(SUM(COALESCE(te.pnl_realized,0)),2) AS pnl
  FROM trade_events te
  JOIN trades t ON t.trade_id = te.trade_id
  WHERE te.ts >= ${sinceMs} AND (t.run_id IS NULL OR t.run_id='')
  GROUP BY day, te.type ORDER BY day, te.type`);

console.log("Trade events by day:");
for (const r of byDay) {
  console.log(`  ${r.day}  ${r.type.padEnd(5)}  n=${r.n}  pnl=$${r.pnl}`);
}

const exits = queryD1(`
  SELECT t.ticker, t.entry_path, te.reason, ROUND(te.pnl_realized,2) AS pnl,
    datetime(te.ts/1000,'unixepoch') AS exit_utc
  FROM trade_events te
  JOIN trades t ON t.trade_id = te.trade_id
  WHERE te.type='EXIT' AND te.ts >= ${sinceMs}
    AND (t.run_id IS NULL OR t.run_id='')
  ORDER BY te.ts`);

const netRealized = exits.reduce((s, r) => s + Number(r.pnl || 0), 0);
console.log(`\nExits (${exits.length}): net realized $${netRealized.toFixed(2)}`);
for (const r of exits) {
  console.log(`  ${r.exit_utc}  ${r.ticker.padEnd(5)}  ${String(r.entry_path || "?").padEnd(22)}  ${r.reason.padEnd(18)}  $${r.pnl}`);
}

const open = queryD1(`
  SELECT ticker, entry_path, ROUND(pnl_pct,2) AS pnl_pct,
    ROUND(max_adverse_excursion,2) AS mae,
    datetime(entry_ts/1000,'unixepoch') AS entry_utc
  FROM trades
  WHERE status='OPEN' AND (run_id IS NULL OR run_id='')
  ORDER BY entry_ts`);

console.log(`\nOpen positions (${open.length}):`);
for (const r of open) {
  console.log(`  ${r.entry_utc}  ${r.ticker.padEnd(5)}  ${String(r.entry_path || "?").padEnd(22)}  pnl=${r.pnl_pct}%  mae=${r.mae}%`);
}

const dr = queryD1(`
  SELECT date(ts/1000,'unixepoch') AS day, event_type, COUNT(*) AS n,
    COUNT(DISTINCT config_hash) AS distinct_hashes
  FROM decision_records
  WHERE ts >= ${sinceMs}
  GROUP BY day, event_type ORDER BY day, event_type`);

console.log(`\nDecision records (provenance):`);
if (!dr.length) {
  console.log("  (none in window — feature may have shipped mid-week)");
} else {
  for (const r of dr) {
    console.log(`  ${r.day}  ${r.event_type.padEnd(8)}  n=${r.n}  hashes=${r.distinct_hashes}`);
  }
  const hashRows = queryD1(`
    SELECT config_hash, COUNT(*) AS n FROM decision_records
    WHERE ts >= ${sinceMs} GROUP BY config_hash ORDER BY n DESC`);
  console.log("  config_hash distribution:");
  for (const r of hashRows) {
    console.log(`    ${r.config_hash}  (${r.n} rows)`);
  }
}

const exitReasons = queryD1(`
  SELECT exit_reason, COUNT(*) AS n, ROUND(SUM(pnl),2) AS total_pnl
  FROM trades
  WHERE exit_ts >= ${sinceMs} AND (run_id IS NULL OR run_id='')
  GROUP BY exit_reason ORDER BY n DESC`);
console.log("\nExit reasons (trades closed in window):");
for (const r of exitReasons) {
  console.log(`  ${String(r.exit_reason).padEnd(20)}  n=${r.n}  pnl=$${r.total_pnl}`);
}

console.log("\n=== end ===\n");
