#!/usr/bin/env node
// scripts/replay-post-trim-floor.mjs
//
// Counterfactual for POST_TRIM_ENTRY_FLOOR (deep_audit_ja_post_trim_floor):
// after the first trim, the remainder closes once price is 0.15% through
// entry. For every trimmed trade whose remainder came back to that floor,
// replay the remainder from the floor touch under alternative rules:
//
//   floor      live rule: exit at the 10m close through entry - 0.15%
//   plan       no floor: first of the ORIGINAL plan stop / target, else mark
//   half_r     floor at entry - 0.5 x the trade's own risk, then plan
//   h1_close   floor needs an hourly CLOSE through entry - 0.15%, then plan
//
// All rules share the same touch, so they are compared on the same trades.
// Horizon: --days trading days after the touch (default 10), marked at close.
// Same-bar ambiguity goes against the rule (stop before target).
//
//   node scripts/replay-post-trim-floor.mjs [--days 10] [--since 2026-05-01]

import { loadTradesWithPlan, candles, rthOnly, MS } from "./lib/trade-tape.mjs";

const args = process.argv.slice(2);
const argv = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const DAYS = Number(argv("--days", 10));
const SINCE = Date.parse(argv("--since", "2026-05-01"));
const BUF = 0.15;

const trades = loadTradesWithPlan({ sinceMs: SINCE }).filter((t) => t.trims.length && t.sl && t.tp);

const pnlAt = (t, px) => (t.long ? (px - t.entry) / t.entry : (t.entry - px) / t.entry) * 100;
const through = (t, px, lvl) => (t.long ? px <= lvl : px >= lvl);

/** Walk bars from index i: first of stop / target, else mark at the last bar. */
function planFrom(t, bars, i) {
  for (let j = i; j < bars.length; j++) {
    const b = bars[j];
    const adverse = t.long ? b.l <= t.sl : b.h >= t.sl;
    if (adverse) {
      const gapped = t.long ? b.o < t.sl : b.o > t.sl;
      return { pnl: pnlAt(t, gapped ? b.o : t.sl), how: "stop" };
    }
    if (t.long ? b.h >= t.tp : b.l <= t.tp) return { pnl: pnlAt(t, t.tp), how: "target" };
  }
  return { pnl: pnlAt(t, bars[bars.length - 1].c), how: "open" };
}

function levelFrom(t, bars, i, lvl) {
  for (let j = i; j < bars.length; j++) {
    const r = planFrom(t, bars.slice(j, j + 1), 0);
    if (r.how !== "open") return { ...r, j };
    if (through(t, bars[j].c, lvl)) return { pnl: pnlAt(t, bars[j].c), how: "floor", j };
  }
  return { pnl: pnlAt(t, bars[bars.length - 1].c), how: "open" };
}

const rows = [];
for (const t of trades) {
  const trim = t.trims[0];
  const end = trim.ts + (DAYS + 6) * 1.5 * MS.DAY;
  const m10 = rthOnly(candles(t.ticker, "10", trim.ts, end));
  const h1 = rthOnly(candles(t.ticker, "60", trim.ts - 2 * MS.DAY, end));
  const floor = t.entry * (1 + (t.long ? -BUF : BUF) / 100);
  const ti = m10.findIndex((b) => b.ts > trim.ts + 10 * 60 * 1000 && through(t, b.c, floor));
  if (ti < 0) continue;
  const touch = m10[ti];
  const days = new Set();
  let last = ti;
  for (let j = ti; j < m10.length; j++) { days.add(new Date(m10[j].ts - 4 * 3600e3).toISOString().slice(0, 10)); if (days.size > DAYS) break; last = j; }
  const win = m10.slice(ti, last + 1);
  const risk = Math.abs(t.entry - t.sl);
  const halfR = t.long ? t.entry - 0.5 * risk : t.entry + 0.5 * risk;

  const floorR = { pnl: pnlAt(t, touch.c), how: "floor" };
  const planR = planFrom(t, win, 1);
  const halfRR = levelFrom(t, win, 1, halfR);
  // Hourly-close floor: the first h1 bar that CLOSES through the floor at or after the touch.
  const h1i = h1.findIndex((b) => b.ts + 3600e3 > touch.ts && b.ts <= win[win.length - 1].ts && through(t, b.c, floor));
  let h1R;
  if (h1i < 0) h1R = planFrom(t, win, 1);
  else {
    const cut = h1[h1i].ts + 3600e3;
    const pre = win.filter((b) => b.ts < cut);
    const pr = planFrom(t, pre, 1);
    h1R = pr.how !== "open" ? pr : { pnl: pnlAt(t, h1[h1i].c), how: "floor" };
  }
  rows.push({
    ticker: t.ticker, grade: t.setup_grade, setup: t.setup_name, date: new Date(touch.ts).toISOString().slice(0, 10),
    trimPct: pnlAt(t, trim.price), riskPct: (risk / t.entry) * 100, tpPct: Math.abs(t.tp - t.entry) / t.entry * 100,
    floor: floorR, plan: planR, half_r: halfRR, h1_close: h1R,
  });
}

const rules = ["floor", "plan", "half_r", "h1_close"];
console.log(`Trimmed trades since ${argv("--since", "2026-05-01")} with a plan: ${trades.length}; remainder came back to the floor: ${rows.length}`);
console.log(`Remainder P&L from the floor touch, % of entry (sum / per trade), horizon ${DAYS} sessions:\n`);
for (const r of rules) {
  const s = rows.reduce((a, x) => a + x[r].pnl, 0);
  const by = (h) => rows.filter((x) => x[r].how === h).length;
  console.log(`  ${r.padEnd(9)} ${s.toFixed(1).padStart(7)}%  ${(s / rows.length).toFixed(2).padStart(6)}/trade   target ${by("target")} · stop ${by("stop")} · floor ${by("floor")} · open ${by("open")}`);
}
for (const g of ["Prime", "Confirmed", "Speculative"]) {
  const sub = rows.filter((x) => x.grade === g);
  if (!sub.length) continue;
  console.log(`\n  ${g} (n=${sub.length}): ` + rules.map((r) => `${r} ${sub.reduce((a, x) => a + x[r].pnl, 0).toFixed(1)}%`).join(" · "));
}
console.log("\nPer trade (remainder % of entry):");
for (const x of rows) {
  console.log(`  ${x.date} ${x.ticker.padEnd(5)} ${String(x.grade || "").padEnd(11)} trim@${x.trimPct.toFixed(2).padStart(5)}% risk ${x.riskPct.toFixed(1).padStart(4)}% tp ${x.tpPct.toFixed(1).padStart(4)}%  `
    + rules.map((r) => `${r} ${x[r].pnl.toFixed(2).padStart(6)} ${x[r].how.padEnd(6)}`).join("  "));
}
