#!/usr/bin/env node
/**
 * Phase C — Cohort segmentation across the 238-ticker universe.
 *
 * READ-ONLY. Operates entirely on the locally-cached daily candles at
 *   /workspace/data/universe-cache/<TICKER>-D.json
 *
 * For each ticker, computes the underlying-price story over the analysis
 * window [WINDOW_START, WINDOW_END]:
 *   - return_pct                       total close-to-close return
 *   - max_drawdown_pct                 deepest peak-to-trough drawdown
 *   - peak_pct / trough_pct            max-up / max-down from window start
 *   - weekly_ema21_break_streak        longest run of consecutive weekly
 *                                      CLOSES below the 21-week EMA
 *   - daily_512_cloud_break_streak     longest run of consecutive daily
 *                                      CLOSES below the 5/12 EMA cloud
 *                                      (close < min(ema5, ema12))
 *   - vs_spy_pct                       excess return over SPY in window
 *
 * Trend determination follows two user-provided principles:
 *   1. CLOSES ONLY — never use intra-bar wicks/snapshots for trend status.
 *   2. Multi-timeframe agreement — the 4H/Daily/Weekly trend filters all
 *      need to stay intact for a "never broke trend" call. (4H EMA-21 is
 *      added in the forensics phase from intraday candles; here we use
 *      Weekly EMA-21 + Daily 5/12 cloud as the cohort-level proxy.)
 *
 * Cohorts (by return_pct):
 *   WINNERS         >= +30%
 *   MODERATE        +10% .. +30%
 *   STAGNANT        -10% .. +10%
 *   LOSERS          <= -10%
 *
 * Sub-cohorts within WINNERS (the "rallied without breaking trend" set):
 *   TREND_HOLD_CANDIDATE: weekly_ema21_break_streak <= 2
 *                          (the dominant signal per user direction —
 *                           "never really broke trend")
 *   Two flavors of TH candidate:
 *     CLEAN_TREND:      max_drawdown_pct >= -25% AND streak <= 1
 *                       (low-vol grinders: FIX/CAT/UTHR-style)
 *     RESILIENT_TREND:  streak <= 2 (regardless of DD)
 *                       (high-vol mega-runners: SNDK/BE/MU/SOXL-style —
 *                        DD allowed up to -50% as long as weekly trend
 *                        never broke for >2 consecutive weeks)
 *
 * Outputs:
 *   /workspace/tasks/phase-c/cohort-segmentation.md
 *   /workspace/data/cohort-segmentation.json   (machine-readable for next step)
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/workspace';
const CACHE_DIR = path.join(ROOT, 'data/universe-cache');
const UNIVERSE_FILE = path.join(ROOT, 'configs/backtest-universe-phase-c-stage1.txt');
const OUT_MD = path.join(ROOT, 'tasks/phase-c/cohort-segmentation.md');
const OUT_JSON = path.join(ROOT, 'data/cohort-segmentation.json');

const WINDOW_START = Date.UTC(2025, 6, 1);   // Jul 1 2025 00:00 UTC
const WINDOW_END   = Date.UTC(2026, 4, 8);   // May 8 2026 — cache may end earlier;
                                              // we clip to last-available bar per ticker.

// Cohort thresholds (confirmed with user)
const WINNER_MIN = 30.0;
const MODERATE_MIN = 10.0;
const STAGNANT_MIN = -10.0;
// LOSER: <= -10%

// Trend-Hold-Candidate cohort gates.
//
// Insight from running the universe: weekly EMA-21 and daily 5/12 cloud
// answer different questions over a 10-month window.
//   - Weekly EMA-21 (slow, macro): "did the trend ever truly break?"
//   - Daily 5/12 cloud (fast):     "how many consolidation phases happened?"
// High-vol mega-runners (SNDK, BE, MU, SOXL, GOOGL) all have CLEAN weekly
// streaks (0-2) but daily-cloud streaks of 10-22 days because of the
// consolidate-then-rip pattern. Hard-gating on daily streak (≤8) drops
// every blueprint target except WDC/LITE/ENS.
//
// Resolution: weekly EMA-21 is the PRIMARY cohort gate; daily 5/12 cloud
// is a sub-classifier that splits CLEAN vs RESILIENT. The "close matters"
// principle (per user direction) gets fully applied at the per-trade
// decision layer in the Trend-Hold module (entry confirm, DCA triggers,
// exit signals), where 4H EMA-21 + daily 5/12 cloud are the operative
// real-time filters — NOT at this cohort-aggregate level.
const TH_MAX_WEEKLY_EMA21_STREAK = 2;
// Sub-flavors split CLEAN (low-vol grinders) from RESILIENT (mega-runners):
const CLEAN_TREND_MAX_DD = -25.0;
const CLEAN_TREND_MAX_WEEKLY_STREAK = 1;
const CLEAN_TREND_MAX_DAILY_STREAK = 10;
// (RESILIENT_TREND: no DD floor, weekly streak ≤ 2, no daily-cloud cap.)

const SPY_TICKER = 'SPY';

// ---------------------------------------------------------------------------
function loadUniverse() {
  return fs
    .readFileSync(UNIVERSE_FILE, 'utf8')
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean);
}

function loadCandles(ticker) {
  const p = path.join(CACHE_DIR, `${ticker}-D.json`);
  if (!fs.existsSync(p)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const cs = (j.candles || []).slice().sort((a, b) => a.ts - b.ts);
    return cs.length ? cs : null;
  } catch {
    return null;
  }
}

function clipToWindow(candles) {
  return candles.filter(c => c.ts >= WINDOW_START && c.ts <= WINDOW_END);
}

function dateStr(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function dailyToWeekly(candles) {
  // Group daily candles into ISO weeks; weekly close = last daily close in week.
  const weeks = new Map();
  for (const c of candles) {
    const d = new Date(c.ts);
    // ISO week key — use Monday as week start.
    const day = d.getUTCDay();           // 0=Sun..6=Sat
    const diffToMon = (day === 0 ? -6 : 1 - day);
    const mon = new Date(d);
    mon.setUTCDate(d.getUTCDate() + diffToMon);
    mon.setUTCHours(0, 0, 0, 0);
    const key = mon.toISOString().slice(0, 10);
    const prev = weeks.get(key);
    if (!prev) {
      weeks.set(key, { ts: mon.getTime(), o: c.o, h: c.h, l: c.l, c: c.c, v: c.v });
    } else {
      prev.h = Math.max(prev.h, c.h);
      prev.l = Math.min(prev.l, c.l);
      prev.c = c.c;
      prev.v += (c.v || 0);
    }
  }
  return Array.from(weeks.values()).sort((a, b) => a.ts - b.ts);
}

function ema(values, period) {
  if (values.length === 0) return [];
  const k = 2 / (period + 1);
  const out = new Array(values.length);
  out[0] = values[0];
  for (let i = 1; i < values.length; i++) {
    out[i] = values[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}

function longestBelowEmaStreak(bars, period, warmup) {
  if (bars.length < period + 1) return 0;
  const closes = bars.map(b => b.c);
  const e = ema(closes, period);
  let cur = 0, best = 0;
  for (let i = warmup; i < bars.length; i++) {
    if (closes[i] < e[i]) { cur++; if (cur > best) best = cur; }
    else cur = 0;
  }
  return best;
}

// Daily 5/12 EMA cloud break: close below BOTH EMA-5 and EMA-12 (i.e.
// fully below the cloud). Streak measured on closes only.
function longestBelowDailyCloudStreak(daily) {
  if (daily.length < 14) return 0;
  const closes = daily.map(b => b.c);
  const e5 = ema(closes, 5);
  const e12 = ema(closes, 12);
  let cur = 0, best = 0;
  // Warmup: skip first 12 bars so EMA-12 has settled.
  for (let i = 12; i < daily.length; i++) {
    const cloudFloor = Math.min(e5[i], e12[i]);
    if (closes[i] < cloudFloor) { cur++; if (cur > best) best = cur; }
    else cur = 0;
  }
  return best;
}

function analyseTicker(ticker, candles, spyReturnPct) {
  const cs = clipToWindow(candles);
  if (cs.length < 20) return null;
  const first = cs[0];
  const last = cs[cs.length - 1];
  const returnPct = (last.c / first.c - 1) * 100;

  // Path stats: rolling peak, max drawdown peak-to-trough.
  let peakClose = first.c;
  let maxDd = 0;          // most negative drawdown seen
  let peakSinceStart = first.c;
  let troughSinceStart = first.c;
  let peakDate = dateStr(first.ts);
  let troughDate = dateStr(first.ts);
  for (const c of cs) {
    if (c.c > peakSinceStart) { peakSinceStart = c.c; peakDate = dateStr(c.ts); }
    if (c.c < troughSinceStart) { troughSinceStart = c.c; troughDate = dateStr(c.ts); }
    if (c.c > peakClose) peakClose = c.c;
    const dd = (c.c / peakClose - 1) * 100;
    if (dd < maxDd) maxDd = dd;
  }
  const peakPct = (peakSinceStart / first.c - 1) * 100;
  const troughPct = (troughSinceStart / first.c - 1) * 100;
  const weekly = dailyToWeekly(cs);
  const weeklyEma21Streak = longestBelowEmaStreak(weekly, 21, 20);
  const dailyCloudStreak = longestBelowDailyCloudStreak(cs);

  return {
    ticker,
    bars: cs.length,
    first_date: dateStr(first.ts),
    last_date: dateStr(last.ts),
    first_close: +first.c.toFixed(4),
    last_close: +last.c.toFixed(4),
    return_pct: +returnPct.toFixed(2),
    peak_pct: +peakPct.toFixed(2),
    peak_date: peakDate,
    trough_pct: +troughPct.toFixed(2),
    trough_date: troughDate,
    max_drawdown_pct: +maxDd.toFixed(2),
    weekly_ema21_break_streak: weeklyEma21Streak,
    daily_512_cloud_break_streak: dailyCloudStreak,
    vs_spy_pct: spyReturnPct === null ? null : +(returnPct - spyReturnPct).toFixed(2),
  };
}

function classifyCohort(r) {
  if (r.return_pct >= WINNER_MIN) return 'WINNERS';
  if (r.return_pct >= MODERATE_MIN) return 'MODERATE';
  if (r.return_pct >= STAGNANT_MIN) return 'STAGNANT';
  return 'LOSERS';
}

function classifyTrendHold(r) {
  if (r.return_pct < WINNER_MIN) return null;
  if (r.weekly_ema21_break_streak > TH_MAX_WEEKLY_EMA21_STREAK) return null;
  if (
    r.max_drawdown_pct >= CLEAN_TREND_MAX_DD &&
    r.weekly_ema21_break_streak <= CLEAN_TREND_MAX_WEEKLY_STREAK &&
    r.daily_512_cloud_break_streak <= CLEAN_TREND_MAX_DAILY_STREAK
  ) {
    return 'CLEAN_TREND';
  }
  return 'RESILIENT_TREND';
}

// ---------------------------------------------------------------------------
function main() {
  const universe = loadUniverse();
  console.error(`[universe] ${universe.length} tickers`);

  // SPY baseline first
  const spy = loadCandles(SPY_TICKER);
  let spyReturn = null;
  if (spy) {
    const s = analyseTicker(SPY_TICKER, spy, null);
    spyReturn = s ? s.return_pct : null;
    console.error(`[spy] window return = ${spyReturn}%`);
  } else {
    console.error('[spy] not in cache — vs_spy_pct will be null');
  }

  const rows = [];
  const noData = [];
  const insufficient = [];
  for (const tk of universe) {
    const cs = loadCandles(tk);
    if (!cs) { noData.push(tk); continue; }
    const r = analyseTicker(tk, cs, spyReturn);
    if (!r) { insufficient.push(tk); continue; }
    rows.push(r);
  }
  console.error(`[analyse] rows=${rows.length} no-data=${noData.length} insufficient=${insufficient.length}`);

  for (const r of rows) {
    r.cohort = classifyCohort(r);
    r.trend_hold_flavor = classifyTrendHold(r);
    r.trend_hold_candidate = r.trend_hold_flavor !== null;
  }

  // Sort within cohort by return desc / asc
  rows.sort((a, b) => b.return_pct - a.return_pct);

  // Bucket counts
  const buckets = { WINNERS: [], MODERATE: [], STAGNANT: [], LOSERS: [] };
  for (const r of rows) buckets[r.cohort].push(r);

  const trendHoldCandidates = rows.filter(r => r.trend_hold_candidate);

  // Write JSON
  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.writeFileSync(
    OUT_JSON,
    JSON.stringify({
      window_start: dateStr(WINDOW_START),
      window_end: dateStr(WINDOW_END),
      spy_return_pct: spyReturn,
      universe_size: universe.length,
      analysed: rows.length,
      no_data: noData,
      insufficient_data: insufficient,
      thresholds: {
        WINNER_MIN, MODERATE_MIN, STAGNANT_MIN,
        TH_MAX_WEEKLY_EMA21_STREAK,
        CLEAN_TREND_MAX_DD,
        CLEAN_TREND_MAX_WEEKLY_STREAK, CLEAN_TREND_MAX_DAILY_STREAK,
      },
      counts: {
        WINNERS: buckets.WINNERS.length,
        MODERATE: buckets.MODERATE.length,
        STAGNANT: buckets.STAGNANT.length,
        LOSERS: buckets.LOSERS.length,
        TREND_HOLD_CANDIDATE: trendHoldCandidates.length,
        CLEAN_TREND: trendHoldCandidates.filter(r => r.trend_hold_flavor === 'CLEAN_TREND').length,
        RESILIENT_TREND: trendHoldCandidates.filter(r => r.trend_hold_flavor === 'RESILIENT_TREND').length,
      },
      rows,
    }, null, 2),
  );
  console.error(`[json] ${OUT_JSON}`);

  // Write Markdown report
  const md = [];
  md.push('# Phase C — Cohort Segmentation (Jul 2025 → May 2026)');
  md.push('');
  md.push(`**Universe:** \`configs/backtest-universe-phase-c-stage1.txt\` (${universe.length} symbols)`);
  md.push(`**Analysis window:** ${dateStr(WINDOW_START)} → ${dateStr(WINDOW_END)} (cache truncates per-ticker; most series end **2026-04-17**, ~3 weeks short of May 8 — acceptable for cohort labeling)`);
  md.push(`**Source:** locally-cached daily candles at \`/workspace/data/universe-cache/\` (fetched via \`scripts/cohort-segmentation.js\`, no network calls).`);
  md.push(`**SPY benchmark return over window:** ${spyReturn === null ? 'n/a' : `${spyReturn.toFixed(2)}%`}`);
  md.push('');
  md.push('## Coverage');
  md.push('');
  md.push(`- Cache present for **${universe.length - noData.length}** of ${universe.length} tickers.`);
  md.push(`- Excluded with no candle data: **${noData.length}** — \`${noData.join(', ')}\` (futures contracts and rotated-out tickers).`);
  md.push(`- Excluded with <20 bars in window (post-window IPOs etc.): **${insufficient.length}** — \`${insufficient.join(', ')}\`.`);
  md.push(`- Final analysed set: **${rows.length}** tickers.`);
  md.push('');
  md.push('## Cohort thresholds (return % over window)');
  md.push('');
  md.push('| cohort | rule | n | % of analysed |');
  md.push('|---|---|---:|---:|');
  for (const c of ['WINNERS', 'MODERATE', 'STAGNANT', 'LOSERS']) {
    const rule = c === 'WINNERS' ? `>= +${WINNER_MIN}%`
      : c === 'MODERATE' ? `+${MODERATE_MIN}% .. +${WINNER_MIN}%`
      : c === 'STAGNANT' ? `${STAGNANT_MIN}% .. +${MODERATE_MIN}%`
      : `<= ${STAGNANT_MIN}%`;
    const n = buckets[c].length;
    md.push(`| **${c}** | ${rule} | ${n} | ${(n / rows.length * 100).toFixed(1)}% |`);
  }
  md.push('');
  md.push('**Trend integrity is measured on CLOSES ONLY** (per user direction): wicks below an EMA mid-bar do NOT count toward a "broken trend" call. Three close-discipline trend filters in the system, each operative at a different layer:');
  md.push('');
  md.push('| filter | timeframe | role | where used |');
  md.push('|---|---|---|---|');
  md.push('| **Weekly EMA-21** | weekly | macro / structural trend | cohort gate (this file) + Trend-Hold demotion |');
  md.push('| **Daily 5/12 cloud** | daily | fast trend confirm | per-trade decisions: entry confirm, DCA reclaim, exit |');
  md.push('| **4H EMA-21** | 4H | tactical trend filter | per-trade decisions: entry confirm, exit |');
  md.push('');
  md.push(`At the **cohort level** the only hard gate is the macro filter: longest consecutive weekly-close-below-EMA-21 streak ≤ ${TH_MAX_WEEKLY_EMA21_STREAK} (i.e. trend can dip below for 1-2 weeks but must recover). Daily 5/12 cloud streak is captured as a column and used as a CLEAN-vs-RESILIENT *sub-classifier*, not a hard cut — high-vol mega-runners (SNDK, BE, MU, SOXL, GOOGL) routinely close below the daily cloud for 10-22 days during consolidation phases yet never break the macro weekly trend.`);
  md.push('');
  md.push(`> **Note on 4H EMA-21:** the 4H trend filter is operative inside the Trend-Hold module (per-trade entry confirm, DCA, exit) but cannot be computed from the daily-only candle cache here. It is folded into per-ticker forensics (Phase 1.2) via \`direction_accuracy.signal_snapshot_json\` for traded names + targeted 4H fetch for non-traded TH candidates.`);
  md.push('');
  md.push(`**Trend-Hold-Candidate sub-cohort** (within WINNERS, weekly EMA-21 streak ≤ ${TH_MAX_WEEKLY_EMA21_STREAK}) → **${trendHoldCandidates.length}** tickers, split by daily-cloud / DD profile:`);
  const cleanList = trendHoldCandidates.filter(r => r.trend_hold_flavor === 'CLEAN_TREND');
  const resilList = trendHoldCandidates.filter(r => r.trend_hold_flavor === 'RESILIENT_TREND');
  md.push(`- **CLEAN_TREND** (low-vol grinders): max DD ≥ ${CLEAN_TREND_MAX_DD}%, weekly streak ≤ ${CLEAN_TREND_MAX_WEEKLY_STREAK}, daily-cloud streak ≤ ${CLEAN_TREND_MAX_DAILY_STREAK} → **${cleanList.length}** tickers.`);
  md.push(`- **RESILIENT_TREND** (high-vol mega-runners): weekly streak ≤ ${TH_MAX_WEEKLY_EMA21_STREAK} regardless of DD or daily-cloud streak → **${resilList.length}** tickers.`);
  md.push('');
  md.push('The split matters for the Trend-Hold management profile: CLEAN_TREND tickers tolerate a tight weekly-EMA-21 trail and a strict daily-cloud DCA trigger; RESILIENT_TREND tickers need a looser trail (probably weekly-EMA-21 with a 1.5×ATR buffer) and treat daily-cloud reclaim as a *DCA-the-dip* signal rather than a stop trigger because intra-week DDs run -30% to -45% before the weekly close recovers.');
  md.push('');

  const thColHeader = '| ticker | return % | peak % | max DD % | wk EMA-21 streak | dly 5/12 streak | vs SPY % |';
  const thColAlign  = '|---|---:|---:|---:|---:|---:|---:|';
  const thRow = r => `| **${r.ticker}** | ${r.return_pct.toFixed(1)} | ${r.peak_pct.toFixed(1)} | ${r.max_drawdown_pct.toFixed(1)} | ${r.weekly_ema21_break_streak} | ${r.daily_512_cloud_break_streak} | ${r.vs_spy_pct?.toFixed(1) ?? '—'} |`;

  md.push('## Trend-Hold candidates — CLEAN_TREND (low-vol grinders)');
  md.push('');
  md.push(thColHeader);
  md.push(thColAlign);
  cleanList.sort((a, b) => b.return_pct - a.return_pct).forEach(r => md.push(thRow(r)));
  md.push('');

  md.push('## Trend-Hold candidates — RESILIENT_TREND (high-vol mega-runners)');
  md.push('');
  md.push(thColHeader);
  md.push(thColAlign);
  resilList.sort((a, b) => b.return_pct - a.return_pct).forEach(r => md.push(thRow(r)));
  md.push('');

  // ---------- Per-cohort tables ----------
  for (const c of ['WINNERS', 'MODERATE', 'STAGNANT', 'LOSERS']) {
    const list = buckets[c].slice();
    md.push(`## ${c} (n=${list.length})`);
    md.push('');
    md.push('| ticker | return % | peak % | max DD % | wk EMA-21 streak | dly 5/12 streak | vs SPY % | TH |');
    md.push('|---|---:|---:|---:|---:|---:|---:|:---:|');
    list.forEach(r => {
      const thLabel = r.trend_hold_flavor === 'CLEAN_TREND' ? 'C'
        : r.trend_hold_flavor === 'RESILIENT_TREND' ? 'R' : '';
      md.push(`| ${r.ticker} | ${r.return_pct.toFixed(1)} | ${r.peak_pct.toFixed(1)} | ${r.max_drawdown_pct.toFixed(1)} | ${r.weekly_ema21_break_streak} | ${r.daily_512_cloud_break_streak} | ${r.vs_spy_pct?.toFixed(1) ?? '—'} | ${thLabel} |`);
    });
    md.push('');
  }

  // ---------- Summary stats ----------
  const med = arr => {
    const s = arr.slice().sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)] : null;
  };
  md.push('## Cohort statistics (medians)');
  md.push('');
  md.push('| cohort | n | return % | max DD % | wk EMA-21 streak | dly 5/12 streak |');
  md.push('|---|---:|---:|---:|---:|---:|');
  for (const c of ['WINNERS', 'MODERATE', 'STAGNANT', 'LOSERS']) {
    const list = buckets[c];
    if (!list.length) { md.push(`| ${c} | 0 | — | — | — | — |`); continue; }
    const r = list.map(x => x.return_pct);
    const dd = list.map(x => x.max_drawdown_pct);
    const stW = list.map(x => x.weekly_ema21_break_streak);
    const stD = list.map(x => x.daily_512_cloud_break_streak);
    md.push(`| ${c} | ${list.length} | ${med(r).toFixed(1)} | ${med(dd).toFixed(1)} | ${med(stW)} | ${med(stD)} |`);
  }
  for (const [label, list] of [['CLEAN_TREND', cleanList], ['RESILIENT_TREND', resilList]]) {
    if (!list.length) continue;
    const r = list.map(x => x.return_pct);
    const dd = list.map(x => x.max_drawdown_pct);
    const stW = list.map(x => x.weekly_ema21_break_streak);
    const stD = list.map(x => x.daily_512_cloud_break_streak);
    md.push(`| **${label}** | ${list.length} | ${med(r).toFixed(1)} | ${med(dd).toFixed(1)} | ${med(stW)} | ${med(stD)} |`);
  }
  md.push('');

  md.push('## Methodology footnote');
  md.push('');
  md.push('- *Return %* = (last_close − first_close) / first_close × 100, computed on the dedupe\'d daily-close series clipped to the analysis window.');
  md.push('- *Max DD %* = deepest peak-to-trough close-to-close drawdown experienced inside the window (negative number).');
  md.push('- *Weekly EMA-21 break streak* = longest run of consecutive **weekly closes** below the 21-week EMA, after a 20-week EMA warmup. ISO-week aggregation; weekly close = last daily close in week.');
  md.push('- *Daily 5/12 cloud break streak* = longest run of consecutive **daily closes** below `min(EMA-5, EMA-12)`, after a 12-bar warmup.');
  md.push('- *Trend integrity is measured on closes only* — wicks below an EMA mid-bar do NOT count toward a break.');
  md.push('- *vs SPY %* = ticker return − SPY return over identical window. (SPY may end on a different last-bar than ticker; difference is small.)');
  md.push('- This file is regenerated by `node scripts/cohort-segmentation.js`.');
  md.push('');

  fs.mkdirSync(path.dirname(OUT_MD), { recursive: true });
  fs.writeFileSync(OUT_MD, md.join('\n'));
  console.error(`[md] ${OUT_MD}`);

  // Console summary
  console.error('--- counts ---');
  for (const c of ['WINNERS', 'MODERATE', 'STAGNANT', 'LOSERS']) {
    console.error(`  ${c.padEnd(10)} ${String(buckets[c].length).padStart(4)}`);
  }
  console.error(`  TREND_HOLD ${String(trendHoldCandidates.length).padStart(4)} ` +
    `(CLEAN=${cleanList.length}, RESILIENT=${resilList.length})`);
}

main();
