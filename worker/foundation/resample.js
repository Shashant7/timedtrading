// worker/foundation/resample.js
// ─────────────────────────────────────────────────────────────────────────────
//  FOUNDATION — deterministic OHLCV resampling (Phase 1 of
//  tasks/2026-06-14-foundation-rebuild-plan.md).
//
//  The core of "one base series → derive every timeframe". Maintaining ONE 5m
//  base per ticker (+ a daily base) and deriving 10/15/30/60/240 (and W/M from
//  daily) by deterministic resample collapses N independent freshness points to
//  2 and makes cross-TF inconsistency impossible (a 30m bar is ALWAYS exactly
//  its constituent 5m bars).
//
//  Pure, deterministic, no I/O. Intraday resampling is SESSION-ANCHORED (each
//  RTH session's buckets align to that day's open) — matching how RTH bars are
//  bucketed — with a clock-anchored mode available for reconciliation testing.
//
//  Aggregation rules (standard): o=first, h=max, l=min, c=last, v=sum.
// ─────────────────────────────────────────────────────────────────────────────

import { etDateStr, sessionBoundsUtc } from "./trading-calendar.js";

const MIN = 60_000;

/** Aggregate a non-empty, ascending run of bars into one OHLCV bar at bucketTs. */
function aggregate(bars, bucketTs) {
  let o = bars[0].o, h = bars[0].h, l = bars[0].l, c = bars[bars.length - 1].c, v = 0;
  for (const b of bars) {
    if (b.h > h) h = b.h;
    if (b.l < l) l = b.l;
    v += Number(b.v) || 0;
  }
  return { ts: bucketTs, o, h, l, c, v, finalized: true };
}

function sortBars(bars) {
  return [...(bars || [])]
    .filter((b) => b && Number.isFinite(Number(b.ts)))
    .map((b) => ({ ...b, ts: Number(b.ts) }))
    .sort((a, b) => a.ts - b.ts);
}

/**
 * Resample bars into `tfMin` buckets aligned to `anchorMs`.
 * bucketOpen = anchorMs + floor((ts - anchorMs)/tfMs) * tfMs.
 * Single-anchor (use for one session, or anchorMs=0 for clock/epoch alignment).
 */
export function resampleAligned(bars, tfMin, anchorMs = 0) {
  const tfMs = tfMin * MIN;
  const sorted = sortBars(bars);
  const buckets = new Map();
  for (const b of sorted) {
    const bucketTs = anchorMs + Math.floor((b.ts - anchorMs) / tfMs) * tfMs;
    if (!buckets.has(bucketTs)) buckets.set(bucketTs, []);
    buckets.get(bucketTs).push(b);
  }
  return [...buckets.keys()].sort((a, b) => a - b).map((ts) => aggregate(buckets.get(ts), ts));
}

/**
 * Session-anchored intraday resample of a multi-day base series — THE canonical
 * intraday derive. Splits base bars by ET trading day, anchors each session at
 * its RTH open (09:30 ET), resamples within the session, and concatenates.
 *
 * CANONICAL 60m / 240m ANCHOR (pinned 2026-06-15, plan §9.1):
 *   • Buckets are anchored to the SESSION OPEN, not the wall-clock hour. So 60m
 *     bars open at 09:30, 10:30, 11:30, 12:30, 13:30, 14:30, 15:30 — matching
 *     the standard US-equity 1H convention (e.g. TradingView). 240m opens at
 *     09:30 and 13:30.
 *   • PARTIAL LAST BAR: the final 60m bar (15:30) covers only 15:30–16:00 (a
 *     30-minute partial); the final 240m bar (13:30) covers 13:30–16:00 (a
 *     2.5-hour partial). Half-days (early 13:00 close) shorten these naturally
 *     because the session bounds come from the calendar.
 *   • RTH CLIP is OPT-IN per call ({clipToSession:true}); when set, base bars
 *     OUTSIDE [open, close) are dropped before bucketing so pre/post-market 5m
 *     prints can't spawn an out-of-session bucket. The CANDLE CHAIN applies this
 *     PER TIMEFRAME to match the validated backtest basis (see candle-chain.js
 *     `defaultSessionClip`): 60m/240m clip to RTH, but 5m/10m/15m/30m DELIBERATELY
 *     keep extended hours — the proven performance results were computed over
 *     extended-hours-inclusive sub-hourly candles (Alpaca-sourced), and clipping
 *     them would change every LTF score. The daily-rollup reconcile also clips
 *     (it compares to the official RTH daily). Default here is RTH-clip for the
 *     generic util; chain callers pass the per-TF policy explicitly.
 *
 * @param {Array} base5m   ascending base bars (e.g. 5m)
 * @param {number} tfMin   target timeframe minutes (must be a multiple of base)
 * @param {Object} [opts]  { clipToSession=true }
 * @returns {Array} derived bars, ascending
 */
export function resampleIntradaySessions(base5m, tfMin, opts = {}) {
  const clipToSession = opts.clipToSession !== false;
  const sorted = sortBars(base5m);
  const byDay = new Map();
  for (const b of sorted) {
    const day = etDateStr(b.ts);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(b);
  }
  const out = [];
  for (const day of [...byDay.keys()].sort()) {
    const sb = sessionBoundsUtc(day);
    const anchor = sb ? sb.openMs : byDay.get(day)[0].ts; // fall back to first bar if non-session
    let dayBars = byDay.get(day);
    if (clipToSession && sb) {
      dayBars = dayBars.filter((b) => b.ts >= sb.openMs && b.ts < sb.closeMs);
    }
    if (dayBars.length === 0) continue;
    for (const bar of resampleAligned(dayBars, tfMin, anchor)) out.push(bar);
  }
  return out;
}

/** Resample a daily base into ISO-week (Mon-anchored) bars. */
export function resampleDailyToWeekly(dailyBars) {
  const sorted = sortBars(dailyBars);
  const byWeek = new Map();
  for (const b of sorted) {
    const dt = new Date(b.ts);
    // ISO week key: year + week number via Thursday rule.
    const d = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()));
    const day = (d.getUTCDay() + 6) % 7;       // Mon=0..Sun=6
    d.setUTCDate(d.getUTCDate() - day + 3);     // Thursday of this week
    const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
    const week = 1 + Math.round(((d - firstThu) / (7 * 24 * 60 * MIN)));
    const key = `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
    if (!byWeek.has(key)) byWeek.set(key, []);
    byWeek.get(key).push(b);
  }
  const out = [];
  for (const key of [...byWeek.keys()].sort()) {
    const grp = byWeek.get(key);
    out.push(aggregate(grp, grp[0].ts)); // week bar stamped at first (Mon-ish) bar's ts
  }
  return out.sort((a, b) => a.ts - b.ts);
}

/** Resample a daily base into calendar-month bars. */
export function resampleDailyToMonthly(dailyBars) {
  const sorted = sortBars(dailyBars);
  const byMonth = new Map();
  for (const b of sorted) {
    const key = etDateStr(b.ts).slice(0, 7); // YYYY-MM (ET)
    if (!byMonth.has(key)) byMonth.set(key, []);
    byMonth.get(key).push(b);
  }
  const out = [];
  for (const key of [...byMonth.keys()].sort()) {
    const grp = byMonth.get(key);
    out.push(aggregate(grp, grp[0].ts)); // month bar stamped at first trading day's ts
  }
  return out.sort((a, b) => a.ts - b.ts);
}
