// worker/foundation/series-contract.js
// ─────────────────────────────────────────────────────────────────────────────
//  FOUNDATION — Layer 1 contract: SeriesView (the candle-chain interface).
//
//  Phase 0 of tasks/2026-06-14-foundation-rebuild-plan.md. This is the SINGLE
//  shape every candle consumer (indicators, score) is allowed to read. The
//  point of the rebuild is that a stale/gappy candle window can never silently
//  become a fresh-looking score — so the SeriesView carries explicit coverage
//  and a `complete` flag, and consumers MUST honor it (see indicator-contract +
//  score-contract).
//
//  This module is PURE (no I/O, no clock, no env). The same builder is used by
//  the live reader and the as-of (replay) reader; that single seam is what
//  guarantees backtest/live parity. Coverage is computed against an
//  `expectedTimestamps` grid SUPPLIED BY THE CALLER (the trading-calendar
//  service in Phase 1) — the contract deliberately does not embed calendar
//  knowledge, so overnight/weekend/holiday gaps are never mistaken for missing
//  bars.
//
//  Nothing in the live worker imports this yet (Phase 0 is additive scaffolding
//  + tests only).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} Bar
 * @property {number} ts   bucket open time, ms UTC
 * @property {number} o
 * @property {number} h
 * @property {number} l
 * @property {number} c
 * @property {number} v
 * @property {boolean} [finalized]  false = currently-forming (mutable) bar; default true
 */

/**
 * @typedef {Object} Coverage
 * @property {number|null} expected  count of bars the calendar says should exist (null = unknown)
 * @property {number} present        count of expected bars actually present
 * @property {Array<[number,number]>} gaps  contiguous [fromTs,toTs] ranges of missing expected bars
 */

/**
 * @typedef {Object} SeriesView
 * @property {string} ticker
 * @property {string} tf
 * @property {Bar[]} bars                 ascending by ts, de-duplicated
 * @property {boolean} complete           true iff every expected bar in the window is present
 * @property {number|null} last_finalized_ts
 * @property {Coverage} coverage
 * @property {number} as_of               clock this view was built at, ms
 * @property {"live"|"as_of"} source
 */

// Intraday fixed-interval timeframes → interval in ms. D/W/M are
// calendar-driven and resolve to null (their expected grid comes from the
// calendar service, not a fixed interval).
const TF_INTERVAL_MS = {
  "1": 60_000,
  "5": 5 * 60_000,
  "10": 10 * 60_000,
  "15": 15 * 60_000,
  "30": 30 * 60_000,
  "60": 60 * 60_000,
  "1H": 60 * 60_000,
  "240": 240 * 60_000,
  "4H": 240 * 60_000,
};

export function intervalMsForTf(tf) {
  return TF_INTERVAL_MS[String(tf)] ?? null;
}

/** Sort ascending by ts and drop duplicate timestamps (last write wins). */
export function normalizeBars(bars) {
  const byTs = new Map();
  for (const b of Array.isArray(bars) ? bars : []) {
    if (!b || !Number.isFinite(Number(b.ts))) continue;
    byTs.set(Number(b.ts), { ...b, ts: Number(b.ts) });
  }
  return [...byTs.values()].sort((a, b) => a.ts - b.ts);
}

/**
 * Compute coverage of `bars` against the calendar-supplied `expectedTimestamps`
 * (ascending array of bucket-open timestamps that SHOULD exist in the window).
 * Pure. When `expectedTimestamps` is null/empty the coverage is "unknown" and
 * the view is treated as NOT complete (we never assert completeness we can't
 * verify).
 *
 * @param {Bar[]} bars
 * @param {number[]|null} expectedTimestamps
 * @returns {Coverage}
 */
export function computeCoverage(bars, expectedTimestamps) {
  const present = new Set(normalizeBars(bars).map((b) => b.ts));
  if (!Array.isArray(expectedTimestamps) || expectedTimestamps.length === 0) {
    return { expected: null, present: present.size, gaps: [] };
  }
  const expected = [...expectedTimestamps].map(Number).sort((a, b) => a - b);
  const gaps = [];
  let presentCount = 0;
  let runStart = null;
  let runEnd = null;
  for (const ts of expected) {
    if (present.has(ts)) {
      presentCount++;
      if (runStart != null) {
        gaps.push([runStart, runEnd]);
        runStart = null;
        runEnd = null;
      }
    } else {
      if (runStart == null) runStart = ts;
      runEnd = ts;
    }
  }
  if (runStart != null) gaps.push([runStart, runEnd]);
  return { expected: expected.length, present: presentCount, gaps };
}

/**
 * Build a SeriesView. The ONLY producer of this shape (live or replay).
 *
 * @param {Object} args
 * @param {string} args.ticker
 * @param {string} args.tf
 * @param {Bar[]} args.bars
 * @param {number[]|null} [args.expectedTimestamps]  calendar grid for the window
 * @param {number} args.asOf                          clock, ms
 * @param {"live"|"as_of"} [args.source="live"]
 * @returns {SeriesView}
 */
export function buildSeriesView({ ticker, tf, bars, expectedTimestamps = null, asOf, source = "live" }) {
  const sorted = normalizeBars(bars);
  const coverage = computeCoverage(sorted, expectedTimestamps);
  let lastFinalized = null;
  for (const b of sorted) {
    if (b.finalized !== false) lastFinalized = b.ts;
  }
  const complete = coverage.expected != null
    && coverage.expected > 0
    && coverage.present === coverage.expected
    && coverage.gaps.length === 0;
  return {
    ticker: String(ticker || "").toUpperCase(),
    tf: String(tf),
    bars: sorted,
    complete,
    last_finalized_ts: lastFinalized,
    coverage,
    as_of: Number(asOf) || 0,
    source: source === "as_of" ? "as_of" : "live",
  };
}

/**
 * Consumer-side guard. Returns { ok, reason }. Indicators/score call this and
 * REFUSE to compute when ok=false — the structural replacement for "compute on
 * a short/gappy window and hope a guard catches it".
 *
 * @param {SeriesView} view
 * @param {Object} [opts]
 * @param {number} [opts.minBars=1]   minimum bars required by the consumer
 * @param {boolean} [opts.allowForming=false]  if false, the forming bar is ignored for the count
 */
export function checkSeries(view, opts = {}) {
  const minBars = Number(opts.minBars) || 1;
  if (!view || !Array.isArray(view.bars)) return { ok: false, reason: "no_series" };
  if (!view.complete) return { ok: false, reason: "series_incomplete" };
  const usable = opts.allowForming ? view.bars : view.bars.filter((b) => b.finalized !== false);
  if (usable.length < minBars) {
    return { ok: false, reason: `insufficient_lookback:${usable.length}/${minBars}` };
  }
  return { ok: true, reason: null };
}
