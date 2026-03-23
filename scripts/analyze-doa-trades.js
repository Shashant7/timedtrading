#!/usr/bin/env node
/**
 * DOA (Dead On Arrival) Trade Analysis
 *
 * Processes trade-autopsy-trades.json from multiple backtest artifacts,
 * identifies trades with negligible MFE (never moved favorably),
 * compares feature distributions between DOA and winning trades,
 * and evaluates candidate entry-gate filters with false-positive analysis.
 *
 * Output: data/doa-analysis-report.json
 */

const fs = require("fs");
const path = require("path");

const ARTIFACT_DIR = path.join(__dirname, "..", "data", "backtest-artifacts");
const OUTPUT_PATH = path.join(__dirname, "..", "data", "doa-analysis-report.json");

const BACKTESTS = [
  "calibrated-v5--20260315-213634",
  "clean-launch-v1--20260315-101522",
  "exit-upgrade-v3--20260315-094435",
  "liq-sweep-tuned-v1--20260317-191052",
  "sizing-fix-v1--20260314-123742",
];

const MFE_THRESHOLD = 0.5;

const REGIME_WINDOWS = [
  { name: "Bullish (Jul-Sep 2025)", start: "2025-07-01", end: "2025-09-30" },
  { name: "Transition (Oct-Nov 2025)", start: "2025-10-01", end: "2025-11-30" },
  { name: "Bearish (Dec 2025-Jan 2026)", start: "2025-12-01", end: "2026-01-31" },
  { name: "Choppy (Feb-Mar 2026)", start: "2026-02-01", end: "2026-03-16" },
];

function tsToDate(ts) {
  if (!ts) return null;
  const ms = Number(ts) < 1e12 ? Number(ts) * 1000 : Number(ts);
  return new Date(ms).toISOString().slice(0, 10);
}

function getRegimeWindow(ts) {
  const d = tsToDate(ts);
  if (!d) return "unknown";
  for (const w of REGIME_WINDOWS) {
    if (d >= w.start && d <= w.end) return w.name;
  }
  return "unknown";
}

function isDOA(trade) {
  return (
    trade.status === "LOSS" &&
    (trade.max_favorable_excursion == null || trade.max_favorable_excursion < MFE_THRESHOLD)
  );
}

function parseLineage(trade) {
  if (!trade.signal_snapshot_json) return {};
  try {
    const s = typeof trade.signal_snapshot_json === "string"
      ? JSON.parse(trade.signal_snapshot_json) : trade.signal_snapshot_json;
    return s?.lineage || {};
  } catch { return {}; }
}

function extractFeatures(trade) {
  const ln = parseLineage(trade);
  const dangerFlags = ln.danger_flags || [];
  const dangerScore = Number(ln.danger_score) || 0;
  const ep = ln.execution_profile || {};
  const mi = ln.market_internals || {};
  const st = ln.supertrend || {};
  const clouds = ln.ripster_clouds || {};
  const squeeze = mi.squeeze || {};
  const phase = ln.saty_phase || {};
  const liq = ln.liq || {};
  const emaDepth = ln.ema_depth || {};

  const stD = st["D"]?.d ?? 0;
  const st4H = st["4H"]?.d ?? 0;
  const st1H = st["1H"]?.d ?? 0;
  const st30 = st["30"]?.d ?? 0;

  const emaD = emaDepth["D"] ?? 15;
  const ema4H = emaDepth["240"] ?? 15;
  const ema1H = emaDepth["60"] ?? 15;
  const ema30 = emaDepth["30"] ?? 15;
  const emaSum = emaD + ema4H + ema1H;

  const bearish4HClouds = Object.values(clouds["4H"] || {}).filter(c => c.b === 0).length;
  const bearishDClouds = Object.values(clouds["D"] || {}).filter(c => c.b === 0).length;

  return {
    hasDStAgainst: dangerFlags.includes("D_st_against"),
    hasStMomentumLow: dangerFlags.some(f => /st_momentum_low/i.test(f)),
    has4HStAgainst: dangerFlags.includes("4H_st_against"),
    hasVixElevated: dangerFlags.includes("vix_elevated"),
    dangerScore,
    dangerFlags,
    bearish4HClouds,
    bearishDClouds,
    hasSqueezeRelease: !!(squeeze.release_30m || squeeze.release_1h),
    isRiskOff: (ep.market_state || mi.overall || "") === "risk_off",
    isChoppySelective: (ep.active_profile || "") === "choppy_selective",
    marketState: ep.market_state || mi.overall || "",
    profileName: ep.active_profile || "",
    personality: ep.personality || "",
    tickerRegime: ep.ticker_regime || "",
    vix: Number(ln.vix_at_entry) || 0,
    eqs: Number(ln.entry_quality_score || trade.entry_quality_score) || 0,
    state: ln.state || "",
    regimeScore: Number(ln.regime_score) || 0,
    entryPath: ln.entry_path || trade.entry_path || "",
    stD, st4H, st1H, st30,
    emaD, ema4H, ema1H, ema30, emaSum,
    phaseDVal: phase["D"]?.v ?? null,
    phase1HVal: phase["1H"]?.v ?? null,
    swingBias: (ln.swing_consensus || {}).bias ?? null,
  };
}

function stats(arr, fn) {
  const vals = arr.map(fn).filter(v => v != null && Number.isFinite(v));
  if (!vals.length) return { n: 0 };
  vals.sort((a, b) => a - b);
  const sum = vals.reduce((a, b) => a + b, 0);
  return {
    n: vals.length,
    mean: +(sum / vals.length).toFixed(2),
    p25: vals[Math.floor(vals.length * 0.25)],
    p50: vals[Math.floor(vals.length * 0.5)],
    p75: vals[Math.floor(vals.length * 0.75)],
    min: vals[0],
    max: vals[vals.length - 1],
  };
}

// Filters: returns true if trade WOULD BE BLOCKED
// Phase 1 filters (danger-flag based, shown to have high FP in practice)
const NAIVE_FILTERS = {
  "D_st_against": (f) => f.hasDStAgainst,
  "danger_score_gte_4": (f) => f.dangerScore >= 4,
  "danger_score_gte_3": (f) => f.dangerScore >= 3,
  "no_squeeze_risk_off": (f) => !f.hasSqueezeRelease && f.isRiskOff,
};

// Phase 2 filters (discriminative composites discovered via differential analysis)
const DISCRIMINATIVE_FILTERS = {
  "stD_bear_AND_st4H_bear": (f) => f.stD === -1 && f.st4H === -1,
  "emaD_lte12_st1H_bear_stD_bear": (f) => f.emaD <= 12 && f.st1H === -1 && f.stD === -1,
  "emaD_lte10_st1H_bear": (f) => f.emaD <= 10 && f.st1H === -1,
  "emaD_lte8": (f) => f.emaD <= 8,
  "4H_st_against": (f) => f.has4HStAgainst,
  "D_bearish_clouds_gte2": (f) => f.bearishDClouds >= 2,
  "phaseD_lte5_danger4": (f) => (f.phaseDVal ?? 50) <= 5 && f.dangerScore >= 4,
  "combined_gate": (f) => {
    if (f.stD !== -1) return false;
    if (f.st4H === -1) return true;
    return f.st1H === -1 && f.emaD <= 12;
  },
  "combined_gate_plus_blacklist": (f) => {
    if (["XLC", "JCI"].includes(f._ticker)) return true;
    if (f.stD !== -1) return false;
    if (f.st4H === -1) return true;
    return f.st1H === -1 && f.emaD <= 12;
  },
  "ticker_blacklist_XLC_JCI": (f) => ["XLC", "JCI"].includes(f._ticker),
};

function evaluateFilter(name, fn, doaF, winF, ndlF) {
  const doaBlocked = doaF.filter(d => fn(d.features)).length;
  const winBlocked = winF.filter(d => fn(d.features)).length;
  const ndlBlocked = ndlF.filter(d => fn(d.features)).length;

  const doaPnlSaved = Math.abs(doaF.filter(d => fn(d.features))
    .reduce((s, d) => s + (Number(d.trade.pnl) || 0), 0));
  const ndlPnlSaved = Math.abs(ndlF.filter(d => fn(d.features))
    .reduce((s, d) => s + (Number(d.trade.pnl) || 0), 0));
  const winPnlLost = winF.filter(d => fn(d.features))
    .reduce((s, d) => s + (Number(d.trade.pnl) || 0), 0);
  const netPnl = doaPnlSaved + ndlPnlSaved - winPnlLost;

  const recall = doaF.length > 0 ? doaBlocked / doaF.length : 0;
  const fpRate = winF.length > 0 ? winBlocked / winF.length : 0;
  const allBlocked = doaBlocked + winBlocked + ndlBlocked;
  const precision = allBlocked > 0 ? doaBlocked / allBlocked : 0;
  const lossPrecision = allBlocked > 0 ? (doaBlocked + ndlBlocked) / allBlocked : 0;

  return {
    doaBlocked, doaTotal: doaF.length,
    winnersBlocked: winBlocked, winnersTotal: winF.length,
    nonDoaLossBlocked: ndlBlocked,
    recall: +((recall * 100).toFixed(1)),
    falsePositiveRate: +((fpRate * 100).toFixed(1)),
    precision: +((precision * 100).toFixed(1)),
    lossPrecision: +((lossPrecision * 100).toFixed(1)),
    doaPnlSaved: Math.round(doaPnlSaved * 100) / 100,
    nonDoaLossPnlSaved: Math.round(ndlPnlSaved * 100) / 100,
    winnerPnlLost: Math.round(winPnlLost * 100) / 100,
    netPnlImpact: Math.round(netPnl * 100) / 100,
  };
}

function main() {
  console.log("DOA Trade Analysis (v2 — discriminative)");
  console.log("=".repeat(60));

  const allTrades = [];
  const perBacktest = {};

  for (const bt of BACKTESTS) {
    const filePath = path.join(ARTIFACT_DIR, bt, "trade-autopsy-trades.json");
    if (!fs.existsSync(filePath)) {
      console.log(`  SKIP: ${bt}`);
      continue;
    }
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const trades = raw.trades || raw;
    if (!Array.isArray(trades)) continue;
    console.log(`  ${bt}: ${trades.length} trades`);
    for (const t of trades) { t._backtest = bt; allTrades.push(t); }
    perBacktest[bt] = trades;
  }

  const winners = allTrades.filter(t => t.status === "WIN");
  const losers = allTrades.filter(t => t.status === "LOSS");
  const doaTrades = losers.filter(isDOA);
  const nonDoaLosers = losers.filter(t => !isDOA(t));

  console.log(`\nTotal: ${allTrades.length} | W: ${winners.length} | L: ${losers.length} | DOA: ${doaTrades.length} (${(doaTrades.length / losers.length * 100).toFixed(1)}% of losses)`);
  console.log(`DOA total P&L: $${doaTrades.reduce((s, t) => s + (Number(t.pnl) || 0), 0).toFixed(0)}\n`);

  const doaF = doaTrades.map(t => ({ trade: t, features: { ...extractFeatures(t), _ticker: t.ticker } }));
  const winF = winners.map(t => ({ trade: t, features: { ...extractFeatures(t), _ticker: t.ticker } }));
  const ndlF = nonDoaLosers.map(t => ({ trade: t, features: { ...extractFeatures(t), _ticker: t.ticker } }));

  // Feature distribution comparison
  console.log("FEATURE DISTRIBUTION: DOA vs WINNERS");
  console.log("-".repeat(70));
  const featureExtractors = {
    eqs: f => f.eqs || null,
    dangerScore: f => f.dangerScore,
    vix: f => f.vix || null,
    emaD: f => f.emaD,
    ema4H: f => f.ema4H,
    ema1H: f => f.ema1H,
    emaSum: f => f.emaSum,
    phaseDVal: f => f.phaseDVal,
    phase1HVal: f => f.phase1HVal,
    swingBias: f => f.swingBias,
    regimeScore: f => f.regimeScore || null,
  };
  const featureComparison = {};
  for (const [name, fn] of Object.entries(featureExtractors)) {
    const ds = stats(doaF, d => fn(d.features));
    const ws = stats(winF, d => fn(d.features));
    const delta = ds.mean != null && ws.mean != null ? +(ds.mean - ws.mean).toFixed(2) : null;
    featureComparison[name] = { doa: ds, win: ws, delta };
    console.log(`  ${name.padEnd(14)} DOA: mean=${String(ds.mean).padEnd(7)} p50=${String(ds.p50).padEnd(7)} | WIN: mean=${String(ws.mean).padEnd(7)} p50=${String(ws.p50).padEnd(7)} | Δ=${delta}`);
  }

  // Supertrend alignment patterns
  console.log("\nSUPERTREND ALIGNMENT (D/4H/1H/30m):");
  const stPatterns = { DOA: {}, WIN: {}, NDL: {} };
  for (const [label, arr] of [["DOA", doaF], ["WIN", winF], ["NDL", ndlF]]) {
    for (const d of arr) {
      const f = d.features;
      const p = [f.stD, f.st4H, f.st1H, f.st30].map(v => v === 1 ? "+" : v === -1 ? "-" : "?").join("");
      stPatterns[label][p] = (stPatterns[label][p] || 0) + 1;
    }
    console.log(`  ${label}: ${JSON.stringify(stPatterns[label])}`);
  }

  // Regime breakdown
  console.log("\nREGIME BREAKDOWN:");
  const regimeBreakdown = {};
  for (const w of REGIME_WINDOWS) {
    const inW = allTrades.filter(t => getRegimeWindow(t.entry_ts) === w.name);
    const wW = inW.filter(t => t.status === "WIN");
    const wL = inW.filter(t => t.status === "LOSS");
    const wD = wL.filter(isDOA);
    const tPnl = inW.reduce((s, t) => s + (Number(t.pnl) || 0), 0);
    const dPnl = wD.reduce((s, t) => s + (Number(t.pnl) || 0), 0);
    regimeBreakdown[w.name] = {
      total: inW.length, wins: wW.length, losses: wL.length, doa: wD.length,
      winRate: inW.length > 0 ? (wW.length / inW.length * 100).toFixed(1) + "%" : "N/A",
      totalPnl: Math.round(tPnl), doaPnl: Math.round(dPnl),
      doaTickers: [...new Set(wD.map(t => t.ticker))],
    };
    console.log(`  ${w.name}: ${inW.length}T ${wW.length}W/${wL.length}L DOA=${wD.length} P&L=$${Math.round(tPnl)}`);
  }

  // Per-backtest
  const btBreakdown = {};
  for (const [bt, trades] of Object.entries(perBacktest)) {
    const w = trades.filter(t => t.status === "WIN");
    const l = trades.filter(t => t.status === "LOSS");
    const d = l.filter(isDOA);
    btBreakdown[bt] = {
      total: trades.length, wins: w.length, losses: l.length, doa: d.length,
      winRate: (w.length / trades.length * 100).toFixed(1) + "%",
      totalPnl: Math.round(trades.reduce((s, t) => s + (Number(t.pnl) || 0), 0)),
      doaPnl: Math.round(d.reduce((s, t) => s + (Number(t.pnl) || 0), 0)),
    };
  }

  // DOA by state / path / ticker
  const doaByState = {}, doaByPath = {}, doaTickerCount = {};
  for (const d of doaF) {
    const s = d.features.state || "unknown";
    doaByState[s] = (doaByState[s] || 0) + 1;
    const p = d.features.entryPath || "unknown";
    doaByPath[p] = (doaByPath[p] || 0) + 1;
    doaTickerCount[d.trade.ticker] = (doaTickerCount[d.trade.ticker] || 0) + 1;
  }
  const repeatOffenders = Object.entries(doaTickerCount)
    .filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]);

  // Ticker-level DOA rates
  const tickerDoaRates = {};
  for (const t of allTrades) {
    if (!tickerDoaRates[t.ticker]) tickerDoaRates[t.ticker] = { total: 0, wins: 0, doa: 0, pnl: 0 };
    tickerDoaRates[t.ticker].total++;
    if (t.status === "WIN") tickerDoaRates[t.ticker].wins++;
    if (isDOA(t)) tickerDoaRates[t.ticker].doa++;
    tickerDoaRates[t.ticker].pnl += Number(t.pnl) || 0;
  }

  // ---- FILTER EVALUATION ----
  console.log("\n" + "=".repeat(60));
  console.log("NAIVE FILTERS (danger-flag based — high FP expected):");
  console.log("-".repeat(60));
  const naiveResults = {};
  for (const [name, fn] of Object.entries(NAIVE_FILTERS)) {
    naiveResults[name] = evaluateFilter(name, fn, doaF, winF, ndlF);
    const r = naiveResults[name];
    console.log(`  ${name}: recall=${r.recall}% FP=${r.falsePositiveRate}% prec=${r.precision}% net=$${r.netPnlImpact}`);
  }

  console.log("\nDISCRIMINATIVE FILTERS (composite, lower FP):");
  console.log("-".repeat(60));
  const discResults = {};
  for (const [name, fn] of Object.entries(DISCRIMINATIVE_FILTERS)) {
    discResults[name] = evaluateFilter(name, fn, doaF, winF, ndlF);
    const r = discResults[name];
    console.log(`  ${name}:`);
    console.log(`    DOA: ${r.doaBlocked}/${r.doaTotal} (${r.recall}%) | WIN: ${r.winnersBlocked}/${r.winnersTotal} (FP ${r.falsePositiveRate}%) | NDL: ${r.nonDoaLossBlocked}`);
    console.log(`    Prec(DOA): ${r.precision}% | Prec(allLoss): ${r.lossPrecision}% | Net: $${r.netPnlImpact}`);
  }

  // Rank all filters
  const allFilterResults = { ...naiveResults, ...discResults };
  const ranked = Object.entries(allFilterResults)
    .sort((a, b) => b[1].netPnlImpact - a[1].netPnlImpact);

  console.log("\nFILTER RANKING (by net P&L):");
  console.log("-".repeat(60));
  for (const [name, r] of ranked) {
    console.log(`  ${name.padEnd(40)} net=$${String(r.netPnlImpact).padEnd(7)} recall=${String(r.recall).padEnd(5)}% FP=${r.falsePositiveRate}%`);
  }

  // Determine recommendation
  const bestByNet = ranked[0];
  const bestLowFP = ranked.find(([, r]) => r.falsePositiveRate <= 15 && r.netPnlImpact > 0) || ranked[0];

  console.log(`\n  RECOMMENDED: ${bestLowFP[0]}`);
  console.log(`    → blocks ${bestLowFP[1].doaBlocked}/${bestLowFP[1].doaTotal} DOA + ${bestLowFP[1].nonDoaLossBlocked} other losses, costs ${bestLowFP[1].winnersBlocked} winners`);
  console.log(`    → net P&L improvement: $${bestLowFP[1].netPnlImpact}`);

  // DOA detail list
  const doaDetailList = doaTrades.map(t => {
    const f = extractFeatures(t);
    return {
      ticker: t.ticker, direction: t.direction,
      entryDate: tsToDate(t.entry_ts), exitDate: tsToDate(t.exit_ts),
      pnl: Math.round((Number(t.pnl) || 0) * 100) / 100,
      mfe: t.max_favorable_excursion, mae: t.max_adverse_excursion,
      exitReason: t.exit_reason, entryPath: f.entryPath,
      state: f.state, dangerScore: f.dangerScore, dangerFlags: f.dangerFlags,
      stD: f.stD, st4H: f.st4H, st1H: f.st1H, st30: f.st30,
      emaD: f.emaD, ema4H: f.ema4H, emaSum: f.emaSum,
      bearish4HClouds: f.bearish4HClouds, bearishDClouds: f.bearishDClouds,
      isRiskOff: f.isRiskOff, vix: f.vix, eqs: f.eqs,
      profileName: f.profileName, regime: getRegimeWindow(t.entry_ts),
      backtest: t._backtest,
    };
  });

  // Blocked winners for recommended filter
  const recFn = DISCRIMINATIVE_FILTERS[bestLowFP[0]] || NAIVE_FILTERS[bestLowFP[0]];
  const blockedWinners = recFn ? winF
    .filter(d => recFn(d.features))
    .map(d => ({
      ticker: d.trade.ticker, entryDate: tsToDate(d.trade.entry_ts),
      pnl: Math.round((Number(d.trade.pnl) || 0) * 100) / 100,
      mfe: d.trade.max_favorable_excursion, state: d.features.state,
      regime: getRegimeWindow(d.trade.entry_ts),
    })) : [];

  const report = {
    generated_at: new Date().toISOString(),
    summary: {
      totalTrades: allTrades.length,
      winners: winners.length,
      losers: losers.length,
      doaTrades: doaTrades.length,
      doaRateAmongLosses: +((doaTrades.length / losers.length * 100).toFixed(1)),
      totalDoaPnl: Math.round(doaTrades.reduce((s, t) => s + (Number(t.pnl) || 0), 0)),
      mfeThreshold: MFE_THRESHOLD,
    },
    keyInsight: "Danger flags (D_st_against, risk_off, danger_score>=3) are NOT discriminative — " +
      "they appear at similar rates in DOA trades AND winners. The discriminative signals are: " +
      "(1) when BOTH daily AND 4H supertrend are bearish, (2) shallow EMA depth on daily " +
      "combined with bearish lower-TF supertrend, and (3) specific repeat-offender tickers.",
    perBacktest: btBreakdown,
    perRegime: regimeBreakdown,
    featureComparison,
    supertrendPatterns: stPatterns,
    doaByEntryPath: doaByPath,
    doaByState,
    repeatOffenders: Object.fromEntries(repeatOffenders),
    tickerDoaRates: Object.fromEntries(
      Object.entries(tickerDoaRates).sort((a, b) => b[1].doa - a[1].doa).slice(0, 20)
    ),
    naiveFilters: naiveResults,
    discriminativeFilters: discResults,
    filterRanking: ranked.map(([name, r]) => ({ name, ...r })),
    recommendation: {
      filterName: bestLowFP[0],
      rationale: "Best net P&L impact with false-positive rate ≤ 15%",
      details: bestLowFP[1],
      implementation: "Block entry when: (stD_bear AND st4H_bear) OR (stD_bear AND st1H_bear AND emaD ≤ 12) OR ticker in {XLC, JCI}",
    },
    doaTradeDetails: doaDetailList,
    blockedWinnersForRecommendedFilter: blockedWinners,
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(report, null, 2));
  console.log(`\nReport → ${OUTPUT_PATH}`);
}

main();
