#!/usr/bin/env node
/**
 * trade-intelligence.js — Deep trade learning from archived run data
 *
 * Reads from backtest_run_trades + direction_accuracy + annotations + ticker_profiles.
 * Produces actionable insights: avoidable losses, signal effectiveness, regime analysis,
 * ticker character x outcome, and concrete recommendations.
 *
 * Usage:
 *   node scripts/trade-intelligence.js --run-id <run_id>
 *   node scripts/trade-intelligence.js                          # uses live trades table
 *   node scripts/trade-intelligence.js --run-id <id> --json     # JSON output to data/
 *   node scripts/trade-intelligence.js --run-id <id> --top 20   # detailed top-N trade narratives
 *   USE_D1=1 node scripts/trade-intelligence.js --run-id <id>   # read from D1 directly
 */

const path = require("path");
const fs = require("fs");

const args = process.argv.slice(2);
const getArg = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
const hasFlag = (name) => args.includes(`--${name}`);

const RUN_ID = getArg("run-id", null);
const JSON_OUT = hasFlag("json");
const TOP_N = Number(getArg("top", "10"));
const SINCE_DATE = getArg("since", "2025-07-01");
const SINCE_TS = Math.floor(new Date(SINCE_DATE + "T00:00:00Z").getTime() / 1000);

const LOCAL_DB_PATH = path.join(__dirname, "../data/timed-local.db");
const USE_D1 = process.env.USE_D1 === "1";
const API_BASE = process.env.API_BASE || "https://timed-trading-ingest.shashant.workers.dev";
const API_KEY = process.env.TIMED_API_KEY || "AwesomeSauce";

const B = "\x1b[1m", G = "\x1b[32m", R = "\x1b[31m", Y = "\x1b[33m", C = "\x1b[36m", DIM = "\x1b[2m", RST = "\x1b[0m";
const t0 = Date.now();
const elapsed = () => ((Date.now() - t0) / 1000).toFixed(1) + "s";
function pct(n, d) { return d > 0 ? Math.round((n / d) * 1000) / 10 : 0; }
function rnd(v, dp = 2) { return Math.round(v * 10 ** dp) / 10 ** dp; }
function median(arr) { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }

let db = null;
if (!USE_D1) {
  try {
    const Database = require("better-sqlite3");
    db = new Database(LOCAL_DB_PATH, { readonly: true });
  } catch (e) {
    console.error("Local DB not found. Run: ./scripts/sync-d1.sh");
    process.exit(1);
  }
}

function query(sql) {
  if (db) return db.prepare(sql).all();
  const { execSync } = require("child_process");
  const escaped = sql.replace(/"/g, '\\"');
  const result = execSync(
    `cd "${path.join(__dirname, "../worker")}" && npx wrangler d1 execute timed-trading-ledger --remote --env production --json --command "${escaped}"`,
    { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
  );
  try {
    const parsed = JSON.parse(result);
    return Array.isArray(parsed) ? parsed[0]?.results || [] : parsed?.results || [];
  } catch { return []; }
}

function safeJson(str) {
  if (!str) return null;
  try { return typeof str === "string" ? JSON.parse(str) : str; } catch { return null; }
}

function msToET(ts) {
  if (!ts || !Number.isFinite(Number(ts))) return "?";
  const ms = Number(ts) > 1e12 ? Number(ts) : Number(ts) * 1000;
  if (ms <= 0 || !Number.isFinite(ms)) return "?";
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(new Date(ms));
  } catch { return "?"; }
}

function holdTimeLabel(entryTs, exitTs) {
  if (!entryTs || !exitTs || !Number.isFinite(Number(entryTs)) || !Number.isFinite(Number(exitTs))) return "?";
  const e = Number(entryTs), x = Number(exitTs);
  const ms = (x > 1e12 ? x : x * 1000) - (e > 1e12 ? e : e * 1000);
  if (!Number.isFinite(ms) || ms <= 0) return "?";
  const hrs = ms / 3600000;
  if (hrs < 1) return "<1h";
  if (hrs < 4) return "1-4h";
  if (hrs < 24) return "4h-1d";
  if (hrs < 72) return "1-3d";
  if (hrs < 168) return "3-7d";
  return ">7d";
}

function entryHourET(ts) {
  if (!ts || !Number.isFinite(Number(ts))) return null;
  const ms = Number(ts) > 1e12 ? Number(ts) : Number(ts) * 1000;
  if (ms <= 0 || !Number.isFinite(ms)) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", hour12: false }).formatToParts(new Date(ms));
    return Number(parts.find(p => p.type === "hour")?.value ?? 0);
  } catch { return null; }
}

function computeMetrics(trades) {
  if (!trades.length) return { n: 0, wr: 0, exp: 0, sqn: 0, pf: 0, total: 0, avg: 0 };
  const n = trades.length;
  const pnls = trades.map(t => Number(t.pnl_pct) || 0);
  const wins = pnls.filter(p => p > 0).length;
  const winPnl = pnls.filter(p => p > 0).reduce((s, p) => s + p, 0);
  const lossPnl = pnls.filter(p => p <= 0).reduce((s, p) => s + Math.abs(p), 0);
  const total = pnls.reduce((s, p) => s + p, 0);
  const avg = total / n;
  const wr = pct(wins, n);
  const avgW = wins > 0 ? winPnl / wins : 0;
  const avgL = (n - wins) > 0 ? lossPnl / (n - wins) : 0;
  const exp = rnd((wins / n) * avgW - ((n - wins) / n) * avgL);
  const pf = lossPnl > 0 ? rnd(winPnl / lossPnl) : 999;
  const std = pnls.length > 1 ? Math.sqrt(pnls.reduce((a, b) => a + (b - avg) ** 2, 0) / n) || 1 : 1;
  const sqn = rnd((avg / std) * Math.sqrt(n));
  return { n, wr, exp, sqn, pf, total: rnd(total), avg: rnd(avg) };
}

function printMetrics(label, m, indent = "  ") {
  const c = m.exp >= 0 ? G : R;
  console.log(`${indent}${label.padEnd(40)} ${String(m.n).padStart(4)}t  WR ${String(m.wr).padStart(5)}%  Exp ${c}${m.exp >= 0 ? "+" : ""}${m.exp}${RST}  PF ${String(m.pf).padStart(5)}  Σ ${m.total >= 0 ? "+" : ""}${m.total}%`);
}

// ═══════════════════════════════════════════════════════════════════════════
// DATA LOADING
// ═══════════════════════════════════════════════════════════════════════════

console.log(`\n${B}╔══════════════════════════════════════════════════════════════╗${RST}`);
console.log(`${B}║   TRADE INTELLIGENCE REPORT                                  ║${RST}`);
console.log(`${B}╚══════════════════════════════════════════════════════════════╝${RST}\n`);

let tradeTable = "trades";
let daTable = "direction_accuracy";
let runFilter = "";

if (RUN_ID) {
  console.log(`  Run: ${C}${RUN_ID}${RST}`);
  try {
    const cnt = query(`SELECT COUNT(*) AS cnt FROM backtest_run_trades WHERE run_id = '${RUN_ID.replace(/'/g, "''")}'`);
    if (Number(cnt[0]?.cnt || 0) > 0) {
      tradeTable = "backtest_run_trades";
      try {
        const daCnt = query(`SELECT COUNT(*) AS cnt FROM backtest_run_direction_accuracy WHERE run_id = '${RUN_ID.replace(/'/g, "''")}'`);
        if (Number(daCnt[0]?.cnt || 0) > 0) daTable = "backtest_run_direction_accuracy";
      } catch {}
      runFilter = `AND t.run_id = '${RUN_ID.replace(/'/g, "''")}'`;
    }
  } catch {}
  if (!runFilter) runFilter = `AND t.run_id = '${RUN_ID.replace(/'/g, "''")}'`;
}

console.log(`  Source: ${tradeTable} + ${daTable}`);
console.log(`  Since: ${SINCE_DATE}\n`);

// Detect available DA columns
let daExtraCols = "";
if (db) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${daTable})`).all().map(r => r.name);
    if (cols.includes("execution_profile_name")) {
      daExtraCols = ", da.execution_profile_name, da.execution_profile_confidence, da.market_state, da.execution_profile_json";
    }
  } catch {}
} else {
  daExtraCols = ", da.execution_profile_name, da.execution_profile_confidence, da.market_state, da.execution_profile_json";
}

console.log(`  [${elapsed()}] Loading trades...`);
const rawTrades = query(
  `SELECT t.trade_id, t.ticker, t.direction, t.entry_ts, t.exit_ts, t.entry_price, t.exit_price,
          t.pnl_pct, t.pnl, t.rank, t.rr, t.status, t.exit_reason, t.trimmed_pct,
          da.signal_snapshot_json, da.regime_daily, da.regime_weekly, da.regime_combined,
          da.entry_path AS da_entry_path ${daExtraCols}
   FROM ${tradeTable} t
   LEFT JOIN ${daTable} da ON da.trade_id = t.trade_id
   WHERE t.status IN ('WIN','LOSS','FLAT') ${runFilter}
     AND t.entry_ts >= ${SINCE_TS}
   ORDER BY t.entry_ts`
);
console.log(`  [${elapsed()}] Loaded ${rawTrades.length} closed trades`);

if (rawTrades.length === 0) {
  console.log(`\n  ${R}No closed trades found.${RST} Check --run-id or --since.`);
  process.exit(0);
}

// Load annotations
let annotations = {};
try {
  const annRows = query(`SELECT trade_id, classification, notes FROM trade_autopsy_annotations`);
  for (const r of annRows) annotations[r.trade_id] = { classification: r.classification, notes: r.notes };
} catch {}
// Also try run-scoped annotations
if (RUN_ID) {
  try {
    const runAnn = query(`SELECT trade_id, classification, notes FROM backtest_run_annotations WHERE run_id = '${RUN_ID.replace(/'/g, "''")}'`);
    for (const r of runAnn) annotations[r.trade_id] = { classification: r.classification, notes: r.notes };
  } catch {}
}
console.log(`  [${elapsed()}] Loaded ${Object.keys(annotations).length} annotations`);

// Load ticker profiles
let tickerProfiles = {};
try {
  const profRows = query(`SELECT ticker, learning_json FROM ticker_profiles WHERE learning_json IS NOT NULL`);
  for (const r of profRows) {
    const lj = safeJson(r.learning_json);
    if (lj) tickerProfiles[r.ticker] = lj;
  }
} catch {}
console.log(`  [${elapsed()}] Loaded ${Object.keys(tickerProfiles).length} ticker profiles`);

// Enrich trades
const trades = rawTrades.map(t => {
  const snap = safeJson(t.signal_snapshot_json);
  const ann = annotations[t.trade_id] || {};
  const profile = tickerProfiles[t.ticker] || null;
  const lineage = snap?.lineage || {};
  const isWin = t.status === "WIN";
  const isLoss = t.status === "LOSS";
  const pnlPct = Number(t.pnl_pct) || 0;
  const holdMs = ((t.exit_ts > 1e12 ? t.exit_ts : t.exit_ts * 1000) - (t.entry_ts > 1e12 ? t.entry_ts : t.entry_ts * 1000));

  // Extract signal state per TF
  const tfSignals = {};
  if (snap?.tf) {
    for (const [tf, data] of Object.entries(snap.tf)) {
      tfSignals[tf] = {
        bias: data?.bias || 0,
        ...data?.signals,
      };
    }
  }

  // Build a signal fingerprint for grouping
  const htfAligned = (tfSignals["D"]?.supertrend === 1 || tfSignals["D"]?.supertrend === -1) &&
                     (tfSignals["4H"]?.supertrend === tfSignals["D"]?.supertrend);
  const ltfAligned = tfSignals["10m"]?.ema_cross === 1 && tfSignals["30m"]?.ema_cross === 1;
  const squeezeRelease = Object.values(tfSignals).some(s => s.squeeze_release === 1 || s.had_squeeze_release === 1);
  const htfBias = ((tfSignals["D"]?.bias || 0) + (tfSignals["4H"]?.bias || 0)) / 2;
  const ltfBias = ((tfSignals["10m"]?.bias || 0) + (tfSignals["30m"]?.bias || 0)) / 2;

  const state = lineage.state || t.da_entry_path || "unknown";
  const regimeClass = lineage.regime_class || "unknown";
  const vixRaw = lineage.vix_at_entry || lineage.market_internals?.vix?.price || lineage.market_internals?.vix || null;
  const vix = typeof vixRaw === "object" ? (vixRaw?.price || null) : (Number(vixRaw) || null);
  const execProfile = lineage.execution_profile?.active_profile || t.execution_profile_name || null;
  const tickerChar = lineage.ticker_character || null;
  const personality = tickerChar?.personality || profile?.personality || lineage.execution_profile?.personality || null;
  const marketState = lineage.market_internals?.overall || t.market_state || null;

  // Avoidable loss flags
  const flags = [];
  if (isLoss) {
    const dir = String(t.direction).toUpperCase();
    const regime = (t.regime_combined || t.regime_daily || "").toLowerCase();
    if (dir === "LONG" && (regime.includes("bear") || regime === "strong_bearish")) flags.push("against_regime");
    if (dir === "SHORT" && (regime.includes("bull") || regime === "strong_bullish")) flags.push("against_regime");
    if (state.includes("BULL") && dir === "SHORT") flags.push("against_htf_state");
    if (state.includes("BEAR") && dir === "LONG") flags.push("against_htf_state");
    if (Number(t.rank) < 60) flags.push("low_rank");
    if (holdMs < 4 * 3600000) flags.push("rapid_exit");
    if (htfBias > 0 && dir === "SHORT") flags.push("htf_bias_mismatch");
    if (htfBias < 0 && dir === "LONG") flags.push("htf_bias_mismatch");
    if (vix && vix > 25) flags.push("high_vix");
    if (!htfAligned) flags.push("no_htf_alignment");
  }

  return {
    ...t, snap, ann, profile, lineage, isWin, isLoss, pnlPct, holdMs,
    tfSignals, htfAligned, ltfAligned, squeezeRelease, htfBias, ltfBias,
    state, regimeClass, vix, execProfile, personality, marketState,
    holdBucket: holdTimeLabel(t.entry_ts, t.exit_ts),
    entryHour: entryHourET(t.entry_ts),
    avoidableFlags: flags,
    manualClass: ann.classification || null,
    manualNotes: ann.notes || null,
  };
});

const wins = trades.filter(t => t.isWin);
const losses = trades.filter(t => t.isLoss);
const report = { run_id: RUN_ID, generated: new Date().toISOString(), since: SINCE_DATE, sections: {} };

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 1: OVERALL SNAPSHOT
// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${B}═══ 1. OVERALL SNAPSHOT ═══${RST}\n`);
const overall = computeMetrics(trades);
printMetrics("ALL TRADES", overall);
printMetrics("  LONG", computeMetrics(trades.filter(t => String(t.direction).toUpperCase() === "LONG")));
printMetrics("  SHORT", computeMetrics(trades.filter(t => String(t.direction).toUpperCase() === "SHORT")));
report.sections.overall = overall;

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 2: AVOIDABLE LOSSES
// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${B}═══ 2. AVOIDABLE LOSSES — "Should We Have Taken This Trade?" ═══${RST}\n`);

const avoidable = losses.filter(t => t.avoidableFlags.length > 0);
const flagCounts = {};
for (const t of avoidable) {
  for (const f of t.avoidableFlags) flagCounts[f] = (flagCounts[f] || 0) + 1;
}
const flagDamage = {};
for (const t of avoidable) {
  for (const f of t.avoidableFlags) flagDamage[f] = (flagDamage[f] || 0) + Math.abs(t.pnlPct);
}

console.log(`  ${avoidable.length} of ${losses.length} losses had warning signs:\n`);
const flagEntries = Object.entries(flagCounts).sort((a, b) => (flagDamage[b[0]] || 0) - (flagDamage[a[0]] || 0));
for (const [flag, cnt] of flagEntries) {
  const dmg = rnd(flagDamage[flag] || 0);
  const desc = {
    against_regime: "Traded against daily/weekly regime",
    against_htf_state: "Direction opposed HTF state (e.g., LONG in HTF_BEAR)",
    low_rank: "Entered with rank < 60 (marginal quality)",
    rapid_exit: "Stopped out within 4 hours (impulsive or chasing)",
    htf_bias_mismatch: "HTF bias score opposed trade direction",
    high_vix: "VIX > 25 at entry (elevated volatility)",
    no_htf_alignment: "Daily + 4H SuperTrend not aligned with direction",
  }[flag] || flag;
  console.log(`  ${R}${flag.padEnd(25)}${RST} ${String(cnt).padStart(3)} trades  ${R}-${dmg}%${RST} total damage`);
  console.log(`    ${DIM}${desc}${RST}`);
}

// If a loss had ZERO flags, it's a "clean" loss (market just didn't work)
const cleanLosses = losses.filter(t => t.avoidableFlags.length === 0);
console.log(`\n  ${G}Clean losses${RST} (no warning signs, market risk): ${cleanLosses.length} of ${losses.length}`);

const totalAvoidableDamage = avoidable.reduce((s, t) => s + Math.abs(t.pnlPct), 0);
const totalLossDamage = losses.reduce((s, t) => s + Math.abs(t.pnlPct), 0);
console.log(`  Avoidable damage: ${R}-${rnd(totalAvoidableDamage)}%${RST} of ${R}-${rnd(totalLossDamage)}%${RST} total loss (${rnd(totalAvoidableDamage / totalLossDamage * 100)}%)\n`);

// Top avoidable trades
console.log(`  ${B}Worst avoidable losses:${RST}`);
const worstAvoidable = [...avoidable].sort((a, b) => a.pnlPct - b.pnlPct).slice(0, Math.min(5, avoidable.length));
for (const t of worstAvoidable) {
  console.log(`    ${R}${t.ticker.padEnd(6)}${RST} ${t.direction.padEnd(5)} ${rnd(t.pnlPct)}%  rank=${t.rank || "?"}  state=${t.state}  flags=[${t.avoidableFlags.join(",")}]`);
  if (t.manualNotes) console.log(`      ${DIM}Note: ${t.manualNotes}${RST}`);
}

report.sections.avoidable_losses = {
  count: avoidable.length, total_losses: losses.length,
  damage_pct: rnd(totalAvoidableDamage), total_loss_pct: rnd(totalLossDamage),
  flags: Object.fromEntries(flagEntries.map(([f, c]) => [f, { count: c, damage_pct: rnd(flagDamage[f] || 0) }])),
  clean_losses: cleanLosses.length,
};

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 3: SIGNAL EFFECTIVENESS
// ═══════════════════════════════════════════════════════════════════════════
console.log(`${B}═══ 3. SIGNAL EFFECTIVENESS — "What Combos Win?" ═══${RST}\n`);

// HTF alignment
const htfAlignedTrades = trades.filter(t => t.htfAligned);
const htfNotAligned = trades.filter(t => !t.htfAligned);
printMetrics("HTF aligned (D+4H SuperTrend)", computeMetrics(htfAlignedTrades));
printMetrics("HTF NOT aligned", computeMetrics(htfNotAligned));
console.log();

// LTF alignment
const ltfAlignedTrades = trades.filter(t => t.ltfAligned);
const ltfNotAligned = trades.filter(t => !t.ltfAligned);
printMetrics("LTF aligned (10m+30m EMA cross)", computeMetrics(ltfAlignedTrades));
printMetrics("LTF NOT aligned", computeMetrics(ltfNotAligned));
console.log();

// Squeeze release
const sqzTrades = trades.filter(t => t.squeezeRelease);
const noSqzTrades = trades.filter(t => !t.squeezeRelease);
printMetrics("With squeeze release", computeMetrics(sqzTrades));
printMetrics("No squeeze release", computeMetrics(noSqzTrades));
console.log();

// Combined: HTF aligned + LTF aligned
const fullAligned = trades.filter(t => t.htfAligned && t.ltfAligned);
const partialAligned = trades.filter(t => t.htfAligned && !t.ltfAligned);
const misaligned = trades.filter(t => !t.htfAligned && !t.ltfAligned);
printMetrics("FULL alignment (HTF+LTF)", computeMetrics(fullAligned));
printMetrics("HTF only (no LTF)", computeMetrics(partialAligned));
printMetrics("No alignment", computeMetrics(misaligned));
console.log();

// HTF bias score buckets
const biasBuckets = [
  { label: "Strong HTF bias (>0.7)", filter: t => Math.abs(t.htfBias) > 0.7 },
  { label: "Moderate HTF bias (0.4-0.7)", filter: t => Math.abs(t.htfBias) >= 0.4 && Math.abs(t.htfBias) <= 0.7 },
  { label: "Weak HTF bias (<0.4)", filter: t => Math.abs(t.htfBias) < 0.4 },
];
for (const b of biasBuckets) {
  const filtered = trades.filter(b.filter);
  if (filtered.length >= 3) printMetrics(b.label, computeMetrics(filtered));
}

report.sections.signal_effectiveness = {
  htf_aligned: computeMetrics(htfAlignedTrades),
  htf_not_aligned: computeMetrics(htfNotAligned),
  ltf_aligned: computeMetrics(ltfAlignedTrades),
  ltf_not_aligned: computeMetrics(ltfNotAligned),
  full_alignment: computeMetrics(fullAligned),
  squeeze_release: computeMetrics(sqzTrades),
  no_squeeze: computeMetrics(noSqzTrades),
};

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 4: REGIME-CONDITIONAL PERFORMANCE
// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${B}═══ 4. REGIME PERFORMANCE — "When Does The System Work?" ═══${RST}\n`);

// By state
const stateGroups = {};
for (const t of trades) {
  const s = t.state || "unknown";
  if (!stateGroups[s]) stateGroups[s] = [];
  stateGroups[s].push(t);
}
console.log(`  ${B}By HTF/LTF State:${RST}`);
for (const [state, group] of Object.entries(stateGroups).sort((a, b) => b[1].length - a[1].length)) {
  if (group.length < 3) continue;
  printMetrics(state, computeMetrics(group), "    ");
}

// By regime class
console.log(`\n  ${B}By Regime Class:${RST}`);
const regimeGroups = {};
for (const t of trades) {
  const r = t.regimeClass || "unknown";
  if (!regimeGroups[r]) regimeGroups[r] = [];
  regimeGroups[r].push(t);
}
for (const [regime, group] of Object.entries(regimeGroups).sort((a, b) => b[1].length - a[1].length)) {
  if (group.length < 3) continue;
  printMetrics(regime, computeMetrics(group), "    ");
}

// By VIX level
console.log(`\n  ${B}By VIX Level:${RST}`);
const vixBuckets = [
  { label: "VIX < 15 (low vol)", filter: t => t.vix && t.vix < 15 },
  { label: "VIX 15-20", filter: t => t.vix && t.vix >= 15 && t.vix < 20 },
  { label: "VIX 20-25", filter: t => t.vix && t.vix >= 20 && t.vix < 25 },
  { label: "VIX > 25 (high vol)", filter: t => t.vix && t.vix >= 25 },
  { label: "VIX unknown", filter: t => !t.vix },
];
for (const b of vixBuckets) {
  const group = trades.filter(b.filter);
  if (group.length >= 3) printMetrics(b.label, computeMetrics(group), "    ");
}

report.sections.regime = {
  by_state: Object.fromEntries(Object.entries(stateGroups).filter(([, g]) => g.length >= 3).map(([k, g]) => [k, computeMetrics(g)])),
  by_regime_class: Object.fromEntries(Object.entries(regimeGroups).filter(([, g]) => g.length >= 3).map(([k, g]) => [k, computeMetrics(g)])),
};

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 5: TICKER CHARACTER ANALYSIS
// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${B}═══ 5. TICKER CHARACTER — "What Works By Ticker?" ═══${RST}\n`);

const tickerGroups = {};
for (const t of trades) {
  if (!tickerGroups[t.ticker]) tickerGroups[t.ticker] = [];
  tickerGroups[t.ticker].push(t);
}

const tickerStats = [];
for (const [ticker, group] of Object.entries(tickerGroups)) {
  if (group.length < 2) continue;
  const m = computeMetrics(group);
  const prof = tickerProfiles[ticker];
  tickerStats.push({ ticker, ...m, personality: prof?.personality || "?", avgRank: rnd(group.reduce((s, t) => s + (Number(t.rank) || 0), 0) / group.length) });
}
tickerStats.sort((a, b) => b.total - a.total);

console.log(`  ${B}Top Edge Tickers:${RST}`);
const edgeTickers = tickerStats.filter(t => t.exp > 0 && t.n >= 2).slice(0, 10);
for (const t of edgeTickers) {
  console.log(`    ${G}${t.ticker.padEnd(6)}${RST} ${String(t.n).padStart(3)}t  WR ${String(t.wr).padStart(5)}%  Exp +${t.exp}  Σ +${t.total}%  ${DIM}${t.personality}${RST}`);
}

console.log(`\n  ${B}Toxic Tickers:${RST}`);
const toxicTickers = tickerStats.filter(t => t.exp < 0 && t.n >= 2).sort((a, b) => a.total - b.total).slice(0, 10);
for (const t of toxicTickers) {
  console.log(`    ${R}${t.ticker.padEnd(6)}${RST} ${String(t.n).padStart(3)}t  WR ${String(t.wr).padStart(5)}%  Exp ${t.exp}  Σ ${t.total}%  ${DIM}${t.personality}${RST}`);
}

// Personality breakdown
console.log(`\n  ${B}Performance by Ticker Personality:${RST}`);
const personalityGroups = {};
for (const t of trades) {
  const p = t.personality || "unknown";
  if (!personalityGroups[p]) personalityGroups[p] = [];
  personalityGroups[p].push(t);
}
for (const [pers, group] of Object.entries(personalityGroups).sort((a, b) => b[1].length - a[1].length)) {
  if (group.length < 3) continue;
  printMetrics(pers, computeMetrics(group), "    ");
}

report.sections.tickers = {
  edge: edgeTickers.map(t => ({ ticker: t.ticker, n: t.n, wr: t.wr, exp: t.exp, total: t.total, personality: t.personality })),
  toxic: toxicTickers.map(t => ({ ticker: t.ticker, n: t.n, wr: t.wr, exp: t.exp, total: t.total, personality: t.personality })),
  by_personality: Object.fromEntries(Object.entries(personalityGroups).filter(([, g]) => g.length >= 3).map(([k, g]) => [k, computeMetrics(g)])),
};

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 6: HOLD TIME + TIME OF DAY
// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${B}═══ 6. TIMING ANALYSIS ═══${RST}\n`);

console.log(`  ${B}By Hold Time:${RST}`);
const holdGroups = {};
for (const t of trades) {
  const b = t.holdBucket;
  if (!holdGroups[b]) holdGroups[b] = [];
  holdGroups[b].push(t);
}
for (const bucket of ["<1h", "1-4h", "4h-1d", "1-3d", "3-7d", ">7d"]) {
  const group = holdGroups[bucket];
  if (group && group.length >= 2) printMetrics(bucket, computeMetrics(group), "    ");
}

console.log(`\n  ${B}By Entry Hour (ET):${RST}`);
const hourGroups = {};
for (const t of trades) {
  const h = t.entryHour;
  if (h == null) continue;
  if (!hourGroups[h]) hourGroups[h] = [];
  hourGroups[h].push(t);
}
for (const h of Object.keys(hourGroups).sort((a, b) => Number(a) - Number(b))) {
  const group = hourGroups[h];
  if (group.length >= 3) printMetrics(`${String(h).padStart(2)}:00 ET`, computeMetrics(group), "    ");
}

report.sections.timing = {
  by_hold_time: Object.fromEntries(Object.entries(holdGroups).filter(([, g]) => g.length >= 2).map(([k, g]) => [k, computeMetrics(g)])),
  by_hour: Object.fromEntries(Object.entries(hourGroups).filter(([, g]) => g.length >= 3).map(([k, g]) => [k, computeMetrics(g)])),
};

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 7: MANUAL CLASSIFICATIONS & NOTES
// ═══════════════════════════════════════════════════════════════════════════
const annotatedTrades = trades.filter(t => t.manualClass || t.manualNotes);
if (annotatedTrades.length > 0) {
  console.log(`\n${B}═══ 7. MANUAL CLASSIFICATIONS & NOTES ═══${RST}\n`);

  const classGroups = {};
  for (const t of annotatedTrades) {
    const c = t.manualClass || "noted";
    if (!classGroups[c]) classGroups[c] = [];
    classGroups[c].push(t);
  }
  for (const [cls, group] of Object.entries(classGroups).sort((a, b) => b[1].length - a[1].length)) {
    printMetrics(`[${cls}]`, computeMetrics(group), "    ");
    const withNotes = group.filter(t => t.manualNotes);
    for (const t of withNotes.slice(0, 3)) {
      console.log(`      ${DIM}${t.ticker} ${t.direction} ${rnd(t.pnlPct)}%: "${t.manualNotes}"${RST}`);
    }
  }

  report.sections.classifications = Object.fromEntries(
    Object.entries(classGroups).map(([k, g]) => [k, { ...computeMetrics(g), notes: g.filter(t => t.manualNotes).map(t => ({ ticker: t.ticker, pnl: t.pnlPct, note: t.manualNotes })) }])
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 8: TOP-N TRADE NARRATIVES
// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${B}═══ 8. TRADE NARRATIVES (Top ${TOP_N} Best + Worst) ═══${RST}\n`);

const sorted = [...trades].sort((a, b) => b.pnlPct - a.pnlPct);
const best = sorted.slice(0, TOP_N);
const worst = sorted.slice(-TOP_N).reverse();

function narrateTrade(t, label) {
  const dir = String(t.direction).toUpperCase();
  const regime = t.regime_combined || t.state || "?";
  const vixStr = t.vix ? `VIX=${rnd(t.vix, 0)}` : "";
  const pnlColor = t.pnlPct >= 0 ? G : R;
  console.log(`  ${label} ${pnlColor}${t.ticker.padEnd(6)} ${dir.padEnd(5)} ${(t.pnlPct >= 0 ? "+" : "") + rnd(t.pnlPct)}%${RST}  rank=${t.rank || "?"}  R=${rnd(Number(t.rr) || 0)}`);
  console.log(`    Entry: ${msToET(t.entry_ts)}  Exit: ${msToET(t.exit_ts)}  Hold: ${t.holdBucket}`);
  console.log(`    State: ${t.state}  Regime: ${regime}  ${vixStr}  Profile: ${t.execProfile || "?"}`);
  console.log(`    HTF aligned: ${t.htfAligned ? G + "YES" + RST : R + "NO" + RST}  LTF aligned: ${t.ltfAligned ? G + "YES" + RST : R + "NO" + RST}  Squeeze: ${t.squeezeRelease ? "YES" : "no"}`);
  if (t.personality) console.log(`    Ticker personality: ${t.personality}`);
  if (t.avoidableFlags.length) console.log(`    ${R}Flags: [${t.avoidableFlags.join(", ")}]${RST}`);
  if (t.manualClass) console.log(`    Manual class: ${t.manualClass}`);
  if (t.manualNotes) console.log(`    ${DIM}Note: "${t.manualNotes}"${RST}`);
}

console.log(`  ${G}${B}── BEST TRADES ──${RST}`);
for (let i = 0; i < best.length; i++) narrateTrade(best[i], `#${i + 1}`);

console.log(`\n  ${R}${B}── WORST TRADES ──${RST}`);
for (let i = 0; i < worst.length; i++) narrateTrade(worst[i], `#${i + 1}`);

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 9: RECOMMENDATIONS
// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${B}═══ 9. RECOMMENDATIONS ═══${RST}\n`);

const recs = [];

const againstRegimeCnt = (flagCounts.against_regime || 0) + (flagCounts.against_htf_state || 0);
const againstRegimeDmg = (flagDamage.against_regime || 0) + (flagDamage.against_htf_state || 0);
if (againstRegimeCnt >= 3) {
  recs.push({ priority: 1, title: `Block trades against HTF regime (${againstRegimeCnt} trades, -${rnd(againstRegimeDmg)}% damage)`, action: "Add entry guard: reject LONG when regime_combined is bearish, reject SHORT when bullish." });
}

if (htfNotAligned.length >= 5 && computeMetrics(htfNotAligned).wr < 40) {
  recs.push({ priority: 2, title: `Require D+4H SuperTrend alignment (${htfNotAligned.length} unaligned trades at ${computeMetrics(htfNotAligned).wr}% WR)`, action: "Tighten entry gate: require D and 4H SuperTrend to agree with trade direction." });
}

const rapidExits = losses.filter(t => t.avoidableFlags.includes("rapid_exit"));
if (rapidExits.length >= 3) {
  const dmg = rapidExits.reduce((s, t) => s + Math.abs(t.pnlPct), 0);
  recs.push({ priority: 3, title: `Add minimum hold guard (${rapidExits.length} trades stopped in <4h, -${rnd(dmg)}% damage)`, action: "Delay non-emergency exits for at least 4-6 hours after entry. Only allow emergency SL hits." });
}

if (toxicTickers.length >= 2) {
  const tickerList = toxicTickers.slice(0, 5).map(t => t.ticker).join(", ");
  const dmg = toxicTickers.reduce((s, t) => s + Math.abs(t.total), 0);
  recs.push({ priority: 4, title: `Auto-ban toxic tickers: ${tickerList} (-${rnd(dmg)}% total)`, action: "Add these tickers to a deny list or require rank >= 85 for entry." });
}

const lowRankLosses = losses.filter(t => t.avoidableFlags.includes("low_rank"));
if (lowRankLosses.length >= 3) {
  const dmg = lowRankLosses.reduce((s, t) => s + Math.abs(t.pnlPct), 0);
  recs.push({ priority: 5, title: `Raise minimum rank threshold (${lowRankLosses.length} low-rank losses, -${rnd(dmg)}%)`, action: "Increase calibrated_rank_min from current value to at least 65." });
}

recs.sort((a, b) => a.priority - b.priority);
for (const r of recs) {
  console.log(`  ${Y}#${r.priority}${RST} ${B}${r.title}${RST}`);
  console.log(`     → ${r.action}\n`);
}

if (recs.length === 0) {
  console.log(`  ${G}No strong recommendations — system is performing within expectations.${RST}\n`);
}

report.sections.recommendations = recs;

// ═══════════════════════════════════════════════════════════════════════════
// OUTPUT
// ═══════════════════════════════════════════════════════════════════════════
if (JSON_OUT) {
  const outPath = path.join(__dirname, "../data", `trade-intelligence-${RUN_ID ? RUN_ID.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60) : "live"}-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`  Report saved: ${outPath}`);
}

console.log(`\n  [${elapsed()}] Done.\n`);
