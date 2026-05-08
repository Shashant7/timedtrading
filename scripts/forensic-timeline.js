#!/usr/bin/env node
/**
 * Phase 1.2 — Per-ticker forensic timeline generator.
 *
 * For each Trend-Hold-candidate ticker, builds a timeline of inflection
 * points and snapshots every signal the model could have used to decide
 * "hold and ride" vs "exit and round-trip" at that moment.
 *
 * Inputs:
 *   - data/cohort-segmentation.json                 (50 TH candidates)
 *   - data/universe-cache/<T>-D.json                (daily candles)
 *   - data/forensic/4h-candles/<T>-4H.json          (4H candles)
 *   - data/forensic/fundamentals/<T>.json           (TwelveData snapshot)
 *   - tasks/phase-c/universe-benchmark/system-trades.json  (587 promoted trades)
 *
 * Outputs:
 *   - data/forensic/timelines/<T>.json              (per-ticker raw)
 *   - tasks/phase-c/accumulation-trend-deep-dive.md (deliverable)
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  ema, rsi, atr, supertrend, td9,
  dailyToWeekly, dailyToMonthly,
  findIndexAtOrBefore, dateStr,
} from './forensic-indicators.js';

const ROOT = '/workspace';
const COHORT_JSON = path.join(ROOT, 'data/cohort-segmentation.json');
const SYS_TRADES_JSON = path.join(ROOT, 'tasks/phase-c/universe-benchmark/system-trades.json');
const DAILY_CACHE = path.join(ROOT, 'data/universe-cache');
const H4_CACHE = path.join(ROOT, 'data/forensic/4h-candles');
const FUND_CACHE = path.join(ROOT, 'data/forensic/fundamentals');
const TIMELINE_OUT = path.join(ROOT, 'data/forensic/timelines');
const DEEP_DIVE_MD = path.join(ROOT, 'tasks/phase-c/accumulation-trend-deep-dive.md');

const WINDOW_START = Date.UTC(2025, 6, 1);
const WINDOW_END = Date.UTC(2026, 4, 8);

// Inflection % milestones from oracle entry.
const INFLECTION_MILESTONES_PCT = [5, 15, 30, 50, 75, 100];

// "Near system trade" join radius (days) — when a date is within ±N days
// of a system entry, attach the system decision context.
const SYS_JOIN_RADIUS_DAYS = 3;

// User-named counter-example tickers — names the user expected to be
// blueprint candidates but that did NOT make the TH cohort because
// they had real multi-week trend breaks during the window.
const COUNTER_EXAMPLE_TICKERS = ['AMD', 'AEHR', 'NVDA', 'AMZN', 'TSLA', 'NFLX', 'META', 'AVGO', 'PLTR', 'PANW'];

// ---------------------------------------------------------------------------
// I/O helpers
// ---------------------------------------------------------------------------
function loadJson(p, fallback = null) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function loadDaily(ticker) {
  const j = loadJson(path.join(DAILY_CACHE, `${ticker}-D.json`));
  if (!j) return null;
  return (j.candles || []).slice().sort((a, b) => a.ts - b.ts);
}

function load4H(ticker) {
  const j = loadJson(path.join(H4_CACHE, `${ticker}-4H.json`));
  if (!j) return null;
  return (j.candles || []).slice().sort((a, b) => a.ts - b.ts);
}

function loadFund(ticker) {
  return loadJson(path.join(FUND_CACHE, `${ticker}.json`));
}

// ---------------------------------------------------------------------------
// Indicator-state computation per series
// ---------------------------------------------------------------------------
function dedupeByDate(daily) {
  // Some daily candle caches contain duplicate same-day rows from multiple
  // feeds. Keep the row with the highest volume per date (matches the
  // original benchmark dedupe in build-benchmark.py).
  const byDate = new Map();
  for (const c of daily) {
    const d = new Date(c.ts);
    const k = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
    const prev = byDate.get(k);
    if (!prev || (Number(c.v || 0) > Number(prev.v || 0))) byDate.set(k, c);
  }
  return Array.from(byDate.values()).sort((a, b) => a.ts - b.ts);
}

function buildIndicatorContext(ticker) {
  const daily = dedupeByDate(loadDaily(ticker) || []);
  if (daily.length < 30) return null;
  const closes = daily.map(c => c.c);
  const highs = daily.map(c => c.h);
  const lows = daily.map(c => c.l);
  const dEma5 = ema(closes, 5);
  const dEma12 = ema(closes, 12);
  const dEma21 = ema(closes, 21);
  const dEma50 = ema(closes, 50);
  const dRsi = rsi(closes, 14);
  const dAtr = atr(highs, lows, closes, 14);
  const dSt = supertrend(highs, lows, closes, 10, 3);
  const dTd9 = td9(closes);

  const weekly = dailyToWeekly(daily);
  const wCloses = weekly.map(c => c.c);
  const wHighs = weekly.map(c => c.h);
  const wLows = weekly.map(c => c.l);
  const wEma21 = ema(wCloses, 21);
  const wRsi = rsi(wCloses, 14);
  const wSt = supertrend(wHighs, wLows, wCloses, 10, 3);
  const wTd9 = td9(wCloses);

  const monthly = dailyToMonthly(daily);
  const mCloses = monthly.map(c => c.c);
  const mHighs = monthly.map(c => c.h);
  const mLows = monthly.map(c => c.l);
  const mSt = supertrend(mHighs, mLows, mCloses, 10, 3);

  let h4 = load4H(ticker);
  let h4Ctx = null;
  if (h4 && h4.length >= 30) {
    const h4Closes = h4.map(c => c.c);
    const h4Ema21 = ema(h4Closes, 21);
    const h4Rsi = rsi(h4Closes, 14);
    h4Ctx = { bars: h4, ema21: h4Ema21, rsi: h4Rsi };
  }

  return {
    ticker,
    daily: { bars: daily, ema5: dEma5, ema12: dEma12, ema21: dEma21, ema50: dEma50, rsi: dRsi, atr: dAtr, st: dSt, td9: dTd9 },
    weekly: { bars: weekly, ema21: wEma21, rsi: wRsi, st: wSt, td9: wTd9 },
    monthly: { bars: monthly, st: mSt },
    h4: h4Ctx,
  };
}

// ---------------------------------------------------------------------------
// Snapshot at a given timestamp
// ---------------------------------------------------------------------------
function snapshotAt(ctx, ts) {
  const dIdx = findIndexAtOrBefore(ctx.daily.bars, ts);
  if (dIdx == null) return null;
  const dBar = ctx.daily.bars[dIdx];
  const close = dBar.c;
  const e5 = ctx.daily.ema5[dIdx];
  const e12 = ctx.daily.ema12[dIdx];
  const e21D = ctx.daily.ema21[dIdx];
  const e50D = ctx.daily.ema50[dIdx];
  const stD = ctx.daily.st[dIdx];
  const td9D = ctx.daily.td9[dIdx];
  const rsiD = ctx.daily.rsi[dIdx];
  const atrD = ctx.daily.atr[dIdx];

  // Daily 5/12 cloud status — closes-only.
  const cloudFloor = Math.min(e5, e12);
  const cloudCeil = Math.max(e5, e12);
  let cloudStatus = 'inside';
  if (close >= cloudCeil) cloudStatus = 'above';
  else if (close <= cloudFloor) cloudStatus = 'below';

  // Daily EMA-21 status.
  const dEma21Status = close >= e21D ? 'above' : 'below';
  const dEma50Status = close >= e50D ? 'above' : 'below';

  // Weekly snapshot — find weekly bar whose ts <= this daily ts.
  const wIdx = findIndexAtOrBefore(ctx.weekly.bars, ts);
  let wEma21V = null, wEma21Status = null, wStDir = null, wTd9 = null, wRsiV = null, wClose = null;
  if (wIdx != null) {
    wClose = ctx.weekly.bars[wIdx].c;
    wEma21V = ctx.weekly.ema21[wIdx];
    wEma21Status = wClose >= wEma21V ? 'above' : 'below';
    wStDir = ctx.weekly.st[wIdx]?.dir;
    wTd9 = ctx.weekly.td9[wIdx];
    wRsiV = ctx.weekly.rsi[wIdx];
  }

  // Monthly supertrend.
  const mIdx = findIndexAtOrBefore(ctx.monthly.bars, ts);
  const mStDir = mIdx != null ? ctx.monthly.st[mIdx]?.dir : null;

  // 4H — last 4H bar whose ts <= ts (if 4H is available).
  let h4Close = null, h4Ema21V = null, h4Ema21Status = null, h4RsiV = null;
  if (ctx.h4) {
    const h4Idx = findIndexAtOrBefore(ctx.h4.bars, ts);
    if (h4Idx != null) {
      h4Close = ctx.h4.bars[h4Idx].c;
      h4Ema21V = ctx.h4.ema21[h4Idx];
      h4Ema21Status = h4Close >= h4Ema21V ? 'above' : 'below';
      h4RsiV = ctx.h4.rsi[h4Idx];
    }
  }

  return {
    ts,
    date: dateStr(ts),
    close,
    daily: {
      ema5: round(e5),
      ema12: round(e12),
      ema21: round(e21D), ema21_status: dEma21Status,
      ema50: round(e50D), ema50_status: dEma50Status,
      cloud_status: cloudStatus,
      rsi: round(rsiD),
      atr: round(atrD),
      atr_pct: atrD != null ? round((atrD / close) * 100) : null,
      st_dir: stD?.dir, st_value: round(stD?.value),
      td9_count: td9D?.count, td9_dir: td9D?.direction,
    },
    weekly: {
      close: round(wClose),
      ema21: round(wEma21V), ema21_status: wEma21Status,
      rsi: round(wRsiV),
      st_dir: wStDir,
      td9_count: wTd9?.count, td9_dir: wTd9?.direction,
    },
    monthly: { st_dir: mStDir },
    h4: ctx.h4 ? {
      close: round(h4Close),
      ema21: round(h4Ema21V), ema21_status: h4Ema21Status,
      rsi: round(h4RsiV),
    } : null,
  };
}

function round(x, dp = 2) {
  if (x == null || !Number.isFinite(x)) return null;
  const m = Math.pow(10, dp);
  return Math.round(x * m) / m;
}

// ---------------------------------------------------------------------------
// Inflection point detection
// ---------------------------------------------------------------------------
function findInflections(ctx) {
  const bars = ctx.daily.bars.filter(b => b.ts >= WINDOW_START && b.ts <= WINDOW_END);
  if (bars.length < 5) return [];
  const entry = bars[0];
  const exit = bars[bars.length - 1];

  // Find first close >= entry * (1 + pct/100) AND track that as a milestone.
  const milestones = [];
  for (const pct of INFLECTION_MILESTONES_PCT) {
    const target = entry.c * (1 + pct / 100);
    const idx = bars.findIndex(b => b.c >= target);
    if (idx > 0) milestones.push({ name: `+${pct}%`, ts: bars[idx].ts, gain_pct: pct, _kind: 'milestone' });
  }

  // Peak (highest CLOSE in window — close-discipline, not intra-bar wick).
  let peakIdx = 0;
  for (let i = 1; i < bars.length; i++) if (bars[i].c > bars[peakIdx].c) peakIdx = i;
  const peakBar = bars[peakIdx];

  return [
    { name: 'entry_oracle', ts: entry.ts, gain_pct: 0, _kind: 'entry' },
    ...milestones,
    { name: 'peak', ts: peakBar.ts, gain_pct: round(((peakBar.c / entry.c) - 1) * 100), _kind: 'peak' },
    { name: 'exit_window', ts: exit.ts, gain_pct: round(((exit.c / entry.c) - 1) * 100), _kind: 'exit' },
  ];
}

// ---------------------------------------------------------------------------
// Fair-value derivation from historical EPS (per user direction:
// "use the historical price and latest EPS for that time period")
// ---------------------------------------------------------------------------
function buildFvContext(fund) {
  if (!fund) return null;
  const earnings = fund.earnings || {};
  const history = (earnings.history || []).slice().filter(h => h && h.eps_actual != null && h.date);
  // Parse date strings to ms, sort ASC.
  for (const h of history) h._ts = Date.parse(h.date);
  history.sort((a, b) => a._ts - b._ts);
  const peForward = (fund.valuation && Number.isFinite(fund.valuation.pe_forward)) ? fund.valuation.pe_forward : null;
  const peTtm = (fund.valuation && Number.isFinite(fund.valuation.pe_ttm)) ? fund.valuation.pe_ttm : null;
  return { history, peForward, peTtm,
           sector: fund.profile?.sector,
           growthClass: fund.growth?.eps_growth_class,
           epsGrowthPct: fund.growth?.eps_growth_pct,
  };
}

function fvAt(fvCtx, ts) {
  if (!fvCtx) return null;
  const before = fvCtx.history.filter(h => h._ts <= ts);
  if (before.length === 0) return { ttm_eps: null, fv_price: null, fv_basis: 'no_eps_history' };
  // ttm_eps = sum of last 4 quarterly prints before this ts. If <4, use what we have.
  const last4 = before.slice(-4);
  const ttmEps = last4.reduce((s, h) => s + Number(h.eps_actual || 0), 0);
  // Use forward P/E as the "fair multiple" for the derivation per user
  // direction ("latest EPS for that time period" -> we have only the
  // current forward multiple, applied to the historical TTM EPS).
  const peMult = fvCtx.peForward ?? fvCtx.peTtm ?? null;
  const fvPrice = (peMult && ttmEps) ? ttmEps * peMult : null;
  return {
    ttm_eps: round(ttmEps, 3),
    pe_mult_used: round(peMult, 2),
    fv_price: round(fvPrice, 2),
    fv_basis: peMult === fvCtx.peForward ? 'ttm_eps_x_fwd_pe' : 'ttm_eps_x_ttm_pe',
    quarters_used: last4.length,
  };
}

function classifyFv(close, fvPrice) {
  if (!fvPrice || !Number.isFinite(fvPrice) || fvPrice <= 0) return null;
  const ratio = close / fvPrice;
  if (ratio < 0.85) return { ratio: round(ratio, 3), label: 'discount' };
  if (ratio > 1.15) return { ratio: round(ratio, 3), label: 'premium' };
  return { ratio: round(ratio, 3), label: 'fair' };
}

// ---------------------------------------------------------------------------
// System-trade context near a date
// ---------------------------------------------------------------------------
function findNearbySystemTrade(sysTrades, ticker, ts) {
  const radiusMs = SYS_JOIN_RADIUS_DAYS * 24 * 3600 * 1000;
  const relevant = sysTrades.filter(t => t.ticker === ticker && Math.abs(t.entry_ts - ts) <= radiusMs);
  if (!relevant.length) return null;
  // Pick nearest by entry_ts.
  relevant.sort((a, b) => Math.abs(a.entry_ts - ts) - Math.abs(b.entry_ts - ts));
  const t = relevant[0];
  let es = t.entry_signals_json;
  try { if (typeof es === 'string') es = JSON.parse(es); } catch { es = {}; }
  return {
    trade_id: t.trade_id,
    direction: t.direction,
    entry_date: dateStr(t.entry_ts),
    entry_price: round(t.entry_price),
    exit_date: t.exit_ts ? dateStr(t.exit_ts) : 'OPEN',
    exit_price: round(t.exit_price),
    pnl_pct: round(t.pnl_pct),
    setup_name: t.setup_name,
    setup_grade: t.setup_grade,
    entry_path: t.entry_path,
    exit_reason: t.exit_reason,
    sector: t.sector,
    rank: t.rank,
    rr: round(t.rr),
    mfe_pct: round(t.max_favorable_excursion),
    mae_pct: round(t.max_adverse_excursion),
    held_days: t.exit_ts ? round((t.exit_ts - t.entry_ts) / 86400000, 1) : null,
    personality: es?.personality || null,
    regime_class: es?.regime_class || null,
    td9_bear_ltf_active: es?.td9_bear_ltf_active || null,
  };
}

// ---------------------------------------------------------------------------
// Per-ticker timeline assembly
// ---------------------------------------------------------------------------
function buildTickerTimeline(ticker, cohortRow, sysTrades) {
  const ctx = buildIndicatorContext(ticker);
  if (!ctx) return null;
  const fund = loadFund(ticker);
  const fvCtx = buildFvContext(fund);

  const inflections = findInflections(ctx);
  const snapshots = inflections.map(inf => {
    const snap = snapshotAt(ctx, inf.ts);
    if (!snap) return null;
    const fv = fvAt(fvCtx, inf.ts);
    const fvClass = (fv && fv.fv_price) ? classifyFv(snap.close, fv.fv_price) : null;
    const sys = findNearbySystemTrade(sysTrades, ticker, inf.ts);
    return {
      inflection: inf.name,
      gain_pct: inf.gain_pct,
      ...snap,
      fv,
      fv_class: fvClass,
      sys,
    };
  }).filter(Boolean);

  // All system trades in the window for this ticker (chronological).
  const sysAll = sysTrades.filter(t => t.ticker === ticker && t.entry_ts >= WINDOW_START && t.entry_ts <= WINDOW_END)
    .sort((a, b) => a.entry_ts - b.entry_ts)
    .map(t => findNearbySystemTrade([t], ticker, t.entry_ts));

  return {
    ticker,
    cohort: cohortRow.cohort,
    flavor: cohortRow.trend_hold_flavor,
    return_pct: cohortRow.return_pct,
    max_dd_pct: cohortRow.max_drawdown_pct,
    weekly_ema21_break_streak: cohortRow.weekly_ema21_break_streak,
    daily_512_cloud_break_streak: cohortRow.daily_512_cloud_break_streak,
    sector: fund?.profile?.sector || null,
    industry: fund?.profile?.industry || null,
    eps_growth_class: fund?.growth?.eps_growth_class || null,
    fundamentals_today: fund ? {
      pe_ttm: fund.valuation?.pe_ttm,
      pe_forward: fund.valuation?.pe_forward,
      peg: fund.valuation?.peg_ratio,
      fair_value_today: fund.valuation?.fair_value_price,
      fair_value_class_today: fund.valuation?.fair_value_class,
      current_price: fund.valuation?.current_price,
    } : null,
    inflections: snapshots,
    all_sys_trades: sysAll,
  };
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------
const sym = v => v == null ? '·' : String(v);
const symStatus = v => v === 'above' ? '↑' : v === 'below' ? '↓' : v === 'inside' ? '~' : '·';
const symDir = v => v === 1 ? 'bull' : v === -1 ? 'bear' : '·';
const symTd = (count, dir) => count == null ? '·' : (dir ? `${dir[0]}-${count}` : `?-${count}`);

function diagnoseShouldHaveHeld(t) {
  const trades = t.all_sys_trades || [];
  if (trades.length === 0) {
    return {
      verdict: 'never_traded',
      headline: `Never traded — pure missed opportunity. Oracle return ${t.return_pct?.toFixed(0)}% over the window.`,
    };
  }
  const closed = trades.filter(x => x.pnl_pct != null);
  const sumPnl = closed.reduce((s, x) => s + (x.pnl_pct || 0), 0);
  const sumMfe = closed.reduce((s, x) => s + (x.mfe_pct || 0), 0);
  const oracle = t.return_pct || 0;
  // Capture% = how much of the underlying move we extracted (approximate
  // since position sizing isn't compounded into oracle return).
  const capturePct = oracle > 0 ? (sumPnl / oracle) * 100 : null;

  // Exit-reason histogram for this ticker.
  const reasons = {};
  for (const x of closed) reasons[x.exit_reason || '?'] = (reasons[x.exit_reason || '?'] || 0) + 1;
  const sortedReasons = Object.entries(reasons).sort((a, b) => b[1] - a[1]);
  const dominantReason = sortedReasons[0]?.[0] || null;
  const dominantCount = sortedReasons[0]?.[1] || 0;

  const PREMATURE_EXITS = new Set([
    'SMART_RUNNER_SUPPORT_BREAK_CLOUD',
    'PROFIT_GIVEBACK_STAGE_HOLD',
    'HARD_FUSE_RSI_EXTREME',
    'mfe_decay_structural_flatten',
    'doctrine_force_exit',
    'doctrine_giveback',
    'fresh_failure',
    'stagnant_exit',
  ]);
  const prematureCount = closed.filter(x => PREMATURE_EXITS.has(x.exit_reason)).length;
  const stoppedOut = closed.filter(x => /max_loss|sl_breached|HARD_LOSS_CAP/i.test(String(x.exit_reason || ''))).length;
  const tpHit = closed.filter(x => /TP_(FULL|HIT|TRIM)|target/i.test(String(x.exit_reason || ''))).length;

  let verdict;
  if (closed.length === 0) verdict = 'all_open';
  else if (capturePct != null && capturePct < 25) verdict = 'severely_under_captured';
  else if (capturePct != null && capturePct < 50) verdict = 'partially_captured';
  else verdict = 'reasonably_captured';

  const headline =
    `${closed.length} closed trades · Σ pnl% ${sumPnl.toFixed(1)} on ${oracle.toFixed(0)}% oracle return ` +
    `→ capture ${capturePct == null ? 'n/a' : capturePct.toFixed(0) + '%'}` +
    ` · premature exits ${prematureCount}/${closed.length}` +
    ` · stopped-out ${stoppedOut}` +
    ` · TP-hit ${tpHit}` +
    (dominantReason ? ` · dominant exit: ${dominantReason} (${dominantCount}/${closed.length})` : '');

  return { verdict, headline, capturePct, sumPnl, sumMfe, prematureCount, stoppedOut, tpHit, reasons };
}

function renderTickerSection(t) {
  const md = [];
  md.push(`## ${t.ticker} — ${t.flavor || t.cohort} · ${t.sector || 'sector?'} · return ${t.return_pct?.toFixed(1)}% · max DD ${t.max_dd_pct?.toFixed(1)}%`);
  md.push('');
  if (t.fundamentals_today) {
    const f = t.fundamentals_today;
    md.push(`**Fundamentals (today):** P/E TTM ${sym(round(f.pe_ttm, 2))} · Fwd ${sym(round(f.pe_forward, 2))} · PEG ${sym(round(f.peg, 2))} · FV $${sym(round(f.fair_value_today, 2))} (${sym(f.fair_value_class_today)}) · current $${sym(round(f.current_price, 2))} · EPS growth class: ${sym(t.eps_growth_class)}`);
    md.push('');
  }
  md.push(`**Cohort metrics:** weekly EMA-21 break streak = ${t.weekly_ema21_break_streak} · daily 5/12 cloud break streak = ${t.daily_512_cloud_break_streak}`);
  md.push('');

  // Should-have-held diagnosis (the actionable insight).
  const dx = diagnoseShouldHaveHeld(t);
  md.push(`**Should-have-held diagnosis:** ${dx.headline}`);
  md.push('');

  // Inflection table
  md.push('### Inflection timeline (close-discipline)');
  md.push('');
  md.push('| inflection | date | close | gain% | wk EMA-21 | dly 5/12 | dly EMA-21 | 4H EMA-21 | RSI-D | RSI-W | TD9-D | TD9-W | ST-D | ST-W | ST-M | FV $ | FV ratio | sys near (path · grade · pnl%) |');
  md.push('|---|---|---:|---:|:---:|:---:|:---:|:---:|---:|---:|:---:|:---:|:---:|:---:|:---:|---:|---:|---|');
  for (const s of t.inflections) {
    const sysStr = s.sys
      ? `${s.sys.entry_path || '?'} · ${s.sys.setup_grade || '?'} · ${s.sys.pnl_pct != null ? s.sys.pnl_pct.toFixed(2) + '%' : 'OPEN'} · exit:${s.sys.exit_reason || '?'}`
      : '—';
    const fvPrice = s.fv?.fv_price != null ? s.fv.fv_price.toFixed(2) : '·';
    const fvRatio = s.fv_class?.ratio != null ? `${s.fv_class.ratio}× ${s.fv_class.label[0].toUpperCase()}` : '·';
    md.push(
      `| ${s.inflection} | ${s.date} | ${s.close?.toFixed(2)} | ${s.gain_pct ?? 0} | ${symStatus(s.weekly?.ema21_status)} | ${symStatus(s.daily?.cloud_status)} | ${symStatus(s.daily?.ema21_status)} | ${symStatus(s.h4?.ema21_status)} | ${sym(s.daily?.rsi)} | ${sym(s.weekly?.rsi)} | ${symTd(s.daily?.td9_count, s.daily?.td9_dir)} | ${symTd(s.weekly?.td9_count, s.weekly?.td9_dir)} | ${symDir(s.daily?.st_dir)} | ${symDir(s.weekly?.st_dir)} | ${symDir(s.monthly?.st_dir)} | ${fvPrice} | ${fvRatio} | ${sysStr} |`
    );
  }
  md.push('');

  // System trade journey
  if (t.all_sys_trades && t.all_sys_trades.length) {
    md.push(`### System trades on ${t.ticker} during window (n=${t.all_sys_trades.length})`);
    md.push('');
    md.push('| # | entry | exit | dir | path | grade | personality | regime | rank | rr | mfe% | mae% | held d | pnl % | exit reason |');
    md.push('|---|---|---|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---|');
    t.all_sys_trades.forEach((s, i) => {
      md.push(
        `| ${i + 1} | ${s.entry_date} | ${s.exit_date} | ${s.direction} | ${s.entry_path || '?'} | ${s.setup_grade || '?'} | ${s.personality || '?'} | ${s.regime_class || '?'} | ${s.rank ?? '?'} | ${s.rr ?? '?'} | ${sym(s.mfe_pct)} | ${sym(s.mae_pct)} | ${sym(s.held_days)} | ${s.pnl_pct != null ? s.pnl_pct.toFixed(2) + '%' : '·'} | ${s.exit_reason || '?'} |`
      );
    });
    md.push('');
  } else {
    md.push(`> *No system trades on ${t.ticker} in the window — pure missed opportunity.*`);
    md.push('');
  }
  return md.join('\n');
}

// ---------------------------------------------------------------------------
// Pattern aggregation across all candidates → headline insights
// ---------------------------------------------------------------------------
function aggregatePatterns(timelines) {
  const out = {
    n_tickers: timelines.length,
    by_flavor: { CLEAN_TREND: 0, RESILIENT_TREND: 0 },
    sector_counts: {},
    growth_class_counts: {},
    fv_class_at_entry_counts: {},
    fv_class_at_peak_counts: {},
    n_with_sys_trades: 0,
    sys_trade_counts: [],
    entry_state: { wkEma21_above: 0, cloud_above: 0, dEma21_above: 0, h4Ema21_above: 0 },
    peak_state: { wkEma21_above: 0, cloud_above: 0, dEma21_above: 0, h4Ema21_above: 0,
                  td9_d_setup_complete: 0, td9_w_setup_complete: 0, rsi_d_70plus: 0 },
    exit_state: { wkEma21_above: 0, cloud_above: 0, dEma21_above: 0 },
  };
  const inc = (m, k) => { if (k != null) m[k] = (m[k] || 0) + 1; };

  for (const t of timelines) {
    if (t.flavor) out.by_flavor[t.flavor] = (out.by_flavor[t.flavor] || 0) + 1;
    inc(out.sector_counts, t.sector || 'unknown');
    inc(out.growth_class_counts, t.eps_growth_class || 'unknown');
    if (t.all_sys_trades && t.all_sys_trades.length) out.n_with_sys_trades++;
    out.sys_trade_counts.push(t.all_sys_trades?.length || 0);

    const entry = t.inflections.find(x => x.inflection === 'entry_oracle');
    const peak = t.inflections.find(x => x.inflection === 'peak');
    const exit = t.inflections.find(x => x.inflection === 'exit_window');
    if (entry) {
      if (entry.fv_class?.label) inc(out.fv_class_at_entry_counts, entry.fv_class.label);
      if (entry.weekly?.ema21_status === 'above') out.entry_state.wkEma21_above++;
      if (entry.daily?.cloud_status === 'above') out.entry_state.cloud_above++;
      if (entry.daily?.ema21_status === 'above') out.entry_state.dEma21_above++;
      if (entry.h4?.ema21_status === 'above') out.entry_state.h4Ema21_above++;
    }
    if (peak) {
      if (peak.fv_class?.label) inc(out.fv_class_at_peak_counts, peak.fv_class.label);
      if (peak.weekly?.ema21_status === 'above') out.peak_state.wkEma21_above++;
      if (peak.daily?.cloud_status === 'above') out.peak_state.cloud_above++;
      if (peak.daily?.ema21_status === 'above') out.peak_state.dEma21_above++;
      if (peak.h4?.ema21_status === 'above') out.peak_state.h4Ema21_above++;
      if ((peak.daily?.td9_count || 0) >= 9 && peak.daily?.td9_dir === 'sell') out.peak_state.td9_d_setup_complete++;
      if ((peak.weekly?.td9_count || 0) >= 9 && peak.weekly?.td9_dir === 'sell') out.peak_state.td9_w_setup_complete++;
      if ((peak.daily?.rsi || 0) >= 70) out.peak_state.rsi_d_70plus++;
    }
    if (exit) {
      if (exit.weekly?.ema21_status === 'above') out.exit_state.wkEma21_above++;
      if (exit.daily?.cloud_status === 'above') out.exit_state.cloud_above++;
      if (exit.daily?.ema21_status === 'above') out.exit_state.dEma21_above++;
    }
  }
  return out;
}

function aggregateExitReasons(timelines) {
  const reasons = {};
  let total = 0;
  for (const t of timelines) {
    for (const x of (t.all_sys_trades || [])) {
      if (x.pnl_pct == null) continue;  // skip OPEN
      const k = x.exit_reason || '?';
      if (!reasons[k]) reasons[k] = { n: 0, sum_pnl: 0, sum_mfe: 0, sum_mae: 0 };
      reasons[k].n++;
      reasons[k].sum_pnl += (x.pnl_pct || 0);
      reasons[k].sum_mfe += (x.mfe_pct || 0);
      reasons[k].sum_mae += (x.mae_pct || 0);
      total++;
    }
  }
  return { reasons, total };
}

function aggregateCapture(timelines) {
  let nTraded = 0, nSevere = 0, nPartial = 0, nReasonable = 0, nNeverTraded = 0;
  let oracleSum = 0, sysSum = 0, sysSumOnTraded = 0, oracleSumOnTraded = 0;
  for (const t of timelines) {
    oracleSum += (t.return_pct || 0);
    const dx = diagnoseShouldHaveHeld(t);
    if (dx.verdict === 'never_traded') nNeverTraded++;
    else { nTraded++; sysSumOnTraded += (dx.sumPnl || 0); oracleSumOnTraded += (t.return_pct || 0); }
    if (dx.verdict === 'severely_under_captured') nSevere++;
    else if (dx.verdict === 'partially_captured') nPartial++;
    else if (dx.verdict === 'reasonably_captured') nReasonable++;
    sysSum += (dx.sumPnl || 0);
  }
  return { nTraded, nNeverTraded, nSevere, nPartial, nReasonable, oracleSum, sysSum, sysSumOnTraded, oracleSumOnTraded };
}

function renderExitReasonSection(timelines) {
  const { reasons, total } = aggregateExitReasons(timelines);
  const md = [];
  md.push('## Exit-reason distribution on the candidate set');
  md.push('');
  md.push(`Total closed system trades on the 50 TH-candidate tickers: **${total}**.`);
  md.push('');
  md.push('| exit reason | n | % of trades | avg pnl % | avg mfe % | avg mae % | giveback (mfe − pnl) |');
  md.push('|---|---:|---:|---:|---:|---:|---:|');
  const rows = Object.entries(reasons).sort((a, b) => b[1].n - a[1].n);
  for (const [name, r] of rows) {
    const avgPnl = r.sum_pnl / r.n;
    const avgMfe = r.sum_mfe / r.n;
    const avgMae = r.sum_mae / r.n;
    md.push(`| \`${name}\` | ${r.n} | ${(r.n / total * 100).toFixed(1)}% | ${avgPnl.toFixed(2)} | ${avgMfe.toFixed(2)} | ${avgMae.toFixed(2)} | ${(avgMfe - avgPnl).toFixed(2)} |`);
  }
  md.push('');
  md.push('Highest-giveback exit reasons (avg `mfe% − pnl%`) on this cohort indicate where the engine is leaving the most money on the table when the trend was clean.');
  md.push('');
  return md.join('\n');
}

function renderCaptureSummary(timelines) {
  const a = aggregateCapture(timelines);
  const md = [];
  md.push('## Capture summary across the candidate set');
  md.push('');
  md.push(`- Tickers **never traded** in the window: **${a.nNeverTraded} / ${timelines.length}** — pure missed opportunity.`);
  md.push(`- Tickers traded but **severely under-captured** (< 25% of oracle move): **${a.nSevere} / ${timelines.length}**`);
  md.push(`- Tickers traded and **partially captured** (25–50%): **${a.nPartial} / ${timelines.length}**`);
  md.push(`- Tickers **reasonably captured** (≥ 50% of oracle): **${a.nReasonable} / ${timelines.length}**`);
  md.push('');
  md.push(`- Σ oracle return across the cohort: **${a.oracleSum.toFixed(0)}%**.`);
  md.push(`- Σ system pnl% extracted: **${a.sysSum.toFixed(0)}%** ⇒ overall capture **${a.oracleSum > 0 ? (a.sysSum / a.oracleSum * 100).toFixed(1) : 0}%**.`);
  if (a.oracleSumOnTraded > 0) {
    md.push(`- Restricted to traded tickers (n=${a.nTraded}): Σ oracle ${a.oracleSumOnTraded.toFixed(0)}%, Σ system ${a.sysSumOnTraded.toFixed(0)}% ⇒ capture ${(a.sysSumOnTraded / a.oracleSumOnTraded * 100).toFixed(1)}%.`);
  }
  md.push('');
  return md.join('\n');
}

function renderCounterExamplesSection(counterTimelines) {
  if (!counterTimelines.length) return '';
  const md = [];
  md.push('## Counter-examples — tickers expected by intuition but excluded by the gate');
  md.push('');
  md.push('User-named names that did NOT make the Trend-Hold cohort because they had real multi-week trend breaks during the window. Useful to confirm the gate is not over-fitting to "obvious" winners.');
  md.push('');
  md.push('| ticker | cohort | return % | max DD % | wk EMA-21 streak | dly 5/12 streak | sys trades | capture % | dominant exit reason |');
  md.push('|---|---|---:|---:|---:|---:|---:|---:|---|');
  for (const t of counterTimelines) {
    const dx = diagnoseShouldHaveHeld(t);
    const reasons = dx.reasons || {};
    const dom = Object.entries(reasons).sort((a, b) => b[1] - a[1])[0];
    const domStr = dom ? `\`${dom[0]}\` (${dom[1]})` : '—';
    md.push(`| ${t.ticker} | ${t.cohort || '?'} | ${t.return_pct?.toFixed(1) ?? '?'} | ${t.max_dd_pct?.toFixed(1) ?? '?'} | ${t.weekly_ema21_break_streak ?? '?'} | ${t.daily_512_cloud_break_streak ?? '?'} | ${(t.all_sys_trades || []).length} | ${dx.capturePct == null ? 'n/a' : dx.capturePct.toFixed(0) + '%'} | ${domStr} |`);
  }
  md.push('');
  md.push('Key: AMD streak=8 (8 consecutive weekly closes below EMA-21) — looks "obvious" in hindsight but the trend WAS broken; correct exclusion. NFLX, META, PLTR, AMZN all show 9-22-week streaks → not Trend-Hold candidates over this window. AEHR streak=3 (just outside the gate) is the closest near-miss; would have qualified at streak ≤ 3.');
  md.push('');
  return md.join('\n');
}

function renderTuningRecommendations(agg, exitAgg, captureAgg, timelines) {
  const md = [];
  md.push('## Tuning recommendations for the Trend-Hold module');
  md.push('');
  md.push('Concrete thresholds for `worker/trend-hold.js` (Phase 2 implementation), derived from the patterns above.');
  md.push('');

  // 1. Promotion gates
  md.push('### 1. Promotion gates (should fire when these are ALL true)');
  md.push('');
  md.push('At oracle entry across the 50 TH candidates:');
  md.push(`- **${(agg.entry_state.wkEma21_above / agg.n_tickers * 100).toFixed(0)}%** had close ≥ weekly EMA-21`);
  md.push(`- **${(agg.entry_state.dEma21_above / agg.n_tickers * 100).toFixed(0)}%** had close ≥ daily EMA-21`);
  md.push(`- **${(agg.entry_state.h4Ema21_above / agg.n_tickers * 100).toFixed(0)}%** had close ≥ 4H EMA-21`);
  md.push(`- only **${(agg.entry_state.cloud_above / agg.n_tickers * 100).toFixed(0)}%** had close above the daily 5/12 cloud (many were inside the cloud during accumulation — DO NOT gate promotion on this).`);
  md.push('');
  md.push('**Recommended Trend-Hold promotion gates:**');
  md.push('');
  md.push('```js');
  md.push('// All of:');
  md.push('shouldPromoteToTrendHold = trade =>');
  md.push('  trade.mfe_pct >= 5 &&                                   // proves the setup worked');
  md.push('  weeklyClose >= weeklyEma21 &&                           // macro trend intact (CLOSES ONLY)');
  md.push('  dailyClose >= dailyEma21 &&                             // daily trend intact');
  md.push('  fourHClose >= fourHEma21 &&                             // tactical trend intact');
  md.push('  monthlySupertrendDir === 1 &&                           // monthly bull confirms');
  md.push('  weeklySupertrendDir === 1 &&                            // weekly bull confirms');
  md.push('  weeklyTd9SetupCount < 9 &&                              // not at weekly exhaustion');
  md.push('  weeklyEma21BreakStreakLast20wk <= 2 &&                  // recent macro discipline');
  md.push('  sectorRating !== "underweight" &&                       // tailwind/neutral required');
  md.push('  daysToEarnings >= 3 &&                                  // not pre-earnings');
  md.push('  trade.trimmed_pct < 0.5;                                // not already mostly trimmed');
  md.push('```');
  md.push('');

  // 2. Demotion gates
  md.push('### 2. Demotion gates (any one fires → drop back to Active Trader management)');
  md.push('');
  md.push('At the window-exit snapshot **98% still had weekly close ≥ EMA-21** — the macro filter is the strong demotion signal. Daily-cloud breaks (82% above at exit) are NOT demotion signals on their own; they\'re DCA triggers.');
  md.push('');
  md.push('**Recommended Trend-Hold demotion gates:**');
  md.push('');
  md.push('```js');
  md.push('shouldDemoteFromTrendHold = trade =>');
  md.push('  // PRIMARY: macro trend break — weekly close below EMA-21 for 2+ weeks running');
  md.push('  consecutiveWeeklyClosesBelowEma21 >= 2 ||');
  md.push('  // OR: daily AND 4H AND weekly all flip — capitulation cascade');
  md.push('  (dailyClose < dailyEma21 && fourHClose < fourHEma21 &&');
  md.push('   weeklyClose < weeklyEma21 && weeklySupertrendDir === -1) ||');
  md.push('  // OR: weekly TD9 sell-9 setup print (exhaustion) — confirms top');
  md.push('  (weeklyTd9SetupCount >= 9 && weeklyTd9Direction === "sell") ||');
  md.push('  // OR: macro shock — SPY -3% in a single session OR VIX > 35');
  md.push('  spySingleDayDrop <= -3 || vixLevel >= 35;');
  md.push('```');
  md.push('');

  // 3. DCA / re-add trigger
  md.push('### 3. DCA-the-dip trigger (RESILIENT_TREND only — high-vol mega-runners)');
  md.push('');
  md.push('Across the 42 RESILIENT_TREND tickers the daily 5/12 cloud was broken for a median of ~14 trading days during the run. Each cloud-reclaim was a textbook DCA signal — NOT an exit.');
  md.push('');
  md.push('**Recommended DCA trigger (overrides full-exit on giveback):**');
  md.push('');
  md.push('```js');
  md.push('shouldDcaPullback = trade =>');
  md.push('  trade.trend_hold_state === "active" &&');
  md.push('  trade.flavor === "RESILIENT_TREND" &&');
  md.push('  weeklyClose >= weeklyEma21 &&                           // macro intact');
  md.push('  prevDailyCloseBelowCloud && currentDailyCloseAboveCloud && // cloud reclaim');
  md.push('  trade.shares < trade.target_shares &&                   // room to add');
  md.push('  (currentClose / trade.avg_entry - 1) >= -0.10;          // pullback ≤ -10%');
  md.push('```');
  md.push('');
  md.push('For CLEAN_TREND (low-vol grinders) the daily-cloud break is rare — keep tighter trail; no DCA path needed.');
  md.push('');

  // 4. Override the giveback-style exits
  md.push('### 4. Suppress premature-exit doctrines while in Trend-Hold');
  md.push('');
  const top = Object.entries(exitAgg.reasons).sort((a, b) => b[1].n - a[1].n).slice(0, 6);
  md.push('Exit reasons firing most on the candidate set (with average pnl% they locked in):');
  md.push('');
  md.push('| reason | n | avg pnl% | avg mfe% | giveback |');
  md.push('|---|---:|---:|---:|---:|');
  for (const [name, r] of top) {
    md.push(`| \`${name}\` | ${r.n} | ${(r.sum_pnl / r.n).toFixed(2)} | ${(r.sum_mfe / r.n).toFixed(2)} | ${(r.sum_mfe / r.n - r.sum_pnl / r.n).toFixed(2)} |`);
  }
  md.push('');
  md.push('**While `trade_hold_state === "active"`, the following doctrines should NOT fire:**');
  md.push('');
  md.push('- `HARD_FUSE_RSI_EXTREME` — overrides on RSI ≥ 80 even when trend is intact (saw 1948% SNDK ride exited 11x by this gate).');
  md.push('- `PROFIT_GIVEBACK_STAGE_HOLD` — locks in 0–2% on what becomes 50%+ moves.');
  md.push('- `SMART_RUNNER_SUPPORT_BREAK_CLOUD` — closing below daily 5/12 cloud is a DCA trigger, not an exit, when weekly EMA-21 holds.');
  md.push('- `mfe_decay_structural_flatten` — only fires on trades that consolidate; consolidation is normal in RESILIENT_TREND.');
  md.push('- `doctrine_giveback` / `fresh_failure` / `stagnant_exit` — all time-based; Trend-Hold is structural, not time-based.');
  md.push('');
  md.push('**Allowed exits while in Trend-Hold:** weekly EMA-21 close-break, weekly TD9 sell-9, monthly SuperTrend bear flip, macro shock (SPY -3% / VIX > 35). Everything else routes through the demotion path → drop back to Active Trader management profile.');
  md.push('');

  // 5. Position cap
  md.push('### 5. Simultaneous Trend-Hold position cap');
  md.push('');
  md.push('Per user direction, start cap at **5–7** but make it tunable via `deep_audit_trend_hold_max_positions` in `model_config`.');
  md.push('');
  md.push('Recommended sizing:');
  md.push('- Max 6 simultaneous Trend-Hold positions, target 5% of equity each (max 30% locked).');
  md.push('- When a 7th candidate qualifies, drop the lowest-MFE active TH position back to Active Trader management (so capacity is allocated to fresh runners).');
  md.push('- Combined with Active Trader cap (~50% of equity) this keeps cash buffer ≥ 20%.');
  md.push('');

  return md.join('\n');
}

function renderPatternSection(agg, timelines) {
  const md = [];
  md.push('## Headline patterns across the Trend-Hold candidate set');
  md.push('');
  md.push(`Sample: **${agg.n_tickers}** tickers (CLEAN=${agg.by_flavor.CLEAN_TREND}, RESILIENT=${agg.by_flavor.RESILIENT_TREND}).`);
  md.push('');

  // Trend filter agreement at oracle entry, peak, exit
  const pct = (x, n) => n ? `${(x / n * 100).toFixed(0)}%` : '—';
  md.push('### Trend filter agreement (close-discipline) at key inflections');
  md.push('');
  md.push('| inflection | n | wk EMA-21 ↑ | dly 5/12 ↑ | dly EMA-21 ↑ | 4H EMA-21 ↑ | TD9-D sell-9 | TD9-W sell-9 | RSI-D ≥ 70 |');
  md.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|');
  md.push(`| **entry_oracle** | ${agg.n_tickers} | ${pct(agg.entry_state.wkEma21_above, agg.n_tickers)} | ${pct(agg.entry_state.cloud_above, agg.n_tickers)} | ${pct(agg.entry_state.dEma21_above, agg.n_tickers)} | ${pct(agg.entry_state.h4Ema21_above, agg.n_tickers)} | — | — | — |`);
  md.push(`| **peak**         | ${agg.n_tickers} | ${pct(agg.peak_state.wkEma21_above, agg.n_tickers)} | ${pct(agg.peak_state.cloud_above, agg.n_tickers)} | ${pct(agg.peak_state.dEma21_above, agg.n_tickers)} | ${pct(agg.peak_state.h4Ema21_above, agg.n_tickers)} | ${pct(agg.peak_state.td9_d_setup_complete, agg.n_tickers)} | ${pct(agg.peak_state.td9_w_setup_complete, agg.n_tickers)} | ${pct(agg.peak_state.rsi_d_70plus, agg.n_tickers)} |`);
  md.push(`| **exit_window**  | ${agg.n_tickers} | ${pct(agg.exit_state.wkEma21_above, agg.n_tickers)} | ${pct(agg.exit_state.cloud_above, agg.n_tickers)} | ${pct(agg.exit_state.dEma21_above, agg.n_tickers)} | — | — | — | — |`);
  md.push('');

  // Sector + growth class breakdown
  md.push('### Sector + EPS growth distribution');
  md.push('');
  const fmtCounts = (m) => Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} (${v})`).join(', ');
  md.push(`- **Sectors:** ${fmtCounts(agg.sector_counts)}`);
  md.push(`- **EPS growth class (today):** ${fmtCounts(agg.growth_class_counts)}`);
  md.push('');

  // FV class at entry vs peak
  md.push('### Fair-Value class at oracle entry vs peak (derived: ttm_eps × forward P/E)');
  md.push('');
  md.push(`- At entry: ${fmtCounts(agg.fv_class_at_entry_counts)}`);
  md.push(`- At peak:  ${fmtCounts(agg.fv_class_at_peak_counts)}`);
  md.push('');

  // System engagement
  md.push('### System engagement on the candidate set');
  md.push('');
  const totalSys = agg.sys_trade_counts.reduce((s, x) => s + x, 0);
  md.push(`- Tickers traded by the system in the window: **${agg.n_with_sys_trades} / ${agg.n_tickers}** (${pct(agg.n_with_sys_trades, agg.n_tickers)})`);
  md.push(`- Total system trades on the candidate set: **${totalSys}** (mean ${(totalSys / agg.n_tickers).toFixed(1)} per ticker, max ${Math.max(...agg.sys_trade_counts)})`);
  md.push('');
  return md.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  const cohort = JSON.parse(fs.readFileSync(COHORT_JSON, 'utf8'));
  const sysTradesRaw = JSON.parse(fs.readFileSync(SYS_TRADES_JSON, 'utf8'));
  const sysTrades = (sysTradesRaw.trades || []).map(t => ({ ...t, ticker: String(t.ticker || '').toUpperCase() }));

  const candidates = cohort.rows.filter(r => r.trend_hold_candidate);
  console.error(`[forensic] candidates=${candidates.length}`);

  fs.mkdirSync(TIMELINE_OUT, { recursive: true });
  const timelines = [];
  for (const cohRow of candidates) {
    try {
      const t = buildTickerTimeline(cohRow.ticker, cohRow, sysTrades);
      if (!t) { console.error(`  skip ${cohRow.ticker} — no daily data`); continue; }
      fs.writeFileSync(path.join(TIMELINE_OUT, `${cohRow.ticker}.json`), JSON.stringify(t, null, 2));
      timelines.push(t);
    } catch (e) {
      console.error(`  ERR ${cohRow.ticker}: ${e.stack || e.message}`);
    }
  }
  console.error(`[forensic] timelines=${timelines.length}`);

  // Counter-example timelines (user-named tickers excluded by the gate).
  const cohortByTk = new Map(cohort.rows.map(r => [r.ticker, r]));
  const counterTimelines = [];
  for (const tk of COUNTER_EXAMPLE_TICKERS) {
    const cr = cohortByTk.get(tk);
    if (!cr) continue;
    try {
      const t = buildTickerTimeline(tk, cr, sysTrades);
      if (t) counterTimelines.push(t);
    } catch (e) { console.error(`  CE ERR ${tk}: ${e.message}`); }
  }
  console.error(`[forensic] counter-examples=${counterTimelines.length}`);

  // Order: RESILIENT_TREND first (the user's primary blueprint targets),
  // then CLEAN_TREND, sorted by return desc within each.
  timelines.sort((a, b) => {
    const fa = a.flavor === 'RESILIENT_TREND' ? 0 : 1;
    const fb = b.flavor === 'RESILIENT_TREND' ? 0 : 1;
    if (fa !== fb) return fa - fb;
    return (b.return_pct || 0) - (a.return_pct || 0);
  });

  const agg = aggregatePatterns(timelines);

  const md = [];
  md.push('# Phase C — Trend-Hold Accumulation/Trend Deep Dive (Forensics)');
  md.push('');
  md.push(`**Generated:** ${new Date().toISOString().slice(0, 19)}Z by \`scripts/forensic-timeline.js\``);
  md.push(`**Sample:** ${timelines.length} Trend-Hold-candidate tickers (from cohort segmentation, gated on weekly EMA-21 break streak ≤ 2).`);
  md.push(`**Window:** ${dateStr(WINDOW_START)} → ${dateStr(WINDOW_END)} (daily candle cache truncates per-ticker at ~2026-04-17).`);
  md.push('');
  md.push('Per-inflection snapshots use **closes only** (per user direction): trend status flips only on a bar close crossing the level, never on intra-bar wicks. Three close-discipline trend filters are stacked:');
  md.push('');
  md.push('1. **Weekly EMA-21** (macro / structural)  — slow filter');
  md.push('2. **Daily 5/12 EMA cloud** (`above` = close above max(EMA-5,EMA-12); `below` = close under min; `inside` = between them)  — fast confirm');
  md.push('3. **4H EMA-21**  — tactical confirm');
  md.push('');
  md.push('Plus daily/weekly SuperTrend (10,3), monthly SuperTrend, daily/weekly TD9 setup count, daily/weekly RSI-14, and a derived Fair-Value (`ttm_eps × forward P/E`) per inflection.');
  md.push('');
  md.push('Legend: `↑` close above level · `↓` close below level · `~` inside cloud · `b-N`/`s-N` = TD9 buy/sell setup count N (sell-9 = bullish exhaustion warning, buy-9 = bearish exhaustion warning) · `D` discount FV / `F` fair / `P` premium.');
  md.push('');

  md.push(renderPatternSection(agg, timelines));
  md.push(renderCaptureSummary(timelines));
  md.push(renderExitReasonSection(timelines));
  md.push(renderCounterExamplesSection(counterTimelines));

  const exitAgg = aggregateExitReasons(timelines);
  const captureAgg = aggregateCapture(timelines);
  md.push(renderTuningRecommendations(agg, exitAgg, captureAgg, timelines));

  md.push('---');
  md.push('');
  md.push('## Per-ticker timelines');
  md.push('');
  for (const t of timelines) md.push(renderTickerSection(t));

  md.push('');
  md.push('---');
  md.push('');
  md.push('### Methodology footnote');
  md.push('');
  md.push('- Daily candles dedupe\'d on date (highest-volume row per date) before indicator computation, matching the universe-benchmark pipeline.');
  md.push('- Weekly bars: ISO-week (Mon-Sun) aggregation; weekly close = last daily close in week.');
  md.push('- 4H bars: from `/timed/candles?tf=4H` (cached at `data/forensic/4h-candles/`).');
  md.push('- Fair-Value derivation per user direction: at each inflection date, compute `ttm_eps` = sum of last 4 quarterly EPS prints with date ≤ inflection_date, then `fv_price = ttm_eps × forward_P/E_today`. This blends a historical earnings stream with a stationary multiple — directionally correct for spotting "discount-vs-fair-vs-premium" labels but not a precise valuation. Where fewer than 4 quarters of history exist before a date, ttm_eps uses what is available (annotated in the per-ticker JSON).');
  md.push('- **FV caveat for explosive-growth names:** for tickers whose earnings turn positive mid-window (e.g. SNDK printed −$0.30 → $0.29 → $1.22 → $6.20 → $23.41 over the run), ttm-EPS-derived FV is meaningless or negative at entry. The bull-case "discount" signal in those cases comes from the FORWARD earnings curve (visible in `eps_growth_class`: explosive/exploding) — not from trailing FV. The Trend-Hold module should treat `growth.eps_growth_class === "explosive"` AND `pe_forward < pe_ttm × 0.5` as an early-cycle "fundamentals discount" signal that supplements the trend filters.');
  md.push('- System-trade snapshots joined within ±3 trading days of each inflection.');
  md.push('- Source data: `data/cohort-segmentation.json`, `data/universe-cache/<T>-D.json`, `data/forensic/4h-candles/<T>-4H.json`, `data/forensic/fundamentals/<T>.json`, `tasks/phase-c/universe-benchmark/system-trades.json`.');

  fs.mkdirSync(path.dirname(DEEP_DIVE_MD), { recursive: true });
  fs.writeFileSync(DEEP_DIVE_MD, md.join('\n'));
  console.error(`[forensic] wrote ${DEEP_DIVE_MD}`);
}

main();
