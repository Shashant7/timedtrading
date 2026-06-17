// worker/foundation/setup-sequences.js
// -----------------------------------------------------------------------------
// Phase 3 shadow abstraction: setup sequences from setup-event atoms.
//
// This is intentionally pure and mock-friendly. It consumes normalized events
// and emits sequence state; it does not place trades or alter live scoring.
// -----------------------------------------------------------------------------

import {
  filterSetupEvents,
  latestSetupEvent,
  normalizeDirection,
  normalizeSetupEvents,
} from "./setup-events.js";

const LONG_SEQUENCE = "td_phase_mean_reversion_long";
const SHORT_SEQUENCE = "td_phase_mean_reversion_short";

const LONG_STAGES = [
  { stage: 1, key: "exhaustion_forming", events: ["td_setup_progress", "phase_entered_extreme", "rsi_extreme_entered", "timing_compression_watch"] },
  { stage: 2, key: "exhaustion_confirmed", events: ["td9_complete", "td13_complete"] },
  { stage: 3, key: "location_valid", events: ["pdz_discount_entered", "fvg_filled", "fvg_reclaimed", "liquidity_swept", "orb_failed_breakout", "ema200_reclaim", "saty_day_gate_test", "saty_week_gate_test"] },
  { stage: 4, key: "phase_left_zone", events: ["phase_left_accumulation", "phase_left_extreme", "rsi_extreme_left", "rsi_divergence_confirmed"] },
  { stage: 5, key: "mean_reversion_target", events: ["mean_reversion_target_reached", "ema21_reclaim", "pdz_equilibrium_reached", "vwap_reclaim"] },
  { stage: 6, key: "breakthrough_with_momentum", events: ["supertrend_breakthrough", "orb_reclaim", "squeeze_release", "momentum_confirmation", "rvol_spike"] },
  { stage: 7, key: "pullback_stabilized", events: ["pullback_stabilized"] },
  { stage: 8, key: "continuation_fired", events: ["supertrend_flip", "orb_breakout"] },
];

const SHORT_STAGES = [
  { stage: 1, key: "exhaustion_forming", events: ["td_setup_progress", "phase_entered_extreme", "rsi_extreme_entered", "timing_extension_watch"] },
  { stage: 2, key: "exhaustion_confirmed", events: ["td9_complete", "td13_complete"] },
  { stage: 3, key: "location_valid", events: ["pdz_premium_entered", "fvg_filled", "fvg_reclaimed", "liquidity_swept", "orb_failed_breakout", "ema200_reject", "saty_day_gate_test", "saty_week_gate_test"] },
  { stage: 4, key: "phase_left_zone", events: ["phase_left_distribution", "phase_left_extreme", "rsi_extreme_left", "rsi_divergence_confirmed"] },
  { stage: 5, key: "mean_reversion_target", events: ["mean_reversion_target_reached", "ema21_reject", "pdz_equilibrium_reached", "vwap_reject"] },
  { stage: 6, key: "breakthrough_with_momentum", events: ["supertrend_breakthrough", "orb_reclaim", "squeeze_release", "momentum_confirmation", "rvol_spike"] },
  { stage: 7, key: "pullback_stabilized", events: ["pullback_stabilized"] },
  { stage: 8, key: "continuation_fired", events: ["supertrend_flip", "orb_breakout"] },
];

function sequenceTypeFor(direction) {
  return direction === "SHORT" ? SHORT_SEQUENCE : LONG_SEQUENCE;
}

function stageDefsFor(direction) {
  return direction === "SHORT" ? SHORT_STAGES : LONG_STAGES;
}

function statusForStage(stage, invalidated = false) {
  if (invalidated) return "invalidated";
  if (stage >= 8) return "entry_ready";
  if (stage >= 5) return "confirmed";
  if (stage >= 1) return "forming";
  return "none";
}

function postureFor(direction, stage, openPosition = false) {
  if (openPosition) return direction === "SHORT" ? "Open Short" : "Open Long";
  if (stage >= 5) return direction === "SHORT" ? "Bearish" : "Bullish";
  if (stage >= 1) return direction === "SHORT" ? "Leaning bearish" : "Leaning bullish";
  return "Neutral";
}

function confidenceFor(stage, matchedCount, maxStage) {
  if (stage <= 0) return 0;
  const stagePart = stage / maxStage;
  const evidencePart = Math.min(1, matchedCount / Math.max(1, stage));
  return Math.round((stagePart * 0.7 + evidencePart * 0.3) * 1000) / 1000;
}

function makePathForecast({ direction, stage, matchedEvents, context = {} }) {
  const highVix = String(context.vix_regime || "").toLowerCase();
  const sector = String(context.sector_posture || context.sector_stance || "").toLowerCase();
  const research = String(context.research_alignment || context.editorial_alignment || "").toLowerCase();
  let primary = "drift_base";
  if (stage >= 6) primary = "pullback_then_continue";
  if (stage >= 8) primary = "trend_continuation";
  if (highVix === "high" || highVix === "panic") primary = direction === "SHORT" ? "trend_continuation" : "sharp_reversal";
  if (research === "opposed") primary = "failed_bounce";
  if (sector === "leading" && direction === "LONG" && stage >= 5) primary = "sharp_reversal";
  if (sector === "lagging" && direction === "SHORT" && stage >= 5) primary = "trend_continuation";

  const firstTs = matchedEvents[0]?.event_ts || null;
  const lastTs = matchedEvents[matchedEvents.length - 1]?.event_ts || null;
  return {
    primary_path: primary,
    direction,
    confidence: confidenceFor(stage, matchedEvents.length, 8),
    expected_first_target: stage >= 5 ? "continuation_trigger" : "ema21|equilibrium|supertrend",
    pullback_expected: stage >= 5,
    time_to_onset_bars: stage >= 5
      ? { p25: 1, median: 3, p75: 6 }
      : { p25: 2, median: 5, p75: 9 },
    time_to_target_bars: stage >= 5
      ? { p25: 4, median: 10, p75: 18 }
      : { p25: 6, median: 14, p75: 24 },
    edge_decay_bars: { median: stage >= 5 ? 12 : 8 },
    matched_event_count: matchedEvents.length,
    first_event_ts: firstTs,
    last_event_ts: lastTs,
    context_used: {
      vix_regime: context.vix_regime || null,
      sector_posture: context.sector_posture || context.sector_stance || null,
      research_alignment: context.research_alignment || context.editorial_alignment || null,
      ticker_personality: context.ticker_personality || null,
    },
  };
}

function firstStageEventAfter(events, eventTypes, minTs) {
  const matches = filterSetupEvents(events, { eventTypes });
  return matches.find((ev) => Number(ev.event_ts) >= Number(minTs || -Infinity)) || null;
}

function invalidationEventTypes(direction) {
  return direction === "SHORT"
    ? ["ema21_reclaim", "ema200_reclaim"]
    : ["ema21_reject", "ema200_reject"];
}

export function detectTdPhaseMeanReversionSequence(eventsInput = [], opts = {}) {
  const direction = normalizeDirection(opts.direction || "LONG") || "LONG";
  const normalized = normalizeSetupEvents(eventsInput);
  const ticker = opts.ticker ? String(opts.ticker).toUpperCase() : normalized.events[0]?.ticker || "UNKNOWN";
  const scoped = filterSetupEvents(normalized.events, {
    ticker,
    direction,
    fromTs: opts.fromTs,
    toTs: opts.toTs,
  });
  const stages = stageDefsFor(direction);
  const matched = [];
  let stage = 0;
  let cursorTs = Number(opts.fromTs);
  if (!Number.isFinite(cursorTs)) cursorTs = -Infinity;
  const stage_results = [];

  for (const def of stages) {
    const ev = firstStageEventAfter(scoped, def.events, cursorTs);
    const ok = !!ev && (stage === def.stage - 1 || def.stage === 1 || opts.allowSkippedStages === true);
    if (ok) {
      stage = Math.max(stage, def.stage);
      matched.push(ev);
      cursorTs = Number(ev.event_ts);
    }
    stage_results.push({
      stage: def.stage,
      key: def.key,
      matched: ok,
      event_id: ok ? ev.event_id : null,
      event_type: ok ? ev.event_type : null,
      event_ts: ok ? ev.event_ts : null,
    });
    if (!ok && opts.requireContiguous !== false) break;
  }

  const invalidation = latestSetupEvent(scoped, { eventTypes: invalidationEventTypes(direction) });
  const invalidated = !!(invalidation && matched.length && invalidation.event_ts > matched[matched.length - 1].event_ts);
  const status = statusForStage(stage, invalidated);
  const sequence_type = sequenceTypeFor(direction);

  return {
    ok: normalized.ok,
    errors: normalized.errors,
    sequence_id: `${ticker}:${sequence_type}:${matched[0]?.event_ts || "none"}`,
    ticker,
    sequence_type,
    direction,
    status,
    stage,
    max_stage: stages.length,
    posture: postureFor(direction, stage, opts.openPosition === true),
    confidence: confidenceFor(stage, matched.length, stages.length),
    started_ts: matched[0]?.event_ts || null,
    last_event_ts: matched[matched.length - 1]?.event_ts || null,
    matched_events: matched.map((ev) => ev.event_id),
    stage_results,
    invalidation_event: invalidated ? invalidation.event_id : null,
    path_forecast: makePathForecast({ direction, stage, matchedEvents: matched, context: opts.context || {} }),
  };
}

export function detectMeanReversionSequences(eventsInput = [], opts = {}) {
  const normalized = normalizeSetupEvents(eventsInput);
  const tickers = opts.tickers?.length
    ? opts.tickers.map((t) => String(t).toUpperCase())
    : [...new Set(normalized.events.map((ev) => ev.ticker))];
  const out = [];
  for (const ticker of tickers) {
    for (const direction of ["LONG", "SHORT"]) {
      const seq = detectTdPhaseMeanReversionSequence(normalized.events, {
        ...opts,
        ticker,
        direction,
      });
      if (seq.stage > 0 || opts.includeEmpty) out.push(seq);
    }
  }
  return out.sort((a, b) => (b.stage - a.stage) || String(a.ticker).localeCompare(String(b.ticker)) || String(a.direction).localeCompare(String(b.direction)));
}

