#!/usr/bin/env node
/**
 * statistical-validation.js — Comprehensive statistical validation of trading signals
 *
 * Implements:
 *   Tier 2: K-S test, bootstrap CI, regime-conditioned Sharpe, IC-by-regime, walk-forward
 *   Tier 3: Signal decay analysis, multiple-testing correction
 *
 * Usage:
 *   node scripts/statistical-validation.js
 *   node scripts/statistical-validation.js --walk-forward
 */

const path = require("path");
const { execSync } = require("child_process");

const WORKER_DIR = path.join(__dirname, "../worker");

function d1Query(sql) {
  const oneLine = sql.replace(/\s+/g, " ").trim();
  const escaped = oneLine.replace(/"/g, '\\"');
  try {
    const raw = execSync(
      `cd "${WORKER_DIR}" && npx wrangler d1 execute timed-trading-ledger --remote --json --command "${escaped}"`,
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 50 * 1024 * 1024 }
    );
    const lines = raw.split("\n").filter(l => !l.startsWith("npm"));
    const parsed = JSON.parse(lines.join("\n"));
    return Array.isArray(parsed) ? parsed[0]?.results || [] : parsed?.results || [];
  } catch (e) {
    console.error("D1 query failed:", e.message?.slice(0, 300));
    return [];
  }
}

function safeJson(str) {
  if (!str) return null;
  try { return typeof str === "string" ? JSON.parse(str) : str; } catch { return null; }
}

// ──────────────────────────────────────────────────────────────
// Statistical Primitives
// ──────────────────────────────────────────────────────────────

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function stdev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
}

function ranks(arr) {
  const indexed = arr.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => a.v - b.v);
  const r = new Array(arr.length);
  for (let i = 0; i < indexed.length; i++) {
    r[indexed[i].i] = i + 1;
  }
  return r;
}

function spearmanCorrelation(x, y) {
  const n = x.length;
  if (n < 5) return { ic: 0, n };
  const rx = ranks(x);
  const ry = ranks(y);
  const d2 = rx.reduce((s, _, i) => s + (rx[i] - ry[i]) ** 2, 0);
  const ic = 1 - (6 * d2) / (n * (n * n - 1));
  return { ic: Math.round(ic * 1000) / 1000, n };
}

function sharpeRatio(returns, annualizationFactor = 252) {
  if (returns.length < 2) return 0;
  const m = mean(returns);
  const s = stdev(returns);
  if (s === 0) return 0;
  return (m / s) * Math.sqrt(annualizationFactor);
}

/**
 * Kolmogorov-Smirnov two-sample test
 * Returns D statistic and approximate p-value
 */
function ksTest(sample1, sample2) {
  const n1 = sample1.length, n2 = sample2.length;
  if (n1 < 2 || n2 < 2) return { D: 0, p: 1, significant: false };

  const all = [
    ...sample1.map(v => ({ v, g: 1 })),
    ...sample2.map(v => ({ v, g: 2 })),
  ].sort((a, b) => a.v - b.v);

  let ecdf1 = 0, ecdf2 = 0, maxD = 0;
  for (const { g } of all) {
    if (g === 1) ecdf1 += 1 / n1;
    else ecdf2 += 1 / n2;
    maxD = Math.max(maxD, Math.abs(ecdf1 - ecdf2));
  }

  // Approximate p-value using asymptotic formula
  const en = Math.sqrt((n1 * n2) / (n1 + n2));
  const lambda = (en + 0.12 + 0.11 / en) * maxD;
  // Kolmogorov distribution approximation
  let p = 2 * Math.exp(-2 * lambda * lambda);
  p = Math.max(0, Math.min(1, p));

  return {
    D: Math.round(maxD * 10000) / 10000,
    p: Math.round(p * 10000) / 10000,
    significant: p < 0.05,
    n1, n2,
  };
}

/**
 * Bootstrap confidence interval for a statistic
 */
function bootstrapCI(data, statFn, { nBoot = 10000, alpha = 0.05 } = {}) {
  if (data.length < 5) return { lower: 0, upper: 0, point: statFn(data), n: data.length };
  const bootStats = [];
  for (let b = 0; b < nBoot; b++) {
    const sample = [];
    for (let i = 0; i < data.length; i++) {
      sample.push(data[Math.floor(Math.random() * data.length)]);
    }
    bootStats.push(statFn(sample));
  }
  bootStats.sort((a, b) => a - b);
  const lo = Math.floor((alpha / 2) * nBoot);
  const hi = Math.floor((1 - alpha / 2) * nBoot);
  return {
    lower: Math.round(bootStats[lo] * 10000) / 10000,
    upper: Math.round(bootStats[hi] * 10000) / 10000,
    point: Math.round(statFn(data) * 10000) / 10000,
    n: data.length,
  };
}

/**
 * One-sided t-test: H0: mean <= 0, H1: mean > 0
 */
function oneSidedTTest(data) {
  const n = data.length;
  if (n < 3) return { t: 0, p: 1, significant: false };
  const m = mean(data);
  const s = stdev(data);
  if (s === 0) return { t: m > 0 ? Infinity : 0, p: m > 0 ? 0 : 1, significant: m > 0 };
  const t = m / (s / Math.sqrt(n));
  // Approximate p-value using normal distribution for large n
  const p = 0.5 * (1 - erf(t / Math.sqrt(2)));
  return {
    t: Math.round(t * 1000) / 1000,
    p: Math.round(p * 10000) / 10000,
    significant: p < 0.05,
    mean: Math.round(m * 10000) / 10000,
    n,
  };
}

function erf(x) {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}

/**
 * Benjamini-Hochberg correction for multiple testing
 */
function benjaminiHochberg(pValues, alpha = 0.05) {
  const m = pValues.length;
  const indexed = pValues.map((p, i) => ({ p, i }));
  indexed.sort((a, b) => a.p - b.p);

  let maxSignificant = -1;
  for (let k = 0; k < m; k++) {
    const threshold = ((k + 1) / m) * alpha;
    if (indexed[k].p <= threshold) maxSignificant = k;
  }

  const significant = new Array(m).fill(false);
  for (let k = 0; k <= maxSignificant; k++) {
    significant[indexed[k].i] = true;
  }
  return significant;
}

// ──────────────────────────────────────────────────────────────
// Data Loading
// ──────────────────────────────────────────────────────────────

console.log("📊 Loading trade data from D1...");

const trades = d1Query(`
  SELECT t.trade_id, t.ticker, t.direction, t.status, t.entry_ts, t.exit_ts,
         t.entry_price, t.exit_price, t.pnl, t.pnl_pct, t.exit_reason,
         t.setup_name, t.setup_grade,
         da.signal_snapshot_json, da.entry_path,
         da.regime_combined, da.regime_daily, da.regime_weekly,
         da.max_favorable_excursion, da.max_adverse_excursion,
         da.execution_profile_name, da.market_state,
         da.rvol_best, da.entry_quality_score
  FROM trades t
  LEFT JOIN direction_accuracy da ON da.trade_id = t.trade_id
  WHERE t.status IN ('WIN','LOSS','FLAT')
  ORDER BY t.entry_ts
`);

console.log(`  Found ${trades.length} closed trades\n`);
if (trades.length === 0) { console.error("No trades found."); process.exit(1); }

const enriched = trades.map(t => {
  const snap = safeJson(t.signal_snapshot_json);
  return {
    ...t,
    snap,
    pnlPct: Number(t.pnl_pct) || 0,
    pnl: Number(t.pnl) || 0,
    mfe: Number(t.max_favorable_excursion) || 0,
    mae: Number(t.max_adverse_excursion) || 0,
    rvol: Number(t.rvol_best) || 0,
    eq: Number(t.entry_quality_score) || 0,
    regime: t.regime_combined || "UNKNOWN",
    entryMonth: new Date(Number(t.entry_ts)).toISOString().slice(0, 7),
    holdHours: (Number(t.exit_ts) - Number(t.entry_ts)) / 3600000,
    isWin: t.status === "WIN",
  };
});

const pnlPcts = enriched.map(t => t.pnlPct);
const winRate = enriched.filter(t => t.isWin).length / enriched.length;

// ──────────────────────────────────────────────────────────────
// 1. Overall Signal Significance (t-test, bootstrap)
// ──────────────────────────────────────────────────────────────

console.log("═══════════════════════════════════════════════");
console.log("  1. OVERALL SIGNAL SIGNIFICANCE");
console.log("═══════════════════════════════════════════════\n");

const tTest = oneSidedTTest(pnlPcts);
console.log(`  t-test on mean return:`);
console.log(`    Mean return: ${tTest.mean}%`);
console.log(`    t-statistic: ${tTest.t}`);
console.log(`    p-value: ${tTest.p} ${tTest.significant ? "✅ SIGNIFICANT" : "❌ NOT SIGNIFICANT"}`);
console.log(`    n = ${tTest.n}\n`);

const winRateCI = bootstrapCI(
  enriched.map(t => t.isWin ? 1 : 0),
  arr => arr.reduce((s, v) => s + v, 0) / arr.length
);
console.log(`  Win rate bootstrap CI (95%):`);
console.log(`    Point: ${(winRateCI.point * 100).toFixed(1)}%`);
console.log(`    95% CI: [${(winRateCI.lower * 100).toFixed(1)}%, ${(winRateCI.upper * 100).toFixed(1)}%]`);
console.log(`    vs. random (50%): ${winRateCI.lower > 0.50 ? "✅ ABOVE RANDOM" : "⚠️ CI includes 50%"}\n`);

const expectancyCI = bootstrapCI(pnlPcts, mean);
console.log(`  Expectancy bootstrap CI (95%):`);
console.log(`    Point: ${expectancyCI.point}%`);
console.log(`    95% CI: [${expectancyCI.lower}%, ${expectancyCI.upper}%]`);
console.log(`    Positive edge: ${expectancyCI.lower > 0 ? "✅ YES" : "⚠️ CI includes zero"}\n`);

// ──────────────────────────────────────────────────────────────
// 2. K-S Test: Conditional vs Unconditional Returns
// ──────────────────────────────────────────────────────────────

console.log("═══════════════════════════════════════════════");
console.log("  2. K-S TESTS: CONDITIONAL vs UNCONDITIONAL");
console.log("═══════════════════════════════════════════════\n");

// Generate unconditional returns (random N-bar returns from the same period)
// We approximate with the trade PnL distribution shuffled as "unconditional"
const halfN = Math.floor(enriched.length / 2);
const unconditional = enriched.slice(0, halfN).map(t => t.pnlPct);
const conditional = enriched.slice(halfN).map(t => t.pnlPct);

const ksOverall = ksTest(pnlPcts, shuffleArray([...pnlPcts]));
console.log(`  Overall signal vs shuffled returns:`);
console.log(`    D = ${ksOverall.D}, p = ${ksOverall.p} ${ksOverall.significant ? "✅" : "❌"}\n`);

// K-S test by entry path
const entryPaths = [...new Set(enriched.map(t => t.entry_path).filter(Boolean))];
console.log(`  By entry path:`);
const ksResults = [];
for (const ep of entryPaths) {
  const pathReturns = enriched.filter(t => t.entry_path === ep).map(t => t.pnlPct);
  const nonPathReturns = enriched.filter(t => t.entry_path !== ep).map(t => t.pnlPct);
  if (pathReturns.length < 5) continue;
  const ks = ksTest(pathReturns, nonPathReturns);
  ksResults.push({ path: ep, ...ks });
  console.log(`    ${ep}: D=${ks.D}, p=${ks.p}, n=${ks.n1} ${ks.significant ? "✅ DIFFERENT" : ""}`);
}
console.log();

// ──────────────────────────────────────────────────────────────
// 3. Regime-Conditioned Sharpe Ratios
// ──────────────────────────────────────────────────────────────

console.log("═══════════════════════════════════════════════");
console.log("  3. REGIME-CONDITIONED SHARPE RATIOS");
console.log("═══════════════════════════════════════════════\n");

const regimes = [...new Set(enriched.map(t => t.regime))].sort();
const regimeSharpes = {};
for (const r of regimes) {
  const returns = enriched.filter(t => t.regime === r).map(t => t.pnlPct);
  if (returns.length < 3) continue;
  const sr = sharpeRatio(returns, 252 / (returns.length / 9)); // rough annualization
  const winR = returns.filter(v => v > 0).length / returns.length;
  const tT = oneSidedTTest(returns);
  regimeSharpes[r] = { sharpe: Math.round(sr * 100) / 100, n: returns.length, winRate: Math.round(winR * 1000) / 10, pnl: Math.round(returns.reduce((s, v) => s + v, 0) * 100) / 100, tTest: tT };
  console.log(`  ${r.padEnd(22)} Sharpe=${sr.toFixed(2).padStart(6)}  WR=${(winR * 100).toFixed(1).padStart(5)}%  n=${String(returns.length).padStart(3)}  p=${tT.p.toString().padStart(6)} ${tT.significant ? "✅" : "❌"}`);
}
console.log();

// ──────────────────────────────────────────────────────────────
// 4. Information Coefficient by Regime
// ──────────────────────────────────────────────────────────────

console.log("═══════════════════════════════════════════════");
console.log("  4. INFORMATION COEFFICIENT BY REGIME");
console.log("═══════════════════════════════════════════════\n");

const signals = ["rvol_best", "entry_quality_score"];
const snapSignals = ["ema_cross", "supertrend", "ema_structure", "ema_depth", "rsi"];

for (const r of regimes) {
  const regTrades = enriched.filter(t => t.regime === r);
  if (regTrades.length < 10) continue;
  console.log(`  ${r} (n=${regTrades.length}):`);

  for (const sig of signals) {
    const x = regTrades.map(t => Number(t[sig]) || 0);
    const y = regTrades.map(t => t.pnlPct);
    if (x.every(v => v === 0)) continue;
    const { ic, n } = spearmanCorrelation(x, y);
    const label = Math.abs(ic) >= 0.1 ? (ic > 0 ? "✅ PREDICTIVE" : "⚠️ INVERSE") : "➖ WEAK";
    console.log(`    ${sig.padEnd(25)} IC=${ic.toString().padStart(7)}  ${label}`);
  }

  for (const sig of snapSignals) {
    const x = regTrades.map(t => {
      const snap = t.snap;
      if (!snap) return 0;
      const ln = snap.lineage || {};
      return Number(ln[`${sig}_15`] || ln[sig] || snap[sig]) || 0;
    });
    const y = regTrades.map(t => t.pnlPct);
    if (x.every(v => v === 0)) continue;
    const { ic, n } = spearmanCorrelation(x, y);
    const label = Math.abs(ic) >= 0.1 ? (ic > 0 ? "✅ PREDICTIVE" : "⚠️ INVERSE") : "➖ WEAK";
    console.log(`    ${sig.padEnd(25)} IC=${ic.toString().padStart(7)}  ${label}`);
  }
  console.log();
}

// ──────────────────────────────────────────────────────────────
// 5. Walk-Forward Validation
// ──────────────────────────────────────────────────────────────

console.log("═══════════════════════════════════════════════");
console.log("  5. WALK-FORWARD VALIDATION");
console.log("═══════════════════════════════════════════════\n");

const months = [...new Set(enriched.map(t => t.entryMonth))].sort();
const trainMonths = months.slice(0, Math.ceil(months.length * 0.67));
const testMonths = months.slice(Math.ceil(months.length * 0.67));

const trainTrades = enriched.filter(t => trainMonths.includes(t.entryMonth));
const testTrades = enriched.filter(t => testMonths.includes(t.entryMonth));

console.log(`  Train period: ${trainMonths[0]} → ${trainMonths[trainMonths.length - 1]} (${trainTrades.length} trades)`);
console.log(`  Test period:  ${testMonths[0]} → ${testMonths[testMonths.length - 1]} (${testTrades.length} trades)\n`);

const trainWR = trainTrades.filter(t => t.isWin).length / trainTrades.length;
const testWR = testTrades.filter(t => t.isWin).length / testTrades.length;
const trainPnl = trainTrades.reduce((s, t) => s + t.pnl, 0);
const testPnl = testTrades.reduce((s, t) => s + t.pnl, 0);
const trainExpectancy = mean(trainTrades.map(t => t.pnlPct));
const testExpectancy = mean(testTrades.map(t => t.pnlPct));
const trainSharpe = sharpeRatio(trainTrades.map(t => t.pnlPct));
const testSharpe = sharpeRatio(testTrades.map(t => t.pnlPct));

console.log(`  Metric            Train       Test        Delta`);
console.log(`  ────────────────  ──────────  ──────────  ──────────`);
console.log(`  Win Rate          ${(trainWR * 100).toFixed(1).padStart(8)}%  ${(testWR * 100).toFixed(1).padStart(8)}%  ${((testWR - trainWR) * 100).toFixed(1).padStart(9)}%`);
console.log(`  Expectancy        ${trainExpectancy.toFixed(2).padStart(8)}%  ${testExpectancy.toFixed(2).padStart(8)}%  ${(testExpectancy - trainExpectancy).toFixed(2).padStart(9)}%`);
console.log(`  Total P&L         $${trainPnl.toFixed(0).padStart(8)}  $${testPnl.toFixed(0).padStart(8)}  $${(testPnl - trainPnl).toFixed(0).padStart(8)}`);
console.log(`  Sharpe            ${trainSharpe.toFixed(2).padStart(9)}  ${testSharpe.toFixed(2).padStart(9)}  ${(testSharpe - trainSharpe).toFixed(2).padStart(9)}`);

const wfDegradation = testExpectancy < trainExpectancy * 0.5;
console.log(`\n  Walk-forward verdict: ${wfDegradation ? "⚠️ SIGNIFICANT DEGRADATION — likely overfit" : "✅ Edge persists out-of-sample"}`);

// Regime breakdown for train vs test
console.log(`\n  Regime performance shift:`);
for (const r of regimes) {
  const trR = trainTrades.filter(t => t.regime === r);
  const teR = testTrades.filter(t => t.regime === r);
  if (trR.length < 3 && teR.length < 3) continue;
  const trWR = trR.length > 0 ? trR.filter(t => t.isWin).length / trR.length : 0;
  const teWR = teR.length > 0 ? teR.filter(t => t.isWin).length / teR.length : 0;
  const trPnl = trR.reduce((s, t) => s + t.pnl, 0);
  const tePnl = teR.reduce((s, t) => s + t.pnl, 0);
  console.log(`    ${r.padEnd(22)} Train: ${(trWR * 100).toFixed(0).padStart(3)}% WR $${trPnl.toFixed(0).padStart(6)} (n=${trR.length})  Test: ${(teWR * 100).toFixed(0).padStart(3)}% WR $${tePnl.toFixed(0).padStart(6)} (n=${teR.length})`);
}
console.log();

// ──────────────────────────────────────────────────────────────
// 6. Signal Decay Analysis (IC at different horizons)
// ──────────────────────────────────────────────────────────────

console.log("═══════════════════════════════════════════════");
console.log("  6. SIGNAL DECAY ANALYSIS");
console.log("═══════════════════════════════════════════════\n");

// Approximate signal decay by binning trades by hold duration
const holdBuckets = [
  { label: "<4hr", min: 0, max: 4 },
  { label: "4-24hr", min: 4, max: 24 },
  { label: "1-3d", min: 24, max: 72 },
  { label: "3-7d", min: 72, max: 168 },
  { label: "7d+", min: 168, max: Infinity },
];

console.log(`  Entry Quality Score IC by hold duration:`);
for (const b of holdBuckets) {
  const bucket = enriched.filter(t => t.holdHours >= b.min && t.holdHours < b.max);
  if (bucket.length < 10) { console.log(`    ${b.label.padEnd(8)} n=${bucket.length} (insufficient)`); continue; }
  const x = bucket.map(t => t.eq);
  const y = bucket.map(t => t.pnlPct);
  const { ic } = spearmanCorrelation(x, y);
  const wr = bucket.filter(t => t.isWin).length / bucket.length;
  console.log(`    ${b.label.padEnd(8)} IC=${ic.toString().padStart(7)}  WR=${(wr * 100).toFixed(1).padStart(5)}%  n=${bucket.length}`);
}

console.log(`\n  RVOL IC by hold duration:`);
for (const b of holdBuckets) {
  const bucket = enriched.filter(t => t.holdHours >= b.min && t.holdHours < b.max);
  if (bucket.length < 10) continue;
  const x = bucket.map(t => t.rvol);
  const y = bucket.map(t => t.pnlPct);
  const { ic } = spearmanCorrelation(x, y);
  console.log(`    ${b.label.padEnd(8)} IC=${ic.toString().padStart(7)}  n=${bucket.length}`);
}
console.log();

// ──────────────────────────────────────────────────────────────
// 7. Multiple Testing Correction
// ──────────────────────────────────────────────────────────────

console.log("═══════════════════════════════════════════════");
console.log("  7. MULTIPLE TESTING CORRECTION (B-H)");
console.log("═══════════════════════════════════════════════\n");

// Collect all p-values from our tests
const allPValues = [];
const testNames = [];

allPValues.push(tTest.p); testNames.push("Overall mean return");
for (const r of regimes) {
  if (regimeSharpes[r]) {
    allPValues.push(regimeSharpes[r].tTest.p);
    testNames.push(`Regime ${r} mean return`);
  }
}
for (const ks of ksResults) {
  allPValues.push(ks.p);
  testNames.push(`K-S ${ks.path}`);
}

const bhSignificant = benjaminiHochberg(allPValues, 0.05);

console.log(`  ${allPValues.length} hypotheses tested. Benjamini-Hochberg correction at FDR=5%:\n`);
for (let i = 0; i < allPValues.length; i++) {
  console.log(`    ${testNames[i].padEnd(40)} p=${allPValues[i].toString().padStart(6)} ${bhSignificant[i] ? "✅ SURVIVES" : "❌ REJECTED"}`);
}
console.log();

// ──────────────────────────────────────────────────────────────
// 8. MFE Capture Analysis
// ──────────────────────────────────────────────────────────────

console.log("═══════════════════════════════════════════════");
console.log("  8. MFE CAPTURE EFFICIENCY");
console.log("═══════════════════════════════════════════════\n");

const winners = enriched.filter(t => t.isWin && t.mfe > 0);
const captureRatios = winners.map(t => t.pnlPct / t.mfe);
const captureCI = bootstrapCI(captureRatios, mean);

console.log(`  Winner MFE capture ratio:`);
console.log(`    Point: ${(captureCI.point * 100).toFixed(1)}%`);
console.log(`    95% CI: [${(captureCI.lower * 100).toFixed(1)}%, ${(captureCI.upper * 100).toFixed(1)}%]`);
console.log(`    Target: >65% (current: ${(captureCI.point * 100).toFixed(1)}%)\n`);

// By exit reason
const exitReasons = [...new Set(winners.map(t => t.exit_reason))].sort();
for (const er of exitReasons) {
  const erTrades = winners.filter(t => t.exit_reason === er);
  if (erTrades.length < 3) continue;
  const erCapture = mean(erTrades.map(t => t.pnlPct / t.mfe));
  const erLeftOnTable = mean(erTrades.map(t => t.mfe - t.pnlPct));
  console.log(`    ${er.padEnd(45)} capture=${(erCapture * 100).toFixed(0).padStart(3)}%  left=${erLeftOnTable.toFixed(2)}%  n=${erTrades.length}`);
}
console.log();

// ──────────────────────────────────────────────────────────────
// Summary & Recommendations
// ──────────────────────────────────────────────────────────────

console.log("═══════════════════════════════════════════════");
console.log("  SUMMARY & RECOMMENDATIONS");
console.log("═══════════════════════════════════════════════\n");

const significantRegimes = regimes.filter(r => regimeSharpes[r]?.tTest?.significant);
const losingRegimes = regimes.filter(r => regimeSharpes[r]?.tTest?.mean < 0);

console.log(`  Overall edge: ${tTest.significant ? "✅ STATISTICALLY SIGNIFICANT" : "⚠️ NOT SIGNIFICANT at p<0.05"} (p=${tTest.p})`);
console.log(`  Walk-forward: ${wfDegradation ? "⚠️ DEGRADED" : "✅ HOLDS"}`);
console.log(`  MFE capture: ${(captureCI.point * 100).toFixed(0)}% (room for ${((1 - captureCI.point) * 100).toFixed(0)}% improvement)`);
console.log(`  Profitable regimes: ${significantRegimes.join(", ") || "none at p<0.05"}`);
console.log(`  Losing regimes: ${losingRegimes.join(", ") || "none"}`);
console.log(`  Tests surviving multiple-testing: ${bhSignificant.filter(Boolean).length}/${bhSignificant.length}`);
console.log();

function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
