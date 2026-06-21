// worker/foundation/setup-replay-mining.js
// -----------------------------------------------------------------------------
// Phase 5 shadow mining: timed_trail snapshot windows -> setup sequences ->
// join closed trades for read-only reliability tables. No D1/KV writes.
// -----------------------------------------------------------------------------

import { deriveSetupEventsFromWindow } from "./setup-event-derivation.js";
import {
  buildDiagnosticsContext,
  parseTrailSnapshotRow,
  summarizeTraderPosture,
} from "./setup-diagnostics-route.js";
import { deriveLegacyEntryDiagnostics, LEGACY_ANALYSIS_MODE } from "./setup-entry-snapshot.js";
import { discoveryMoveAnchorTs } from "./discovery-move-utils.js";
import { detectMeanReversionSequences } from "./setup-sequences.js";

const DEFAULT_PRE_ENTRY_MS = 48 * 60 * 60 * 1000;

export function snapshotsFromTrailRows(rows = [], ticker = "") {
  const sym = String(ticker || "").toUpperCase();
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const snap = parseTrailSnapshotRow(row, sym || row?.ticker);
    if (snap) out.push(snap);
  }
  return out.sort((a, b) => Number(a.ts) - Number(b.ts));
}

export function snapshotsBeforeEntry(snapshots = [], entryTs, opts = {}) {
  const entry = Number(entryTs);
  if (!Number.isFinite(entry)) return [];
  const preMs = Number.isFinite(Number(opts.preEntryMs))
    ? Number(opts.preEntryMs)
    : DEFAULT_PRE_ENTRY_MS;
  const since = entry - preMs;
  return snapshots.filter((s) => {
    const ts = Number(s.ts);
    return Number.isFinite(ts) && ts >= since && ts <= entry;
  });
}

export function sequenceForDirection(sequences = [], direction) {
  const dir = String(direction || "").toUpperCase();
  const matches = (Array.isArray(sequences) ? sequences : [])
    .filter((s) => s.direction === dir && s.stage > 0);
  if (!matches.length) return null;
  return [...matches].sort((a, b) => b.stage - a.stage || Number(b.confidence) - Number(a.confidence))[0];
}

export function diagnosticsForEntryWindow(snapshots = [], entryTs, opts = {}) {
  const windowSnaps = snapshotsBeforeEntry(snapshots, entryTs, opts);
  if (!windowSnaps.length) {
    return {
      ok: false,
      reason: "no_snapshots_before_entry",
      snapshot_count: 0,
      events: [],
      sequences: [],
      trader_posture: summarizeTraderPosture([]),
    };
  }

  const latest = windowSnaps[windowSnaps.length - 1];
  const context = buildDiagnosticsContext(latest, opts.env || {});
  const derived = deriveSetupEventsFromWindow(windowSnaps, {
    ...opts.derivationOpts,
    context,
    bootstrapFirst: opts.bootstrapFirst !== false,
    source: opts.source || "shadow_replay_mining",
  });

  return {
    ok: true,
    snapshot_count: windowSnaps.length,
    window_since_ts: windowSnaps[0]?.ts ?? null,
    window_until_ts: latest?.ts ?? null,
    context_used: context,
    events: derived.events,
    event_history: derived.event_history,
    sequences: derived.sequences,
    trader_posture: summarizeTraderPosture(derived.sequences),
  };
}

export function classifyTradeOutcome(trade = {}) {
  const status = String(trade.status || "").toUpperCase();
  if (status === "WIN") return { outcome: "win", pnl_pct: Number(trade.pnl_pct ?? trade.pnlPct) || null };
  if (status === "LOSS") return { outcome: "loss", pnl_pct: Number(trade.pnl_pct ?? trade.pnlPct) || null };

  const pnlPct = Number(trade.pnl_pct ?? trade.pnlPct);
  if (Number.isFinite(pnlPct)) {
    return {
      outcome: pnlPct > 0 ? "win" : pnlPct < 0 ? "loss" : "flat",
      pnl_pct: pnlPct,
    };
  }
  const pnl = Number(trade.pnl ?? trade.pnl_usd);
  if (Number.isFinite(pnl)) {
    return {
      outcome: pnl > 0 ? "win" : pnl < 0 ? "loss" : "flat",
      pnl_pct: null,
      pnl,
    };
  }
  return { outcome: "unknown", pnl_pct: null };
}

export function stageBucket(stage) {
  const s = Number(stage) || 0;
  if (s >= 8) return "8_entry_ready";
  if (s >= 5) return "5_7_confirmed";
  if (s >= 1) return "1_4_forming";
  return "0_none";
}

export function diagnosticsForEventWindow(events = [], anchorTs, opts = {}) {
  const anchor = Number(anchorTs);
  const preMs = Number.isFinite(Number(opts.preEntryMs))
    ? Number(opts.preEntryMs)
    : DEFAULT_PRE_ENTRY_MS;
  const since = Number.isFinite(anchor) ? anchor - preMs : null;
  const windowEvents = (Array.isArray(events) ? events : []).filter((ev) => {
    const ts = Number(ev.event_ts);
    if (!Number.isFinite(ts)) return false;
    if (Number.isFinite(anchor) && ts > anchor) return false;
    if (since != null && ts < since) return false;
    return true;
  });
  if (!windowEvents.length) {
    return {
      ok: false,
      reason: "no_events_before_anchor",
      snapshot_count: 0,
      events: [],
      sequences: [],
      trader_posture: summarizeTraderPosture([]),
    };
  }
  const latestTs = windowEvents[windowEvents.length - 1]?.event_ts;
  const sequences = detectMeanReversionSequences(windowEvents, {
    ticker: opts.ticker,
    context: opts.context || {},
    includeEmpty: opts.includeEmptySequences === true,
  });
  return {
    ok: true,
    snapshot_count: windowEvents.length,
    window_since_ts: windowEvents[0]?.event_ts ?? null,
    window_until_ts: latestTs ?? null,
    events: windowEvents,
    sequences,
    trader_posture: summarizeTraderPosture(sequences),
  };
}

export function joinTradeWithLegacyEntrySnapshot(trade = {}, opts = {}) {
  const ticker = String(trade.ticker || "").toUpperCase();
  const direction = String(trade.direction || "LONG").toUpperCase();
  const entryTs = Number(trade.entry_ts ?? trade.entryTs);
  const diag = deriveLegacyEntryDiagnostics(trade, null, opts);
  const seq = diag.sequence || null;
  const outcome = classifyTradeOutcome(trade);

  return {
    trade_id: trade.trade_id || trade.tradeId || null,
    ticker,
    direction,
    entry_ts: Number.isFinite(entryTs) ? entryTs : null,
    exit_ts: Number(trade.exit_ts ?? trade.exitTs) || null,
    entry_path: trade.entry_path || trade.setup_name || null,
    pnl_pct: outcome.pnl_pct,
    outcome: outcome.outcome,
    mfe_pct: Number(trade.max_favorable_excursion ?? trade.maxFavorableExcursion) || null,
    mae_pct: Number(trade.max_adverse_excursion ?? trade.maxAdverseExcursion) || null,
    analysis_mode: LEGACY_ANALYSIS_MODE,
    promotion_safe: false,
    diagnostics_ok: diag.ok === true,
    diagnostics_reason: diag.reason || null,
    snapshot_count: diag.snapshot_count || 0,
    has_setup_snapshot: diag.has_setup_snapshot === true,
    static_stage: diag.static_stage || null,
    sequence: seq ? {
      sequence_id: seq.sequence_id || null,
      sequence_type: seq.sequence_type,
      direction: seq.direction,
      stage: seq.stage,
      stage_bucket: stageBucket(seq.stage),
      status: seq.status,
      posture: seq.posture,
      confidence: seq.confidence,
      path_forecast: seq.path_forecast || null,
      static_only: seq.static_only === true,
    } : null,
    trader_posture: diag.trader_posture,
    event_count: diag.event_count || 0,
  };
}

export function joinTradeWithEventLedger(trade = {}, events = [], opts = {}) {
  const ticker = String(trade.ticker || "").toUpperCase();
  const direction = String(trade.direction || "LONG").toUpperCase();
  const entryTs = Number(trade.entry_ts ?? trade.entryTs);
  const diag = diagnosticsForEventWindow(events, entryTs, { ...opts, ticker });
  const seq = sequenceForDirection(diag.sequences || [], direction);
  const outcome = classifyTradeOutcome(trade);

  return {
    trade_id: trade.trade_id || trade.tradeId || null,
    ticker,
    direction,
    entry_ts: Number.isFinite(entryTs) ? entryTs : null,
    exit_ts: Number(trade.exit_ts ?? trade.exitTs) || null,
    entry_path: trade.entry_path || trade.setup_name || null,
    pnl_pct: outcome.pnl_pct,
    outcome: outcome.outcome,
    analysis_mode: "setup_events_d1",
    promotion_safe: true,
    diagnostics_ok: diag.ok === true,
    diagnostics_reason: diag.reason || null,
    snapshot_count: diag.snapshot_count || 0,
    sequence: seq ? {
      sequence_id: seq.sequence_id,
      sequence_type: seq.sequence_type,
      direction: seq.direction,
      stage: seq.stage,
      stage_bucket: stageBucket(seq.stage),
      status: seq.status,
      posture: seq.posture,
      confidence: seq.confidence,
      path_forecast: seq.path_forecast,
    } : null,
    trader_posture: diag.trader_posture,
    event_count: (diag.events || []).length,
  };
}

function compactSequence(seq) {
  if (!seq?.sequence_type) return null;
  return {
    sequence_id: seq.sequence_id || null,
    sequence_type: seq.sequence_type,
    direction: seq.direction,
    stage: seq.stage,
    stage_bucket: stageBucket(seq.stage),
    status: seq.status,
    posture: seq.posture,
    confidence: seq.confidence,
    path_forecast: seq.path_forecast || null,
    matched_stage_keys: (seq.stage_results || [])
      .filter((r) => r.matched)
      .map((r) => r.key),
    invalidated: seq.status === "invalidated",
  };
}

const CONFIRMATION_EVENT_TYPES = [
  "td9_complete", "td13_complete",
  "ema21_reclaim", "ema21_reject", "ema200_reclaim", "ema200_reject",
  "supertrend_flip", "supertrend_breakthrough", "squeeze_release",
  "momentum_confirmation", "orb_breakout", "orb_reclaim",
  "mean_reversion_target_reached", "pullback_stabilized", "vwap_reclaim", "vwap_reject",
];

const EXHAUSTION_EVENT_TYPES = [
  "td_setup_progress", "phase_entered_extreme", "rsi_extreme_entered",
  "ema21_stretched", "supertrend_flat_opposing",
];

export function extractPatternProfile(diag = {}, opts = {}) {
  const events = Array.isArray(diag.events) ? diag.events : [];
  const sequences = Array.isArray(diag.sequences) ? diag.sequences : [];
  const eventTypes = [...new Set(events.map((ev) => ev.event_type).filter(Boolean))].sort();
  const has = (type) => eventTypes.includes(type);

  const longSeq = sequences.find((s) => s.direction === "LONG" && s.stage > 0) || null;
  const shortSeq = sequences.find((s) => s.direction === "SHORT" && s.stage > 0) || null;
  const moveDir = String(opts.moveDir || opts.direction || "").toUpperCase() || null;
  const alignedSeq = moveDir
    ? sequences.find((s) => s.direction === moveDir && s.stage > 0) || null
    : null;

  const confirmationHits = CONFIRMATION_EVENT_TYPES.filter(has);
  const exhaustionHits = EXHAUSTION_EVENT_TYPES.filter(has);

  return {
    event_count: events.length,
    event_types: eventTypes,
    exhaustion_events: exhaustionHits,
    confirmation_events: confirmationHits,
    has_td9: has("td9_complete"),
    has_td13: has("td13_complete"),
    has_st_flip: has("supertrend_flip"),
    has_st_breakthrough: has("supertrend_breakthrough"),
    has_ema21_reclaim: has("ema21_reclaim"),
    has_ema21_reject: has("ema21_reject"),
    has_ema200_reclaim: has("ema200_reclaim"),
    has_ema200_reject: has("ema200_reject"),
    has_squeeze_release: has("squeeze_release"),
    has_momentum_confirmation: has("momentum_confirmation"),
    has_orb_breakout: has("orb_breakout"),
    has_mean_reversion_target: has("mean_reversion_target_reached"),
    has_pullback_stabilized: has("pullback_stabilized"),
    long_mr_stage: longSeq?.stage ?? 0,
    short_mr_stage: shortSeq?.stage ?? 0,
    aligned_mr_stage: alignedSeq?.stage ?? 0,
    long_mr_status: longSeq?.status ?? "none",
    short_mr_status: shortSeq?.status ?? "none",
    aligned_mr_status: alignedSeq?.status ?? "none",
    long_matched_stages: (longSeq?.stage_results || []).filter((r) => r.matched).map((r) => r.key),
    short_matched_stages: (shortSeq?.stage_results || []).filter((r) => r.matched).map((r) => r.key),
    aligned_matched_stages: (alignedSeq?.stage_results || []).filter((r) => r.matched).map((r) => r.key),
    path_forecast: alignedSeq?.path_forecast?.primary_path
      || longSeq?.path_forecast?.primary_path
      || shortSeq?.path_forecast?.primary_path
      || null,
    invalidated: alignedSeq?.status === "invalidated" || longSeq?.status === "invalidated" || shortSeq?.status === "invalidated",
  };
}

function initCensusBucket() {
  return { n: 0, aligned: 0, opposed: 0, wins: 0, losses: 0 };
}

function censusSlice(row) {
  if (row.cohort === "discovery_missed") {
    const o = row.move_alignment?.outcome;
    if (o === "aligned") return "missed_aligned";
    if (o === "opposed") return "missed_opposed";
    return "missed_other";
  }
  if (row.outcome === "win" || row.trade_outcome === "win") return "captured_win";
  if (row.outcome === "loss" || row.trade_outcome === "loss") return "captured_loss";
  return "captured_other";
}

function touchCensus(map, key, slice) {
  if (!map.has(key)) {
    map.set(key, {
      missed_aligned: initCensusBucket(),
      missed_opposed: initCensusBucket(),
      missed_other: initCensusBucket(),
      captured_win: initCensusBucket(),
      captured_loss: initCensusBucket(),
      captured_other: initCensusBucket(),
    });
  }
  const bucket = map.get(key)[slice];
  bucket.n += 1;
  if (slice === "missed_aligned") bucket.aligned += 1;
  if (slice === "missed_opposed") bucket.opposed += 1;
  if (slice === "captured_win") bucket.wins += 1;
  if (slice === "captured_loss") bucket.losses += 1;
}

export function buildPatternCensusReport(rows = []) {
  const byEventType = new Map();
  const byConfirmationFlag = new Map();
  const byMrStage = new Map();
  const byPathForecast = new Map();
  const byMatchedStageKey = new Map();
  const headline = {
    total: 0,
    missed_aligned: 0,
    missed_opposed: 0,
    captured_win: 0,
    captured_loss: 0,
    with_td9: initCensusBucket(),
    with_st_flip: initCensusBucket(),
    with_squeeze: initCensusBucket(),
    with_ema21_reclaim: initCensusBucket(),
    with_ema200_reclaim: initCensusBucket(),
    stage6_plus: initCensusBucket(),
    entry_ready_stage8: initCensusBucket(),
    invalidated: initCensusBucket(),
  };

  for (const row of Array.isArray(rows) ? rows : []) {
    const profile = row.pattern_profile;
    if (!profile) continue;
    headline.total += 1;
    const slice = censusSlice(row);
    if (slice === "missed_aligned") headline.missed_aligned += 1;
    if (slice === "missed_opposed") headline.missed_opposed += 1;
    if (slice === "captured_win") headline.captured_win += 1;
    if (slice === "captured_loss") headline.captured_loss += 1;

    const flagPairs = [
      ["with_td9", profile.has_td9],
      ["with_st_flip", profile.has_st_flip],
      ["with_squeeze", profile.has_squeeze_release],
      ["with_ema21_reclaim", profile.has_ema21_reclaim],
      ["with_ema200_reclaim", profile.has_ema200_reclaim],
    ];
    for (const [headlineKey, on] of flagPairs) {
      if (!on) continue;
      headline[headlineKey].n += 1;
      touchCensus(byConfirmationFlag, headlineKey, slice);
    }

    if (profile.aligned_mr_stage >= 6) {
      headline.stage6_plus.n += 1;
      touchCensus(byConfirmationFlag, "aligned_stage_6_plus", slice);
    }
    if (profile.aligned_mr_stage >= 8) {
      headline.entry_ready_stage8.n += 1;
      touchCensus(byConfirmationFlag, "aligned_stage_8_entry_ready", slice);
    }
    if (profile.invalidated) {
      headline.invalidated.n += 1;
      touchCensus(byConfirmationFlag, "invalidated", slice);
    }

    for (const ev of profile.event_types || []) {
      touchCensus(byEventType, ev, slice);
    }

    const stageKey = profile.aligned_mr_stage > 0
      ? `stage_${profile.aligned_mr_stage}`
      : (profile.long_mr_stage > 0 || profile.short_mr_stage > 0
        ? `long_${profile.long_mr_stage}_short_${profile.short_mr_stage}`
        : "no_mr");
    touchCensus(byMrStage, stageKey, slice);

    if (profile.path_forecast) touchCensus(byPathForecast, profile.path_forecast, slice);

    for (const key of profile.aligned_matched_stages || []) {
      touchCensus(byMatchedStageKey, key, slice);
    }
  }

  const sortMap = (map) => [...map.entries()]
    .map(([key, slices]) => ({
      key,
      ...slices,
      total_n: Object.values(slices).reduce((s, b) => s + b.n, 0),
    }))
    .sort((a, b) => b.total_n - a.total_n || String(a.key).localeCompare(String(b.key)));

  return {
    headline,
    by_event_type: sortMap(byEventType),
    by_confirmation_flag: sortMap(byConfirmationFlag),
    by_mr_stage: sortMap(byMrStage),
    by_path_forecast: sortMap(byPathForecast),
    by_matched_stage_key: sortMap(byMatchedStageKey),
  };
}

export function formatPatternCensusMarkdown(report = {}) {
  const h = report.headline || {};
  const lines = [
    "# Setup pattern census (objective, all event types)",
    "",
    "MR forming (stage 1–4) is exhaustion only. Stages 5–7 add location/target confirmation;",
    "stage 6+ adds EMA reclaim, squeeze release, SuperTrend breakthrough; stage 8 = ST flip / ORB breakout.",
    "",
    "## Headline",
    "",
    `- Rows with pattern profile: ${h.total ?? 0}`,
    `- Missed aligned: ${h.missed_aligned ?? 0} | Missed opposed: ${h.missed_opposed ?? 0}`,
    `- Captured win: ${h.captured_win ?? 0} | Captured loss: ${h.captured_loss ?? 0}`,
    "",
    "## Confirmation flags (presence before anchor/entry)",
    "",
    "| Flag | N |",
    "|---|---:|",
  ];
  for (const [label, bucket] of [
    ["TD9 complete", h.with_td9],
    ["SuperTrend flip", h.with_st_flip],
    ["Squeeze release", h.with_squeeze],
    ["EMA21 reclaim", h.with_ema21_reclaim],
    ["EMA200 reclaim", h.with_ema200_reclaim],
    ["MR stage 6+ (breakthrough lane)", h.stage6_plus],
    ["MR stage 8 (entry-ready)", h.entry_ready_stage8],
    ["Invalidated sequence", h.invalidated],
  ]) {
    lines.push(`| ${label} | ${bucket?.n ?? 0} |`);
  }

  lines.push("", "## By event type (top 25)", "", "| Event | Total | Miss aligned | Miss opposed | Cap win | Cap loss |", "|---|---:|---:|---:|---:|---:|");
  for (const row of (report.by_event_type || []).slice(0, 25)) {
    lines.push(`| ${row.key} | ${row.total_n} | ${row.missed_aligned?.n ?? 0} | ${row.missed_opposed?.n ?? 0} | ${row.captured_win?.n ?? 0} | ${row.captured_loss?.n ?? 0} |`);
  }

  lines.push("", "## By MR stage (move-aligned direction)", "", "| Stage bucket | Total | Miss aligned | Miss opposed | Cap win | Cap loss |", "|---|---:|---:|---:|---:|---:|");
  for (const row of report.by_mr_stage || []) {
    lines.push(`| ${row.key} | ${row.total_n} | ${row.missed_aligned?.n ?? 0} | ${row.missed_opposed?.n ?? 0} | ${row.captured_win?.n ?? 0} | ${row.captured_loss?.n ?? 0} |`);
  }

  lines.push("", "## By matched stage key (ladder progress)", "", "| Stage key | Total | Miss aligned | Miss opposed |", "|---|---:|---:|---:|");
  for (const row of (report.by_matched_stage_key || []).slice(0, 20)) {
    lines.push(`| ${row.key} | ${row.total_n} | ${row.missed_aligned?.n ?? 0} | ${row.missed_opposed?.n ?? 0} |`);
  }

  lines.push("", "## By path forecast", "", "| Path | Total | Miss aligned | Miss opposed |", "|---|---:|---:|---:|");
  for (const row of report.by_path_forecast || []) {
    lines.push(`| ${row.key} | ${row.total_n} | ${row.missed_aligned?.n ?? 0} | ${row.missed_opposed?.n ?? 0} |`);
  }

  return lines.join("\n");
}

export function joinMissedMoveWithTrailDiagnostics(move = {}, trailRows = [], opts = {}) {
  const ticker = String(move.ticker || "").toUpperCase();
  const moveDir = resolveMoveDirection(move) || "LONG";
  const anchorTs = discoveryMoveAnchorTs(move) ?? Number(move.start_ts ?? move.startTs ?? move.entry_ts);
  const snapshots = snapshotsFromTrailRows(trailRows, ticker);
  const diag = diagnosticsForEntryWindow(snapshots, anchorTs, opts);
  const seq = sequenceForDirection(diag.sequences || [], moveDir);
  const moveAlignment = classifyMoveAlignment(move, seq);
  const patternProfile = opts.enrich_patterns !== false
    ? extractPatternProfile(diag, { moveDir })
    : null;

  return {
    cohort: "discovery_missed",
    move_id: move.move_id || `${ticker}:${anchorTs}`,
    ticker,
    direction: moveDir,
    capture: move.capture || "MISSED",
    start_ts: anchorTs,
    end_ts: Number(move.end_ts ?? move.endTs) || null,
    move_pct: Number(move.move_pct) || null,
    move_atr: Number(move.move_atr) || null,
    move_alignment: moveAlignment,
    outcome: moveAlignment.outcome,
    analysis_mode: opts.analysis_mode || "trail_5m_facts",
    promotion_safe: false,
    diagnostics_ok: diag.ok === true,
    diagnostics_reason: diag.reason || null,
    snapshot_count: diag.snapshot_count || 0,
    sequence: compactSequence(seq),
    pattern_profile: patternProfile,
    event_count: (diag.events || []).length,
  };
}

export function joinTradeWithSequenceDiagnostics(trade = {}, trailRows = [], opts = {}) {
  const ticker = String(trade.ticker || "").toUpperCase();
  const direction = String(trade.direction || "LONG").toUpperCase();
  const entryTs = Number(trade.entry_ts ?? trade.entryTs);
  const snapshots = snapshotsFromTrailRows(trailRows, ticker);
  const diag = diagnosticsForEntryWindow(snapshots, entryTs, opts);
  const seq = sequenceForDirection(diag.sequences || [], direction);
  const outcome = classifyTradeOutcome(trade);
  const patternProfile = opts.enrich_patterns !== false
    ? extractPatternProfile(diag, { moveDir: direction })
    : null;

  return {
    trade_id: trade.trade_id || trade.tradeId || null,
    ticker,
    direction,
    entry_ts: Number.isFinite(entryTs) ? entryTs : null,
    exit_ts: Number(trade.exit_ts ?? trade.exitTs) || null,
    entry_path: trade.entry_path || trade.setup_name || null,
    pnl_pct: outcome.pnl_pct,
    outcome: outcome.outcome,
    mfe_pct: Number(trade.max_favorable_excursion ?? trade.maxFavorableExcursion) || null,
    mae_pct: Number(trade.max_adverse_excursion ?? trade.maxAdverseExcursion) || null,
    diagnostics_ok: diag.ok === true,
    diagnostics_reason: diag.reason || null,
    snapshot_count: diag.snapshot_count || 0,
    analysis_mode: opts.analysis_mode || "trail_window",
    promotion_safe: opts.promotion_safe === true,
    sequence: compactSequence(seq),
    pattern_profile: patternProfile,
    trader_posture: diag.trader_posture,
    event_count: (diag.events || []).length,
  };
}

function initBucket() {
  return { n: 0, wins: 0, losses: 0, flat: 0, unknown: 0, pnl_sum: 0, pnl_n: 0 };
}

/** Discovery exports use UP/DOWN; sequences and trades use LONG/SHORT. */
export function normalizeMoveDirection(rawDir, movePct) {
  const d = String(rawDir ?? "").toUpperCase().trim();
  if (d === "UP" || d === "LONG" || d === "BULLISH") return "LONG";
  if (d === "DOWN" || d === "SHORT" || d === "BEARISH") return "SHORT";
  const pct = Number(movePct);
  if (Number.isFinite(pct)) return pct >= 0 ? "LONG" : "SHORT";
  return null;
}

/** Realized move direction — move_pct sign wins over stale stored direction. */
export function resolveMoveDirection(move = {}) {
  const movePct = Number(move.move_pct ?? move.movePct);
  if (Number.isFinite(movePct) && movePct !== 0) {
    return movePct >= 0 ? "LONG" : "SHORT";
  }
  return normalizeMoveDirection(
    move.direction ?? move.move_dir ?? move.move_alignment?.move_dir,
    movePct,
  );
}

export function classifyMoveAlignment(move = {}, sequence = null) {
  const movePct = Number(move.move_pct ?? move.movePct);
  const moveDir = resolveMoveDirection(move);
  if (!moveDir) {
    return {
      outcome: "unknown",
      move_dir: null,
      move_pct: Number.isFinite(movePct) ? movePct : null,
      move_atr: Number(move.move_atr) || null,
    };
  }
  if (!Number.isFinite(movePct)) {
    return { outcome: "unknown", move_dir: moveDir, move_pct: null, move_atr: Number(move.move_atr) || null };
  }
  if (!sequence?.direction) {
    return { outcome: "none", move_dir: moveDir, move_pct: movePct, move_atr: Number(move.move_atr) || null };
  }
  const seqDir = String(sequence.direction).toUpperCase();
  const aligned = seqDir === moveDir;
  return {
    outcome: aligned ? "aligned" : "opposed",
    move_dir: moveDir,
    move_pct: movePct,
    move_atr: Number(move.move_atr) || null,
  };
}

export function classifyTradeSequenceAlignment(trade = {}, sequence = null) {
  const tradeDir = normalizeMoveDirection(trade.direction, null);
  if (!tradeDir || !sequence?.direction) {
    return { outcome: "none", trade_dir: tradeDir, sequence_dir: sequence?.direction || null };
  }
  const seqDir = String(sequence.direction).toUpperCase();
  return {
    outcome: seqDir === tradeDir ? "aligned" : "opposed",
    trade_dir: tradeDir,
    sequence_dir: seqDir,
  };
}

function addToBucket(bucket, row) {
  bucket.n += 1;
  const outcome = row.outcome || row.move_alignment?.outcome;
  if (outcome === "win" || outcome === "aligned") bucket.wins += 1;
  else if (outcome === "loss" || outcome === "opposed") bucket.losses += 1;
  else if (outcome === "flat") bucket.flat += 1;
  else bucket.unknown += 1;
  const pnl = row.pnl_pct ?? row.move_alignment?.move_pct ?? row.move_pct;
  if (Number.isFinite(Number(pnl))) {
    bucket.pnl_sum += Number(pnl);
    bucket.pnl_n += 1;
  }
}

function finalizeBucket(bucket) {
  const decided = bucket.wins + bucket.losses;
  return {
    ...bucket,
    win_rate: decided > 0 ? Math.round((bucket.wins / decided) * 1000) / 1000 : null,
    avg_pnl_pct: bucket.pnl_n > 0 ? Math.round((bucket.pnl_sum / bucket.pnl_n) * 100) / 100 : null,
  };
}

export function aggregateMoveAlignment(joinedRows = []) {
  const stats = {
    total: 0,
    with_sequence: 0,
    aligned: 0,
    opposed: 0,
    none: 0,
    unknown: 0,
    by_stage: {},
    by_move_atr_tier: {
      high_atr: { label: "move_atr >= 8 (Tier A)", total: 0, aligned: 0, opposed: 0, none: 0 },
      breadth: { label: "move_atr < 8 (Tier B)", total: 0, aligned: 0, opposed: 0, none: 0 },
    },
    no_sequence_moves: [],
  };

  for (const row of Array.isArray(joinedRows) ? joinedRows : []) {
    stats.total += 1;
    const tierKey = Number(row.move_atr) >= 8 ? "high_atr" : "breadth";
    stats.by_move_atr_tier[tierKey].total += 1;

    const stage = row.sequence?.stage_bucket || "0_none";
    if (!stats.by_stage[stage]) {
      stats.by_stage[stage] = { total: 0, aligned: 0, opposed: 0, none: 0 };
    }
    stats.by_stage[stage].total += 1;

    const outcome = row.move_alignment?.outcome || row.outcome;
    if (!row.sequence?.sequence_type) {
      stats.none += 1;
      stats.by_move_atr_tier[tierKey].none += 1;
      stats.by_stage[stage].none += 1;
      stats.no_sequence_moves.push({
        ticker: row.ticker,
        move_id: row.move_id,
        move_atr: row.move_atr ?? null,
        move_pct: row.move_pct ?? null,
      });
      continue;
    }

    stats.with_sequence += 1;
    if (outcome === "aligned") {
      stats.aligned += 1;
      stats.by_move_atr_tier[tierKey].aligned += 1;
      stats.by_stage[stage].aligned += 1;
    } else if (outcome === "opposed") {
      stats.opposed += 1;
      stats.by_move_atr_tier[tierKey].opposed += 1;
      stats.by_stage[stage].opposed += 1;
    } else {
      stats.unknown += 1;
    }
  }

  const decided = stats.aligned + stats.opposed;
  stats.alignment_rate = decided > 0
    ? Math.round((stats.aligned / decided) * 1000) / 1000
    : null;
  stats.opposed_rate = decided > 0
    ? Math.round((stats.opposed / decided) * 1000) / 1000
    : null;

  return stats;
}

function sequenceKey(row) {
  if (!row?.sequence?.sequence_type) return "none:NA:0_none";
  const s = row.sequence;
  return `${s.sequence_type}:${s.direction}:${s.stage_bucket}`;
}

function initCompareBucket() {
  return { n: 0, wins: 0, losses: 0, with_sequence: 0, aligned: 0, opposed: 0, none: 0 };
}

export function compareCapturedVsMissed(capturedRows = [], missedRows = []) {
  const captured = Array.isArray(capturedRows) ? capturedRows : [];
  const missed = Array.isArray(missedRows) ? missedRows : [];

  const capSummary = initCompareBucket();
  const missSummary = initCompareBucket();
  const bySequence = new Map();

  const touchSeq = (map, key, row, aligned) => {
    if (!map.has(key)) map.set(key, { captured: initCompareBucket(), missed: initCompareBucket() });
    const bucket = map.get(key);
    const side = row.cohort === "discovery_missed" ? bucket.missed : bucket.captured;
    side.n += 1;
    if (row.sequence?.sequence_type) {
      side.with_sequence += 1;
      if (aligned === true) side.aligned += 1;
      else if (aligned === false) side.opposed += 1;
      else side.none += 1;
    } else {
      side.none += 1;
    }
    const outcome = row.outcome || row.trade_outcome;
    if (outcome === "win") side.wins += 1;
    else if (outcome === "loss") side.losses += 1;
  };

  for (const row of captured) {
    capSummary.n += 1;
    const align = classifyTradeSequenceAlignment(row, row.sequence);
    row.sequence_alignment = align;
    if (row.sequence?.sequence_type) {
      capSummary.with_sequence += 1;
      if (align.outcome === "aligned") capSummary.aligned += 1;
      else if (align.outcome === "opposed") capSummary.opposed += 1;
    } else capSummary.none += 1;
    if (row.outcome === "win") capSummary.wins += 1;
    else if (row.outcome === "loss") capSummary.losses += 1;
    touchSeq(bySequence, sequenceKey(row), row, align.outcome === "aligned");
  }

  for (const row of missed) {
    missSummary.n += 1;
    const align = row.move_alignment || classifyMoveAlignment(row, row.sequence);
    row.move_alignment = align;
    if (row.sequence?.sequence_type) {
      missSummary.with_sequence += 1;
      if (align.outcome === "aligned") missSummary.aligned += 1;
      else if (align.outcome === "opposed") missSummary.opposed += 1;
    } else missSummary.none += 1;
    touchSeq(bySequence, sequenceKey(row), row, align.outcome === "aligned");
  }

  const decidedCap = capSummary.aligned + capSummary.opposed;
  const decidedMiss = missSummary.aligned + missSummary.opposed;

  return {
    captured: {
      ...capSummary,
      win_rate: capSummary.wins + capSummary.losses > 0
        ? Math.round((capSummary.wins / (capSummary.wins + capSummary.losses)) * 1000) / 1000
        : null,
      alignment_rate: decidedCap > 0 ? Math.round((capSummary.aligned / decidedCap) * 1000) / 1000 : null,
    },
    missed: {
      ...missSummary,
      alignment_rate: decidedMiss > 0 ? Math.round((missSummary.aligned / decidedMiss) * 1000) / 1000 : null,
    },
    by_sequence: [...bySequence.entries()]
      .map(([key, v]) => ({ key, ...v }))
      .sort((a, b) => (b.captured.n + b.missed.n) - (a.captured.n + a.missed.n)),
  };
}

export function formatCapturedVsMissedMarkdown(report = {}) {
  const cap = report.captured || {};
  const miss = report.missed || {};
  const lines = [
    "# Captured trades vs missed moves — sequence comparison",
    "",
    "MR = **mean reversion** (TD phase exhaustion + location sequence, e.g. `td_phase_mean_reversion_long`).",
    "",
    "## Headline",
    "",
    "| Cohort | N | With sequence | Aligned | Opposed | Alignment rate | Win rate |",
    "|---|---:|---:|---:|---:|---:|---:|",
    `| Live captured trades | ${cap.n ?? 0} | ${cap.with_sequence ?? 0} | ${cap.aligned ?? 0} | ${cap.opposed ?? 0} | ${cap.alignment_rate ?? "—"} | ${cap.win_rate ?? "—"} |`,
    `| Discovery missed moves | ${miss.n ?? 0} | ${miss.with_sequence ?? 0} | ${miss.aligned ?? 0} | ${miss.opposed ?? 0} | ${miss.alignment_rate ?? "—"} | — |`,
    "",
    "## By sequence (type:direction:stage)",
    "",
    "| Key | Cap N | Cap aligned | Cap WR | Miss N | Miss aligned |",
    "|---|---:|---:|---:|---:|---:|",
  ];
  for (const row of report.by_sequence || []) {
    const c = row.captured || {};
    const m = row.missed || {};
    const wr = c.wins + c.losses > 0 ? Math.round((c.wins / (c.wins + c.losses)) * 100) / 100 : null;
    lines.push(`| ${row.key} | ${c.n} | ${c.aligned} | ${wr ?? "—"} | ${m.n} | ${m.aligned} |`);
  }
  lines.push(
    "",
    "## Backtest harness note",
    "",
    "Use the same read-only mining stack as live backtest validation:",
    "- `mine-setup-sequences.mjs --cohort trades` for captured/backtest trades",
    "- `replay-move-windows.mjs` + `--cohort discovery` for missed-move windows",
    "- Compare with `compare-captured-vs-missed.mjs` (this report)",
    "- Optional: replay discovery anchors through preprod scoring (`historical_replay`) to test whether entry gates would fire",
    "",
  );
  return lines.join("\n");
}

export function aggregateSequenceReliability(joinedRows = []) {
  const bySequence = new Map();
  const byStageBucket = new Map();
  const byTicker = new Map();
  const byPathArchetype = new Map();

  for (const row of Array.isArray(joinedRows) ? joinedRows : []) {
    const seqKey = row.sequence
      ? `${row.sequence.sequence_type}:${row.sequence.direction}:${row.sequence.stage_bucket}`
      : "none:NA:0_none";
    if (!bySequence.has(seqKey)) bySequence.set(seqKey, initBucket());
    addToBucket(bySequence.get(seqKey), row);

    const stageKey = row.sequence?.stage_bucket || "0_none";
    if (!byStageBucket.has(stageKey)) byStageBucket.set(stageKey, initBucket());
    addToBucket(byStageBucket.get(stageKey), row);

    const tickerKey = row.ticker || "UNKNOWN";
    if (!byTicker.has(tickerKey)) byTicker.set(tickerKey, initBucket());
    addToBucket(byTicker.get(tickerKey), row);

    const pathKey = row.sequence?.path_forecast?.primary_path || "none";
    if (!byPathArchetype.has(pathKey)) byPathArchetype.set(pathKey, initBucket());
    addToBucket(byPathArchetype.get(pathKey), row);
  }

  const sortEntries = (map) => [...map.entries()]
    .map(([key, bucket]) => ({ key, ...finalizeBucket(bucket) }))
    .sort((a, b) => b.n - a.n || String(a.key).localeCompare(String(b.key)));

  return {
    total_trades: joinedRows.length,
    with_sequence: joinedRows.filter((r) => r.sequence).length,
    with_diagnostics: joinedRows.filter((r) => r.diagnostics_ok).length,
    by_sequence: sortEntries(bySequence),
    by_stage_bucket: sortEntries(byStageBucket),
    by_ticker: sortEntries(byTicker),
    by_path_archetype: sortEntries(byPathArchetype),
  };
}

export function refreshMoveAlignmentOnRows(rows = []) {
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const move_alignment = classifyMoveAlignment(row, row.sequence);
    return {
      ...row,
      move_alignment,
      outcome: move_alignment.outcome,
      direction: move_alignment.move_dir || row.direction,
    };
  });
}

export function buildReliabilityReport(joinedRows = [], meta = {}) {
  const rows = refreshMoveAlignmentOnRows(joinedRows);
  const alignment = aggregateMoveAlignment(rows);
  return {
    generated_at: new Date().toISOString(),
    shadow: true,
    meta,
    alignment,
    reliability: aggregateSequenceReliability(rows),
    trades: rows,
  };
}

export function formatReliabilityMarkdown(report = {}) {
  const rel = report.reliability || {};
  const meta = report.meta || {};
  const align = report.alignment || {};
  const lines = [
    "# Setup Sequence Reliability (shadow mining)",
    "",
    `Generated: ${report.generated_at || "unknown"}`,
    "",
    "## Summary",
    "",
    `- Total trades analyzed: ${rel.total_trades ?? 0}`,
    `- Trades with diagnostics window: ${rel.with_diagnostics ?? 0}`,
    `- Trades with active sequence at anchor: ${rel.with_sequence ?? 0}`,
    meta.analysis_mode ? `- Analysis mode: ${meta.analysis_mode}` : "",
    meta.cohort ? `- Cohort: ${meta.cohort}` : "",
    "",
  ];

  if (align.total > 0) {
    lines.push(
      "## Move-direction alignment (missed-move cohort)",
      "",
      "Sequence direction vs realized move direction at the move anchor.",
      "",
      `- With sequence: ${align.with_sequence ?? 0}`,
      `- Aligned with move: ${align.aligned ?? 0} (${align.alignment_rate != null ? `${Math.round(align.alignment_rate * 100)}%` : "—"})`,
      `- Opposed to move: ${align.opposed ?? 0} (${align.opposed_rate != null ? `${Math.round(align.opposed_rate * 100)}%` : "—"})`,
      `- No sequence: ${align.none ?? 0}`,
      "",
      "### By move ATR tier",
      "",
      "| Tier | N | Aligned | Opposed | No sequence |",
      "|---|---:|---:|---:|---:|",
    );
    for (const bucket of Object.values(align.by_move_atr_tier || {})) {
      lines.push(`| ${bucket.label} | ${bucket.total} | ${bucket.aligned} | ${bucket.opposed} | ${bucket.none} |`);
    }
    lines.push("", "### By stage bucket", "", "| Stage | N | Aligned | Opposed | No sequence |", "|---|---:|---:|---:|---:|");
    for (const [stage, bucket] of Object.entries(align.by_stage || {}).sort((a, b) => String(a[0]).localeCompare(String(b[0])))) {
      lines.push(`| ${stage} | ${bucket.total} | ${bucket.aligned} | ${bucket.opposed} | ${bucket.none} |`);
    }
    if ((align.no_sequence_moves || []).length) {
      lines.push("", "### No-sequence moves", "", "| Ticker | move_id | move_atr | move_pct |", "|---|---|---:|---:|");
      for (const row of align.no_sequence_moves) {
        lines.push(`| ${row.ticker} | ${row.move_id} | ${row.move_atr ?? "—"} | ${row.move_pct ?? "—"} |`);
      }
    }
    lines.push("");
  }

  lines.push(
    "",
    "## By sequence (type:direction:stage_bucket)",
    "",
    "| Key | N | Win rate | Avg PnL % | Wins | Losses |",
    "|---|---:|---:|---:|---:|---:|",
  );

  for (const row of rel.by_sequence || []) {
    lines.push(`| ${row.key} | ${row.n} | ${row.win_rate ?? "—"} | ${row.avg_pnl_pct ?? "—"} | ${row.wins} | ${row.losses} |`);
  }

  lines.push("", "## By stage bucket", "", "| Bucket | N | Win rate | Avg PnL % |", "|---|---:|---:|---:|");
  for (const row of rel.by_stage_bucket || []) {
    lines.push(`| ${row.key} | ${row.n} | ${row.win_rate ?? "—"} | ${row.avg_pnl_pct ?? "—"} |`);
  }

  lines.push("", "## By path archetype", "", "| Path | N | Win rate | Avg PnL % |", "|---|---:|---:|---:|");
  for (const row of rel.by_path_archetype || []) {
    lines.push(`| ${row.key} | ${row.n} | ${row.win_rate ?? "—"} | ${row.avg_pnl_pct ?? "—"} |`);
  }

  return lines.join("\n");
}
