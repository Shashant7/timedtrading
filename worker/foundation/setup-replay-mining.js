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

export function joinMissedMoveWithTrailDiagnostics(move = {}, trailRows = [], opts = {}) {
  const ticker = String(move.ticker || "").toUpperCase();
  const moveDir = normalizeMoveDirection(move.direction, move.move_pct ?? move.movePct) || "LONG";
  const anchorTs = discoveryMoveAnchorTs(move) ?? Number(move.start_ts ?? move.startTs ?? move.entry_ts);
  const snapshots = snapshotsFromTrailRows(trailRows, ticker);
  const diag = diagnosticsForEntryWindow(snapshots, anchorTs, opts);
  const seq = sequenceForDirection(diag.sequences || [], moveDir);
  const moveAlignment = classifyMoveAlignment(move, seq);

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
    sequence: seq ? {
      sequence_type: seq.sequence_type,
      direction: seq.direction,
      stage: seq.stage,
      stage_bucket: stageBucket(seq.stage),
      status: seq.status,
      confidence: seq.confidence,
    } : null,
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

export function classifyMoveAlignment(move = {}, sequence = null) {
  const movePct = Number(move.move_pct ?? move.movePct);
  // Realized move_pct sign is ground truth for discovery missed moves (stored direction is often stale).
  let moveDir = null;
  if (Number.isFinite(movePct) && movePct !== 0) {
    moveDir = movePct >= 0 ? "LONG" : "SHORT";
  } else {
    moveDir = normalizeMoveDirection(
      move.direction ?? move.move_dir ?? move.move_alignment?.move_dir,
      movePct,
    );
  }
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
