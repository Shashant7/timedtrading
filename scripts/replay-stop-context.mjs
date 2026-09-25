#!/usr/bin/env node
// scripts/replay-stop-context.mjs
//
// How does price behave at OUR stop level, and does the context at the touch
// say which touches recover? For every trade with a protective plan stop (the
// ENTRY event's sl_price, not the trailed positions.stop_loss), find the first
// 10m RTH bar after entry that trades through the stop (before the target was
// reached), and classify the context at that bar's CLOSE — the earliest a
// bar-close rule could act:
//
//   gap_through   first bar of the session opened beyond the stop
//   rel_vol       bar volume / the same RTH slot's mean over the prior 10 sessions
//   rsi10 / rsi60 RSI(14) on 10m (incl. this bar) and on closed hourly bars
//   ph10 / ph60   Saty phase (EMA3 of (close-EMA21)/(3 ATR14) x 100)
//   reclaim       the touch bar closed back on the protective side of the stop
//   wick          lower (long) / upper (short) wick as a share of the bar range
//
// Outcomes from the touch-bar close, within --days sessions:
//   recover   price regains ENTRY before trading 0.5R beyond the stop
//   fail      trades 0.5R beyond the stop first
//   exit_now  P&L exiting at the stop (at the open if it gapped through)
//   hold      P&L holding with a backstop 0.5R beyond the stop, exit at
//             target, else marked at the horizon close
// P&L in R (multiples of the trade's own entry-to-stop risk).
//
//   node scripts/replay-stop-context.mjs [--days 5] [--since 2026-05-01] [--open-only]

import { loadTradesWithPlan, candles, rthOnly, etClock, rsi, phase, atr, MS } from "./lib/trade-tape.mjs";

const atrOf = (bars) => atr(bars, 14).filter((v) => v != null).at(-1);

const args = process.argv.slice(2);
const argv = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const DAYS = Number(argv("--days", 5));
const SINCE = Date.parse(argv("--since", "2026-05-01"));
const OPEN_ONLY = args.includes("--open-only");
const BACKSTOP_R = 0.5;

const trades = loadTradesWithPlan({ sinceMs: SINCE }).filter((t) => t.sl && t.tp);

const sessionsAfter = (bars, i, n) => {
  const days = new Set();
  let last = i;
  for (let j = i; j < bars.length; j++) { days.add(etClock(bars[j].ts).date); if (days.size > n) break; last = j; }
  return last;
};

const rows = [];
const geo = [];
for (const t of trades) {
  {
    const d = candles(t.ticker, "D", t.entry_ts - 60 * MS.DAY, t.entry_ts - 1).filter((x) => x.ts < t.entry_ts - 6 * 3600e3);
    if (d.length >= 15) {
      const a = atrOf(d);
      const prior = d.slice(-5), prior10 = d.slice(-10);
      const swing = t.long ? Math.min(...prior.map((x) => x.l)) : Math.max(...prior.map((x) => x.h));
      const swing10 = t.long ? Math.min(...prior10.map((x) => x.l)) : Math.max(...prior10.map((x) => x.h));
      geo.push({
        trade_id: t.trade_id, ticker: t.ticker,
        stopAtr: Math.abs(t.entry - t.sl) / a,
        beyond5: t.long ? t.sl < swing : t.sl > swing,
        beyond10: t.long ? t.sl < swing10 : t.sl > swing10,
        gapToSwingAtr: (t.long ? swing - t.sl : t.sl - swing) / a,
      });
    }
  }
  const from = t.entry_ts - 12 * MS.DAY;
  const to = t.entry_ts + 30 * MS.DAY;
  const m10 = rthOnly(candles(t.ticker, "10", from, to));
  const h1 = rthOnly(candles(t.ticker, "60", t.entry_ts - 40 * MS.DAY, to));
  if (m10.length < 100) continue;
  const risk = Math.abs(t.entry - t.sl);
  const R = (px) => (t.long ? px - t.entry : t.entry - px) / risk;
  const beyond = (b) => (t.long ? b.l <= t.sl : b.h >= t.sl);
  const hitTp = (b) => (t.long ? b.h >= t.tp : b.l <= t.tp);

  const e0 = m10.findIndex((b) => b.ts > t.entry_ts);
  if (e0 < 0) continue;
  const endI = sessionsAfter(m10, e0, 15);
  let ti = -1;
  for (let j = e0 + 1; j <= endI; j++) {
    if (hitTp(m10[j])) break;
    if (beyond(m10[j])) { ti = j; break; }
  }
  if (ti < 0) continue;
  const b = m10[ti];
  if (OPEN_ONLY && b.ts >= t.exit_ts) continue;

  const ck = etClock(b.ts);
  const firstOfSession = ti === 0 || etClock(m10[ti - 1].ts).date !== ck.date;
  const prevClose = firstOfSession ? m10[ti - 1]?.c : null;
  const gapThrough = firstOfSession && (t.long ? b.o <= t.sl : b.o >= t.sl);
  const gapPct = prevClose ? ((b.o - prevClose) / prevClose) * 100 * (t.long ? 1 : -1) : 0;

  const slot = m10.filter((x, j) => j < ti && etClock(x.ts).rthMin === ck.rthMin).slice(-10);
  const relVol = slot.length >= 3 ? b.v / (slot.reduce((a, x) => a + x.v, 0) / slot.length || 1) : null;

  const upto10 = m10.slice(Math.max(0, ti - 200), ti + 1);
  const rsi10 = rsi(upto10.map((x) => x.c)).at(-1);
  const ph10 = phase(upto10).at(-1);
  const h1Closed = h1.filter((x) => x.ts + 3600e3 <= b.ts + 600e3);
  const rsi60 = h1Closed.length > 20 ? rsi(h1Closed.map((x) => x.c)).at(-1) : null;
  const ph60 = h1Closed.length > 30 ? phase(h1Closed).at(-1) : null;

  const reclaim = t.long ? b.c > t.sl : b.c < t.sl;
  const range = b.h - b.l || 1e-9;
  const wick = (t.long ? Math.min(b.o, b.c) - b.l : b.h - Math.max(b.o, b.c)) / range;

  const exitPx = gapThrough ? b.o : t.sl;
  const exitNow = R(exitPx);
  const backstop = t.long ? t.sl - BACKSTOP_R * risk : t.sl + BACKSTOP_R * risk;
  const hEnd = sessionsAfter(m10, ti, DAYS);
  let outcome = "neither", hold = null;
  let maeR = R(b.c);
  for (let j = ti + 1; j <= hEnd; j++) {
    const x = m10[j];
    maeR = Math.min(maeR, R(t.long ? x.l : x.h));
    const failed = t.long ? x.l <= backstop : x.h >= backstop;
    const recovered = t.long ? x.h >= t.entry : x.l <= t.entry;
    if (outcome === "neither") {
      if (failed) outcome = "fail";
      else if (recovered) outcome = "recover";
    }
    if (hold == null) {
      if (failed) { const gp = t.long ? x.o < backstop : x.o > backstop; hold = R(gp ? x.o : backstop); }
      else if (hitTp(x)) hold = R(t.tp);
    }
  }
  if (hold == null) hold = R(m10[hEnd].c);
  // Bar-close exit (a close-confirm rule): exit at this bar's close if it closed beyond the stop.
  const closeConfirm = reclaim ? null : R(b.c);

  const oversold = (rsi10 != null && (t.long ? rsi10 <= 30 : rsi10 >= 70))
    || (ph10 != null && (t.long ? ph10 <= -100 : ph10 >= 100));
  const htfStretched = ph60 != null && (t.long ? ph60 <= -61.8 : ph60 >= 61.8);
  const heavy = relVol != null && relVol >= 2;
  let ctx;
  if (gapThrough) ctx = "gap_through";
  else if (heavy && !reclaim) ctx = "volume_break";
  else if (reclaim && (oversold || htfStretched)) ctx = "exhausted_reclaim";
  else if (reclaim) ctx = "reclaim";
  else if (oversold || htfStretched) ctx = "exhausted_close_beyond";
  else ctx = "plain_close_beyond";

  rows.push({
    trade_id: t.trade_id,
    date: ck.date, rthMin: ck.rthMin, ticker: t.ticker, grade: t.setup_grade, setup: t.setup_name, dir: t.long ? "L" : "S",
    riskPct: (risk / t.entry) * 100, open: b.ts < t.exit_ts, exitReason: t.exit_reason,
    gapThrough, gapPct, relVol, rsi10, rsi60, ph10, ph60, reclaim, wick, ctx,
    exitNow, closeConfirm, hold, outcome, maeR,
  });
}

const f = (v, d = 2) => (v == null || !Number.isFinite(v) ? "  -  " : v.toFixed(d));
console.log(`Trades since ${argv("--since", "2026-05-01")} with a plan: ${trades.length}; touched the plan stop before target: ${rows.length}${OPEN_ONLY ? " (still open at the touch)" : ""}`);
console.log(`Backstop ${BACKSTOP_R}R beyond the stop, horizon ${DAYS} sessions. R = trade's own entry-to-stop risk.\n`);

function summarize(label, sub) {
  if (!sub.length) return;
  const sum = (k) => sub.reduce((a, x) => a + (x[k] ?? 0), 0);
  const rec = sub.filter((x) => x.outcome === "recover").length;
  const fail = sub.filter((x) => x.outcome === "fail").length;
  const cc = sub.map((x) => (x.closeConfirm == null ? x.hold : x.closeConfirm));
  console.log(`  ${label.padEnd(24)} n=${String(sub.length).padStart(3)}  recover ${String(rec).padStart(2)} (${((rec / sub.length) * 100).toFixed(0).padStart(3)}%)  fail ${String(fail).padStart(2)}  `
    + `exit_now ${f(sum("exitNow") / sub.length)}R  hold ${f(sum("hold") / sub.length)}R  close_confirm ${f(cc.reduce((a, v) => a + v, 0) / sub.length)}R  (per touch)`);
}
console.log("By context at the touch:");
for (const c of ["gap_through", "volume_break", "plain_close_beyond", "exhausted_close_beyond", "reclaim", "exhausted_reclaim"]) summarize(c, rows.filter((x) => x.ctx === c));
summarize("ALL", rows);
console.log("\nBy single feature:");
summarize("opening bar (first 30m)", rows.filter((x) => x.rthMin < 30));
summarize("later in session", rows.filter((x) => x.rthMin >= 30));
summarize("rsi10 oversold", rows.filter((x) => x.rsi10 != null && (x.dir === "L" ? x.rsi10 <= 30 : x.rsi10 >= 70)));
summarize("rsi10 not oversold", rows.filter((x) => x.rsi10 != null && !(x.dir === "L" ? x.rsi10 <= 30 : x.rsi10 >= 70)));
summarize("ph60 stretched (-61.8)", rows.filter((x) => x.ph60 != null && (x.dir === "L" ? x.ph60 <= -61.8 : x.ph60 >= 61.8)));
summarize("ph60 not stretched", rows.filter((x) => x.ph60 != null && !(x.dir === "L" ? x.ph60 <= -61.8 : x.ph60 >= 61.8)));
summarize("rel_vol >= 2", rows.filter((x) => x.relVol != null && x.relVol >= 2));
summarize("rel_vol < 1.2", rows.filter((x) => x.relVol != null && x.relVol < 1.2));
summarize("reclaim (closed back)", rows.filter((x) => x.reclaim));
summarize("closed beyond", rows.filter((x) => !x.reclaim));
summarize("wick >= 0.5", rows.filter((x) => x.wick >= 0.5));
summarize("stop < 2% away", rows.filter((x) => x.riskPct < 2));
summarize("stop >= 4% away", rows.filter((x) => x.riskPct >= 4));
for (const g of ["Prime", "Confirmed", "Speculative"]) summarize(`grade ${g}`, rows.filter((x) => x.grade === g));

console.log("\nStop placement (all trades with daily history): touched = traded through the plan stop before target within 15 sessions");
const touchedBy = new Map(rows.map((x) => [x.trade_id, x]));
function geoLine(label, sub) {
  if (!sub.length) return;
  const touched = sub.filter((g) => touchedBy.has(g.trade_id));
  const rec = touched.filter((g) => touchedBy.get(g.trade_id).outcome === "recover").length;
  console.log(`  ${label.padEnd(30)} n=${String(sub.length).padStart(3)}  touched ${String(touched.length).padStart(3)} (${((touched.length / sub.length) * 100).toFixed(0).padStart(3)}%)  recovered after touch ${rec}`);
}
geoLine("stop < 1.0 daily ATR", geo.filter((g) => g.stopAtr < 1));
geoLine("stop 1.0-1.5 daily ATR", geo.filter((g) => g.stopAtr >= 1 && g.stopAtr < 1.5));
geoLine("stop 1.5-2.5 daily ATR", geo.filter((g) => g.stopAtr >= 1.5 && g.stopAtr < 2.5));
geoLine("stop >= 2.5 daily ATR", geo.filter((g) => g.stopAtr >= 2.5));
geoLine("stop beyond 5-day swing", geo.filter((g) => g.beyond5));
geoLine("stop inside 5-day swing", geo.filter((g) => !g.beyond5));
geoLine("stop beyond 10-day swing", geo.filter((g) => g.beyond10));
geoLine("stop inside 10-day swing", geo.filter((g) => !g.beyond10));
geoLine("stop within 0.25 ATR past swing", geo.filter((g) => g.beyond5 && g.gapToSwingAtr < 0.25));
const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
console.log(`  median stop distance ${med(geo.map((g) => g.stopAtr)).toFixed(2)} daily ATR; inside the 5-day swing ${geo.filter((g) => !g.beyond5).length}/${geo.length}`);

if (args.includes("--rows")) {
  console.log("\nPer touch:");
  for (const x of rows) {
    console.log(`  ${x.date} +${String(x.rthMin).padStart(3)}m ${x.ticker.padEnd(5)} ${x.dir} ${String(x.grade || "").padEnd(11)} risk ${f(x.riskPct, 1)}% ${x.ctx.padEnd(22)} gap ${f(x.gapPct, 1)}% vol ${f(x.relVol, 1)} rsi10 ${f(x.rsi10, 0)} rsi60 ${f(x.rsi60, 0)} ph10 ${f(x.ph10, 0)} ph60 ${f(x.ph60, 0)} wick ${f(x.wick, 2)}  `
      + `exit ${f(x.exitNow)}R hold ${f(x.hold)}R mae ${f(x.maeR)}R ${x.outcome}`);
  }
}
