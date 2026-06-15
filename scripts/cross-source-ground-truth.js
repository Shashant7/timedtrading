#!/usr/bin/env node
// scripts/cross-source-ground-truth.js
// ─────────────────────────────────────────────────────────────────────────────
//  FOUNDATION Phase 1 — cross-source candle GROUND TRUTH (TwelveData vs Alpaca
//  vs web). Immutable historical OHLC should agree across independent providers;
//  where >= quorum sources agree (within tol) on H/L/C, that is ground truth and
//  any disagreeing source is an outlier to re-fetch / audit.
//
//  This is the operator runner for the cross-provider check in
//  tasks/2026-06-15-candle-ground-truth-findings.md. It is a thin shell around
//  the PURE consensus core in worker/foundation/reconcile.js
//  (`crossSourceConsensus`) — the math is unit-tested there; this just plumbs
//  two independent provider fetches in per (ticker, day) and writes a report.
//
//  SOURCES (independent, read-only — NOTHING is written to D1/KV):
//    • TwelveData — direct https://api.twelvedata.com/time_series
//      (env TWELVE_DATA_API_KEY | TWELVEDATA_API_KEY). Daily `datetime` is the
//      trading date directly; 5m datetime is ET session time.
//    • Alpaca — via the pre-prod READ-ONLY proxy
//      GET /timed/admin/alpaca-bars-readonly (the worker holds the Alpaca
//      secret; the proxy fetches and returns bars without persisting). Daily
//      bars are stamped at 00:00 ET → mapped to their ET date.
//    • Web/exa — NOT automated here: the WebSearch tool is the human/agent
//      auditor for a random sample and any TD-vs-Alpaca disagreement. This
//      script flags exactly those (ticker, day) cases for web audit.
//
//  USAGE:
//    TIMED_TRADING_API_KEY=... TWELVE_DATA_API_KEY=... \
//    node scripts/cross-source-ground-truth.js \
//      --basket data/parity/2026-06-12-basket.txt \
//      --start  2026-06-01 --end 2026-06-12 \
//      --tf D \
//      [--pre https://timed-trading-ingest-preprod.shashant.workers.dev] \
//      [--priceTol 0.02] [--limit 45] \
//      [--out data/parity/2026-06-cross-source.json]
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname } from "path";
import { crossSourceConsensus } from "../worker/foundation/reconcile.js";

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) {
    const key = a.slice(2);
    const next = process.argv[i + 1];
    if (next && !next.startsWith("--")) { args[key] = next; i++; }
    else args[key] = true;
  }
}

const PRE = args.pre || process.env.PRE || "https://timed-trading-ingest-preprod.shashant.workers.dev";
const ADMIN_KEY = process.env.TIMED_TRADING_API_KEY;
const TD_KEY = process.env.TWELVE_DATA_API_KEY || process.env.TWELVEDATA_API_KEY;
const TF = String(args.tf || "D");
const START = args.start || "2026-06-01";
const END = args.end || "2026-06-12";
const PRICE_TOL = Number(args.priceTol ?? 0.02);
const OUT = args.out || `data/parity/${START.slice(0, 7)}-cross-source.json`;
const LIMIT = args.limit ? Number(args.limit) : 0;

if (!ADMIN_KEY) { console.error("ERROR: TIMED_TRADING_API_KEY required (for Alpaca read-only proxy)"); process.exit(1); }
if (!TD_KEY) { console.error("ERROR: TWELVE_DATA_API_KEY required (TwelveData time_series)"); process.exit(1); }

const basketPath = args.basket || "data/parity/2026-06-12-basket.txt";
let basket = readFileSync(basketPath, "utf8").trim().split(/[\s,]+/).map((t) => t.trim().toUpperCase()).filter(Boolean);
if (LIMIT > 0) basket = basket.slice(0, LIMIT);

// Crypto/ETF symbols whose daily roll-up / session differs; skip from the
// equity ground-truth sweep (24/7 markets, no shared session-anchored truth).
const SKIP = new Set(["BTCUSD", "ETHUSD"]);

const TD_INTERVAL = { D: "1day", W: "1week", M: "1month", "5": "5min", "10": "10min", "30": "30min", "60": "1h", "240": "4h" };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const INTRADAY = !["D", "W", "M"].includes(TF);

// Map a daily bar timestamp (ms) to its US/Eastern trading date (YYYY-MM-DD).
function etDate(ms) {
  // en-CA gives ISO-like YYYY-MM-DD
  return new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

// Minutes that ET is ahead of UTC at instant `ms` (negative; -240 in EDT).
function etOffsetMinutes(ms) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const m = {};
  for (const p of dtf.formatToParts(new Date(ms))) m[p.type] = p.value;
  const asUTC = Date.UTC(+m.year, +m.month - 1, +m.day, +m.hour, +m.minute, +m.second);
  return (asUTC - ms) / 60000;
}

// Convert a TwelveData intraday datetime "YYYY-MM-DD HH:MM:SS" (exchange/ET time)
// to epoch ms. Safe away from DST switch hours (our windows are mid-month).
function etWallToEpoch(dt) {
  const [datePart, timePart = "00:00:00"] = String(dt).split(" ");
  const [Y, M, D] = datePart.split("-").map(Number);
  const [h, mi, s] = timePart.split(":").map(Number);
  const guess = Date.UTC(Y, M - 1, D, h, mi, s || 0);
  const off = etOffsetMinutes(guess);
  return guess - off * 60000;
}

// TwelveData's time_series end_date is EXCLUSIVE (a request 06-01..06-03 returns
// only 06-01 and 06-02). Bump it by one calendar day so the window is inclusive
// of END and aligns with Alpaca's inclusive range.
function nextDay(dateStr) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** TwelveData direct fetch → { [tradingDate]: {o,h,l,c,v} }. */
async function fetchTD(ticker) {
  const interval = TD_INTERVAL[TF] || "1day";
  const tdEnd = nextDay(END);
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(ticker)}` +
    `&interval=${interval}&start_date=${START}&end_date=${tdEnd}&outputsize=5000&apikey=${TD_KEY}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(url);
      const j = await r.json();
      if (j.status === "error") {
        // rate-limit → backoff; other errors → empty
        if (/run out of API credits|rate limit/i.test(j.message || "")) { await sleep(2000 * (attempt + 1)); continue; }
        return { error: j.message || "td_error", byDate: {} };
      }
      const byDate = {};
      for (const v of j.values || []) {
        // daily: datetime is "YYYY-MM-DD" → key by trading date.
        // intraday: "YYYY-MM-DD HH:MM:SS" (ET) → key by epoch ms (instant).
        const key = INTRADAY ? String(etWallToEpoch(v.datetime)) : String(v.datetime).slice(0, 10);
        byDate[key] = { o: +v.open, h: +v.high, l: +v.low, c: +v.close, v: +v.volume || 0 };
      }
      return { byDate };
    } catch (e) {
      await sleep(1500 * (attempt + 1));
    }
  }
  return { error: "td_fetch_failed", byDate: {} };
}

/** Alpaca via pre-prod read-only proxy → { [tradingDate]: {o,h,l,c,v} }. */
async function fetchAlpaca(ticker) {
  const url = `${PRE}/timed/admin/alpaca-bars-readonly?ticker=${encodeURIComponent(ticker)}` +
    `&tf=${encodeURIComponent(TF)}&startDate=${START}&endDate=${END}&key=${ADMIN_KEY}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(url, { method: "GET" });
      const j = await r.json();
      if (!j.ok) return { error: j.error || "alpaca_error", byDate: {} };
      const byDate = {};
      for (const b of j.bars || []) {
        const key = INTRADAY ? String(Number(b.ts)) : etDate(Number(b.ts));
        byDate[key] = { o: +b.o, h: +b.h, l: +b.l, c: +b.c, v: +b.v || 0 };
      }
      return { byDate };
    } catch (e) {
      await sleep(1500 * (attempt + 1));
    }
  }
  return { error: "alpaca_fetch_failed", byDate: {} };
}

(async () => {
  console.log(`[cross-source] basket=${basket.length} tf=${TF} ${START}..${END} priceTol=${PRICE_TOL}`);
  const perTicker = {};
  const disagreements = [];   // (ticker,day) where TD vs Alpaca differ on H/L/C → web audit
  const missing = [];         // present in one source only
  let cases = 0, agreed = 0;
  const volRatios = [];

  for (const ticker of basket) {
    if (SKIP.has(ticker)) { perTicker[ticker] = { skipped: "crypto" }; continue; }
    const [td, al] = await Promise.all([fetchTD(ticker), fetchAlpaca(ticker)]);
    const days = new Set([...Object.keys(td.byDate), ...Object.keys(al.byDate)]);
    const tk = { days: 0, agreed: 0, td_only: 0, alpaca_only: 0, disagree: 0, td_error: td.error || null, alpaca_error: al.error || null };
    for (const day of [...days].sort()) {
      const tdBar = td.byDate[day];
      const alBar = al.byDate[day];
      if (!tdBar || !alBar) {
        tk[tdBar ? "td_only" : "alpaca_only"]++;
        missing.push({ ticker, day, present: tdBar ? "td" : "alpaca" });
        continue;
      }
      tk.days++;
      cases++;
      const sources = { td: tdBar, alpaca: alBar };
      const con = crossSourceConsensus(sources, { fields: ["h", "l", "c"], priceTol: PRICE_TOL, quorum: 2 });
      // volume ratio (informational — auction/consolidation differences)
      const vr = tdBar.v > 0 ? alBar.v / tdBar.v : null;
      if (vr != null && Number.isFinite(vr)) volRatios.push(vr);
      if (con.agreed) { agreed++; tk.agreed++; }
      else {
        tk.disagree++;
        disagreements.push({
          ticker, day,
          td: { h: tdBar.h, l: tdBar.l, c: tdBar.c },
          alpaca: { h: alBar.h, l: alBar.l, c: alBar.c },
          field_agreement: con.field_agreement,
          delta: { h: +(tdBar.h - alBar.h).toFixed(4), l: +(tdBar.l - alBar.l).toFixed(4), c: +(tdBar.c - alBar.c).toFixed(4) },
        });
      }
    }
    perTicker[ticker] = tk;
    process.stdout.write(`  ${ticker}: ${tk.agreed}/${tk.days} agree` +
      (tk.disagree ? ` (${tk.disagree} disagree)` : "") +
      (tk.td_only || tk.alpaca_only ? ` [td_only ${tk.td_only}, alpaca_only ${tk.alpaca_only}]` : "") +
      (tk.td_error || tk.alpaca_error ? ` ERR td=${tk.td_error} al=${tk.alpaca_error}` : "") + "\n");
    await sleep(250); // gentle on TD rate limit
  }

  volRatios.sort((a, b) => a - b);
  const vMed = volRatios.length ? volRatios[Math.floor(volRatios.length / 2)] : null;
  const report = {
    generated_at: new Date().toISOString(),
    params: { tf: TF, start: START, end: END, priceTol: PRICE_TOL, basket: basket.length },
    summary: {
      cases,
      agreed,
      agreement_pct: cases ? +(100 * agreed / cases).toFixed(2) : null,
      disagreements: disagreements.length,
      missing_one_source: missing.length,
      volume_ratio_median_alpaca_over_td: vMed != null ? +vMed.toFixed(4) : null,
    },
    disagreements,
    missing,
    perTicker,
  };
  if (!existsSync(dirname(OUT))) mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(`\n[cross-source] cases=${cases} agreed=${agreed} (${report.summary.agreement_pct}%) ` +
    `disagree=${disagreements.length} missing=${missing.length} volRatioMed(alpaca/td)=${report.summary.volume_ratio_median_alpaca_over_td}`);
  console.log(`[cross-source] wrote ${OUT}`);
  if (disagreements.length) {
    console.log(`\nDisagreements (web-audit these):`);
    for (const d of disagreements.slice(0, 30)) {
      console.log(`  ${d.ticker} ${d.day}: TD H/L/C ${d.td.h}/${d.td.l}/${d.td.c} vs Alpaca ${d.alpaca.h}/${d.alpaca.l}/${d.alpaca.c} Δ ${JSON.stringify(d.delta)}`);
    }
  }
})();
