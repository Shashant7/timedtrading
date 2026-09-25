#!/usr/bin/env node
// scripts/replay-st-profit-lock.mjs
//
// Counterfactual for a Short Term profit lock.
//
// 140 live Short Term trades since July reached an average peak of +3.69%
// and booked -0.11%; 21 of them were up 2% or more and closed red, for
// -41.1% between them. Winners kept about a third of their peak.
//
// Candidate rule: once a trade has been up ARM% at any point, its floor
// rises to entry + LOCK x (peak - entry). Replayed on the trade's own hourly
// bars from entry to its ACTUAL exit: the lock can only make an exit happen
// earlier, never invent a later one. If the floor is touched first, the trade
// is booked at the floor; otherwise it keeps what it actually booked. A bar
// that both arms and touches is not counted until the next bar.
//
//   node scripts/replay-st-profit-lock.mjs [--arm 1.5,2,3] [--lock 0,0.5]

import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const argv = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const ARMS = String(argv("--arm", "1.5,2,3")).split(",").map(Number);
const LOCKS = String(argv("--lock", "0,0.25,0.5")).split(",").map(Number);
const SINCE = Number(argv("--since", 1782864000000));

function d1(sql) {
  const raw = execFileSync("../node_modules/.bin/wrangler", [
    "d1", "execute", "timed-trading-ledger", "--remote", "--json", "--command", sql,
  ], { cwd: new URL("../worker/", import.meta.url).pathname, encoding: "utf8", maxBuffer: 512 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  return JSON.parse(raw.slice(raw.indexOf("[")))[0].results;
}

const trades = d1(`
  SELECT trade_id, ticker, direction, entry_ts, entry_price, exit_ts, exit_price, pnl_pct,
         exit_reason, setup_name, max_favorable_excursion AS mfe
    FROM trades
   WHERE status IN ('WIN','LOSS','FLAT') AND exit_ts > ${SINCE}
     AND (run_id IS NULL OR run_id = '') AND entry_price > 0
   ORDER BY exit_ts`);

// One query per ticker for the whole span, sliced per trade.
const byTicker = new Map();
for (const t of trades) {
  const k = t.ticker;
  const r = byTicker.get(k) || { from: Infinity, to: 0 };
  r.from = Math.min(r.from, Number(t.entry_ts));
  r.to = Math.max(r.to, Number(t.exit_ts));
  byTicker.set(k, r);
}
const candles = new Map();
for (const [ticker, { from, to }] of byTicker) {
  candles.set(ticker, d1(`SELECT ts, h, l FROM ticker_candles
    WHERE ticker = '${ticker}' AND tf = '60' AND ts >= ${from - 3600000} AND ts <= ${to} ORDER BY ts`));
}

let covered = 0;
const results = [];
for (const arm of ARMS) {
  for (const lock of LOCKS) {
    let actualSum = 0, candSum = 0, fired = 0, savedLosers = 0, clippedWinners = 0, clipCost = 0, saveGain = 0;
    let n = 0;
    for (const t of trades) {
      const long = String(t.direction).toUpperCase() !== "SHORT";
      const entry = Number(t.entry_price);
      const bars = (candles.get(t.ticker) || [])
        .filter((b) => Number(b.ts) >= Number(t.entry_ts) - 3600000 && Number(b.ts) < Number(t.exit_ts));
      if (!bars.length) continue;
      n++;
      const actual = Number(t.pnl_pct);
      actualSum += actual;
      let peak = 0;
      let armed = false;
      let booked = actual;
      for (const b of bars) {
        const hi = long ? (b.h - entry) / entry * 100 : (entry - b.l) / entry * 100;
        const lo = long ? (b.l - entry) / entry * 100 : (entry - b.h) / entry * 100;
        if (armed) {
          const floor = lock * peak;
          if (lo <= floor) { booked = floor; break; }
        }
        peak = Math.max(peak, hi);
        if (!armed && peak >= arm) armed = true;
      }
      if (booked !== actual) {
        fired++;
        const d = booked - actual;
        if (d >= 0) { savedLosers++; saveGain += d; } else { clippedWinners++; clipCost += d; }
      }
      candSum += booked;
    }
    covered = n;
    results.push({ arm, lock, n, actualSum, candSum, fired, savedLosers, clippedWinners, saveGain, clipCost });
  }
}

console.log(`Short Term profit lock, replayed on ${covered} live trades with hourly bars (of ${trades.length} since ${new Date(SINCE).toISOString().slice(0, 10)}).`);
console.log("floor after arming = entry + LOCK x peak gain. Booked sum is the sum of per-trade % returns.\n");
console.log("  arm   lock   booked now  ->  with lock   diff    fired  helped (+pts)   hurt (-pts)");
for (const r of results) {
  const diff = r.candSum - r.actualSum;
  console.log(`  ${String(r.arm).padEnd(4)}%  ${String(r.lock).padEnd(4)}   ${r.actualSum.toFixed(1).padStart(7)}%  ->  ${r.candSum.toFixed(1).padStart(7)}%  ${(diff >= 0 ? "+" : "") + diff.toFixed(1)}`.padEnd(62)
    + `  ${String(r.fired).padStart(3)}    ${String(r.savedLosers).padStart(3)} (+${r.saveGain.toFixed(1)})     ${String(r.clippedWinners).padStart(3)} (${r.clipCost.toFixed(1)})`);
}
