#!/usr/bin/env node
/**
 * Phase 3 — Per-leg verdict generator for the Trend-Hold backtest.
 *
 * Compares trader baseline vs trader-with-TH vs investor for one
 * monthly leg. Surfaces TH promotion / demotion counts, suppressed-exit
 * savings, and the SNDK case-study validation.
 *
 * Usage:
 *   node scripts/build-investor-monthly-verdict.js \
 *     --month 2025-07 \
 *     --trader-run-id   phase-c-stage1-jul2025-may2026 \
 *     --th-run-id       phase-c-stage2-trader-th-jul2025-may2026 \
 *     --api-base        https://timed-trading-ingest-preprod.shashant.workers.dev \
 *     --out             tasks/phase-c/monthly-verdicts/2025-07-investor.md
 *
 * Env: TIMED_TRADING_API_KEY (or TIMED_API_KEY)
 *
 * Reads from worker:
 *   GET /timed/admin/backtests/run-trades?run_id=...   for trader + th runs
 *   GET /timed/admin/data-audit-log?op=trend_hold_promote
 *   GET /timed/admin/data-audit-log?op=trend_hold_demote
 *   GET /timed/admin/ledger-inspect?mode=investor      for investor leg
 *
 * Writes:
 *   tasks/phase-c/monthly-verdicts/<YYYY-MM>-investor.md
 *
 * Side-effect free: read-only. Does not mutate D1, KV, or trades.
 */

import fs from 'node:fs';
import path from 'node:path';

// ─────────────────────────────────────────────────────────────────────
// Args + env
// ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      out[key] = v;
    }
  }
  return out;
}

const args = parseArgs(process.argv);
const MONTH = args.month;
if (!MONTH || !/^\d{4}-\d{2}$/.test(MONTH)) {
  console.error('ERROR: --month YYYY-MM required');
  process.exit(2);
}
const TRADER_RUN_ID = args['trader-run-id'] || 'phase-c-stage1-jul2025-may2026';
const TH_RUN_ID = args['th-run-id'] || null;
const INVESTOR_MODE = args['investor-mode'] || 'investor';
const API_BASE = args['api-base'] || process.env.PREPROD_BASE || 'https://timed-trading-ingest.shashant.workers.dev';
const OUT_PATH = args.out || path.join('/workspace/tasks/phase-c/monthly-verdicts', `${MONTH}-investor.md`);
const API_KEY = process.env.TIMED_TRADING_API_KEY || process.env.TIMED_API_KEY;
if (!API_KEY) { console.error('ERROR: TIMED_TRADING_API_KEY env required'); process.exit(2); }

const monthStartMs = Date.UTC(Number(MONTH.slice(0, 4)), Number(MONTH.slice(5, 7)) - 1, 1);
const monthEndMs = (() => {
  const y = Number(MONTH.slice(0, 4));
  const m = Number(MONTH.slice(5, 7));
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 0 : m;
  return Date.UTC(ny, nm, 1);
})();

// ─────────────────────────────────────────────────────────────────────
// HTTP
// ─────────────────────────────────────────────────────────────────────
async function fetchJson(url, opts = {}) {
  const res = await fetch(url, { ...opts, headers: { 'User-Agent': 'phase-c-verdict/1.0', ...(opts.headers || {}) } });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${url.slice(0, 80)}`);
  return await res.json();
}

async function fetchRunTrades(runId) {
  if (!runId) return [];
  const url = `${API_BASE}/timed/admin/backtests/run-trades?run_id=${encodeURIComponent(runId)}&limit=20000&key=${encodeURIComponent(API_KEY)}`;
  const j = await fetchJson(url);
  if (!j.ok) throw new Error(`run-trades failed for ${runId}: ${j.error}`);
  return j.trades || [];
}

async function fetchAuditOps(op, since) {
  // Opportunistic — endpoint may not support op filter on older deploys.
  const url = `${API_BASE}/timed/admin/data-audit-log?op=${encodeURIComponent(op)}&since=${since}&limit=5000&key=${encodeURIComponent(API_KEY)}`;
  try {
    const j = await fetchJson(url);
    if (!j.ok) return [];
    return j.rows || j.entries || [];
  } catch { return []; }
}

// ─────────────────────────────────────────────────────────────────────
// Aggregations
// ─────────────────────────────────────────────────────────────────────
function inMonth(ts) { return ts >= monthStartMs && ts < monthEndMs; }

function summarizeTrades(trades, label) {
  const inWindow = trades.filter(t => inMonth(Number(t.entry_ts)));
  const closed = inWindow.filter(t => t.status && t.status !== 'OPEN');
  const wins = closed.filter(t => Number(t.pnl_pct) > 0).length;
  const losses = closed.filter(t => Number(t.pnl_pct) < 0).length;
  const sumPnlPct = closed.reduce((s, t) => s + (Number(t.pnl_pct) || 0), 0);
  const sumPnlDollars = closed.reduce((s, t) => s + (Number(t.pnl) || 0), 0);
  const sumMfe = closed.reduce((s, t) => s + (Number(t.max_favorable_excursion) || 0), 0);
  return {
    label, n_in_window: inWindow.length, closed: closed.length, open: inWindow.length - closed.length,
    wins, losses, wr: closed.length ? wins / closed.length : 0,
    sum_pnl_pct: sumPnlPct, sum_pnl_dollars: sumPnlDollars, sum_mfe_pct: sumMfe,
    giveback_pct: sumMfe - sumPnlPct,
    avg_pnl_pct: closed.length ? sumPnlPct / closed.length : 0,
    avg_mfe_pct: closed.length ? sumMfe / closed.length : 0,
  };
}

function thStats(thTrades) {
  const inWindow = thTrades.filter(t => inMonth(Number(t.entry_ts)));
  const promotions = inWindow.filter(t => t.trend_hold_promoted_at != null).length;
  const demotions = inWindow.filter(t => t.trend_hold_demoted_at != null).length;
  const stillActive = inWindow.filter(t => String(t.trend_hold_state || '').toLowerCase() === 'active').length;
  const flavorCount = {};
  for (const t of inWindow) {
    const f = t.trend_hold_flavor;
    if (f) flavorCount[f] = (flavorCount[f] || 0) + 1;
  }
  return { promotions, demotions, still_active: stillActive, flavor_count: flavorCount };
}

function suppressionAnalysis(trader, th) {
  const SUPPRESSED = new Set([
    'HARD_FUSE_RSI_EXTREME', 'PROFIT_GIVEBACK_STAGE_HOLD', 'PROFIT_GIVEBACK_COOLING_HOLD',
    'SMART_RUNNER_SUPPORT_BREAK_CLOUD', 'mfe_decay_structural_flatten', 'ST_FLIP_4H_CLOSE',
  ]);
  const traderHits = trader.filter(t => inMonth(Number(t.entry_ts)) && SUPPRESSED.has(t.exit_reason)).length;
  const thHits = th.filter(t => inMonth(Number(t.entry_ts)) && SUPPRESSED.has(t.exit_reason)).length;
  const reduction = traderHits - thHits;
  return { trader_suppressed_hits: traderHits, th_suppressed_hits: thHits, reduction };
}

function blueprintCaseStudy(ticker, trader, th) {
  const t = trader.filter(x => x.ticker === ticker && inMonth(Number(x.entry_ts)));
  const tt = th.filter(x => x.ticker === ticker && inMonth(Number(x.entry_ts)));
  const sumPnl = (arr) => arr.reduce((s, x) => s + (Number(x.pnl_pct) || 0), 0);
  const maxPnl = (arr) => arr.length ? Math.max(...arr.map(x => Number(x.pnl_pct) || 0)) : 0;
  return {
    ticker,
    trader_count: t.length,
    th_count: tt.length,
    trader_sum_pnl: sumPnl(t),
    th_sum_pnl: sumPnl(tt),
    trader_max_pnl: maxPnl(t),
    th_max_pnl: maxPnl(tt),
    th_promoted: tt.filter(x => x.trend_hold_promoted_at != null).length,
    th_active_at_exit: tt.filter(x => String(x.trend_hold_state || '').toLowerCase() === 'active').length,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Markdown rendering
// ─────────────────────────────────────────────────────────────────────
function f(x, dp = 2) {
  if (x == null || !Number.isFinite(Number(x))) return '·';
  const n = Number(x);
  return (Math.round(n * Math.pow(10, dp)) / Math.pow(10, dp)).toFixed(dp);
}

function pct(x, dp = 1) { return x == null ? '·' : `${f(x, dp)}%`; }

function renderMarkdown({ trader, th, traderSummary, thSummary, thLifecycle, suppression, blueprints }) {
  const md = [];
  md.push(`# Phase C — Investor / Trend-Hold Verdict — ${MONTH}`);
  md.push('');
  md.push(`Generated: ${new Date().toISOString().slice(0, 19)}Z`);
  md.push(`Window: \`${MONTH}-01\` → start of next month`);
  md.push(`Trader run: \`${TRADER_RUN_ID}\` (${trader.length} total trades, ${traderSummary.n_in_window} in window)`);
  md.push(`Trend-Hold run: ${TH_RUN_ID ? `\`${TH_RUN_ID}\` (${th.length} total trades, ${thSummary.n_in_window} in window)` : '*not provided — comparison disabled*'}`);
  md.push('');

  // ── Headline ────────────────────────────────────────────────────────
  md.push('## Headline');
  md.push('');
  md.push('| metric | trader baseline | trader + TH | delta |');
  md.push('|---|---:|---:|---:|');
  if (TH_RUN_ID) {
    md.push(`| Trades opened | ${traderSummary.n_in_window} | ${thSummary.n_in_window} | ${thSummary.n_in_window - traderSummary.n_in_window} |`);
    md.push(`| Closed | ${traderSummary.closed} | ${thSummary.closed} | ${thSummary.closed - traderSummary.closed} |`);
    md.push(`| Still open | ${traderSummary.open} | ${thSummary.open} | ${thSummary.open - traderSummary.open} |`);
    md.push(`| Win rate | ${pct(traderSummary.wr * 100)} | ${pct(thSummary.wr * 100)} | ${pct((thSummary.wr - traderSummary.wr) * 100)} |`);
    md.push(`| Σ pnl % | ${pct(traderSummary.sum_pnl_pct)} | ${pct(thSummary.sum_pnl_pct)} | ${pct(thSummary.sum_pnl_pct - traderSummary.sum_pnl_pct)} |`);
    md.push(`| Σ pnl $ | $${f(traderSummary.sum_pnl_dollars, 0)} | $${f(thSummary.sum_pnl_dollars, 0)} | $${f(thSummary.sum_pnl_dollars - traderSummary.sum_pnl_dollars, 0)} |`);
    md.push(`| Σ MFE % | ${pct(traderSummary.sum_mfe_pct)} | ${pct(thSummary.sum_mfe_pct)} | ${pct(thSummary.sum_mfe_pct - traderSummary.sum_mfe_pct)} |`);
    md.push(`| Σ giveback % (mfe − pnl) | ${pct(traderSummary.giveback_pct)} | ${pct(thSummary.giveback_pct)} | ${pct(thSummary.giveback_pct - traderSummary.giveback_pct)} |`);
  } else {
    md.push(`| Trades opened | ${traderSummary.n_in_window} | n/a | — |`);
    md.push(`| Σ pnl % | ${pct(traderSummary.sum_pnl_pct)} | n/a | — |`);
    md.push(`| Σ giveback % | ${pct(traderSummary.giveback_pct)} | n/a | — |`);
  }
  md.push('');

  // ── TH lifecycle ───────────────────────────────────────────────────
  if (TH_RUN_ID) {
    md.push('## Trend-Hold lifecycle');
    md.push('');
    md.push(`- Promotions in this window: **${thLifecycle.promotions}**`);
    md.push(`- Demotions in this window: **${thLifecycle.demotions}**`);
    md.push(`- Still active at end of window: **${thLifecycle.still_active}**`);
    const flavors = Object.entries(thLifecycle.flavor_count).map(([k, v]) => `${k}=${v}`).join(', ');
    md.push(`- Flavor breakdown: ${flavors || '*none*'}`);
    md.push('');

    // ── Suppression savings ──────────────────────────────────────────
    md.push('## Suppression savings');
    md.push('');
    md.push(`Closed trades whose \`exit_reason\` matched a suppressed doctrine (HARD_FUSE_RSI_EXTREME, PROFIT_GIVEBACK_*, SMART_RUNNER_SUPPORT_BREAK_CLOUD, mfe_decay_structural_flatten, ST_FLIP_4H_CLOSE):`);
    md.push('');
    md.push(`- Trader baseline: **${suppression.trader_suppressed_hits}** trades closed via suppressed reasons.`);
    md.push(`- Trader + TH:    **${suppression.th_suppressed_hits}** trades closed via suppressed reasons.`);
    md.push(`- **Reduction**: ${suppression.reduction} trades (giveback exits prevented = capture saved).`);
    md.push('');
  }

  // ── Blueprint case studies ─────────────────────────────────────────
  if (TH_RUN_ID && blueprints.length) {
    md.push('## Blueprint case studies (RESILIENT_TREND targets)');
    md.push('');
    md.push('| ticker | trader trades | TH trades | trader Σ pnl% | TH Σ pnl% | trader max pnl% | TH max pnl% | TH promoted | active at exit |');
    md.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|');
    for (const b of blueprints) {
      md.push(`| **${b.ticker}** | ${b.trader_count} | ${b.th_count} | ${pct(b.trader_sum_pnl)} | ${pct(b.th_sum_pnl)} | ${pct(b.trader_max_pnl)} | ${pct(b.th_max_pnl)} | ${b.th_promoted} | ${b.th_active_at_exit} |`);
    }
    md.push('');
    md.push('**Pass criterion (per ticker, full Jul→May window — verify at end of multi-leg run, not per-month):**');
    md.push('- TH trade count drops vs trader (round-trip → ride collapse).');
    md.push('- Σ TH pnl% ≥ 2× trader baseline.');
    md.push('- Max single-trade TH pnl% ≥ 30%.');
    md.push('- ≥ 1 TH trade still active at end of window OR exited via demotion (NOT via a suppressed reason).');
    md.push('');
  }

  // ── Per-trade detail (TH only — diagnostic) ─────────────────────────
  if (TH_RUN_ID && thSummary.n_in_window > 0) {
    md.push('## TH-run per-trade detail (this window)');
    md.push('');
    md.push('| ticker | entry | exit | dir | mfe% | pnl% | exit reason | TH state | TH flavor | TH max mfe% |');
    md.push('|---|---|---|---|---:|---:|---|---|---|---:|');
    const inWindow = th.filter(t => inMonth(Number(t.entry_ts))).slice(0, 60);
    inWindow.sort((a, b) => Number(a.entry_ts) - Number(b.entry_ts));
    for (const t of inWindow) {
      const ed = new Date(Number(t.entry_ts)).toISOString().slice(0, 10);
      const xd = t.exit_ts ? new Date(Number(t.exit_ts)).toISOString().slice(0, 10) : 'OPEN';
      md.push(`| ${t.ticker} | ${ed} | ${xd} | ${t.direction} | ${f(t.max_favorable_excursion)} | ${f(t.pnl_pct)} | ${t.exit_reason || '·'} | ${t.trend_hold_state || '·'} | ${t.trend_hold_flavor || '·'} | ${f(t.trend_hold_max_mfe_pct)} |`);
    }
    if (th.filter(t => inMonth(Number(t.entry_ts))).length > 60) {
      md.push(`| *...${th.filter(t => inMonth(Number(t.entry_ts))).length - 60} more rows truncated...* | | | | | | | | | |`);
    }
    md.push('');
  }

  md.push('---');
  md.push('');
  md.push(`Regenerate: \`node scripts/build-investor-monthly-verdict.js --month ${MONTH} --trader-run-id ${TRADER_RUN_ID}${TH_RUN_ID ? ` --th-run-id ${TH_RUN_ID}` : ''} --out ${OUT_PATH}\``);
  return md.join('\n');
}

// ─────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────
async function main() {
  console.error(`[verdict] month=${MONTH} trader=${TRADER_RUN_ID} th=${TH_RUN_ID || '(none)'}`);
  console.error(`[verdict] window: ${new Date(monthStartMs).toISOString().slice(0, 10)} → ${new Date(monthEndMs).toISOString().slice(0, 10)}`);

  const trader = await fetchRunTrades(TRADER_RUN_ID);
  console.error(`[verdict] trader trades: ${trader.length}`);

  let th = [];
  if (TH_RUN_ID) {
    th = await fetchRunTrades(TH_RUN_ID);
    console.error(`[verdict] TH trades: ${th.length}`);
  }

  const traderSummary = summarizeTrades(trader, 'trader');
  const thSummary = summarizeTrades(th, 'trader+TH');
  const thLifecycle = thStats(th);
  const suppression = suppressionAnalysis(trader, th);

  const BLUEPRINT_TICKERS = ['SNDK', 'BE', 'MU', 'SOXL', 'LITE', 'GOOGL', 'AEHR'];
  const blueprints = BLUEPRINT_TICKERS.map(tk => blueprintCaseStudy(tk, trader, th));

  const md = renderMarkdown({ trader, th, traderSummary, thSummary, thLifecycle, suppression, blueprints });

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, md);
  console.error(`[verdict] wrote ${OUT_PATH}`);
  console.error(`[verdict] trader Σ pnl%=${traderSummary.sum_pnl_pct.toFixed(2)} | TH Σ pnl%=${thSummary.sum_pnl_pct.toFixed(2)} | suppressed-hits trader=${suppression.trader_suppressed_hits} th=${suppression.th_suppressed_hits}`);
}

main().catch(e => { console.error(e.stack || e.message); process.exit(1); });
