#!/usr/bin/env node
/**
 * refinement-validation-report.js
 *
 * Compare a challenger run against the frozen refinement baseline on:
 * - headline PnL / trade count
 * - hold profile
 * - same-ticker quick re-entry churn
 * - exit-family mix
 * - targeted ticker summaries
 *
 * Usage:
 *   node scripts/refinement-validation-report.js --candidate-run-id <RUN_ID>
 *   node scripts/refinement-validation-report.js --baseline-run-id <RUN_ID> --candidate-run-id <RUN_ID>
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const WORKER_DIR = path.join(__dirname, "../worker");
const OUT_DIR = path.join(__dirname, "../data/refinement-validation");
fs.mkdirSync(OUT_DIR, { recursive: true });

const DEFAULT_BASELINE = "backtest_2025-07-01_2026-03-23@2026-03-24T06:23:53.734Z";
const args = process.argv.slice(2);
const getArg = (name) => {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : null;
};

const BASELINE_RUN_ID = getArg("--baseline-run-id") || DEFAULT_BASELINE;
const CANDIDATE_RUN_ID = getArg("--candidate-run-id");

if (!CANDIDATE_RUN_ID) {
  console.error("Missing required --candidate-run-id");
  process.exit(1);
}

function d1Query(sql) {
  const oneLine = sql.replace(/\s+/g, " ").trim();
  const escaped = oneLine.replace(/"/g, '\"');
  const raw = execSync(
    `cd "${WORKER_DIR}" && npx wrangler d1 execute timed-trading-ledger --remote --env production --json --command "${escaped}"`,
    { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 50 * 1024 * 1024 },
  );
  const lines = raw.split("\n").filter((l) => !l.startsWith("npm"));
  const parsed = JSON.parse(lines.join("\n"));
  return Array.isArray(parsed) ? parsed[0]?.results || [] : parsed?.results || [];
}

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function fmtPct(v) {
  return `${safeNum(v).toFixed(4)}%`;
}

function loadRunTrades(runId) {
  return d1Query(`
    SELECT trade_id, ticker, direction, status, entry_ts, exit_ts, trim_ts,
           entry_price, exit_price, pnl_pct, exit_reason, setup_name, setup_grade, trimmed_pct
    FROM backtest_run_trades
    WHERE run_id = '${runId.replace(/'/g, "''")}'
    ORDER BY ticker, entry_ts
  `).map((r) => ({
    ...r,
    pnl_pct: safeNum(r.pnl_pct),
    entry_ts: safeNum(r.entry_ts, null),
    exit_ts: safeNum(r.exit_ts, null),
    trim_ts: safeNum(r.trim_ts, null),
    trimmed_pct: safeNum(r.trimmed_pct),
  }));
}

function summarizeRun(trades) {
  const closed = trades.filter((t) => ["WIN", "LOSS", "FLAT"].includes(String(t.status || "").toUpperCase()));
  const sameDay = closed.filter((t) => t.exit_ts && t.entry_ts && (t.exit_ts - t.entry_ts) < 390 * 60000);
  const oneToThreeDays = closed.filter((t) => t.exit_ts && t.entry_ts && (t.exit_ts - t.entry_ts) >= 390 * 60000 && (t.exit_ts - t.entry_ts) < 3 * 390 * 60000);
  const threePlusDays = closed.filter((t) => t.exit_ts && t.entry_ts && (t.exit_ts - t.entry_ts) >= 3 * 390 * 60000);

  let quickReentries = 0;
  let quickReentryPnl = 0;
  let sameDayRoundTrips = 0;
  const byTicker = new Map();
  for (const t of trades) {
    if (!byTicker.has(t.ticker)) byTicker.set(t.ticker, []);
    byTicker.get(t.ticker).push(t);
    if (t.exit_ts && t.entry_ts && (t.exit_ts - t.entry_ts) < 390 * 60000) sameDayRoundTrips++;
  }
  for (const tickerTrades of byTicker.values()) {
    for (let i = 0; i < tickerTrades.length - 1; i++) {
      const a = tickerTrades[i];
      const b = tickerTrades[i + 1];
      if (!a.exit_ts || !b.entry_ts) continue;
      if ((b.entry_ts - a.exit_ts) <= 390 * 60000) {
        quickReentries++;
        quickReentryPnl += safeNum(b.pnl_pct);
      }
    }
  }

  const exitFocus = [
    "ripster_72_89_1h_structural_break",
    "SMART_RUNNER_SUPPORT_BREAK_CLOUD",
    "ripster_34_50_lost_mtf",
    "SOFT_FUSE_RSI_CONFIRMED",
    "SMART_RUNNER_TD_EXHAUSTION_RUNNER",
  ];
  const exitMix = {};
  for (const key of exitFocus) {
    const subset = closed.filter((t) => t.exit_reason === key);
    exitMix[key] = {
      trades: subset.length,
      avg_pnl_pct: subset.length ? subset.reduce((s, t) => s + t.pnl_pct, 0) / subset.length : 0,
    };
  }

  const targetedTickers = ["FIX", "TJX", "ULTA", "MNST", "CELH", "APP"];
  const tickerSummary = {};
  for (const ticker of targetedTickers) {
    const subset = trades.filter((t) => t.ticker === ticker);
    tickerSummary[ticker] = {
      trades: subset.length,
      total_pnl_pct: subset.reduce((s, t) => s + t.pnl_pct, 0),
      same_day: subset.filter((t) => t.exit_ts && t.entry_ts && (t.exit_ts - t.entry_ts) < 390 * 60000).length,
    };
  }

  return {
    totalTrades: trades.length,
    wins: closed.filter((t) => t.status === "WIN").length,
    losses: closed.filter((t) => t.status === "LOSS").length,
    flats: closed.filter((t) => t.status === "FLAT").length,
    totalPnlPct: closed.reduce((s, t) => s + t.pnl_pct, 0),
    avgTradePct: closed.length ? closed.reduce((s, t) => s + t.pnl_pct, 0) / closed.length : 0,
    holdProfile: {
      same_day: { trades: sameDay.length, avg_pnl_pct: sameDay.length ? sameDay.reduce((s, t) => s + t.pnl_pct, 0) / sameDay.length : 0 },
      one_to_three_days: { trades: oneToThreeDays.length, avg_pnl_pct: oneToThreeDays.length ? oneToThreeDays.reduce((s, t) => s + t.pnl_pct, 0) / oneToThreeDays.length : 0 },
      three_plus_days: { trades: threePlusDays.length, avg_pnl_pct: threePlusDays.length ? threePlusDays.reduce((s, t) => s + t.pnl_pct, 0) / threePlusDays.length : 0 },
    },
    sameDayRoundTrips,
    quickReentries1d: quickReentries,
    quickReentryAvgPnlPct: quickReentries ? quickReentryPnl / quickReentries : 0,
    exitMix,
    tickerSummary,
  };
}

const baselineTrades = loadRunTrades(BASELINE_RUN_ID);
const candidateTrades = loadRunTrades(CANDIDATE_RUN_ID);

if (!baselineTrades.length) {
  console.error(`Baseline run not found: ${BASELINE_RUN_ID}`);
  process.exit(1);
}
if (!candidateTrades.length) {
  console.error(`Candidate run not found: ${CANDIDATE_RUN_ID}`);
  process.exit(1);
}

const baseline = summarizeRun(baselineTrades);
const challenger = summarizeRun(candidateTrades);

const report = {
  baseline_run_id: BASELINE_RUN_ID,
  candidate_run_id: CANDIDATE_RUN_ID,
  baseline,
  challenger,
};

const outJson = path.join(OUT_DIR, `${CANDIDATE_RUN_ID.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`);
fs.writeFileSync(outJson, JSON.stringify(report, null, 2));

const md = [];
md.push("# Refinement Validation Report");
md.push("");
md.push(`- baseline: \`${BASELINE_RUN_ID}\``);
md.push(`- challenger: \`${CANDIDATE_RUN_ID}\``);
md.push("");
md.push("## Headline");
md.push(`- baseline trades / pnl / avg: \`${baseline.totalTrades}\` / \`${fmtPct(baseline.totalPnlPct)}\` / \`${fmtPct(baseline.avgTradePct)}\``);
md.push(`- challenger trades / pnl / avg: \`${challenger.totalTrades}\` / \`${fmtPct(challenger.totalPnlPct)}\` / \`${fmtPct(challenger.avgTradePct)}\``);
md.push("");
md.push("## Churn");
md.push(`- baseline quick re-entries within 1 day: \`${baseline.quickReentries1d}\` @ \`${fmtPct(baseline.quickReentryAvgPnlPct)}\``);
md.push(`- challenger quick re-entries within 1 day: \`${challenger.quickReentries1d}\` @ \`${fmtPct(challenger.quickReentryAvgPnlPct)}\``);
md.push(`- baseline same-day round trips: \`${baseline.sameDayRoundTrips}\``);
md.push(`- challenger same-day round trips: \`${challenger.sameDayRoundTrips}\``);
md.push("");
md.push("## Hold Profile");
for (const key of ["same_day", "one_to_three_days", "three_plus_days"]) {
  md.push(`- ${key}: baseline \`${baseline.holdProfile[key].trades}\` @ \`${fmtPct(baseline.holdProfile[key].avg_pnl_pct)}\`, challenger \`${challenger.holdProfile[key].trades}\` @ \`${fmtPct(challenger.holdProfile[key].avg_pnl_pct)}\``);
}
md.push("");
md.push("## Exit Mix");
for (const key of Object.keys(baseline.exitMix)) {
  md.push(`- ${key}: baseline \`${baseline.exitMix[key].trades}\` @ \`${fmtPct(baseline.exitMix[key].avg_pnl_pct)}\`, challenger \`${challenger.exitMix[key].trades}\` @ \`${fmtPct(challenger.exitMix[key].avg_pnl_pct)}\``);
}
md.push("");
md.push("## Targeted Tickers");
for (const ticker of Object.keys(baseline.tickerSummary)) {
  const b = baseline.tickerSummary[ticker];
  const c = challenger.tickerSummary[ticker];
  md.push(`- ${ticker}: baseline \`${b.trades}\` trades / \`${fmtPct(b.total_pnl_pct)}\` / same-day \`${b.same_day}\`, challenger \`${c.trades}\` trades / \`${fmtPct(c.total_pnl_pct)}\` / same-day \`${c.same_day}\``);
}
md.push("");

const outMd = path.join(OUT_DIR, `${CANDIDATE_RUN_ID.replace(/[^a-zA-Z0-9._-]/g, "_")}.md`);
fs.writeFileSync(outMd, md.join("\n"));

console.log(md.join("\n"));
console.log(`\nSaved:
- ${outJson}
- ${outMd}`);
