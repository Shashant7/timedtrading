#!/usr/bin/env node
// scripts/chain-indicator-parity.js
// ─────────────────────────────────────────────────────────────────────────────
//  FOUNDATION Phase 2 — INDICATOR/SCORE PARITY from the chain.
//
//  The Phase 0 baseline localized live-vs-replay divergence to the score-
//  composition layer (htf_score/ltf_score/state). This harness proves the chain
//  reproduces those numbers: for each ticker it builds the per-TF indicator
//  bundles TWICE — once from the LEGACY per-TF D1 store, once from the CHAIN
//  (derived from one 5m base + the daily base via the foundation derive) — then
//  runs the IDENTICAL pure scorers (computeTfBundle → computeWeightedHTFScore /
//  computeWeightedLTFScore / classifyState), replicating assembleTickerData's
//  glue (daily anchors, leadingLtf, fixed isRTH). It diffs htf/ltf/state and key
//  per-TF indicator fields.
//
//  Read-only against pre-prod D1; no worker, no writes. Pure scorers run in node.
//
//  Usage:
//    CLOUDFLARE_API_TOKEN=... node scripts/chain-indicator-parity.js \
//      --tickers AA,AAPL,CLS,FSLR,GS,MU,NFLX,SNDK,TSLA,XLE \
//      --start 2026-06-01 --end 2026-06-12 \
//      [--db timed-trading-ledger-preprod] [--isRTH false] \
//      [--out data/parity/2026-06-chain-indicator-parity.json]
// ─────────────────────────────────────────────────────────────────────────────

import { execFileSync } from "child_process";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "fs";
import { dirname } from "path";
import {
  computeTfBundle, computeWeightedHTFScore, computeWeightedLTFScore, classifyState, deduplicateCandles,
} from "../worker/indicators.js";
import { getSeriesFromBases } from "../worker/foundation/chain-series-adapter.js";

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) { const k = argv[i].slice(2); const n = argv[i + 1]; if (n === undefined || n.startsWith("--")) o[k] = true; else { o[k] = n; i++; } }
  }
  return o;
}
const args = parseArgs(process.argv.slice(2));
const DB = args.db || "timed-trading-ledger-preprod";
const START = args.start || "2026-06-01";
const END = args.end || "2026-06-12";
const OUT = args.out || "data/parity/2026-06-chain-indicator-parity.json";
const IS_RTH = String(args.isRTH ?? "false") === "true"; // fixed for BOTH sides (fairness)
let tickersArg = args.tickers || "AA,AAPL,CLS,FSLR,GS,MU,NFLX,SNDK,TSLA,XLE";
if (typeof tickersArg === "string" && tickersArg.startsWith("@")) tickersArg = readFileSync(tickersArg.slice(1), "utf-8");
const TICKERS = String(tickersArg).split(/[\s,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);

const HTF_TFS = ["M", "W", "D", "240"];
const LTF_TFS = ["60", "30", "10", "15"];
const ALL_TFS = ["M", "W", "D", "240", "60", "30", "15", "10"];
const endMs = Date.UTC(...END.split("-").map((x, i) => (i === 1 ? +x - 1 : +x))) + 24 * 3600 * 1000;
const fiveStartMs = Date.UTC(...START.split("-").map((x, i) => (i === 1 ? +x - 1 : +x)));

function d1Query(sql) {
  const out = execFileSync("npx", ["wrangler", "d1", "execute", DB, "--remote", "--json", "--command", sql],
    { encoding: "utf-8", maxBuffer: 256 * 1024 * 1024, env: { ...process.env, CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN || process.env.CLOUDFLARE_TOKEN } });
  return (JSON.parse(out.slice(out.indexOf("[")))[0] || {}).results || [];
}
const mapRows = (rows) => rows.map((r) => ({ ts: Number(r.ts), o: +r.o, h: +r.h, l: +r.l, c: +r.c, v: +r.v }));

// Build the bundle map exactly like computeServerSideScores/assembleTickerData:
// dedup per TF, computeTfBundle when >= 50 bars (scoring threshold).
function bundlesFrom(candlesByTf) {
  const out = {};
  for (const tf of ALL_TFS) {
    const c = deduplicateCandles(candlesByTf[tf] || [], tf);
    out[tf] = c.length >= 50 ? computeTfBundle(c) : null;
  }
  return out;
}

// Replicate assembleTickerData's htf/ltf/state glue (lines 4421-4453).
function scoresFrom(bundles) {
  const bM = bundles.M, bW = bundles.W, bD = bundles.D, b4H = bundles["240"];
  const b1H = bundles["60"], b30 = bundles["30"], b15 = bundles["15"], b10 = bundles["10"];
  const leadingLtf = b10 ? "10" : b15 ? "15" : b30 ? "30" : "10";
  const bLead = leadingLtf === "30" ? b30 : leadingLtf === "15" ? b15 : b10;
  let anchors = null;
  if (bD && Number.isFinite(bD.atr14)) {
    const PCd = bD.px, ATRd = bD.atr14, m = 0.382;
    anchors = { PCd, ATRd, GGup: PCd + m * ATRd, GGdn: PCd - m * ATRd };
  }
  const htf = computeWeightedHTFScore(bM, bW, bD, b4H);
  const ltf = computeWeightedLTFScore(b1H, b30, bLead, anchors, IS_RTH);
  return { htf: Math.round(htf * 10) / 10, ltf: Math.round(ltf * 10) / 10, state: classifyState(htf, ltf), leadingLtf };
}

const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
function bundleFields(b) {
  if (!b) return null;
  return { px: r2(b.px), emaDepth: b.emaDepth, emaStructure: b.emaStructure, emaMomentum: b.emaMomentum, stDir: b.stDir, rsi: r2(b.rsi), atrRatio: r2(b.atrRatio), phaseZone: b.phaseZone };
}

(async () => {
  console.log(`[chain-indicator-parity] ${TICKERS.length} tickers ${START}..${END} isRTH=${IS_RTH}`);
  const report = { contract: "chain_indicator_parity_v1", generated_at: new Date().toISOString(), db: DB, window: { start: START, end: END }, isRTH: IS_RTH, per_ticker: {}, summary: {} };
  let htfMatch = 0, ltfMatch = 0, stateMatch = 0, n = 0;
  const tfFieldMatch = {}; for (const tf of ALL_TFS) tfFieldMatch[tf] = { both: 0, equal: 0 };

  for (const ticker of TICKERS) {
    let legacyByTf = {}, base5 = [], daily = [];
    try {
      // INTRADAY legacy bounded to the 5m-base window so the comparison is on
      // the SAME ts range as the chain (the chain's 5m base is only this window).
      // Deep history would mismatch windows, not derivation — see the result doc.
      const rowsI = d1Query(`SELECT tf,ts,o,h,l,c,v FROM ticker_candles WHERE ticker='${ticker}' AND tf IN ('240','60','30','15','10') AND ts>=${fiveStartMs} AND ts<=${endMs} ORDER BY tf,ts`);
      // HTF daily-derived legacy kept DEEP (M/W/D use the shared daily history).
      const rowsH = d1Query(`SELECT tf,ts,o,h,l,c,v FROM ticker_candles WHERE ticker='${ticker}' AND tf IN ('M','W','D') AND ts<=${endMs} ORDER BY tf,ts`);
      for (const r of [...rowsI, ...rowsH]) (legacyByTf[String(r.tf)] ||= []).push({ ts: Number(r.ts), o: +r.o, h: +r.h, l: +r.l, c: +r.c, v: +r.v });
      base5 = mapRows(d1Query(`SELECT ts,o,h,l,c,v FROM ticker_candles WHERE ticker='${ticker}' AND tf='5' AND ts<${endMs} ORDER BY ts`));
      daily = mapRows(d1Query(`SELECT ts,o,h,l,c,v FROM ticker_candles WHERE ticker='${ticker}' AND tf='D' ORDER BY ts`));
    } catch (e) { console.error(`  ${ticker}: D1 read failed ${String(e?.message || e).slice(0, 100)}`); continue; }

    // CHAIN side: derive every TF from one 5m base + the daily base.
    const getSeries = getSeriesFromBases({ base5m: base5, baseDaily: daily });
    const chainByTf = {};
    for (const tf of ALL_TFS) {
      const startMs = ["M", "W", "D"].includes(tf) ? (daily[0]?.ts ?? 0) : fiveStartMs;
      const view = await getSeries(ticker, tf, { startMs, endMs, asOf: endMs, source: "as_of" });
      chainByTf[tf] = view.bars;
    }

    const legBundles = bundlesFrom(legacyByTf);
    const chBundles = bundlesFrom(chainByTf);
    const legScore = scoresFrom(legBundles);
    const chScore = scoresFrom(chBundles);

    const perTf = {};
    for (const tf of ALL_TFS) {
      const lf = bundleFields(legBundles[tf]); const cf = bundleFields(chBundles[tf]);
      let equal = null;
      if (lf && cf) {
        tfFieldMatch[tf].both++;
        equal = lf.emaDepth === cf.emaDepth && lf.stDir === cf.stDir && lf.emaStructure === cf.emaStructure && lf.rsi === cf.rsi;
        if (equal) tfFieldMatch[tf].equal++;
      }
      perTf[tf] = { legacy: lf, chain: cf, equal, legacy_bars: (legacyByTf[tf] || []).length, chain_bars: (chainByTf[tf] || []).length };
    }

    const htfEq = legScore.htf === chScore.htf;
    const ltfEq = legScore.ltf === chScore.ltf;
    const stEq = legScore.state === chScore.state;
    n++; if (htfEq) htfMatch++; if (ltfEq) ltfMatch++; if (stEq) stateMatch++;
    report.per_ticker[ticker] = { legacy: legScore, chain: chScore, htf_equal: htfEq, ltf_equal: ltfEq, state_equal: stEq, per_tf: perTf };
    console.log(`  ${ticker.padEnd(6)} htf L${legScore.htf}/C${chScore.htf} ${htfEq ? "=" : "≠"} | ltf L${legScore.ltf}/C${chScore.ltf} ${ltfEq ? "=" : "≠"} | state ${stEq ? "=" : `${legScore.state}→${chScore.state}`}`);
  }

  report.summary = {
    tickers: n,
    htf_match: htfMatch, ltf_match: ltfMatch, state_match: stateMatch,
    htf_match_pct: n ? +(100 * htfMatch / n).toFixed(1) : null,
    ltf_match_pct: n ? +(100 * ltfMatch / n).toFixed(1) : null,
    state_match_pct: n ? +(100 * stateMatch / n).toFixed(1) : null,
    per_tf_field_match: Object.fromEntries(Object.entries(tfFieldMatch).map(([tf, v]) => [tf, `${v.equal}/${v.both}`])),
  };
  if (!existsSync(dirname(OUT))) mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(report, null, 2) + "\n");
  console.log(`\n[chain-indicator-parity] htf ${htfMatch}/${n} ltf ${ltfMatch}/${n} state ${stateMatch}/${n}`);
  console.log(`  per-TF bundle field match: ${JSON.stringify(report.summary.per_tf_field_match)}`);
  console.log(`[chain-indicator-parity] wrote ${OUT}`);
})();
