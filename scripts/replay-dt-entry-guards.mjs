#!/usr/bin/env node
// scripts/replay-dt-entry-guards.mjs
//
// Index day-trade entries vs the tape at the moment of the BUY. For every BUY
// in KV `timed:opt-dt-actions`, rebuild the 5m session so far from production
// D1 and measure what the reversal / location guards in
// worker/option-execution-clock.js would have seen:
//
//   off_extreme_atr   distance from the session low (puts) / high (calls), in
//                     day-ATR — a put 0.1 ATR off the low is selling the hole
//   held_bars         bars since that extreme printed (>= 2 = it is holding)
//   rsi / rsi_prev    RSI(14) on 5m — turning up from < 35 (puts) / down from
//                     > 65 (calls)
//
// and the round's premium result (half at the trim if one printed), plus the
// day lean at the BUY with and without the OR-break buffer
// (OR_BREAK_BUFFER_ATR in worker/day-trade-game-plan.js).
//
// Findings 2026-09-25 (37 BUYs, 9/23-9/25): neither tape guard is worth
// shipping — "not within 0.25 ATR of the extreme" blocks 23 rounds worth
// +56% (the 9/23 trend-day puts at the lows won 79-100%), and the reversal
// signature blocks 2 rounds (-11%) and misses 9/25's puts. The OR buffer
// flips only 9/25's SPY/QQQ puts to NEUTRAL (breaks of 0.07 / 0.06 ATR).
//
// Dump the actions first:
//   wrangler kv key get --binding=KV_TIMED --remote timed:opt-dt-actions > /tmp/dtactions.json
//   node scripts/replay-dt-entry-guards.mjs [--actions /tmp/dtactions.json]

import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { nyParts } from "../worker/option-execution-clock.js";
import { computeDayLean, computeOvernightRangeFromM5, computeOpeningRangeFromM5 } from "../worker/day-trade-game-plan.js";

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const round2 = (v) => (num(v) == null ? null : Math.round(v * 100) / 100);

function wilderRsi(closes, n = 14) {
  const out = new Array(closes.length).fill(null);
  let up = 0, dn = 0;
  for (let i = 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const u = Math.max(ch, 0), d = Math.max(-ch, 0);
    if (i <= n) {
      up += u / n; dn += d / n;
      if (i === n) out[i] = dn === 0 ? 100 : 100 - 100 / (1 + up / dn);
      continue;
    }
    up = (up * (n - 1) + u) / n;
    dn = (dn * (n - 1) + d) / n;
    out[i] = dn === 0 ? 100 : 100 - 100 / (1 + up / dn);
  }
  return out;
}

/**
 * Today's cash session so far from 5m bars: extremes, how many bars each has
 * held, and RSI(14) now vs one bar ago. The bars before the open warm RSI.
 */
function sessionTapeFromM5(candles, { now = Date.now() } = {}) {
  if (!Array.isArray(candles) || candles.length < 16) return null;
  const today = nyParts(now).ymd;
  const rsi = wilderRsi(candles.map((c) => Number(c.c)));
  let lo = Infinity, loI = -1, hi = -Infinity, hiI = -1, n = 0;
  for (let i = 0; i < candles.length; i++) {
    const p = nyParts(Number(candles[i].ts ?? candles[i].t));
    if (p.ymd !== today || p.minutes < 9 * 60 + 30 || p.minutes >= 16 * 60) continue;
    n++;
    if (Number(candles[i].l) < lo) { lo = Number(candles[i].l); loI = i; }
    if (Number(candles[i].h) > hi) { hi = Number(candles[i].h); hiI = i; }
  }
  if (!n) return null;
  const last = candles.length - 1;
  return {
    low: lo,
    high: hi,
    bars_since_low: last - loI,
    bars_since_high: last - hiI,
    rsi: rsi[last] != null ? round2(rsi[last]) : null,
    rsi_prev: rsi[last - 1] != null ? round2(rsi[last - 1]) : null,
    session_bars: n,
  };
}

/** Pullback entries must retrace at least this much of a day ATR off the extreme. */
const DT_PULLBACK_MIN_ATR = 0.25;

/**
 * Is the tape reversing against a new ticket?
 *
 * reversal: the session extreme has held for 2+ bars while 5m RSI turns
 *   back from oversold (puts: from < 35 and rising) / overbought (calls).
 *   SPY 763P / QQQ 737P 2026-09-25 were bought on exactly that bounce.
 * location: a pullback-style entry still within DT_PULLBACK_MIN_ATR of the
 *   extreme is buying the hole, not a pullback (0.12 / 0.15 ATR that day).
 *   Breakout entries (trigger pierce) are not held to it.
 */
function dtEntryGuard({ isPut, spot, tape, dayAtr, pullbackMode = true } = {}) {
  const px = num(spot);
  const atr = num(dayAtr);
  if (!tape || px == null) return { reversal: false, location: false };
  const held = isPut ? tape.bars_since_low : tape.bars_since_high;
  const r = num(tape.rsi), rp = num(tape.rsi_prev);
  const turning = r != null && rp != null && (isPut ? (rp < 35 && r > rp) : (rp > 65 && r < rp));
  const reversal = held >= 2 && turning;
  const off = isPut ? px - tape.low : tape.high - px;
  const location = !!pullbackMode && atr > 0 && Number.isFinite(off) && off / atr < DT_PULLBACK_MIN_ATR;
  return { reversal, location, off_extreme_atr: atr > 0 ? round2(off / atr) : null, held_bars: held };
}

function d1(sql) {
  const raw = execFileSync("../node_modules/.bin/wrangler", [
    "d1", "execute", "timed-trading-ledger", "--remote", "--json", "--command", sql,
  ], { cwd: new URL("../worker/", import.meta.url).pathname, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  return JSON.parse(raw.slice(raw.indexOf("[")))[0].results;
}

function atr(bars, n = 14) {
  const out = new Array(bars.length).fill(null);
  let a = null;
  for (let i = 1; i < bars.length; i++) {
    const tr = Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c));
    a = a == null ? tr : (a * (n - 1) + tr) / n;
    if (i >= n) out[i] = a;
  }
  return out;
}

const args = process.argv.slice(2);
const argv = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const actions = JSON.parse(fs.readFileSync(argv("--actions", "/tmp/dtactions.json"), "utf8")).sort((a, b) => a.ts - b.ts);

const rounds = [];
const open = new Map();
for (const a of actions) {
  const id = a.signal_id;
  if (a.event === "BUY") { const r = { id, buy: a, trims: [], exit: null }; open.set(id, r); rounds.push(r); continue; }
  const r = open.get(id);
  if (!r) continue;
  if (a.event === "TRIM") r.trims.push(a);
  else if (a.event === "STOP" || a.event === "EXIT") { r.exit = a; open.delete(id); }
}

const cache = new Map();
function bars(ticker, tf, from, to) {
  const k = `${ticker}:${tf}:${from}:${to}`;
  if (!cache.has(k)) {
    cache.set(k, d1(`SELECT ts, o, h, l, c, v FROM ticker_candles WHERE ticker='${ticker}' AND tf='${tf}' AND ts >= ${from} AND ts <= ${to} ORDER BY ts`)
      .map((b) => ({ ts: +b.ts, o: +b.o, h: +b.h, l: +b.l, c: +b.c, v: +b.v || 0 })));
  }
  return cache.get(k);
}

console.log("date   time  ticker flav  prem  result  | off_ext_atr held rsi_prev->rsi | reversal location | OR break (ATR, + = through) / lean now / lean with 0.1 ATR OR buffer");
let sum = { all: 0, n: 0, blockedR: 0, blockedN: 0, blockedL: 0, blockedLN: 0 };
for (const r of rounds) {
  const [, ticker, , , right] = r.id.split(":");
  const isPut = right === "P";
  const t = r.buy.ts;
  const day = new Date(t).toISOString().slice(0, 10);
  // The bar containing the BUY is stored with its FINAL close — use only the
  // bars completed by then, and that bar's open as the spot (<= 5 min old).
  const all5 = bars(ticker, "5", t - 3 * 86400000, t).filter((b) => b.ts <= t);
  const m5 = all5.filter((b) => b.ts + 5 * 60000 <= t);
  const forming = all5.find((b) => b.ts + 5 * 60000 > t);
  const d = bars(ticker, "D", t - 40 * 86400000, t - 6 * 3600e3);
  const dayAtr = atr(d, 14).filter((v) => v != null).at(-1);
  const tape = sessionTapeFromM5(m5, { now: t });
  const px = forming?.o ?? m5.at(-1)?.c;
  const g = dtEntryGuard({ isPut, spot: px, tape, dayAtr, pullbackMode: true });
  const exitPx = r.exit?.premium;
  let pnl = null;
  if (exitPx != null) {
    pnl = r.trims.length
      ? 0.5 * (r.trims[0].premium - r.buy.premium) + 0.5 * (exitPx - r.buy.premium)
      : exitPx - r.buy.premium;
    pnl = (pnl / r.buy.premium) * 100;
  }
  // The day lean as the clock saw it, and with the OR-break buffer.
  const dPrior = d.filter((x) => new Date(x.ts).toISOString().slice(0, 10) < day);
  const prevClose = dPrior.at(-1)?.c;
  const closes = dPrior.map((x) => x.c);
  const sma5 = closes.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const trendBias = Math.max(-1, Math.min(1, ((closes.at(-1) - sma5) / sma5) / 0.01));
  const ov = computeOvernightRangeFromM5(m5, new Date(t));
  const orng = computeOpeningRangeFromM5(m5, new Date(t));
  const leanArgs = { curPrice: px, anchor: prevClose, dayAtr, overnightRange: ov, openingRange: orng, trendBias, researchBias: 0.3 };
  const leanNow = computeDayLean({ ...leanArgs, orBreakBufferAtr: 0 });
  const leanBuf = computeDayLean(leanArgs);
  const orBreak = orng?.resolved ? (isPut ? (orng.low - px) : (px - orng.high)) / dayAtr : null;
  r.lean = { now: `${leanNow.lean}/${leanNow.conviction}`, buf: `${leanBuf.lean}/${leanBuf.conviction}`, orBreak };

  // Thesis exit variants — only for a round the lean opened (lean side ==
  // flavor). Walk completed 5m closes to the real exit; a variant fires on
  // the first close that is red vs the entry spot (underlying proxy) AND its
  // condition holds. Priced from the first option mark at/after the trigger.
  //   A lean left the entry side, or price closed back inside a broken OR level
  //   B reclaim of the broken OR level only
  //   C lean flipped to the opposite side, or reclaim
  //   D lean off the entry side for 2 consecutive closes, or reclaim
  const side = isPut ? "SHORT" : "LONG";
  const opp = isPut ? "LONG" : "SHORT";
  r.variants = {};
  if (leanNow.lean === side) {
    const brokeLevel = orng?.resolved ? (isPut ? (px < orng.low ? orng.low : null) : (px > orng.high ? orng.high : null)) : null;
    const endTs = r.exit?.ts ?? t + 6 * 3600e3;
    const after = bars(ticker, "5", t, endTs + 300000).filter((b) => b.ts >= t && b.ts + 300000 <= endTs);
    let offRun = 0;
    for (const b of after) {
      const upto = bars(ticker, "5", t - 3 * 86400000, b.ts + 1).filter((x) => x.ts <= b.ts);
      const l = computeDayLean({ ...leanArgs, curPrice: b.c, openingRange: computeOpeningRangeFromM5(upto, new Date(b.ts + 300000)) });
      const red = isPut ? b.c > px : b.c < px;
      const reclaimed = brokeLevel != null && (isPut ? b.c > brokeLevel : b.c < brokeLevel);
      offRun = l.lean !== side ? offRun + 1 : 0;
      const at = b.ts + 300000;
      if (!red) continue;
      if (!r.variants.A && (l.lean !== side || reclaimed)) r.variants.A = at;
      if (!r.variants.B && reclaimed) r.variants.B = at;
      if (!r.variants.C && (l.lean === opp || reclaimed)) r.variants.C = at;
      if (!r.variants.D && (offRun >= 2 || reclaimed)) r.variants.D = at;
    }
    const marks = d1(`SELECT ts, mid FROM option_marks WHERE signal_id='${r.id}' AND ts >= ${t} ORDER BY ts`).map((m) => ({ ts: +m.ts, mid: +m.mid }));
    for (const k of Object.keys(r.variants)) {
      const at = r.variants[k];
      const m = marks.find((x) => x.ts >= at && x.mid > 0);
      if (!m || (r.exit && m.ts >= r.exit.ts)) { r.variants[k] = { at, pnl: null }; continue; }
      const trimBefore = r.trims.find((x) => x.ts < m.ts);
      const pnl = trimBefore
        ? 0.5 * (trimBefore.premium - r.buy.premium) + 0.5 * (m.mid - r.buy.premium)
        : m.mid - r.buy.premium;
      r.variants[k] = { at, pnl: (pnl / r.buy.premium) * 100, mid: m.mid };
    }
  }
  const et = new Date(t).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false });
  const off = tape ? (isPut ? px - tape.low : tape.high - px) / dayAtr : null;
  const held = tape ? (isPut ? tape.bars_since_low : tape.bars_since_high) : null;
  console.log(`${day.slice(5)} ${et} ${ticker.padEnd(4)} ${isPut ? "put " : "call"} ${String(r.buy.premium).padStart(5)} ${pnl == null ? "  open " : `${pnl.toFixed(0).padStart(5)}%`} | ${off == null ? " -  " : off.toFixed(2).padStart(5)} ${String(held ?? "-").padStart(4)} ${tape?.rsi_prev?.toFixed(0) ?? "-"}->${tape?.rsi?.toFixed(0) ?? "-"} | ${g.reversal ? "BLOCK" : "  -  "}    ${g.location ? "BLOCK" : "  -  "} | OR break ${r.lean.orBreak == null ? "  -  " : r.lean.orBreak.toFixed(2).padStart(5)} lean ${r.lean.now.padEnd(14)} buffered ${r.lean.buf.padEnd(14)} | ${["A", "B", "C", "D"].map((k) => { const v = r.variants[k]; if (!v) return `${k} -`; const hm = new Date(v.at).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }); return `${k} ${hm} ${v.pnl == null ? "nomark" : `${v.pnl.toFixed(0)}%`}`; }).join("  ")}`);
  r.pnl = pnl;
  if (pnl != null) {
    sum.all += pnl; sum.n++;
    if (g.reversal) { sum.blockedR += pnl; sum.blockedN++; }
    if (g.reversal || g.location) { sum.blockedL += pnl; sum.blockedLN++; }
  }
}
console.log(`\nclosed rounds ${sum.n}: total ${sum.all.toFixed(0)}% of premium`);
console.log(`reversal guard blocks ${sum.blockedN} rounds worth ${sum.blockedR.toFixed(0)}%`);
console.log(`reversal + location (pullback modes) blocks ${sum.blockedLN} rounds worth ${sum.blockedL.toFixed(0)}%`);
for (const k of ["A", "B", "C", "D"]) {
  let n = 0, actual = 0, alt = 0;
  for (const r of rounds) {
    const v = r.variants?.[k];
    if (!v || v.pnl == null || r.pnl == null) continue;
    n++; actual += r.pnl; alt += v.pnl;
  }
  console.log(`thesis exit ${k}: fires on ${n} priced closed rounds: actual ${actual.toFixed(0)}% -> ${alt.toFixed(0)}% (${(alt - actual >= 0 ? "+" : "")}${(alt - actual).toFixed(0)} pts)`);
}
