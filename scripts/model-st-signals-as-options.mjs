#!/usr/bin/env node
// scripts/model-st-signals-as-options.mjs
//
// What would the Short Term signals have made as options?
//
// No single-stock option marks are stored (option_marks covers SPY / QQQ /
// IWM / DIA only), so this is a MODEL, not a measurement: every closed live
// Short Term trade is repriced as a 30-day at-the-money option — calls for
// longs, puts for shorts — with Black-Scholes at the trade's real entry and
// exit price and real holding time. IV is held flat across the trade (no
// vol crush or expansion) and a round-trip spread is charged as a fraction
// of premium. Both unknowns get a sensitivity range.
//
//   node scripts/model-st-signals-as-options.mjs [--dte 30] [--iv 0.3,0.45,0.6] [--spread 0.04,0.08]

import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const argv = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const DTE = Number(argv("--dte", 30));
const IVS = String(argv("--iv", "0.3,0.45,0.6")).split(",").map(Number);
const SPREADS = String(argv("--spread", "0.04,0.08")).split(",").map(Number);
const SINCE = Number(argv("--since", 1782864000000));

function d1(sql) {
  const raw = execFileSync("../node_modules/.bin/wrangler", [
    "d1", "execute", "timed-trading-ledger", "--remote", "--json", "--command", sql,
  ], { cwd: new URL("../worker/", import.meta.url).pathname, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  return JSON.parse(raw.slice(raw.indexOf("[")))[0].results;
}

function ncdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}
/** Black-Scholes, r = 0. */
export function bs({ spot, strike, years, iv, call }) {
  if (years <= 0) return Math.max(0, call ? spot - strike : strike - spot);
  const sd = iv * Math.sqrt(years);
  const d1v = (Math.log(spot / strike) + 0.5 * sd * sd) / sd;
  const d2v = d1v - sd;
  return call ? spot * ncdf(d1v) - strike * ncdf(d2v) : strike * ncdf(-d2v) - spot * ncdf(-d1v);
}

const trades = d1(`
  SELECT ticker, direction, entry_ts, entry_price, exit_ts, exit_price, pnl_pct, setup_name
    FROM trades
   WHERE status IN ('WIN','LOSS','FLAT') AND exit_ts > ${SINCE}
     AND (run_id IS NULL OR run_id = '') AND entry_price > 0 AND exit_price > 0`);

const YEAR_MS = 365 * 24 * 3600 * 1000;
console.log(`${trades.length} live Short Term trades since ${new Date(SINCE).toISOString().slice(0, 10)}, repriced as ${DTE}-DTE at-the-money options (MODEL).`);
const stock = trades.reduce((a, t) => a + Number(t.pnl_pct), 0);
console.log(`Stock, as booked: sum ${stock.toFixed(1)}%   per trade ${(stock / trades.length).toFixed(2)}%   win rate ${Math.round(100 * trades.filter((t) => t.pnl_pct > 0).length / trades.length)}%\n`);
console.log("  IV     spread   per-trade option return   win rate   sum of returns   worst");

const bySetup = new Map();
for (const iv of IVS) {
  for (const spread of SPREADS) {
    const rets = [];
    for (const t of trades) {
      const call = String(t.direction).toUpperCase() !== "SHORT";
      const S0 = Number(t.entry_price);
      const S1 = Number(t.exit_price);
      const held = Math.max(0, (Number(t.exit_ts) - Number(t.entry_ts)) / YEAR_MS);
      const T0 = DTE / 365;
      const p0 = bs({ spot: S0, strike: S0, years: T0, iv, call });
      const p1 = bs({ spot: S1, strike: S0, years: Math.max(0, T0 - held), iv, call });
      const r = (p1 * (1 - spread / 2) - p0 * (1 + spread / 2)) / (p0 * (1 + spread / 2)) * 100;
      rets.push(r);
      if (iv === IVS[Math.floor(IVS.length / 2)] && spread === SPREADS[0]) {
        const k = t.setup_name || "unknown";
        const s = bySetup.get(k) || { n: 0, stock: 0, opt: 0 };
        s.n++; s.stock += Number(t.pnl_pct); s.opt += r;
        bySetup.set(k, s);
      }
    }
    const sum = rets.reduce((a, b) => a + b, 0);
    console.log(`  ${(iv * 100).toFixed(0).padStart(3)}%   ${(spread * 100).toFixed(0).padStart(3)}%       ${(sum / rets.length).toFixed(1).padStart(7)}%              ${Math.round(100 * rets.filter((x) => x > 0).length / rets.length)}%        ${sum.toFixed(0).padStart(6)}%      ${Math.min(...rets).toFixed(0)}%`);
  }
}
const mid = IVS[Math.floor(IVS.length / 2)];
console.log(`\nBy setup at IV ${(mid * 100).toFixed(0)}%, spread ${(SPREADS[0] * 100).toFixed(0)}% (per-trade averages):`);
for (const [k, s] of [...bySetup].sort((a, b) => b[1].n - a[1].n)) {
  if (s.n < 5) continue;
  console.log(`  ${k.padEnd(26)} n=${String(s.n).padStart(3)}   stock ${(s.stock / s.n).toFixed(2).padStart(6)}%   option ${(s.opt / s.n).toFixed(1).padStart(6)}%`);
}
