#!/usr/bin/env node
/**
 * analyze-backtest.js — Deep backtest analysis → interactive HTML canvas
 *
 * Queries D1 for all closed trades + direction_accuracy + signal snapshots,
 * computes comprehensive analytics, and generates an interactive HTML canvas
 * with 8 analysis panels.
 *
 * Usage:
 *   node scripts/analyze-backtest.js
 *   node scripts/analyze-backtest.js --run-id <specific_run_id>
 */

const path = require("path");
const fs = require("fs");
const { execSync } = require("child_process");

const WORKER_DIR = path.join(__dirname, "../worker");
const OUT_DIR = path.join(__dirname, "../data");
fs.mkdirSync(OUT_DIR, { recursive: true });

const RUN_ID = process.argv.includes("--run-id")
  ? process.argv[process.argv.indexOf("--run-id") + 1]
  : null;

// ── D1 helper ──────────────────────────────────────────────────────────────
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

function pct(n, d) { return d > 0 ? ((n / d) * 100).toFixed(1) : "0.0"; }
function fmt$(v) { return v >= 0 ? `$${v.toFixed(2)}` : `-$${Math.abs(v).toFixed(2)}`; }

// ── Step 1: Extract data from D1 ──────────────────────────────────────────
console.log("🔍 Querying D1 for trade data...");

const runFilter = RUN_ID ? `AND t.run_id = '${RUN_ID}'` : "";

const trades = d1Query(`
  SELECT t.trade_id, t.ticker, t.direction, t.status, t.entry_ts, t.exit_ts,
         t.entry_price, t.exit_price, t.pnl, t.pnl_pct, t.exit_reason,
         t.setup_name, t.setup_grade, t.risk_budget, t.trimmed_pct, t.trim_ts, t.run_id,
         da.signal_snapshot_json, da.exit_snapshot_json, da.entry_path,
         da.consensus_direction, da.regime_combined, da.regime_daily, da.regime_weekly,
         da.max_favorable_excursion, da.max_adverse_excursion, da.tf_stack_json,
         da.execution_profile_name, da.execution_profile_confidence, da.market_state,
         da.rvol_best, da.entry_quality_score
  FROM trades t
  LEFT JOIN direction_accuracy da ON da.trade_id = t.trade_id
  WHERE t.status IN ('WIN','LOSS','FLAT') ${runFilter}
  ORDER BY t.entry_ts
`);

console.log(`  Found ${trades.length} closed trades`);
if (trades.length === 0) { console.error("No trades found. Exiting."); process.exit(1); }

// Parse signal snapshots
const enriched = trades.map(t => {
  const snap = safeJson(t.signal_snapshot_json);
  const exitSnap = safeJson(t.exit_snapshot_json);
  const ln = snap?.lineage || {};
  const exitLn = exitSnap?.lineage || {};
  const tfSignals = snap?.tf || {};
  const exitTfSignals = exitSnap?.tf || {};
  const entryMs = Number(t.entry_ts) || 0;
  const exitMs = Number(t.exit_ts) || 0;
  const holdMs = exitMs - entryMs;
  const holdHours = holdMs / 3600000;
  const entryDate = entryMs > 1e12 ? new Date(entryMs) : new Date(entryMs * 1000);
  const entryHourET = (entryDate.getUTCHours() - 4 + 24) % 24;
  const entryDow = entryDate.getUTCDay();

  return {
    ...t,
    snap, exitSnap, ln, exitLn, tfSignals, exitTfSignals,
    pnl: Number(t.pnl) || 0,
    pnlPct: Number(t.pnl_pct) || 0,
    mfe: Number(t.max_favorable_excursion) || null,
    mae: Number(t.max_adverse_excursion) || null,
    rvol: Number(t.rvol_best) || null,
    eqScore: Number(t.entry_quality_score) || null,
    epConf: Number(t.execution_profile_confidence) || null,
    holdHours,
    entryHourET,
    entryDow,
    isWin: t.status === "WIN",
    isLoss: t.status === "LOSS",
    trimmedPct: Number(t.trimmed_pct) || 0,
    grade: t.setup_grade || "Unknown",
    regime: t.regime_combined || ln.regime_class || "Unknown",
    entryPath: t.entry_path || ln.entry_path || "Unknown",
    vix: Number(ln.vix_at_entry) || null,
    volTier: ln.volatility_tier || null,
    dangerScore: ln.danger_score != null ? Number(ln.danger_score) : null,
    personality: ln.execution_profile?.personality || ln.ticker_character?.personality || null,
  };
});

const wins = enriched.filter(t => t.isWin);
const losses = enriched.filter(t => t.isLoss);

// ── Step 2: Compute analytics ─────────────────────────────────────────────
console.log("📊 Computing analytics...");

// 2a. Overview stats
const overview = {
  totalTrades: enriched.length,
  wins: wins.length,
  losses: losses.length,
  winRate: pct(wins.length, enriched.length),
  totalPnl: enriched.reduce((s, t) => s + t.pnl, 0),
  avgWin: wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0,
  avgLoss: losses.length > 0 ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0,
  bestTrade: enriched.reduce((b, t) => t.pnl > b.pnl ? t : b, enriched[0]),
  worstTrade: enriched.reduce((w, t) => t.pnl < w.pnl ? t : w, enriched[0]),
  profitFactor: (() => {
    const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    return grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : "∞";
  })(),
  expectancy: enriched.reduce((s, t) => s + t.pnl, 0) / enriched.length,
  equityCurve: enriched.map((t, i) => ({
    x: t.entry_ts,
    y: enriched.slice(0, i + 1).reduce((s, tr) => s + tr.pnl, 0),
    ticker: t.ticker,
    status: t.status,
  })),
};

// 2b. Breakdown by group
function groupBy(arr, keyFn) {
  const map = {};
  for (const item of arr) {
    const key = keyFn(item) || "Unknown";
    if (!map[key]) map[key] = [];
    map[key].push(item);
  }
  return map;
}

function computeGroupStats(groups) {
  return Object.entries(groups).map(([key, trades]) => {
    const w = trades.filter(t => t.isWin).length;
    const l = trades.filter(t => t.isLoss).length;
    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
    const avgPnl = totalPnl / trades.length;
    const avgPnlPct = trades.reduce((s, t) => s + t.pnlPct, 0) / trades.length;
    return { key, n: trades.length, wins: w, losses: l, wr: pct(w, trades.length), totalPnl, avgPnl, avgPnlPct };
  }).sort((a, b) => b.n - a.n);
}

const byGrade = computeGroupStats(groupBy(enriched, t => t.grade));
const byRegime = computeGroupStats(groupBy(enriched, t => t.regime));
const byPath = computeGroupStats(groupBy(enriched, t => t.entryPath));
const byTicker = computeGroupStats(groupBy(enriched, t => t.ticker));

// Exit reason: normalize truncated strings
const byExitReason = computeGroupStats(groupBy(enriched, t => {
  const er = (t.exit_reason || "unknown").split(",")[0].trim();
  return er;
}));

// 2c. Entry signal analysis per TF
const TFS = ["15m", "30m", "1H", "4H", "D"];
const signalAnalysis = {};

for (const tf of TFS) {
  const tfData = { emaCross: { bull: { w: 0, l: 0 }, bear: { w: 0, l: 0 }, none: { w: 0, l: 0 } } };

  // EMA Depth buckets
  tfData.emaDepth = { "0-4": { w: 0, l: 0 }, "5-9": { w: 0, l: 0 }, "10-15": { w: 0, l: 0 }, none: { w: 0, l: 0 } };

  // SuperTrend
  tfData.supertrend = { bull: { w: 0, l: 0 }, bear: { w: 0, l: 0 }, none: { w: 0, l: 0 } };

  // RSI buckets
  tfData.rsi = { "0-30": { w: 0, l: 0 }, "30-50": { w: 0, l: 0 }, "50-70": { w: 0, l: 0 }, "70-100": { w: 0, l: 0 }, none: { w: 0, l: 0 } };

  // RSI scatter data
  tfData.rsiScatter = [];

  for (const t of enriched) {
    const sig = t.tfSignals[tf]?.signals || {};
    const wl = t.isWin ? "w" : "l";

    // EMA Cross
    if (sig.ema_cross === 1) tfData.emaCross.bull[wl]++;
    else if (sig.ema_cross === -1) tfData.emaCross.bear[wl]++;
    else tfData.emaCross.none[wl]++;

    // EMA Depth
    const d = sig.ema_depth;
    if (d != null) {
      if (d < 5) tfData.emaDepth["0-4"][wl]++;
      else if (d < 10) tfData.emaDepth["5-9"][wl]++;
      else tfData.emaDepth["10-15"][wl]++;
    } else tfData.emaDepth.none[wl]++;

    // SuperTrend
    if (sig.supertrend === 1) tfData.supertrend.bull[wl]++;
    else if (sig.supertrend === -1) tfData.supertrend.bear[wl]++;
    else tfData.supertrend.none[wl]++;

    // RSI
    const rsi = sig.rsi;
    if (rsi != null) {
      if (rsi <= 30) tfData.rsi["0-30"][wl]++;
      else if (rsi <= 50) tfData.rsi["30-50"][wl]++;
      else if (rsi <= 70) tfData.rsi["50-70"][wl]++;
      else tfData.rsi["70-100"][wl]++;
      tfData.rsiScatter.push({ rsi: Number(rsi.toFixed(1)), pnlPct: t.pnlPct, status: t.status, ticker: t.ticker });
    } else tfData.rsi.none[wl]++;
  }

  signalAnalysis[tf] = tfData;
}

// 2d. Alignment score: how many TFs were bullish at entry?
const alignmentData = enriched.map(t => {
  let bullCount = 0, bearCount = 0, total = 0;
  for (const tf of TFS) {
    const sig = t.tfSignals[tf]?.signals || {};
    if (sig.ema_cross === 1) bullCount++;
    else if (sig.ema_cross === -1) bearCount++;
    if (sig.supertrend === 1) bullCount++;
    else if (sig.supertrend === -1) bearCount++;
    if (sig.ema_cross != null || sig.supertrend != null) total += 2;
  }
  const alignScore = total > 0 ? (bullCount / total * 100).toFixed(0) : null;
  return { alignScore: Number(alignScore), isWin: t.isWin, pnl: t.pnl, ticker: t.ticker };
}).filter(d => d.alignScore != null);

const alignmentBuckets = {};
for (const d of alignmentData) {
  const bucket = d.alignScore >= 80 ? "80-100%" : d.alignScore >= 60 ? "60-79%" : d.alignScore >= 40 ? "40-59%" : "0-39%";
  if (!alignmentBuckets[bucket]) alignmentBuckets[bucket] = { w: 0, l: 0 };
  alignmentBuckets[bucket][d.isWin ? "w" : "l"]++;
}

// 2e. TD Sequential analysis
const tdAnalysis = { atEntry: [] };
for (const t of enriched) {
  const td = t.ln?.td_counts || {};
  const hasTd = Object.keys(td).length > 0;
  if (!hasTd) continue;
  let maxBearPrep = 0, maxBullPrep = 0;
  for (const [tfKey, counts] of Object.entries(td)) {
    if (counts.xp > maxBearPrep) maxBearPrep = counts.xp;
    if (counts.bp > maxBullPrep) maxBullPrep = counts.bp;
  }
  tdAnalysis.atEntry.push({
    maxBearPrep, maxBullPrep, isWin: t.isWin, pnl: t.pnl, pnlPct: t.pnlPct, ticker: t.ticker,
  });
}

// 2f. Phase oscillator analysis
const phaseAnalysis = [];
for (const t of enriched) {
  const phase = t.ln?.saty_phase || {};
  const phaseD = phase.D || phase.d;
  const phase1H = phase["1H"] || phase["60"];
  const phase30 = phase["30"] || phase["30m"];
  if (phaseD || phase1H || phase30) {
    phaseAnalysis.push({
      phaseD: phaseD?.v != null ? Number(phaseD.v) : null,
      phase1H: phase1H?.v != null ? Number(phase1H.v) : null,
      phase30: phase30?.v != null ? Number(phase30.v) : null,
      isWin: t.isWin, pnl: t.pnl, ticker: t.ticker,
    });
  }
}

// 2g. MFE / MAE analysis
const mfeMaeData = enriched.filter(t => t.mfe != null || t.mae != null).map(t => ({
  mfe: t.mfe || 0, mae: t.mae || 0,
  pnlPct: t.pnlPct, isWin: t.isWin, ticker: t.ticker,
  captureRatio: t.mfe > 0 ? (t.pnlPct / t.mfe * 100).toFixed(1) : null,
  exitReason: (t.exit_reason || "unknown").split(",")[0],
}));

// 2h. Regime and volatility
const regimeVix = enriched.filter(t => t.vix != null).map(t => ({
  vix: t.vix, regime: t.regime, isWin: t.isWin, pnl: t.pnl, pnlPct: t.pnlPct, ticker: t.ticker,
}));

const byVolTier = computeGroupStats(groupBy(enriched.filter(t => t.volTier), t => t.volTier));

const rvolData = enriched.filter(t => t.rvol != null).map(t => ({
  rvol: t.rvol, isWin: t.isWin, pnl: t.pnl, pnlPct: t.pnlPct, ticker: t.ticker,
}));

// 2i. Timing analysis
const byEntryHour = computeGroupStats(groupBy(enriched, t => `${t.entryHourET}:00 ET`));
const byDow = computeGroupStats(groupBy(enriched, t => ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][t.entryDow]));

const holdDurationData = enriched.map(t => ({
  hours: t.holdHours, isWin: t.isWin, pnl: t.pnl, pnlPct: t.pnlPct, ticker: t.ticker,
})).filter(d => d.hours > 0 && d.hours < 5000);

// 2j. Entry quality score
const eqData = enriched.filter(t => t.eqScore != null).map(t => ({
  score: t.eqScore, isWin: t.isWin, pnl: t.pnl, pnlPct: t.pnlPct, ticker: t.ticker,
}));

// 2k. Danger score
const dangerData = enriched.filter(t => t.dangerScore != null).map(t => ({
  danger: t.dangerScore, isWin: t.isWin, pnl: t.pnl, ticker: t.ticker,
}));

// 2l. Investor Engine analysis
console.log("🏦 Querying investor positions & lots...");

const invPositions = d1Query(`
  SELECT id, ticker, status, total_shares, cost_basis, avg_entry,
         first_entry_ts, last_entry_ts, investor_stage, target_alloc_pct, closed_at
  FROM investor_positions
  ORDER BY first_entry_ts
`);

const invLots = d1Query(`
  SELECT id, position_id, ticker, action, shares, price, value, ts, reason
  FROM investor_lots
  ORDER BY ts
`);

console.log(`  Found ${invPositions.length} investor positions, ${invLots.length} lots`);

const investorAnalysis = (() => {
  const lotsByPos = {};
  for (const lot of invLots) {
    if (!lotsByPos[lot.position_id]) lotsByPos[lot.position_id] = [];
    lotsByPos[lot.position_id].push(lot);
  }

  const positionResults = invPositions.map(pos => {
    const lots = lotsByPos[pos.id] || [];
    const buys = lots.filter(l => l.action === "BUY");
    const sells = lots.filter(l => l.action === "SELL");
    const totalBought = buys.reduce((s, l) => s + Number(l.value || 0), 0);
    const totalSold = sells.reduce((s, l) => s + Number(l.value || 0), 0);
    const pnl = totalSold - totalBought;
    const pnlPct = totalBought > 0 ? (pnl / totalBought) * 100 : 0;
    const entryMs = Number(pos.first_entry_ts) || 0;
    const exitMs = Number(pos.closed_at) || Number(pos.last_entry_ts) || entryMs;
    const holdDays = (exitMs - entryMs) / 86400000;
    const exitReason = sells.length > 0 ? sells[sells.length - 1].reason : "unknown";

    return {
      id: pos.id, ticker: pos.ticker, status: pos.status,
      costBasis: Number(pos.cost_basis) || 0,
      avgEntry: Number(pos.avg_entry) || 0,
      totalBought, totalSold, pnl, pnlPct, holdDays,
      stage: pos.investor_stage, allocPct: Number(pos.target_alloc_pct) || 0,
      exitReason, numBuys: buys.length, numSells: sells.length,
    };
  });

  const totalInvested = positionResults.reduce((s, p) => s + p.totalBought, 0);
  const totalReturned = positionResults.reduce((s, p) => s + p.totalSold, 0);
  const totalPnl = totalReturned - totalInvested;
  const invWins = positionResults.filter(p => p.pnl > 0);
  const invLosses = positionResults.filter(p => p.pnl <= 0);

  // Per-ticker aggregation
  const tickerMap = {};
  for (const p of positionResults) {
    if (!tickerMap[p.ticker]) tickerMap[p.ticker] = { ticker: p.ticker, positions: [], totalPnl: 0, totalInvested: 0 };
    tickerMap[p.ticker].positions.push(p);
    tickerMap[p.ticker].totalPnl += p.pnl;
    tickerMap[p.ticker].totalInvested += p.totalBought;
  }
  const byInvTicker = Object.values(tickerMap).map(g => {
    const w = g.positions.filter(p => p.pnl > 0).length;
    const l = g.positions.filter(p => p.pnl <= 0).length;
    const avgHold = g.positions.reduce((s, p) => s + p.holdDays, 0) / g.positions.length;
    return {
      ticker: g.ticker, n: g.positions.length, wins: w, losses: l,
      wr: pct(w, g.positions.length), totalPnl: g.totalPnl,
      avgPnl: g.totalPnl / g.positions.length,
      pnlPct: g.totalInvested > 0 ? (g.totalPnl / g.totalInvested * 100).toFixed(2) : "0",
      avgHoldDays: avgHold.toFixed(1),
    };
  }).sort((a, b) => b.totalPnl - a.totalPnl);

  // Exit reason breakdown
  const exitReasonMap = {};
  for (const p of positionResults) {
    const key = p.exitReason || "unknown";
    if (!exitReasonMap[key]) exitReasonMap[key] = { reason: key, n: 0, totalPnl: 0, wins: 0, losses: 0 };
    exitReasonMap[key].n++;
    exitReasonMap[key].totalPnl += p.pnl;
    if (p.pnl > 0) exitReasonMap[key].wins++;
    else exitReasonMap[key].losses++;
  }
  const byExitReasonInv = Object.values(exitReasonMap).map(g => ({
    ...g, wr: pct(g.wins, g.n), avgPnl: g.totalPnl / g.n,
  })).sort((a, b) => b.n - a.n);

  // Cross-correlation: overlap between investor tickers and active trade tickers
  const invTickers = new Set(positionResults.map(p => p.ticker));
  const activeTickers = new Set(enriched.map(t => t.ticker));
  const overlap = [...invTickers].filter(t => activeTickers.has(t));
  const overlapActiveTrades = enriched.filter(t => invTickers.has(t.ticker));
  const nonOverlapTrades = enriched.filter(t => !invTickers.has(t.ticker));
  const overlapWR = overlapActiveTrades.length > 0
    ? pct(overlapActiveTrades.filter(t => t.isWin).length, overlapActiveTrades.length) : "0";
  const nonOverlapWR = nonOverlapTrades.length > 0
    ? pct(nonOverlapTrades.filter(t => t.isWin).length, nonOverlapTrades.length) : "0";
  const overlapPnl = overlapActiveTrades.reduce((s, t) => s + t.pnl, 0);
  const nonOverlapPnl = nonOverlapTrades.reduce((s, t) => s + t.pnl, 0);

  // PnL timeline for equity curve
  const sortedPositions = [...positionResults].sort((a, b) => {
    const aTs = Number(invPositions.find(p => p.id === a.id)?.closed_at || 0);
    const bTs = Number(invPositions.find(p => p.id === b.id)?.closed_at || 0);
    return aTs - bTs;
  });
  let cumPnl = 0;
  const invEquityCurve = sortedPositions.map(p => {
    cumPnl += p.pnl;
    return { ticker: p.ticker, pnl: p.pnl, cumPnl, holdDays: p.holdDays };
  });

  // Hold duration buckets
  const holdBuckets = { "0-1 day": { w: 0, l: 0, pnl: 0 }, "1-3 days": { w: 0, l: 0, pnl: 0 }, "3-7 days": { w: 0, l: 0, pnl: 0 }, "7+ days": { w: 0, l: 0, pnl: 0 } };
  for (const p of positionResults) {
    const bucket = p.holdDays <= 1 ? "0-1 day" : p.holdDays <= 3 ? "1-3 days" : p.holdDays <= 7 ? "3-7 days" : "7+ days";
    holdBuckets[bucket][p.pnl > 0 ? "w" : "l"]++;
    holdBuckets[bucket].pnl += p.pnl;
  }

  return {
    summary: {
      totalPositions: positionResults.length,
      totalInvested, totalReturned, totalPnl,
      winRate: pct(invWins.length, positionResults.length),
      wins: invWins.length, losses: invLosses.length,
      avgPnl: positionResults.length > 0 ? totalPnl / positionResults.length : 0,
      avgHoldDays: positionResults.length > 0
        ? (positionResults.reduce((s, p) => s + p.holdDays, 0) / positionResults.length).toFixed(1) : "0",
      avgWin: invWins.length > 0 ? invWins.reduce((s, p) => s + p.pnl, 0) / invWins.length : 0,
      avgLoss: invLosses.length > 0 ? invLosses.reduce((s, p) => s + p.pnl, 0) / invLosses.length : 0,
    },
    byInvTicker,
    byExitReasonInv,
    crossCorrelation: {
      overlapTickers: overlap,
      overlapTradeCount: overlapActiveTrades.length,
      overlapWR, overlapPnl,
      nonOverlapTradeCount: nonOverlapTrades.length,
      nonOverlapWR, nonOverlapPnl,
      invTickers: [...invTickers],
      activeTickers: [...activeTickers],
    },
    invEquityCurve,
    holdBuckets,
    positions: positionResults,
  };
})();

// ═══════════════════════════════════════════════════════════════════════════════
// 2m. AUTO-RECOMMENDATION ENGINE
// Categorized, prioritized, data-driven recommendations
// ═══════════════════════════════════════════════════════════════════════════════

console.log("🧠 Running auto-recommendation engine...");

const recommendations = [];
const MIN_SAMPLE = 3;

function recHelper(arr) {
  const w = arr.filter(t => t.isWin).length;
  const l = arr.filter(t => t.isLoss).length;
  const wr = arr.length > 0 ? (w / arr.length * 100) : 0;
  const totalPnl = arr.reduce((s, t) => s + t.pnl, 0);
  const avgPnl = arr.length > 0 ? totalPnl / arr.length : 0;
  return { n: arr.length, w, l, wr: wr.toFixed(1), totalPnl, avgPnl };
}

// ────────────────────────────────────────────────────────────────────────────
// CATEGORY 1: ENTRY SIGNAL QUALITY
// ────────────────────────────────────────────────────────────────────────────

// 1a. RSI overbought/oversold at entry (per TF)
for (const tf of ["15m", "30m", "1H"]) {
  const rsiOver70 = enriched.filter(t => { const r = t.tfSignals[tf]?.signals?.rsi; return r != null && r > 70; });
  const rsiUnder30 = enriched.filter(t => { const r = t.tfSignals[tf]?.signals?.rsi; return r != null && r < 30; });
  if (rsiOver70.length >= MIN_SAMPLE) {
    const s = recHelper(rsiOver70);
    recommendations.push({
      category: "entry", priority: Number(s.wr) < 40 ? 1 : 3,
      type: Number(s.wr) < 50 ? "warning" : "info",
      title: `${tf} RSI > 70 at Entry`,
      text: `${s.wr}% WR (${s.n} trades, ${fmt$(s.totalPnl)}). ${Number(s.wr) < 40 ? "Strong signal to BLOCK overbought entries on " + tf + "." : Number(s.wr) < 50 ? "Consider adding a caution gate." : "Still profitable despite overbought condition."}`,
      action: Number(s.wr) < 40 ? "Block entries when " + tf + " RSI > 70" : null,
    });
  }
  if (rsiUnder30.length >= MIN_SAMPLE) {
    const s = recHelper(rsiUnder30);
    recommendations.push({
      category: "entry", priority: 3,
      type: Number(s.wr) >= 60 ? "success" : "info",
      title: `${tf} RSI < 30 at Entry`,
      text: `${s.wr}% WR (${s.n} trades, ${fmt$(s.totalPnl)}). ${Number(s.wr) >= 60 ? "Oversold entries on " + tf + " are working well." : "Oversold bounces are hit-or-miss."}`,
    });
  }
}

// 1b. EMA cross alignment
const bullCross4H = enriched.filter(t => t.tfSignals["4H"]?.signals?.ema_cross === 1);
const bearCross4H = enriched.filter(t => t.tfSignals["4H"]?.signals?.ema_cross === -1);
if (bullCross4H.length >= MIN_SAMPLE) {
  const s = recHelper(bullCross4H);
  recommendations.push({
    category: "entry", priority: 3,
    type: Number(s.wr) >= 60 ? "success" : "info",
    title: "4H EMA Bull Cross at Entry",
    text: `${s.wr}% WR (${s.n} trades, ${fmt$(s.totalPnl)}). ${Number(s.wr) >= 60 ? "4H bullish EMA cross is a reliable entry confirmation." : "4H bull cross alone doesn't guarantee wins."}`,
  });
}
if (bearCross4H.length >= MIN_SAMPLE) {
  const s = recHelper(bearCross4H);
  recommendations.push({
    category: "entry", priority: Number(s.wr) < 40 ? 1 : 3,
    type: Number(s.wr) < 50 ? "warning" : "info",
    title: "4H EMA Bear Cross at Entry",
    text: `${s.wr}% WR (${s.n} trades, ${fmt$(s.totalPnl)}). ${Number(s.wr) < 40 ? "Entering LONG against 4H bearish EMA = high-failure pattern." : "Mixed results entering against 4H trend."}`,
    action: Number(s.wr) < 40 ? "Require 4H EMA bull cross for LONG entries" : null,
  });
}

// 1c. SuperTrend alignment across TFs
const stAligned = enriched.filter(t => {
  let bull = 0;
  for (const tf of ["1H", "4H", "D"]) { if (t.tfSignals[tf]?.signals?.supertrend === 1) bull++; }
  return bull >= 3;
});
const stMisaligned = enriched.filter(t => {
  let bull = 0, bear = 0;
  for (const tf of ["1H", "4H", "D"]) {
    if (t.tfSignals[tf]?.signals?.supertrend === 1) bull++;
    else if (t.tfSignals[tf]?.signals?.supertrend === -1) bear++;
  }
  return bull > 0 && bear > 0;
});
if (stAligned.length >= MIN_SAMPLE && stMisaligned.length >= MIN_SAMPLE) {
  const sa = recHelper(stAligned), sm = recHelper(stMisaligned);
  const delta = Number(sa.wr) - Number(sm.wr);
  recommendations.push({
    category: "entry", priority: delta > 15 ? 1 : 2,
    type: delta > 15 ? "success" : "info",
    title: "SuperTrend Multi-TF Alignment",
    text: `Aligned (1H+4H+D all bull): ${sa.wr}% WR (${sa.n} trades, ${fmt$(sa.totalPnl)}) vs Misaligned: ${sm.wr}% WR (${sm.n} trades, ${fmt$(sm.totalPnl)}). ${delta > 15 ? "Alignment is a STRONG edge (+"+delta.toFixed(0)+"% WR). Prioritize aligned setups." : "Modest alignment effect."}`,
    action: delta > 15 ? "Boost setup_grade when 1H/4H/D SuperTrend all agree" : null,
  });
}

// 1d. EMA Depth sweet spot
for (const tf of ["1H", "4H"]) {
  const shallow = enriched.filter(t => { const d = t.tfSignals[tf]?.signals?.ema_depth; return d != null && d < 4; });
  const deep = enriched.filter(t => { const d = t.tfSignals[tf]?.signals?.ema_depth; return d != null && d >= 8; });
  if (shallow.length >= MIN_SAMPLE && deep.length >= MIN_SAMPLE) {
    const ss = recHelper(shallow), sd = recHelper(deep);
    const delta = Number(sd.wr) - Number(ss.wr);
    recommendations.push({
      category: "entry", priority: Math.abs(delta) > 15 ? 2 : 3,
      type: delta > 10 ? "success" : delta < -10 ? "warning" : "info",
      title: `${tf} EMA Depth`,
      text: `Shallow (<4): ${ss.wr}% WR (${ss.n}) vs Deep (8+): ${sd.wr}% WR (${sd.n}). ${delta > 10 ? "Deep EMA stack on " + tf + " confirms trend conviction." : delta < -10 ? "Surprisingly, shallow depth outperforms on " + tf + "." : "Similar performance regardless of depth."}`,
      action: delta > 15 ? "Prefer entries when " + tf + " EMA depth >= 8" : null,
    });
  }
}

// 1e. Signal alignment score
const highAlign = alignmentData.filter(d => d.alignScore >= 80);
const midAlign = alignmentData.filter(d => d.alignScore >= 50 && d.alignScore < 80);
const lowAlign = alignmentData.filter(d => d.alignScore < 50);
if (highAlign.length >= MIN_SAMPLE && lowAlign.length >= MIN_SAMPLE) {
  const hi = recHelper(highAlign.map(d => enriched.find(t => t.ticker === d.ticker && t.isWin === d.isWin) || { pnl: 0, isWin: d.isWin, isLoss: !d.isWin }));
  const lo = recHelper(lowAlign.map(d => enriched.find(t => t.ticker === d.ticker && t.isWin === d.isWin) || { pnl: 0, isWin: d.isWin, isLoss: !d.isWin }));
  const hiWR = pct(highAlign.filter(d => d.isWin).length, highAlign.length);
  const loWR = pct(lowAlign.filter(d => d.isWin).length, lowAlign.length);
  const delta = Number(hiWR) - Number(loWR);
  recommendations.push({
    category: "entry", priority: delta > 15 ? 1 : 2,
    type: delta > 15 ? "success" : "info",
    title: "Multi-TF Signal Alignment",
    text: `80%+ aligned: ${hiWR}% WR (${highAlign.length} trades) vs <50%: ${loWR}% WR (${lowAlign.length} trades). ${delta > 15 ? "Strong correlation. Require minimum alignment for entry." : "Alignment matters but isn't decisive alone."}`,
    action: delta > 15 ? "Set minimum alignment score threshold of 60% for entry" : null,
  });
}

// 1f. TD Sequential exhaustion at entry
if (tdAnalysis.atEntry.length >= MIN_SAMPLE) {
  const tdHigh = tdAnalysis.atEntry.filter(d => d.maxBearPrep >= 7 || d.maxBullPrep >= 7);
  const tdLow = tdAnalysis.atEntry.filter(d => d.maxBearPrep < 5 && d.maxBullPrep < 5);
  if (tdHigh.length >= MIN_SAMPLE) {
    const s = recHelper(tdHigh);
    recommendations.push({
      category: "entry", priority: Number(s.wr) < 40 ? 1 : 3,
      type: Number(s.wr) < 40 ? "warning" : "info",
      title: "TD Sequential Exhaustion Near Completion (7+)",
      text: `Entries when any TF has prep count >= 7: ${s.wr}% WR (${s.n} trades, ${fmt$(s.totalPnl)}). ${Number(s.wr) < 40 ? "Entering near exhaustion completion is dangerous — the move may reverse." : "Exhaustion count doesn't strongly predict failure."}`,
      action: Number(s.wr) < 40 ? "Block entries when any TF bear/bull prep >= 7" : null,
    });
  }
}

// 1g. Phase oscillator zones at entry
if (phaseAnalysis.length >= MIN_SAMPLE) {
  const phaseOverbought = phaseAnalysis.filter(d => d.phaseD != null && d.phaseD > 60);
  const phaseOversold = phaseAnalysis.filter(d => d.phaseD != null && d.phaseD < -60);
  const phaseNeutral = phaseAnalysis.filter(d => d.phaseD != null && Math.abs(d.phaseD) <= 30);
  if (phaseOverbought.length >= MIN_SAMPLE) {
    const s = recHelper(phaseOverbought);
    recommendations.push({
      category: "entry", priority: Number(s.wr) < 40 ? 1 : 3,
      type: Number(s.wr) < 50 ? "warning" : "info",
      title: "Phase Oscillator Overbought (D > 60)",
      text: `${s.wr}% WR (${s.n} trades, ${fmt$(s.totalPnl)}). ${Number(s.wr) < 50 ? "LONG entries in overbought daily phase are struggling." : "Still working despite extended phase."}`,
      action: Number(s.wr) < 40 ? "Reduce position size when Daily Phase > 60" : null,
    });
  }
  if (phaseOversold.length >= MIN_SAMPLE) {
    const s = recHelper(phaseOversold);
    recommendations.push({
      category: "entry", priority: 3,
      type: Number(s.wr) >= 60 ? "success" : "info",
      title: "Phase Oscillator Oversold (D < -60)",
      text: `${s.wr}% WR (${s.n} trades, ${fmt$(s.totalPnl)}). ${Number(s.wr) >= 60 ? "Buying oversold daily phase is working well." : "Oversold bounces not consistently profitable."}`,
    });
  }
}

// 1h. Entry quality score effectiveness
if (eqData.length >= MIN_SAMPLE * 2) {
  const highEQ = eqData.filter(d => d.score >= 70);
  const lowEQ = eqData.filter(d => d.score < 40);
  if (highEQ.length >= MIN_SAMPLE && lowEQ.length >= MIN_SAMPLE) {
    const hWR = pct(highEQ.filter(d => d.isWin).length, highEQ.length);
    const lWR = pct(lowEQ.filter(d => d.isWin).length, lowEQ.length);
    const delta = Number(hWR) - Number(lWR);
    recommendations.push({
      category: "entry", priority: delta > 20 ? 1 : 2,
      type: delta > 15 ? "success" : delta < -5 ? "warning" : "info",
      title: "Entry Quality Score Validation",
      text: `EQ >= 70: ${hWR}% WR (${highEQ.length} trades) vs EQ < 40: ${lWR}% WR (${lowEQ.length} trades). ${delta > 15 ? "EQ score is a STRONG predictor. Trust it." : delta < 0 ? "EQ score is not predicting correctly — needs recalibration." : "Modest predictive value."}`,
      action: delta > 15 ? "Gate entries: require EQ score >= 50" : delta < 0 ? "Recalibrate EQ score weights" : null,
    });
  }
}

// 1i. Danger score as filter
if (dangerData.length >= MIN_SAMPLE * 2) {
  const highDanger = dangerData.filter(d => d.danger >= 60);
  const lowDanger = dangerData.filter(d => d.danger < 30);
  if (highDanger.length >= MIN_SAMPLE && lowDanger.length >= MIN_SAMPLE) {
    const hWR = pct(highDanger.filter(d => d.isWin).length, highDanger.length);
    const lWR = pct(lowDanger.filter(d => d.isWin).length, lowDanger.length);
    const delta = Number(lWR) - Number(hWR);
    recommendations.push({
      category: "entry", priority: delta > 20 ? 1 : 2,
      type: delta > 15 ? "success" : "info",
      title: "Danger Score as Entry Filter",
      text: `Low danger (<30): ${lWR}% WR (${lowDanger.length} trades) vs High danger (60+): ${hWR}% WR (${highDanger.length} trades). ${delta > 15 ? "Danger score IS protecting us. High-danger entries fail more often." : "Danger score has modest predictive value."}`,
      action: delta > 20 ? "Tighten: block entries when danger score >= 70" : null,
    });
  }
}

// ────────────────────────────────────────────────────────────────────────────
// CATEGORY 2: EXIT & TRADE MANAGEMENT
// ────────────────────────────────────────────────────────────────────────────

// 2a. MFE capture efficiency
const mfeTrades = enriched.filter(t => t.mfe != null && t.mfe > 0);
if (mfeTrades.length >= MIN_SAMPLE) {
  const avgCapture = mfeTrades.reduce((s, t) => s + (t.pnlPct / t.mfe), 0) / mfeTrades.length * 100;
  const leftOnTable = mfeTrades.reduce((s, t) => s + (t.mfe - Math.max(0, t.pnlPct)), 0) / mfeTrades.length;
  recommendations.push({
    category: "exit", priority: avgCapture < 40 ? 1 : 2,
    type: avgCapture < 30 ? "warning" : avgCapture > 60 ? "success" : "info",
    title: "MFE Capture Efficiency",
    text: `Avg capture: ${avgCapture.toFixed(0)}% of MFE. Avg left on table: ${leftOnTable.toFixed(2)}% per trade. ${avgCapture < 30 ? "CRITICAL: exits are capturing less than a third of available move. Trail stops may be too tight." : avgCapture < 50 ? "Moderate — room to improve exit timing." : "Good capture of available moves."}`,
    action: avgCapture < 40 ? "Widen trail stop or add runner logic to capture more of the move" : null,
  });
}

// 2b. MAE analysis — optimal stop level
const maeTrades = enriched.filter(t => t.mae != null);
if (maeTrades.length >= MIN_SAMPLE * 2) {
  const winMAE = wins.filter(t => t.mae != null);
  const lossMAE = losses.filter(t => t.mae != null);
  if (winMAE.length > 0 && lossMAE.length > 0) {
    const avgWinMAE = winMAE.reduce((s, t) => s + t.mae, 0) / winMAE.length;
    const avgLossMAE = lossMAE.reduce((s, t) => s + t.mae, 0) / lossMAE.length;
    const maxWinMAE = Math.max(...winMAE.map(t => t.mae));
    recommendations.push({
      category: "exit", priority: 2,
      type: "info",
      title: "MAE-Based Stop Loss Optimization",
      text: `Avg winner drawdown: ${avgWinMAE.toFixed(2)}%, max winner drawdown: ${maxWinMAE.toFixed(2)}%. Avg loser drawdown: ${avgLossMAE.toFixed(2)}%. ${maxWinMAE < avgLossMAE ? "Winners never draw down as far as losers — you could tighten stops to " + (maxWinMAE * 1.2).toFixed(2) + "% and cut losers faster." : "Some winners have significant drawdowns — be careful tightening stops too much."}`,
      action: maxWinMAE < avgLossMAE ? "Consider stop at " + (maxWinMAE * 1.2).toFixed(2) + "% (1.2x max winner MAE)" : null,
    });
  }
}

// 2c. Trim effectiveness
const trimmed = enriched.filter(t => t.trimmedPct > 0);
const untrimmed = enriched.filter(t => t.trimmedPct === 0);
if (trimmed.length >= MIN_SAMPLE && untrimmed.length >= MIN_SAMPLE) {
  const st = recHelper(trimmed), su = recHelper(untrimmed);
  recommendations.push({
    category: "exit", priority: 2,
    type: Number(st.wr) > Number(su.wr) ? "success" : "info",
    title: "Trim Effectiveness",
    text: `Trimmed trades: ${st.wr}% WR, ${fmt$(st.avgPnl)} avg (${st.n} trades). Untrimmed: ${su.wr}% WR, ${fmt$(su.avgPnl)} avg (${su.n} trades). ${Number(st.wr) > Number(su.wr) + 10 ? "Trimming is protecting profits effectively." : "Trimming doesn't significantly improve outcomes."}`,
    action: Number(st.wr) < Number(su.wr) - 10 ? "Review trim triggers — may be cutting winners too early" : null,
  });
}

// 2d. Best & worst exit signals
const exitsSorted = byExitReason.filter(r => r.n >= 2).sort((a, b) => Number(b.wr) - Number(a.wr));
if (exitsSorted.length >= 2) {
  const best = exitsSorted[0];
  const worst = exitsSorted[exitsSorted.length - 1];
  recommendations.push({
    category: "exit", priority: 2,
    type: "success",
    title: "Best Exit Signal",
    text: `"${best.key}" — ${best.wr}% WR, ${fmt$(best.avgPnl)} avg across ${best.n} trades. This exit trigger produces the best outcomes.`,
    action: "Lower threshold to trigger this exit more often",
  });
  if (Number(worst.wr) < 40) {
    recommendations.push({
      category: "exit", priority: 1,
      type: "warning",
      title: "Worst Exit Signal",
      text: `"${worst.key}" — ${worst.wr}% WR, ${fmt$(worst.avgPnl)} avg across ${worst.n} trades. This exit is not working well.`,
      action: "Review and potentially disable or modify this exit trigger",
    });
  }
}

// 2e. Tiny wins — exits firing too early
const tinyWins = wins.filter(t => t.pnl > 0 && t.pnl < 5);
if (tinyWins.length > wins.length * 0.3 && tinyWins.length >= MIN_SAMPLE) {
  recommendations.push({
    category: "exit", priority: 1,
    type: "warning",
    title: "Premature Exit Pattern",
    text: `${tinyWins.length}/${wins.length} wins (${pct(tinyWins.length, wins.length)}%) are under $5. Exits are firing too early on winners — most of the winning move is being left on the table.`,
    action: "Widen trail stops, increase minimum profit target, or add runner tier for winners",
  });
}

// ────────────────────────────────────────────────────────────────────────────
// CATEGORY 3: REGIME & MARKET CONTEXT
// ────────────────────────────────────────────────────────────────────────────

// 3a. Best and worst regimes
const regimesSorted = byRegime.filter(r => r.n >= MIN_SAMPLE).sort((a, b) => Number(b.wr) - Number(a.wr));
if (regimesSorted.length >= 1) {
  const best = regimesSorted[0];
  recommendations.push({
    category: "regime", priority: 2,
    type: "success",
    title: "Best Market Regime",
    text: `${best.key} — ${best.wr}% WR across ${best.n} trades (${fmt$(best.totalPnl)}). This is where the system works best.`,
    action: "Increase position sizing in " + best.key + " regime",
  });
  const worst = regimesSorted[regimesSorted.length - 1];
  if (worst !== best && Number(worst.wr) < 50) {
    recommendations.push({
      category: "regime", priority: 1,
      type: "warning",
      title: "Worst Market Regime",
      text: `${worst.key} — ${worst.wr}% WR across ${worst.n} trades (${fmt$(worst.totalPnl)}). Consider reducing activity or tightening entry gates.`,
      action: "Reduce position size or raise entry quality threshold in " + worst.key,
    });
  }
}

// 3b. Setup grade effectiveness
const gradesSorted = byGrade.filter(g => g.n >= MIN_SAMPLE).sort((a, b) => Number(b.wr) - Number(a.wr));
if (gradesSorted.length >= 2) {
  const best = gradesSorted[0];
  const worst = gradesSorted[gradesSorted.length - 1];
  recommendations.push({
    category: "regime", priority: Number(best.wr) - Number(worst.wr) > 20 ? 1 : 2,
    type: "info",
    title: "Setup Grade Validation",
    text: `Best grade: ${best.key} at ${best.wr}% WR (${best.n} trades). Worst grade: ${worst.key} at ${worst.wr}% WR (${worst.n} trades). ${Number(best.wr) - Number(worst.wr) > 20 ? "Grading system has strong predictive power." : "Grading differentiates modestly."}`,
    action: Number(worst.wr) < 40 ? "Consider blocking " + worst.key + " grade entries or demoting to smaller size" : null,
  });
}

// 3c. VIX environment
const vixTrades = enriched.filter(t => t.vix != null);
if (vixTrades.length >= MIN_SAMPLE * 2) {
  const lowVix = vixTrades.filter(t => t.vix < 18);
  const highVix = vixTrades.filter(t => t.vix >= 25);
  const midVix = vixTrades.filter(t => t.vix >= 18 && t.vix < 25);
  const results = [];
  if (lowVix.length >= MIN_SAMPLE) { const s = recHelper(lowVix); results.push(`Low VIX (<18): ${s.wr}% WR (${s.n})`); }
  if (midVix.length >= MIN_SAMPLE) { const s = recHelper(midVix); results.push(`Mid VIX (18-25): ${s.wr}% WR (${s.n})`); }
  if (highVix.length >= MIN_SAMPLE) { const s = recHelper(highVix); results.push(`High VIX (25+): ${s.wr}% WR (${s.n})`); }
  if (results.length >= 2) {
    recommendations.push({
      category: "regime", priority: 3,
      type: "info",
      title: "VIX Environment Impact",
      text: results.join(" | ") + ". Use VIX level to adjust position sizing and entry gates.",
    });
  }
}

// 3d. RVOL effectiveness
const rvolTrades = enriched.filter(t => t.rvol != null);
if (rvolTrades.length >= MIN_SAMPLE * 2) {
  const lowRvol = rvolTrades.filter(t => t.rvol < 0.8);
  const highRvol = rvolTrades.filter(t => t.rvol >= 1.5);
  if (lowRvol.length >= MIN_SAMPLE && highRvol.length >= MIN_SAMPLE) {
    const sl = recHelper(lowRvol), sh = recHelper(highRvol);
    recommendations.push({
      category: "regime", priority: 2,
      type: Number(sh.wr) > Number(sl.wr) + 10 ? "success" : "info",
      title: "RVOL at Entry",
      text: `Low RVOL (<0.8): ${sl.wr}% WR (${sl.n} trades). High RVOL (1.5+): ${sh.wr}% WR (${sh.n} trades). ${Number(sh.wr) > Number(sl.wr) + 10 ? "Volume confirmation matters." : "Volume alone doesn't differentiate outcomes."}`,
      action: Number(sl.wr) < 40 ? "Require RVOL >= 0.8 minimum for entries" : null,
    });
  }
}

// 3e. Direction balance
const shorts = enriched.filter(t => t.direction === "SHORT");
const longs = enriched.filter(t => t.direction === "LONG");
if (shorts.length === 0) {
  recommendations.push({
    category: "regime", priority: 2,
    type: "warning",
    title: "No SHORT Trades",
    text: "Zero SHORT trades taken. Entire downside of market untapped during bearish moves.",
    action: "Review SHORT entry gates: CHOPPY regime block, RVOL minimum, bearish momentum path",
  });
} else if (shorts.length >= MIN_SAMPLE && longs.length >= MIN_SAMPLE) {
  const ss = recHelper(shorts), sl = recHelper(longs);
  recommendations.push({
    category: "regime", priority: 2,
    type: "info",
    title: "LONG vs SHORT Performance",
    text: `LONG: ${sl.wr}% WR (${sl.n} trades, ${fmt$(sl.totalPnl)}). SHORT: ${ss.wr}% WR (${ss.n} trades, ${fmt$(ss.totalPnl)}). ${Number(ss.wr) < Number(sl.wr) - 20 ? "Shorts are significantly underperforming longs." : "Both directions performing comparably."}`,
    action: Number(ss.wr) < 30 ? "Tighten SHORT entry criteria" : null,
  });
}

// ────────────────────────────────────────────────────────────────────────────
// CATEGORY 4: TIMING & DURATION
// ────────────────────────────────────────────────────────────────────────────

// 4a. Entry hour analysis
const hourGroups = groupBy(enriched, t => t.entryHourET);
const significantHours = Object.entries(hourGroups).filter(([_, trades]) => trades.length >= MIN_SAMPLE);
if (significantHours.length >= 2) {
  const hourWR = significantHours.map(([hour, trades]) => {
    const s = recHelper(trades);
    return { hour: Number(hour), wr: Number(s.wr), n: trades.length, totalPnl: s.totalPnl };
  }).sort((a, b) => b.wr - a.wr);
  const best = hourWR[0];
  const worst = hourWR[hourWR.length - 1];
  if (best.wr - worst.wr > 20) {
    recommendations.push({
      category: "timing", priority: 2,
      type: "info",
      title: "Optimal Entry Window",
      text: `Best hour: ${best.hour}:00 ET — ${best.wr.toFixed(1)}% WR (${best.n} trades). Worst hour: ${worst.hour}:00 ET — ${worst.wr.toFixed(1)}% WR (${worst.n} trades). Spread: ${(best.wr - worst.wr).toFixed(0)}%.`,
      action: worst.wr < 35 ? "Avoid entries at " + worst.hour + ":00 ET" : null,
    });
  }
}

// 4b. Day of week
const dowGroups = groupBy(enriched, t => ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][t.entryDow]);
const significantDows = Object.entries(dowGroups).filter(([_, trades]) => trades.length >= MIN_SAMPLE);
if (significantDows.length >= 3) {
  const dowWR = significantDows.map(([day, trades]) => {
    const s = recHelper(trades);
    return { day, wr: Number(s.wr), n: trades.length };
  }).sort((a, b) => b.wr - a.wr);
  const best = dowWR[0], worst = dowWR[dowWR.length - 1];
  if (best.wr - worst.wr > 20) {
    recommendations.push({
      category: "timing", priority: 3,
      type: "info",
      title: "Day-of-Week Pattern",
      text: `Best day: ${best.day} — ${best.wr.toFixed(1)}% WR (${best.n} trades). Worst day: ${worst.day} — ${worst.wr.toFixed(1)}% WR (${worst.n} trades).`,
      action: worst.wr < 35 ? "Consider pausing or reducing size on " + worst.day + "s" : null,
    });
  }
}

// 4c. Hold duration analysis
if (holdDurationData.length >= MIN_SAMPLE * 3) {
  const shortHold = holdDurationData.filter(d => d.hours < 4);
  const medHold = holdDurationData.filter(d => d.hours >= 4 && d.hours < 24);
  const longHold = holdDurationData.filter(d => d.hours >= 24);
  const groups = [];
  if (shortHold.length >= MIN_SAMPLE) { const s = recHelper(shortHold); groups.push({ label: "<4h", wr: s.wr, n: s.n, avgPnl: s.avgPnl }); }
  if (medHold.length >= MIN_SAMPLE) { const s = recHelper(medHold); groups.push({ label: "4-24h", wr: s.wr, n: s.n, avgPnl: s.avgPnl }); }
  if (longHold.length >= MIN_SAMPLE) { const s = recHelper(longHold); groups.push({ label: "24h+", wr: s.wr, n: s.n, avgPnl: s.avgPnl }); }
  if (groups.length >= 2) {
    recommendations.push({
      category: "timing", priority: 2,
      type: "info",
      title: "Hold Duration vs Outcome",
      text: groups.map(g => `${g.label}: ${g.wr}% WR (${g.n} trades, ${fmt$(g.avgPnl)} avg)`).join(" | "),
      action: groups.some(g => Number(g.wr) < 35 && g.n >= MIN_SAMPLE) ? "Reduce max hold for underperforming duration bucket" : null,
    });
  }
}

// 4d. Entry path: confirmed vs early
const confirmed = enriched.filter(t => t.entryPath.toLowerCase().includes("confirmed"));
const early = enriched.filter(t => t.entryPath.toLowerCase().includes("early"));
if (confirmed.length >= MIN_SAMPLE && early.length >= MIN_SAMPLE) {
  const sc = recHelper(confirmed), se = recHelper(early);
  const delta = Number(sc.wr) - Number(se.wr);
  recommendations.push({
    category: "timing", priority: delta > 15 ? 1 : 3,
    type: delta > 15 ? "success" : "info",
    title: "Confirmed vs Early Entry Path",
    text: `Confirmed: ${sc.wr}% WR (${sc.n} trades, ${fmt$(sc.avgPnl)} avg). Early: ${se.wr}% WR (${se.n} trades, ${fmt$(se.avgPnl)} avg). ${delta > 15 ? "Waiting for confirmation is significantly better." : "Similar performance."}`,
    action: delta > 20 ? "Increase weight on confirmed path; reduce early path sizing" : null,
  });
}

// ────────────────────────────────────────────────────────────────────────────
// CATEGORY 5: TICKER-SPECIFIC
// ────────────────────────────────────────────────────────────────────────────

// 5a. Consistently winning tickers
const tickersSorted = byTicker.filter(t => t.n >= MIN_SAMPLE).sort((a, b) => Number(b.wr) - Number(a.wr));
if (tickersSorted.length >= 2) {
  const topTickers = tickersSorted.filter(t => Number(t.wr) >= 60);
  if (topTickers.length > 0) {
    recommendations.push({
      category: "ticker", priority: 2,
      type: "success",
      title: "High Win-Rate Tickers",
      text: topTickers.map(t => `${t.key}: ${t.wr}% WR (${t.n} trades, ${fmt$(t.totalPnl)})`).join(", ") + ". These tickers suit the system well.",
      action: "Consider increasing allocation or frequency for these tickers",
    });
  }
  const bottomTickers = tickersSorted.filter(t => Number(t.wr) < 40 && t.n >= MIN_SAMPLE);
  if (bottomTickers.length > 0) {
    recommendations.push({
      category: "ticker", priority: 1,
      type: "warning",
      title: "Underperforming Tickers",
      text: bottomTickers.map(t => `${t.key}: ${t.wr}% WR (${t.n} trades, ${fmt$(t.totalPnl)})`).join(", ") + ". These tickers are dragging performance.",
      action: "Review ticker profiles; consider exclusion or tighter entry gates",
    });
  }
}

// 5b. Ticker personality vs outcome
const personalityMap = groupBy(enriched.filter(t => t.personality), t => t.personality);
const personalityStats = computeGroupStats(personalityMap).filter(g => g.n >= MIN_SAMPLE);
if (personalityStats.length >= 2) {
  const bestP = personalityStats.sort((a, b) => Number(b.wr) - Number(a.wr))[0];
  const worstP = personalityStats[personalityStats.length - 1];
  recommendations.push({
    category: "ticker", priority: 2,
    type: "info",
    title: "Ticker Personality Match",
    text: `Best personality: ${bestP.key} — ${bestP.wr}% WR (${bestP.n} trades). Worst: ${worstP.key} — ${worstP.wr}% WR (${worstP.n} trades). Tailor strategy to personality type.`,
    action: Number(worstP.wr) < 35 ? "Review execution profile for " + worstP.key + " personality" : null,
  });
}

// ────────────────────────────────────────────────────────────────────────────
// CATEGORY 6: INVESTOR ENGINE
// ────────────────────────────────────────────────────────────────────────────

if (investorAnalysis.summary.totalPositions > 0) {
  const invWR = Number(investorAnalysis.summary.winRate);
  recommendations.push({
    category: "investor", priority: invWR < 40 ? 1 : 3,
    type: invWR >= 50 ? "success" : "warning",
    title: "Investor Engine Performance",
    text: `${investorAnalysis.summary.winRate}% WR across ${investorAnalysis.summary.totalPositions} positions. Total P&L: ${fmt$(investorAnalysis.summary.totalPnl)}, avg hold: ${investorAnalysis.summary.avgHoldDays} days, avg P&L: ${fmt$(investorAnalysis.summary.avgPnl)}.`,
    action: invWR < 40 ? "Review investor scoring thresholds and accumulation zone detection" : null,
  });

  const cc = investorAnalysis.crossCorrelation;
  if (cc.overlapTradeCount > 0 && cc.nonOverlapTradeCount > 0) {
    const delta = Number(cc.overlapWR) - Number(cc.nonOverlapWR);
    recommendations.push({
      category: "investor", priority: Math.abs(delta) > 15 ? 1 : 3,
      type: delta > 10 ? "success" : delta < -10 ? "warning" : "info",
      title: "Investor-Active Trade Cross-Correlation",
      text: `Active trades on investor tickers: ${cc.overlapWR}% WR (${cc.overlapTradeCount} trades). Non-investor tickers: ${cc.nonOverlapWR}% WR (${cc.nonOverlapTradeCount} trades). ${delta > 10 ? "Investor signal adds alpha — active trades on investor-favored tickers win more." : delta < -10 ? "Investor-favored tickers underperform in active trades — signals may be conflicting." : "No significant correlation."}`,
      action: delta > 15 ? "Use investor score as a positive bias for active trade entries" : delta < -15 ? "Investigate why investor and active engines disagree" : null,
    });
  }

  const worstInv = investorAnalysis.byInvTicker.filter(t => t.n >= 2).sort((a, b) => a.totalPnl - b.totalPnl)[0];
  if (worstInv && worstInv.totalPnl < 0) {
    recommendations.push({
      category: "investor", priority: 2,
      type: "warning",
      title: "Worst Investor Ticker",
      text: `${worstInv.ticker} — ${fmt$(worstInv.totalPnl)} across ${worstInv.n} positions (${worstInv.wr}% WR). Thesis or accumulation triggers need review.`,
      action: "Re-evaluate " + worstInv.ticker + " investor thesis and reduce allocation",
    });
  }
}

// ────────────────────────────────────────────────────────────────────────────
// CATEGORY 7: SYSTEM-LEVEL INSIGHTS
// ────────────────────────────────────────────────────────────────────────────

// 7a. Risk/reward ratio
if (overview.avgWin > 0 && overview.avgLoss < 0) {
  const rr = Math.abs(overview.avgWin / overview.avgLoss);
  recommendations.push({
    category: "system", priority: rr < 1 ? 1 : 2,
    type: rr >= 2 ? "success" : rr >= 1 ? "info" : "warning",
    title: "Risk/Reward Ratio",
    text: `Avg win: ${fmt$(overview.avgWin)}, avg loss: ${fmt$(overview.avgLoss)}. R:R = ${rr.toFixed(2)}:1. ${rr < 1 ? "Losses are bigger than wins — need better exits or tighter stops." : rr >= 2 ? "Excellent R:R, losses are well-controlled." : "Acceptable but room for improvement."}`,
    action: rr < 1 ? "Tighten stop losses and/or widen profit targets" : null,
  });
}

// 7b. Expectancy
recommendations.push({
  category: "system", priority: overview.expectancy < 0 ? 1 : 3,
  type: overview.expectancy > 0 ? "success" : "warning",
  title: "System Expectancy",
  text: `${fmt$(overview.expectancy)} per trade across ${overview.totalTrades} trades. ${overview.expectancy > 0 ? "System has positive expectancy — keep trading." : "NEGATIVE expectancy — system is losing money per trade on average."}`,
  action: overview.expectancy < 0 ? "Focus on fixing the highest-priority warnings above before taking more trades" : null,
});

// 7c. Profit factor
const pf = Number(overview.profitFactor);
if (Number.isFinite(pf)) {
  recommendations.push({
    category: "system", priority: pf < 1 ? 1 : 3,
    type: pf >= 2 ? "success" : pf >= 1.5 ? "info" : pf >= 1 ? "info" : "warning",
    title: "Profit Factor",
    text: `${pf.toFixed(2)} (gross wins / gross losses). ${pf >= 2 ? "Strong — system earns $2 for every $1 lost." : pf >= 1.5 ? "Good — healthy buffer." : pf >= 1 ? "Marginally profitable — small edge." : "Below 1.0 — system is a net loser."}`,
    action: pf < 1.5 ? "Improve by cutting low-WR entry patterns or tightening worst exits" : null,
  });
}

// 7d. Win streak / loss streak
let maxWinStreak = 0, maxLossStreak = 0, curW = 0, curL = 0;
for (const t of enriched) {
  if (t.isWin) { curW++; curL = 0; maxWinStreak = Math.max(maxWinStreak, curW); }
  else { curL++; curW = 0; maxLossStreak = Math.max(maxLossStreak, curL); }
}
if (maxLossStreak >= 4) {
  recommendations.push({
    category: "system", priority: maxLossStreak >= 6 ? 1 : 2,
    type: maxLossStreak >= 6 ? "warning" : "info",
    title: "Consecutive Loss Streak",
    text: `Max consecutive losses: ${maxLossStreak}. Max consecutive wins: ${maxWinStreak}. ${maxLossStreak >= 6 ? "6+ loss streak indicates potential regime-mismatch or over-trading. Consider adding a circuit breaker." : "Normal variance."}`,
    action: maxLossStreak >= 5 ? "Add daily loss-limit circuit breaker (e.g., stop after 3 consecutive losses)" : null,
  });
}

// Sort recommendations: priority 1 first, then by category
recommendations.sort((a, b) => (a.priority || 9) - (b.priority || 9));

console.log(`  Generated ${recommendations.length} recommendations (${recommendations.filter(r => r.priority === 1).length} high priority)`);

// ── Step 3: Build the analytics payload ────────────────────────────────────
const analyticsPayload = {
  generated: new Date().toISOString(),
  overview,
  byGrade, byRegime, byPath, byTicker, byExitReason,
  signalAnalysis,
  alignmentBuckets,
  tdAnalysis,
  phaseAnalysis,
  mfeMaeData,
  regimeVix,
  byVolTier,
  rvolData,
  byEntryHour, byDow,
  holdDurationData,
  eqData,
  dangerData,
  investorAnalysis,
  recommendations,
  trades: enriched.map(t => ({
    id: t.trade_id, ticker: t.ticker, direction: t.direction, status: t.status,
    pnl: t.pnl, pnlPct: t.pnlPct, grade: t.grade, regime: t.regime,
    entryPath: t.entryPath, exitReason: (t.exit_reason || "").split(",")[0],
    mfe: t.mfe, mae: t.mae, holdHours: t.holdHours, rvol: t.rvol,
    eqScore: t.eqScore, dangerScore: t.dangerScore, vix: t.vix,
    entryHourET: t.entryHourET, entryDow: t.entryDow,
    entryTs: t.entry_ts, exitTs: t.exit_ts,
  })),
};

// ── Step 4: Generate HTML canvas ───────────────────────────────────────────
console.log("🎨 Generating interactive HTML canvas...");

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Backtest Analysis Canvas</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"><\/script>
<style>
  :root{--bg:#0d1117;--surface:#161b22;--border:#30363d;--text:#e6edf3;--muted:#8b949e;--green:#22c55e;--red:#ef4444;--blue:#60a5fa;--amber:#f59e0b;--purple:#a78bfa;--teal:#14b8a6}
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:'Inter',system-ui,sans-serif;background:var(--bg);color:var(--text);font-size:13px;line-height:1.5}
  .header{padding:16px 24px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:16px}
  .header h1{font-size:18px;font-weight:700}
  .header .meta{color:var(--muted);font-size:12px}
  .tabs{display:flex;gap:2px;padding:8px 24px;border-bottom:1px solid var(--border);background:var(--surface);overflow-x:auto}
  .tab{padding:8px 16px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;color:var(--muted);white-space:nowrap;transition:all .15s}
  .tab:hover{color:var(--text);background:rgba(255,255,255,.04)}
  .tab.active{color:var(--blue);background:rgba(96,165,250,.1)}
  .panel{display:none;padding:24px;max-width:1400px;margin:0 auto}
  .panel.active{display:block}
  .grid{display:grid;gap:16px}
  .grid-2{grid-template-columns:1fr 1fr}
  .grid-3{grid-template-columns:1fr 1fr 1fr}
  .grid-4{grid-template-columns:1fr 1fr 1fr 1fr}
  .card{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:16px}
  .card h3{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:12px}
  .stat-value{font-size:28px;font-weight:800}
  .stat-label{font-size:11px;color:var(--muted);margin-top:2px}
  .stat-green{color:var(--green)}.stat-red{color:var(--red)}.stat-blue{color:var(--blue)}.stat-amber{color:var(--amber)}
  table{width:100%;border-collapse:collapse;font-size:12px}
  th{text-align:left;padding:6px 8px;font-size:10px;font-weight:700;text-transform:uppercase;color:var(--muted);border-bottom:1px solid var(--border)}
  td{padding:6px 8px;border-bottom:1px solid rgba(48,54,61,.5)}
  tr:hover td{background:rgba(255,255,255,.02)}
  .wr-bar{display:inline-block;height:6px;border-radius:3px;min-width:4px}
  .chart-wrap{position:relative;height:280px}
  .rec{padding:12px 16px;border-radius:8px;margin-bottom:8px;border-left:4px solid}
  .rec.success{background:rgba(34,197,94,.06);border-color:var(--green)}
  .rec.warning{background:rgba(239,68,68,.06);border-color:var(--red)}
  .rec.info{background:rgba(96,165,250,.06);border-color:var(--blue)}
  .rec-text{font-size:13px;line-height:1.5}
  @media(max-width:900px){.grid-2,.grid-3,.grid-4{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="header">
  <h1>Backtest Analysis</h1>
  <span class="meta">Generated ${new Date().toLocaleString()} &bull; ${enriched.length} trades</span>
</div>

<div class="tabs" id="tabs">
  <div class="tab active" data-panel="overview">Overview</div>
  <div class="tab" data-panel="signals">Entry Signals</div>
  <div class="tab" data-panel="exits">Exits & Management</div>
  <div class="tab" data-panel="regime">Regime & Volatility</div>
  <div class="tab" data-panel="tickers">Ticker Profiles</div>
  <div class="tab" data-panel="timing">Timing & Drawdown</div>
  <div class="tab" data-panel="investor">Investor Engine</div>
  <div class="tab" data-panel="recs">Recommendations</div>
  <div class="tab" data-panel="trades">All Trades</div>
</div>

<!-- ═══ OVERVIEW PANEL ═══ -->
<div class="panel active" id="panel-overview">
  <div class="grid grid-4" style="margin-bottom:16px">
    <div class="card"><div class="stat-value stat-blue">${overview.winRate}%</div><div class="stat-label">Win Rate (${wins.length}W / ${losses.length}L)</div></div>
    <div class="card"><div class="stat-value ${overview.totalPnl >= 0 ? 'stat-green' : 'stat-red'}">${fmt$(overview.totalPnl)}</div><div class="stat-label">Total P&L</div></div>
    <div class="card"><div class="stat-value stat-green">${fmt$(overview.avgWin)}</div><div class="stat-label">Avg Win</div></div>
    <div class="card"><div class="stat-value stat-red">${fmt$(overview.avgLoss)}</div><div class="stat-label">Avg Loss</div></div>
  </div>
  <div class="grid grid-4" style="margin-bottom:16px">
    <div class="card"><div class="stat-value stat-amber">${overview.profitFactor}</div><div class="stat-label">Profit Factor</div></div>
    <div class="card"><div class="stat-value">${fmt$(overview.expectancy)}</div><div class="stat-label">Expectancy / Trade</div></div>
    <div class="card"><div class="stat-value stat-green">${overview.bestTrade.ticker} +${fmt$(overview.bestTrade.pnl)}</div><div class="stat-label">Best Trade</div></div>
    <div class="card"><div class="stat-value stat-red">${overview.worstTrade.ticker} ${fmt$(overview.worstTrade.pnl)}</div><div class="stat-label">Worst Trade</div></div>
  </div>
  <div class="grid grid-2" style="margin-bottom:16px">
    <div class="card"><h3>Equity Curve</h3><div class="chart-wrap"><canvas id="equityChart"></canvas></div></div>
    <div class="card"><h3>P&L Distribution</h3><div class="chart-wrap"><canvas id="pnlDistChart"></canvas></div></div>
  </div>
  <div class="grid grid-2">
    <div class="card"><h3>By Setup Grade</h3>${renderGroupTable(byGrade)}</div>
    <div class="card"><h3>By Regime</h3>${renderGroupTable(byRegime)}</div>
  </div>
  <div class="grid grid-2" style="margin-top:16px">
    <div class="card"><h3>By Entry Path</h3>${renderGroupTable(byPath)}</div>
    <div class="card"><h3>By Exit Reason</h3>${renderGroupTable(byExitReason)}</div>
  </div>
</div>

<!-- ═══ SIGNALS PANEL ═══ -->
<div class="panel" id="panel-signals">
  <div class="grid grid-2" style="margin-bottom:16px">
    <div class="card"><h3>EMA Cross Alignment vs Outcome</h3><div class="chart-wrap"><canvas id="emaCrossChart"></canvas></div></div>
    <div class="card"><h3>Signal Alignment Score vs Win Rate</h3><div class="chart-wrap"><canvas id="alignChart"></canvas></div></div>
  </div>
  <div class="grid grid-2" style="margin-bottom:16px">
    <div class="card"><h3>EMA Depth Heatmap (Win Rate by TF x Depth)</h3><div class="chart-wrap"><canvas id="depthChart"></canvas></div></div>
    <div class="card"><h3>SuperTrend Direction vs Outcome</h3><div class="chart-wrap"><canvas id="stChart"></canvas></div></div>
  </div>
  <div class="grid grid-2" style="margin-bottom:16px">
    <div class="card"><h3>RSI at Entry (1H) vs P&L%</h3><div class="chart-wrap"><canvas id="rsiScatterChart"></canvas></div></div>
    <div class="card"><h3>RSI Zones vs Win Rate by TF</h3><div class="chart-wrap"><canvas id="rsiZoneChart"></canvas></div></div>
  </div>
  <div class="grid grid-2">
    <div class="card"><h3>TD Sequential Bear Prep at Entry vs Outcome</h3><div class="chart-wrap"><canvas id="tdChart"></canvas></div></div>
    <div class="card"><h3>Phase Oscillator (D) at Entry vs Outcome</h3><div class="chart-wrap"><canvas id="phaseChart"></canvas></div></div>
  </div>
</div>

<!-- ═══ EXITS PANEL ═══ -->
<div class="panel" id="panel-exits">
  <div class="grid grid-2" style="margin-bottom:16px">
    <div class="card"><h3>MFE vs MAE (each dot = 1 trade)</h3><div class="chart-wrap"><canvas id="mfeMaeChart"></canvas></div></div>
    <div class="card"><h3>Capture Efficiency (PnL% / MFE%)</h3><div class="chart-wrap"><canvas id="captureChart"></canvas></div></div>
  </div>
  <div class="card" style="margin-bottom:16px"><h3>Exit Reason Effectiveness</h3>${renderGroupTable(byExitReason)}</div>
</div>

<!-- ═══ REGIME PANEL ═══ -->
<div class="panel" id="panel-regime">
  <div class="grid grid-2" style="margin-bottom:16px">
    <div class="card"><h3>Win Rate by Regime</h3><div class="chart-wrap"><canvas id="regimeWRChart"></canvas></div></div>
    <div class="card"><h3>VIX at Entry vs P&L%</h3><div class="chart-wrap"><canvas id="vixChart"></canvas></div></div>
  </div>
  <div class="grid grid-2" style="margin-bottom:16px">
    <div class="card"><h3>RVOL at Entry vs P&L%</h3><div class="chart-wrap"><canvas id="rvolChart"></canvas></div></div>
    <div class="card"><h3>By Volatility Tier</h3>${renderGroupTable(byVolTier)}</div>
  </div>
</div>

<!-- ═══ TICKERS PANEL ═══ -->
<div class="panel" id="panel-tickers">
  <div class="card"><h3>Per-Ticker Performance</h3>${renderGroupTable(byTicker)}</div>
</div>

<!-- ═══ TIMING PANEL ═══ -->
<div class="panel" id="panel-timing">
  <div class="grid grid-2" style="margin-bottom:16px">
    <div class="card"><h3>Win Rate by Entry Hour (ET)</h3><div class="chart-wrap"><canvas id="hourChart"></canvas></div></div>
    <div class="card"><h3>Win Rate by Day of Week</h3><div class="chart-wrap"><canvas id="dowChart"></canvas></div></div>
  </div>
  <div class="grid grid-2" style="margin-bottom:16px">
    <div class="card"><h3>Hold Duration vs P&L%</h3><div class="chart-wrap"><canvas id="holdChart"></canvas></div></div>
    <div class="card"><h3>Entry Quality Score vs Outcome</h3><div class="chart-wrap"><canvas id="eqChart"></canvas></div></div>
  </div>
</div>

<!-- ═══ INVESTOR ENGINE PANEL ═══ -->
<div class="panel" id="panel-investor">
  <div class="grid grid-4" style="margin-bottom:16px">
    <div class="card"><div class="stat-value stat-blue">${investorAnalysis.summary.totalPositions}</div><div class="stat-label">Total Positions</div></div>
    <div class="card"><div class="stat-value ${investorAnalysis.summary.totalPnl >= 0 ? 'stat-green' : 'stat-red'}">${fmt$(investorAnalysis.summary.totalPnl)}</div><div class="stat-label">Total P&L (${investorAnalysis.summary.winRate}% WR)</div></div>
    <div class="card"><div class="stat-value stat-green">${fmt$(investorAnalysis.summary.avgWin)}</div><div class="stat-label">Avg Win</div></div>
    <div class="card"><div class="stat-value stat-red">${fmt$(investorAnalysis.summary.avgLoss)}</div><div class="stat-label">Avg Loss</div></div>
  </div>
  <div class="grid grid-4" style="margin-bottom:16px">
    <div class="card"><div class="stat-value">${fmt$(investorAnalysis.summary.totalInvested)}</div><div class="stat-label">Total Invested</div></div>
    <div class="card"><div class="stat-value">${fmt$(investorAnalysis.summary.totalReturned)}</div><div class="stat-label">Total Returned</div></div>
    <div class="card"><div class="stat-value">${investorAnalysis.summary.avgHoldDays}d</div><div class="stat-label">Avg Hold Duration</div></div>
    <div class="card"><div class="stat-value">${fmt$(investorAnalysis.summary.avgPnl)}</div><div class="stat-label">Avg P&L per Position</div></div>
  </div>
  <div class="grid grid-2" style="margin-bottom:16px">
    <div class="card"><h3>Investor Equity Curve</h3><div class="chart-wrap"><canvas id="invEquityChart"></canvas></div></div>
    <div class="card"><h3>Investor vs Active: Ticker Overlap</h3><div class="chart-wrap"><canvas id="overlapChart"></canvas></div></div>
  </div>
  <div class="grid grid-2" style="margin-bottom:16px">
    <div class="card"><h3>Per-Ticker Investor Performance</h3>
      <table>
        <thead><tr><th>Ticker</th><th>Positions</th><th>W</th><th>L</th><th>WR%</th><th>Total PnL</th><th>Return %</th><th>Avg Hold</th></tr></thead>
        <tbody>${renderInvTickerTable(investorAnalysis.byInvTicker)}</tbody>
      </table>
    </div>
    <div class="card"><h3>Hold Duration vs Outcome</h3><div class="chart-wrap"><canvas id="invHoldChart"></canvas></div></div>
  </div>
  <div class="grid grid-2" style="margin-bottom:16px">
    <div class="card"><h3>Cross-Correlation: Investor Tickers in Active Trades</h3>
      <div style="margin-bottom:12px;font-size:13px">
        <p><b>Overlapping tickers:</b> ${investorAnalysis.crossCorrelation.overlapTickers.length > 0 ? investorAnalysis.crossCorrelation.overlapTickers.join(", ") : "None"}</p>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px">
          <div style="padding:12px;background:rgba(96,165,250,.08);border-radius:6px">
            <div style="font-size:20px;font-weight:800;color:var(--blue)">${investorAnalysis.crossCorrelation.overlapWR}%</div>
            <div style="font-size:11px;color:var(--muted)">Active WR on Investor Tickers (${investorAnalysis.crossCorrelation.overlapTradeCount} trades, ${fmt$(investorAnalysis.crossCorrelation.overlapPnl)})</div>
          </div>
          <div style="padding:12px;background:rgba(167,139,250,.08);border-radius:6px">
            <div style="font-size:20px;font-weight:800;color:var(--purple)">${investorAnalysis.crossCorrelation.nonOverlapWR}%</div>
            <div style="font-size:11px;color:var(--muted)">Active WR on Non-Investor Tickers (${investorAnalysis.crossCorrelation.nonOverlapTradeCount} trades, ${fmt$(investorAnalysis.crossCorrelation.nonOverlapPnl)})</div>
          </div>
        </div>
      </div>
    </div>
    <div class="card"><h3>Exit Reason Breakdown</h3>
      <table>
        <thead><tr><th>Exit Reason</th><th>N</th><th>W</th><th>L</th><th>WR%</th><th>Total PnL</th><th>Avg PnL</th></tr></thead>
        <tbody>${renderInvExitTable(investorAnalysis.byExitReasonInv)}</tbody>
      </table>
    </div>
  </div>
  <div class="card">
    <h3>All Investor Positions (${investorAnalysis.positions.length})</h3>
    <div style="overflow-x:auto">
    <table>
      <thead><tr><th>Ticker</th><th>Entry $</th><th>Invested</th><th>Returned</th><th>P&L</th><th>P&L%</th><th>Hold</th><th>Stage</th><th>Exit Reason</th></tr></thead>
      <tbody>${renderInvPositionsTable(investorAnalysis.positions)}</tbody>
    </table>
    </div>
  </div>
</div>

<!-- ═══ RECOMMENDATIONS PANEL ═══ -->
<div class="panel" id="panel-recs">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px">
    <h2 style="font-size:18px;font-weight:800">Auto-Recommendation Engine</h2>
    <div style="display:flex;gap:8px;font-size:11px">
      <span style="display:flex;align-items:center;gap:4px"><span style="width:8px;height:8px;border-radius:50%;background:var(--red);display:inline-block"></span> High Priority (${recommendations.filter(r => r.priority === 1).length})</span>
      <span style="display:flex;align-items:center;gap:4px"><span style="width:8px;height:8px;border-radius:50%;background:var(--amber);display:inline-block"></span> Medium (${recommendations.filter(r => r.priority === 2).length})</span>
      <span style="display:flex;align-items:center;gap:4px"><span style="width:8px;height:8px;border-radius:50%;background:var(--blue);display:inline-block"></span> Low (${recommendations.filter(r => r.priority === 3).length})</span>
    </div>
  </div>
  ${["entry","exit","regime","timing","ticker","investor","system"].map(cat => {
    const catRecs = recommendations.filter(r => r.category === cat);
    if (catRecs.length === 0) return "";
    const catLabels = { entry: "Entry Signal Quality", exit: "Exit & Trade Management", regime: "Regime & Market Context", timing: "Timing & Duration", ticker: "Ticker-Specific", investor: "Investor Engine", system: "System-Level" };
    const catIcons = { entry: "&#x1F3AF;", exit: "&#x1F6AA;", regime: "&#x1F30D;", timing: "&#x23F0;", ticker: "&#x1F4CA;", investor: "&#x1F3E6;", system: "&#x2699;" };
    return '<div style="margin-bottom:24px"><h3 style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid var(--border)">' + (catIcons[cat] || "") + " " + (catLabels[cat] || cat) + ' <span style="font-size:11px;font-weight:400">(' + catRecs.length + ')</span></h3>'
      + catRecs.map(r => {
        const prioColor = r.priority === 1 ? "var(--red)" : r.priority === 2 ? "var(--amber)" : "var(--blue)";
        const prioLabel = r.priority === 1 ? "HIGH" : r.priority === 2 ? "MED" : "LOW";
        return '<div class="rec ' + r.type + '" style="position:relative;padding-left:20px">'
          + '<div style="display:flex;align-items:start;gap:10px">'
          + '<span style="font-size:9px;font-weight:800;padding:2px 6px;border-radius:3px;background:' + prioColor + '20;color:' + prioColor + ';white-space:nowrap;margin-top:2px">' + prioLabel + '</span>'
          + '<div>'
          + (r.title ? '<div style="font-weight:700;font-size:13px;margin-bottom:3px">' + r.title + '</div>' : '')
          + '<div class="rec-text">' + r.text + '</div>'
          + (r.action ? '<div style="margin-top:6px;font-size:11px;font-weight:600;color:var(--teal)">&#x2192; ACTION: ' + r.action + '</div>' : '')
          + '</div></div></div>';
      }).join("")
      + '</div>';
  }).join("")}
</div>

<!-- ═══ ALL TRADES PANEL ═══ -->
<div class="panel" id="panel-trades">
  <div class="card">
    <h3>All Closed Trades (${enriched.length})</h3>
    <div style="overflow-x:auto">
    <table>
      <thead><tr><th>Date</th><th>Ticker</th><th>Dir</th><th>Status</th><th>P&L</th><th>P&L%</th><th>Grade</th><th>Regime</th><th>MFE</th><th>MAE</th><th>RVOL</th><th>EQ</th><th>Exit</th></tr></thead>
      <tbody>
        ${enriched.map(t => {
          const d = new Date(Number(t.entry_ts));
          const ds = d.toISOString().slice(5, 10);
          const pc = t.isWin ? "stat-green" : "stat-red";
          return `<tr>
            <td>${ds}</td><td><b>${t.ticker}</b></td><td>${t.direction}</td>
            <td class="${pc}">${t.status}</td>
            <td class="${pc}">${fmt$(t.pnl)}</td><td>${t.pnlPct.toFixed(2)}%</td>
            <td>${t.grade}</td><td>${t.regime}</td>
            <td>${t.mfe != null ? t.mfe.toFixed(2) + '%' : '—'}</td>
            <td>${t.mae != null ? t.mae.toFixed(2) + '%' : '—'}</td>
            <td>${t.rvol != null ? t.rvol.toFixed(1) : '—'}</td>
            <td>${t.eqScore != null ? t.eqScore : '—'}</td>
            <td style="max-width:150px;overflow:hidden;text-overflow:ellipsis">${(t.exit_reason || '—').split(',')[0]}</td>
          </tr>`;
        }).join("")}
      </tbody>
    </table>
    </div>
  </div>
</div>

<script>
const DATA = ${JSON.stringify(analyticsPayload)};

// Tab switching
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('panel-' + tab.dataset.panel).classList.add('active');
  });
});

Chart.defaults.color = '#8b949e';
Chart.defaults.borderColor = '#30363d';
const GREEN = '#22c55e', RED = '#ef4444', BLUE = '#60a5fa', AMBER = '#f59e0b', PURPLE = '#a78bfa', TEAL = '#14b8a6';

// Equity curve
new Chart(document.getElementById('equityChart'), {
  type: 'line',
  data: {
    labels: DATA.overview.equityCurve.map((_, i) => i + 1),
    datasets: [{
      label: 'Cumulative P&L',
      data: DATA.overview.equityCurve.map(d => d.y),
      borderColor: BLUE, backgroundColor: 'rgba(96,165,250,.1)', fill: true,
      tension: 0.3, pointRadius: 3,
      pointBackgroundColor: DATA.overview.equityCurve.map(d => d.status === 'WIN' ? GREEN : RED),
    }]
  },
  options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
});

// PnL distribution
const pnlBuckets = {};
DATA.trades.forEach(t => {
  const b = t.pnl >= 100 ? '$100+' : t.pnl >= 50 ? '$50-100' : t.pnl >= 10 ? '$10-50' : t.pnl >= 0 ? '$0-10' : t.pnl >= -10 ? '-$10-0' : t.pnl >= -50 ? '-$50-10' : '-$50+';
  pnlBuckets[b] = (pnlBuckets[b] || 0) + 1;
});
const pnlLabels = ['-$50+', '-$50-10', '-$10-0', '$0-10', '$10-50', '$50-100', '$100+'];
new Chart(document.getElementById('pnlDistChart'), {
  type: 'bar',
  data: {
    labels: pnlLabels,
    datasets: [{ data: pnlLabels.map(l => pnlBuckets[l] || 0), backgroundColor: pnlLabels.map(l => l.startsWith('-') ? RED + '80' : GREEN + '80') }]
  },
  options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
});

// EMA Cross per TF
const emaTFs = ${JSON.stringify(TFS)};
const emaBullWR = emaTFs.map(tf => {
  const d = DATA.signalAnalysis[tf]?.emaCross?.bull;
  return d ? (d.w / Math.max(1, d.w + d.l) * 100) : 0;
});
const emaBearWR = emaTFs.map(tf => {
  const d = DATA.signalAnalysis[tf]?.emaCross?.bear;
  return d ? (d.w / Math.max(1, d.w + d.l) * 100) : 0;
});
new Chart(document.getElementById('emaCrossChart'), {
  type: 'bar',
  data: {
    labels: emaTFs,
    datasets: [
      { label: 'Bull Cross WR%', data: emaBullWR, backgroundColor: GREEN + '80' },
      { label: 'Bear Cross WR%', data: emaBearWR, backgroundColor: RED + '80' },
    ]
  },
  options: { responsive: true, maintainAspectRatio: false, scales: { y: { max: 100, title: { display: true, text: 'Win Rate %' } } } }
});

// Alignment score
const alignLabels = ['0-39%', '40-59%', '60-79%', '80-100%'];
const alignWR = alignLabels.map(l => {
  const b = DATA.alignmentBuckets[l];
  return b ? (b.w / Math.max(1, b.w + b.l) * 100) : 0;
});
const alignN = alignLabels.map(l => { const b = DATA.alignmentBuckets[l]; return b ? b.w + b.l : 0; });
new Chart(document.getElementById('alignChart'), {
  type: 'bar',
  data: {
    labels: alignLabels.map((l, i) => l + ' (n=' + alignN[i] + ')'),
    datasets: [{ label: 'Win Rate %', data: alignWR, backgroundColor: [RED + '60', AMBER + '60', BLUE + '60', GREEN + '60'] }]
  },
  options: { responsive: true, maintainAspectRatio: false, scales: { y: { max: 100 } }, plugins: { legend: { display: false } } }
});

// EMA Depth heatmap (as grouped bar)
const depthBuckets = ['0-4', '5-9', '10-15'];
const depthDatasets = emaTFs.map((tf, i) => ({
  label: tf,
  data: depthBuckets.map(b => {
    const d = DATA.signalAnalysis[tf]?.emaDepth?.[b];
    return d ? (d.w / Math.max(1, d.w + d.l) * 100) : 0;
  }),
  backgroundColor: [RED, AMBER, GREEN, BLUE, PURPLE][i] + '80',
}));
new Chart(document.getElementById('depthChart'), {
  type: 'bar',
  data: { labels: depthBuckets.map(b => 'Depth ' + b), datasets: depthDatasets },
  options: { responsive: true, maintainAspectRatio: false, scales: { y: { max: 100, title: { display: true, text: 'Win Rate %' } } } }
});

// SuperTrend
const stBullWR = emaTFs.map(tf => {
  const d = DATA.signalAnalysis[tf]?.supertrend?.bull;
  return d ? (d.w / Math.max(1, d.w + d.l) * 100) : 0;
});
const stBearWR = emaTFs.map(tf => {
  const d = DATA.signalAnalysis[tf]?.supertrend?.bear;
  return d ? (d.w / Math.max(1, d.w + d.l) * 100) : 0;
});
new Chart(document.getElementById('stChart'), {
  type: 'bar',
  data: {
    labels: emaTFs,
    datasets: [
      { label: 'ST Bull WR%', data: stBullWR, backgroundColor: GREEN + '80' },
      { label: 'ST Bear WR%', data: stBearWR, backgroundColor: RED + '80' },
    ]
  },
  options: { responsive: true, maintainAspectRatio: false, scales: { y: { max: 100 } } }
});

// RSI scatter (1H)
const rsiData = DATA.signalAnalysis['1H']?.rsiScatter || [];
new Chart(document.getElementById('rsiScatterChart'), {
  type: 'scatter',
  data: {
    datasets: [{
      label: 'RSI vs PnL%',
      data: rsiData.map(d => ({ x: d.rsi, y: d.pnlPct })),
      backgroundColor: rsiData.map(d => d.status === 'WIN' ? GREEN + '80' : RED + '80'),
      pointRadius: 5,
    }]
  },
  options: {
    responsive: true, maintainAspectRatio: false,
    scales: { x: { title: { display: true, text: '1H RSI at Entry' } }, y: { title: { display: true, text: 'P&L %' } } },
    plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => rsiData[ctx.dataIndex]?.ticker + ' RSI=' + ctx.parsed.x + ' PnL=' + ctx.parsed.y.toFixed(2) + '%' } } }
  }
});

// RSI Zones
const rsiZones = ['0-30', '30-50', '50-70', '70-100'];
const rsiZoneDatasets = emaTFs.map((tf, i) => ({
  label: tf,
  data: rsiZones.map(z => {
    const d = DATA.signalAnalysis[tf]?.rsi?.[z];
    return d ? (d.w / Math.max(1, d.w + d.l) * 100) : 0;
  }),
  backgroundColor: [RED, AMBER, GREEN, BLUE, PURPLE][i] + '80',
}));
new Chart(document.getElementById('rsiZoneChart'), {
  type: 'bar',
  data: { labels: rsiZones.map(z => 'RSI ' + z), datasets: rsiZoneDatasets },
  options: { responsive: true, maintainAspectRatio: false, scales: { y: { max: 100, title: { display: true, text: 'Win Rate %' } } } }
});

// TD Sequential
const tdData = DATA.tdAnalysis?.atEntry || [];
if (tdData.length > 0) {
  new Chart(document.getElementById('tdChart'), {
    type: 'scatter',
    data: {
      datasets: [{
        label: 'Max Bear Prep vs PnL%',
        data: tdData.map(d => ({ x: d.maxBearPrep, y: d.pnlPct })),
        backgroundColor: tdData.map(d => d.isWin ? GREEN + '80' : RED + '80'),
        pointRadius: 5,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: { x: { title: { display: true, text: 'Max Bearish Prep Count (buyer exhaustion)' } }, y: { title: { display: true, text: 'P&L %' } } },
      plugins: { legend: { display: false } }
    }
  });
}

// Phase oscillator
const phData = DATA.phaseAnalysis || [];
if (phData.length > 0) {
  new Chart(document.getElementById('phaseChart'), {
    type: 'scatter',
    data: {
      datasets: [{
        data: phData.filter(d => d.phaseD != null).map(d => ({ x: d.phaseD, y: d.pnl })),
        backgroundColor: phData.filter(d => d.phaseD != null).map(d => d.isWin ? GREEN + '80' : RED + '80'),
        pointRadius: 5,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: { x: { title: { display: true, text: 'Daily Phase Value at Entry' } }, y: { title: { display: true, text: 'P&L ($)' } } },
      plugins: { legend: { display: false } }
    }
  });
}

// MFE vs MAE
if (DATA.mfeMaeData.length > 0) {
  new Chart(document.getElementById('mfeMaeChart'), {
    type: 'scatter',
    data: {
      datasets: [{
        data: DATA.mfeMaeData.map(d => ({ x: d.mae, y: d.mfe })),
        backgroundColor: DATA.mfeMaeData.map(d => d.isWin ? GREEN + '80' : RED + '80'),
        pointRadius: 6,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: { x: { title: { display: true, text: 'MAE % (drawdown)' } }, y: { title: { display: true, text: 'MFE % (potential)' } } },
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => { const d = DATA.mfeMaeData[ctx.dataIndex]; return d?.ticker + ' MFE=' + d?.mfe.toFixed(2) + '% MAE=' + d?.mae.toFixed(2) + '%'; } } } }
    }
  });
}

// Capture efficiency
if (DATA.mfeMaeData.length > 0) {
  const capData = DATA.mfeMaeData.filter(d => d.captureRatio != null);
  new Chart(document.getElementById('captureChart'), {
    type: 'bar',
    data: {
      labels: capData.map(d => d.ticker),
      datasets: [{ data: capData.map(d => Number(d.captureRatio)), backgroundColor: capData.map(d => d.isWin ? GREEN + '80' : RED + '80') }]
    },
    options: { responsive: true, maintainAspectRatio: false, scales: { y: { title: { display: true, text: 'Capture %' } } }, plugins: { legend: { display: false } } }
  });
}

// Regime WR
const regimeLabels = DATA.byRegime.map(r => r.key);
new Chart(document.getElementById('regimeWRChart'), {
  type: 'bar',
  data: {
    labels: regimeLabels.map((l, i) => l + ' (n=' + DATA.byRegime[i].n + ')'),
    datasets: [{ label: 'Win Rate %', data: DATA.byRegime.map(r => Number(r.wr)), backgroundColor: DATA.byRegime.map(r => Number(r.wr) >= 60 ? GREEN + '80' : Number(r.wr) >= 40 ? AMBER + '80' : RED + '80') }]
  },
  options: { responsive: true, maintainAspectRatio: false, scales: { y: { max: 100 } }, plugins: { legend: { display: false } } }
});

// VIX scatter
if (DATA.regimeVix.length > 0) {
  new Chart(document.getElementById('vixChart'), {
    type: 'scatter',
    data: {
      datasets: [{
        data: DATA.regimeVix.map(d => ({ x: d.vix, y: d.pnlPct })),
        backgroundColor: DATA.regimeVix.map(d => d.isWin ? GREEN + '80' : RED + '80'),
        pointRadius: 5,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: { x: { title: { display: true, text: 'VIX at Entry' } }, y: { title: { display: true, text: 'P&L %' } } },
      plugins: { legend: { display: false } }
    }
  });
}

// RVOL scatter
if (DATA.rvolData.length > 0) {
  new Chart(document.getElementById('rvolChart'), {
    type: 'scatter',
    data: {
      datasets: [{
        data: DATA.rvolData.map(d => ({ x: d.rvol, y: d.pnlPct })),
        backgroundColor: DATA.rvolData.map(d => d.isWin ? GREEN + '80' : RED + '80'),
        pointRadius: 5,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: { x: { title: { display: true, text: 'RVOL at Entry' } }, y: { title: { display: true, text: 'P&L %' } } },
      plugins: { legend: { display: false } }
    }
  });
}

// Entry hour
if (DATA.byEntryHour.length > 0) {
  const hoursSorted = DATA.byEntryHour.sort((a, b) => parseInt(a.key) - parseInt(b.key));
  new Chart(document.getElementById('hourChart'), {
    type: 'bar',
    data: {
      labels: hoursSorted.map(h => h.key + ' (n=' + h.n + ')'),
      datasets: [{ data: hoursSorted.map(h => Number(h.wr)), backgroundColor: hoursSorted.map(h => Number(h.wr) >= 60 ? GREEN + '80' : Number(h.wr) >= 40 ? AMBER + '80' : RED + '80') }]
    },
    options: { responsive: true, maintainAspectRatio: false, scales: { y: { max: 100, title: { display: true, text: 'Win Rate %' } } }, plugins: { legend: { display: false } } }
  });
}

// Day of week
if (DATA.byDow.length > 0) {
  const dowOrder = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
  const dowSorted = dowOrder.map(d => DATA.byDow.find(x => x.key === d)).filter(Boolean);
  new Chart(document.getElementById('dowChart'), {
    type: 'bar',
    data: {
      labels: dowSorted.map(d => d.key + ' (n=' + d.n + ')'),
      datasets: [{ data: dowSorted.map(d => Number(d.wr)), backgroundColor: dowSorted.map(d => Number(d.wr) >= 60 ? GREEN + '80' : Number(d.wr) >= 40 ? AMBER + '80' : RED + '80') }]
    },
    options: { responsive: true, maintainAspectRatio: false, scales: { y: { max: 100 } }, plugins: { legend: { display: false } } }
  });
}

// Hold duration scatter
if (DATA.holdDurationData.length > 0) {
  new Chart(document.getElementById('holdChart'), {
    type: 'scatter',
    data: {
      datasets: [{
        data: DATA.holdDurationData.map(d => ({ x: d.hours, y: d.pnlPct })),
        backgroundColor: DATA.holdDurationData.map(d => d.isWin ? GREEN + '80' : RED + '80'),
        pointRadius: 5,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: { x: { title: { display: true, text: 'Hold Duration (hours)' } }, y: { title: { display: true, text: 'P&L %' } } },
      plugins: { legend: { display: false } }
    }
  });
}

// Entry quality score
if (DATA.eqData.length > 0) {
  new Chart(document.getElementById('eqChart'), {
    type: 'scatter',
    data: {
      datasets: [{
        data: DATA.eqData.map(d => ({ x: d.score, y: d.pnlPct })),
        backgroundColor: DATA.eqData.map(d => d.isWin ? GREEN + '80' : RED + '80'),
        pointRadius: 5,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: { x: { title: { display: true, text: 'Entry Quality Score (0-100)' } }, y: { title: { display: true, text: 'P&L %' } } },
      plugins: { legend: { display: false } }
    }
  });
}
// ── Investor Engine Charts ──
const invData = DATA.investorAnalysis || {};

// Investor equity curve
if (invData.invEquityCurve?.length > 0) {
  new Chart(document.getElementById('invEquityChart'), {
    type: 'line',
    data: {
      labels: invData.invEquityCurve.map((_, i) => i + 1),
      datasets: [{
        label: 'Cumulative Investor P&L',
        data: invData.invEquityCurve.map(d => d.cumPnl),
        borderColor: TEAL, backgroundColor: 'rgba(20,184,166,.1)', fill: true,
        tension: 0.3, pointRadius: 4,
        pointBackgroundColor: invData.invEquityCurve.map(d => d.pnl >= 0 ? GREEN : RED),
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: {
        label: (ctx) => { const d = invData.invEquityCurve[ctx.dataIndex]; return d?.ticker + ' ' + (d?.pnl >= 0 ? '+' : '') + '$' + d?.pnl.toFixed(2) + ' (cum: $' + d?.cumPnl.toFixed(2) + ')'; }
      } } },
      scales: { y: { title: { display: true, text: 'Cumulative P&L ($)' } } }
    }
  });
}

// Overlap chart: investor tickers vs non-investor active trade WR
if (invData.crossCorrelation) {
  const cc = invData.crossCorrelation;
  new Chart(document.getElementById('overlapChart'), {
    type: 'bar',
    data: {
      labels: ['Investor Tickers\\n(' + cc.overlapTradeCount + ' trades)', 'Non-Investor Tickers\\n(' + cc.nonOverlapTradeCount + ' trades)'],
      datasets: [
        { label: 'Win Rate %', data: [Number(cc.overlapWR), Number(cc.nonOverlapWR)], backgroundColor: [TEAL + '80', PURPLE + '80'] },
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: { y: { max: 100, title: { display: true, text: 'Active Trade Win Rate %' } } },
      plugins: { legend: { display: false } }
    }
  });
}

// Hold duration buckets
if (invData.holdBuckets) {
  const hbLabels = Object.keys(invData.holdBuckets);
  const hbWR = hbLabels.map(l => {
    const b = invData.holdBuckets[l];
    return b ? (b.w / Math.max(1, b.w + b.l) * 100) : 0;
  });
  const hbPnl = hbLabels.map(l => invData.holdBuckets[l]?.pnl || 0);
  new Chart(document.getElementById('invHoldChart'), {
    type: 'bar',
    data: {
      labels: hbLabels.map((l, i) => {
        const b = invData.holdBuckets[l];
        return l + ' (n=' + (b ? b.w + b.l : 0) + ')';
      }),
      datasets: [
        { label: 'Win Rate %', data: hbWR, backgroundColor: hbWR.map(v => v >= 50 ? GREEN + '80' : RED + '80'), yAxisID: 'y' },
        { label: 'Total P&L ($)', data: hbPnl, type: 'line', borderColor: AMBER, pointRadius: 5, yAxisID: 'y1' },
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: {
        y: { position: 'left', max: 100, title: { display: true, text: 'Win Rate %' } },
        y1: { position: 'right', grid: { drawOnChartArea: false }, title: { display: true, text: 'P&L ($)' } },
      },
    }
  });
}
<\/script>
</body>
</html>`;

function renderInvTickerTable(tickers) {
  return tickers.map(g => {
    const wrN = Number(g.wr);
    const wrColor = wrN >= 60 ? "var(--green)" : wrN >= 40 ? "var(--amber)" : "var(--red)";
    const pnlColor = g.totalPnl >= 0 ? "var(--green)" : "var(--red)";
    return '<tr><td><b>' + g.ticker + '</b></td><td>' + g.n + '</td><td>' + g.wins + '</td><td>' + g.losses
      + '</td><td style="color:' + wrColor + ';font-weight:700">' + g.wr + '%</td><td style="color:' + pnlColor + '">'
      + fmt$(g.totalPnl) + '</td><td>' + g.pnlPct + '%</td><td>' + g.avgHoldDays + 'd</td></tr>';
  }).join("");
}

function renderInvExitTable(reasons) {
  return reasons.map(g => {
    const wrN = Number(g.wr);
    const wrColor = wrN >= 60 ? "var(--green)" : wrN >= 40 ? "var(--amber)" : "var(--red)";
    const pnlColor = g.totalPnl >= 0 ? "var(--green)" : "var(--red)";
    return '<tr><td><b>' + g.reason + '</b></td><td>' + g.n + '</td><td>' + g.wins + '</td><td>' + g.losses
      + '</td><td style="color:' + wrColor + ';font-weight:700">' + g.wr + '%</td><td style="color:' + pnlColor + '">'
      + fmt$(g.totalPnl) + '</td><td>' + fmt$(g.avgPnl) + '</td></tr>';
  }).join("");
}

function renderInvPositionsTable(positions) {
  return positions.map(p => {
    const pc = p.pnl >= 0 ? "stat-green" : "stat-red";
    return '<tr><td><b>' + p.ticker + '</b></td><td>' + p.avgEntry.toFixed(2) + '</td><td>' + fmt$(p.totalBought)
      + '</td><td>' + fmt$(p.totalSold) + '</td><td class="' + pc + '">' + fmt$(p.pnl) + '</td><td class="' + pc + '">'
      + p.pnlPct.toFixed(2) + '%</td><td>' + p.holdDays.toFixed(1) + 'd</td><td>' + p.stage + '</td><td>' + p.exitReason + '</td></tr>';
  }).join("");
}

function renderGroupTable(groups) {
  if (!groups.length) return "<p style='color:var(--muted)'>No data</p>";
  return `<table><thead><tr><th>Group</th><th>Trades</th><th>W</th><th>L</th><th>WR%</th><th>Avg PnL</th><th>Total PnL</th></tr></thead><tbody>${
    groups.map(g => {
      const wrN = Number(g.wr);
      const wrColor = wrN >= 60 ? "var(--green)" : wrN >= 40 ? "var(--amber)" : "var(--red)";
      const pnlColor = g.totalPnl >= 0 ? "var(--green)" : "var(--red)";
      return `<tr><td><b>${g.key}</b></td><td>${g.n}</td><td>${g.wins}</td><td>${g.losses}</td><td style="color:${wrColor};font-weight:700">${g.wr}%</td><td>${fmt$(g.avgPnl)}</td><td style="color:${pnlColor}">${fmt$(g.totalPnl)}</td></tr>`;
    }).join("")
  }</tbody></table>`;
}

const outPath = path.join(OUT_DIR, "analysis-canvas.html");
fs.writeFileSync(outPath, html, "utf8");
console.log(`\n✅ Canvas written to: ${outPath}`);
console.log(`   Open in browser: file://${outPath}`);
