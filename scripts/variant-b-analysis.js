#!/usr/bin/env node
/**
 * variant-b-analysis.js — Deep analysis of Variant B backtest trades
 *
 * Performs 5 analyses:
 * 1. 15m EMA Cross at entry vs win/loss rates
 * 2. SOFT RSI FUSE exits — should we defer when trend is strong?
 * 3. Chop/compression trades — stall detection, box/range analysis
 * 4. Giving back gains — post-trim reversal and divergence
 * 5. Early entries — right thesis, wrong timing
 *
 * Usage:
 *   node scripts/variant-b-analysis.js
 *   node scripts/variant-b-analysis.js --run-id <custom_run_id>
 */

const path = require("path");
const fs = require("fs");
const { execSync } = require("child_process");

const RUN_ID = process.argv.includes("--run-id")
  ? process.argv[process.argv.indexOf("--run-id") + 1]
  : "backtest_2025-07-01_2026-03-11@2026-03-12T13:11:26.904Z";

const WORKER_DIR = path.join(__dirname, "../worker");
const OUT_DIR = path.join(__dirname, "../data/variant-b-analysis");
fs.mkdirSync(OUT_DIR, { recursive: true });

const B = "\x1b[1m", G = "\x1b[32m", R = "\x1b[31m", Y = "\x1b[33m", C = "\x1b[36m", DIM = "\x1b[2m", RST = "\x1b[0m";

function d1Query(sql) {
  const escaped = sql.replace(/"/g, '\\"');
  try {
    const raw = execSync(
      `cd "${WORKER_DIR}" && npx wrangler d1 execute timed-trading-ledger --remote --env production --json --command "${escaped}"`,
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 50 * 1024 * 1024 }
    );
    const lines = raw.split("\n").filter(l => !l.startsWith("npm"));
    const parsed = JSON.parse(lines.join("\n"));
    return Array.isArray(parsed) ? parsed[0]?.results || [] : parsed?.results || [];
  } catch (e) {
    console.error(`${R}D1 query failed:${RST}`, e.message?.slice(0, 200));
    return [];
  }
}

function safeJson(str) {
  if (!str) return null;
  try { return typeof str === "string" ? JSON.parse(str) : str; } catch { return null; }
}

function pct(n, d) { return d > 0 ? Math.round((n / d) * 1000) / 10 : 0; }
function rnd(v, dp = 2) { return Math.round(v * 10 ** dp) / 10 ** dp; }
function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function avg(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }

function msToET(ts) {
  if (!ts || !Number.isFinite(Number(ts))) return "?";
  const ms = Number(ts) > 1e12 ? Number(ts) : Number(ts) * 1000;
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(new Date(ms));
  } catch { return "?"; }
}

function getTfSignals(snap, tf) {
  return snap?.tf?.[tf]?.signals || {};
}

function getLtfKey(snap) {
  if (snap?.tf?.["15m"]) return "15m";
  if (snap?.tf?.["10m"]) return "10m";
  return null;
}

// ── Data Loading ─────────────────────────────────────────────────────────────

console.log(`\n${B}${C}═══ Variant B Trade Analysis ═══${RST}`);
console.log(`${DIM}Run ID: ${RUN_ID}${RST}\n`);
console.log(`${DIM}Loading data from D1...${RST}`);

const trades = d1Query(`SELECT * FROM backtest_run_trades WHERE run_id = '${RUN_ID}' ORDER BY entry_ts`);
console.log(`  Trades: ${trades.length}`);

const daRows = d1Query(`SELECT * FROM backtest_run_direction_accuracy WHERE run_id = '${RUN_ID}'`);
console.log(`  Direction Accuracy: ${daRows.length}`);

const annotations = d1Query(`SELECT * FROM backtest_run_annotations WHERE run_id = '${RUN_ID}'`);
console.log(`  Annotations: ${annotations.length}`);

const daMap = {};
for (const r of daRows) daMap[r.trade_id] = r;
const annoMap = {};
for (const a of annotations) annoMap[a.trade_id] = a;

const enriched = trades.map(t => {
  const da = daMap[t.trade_id] || {};
  const anno = annoMap[t.trade_id] || {};
  const snap = safeJson(da.signal_snapshot_json);
  const ltfKey = getLtfKey(snap);
  return {
    ...t,
    snap,
    ltfKey,
    ltfSignals: getTfSignals(snap, ltfKey),
    signals30m: getTfSignals(snap, "30m"),
    signals1H: getTfSignals(snap, "1H"),
    signals4H: getTfSignals(snap, "4H"),
    signalsD: getTfSignals(snap, "D"),
    regime: da.regime_combined || da.regime_daily || "?",
    classification: anno.classification || null,
    notes: anno.notes || null,
    lineage: snap?.lineage || {},
    vix: snap?.lineage?.market_internals?.vix?.price || null,
    holdHours: t.exit_ts && t.entry_ts
      ? rnd((Number(t.exit_ts > 1e12 ? t.exit_ts : t.exit_ts * 1000) - Number(t.entry_ts > 1e12 ? t.entry_ts : t.entry_ts * 1000)) / 3600000)
      : null,
  };
});

const wins = enriched.filter(t => t.status === "WIN");
const losses = enriched.filter(t => t.status === "LOSS");

console.log(`\n${B}Baseline: ${enriched.length} trades | ${wins.length}W / ${losses.length}L | ${pct(wins.length, enriched.length)}% WR${RST}`);
console.log(`${DIM}Avg Win: ${rnd(avg(wins.map(t => t.pnl_pct || 0)))}% | Avg Loss: ${rnd(avg(losses.map(t => t.pnl_pct || 0)))}%${RST}\n`);

// Save enriched data for reference
fs.writeFileSync(path.join(OUT_DIR, "enriched-trades.json"), JSON.stringify(enriched, null, 2));
console.log(`${DIM}Saved enriched trades to data/variant-b-analysis/enriched-trades.json${RST}\n`);

// ══════════════════════════════════════════════════════════════════════════════
// TASK 1: 15m EMA Cross at Entry vs Win/Loss Rates
// ══════════════════════════════════════════════════════════════════════════════

console.log(`${B}${C}══ TASK 1: 15m EMA Cross at Entry vs Win/Loss ══${RST}\n`);

const crossGroups = { bullish: { win: [], loss: [] }, bearish: { win: [], loss: [] }, unknown: { win: [], loss: [] } };

for (const t of enriched) {
  const emaCross = t.ltfSignals?.ema_cross;
  const group = emaCross === 1 ? "bullish" : emaCross === -1 ? "bearish" : "unknown";
  const bucket = t.status === "WIN" ? "win" : "loss";
  crossGroups[group][bucket].push(t);
}

for (const [cross, data] of Object.entries(crossGroups)) {
  const total = data.win.length + data.loss.length;
  if (total === 0) continue;
  const wr = pct(data.win.length, total);
  const color = wr >= 55 ? G : wr >= 45 ? Y : R;
  console.log(`  ${B}15m EMA Cross = ${cross.toUpperCase()}${RST}: ${total} trades | ${data.win.length}W / ${data.loss.length}L | ${color}${wr}% WR${RST}`);
  console.log(`    Avg Win PnL: ${G}${rnd(avg(data.win.map(t => t.pnl_pct || 0)))}%${RST} | Avg Loss PnL: ${R}${rnd(avg(data.loss.map(t => t.pnl_pct || 0)))}%${RST}`);
}

// Cross-tab with 30m
console.log(`\n  ${B}Compound: 15m x 30m EMA Cross${RST}`);
const compound = {};
for (const t of enriched) {
  const ltf = t.ltfSignals?.ema_cross === 1 ? "Bull" : t.ltfSignals?.ema_cross === -1 ? "Bear" : "?";
  const m30 = t.signals30m?.ema_cross === 1 ? "Bull" : t.signals30m?.ema_cross === -1 ? "Bear" : "?";
  const key = `15m:${ltf} + 30m:${m30}`;
  if (!compound[key]) compound[key] = { win: 0, loss: 0, trades: [] };
  compound[key][t.status === "WIN" ? "win" : "loss"]++;
  compound[key].trades.push(t);
}
for (const [key, data] of Object.entries(compound).sort((a, b) => (b[1].win + b[1].loss) - (a[1].win + a[1].loss))) {
  const total = data.win + data.loss;
  const wr = pct(data.win, total);
  const color = wr >= 55 ? G : wr >= 45 ? Y : R;
  console.log(`    ${key}: ${total} trades | ${data.win}W / ${data.loss}L | ${color}${wr}% WR${RST}`);
}

// EMA depth analysis at entry
console.log(`\n  ${B}15m EMA Depth at Entry${RST}`);
const depthBuckets = { "0-4": { win: 0, loss: 0 }, "5-9": { win: 0, loss: 0 }, "10-15": { win: 0, loss: 0 }, "15+": { win: 0, loss: 0 } };
for (const t of enriched) {
  const d = t.ltfSignals?.ema_depth ?? -1;
  const bucket = d < 5 ? "0-4" : d < 10 ? "5-9" : d <= 15 ? "10-15" : "15+";
  depthBuckets[bucket][t.status === "WIN" ? "win" : "loss"]++;
}
for (const [bucket, data] of Object.entries(depthBuckets)) {
  const total = data.win + data.loss;
  if (total === 0) continue;
  const wr = pct(data.win, total);
  const color = wr >= 55 ? G : wr >= 45 ? Y : R;
  console.log(`    Depth ${bucket}: ${total} trades | ${data.win}W / ${data.loss}L | ${color}${wr}% WR${RST}`);
}

// RSI analysis at entry
console.log(`\n  ${B}15m RSI at Entry (LONG trades only)${RST}`);
const longs = enriched.filter(t => t.direction === "LONG");
const rsiBuckets = { "<45": { win: 0, loss: 0 }, "45-55": { win: 0, loss: 0 }, "55-65": { win: 0, loss: 0 }, "65+": { win: 0, loss: 0 } };
for (const t of longs) {
  const r = t.ltfSignals?.rsi ?? 50;
  const bucket = r < 45 ? "<45" : r < 55 ? "45-55" : r < 65 ? "55-65" : "65+";
  rsiBuckets[bucket][t.status === "WIN" ? "win" : "loss"]++;
}
for (const [bucket, data] of Object.entries(rsiBuckets)) {
  const total = data.win + data.loss;
  if (total === 0) continue;
  const wr = pct(data.win, total);
  const color = wr >= 55 ? G : wr >= 45 ? Y : R;
  console.log(`    RSI ${bucket}: ${total} trades | ${data.win}W / ${data.loss}L | ${color}${wr}% WR${RST}`);
}

// ══════════════════════════════════════════════════════════════════════════════
// TASK 5: Early Entries — Right Thesis, Wrong Timing
// ══════════════════════════════════════════════════════════════════════════════

console.log(`\n${B}${C}══ TASK 5: Early Entries Analysis ══${RST}\n`);

const earlyEntries = enriched.filter(t => t.classification === "early_entry");
console.log(`  ${B}Early Entry trades: ${earlyEntries.length}${RST}\n`);

const earlySignalSummary = { ltf_bearish: 0, m30_bearish: 0, low_depth: 0, low_rsi: 0, low_structure: 0, total: earlyEntries.length };

for (const t of earlyEntries) {
  const isWin = t.status === "WIN";
  const ltfCross = t.ltfSignals?.ema_cross;
  const m30Cross = t.signals30m?.ema_cross;
  const depth = t.ltfSignals?.ema_depth ?? 0;
  const rsi = t.ltfSignals?.rsi ?? 50;
  const structure = t.ltfSignals?.ema_structure ?? 0;

  if (ltfCross === -1) earlySignalSummary.ltf_bearish++;
  if (m30Cross === -1) earlySignalSummary.m30_bearish++;
  if (depth < 5) earlySignalSummary.low_depth++;
  if (rsi < 50 && t.direction === "LONG") earlySignalSummary.low_rsi++;
  if (structure < 0.5) earlySignalSummary.low_structure++;

  const color = isWin ? G : R;
  console.log(`  ${color}${isWin ? "WIN" : "LOSS"}${RST} ${B}${t.ticker}${RST} ${t.direction} | ${msToET(t.entry_ts)} → ${msToET(t.exit_ts)} | PnL: ${color}${rnd(t.pnl_pct || 0)}%${RST}`);
  console.log(`    15m: cross=${ltfCross === 1 ? G + "Bull" : R + "Bear"}${RST} depth=${depth} rsi=${rnd(rsi, 1)} struct=${rnd(structure, 2)}`);
  console.log(`    30m: cross=${m30Cross === 1 ? G + "Bull" : R + "Bear"}${RST} depth=${t.signals30m?.ema_depth ?? "?"} rsi=${rnd(t.signals30m?.rsi ?? 0, 1)}`);
  console.log(`    1H:  cross=${t.signals1H?.ema_cross === 1 ? G + "Bull" : R + "Bear"}${RST} ST=${t.signals1H?.supertrend === 1 ? G + "Bull" : R + "Bear"}${RST}`);
  console.log(`    4H:  cross=${t.signals4H?.ema_cross === 1 ? G + "Bull" : R + "Bear"}${RST} ST=${t.signals4H?.supertrend === 1 ? G + "Bull" : R + "Bear"}${RST}`);
  console.log(`    Exit: ${t.exit_reason} | Hold: ${t.holdHours}h | VIX: ${t.vix || "?"}`);
  if (t.notes) console.log(`    ${DIM}Notes: ${t.notes}${RST}`);
  console.log();
}

console.log(`  ${B}Early Entry Signal Summary:${RST}`);
console.log(`    15m EMA Cross Bearish at entry: ${earlySignalSummary.ltf_bearish}/${earlySignalSummary.total} (${pct(earlySignalSummary.ltf_bearish, earlySignalSummary.total)}%)`);
console.log(`    30m EMA Cross Bearish at entry: ${earlySignalSummary.m30_bearish}/${earlySignalSummary.total} (${pct(earlySignalSummary.m30_bearish, earlySignalSummary.total)}%)`);
console.log(`    15m EMA Depth < 5: ${earlySignalSummary.low_depth}/${earlySignalSummary.total} (${pct(earlySignalSummary.low_depth, earlySignalSummary.total)}%)`);
console.log(`    15m RSI < 50 (LONG): ${earlySignalSummary.low_rsi}/${earlySignalSummary.total} (${pct(earlySignalSummary.low_rsi, earlySignalSummary.total)}%)`);
console.log(`    15m EMA Structure < 0.5: ${earlySignalSummary.low_structure}/${earlySignalSummary.total} (${pct(earlySignalSummary.low_structure, earlySignalSummary.total)}%)`);

// ══════════════════════════════════════════════════════════════════════════════
// TASK 2: SOFT RSI FUSE Exits — Should We Defer?
// ══════════════════════════════════════════════════════════════════════════════

console.log(`\n${B}${C}══ TASK 2: SOFT RSI FUSE Exit Analysis ══${RST}\n`);

const softFuseTrades = enriched.filter(t => t.exit_reason && t.exit_reason.toLowerCase().includes("soft_fuse"));
console.log(`  ${B}SOFT_FUSE exits: ${softFuseTrades.length}${RST}\n`);

for (const t of softFuseTrades) {
  const isWin = t.status === "WIN";
  const color = isWin ? G : R;
  const cls = t.classification || "?";

  console.log(`  ${color}${isWin ? "WIN" : "LOSS"}${RST} ${B}${t.ticker}${RST} ${t.direction} | ${msToET(t.entry_ts)} → ${msToET(t.exit_ts)} | PnL: ${color}$${rnd(t.pnl || 0)} (${rnd(t.pnl_pct || 0)}%)${RST}`);
  console.log(`    Classification: ${cls} | Hold: ${t.holdHours}h | Trim: ${t.trim_ts ? "Yes @" + msToET(t.trim_ts) : "No"}`);

  // Show signals at entry for context
  console.log(`    Entry signals → 15m: depth=${t.ltfSignals?.ema_depth} rsi=${rnd(t.ltfSignals?.rsi || 0, 1)} | 30m: depth=${t.signals30m?.ema_depth} rsi=${rnd(t.signals30m?.rsi || 0, 1)}`);
  console.log(`    1H: struct=${rnd(t.signals1H?.ema_structure || 0, 2)} ST=${t.signals1H?.supertrend === 1 ? "Bull" : "Bear"} | 4H: struct=${rnd(t.signals4H?.ema_structure || 0, 2)} ST=${t.signals4H?.supertrend === 1 ? "Bull" : "Bear"}`);
  console.log(`    Regime: ${t.regime} | VIX: ${t.vix || "?"}`);
  if (t.notes) console.log(`    ${DIM}Notes: ${t.notes}${RST}`);

  // Classify: should we have held?
  const shouldHave = cls === "bad_exit";
  if (shouldHave) console.log(`    ${Y}→ CANDIDATE FOR DEFER: classified as bad_exit${RST}`);
  console.log();
}

const softFuseWins = softFuseTrades.filter(t => t.status === "WIN");
const softFuseBadExits = softFuseTrades.filter(t => t.classification === "bad_exit");
console.log(`  ${B}SOFT FUSE Summary:${RST}`);
console.log(`    Win Rate: ${pct(softFuseWins.length, softFuseTrades.length)}% (${softFuseWins.length}/${softFuseTrades.length})`);
console.log(`    Classified as bad_exit (should have held): ${softFuseBadExits.length}/${softFuseTrades.length}`);
console.log(`    Avg PnL%: ${rnd(avg(softFuseTrades.map(t => t.pnl_pct || 0)))}%`);

// Common signals among bad exits
if (softFuseBadExits.length) {
  const highDepth1H = softFuseBadExits.filter(t => (t.signals1H?.ema_depth || 0) >= 10);
  const allSTBull = softFuseBadExits.filter(t => t.signals1H?.supertrend === 1 && t.signals4H?.supertrend === 1);
  console.log(`\n  ${B}Bad Exit signal patterns:${RST}`);
  console.log(`    1H EMA depth >= 10: ${highDepth1H.length}/${softFuseBadExits.length}`);
  console.log(`    1H + 4H SuperTrend both Bullish: ${allSTBull.length}/${softFuseBadExits.length}`);
}

// ══════════════════════════════════════════════════════════════════════════════
// TASK 3: Chop/Compression — Stall Detection
// ══════════════════════════════════════════════════════════════════════════════

console.log(`\n${B}${C}══ TASK 3: Chop/Compression Analysis ══${RST}\n`);

// Trades classified ok_trade or bad_exit with hold > 48h and small pnl%
const chopCandidates = enriched.filter(t => {
  const absP = Math.abs(t.pnl_pct || 0);
  const hours = t.holdHours || 0;
  return (t.classification === "ok_trade" || t.classification === "bad_exit") && hours >= 24 && absP < 3;
});

console.log(`  ${B}Chop/compression candidates (ok_trade or bad_exit, held >=24h, |pnl| < 3%): ${chopCandidates.length}${RST}\n`);

for (const t of chopCandidates) {
  const isWin = t.status === "WIN";
  const color = isWin ? G : R;

  console.log(`  ${color}${isWin ? "WIN" : "LOSS"}${RST} ${B}${t.ticker}${RST} ${t.direction} | ${msToET(t.entry_ts)} → ${msToET(t.exit_ts)} | PnL: ${color}$${rnd(t.pnl || 0)} (${rnd(t.pnl_pct || 0)}%)${RST}`);
  console.log(`    Hold: ${t.holdHours}h | Cls: ${t.classification} | Exit: ${t.exit_reason}`);
  console.log(`    15m: cross=${t.ltfSignals?.ema_cross} depth=${t.ltfSignals?.ema_depth} rsi=${rnd(t.ltfSignals?.rsi || 0, 1)} struct=${rnd(t.ltfSignals?.ema_structure || 0, 2)}`);
  console.log(`    30m: cross=${t.signals30m?.ema_cross} depth=${t.signals30m?.ema_depth} struct=${rnd(t.signals30m?.ema_structure || 0, 2)}`);
  console.log(`    Regime: ${t.regime} | VIX: ${t.vix || "?"}`);
  if (t.notes) console.log(`    ${DIM}Notes: ${t.notes}${RST}`);
  console.log();
}

// Summary stats for chop trades
if (chopCandidates.length) {
  const chopWins = chopCandidates.filter(t => t.status === "WIN");
  console.log(`  ${B}Chop Summary:${RST}`);
  console.log(`    Win Rate: ${pct(chopWins.length, chopCandidates.length)}%`);
  console.log(`    Avg Hold: ${rnd(avg(chopCandidates.map(t => t.holdHours || 0)))}h`);
  console.log(`    Avg PnL%: ${rnd(avg(chopCandidates.map(t => t.pnl_pct || 0)))}%`);
  console.log(`    Avg 15m Depth: ${rnd(avg(chopCandidates.map(t => t.ltfSignals?.ema_depth ?? 0)))}`);

  const mixedRegime = chopCandidates.filter(t => t.regime?.toLowerCase().includes("transition") || t.regime?.toLowerCase().includes("chop"));
  console.log(`    In Transitional/Choppy regime: ${mixedRegime.length}/${chopCandidates.length}`);
}

// ══════════════════════════════════════════════════════════════════════════════
// TASK 4: Giving Back Gains — Post-Trim Reversal
// ══════════════════════════════════════════════════════════════════════════════

console.log(`\n${B}${C}══ TASK 4: Giving Back Gains ══${RST}\n`);

// Trades that were trimmed but ended with low/negative PnL
const trimmedTrades = enriched.filter(t => t.trim_ts);
const givebackTrades = trimmedTrades.filter(t => (t.pnl_pct || 0) < 1.5);

console.log(`  ${B}Trimmed trades: ${trimmedTrades.length} | Gave back gains (final PnL% < 1.5%): ${givebackTrades.length}${RST}\n`);

for (const t of givebackTrades) {
  const isWin = t.status === "WIN";
  const color = isWin ? G : R;
  const trimPrice = t.trim_price || 0;
  const entryPrice = t.entry_price || 0;
  const exitPrice = t.exit_price || 0;

  // Estimate: how much was the gain at trim vs at exit
  const trimGainPct = entryPrice > 0 && trimPrice > 0
    ? rnd(((trimPrice - entryPrice) / entryPrice) * 100 * (t.direction === "LONG" ? 1 : -1))
    : "?";
  const finalPnlPct = rnd(t.pnl_pct || 0);
  const giveback = typeof trimGainPct === "number" ? rnd(trimGainPct - finalPnlPct) : "?";

  console.log(`  ${color}${isWin ? "WIN" : "LOSS"}${RST} ${B}${t.ticker}${RST} ${t.direction} | ${msToET(t.entry_ts)} → ${msToET(t.exit_ts)}`);
  console.log(`    Entry: $${entryPrice} | Trim: $${trimPrice} @${msToET(t.trim_ts)} | Exit: $${exitPrice}`);
  console.log(`    Gain at trim: ~${trimGainPct}% → Final: ${finalPnlPct}% | ${R}Gave back: ~${giveback}%${RST}`);
  console.log(`    Hold: ${t.holdHours}h | Cls: ${t.classification} | Exit: ${t.exit_reason}`);
  console.log(`    1H: struct=${rnd(t.signals1H?.ema_structure || 0, 2)} depth=${t.signals1H?.ema_depth} | 4H: struct=${rnd(t.signals4H?.ema_structure || 0, 2)} depth=${t.signals4H?.ema_depth}`);
  if (t.notes) console.log(`    ${DIM}Notes: ${t.notes}${RST}`);
  console.log();
}

if (trimmedTrades.length) {
  const trimmedWins = trimmedTrades.filter(t => t.status === "WIN");
  console.log(`  ${B}Trim Summary:${RST}`);
  console.log(`    All trimmed: WR = ${pct(trimmedWins.length, trimmedTrades.length)}% (${trimmedWins.length}/${trimmedTrades.length})`);
  console.log(`    Gave-back trades: ${givebackTrades.length} — ${givebackTrades.filter(t => t.status === "LOSS").length} ended as losses`);
  console.log(`    Avg PnL% of giveback trades: ${rnd(avg(givebackTrades.map(t => t.pnl_pct || 0)))}%`);
}

// ══════════════════════════════════════════════════════════════════════════════
// CROSS-CUTTING: Exit Reason x Win/Loss
// ══════════════════════════════════════════════════════════════════════════════

console.log(`\n${B}${C}══ Exit Reason Breakdown ══${RST}\n`);

const exitGroups = {};
for (const t of enriched) {
  const reason = (t.exit_reason || "unknown").split(",")[0];
  if (!exitGroups[reason]) exitGroups[reason] = { win: 0, loss: 0, pnls: [] };
  exitGroups[reason][t.status === "WIN" ? "win" : "loss"]++;
  exitGroups[reason].pnls.push(t.pnl_pct || 0);
}
const sortedExits = Object.entries(exitGroups).sort((a, b) => (b[1].win + b[1].loss) - (a[1].win + a[1].loss));
for (const [reason, data] of sortedExits) {
  const total = data.win + data.loss;
  const wr = pct(data.win, total);
  const avgP = rnd(avg(data.pnls));
  const color = wr >= 55 ? G : wr >= 45 ? Y : R;
  console.log(`  ${reason}: ${total} trades | ${data.win}W/${data.loss}L | ${color}${wr}% WR${RST} | Avg PnL: ${avgP}%`);
}

// ══════════════════════════════════════════════════════════════════════════════
// CROSS-CUTTING: Classification x Signal Patterns
// ══════════════════════════════════════════════════════════════════════════════

console.log(`\n${B}${C}══ Classification Signal Patterns ══${RST}\n`);

const classGroups = {};
for (const t of enriched) {
  const cls = t.classification || "unclassified";
  if (!classGroups[cls]) classGroups[cls] = [];
  classGroups[cls].push(t);
}

for (const [cls, trades] of Object.entries(classGroups).sort((a, b) => b[1].length - a[1].length)) {
  const w = trades.filter(t => t.status === "WIN").length;
  const l = trades.length - w;
  const avgDepth = rnd(avg(trades.map(t => t.ltfSignals?.ema_depth ?? 0)));
  const avgRsi = rnd(avg(trades.map(t => t.ltfSignals?.rsi ?? 50)));
  const bearishLtf = trades.filter(t => t.ltfSignals?.ema_cross === -1).length;
  const avgPnl = rnd(avg(trades.map(t => t.pnl_pct || 0)));

  console.log(`  ${B}${cls}${RST}: ${trades.length} trades | ${w}W/${l}L | Avg PnL: ${avgPnl}%`);
  console.log(`    Avg 15m depth: ${avgDepth} | Avg 15m RSI: ${avgRsi} | 15m bearish cross: ${bearishLtf}/${trades.length}`);
}

// ══════════════════════════════════════════════════════════════════════════════
// RECOMMENDATIONS
// ══════════════════════════════════════════════════════════════════════════════

console.log(`\n${B}${C}══ RECOMMENDATIONS ══${RST}\n`);

// Task 1 recommendation
const bearishAll = crossGroups.bearish.win.length + crossGroups.bearish.loss.length;
const bearishWR = pct(crossGroups.bearish.win.length, bearishAll);
const bullishAll = crossGroups.bullish.win.length + crossGroups.bullish.loss.length;
const bullishWR = pct(crossGroups.bullish.win.length, bullishAll);

console.log(`  ${B}1. 15m EMA Cross Guard${RST}`);
console.log(`     Bearish 15m cross: ${bearishWR}% WR (${bearishAll} trades) vs Bullish: ${bullishWR}% WR (${bullishAll} trades)`);
if (bearishWR < bullishWR - 10) {
  console.log(`     ${G}→ STRONG signal: Add deep_audit_require_ltf_bullish_ema_cross = true${RST}`);
  console.log(`     Expected impact: Block ${crossGroups.bearish.loss.length} losses, sacrifice ${crossGroups.bearish.win.length} wins`);
  console.log(`     Net win rate improvement: ~${rnd(pct(wins.length - crossGroups.bearish.win.length, enriched.length - bearishAll) - pct(wins.length, enriched.length))} pp`);
} else {
  console.log(`     ${Y}→ Marginal difference. Consider compound filter with depth/RSI instead${RST}`);
}

console.log(`\n  ${B}5. Early Entry Guard${RST}`);
console.log(`     ${earlySignalSummary.ltf_bearish}/${earlySignalSummary.total} early entries had bearish 15m cross`);
console.log(`     ${earlySignalSummary.low_depth}/${earlySignalSummary.total} had depth < 5`);
console.log(`     ${earlySignalSummary.low_rsi}/${earlySignalSummary.total} had RSI < 50 (LONG)`);
console.log(`     → Compound guard: require ema_cross bullish + depth >= 5 + RSI >= 48 for LONG entries`);

console.log(`\n  ${B}2. SOFT FUSE Defer${RST}`);
console.log(`     ${softFuseBadExits.length}/${softFuseTrades.length} SOFT FUSE exits classified as bad_exit`);
console.log(`     → If 1H+4H SuperTrend aligned + EMA depth >= 10 on 1H: defer fuse, re-arm after N bars`);

console.log(`\n  ${B}3. Compression Detector${RST}`);
console.log(`     ${chopCandidates.length} trades held 24h+ with < 3% PnL — capital drag`);
console.log(`     → Add stall timer: if trade makes < 0.5 ATR progress in 48h, tighten SL to breakeven`);

console.log(`\n  ${B}4. Post-Trim Protection${RST}`);
console.log(`     ${givebackTrades.length} trimmed trades ended with < 1.5% PnL`);
console.log(`     → After trim, set defensive SL at breakeven. If price reverses 0.5 ATR from high: exit`);

console.log(`\n${DIM}Analysis complete. Raw data saved to data/variant-b-analysis/${RST}\n`);
