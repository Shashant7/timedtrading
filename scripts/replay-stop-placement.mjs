#!/usr/bin/env node
// scripts/replay-stop-placement.mjs
//
// Would a stop placed BEYOND recent structure do better than the plan stop?
// replay-stop-context.mjs shows stops inside the prior 5-day swing are touched
// more often and recover ~1 in 4 times (noise), while stops beyond it rarely
// recover once hit. This replays every trade from entry on 10m bars under:
//
//   plan       the ENTRY event's stop and target
//   swingN     if the plan stop sits inside the prior N-day swing, move it
//              BUFFER x daily ATR beyond that swing (capped at CAP x ATR from
//              entry); target unchanged
//
// Sizing is risk-based, so a wider stop means fewer shares for the same dollar
// risk: results are compared in R (multiples of each version's own risk).
// First of stop / target within --days sessions, else marked at the close.
// Same-bar ambiguity goes against the trade (stop first).
//
//   node scripts/replay-stop-placement.mjs [--days 10] [--buffer 0.1] [--cap 3]

import { loadTradesWithPlan, candles, rthOnly, etClock, atr, MS } from "./lib/trade-tape.mjs";

const args = process.argv.slice(2);
const argv = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const DAYS = Number(argv("--days", 10));
const BUFFER = Number(argv("--buffer", 0.1));
const CAP = Number(argv("--cap", 3));
const SINCE = Date.parse(argv("--since", "2026-05-01"));

const trades = loadTradesWithPlan({ sinceMs: SINCE }).filter((t) => t.sl && t.tp);

function run(t, bars, sl) {
  const risk = Math.abs(t.entry - sl);
  const R = (px) => (t.long ? px - t.entry : t.entry - px) / risk;
  for (const b of bars) {
    if (t.long ? b.l <= sl : b.h >= sl) return { r: R((t.long ? b.o < sl : b.o > sl) ? b.o : sl), how: "stop" };
    if (t.long ? b.h >= t.tp : b.l <= t.tp) return { r: R(t.tp), how: "target" };
  }
  return { r: R(bars[bars.length - 1].c), how: "open" };
}

const arms = { plan: [], swing5: [], swing10: [] };
const changed = { swing5: [], swing10: [] };
for (const t of trades) {
  const d = candles(t.ticker, "D", t.entry_ts - 60 * MS.DAY, t.entry_ts - 1).filter((x) => x.ts < t.entry_ts - 6 * 3600e3);
  const m10all = rthOnly(candles(t.ticker, "10", t.entry_ts - 12 * MS.DAY, t.entry_ts + 30 * MS.DAY));
  const e0 = m10all.findIndex((b) => b.ts > t.entry_ts);
  if (d.length < 15 || e0 < 0) continue;
  const days = new Set();
  let last = e0;
  for (let j = e0; j < m10all.length; j++) { days.add(etClock(m10all[j].ts).date); if (days.size > DAYS) break; last = j; }
  const bars = m10all.slice(e0 + 1, last + 1);
  if (!bars.length) continue;
  const a = atr(d, 14).filter((v) => v != null).at(-1);
  const planR = run(t, bars, t.sl);
  arms.plan.push({ t, ...planR });
  for (const n of [5, 10]) {
    const prior = d.slice(-n);
    const swing = t.long ? Math.min(...prior.map((x) => x.l)) : Math.max(...prior.map((x) => x.h));
    const inside = t.long ? t.sl >= swing : t.sl <= swing;
    let sl = t.sl;
    if (inside) {
      sl = t.long ? swing - BUFFER * a : swing + BUFFER * a;
      const cap = t.long ? t.entry - CAP * a : t.entry + CAP * a;
      sl = t.long ? Math.max(sl, cap) : Math.min(sl, cap);
      if (t.long ? sl >= t.sl : sl <= t.sl) sl = t.sl;
    }
    const r = run(t, bars, sl);
    arms[`swing${n}`].push({ t, ...r });
    if (sl !== t.sl) changed[`swing${n}`].push({ t, plan: planR, alt: r, widenAtr: Math.abs(sl - t.sl) / a });
  }
}

const sumR = (xs) => xs.reduce((s, x) => s + x.r, 0);
const by = (xs, h) => xs.filter((x) => x.how === h).length;
console.log(`Trades since ${argv("--since", "2026-05-01")} with a plan and daily history: ${arms.plan.length}; horizon ${DAYS} sessions; buffer ${BUFFER} ATR, cap ${CAP} ATR\n`);
for (const [k, xs] of Object.entries(arms)) {
  console.log(`  ${k.padEnd(8)} ${sumR(xs).toFixed(1).padStart(7)}R  ${(sumR(xs) / xs.length).toFixed(3).padStart(7)}R/trade   target ${by(xs, "target")} · stop ${by(xs, "stop")} · open ${by(xs, "open")}`);
}
for (const k of ["swing5", "swing10"]) {
  const c = changed[k];
  const p = c.reduce((s, x) => s + x.plan.r, 0), q = c.reduce((s, x) => s + x.alt.r, 0);
  const saved = c.filter((x) => x.plan.how === "stop" && x.alt.how !== "stop").length;
  const lostTarget = c.filter((x) => x.plan.how === "target").length;
  console.log(`\n  ${k}: ${c.length} stops moved (median widen ${[...c.map((x) => x.widenAtr)].sort((a, b) => a - b)[Math.floor(c.length / 2)]?.toFixed(2)} ATR): plan ${p.toFixed(1)}R -> ${q.toFixed(1)}R (${(q - p >= 0 ? "+" : "")}${(q - p).toFixed(1)}R); stop-outs avoided ${saved}; targets that shrink in R ${lostTarget}`);
  for (const g of ["Prime", "Confirmed", "Speculative"]) {
    const s = c.filter((x) => x.t.setup_grade === g);
    if (s.length) console.log(`    ${g.padEnd(11)} n=${String(s.length).padStart(3)}  ${s.reduce((a, x) => a + x.plan.r, 0).toFixed(1)}R -> ${s.reduce((a, x) => a + x.alt.r, 0).toFixed(1)}R`);
  }
}
if (args.includes("--rows")) {
  for (const x of changed.swing5) {
    console.log(`  ${new Date(x.t.entry_ts).toISOString().slice(0, 10)} ${x.t.ticker.padEnd(5)} ${String(x.t.setup_grade || "").padEnd(11)} widen ${x.widenAtr.toFixed(2)} ATR  plan ${x.plan.r.toFixed(2)}R ${x.plan.how.padEnd(6)} -> ${x.alt.r.toFixed(2)}R ${x.alt.how}`);
  }
}
