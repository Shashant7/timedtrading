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
// Intraday TFs derived from the 5m base.
export const DERIVED_INTRADAY_TFS = ["10", "15", "30", "60", "240"];

/** Idempotent merge of incoming base bars into existing (dedupe by ts, sorted). */
export function ingestBase(existing, incoming) {
  return normalizeBars([...(existing || []), ...(incoming || [])]);
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
export function deriveTimeframe(tf, { ticker, base5m, baseDaily, asOf, windowStartMs, windowEndMs, source = "live" }) {
  const tfu = String(tf);
  let bars;
  if (tfu === "5") {
    bars = normalizeBars(base5m);
  } else if (DERIVED_INTRADAY_TFS.includes(tfu)) {
    bars = resampleIntradaySessions(base5m, Number(tfu));
  } else if (tfu === "D") {
    bars = normalizeBars(baseDaily);
  } else if (tfu === "W") {
    bars = resampleDailyToWeekly(baseDaily);
  } else if (tfu === "M") {
    bars = resampleDailyToMonthly(baseDaily);
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
export function deriveAllTimeframes({ ticker, base5m, baseDaily, asOf, windowStartMs, windowEndMs, source = "live", tfs }) {
  const list = tfs || ["5", ...DERIVED_INTRADAY_TFS, "D", "W", "M"];
  const out = {};
  for (const tf of list) {
    out[tf] = deriveTimeframe(tf, { ticker, base5m, baseDaily, asOf, windowStartMs, windowEndMs, source });
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
