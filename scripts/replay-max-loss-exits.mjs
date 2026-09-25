#!/usr/bin/env node
// scripts/replay-max-loss-exits.mjs
//
// Did the max-loss exits save money, or throw away trades that were fine?
//
// For every closed Short Term trade exited by a `max_loss*` rule, walk the
// hourly candles after the exit and ask which the trade's OWN plan would have
// hit first: its take-profit or its stop-loss (both from `positions`). Also
// report the exit in R — the fraction of the trade's own stop distance the
// rule gave up at — since the rule is a flat percentage and the stop is not.
//
//   node scripts/replay-max-loss-exits.mjs [--days 10] [--json out.json]
//
// Reads production D1 through wrangler (CLOUDFLARE_API_TOKEN).

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const argv = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const DAYS = Number(argv("--days", 10));
const OUT = argv("--json", null);

function d1(sql) {
  const raw = execFileSync("../node_modules/.bin/wrangler", [
    "d1", "execute", "timed-trading-ledger", "--remote", "--json", "--command", sql,
  ], { cwd: new URL("../worker/", import.meta.url).pathname, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  const parsed = JSON.parse(raw.slice(raw.indexOf("[")));
  return parsed[0].results;
}

const trades = d1(`
  SELECT t.trade_id, t.ticker, t.direction, t.entry_ts, t.entry_price, t.exit_ts, t.exit_price,
         t.exit_reason, t.pnl_pct, t.setup_name, t.setup_grade, t.entry_path,
         t.max_favorable_excursion AS mfe, p.stop_loss, p.take_profit
    FROM trades t JOIN positions p ON p.position_id = t.trade_id
   WHERE t.exit_reason LIKE 'max_loss%' AND t.exit_ts IS NOT NULL
     AND p.stop_loss > 0 AND p.take_profit > 0
   ORDER BY t.exit_ts`);

const WINDOW_MS = DAYS * 24 * 3600 * 1000 * 1.4; // trading days, weekends included
const results = [];
for (const t of trades) {
  const long = String(t.direction).toUpperCase() !== "SHORT";
  const entry = Number(t.entry_price);
  const stop = Number(t.stop_loss);
  const tp = Number(t.take_profit);
  const exit = Number(t.exit_price);
  const riskPct = Math.abs(entry - stop) / entry * 100;
  const exitR = (long ? exit - entry : entry - exit) / Math.abs(entry - stop);
  // A stop on the wrong side of entry is not a plan to replay against.
  if (!(riskPct > 0) || (long ? stop >= entry || tp <= entry : stop <= entry || tp >= entry)) continue;

  const bars = d1(`SELECT ts, h, l, c FROM ticker_candles
     WHERE ticker = '${t.ticker}' AND tf = '60' AND ts > ${Number(t.exit_ts)} AND ts <= ${Number(t.exit_ts) + WINDOW_MS}
     ORDER BY ts`);
  let outcome = "neither";
  let hitTs = null;
  for (const b of bars) {
    const hitStop = long ? b.l <= stop : b.h >= stop;
    const hitTp = long ? b.h >= tp : b.l <= tp;
    // Same bar touching both: count it as the stop. Conservative.
    if (hitStop) { outcome = "stop"; hitTs = b.ts; break; }
    if (hitTp) { outcome = "target"; hitTs = b.ts; break; }
  }
  const last = bars.length ? Number(bars[bars.length - 1].c) : null;
  const heldPct = last != null ? (long ? last - entry : entry - last) / entry * 100 : null;
  // What the plan would have made: +TP%, -stop%, or mark-to-market at window end.
  const tpPct = Math.abs(tp - entry) / entry * 100;
  const planPct = outcome === "target" ? tpPct : outcome === "stop" ? -riskPct : heldPct;
  results.push({
    trade_id: t.trade_id, ticker: t.ticker, dir: long ? "L" : "S", reason: t.exit_reason,
    setup: t.setup_name, grade: t.setup_grade, path: t.entry_path,
    risk_pct: +riskPct.toFixed(2), tp_pct: +tpPct.toFixed(2),
    exit_pct: +Number(t.pnl_pct).toFixed(2), exit_R: +exitR.toFixed(2),
    outcome, days_to_hit: hitTs ? +((hitTs - t.exit_ts) / 86400000).toFixed(1) : null,
    plan_pct: planPct == null ? null : +planPct.toFixed(2), bars: bars.length,
  });
}

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
function summarize(rows, label) {
  const n = rows.length;
  if (!n) return;
  const c = (o) => rows.filter((r) => r.outcome === o).length;
  const exitSum = sum(rows.map((r) => r.exit_pct));
  const planSum = sum(rows.map((r) => r.plan_pct ?? r.exit_pct));
  console.log(`\n${label}  (n=${n})`);
  console.log(`  after the exit, the trade's own plan hit: target ${c("target")} · stop ${c("stop")} · neither ${c("neither")}`);
  console.log(`  median exit at ${median(rows.map((r) => r.exit_R))}R of the trade's own risk (median stop distance ${median(rows.map((r) => r.risk_pct))}%)`);
  console.log(`  sum of exits ${exitSum.toFixed(1)}%  vs  holding to the plan ${planSum.toFixed(1)}%  (per-trade avg ${(exitSum / n).toFixed(2)}% vs ${(planSum / n).toFixed(2)}%)`);
}
function median(xs) { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; }

console.log(`Max-loss exits replayed against each trade's own stop and target, ${DAYS} trading days forward (hourly bars).`);
summarize(results, "ALL max_loss*");
for (const r of ["max_loss", "max_loss_time_scaled", "max_loss_time_scaled_momentum_buffered"]) {
  summarize(results.filter((x) => x.reason === r), r);
}
const wide = results.filter((r) => r.exit_R > -0.5);
summarize(wide, "Exits at less than half the trade's own risk (exit_R > -0.5R)");
summarize(results.filter((r) => r.exit_R <= -0.5), "Exits at half the trade's risk or more");

console.log("\nPer trade:");
for (const r of results) {
  console.log(`  ${r.ticker.padEnd(5)} ${r.dir} ${r.reason.padEnd(38)} risk ${String(r.risk_pct).padStart(5)}%  exit ${String(r.exit_pct).padStart(6)}% (${String(r.exit_R).padStart(5)}R)  -> ${r.outcome.padEnd(7)} ${r.days_to_hit != null ? `${r.days_to_hit}d` : ""}  plan ${r.plan_pct}%  ${r.setup || ""}`);
}
if (OUT) writeFileSync(OUT, JSON.stringify(results, null, 2));
