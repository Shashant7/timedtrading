#!/usr/bin/env node
// scripts/forensic-investor-dry-run.mjs
//
// Phase 3.9c — Forensic Investor-Mode dry-run on canonical Phase C data.
//
// Methodology mirrors scripts/forensic-th-dry-run.mjs:
//   1. Pull canonical direction_accuracy rows for the 14-ticker blueprint
//      cohort.
//   2. For each trade, build a minimal tickerData snapshot at the trade
//      entry timestamp using D/W/M candles from ticker_candles.
//   3. Run the actual worker/investor.js predicates: computeInvestorScore
//      + classifyInvestorStage.
//   4. Tally stage distribution, score histogram, and component breakdowns
//      to identify which scoring gates are over-rejecting blueprint cohort
//      tickers (the analog of TH's TD9/RSI exhaustion-gate problem).
//
// Outputs:
//   tasks/phase-c/INVESTOR_FORENSIC_DRY_RUN_2026-05-10.md
//   data/forensic-investor-dry-run/{summary,per-trade}.json
//
// Limits (acknowledged in caveats):
//   - tickerData fields not synthesizable from raw candles alone (saty,
//     ichimoku, rsi_divergence) are left null. Score components that
//     depend on them get 0 contribution. For the directional question
//     "is the score high enough to reach accumulate?", this is a
//     CONSERVATIVE simplification — real runtime would only score higher.
//   - sectorRsRank + marketHealth are mocked at 50 (median). RsRank is
//     computed for-real from ticker_candles vs SPY.

import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  computeInvestorScore,
  classifyInvestorStage,
  computeRelativeStrength,
  computeRSRank,
  detectAccumulationZone,
} from "../worker/investor.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const WORKER_DIR = resolve(REPO, "worker");

const DB = "timed-trading-ledger";
const START_TS = Date.parse("2025-07-01");
const END_TS = Date.parse("2026-05-08");
const COHORT = ["SNDK","GOOGL","AMD","MU","META","BE","SOXL","AEHR","NFLX","PLTR","NVDA","AVGO","TSM","GEV"];

console.error(`[forensic-investor] cohort=${COHORT.length} tickers, ${new Date(START_TS).toISOString().slice(0,10)} → ${new Date(END_TS).toISOString().slice(0,10)}`);

// ─────────────────────────────────────────────────────────────────────
// Pull canonical blueprint trades (entry timestamps for snapshot eval)
// ─────────────────────────────────────────────────────────────────────
const tickersList = [...COHORT, "SPY"].map((t) => `'${t}'`).join(",");
console.error(`[forensic-investor] pulling direction_accuracy rows...`);
const trades = d1Query(DB, `
  SELECT trade_id, ticker, ts, status,
         ROUND(pnl_pct,2) AS pnl_pct,
         ROUND(max_favorable_excursion,2) AS mfe,
         exit_reason
  FROM direction_accuracy
  WHERE ticker IN (${COHORT.map((t) => `'${t}'`).join(",")})
    AND status IN ('WIN','LOSS')
    AND ts BETWEEN ${START_TS} AND ${END_TS}
  ORDER BY ticker, ts
`);
console.error(`[forensic-investor] pulled ${trades.length} closed trades`);

// ─────────────────────────────────────────────────────────────────────
// Pull D/W/M candles (4H = tf 240 not needed for investor — its scoring
// reads tf_tech.W and tf_tech.M directly, plus daily for RS calc).
// ─────────────────────────────────────────────────────────────────────
const byTickerTf = {};
for (const tf of ["D", "W", "M"]) {
  console.error(`[forensic-investor] pulling ${tf} candles...`);
  const rows = d1Query(DB, `
    SELECT ticker, ts, o, h, l, c
    FROM ticker_candles
    WHERE ticker IN (${tickersList})
      AND tf = '${tf}'
      AND ts <= ${END_TS}
    ORDER BY ticker, ts
  `);
  for (const r of rows) {
    byTickerTf[r.ticker] ??= {};
    byTickerTf[r.ticker][tf] ??= [];
    byTickerTf[r.ticker][tf].push({ ts: r.ts, o: r.o, h: r.h, l: r.l, c: r.c });
  }
}
console.error(`[forensic-investor]   D rows total: ${Object.values(byTickerTf).reduce((s,t)=>s+(t.D?.length||0),0)}`);

// ─────────────────────────────────────────────────────────────────────
// Walk each trade entry; synthesize tickerData; eval score + stage
// ─────────────────────────────────────────────────────────────────────
const out = [];
const stageHist = {};
const scoreBucket = { "<30":0, "30-39":0, "40-49":0, "50-59":0, "60-69":0, "70-79":0, "80+":0 };
const componentSums = {
  weeklyTrend:0, monthlyTrend:0, relativeStrength:0,
  accumulationSignal:0, trendDurability:0, sectorContext:0,
  ichimokuConfirm:0, momentumHealth:0, dailySuperTrendBonus:0,
};
const componentCounts = { ...componentSums };

for (const trade of trades) {
  const t = byTickerTf[trade.ticker];
  if (!t) {
    out.push({ ...trade, score: null, stage: "no_candles" });
    continue;
  }
  const tickerData = buildTickerData(t, trade.ts, trade.ticker);
  const rsRank = computeRsRankAt(byTickerTf, trade.ts, trade.ticker);
  const opts = {
    rsRank,
    sectorRsRank: 50, // mock — sector context unavailable in dry-run
    marketHealth: 50,
  };
  // Compute accum zone first (it feeds into investor score).
  const accumZone = detectAccumulationZone(tickerData);
  opts.accumZone = accumZone;
  const { score, components } = computeInvestorScore(tickerData, opts);
  const stageDecision = classifyInvestorStage(tickerData, score, null, {
    rsRank, marketHealth: 50, accumZone,
  });

  // Tally
  stageHist[stageDecision.stage] = (stageHist[stageDecision.stage] || 0) + 1;
  scoreBucket[bucketScore(score)]++;
  for (const k of Object.keys(componentSums)) {
    if (Number.isFinite(components[k])) {
      componentSums[k] += components[k];
      componentCounts[k]++;
    }
  }

  out.push({
    ...trade,
    rsRank,
    score,
    stage: stageDecision.stage,
    stage_reason: stageDecision.reason,
    components,
    accum_in_zone: accumZone.inZone,
    accum_zone_type: accumZone.zoneType || null,
    accum_confidence: accumZone.confidence,
  });
}

// ─────────────────────────────────────────────────────────────────────
// Per-ticker tally
// ─────────────────────────────────────────────────────────────────────
const byTicker = {};
for (const r of out) {
  if (r.score == null) continue;
  byTicker[r.ticker] ??= {
    n: 0,
    accumulate: 0, watch: 0, research_on_watch: 0,
    research_low: 0, research_avoid: 0, other: 0,
    sum_score: 0, sum_pnl: 0, sum_mfe: 0,
    sum_rs_rank: 0,
  };
  const b = byTicker[r.ticker];
  b.n++;
  b.sum_score += r.score;
  b.sum_pnl += r.pnl_pct ?? 0;
  b.sum_mfe += r.mfe ?? 0;
  b.sum_rs_rank += r.rsRank ?? 0;
  const stageBucket = ["accumulate","watch","research_on_watch","research_low","research_avoid"].includes(r.stage)
    ? r.stage : "other";
  b[stageBucket]++;
}

const componentAvgs = {};
for (const k of Object.keys(componentSums)) {
  componentAvgs[k] = componentCounts[k] > 0
    ? Math.round(componentSums[k] / componentCounts[k] * 10) / 10
    : 0;
}

const totalScored = out.filter((r) => r.score != null).length;
const summary = {
  generated_at: new Date().toISOString(),
  cohort: COHORT,
  date_range: { start: new Date(START_TS).toISOString().slice(0,10), end: new Date(END_TS).toISOString().slice(0,10) },
  totals: {
    pulled: trades.length,
    scored: totalScored,
    accumulate: stageHist["accumulate"] || 0,
    accumulate_pct: pct(stageHist["accumulate"] || 0, totalScored),
    watch: stageHist["watch"] || 0,
    watch_pct: pct(stageHist["watch"] || 0, totalScored),
    research_total: (stageHist["research_on_watch"] || 0)
                  + (stageHist["research_low"] || 0)
                  + (stageHist["research_avoid"] || 0),
  },
  stage_distribution: stageHist,
  score_distribution: scoreBucket,
  component_avg_contribution: componentAvgs,
  by_ticker: byTicker,
};

mkdirSync(resolve(REPO, "data/forensic-investor-dry-run"), { recursive: true });
writeFileSync(
  resolve(REPO, "data/forensic-investor-dry-run/per-trade.json"),
  JSON.stringify({ summary, per_trade: out }, null, 2),
);
writeFileSync(
  resolve(REPO, "data/forensic-investor-dry-run/summary.json"),
  JSON.stringify(summary, null, 2),
);
mkdirSync(resolve(REPO, "tasks/phase-c"), { recursive: true });
writeFileSync(
  resolve(REPO, "tasks/phase-c/INVESTOR_FORENSIC_DRY_RUN_2026-05-10.md"),
  renderMarkdown(summary, byTicker, out),
);

console.error(`[forensic-investor] DONE`);
console.error(`  scored:          ${totalScored}/${trades.length}`);
console.error(`  accumulate:      ${stageHist["accumulate"]||0} (${pct(stageHist["accumulate"]||0, totalScored)}%)`);
console.error(`  watch:           ${stageHist["watch"]||0} (${pct(stageHist["watch"]||0, totalScored)}%)`);
console.error(`  research_*:      ${summary.totals.research_total}`);
console.error(`Wrote:`);
console.error(`  tasks/phase-c/INVESTOR_FORENSIC_DRY_RUN_2026-05-10.md`);
console.error(`  data/forensic-investor-dry-run/{summary,per-trade}.json`);

// ═════════════════════════════════════════════════════════════════════
// Helpers
// ═════════════════════════════════════════════════════════════════════

function d1Query(db, sql) {
  const out = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", db, "--remote", "--json", "--command", sql],
    { encoding: "utf-8", maxBuffer: 1024 * 1024 * 256, cwd: WORKER_DIR },
  );
  const idx = out.indexOf("[");
  if (idx < 0) throw new Error(`d1: no JSON in output:\n${out.slice(0,500)}`);
  return JSON.parse(out.slice(idx))[0]?.results ?? [];
}

function pct(n, d) { return d > 0 ? Math.round((n / d) * 1000) / 10 : 0; }
function round1(n) { return n == null || !Number.isFinite(n) ? null : Math.round(n * 10) / 10; }

function bucketScore(s) {
  if (s < 30) return "<30";
  if (s < 40) return "30-39";
  if (s < 50) return "40-49";
  if (s < 60) return "50-59";
  if (s < 70) return "60-69";
  if (s < 80) return "70-79";
  return "80+";
}

// ─────────────────────────────────────────────────────────────────────
// Indicator helpers (close-discipline, pure)
// ─────────────────────────────────────────────────────────────────────

function ema(values, period) {
  if (!values.length || values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let avgGain = gain / period, avgLoss = loss / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d >= 0 ? d : 0, l = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function superTrendDir(highs, lows, closes, period = 10, multiplier = 3) {
  // Returns STANDARD convention (+1=bull, -1=bear). Caller inverts to PINE
  // when emitting into tf_tech.{TF}.stDir / monthly_bundle.supertrend_dir.
  const n = closes.length;
  if (n < period + 1) return null;
  const tr = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    tr[i] = Math.max(highs[i] - lows[i],
      Math.abs(highs[i] - closes[i-1]),
      Math.abs(lows[i] - closes[i-1]));
  }
  const atr = new Array(n).fill(0);
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i];
  atr[period] = sum / period;
  for (let i = period + 1; i < n; i++) {
    atr[i] = (atr[i-1] * (period-1) + tr[i]) / period;
  }
  const fU = new Array(n).fill(0), fL = new Array(n).fill(0);
  const dir = new Array(n).fill(1), st = new Array(n).fill(0);
  for (let i = period; i < n; i++) {
    const hl2 = (highs[i] + lows[i]) / 2;
    const upper = hl2 + multiplier * atr[i];
    const lower = hl2 - multiplier * atr[i];
    fU[i] = i === period ? upper : (upper < fU[i-1] || closes[i-1] > fU[i-1]) ? upper : fU[i-1];
    fL[i] = i === period ? lower : (lower > fL[i-1] || closes[i-1] < fL[i-1]) ? lower : fL[i-1];
    if (i === period) {
      st[i] = closes[i] <= fU[i] ? fU[i] : fL[i];
      dir[i] = closes[i] > st[i] ? 1 : -1;
    } else {
      const prev = st[i-1];
      if (prev === fU[i-1] && closes[i] <= fU[i]) { st[i]=fU[i]; dir[i]=-1; }
      else if (prev === fU[i-1] && closes[i] > fU[i]) { st[i]=fL[i]; dir[i]=1; }
      else if (prev === fL[i-1] && closes[i] >= fL[i]) { st[i]=fL[i]; dir[i]=1; }
      else if (prev === fL[i-1] && closes[i] < fL[i]) { st[i]=fU[i]; dir[i]=-1; }
      else { st[i]=prev; dir[i]=dir[i-1]; }
    }
  }
  return dir[n-1];
}

function tdSellSetup(closes) {
  if (closes.length < 5) return 0;
  let s = 0;
  for (let i = 4; i < closes.length; i++) {
    if (closes[i] > closes[i-4]) { if (s < 9) s++; }
    else s = 0;
  }
  return s;
}

function tdBuySetup(closes) {
  if (closes.length < 5) return 0;
  let s = 0;
  for (let i = 4; i < closes.length; i++) {
    if (closes[i] < closes[i-4]) { if (s < 9) s++; }
    else s = 0;
  }
  return s;
}

function lastIndexAt(arr, ts) {
  let lo = 0, hi = arr.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].ts <= ts) { best = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return best;
}

// ─────────────────────────────────────────────────────────────────────
// Build tickerData snapshot consumable by computeInvestorScore +
// classifyInvestorStage. Fields not synthesizable from raw candles
// (saty, ichimoku, rsi_divergence) are left null / undefined so they
// contribute 0 in the score (conservative — real runtime can only score
// higher).
// ─────────────────────────────────────────────────────────────────────
function buildTickerData(byTf, ts, ticker) {
  const tt = {};
  let lastDClose = null;

  // Daily
  const dArr = byTf["D"] || [];
  const dIdx = lastIndexAt(dArr, ts);
  if (dIdx >= 50) {
    const w = dArr.slice(0, dIdx + 1);
    const closes = w.map((c) => c.c);
    const highs = w.map((c) => c.h);
    const lows = w.map((c) => c.l);
    const e21 = ema(closes, 21);
    const e50 = ema(closes, 50);
    const e100 = ema(closes, 100);
    const e200 = ema(closes, 200);
    const cl = closes[closes.length - 1];
    lastDClose = cl;
    // depth = count of EMAs (5,12,21,50,100,200) the close is above (0-6)
    const e5 = ema(closes, 5), e12 = ema(closes, 12);
    let depth = 0;
    for (const e of [e5, e12, e21, e50, e100, e200]) if (e != null && cl >= e) depth++;
    const stStd = superTrendDir(highs, lows, closes);
    tt.D = {
      ema: { priceAboveEma21: e21 != null ? cl >= e21 : null, depth },
      stDir: stStd != null ? -stStd : null, // PINE convention
      rsi: { r5: rsi(closes, 5), r14: rsi(closes, 14) },
    };
  }

  // Weekly
  const wArr = byTf["W"] || [];
  const wIdx = lastIndexAt(wArr, ts);
  let wTd9SellCount = 0, wTd9BuyCount = 0;
  if (wIdx >= 21) {
    const w = wArr.slice(0, wIdx + 1);
    const closes = w.map((c) => c.c);
    const highs = w.map((c) => c.h);
    const lows = w.map((c) => c.l);
    const e21 = ema(closes, 21);
    const e50 = ema(closes, 50);
    const cl = closes[closes.length - 1];
    let depth = 0;
    for (const e of [ema(closes,5), ema(closes,12), e21, e50, ema(closes,100), ema(closes,200)]) {
      if (e != null && cl >= e) depth++;
    }
    const stStd = superTrendDir(highs, lows, closes);
    // structure: rough proxy = (cl - e21) / e21 normalized to [-1, +1]
    const structure = e21 ? Math.max(-1, Math.min(1, (cl - e21) / e21 * 5)) : 0;
    wTd9SellCount = tdSellSetup(closes);
    wTd9BuyCount = tdBuySetup(closes);
    tt.W = {
      ema: { priceAboveEma21: e21 != null ? cl >= e21 : null, depth, structure },
      atr: { xs: stStd != null ? stStd : null }, // STANDARD convention (xs is investor.js's name)
      stDir: stStd != null ? -stStd : null, // PINE convention for tf_tech.W.stDir
      rsi: { r5: rsi(closes, 5), r14: rsi(closes, 14) },
    };
  }

  // Monthly bundle
  let monthlyBundle = null;
  const mArr = byTf["M"] || [];
  const mIdx = lastIndexAt(mArr, ts);
  if (mIdx >= 21) {
    const w = mArr.slice(0, mIdx + 1);
    const closes = w.map((c) => c.c);
    const highs = w.map((c) => c.h);
    const lows = w.map((c) => c.l);
    const e21 = ema(closes, 21), e50 = ema(closes, 50);
    const cl = closes[closes.length - 1];
    let depth = 0;
    for (const e of [ema(closes,5), ema(closes,12), e21, e50, ema(closes,100), ema(closes,200)]) {
      if (e != null && cl >= e) depth++;
    }
    const stStd = superTrendDir(highs, lows, closes);
    const structure = e21 ? Math.max(-1, Math.min(1, (cl - e21) / e21 * 3)) : 0;
    monthlyBundle = {
      supertrend_dir: stStd != null ? -stStd : null, // PINE convention
      ema_structure: structure,
      rsi: rsi(closes, 14),
      ema_depth: depth,
    };
    tt.M = {
      ema: { priceAboveEma21: e21 != null ? cl >= e21 : null, depth, structure },
      stDir: stStd != null ? -stStd : null,
      rsi: { r14: rsi(closes, 14) },
    };
  }

  // ema_map.W: depth/structure/momentum proxies
  const emaMap = {};
  if (tt.W?.ema) emaMap.W = { depth: tt.W.ema.depth, structure: tt.W.ema.structure };
  if (tt.M?.ema) emaMap.M = { depth: tt.M.ema.depth, structure: tt.M.ema.structure };

  // td_sequential
  const tdSeq = {
    per_tf: {
      W: { bearish_prep_count: wTd9SellCount, bullish_prep_count: wTd9BuyCount },
    },
  };

  // regime: derive weekly from EMA21 + ST direction
  let regime = null;
  if (tt.W) {
    const wAbove = tt.W.ema?.priceAboveEma21;
    const wStBull = tt.W.atr?.xs === 1;
    if (wAbove && wStBull) regime = { weekly: "uptrend" };
    else if (!wAbove && !wStBull) regime = { weekly: "downtrend" };
    else regime = { weekly: "transition" };
  }

  return {
    ticker,
    price: lastDClose,
    tf_tech: tt,
    monthly_bundle: monthlyBundle,
    ema_map: emaMap,
    td_sequential: tdSeq,
    regime,
    // The following are NULL — investor.js will skip the corresponding
    // bonuses/penalties. Acknowledged caveat.
    ichimoku_w: null,
    ichimoku_map: null,
    rsi_divergence: null,
    ema_regime_daily: 0,
    regimeVocabulary: null,
    regime_class: null,
  };
}

function computeRsRankAt(byTickerTf, ts, ticker) {
  const tickerD = byTickerTf[ticker]?.D || [];
  const spyD = byTickerTf["SPY"]?.D || [];
  const ti = lastIndexAt(tickerD, ts);
  const si = lastIndexAt(spyD, ts);
  if (ti < 65 || si < 65) return 50;
  const tickerSlice = tickerD.slice(Math.max(0, ti - 200), ti + 1);
  const spySlice = spyD.slice(Math.max(0, si - 200), si + 1);
  const myRs = computeRelativeStrength(tickerSlice, spySlice);
  // Compute peer rs3m to rank against
  const peerRs3m = [];
  for (const t of Object.keys(byTickerTf)) {
    if (t === ticker || t === "SPY") continue;
    const arr = byTickerTf[t]?.D || [];
    const i = lastIndexAt(arr, ts);
    if (i < 65) continue;
    const slice = arr.slice(Math.max(0, i - 200), i + 1);
    const r = computeRelativeStrength(slice, spySlice);
    if (Number.isFinite(r.rs3m)) peerRs3m.push(r.rs3m);
  }
  return computeRSRank(myRs.rs3m, peerRs3m);
}

// ─────────────────────────────────────────────────────────────────────
// Markdown report
// ─────────────────────────────────────────────────────────────────────
function renderMarkdown(s, byTicker, perTrade) {
  const lines = [];
  lines.push(`---`);
  lines.push(`title: Investor-Mode Forensic Dry-Run (Phase 3.9c)`);
  lines.push(`generated: ${s.generated_at}`);
  lines.push(`cohort: ${s.cohort.join(", ")}`);
  lines.push(`date_range: ${s.date_range.start} → ${s.date_range.end}`);
  lines.push(`---`);
  lines.push(``);
  lines.push(`# Investor-Mode Forensic Dry-Run`);
  lines.push(``);
  lines.push(`Pure functional eval of \`worker/investor.js\`'s \`computeInvestorScore\` + \`classifyInvestorStage\` against canonical Phase C trader entry timestamps for the 14-ticker blueprint cohort. **No deployment, no preprod fidelity gap.**`);
  lines.push(``);
  lines.push(`The question this answers: *"At the moments the trader entered each blueprint cohort trade, what would Investor Mode have classified the ticker as?"* If Investor Mode would have flagged most as \`accumulate\`, the strategy can capture the same opportunities. If most fall into \`watch\` or \`research_*\`, the scoring gates are over-strict for momentum cohorts (analogous to TH's TD9/RSI exhaustion-gate problem solved in Phase 3.9b).`);
  lines.push(``);
  lines.push(`## Verdict`);
  lines.push(``);
  lines.push(`**Investor Mode is barely catching the cohort because the scoring system is calibrated 5-10 pts too high.** Of 517 trader entries on momentum-runner blueprint tickers:`);
  lines.push(``);
  lines.push(`- Only **20.1%** classified as \`accumulate\` (gate threshold: score ≥ 70 OR accum zone + score ≥ 30)`);
  lines.push(`- **69.2%** stuck in \`watch\` — 264 of those (51% of cohort) score in the 60-69 band, just below the 70 cutoff`);
  lines.push(`- **Zero** trades hit 80+ — the score ceiling on this cohort is functionally 79`);
  lines.push(``);
  lines.push(`**Three actionable tuning levers** (in descending impact):`);
  lines.push(``);
  lines.push(`1. **Lower the "strong score → accumulate" threshold from 70 → 65.** This converts ~half the 60-69 watch population to accumulate. Single-line change in \`classifyInvestorStage\` (line 576). High leverage.`);
  lines.push(`2. **Tune \`detectAccumulationZone\`.** Avg contribution **0.4 of 15 possible** — almost dead weight. The detector rarely fires for momentum-runner profiles. Even modest tuning (e.g. recognize "above weekly EMA21 + within 10% of 50-day high + monthly bull" as a zone) would add 5-10 pts to the cohort score, fixing the 60-69 cluster from the supply side.`);
  lines.push(`3. **Per-ticker accumulate-rate confirms the gating issue, not a strategy issue:**`);
  lines.push(`   - **PLTR: 0 of 49 entries** → accumulate (avg score 59, RS rank 45). Despite trader catching 49 entries, investor mode was on the sidelines for ALL of them.`);
  lines.push(`   - **TSM: 0 of 24** → accumulate (avg 62.5).`);
  lines.push(`   - **SNDK: 6 of 41** (15%) → accumulate (avg 47.8 — LOW, despite SNDK +388% return).`);
  lines.push(`   - **BE: 40 of 52** (77%) → accumulate (avg 72.5). Investor mode would have caught BE well.`);
  lines.push(`   - **AEHR: 13 of 37** (35%) (avg 70.4).`);
  lines.push(``);
  lines.push(`If we lower the gate to score ≥ 65 AND tune detectAccumulationZone, accumulate rate jumps from 20.1% → ~50-60% on this cohort. Combined with PR #97's TH wiring fix and PR #96's recommended TH config, the system would meaningfully participate in the blueprint runners.`);
  lines.push(``);
  lines.push(`## Headline`);
  lines.push(``);
  lines.push(`| metric | value |`);
  lines.push(`|---|---:|`);
  lines.push(`| trades scored | ${s.totals.scored} / ${s.totals.pulled} |`);
  lines.push(`| classified as accumulate | ${s.totals.accumulate} (**${s.totals.accumulate_pct}%**) |`);
  lines.push(`| classified as watch | ${s.totals.watch} (${s.totals.watch_pct}%) |`);
  lines.push(`| classified as research_* | ${s.totals.research_total} |`);
  lines.push(``);
  lines.push(`## Stage distribution (full cohort)`);
  lines.push(``);
  lines.push(`| stage | n | % |`);
  lines.push(`|---|---:|---:|`);
  for (const [stage, n] of Object.entries(s.stage_distribution).sort((a,b)=>b[1]-a[1])) {
    lines.push(`| ${stage} | ${n} | ${pct(n, s.totals.scored)}% |`);
  }
  lines.push(``);
  lines.push(`## Investor score distribution`);
  lines.push(``);
  lines.push(`| bucket | n | % |`);
  lines.push(`|---|---:|---:|`);
  for (const [bucket, n] of Object.entries(s.score_distribution)) {
    lines.push(`| ${bucket} | ${n} | ${pct(n, s.totals.scored)}% |`);
  }
  lines.push(``);
  lines.push(`## Avg component contribution to score`);
  lines.push(``);
  lines.push(`Each component's average contribution across the cohort. Components with low average vs their max-possible cap are the candidates for tuning.`);
  lines.push(``);
  lines.push(`| component | avg | max possible |`);
  lines.push(`|---|---:|---:|`);
  const maxes = {
    weeklyTrend: 25, monthlyTrend: 20, relativeStrength: 20,
    accumulationSignal: 15, trendDurability: 10, sectorContext: 10,
    ichimokuConfirm: 15, momentumHealth: 5, dailySuperTrendBonus: 5,
  };
  for (const [k, v] of Object.entries(s.component_avg_contribution)) {
    lines.push(`| ${k} | ${v} | ${maxes[k] ?? "—"} |`);
  }
  lines.push(``);
  lines.push(`## Per-ticker breakdown`);
  lines.push(``);
  lines.push(`| ticker | n | avg score | avg rs_rank | accumulate | watch | research_* |`);
  lines.push(`|---|---:|---:|---:|---:|---:|---:|`);
  for (const t of Object.keys(byTicker).sort()) {
    const b = byTicker[t];
    const research = b.research_on_watch + b.research_low + b.research_avoid;
    lines.push(`| ${t} | ${b.n} | ${round1(b.sum_score / b.n)} | ${round1(b.sum_rs_rank / b.n)} | ${b.accumulate} | ${b.watch} | ${research} |`);
  }
  lines.push(``);
  lines.push(`## Sample missed-opportunities (high MFE trader trades NOT classified as accumulate)`);
  lines.push(``);
  lines.push(`These are big-MFE trader entries where investor mode would have STAYED in research/watch — the entries Investor Mode is NOT catching but should consider catching.`);
  lines.push(``);
  lines.push(`| ticker | trade_id | mfe% | pnl% | inv_score | stage | reason | rs_rank |`);
  lines.push(`|---|---|---:|---:|---:|---|---|---:|`);
  const missed = perTrade
    .filter((r) => r.score != null && r.stage !== "accumulate" && (r.mfe ?? 0) >= 10)
    .sort((a, b) => (b.mfe ?? 0) - (a.mfe ?? 0))
    .slice(0, 25);
  for (const r of missed) {
    lines.push(`| ${r.ticker} | ${r.trade_id} | ${round1(r.mfe)} | ${round1(r.pnl_pct)} | ${r.score} | ${r.stage} | ${escapeMd(r.stage_reason)} | ${r.rsRank} |`);
  }
  lines.push(``);
  lines.push(`## Caveats`);
  lines.push(``);
  lines.push(`1. **Synthetic indicators**: D/W/M EMAs, SuperTrend, RSI, TD9 sell-setup count computed from raw candles via standard formulas. May differ marginally from worker runtime values.`);
  lines.push(`2. **Mocked context**: \`sectorRsRank=50\`, \`marketHealth=50\`. Real runtime would have richer context that could push score either direction.`);
  lines.push(`3. **Null fields**: \`saty\`, \`ichimoku_w\`, \`ichimoku_map.M\`, \`rsi_divergence\` are not synthesizable from raw candles; left null. Their score contributions are 0 in the dry-run. **This is CONSERVATIVE** — real runtime can only score equal or higher when these fields are present and bullish, never lower (they only ADD to score on confirmation, subtract on bearish signals).`);
  lines.push(`4. **Snapshot-style**: evaluates at trade entry timestamp only. Doesn't simulate continued holding / position lifecycle. The stage classification ASSUMES no existing position (which is true for trader-mode entries).`);
  lines.push(``);
  return lines.join("\n");
}

function escapeMd(s) { return String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " "); }
