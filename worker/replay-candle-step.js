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
    const KV = env?.KV;
    if (!db) return sendJSON({ ok: false, error: "no_db_binding" }, 500, corsHeaders(env, req));

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
      allTickers,
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
      marketOpenMs,
      REPLAY_TFS,
      candleCache,
      replayCtx,
      stateMap,
      sanitizeReplayTickerState,
      stripReplayCarryState,
      replayTradeScope,
      replayLockVal,
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
