export function createCandleReplayStep(deps = {}) {
  const {
    sendJSON,
    corsHeaders,
    parseCandleReplayRequest,
    SECTOR_MAP,
    normalizeTfKey,
    nyWallTimeToUtcMs,
    prepareCandleReplayBatch,
    loadRunManifest,
    buildReplayTradeScope,
    isRunManifestCleanLane,
    kvPutJSON,
    d1GetCandlesAllTfs,
    kvGetJSON,
    /* Phase C — Stage 1 (2026-05-03) */
    PhaseCLoops,
    d1EnsureBacktestRunsSchema,
    sanitizeReplayTradesForScope,
    loadReplayScopedTrades,
    loadReplayTickerState,
    REPLAY_TRADES_KV_KEY,
    loadReplayRuntimeConfig,
    applyReplayRuntimeCaches,
    prepareCandleReplayRuntime,
    loadReplayConfigValue,
    CARTER_OFFENSE_SECTORS,
    CARTER_DEFENSE_SECTORS,
    loadReplayTickerProfiles,
    executeCandleReplayBatches,
  } = deps;

  return async function runCandleReplayStepImpl({ req, env, url, body = {} }) {
    const db = env?.DB;
    // Fall back to KV_TIMED when KV is not explicitly injected (BacktestRunner
    // DO injects KV alongside KV_TIMED; external HTTP callers only have
    // KV_TIMED because that is the wrangler binding name). Without this fallback
    // the external /timed/admin/candle-replay path throws 1101 when KV.get is
    // first called inside prepareCandleReplayBatch. See lessons.md 2026-04-17.
    const KV = env?.KV || env?.KV_TIMED || null;
    if (!db) return sendJSON({ ok: false, error: "no_db_binding" }, 500, corsHeaders(env, req));
    if (!KV) return sendJSON({ ok: false, error: "no_kv_binding" }, 500, corsHeaders(env, req));

    const directConfigOverride = body?.config_override && typeof body.config_override === "object" && !Array.isArray(body.config_override)
      ? body.config_override
      : null;
    const replayRequest = parseCandleReplayRequest({
      url,
      tickerUniverse: Object.keys(SECTOR_MAP),
    });
    if (!replayRequest?.ok) {
      return sendJSON({ ok: false, error: replayRequest?.error || "invalid_replay_request" }, replayRequest?.status || 400, corsHeaders(env, req));
    }

    const {
      dateParam,
      fullDay,
      intervalMinutes,
      cleanSlate,
      freshRun,
      trailOnly,
      skipTrail,
      skipInvestor,
      debugTimeline,
      blockChainTrace,
      allTickers,
      trailForensics,
    } = replayRequest.request;
    let { tickerOffset, tickerBatch, batchTickers, hasMore } = replayRequest.request;

    const replayEnv = { ...env, _isReplay: true };
    for (const overrideKey of ["LEADING_LTF", "TT_EXIT_DEBOUNCE_BARS", "TT_TUNE_V2", "RIPSTER_TUNE_V2", "ENTRY_ENGINE", "MANAGEMENT_ENGINE"]) {
      const overrideValue = url.searchParams.get(overrideKey);
      if (overrideValue != null && overrideValue !== "") replayEnv[overrideKey] = overrideValue;
    }
    const replayLeadingLtf = normalizeTfKey(replayEnv.LEADING_LTF || "10") || "10";

    const marketOpenMs = nyWallTimeToUtcMs(dateParam, 9, 30, 0);
    const marketCloseMs = nyWallTimeToUtcMs(dateParam, 16, 0, 0);
    if (!marketOpenMs || !marketCloseMs) {
      return sendJSON({ ok: false, error: "failed_to_compute_market_hours" }, 500, corsHeaders(env, req));
    }

    const intervalMs = intervalMinutes * 60 * 1000;
    const intervals = [];
    for (let ts = marketOpenMs; ts <= marketCloseMs; ts += intervalMs) {
      intervals.push(ts);
    }

    const preparedReplayBatch = await prepareCandleReplayBatch({
      env,
      KV,
      db,
      url,
      dateParam,
      fullDay,
      tickerOffset,
      batchTickers,
      allTickers,
      replayLeadingLtf,
      replayEnv,
      marketCloseMs,
      cleanSlate,
      freshRun,
      deps: {
        loadRunManifest,
        buildReplayTradeScope,
        isRunManifestCleanLane,
        kvPutJSON,
        d1GetCandlesAllTfs,
        kvGetJSON,
        d1EnsureBacktestRunsSchema,
        sanitizeReplayTradesForScope,
        loadReplayScopedTrades,
        loadReplayTickerState,
        REPLAY_TRADES_KV_KEY,
      },
    });
    const {
      replayLockVal,
      replayRunId,
      replayConfigRunHint,
      replayTradeScope,
      replayTfs: REPLAY_TFS,
      candleCache,
      replayCtx,
      stateMap,
      sanitizeReplayTickerState,
      stripReplayCarryState,
    } = preparedReplayBatch;

    const {
      replayRunConfig,
      replayAdaptiveEntryGates,
      replayAdaptiveRegimeGates,
      replayAdaptiveSLTP,
      replayCalibratedSlAtr,
      replayCalibratedRankMin,
      calibratedTPTiers,
      dynamicEngineRules,
      referenceExecutionMap,
      scenarioExecutionPolicy,
      goldenProfiles: replayGoldenProfiles,
    } = await loadReplayRuntimeConfig({
      db,
      KV,
      replayConfigRunHint,
      directConfigOverride,
      replayEnv,
      logPrefix: "[REPLAY]",
      pinnedConfigExtraKeys: ["cio_franchise_blacklist", "cio_reference_features"],
    });
    applyReplayRuntimeCaches?.({
      calibratedTPTiers,
      dynamicEngineRules,
      referenceExecutionMap,
      scenarioExecutionPolicy,
    });

    const {
      replayCurrentVix,
      replayVixCandles,
      replaySectorCandles,
      replayMarketInternals,
    } = await prepareCandleReplayRuntime({
      db,
      KV,
      replayEnv,
      replayRunConfig,
      replayCtx,
      candleCache,
      dateParam,
      marketCloseMs,
      deps: {
        loadReplayConfigValue,
        d1GetCandlesAllTfs,
        kvGetJSON,
        CARTER_OFFENSE_SECTORS,
        CARTER_DEFENSE_SECTORS,
      },
    });

    const replayTickerProfiles = await loadReplayTickerProfiles(db, batchTickers, { logPrefix: "[REPLAY]" });

    env._adaptiveSLTP = replayAdaptiveSLTP;
    env._calibratedSlAtr = replayCalibratedSlAtr;
    env._calibratedRankMin = replayCalibratedRankMin;
    env._deepAuditConfig = replayEnv._deepAuditConfig;

    /* Phase C — Stage 1 (2026-05-03) — Pre-fetch Loop 1 + Loop 2 state once
       per batch and stamp it on replayEnv so the per-ticker scoring loop
       can read it sync. Mirrors the live cron path in worker/index.js. */
    const _phaseCDaCfg = replayEnv?._deepAuditConfig || env?._deepAuditConfig || {};

    /* Phase C — Stage 1.1 (2026-05-03) — In live, Loop 2's hourly cron
       computes a pulse from the most-recent closed trades and trips the
       pause flag if WR/today-PnL/consec-loss thresholds are breached.
       Backtest replay never invokes the cron, so the breaker stays at
       rest no matter how badly the engine is bleeding mid-month. We mirror
       the cron logic here using the in-memory replayCtx.allTrades (no D1
       query needed — it's already the trade history for the run). The
       pulse fires once per batch (i.e. once per simulated day per ticker
       slice), which is the right cadence for backtest — way fewer pulses
       than the hourly live cron, but still sufficient to catch a 4-day
       losing streak. */
    try {
      const loop2Enabled = String(_phaseCDaCfg.loop2_circuit_breaker_enabled ?? "false") === "true";
      if (PhaseCLoops && loop2Enabled && KV && Array.isArray(replayCtx?.allTrades)) {
        const recentRows = replayCtx.allTrades
          .filter((t) => {
            const s = String(t?.status || "").toUpperCase();
            return (s === "WIN" || s === "LOSS" || s === "FLAT") && t?.exit_ts;
          })
          .sort((a, b) => Number(b.exit_ts || 0) - Number(a.exit_ts || 0))
          .slice(0, 30);
        if (recentRows.length > 0) {
          const pulse = PhaseCLoops.loop2ComputePulse(recentRows, { window: 10, nowMs: marketCloseMs });
          const evalRes = PhaseCLoops.loop2EvaluatePulse(pulse, _phaseCDaCfg);
          await PhaseCLoops.loop2WritePulse(KV, pulse, evalRes, _phaseCDaCfg, { nowMs: marketCloseMs });
          if (evalRes.trip) {
            console.warn(
              `[phase-c][REPLAY] LOOP 2 BREAKER TRIPPED — reason=${evalRes.reason} wr=${pulse.last10_wr != null ? (pulse.last10_wr * 100).toFixed(0) + "%" : "n/a"} todayPnl=${pulse.today_pnl_pct.toFixed(2)}% consec=${pulse.consec_losses}`
            );
          }
        }
      }
    } catch (e) {
      console.warn("[phase-c][REPLAY] loop2 pulse failed:", String(e?.message || e).slice(0, 200));
    }

    try {
      if (PhaseCLoops && String(_phaseCDaCfg.loop2_circuit_breaker_enabled ?? "false") === "true") {
        replayEnv._loop2Pause = await PhaseCLoops.loop2ReadPause(KV, { nowMs: marketCloseMs });
      } else {
        replayEnv._loop2Pause = { paused: false };
      }
    } catch (_) {
      replayEnv._loop2Pause = { paused: false };
    }
    try {
      if (PhaseCLoops && String(_phaseCDaCfg.loop1_specialization_enabled ?? "false") === "true") {
        const _scorecards = await PhaseCLoops.loop1ReadAllScorecards(KV);
        replayEnv._loop1AdvisoryByCombo = PhaseCLoops.loop1ComputeAdvisoryMap(_scorecards, _phaseCDaCfg);
      } else {
        replayEnv._loop1AdvisoryByCombo = {};
      }
    } catch (_) {
      replayEnv._loop1AdvisoryByCombo = {};
    }

    return executeCandleReplayBatches({
      env,
      KV,
      db,
      req,
      dateParam,
      fullDay,
      intervalMinutes,
      intervals,
      allTickers,
      tickerOffset,
      tickerBatch,
      batchTickers,
      hasMore,
      replayLeadingLtf,
      cleanSlate,
      trailOnly,
      skipTrail,
      skipInvestor,
      debugTimeline,
      blockChainTrace,
      trailForensics,
      marketOpenMs,
      REPLAY_TFS,
      candleCache,
      replayCtx,
      stateMap,
      sanitizeReplayTickerState,
      stripReplayCarryState,
      replayTradeScope,
      replayLockVal,
      replayRunId,
      replayEnv,
      replayAdaptiveEntryGates,
      replayAdaptiveRegimeGates,
      replayAdaptiveSLTP,
      replayCalibratedSlAtr,
      replayCalibratedRankMin,
      replayGoldenProfiles,
      replayTickerProfiles,
      replayVixCandles,
      replayCurrentVix,
      replaySectorCandles,
      replayMarketInternals,
    }, deps);
  };
}
