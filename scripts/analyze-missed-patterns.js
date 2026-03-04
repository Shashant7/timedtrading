#!/usr/bin/env node
/**
 * analyze-missed-patterns.js — Signal pattern analysis for never-traded tickers.
 *
 * Takes the move-discovery output, isolates the 74 missed tickers, diagnoses
 * WHY each move was missed using indicator snapshots, then clusters moves by
 * signal pattern to discover candidate entry paths.
 *
 * Usage:
 *   node scripts/analyze-missed-patterns.js [--input data/move-discovery-*.json]
 */

const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const getArg = (name, dflt) => {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : dflt;
};

let inputFile = getArg("input", null);
if (!inputFile) {
  const dataDir = path.join(__dirname, "../data");
  const files = fs.readdirSync(dataDir).filter(f => f.startsWith("move-discovery-") && f.endsWith(".json")).sort().reverse();
  if (files.length === 0) { console.error("No move-discovery file found in data/"); process.exit(1); }
  inputFile = path.join(dataDir, files[0]);
}

console.log(`Loading: ${inputFile}\n`);
const raw = JSON.parse(fs.readFileSync(inputFile, "utf-8"));
const allMoves = raw.moves || raw;

const MISSED_TICKERS = new Set([
  "DY","STRL","IBP","DCI","AVAV","AXON","MLI","NXT","CARR","CW","FLR","VMI","UNP","ARRY",
  "JPM","GS","AXP","SPGI","PNC","BK","ALLY","EWBC","WAL","SOFI","HOOD","MTB","COIN",
  "AMD","KLAC","CDNS","MDB","PATH","SANM","IONQ","LITE","MSTR","LSCC","SHOP","SMCI",
  "VST","FSLR","TLN","WFRD","CVX","DINO","OKE","TPL","AR",
  "AMGN","GILD","UTHR","NBIS","EXEL","HALO","UHS","VRTX","ISRG",
  "MP","SN","APD","PKG","PPG",
  "META","GOOGL","NFLX","RDDT",
  "GLXY","RIOT","ETHA",
  "BABA","LRN",
  "RKLB","NOC",
  "ELF"
]);

const SECTOR_MAP = {
  DY:"Industrials",STRL:"Industrials",IBP:"Industrials",DCI:"Industrials",AVAV:"Industrials",
  AXON:"Industrials",MLI:"Industrials",NXT:"Industrials",CARR:"Industrials",CW:"Industrials",
  FLR:"Industrials",VMI:"Industrials",UNP:"Industrials",ARRY:"Industrials",
  JPM:"Financials",GS:"Financials",AXP:"Financials",SPGI:"Financials",PNC:"Financials",
  BK:"Financials",ALLY:"Financials",EWBC:"Financials",WAL:"Financials",SOFI:"Financials",
  HOOD:"Financials",MTB:"Financials",COIN:"Financials",
  AMD:"IT",KLAC:"IT",CDNS:"IT",MDB:"IT",PATH:"IT",SANM:"IT",IONQ:"IT",LITE:"IT",
  MSTR:"IT",LSCC:"IT",SHOP:"IT",SMCI:"IT",
  VST:"Energy",FSLR:"Energy",TLN:"Energy",WFRD:"Energy",CVX:"Energy",DINO:"Energy",
  OKE:"Energy",TPL:"Energy",AR:"Energy",
  AMGN:"Health Care",GILD:"Health Care",UTHR:"Health Care",NBIS:"Health Care",EXEL:"Health Care",
  HALO:"Health Care",UHS:"Health Care",VRTX:"Health Care",ISRG:"Health Care",
  MP:"Materials",SN:"Materials",APD:"Materials",PKG:"Materials",PPG:"Materials",
  META:"Comm Svcs",GOOGL:"Comm Svcs",NFLX:"Comm Svcs",RDDT:"Comm Svcs",
  GLXY:"Crypto",RIOT:"Crypto",ETHA:"Crypto",
  BABA:"Consumer Disc",LRN:"Consumer Disc",
  RKLB:"Aero/Defense",NOC:"Aero/Defense",
  ELF:"Consumer Staples"
};

function rnd(v, dp = 2) { return Math.round(v * Math.pow(10, dp)) / Math.pow(10, dp); }
function pct(n, d) { return d > 0 ? rnd(n / d * 100, 1) : 0; }

const missedMoves = allMoves.filter(m => MISSED_TICKERS.has(m.ticker));
const tradedMoves = allMoves.filter(m => !MISSED_TICKERS.has(m.ticker));

console.log("═══════════════════════════════════════════════════════════════════");
console.log(" MISSED TICKER SIGNAL PATTERN ANALYSIS");
console.log("═══════════════════════════════════════════════════════════════════\n");
console.log(`Total moves on missed tickers: ${missedMoves.length}`);
console.log(`Total moves on traded tickers: ${tradedMoves.length}`);
console.log(`UP: ${missedMoves.filter(m => m.direction === "UP").length}  DOWN: ${missedMoves.filter(m => m.direction === "DOWN").length}\n`);

// ════════════════════════════════════════════════════════════════
// DIAGNOSIS: Why each move was missed
// ════════════════════════════════════════════════════════════════

console.log("═══ DIAGNOSIS: WHY EACH MOVE WAS MISSED ═══\n");

const diagBuckets = {
  NO_TRAIL_DATA: [],
  LOW_RANK: [],
  LOW_HTF: [],
  WRONG_STATE: [],
  SHOULD_HAVE_ENTERED: [],
};

for (const move of missedMoves) {
  const startSnap = (move.indicators || [])[0] || {};
  const hasTrail = startSnap.state != null && startSnap.state !== "unknown";

  if (!hasTrail) {
    diagBuckets.NO_TRAIL_DATA.push(move);
    move._diagnosis = "NO_TRAIL_DATA";
    continue;
  }

  const rank = Number(startSnap.rank) || 0;
  const htf = Math.abs(Number(startSnap.htf_score) || 0);
  const state = String(startSnap.state || "");
  const emaRegime = startSnap.ema_regime;

  const isLong = move.direction === "UP";
  const isShort = move.direction === "DOWN";
  const stateAligned = (isLong && (state.includes("BULL") && !state.includes("BEAR_LTF"))) ||
    (isShort && (state.includes("BEAR") && !state.includes("BULL_LTF")));
  const regimeAligned = (isLong && emaRegime >= 2) || (isShort && emaRegime <= -2);

  if (rank < 55) {
    diagBuckets.LOW_RANK.push(move);
    move._diagnosis = "LOW_RANK";
  } else if (htf < 10) {
    diagBuckets.LOW_HTF.push(move);
    move._diagnosis = "LOW_HTF";
  } else if (!stateAligned && !regimeAligned) {
    diagBuckets.WRONG_STATE.push(move);
    move._diagnosis = "WRONG_STATE";
  } else {
    diagBuckets.SHOULD_HAVE_ENTERED.push(move);
    move._diagnosis = "SHOULD_HAVE_ENTERED";
  }
}

const diagTotal = missedMoves.length;
for (const [bucket, moves] of Object.entries(diagBuckets)) {
  const avgAtr = moves.length > 0 ? rnd(moves.reduce((s, m) => s + m.move_atr, 0) / moves.length, 1) : 0;
  console.log(`  ${bucket.padEnd(22)} ${String(moves.length).padStart(5)} (${pct(moves.length, diagTotal).toString().padStart(5)}%)  avgATR=${avgAtr}`);
}

// ════════════════════════════════════════════════════════════════
// PATTERN ANALYSIS: Group by signal at move start
// ════════════════════════════════════════════════════════════════

console.log("\n═══ SIGNAL PATTERNS AT MOVE START ═══\n");

const withTrail = missedMoves.filter(m => m._diagnosis !== "NO_TRAIL_DATA");

console.log(`Moves with trail data for analysis: ${withTrail.length}\n`);

// 1. Group by ema_regime at start
const byRegime = {};
for (const m of withTrail) {
  const snap = m.indicators[0] || {};
  const regime = snap.ema_regime != null ? String(snap.ema_regime) : "null";
  const key = `regime_${regime}_${m.direction}`;
  if (!byRegime[key]) byRegime[key] = { regime, direction: m.direction, moves: [] };
  byRegime[key].moves.push(m);
}

console.log("── By EMA Regime at Move Start ──");
console.log("Regime   Dir    Count  AvgATR  AvgPct  AvgRank  AvgHTF  Signals%");
const regimeSorted = Object.values(byRegime).sort((a, b) => b.moves.length - a.moves.length);
for (const g of regimeSorted) {
  const n = g.moves.length;
  const avgAtr = rnd(g.moves.reduce((s, m) => s + m.move_atr, 0) / n, 1);
  const avgPct = rnd(g.moves.reduce((s, m) => s + Math.abs(m.move_pct), 0) / n, 1);
  const avgRank = rnd(g.moves.reduce((s, m) => s + (m.indicators[0]?.rank || 0), 0) / n, 0);
  const avgHtf = rnd(g.moves.reduce((s, m) => s + Math.abs(m.indicators[0]?.htf_score || 0), 0) / n, 1);
  const sqPct = pct(g.moves.filter(m => m.indicators[0]?.squeeze_release).length, n);
  const emaPct = pct(g.moves.filter(m => m.indicators[0]?.ema_cross).length, n);
  const stPct = pct(g.moves.filter(m => m.indicators[0]?.st_flip).length, n);
  const mePct = pct(g.moves.filter(m => m.indicators[0]?.momentum_elite).length, n);
  console.log(
    `  ${g.regime.padStart(3)}    ${g.direction.padEnd(5)} ${String(n).padStart(5)}  ${String(avgAtr).padStart(6)}  ${String(avgPct).padStart(6)}%  ${String(avgRank).padStart(5)}    ${String(avgHtf).padStart(5)}   sq=${sqPct}% ema=${emaPct}% st=${stPct}% me=${mePct}%`
  );
}

// 2. Group by state at start
console.log("\n── By State at Move Start ──");
const byState = {};
for (const m of withTrail) {
  const snap = m.indicators[0] || {};
  const key = `${snap.state || "unknown"}_${m.direction}`;
  if (!byState[key]) byState[key] = { state: snap.state || "unknown", direction: m.direction, moves: [] };
  byState[key].moves.push(m);
}

console.log("State                        Dir    Count  AvgATR  AvgPct  AvgRank  AvgHTF");
const stateSorted = Object.values(byState).sort((a, b) => b.moves.length - a.moves.length);
for (const g of stateSorted.slice(0, 20)) {
  const n = g.moves.length;
  const avgAtr = rnd(g.moves.reduce((s, m) => s + m.move_atr, 0) / n, 1);
  const avgPct = rnd(g.moves.reduce((s, m) => s + Math.abs(m.move_pct), 0) / n, 1);
  const avgRank = rnd(g.moves.reduce((s, m) => s + (m.indicators[0]?.rank || 0), 0) / n, 0);
  const avgHtf = rnd(g.moves.reduce((s, m) => s + Math.abs(m.indicators[0]?.htf_score || 0), 0) / n, 1);
  console.log(
    `  ${g.state.padEnd(28)} ${g.direction.padEnd(5)} ${String(n).padStart(5)}  ${String(avgAtr).padStart(6)}  ${String(avgPct).padStart(6)}%  ${String(avgRank).padStart(5)}    ${String(avgHtf).padStart(5)}`
  );
}

// 3. CANDIDATE ENTRY PATHS — moves that had good signals but didn't qualify
console.log("\n═══ CANDIDATE ENTRY PATHS ═══\n");

const candidates = [];

// Candidate 1: ema_regime=1 (early bull) with rank >= 50 — not currently traded except ema_regime_early_long which requires HTF>=8 + confirmation
const earlyBullUp = withTrail.filter(m => {
  const snap = m.indicators[0] || {};
  return m.direction === "UP" && snap.ema_regime === 1 && (snap.rank || 0) >= 50;
});
candidates.push({
  name: "early_bull_relaxed (regime=1, rank>=50, UP)",
  count: earlyBullUp.length,
  avgAtr: earlyBullUp.length > 0 ? rnd(earlyBullUp.reduce((s, m) => s + m.move_atr, 0) / earlyBullUp.length, 1) : 0,
  avgPct: earlyBullUp.length > 0 ? rnd(earlyBullUp.reduce((s, m) => s + Math.abs(m.move_pct), 0) / earlyBullUp.length, 1) : 0,
  avgRank: earlyBullUp.length > 0 ? rnd(earlyBullUp.reduce((s, m) => s + (m.indicators[0]?.rank || 0), 0) / earlyBullUp.length, 0) : 0,
  highRankPct: earlyBullUp.length > 0 ? pct(earlyBullUp.filter(m => (m.indicators[0]?.rank || 0) >= 60).length, earlyBullUp.length) : 0,
  tickers: [...new Set(earlyBullUp.map(m => m.ticker))].length,
  sampleTickers: [...new Set(earlyBullUp.map(m => m.ticker))].slice(0, 10),
  moves: earlyBullUp,
});

// Candidate 2: ema_regime=2 (confirmed bull) but rank < 55 — would have traded if rank gate was lower
const confirmedBullLowRank = withTrail.filter(m => {
  const snap = m.indicators[0] || {};
  return m.direction === "UP" && snap.ema_regime === 2 && (snap.rank || 0) >= 40 && (snap.rank || 0) < 55;
});
candidates.push({
  name: "confirmed_bull_low_rank (regime=2, rank 40-54, UP)",
  count: confirmedBullLowRank.length,
  avgAtr: confirmedBullLowRank.length > 0 ? rnd(confirmedBullLowRank.reduce((s, m) => s + m.move_atr, 0) / confirmedBullLowRank.length, 1) : 0,
  avgPct: confirmedBullLowRank.length > 0 ? rnd(confirmedBullLowRank.reduce((s, m) => s + Math.abs(m.move_pct), 0) / confirmedBullLowRank.length, 1) : 0,
  avgRank: confirmedBullLowRank.length > 0 ? rnd(confirmedBullLowRank.reduce((s, m) => s + (m.indicators[0]?.rank || 0), 0) / confirmedBullLowRank.length, 0) : 0,
  tickers: [...new Set(confirmedBullLowRank.map(m => m.ticker))].length,
  sampleTickers: [...new Set(confirmedBullLowRank.map(m => m.ticker))].slice(0, 10),
  moves: confirmedBullLowRank,
});

// Candidate 3: ema_regime=-2 (confirmed bear) — SHORT opportunities
const confirmedBearDown = withTrail.filter(m => {
  const snap = m.indicators[0] || {};
  return m.direction === "DOWN" && snap.ema_regime === -2 && (snap.rank || 0) >= 50;
});
candidates.push({
  name: "confirmed_bear_short (regime=-2, rank>=50, DOWN)",
  count: confirmedBearDown.length,
  avgAtr: confirmedBearDown.length > 0 ? rnd(confirmedBearDown.reduce((s, m) => s + m.move_atr, 0) / confirmedBearDown.length, 1) : 0,
  avgPct: confirmedBearDown.length > 0 ? rnd(confirmedBearDown.reduce((s, m) => s + Math.abs(m.move_pct), 0) / confirmedBearDown.length, 1) : 0,
  avgRank: confirmedBearDown.length > 0 ? rnd(confirmedBearDown.reduce((s, m) => s + (m.indicators[0]?.rank || 0), 0) / confirmedBearDown.length, 0) : 0,
  tickers: [...new Set(confirmedBearDown.map(m => m.ticker))].length,
  sampleTickers: [...new Set(confirmedBearDown.map(m => m.ticker))].slice(0, 10),
  moves: confirmedBearDown,
});

// Candidate 4: early bear (regime=-1) — SHORT opportunities
const earlyBearDown = withTrail.filter(m => {
  const snap = m.indicators[0] || {};
  return m.direction === "DOWN" && snap.ema_regime === -1 && (snap.rank || 0) >= 50;
});
candidates.push({
  name: "early_bear_short (regime=-1, rank>=50, DOWN)",
  count: earlyBearDown.length,
  avgAtr: earlyBearDown.length > 0 ? rnd(earlyBearDown.reduce((s, m) => s + m.move_atr, 0) / earlyBearDown.length, 1) : 0,
  avgPct: earlyBearDown.length > 0 ? rnd(earlyBearDown.reduce((s, m) => s + Math.abs(m.move_pct), 0) / earlyBearDown.length, 1) : 0,
  avgRank: earlyBearDown.length > 0 ? rnd(earlyBearDown.reduce((s, m) => s + (m.indicators[0]?.rank || 0), 0) / earlyBearDown.length, 0) : 0,
  tickers: [...new Set(earlyBearDown.map(m => m.ticker))].length,
  sampleTickers: [...new Set(earlyBearDown.map(m => m.ticker))].slice(0, 10),
  moves: earlyBearDown,
});

// Candidate 5: Regime 0 (no regime) but with signals (squeeze/ema_cross/st_flip) — breakout-style
const noRegimeWithSignals = withTrail.filter(m => {
  const snap = m.indicators[0] || {};
  return snap.ema_regime === 0 && (snap.squeeze_release || snap.ema_cross || snap.st_flip) && (snap.rank || 0) >= 50;
});
candidates.push({
  name: "no_regime_with_signals (regime=0, has signal, rank>=50)",
  count: noRegimeWithSignals.length,
  avgAtr: noRegimeWithSignals.length > 0 ? rnd(noRegimeWithSignals.reduce((s, m) => s + m.move_atr, 0) / noRegimeWithSignals.length, 1) : 0,
  avgPct: noRegimeWithSignals.length > 0 ? rnd(noRegimeWithSignals.reduce((s, m) => s + Math.abs(m.move_pct), 0) / noRegimeWithSignals.length, 1) : 0,
  avgRank: noRegimeWithSignals.length > 0 ? rnd(noRegimeWithSignals.reduce((s, m) => s + (m.indicators[0]?.rank || 0), 0) / noRegimeWithSignals.length, 0) : 0,
  tickers: [...new Set(noRegimeWithSignals.map(m => m.ticker))].length,
  sampleTickers: [...new Set(noRegimeWithSignals.map(m => m.ticker))].slice(0, 10),
  moves: noRegimeWithSignals,
});

// Candidate 6: EMA aligned (from candle analysis) + high rank — pure price action
const emaAlignedHighRank = withTrail.filter(m => {
  const snap = m.indicators[0] || {};
  return m.ema_aligned && (snap.rank || 0) >= 55 && Math.abs(snap.htf_score || 0) >= 10;
});
candidates.push({
  name: "ema_aligned_strong_htf (emaAligned, rank>=55, |HTF|>=10)",
  count: emaAlignedHighRank.length,
  avgAtr: emaAlignedHighRank.length > 0 ? rnd(emaAlignedHighRank.reduce((s, m) => s + m.move_atr, 0) / emaAlignedHighRank.length, 1) : 0,
  avgPct: emaAlignedHighRank.length > 0 ? rnd(emaAlignedHighRank.reduce((s, m) => s + Math.abs(m.move_pct), 0) / emaAlignedHighRank.length, 1) : 0,
  avgRank: emaAlignedHighRank.length > 0 ? rnd(emaAlignedHighRank.reduce((s, m) => s + (m.indicators[0]?.rank || 0), 0) / emaAlignedHighRank.length, 0) : 0,
  tickers: [...new Set(emaAlignedHighRank.map(m => m.ticker))].length,
  sampleTickers: [...new Set(emaAlignedHighRank.map(m => m.ticker))].slice(0, 10),
  moves: emaAlignedHighRank,
});

// Candidate 7: HTF_BULL_LTF_BULL state going UP with rank >= 50
const bullBullUp = withTrail.filter(m => {
  const snap = m.indicators[0] || {};
  return m.direction === "UP" && (snap.state || "").includes("HTF_BULL_LTF_BULL") && (snap.rank || 0) >= 50;
});
candidates.push({
  name: "htf_bull_ltf_bull_UP (aligned state, rank>=50)",
  count: bullBullUp.length,
  avgAtr: bullBullUp.length > 0 ? rnd(bullBullUp.reduce((s, m) => s + m.move_atr, 0) / bullBullUp.length, 1) : 0,
  avgPct: bullBullUp.length > 0 ? rnd(bullBullUp.reduce((s, m) => s + Math.abs(m.move_pct), 0) / bullBullUp.length, 1) : 0,
  avgRank: bullBullUp.length > 0 ? rnd(bullBullUp.reduce((s, m) => s + (m.indicators[0]?.rank || 0), 0) / bullBullUp.length, 0) : 0,
  tickers: [...new Set(bullBullUp.map(m => m.ticker))].length,
  sampleTickers: [...new Set(bullBullUp.map(m => m.ticker))].slice(0, 10),
  moves: bullBullUp,
});

// Print candidates
console.log("Candidate Path                                          Count  AvgATR  AvgPct  AvgRank  Tickers");
console.log("─".repeat(110));
for (const c of candidates.sort((a, b) => b.count - a.count)) {
  if (c.count === 0) continue;
  console.log(
    `  ${c.name.padEnd(55)} ${String(c.count).padStart(4)}  ${String(c.avgAtr).padStart(6)}  ${String(c.avgPct).padStart(6)}%  ${String(c.avgRank).padStart(5)}    ${c.tickers}`
  );
  console.log(`    Tickers: ${c.sampleTickers.join(", ")}`);
}

// ════════════════════════════════════════════════════════════════
// COMPARE: Missed ticker moves vs traded ticker moves
// ════════════════════════════════════════════════════════════════

console.log("\n═══ COMPARISON: MISSED vs TRADED TICKER MOVES ═══\n");

function groupStats(moves, label) {
  const withT = moves.filter(m => m.indicators?.[0]?.state != null && m.indicators[0].state !== "unknown");
  const n = withT.length;
  if (n === 0) return;

  const avgAtr = rnd(withT.reduce((s, m) => s + m.move_atr, 0) / n, 1);
  const avgPct = rnd(withT.reduce((s, m) => s + Math.abs(m.move_pct), 0) / n, 1);
  const avgRank = rnd(withT.reduce((s, m) => s + (m.indicators[0]?.rank || 0), 0) / n, 0);
  const avgHtf = rnd(withT.reduce((s, m) => s + Math.abs(m.indicators[0]?.htf_score || 0), 0) / n, 1);
  const sqPct = pct(withT.filter(m => m.indicators[0]?.squeeze_release).length, n);
  const emaPct = pct(withT.filter(m => m.indicators[0]?.ema_cross).length, n);

  const regimeDist = {};
  withT.forEach(m => {
    const r = m.indicators[0]?.ema_regime;
    const key = r != null ? String(r) : "null";
    regimeDist[key] = (regimeDist[key] || 0) + 1;
  });

  console.log(`  ${label} (n=${n})`);
  console.log(`    AvgATR=${avgAtr}  AvgPct=${avgPct}%  AvgRank=${avgRank}  AvgHTF=${avgHtf}`);
  console.log(`    Signals: squeeze=${sqPct}%  emaCross=${emaPct}%`);
  console.log(`    Regime dist: ${Object.entries(regimeDist).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`${k}=${v}(${pct(v,n)}%)`).join("  ")}`);
}

const missedUP = missedMoves.filter(m => m.direction === "UP");
const missedDOWN = missedMoves.filter(m => m.direction === "DOWN");
const tradedCaptured = tradedMoves.filter(m => m.capture === "FULL" || m.capture === "PARTIAL");
const tradedMissed = tradedMoves.filter(m => m.capture === "MISSED");

groupStats(missedUP, "MISSED TICKERS — UP moves");
console.log();
groupStats(missedDOWN, "MISSED TICKERS — DOWN moves");
console.log();
groupStats(tradedCaptured, "TRADED TICKERS — CAPTURED moves");
console.log();
groupStats(tradedMissed, "TRADED TICKERS — MISSED moves");

// ════════════════════════════════════════════════════════════════
// SECTOR BREAKDOWN
// ════════════════════════════════════════════════════════════════

console.log("\n═══ SECTOR BREAKDOWN (missed tickers) ═══\n");

const bySector = {};
for (const m of missedMoves) {
  const sec = SECTOR_MAP[m.ticker] || "Unknown";
  if (!bySector[sec]) bySector[sec] = { up: 0, down: 0, total: 0, totalAtr: 0, tickers: new Set() };
  bySector[sec][m.direction === "UP" ? "up" : "down"]++;
  bySector[sec].total++;
  bySector[sec].totalAtr += m.move_atr;
  bySector[sec].tickers.add(m.ticker);
}

console.log("Sector            Tickers  Moves  UP  DOWN  AvgATR");
for (const [sec, d] of Object.entries(bySector).sort((a, b) => b[1].total - a[1].total)) {
  const avgAtr = rnd(d.totalAtr / d.total, 1);
  console.log(`  ${sec.padEnd(18)} ${String(d.tickers.size).padStart(4)}   ${String(d.total).padStart(4)}  ${String(d.up).padStart(3)}  ${String(d.down).padStart(4)}  ${String(avgAtr).padStart(6)}`);
}

// ════════════════════════════════════════════════════════════════
// TOP INDIVIDUAL MOVES (highest ATR)
// ════════════════════════════════════════════════════════════════

console.log("\n═══ TOP 30 INDIVIDUAL MISSED MOVES (by ATR) ═══\n");
console.log("Ticker  Dir  Window  MovePct  MoveATR  Rank  HTF   EmaRegime  State                    Signals");
console.log("─".repeat(120));

const topMoves = [...missedMoves].sort((a, b) => b.move_atr - a.move_atr).slice(0, 30);
for (const m of topMoves) {
  const snap = m.indicators?.[0] || {};
  const signals = [];
  if (snap.squeeze_release) signals.push("SQ");
  if (snap.ema_cross) signals.push("EMA");
  if (snap.st_flip) signals.push("ST");
  if (snap.momentum_elite) signals.push("ME");
  console.log(
    `  ${m.ticker.padEnd(6)} ${m.direction.padEnd(5)} ${String(m.window + "d").padStart(4)}  ${String(m.move_pct + "%").padStart(8)}  ${String(m.move_atr).padStart(6)}  ${String(snap.rank || "?").toString().padStart(4)}  ${String(snap.htf_score || "?").toString().padStart(5)}  ${String(snap.ema_regime != null ? snap.ema_regime : "?").toString().padStart(5)}      ${(snap.state || "?").padEnd(24)} ${signals.join(",") || "none"}`
  );
}

// ════════════════════════════════════════════════════════════════
// SAVE OUTPUT
// ════════════════════════════════════════════════════════════════

const output = {
  generated_at: new Date().toISOString(),
  summary: {
    total_missed_moves: missedMoves.length,
    unique_tickers: MISSED_TICKERS.size,
    tickers_with_moves: new Set(missedMoves.map(m => m.ticker)).size,
    diagnosis: Object.fromEntries(Object.entries(diagBuckets).map(([k, v]) => [k, v.length])),
  },
  candidates: candidates.map(c => ({
    name: c.name,
    count: c.count,
    avgAtr: c.avgAtr,
    avgPct: c.avgPct,
    avgRank: c.avgRank,
    tickers: c.tickers,
    sampleTickers: c.sampleTickers,
  })),
  top_moves: topMoves.map(m => ({
    ticker: m.ticker,
    direction: m.direction,
    window: m.window,
    move_pct: m.move_pct,
    move_atr: m.move_atr,
    start_date: m.start_date,
    end_date: m.end_date,
    ema_regime: m.indicators?.[0]?.ema_regime,
    state: m.indicators?.[0]?.state,
    rank: m.indicators?.[0]?.rank,
    htf_score: m.indicators?.[0]?.htf_score,
    signals: {
      squeeze: !!m.indicators?.[0]?.squeeze_release,
      ema_cross: !!m.indicators?.[0]?.ema_cross,
      st_flip: !!m.indicators?.[0]?.st_flip,
      momentum_elite: !!m.indicators?.[0]?.momentum_elite,
    },
  })),
};

const outPath = path.join(__dirname, "../data/missed-ticker-patterns.json");
fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
console.log(`\nReport saved: ${outPath}`);
