// worker/foundation/candle-chain.js
// ─────────────────────────────────────────────────────────────────────────────
//  FOUNDATION — Candle Chain core (Phase 1 of
//  tasks/2026-06-14-foundation-rebuild-plan.md).
//
//  The pure, storage-agnostic heart of the candle chain. A Durable Object (or
//  any store) wraps this with persistence (D1 hot window + R2 cold) — the logic
//  here owns:
//    • ingest: idempotent merge of incoming base bars (dedupe, sort)
//    • integrity: contiguity check of the 5m base against the calendar grid
//      (the SINGLE freshness point), returning the exact missing ranges to heal
//    • derive: build every timeframe from the base via deterministic resample,
//      each as a SeriesView whose `complete` flag is computed against the
//      calendar — so a consumer can never compute on a gappy/short window
//    • cursor: the next bar the calendar says should exist (ingestion target)
//
//  Pure, deterministic, no I/O. Ties together series-contract + trading-calendar
//  + resample. Nothing in the live worker imports it yet (additive scaffolding).
// ─────────────────────────────────────────────────────────────────────────────

import { buildSeriesView, normalizeBars, computeCoverage } from "./series-contract.js";
import {
  expectedBuckets,
  expectedIntradayBuckets,
  etDateStr,
  sessionBoundsUtc,
  tradingDaysInRange,
} from "./trading-calendar.js";
import {
  resampleIntradaySessions,
  resampleDailyToWeekly,
  resampleDailyToMonthly,
} from "./resample.js";

const MIN = 60_000;
const DAY_MS = 24 * 60 * MIN;
// Intraday TFs derived from the 5m base.
export const DERIVED_INTRADAY_TFS = ["10", "15", "30", "60", "240"];

// CANONICAL SESSION POLICY (matches the validated backtest/live basis, verified
// 2026-06-15). The proven performance results were computed over intraday
// candles whose session content is SOURCE-DEPENDENT in the legacy store:
//   • 5m / 10m / 15m / 30m  → EXTENDED-HOURS-INCLUSIVE (Alpaca-sourced; the
//     leading-LTF + LTF inputs the strategy actually traded on). Deriving these
//     from the extended-hours 5m base WITHOUT clipping reproduces the legacy
//     bundles byte-for-byte (emaDepth/ST/RSI/px identical).
//   • 60m / 240m            → RTH-ONLY (different source/aggregation).
// Clipping the sub-hourly TFs to RTH would DROP the pre/post-market bars the
// backtest relied on and change every LTF score — so do NOT do it by default.
// Override per call via opts.sessionClip (boolean | {tf:boolean}).
const RTH_DERIVED_TFS = new Set(["60", "240", "1H", "4H"]);

/** Whether a derived intraday TF clips to RTH (true) or includes extended hours. */
export function defaultSessionClip(tf) {
  return RTH_DERIVED_TFS.has(String(tf));
}

function resolveSessionClip(tf, override) {
  if (override == null) return defaultSessionClip(tf);
  if (typeof override === "boolean") return override;
  const v = override[String(tf)];
  return typeof v === "boolean" ? v : defaultSessionClip(tf);
}

/** Idempotent merge of incoming base bars into existing (dedupe by ts, sorted). */
export function ingestBase(existing, incoming) {
  return normalizeBars([...(existing || []), ...(incoming || [])]);
}

/**
 * Canonical daily-bar timestamp: 00:00:00 UTC of the bar's UTC calendar date
 * (the trading day). Providers stamp daily near midnight in different zones
 * (TwelveData 00:00 UTC; Alpaca 00:00 ET = 04:00 UTC; some at the open) — all
 * collapse to this single anchor. Since the epoch is UTC-aligned, flooring to
 * the day boundary yields 00:00 UTC of that UTC date.
 */
export function canonicalDailyTs(ts) {
  return Math.floor(Number(ts) / DAY_MS) * DAY_MS;
}

/**
 * Normalize + dedup a daily series: snap every bar to its canonical daily anchor
 * and de-duplicate by ts (last write wins). This is what kills the legacy
 * 00:00Z/04:00Z daily double-write — both stamps map to the same anchor and
 * collapse to one bar per trading day.
 */
export function normalizeDailyBars(bars) {
  const mapped = (Array.isArray(bars) ? bars : [])
    .filter((b) => b && Number.isFinite(Number(b.ts)))
    .map((b) => ({ ...b, ts: canonicalDailyTs(Number(b.ts)) }));
  return normalizeBars(mapped);
}

/**
 * Contiguity check of the 5m base against the calendar grid for [startMs,endMs).
 * Returns coverage + the missing ranges to heal. This is gap DETECTION as a
 * computed fact (present vs expected), not an after-the-fact guard.
 */
export function checkBaseIntegrity(base5m, { startMs, endMs }) {
  const expected = expectedBuckets({ tf: "5", startMs, endMs });
  const coverage = computeCoverage(base5m, expected);
  return {
    complete: coverage.expected != null && coverage.present === coverage.expected && coverage.gaps.length === 0,
    coverage,
    healRanges: coverage.gaps,   // [[fromTs,toTs], ...] — exact buckets to backfill
  };
}

/**
 * The next 5m bucket the calendar says should exist after `lastTs`. Returns null
 * if there is no further expected bucket up to `untilMs`. Ingestion advances the
 * cursor to this; falling behind it is the (alarming) exception, not the norm.
 */
export function nextExpectedBucketMs(lastTs, untilMs, tfMin = 5) {
  const from = Number.isFinite(lastTs) ? lastTs + 1 : 0;
  const startDate = etDateStr(from);
  const endDate = etDateStr(untilMs);
  for (const day of tradingDaysInRange(startDate, endDate)) {
    for (const ts of expectedIntradayBuckets(day, tfMin)) {
      if (ts > (Number.isFinite(lastTs) ? lastTs : -Infinity) && ts <= untilMs) return ts;
    }
  }
  return null;
}

/**
 * Derive a single timeframe's SeriesView from the bases. Intraday TFs come from
 * the 5m base (session-anchored resample); D from the daily base; W/M resampled
 * from the daily base. `complete` is computed against the calendar grid.
 *
 * @returns {import("./series-contract.js").SeriesView}
 */
export function deriveTimeframe(tf, { ticker, base5m, baseDaily, asOf, windowStartMs, windowEndMs, source = "live", sessionClip }) {
  const tfu = String(tf);
  let bars;
  if (tfu === "5") {
    // 5m base is served as-is (extended-hours-inclusive — the backtest basis).
    bars = normalizeBars(base5m);
  } else if (DERIVED_INTRADAY_TFS.includes(tfu)) {
    bars = resampleIntradaySessions(base5m, Number(tfu), { clipToSession: resolveSessionClip(tfu, sessionClip) });
  } else if (tfu === "D") {
    bars = normalizeDailyBars(baseDaily);
  } else if (tfu === "W") {
    bars = resampleDailyToWeekly(normalizeDailyBars(baseDaily));
  } else if (tfu === "M") {
    bars = resampleDailyToMonthly(normalizeDailyBars(baseDaily));
  } else {
    bars = [];
  }
  const inWindow = (windowStartMs != null && windowEndMs != null)
    ? bars.filter((b) => b.ts >= windowStartMs && b.ts < windowEndMs)
    : bars;
  const expected = (windowStartMs != null && windowEndMs != null)
    ? expectedBuckets({ tf: tfu, startMs: windowStartMs, endMs: windowEndMs })
    : null;
  return buildSeriesView({ ticker, tf: tfu, bars: inWindow, expectedTimestamps: expected, asOf, source });
}

/**
 * Derive ALL working timeframes from the two bases in one call. The output is
 * exactly what the indicator + score layers consume — each a SeriesView with an
 * honest `complete` flag.
 *
 * @returns {Object<string, import("./series-contract.js").SeriesView>}
 */
export function deriveAllTimeframes({ ticker, base5m, baseDaily, asOf, windowStartMs, windowEndMs, source = "live", tfs, sessionClip }) {
  const list = tfs || ["5", ...DERIVED_INTRADAY_TFS, "D", "W", "M"];
  const out = {};
  for (const tf of list) {
    out[tf] = deriveTimeframe(tf, { ticker, base5m, baseDaily, asOf, windowStartMs, windowEndMs, source, sessionClip });
  }
  return out;
}

/**
 * Compute the bounded hot-window start for a 5m base given a retention of N
 * trading days ending at `asOf` (the D1 footprint stays constant — §3.6 of the
 * plan). Bars older than this are shipped to cold storage (R2) by the DO.
 */
export function hotWindowStartMs(asOf, retentionTradingDays = 150) {
  // Walk back calendar days until we've passed `retentionTradingDays` sessions.
  const endDate = etDateStr(asOf);
  // Over-scan ~1.6x calendar days to cover weekends/holidays, then take the Nth-back session.
  const scanStart = etDateStr(asOf - Math.ceil(retentionTradingDays * 1.7) * 24 * 60 * MIN);
  const days = tradingDaysInRange(scanStart, endDate);
  if (days.length <= retentionTradingDays) {
    return days.length ? sessionBoundsUtc(days[0]).openMs : asOf;
  }
  const startDay = days[days.length - retentionTradingDays];
  return sessionBoundsUtc(startDay).openMs;
}
