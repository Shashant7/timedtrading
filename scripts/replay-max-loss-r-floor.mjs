#!/usr/bin/env node
// scripts/replay-max-loss-r-floor.mjs
//
// Counterfactual for an R-aware max-loss floor. The live rule cuts at a flat
// percentage (-3%, then -2.5 / -2.0 / -1.5% as the trade ages) whatever the
// trade's own stop distance is. On a wide-stop trade that is noise: P
// 2026-09-22 was cut at -2.7% on a 10.1% stop (-0.27R) and hit its target
// 1.9 days later.
//
// Candidate rule: the same floors, but never tighter than K x the trade's own
// risk. Replayed from ENTRY on hourly bars: first of floor / target / plan
// stop wins; a trade that hits none within the window is marked to market.
// Compared with what the trade actually booked (every exit rule included).
//
//   node scripts/replay-max-loss-r-floor.mjs [--k 0.5] [--days 10]
//
// Reads production D1 through wrangler (CLOUDFLARE_API_TOKEN).

import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const argv = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const DAYS = Number(argv("--days", 10));
const KS = String(argv("--k", "0.4,0.5,0.6")).split(",").map(Number);

function d1(sql) {
  const raw = execFileSync("../node_modules/.bin/wrangler", [
    "d1", "execute", "timed-trading-ledger", "--remote", "--json", "--command", sql,
  ], { cwd: new URL("../worker/", import.meta.url).pathname, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  return JSON.parse(raw.slice(raw.indexOf("[")))[0].results;
}

/** The live flat floor for a position this many market minutes old. */
export function flatFloorPct(ageMin) {
  if (ageMin >= 1440) return -1.5;
  if (ageMin >= 720) return -2.0;
  if (ageMin >= 240) return -2.5;
  return -3.0;
}

const trades = d1(`
  SELECT t.trade_id, t.ticker, t.direction, t.entry_ts, t.entry_price, t.exit_ts, t.exit_price,
         t.exit_reason, t.pnl_pct, t.setup_name, p.stop_loss, p.take_profit
    FROM trades t JOIN positions p ON p.position_id = t.trade_id
   WHERE t.exit_reason LIKE 'max_loss%' AND t.exit_ts IS NOT NULL
     AND p.stop_loss > 0 AND p.take_profit > 0
   ORDER BY t.exit_ts`);

const barsByTrade = new Map();
for (const t of trades) {
  const end = Number(t.exit_ts) + DAYS * 24 * 3600 * 1000 * 1.4;
  barsByTrade.set(t.trade_id, d1(`SELECT ts, h, l, c FROM ticker_candles
    WHERE ticker = '${t.ticker}' AND tf = '60' AND ts > ${Number(t.entry_ts)} AND ts <= ${end} ORDER BY ts`));
}

// Market minutes between two timestamps, counting 6.5h per weekday session.
function marketMinutes(fromMs, toMs) {
  let min = 0;
  for (let t = fromMs; t < toMs; t += 60 * 60 * 1000) {
    const d = new Date(t);
    const dow = d.getUTCDay();
    const et = (d.getUTCHours() - 4 + 24) % 24 + d.getUTCMinutes() / 60;
    if (dow >= 1 && dow <= 5 && et >= 9.5 && et < 16) min += 60;
  }
  return min;
}

for (const K of KS) {
  let actual = 0, cand = 0, changed = 0, n = 0;
  const rows = [];
  for (const t of trades) {
    const long = String(t.direction).toUpperCase() !== "SHORT";
    const entry = Number(t.entry_price);
    const stop = Number(t.stop_loss);
    const tp = Number(t.take_profit);
    const riskPct = Math.abs(entry - stop) / entry * 100;
    if (!(riskPct > 0) || (long ? stop >= entry || tp <= entry : stop <= entry || tp >= entry)) continue;
    const tpPct = Math.abs(tp - entry) / entry * 100;
    const bars = barsByTrade.get(t.trade_id) || [];
    n++;
    actual += Number(t.pnl_pct);

    let outcome = "open";
    let pnl = null;
    for (const b of bars) {
      const age = marketMinutes(Number(t.entry_ts), Number(b.ts));
      const floorPct = Math.min(flatFloorPct(age), -K * riskPct);
      const lowPct = long ? (b.l - entry) / entry * 100 : (entry - b.h) / entry * 100;
      const highPct = long ? (b.h - entry) / entry * 100 : (entry - b.l) / entry * 100;
      if (lowPct <= -riskPct) { outcome = "stop"; pnl = -riskPct; break; }
      if (lowPct <= floorPct) { outcome = "floor"; pnl = floorPct; break; }
      if (highPct >= tpPct) { outcome = "target"; pnl = tpPct; break; }
    }
    if (pnl == null) {
      const last = bars.length ? Number(bars[bars.length - 1].c) : entry;
      pnl = long ? (last - entry) / entry * 100 : (entry - last) / entry * 100;
    }
    cand += pnl;
    const flatIsLooser = K * riskPct <= 1.5;
    if (!flatIsLooser) changed++;
    rows.push({ ticker: t.ticker, risk: riskPct.toFixed(2), actual: Number(t.pnl_pct).toFixed(2), cand: pnl.toFixed(2), outcome, setup: t.setup_name });
  }
  console.log(`\nK=${K}: floor = min(live flat floor, -${K} x the trade's own risk)   n=${n}`);
  console.log(`  actual booked ${actual.toFixed(1)}%   candidate ${cand.toFixed(1)}%   difference ${(cand - actual >= 0 ? "+" : "")}${(cand - actual).toFixed(1)} pts  (${((cand - actual) / n).toFixed(2)} per trade)`);
  const by = (o) => rows.filter((r) => r.outcome === o).length;
  console.log(`  candidate outcomes: target ${by("target")} · floor ${by("floor")} · plan stop ${by("stop")} · still open ${by("open")}`);
  if (K === KS[Math.floor(KS.length / 2)]) {
    for (const r of rows) console.log(`    ${r.ticker.padEnd(5)} risk ${r.risk.padStart(5)}%  actual ${r.actual.padStart(6)}%  ->  ${r.cand.padStart(6)}%  ${r.outcome.padEnd(6)} ${r.setup || ""}`);
  }
}
