#!/usr/bin/env node
/**
 * Trust Spine weekly scorecard — config_hash epochs + trade outcomes.
 * Usage: node scripts/trust-spine-scorecard.mjs [--days 7]
 */
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { scoreEpochMetrics } from "../worker/trust-spine/scorecard.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workerDir = path.join(__dirname, "../worker");
const daysIdx = process.argv.indexOf("--days");
const DAYS = daysIdx >= 0 ? Number(process.argv[daysIdx + 1]) : 7;

function queryD1(sql) {
  const oneLine = sql.replace(/\s+/g, " ").trim();
  const cmd = `cd "${workerDir}" && ../node_modules/.bin/wrangler d1 execute --env production timed-trading-ledger --remote --command '${oneLine.replace(/'/g, "'\"'\"'")}'`;
  const raw = execSync(cmd, { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
  const m = raw.match(/"results":\s*(\[[\s\S]*?\])\s*,\s*"success"/);
  if (!m) throw new Error("could not parse D1 output");
  return JSON.parse(m[1]);
}

const sinceMs = `(strftime('%s','now') - ${DAYS}*86400)*1000`;

const epochs = queryD1(`
  SELECT config_hash, COUNT(*) as decisions,
         SUM(CASE WHEN event_type='ENTRY' THEN 1 ELSE 0 END) as entries
  FROM decision_records
  WHERE ts >= ${sinceMs} AND config_hash IS NOT NULL AND config_hash != ''
  GROUP BY config_hash ORDER BY decisions DESC`);

const trades = queryD1(`
  SELECT t.pnl, t.pnl_pct, t.exit_ts, dr.config_hash
  FROM trades t
  LEFT JOIN decision_records dr ON dr.trade_id = t.trade_id AND dr.event_type = 'ENTRY'
  WHERE t.exit_ts >= ${sinceMs} AND t.status IN ('WIN','LOSS')
    AND (t.run_id IS NULL OR t.run_id = '')`);

const scorecard = scoreEpochMetrics(epochs, trades);

const lines = [];
lines.push(`# Trust Spine scorecard — ${DAYS}d`);
lines.push("");
lines.push(`Generated: ${new Date().toISOString()}`);
lines.push("");
lines.push(`Closed loop ready: **${scorecard.closed_loop_ready ? "yes" : "no"}**`);
lines.push("");
lines.push("| config_hash | decisions | entries | closed | WR% | net PnL |");
lines.push("|-------------|----------:|--------:|-------:|----:|--------:|");
for (const e of scorecard.epochs) {
  lines.push(`| ${e.config_hash} | ${e.decision_rows} | ${e.entries} | ${e.closed_trades} | ${e.win_rate ?? "—"} | $${e.net_pnl} |`);
}

const outDir = "data/trust-spine";
fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().slice(0, 10);
const mdPath = `${outDir}/week-scorecard-${stamp}.md`;
const jsonPath = `${outDir}/week-scorecard-${stamp}.json`;
fs.writeFileSync(mdPath, lines.join("\n") + "\n");
fs.writeFileSync(jsonPath, JSON.stringify(scorecard, null, 2));
console.log(lines.join("\n"));
console.log(`\nWrote ${mdPath}`);
