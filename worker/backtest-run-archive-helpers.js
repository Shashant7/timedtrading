function parseBool01(v) {
  if (typeof v === "boolean") return v ? 1 : 0;
  const s = String(v ?? "").trim().toLowerCase();
  return (s === "1" || s === "true" || s === "yes" || s === "y" || s === "on") ? 1 : 0;
}

function parseJSONSafe(raw, fallback = null) {
  if (raw == null || raw === "") return fallback;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function firstNonEmptyString(...vals) {
  for (const v of vals) {
    if (v == null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return null;
}

function buildRunManifest(sources = {}) {
  const row = sources?.row && typeof sources.row === "object" ? sources.row : {};
  const body = sources?.body && typeof sources.body === "object" ? sources.body : {};
  const params = (body?.params && typeof body.params === "object" && !Array.isArray(body.params))
    ? body.params
    : parseJSONSafe(row?.params_json, {});
  const tags = Array.isArray(body?.tags)
    ? body.tags
    : (Array.isArray(parseJSONSafe(row?.tags_json, null)) ? parseJSONSafe(row?.tags_json, null) : []);
  const configOverride = body?.config_override && typeof body.config_override === "object" && !Array.isArray(body.config_override)
    ? body.config_override
    : null;
  const envOverrides = params?.env_overrides && typeof params.env_overrides === "object" && !Array.isArray(params.env_overrides)
    ? params.env_overrides
    : {};

  const entryEngine = firstNonEmptyString(
    body?.entry_engine,
    envOverrides?.ENTRY_ENGINE,
    params?.entry_engine,
    "tt_core",
  );
  const managementEngine = firstNonEmptyString(
    body?.management_engine,
    envOverrides?.MANAGEMENT_ENGINE,
    params?.management_engine,
    "tt_core",
  );
  const leadingLtf = firstNonEmptyString(
    body?.leading_ltf,
    envOverrides?.LEADING_LTF,
    params?.leading_ltf,
    "10",
  );
  const rehydrationPolicy = firstNonEmptyString(
    body?.rehydration_policy,
    params?.rehydration_policy,
    parseBool01(body?.resume ?? params?.resume) === 1 ? "checkpoint_resume" : "fresh_reset",
  );
  const replayCleanLane = body?.replay_clean_lane != null
    ? parseBool01(body.replay_clean_lane) === 1
    : params?.replay_clean_lane != null
      ? parseBool01(params.replay_clean_lane) === 1
      : (rehydrationPolicy === "fresh_reset" || rehydrationPolicy === "clean_lane");
  const configKeyCount = configOverride
    ? Object.keys(configOverride).length
    : Math.max(0, Number(params?.config_key_count) || 0);
  const configSource = configOverride || params?.config_file || params?.config_source_run_id || configKeyCount > 0
    ? "explicit_override"
    : "registered_snapshot";

  return {
    runId: firstNonEmptyString(body?.run_id, row?.run_id),
    label: firstNonEmptyString(body?.label, row?.label),
    description: firstNonEmptyString(body?.description, row?.description),
    codeRevision: firstNonEmptyString(body?.code_revision, params?.code_revision),
    engineSelection: {
      entryEngine,
      managementEngine,
      leadingLtf,
    },
    dataset: {
      startDate: firstNonEmptyString(body?.start_date, row?.start_date),
      endDate: firstNonEmptyString(body?.end_date, row?.end_date),
      intervalMin: Number(body?.interval_min ?? row?.interval_min) || 15,
      tickerBatch: Number(body?.ticker_batch ?? row?.ticker_batch) || 15,
      tickerUniverseCount: Number(body?.ticker_universe_count ?? row?.ticker_universe_count) || 0,
      traderOnly: parseBool01(body?.trader_only ?? row?.trader_only) === 1,
      keepOpenAtEnd: parseBool01(body?.keep_open_at_end ?? row?.keep_open_at_end) === 1,
      lowWrite: parseBool01(body?.low_write ?? row?.low_write) === 1,
    },
    replayMode: {
      isReplay: true,
      cleanLane: replayCleanLane,
      rehydrationPolicy,
    },
    config: {
      source: configSource,
      snapshotKeys: configOverride ? Object.keys(configOverride) : null,
      keyCount: configKeyCount || null,
      configFile: firstNonEmptyString(params?.config_file),
      configSourceRunId: firstNonEmptyString(params?.config_source_run_id),
      datasetManifest: firstNonEmptyString(params?.dataset_manifest),
    },
    tags: Array.isArray(tags) ? tags : [],
    params: params && typeof params === "object" && !Array.isArray(params) ? params : null,
    createdAt: Number(body?.created_at ?? row?.created_at) || Date.now(),
  };
}

function parseRunRecord(row) {
  if (!row || typeof row !== "object") return null;
  const out = { ...row };
  out.tags = Array.isArray(parseJSONSafe(row.tags_json, null)) ? parseJSONSafe(row.tags_json, null) : null;
  out.params = parseJSONSafe(row.params_json, null);
  out.metrics = parseJSONSafe(row.metrics_json, null);
  const manifest = parseJSONSafe(row.manifest_json, null);
  out.manifest = manifest && typeof manifest === "object" ? manifest : buildRunManifest({ row });
  return out;
}

function isRunManifestCleanLane(manifest) {
  if (!manifest || typeof manifest !== "object") return false;
  if (manifest?.replayMode?.cleanLane === true) return true;
  const policy = String(manifest?.replayMode?.rehydrationPolicy || "").trim().toLowerCase();
  return policy === "fresh_reset" || policy === "clean_lane";
}

function buildTradeAutopsyRunUrl(runId) {
  const safe = encodeURIComponent(String(runId || "").trim());
  return safe ? `trade-autopsy.html?run_id=${safe}` : "trade-autopsy.html";
}

export async function summarizeRunMetrics(db, runId) {
  const rid = String(runId || "").trim();
  if (!rid) return null;
  let tradeTable = "trades";
  try {
    const archivedRow = await db.prepare(`SELECT COUNT(*) AS cnt FROM backtest_run_trades WHERE run_id = ?1`).bind(rid).first();
    if (Number(archivedRow?.cnt || 0) > 0) tradeTable = "backtest_run_trades";
  } catch {}
  const totals = await db.prepare(
    `SELECT
      COUNT(*) AS total_trades,
      COUNT(DISTINCT ticker) AS total_tickers_traded,
      SUM(CASE WHEN status='WIN' THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN status='LOSS' THEN 1 ELSE 0 END) AS losses,
      SUM(CASE WHEN status='FLAT' THEN 1 ELSE 0 END) AS breakevens,
      SUM(CASE WHEN status='OPEN' OR status='TP_HIT_TRIM' THEN 1 ELSE 0 END) AS open_trades,
      SUM(CASE WHEN status IN ('WIN','LOSS','FLAT') THEN 1 ELSE 0 END) AS closed_trades,
      SUM(CASE WHEN status IN ('WIN','LOSS','FLAT') THEN COALESCE(pnl,0) ELSE 0 END) AS realized_pnl,
      AVG(CASE WHEN status='WIN' THEN COALESCE(pnl_pct,0) ELSE NULL END) AS avg_win_pct,
      AVG(CASE WHEN status='LOSS' THEN COALESCE(pnl_pct,0) ELSE NULL END) AS avg_loss_pct
     FROM ${tradeTable} WHERE run_id = ?1`
  ).bind(rid).first();

  const classifications = {};
  try {
    const classRows = await db.prepare(
      `SELECT COALESCE(NULLIF(a.classification,''), 'unclassified') AS classification, COUNT(*) AS count
       FROM ${tradeTable} t LEFT JOIN trade_autopsy_annotations a ON a.trade_id = t.trade_id
       WHERE t.run_id = ?1 GROUP BY classification ORDER BY count DESC`
    ).bind(rid).all();
    for (const row of (classRows?.results || [])) classifications[String(row.classification || "unclassified")] = Number(row.count || 0);
  } catch {}

  const byStatus = {};
  try {
    const statusRows = await db.prepare(
      `SELECT COALESCE(status,'UNKNOWN') AS status, COUNT(*) AS count FROM ${tradeTable} WHERE run_id = ?1 GROUP BY status ORDER BY count DESC`
    ).bind(rid).all();
    for (const row of (statusRows?.results || [])) byStatus[String(row.status || "UNKNOWN")] = Number(row.count || 0);
  } catch {}

  const wins = Number(totals?.wins || 0);
  const losses = Number(totals?.losses || 0);
  const closedTrades = Number(totals?.closed_trades || 0);
  const winRate = closedTrades > 0 ? (wins / closedTrades) * 100 : 0;
  return {
    run_id: rid,
    total_tickers_traded: Number(totals?.total_tickers_traded || 0),
    total_trades: Number(totals?.total_trades || 0),
    wins,
    losses,
    breakevens: Number(totals?.breakevens || 0),
    open_trades: Number(totals?.open_trades || 0),
    closed_trades: closedTrades,
    win_rate: winRate,
    realized_pnl: Number(totals?.realized_pnl || 0),
    realized_pnl_pct: 0,
    avg_win_pct: Number(totals?.avg_win_pct || 0),
    avg_loss_pct: Number(totals?.avg_loss_pct || 0),
    classifications_json: JSON.stringify(classifications),
    by_status_json: JSON.stringify(byStatus),
    autopsy_url: buildTradeAutopsyRunUrl(rid),
  };
}

export const SENTINEL_BASKET_V1 = ["RIOT", "GRNY", "FIX", "SOFI", "CSCO", "SWK"];

export async function resolveSentinelReferenceRunId(db, candidateRunId) {
  const candidate = String(candidateRunId || "").trim();
  if (!db || !candidate) return null;
  try {
    const live = await db.prepare(
      `SELECT run_id
         FROM backtest_runs
        WHERE live_config_slot = 1
          AND run_id != ?1
        ORDER BY updated_at DESC
        LIMIT 1`
    ).bind(candidate).first();
    if (live?.run_id) return String(live.run_id);
  } catch {}
  try {
    const protectedRow = await db.prepare(
      `SELECT run_id
         FROM backtest_runs
        WHERE is_protected_baseline = 1
          AND run_id != ?1
        ORDER BY COALESCE(ended_at, updated_at, created_at) DESC
        LIMIT 1`
    ).bind(candidate).first();
    if (protectedRow?.run_id) return String(protectedRow.run_id);
  } catch {}
  try {
    const latestCompleted = await db.prepare(
      `SELECT run_id
         FROM backtest_runs
        WHERE status = 'completed'
          AND run_id != ?1
        ORDER BY COALESCE(ended_at, updated_at, created_at) DESC
        LIMIT 1`
    ).bind(candidate).first();
    if (latestCompleted?.run_id) return String(latestCompleted.run_id);
  } catch {}
  return null;
}

export async function loadRunTradesForValidation(db, runId) {
  const rid = String(runId || "").trim();
  if (!db || !rid) return [];
  let rows = [];
  try {
    rows = (await db.prepare(
      `SELECT * FROM backtest_run_trades WHERE run_id = ?1 ORDER BY entry_ts ASC`
    ).bind(rid).all())?.results || [];
  } catch {}
  if (rows.length === 0) {
    try {
      rows = (await db.prepare(
        `SELECT * FROM trades WHERE run_id = ?1 ORDER BY entry_ts ASC`
      ).bind(rid).all())?.results || [];
    } catch {}
  }
  return rows.map((r) => ({
    trade_id: r.trade_id || null,
    ticker: String(r.ticker || "").toUpperCase(),
    direction: String(r.direction || "").toUpperCase(),
    entry_ts: Number(r.entry_ts || 0) || 0,
    exit_ts: Number(r.exit_ts || 0) || 0,
    entry_price: Number(r.entry_price || 0) || 0,
    exit_price: Number(r.exit_price || 0) || 0,
    status: String(r.status || "").toUpperCase(),
    exit_reason: r.exit_reason || null,
    pnl: Number(r.pnl || 0) || 0,
    pnl_pct: Number(r.pnl_pct || 0) || 0,
    trimmed_pct: Number(r.trimmed_pct || 0) || 0,
  }));
}

function buildSentinelTradeSummary(trades) {
  const wins = trades.filter((t) => t.status === "WIN").length;
  const losses = trades.filter((t) => t.status === "LOSS").length;
  const open = trades.filter((t) => t.status === "OPEN" || t.status === "TP_HIT_TRIM").length;
  return {
    trade_count: trades.length,
    wins,
    losses,
    open,
    total_pnl: Math.round(trades.reduce((sum, t) => sum + (Number(t.pnl) || 0), 0) * 100) / 100,
    exit_reasons: [...new Set(trades.map((t) => String(t.exit_reason || "").trim()).filter(Boolean))],
  };
}

export function buildSentinelValidationArtifact(candidateRunId, referenceRunId, candidateTrades, referenceTrades, basket = SENTINEL_BASKET_V1) {
  const tickers = [...new Set((Array.isArray(basket) ? basket : []).map((t) => String(t || "").trim().toUpperCase()).filter(Boolean))];
  const sentinels = [];
  let totalMatchedPairs = 0;
  let totalMissingInCandidate = 0;
  let totalExtraInCandidate = 0;
  let totalPnlDelta = 0;

  for (const ticker of tickers) {
    const candidateTickerTrades = candidateTrades.filter((t) => t.ticker === ticker).sort((a, b) => a.entry_ts - b.entry_ts);
    const referenceTickerTrades = referenceTrades.filter((t) => t.ticker === ticker).sort((a, b) => a.entry_ts - b.entry_ts);
    const matchedCount = Math.min(candidateTickerTrades.length, referenceTickerTrades.length);
    const comparisons = [];
    for (let i = 0; i < matchedCount; i++) {
      const c = candidateTickerTrades[i];
      const r = referenceTickerTrades[i];
      const entryDeltaMin = c.entry_ts > 0 && r.entry_ts > 0 ? Math.round((c.entry_ts - r.entry_ts) / 60000) : null;
      const exitDeltaMin = c.exit_ts > 0 && r.exit_ts > 0 ? Math.round((c.exit_ts - r.exit_ts) / 60000) : null;
      const pnlDelta = Math.round((((Number(c.pnl) || 0) - ((Number(r.pnl) || 0))) * 100)) / 100;
      comparisons.push({
        index: i + 1,
        candidate_trade_id: c.trade_id,
        reference_trade_id: r.trade_id,
        candidate_status: c.status,
        reference_status: r.status,
        entry_delta_min: entryDeltaMin,
        exit_delta_min: exitDeltaMin,
        pnl_delta: pnlDelta,
        candidate_exit_reason: c.exit_reason || null,
        reference_exit_reason: r.exit_reason || null,
        exit_reason_changed: String(c.exit_reason || "") !== String(r.exit_reason || ""),
      });
    }
    const candidateSummary = buildSentinelTradeSummary(candidateTickerTrades);
    const referenceSummary = buildSentinelTradeSummary(referenceTickerTrades);
    const tradeCountDelta = candidateSummary.trade_count - referenceSummary.trade_count;
    const pnlDelta = Math.round((candidateSummary.total_pnl - referenceSummary.total_pnl) * 100) / 100;
    totalMatchedPairs += matchedCount;
    totalMissingInCandidate += Math.max(0, referenceTickerTrades.length - candidateTickerTrades.length);
    totalExtraInCandidate += Math.max(0, candidateTickerTrades.length - referenceTickerTrades.length);
    totalPnlDelta += pnlDelta;
    sentinels.push({
      ticker,
      candidate: candidateSummary,
      reference: referenceSummary,
      diff: {
        trade_count_delta: tradeCountDelta,
        total_pnl_delta: pnlDelta,
        missing_in_candidate: Math.max(0, referenceTickerTrades.length - candidateTickerTrades.length),
        extra_in_candidate: Math.max(0, candidateTickerTrades.length - referenceTickerTrades.length),
        matched_pairs: matchedCount,
        comparisons,
      },
    });
  }

  return {
    artifact_type: "sentinel_basket_v1",
    run_id: candidateRunId,
    reference_run_id: referenceRunId,
    basket: tickers,
    compared_at: Date.now(),
    summary: {
      matched_pairs: totalMatchedPairs,
      missing_in_candidate: totalMissingInCandidate,
      extra_in_candidate: totalExtraInCandidate,
      total_pnl_delta: Math.round(totalPnlDelta * 100) / 100,
      candidate_trade_count: candidateTrades.filter((t) => tickers.includes(t.ticker)).length,
      reference_trade_count: referenceTrades.filter((t) => tickers.includes(t.ticker)).length,
    },
    sentinels,
    gate: {
      ok: true,
      status: "ok",
      reason: "artifact_generated",
    },
  };
}

function buildMetricsPayload(summary) {
  return {
    run_id: summary.run_id,
    tickers: { traded: summary.total_tickers_traded },
    trades: {
      total: summary.total_trades,
      wins: summary.wins,
      losses: summary.losses,
      breakevens: summary.breakevens,
      open: summary.open_trades,
      closed: summary.closed_trades,
      win_rate: summary.win_rate,
    },
    pnl: {
      realized_pnl: summary.realized_pnl,
      realized_pnl_pct: summary.realized_pnl_pct,
      avg_win_pct: summary.avg_win_pct,
      avg_loss_pct: summary.avg_loss_pct,
    },
    classifications: (() => { try { return JSON.parse(summary.classifications_json || "{}"); } catch { return {}; } })(),
    by_status: (() => { try { return JSON.parse(summary.by_status_json || "{}"); } catch { return {}; } })(),
    autopsy_url: summary.autopsy_url,
  };
}

export async function finalizeBacktestRun(db, body = {}) {
  const runId = String(body?.run_id || "").trim();
  if (!runId) return { ok: false, error: "run_id_required", httpStatus: 400 };
  const now = Date.now();
  const status = String(body?.status || "completed").trim().toLowerCase();
  const preserveRegisteredConfig = parseBool01(body?.preserve_registered_config) === 1;
  const existingRun = await db.prepare(`SELECT * FROM backtest_runs WHERE run_id = ?1`).bind(runId).first();
  const manifest = parseRunRecord(existingRun)?.manifest || buildRunManifest({ row: existingRun || { run_id: runId }, body });
  const cleanReplayLane = isRunManifestCleanLane(manifest);
  if (!existingRun?.manifest_json) {
    try {
      await db.prepare(`UPDATE backtest_runs SET manifest_json = ?2 WHERE run_id = ?1`).bind(runId, JSON.stringify(manifest)).run();
    } catch {}
  }

  if (!cleanReplayLane) {
    try {
      await db.prepare(`UPDATE trades SET run_id = ?1 WHERE run_id IS NULL`).bind(runId).run();
    } catch {}
  } else {
    try {
      const archivedIds = (await db.prepare(
        `SELECT trade_id FROM backtest_run_trades WHERE run_id = ?1`
      ).bind(runId).all())?.results || [];
      const tradeIds = archivedIds.map((row) => String(row?.trade_id || "").trim()).filter(Boolean);
      const CHUNK = 90;
      for (let i = 0; i < tradeIds.length; i += CHUNK) {
        const chunk = tradeIds.slice(i, i + CHUNK);
        const placeholders = chunk.map((_, idx) => `?${idx + 2}`).join(",");
        await db.prepare(
          `UPDATE trades
              SET run_id = COALESCE(run_id, ?1)
            WHERE trade_id IN (${placeholders})`
        ).bind(runId, ...chunk).run();
      }
    } catch {}
  }

  const summary = await summarizeRunMetrics(db, runId);
  if (!summary) return { ok: false, error: "summary_failed", httpStatus: 500 };
  const metricsPayload = buildMetricsPayload(summary);

  await db.prepare(`UPDATE backtest_runs SET status = ?2, status_note = ?3, metrics_json = ?4, ended_at = COALESCE(ended_at, ?5), updated_at = ?5, label = COALESCE(?6, label), description = COALESCE(?7, description) WHERE run_id = ?1`).bind(
    runId, status, body?.status_note || "Finalized",
    JSON.stringify(metricsPayload), now, body?.label || null, body?.description || null,
  ).run();
  try {
    await db.prepare(`INSERT OR REPLACE INTO backtest_run_metrics (run_id, total_tickers_traded, total_trades, wins, losses, breakevens, open_trades, closed_trades, win_rate, realized_pnl, realized_pnl_pct, avg_win_pct, avg_loss_pct, classifications_json, by_status_json, autopsy_url, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)`).bind(
      summary.run_id, summary.total_tickers_traded, summary.total_trades, summary.wins, summary.losses, summary.breakevens, summary.open_trades, summary.closed_trades, summary.win_rate, summary.realized_pnl, summary.realized_pnl_pct, summary.avg_win_pct, summary.avg_loss_pct, summary.classifications_json, summary.by_status_json, summary.autopsy_url, now,
    ).run();
  } catch {}

  let archived = { trades: 0, da: 0, annotations: 0, config: 0 };
  try {
    // V13 data-capture fix (2026-04-24): archive SELECT was dropping
    // rank_trace_json, entry_path, MFE/MAE, and setup fields. V11/V12/V13
    // runs showed NULL rank_trace_json in backtest_run_trades even when
    // the live `trades` table had the data. Include every column the
    // target table has so nothing gets silently dropped.
    // V15 P0.7.46 (2026-05-01) — also include entry_signals_json + sector
    // so the finalize-archive copy doesn't drop the new flat columns
    // (the per-batch d1ArchiveRunTrade also writes them; this is the
    // backstop for runs where finalize is the only archive event).
    const archRes = await db.prepare(
      `INSERT OR REPLACE INTO backtest_run_trades
        (run_id, trade_id, ticker, direction, entry_ts, entry_price, rank, rr, status,
         exit_ts, exit_price, exit_reason, trimmed_pct, pnl, pnl_pct, script_version,
         created_at, updated_at, trim_ts, trim_price,
         setup_name, setup_grade, risk_budget, shares, notional,
         entry_path, max_favorable_excursion, max_adverse_excursion, rank_trace_json,
         entry_signals_json, sector)
       SELECT COALESCE(run_id, ?1), trade_id, ticker, direction, entry_ts, entry_price, rank, rr, status,
              exit_ts, exit_price, exit_reason, trimmed_pct, pnl, pnl_pct, script_version,
              created_at, updated_at, trim_ts, trim_price,
              setup_name, setup_grade, risk_budget, shares, notional,
              entry_path, max_favorable_excursion, max_adverse_excursion, rank_trace_json,
              entry_signals_json, sector
       FROM trades
       WHERE run_id = ?1 ${cleanReplayLane ? "" : "OR run_id IS NULL"}`
    ).bind(runId).run();
    archived.trades = archRes?.meta?.changes ?? 0;
  } catch (error) { console.error("[ARCHIVE] trades:", String(error).slice(0, 200)); }
  try {
    const daRes = await db.prepare(
      `INSERT OR IGNORE INTO backtest_run_direction_accuracy (run_id, trade_id, ticker, ts, signal_snapshot_json, exit_snapshot_json, regime_daily, regime_weekly, regime_combined, entry_path, consensus_direction, execution_profile_name, execution_profile_confidence, market_state, execution_profile_json, tf_stack_json, max_favorable_excursion, max_adverse_excursion, rvol_best, entry_quality_score, exit_reason) SELECT ?1, da.trade_id, da.ticker, da.ts, da.signal_snapshot_json, da.exit_snapshot_json, da.regime_daily, da.regime_weekly, da.regime_combined, da.entry_path, da.consensus_direction, da.execution_profile_name, da.execution_profile_confidence, da.market_state, da.execution_profile_json, da.tf_stack_json, da.max_favorable_excursion, da.max_adverse_excursion, da.rvol_best, da.entry_quality_score, da.exit_reason FROM direction_accuracy da INNER JOIN trades t ON da.trade_id = t.trade_id WHERE t.run_id = ?1 ${cleanReplayLane ? "" : "OR t.run_id IS NULL"}`
    ).bind(runId).run();
    archived.da = daRes?.meta?.changes ?? 0;
  } catch (error) { console.error("[ARCHIVE] da:", String(error).slice(0, 200)); }
  try {
    const annRes = await db.prepare(
      `INSERT OR IGNORE INTO backtest_run_annotations (run_id, trade_id, classification, notes, updated_at) SELECT ?1, a.trade_id, a.classification, a.notes, a.updated_at FROM trade_autopsy_annotations a INNER JOIN trades t ON a.trade_id = t.trade_id WHERE t.run_id = ?1 ${cleanReplayLane ? "" : "OR t.run_id IS NULL"}`
    ).bind(runId).run();
    archived.annotations = annRes?.meta?.changes ?? 0;
  } catch (error) { console.error("[ARCHIVE] annotations:", String(error).slice(0, 200)); }
  try {
    if (!preserveRegisteredConfig) {
      await db.prepare(
        `INSERT OR REPLACE INTO backtest_run_config (run_id, config_key, config_value) SELECT ?1, config_key, config_value FROM model_config`
      ).bind(runId).run();
    }
  } catch (error) { console.error("[ARCHIVE] config:", String(error).slice(0, 200)); }
  try {
    const [tradeCountRow, daCountRow, annCountRow, cfgCountRow] = await Promise.all([
      db.prepare(`SELECT COUNT(*) AS cnt FROM backtest_run_trades WHERE run_id = ?1`).bind(runId).first(),
      db.prepare(`SELECT COUNT(*) AS cnt FROM backtest_run_direction_accuracy WHERE run_id = ?1`).bind(runId).first(),
      db.prepare(`SELECT COUNT(*) AS cnt FROM backtest_run_annotations WHERE run_id = ?1`).bind(runId).first(),
      db.prepare(`SELECT COUNT(*) AS cnt FROM backtest_run_config WHERE run_id = ?1`).bind(runId).first(),
    ]);
    archived = {
      trades: Number(tradeCountRow?.cnt || 0),
      da: Number(daCountRow?.cnt || 0),
      annotations: Number(annCountRow?.cnt || 0),
      config: Number(cfgCountRow?.cnt || 0),
    };
  } catch {}

  const finalSummary = await summarizeRunMetrics(db, runId).catch(() => null);
  if (finalSummary) {
    const finalMetricsPayload = buildMetricsPayload(finalSummary);
    try {
      await db.prepare(`UPDATE backtest_runs SET metrics_json = ?2, updated_at = ?3 WHERE run_id = ?1`).bind(
        runId,
        JSON.stringify(finalMetricsPayload),
        now,
      ).run();
      await db.prepare(`INSERT OR REPLACE INTO backtest_run_metrics (run_id, total_tickers_traded, total_trades, wins, losses, breakevens, open_trades, closed_trades, win_rate, realized_pnl, realized_pnl_pct, avg_win_pct, avg_loss_pct, classifications_json, by_status_json, autopsy_url, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)`).bind(
        finalSummary.run_id, finalSummary.total_tickers_traded, finalSummary.total_trades, finalSummary.wins, finalSummary.losses, finalSummary.breakevens, finalSummary.open_trades, finalSummary.closed_trades, finalSummary.win_rate, finalSummary.realized_pnl, finalSummary.realized_pnl_pct, finalSummary.avg_win_pct, finalSummary.avg_loss_pct, finalSummary.classifications_json, finalSummary.by_status_json, finalSummary.autopsy_url, now,
      ).run();
    } catch {}
    return { ok: true, run_id: runId, status, summary: finalMetricsPayload, archived, manifest, httpStatus: 200 };
  }

  return { ok: true, run_id: runId, status, summary: metricsPayload, archived, manifest, httpStatus: 200 };
}

export async function validateSentinelBasket(db, body = {}) {
  const runId = String(body?.run_id || "").trim();
  if (!runId) return { ok: false, error: "run_id_required", httpStatus: 400 };
  const referenceRunId = String(body?.reference_run_id || "").trim() || await resolveSentinelReferenceRunId(db, runId);
  if (!referenceRunId) return { ok: false, error: "reference_run_not_found", httpStatus: 404 };
  if (referenceRunId === runId) return { ok: false, error: "reference_run_matches_candidate", httpStatus: 400 };
  const basket = Array.isArray(body?.tickers) && body.tickers.length ? body.tickers : SENTINEL_BASKET_V1;
  const [candidateTrades, referenceTrades, candidateRun, referenceRun] = await Promise.all([
    loadRunTradesForValidation(db, runId),
    loadRunTradesForValidation(db, referenceRunId),
    db.prepare(`SELECT run_id, label, status FROM backtest_runs WHERE run_id = ?1`).bind(runId).first().catch(() => null),
    db.prepare(`SELECT run_id, label, status FROM backtest_runs WHERE run_id = ?1`).bind(referenceRunId).first().catch(() => null),
  ]);
  const artifact = buildSentinelValidationArtifact(runId, referenceRunId, candidateTrades, referenceTrades, basket);
  const now = Date.now();
  await db.prepare(
    `INSERT OR REPLACE INTO backtest_run_validation_artifacts
     (run_id, artifact_type, reference_run_id, gate_status, artifact_json, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, COALESCE((SELECT created_at FROM backtest_run_validation_artifacts WHERE run_id = ?1 AND artifact_type = ?2), ?6), ?6)`
  ).bind(
    runId,
    "sentinel_basket_v1",
    referenceRunId,
    String(artifact?.gate?.status || "ok"),
    JSON.stringify(artifact),
    now,
  ).run();
  return {
    ok: true,
    run_id: runId,
    reference_run_id: referenceRunId,
    candidate_label: candidateRun?.label || null,
    reference_label: referenceRun?.label || null,
    artifact,
    httpStatus: 200,
  };
}
