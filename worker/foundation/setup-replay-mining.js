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
  const direction = String(move.direction || (Number(move.move_pct) >= 0 ? "LONG" : "SHORT")).toUpperCase();
  const anchorTs = discoveryMoveAnchorTs(move) ?? Number(move.start_ts ?? move.startTs ?? move.entry_ts);
  const snapshots = snapshotsFromTrailRows(trailRows, ticker);
  const diag = diagnosticsForEntryWindow(snapshots, anchorTs, opts);
  const seq = sequenceForDirection(diag.sequences || [], direction === "SHORT" ? "SHORT" : "LONG");
  const moveAlignment = classifyMoveAlignment(move, seq);

  return {
    cohort: "discovery_missed",
    move_id: move.move_id || `${ticker}:${anchorTs}`,
    ticker,
    direction: direction === "SHORT" ? "SHORT" : "LONG",
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

export function classifyMoveAlignment(move = {}, sequence = null) {
  const movePct = Number(move.move_pct ?? move.movePct);
  const moveDir = String(move.direction || (movePct >= 0 ? "LONG" : "SHORT")).toUpperCase();
  if (!Number.isFinite(movePct)) {
    return { outcome: "unknown", move_dir: moveDir, move_pct: null, move_atr: Number(move.move_atr) || null };
  }
  if (!sequence?.direction) {
    return { outcome: "none", move_dir: moveDir, move_pct: movePct, move_atr: Number(move.move_atr) || null };
  }
  const aligned = String(sequence.direction).toUpperCase() === moveDir;
  return {
    outcome: aligned ? "aligned" : "opposed",
    move_dir: moveDir,
    move_pct: movePct,
    move_atr: Number(move.move_atr) || null,
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

export function buildReliabilityReport(joinedRows = [], meta = {}) {
  const alignment = aggregateMoveAlignment(joinedRows);
  return {
    generated_at: new Date().toISOString(),
    shadow: true,
    meta,
    alignment,
    reliability: aggregateSequenceReliability(joinedRows),
    trades: joinedRows,
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
