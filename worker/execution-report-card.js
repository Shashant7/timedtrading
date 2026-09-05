// worker/execution-report-card.js
//
// Execution report card (2026-09-05). The grade the execution-discipline
// plan is read against, computed from the ledger, not from memory:
//
//   - baseline by lane (core vs paper family), closed trades in the window
//   - entry-hour buckets (ET) -- the late-day pattern that set the 14:00 cutoff
//   - setup and direction slices
//   - MFE left on the table, with physically impossible MFEs flagged by
//     checking the recorded peak against the daily candle extremes
//   - counterfactual: what the entry caps (core 6/day, family 3/day, 4 open)
//     would have blocked, and how those tickets did
//
// Pure: gradeExecution(rows, candles, opts). GET /timed/admin/execution/report-card
// feeds it from D1. Small samples are reported as small samples (n on every
// line); a bucket with n < 8 is a hint, not a verdict.

import { isPaperFamilyEntryPath } from "./foundation/paper-family-entry.js";

const NY = "America/New_York";
const DAY_MS = 86400000;

function nyParts(ms) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: NY, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(new Date(Number(ms)));
  const m = {};
  for (const p of parts) m[p.type] = p.value;
  const hour = Number(m.hour) === 24 ? 0 : Number(m.hour);
  return { date: `${m.year}-${m.month}-${m.day}`, minutes: hour * 60 + Number(m.minute) };
}

function round(n, dp = 2) {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

export function summarize(list) {
  const p = list.map((r) => Number(r.pnl_pct)).filter(Number.isFinite);
  if (!p.length) return { n: 0 };
  const sorted = [...p].sort((a, b) => a - b);
  return {
    n: p.length,
    win_rate_pct: Math.round((p.filter((x) => x > 0).length / p.length) * 100),
    sum_pct: round(p.reduce((a, b) => a + b, 0), 1),
    mean_pct: round(p.reduce((a, b) => a + b, 0) / p.length, 2),
    median_pct: round(sorted[Math.floor(sorted.length / 2)], 2),
  };
}

export const ENTRY_BUCKETS = [
  ["09:30-10:30", 570, 630],
  ["10:30-12:00", 630, 720],
  ["12:00-14:00", 720, 840],
  ["14:00-15:00", 840, 900],
  ["15:00-16:00", 900, 960],
];

/**
 * Recorded MFE vs the best daily-candle extreme between entry and exit.
 * Returns the real ceiling (pct) or null when candles are missing.
 */
export function realMfeCeiling(row, candlesForTicker) {
  const entry = Number(row.entry_price);
  if (!(entry > 0) || !Array.isArray(candlesForTicker) || !candlesForTicker.length) return null;
  const from = Number(row.entry_ts) - DAY_MS;
  const to = (Number(row.exit_ts) || Number.MAX_SAFE_INTEGER) + 3600000;
  let best = null;
  for (const c of candlesForTicker) {
    const ts = Number(c.ts);
    if (ts < from || ts > to) continue;
    const v = String(row.direction).toUpperCase() === "SHORT"
      ? (1 - Number(c.l) / entry) * 100
      : (Number(c.h) / entry - 1) * 100;
    if (Number.isFinite(v) && (best === null || v > best)) best = v;
  }
  return best;
}

/**
 * Replay the entry caps over the window in time order.
 * @returns {{ blocked: Array, kept: Array }}
 */
export function replayEntryCaps(rows, { coreDaily = 6, familyDaily = 3, familyOpen = 4 } = {}) {
  const sorted = [...rows].sort((a, b) => Number(a.entry_ts) - Number(b.entry_ts));
  const dayCount = new Map();
  let familyOpenExits = [];
  const blocked = [];
  const kept = [];
  for (const r of sorted) {
    const fam = isPaperFamilyEntryPath(r.entry_path);
    const key = `${nyParts(r.entry_ts).date}|${fam ? "fam" : "core"}`;
    const cap = fam ? familyDaily : coreDaily;
    familyOpenExits = familyOpenExits.filter((x) => x === null || x > Number(r.entry_ts));
    const overOpen = fam && familyOpenExits.length >= familyOpen;
    if ((dayCount.get(key) || 0) >= cap || overOpen) { blocked.push(r); continue; }
    dayCount.set(key, (dayCount.get(key) || 0) + 1);
    if (fam) familyOpenExits.push(r.exit_ts ? Number(r.exit_ts) : null);
    kept.push(r);
  }
  return { blocked, kept };
}

/**
 * @param rows     trades rows: ticker, direction, status, entry_ts, exit_ts,
 *                 pnl_pct, max_favorable_excursion, entry_path, exit_reason, entry_price
 * @param candles  { TICKER: [{ ts, h, l }] } daily candles
 */
export function gradeExecution(rows = [], candles = {}, { days = 42, caps = {} } = {}) {
  const all = Array.isArray(rows) ? rows : [];
  const closed = all.filter((r) => r.status !== "OPEN" && Number.isFinite(Number(r.pnl_pct)));
  const fam = (r) => isPaperFamilyEntryPath(r.entry_path);
  const core = closed.filter((r) => !fam(r));
  const family = closed.filter(fam);

  const byBucket = (list) => Object.fromEntries(ENTRY_BUCKETS.map(([label, lo, hi]) =>
    [label, summarize(list.filter((r) => { const m = nyParts(r.entry_ts).minutes; return m >= lo && m < hi; }))]));
  const bySetup = (list) => {
    const g = {};
    for (const r of list) (g[r.entry_path || "core"] = g[r.entry_path || "core"] || []).push(r);
    return Object.fromEntries(Object.entries(g).map(([k, v]) => [k, summarize(v)]));
  };
  const byDirection = (list) => ({
    LONG: summarize(list.filter((r) => String(r.direction).toUpperCase() === "LONG")),
    SHORT: summarize(list.filter((r) => String(r.direction).toUpperCase() === "SHORT")),
  });
  const holdSplit = (list) => ({
    under_1d: summarize(list.filter((r) => (Number(r.exit_ts) - Number(r.entry_ts)) < DAY_MS)),
    over_1d: summarize(list.filter((r) => (Number(r.exit_ts) - Number(r.entry_ts)) >= DAY_MS)),
  });

  // MFE integrity + giveback.
  const corrupt = [];
  const giveback = { core: { armed: 0, closed_below_40pct: 0 }, family: { armed: 0, closed_below_40pct: 0 } };
  for (const r of closed) {
    const mfe = Number(r.max_favorable_excursion);
    if (!Number.isFinite(mfe)) continue;
    const ceil = realMfeCeiling(r, candles[String(r.ticker).toUpperCase()]);
    if (ceil !== null && mfe > ceil + 0.75) {
      corrupt.push({ ticker: r.ticker, recorded_mfe: round(mfe), candle_ceiling: round(ceil), exit_reason: r.exit_reason });
      continue;
    }
    const lane = fam(r) ? "family" : "core";
    if (mfe >= 1.5) {
      giveback[lane].armed += 1;
      if (Number(r.pnl_pct) < 0.4 * mfe) giveback[lane].closed_below_40pct += 1;
    }
  }

  const capReplay = replayEntryCaps(all, caps);
  const blockedClosed = capReplay.blocked.filter((r) => r.status !== "OPEN" && Number.isFinite(Number(r.pnl_pct)));
  const keptClosed = capReplay.kept.filter((r) => r.status !== "OPEN" && Number.isFinite(Number(r.pnl_pct)));

  return {
    ok: true,
    days,
    trades: { total: all.length, open: all.length - closed.length, closed: closed.length },
    baseline: { all: summarize(closed), core: summarize(core), family: summarize(family) },
    core: { by_entry_hour_et: byBucket(core), by_setup: bySetup(core), by_direction: byDirection(core), by_hold: holdSplit(core) },
    family: { by_entry_hour_et: byBucket(family), by_direction: byDirection(family), by_hold: holdSplit(family) },
    mfe: { corrupt_n: corrupt.length, corrupt, giveback },
    caps_counterfactual: {
      blocked: summarize(blockedClosed),
      kept: summarize(keptClosed),
      note: "blocked = entries beyond core 6/day, family 3/day or 4 open, replayed in time order",
    },
  };
}
