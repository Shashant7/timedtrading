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

function addToBucket(bucket, row) {
  bucket.n += 1;
  if (row.outcome === "win") bucket.wins += 1;
  else if (row.outcome === "loss") bucket.losses += 1;
  else if (row.outcome === "flat") bucket.flat += 1;
  else bucket.unknown += 1;
  if (Number.isFinite(Number(row.pnl_pct))) {
    bucket.pnl_sum += Number(row.pnl_pct);
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
  return {
    generated_at: new Date().toISOString(),
    shadow: true,
    meta,
    reliability: aggregateSequenceReliability(joinedRows),
    trades: joinedRows,
  };
}

export function formatReliabilityMarkdown(report = {}) {
  const rel = report.reliability || {};
  const lines = [
    "# Setup Sequence Reliability (shadow mining)",
    "",
    `Generated: ${report.generated_at || "unknown"}`,
    "",
    "## Summary",
    "",
    `- Total trades analyzed: ${rel.total_trades ?? 0}`,
    `- Trades with diagnostics window: ${rel.with_diagnostics ?? 0}`,
    `- Trades with active sequence at entry: ${rel.with_sequence ?? 0}`,
    "",
    "## By sequence (type:direction:stage_bucket)",
    "",
    "| Key | N | Win rate | Avg PnL % | Wins | Losses |",
    "|---|---:|---:|---:|---:|---:|",
  ];

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
