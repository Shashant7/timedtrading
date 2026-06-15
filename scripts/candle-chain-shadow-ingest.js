#!/usr/bin/env node
// scripts/candle-chain-shadow-ingest.js
// ─────────────────────────────────────────────────────────────────────────────
//  FOUNDATION Phase 1 → 2 — SHADOW INGEST + zero-gap coverage proof.
//
//  Runs the candle chain in SHADOW on pre-prod beside the current per-TF store:
//  reads the stored 5m + daily base from pre-prod D1 (read-only), feeds it into
//  the DORMANT per-shard Candle Chain Durable Object via the admin proxy
//  (`POST /timed/admin/candle-chain` action=ingest, gate:true), then asks the
//  chain's OWN coverage/integrity report (not an external guard) to prove zero
//  gaps over the window. Also runs the base-fidelity shadow gate.
//
//  The DO is dormant (no cron); this only populates it on demand. Nothing live
//  is touched: D1 reads are read-only and the DO is isolated pre-prod storage.
//
//  Usage:
//    TIMED_TRADING_API_KEY=... CLOUDFLARE_API_TOKEN=... \
//    node scripts/candle-chain-shadow-ingest.js \
//      --tickers AA,AAPL,CLS,FSLR,GS,MU,NFLX,SNDK,TSLA,XLE \
//      --start 2026-06-01 --end 2026-06-12 \
//      [--pre https://timed-trading-ingest-preprod.shashant.workers.dev] \
//      [--db timed-trading-ledger-preprod] \
//      [--out data/parity/2026-06-chain-shadow-coverage.json]
// ─────────────────────────────────────────────────────────────────────────────

import { execFileSync } from "child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname } from "path";
import { tradingDaysInRange, sessionBoundsUtc } from "../worker/foundation/trading-calendar.js";

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
const PRE = args.pre || process.env.PRE || "https://timed-trading-ingest-preprod.shashant.workers.dev";
const DB = args.db || "timed-trading-ledger-preprod";
const KEY = process.env.TIMED_TRADING_API_KEY;
const START = args.start || "2026-06-01";
const END = args.end || "2026-06-12";
const OUT = args.out || "data/parity/2026-06-chain-shadow-coverage.json";
if (!KEY) { console.error("ERROR: TIMED_TRADING_API_KEY required"); process.exit(1); }

let tickersArg = args.tickers || "AA,AAPL,CLS,FSLR,GS,MU,NFLX,SNDK,TSLA,XLE";
if (typeof tickersArg === "string" && tickersArg.startsWith("@")) tickersArg = readFileSync(tickersArg.slice(1), "utf-8");
const TICKERS = String(tickersArg).split(/[\s,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);

const startMs = Date.UTC(...START.split("-").map((x, i) => (i === 1 ? +x - 1 : +x)));
const endMs = Date.UTC(...END.split("-").map((x, i) => (i === 1 ? +x - 1 : +x))) + 24 * 3600 * 1000;
const days = tradingDaysInRange(START, END);

function d1Query(sql) {
  const out = execFileSync("npx", ["wrangler", "d1", "execute", DB, "--remote", "--json", "--command", sql],
    { encoding: "utf-8", maxBuffer: 128 * 1024 * 1024, env: { ...process.env, CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN || process.env.CLOUDFLARE_TOKEN } });
  const parsed = JSON.parse(out.slice(out.indexOf("[")));
  return (parsed[0] && parsed[0].results) || [];
}

async function proxy(body) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(`${PRE}/timed/admin/candle-chain?key=${KEY}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      return await r.json();
    } catch (e) {
      await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
    }
  }
  return { ok: false, error: "proxy_fetch_failed" };
}

function fetchBase(ticker) {
  const rows5 = d1Query(
    `SELECT ts,o,h,l,c,v FROM ticker_candles WHERE ticker='${ticker}' AND tf='5' AND ts>=${startMs} AND ts<${endMs} ORDER BY ts`);
  const rowsD = d1Query(
    `SELECT ts,o,h,l,c,v FROM ticker_candles WHERE ticker='${ticker}' AND tf='D' ORDER BY ts`);
  const map = (rows) => rows.map((r) => ({ ts: Number(r.ts), o: +r.o, h: +r.h, l: +r.l, c: +r.c, v: +r.v }));
  return { base5: map(rows5), daily: map(rowsD) };
}

(async () => {
  console.log(`[shadow-ingest] ${TICKERS.length} tickers, ${days.length} trading days ${START}..${END}`);
  const report = {
    contract: "chain_shadow_coverage_v1", generated_at: new Date().toISOString(),
    pre: PRE, db: DB, window: { start: START, end: END, trading_days: days.length },
    per_ticker: {},
    totals: { expected: 0, present: 0, gap_buckets: 0, complete_days: 0, day_count: 0, reconcile_ok: 0, fidelity_ok: 0 },
  };

  for (const ticker of TICKERS) {
    let base5, daily;
    try { ({ base5, daily } = fetchBase(ticker)); }
    catch (e) { console.error(`  ${ticker}: D1 read failed: ${String(e?.message || e).slice(0, 120)}`); continue; }

    // Feed the chain (with the base-fidelity shadow gate enabled).
    const di = await proxy({ action: "ingest", ticker, tf: "D", bars: daily, gate: false });
    const ri = await proxy({ action: "ingest", ticker, tf: "5", bars: base5, gate: true });

    // Ask the chain's OWN coverage report per trading day (RTH 5m grid).
    let expected = 0, present = 0, gapBuckets = 0, completeDays = 0;
    const dayGaps = [];
    for (const day of days) {
      const sb = sessionBoundsUtc(day);
      if (!sb) continue;
      const integ = await proxy({ action: "integrity", ticker, start: sb.openMs, end: sb.closeMs });
      const cov = integ.coverage || { expected: 0, present: 0, gaps: [] };
      expected += cov.expected || 0;
      present += cov.present || 0;
      const gb = (cov.gaps || []).reduce((s, _g) => s + 1, 0);
      gapBuckets += (cov.expected || 0) - (cov.present || 0);
      if (integ.complete) completeDays++;
      else dayGaps.push({ day, expected: cov.expected, present: cov.present, gaps: cov.gaps });
    }

    const reconcile = await proxy({ action: "reconcile-daily", ticker, start: startMs, end: endMs });
    const fidelity = (ri && ri.fidelity) || (await proxy({ action: "base-fidelity", ticker, start: startMs, end: endMs })).report;

    const tRep = {
      base5_ingested: ri.written || 0, daily_ingested: di.written || 0,
      expected, present, gap_buckets: expected - present,
      complete_days: completeDays, day_count: days.length,
      zero_gap: expected > 0 && present === expected,
      day_gaps: dayGaps.slice(0, 5),
      reconcile_ok: reconcile.ok === true,
      reconcile_mismatches: (reconcile.mismatches || []).slice(0, 5),
      fidelity_ok: fidelity ? fidelity.ok : null,
    };
    report.per_ticker[ticker] = tRep;
    report.totals.expected += expected;
    report.totals.present += present;
    report.totals.gap_buckets += (expected - present);
    report.totals.complete_days += completeDays;
    report.totals.day_count += days.length;
    if (tRep.reconcile_ok) report.totals.reconcile_ok++;
    if (tRep.fidelity_ok) report.totals.fidelity_ok++;
    console.log(`  ${ticker.padEnd(6)} 5m=${String(ri.written || 0).padStart(4)} D=${String(di.written || 0).padStart(3)} | cov ${present}/${expected} ${tRep.zero_gap ? "ZERO-GAP" : `GAPS(${expected - present})`} | days ${completeDays}/${days.length} | reconcile ${tRep.reconcile_ok ? "ok" : "FAIL"} | fidelity ${tRep.fidelity_ok}`);
  }

  const t = report.totals;
  report.summary = {
    coverage_pct: t.expected ? +(100 * t.present / t.expected).toFixed(2) : null,
    zero_gap_all: t.gap_buckets === 0 && t.expected > 0,
    complete_day_pct: t.day_count ? +(100 * t.complete_days / t.day_count).toFixed(2) : null,
    reconcile_ok_tickers: t.reconcile_ok,
    fidelity_ok_tickers: t.fidelity_ok,
    tickers: Object.keys(report.per_ticker).length,
  };
  if (!existsSync(dirname(OUT))) mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(report, null, 2) + "\n");
  console.log(`\n[shadow-ingest] coverage ${t.present}/${t.expected} (${report.summary.coverage_pct}%) ` +
    `zeroGapAll=${report.summary.zero_gap_all} completeDays=${t.complete_days}/${t.day_count} ` +
    `reconcileOk=${t.reconcile_ok}/${report.summary.tickers} fidelityOk=${t.fidelity_ok}/${report.summary.tickers}`);
  console.log(`[shadow-ingest] wrote ${OUT}`);
})();
