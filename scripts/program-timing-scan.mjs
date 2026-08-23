#!/usr/bin/env node
/**
 * Scan live (or replay) fills by program × clock.
 * Crowns the session / hour with the best MFE and the least MAE.
 *
 * Usage:
 *   node scripts/program-timing-scan.mjs --wrangler-d1 production --remote
 *   node scripts/program-timing-scan.mjs --wrangler-d1 production --remote --days 60 --min-n 3
 *
 * Observational on filled clocks — not a flipped ENTRY_ENGINE replay.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildProgramTimingReport, PROGRAM_ORDER, PROGRAM_LABELS } from "../worker/trust-spine/program-timing.js";

const args = process.argv.slice(2);
const remote = args.includes("--remote");
const d1Idx = args.indexOf("--wrangler-d1");
const envName = d1Idx >= 0 ? args[d1Idx + 1] : "production";
const daysIdx = args.indexOf("--days");
const days = Math.min(Math.max(Number(daysIdx >= 0 ? args[daysIdx + 1] : 60) || 60, 1), 180);
const minIdx = args.indexOf("--min-n");
const minN = Math.min(Math.max(Number(minIdx >= 0 ? args[minIdx + 1] : 3) || 3, 1), 30);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "..", "data", "trust-spine");

function d1Query(sql) {
  const remoteFlag = remote ? " --remote" : "";
  const envFlag = ` --env ${envName}`;
  const escaped = sql.replace(/'/g, "'\"'\"'");
  const cmd = `cd worker && npx wrangler d1 execute timed-trading-ledger${envFlag}${remoteFlag} --command '${escaped}'`;
  const out = execSync(cmd, { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  const m = out.match(/"results":\s*(\[[\s\S]*?\])\s*,\s*"success"/);
  if (!m) throw new Error("could not parse D1 output");
  return JSON.parse(m[1]);
}

function fmt(v, digits = 2) {
  if (v == null || !Number.isFinite(Number(v))) return "—";
  return Number(v).toFixed(digits);
}

function bucketLine(b) {
  if (!b) return "—";
  const thin = b.thin ? " (thin)" : "";
  return `${b.label || b.key}  n=${b.closed}  MFE=${fmt(b.avg_mfe_pct)}  MAE=${fmt(b.avg_mae_pct)}  edge=${fmt(b.mfe_mae_edge)}${thin}`;
}

const since = Date.now() - days * 86400000;

console.error(`Querying ${envName} ledger, last ${days}d …`);

let trades = [];
try {
  trades = d1Query(
    `SELECT trade_id, ticker, direction, status, pnl, pnl_pct, exit_reason, setup_name,
            max_favorable_excursion, max_adverse_excursion, entry_ts, exit_ts
       FROM trades
      WHERE entry_ts >= ${since}
        AND (run_id IS NULL OR run_id = '')
      ORDER BY entry_ts DESC
      LIMIT 4000`,
  );
} catch {
  trades = d1Query(
    `SELECT trade_id, ticker, direction, status, pnl, pnl_pct,
            max_favorable_excursion, max_adverse_excursion, entry_ts, exit_ts
       FROM trades
      WHERE entry_ts >= ${since}
        AND (run_id IS NULL OR run_id = '')
      ORDER BY entry_ts DESC
      LIMIT 4000`,
  );
}

const tradeIds = [...new Set(trades.map((t) => t.trade_id).filter(Boolean))];
let entryDecisions = [];
for (let i = 0; i < tradeIds.length; i += 80) {
  const chunk = tradeIds.slice(i, i + 80);
  if (!chunk.length) continue;
  const ph = chunk.map((id) => `'${String(id).replace(/'/g, "''")}'`).join(",");
  const rows = d1Query(
    `SELECT decision_id, trade_id, ticker, event_type, ts, reason,
            conviction_tier, inputs_json, gate_trace_json
       FROM decision_records
      WHERE event_type = 'ENTRY' AND trade_id IN (${ph})`,
  );
  entryDecisions = entryDecisions.concat(rows);
}

const report = buildProgramTimingReport({
  days,
  minN,
  entryDecisions,
  trades,
});

const lines = [];
lines.push("# Program timing — MFE / MAE by clock");
lines.push("");
lines.push(`Generated: ${new Date().toISOString()}`);
lines.push(`Window: last ${days}d | env: ${envName} | min closed n to crown: ${minN}`);
lines.push(`Fills scanned: ${report.fills} (${report.closed} closed)`);
lines.push("");
lines.push(report.note);
lines.push("");
lines.push("## Ideal clock by program");
lines.push("");
lines.push("| Program | Best session | Best hour | Weekday | Closed | MFE % | MAE % | Edge |");
lines.push("|---------|--------------|-----------|---------|-------:|------:|------:|-----:|");
for (const row of report.ideals) {
  lines.push(`| ${row.label}${row.thin ? " *" : ""} | ${row.session || "—"} | ${row.hour || "—"} | ${row.weekday || "—"} | ${row.n} | ${fmt(row.avg_mfe_pct)} | ${fmt(row.avg_mae_pct)} | ${fmt(row.mfe_mae_edge)} |`);
}
if (!report.ideals.length) {
  lines.push("| — | no closed fills in window | — | — | 0 | — | — | — |");
}
lines.push("");
lines.push("\\* thin = closed n below the crown threshold; treat as a hint, not a gate.");
lines.push("");

for (const key of PROGRAM_ORDER) {
  const block = report.programs[key];
  lines.push(`## ${PROGRAM_LABELS[key] || key}`);
  lines.push("");
  lines.push(`Overall: n=${block.overall.n} closed=${block.overall.closed} MFE=${fmt(block.overall.avg_mfe_pct)} MAE=${fmt(block.overall.avg_mae_pct)} edge=${fmt(block.overall.mfe_mae_edge)} keep=${fmt(block.overall.avg_mfe_keep_rate, 3)} exp=${fmt(block.overall.stats?.expectancy_pct)}`);
  lines.push("");
  lines.push(`- Ideal session: ${bucketLine(block.ideal.session)}`);
  lines.push(`- Avoid session: ${bucketLine(block.avoid.session)}`);
  lines.push(`- Ideal hour: ${bucketLine(block.ideal.hour)}`);
  lines.push(`- Ideal weekday: ${bucketLine(block.ideal.weekday)}`);
  lines.push(`- Ideal RTH offset: ${bucketLine(block.ideal.rth_offset)}`);
  lines.push("");
  const sessions = (block.by_session.buckets || []).filter((b) => b.closed > 0);
  if (sessions.length) {
    lines.push("| Session | Closed | MFE % | MAE % | Edge | Keep |");
    lines.push("|---------|-------:|------:|------:|-----:|-----:|");
    for (const b of sessions) {
      lines.push(`| ${b.label}${b.thin ? " *" : ""} | ${b.closed} | ${fmt(b.avg_mfe_pct)} | ${fmt(b.avg_mae_pct)} | ${fmt(b.mfe_mae_edge)} | ${fmt(b.avg_mfe_keep_rate, 3)} |`);
    }
    lines.push("");
  }
}

const md = lines.join("\n");
console.log(md);

fs.mkdirSync(OUT_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outMd = path.join(OUT_DIR, `program-timing-${stamp}.md`);
const outJson = path.join(OUT_DIR, `program-timing-${stamp}.json`);
fs.writeFileSync(outMd, md);
fs.writeFileSync(outJson, JSON.stringify(report, null, 2));
console.error(`\nWrote ${outMd}`);
