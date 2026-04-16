function finiteOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeRunMetrics(run) {
  if (!run) return null;
  return {
    total_trades: finiteOrNull(run.total_trades),
    wins: finiteOrNull(run.wins),
    losses: finiteOrNull(run.losses),
    win_rate: finiteOrNull(run.win_rate),
    realized_pnl: finiteOrNull(run.realized_pnl),
    realized_pnl_pct: finiteOrNull(run.realized_pnl_pct),
    avg_win_pct: finiteOrNull(run.avg_win_pct),
    avg_loss_pct: finiteOrNull(run.avg_loss_pct),
  };
}

export function buildRunOperatorSummary(run, options = {}) {
  if (!run || typeof run !== "object") return null;
  const metrics = normalizeRunMetrics(run);
  const activeRunId = options.activeRunId || run.active_run_id || run.run_id || null;
  const activeSource = options.activeSource || run.active_source || null;
  const isCleanLane = options.isCleanLane === true || run.is_clean_lane === true;
  const replay = options.replay || run.replay || null;
  return {
    run_id: run.run_id || null,
    active_run_id: activeRunId,
    label: run.label || null,
    description: run.description || null,
    status: run.status || null,
    status_note: run.status_note || null,
    start_date: run.start_date || null,
    end_date: run.end_date || null,
    created_at: finiteOrNull(run.created_at),
    started_at: finiteOrNull(run.started_at),
    ended_at: finiteOrNull(run.ended_at),
    updated_at: finiteOrNull(run.updated_at),
    active_source: activeSource,
    is_clean_lane: isCleanLane,
    trades: {
      total: metrics?.total_trades,
      wins: metrics?.wins,
      losses: metrics?.losses,
      win_rate: metrics?.win_rate,
    },
    pnl: {
      realized: metrics?.realized_pnl,
      realized_pct: metrics?.realized_pnl_pct,
      avg_win_pct: metrics?.avg_win_pct,
      avg_loss_pct: metrics?.avg_loss_pct,
    },
    manifest: run.manifest || null,
    replay: replay ? {
      locked: replay.locked === true,
      lock: replay.lock || null,
      running: replay.running || null,
    } : null,
  };
}

export function buildActiveRunReadModel(activeState = {}) {
  const run = buildRunOperatorSummary(activeState.active || activeState.live || null, {
    activeRunId: activeState.active_run_id || null,
    activeSource: activeState.active_source || null,
    isCleanLane: activeState.is_clean_lane === true,
    replay: activeState.replay || null,
  });
  return {
    active_run_id: activeState.active_run_id || run?.active_run_id || null,
    active_source: activeState.active_source || run?.active_source || null,
    is_clean_lane: activeState.is_clean_lane === true,
    replay: activeState.replay || null,
    run,
    active: run,
  };
}

export function buildRunDetailReadModel(run, options = {}) {
  const summary = buildRunOperatorSummary(run, {
    activeRunId: run?.run_id || null,
    activeSource: options.activeSource || null,
    isCleanLane: options.isCleanLane === true,
  });
  return {
    run: summary,
    metrics: normalizeRunMetrics(run),
    manifest: run?.manifest || null,
    params: run?.params || null,
    tags: Array.isArray(run?.tags) ? run.tags : [],
    is_clean_lane: options.isCleanLane === true,
  };
}

export function buildTradeAutopsyReadModel({
  source,
  archiveRun,
  liveRun,
  tradeCount,
  isLive,
  isCleanLane,
  replay,
}) {
  const activeRunSummary = buildRunOperatorSummary(liveRun, {
    activeRunId: liveRun?.active_run_id || liveRun?.run_id || null,
    activeSource: liveRun?.active_source || null,
    isCleanLane: isCleanLane === true,
    replay,
  });
  const archiveRunSummary = buildRunOperatorSummary(archiveRun, {
    activeRunId: archiveRun?.run_id || null,
    activeSource: "archive",
    isCleanLane: archiveRun?.is_clean_lane === true,
  });
  return {
    surface: "trade_autopsy",
    mode: isLive ? "live" : "archive",
    trade_count: finiteOrNull(tradeCount) || 0,
    source_meta: {
      source: source || "",
      archive_run_id: archiveRunSummary?.run_id || null,
      live_run_id: activeRunSummary?.active_run_id || activeRunSummary?.run_id || null,
      active_source: activeRunSummary?.active_source || null,
      is_clean_lane: isCleanLane === true,
    },
    live_run: activeRunSummary,
    archive_run: archiveRunSummary,
    replay: replay || null,
  };
}
