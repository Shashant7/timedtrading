#!/usr/bin/env node
// scripts/candle-chain-shadow-reconcile.js
// ─────────────────────────────────────────────────────────────────────────────
//  FOUNDATION Phase 1b — SHADOW RECONCILER (read-only).
//
//  Validates the rebuild's core thesis on REAL data: does deriving every
//  timeframe from ONE 5m base (worker/foundation/resample.js) reproduce the
//  provider's separately-fetched higher-TF bars that the system stores today?
//
//  It reads candles directly from the PRE-PROD D1 (read-only `wrangler d1
//  execute --remote`), resamples the stored 5m base to 10/15/30/60/240 (both
//  session- and clock-anchored, so we learn the provider's bucketing), and
//  diffs against the stored higher-TF bars. NO writes anywhere; live untouched.
//
//  Usage:
//    CLOUDFLARE_API_TOKEN=... node scripts/candle-chain-shadow-reconcile.js \
//      --tickers AAPL,MU,GS --start 2026-06-01 --end 2026-06-12 \
//      [--db timed-trading-ledger-preprod] [--out data/parity/shadow-reconcile.json]
//    # --tickers @data/parity/2026-06-12-basket.txt  reads a CSV file
// ─────────────────────────────────────────────────────────────────────────────

import { execFileSync } from "child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname } from "path";
import { resampleIntradaySessions, resampleAligned } from "../worker/foundation/resample.js";

const TARGET_TFS = [10, 15, 30, 60, 240];
const PRICE_TOL = 0.011;     // stored as 2dp REAL
const VOL_TOL_FRAC = 0.005;  // 0.5% volume tolerance

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const k = argv[i].slice(2); const n = argv[i + 1];
      if (n === undefined || n.startsWith("--")) o[k] = true; else { o[k] = n; i++; }
    }
  }
  return o;
}
const args = parseArgs(process.argv.slice(2));
const DB = args.db || "timed-trading-ledger-preprod";
const START = args.start || "2026-06-01";
const END = args.end || "2026-06-12";
const OUT = args.out || "data/parity/shadow-reconcile.json";
let tickersArg = args.tickers || "AAPL";
if (typeof tickersArg === "string" && tickersArg.startsWith("@")) {
  tickersArg = readFileSync(tickersArg.slice(1), "utf-8");
}
const TICKERS = String(tickersArg).split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
const startMs = Date.UTC(...START.split("-").map((x, i) => (i === 1 ? +x - 1 : +x)));
const endMs = Date.UTC(...END.split("-").map((x, i) => (i === 1 ? +x - 1 : +x))) + 24 * 3600 * 1000;

function d1Query(sql) {
  const out = execFileSync("npx", ["wrangler", "d1", "execute", DB, "--remote", "--json", "--command", sql],
    { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN || process.env.CLOUDFLARE_TOKEN } });
  // wrangler --json prints a JSON array of statement results; tolerate leading noise.
  const jStart = out.indexOf("[");
  const parsed = JSON.parse(out.slice(jStart));
  return (parsed[0] && parsed[0].results) || [];
}

function fetchCandles(ticker) {
  const rows = d1Query(
    `SELECT tf, ts, o, h, l, c, v FROM ticker_candles WHERE ticker='${ticker}' ` +
    `AND tf IN ('5','10','15','30','60','240') AND ts>=${startMs} AND ts<${endMs} ORDER BY tf, ts`);
  const byTf = {};
  for (const r of rows) {
    const tf = String(r.tf);
    (byTf[tf] ||= []).push({ ts: Number(r.ts), o: +r.o, h: +r.h, l: +r.l, c: +r.c, v: +r.v });
  }
  return byTf;
}

function ohlcMatch(a, b) {
  if (!a || !b) return false;
  const p = (x, y) => Math.abs(x - y) <= PRICE_TOL;
  const vol = Math.abs(a.v - b.v) <= Math.max(1, VOL_TOL_FRAC * Math.max(a.v, b.v));
  return p(a.o, b.o) && p(a.h, b.h) && p(a.l, b.l) && p(a.c, b.c) && vol;
}

function diff(derived, stored) {
  const sMap = new Map(stored.map((b) => [b.ts, b]));
  const dMap = new Map(derived.map((b) => [b.ts, b]));
  let tsMatched = 0, ohlcMatched = 0, ohlcMismatch = 0;
  const samples = [];
  for (const d of derived) {
    const s = sMap.get(d.ts);
    if (!s) continue;
    tsMatched++;
    if (ohlcMatch(d, s)) ohlcMatched++;
    else { ohlcMismatch++; if (samples.length < 3) samples.push({ ts: d.ts, derived: d, stored: s }); }
  }
  return {
    stored: stored.length, derived: derived.length,
    ts_matched: tsMatched,
    only_derived: derived.filter((d) => !sMap.has(d.ts)).length,
    only_stored: stored.filter((s) => !dMap.has(s.ts)).length,
    ohlc_matched: ohlcMatched, ohlc_mismatch: ohlcMismatch,
    samples,
  };
}

const report = { contract: "shadow_reconcile_v1", db: DB, window: { start: START, end: END }, generated_at: new Date().toISOString(), per_ticker: {}, totals: {} };
const totals = {};
for (const tf of TARGET_TFS) totals[tf] = { session: { ts_matched: 0, ohlc_matched: 0, ohlc_mismatch: 0, only_derived: 0, only_stored: 0 }, clock: { ts_matched: 0, ohlc_matched: 0, ohlc_mismatch: 0, only_derived: 0, only_stored: 0 } };

for (const ticker of TICKERS) {
  let byTf;
  try { byTf = fetchCandles(ticker); }
  catch (e) { console.error(`  ${ticker}: d1 query failed: ${String(e?.message || e).slice(0, 120)}`); continue; }
  const base5 = byTf["5"] || [];
  const tRep = { base5: base5.length };
  for (const tf of TARGET_TFS) {
    const stored = byTf[String(tf)] || [];
    const session = diff(resampleIntradaySessions(base5, tf), stored);
    const clock = diff(resampleAligned(base5, tf, 0), stored);
    tRep[tf] = { session, clock };
    for (const mode of ["session", "clock"]) {
      const s = tf && tRep[tf][mode];
      for (const k of ["ts_matched", "ohlc_matched", "ohlc_mismatch", "only_derived", "only_stored"]) totals[tf][mode][k] += s[k];
    }
  }
  report.per_ticker[ticker] = tRep;
  const s30 = tRep[30].session;
  console.log(`  ${ticker.padEnd(6)} base5=${String(base5.length).padStart(4)} | 30m session ts=${s30.ts_matched} ohlc✓=${s30.ohlc_matched} ✗=${s30.ohlc_mismatch} (stored ${s30.stored})`);
}
report.totals = totals;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(report, null, 2) + "\n");

console.log("\n=== AGGREGATE: derived-from-5m vs stored higher-TF ===");
console.log("tf   | mode    | ts_matched | ohlc✓ | ohlc✗ | only_derived | only_stored | ohlc match%");
for (const tf of TARGET_TFS) {
  for (const mode of ["session", "clock"]) {
    const t = totals[tf][mode];
    const pct = t.ts_matched ? (100 * t.ohlc_matched / t.ts_matched).toFixed(1) : "—";
    console.log(`${String(tf).padEnd(4)} | ${mode.padEnd(7)} | ${String(t.ts_matched).padStart(10)} | ${String(t.ohlc_matched).padStart(5)} | ${String(t.ohlc_mismatch).padStart(5)} | ${String(t.only_derived).padStart(12)} | ${String(t.only_stored).padStart(11)} | ${pct}%`);
  }
}
console.log(`\nreport: ${OUT}`);
