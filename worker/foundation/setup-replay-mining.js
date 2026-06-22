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
    has_rsi_divergence: has("rsi_divergence_confirmed"),
    has_phase_left: has("phase_left_accumulation") || has("phase_left_distribution") || has("phase_left_extreme"),
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

/** trail_5m_facts booleans often fire when pair-diff derivation does not emit events. */
export function augmentPatternProfileFromTrailFacts(profile, trailRows = [], trailSource = "5m") {
  if (!profile || trailSource !== "5m") return profile;
  const rows = Array.isArray(trailRows) ? trailRows : [];
  if (!rows.length) return profile;
  const eventTypes = new Set(profile.event_types || []);
  let hasStFlip = profile.has_st_flip;
  let hasSqueeze = profile.has_squeeze_release;
  let hasEmaCross = false;
  let hasMomentumElite = false;
  for (const row of rows) {
    if (row.had_st_flip) {
      hasStFlip = true;
      eventTypes.add("supertrend_flip");
    }
    if (row.had_squeeze_release) {
      hasSqueeze = true;
      eventTypes.add("squeeze_release");
    }
    if (row.had_ema_cross) {
      hasEmaCross = true;
      eventTypes.add("ema21_reclaim");
    }
    if (row.had_momentum_elite) {
      hasMomentumElite = true;
      eventTypes.add("momentum_confirmation");
    }
  }
  return {
    ...profile,
    event_types: [...eventTypes].sort(),
    has_st_flip: hasStFlip,
    has_squeeze_release: hasSqueeze,
    has_ema21_reclaim: profile.has_ema21_reclaim || hasEmaCross,
    has_momentum_confirmation: profile.has_momentum_confirmation || hasMomentumElite,
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
    with_rsi_divergence: initCensusBucket(),
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
      ["with_rsi_divergence", profile.has_rsi_divergence],
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
    ["RSI divergence confirmed", h.with_rsi_divergence],
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

export const EVENT_COMBO_PRESETS = [
  { key: "exhaustion_forming_only", label: "Exhaustion forming only (stage key)", test: (p) => (p.aligned_matched_stages || []).includes("exhaustion_forming") && !(p.confirmation_events || []).length },
  { key: "exhaustion_confirmed", label: "Exhaustion confirmed (TD9/TD13 stage)", test: (p) => (p.aligned_matched_stages || []).includes("exhaustion_confirmed") || p.has_td9 || p.has_td13 },
  { key: "location_valid", label: "Location valid (PDZ/FVG stage)", test: (p) => (p.aligned_matched_stages || []).includes("location_valid") },
  { key: "mean_reversion_target", label: "MR target reached (EMA21/VWAP stage)", test: (p) => (p.aligned_matched_stages || []).includes("mean_reversion_target") || p.has_mean_reversion_target },
  { key: "breakthrough_momentum", label: "Breakthrough w/ momentum (stage 6)", test: (p) => (p.aligned_matched_stages || []).includes("breakthrough_with_momentum") || p.has_st_breakthrough || p.has_momentum_confirmation },
  { key: "pullback_stabilized", label: "Pullback stabilized (hold lane)", test: (p) => (p.aligned_matched_stages || []).includes("pullback_stabilized") || p.has_pullback_stabilized },
  { key: "confirm_st_flip", label: "SuperTrend flip", test: (p) => p.has_st_flip },
  { key: "confirm_squeeze", label: "Squeeze release", test: (p) => p.has_squeeze_release },
  { key: "confirm_ema21_reclaim", label: "EMA21 reclaim", test: (p) => p.has_ema21_reclaim },
  { key: "confirm_ema21_reject", label: "EMA21 reject", test: (p) => p.has_ema21_reject },
  { key: "confirm_ema200_reclaim", label: "EMA200 reclaim", test: (p) => p.has_ema200_reclaim },
  { key: "stack_st+ema21", label: "ST flip + EMA21 reclaim", test: (p) => p.has_st_flip && p.has_ema21_reclaim },
  { key: "stack_st+squeeze", label: "ST flip + squeeze release", test: (p) => p.has_st_flip && p.has_squeeze_release },
  { key: "stack_td9+st", label: "TD9 + ST flip", test: (p) => p.has_td9 && p.has_st_flip },
  { key: "confirm_rsi_divergence", label: "RSI divergence confirmed", test: (p) => p.has_rsi_divergence || (p.event_types || []).includes("rsi_divergence_confirmed") },
  { key: "stack_td9+rsi_div", label: "TD9 + RSI divergence", test: (p) => p.has_td9 && (p.has_rsi_divergence || (p.event_types || []).includes("rsi_divergence_confirmed")) },
  { key: "stack_exhaust+rsi_div", label: "Exhaustion confirmed + RSI divergence", test: (p) => ((p.aligned_matched_stages || []).includes("exhaustion_confirmed") || p.has_td9 || p.has_td13) && (p.has_rsi_divergence || (p.event_types || []).includes("rsi_divergence_confirmed")) },
  { key: "stack_runway_mr", label: "TD9 + RSI div + phase left zone (MR stage 4)", test: (p) => (p.has_td9 || p.has_td13) && (p.has_rsi_divergence || (p.event_types || []).includes("rsi_divergence_confirmed")) && ((p.aligned_matched_stages || []).includes("phase_left_zone") || p.has_phase_left) },
  { key: "stack_td9+div+momentum", label: "TD9 + RSI div + momentum (ST/squeeze/breakthrough)", test: (p) => p.has_td9 && (p.has_rsi_divergence || (p.event_types || []).includes("rsi_divergence_confirmed")) && (p.has_st_flip || p.has_squeeze_release || p.has_st_breakthrough || p.has_momentum_confirmation) },
  { key: "stack_full_confirm", label: "ST flip + squeeze + EMA21 (reclaim or reject)", test: (p) => p.has_st_flip && p.has_squeeze_release && (p.has_ema21_reclaim || p.has_ema21_reject) },
  { key: "mr_stage5_plus", label: "MR aligned stage >= 5", test: (p) => p.aligned_mr_stage >= 5 },
  { key: "mr_stage6_plus", label: "MR aligned stage >= 6", test: (p) => p.aligned_mr_stage >= 6 },
  { key: "invalidated", label: "Sequence invalidated", test: (p) => p.invalidated === true },
];

export function liftSlice(row = {}) {
  if (row.cohort === "backtest") {
    if (row.outcome === "win") return "backtest_win";
    if (row.outcome === "loss") return "backtest_loss";
    return "backtest_other";
  }
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

function initLiftTotals() {
  return {
    backtest_win: 0,
    backtest_loss: 0,
    missed_aligned: 0,
    missed_opposed: 0,
    missed_tier_a: 0,
    missed_other: 0,
    backtest_other: 0,
  };
}

function initLiftPresence() {
  return {
    backtest_win: 0,
    backtest_loss: 0,
    missed_aligned: 0,
    missed_opposed: 0,
    missed_tier_a: 0,
  };
}

function rate(n, d) {
  if (!d || d <= 0) return null;
  return Math.round((n / d) * 1000) / 1000;
}

function liftRow(key, label, kind, presence, totals) {
  const winR = rate(presence.backtest_win, totals.backtest_win);
  const lossR = rate(presence.backtest_loss, totals.backtest_loss);
  const missR = rate(presence.missed_aligned, totals.missed_aligned);
  const missTierR = rate(presence.missed_tier_a, totals.missed_tier_a);
  const winLift = winR != null && lossR != null ? Math.round((winR - lossR) * 1000) / 1000 : null;
  const winRatio = winR != null && lossR != null && lossR > 0 ? Math.round((winR / lossR) * 100) / 100 : null;
  const captureGap = missTierR != null && winR != null ? Math.round((missTierR - winR) * 1000) / 1000 : null;
  return {
    key,
    label,
    kind,
    totals: { ...totals },
    presence: { ...presence },
    rates: {
      backtest_win: winR,
      backtest_loss: lossR,
      missed_aligned: missR,
      missed_tier_a: missTierR,
    },
    win_lift: winLift,
    win_ratio: winRatio,
    capture_gap_tier_a: captureGap,
  };
}

export function buildEventLiftReport(rows = [], opts = {}) {
  const totals = initLiftTotals();
  const eventPresence = new Map();
  const comboPresence = new Map();
  const tierAThreshold = Number(opts.tier_a_min_atr) || 8;

  for (const row of Array.isArray(rows) ? rows : []) {
    const profile = row.pattern_profile;
    if (!profile) continue;
    const slice = liftSlice(row);
    if (slice === "backtest_other" || slice === "missed_other" || slice === "captured_other") continue;
    totals[slice] += 1;
    const isTierAMiss = row.cohort === "discovery_missed" && Number(row.move_atr) >= tierAThreshold;
    if (isTierAMiss) totals.missed_tier_a += 1;

    for (const ev of profile.event_types || []) {
      if (!eventPresence.has(ev)) eventPresence.set(ev, initLiftPresence());
      eventPresence.get(ev)[slice] += 1;
      if (isTierAMiss) eventPresence.get(ev).missed_tier_a += 1;
    }

    for (const preset of EVENT_COMBO_PRESETS) {
      if (!preset.test(profile)) continue;
      if (!comboPresence.has(preset.key)) comboPresence.set(preset.key, initLiftPresence());
      comboPresence.get(preset.key)[slice] += 1;
      if (isTierAMiss) comboPresence.get(preset.key).missed_tier_a += 1;
    }
  }

  const byEvent = [...eventPresence.entries()]
    .map(([key, presence]) => liftRow(key, key, "event", presence, totals))
    .sort((a, b) => (b.win_lift ?? -999) - (a.win_lift ?? -999) || b.presence.backtest_win - a.presence.backtest_win);

  const byCombo = [...comboPresence.entries()]
    .map(([key, presence]) => {
      const preset = EVENT_COMBO_PRESETS.find((p) => p.key === key);
      return liftRow(key, preset?.label || key, "combo", presence, totals);
    })
    .sort((a, b) => (b.win_lift ?? -999) - (a.win_lift ?? -999) || b.rates.missed_tier_a - a.rates.backtest_win);

  return {
    totals,
    tier_a_min_atr: tierAThreshold,
    by_event: byEvent,
    by_combo: byCombo,
    top_win_lift: byCombo.filter((r) => r.win_lift != null).slice(0, 10),
    top_capture_signals: byCombo
      .filter((r) => r.rates.missed_tier_a != null && r.rates.backtest_win != null)
      .sort((a, b) => (b.capture_gap_tier_a ?? -999) - (a.capture_gap_tier_a ?? -999))
      .slice(0, 10),
  };
}

export function formatEventLiftMarkdown(report = {}) {
  const t = report.totals || {};
  const lines = [
    "# Event-combo lift pass (objective)",
    "",
    "Compares pattern presence **before entry/anchor** across cohorts.",
    "Win lift = P(pattern|backtest WIN) − P(pattern|backtest LOSS).",
    "Capture gap (Tier A) = P(pattern|missed move) − P(pattern|backtest WIN) — positive means the signal was visible on misses we did not trade.",
    "",
    "## Cohort sizes",
    "",
    "| Cohort | N |",
    "|---|---:|",
    `| Backtest WIN | ${t.backtest_win ?? 0} |`,
    `| Backtest LOSS | ${t.backtest_loss ?? 0} |`,
    `| Missed (aligned) | ${t.missed_aligned ?? 0} |`,
    `| Missed Tier A (move_atr >= ${report.tier_a_min_atr ?? 8}) | ${t.missed_tier_a ?? 0} |`,
    "",
    "## Combo presets — win lift (sorted)",
    "",
    "| Combo | Win rate | Loss rate | Win lift | Win/loss ratio | Miss Tier A rate | Capture gap |",
    "|---|---:|---:|---:|---:|---:|---:|",
  ];

  for (const row of report.by_combo || []) {
    lines.push(`| ${row.label} | ${row.rates.backtest_win ?? "—"} | ${row.rates.backtest_loss ?? "—"} | ${row.win_lift ?? "—"} | ${row.win_ratio ?? "—"} | ${row.rates.missed_tier_a ?? "—"} | ${row.capture_gap_tier_a ?? "—"} |`);
  }

  lines.push("", "## Top events by win lift", "", "| Event | Win rate | Loss rate | Win lift | Miss Tier A rate |", "|---|---:|---:|---:|---:|");
  for (const row of (report.by_event || []).filter((r) => r.win_lift != null).slice(0, 20)) {
    lines.push(`| ${row.key} | ${row.rates.backtest_win ?? "—"} | ${row.rates.backtest_loss ?? "—"} | ${row.win_lift ?? "—"} | ${row.rates.missed_tier_a ?? "—"} |`);
  }

  lines.push("", "## Interpretation guardrails", "", "- High **miss Tier A rate** + low **win lift** = ubiquitous noise (e.g. ST flip on all moves).", "- Positive **win lift** + high **miss Tier A rate** = candidate capture stack worth gate simulation.", "- Negative win lift on exhaustion-only = confirms do-not-promote forming MR without confirmation.", "");

  return lines.join("\n");
}

export function gatePresetByKey(gateKey) {
  return EVENT_COMBO_PRESETS.find((p) => p.key === gateKey) || null;
}

export function evaluateGateOnProfile(profile, gateKey) {
  const preset = gatePresetByKey(gateKey);
  if (!preset || !profile) return false;
  return preset.test(profile) === true;
}

/** Minimal profile flags from accumulated event types (for timing walk). */
export function profileFlagsFromEventTypes(eventTypes = []) {
  const types = new Set(eventTypes);
  const has = (t) => types.has(t);
  return {
    has_td9: has("td9_complete"),
    has_td13: has("td13_complete"),
    has_st_flip: has("supertrend_flip"),
    has_squeeze_release: has("squeeze_release"),
    has_ema21_reclaim: has("ema21_reclaim"),
    has_ema21_reject: has("ema21_reject"),
    has_ema200_reclaim: has("ema200_reclaim"),
    has_rsi_divergence: has("rsi_divergence_confirmed"),
    has_phase_left: has("phase_left_accumulation") || has("phase_left_distribution") || has("phase_left_extreme"),
    has_st_breakthrough: has("supertrend_breakthrough"),
    has_momentum_confirmation: has("momentum_confirmation"),
    has_mean_reversion_target: has("mean_reversion_target_reached"),
    has_pullback_stabilized: has("pullback_stabilized"),
    aligned_mr_stage: 0,
    aligned_matched_stages: [],
    confirmation_events: [],
    exhaustion_events: [],
    invalidated: false,
  };
}

export function profileFlagsFromTrailCumulative(state = {}) {
  return {
    has_st_flip: state.has_st_flip === true,
    has_squeeze_release: state.has_squeeze_release === true,
    has_ema21_reclaim: state.has_ema21_reclaim === true,
    has_ema21_reject: state.has_ema21_reject === true,
    has_td9: state.has_td9 === true,
    has_td13: state.has_td13 === true,
    has_ema200_reclaim: state.has_ema200_reclaim === true,
    has_st_breakthrough: false,
    has_momentum_confirmation: state.has_momentum_elite === true,
    has_mean_reversion_target: false,
    has_pullback_stabilized: false,
    aligned_mr_stage: 0,
    aligned_matched_stages: [],
    confirmation_events: [],
    exhaustion_events: [],
    invalidated: false,
  };
}

export function computeGateTimingFromEvents(events = [], anchorTs, gateKey, opts = {}) {
  const preset = gatePresetByKey(gateKey);
  const anchor = Number(anchorTs);
  const preMs = Number(opts.preEntryMs) || 48 * 60 * 60 * 1000;
  const since = Number.isFinite(anchor) ? anchor - preMs : null;
  if (!preset || !Number.isFinite(anchor)) {
    return { fires: false, first_fire_ts: null, hours_before_anchor: null, source: "events" };
  }
  const sorted = (Array.isArray(events) ? events : [])
    .filter((ev) => {
      const ts = Number(ev.event_ts);
      if (!Number.isFinite(ts) || ts > anchor) return false;
      if (since != null && ts < since) return false;
      return true;
    })
    .sort((a, b) => Number(a.event_ts) - Number(b.event_ts));

  const types = [];
  for (const ev of sorted) {
    if (ev.event_type) types.push(ev.event_type);
    if (preset.test(profileFlagsFromEventTypes(types))) {
      const ts = Number(ev.event_ts);
      return {
        fires: true,
        first_fire_ts: ts,
        hours_before_anchor: Math.round(((anchor - ts) / (60 * 60 * 1000)) * 10) / 10,
        source: "events",
      };
    }
  }
  return { fires: false, first_fire_ts: null, hours_before_anchor: null, source: "events" };
}

export function computeGateTimingFromTrailRows(trailRows = [], anchorTs, gateKey, opts = {}) {
  const preset = gatePresetByKey(gateKey);
  const anchor = Number(anchorTs);
  const preMs = Number(opts.preEntryMs) || 48 * 60 * 60 * 1000;
  const since = Number.isFinite(anchor) ? anchor - preMs : null;
  if (!preset || !Number.isFinite(anchor)) {
    return { fires: false, first_fire_ts: null, hours_before_anchor: null, source: "trail_5m" };
  }
  const sorted = (Array.isArray(trailRows) ? trailRows : [])
    .map((row) => ({ row, ts: Number(row.bucket_ts ?? row.ts) }))
    .filter(({ ts }) => Number.isFinite(ts) && ts <= anchor && (since == null || ts >= since))
    .sort((a, b) => a.ts - b.ts);

  const state = {
    has_st_flip: false,
    has_squeeze_release: false,
    has_ema21_reclaim: false,
    has_ema21_reject: false,
    has_td9: false,
    has_momentum_elite: false,
  };

  for (const { row, ts } of sorted) {
    if (row.had_st_flip) state.has_st_flip = true;
    if (row.had_squeeze_release) state.has_squeeze_release = true;
    if (row.had_ema_cross) state.has_ema21_reclaim = true;
    if (row.had_momentum_elite) state.has_momentum_elite = true;
    if (preset.test(profileFlagsFromTrailCumulative(state))) {
      return {
        fires: true,
        first_fire_ts: ts,
        hours_before_anchor: Math.round(((anchor - ts) / (60 * 60 * 1000)) * 10) / 10,
        source: "trail_5m",
      };
    }
  }
  return { fires: false, first_fire_ts: null, hours_before_anchor: null, source: "trail_5m" };
}

function avg(nums) {
  const vals = nums.filter((n) => Number.isFinite(n));
  if (!vals.length) return null;
  return Math.round((vals.reduce((s, n) => s + n, 0) / vals.length) * 100) / 100;
}

export function buildGateSimulationReport(rows = [], opts = {}) {
  const gateKeys = opts.gate_keys || ["stack_full_confirm", "stack_st+squeeze", "confirm_st_flip"];
  const tierMin = Number(opts.tier_a_min_atr) || 8;
  const timingByMoveId = opts.timing_by_move_id || {};

  const gates = gateKeys.map((gateKey) => {
    const preset = gatePresetByKey(gateKey);
    const tierA = [];
    const btWin = [];
    const btLoss = [];

    for (const row of Array.isArray(rows) ? rows : []) {
      if (!row.pattern_profile) continue;
      const fires = evaluateGateOnProfile(row.pattern_profile, gateKey);
      const enriched = { ...row, gate_fires: fires };
      if (row.cohort === "discovery_missed" && Number(row.move_atr) >= tierMin) tierA.push(enriched);
      else if (row.cohort === "backtest" && row.outcome === "win") btWin.push(enriched);
      else if (row.cohort === "backtest" && row.outcome === "loss") btLoss.push(enriched);
    }

    const tierEnter = tierA.filter((r) => r.gate_fires);
    const winEnter = btWin.filter((r) => r.gate_fires).length;
    const lossEnter = btLoss.filter((r) => r.gate_fires).length;
    const decided = winEnter + lossEnter;

    const timingRows = tierEnter
      .map((r) => timingByMoveId[r.move_id])
      .filter((t) => t?.fires === true && Number.isFinite(t.hours_before_anchor));

    return {
      key: gateKey,
      label: preset?.label || gateKey,
      tier_a: {
        n: tierA.length,
        would_enter: tierEnter.length,
        enter_rate: rate(tierEnter.length, tierA.length),
        avg_abs_move_pct_when_enter: avg(tierEnter.map((r) => Math.abs(Number(r.move_pct)))),
        avg_move_atr_when_enter: avg(tierEnter.map((r) => Number(r.move_atr))),
        aligned_rate_when_enter: rate(
          tierEnter.filter((r) => r.move_alignment?.outcome === "aligned").length,
          tierEnter.length,
        ),
      },
      backtest_win: {
        n: btWin.length,
        would_enter: winEnter,
        enter_rate: rate(winEnter, btWin.length),
      },
      backtest_loss: {
        n: btLoss.length,
        would_enter: lossEnter,
        enter_rate: rate(lossEnter, btLoss.length),
      },
      win_share_when_gate_fires: rate(winEnter, decided),
      baseline_backtest_win_rate: rate(btWin.length, btWin.length + btLoss.length),
      capture_opportunity: rate(tierEnter.length, tierA.length) != null && rate(winEnter, btWin.length) != null
        ? Math.round((rate(tierEnter.length, tierA.length) - rate(winEnter, btWin.length)) * 1000) / 1000
        : null,
      timing_tier_a: {
        n_with_timing: timingRows.length,
        avg_hours_before_anchor: avg(timingRows.map((t) => t.hours_before_anchor)),
        median_hours_before_anchor: timingRows.length
          ? (() => {
            const sorted = timingRows.map((t) => t.hours_before_anchor).sort((a, b) => a - b);
            const mid = Math.floor(sorted.length / 2);
            return sorted.length % 2 ? sorted[mid] : Math.round(((sorted[mid - 1] + sorted[mid]) / 2) * 10) / 10;
          })()
          : null,
      },
    };
  });

  return {
    tier_a_min_atr: tierMin,
    pre_entry_hours: opts.pre_entry_hours ?? null,
    gates,
    primary_gate: opts.primary_gate || "stack_full_confirm",
  };
}

export function formatGateSimulationMarkdown(report = {}) {
  const lines = [
    "# Confirm-stack gate simulation",
    "",
    "Shadow gate: entry allowed only when the confirmation stack is present in the lookback window before anchor/entry.",
    "Does **not** place trades — measures hypothetical fill rates only.",
    "",
    `Tier A threshold: move_atr >= ${report.tier_a_min_atr ?? 8}`,
    `Lookback: ${report.pre_entry_hours ?? "—"}h before anchor/entry`,
    "",
    "## Gate comparison",
    "",
    "| Gate | Tier A enter % | BT WIN enter % | BT LOSS enter % | Win share if entered | Capture opp | Avg h before move |",
    "|---|---:|---:|---:|---:|---:|---:|",
  ];

  for (const g of report.gates || []) {
    lines.push(`| ${g.label} | ${g.tier_a.enter_rate ?? "—"} | ${g.backtest_win.enter_rate ?? "—"} | ${g.backtest_loss.enter_rate ?? "—"} | ${g.win_share_when_gate_fires ?? "—"} | ${g.capture_opportunity ?? "—"} | ${g.timing_tier_a.avg_hours_before_anchor ?? "—"} |`);
  }

  const primary = (report.gates || []).find((g) => g.key === report.primary_gate) || report.gates?.[0];
  if (primary) {
    lines.push(
      "",
      "## Primary gate detail",
      "",
      `Gate: **${primary.label}** (\`${primary.key}\`)`,
      "",
      "| Cohort | N | Would enter | Enter rate |",
      "|---|---:|---:|---:|",
      `| Tier A missed | ${primary.tier_a.n} | ${primary.tier_a.would_enter} | ${primary.tier_a.enter_rate ?? "—"} |`,
      `| Backtest WIN | ${primary.backtest_win.n} | ${primary.backtest_win.would_enter} | ${primary.backtest_win.enter_rate ?? "—"} |`,
      `| Backtest LOSS | ${primary.backtest_loss.n} | ${primary.backtest_loss.would_enter} | ${primary.backtest_loss.enter_rate ?? "—"} |`,
      "",
      `- Win share when gate fires: **${primary.win_share_when_gate_fires ?? "—"}** (baseline backtest WR: ${primary.baseline_backtest_win_rate ?? "—"})`,
      `- Tier A avg |move| when gate fires: **${primary.tier_a.avg_abs_move_pct_when_enter ?? "—"}%** (avg move_atr: ${primary.tier_a.avg_move_atr_when_enter ?? "—"})`,
      `- Tier A aligned with realized direction when gate fires: **${primary.tier_a.aligned_rate_when_enter ?? "—"}**`,
      `- Median lead time (Tier A, event timing): **${primary.timing_tier_a.median_hours_before_anchor ?? "—"}h** before move anchor`,
      "",
      "### Promotion read",
      "",
      "- **Proceed to preprod shadow stamp** if win share when gate fires >= baseline WR and Tier A enter rate > BT WIN enter rate (capture opportunity > 0).",
      "- **Blocked for live sizing** until forward shadow + L2 parity pass.",
      "",
    );
  }

  return lines.join("\n");
}

export const RUNWAY_EXHAUSTION_TYPES = [
  "td9_complete", "td13_complete", "phase_entered_extreme", "td_setup_progress",
];

export const RUNWAY_DIVERGENCE_TYPES = ["rsi_divergence_confirmed"];

export const RUNWAY_PHASE_LEFT_TYPES = [
  "phase_left_accumulation", "phase_left_distribution", "phase_left_extreme", "rsi_extreme_left",
];

export const RUNWAY_MOMENTUM_TYPES = [
  "supertrend_flip", "squeeze_release", "supertrend_breakthrough", "momentum_confirmation",
  "ema21_reclaim", "ema21_reject", "orb_breakout", "orb_reclaim",
];

function eventDirectionAligned(ev, moveDir) {
  const dir = String(ev?.direction || "").toUpperCase();
  if (!dir || dir === "NEUTRAL") return true;
  return dir === String(moveDir || "").toUpperCase();
}

function filterRunwayEvents(events = [], anchorTs, preMs) {
  const anchor = Number(anchorTs);
  const since = Number.isFinite(anchor) ? anchor - (Number(preMs) || 0) : null;
  return (Array.isArray(events) ? events : [])
    .filter((ev) => {
      const ts = Number(ev.event_ts);
      if (!Number.isFinite(ts) || ts > anchor) return false;
      if (since != null && ts < since) return false;
      return true;
    })
    .sort((a, b) => Number(a.event_ts) - Number(b.event_ts));
}

export function firstRunwayEventTs(events = [], types = [], moveDir = null) {
  const typeSet = new Set(types);
  for (const ev of events) {
    if (!typeSet.has(ev.event_type)) continue;
    if (moveDir && !eventDirectionAligned(ev, moveDir)) continue;
    const ts = Number(ev.event_ts);
    if (Number.isFinite(ts)) return ts;
  }
  return null;
}

function hoursBetween(fromTs, toTs) {
  const a = Number(fromTs);
  const b = Number(toTs);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0 || b <= a) return null;
  return Math.round(((b - a) / (60 * 60 * 1000)) * 10) / 10;
}

/** Event-order runway: exhaustion → divergence → momentum before anchor. */
export function analyzeDivergenceRunway(events = [], anchorTs, moveDir, opts = {}) {
  const anchor = Number(anchorTs);
  const preMs = Number(opts.preEntryMs) || 120 * 60 * 60 * 1000;
  const windowEvents = filterRunwayEvents(events, anchor, preMs);
  const dir = String(moveDir || "").toUpperCase();

  const firstExhaustTs = firstRunwayEventTs(windowEvents, RUNWAY_EXHAUSTION_TYPES, dir);
  const firstTd9Ts = firstRunwayEventTs(windowEvents, ["td9_complete", "td13_complete"], dir);
  const firstDivTs = firstRunwayEventTs(windowEvents, RUNWAY_DIVERGENCE_TYPES, dir);
  const firstPhaseLeftTs = firstRunwayEventTs(windowEvents, RUNWAY_PHASE_LEFT_TYPES, dir);
  const firstMomentumTs = firstRunwayEventTs(windowEvents, RUNWAY_MOMENTUM_TYPES, dir);

  const exhaustBeforeDiv = firstExhaustTs != null && firstDivTs != null && firstExhaustTs <= firstDivTs;
  const td9BeforeDiv = firstTd9Ts != null && firstDivTs != null && firstTd9Ts <= firstDivTs;
  const divBeforeMomentum = firstDivTs != null && firstMomentumTs != null && firstDivTs <= firstMomentumTs;
  const divBeforeAnchor = firstDivTs != null && Number.isFinite(anchor) && firstDivTs <= anchor;
  const momentumBeforeAnchor = firstMomentumTs != null && Number.isFinite(anchor) && firstMomentumTs <= anchor;
  const runwayComplete = exhaustBeforeDiv && divBeforeMomentum && momentumBeforeAnchor;

  let ordering = "incomplete";
  if (firstExhaustTs != null && firstDivTs != null && firstMomentumTs != null) {
    if (firstExhaustTs <= firstDivTs && firstDivTs <= firstMomentumTs) ordering = "exhaust_div_momentum";
    else if (firstDivTs <= firstExhaustTs && firstDivTs <= firstMomentumTs) ordering = "div_exhaust_momentum";
    else if (firstExhaustTs <= firstMomentumTs && firstMomentumTs <= firstDivTs) ordering = "exhaust_momentum_div";
    else ordering = "mixed";
  } else if (firstExhaustTs != null && firstDivTs != null && firstExhaustTs <= firstDivTs) {
    ordering = "exhaust_then_div";
  } else if (firstDivTs != null && firstExhaustTs != null && firstDivTs < firstExhaustTs) {
    ordering = "div_before_exhaust";
  }

  return {
    has_exhaustion: firstExhaustTs != null,
    has_td9: firstTd9Ts != null,
    has_divergence: firstDivTs != null,
    has_phase_left: firstPhaseLeftTs != null,
    has_momentum: firstMomentumTs != null,
    first_exhaust_ts: firstExhaustTs,
    first_td9_ts: firstTd9Ts,
    first_div_ts: firstDivTs,
    first_phase_left_ts: firstPhaseLeftTs,
    first_momentum_ts: firstMomentumTs,
    hours_exhaust_to_div: hoursBetween(firstExhaustTs, firstDivTs),
    hours_td9_to_div: hoursBetween(firstTd9Ts, firstDivTs),
    hours_div_to_momentum: hoursBetween(firstDivTs, firstMomentumTs),
    hours_div_to_anchor: hoursBetween(firstDivTs, anchor),
    hours_momentum_to_anchor: hoursBetween(firstMomentumTs, anchor),
    exhaust_before_div: exhaustBeforeDiv,
    td9_before_div: td9BeforeDiv,
    div_before_momentum: divBeforeMomentum,
    div_before_anchor: divBeforeAnchor,
    runway_complete: runwayComplete,
    ordering,
    event_count: windowEvents.length,
  };
}

function initRunwayBucket() {
  return { n: 0, with_div: 0, td9_before_div: 0, exhaust_before_div: 0, div_before_momentum: 0, runway_complete: 0 };
}

function touchRunwayStat(bucket, timing) {
  bucket.n += 1;
  if (timing.has_divergence) bucket.with_div += 1;
  if (timing.td9_before_div) bucket.td9_before_div += 1;
  if (timing.exhaust_before_div) bucket.exhaust_before_div += 1;
  if (timing.div_before_momentum) bucket.div_before_momentum += 1;
  if (timing.runway_complete) bucket.runway_complete += 1;
}

function runwayRates(bucket) {
  return {
    n: bucket.n,
    with_div_rate: rate(bucket.with_div, bucket.n),
    td9_before_div_rate: rate(bucket.td9_before_div, bucket.with_div),
    exhaust_before_div_rate: rate(bucket.exhaust_before_div, bucket.with_div),
    div_before_momentum_rate: rate(bucket.div_before_momentum, bucket.with_div),
    runway_complete_rate: rate(bucket.runway_complete, bucket.n),
  };
}

export function buildDivergenceRunwayReport(rows = [], opts = {}) {
  const tierMin = Number(opts.tier_a_min_atr) || 8;
  const buckets = {
    tier_a_missed: initRunwayBucket(),
    missed_aligned: initRunwayBucket(),
    backtest_win: initRunwayBucket(),
    backtest_loss: initRunwayBucket(),
  };
  const timings = [];
  const orderingCounts = {};
  const hoursTd9ToDiv = [];
  const hoursDivToMomentum = [];
  const hoursDivToAnchor = [];
  const moveAtrWithRunway = [];
  const moveAtrDivOnly = [];

  for (const row of Array.isArray(rows) ? rows : []) {
    const events = row.events || row.setup_events || [];
    if (!events.length) continue;
    const anchorTs = Number(row.anchor_ts ?? row.start_ts ?? row.entry_ts);
    const moveDir = String(row.move_dir ?? row.direction ?? resolveMoveDirection(row) ?? "LONG").toUpperCase();
    if (!Number.isFinite(anchorTs)) continue;

    const timing = analyzeDivergenceRunway(events, anchorTs, moveDir, opts);
    timings.push({ ...row, timing });

    let bucketKey = null;
    if (row.cohort === "discovery_missed" && row.move_alignment?.outcome === "aligned") {
      bucketKey = "missed_aligned";
      if (Number(row.move_atr) >= tierMin) bucketKey = "tier_a_missed";
    } else if (row.cohort === "backtest" && row.outcome === "win") bucketKey = "backtest_win";
    else if (row.cohort === "backtest" && row.outcome === "loss") bucketKey = "backtest_loss";

    if (bucketKey) touchRunwayStat(buckets[bucketKey], timing);

    if (timing.ordering) orderingCounts[timing.ordering] = (orderingCounts[timing.ordering] || 0) + 1;
    if (Number.isFinite(timing.hours_td9_to_div)) hoursTd9ToDiv.push(timing.hours_td9_to_div);
    if (Number.isFinite(timing.hours_div_to_momentum)) hoursDivToMomentum.push(timing.hours_div_to_momentum);
    if (Number.isFinite(timing.hours_div_to_anchor)) hoursDivToAnchor.push(timing.hours_div_to_anchor);

    if (row.cohort === "discovery_missed" && Number(row.move_atr) >= tierMin) {
      const atr = Number(row.move_atr);
      if (Number.isFinite(atr)) {
        if (timing.runway_complete) moveAtrWithRunway.push(atr);
        else if (timing.has_divergence) moveAtrDivOnly.push(atr);
      }
    }
  }

  return {
    tier_a_min_atr: tierMin,
    pre_entry_hours: opts.preEntryMs ? Math.round(opts.preEntryMs / (60 * 60 * 1000)) : opts.pre_entry_hours ?? null,
    cohorts: {
      tier_a_missed: runwayRates(buckets.tier_a_missed),
      missed_aligned: runwayRates(buckets.missed_aligned),
      backtest_win: runwayRates(buckets.backtest_win),
      backtest_loss: runwayRates(buckets.backtest_loss),
    },
    ordering_counts: orderingCounts,
    timing_medians: {
      hours_td9_to_div: avg(hoursTd9ToDiv),
      hours_div_to_momentum: avg(hoursDivToMomentum),
      hours_div_to_anchor: avg(hoursDivToAnchor),
      median_hours_td9_to_div: median(hoursTd9ToDiv),
      median_hours_div_to_momentum: median(hoursDivToMomentum),
      median_hours_div_to_anchor: median(hoursDivToAnchor),
    },
    tier_a_move_atr: {
      avg_when_runway_complete: avg(moveAtrWithRunway),
      avg_when_div_only: avg(moveAtrDivOnly),
      n_runway_complete: moveAtrWithRunway.length,
      n_div_only: moveAtrDivOnly.length,
    },
    sample_timings: timings.slice(0, 25),
    n_with_events: timings.length,
  };
}

function median(nums) {
  const vals = nums.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!vals.length) return null;
  const mid = Math.floor(vals.length / 2);
  return vals.length % 2 ? vals[mid] : Math.round(((vals[mid - 1] + vals[mid]) / 2) * 10) / 10;
}

export function formatDivergenceRunwayMarkdown(report = {}) {
  const c = report.cohorts || {};
  const lines = [
    "# Divergence runway analysis",
    "",
    "Tests the MR hypothesis: **exhaustion (TD9/phase) → RSI divergence → momentum** before the move anchor.",
    "RSI divergence is MR ladder **stage 4** (`phase_left_zone`) — the runway between exhaustion and breakthrough.",
    "",
    `Tier A threshold: move_atr >= ${report.tier_a_min_atr ?? 8}`,
    `Lookback: ${report.pre_entry_hours ?? "—"}h`,
    `Rows with event timelines: ${report.n_with_events ?? 0}`,
    "",
    "## Cohort runway rates",
    "",
    "| Cohort | N | Has div | TD9→div | Exhaust→div | Div→momentum | Full runway |",
    "|---|---:|---:|---:|---:|---:|---:|",
  ];

  for (const [key, label] of [
    ["tier_a_missed", "Tier A missed"],
    ["missed_aligned", "Missed aligned"],
    ["backtest_win", "Backtest WIN"],
    ["backtest_loss", "Backtest LOSS"],
  ]) {
    const b = c[key] || {};
    lines.push(`| ${label} | ${b.n ?? 0} | ${b.with_div_rate ?? "—"} | ${b.td9_before_div_rate ?? "—"} | ${b.exhaust_before_div_rate ?? "—"} | ${b.div_before_momentum_rate ?? "—"} | ${b.runway_complete_rate ?? "—"} |`);
  }

  const tm = report.timing_medians || {};
  lines.push(
    "",
    "## Timing (hours, Tier A+ missed with events)",
    "",
    `- Median TD9 → divergence: **${tm.median_hours_td9_to_div ?? "—"}h** (mean ${tm.hours_td9_to_div ?? "—"}h)`,
    `- Median divergence → momentum: **${tm.median_hours_div_to_momentum ?? "—"}h** (mean ${tm.hours_div_to_momentum ?? "—"}h)`,
    `- Median divergence → move anchor: **${tm.median_hours_div_to_anchor ?? "—"}h** (mean ${tm.hours_div_to_anchor ?? "—"}h)`,
    "",
    "## Event ordering",
    "",
  );

  for (const [ord, n] of Object.entries(report.ordering_counts || {}).sort((a, b) => b[1] - a[1])) {
    lines.push(`- \`${ord}\`: ${n}`);
  }

  const ma = report.tier_a_move_atr || {};
  lines.push(
    "",
    "## Tier A move size vs runway completeness",
    "",
    `- Full runway (exhaust→div→momentum): n=${ma.n_runway_complete ?? 0}, avg move_atr **${ma.avg_when_runway_complete ?? "—"}**`,
    `- Divergence only (partial): n=${ma.n_div_only ?? 0}, avg move_atr **${ma.avg_when_div_only ?? "—"}**`,
    "",
    "## Interpretation",
    "",
    "- **TD9→div** rate among div cases = exhaustion building runway before divergence fires.",
    "- **Div→momentum** rate = divergence precedes the confirmation stack (ST/squeeze/EMA21).",
    "- Backtest parity requires `setup_events` (trail_5m lacks divergence); zero backtest div rates in lift pass indicate enrichment gap, not absence of edge.",
    "",
  );

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
