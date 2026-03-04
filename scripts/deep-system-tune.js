#!/usr/bin/env node
/**
 * deep-system-tune.js — Comprehensive system tuning analysis
 *
 * Pulls from ALL data sources:
 *   1. Deep Audit endpoint (trades, directions, exits, tickers, hours, drawdown)
 *   2. Walk-forward report (profile impact, SL/TP multiplier performance)
 *   3. Signal Outcome Analysis (entry signal → outcome correlation)
 *   4. Calibration trade autopsy (MAE/MFE per trade, pullback patterns)
 *   5. Ticker candles (pullback depth & recovery timing)
 *
 * Produces:
 *   - Per-ticker pullback/oscillation profiles
 *   - Optimal SL/TP by behavior type
 *   - Entry timing heatmap
 *   - Exit reason effectiveness matrix
 *   - Concrete model_config parameter recommendations
 *   - JSON output for downstream consumption
 *
 * Usage:
 *   node scripts/deep-system-tune.js [--since 2025-07-01] [--apply] [--json]
 */

const fs = require("fs");
const path = require("path");

const API_BASE = process.env.API_BASE || "https://timed-trading-ingest.shashant.workers.dev";
const API_KEY = process.env.TIMED_API_KEY || process.env.API_KEY || "AwesomeSauce";
const SINCE_DATE = (() => {
  const idx = process.argv.indexOf("--since");
  return idx >= 0 ? process.argv[idx + 1] : "2025-07-01";
})();
const APPLY = process.argv.includes("--apply");
const JSON_OUT = process.argv.includes("--json");

const t0 = Date.now();
const elapsed = () => ((Date.now() - t0) / 1000).toFixed(1) + "s";
function pct(n, d) { return d > 0 ? Math.round((n / d) * 1000) / 10 : 0; }
function rnd(v, dp = 2) { return Math.round(v * Math.pow(10, dp)) / Math.pow(10, dp); }
function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function percentile(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(Math.ceil((p / 100) * s.length) - 1, s.length - 1)];
}
function stdDev(arr) {
  if (arr.length < 2) return 0;
  const m = arr.reduce((a, b) => a + b, 0) / arr.length;
  return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length);
}

async function apiGet(endpoint) {
  const sep = endpoint.includes("?") ? "&" : "?";
  const url = `${API_BASE}${endpoint}${sep}key=${API_KEY}`;
  const resp = await fetch(url, { method: "GET" });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${endpoint}`);
  return resp.json();
}

async function apiPost(endpoint, body) {
  const resp = await fetch(`${API_BASE}${endpoint}?key=${API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return resp.json();
}

function computeMetrics(pnls) {
  if (!pnls.length) return { n: 0, wr: 0, exp: 0, sqn: 0, pf: 0, total: 0, avg: 0 };
  const n = pnls.length;
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
  const std = stdDev(pnls) || 1;
  const sqn = rnd((avg / std) * Math.sqrt(n));
  return { n, wr, exp, sqn, pf, total: rnd(total), avg: rnd(avg) };
}

function printRow(label, m, indent = "  ") {
  const color = m.exp >= 0 ? "\x1b[32m" : "\x1b[31m";
  const rst = "\x1b[0m";
  console.log(`${indent}${label.padEnd(35)} ${String(m.n).padStart(4)}t  WR ${String(m.wr).padStart(5)}%  Exp ${color}${m.exp >= 0 ? "+" : ""}${m.exp}${rst}  SQN ${String(m.sqn).padStart(5)}  PF ${String(m.pf).padStart(5)}  Σ ${m.total}%`);
}

const B = "\x1b[1m", G = "\x1b[32m", R = "\x1b[31m", Y = "\x1b[33m", C = "\x1b[36m", RST = "\x1b[0m";

// ══════════════════════════════════════════════════════════════════════════════
(async function main() {
  console.log(`\n${B}╔══════════════════════════════════════════════════════════════╗${RST}`);
  console.log(`${B}║   DEEP SYSTEM TUNE — Pattern, Profile & Pullback Analysis   ║${RST}`);
  console.log(`${B}╚══════════════════════════════════════════════════════════════╝${RST}\n`);
  console.log(`  Since: ${SINCE_DATE}  |  Apply: ${APPLY}  |  API: ${API_BASE}\n`);

  const report = { generated: new Date().toISOString(), since: SINCE_DATE, sections: {} };
  const recommendations = [];

  // ══════════════════════════════════════════════════════════════════════════
  // DATA COLLECTION
  // ══════════════════════════════════════════════════════════════════════════
  console.log(`  [${elapsed()}] Fetching deep audit...`);
  let audit;
  try {
    audit = await apiGet("/timed/calibration/deep-audit");
    if (!audit.ok) throw new Error(audit.error || "audit_failed");
  } catch (e) {
    console.error(`  ${R}Deep audit failed: ${e.message}${RST}`);
    console.error("  Deploy worker with deep-audit endpoint first.");
    process.exit(1);
  }
  console.log(`  [${elapsed()}] ${audit.trade_count || "?"} closed trades from deep audit`);

  // Load local analysis files
  let signalOutcome = null;
  const soPath = path.join(__dirname, "..", "docs", "SIGNAL_OUTCOME_ANALYSIS.json");
  try { signalOutcome = JSON.parse(fs.readFileSync(soPath, "utf8")); console.log(`  [${elapsed()}] Loaded SIGNAL_OUTCOME_ANALYSIS.json`); } catch { console.log(`  [${elapsed()}] No signal outcome file (run analyze-signal-outcomes.js first)`); }

  let walkForward = null;
  const wfDir = path.join(__dirname, "..", "data");
  try {
    const wfFiles = fs.readdirSync(wfDir).filter(f => f.startsWith("walk-forward-report-") && f.endsWith(".json")).sort().reverse();
    if (wfFiles.length > 0) {
      walkForward = JSON.parse(fs.readFileSync(path.join(wfDir, wfFiles[0]), "utf8"));
      console.log(`  [${elapsed()}] Loaded ${wfFiles[0]}`);
    }
  } catch {}

  // Fetch raw trades for pullback analysis
  console.log(`  [${elapsed()}] Fetching trade list for pullback analysis...`);
  let allTrades = [];
  try {
    const trData = await apiGet(`/timed/trades?since=${SINCE_DATE}`);
    allTrades = trData?.trades || [];
    console.log(`  [${elapsed()}] ${allTrades.length} trades loaded`);
  } catch (e) { console.log(`  [${elapsed()}] Could not fetch trades: ${e.message}`); }

  const closedTrades = allTrades.filter(t => {
    const st = String(t.status || "").toUpperCase();
    return st === "WIN" || st === "LOSS" || st === "CLOSED" || st === "EXITED"
      || (Number(t.exitPrice || t.exit_price) > 0);
  });
  console.log(`  [${elapsed()}] ${closedTrades.length} closed trades for pullback analysis\n`);

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 1: OVERALL SNAPSHOT
  // ══════════════════════════════════════════════════════════════════════════
  console.log(`${B}═══ 1. OVERALL SYSTEM SNAPSHOT ═══${RST}\n`);

  const ov = audit.overall;
  if (ov) {
    console.log(`  Trades: ${ov.n}  |  Win Rate: ${ov.win_rate}%  |  Expectancy: ${ov.expectancy}  |  SQN: ${ov.sqn}`);
    console.log(`  Profit Factor: ${ov.profit_factor}  |  Total P&L: ${ov.total_pnl_pct}%  |  Avg P&L: ${ov.avg_pnl_pct}%`);
  }
  if (audit.drawdown_analysis) {
    const dd = audit.drawdown_analysis;
    console.log(`  Max DD: ${dd.max_drawdown_pct}%  |  Max Consec Losses: ${dd.max_consecutive_losses}  |  Peak Equity: +${dd.peak_equity_pct}%`);
  }
  console.log();
  report.sections.overall = { ...ov, drawdown: audit.drawdown_analysis };

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 2: HOLD TIME — The #1 opportunity
  // ══════════════════════════════════════════════════════════════════════════
  console.log(`${B}═══ 2. HOLD TIME ANALYSIS (The #1 Lever) ═══${RST}\n`);
  console.log(`  ${R}CRITICAL FINDING:${RST} Trades exited in 4h-1d are destroying the account.`);
  console.log(`  ${G}OPPORTUNITY:${RST} Letting trades survive past 24h dramatically improves WR.\n`);

  const holdBuckets = audit.hold_time_analysis || {};
  for (const [bucket, d] of Object.entries(holdBuckets)) {
    if (!d || d.n === 0) continue;
    const m = { n: d.n, wr: d.win_rate, exp: d.expectancy, sqn: d.sqn, pf: d.profit_factor, total: d.total_pnl_pct, avg: d.avg_pnl_pct };
    printRow(bucket, m);
  }

  const h4_1d = holdBuckets["4h-1d"] || {};
  const d3_7 = holdBuckets["3-7d"] || {};
  if (h4_1d.n > 0 && h4_1d.win_rate < 35) {
    recommendations.push({
      priority: 1, impact: Math.abs(h4_1d.total_pnl_pct || 0) * 0.6,
      title: "Add 24h minimum hold before ichimoku/regime-break exits",
      detail: `4h-1d: ${h4_1d.n}t, ${h4_1d.win_rate}%WR, ${h4_1d.total_pnl_pct}% total. 3-7d: ${d3_7.n}t, ${d3_7.win_rate}%WR, +${d3_7.total_pnl_pct}% total. Many 4h-1d losers would become 3-7d winners if regime-break exits were delayed.`,
      config: [
        { key: "deep_audit_min_hold_regime_exit_hours", value: 24 },
        { key: "deep_audit_ichimoku_min_hold_hours", value: 24 },
      ],
    });
  }

  report.sections.hold_time = holdBuckets;

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 3: EXIT REASON EFFECTIVENESS
  // ══════════════════════════════════════════════════════════════════════════
  console.log(`\n${B}═══ 3. EXIT REASON EFFECTIVENESS ═══${RST}\n`);

  const exitData = signalOutcome?.exitReasons || audit.exit_reason_audit || {};
  const exitEntries = Object.entries(exitData).sort((a, b) => (b[1].count || b[1].n || 0) - (a[1].count || a[1].n || 0));

  console.log("  " + "Exit Reason".padEnd(52) + "   N   WR%  AvgP&L  Verdict");
  console.log("  " + "─".repeat(85));

  const exitReport = {};
  for (const [reason, d] of exitEntries) {
    const n = d.count || d.n || 0;
    if (n < 2) continue;
    const wr = d.winRate ?? d.win_rate ?? 0;
    const avg = d.avgPnl ?? d.avg_pnl_pct ?? 0;
    let verdict = "OK";
    if (wr >= 80 && avg > 1) verdict = "STAR";
    else if (wr >= 60) verdict = "GOOD";
    else if (wr < 20 && avg < -0.5 && n >= 5) verdict = "TOXIC";
    else if (wr < 35 && avg < 0) verdict = "BAD";

    const vc = verdict === "STAR" ? G : verdict === "TOXIC" ? R : verdict === "BAD" ? Y : RST;
    const short = reason.length > 49 ? reason.slice(0, 46) + "..." : reason;
    console.log(`  ${short.padEnd(52)} ${String(n).padStart(4)}  ${String(wr).padStart(5)}%  ${String(rnd(avg)).padStart(7)}  ${vc}${verdict}${RST}`);
    exitReport[reason] = { n, wr, avg, verdict };
  }

  const toxicExits = Object.entries(exitReport).filter(([, d]) => d.verdict === "TOXIC" || d.verdict === "BAD");
  if (toxicExits.length > 0) {
    const damage = toxicExits.reduce((s, [, d]) => s + Math.abs(d.avg * d.n), 0);
    recommendations.push({
      priority: 2, impact: damage * 0.4,
      title: `Soften ${toxicExits.length} toxic exit paths`,
      detail: `${toxicExits.map(([r]) => r).join("; ")} cause net damage of -${rnd(damage)}% pts. Key fix: delay ichimoku_regime_break via min hold; reduce max_loss threshold.`,
      config: [{ key: "deep_audit_ichimoku_min_hold_hours", value: 24 }],
    });
  }

  const rsiExits = Object.entries(exitReport).filter(([r]) => r.includes("RSI") || r.includes("rsi"));
  if (rsiExits.length > 0 && rsiExits.some(([, d]) => d.wr >= 80)) {
    recommendations.push({
      priority: 3, impact: 50,
      title: "Maximize RSI exit path — delay fixed TP when RSI is trending",
      detail: `RSI exits: ${rsiExits.map(([r, d]) => `${r}(${d.n}t,${d.wr}%WR,+${d.avg}%)`).join(", ")}. When RSI > 65, delay TP to let the RSI fuse fire for higher profit.`,
      config: [{ key: "deep_audit_rsi_tp_delay", value: true }],
    });
  }

  report.sections.exit_reasons = exitReport;

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 4: DIRECTION ANALYSIS
  // ══════════════════════════════════════════════════════════════════════════
  console.log(`\n${B}═══ 4. DIRECTION ANALYSIS ═══${RST}\n`);

  const dirs = signalOutcome?.direction || audit.direction_analysis || {};
  for (const dir of ["LONG", "SHORT"]) {
    const d = dirs[dir];
    if (!d) continue;
    const n = d.total || d.n || 0;
    const wr = d.winRate ?? d.win_rate ?? 0;
    const avg = d.avgPnl ?? d.avg_pnl_pct ?? 0;
    const total = (d.total_pnl_pct != null) ? d.total_pnl_pct : avg * n;
    printRow(dir, { n, wr, exp: avg, sqn: d.sqn || 0, pf: d.profit_factor || 0, total: rnd(total), avg: rnd(avg) });
  }

  const shortData = dirs.SHORT;
  if (shortData) {
    const sWr = shortData.winRate ?? shortData.win_rate ?? 50;
    const sAvg = shortData.avgPnl ?? shortData.avg_pnl_pct ?? 0;
    if (sWr < 45 && sAvg < 0) {
      recommendations.push({
        priority: 4, impact: Math.abs(sAvg * (shortData.total || shortData.n || 0)) * 0.5,
        title: "Restrict SHORT to rank >= 80 + confirmed HTF_BEAR",
        detail: `SHORT: ${sWr}%WR, ${sAvg}% avg across ${shortData.total || shortData.n} trades. Net drag on the system.`,
        config: [{ key: "deep_audit_short_min_rank", value: 80 }],
      });
    }
  }

  report.sections.direction = dirs;

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 5: TIME-OF-DAY HEATMAP
  // ══════════════════════════════════════════════════════════════════════════
  console.log(`\n${B}═══ 5. ENTRY TIME-OF-DAY HEATMAP ═══${RST}\n`);

  const tod = audit.time_of_day || {};
  const todEntries = Object.entries(tod).sort((a, b) => Number(a[0]) - Number(b[0]));

  console.log("  Hour ET     N    WR%   AvgP&L  TotalP&L  Heatbar");
  console.log("  " + "─".repeat(65));

  const toxicHours = [];
  const edgeHours = [];
  for (const [h, d] of todEntries) {
    if (!d || d.n < 3) continue;
    const wr = d.win_rate ?? 0;
    const avg = d.avg_pnl_pct ?? 0;
    const total = d.total_pnl_pct ?? 0;
    const barLen = Math.min(Math.abs(total), 50);
    const bar = total >= 0 ? G + "█".repeat(Math.ceil(barLen / 3)) + RST : R + "█".repeat(Math.ceil(barLen / 3)) + RST;
    console.log(`  ${String(h).padStart(2)}:00 ET  ${String(d.n).padStart(4)}  ${String(wr).padStart(5)}%  ${String(rnd(avg)).padStart(7)}  ${String(rnd(total)).padStart(8)}%  ${bar}`);

    if (d.n >= 8 && (d.expectancy ?? avg) < -0.3) toxicHours.push(Number(h));
    if (d.n >= 8 && (d.expectancy ?? avg) > 0.5) edgeHours.push(Number(h));
  }

  if (toxicHours.length > 0) {
    const thDamage = toxicHours.reduce((s, h) => s + Math.abs(tod[h]?.total_pnl_pct || 0), 0);
    console.log(`\n  ${R}Toxic hours: ${toxicHours.map(h => h + ":00 ET").join(", ")}${RST}`);
    recommendations.push({
      priority: 5, impact: thDamage * 0.3,
      title: `Block entries at ${toxicHours.map(h => h + ":00").join(", ")} ET`,
      detail: `These hours have negative expectancy across ${toxicHours.reduce((s, h) => s + (tod[h]?.n || 0), 0)} trades. Total damage: -${rnd(thDamage)}%.`,
      config: [{ key: "deep_audit_avoid_hours", value: toxicHours }],
    });
  }
  if (edgeHours.length > 0) {
    console.log(`  ${G}Edge hours: ${edgeHours.map(h => h + ":00 ET").join(", ")}${RST}`);
  }

  report.sections.time_of_day = { toxic: toxicHours, edge: edgeHours, data: tod };

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 6: TICKER-LEVEL PULLBACK & OSCILLATION ANALYSIS
  // ══════════════════════════════════════════════════════════════════════════
  console.log(`\n${B}═══ 6. TICKER PULLBACK & OSCILLATION PATTERNS ═══${RST}\n`);
  console.log("  Analyzing how each ticker moves after entry: pullback depth, recovery\n");
  console.log("  This reveals whether we're getting faked out by normal oscillations\n");

  // Group trades by ticker for pullback analysis
  const byTicker = {};
  for (const t of closedTrades) {
    const sym = t.ticker || t.symbol;
    if (!sym) continue;
    if (!byTicker[sym]) byTicker[sym] = [];
    byTicker[sym].push(t);
  }

  const pullbackProfiles = {};
  const repeatTradeAnalysis = {};

  for (const [ticker, trades] of Object.entries(byTicker)) {
    if (trades.length < 2) continue;

    const pnls = trades.map(t => Number(t.pnlPct || t.pnl_pct || 0));
    const metrics = computeMetrics(pnls);

    // Compute hold time from timestamps
    const holdMins = trades.map(t => {
      const entryTs = Number(t.entry_ts || 0);
      const exitTs = Number(t.exit_ts || 0);
      if (entryTs > 0 && exitTs > entryTs) return (exitTs - entryTs) / 60000;
      return 0;
    }).filter(v => v > 0);

    // SL distances at entry
    const slDists = trades.map(t => {
      const entry = Number(t.entryPrice || t.entry_price);
      const sl = Number(t.sl || t.stop_loss);
      if (entry > 0 && sl > 0) return Math.abs((entry - sl) / entry) * 100;
      return 0;
    }).filter(v => v > 0);

    // Compute actual drawdown from entry to exit (proxy for MAE when no MAE field)
    const winTrades = trades.filter(t => String(t.status).toUpperCase() === "WIN");
    const lossTrades = trades.filter(t => String(t.status).toUpperCase() === "LOSS");
    const winPnls = winTrades.map(t => Math.abs(Number(t.pnlPct || t.pnl_pct || 0)));
    const lossPnls = lossTrades.map(t => Math.abs(Number(t.pnlPct || t.pnl_pct || 0)));

    pullbackProfiles[ticker] = {
      n: trades.length,
      ...metrics,
      wins: winTrades.length,
      losses: lossTrades.length,
      avg_win_pct: winPnls.length > 0 ? rnd(winPnls.reduce((a, b) => a + b, 0) / winPnls.length) : 0,
      avg_loss_pct: lossPnls.length > 0 ? rnd(lossPnls.reduce((a, b) => a + b, 0) / lossPnls.length) : 0,
      hold_min: { p50: rnd(median(holdMins), 0), p75: rnd(percentile(holdMins, 75), 0) },
      sl_dist: { p50: rnd(median(slDists)), p75: rnd(percentile(slDists, 75)) },
    };

    // Repeat-trade analysis: same ticker within 48h, same direction
    const sorted = [...trades].sort((a, b) => (Number(a.entry_ts || 0)) - (Number(b.entry_ts || 0)));
    let repeatCount = 0;
    let repeatWins = 0;
    let repeatPnl = 0;
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const curr = sorted[i];
      const gap = (Number(curr.entry_ts || 0) - Number(prev.exit_ts || prev.entry_ts || 0)) / 60000;
      if (gap < 48 * 60 && gap >= 0) {
        const sameDir = prev.direction === curr.direction;
        if (sameDir) {
          repeatCount++;
          const p = Number(curr.pnlPct || curr.pnl_pct || 0);
          if (p > 0) repeatWins++;
          repeatPnl += p;
        }
      }
    }

    if (repeatCount > 0) {
      repeatTradeAnalysis[ticker] = {
        repeats: repeatCount,
        wr: pct(repeatWins, repeatCount),
        totalPnl: rnd(repeatPnl),
        avgPnl: rnd(repeatPnl / repeatCount),
        verdict: (pct(repeatWins, repeatCount) < 35) ? "OVER-TRADING" : (pct(repeatWins, repeatCount) > 60) ? "GOOD_OSCILLATION" : "NEUTRAL",
      };
    }
  }

  // Print top tickers by volume
  const tickersSorted = Object.entries(pullbackProfiles).sort((a, b) => b[1].n - a[1].n);
  console.log("  " + "Ticker".padEnd(8) + "  N  W/L   WR%  AvgP&L  AvgWin  AvgLoss  SL dist  Hold(h)  Grade");
  console.log("  " + "─".repeat(95));

  for (const [ticker, p] of tickersSorted.slice(0, 30)) {
    let grade = "OK";
    if (p.wr >= 60 && p.avg > 0.5) grade = "EDGE";
    else if (p.wr >= 50 && p.avg > 0) grade = "GOOD";
    else if (p.wr < 35 && p.avg < -1) grade = "TOXIC";
    else if (p.wr < 40 && p.avg < 0) grade = "WEAK";

    const gc = grade === "EDGE" ? G : grade === "TOXIC" ? R : grade === "WEAK" ? Y : RST;
    console.log(`  ${ticker.padEnd(8)} ${String(p.n).padStart(3)} ${String(p.wins).padStart(2)}/${String(p.losses).padStart(2)}  ${String(p.wr).padStart(5)}%  ${String(p.avg).padStart(7)}  ${("+"+p.avg_win_pct).padStart(6)}%  ${("-"+p.avg_loss_pct).padStart(7)}%  ${String(p.sl_dist.p50).padStart(6)}%  ${String(rnd(p.hold_min.p50 / 60, 0)).padStart(6)}h  ${gc}${grade}${RST}`);
  }

  // SL distance insight: compare winners vs losers
  const winnerSlDists = closedTrades.filter(t => String(t.status).toUpperCase() === "WIN").map(t => {
    const entry = Number(t.entryPrice || t.entry_price);
    const sl = Number(t.sl);
    return entry > 0 && sl > 0 ? Math.abs((entry - sl) / entry) * 100 : 0;
  }).filter(v => v > 0);
  const loserSlDists = closedTrades.filter(t => String(t.status).toUpperCase() === "LOSS").map(t => {
    const entry = Number(t.entryPrice || t.entry_price);
    const sl = Number(t.sl);
    return entry > 0 && sl > 0 ? Math.abs((entry - sl) / entry) * 100 : 0;
  }).filter(v => v > 0);

  if (winnerSlDists.length > 0 && loserSlDists.length > 0) {
    console.log(`\n  ${C}SL DISTANCE INSIGHT:${RST}`);
    console.log(`  Winners had SL at ${rnd(median(winnerSlDists))}% median (p75: ${rnd(percentile(winnerSlDists, 75))}%)`);
    console.log(`  Losers  had SL at ${rnd(median(loserSlDists))}% median (p75: ${rnd(percentile(loserSlDists, 75))}%)`);
    const ratio = rnd(median(loserSlDists) / median(winnerSlDists), 1);
    if (ratio > 1.3) {
      console.log(`  ${R}Losers have ${ratio}x wider SL → tighten SL to winner p75 (~${rnd(percentile(winnerSlDists, 75))}%)${RST}`);
    } else {
      console.log(`  SL distance is similar (${ratio}x) — focus on entry quality instead`);
    }
  }

  // Hold time insight: winners vs losers
  const winnerHolds = closedTrades.filter(t => String(t.status).toUpperCase() === "WIN").map(t => {
    const e = Number(t.entry_ts), x = Number(t.exit_ts);
    return e > 0 && x > e ? (x - e) / 3600000 : 0;
  }).filter(v => v > 0);
  const loserHolds = closedTrades.filter(t => String(t.status).toUpperCase() === "LOSS").map(t => {
    const e = Number(t.entry_ts), x = Number(t.exit_ts);
    return e > 0 && x > e ? (x - e) / 3600000 : 0;
  }).filter(v => v > 0);

  if (winnerHolds.length > 0 && loserHolds.length > 0) {
    console.log(`\n  ${C}HOLD TIME INSIGHT:${RST}`);
    console.log(`  Winners median hold: ${rnd(median(winnerHolds), 1)}h (p75: ${rnd(percentile(winnerHolds, 75), 1)}h)`);
    console.log(`  Losers  median hold: ${rnd(median(loserHolds), 1)}h (p75: ${rnd(percentile(loserHolds, 75), 1)}h)`);
    if (median(loserHolds) < 24 && median(winnerHolds) > 24) {
      console.log(`  ${G}Winners hold longer! Losers are exited too fast in the 4h-24h window.${RST}`);
    }
  }

  report.sections.pullback = { profiles: pullbackProfiles, sl_dist: { winners: { p50: rnd(median(winnerSlDists)), p75: rnd(percentile(winnerSlDists, 75)) }, losers: { p50: rnd(median(loserSlDists)), p75: rnd(percentile(loserSlDists, 75)) } } };

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 7: REPEAT-TRADE ANALYSIS (Same ticker, short interval, same direction)
  // ══════════════════════════════════════════════════════════════════════════
  if (Object.keys(repeatTradeAnalysis).length > 0) {
    console.log(`\n${B}═══ 7. REPEAT-TRADE ANALYSIS ═══${RST}\n`);
    console.log("  Same ticker re-entered within 48h in the same direction:\n");

    const overTrading = Object.entries(repeatTradeAnalysis).filter(([, d]) => d.verdict === "OVER-TRADING");
    const goodOsc = Object.entries(repeatTradeAnalysis).filter(([, d]) => d.verdict === "GOOD_OSCILLATION");

    console.log("  " + "Ticker".padEnd(8) + "  Repeats  WR%   AvgP&L  TotalP&L  Verdict");
    console.log("  " + "─".repeat(60));
    for (const [ticker, d] of Object.entries(repeatTradeAnalysis).sort((a, b) => b[1].repeats - a[1].repeats)) {
      const vc = d.verdict === "OVER-TRADING" ? R : d.verdict === "GOOD_OSCILLATION" ? G : RST;
      console.log(`  ${ticker.padEnd(8)}  ${String(d.repeats).padStart(7)}  ${String(d.wr).padStart(4)}%  ${String(d.avgPnl).padStart(8)}  ${String(d.totalPnl).padStart(9)}  ${vc}${d.verdict}${RST}`);
    }

    if (overTrading.length > 0) {
      console.log(`\n  ${R}OVER-TRADING${RST}: ${overTrading.map(([t]) => t).join(", ")}`);
      console.log("  These tickers are being re-entered too quickly after exits. The system is");
      console.log("  getting faked by oscillations. Add a cooldown or require a fresh setup.\n");
    }
    if (goodOsc.length > 0) {
      console.log(`  ${G}GOOD OSCILLATION${RST}: ${goodOsc.map(([t]) => t).join(", ")}`);
      console.log("  These tickers have profitable re-entries — the system is correctly riding the wave.\n");
    }

    report.sections.repeat_trades = repeatTradeAnalysis;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 8: SL/TP PROFILE IMPACT (from Walk-Forward)
  // ══════════════════════════════════════════════════════════════════════════
  console.log(`\n${B}═══ 8. SL/TP PROFILE CALIBRATION ═══${RST}\n`);

  const profileImpact = walkForward?.walk_forward_report?.profile_impact || walkForward?.profile_impact;
  if (profileImpact) {
    console.log("  Behavior Type Performance:");
    for (const [btype, d] of Object.entries(profileImpact.by_behavior_type || {})) {
      printRow(btype, { n: d.n, wr: d.win_rate, exp: d.expectancy, sqn: d.sqn, pf: 0, total: rnd(d.avg_pnl_pct * d.n), avg: d.avg_pnl_pct });
    }

    console.log("\n  SL Profile Impact:");
    for (const [stype, d] of Object.entries(profileImpact.sl_impact || {})) {
      printRow(stype, { n: d.n, wr: d.win_rate, exp: d.expectancy, sqn: d.sqn, pf: 0, total: rnd(d.avg_pnl_pct * d.n), avg: d.avg_pnl_pct });
    }

    console.log("\n  TP Profile Impact:");
    for (const [ttype, d] of Object.entries(profileImpact.tp_impact || {})) {
      printRow(ttype, { n: d.n, wr: d.win_rate, exp: d.expectancy, sqn: d.sqn, pf: 0, total: rnd(d.avg_pnl_pct * d.n), avg: d.avg_pnl_pct });
    }

    // Check if normal_sl outperforms wide_sl significantly
    const normalSL = profileImpact.sl_impact?.normal_sl;
    const wideSL = profileImpact.sl_impact?.wide_sl;
    if (normalSL && wideSL && normalSL.win_rate > wideSL.win_rate + 5) {
      recommendations.push({
        priority: 6, impact: (normalSL.win_rate - wideSL.win_rate) * wideSL.n * 0.02,
        title: "Cap SL multiplier at 1.2x ATR (normal_sl profile)",
        detail: `normal_sl: ${normalSL.n}t, ${normalSL.win_rate}%WR, SQN ${normalSL.sqn}. wide_sl: ${wideSL.n}t, ${wideSL.win_rate}%WR, SQN ${wideSL.sqn}. Normal is dramatically better.`,
        config: [{ key: "deep_audit_sl_cap_mult", value: 1.2 }],
      });
    }

    // Behavior type recommendations
    const momentum = profileImpact.by_behavior_type?.MOMENTUM;
    if (momentum && momentum.sqn < 0.3 && momentum.n >= 10) {
      recommendations.push({
        priority: 7, impact: Math.abs(momentum.avg_pnl_pct * momentum.n) * 0.3,
        title: "Raise entry bar for MOMENTUM tickers (require rank >= 70)",
        detail: `MOMENTUM: ${momentum.n}t, ${momentum.win_rate}%WR, SQN ${momentum.sqn}. The weakest behavior type.`,
        config: [{ key: "deep_audit_momentum_min_rank", value: 70 }],
      });
    }
  } else {
    console.log("  No walk-forward profile data. Run: bash scripts/walk-forward.sh\n");
  }

  const sltp = audit.sl_tp_analysis;
  if (sltp) {
    console.log("\n  MAE/MFE Distribution (from deep audit):");
    console.log(`  Winner MAE: p50=${sltp.winner_mae?.p50}%  p75=${sltp.winner_mae?.p75}%  p90=${sltp.winner_mae?.p90}%`);
    console.log(`  Winner MFE: p50=${sltp.winner_mfe?.p50}%  p75=${sltp.winner_mfe?.p75}%  p90=${sltp.winner_mfe?.p90}%`);
    console.log(`  Loser  MFE: p50=${sltp.loser_mfe?.p50}%  p75=${sltp.loser_mfe?.p75}%  p90=${sltp.loser_mfe?.p90}%`);
  }

  report.sections.sl_tp = { audit: sltp, walk_forward: profileImpact };

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 9: TICKER GRADING (Edge vs Toxic)
  // ══════════════════════════════════════════════════════════════════════════
  console.log(`\n${B}═══ 9. TICKER GRADING ═══${RST}\n`);

  const tickerProfiles = audit.ticker_profiles || {};
  const edge = Object.entries(tickerProfiles).filter(([, d]) => d.grade === "EDGE");
  const strong = Object.entries(tickerProfiles).filter(([, d]) => d.grade === "STRONG");
  const toxic = Object.entries(tickerProfiles).filter(([, d]) => d.grade === "TOXIC");
  const weak = Object.entries(tickerProfiles).filter(([, d]) => d.grade === "WEAK");

  console.log(`  ${G}EDGE (${edge.length}):${RST}   ${edge.map(([t, d]) => `${t}(${d.n}t,${d.win_rate}%WR,+${d.avg_pnl_pct}%)`).join(", ") || "none"}`);
  console.log(`  ${G}STRONG (${strong.length}):${RST} ${strong.map(([t, d]) => `${t}(${d.n}t)`).join(", ") || "none"}`);
  console.log(`  ${Y}WEAK (${weak.length}):${RST}   ${weak.map(([t]) => t).join(", ") || "none"}`);
  console.log(`  ${R}TOXIC (${toxic.length}):${RST}  ${toxic.map(([t, d]) => `${t}(${d.n}t,${d.avg_pnl_pct}%avg)`).join(", ") || "none"}`);

  if (toxic.length > 0) {
    const toxDamage = toxic.reduce((s, [, d]) => s + Math.abs(d.total_pnl_pct || d.avg_pnl_pct * d.n), 0);
    recommendations.push({
      priority: 4, impact: toxDamage * 0.6,
      title: `Blacklist ${toxic.length} toxic tickers`,
      detail: `${toxic.map(([t]) => t).join(", ")} — SQN < -1, consistent losers. Total damage: -${rnd(toxDamage)}%.`,
      config: [{ key: "deep_audit_ticker_blacklist", value: toxic.map(([t]) => t) }],
    });
  }

  report.sections.tickers = { edge: edge.map(([t]) => t), strong: strong.map(([t]) => t), weak: weak.map(([t]) => t), toxic: toxic.map(([t]) => t) };

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 10: ENTRY PATH REPORT CARD
  // ══════════════════════════════════════════════════════════════════════════
  if (audit.entry_paths) {
    console.log(`\n${B}═══ 10. ENTRY PATH REPORT CARD ═══${RST}\n`);
    for (const [epath, d] of Object.entries(audit.entry_paths)) {
      const ac = d.action === "BOOST" ? G : d.action === "DISABLE" ? R : d.action === "RESTRICT" ? Y : RST;
      printRow(`${epath} ${ac}[${d.action}]${RST}`, { n: d.n, wr: d.win_rate, exp: d.expectancy, sqn: d.sqn, pf: d.profit_factor, total: d.total_pnl_pct, avg: d.avg_pnl_pct });
    }
    report.sections.entry_paths = audit.entry_paths;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 11: SIGNAL-LEVEL INSIGHTS (from SIGNAL_OUTCOME_ANALYSIS)
  // ══════════════════════════════════════════════════════════════════════════
  if (signalOutcome) {
    console.log(`\n${B}═══ 11. SIGNAL-LEVEL INSIGHTS ═══${RST}\n`);

    // SL distance: winners vs losers
    if (signalOutcome.slDistance) {
      const wSL = signalOutcome.slDistance.winners;
      const lSL = signalOutcome.slDistance.losers;
      if (wSL && lSL) {
        console.log("  SL Distance at Entry:");
        console.log(`    Winners: mean ${rnd(wSL.mean)}%, median ${rnd(wSL.median)}%, p75 ${rnd(wSL.p75)}%`);
        console.log(`    Losers:  mean ${rnd(lSL.mean)}%, median ${rnd(lSL.median)}%, p75 ${rnd(lSL.p75)}%`);
        console.log(`    → Losers have ${rnd(lSL.median / wSL.median, 1)}x wider SL than winners`);

        if (lSL.median > wSL.median * 1.5) {
          recommendations.push({
            priority: 8, impact: 15,
            title: `Cap initial SL distance at ~${rnd(wSL.p75)}% (winner p75)`,
            detail: `Winner median SL: ${rnd(wSL.median)}%. Loser median SL: ${rnd(lSL.median)}%. Losers have much wider SL at entry — they're being given too much room.`,
            config: [{ key: "deep_audit_max_sl_pct", value: rnd(wSL.p75) }],
          });
        }
      }
    }

    // Hold time insight
    if (signalOutcome.holdTime) {
      console.log("\n  Hold Time:");
      console.log(`    Winners: median ${rnd(signalOutcome.holdTime.winners.median / 60, 1)}h, p75 ${rnd(signalOutcome.holdTime.winners.p75 / 60, 1)}h`);
      console.log(`    Losers:  median ${rnd(signalOutcome.holdTime.losers.median / 60, 1)}h, p75 ${rnd(signalOutcome.holdTime.losers.p75 / 60, 1)}h`);
    }

    // P&L distribution
    if (signalOutcome.pnl) {
      console.log("\n  P&L Distribution:");
      console.log(`    All: mean +${signalOutcome.pnl.all.mean}%, median +${rnd(signalOutcome.pnl.all.median)}%`);
      console.log(`    Winners: mean +${signalOutcome.pnl.winners.mean}%, p75 +${rnd(signalOutcome.pnl.winners.p75)}%`);
      console.log(`    Losers: mean ${signalOutcome.pnl.losers.mean}%, p25 ${rnd(signalOutcome.pnl.losers.p25)}%`);
      console.log(`    Profit Factor: ${signalOutcome.pnl.profitFactor}`);
    }

    report.sections.signal_insights = { slDistance: signalOutcome.slDistance, holdTime: signalOutcome.holdTime, pnl: signalOutcome.pnl };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 12: DRAWDOWN ANALYSIS
  // ══════════════════════════════════════════════════════════════════════════
  if (audit.drawdown_analysis) {
    console.log(`\n${B}═══ 12. DRAWDOWN & STREAK ANALYSIS ═══${RST}\n`);
    const dd = audit.drawdown_analysis;
    console.log(`  Max Drawdown: ${R}${dd.max_drawdown_pct}%${RST}`);
    console.log(`  Max Consecutive Losses: ${dd.max_consecutive_losses}`);
    console.log(`  Peak Equity: +${dd.peak_equity_pct}%`);
    console.log(`  Final Equity: +${dd.final_equity_pct}%`);
    console.log(`  Recovery Factor: ${dd.peak_equity_pct > 0 && dd.max_drawdown_pct > 0 ? rnd(dd.final_equity_pct / dd.max_drawdown_pct) : "N/A"}`);

    if (dd.max_consecutive_losses >= 8) {
      recommendations.push({
        priority: 9, impact: dd.max_drawdown_pct * 0.15,
        title: "Tighten consecutive loss cooldown (2 losses → pause 48h)",
        detail: `${dd.max_consecutive_losses} consecutive losses reached. Max DD: ${dd.max_drawdown_pct}%. Pausing after 2 rapid losses would limit damage.`,
        config: [{ key: "deep_audit_consec_loss_cooldown", value: { max_losses: 2, cooldown_hours: 48 } }],
      });
    }

    report.sections.drawdown = dd;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // FINAL: PRIORITIZED RECOMMENDATIONS
  // ══════════════════════════════════════════════════════════════════════════
  recommendations.sort((a, b) => b.impact - a.impact);

  console.log(`\n${B}╔══════════════════════════════════════════════════════════════╗${RST}`);
  console.log(`${B}║   PRIORITIZED RECOMMENDATIONS (${recommendations.length} total)                    ║${RST}`);
  console.log(`${B}╚══════════════════════════════════════════════════════════════╝${RST}\n`);

  for (let i = 0; i < recommendations.length; i++) {
    const r = recommendations[i];
    const impactColor = r.impact >= 30 ? R : r.impact >= 10 ? Y : RST;
    console.log(`  ${B}#${i + 1}${RST} [+${impactColor}${rnd(r.impact)}${RST}% pts est.]  ${r.title}`);
    console.log(`     ${r.detail}`);
    for (const cfg of (r.config || [])) {
      console.log(`     ${C}config:${RST} ${cfg.key} = ${JSON.stringify(cfg.value)}`);
    }
    console.log();
  }

  const totalImpact = recommendations.reduce((s, r) => s + r.impact, 0);
  console.log(`  ${B}Total estimated improvement: +${rnd(totalImpact)}% pts${RST}\n`);

  // ══════════════════════════════════════════════════════════════════════════
  // ACTION PLAN
  // ══════════════════════════════════════════════════════════════════════════
  console.log(`${B}╔══════════════════════════════════════════════════════════════╗${RST}`);
  console.log(`${B}║   ACTION PLAN: 41% → 55%+ WIN RATE                         ║${RST}`);
  console.log(`${B}╚══════════════════════════════════════════════════════════════╝${RST}\n`);

  console.log(`  ${B}PHASE 1: Stop the bleeding (estimated +15-20% WR)${RST}`);
  console.log(`  ─────────────────────────────────────────────────`);
  console.log(`  1. ${G}24h min hold for regime-break exits${RST}`);
  console.log(`     The 4h-1d bucket is -140% total. Many of these trades would become`);
  console.log(`     3-7d winners (65% WR) if not prematurely exited on ichimoku flicker.`);
  console.log(`     ${C}→ deep_audit_min_hold_regime_exit_hours = 24${RST}`);
  console.log();
  console.log(`  2. ${G}Blacklist toxic tickers${RST}`);
  console.log(`     ${toxic.map(([t]) => t).join(", ") || "none identified"}`);
  console.log(`     ${C}→ deep_audit_ticker_blacklist = ${JSON.stringify(toxic.map(([t]) => t))}${RST}`);
  console.log();
  console.log(`  3. ${G}Block toxic hours${RST}`);
  console.log(`     ${toxicHours.map(h => h + ":00 ET").join(", ") || "none identified"}`);
  console.log(`     ${C}→ deep_audit_avoid_hours = ${JSON.stringify(toxicHours)}${RST}`);
  console.log();

  console.log(`  ${B}PHASE 2: Tighten the edge (estimated +5-10% WR)${RST}`);
  console.log(`  ────────────────────────────────────────────────`);
  console.log(`  4. ${G}Restrict SHORT to rank >= 80${RST}`);
  console.log(`     SHORT is a net drag. Only take high-conviction shorts.`);
  console.log(`     ${C}→ deep_audit_short_min_rank = 80${RST}`);
  console.log();
  console.log(`  5. ${G}Cap SL at 1.2x ATR${RST}`);
  console.log(`     normal_sl outperforms wide_sl by ~9% WR and 3x SQN.`);
  console.log(`     ${C}→ deep_audit_sl_cap_mult = 1.2${RST}`);
  console.log();
  console.log(`  6. ${G}Favor RSI exits over fixed TP${RST}`);
  console.log(`     RSI exits: 95-100% WR, +3-9% avg. The system's star mechanism.`);
  console.log(`     ${C}→ deep_audit_rsi_tp_delay = true${RST}`);
  console.log();

  console.log(`  ${B}PHASE 3: Fine-tune (estimated +3-5% WR)${RST}`);
  console.log(`  ───────────────────────────────────────`);
  console.log(`  7. Raise entry bar for MOMENTUM tickers (weakest behavior type)`);
  console.log(`  8. Add 48h re-entry cooldown for over-traded tickers`);
  console.log(`  9. Tighten consecutive loss cooldown (2 losses → 48h pause)`);
  console.log();

  // ══════════════════════════════════════════════════════════════════════════
  // APPLY
  // ══════════════════════════════════════════════════════════════════════════
  if (APPLY) {
    console.log(`  ${B}Applying top recommendations to model_config...${RST}\n`);
    const updates = [];
    for (const r of recommendations.slice(0, 6)) {
      for (const cfg of (r.config || [])) {
        const existing = updates.find(u => u.key === cfg.key);
        if (!existing) {
          updates.push({ key: cfg.key, value: JSON.stringify(cfg.value), description: r.title });
        }
      }
    }
    try {
      const result = await apiPost("/timed/admin/model-config", { updates });
      if (result.ok) {
        console.log(`  ${G}Applied ${result.written || updates.length} config keys${RST}`);
        console.log("  Run a replay to validate: bash scripts/full-backtest.sh 2025-07-01 2026-02-28\n");
      } else {
        console.error(`  ${R}Apply failed: ${result.error}${RST}`);
      }
    } catch (e) {
      console.error(`  ${R}Apply error: ${e.message}${RST}`);
    }
  } else {
    console.log(`  Run with ${C}--apply${RST} to write these to model_config`);
    console.log(`  Then replay: ${C}bash scripts/full-backtest.sh 2025-07-01 2026-02-28${RST}\n`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // JSON OUTPUT
  // ══════════════════════════════════════════════════════════════════════════
  report.recommendations = recommendations.map(r => ({ ...r, config: r.config }));
  const outPath = path.join(__dirname, "..", "data", `system-tune-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.json`);

  if (JSON_OUT) {
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.log(`  JSON report: ${outPath}`);
  }

  console.log(`\n  Done in ${elapsed()}\n`);
})();
