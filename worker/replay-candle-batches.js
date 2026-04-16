export async function executeCandleReplayBatches(args = {}, deps = {}) {
  const {
    env,
    KV,
    db,
    req,
    dateParam,
    fullDay,
    intervalMinutes,
    intervals,
    allTickers,
    tickerOffset: initialTickerOffset,
    tickerBatch,
    batchTickers: initialBatchTickers,
    hasMore: initialHasMore,
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
    replayMarketInternals,
  } = args;
  const {
    sendJSON,
    corsHeaders,
    computeTfBundle,
    normalizeLearnedTickerProfile,
    assembleTickerData,
    computeTDSequentialMultiTF,
    SECTOR_MAP,
    computeRR,
    computeRank,
    computeRRWarning,
    computeMoveStatus,
    shouldCaptureReplayTargetSnapshot,
    buildReplayTargetSnapshot,
    shouldCaptureReplayTargetTimeline,
    classifyKanbanStage,
    qualifiesForEnter,
    sideFromStateOrScores,
    deriveKanbanMeta,
    processTradeSimulation,
    isoToMs,
    isOpenTradeStatus,
    buildReplayCloudDebug,
    sanitizeReplayTradesForScope,
    kvPutJSON,
    REPLAY_TRADES_KV_KEY,
    d1UpsertTickerLatest,
    d1UpsertTrade,
    d1StampRunIdForTrades,
    d1ArchiveRunTrade,
    d1InsertPosition,
    clearReplayRunningMarker,
    runInvestorDailyReplay,
    snapshotBothPortfolios,
  } = deps;

  let tickerOffset = initialTickerOffset;
  let batchTickers = initialBatchTickers;
  let hasMore = initialHasMore;

  let dayScored = 0;
  let dayTradesCreated = 0;
  let daySkipped = 0;
  let dayD1State = 0;
  let dayTrailWritten = 0;
  const dayErrors = [];
  const mergedStageCounts = {};
  const mergedBlockReasons = {};

  while (true) {
    if (batchTickers.length === 0) {
      return sendJSON({ ok: true, processed: 0, hasMore: false, message: "no_tickers_in_batch", fullDay: !!fullDay }, 200, corsHeaders(env, req));
    }

    let processed = 0;
    let tradesCreated = 0;
    let scored = 0;
    let skipped = 0;
    const errors = [];
    const timeline = [];
    const stageCounts = {};
    const blockReasons = {};
    const pendingTrail = [];
    const targetSnapshots = {};
    const targetTimeline = [];
    const bundleCache = {};
    const tdSeqCache = {};

    for (let intervalIdx = 0; intervalIdx < intervals.length; intervalIdx++) {
      const intervalTs = intervals[intervalIdx];
      const intervalTradesBefore = replayCtx.allTrades.length;
      const intervalStageCounts = {};
      const intervalBlockReasons = {};
      const intervalDeepAuditDebug = {};

      for (const ticker of batchTickers) {
        try {
          const bundles = {};
          let hasData = false;
          for (const tf of REPLAY_TFS) {
            const allCandles = candleCache[ticker][tf] || [];
            let lo = 0, hi = allCandles.length - 1;
            while (lo <= hi) {
              const mid = (lo + hi) >> 1;
              if (allCandles[mid].ts <= intervalTs) lo = mid + 1;
              else hi = mid - 1;
            }
            const endIdx = hi + 1;
            if (endIdx >= 50) {
              const cacheKey = `${ticker}:${tf}`;
              const cached = bundleCache[cacheKey];
              if (cached && cached.endIdx === endIdx) {
                bundles[tf] = cached.bundle;
                hasData = true;
              } else {
                const sliced = allCandles.slice(0, endIdx);
                const bundle = computeTfBundle(sliced);
                if (bundle) {
                  bundles[tf] = bundle;
                  hasData = true;
                  bundleCache[cacheKey] = { endIdx, bundle };
                }
              }
            }
          }

          if (!hasData) {
            skipped++;
            continue;
          }

          const bundleMap = {
            M: bundles.M || null,
            W: bundles.W || null,
            D: bundles.D || null,
            "240": bundles["240"] || null,
            "60": bundles["60"] || null,
            "30": bundles["30"] || null,
            "15": bundles["15"] || null,
            "10": bundles["10"] || null,
          };

          const rawBars = {};
          for (const tf of ["D", "W", replayLeadingLtf]) {
            const allCandles = candleCache[ticker]?.[tf] || [];
            const sliced = allCandles.filter((c) => c.ts <= intervalTs);
            const minBars = (tf === "D" || tf === "W") ? 25 : 3;
            if (sliced.length >= minBars) rawBars[tf] = sliced;
          }

          const rawExisting = stateMap[ticker] || {};
          const existing = (cleanSlate && tickerOffset === 0 && intervalIdx === 0)
            ? stripReplayCarryState(rawExisting)
            : rawExisting;
          if (replayTickerProfiles[ticker] && !existing._tickerProfile) {
            existing._tickerProfile = normalizeLearnedTickerProfile(replayTickerProfiles[ticker], {
              ticker,
              source: "replay_d1_batch",
            });
          }
          if (replayMarketInternals) existing._marketInternals = replayMarketInternals;

          const result = assembleTickerData(ticker, bundleMap, existing, {
            rawBars,
            leadingLtf: replayLeadingLtf,
            asOfTs: intervalTs,
          });
          if (!result) {
            skipped++;
            continue;
          }

          {
            const tdSeqTfs = ["10", "30", "60", "240", "D", "W", "M"];
            let tdEndIdxKey = "";
            const tdSeqCandles = {};
            for (const tf of tdSeqTfs) {
              const allC = candleCache[ticker]?.[tf];
              if (!_hasTdMinimum(allC)) continue;
              let lo = 0, hi = allC.length - 1;
              while (lo <= hi) {
                const mid = (lo + hi) >> 1;
                if (allC[mid].ts <= intervalTs) lo = mid + 1;
                else hi = mid - 1;
              }
              const endIdx = hi + 1;
              tdEndIdxKey += `${tf}:${endIdx},`;
              if (endIdx >= 14) tdSeqCandles[tf] = allC.slice(Math.max(0, endIdx - 60), endIdx);
            }
            const tdCached = tdSeqCache[ticker];
            if (tdCached && tdCached.endIdxKey === tdEndIdxKey) {
              result.td_sequential = tdCached.tdSeq;
            } else if (Object.keys(tdSeqCandles).length > 0) {
              const htfBull = (result.htf_score || 0) >= 0;
              const tdSeq = computeTDSequentialMultiTF(tdSeqCandles, htfBull);
              result.td_sequential = tdSeq;
              tdSeqCache[ticker] = { endIdxKey: tdEndIdxKey, tdSeq };
            } else if (result.td_sequential) {
              delete result.td_sequential;
            }
          }

          {
            const sector = SECTOR_MAP[ticker] || "Unknown";
            const rSpyData = stateMap["SPY"];
            const rMktRegime = rSpyData?.regime_class
              ? {
                  regime: rSpyData.regime_class,
                  score: rSpyData.regime_score || 0,
                  htf_score: rSpyData.htf_score ?? null,
                  ema_regime_daily: rSpyData.ema_regime_daily ?? 0,
                  swing_dir: rSpyData.swing_consensus?.direction || null,
                  combined: rSpyData.regime?.combined || null,
                }
              : null;
            const sectorEtfs = require("./sector-mapping.js").SECTOR_ETF_MAP || {};
            const rSectorETF = sectorEtfs[sector];
            const rSectorData = rSectorETF ? stateMap[rSectorETF] : null;
            const rSecRegime = rSectorData?.regime_class ? { regime: rSectorData.regime_class, score: rSectorData.regime_score || 0 } : null;
            result._env = {
              _isReplay: true,
              _goldenProfiles: replayGoldenProfiles,
              _adaptiveEntryGates: replayAdaptiveEntryGates,
              _adaptiveRegimeGates: replayAdaptiveRegimeGates,
              _adaptiveSLTP: replayAdaptiveSLTP,
              _calibratedSlAtr: replayCalibratedSlAtr,
              _calibratedRankMin: replayCalibratedRankMin,
              _marketRegime: rMktRegime,
              _sectorRegime: rSecRegime,
              _marketInternals: replayMarketInternals,
              _deepAuditConfig: replayEnv._deepAuditConfig || null,
              _leadingLtf: replayLeadingLtf,
              _universeSize: allTickers.length,
              _replayBlockedEntries: replayCtx._blockedEntries || null,
              _entryEngine: replayEnv.ENTRY_ENGINE || "tt_core",
              _managementEngine: replayEnv.MANAGEMENT_ENGINE || "tt_core",
              _referenceExecutionMap: replayEnv._referenceExecutionMap || null,
              _scenarioExecutionPolicy: replayEnv._scenarioExecutionPolicy || null,
              _ripsterTuneV2: replayEnv.RIPSTER_TUNE_V2 || "true",
              _ripsterExitDebounceBars: replayEnv.TT_EXIT_DEBOUNCE_BARS || "3",
            };
          }

          if (replayVixCandles.length > 0) {
            let lo = 0, hi = replayVixCandles.length - 1;
            while (lo <= hi) {
              const mid = (lo + hi) >> 1;
              if (replayVixCandles[mid].ts <= intervalTs) lo = mid + 1;
              else hi = mid - 1;
            }
            const vixIdx = Math.max(0, lo - 1);
            const vixCandle = replayVixCandles[vixIdx];
            if (vixCandle?.c) result._vix = Number(vixCandle.c);
          } else if (replayCurrentVix != null) {
            result._vix = replayCurrentVix;
          }

          result.ts = intervalTs;
          result.ingest_ts = intervalTs;
          result.data_source = "candle_replay";
          result.data_source_ts = intervalTs;

          const openTrade = replayCtx.allTrades.find(
            (t) => String(t?.ticker || "").toUpperCase() === ticker && isOpenTradeStatus(t?.status)
          ) || null;
          const staleCarryState = !openTrade && (existing?.entry_ts != null || existing?.entry_price != null);
          if (openTrade) {
            if (existing?.entry_ts != null && result.entry_ts == null) result.entry_ts = existing.entry_ts;
            if (existing?.entry_price != null && result.entry_price == null) result.entry_price = existing.entry_price;
          } else if (staleCarryState) {
            result.entry_ts = null;
            result.entry_price = null;
          }
          if (existing?.kanban_cycle_enter_now_ts != null) result.kanban_cycle_enter_now_ts = existing.kanban_cycle_enter_now_ts;
          if (existing?.kanban_cycle_trigger_ts != null) result.kanban_cycle_trigger_ts = existing.kanban_cycle_trigger_ts;
          if (existing?.kanban_cycle_side != null) result.kanban_cycle_side = existing.kanban_cycle_side;

          const replayScoreSeed = {
            existing_rank: existing?.rank ?? null,
            existing_score: existing?.score ?? null,
            assembled_rank: result?.rank ?? null,
            assembled_score: result?.score ?? null,
            session_seed_rank: null,
            session_seed_score: null,
            session_seed_ts: null,
            session_seed_state: null,
            after_guard_rank: null,
            after_guard_score: null,
            after_sim_rank: null,
            after_sim_score: null,
            after_post_close_rank: null,
            after_post_close_score: null,
            just_closed_replay_trade: false,
          };

          result.rr = computeRR(result);
          if (result.rr != null && Number(result.rr) > 25) result.rr = 25;
          const replaySessionSeedKey = `${dateParam}:${ticker}`;
          if (!replayCtx.sessionScoreSeeds.has(replaySessionSeedKey)) {
            const seedResult = { ...result };
            seedResult.entry_ts = null;
            seedResult.entry_price = null;
            seedResult.trigger_ts = null;
            seedResult.kanban_cycle_enter_now_ts = null;
            seedResult.kanban_cycle_trigger_ts = null;
            seedResult.kanban_cycle_side = null;
            delete seedResult.__entry_path;
            delete seedResult.__entry_confidence;
            delete seedResult.__entry_reason;
            delete seedResult.__setup_reason;
            delete seedResult.__entry_block_reason;
            delete seedResult.__entry_block_fuel_pct;
            delete seedResult.prev_kanban_stage;
            delete seedResult.prev_kanban_stage_ts;
            delete seedResult.__rank_trace;
            seedResult.rank = null;
            seedResult.score = null;
            seedResult.move_status = computeMoveStatus(seedResult);
            if (seedResult.flags) {
              seedResult.flags.move_invalidated = seedResult.move_status?.status === "INVALIDATED";
              seedResult.flags.move_completed = seedResult.move_status?.status === "COMPLETED";
            }
            seedResult.rank = computeRank(seedResult);
            seedResult.score = seedResult.rank;
            replayCtx.sessionScoreSeeds.set(replaySessionSeedKey, {
              rank: seedResult.rank,
              score: seedResult.score,
              ts: intervalTs,
              state: seedResult.state ?? null,
            });
          }
          const replaySessionSeed = replayCtx.sessionScoreSeeds.get(replaySessionSeedKey) || null;
          replayScoreSeed.session_seed_rank = replaySessionSeed?.rank ?? null;
          replayScoreSeed.session_seed_score = replaySessionSeed?.score ?? null;
          replayScoreSeed.session_seed_ts = replaySessionSeed?.ts ?? null;
          replayScoreSeed.session_seed_state = replaySessionSeed?.state ?? null;
          delete result.__rank_trace;
          result.rank = computeRank(result);
          result.score = result.rank;
          replayScoreSeed.after_guard_rank = result?.rank ?? null;
          replayScoreSeed.after_guard_score = result?.score ?? null;
          if (result.rr_warning == null && Number.isFinite(result.rr)) {
            result.rr_warning = computeRRWarning(result.rr);
          }
          result.move_status = computeMoveStatus(result);
          if (result.flags) {
            result.flags.move_invalidated = result.move_status?.status === "INVALIDATED";
            result.flags.move_completed = result.move_status?.status === "COMPLETED";
          }
          if (shouldCaptureReplayTargetSnapshot(ticker, intervalTs)) {
            if (!result.__rank_trace) computeRank(result);
            targetSnapshots[`${ticker}:${intervalTs}:pre_stage`] = buildReplayTargetSnapshot(result, {
              open_trade_status: openTrade?.status ?? null,
              open_trade_entry_ts: openTrade?.entry_ts ?? null,
              stale_carry_state: staleCarryState,
            });
          }

          const prevState = existing?.state;
          const curState = result.state;
          const isActionable = curState && (
            curState.includes("BULL_BULL") || curState.includes("BEAR_BEAR") || curState.includes("PULLBACK")
          );
          if (isActionable && curState !== prevState) {
            result.trigger_ts = intervalTs;
          } else if (existing?.trigger_ts) {
            result.trigger_ts = existing.trigger_ts;
          }

          const prevStage = existing?.kanban_stage;
          const stage = classifyKanbanStage(result, openTrade, intervalTs);
          let finalStage = stage;

          const needsBlockDiag = ["watch", "setup", "discovery", "in_review", "enter", "enter_now"].includes(stage) && result.state;
          if (needsBlockDiag) {
            const diagEntry = qualifiesForEnter(result, intervalTs);
            if (!diagEntry.qualifies) {
              result.__entry_block_reason = diagEntry.reason;
              if (diagEntry.fuelPct != null) result.__entry_block_fuel_pct = diagEntry.fuelPct;
              blockReasons[diagEntry.reason] = (blockReasons[diagEntry.reason] || 0) + 1;
              intervalBlockReasons[diagEntry.reason] = (intervalBlockReasons[diagEntry.reason] || 0) + 1;
            } else {
              delete result.__entry_block_reason;
              delete result.__entry_block_fuel_pct;
            }
          }

          if (finalStage === "in_review" || finalStage === "enter_now" || finalStage === "enter") {
            result.kanban_cycle_enter_now_ts = intervalTs;
            result.kanban_cycle_trigger_ts = Number.isFinite(Number(result?.trigger_ts)) ? result.trigger_ts : intervalTs;
            result.kanban_cycle_side = sideFromStateOrScores(result);
          } else if (["hold", "just_entered", "defend", "trim", "exit"].includes(finalStage)) {
            result.kanban_cycle_enter_now_ts = existing?.kanban_cycle_enter_now_ts ?? null;
            result.kanban_cycle_trigger_ts = existing?.kanban_cycle_trigger_ts ?? null;
            result.kanban_cycle_side = existing?.kanban_cycle_side ?? null;
          } else {
            result.kanban_cycle_enter_now_ts = null;
            result.kanban_cycle_trigger_ts = null;
            result.kanban_cycle_side = null;
          }

          const isNewEntry = (finalStage === "in_review" || finalStage === "enter_now" || finalStage === "enter")
            && prevStage !== "in_review" && prevStage !== "enter_now" && prevStage !== "enter";
          if (isNewEntry) {
            const bLtf = bundleMap[replayLeadingLtf];
            let priceLtf = Number(bLtf?.px);
            if (!(Number.isFinite(priceLtf) && priceLtf > 0)) {
              const ltfCandles = candleCache[ticker]?.[replayLeadingLtf] || [];
              const lastLtf = ltfCandles.filter((c) => c.ts <= intervalTs).pop();
              priceLtf = lastLtf ? Number(lastLtf.c) : null;
            }
            const priceFallback = Number(result?.price);
            const price = (Number.isFinite(priceLtf) && priceLtf > 0) ? priceLtf : priceFallback;
            if (Number.isFinite(price) && price > 0) {
              result.entry_price = price;
              result.entry_ts = intervalTs;
            }
          }
          if (!isNewEntry && openTrade && finalStage && existing?.entry_price && result.entry_price == null) {
            result.entry_price = existing.entry_price;
            result.entry_ts = existing.entry_ts;
          }

          if (prevStage && finalStage && String(prevStage) !== String(finalStage)) {
            result.prev_kanban_stage = String(prevStage);
            result.prev_kanban_stage_ts = intervalTs;
          }

          result.kanban_stage = finalStage;
          result.kanban_meta = deriveKanbanMeta(result, finalStage);
          if (shouldCaptureReplayTargetSnapshot(ticker, intervalTs)) {
            targetSnapshots[`${ticker}:${intervalTs}:post_stage`] = buildReplayTargetSnapshot(result, {
              kanban_stage: finalStage,
              open_trade_status: openTrade?.status ?? null,
              open_trade_entry_ts: openTrade?.entry_ts ?? null,
              stale_carry_state: staleCarryState,
            });
          }

          stageCounts[finalStage || "null"] = (stageCounts[finalStage || "null"] || 0) + 1;
          intervalStageCounts[finalStage || "null"] = (intervalStageCounts[finalStage || "null"] || 0) + 1;

          if (!skipTrail) pendingTrail.push({ ticker, result: { ...result } });

          let intervalTradeDelta = 0;
          if (!trailOnly) {
            const simReplayEnv = { ...env, DISCORD_ENABLE: "false", DISCORD_WEBHOOK_URL: null, EMAIL_ENABLED: "false", SENDGRID_API_KEY: null };
            const countBefore = replayCtx.allTrades.filter((x) => String(x?.ticker).toUpperCase() === ticker).length;
            await processTradeSimulation(KV, ticker, result, existing, simReplayEnv, {
              forceUseIngestTs: true,
              replayBatchContext: replayCtx,
              asOfTs: intervalTs,
            });
            replayScoreSeed.after_sim_rank = result?.rank ?? null;
            replayScoreSeed.after_sim_score = result?.score ?? null;
            const countAfter = replayCtx.allTrades.filter((x) => String(x?.ticker).toUpperCase() === ticker).length;
            intervalTradeDelta = Math.max(0, countAfter - countBefore);
            if (intervalTradeDelta > 0) tradesCreated += intervalTradeDelta;

            const openTradeAfter = replayCtx.allTrades.find(
              (t) => String(t?.ticker || "").toUpperCase() === ticker && isOpenTradeStatus(t?.status)
            ) || null;
            const justClosedReplayTrade = !!openTrade && !openTradeAfter;
            const openTradeEntryTs = Number(
              openTrade?.entry_ts ?? openTrade?.entryTimeMs ?? isoToMs(openTrade?.entryTime) ?? openTrade?.entryTs
            );
            const carriedIntoSession = !!openTrade
              && Number.isFinite(openTradeEntryTs)
              && Number.isFinite(marketOpenMs)
              && openTradeEntryTs < marketOpenMs;
            if (justClosedReplayTrade) {
              replayScoreSeed.just_closed_replay_trade = true;
              result.entry_ts = null;
              result.entry_price = null;
              result.trigger_ts = null;
              result.kanban_cycle_enter_now_ts = null;
              result.kanban_cycle_trigger_ts = null;
              result.kanban_cycle_side = null;
              delete result.__entry_path;
              delete result.__entry_confidence;
              delete result.__entry_reason;
              delete result.__setup_reason;
              delete result.__entry_block_reason;
              delete result.__entry_block_fuel_pct;
              delete result.prev_kanban_stage;
              delete result.prev_kanban_stage_ts;
              result.move_status = computeMoveStatus(result);
              if (result.flags) {
                result.flags.move_invalidated = result.move_status?.status === "INVALIDATED";
                result.flags.move_completed = result.move_status?.status === "COMPLETED";
              }
              if (carriedIntoSession && replaySessionSeed && Number.isFinite(Number(replaySessionSeed.rank))) {
                delete result.__rank_trace;
                result.rank = Number(replaySessionSeed.rank);
                result.score = Number(replaySessionSeed.score ?? replaySessionSeed.rank);
              } else {
                delete result.__rank_trace;
                result.rank = computeRank(result);
                result.score = result.rank;
              }
              const postCloseStage = classifyKanbanStage(result, null, intervalTs);
              result.kanban_stage = postCloseStage;
              result.kanban_meta = deriveKanbanMeta(result, postCloseStage);
              if (["watch", "setup", "discovery", "in_review", "enter", "enter_now"].includes(postCloseStage) && result.state) {
                const postCloseDiag = qualifiesForEnter(result, intervalTs);
                if (!postCloseDiag.qualifies) {
                  result.__entry_block_reason = postCloseDiag.reason;
                  if (postCloseDiag.fuelPct != null) result.__entry_block_fuel_pct = postCloseDiag.fuelPct;
                }
              }
            }
            replayScoreSeed.after_post_close_rank = result?.rank ?? null;
            replayScoreSeed.after_post_close_score = result?.score ?? null;
          }

          if (shouldCaptureReplayTargetTimeline(dateParam, ticker)) {
            if (!result.__rank_trace || Number(result.__rank_trace?.ts || 0) !== Number(intervalTs)) computeRank(result);
            targetTimeline.push(buildReplayTargetSnapshot(result, {
              interval_date: dateParam,
              kanban_stage: result?.kanban_stage ?? null,
              open_trade_status: replayCtx.allTrades.find(
                (t) => String(t?.ticker || "").toUpperCase() === ticker && isOpenTradeStatus(t?.status)
              )?.status ?? null,
              open_trade_entry_ts: replayCtx.allTrades.find(
                (t) => String(t?.ticker || "").toUpperCase() === ticker && isOpenTradeStatus(t?.status)
              )?.entry_ts ?? null,
              stale_carry_state: staleCarryState,
              trades_created_delta: intervalTradeDelta,
              replay_score_seed: replayScoreSeed,
            }));
          }

          intervalDeepAuditDebug[ticker] = {
            pullback_selective_enabled: result?._env?._deepAuditConfig?.deep_audit_pullback_selective_enabled ?? null,
            pullback_min_bearish_count: result?._env?._deepAuditConfig?.deep_audit_pullback_min_bearish_count ?? null,
          };
          stateMap[ticker] = sanitizeReplayTickerState(result);
          scored++;
          processed++;
        } catch (e) {
          errors.push({ ticker, ts: intervalTs, error: String(e?.message || e) });
        }
      }

      if (debugTimeline) {
        const intervalTradesAfter = replayCtx.allTrades.length;
        const openTrades = replayCtx.allTrades.filter((t) => {
          if (!isOpenTradeStatus(t?.status)) return false;
          const tradeSym = String(t?.ticker || "").toUpperCase();
          return batchTickers.includes(tradeSym);
        }).length;
        const latestTrades = replayCtx.allTrades
          .filter((t) => batchTickers.includes(String(t?.ticker || "").toUpperCase()))
          .sort((a, b) => {
            const aTs = Number(a?.entry_ts || a?.created_at || 0);
            const bTs = Number(b?.entry_ts || b?.created_at || 0);
            return bTs - aTs;
          })
          .slice(0, 3)
          .map((t) => ({
            ticker: t?.ticker || null,
            status: t?.status || null,
            entry_ts: Number(t?.entry_ts || t?.created_at || 0) || null,
            exit_ts: Number(t?.exit_ts || 0) || null,
            exit_reason: t?.exitReason || t?.exit_reason || null,
            trimmed_pct: Number(t?.trimmedPct || t?.trimmed_pct || 0) || 0,
          }));
        const tickerSnapshots = batchTickers.slice(0, 5).map((ticker) => {
          const latestState = stateMap[ticker] || null;
          const deepAuditDebug = intervalDeepAuditDebug[ticker] || {};
          return {
            ticker,
            state: latestState?.state || null,
            stage: latestState?.kanban_stage || null,
            price: latestState?.price != null ? Number(latestState.price) : null,
            htf_score: latestState?.htf_score != null ? Number(latestState.htf_score) : null,
            ltf_score: latestState?.ltf_score != null ? Number(latestState.ltf_score) : null,
            cloud_debug: buildReplayCloudDebug(latestState),
            deep_audit_debug: {
              pullback_selective_enabled: deepAuditDebug.deep_audit_pullback_selective_enabled ?? null,
              pullback_min_bearish_count: deepAuditDebug.deep_audit_pullback_min_bearish_count ?? null,
            },
          };
        });
        timeline.push({
          interval: intervalIdx,
          intervalTs,
          tradesCreated: Math.max(0, intervalTradesAfter - intervalTradesBefore),
          totalTrades: intervalTradesAfter,
          openTrades,
          stageCounts: intervalStageCounts,
          blockReasons: intervalBlockReasons,
          latestTrades,
          tickerSnapshots,
        });
      }
    }

    let trailWritten = 0;
    if (pendingTrail.length > 0 && db) {
      try {
        const trailStmts = [];
        for (const { ticker: t, result: r } of pendingTrail) {
          const ts = Number(r?.ts);
          if (!Number.isFinite(ts)) continue;
          const flagsJson = r?.flags ? JSON.stringify(r.flags) : null;
          trailStmts.push(
            db.prepare(
              `INSERT OR REPLACE INTO timed_trail
                (ticker, ts, price, htf_score, ltf_score, completion, phase_pct, state, rank, flags_json, trigger_reason, trigger_dir, kanban_stage, payload_json)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`
            ).bind(
              String(t).toUpperCase(),
              ts,
              r?.price ?? null,
              r?.htf_score ?? null,
              r?.ltf_score ?? null,
              r?.completion ?? null,
              r?.phase_pct ?? null,
              r?.state ?? null,
              r?.rank ?? null,
              flagsJson,
              r?.trigger_reason ?? null,
              r?.trigger_dir ?? null,
              r?.kanban_stage ?? null,
              null,
            )
          );
        }
        const D1_BATCH_MAX = 100;
        for (let i = 0; i < trailStmts.length; i += D1_BATCH_MAX) {
          await db.batch(trailStmts.slice(i, i + D1_BATCH_MAX));
          trailWritten += Math.min(D1_BATCH_MAX, trailStmts.length - i);
        }
      } catch (trailErr) {
        errors.push({ ticker: "TRAIL_BATCH", error: String(trailErr?.message || trailErr).slice(0, 150) });
      }
    }

    let d1StateWritten = 0;
    if (!trailOnly) {
      for (const ticker of batchTickers) {
        if (stateMap[ticker] && Object.keys(stateMap[ticker]).length > 0) {
          try {
            await d1UpsertTickerLatest(env, ticker, stateMap[ticker]);
            d1StateWritten++;
          } catch (d1Err) {
            errors.push({ ticker, error: `D1_STATE: ${String(d1Err?.message || d1Err).slice(0, 100)}` });
          }
          try {
            await kvPutJSON(KV, `timed:latest:${ticker}`, stateMap[ticker]);
          } catch (kvErr) {
            console.warn(`[REPLAY] KV write failed for ${ticker}:`, String(kvErr?.message || kvErr).slice(0, 100));
          }
        }
      }

      replayCtx.allTrades = sanitizeReplayTradesForScope(replayCtx.allTrades, replayTradeScope);
      try {
        await kvPutJSON(KV, REPLAY_TRADES_KV_KEY, replayCtx.allTrades);
      } catch (e) {
        errors.push({ ticker: "TRADES_KV_SAVE", error: String(e?.message || e) });
      }

      if (db) {
        const batchTickerSet = new Set(batchTickers.map((t) => t.toUpperCase()));
        const batchTrades = replayCtx.allTrades.filter((t) =>
          batchTickerSet.has(String(t?.ticker || "").toUpperCase())
        );
        try {
          for (const trade of batchTrades) {
            if (replayLockVal && !trade.run_id) trade.run_id = replayLockVal;
            await d1UpsertTrade(env, trade).catch(() => {});
          }
          if (replayLockVal) {
            await d1StampRunIdForTrades(
              env,
              replayLockVal,
              batchTrades.map((t) => t?.trade_id || t?.id || null),
            );
          }
        } catch (e) {
          errors.push({ ticker: "TRADES_D1_SYNC", error: String(e?.message || e).slice(0, 150) });
        }

        if (replayLockVal) {
          try {
            for (const trade of batchTrades) {
              await d1ArchiveRunTrade(env, replayLockVal, trade).catch(() => {});
            }
          } catch (e) {
            errors.push({ ticker: "TRADES_ARCHIVE_SYNC", error: String(e?.message || e).slice(0, 150) });
          }
        }

        const openBatchTrades = batchTrades.filter((t) => String(t?.status || "").toUpperCase() === "OPEN");
        let positionsSynced = 0;
        for (const trade of openBatchTrades) {
          try {
            const sym = String(trade.ticker).toUpperCase();
            const dir = String(trade.direction || "LONG").toUpperCase();
            const shares = Number(trade.shares) || 0;
            const ep = Number(trade.entryPrice) || 0;
            const costBasis = shares * ep;
            const entryTs = Number(trade.entry_ts) || Number(trade.created_at) || Date.now();
            const sl = Number(trade.sl);
            const tp = Number(trade.tp);
            const posId = trade.id || `replay-${sym}-${entryTs}`;
            await d1InsertPosition(env, {
              position_id: posId,
              ticker: sym,
              direction: dir,
              status: "OPEN",
              total_qty: shares,
              cost_basis: costBasis,
              created_at: entryTs,
              updated_at: entryTs,
              stop_loss: Number.isFinite(sl) ? sl : null,
              take_profit: Number.isFinite(tp) ? tp : null,
            });
            positionsSynced++;
          } catch {}
        }
        if (positionsSynced > 0) {
          console.log(`[REPLAY] Synced ${positionsSynced} open positions to D1 positions table`);
        }
      }
    }

    if (!hasMore) {
      await clearReplayRunningMarker(KV);
      if (!skipInvestor) {
        console.log(`[REPLAY] End-of-day for ${dateParam}: investor replay + snapshots (this can take 30-60s)`);
        try {
          const invResult = await runInvestorDailyReplay(env, KV, replayCtx, dateParam);
          if (invResult?.opened || invResult?.closed || invResult?.dcaBuys || invResult?.trimmed) {
            console.log(`[REPLAY] Investor: +${invResult.opened} -${invResult.closed} dca=${invResult.dcaBuys} trim=${invResult.trimmed}`);
          }
        } catch (invErr) {
          console.warn("[REPLAY] Investor daily replay failed:", String(invErr).slice(0, 200));
        }
        try {
          await snapshotBothPortfolios(env, KV, replayCtx, dateParam);
        } catch (snapErr) {
          console.warn("[REPLAY] Portfolio snapshot failed:", String(snapErr).slice(0, 200));
        }
      } else {
        const dayState = {};
        for (const sym of Object.keys(SECTOR_MAP)) {
          try {
            const td = await deps.kvGetJSON?.(KV, `timed:latest:${sym}`);
            if (td && td.price > 0) dayState[sym] = td;
          } catch {}
        }
        try {
          await kvPutJSON(KV, `timed:replay:daystate:${dateParam}`, dayState);
          console.log(`[REPLAY] Last batch done (trader only); saved day state for ${dateParam} (${Object.keys(dayState).length} tickers)`);
        } catch (e) {
          console.warn("[REPLAY] Failed to save day state:", String(e).slice(0, 150));
        }
      }
    }

    const lastSnapshot = {};
    for (const ticker of batchTickers) {
      const s = stateMap[ticker];
      if (s) {
        lastSnapshot[ticker] = {
          state: s.state,
          htf_score: s.htf_score,
          ltf_score: s.ltf_score,
          ema_regime_daily: s.ema_regime_daily,
          ema_regime_4h: s.ema_regime_4h,
          fuel_D: s.fuel?.D?.fuelPct ?? null,
          fuel_10: s.fuel?.["10"]?.fuelPct ?? null,
          fuel_30: s.fuel?.["30"]?.fuelPct ?? null,
          st_support_D: s.st_support?.map?.D || null,
          kanban_stage: s.kanban_stage,
          score: s.score || s.rank,
          block_reason: s.__entry_block_reason || null,
          block_fuel_pct: s.__entry_block_fuel_pct ?? null,
          primary_fuel: (s.fuel != null) ? Math.max(s.fuel?.["30"]?.fuelPct ?? 50, s.fuel?.["10"]?.fuelPct ?? 50) : null,
        };
      }
    }

    if (fullDay) {
      dayScored += scored;
      dayTradesCreated += tradesCreated;
      daySkipped += skipped;
      dayD1State += d1StateWritten;
      dayTrailWritten += trailWritten;
      dayErrors.push(...errors);
      for (const k of Object.keys(stageCounts || {})) mergedStageCounts[k] = (mergedStageCounts[k] || 0) + (stageCounts[k] || 0);
      for (const k of Object.keys(blockReasons || {})) mergedBlockReasons[k] = (mergedBlockReasons[k] || 0) + (blockReasons[k] || 0);
      if (hasMore) {
        tickerOffset += tickerBatch;
        batchTickers = allTickers.slice(tickerOffset, tickerOffset + tickerBatch);
        hasMore = tickerOffset + tickerBatch < allTickers.length;
        continue;
      }
    }

    return sendJSON({
      ok: true,
      date: dateParam,
      tickerOffset,
      tickerBatch,
      tickersProcessed: fullDay ? allTickers.length : batchTickers.length,
      intervals: intervals.length,
      intervalMinutes,
      scored: fullDay ? dayScored : scored,
      skipped: fullDay ? daySkipped : skipped,
      tradesCreated: fullDay ? dayTradesCreated : tradesCreated,
      totalTrades: replayCtx.allTrades.length,
      hasMore: fullDay ? false : hasMore,
      nextTickerOffset: fullDay ? null : (hasMore ? tickerOffset + tickerBatch : null),
      errorsCount: fullDay ? dayErrors.length : errors.length,
      errors: (fullDay ? dayErrors : errors).slice(0, 10),
      stageCounts: fullDay ? mergedStageCounts : stageCounts,
      blockReasons: fullDay ? mergedBlockReasons : blockReasons,
      d1StateWritten: fullDay ? dayD1State : d1StateWritten,
      trailWritten: fullDay ? dayTrailWritten : trailWritten,
      lastSnapshot,
      targetSnapshots,
      targetTimeline,
      processDebug: replayCtx?.processDebug?.slice(0, 30) || [],
      blockedEntryGates: replayCtx?._blockedEntries || {},
      timeline: debugTimeline ? timeline : undefined,
      fullDay: !!fullDay,
    }, 200, corsHeaders(env, req));
  }
}

function _hasTdMinimum(candles) {
  return Array.isArray(candles) && candles.length >= 14;
}
