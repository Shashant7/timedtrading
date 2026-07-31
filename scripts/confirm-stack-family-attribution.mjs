#!/usr/bin/env node
/**
 * Confirm-stack EMA21 thin-slice attribution report.
 *
 * Joins decision_records ENTRY → trades for family confirm_stack_ema21 and
 * reports MFE keep, vehicle mix, and whether the family beats the ~4.8%
 * capture baseline (plans/confirm-stack-ema21-slice.plan.md).
 *
 * Usage:
 *   node scripts/confirm-stack-family-attribution.mjs --wrangler-d1 production --remote
 *   node scripts/confirm-stack-family-attribution.mjs --wrangler-d1 production --remote --days 30
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildFamilyAttributionReport, isConfirmStackDecision } from "../worker/trust-spine/family-attribution.js";

const args = process.argv.slice(2);
const remote = args.includes("--remote");
const d1Idx = args.indexOf("--wrangler-d1");
const envName = d1Idx >= 0 ? args[d1Idx + 1] : "production";
const daysIdx = args.indexOf("--days");
const days = Math.min(Math.max(Number(daysIdx >= 0 ? args[daysIdx + 1] : 30) || 30, 1), 180);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "..", "data", "trust-spine");

function d1Query(sql) {
  const remoteFlag = remote ? " --remote" : "";
  const envFlag = ` --env ${envName}`;
  const escaped = sql.replace(/'/g, "'\"'\"'");
  const cmd = `cd worker && npx wrangler d1 execute timed-trading-ledger${envFlag}${remoteFlag} --command '${escaped}'`;
  const out = execSync(cmd, { encoding: "utf8", maxBuffer: 12 * 1024 * 1024 });
  const m = out.match(/"results":\s*(\[[\s\S]*?\])\s*,\s*"success"/);
  if (!m) throw new Error("could not parse D1 output");
  return JSON.parse(m[1]);
}

const since = Date.now() - days * 86400000;

const entryDecisions = d1Query(
  `SELECT decision_id, trade_id, ticker, event_type, ts, reason,
          conviction_tier, inputs_json, gate_trace_json
     FROM decision_records
    WHERE event_type = 'ENTRY' AND ts >= ${since}
    ORDER BY ts DESC
    LIMIT 2000`,
);

const tradeIds = [...new Set(entryDecisions.map((d) => d.trade_id).filter(Boolean))];
let trades = [];
for (let i = 0; i < tradeIds.length; i += 80) {
  const chunk = tradeIds.slice(i, i + 80);
  if (!chunk.length) continue;
  const ph = chunk.map((id) => `'${String(id).replace(/'/g, "''")}'`).join(",");
  try {
    const rows = d1Query(
      `SELECT trade_id, ticker, status, pnl, pnl_pct, exit_reason, setup_name,
              max_favorable_excursion, entry_ts, exit_ts
         FROM trades
        WHERE trade_id IN (${ph})`,
    );
    trades = trades.concat(rows);
  } catch {
    const rows = d1Query(
      `SELECT trade_id, ticker, status, pnl, pnl_pct, exit_reason, setup_name, entry_ts, exit_ts
         FROM trades
        WHERE trade_id IN (${ph})`,
    );
    trades = trades.concat(rows);
  }
}

const report = buildFamilyAttributionReport({
  family: "confirm_stack_ema21",
  days,
  entryDecisions,
  trades,
  universeCapturePct: null,
  baselineCapturePct: 4.8,
});

const stamped = entryDecisions.filter((d) => isConfirmStackDecision(d)).length;
const withGates = entryDecisions.filter((d) => {
  try {
    const j = typeof d.inputs_json === "string" ? JSON.parse(d.inputs_json) : d.inputs_json;
    return !!(j?.setup_gates?.stack_full_confirm);
  } catch { return false; }
}).length;

const lines = [];
lines.push("# Confirm-stack EMA21 — Family Attribution");
lines.push("");
lines.push(`Generated: ${new Date().toISOString()}`);
lines.push(`Window: last ${days}d | env: ${envName}`);
lines.push("");
lines.push("## Provenance coverage");
lines.push("");
lines.push(`| Metric | Value |`);
lines.push(`|--------|------:|`);
lines.push(`| ENTRY rows in window | ${entryDecisions.length} |`);
lines.push(`| With setup_gates.stack_full_confirm | ${withGates} |`);
lines.push(`| Classified confirm-stack family | ${stamped} |`);
lines.push("");
lines.push("## Family outcomes");
lines.push("");
lines.push("```");
lines.push(`entries=${report.entries}  open=${report.open}  closed=${report.closed}`);
lines.push(`avg_mfe_pct=${report.avg_mfe_pct ?? "—"}  avg_mfe_keep_rate=${report.avg_mfe_keep_rate ?? "—"}`);
lines.push(`family_win_rate_pct=${report.family_win_rate_pct ?? "—"}  baseline_capture_pct=${report.baseline_capture_rate_pct}`);
lines.push(`beats_baseline_capture=${report.beats_baseline_capture}`);
lines.push(`widen_ready=${report.widen_ready}`);
lines.push(`vehicles=${JSON.stringify(report.vehicles || {})}`);
if (report.stats) {
  lines.push(`stats: n=${report.stats.n ?? report.closed} wr=${report.stats.win_rate_pct ?? "—"}% expectancy_pct=${report.stats.expectancy_pct ?? "—"} pf=${report.stats.profit_factor ?? "—"}`);
}
lines.push("```");
lines.push("");
lines.push("## Sample closed");
lines.push("");
for (const s of report.sample_closed || []) {
  lines.push(`- ${s.ticker} ${s.status} pnl=${s.pnl_pct}% mfe=${s.mfe_pct ?? "—"} keep=${s.keep_rate ?? "—"} (${s.exit_reason || s.setup_name || ""})`);
}
if (!(report.sample_closed || []).length) {
  lines.push("_No closed family trades in window — stamp setup_gates on ENTRY, then re-run._");
}
lines.push("");
lines.push("## Verdict");
lines.push("");
if (report.widen_ready) {
  lines.push("**WIDEN CANDIDATE** — family closed n≥5, MFE keep≥0.35, +EV / PF≥1, universe capture not below 4.8%.");
} else if (withGates === 0 && stamped === 0) {
  lines.push("**PROVENANCE GAP** — ENTRY rows lack setup_gates / slice_family (hint-matched family only). Deploy thin-slice stamp, then re-accrue.");
} else if (report.entries === 0) {
  lines.push("**NO FAMILY ROWS** — ENTRY provenance still missing setup_gates / slice_family. Deploy thin-slice stamp, then accrue.");
} else if (report.closed < 5) {
  lines.push(`**ACCRUING** — ${report.closed} closed (need ≥5) before widen gate.`);
} else {
  lines.push("**HOLD / AUTOPSY** — sample present but widen_ready=false (check MFE keep, expectancy, profit factor).");
}
lines.push("");
lines.push("API: `GET /timed/admin/trust-spine/family-attribution?days=" + days + "&family=confirm_stack_ema21`");

const md = lines.join("\n");
console.log(md);

fs.mkdirSync(OUT_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outMd = path.join(OUT_DIR, `confirm-stack-attribution-${stamp}.md`);
const outJson = path.join(OUT_DIR, `confirm-stack-attribution-${stamp}.json`);
fs.writeFileSync(outMd, md);
fs.writeFileSync(outJson, JSON.stringify({ report, stamped, withGates, days, envName }, null, 2));
console.error(`\nWrote ${outMd}`);
