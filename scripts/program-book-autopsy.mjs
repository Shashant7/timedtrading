#!/usr/bin/env node
/**
 * Full live-book autopsy: core vs paper experiments.
 *
 * Usage:
 *   node scripts/program-book-autopsy.mjs --wrangler-d1 production --remote
 *   node scripts/program-book-autopsy.mjs --wrangler-d1 production --remote --days 400
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildBookAutopsyReport, PROGRAM_ORDER, PROGRAM_LABELS } from "../worker/trust-spine/program-book-autopsy.js";

const args = process.argv.slice(2);
const remote = args.includes("--remote");
const d1Idx = args.indexOf("--wrangler-d1");
const envName = d1Idx >= 0 ? args[d1Idx + 1] : "production";
const daysIdx = args.indexOf("--days");
const days = daysIdx >= 0 ? Math.min(Math.max(Number(args[daysIdx + 1]) || 400, 1), 800) : 0;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "..", "data", "trust-spine");

function d1Query(sql) {
  const remoteFlag = remote ? " --remote" : "";
  const envFlag = ` --env ${envName}`;
  const escaped = sql.replace(/'/g, "'\"'\"'");
  const cmd = `cd worker && npx wrangler d1 execute timed-trading-ledger${envFlag}${remoteFlag} --command '${escaped}'`;
  const out = execSync(cmd, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  const m = out.match(/"results":\s*(\[[\s\S]*?\])\s*,\s*"success"/);
  if (!m) throw new Error("could not parse D1 output");
  return JSON.parse(m[1]);
}

function fmt(v, d = 2) {
  if (v == null || !Number.isFinite(Number(v))) return "—";
  return Number(v).toFixed(d);
}

function usd(v) {
  if (v == null || !Number.isFinite(Number(v))) return "—";
  const n = Number(v);
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function lineStats(s) {
  if (!s) return "—";
  return `n=${s.n} closed=${s.closed} WR=${fmt(s.win_rate_pct, 1)}%  P&L=${usd(s.pnl_usd)}  exp=${fmt(s.expectancy_pct)}%  PF=${fmt(s.profit_factor)}  MFE=${fmt(s.avg_mfe_pct)} MAE=${fmt(s.avg_mae_pct)} keep=${fmt(s.avg_keep, 3)}  notional~${usd(s.median_notional)}`;
}

function table(rows, cols) {
  const out = [];
  out.push("| " + cols.map((c) => c.h).join(" | ") + " |");
  out.push("|" + cols.map((c) => (c.num ? "---:" : "---")).join("|") + "|");
  for (const r of rows) {
    out.push("| " + cols.map((c) => c.f(r)).join(" | ") + " |");
  }
  return out.join("\n");
}

const STAT_COLS = [
  { h: "Slice", f: (r) => r.key },
  { h: "N", num: true, f: (r) => String(r.n) },
  { h: "WR %", num: true, f: (r) => fmt(r.win_rate_pct, 1) },
  { h: "P&L", num: true, f: (r) => usd(r.pnl_usd) },
  { h: "Exp %", num: true, f: (r) => fmt(r.expectancy_pct) },
  { h: "PF", num: true, f: (r) => fmt(r.profit_factor) },
  { h: "MFE", num: true, f: (r) => fmt(r.avg_mfe_pct) },
  { h: "MAE", num: true, f: (r) => fmt(r.avg_mae_pct) },
  { h: "Keep", num: true, f: (r) => fmt(r.avg_keep, 3) },
];

const since = days > 0 ? Date.now() - days * 86400000 : 0;
const liveFilter = `(run_id IS NULL OR run_id = '')`;
const timeFilter = since ? ` AND entry_ts >= ${since}` : "";

console.error(`Querying ${envName} live trades${days ? ` last ${days}d` : " (all live)"} …`);

const trades = d1Query(
  `SELECT trade_id, ticker, direction, status, pnl, pnl_pct, exit_reason, setup_name, setup_grade,
          entry_path, entry_ts, exit_ts, notional, shares, sector,
          max_favorable_excursion, max_adverse_excursion
     FROM trades
    WHERE ${liveFilter}${timeFilter}
    ORDER BY entry_ts ASC`,
);

const tradeIds = [...new Set(trades.map((t) => t.trade_id).filter(Boolean))];
let decisions = [];
for (let i = 0; i < tradeIds.length; i += 60) {
  const chunk = tradeIds.slice(i, i + 60);
  const ph = chunk.map((id) => `'${String(id).replace(/'/g, "''")}'`).join(",");
  const rows = d1Query(
    `SELECT trade_id, event_type,
            json_extract(inputs_json, '$.slice_family') AS slice_family,
            json_extract(inputs_json, '$.confirm_stack') AS confirm_stack,
            json_extract(inputs_json, '$.tt_cloud_pivot') AS tt_cloud_pivot,
            json_extract(inputs_json, '$.momentum_continuation') AS momentum_continuation,
            json_extract(inputs_json, '$.sequence_paper_queue.family') AS paper_family
       FROM decision_records
      WHERE event_type = 'ENTRY' AND trade_id IN (${ph})`,
  );
  for (const r of rows) {
    decisions.push({
      trade_id: r.trade_id,
      event_type: r.event_type,
      inputs_json: JSON.stringify({
        slice_family: r.slice_family || undefined,
        confirm_stack: r.confirm_stack === 1 || r.confirm_stack === true || r.confirm_stack === "true" || undefined,
        tt_cloud_pivot: r.tt_cloud_pivot === 1 || r.tt_cloud_pivot === true || r.tt_cloud_pivot === "true" || undefined,
        momentum_continuation: r.momentum_continuation === 1 || r.momentum_continuation === true || r.momentum_continuation === "true" || undefined,
        sequence_paper_queue: r.paper_family ? { family: r.paper_family } : undefined,
      }),
    });
  }
}

const report = buildBookAutopsyReport({ trades, decisions });
const h = report.headline;
const iso = (ts) => (ts ? new Date(ts).toISOString().slice(0, 10) : "—");
const firstExp = iso(report.first_experiment_ts);
const firstFamily = iso(report.first_family_stamp_ts);
const firstStamped = iso(report.first_stamped_path_ts);

const lines = [];
lines.push("# Model book autopsy — core vs experiments");
lines.push("");
lines.push(`Generated: ${new Date().toISOString()}`);
lines.push(`Env: ${envName} live ledger (${liveFilter})`);
lines.push(`Fills: ${report.fills} (closed ${h.blended.closed}, open ${h.blended.open})`);
lines.push(`First stamped \`entry_path\`: ${firstStamped}`);
lines.push(`First paper-family stamp (coincident or standalone): ${firstFamily}`);
lines.push(`First standalone experiment fill (family stamp, no canonical path): ${firstExp}`);
lines.push("");
lines.push("Classification: a canonical `entry_path` (Support Bounce, ATH, pullback, …) stays **core** even if a paper-family stamp sits on the payload (flagged coincident). Named slice stamps without a canonical path are the only standalone experiments. Do not treat the 60-day timing scan's family buckets as a dedicated experiment P&L book — those rows are mostly coincident stamps on core paths.");
lines.push("");
lines.push("## Verdict — are experiments polluting the core?");
lines.push("");
lines.push(`- Blended book: ${lineStats(h.blended)}`);
lines.push(`- Core only:    ${lineStats(h.core)}`);
lines.push(`- Standalone experiments:  ${lineStats(h.experiments)}`);
lines.push(`- Coincident paper-on-core-path: ${lineStats(h.coincident)}`);
lines.push("");
lines.push(`- Standalone experiment **dollar** drag vs core: ${usd(h.pollution.usd_drag)} (blended − core)`);
lines.push(`- Standalone experiment **mix** drag on expectancy: ${fmt(h.pollution.expectancy_pct_drag)} pp`);
lines.push(`- Standalone experiment **mix** drag on win rate: ${fmt(h.pollution.win_rate_drag, 1)} pp`);
lines.push(`- Coincident paper-on-core P&L (still inside core): ${usd(h.pollution.coincident_pnl_usd)} on ${h.pollution.coincident_n} fills`);
lines.push("");
if ((h.pollution.standalone_experiment_n || 0) === 0) {
  lines.push("**No standalone experiment fills in the live book.** Paper families have not opened their own tickets — they stamped core paths. Dollar pollution from a separate experiment book is $0. The live risk is (1) mis-attributing coincident core fills as experiments, and (2) size crush on a canonical path (AXON-class).");
} else if (Math.abs(h.pollution.usd_drag || 0) < Math.abs(h.core.pnl_usd || 0) * 0.05) {
  lines.push("**Dollar pollution is small** relative to core P&L (paper 0.1×). The risk is **mix**: blending % stats makes the core look worse/better than it is. Always read core-only.");
} else {
  lines.push("**Dollar pollution is material** — standalone experiments are large enough to move the book P&L, not just the averages.");
}
lines.push("");
lines.push("### Three eras (this is the degradation story)");
lines.push("");
lines.push(`- Unstamped historical core (no \`entry_path\`): ${lineStats(h.unstamped)}`);
lines.push(`- Stamped-path core, no paper stamp: ${lineStats(h.stamped_clean)}`);
lines.push(`- Stamped-path + coincident paper stamp: ${lineStats(h.coincident)}`);
lines.push(`- All stamped-path core (clean + coincident): ${lineStats(h.stamped_all)}`);
lines.push("");
lines.push(`- Core before first stamped path (${firstStamped}): ${lineStats(report.core.before_stamped_path)}`);
lines.push(`- Core after first stamped path: ${lineStats(report.core.after_stamped_path)}`);
lines.push(`- Core before first family stamp (${firstFamily}): ${lineStats(report.core.before_family_stamp)}`);
lines.push(`- Core after first family stamp: ${lineStats(report.core.after_family_stamp)}`);
if (report.first_experiment_ts) {
  lines.push(`- Core before first standalone experiment (${firstExp}): ${lineStats(report.core.before_experiments)}`);
  lines.push(`- Core after first standalone experiment: ${lineStats(report.core.after_experiments)}`);
}
lines.push("");
lines.push("If the unstamped book is the winner and the stamped-path book is the loser, that is **core engine-path degradation**, not experiment pollution. Paper stamps arriving in the same months as the new paths can make the two look like one story — they are not.");
lines.push("");
if (h.unstamped?.avg_mfe_pct == null || (h.unstamped?.avg_mae_pct || 0) < 0.05) {
  lines.push("_Caveat: older unstamped rows usually have no MFE/MAE. Do not read keep/MFE on the all-time book._");
  lines.push("");
}

lines.push("## Scoreboard by program");
lines.push("");
const progRows = PROGRAM_ORDER.map((p) => ({ key: PROGRAM_LABELS[p], ...report.programs[p] }));
lines.push(table(progRows, STAT_COLS));
lines.push("");

lines.push("## Core — where it wins and loses");
lines.push("");
lines.push("### By entry path");
lines.push("");
lines.push(table(report.core.by_entry_path, STAT_COLS));
lines.push("");
lines.push("### Setup winners");
lines.push("");
lines.push(table(report.core.by_setup_winners || report.core.by_setup.slice(-12).reverse(), STAT_COLS));
lines.push("");
lines.push("### Setup losers");
lines.push("");
lines.push(table(report.core.by_setup_losers || report.core.by_setup.slice(0, 12), STAT_COLS));
lines.push("");
lines.push("### By session");
lines.push("");
lines.push(table(report.core.by_session, STAT_COLS));
lines.push("");
lines.push("### By month");
lines.push("");
lines.push(table(report.core.by_month, STAT_COLS));
lines.push("");
lines.push("### By direction");
lines.push("");
lines.push(table(report.core.by_direction, STAT_COLS));
lines.push("");
lines.push("### By grade");
lines.push("");
lines.push(table(report.core.by_grade, STAT_COLS));
lines.push("");
lines.push("### By exit reason (volume)");
lines.push("");
lines.push(table(report.core.by_exit.slice(0, 15), STAT_COLS));
lines.push("");
lines.push("### Exit reasons that bled (worst $)");
lines.push("");
lines.push(table((report.core.by_exit_pnl || []).filter((r) => (r.pnl_usd || 0) < 0).slice(0, 10), STAT_COLS));
lines.push("");
lines.push("### Exit reasons that paid (best $)");
lines.push("");
lines.push(table((report.core.by_exit_pnl || []).filter((r) => (r.pnl_usd || 0) > 0).sort((a, b) => (b.pnl_usd || 0) - (a.pnl_usd || 0)).slice(0, 10), STAT_COLS));
lines.push("");
lines.push("### Core ticker winners");
lines.push("");
lines.push(table(report.core.winners, STAT_COLS));
lines.push("");
lines.push("### Core ticker losers");
lines.push("");
lines.push(table(report.core.losers, STAT_COLS));
lines.push("");
lines.push("### Core tickers that never won (n≥3, 0 wins)");
lines.push("");
lines.push(table(report.core.never_won || [], STAT_COLS));
lines.push("");
lines.push("### Stamped-path core with no paper stamp (May–Jul class)");
lines.push("");
lines.push(table(report.core.stamped_clean_by_path || [], STAT_COLS));
lines.push("");
if ((report.core.experiment_named_exits || []).length) {
  lines.push("### Experiment-named exits on core fills");
  lines.push("");
  lines.push("Cloud Pivot (and any confirm-stack) exit reasons firing on a canonical `entry_path`. This is management overlay, not a standalone experiment fill.");
  lines.push("");
  lines.push(table(report.core.experiment_named_exits, STAT_COLS));
  lines.push("");
}

lines.push("## Coincident paper stamps on core paths");
lines.push("");
lines.push("Canonical engine entries that also carry a paper family stamp. They stay in CORE. Do not widen a family or retire a family on this sample.");
lines.push("");
lines.push("### Coincident by family stamp");
lines.push("");
lines.push(table(report.coincident.by_family, STAT_COLS));
lines.push("");
lines.push("### Coincident by entry path");
lines.push("");
lines.push(table(report.coincident.by_entry_path, STAT_COLS));
lines.push("");
lines.push("### Coincident by setup");
lines.push("");
lines.push(table(report.coincident.by_setup, STAT_COLS));
lines.push("");
lines.push("### Coincident by session");
lines.push("");
lines.push(table(report.coincident.by_session, STAT_COLS));
lines.push("");
lines.push("### Coincident by size lane");
lines.push("");
lines.push(table(report.coincident.by_size, STAT_COLS));
lines.push("");
lines.push("### Coincident ticker winners");
lines.push("");
lines.push(table(report.coincident.winners, STAT_COLS));
lines.push("");
lines.push("### Coincident ticker losers");
lines.push("");
lines.push(table(report.coincident.losers, STAT_COLS));
lines.push("");

lines.push("## Standalone experiments — where they win and lose");
lines.push("");
if ((h.pollution.standalone_experiment_n || 0) === 0) {
  lines.push("_None in the live book. Confirm-stack, Cloud Pivot, and Continuation have not filled as their own `entry_path`. The 60-day timing scan's family rows were coincident stamps on core paths._");
  lines.push("");
}
lines.push("### By program");
lines.push("");
lines.push(table(report.experiments.by_program.map((r) => ({ ...r, key: r.label })), STAT_COLS));
lines.push("");
lines.push("### By setup");
lines.push("");
lines.push(table(report.experiments.by_setup.slice(0, 15), STAT_COLS));
lines.push("");
lines.push("### By session");
lines.push("");
lines.push(table(report.experiments.by_session, STAT_COLS));
lines.push("");
lines.push("### By month");
lines.push("");
lines.push(table(report.experiments.by_month, STAT_COLS));
lines.push("");
lines.push("### By exit reason");
lines.push("");
lines.push(table(report.experiments.by_exit.slice(0, 12), STAT_COLS));
lines.push("");
lines.push("### Experiment ticker winners");
lines.push("");
lines.push(table(report.experiments.winners, STAT_COLS));
lines.push("");
lines.push("### Experiment ticker losers");
lines.push("");
lines.push(table(report.experiments.losers, STAT_COLS));
lines.push("");

lines.push("## Tickers in both books");
lines.push("");
if (!report.overlap_tickers.length) {
  lines.push("_No overlapping tickers._");
} else {
  lines.push("| Ticker | Core n | Core P&L | Core exp % | Exp n | Exp P&L | Exp exp % |");
  lines.push("|--------|-------:|---------:|-----------:|------:|--------:|----------:|");
  for (const r of report.overlap_tickers) {
    lines.push(`| ${r.ticker} | ${r.core.n} | ${usd(r.core.pnl_usd)} | ${fmt(r.core.expectancy_pct)} | ${r.experiment.n} | ${usd(r.experiment.pnl_usd)} | ${fmt(r.experiment.expectancy_pct)} |`);
  }
}
lines.push("");
if (report.open_trades?.length) {
  lines.push("## Open live fills");
  lines.push("");
  for (const f of report.open_trades) {
    lines.push(`- ${f.ticker} ${f.entry_path}${f.family_stamp ? ` stamp=${f.family_stamp}` : ""} notional=${usd(f.notional)}`);
  }
  lines.push("");
}

lines.push("## Coincident fill list");
lines.push("");
lines.push("Coincident fills (core path + paper stamp): " + report.headline.coincident.n);
if (report.experiments.coincident.length) {
  lines.push("");
  for (const f of report.experiments.coincident) {
    const day = f.entry_ts ? new Date(f.entry_ts).toISOString().slice(0, 10) : "";
    lines.push(`- ${day} ${f.ticker} ${f.entry_path} stamp=${f.family_stamp} ${f.status} ${usd(f.pnl)} notional=${usd(f.notional)} exit=${f.exit_reason}`);
  }
}
lines.push("");
lines.push("Skill: `skills/program-timing.md`. Re-run: `node scripts/program-book-autopsy.mjs --wrangler-d1 production --remote`");

const md = lines.join("\n");
console.log(md);
fs.mkdirSync(OUT_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outMd = path.join(OUT_DIR, `program-book-autopsy-${stamp}.md`);
fs.writeFileSync(outMd, md);
fs.writeFileSync(path.join(OUT_DIR, `program-book-autopsy-${stamp}.json`), JSON.stringify(report, null, 2));
console.error(`\nWrote ${outMd}`);
