// scripts/lib/trade-tape.mjs
//
// Shared loader for Short Term counterfactuals that need the trade's ORIGINAL
// plan (stop / target from the ENTRY event — `positions.stop_loss` is the
// trailed stop) and the intraday tape around it. Reads production D1 through
// wrangler; candles are cached under /tmp so reruns are cheap.

import { execFileSync } from "node:child_process";
import fs from "node:fs";

const WORKER_DIR = new URL("../../worker/", import.meta.url).pathname;
const CACHE_DIR = "/tmp/trade-tape-cache";

export function d1(sql) {
  const raw = execFileSync("../node_modules/.bin/wrangler", [
    "d1", "execute", "timed-trading-ledger", "--remote", "--json", "--command", sql,
  ], { cwd: WORKER_DIR, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  return JSON.parse(raw.slice(raw.indexOf("[")))[0].results;
}

/** Closed trades with the plan they were entered on, plus their TRIM events. */
export function loadTradesWithPlan({ sinceMs }) {
  const rows = d1(`
    SELECT t.trade_id, t.ticker, t.direction, t.entry_ts, t.entry_price, t.exit_ts, t.exit_price,
           t.exit_reason, t.pnl, t.pnl_pct, t.setup_name, t.setup_grade, t.trimmed_pct,
           t.max_favorable_excursion mfe, e.meta_json
      FROM trades t JOIN trade_events e ON e.trade_id = t.trade_id AND e.type = 'ENTRY'
     WHERE t.exit_ts IS NOT NULL AND t.entry_ts >= ${Number(sinceMs)}
     ORDER BY t.entry_ts`);
  const trims = d1(`
    SELECT e.trade_id, e.ts, e.price, e.qty_pct_delta, e.qty_pct_total
      FROM trade_events e JOIN trades t ON t.trade_id = e.trade_id
     WHERE e.type = 'TRIM' AND t.entry_ts >= ${Number(sinceMs)} ORDER BY e.ts`);
  const trimsBy = new Map();
  for (const x of trims) {
    if (!trimsBy.has(x.trade_id)) trimsBy.set(x.trade_id, []);
    trimsBy.get(x.trade_id).push({ ts: Number(x.ts), price: Number(x.price), total: Number(x.qty_pct_total) });
  }
  const out = [];
  for (const r of rows) {
    let meta = {};
    try { meta = JSON.parse(r.meta_json || "{}"); } catch { /* keep empty */ }
    const long = String(r.direction).toUpperCase() !== "SHORT";
    const entry = Number(r.entry_price);
    const sl = Number(meta.sl_price);
    const tp = Number(meta.tp_price);
    const protective = sl > 0 && (long ? sl < entry : sl > entry);
    out.push({
      ...r, long, entry, sl: protective ? sl : null, tp: tp > 0 ? tp : null,
      entry_ts: Number(r.entry_ts), exit_ts: Number(r.exit_ts),
      trims: trimsBy.get(r.trade_id) || [],
    });
  }
  return out;
}

/** Candles for one ticker/tf in [fromMs, toMs], cached per request. */
export function candles(ticker, tf, fromMs, toMs) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const f = `${CACHE_DIR}/${ticker}-${tf}-${fromMs}-${toMs}.json`;
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8"));
  const rows = d1(`SELECT ts, o, h, l, c, v FROM ticker_candles
    WHERE ticker = '${ticker.replace(/'/g, "''")}' AND tf = '${tf}' AND ts >= ${fromMs} AND ts <= ${toMs} ORDER BY ts`)
    .map((b) => ({ ts: Number(b.ts), o: Number(b.o), h: Number(b.h), l: Number(b.l), c: Number(b.c), v: Number(b.v) || 0 }));
  fs.writeFileSync(f, JSON.stringify(rows));
  return rows;
}

const DAY = 24 * 3600 * 1000;

/** ET session date (YYYY-MM-DD) and minutes since 09:30 ET for a bar timestamp. */
export function etClock(ts) {
  const d = new Date(ts);
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
  const hh = Number(p.hour) % 24;
  return { date: `${p.year}-${p.month}-${p.day}`, rthMin: hh * 60 + Number(p.minute) - 570 };
}

/** Regular-session bars only. */
export function rthOnly(bars) {
  return bars.filter((b) => { const m = etClock(b.ts).rthMin; return m >= 0 && m < 390; });
}

export function ema(values, n) {
  const k = 2 / (n + 1);
  const out = [];
  let e = null;
  for (const v of values) { e = e == null ? v : v * k + e * (1 - k); out.push(e); }
  return out;
}

/** Wilder RSI. */
export function rsi(closes, n = 14) {
  const out = new Array(closes.length).fill(null);
  let up = 0, dn = 0;
  for (let i = 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const u = Math.max(ch, 0), d = Math.max(-ch, 0);
    if (i <= n) { up += u / n; dn += d / n; if (i === n) out[i] = dn === 0 ? 100 : 100 - 100 / (1 + up / dn); continue; }
    up = (up * (n - 1) + u) / n; dn = (dn * (n - 1) + d) / n;
    out[i] = dn === 0 ? 100 : 100 - 100 / (1 + up / dn);
  }
  return out;
}

/** Wilder ATR. */
export function atr(bars, n = 14) {
  const out = new Array(bars.length).fill(null);
  let a = null;
  for (let i = 1; i < bars.length; i++) {
    const tr = Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c));
    a = a == null ? tr : (a * (n - 1) + tr) / n;
    if (i >= n) out[i] = a;
  }
  return out;
}

/**
 * Saty-style phase oscillator: EMA3 of (close - EMA21) / (3 x ATR14) x 100.
 * +/-100 is the "extended" band, +/-61.8 "distribution / accumulation".
 */
export function phase(bars) {
  const closes = bars.map((b) => b.c);
  const e21 = ema(closes, 21);
  const a14 = atr(bars, 14);
  const raw = bars.map((b, i) => (a14[i] ? ((b.c - e21[i]) / (3 * a14[i])) * 100 : 0));
  return ema(raw, 3);
}

export const MS = { DAY };
