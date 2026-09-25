#!/usr/bin/env node
// scripts/replay-max-loss-reclaim-reentry.mjs
//
// Counterfactual for a reclaim re-entry after a safety stop.
//
// A max-loss exit is final today: the entry path fires on a trigger, the
// trigger is spent, and a top-ranked state alone does not re-arm it. P
// 2026-09-22 was stopped at -2.7%, sat at rank 95-100 in HTF_BULL_LTF_BULL
// for two sessions, reclaimed its entry and ran to its target — with no
// Short Term position.
//
// Candidate rule: after a `max_loss*` exit, if an hourly bar CLOSES back
// through the original entry price within W trading days, re-enter at that
// close under the original plan (same target and stop) with the live flat
// max-loss floor measured from the re-entry. Replayed on hourly bars; first
// of floor / target / plan stop wins, else marked to market after D days.
//
//   node scripts/replay-max-loss-reclaim-reentry.mjs [--window 1,2,3] [--days 10]

import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const argv = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const DAYS = Number(argv("--days", 10));
const WINDOWS = String(argv("--window", "1,2,3")).split(",").map(Number);
const DAY = 24 * 3600 * 1000;

function d1(sql) {
  const raw = execFileSync("../node_modules/.bin/wrangler", [
    "d1", "execute", "timed-trading-ledger", "--remote", "--json", "--command", sql,
  ], { cwd: new URL("../worker/", import.meta.url).pathname, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  return JSON.parse(raw.slice(raw.indexOf("[")))[0].results;
}

function flatFloorPct(ageMin) {
  if (ageMin >= 1440) return -1.5;
  if (ageMin >= 720) return -2.0;
  if (ageMin >= 240) return -2.5;
  return -3.0;
}
function isRth(ms) {
  const d = new Date(ms);
  const dow = d.getUTCDay();
  const et = (d.getUTCHours() - 4 + 24) % 24 + d.getUTCMinutes() / 60;
  return dow >= 1 && dow <= 5 && et >= 9.5 && et < 16;
}

const trades = d1(`
  SELECT t.trade_id, t.ticker, t.direction, t.entry_ts, t.entry_price, t.exit_ts, t.exit_price,
         t.exit_reason, t.pnl_pct, t.setup_name, t.setup_grade, p.stop_loss, p.take_profit
    FROM trades t JOIN positions p ON p.position_id = t.trade_id
   WHERE t.exit_reason LIKE 'max_loss%' AND t.exit_ts IS NOT NULL
     AND p.stop_loss > 0 AND p.take_profit > 0
   ORDER BY t.exit_ts`);

const bars = new Map();
for (const t of trades) {
  bars.set(t.trade_id, d1(`SELECT ts, h, l, c FROM ticker_candles
    WHERE ticker = '${t.ticker}' AND tf = '60' AND ts > ${Number(t.exit_ts)}
      AND ts <= ${Number(t.exit_ts) + (Math.max(...WINDOWS) + DAYS) * DAY * 1.4} ORDER BY ts`));
}

for (const W of WINDOWS) {
  let n = 0, reentered = 0, total = 0;
  const outcomes = { target: 0, floor: 0, stop: 0, open: 0 };
  const rows = [];
  for (const t of trades) {
    const long = String(t.direction).toUpperCase() !== "SHORT";
    const entry = Number(t.entry_price);
    const stop = Number(t.stop_loss);
    const tp = Number(t.take_profit);
    if (long ? stop >= entry || tp <= entry : stop <= entry || tp >= entry) continue;
    n++;
    const b = (bars.get(t.trade_id) || []).filter((x) => isRth(Number(x.ts)));
    const deadline = Number(t.exit_ts) + W * DAY * 1.4;
    const i = b.findIndex((x) => Number(x.ts) <= deadline && (long ? x.c >= entry : x.c <= entry));
    if (i < 0) { rows.push({ t, reentry: null }); continue; }
    reentered++;
    const px = Number(b[i].c);
    const tpPct = (long ? tp - px : px - tp) / px * 100;
    const stopPct = (long ? px - stop : stop - px) / px * 100;
    let pnl = null, outcome = "open", ageMin = 0;
    const end = Number(b[i].ts) + DAYS * DAY * 1.4;
    for (const x of b.slice(i + 1)) {
      if (Number(x.ts) > end) break;
      ageMin += 60;
      const lowPct = long ? (x.l - px) / px * 100 : (px - x.h) / px * 100;
      const highPct = long ? (x.h - px) / px * 100 : (px - x.l) / px * 100;
      const floorPct = flatFloorPct(ageMin);
      if (lowPct <= -stopPct) { pnl = -stopPct; outcome = "stop"; break; }
      if (lowPct <= floorPct) { pnl = floorPct; outcome = "floor"; break; }
      if (highPct >= tpPct) { pnl = tpPct; outcome = "target"; break; }
    }
    if (pnl == null) {
      const last = b.filter((x) => Number(x.ts) <= end).pop();
      const c = last ? Number(last.c) : px;
      pnl = long ? (c - px) / px * 100 : (px - c) / px * 100;
    }
    outcomes[outcome]++;
    total += pnl;
    rows.push({ t, reentry: px, pnl, outcome });
  }
  console.log(`\nReclaim within ${W} trading day(s) of the stop:  ${reentered}/${n} stops would have re-entered`);
  console.log(`  re-entries: target ${outcomes.target} · floor ${outcomes.floor} · plan stop ${outcomes.stop} · still open ${outcomes.open}`);
  console.log(`  sum ${total >= 0 ? "+" : ""}${total.toFixed(1)}%   per re-entry ${reentered ? (total / reentered).toFixed(2) : "n/a"}%   win rate ${reentered ? Math.round(100 * rows.filter((r) => r.pnl > 0).length / reentered) : 0}%`);
  if (W === WINDOWS[Math.floor(WINDOWS.length / 2)]) {
    for (const r of rows.filter((x) => x.reentry != null)) {
      console.log(`    ${r.t.ticker.padEnd(5)} stopped ${Number(r.t.pnl_pct).toFixed(2).padStart(6)}%  re-enter ${r.reentry.toFixed(2).padStart(8)}  ->  ${r.pnl.toFixed(2).padStart(6)}% ${r.outcome.padEnd(6)} ${r.t.setup_name || ""} ${r.t.setup_grade || ""}`);
    }
  }
}
