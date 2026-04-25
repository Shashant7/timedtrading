// ─────────────────────────────────────────────────────────────────────────
// V13 Focus Tier — helpers
// Build per-ticker history stats from closed trades with exit_ts < asOfTs.
// Shape matches what computeConvictionScore expects.
// ─────────────────────────────────────────────────────────────────────────
function _dayBucketTs(ts) {
  const d = new Date(Number(ts) || 0);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}
function _buildFocusHistoryStats(trades, asOfMs) {
  const out = new Map();
  if (!Array.isArray(trades)) return out;
  const recent30dMs = 30 * 24 * 60 * 60 * 1000;
  for (const t of trades) {
    if (!t) continue;
    const exitTs = Number(t.exit_ts || 0);
    if (!exitTs || exitTs >= asOfMs) continue;  // no lookahead
    const status = String(t.status || "").toUpperCase();
    if (status !== "WIN" && status !== "LOSS" && status !== "FLAT") continue;
    const tk = String(t.ticker || "").toUpperCase();
    if (!tk) continue;
    const pnl = Number(t.pnl_pct) || 0;
    let slot = out.get(tk);
    if (!slot) {
      slot = { n: 0, wins: 0, losses: 0, totalPnl: 0, recent30d: { n: 0, wins: 0, losses: 0, totalPnl: 0 } };
      out.set(tk, slot);
    }
    slot.n++;
    slot.totalPnl += pnl;
    if (status === "WIN") slot.wins++;
    else if (status === "LOSS") slot.losses++;
    if (asOfMs - exitTs <= recent30dMs) {
      slot.recent30d.n++;
      slot.recent30d.totalPnl += pnl;
      if (status === "WIN") slot.recent30d.wins++;
      else if (status === "LOSS") slot.recent30d.losses++;
    }
  }
  return out;
}

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
  // Phase D analyzer: per-bar block trace. Accumulated across all ticker
  // batches in a fullDay call so the caller gets one consolidated array.
  // Capped to avoid pathological responses; 50k bars is ~24 tickers ×
  // 79 intervals × 22 trading days = 41.7k, one month of output.
  const dayBlockChainBars = blockChainTrace ? [] : null;
  const BLOCK_CHAIN_CAP = 100000;

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
    const blockChainBars = blockChainTrace ? [] : null;
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
                  // Phase-E 2026-04-19: SPY daily structure (D21/D48/D200 +
                  // slopes + bull/bear stack). Consumed by tt-core-entry
                  // gates that relax on bearish market regime (shorts) or
                  // tighten in counter-regime context (longs).
                  spy_daily_structure: rSpyData.daily_structure || null,
                }
              : null;
            const sectorEtfs = require("./sector-mapping.js").SECTOR_ETF_MAP || {};
            const sectorRatings = require("./sector-mapping.js").SECTOR_RATINGS || {};
            const rSectorETF = sectorEtfs[sector];
            const rSectorData = rSectorETF ? stateMap[rSectorETF] : null;
            const rSecRegime = rSectorData?.regime_class ? { regime: rSectorData.regime_class, score: rSectorData.regime_score || 0 } : null;

            // Phase-H.3 2026-04-20: derive monthlyCycle label from SPY's daily
            // ema regime + htf score. Matches the logic used by
            // scripts/build-monthly-backdrop.js (joint EMA(20) daily + 4H bias),
            // computed live from the replay state rather than loading the JSON.
            //
            //   ema_regime_daily >=  2  OR   htf >= +15  -> "uptrend"
            //   ema_regime_daily <= -2  OR   htf <= -15  -> "downtrend"
            //   otherwise                                -> "transitional"
            let _monthlyCycle = null;
            if (rSpyData) {
              const _edr = Number(rSpyData.ema_regime_daily) || 0;
              const _htf = Number(rSpyData.htf_score) || 0;
              if (_edr >= 2 || _htf >= 15) _monthlyCycle = "uptrend";
              else if (_edr <= -2 || _htf <= -15) _monthlyCycle = "downtrend";
              else _monthlyCycle = "transitional";
            }
            // Also attach ticker's sector rating so consensus gate can read it
            // without needing SECTOR_RATINGS in trade-context.
            const tickerSectorRating = sectorRatings[sector];
            if (tickerSectorRating?.rating) {
              result._sector_rating = tickerSectorRating.rating;
            }
            result._cohort = (() => {
              const _cohorts = replayEnv._deepAuditConfig || {};
              const _idxT = String(_cohorts.deep_audit_cohort_index_etf_tickers || "").split(",").map(s => s.trim()).filter(Boolean);
              if (_idxT.includes(ticker)) return "index_etf";
              const _mcT = String(_cohorts.deep_audit_cohort_megacap_tickers || "").split(",").map(s => s.trim()).filter(Boolean);
              if (_mcT.includes(ticker)) return "megacap";
              const _indT = String(_cohorts.deep_audit_cohort_industrial_tickers || "").split(",").map(s => s.trim()).filter(Boolean);
              if (_indT.includes(ticker)) return "industrial";
              const _specT = String(_cohorts.deep_audit_cohort_speculative_tickers || "").split(",").map(s => s.trim()).filter(Boolean);
              if (_specT.includes(ticker)) return "speculative";
              return sector?.toLowerCase() || "unknown";
            })();

            // Phase-I.1 — recent trades for this ticker (for re-entry throttle
            // + duplicate-open guard). Include the last 10 trades (open + closed)
            // on this ticker so the entry pipeline can reject same-direction
            // duplicates and enforce a cooldown after recent exits.
            const _recentTickerTrades = replayCtx.allTrades
              .filter(t => String(t?.ticker || "").toUpperCase() === ticker)
              .sort((a, b) => (Number(b?.entry_ts) || 0) - (Number(a?.entry_ts) || 0))
              .slice(0, 10)
              .map(t => ({
                ticker: t?.ticker || null,
                direction: t?.direction || null,
                entry_ts: Number(t?.entry_ts) || null,
                exit_ts: Number(t?.exit_ts) || null,
                entry_price: Number(t?.entry_price) || null,
                status: t?.status || null,
                pnl_pct: Number(t?.pnl_pct) || null,
              }));

            // V13 Focus Tier — per-day history stats on replayCtx (rebuilt
            // at each day's first bar; reused across all bars of that day
            // for ALL tickers). Only includes trades with exit_ts <
            // asOfTs — backtest-safe, no lookahead.
            if (!replayCtx._focusHistoryStatsTs || replayCtx._focusHistoryStatsTs !== _dayBucketTs(intervalTs)) {
              replayCtx._focusHistoryStats = _buildFocusHistoryStats(
                replayCtx.allTrades,
                intervalTs,
              );
              replayCtx._focusHistoryStatsTs = _dayBucketTs(intervalTs);
            }

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
              _monthlyCycle,
              _recentTickerTrades,
              _focusHistoryStats: replayCtx._focusHistoryStats,
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
          // V13 data capture: always force trace during scoring when
          // deep_audit_rank_trace_on_entry_always is true, so every
          // potential-entry bar carries its rank breakdown into
          // processTradeSimulation / entry creation. No-op when the DA
          // key is false.
          const _traceAlwaysScoring = String(
            result?._env?._deepAuditConfig?.deep_audit_rank_trace_on_entry_always ?? "false",
          ) === "true";
          if (_traceAlwaysScoring) result.__rank_trace_force = true;
          result.rank = computeRank(result);
          result.score = result.rank;
          if (_traceAlwaysScoring) delete result.__rank_trace_force;
          if (result.__rank_trace) {
            // Serialize proactively so downstream (processTradeSimulation
            // + d1UpsertTrade) sees the JSON without re-running JSON.stringify.
            result.__rank_trace_json = JSON.stringify(result.__rank_trace);
          }
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
              if (blockChainBars && blockChainBars.length < BLOCK_CHAIN_CAP) {
                const ds = result?.daily_structure || null;
                blockChainBars.push({
                  ticker,
                  ts: intervalTs,
                  reason: diagEntry.reason,
                  kanban_stage: stage,
                  state: result.state,
                  score: Number.isFinite(Number(result?.score)) ? Number(result.score) : null,
                  rank: Number.isFinite(Number(result?.rank)) ? Number(result.rank) : null,
                  htf_score: Number.isFinite(Number(result?.htf_score)) ? Number(result.htf_score) : null,
                  ltf_score: Number.isFinite(Number(result?.ltf_score)) ? Number(result.ltf_score) : null,
                  // Phase-E: daily structure snapshot for diagnosing why
                  // the index-ETF swing trigger and D-EMA gates fire or
                  // don't fire on specific bars.
                  daily_structure: ds ? {
                    px: ds.px,
                    e21: ds.e21,
                    e48: ds.e48,
                    e200: ds.e200,
                    pct_above_e48: ds.pct_above_e48,
                    pct_above_e21: ds.pct_above_e21,
                    e21_slope_5d_pct: ds.e21_slope_5d_pct,
                    e48_slope_10d_pct: ds.e48_slope_10d_pct,
                    bull_stack: ds.bull_stack,
                    bear_stack: ds.bear_stack,
                    above_e200: ds.above_e200,
                  } : null,
                  // V15 (2026-04-25) — index-ETF swing trigger trace if computed.
                  // Captures every condition's actual value vs band so we can
                  // see which threshold(s) need calibration.
                  index_etf_swing_diag: result?.__index_etf_swing_diag || null,
                });
              }
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

            // V11 rank integrity audit (2026-04-22): when the bar is in an
            // enter-now / enter stage and rank-trace-force is enabled via
            // DA key, recompute rank with the trace flag set so the trade
            // record carries the full component breakdown.
            //
            // V12 P2 extension: the `deep_audit_rank_trace_on_entry_always`
            // DA key forces trace on EVERY bar that could become an entry,
            // removing the gate on `stageReady`. Needed because trades
            // sometimes transition through stages that aren't in our
            // enter-now list but still fire entries downstream.
            //
            // V13: also triggered for ALL stages when on_entry_always is
            // set, ensuring every entry ends up with a rank breakdown in
            // D1 for calibration.
            const _rtfEnabled = String(
              result?._env?._deepAuditConfig?.deep_audit_rank_trace_force_enabled ?? "false",
            ) === "true";
            const _traceAlways = String(
              result?._env?._deepAuditConfig?.deep_audit_rank_trace_on_entry_always ?? "false",
            ) === "true";
            const _stageReady = ["enter_now", "enter", "setup", "in_review", "hold", "defend"]
              .includes(String(finalStage || "").toLowerCase());
            if ((_rtfEnabled && _stageReady) || _traceAlways) {
              try {
                result.__rank_trace_force = true;
                delete result.__rank_trace;
                const _newRank = computeRank(result);
                result.rank = _newRank;
                result.score = _newRank;
                // Make the trace discoverable to processTradeSimulation so
                // it flows onto the trade record.
                if (result.__rank_trace) {
                  result.__rank_trace_json = JSON.stringify(result.__rank_trace);
                }
              } catch (e) {
                console.warn(`[RANK-TRACE-FORCE] ${ticker} ${intervalTs}: ${String(e?.message || e).slice(0, 120)}`);
              } finally {
                delete result.__rank_trace_force;
              }
            }

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
        // Phase-G (2026-04-20): persist a slim forensics payload on every
        // trail row so per-trade reconstruction (ATR Levels, MTF
        // indicators, cohort context) is possible without a re-run.
        // Full tickerData is too large; extract the forensics-relevant
        // subset only — still tiny per row (~2-3 KB) but captures
        // everything the per-trade analyzer needs.
        const buildForensicsPayload = (r) => {
          if (!r || typeof r !== "object") return null;
          try {
            const tfTechCondensed = {};
            if (r.tf_tech && typeof r.tf_tech === "object") {
              for (const [tf, bundle] of Object.entries(r.tf_tech)) {
                if (!bundle || typeof bundle !== "object") continue;
                tfTechCondensed[tf] = {
                  stDir: bundle.stDir ?? null,
                  stSlope: bundle.stSlope ?? null,
                  rsi: bundle?.rsi?.r5 ?? null,
                  ema_depth: bundle?.ema?.depth ?? null,
                  ema_structure: bundle?.ema?.structure ?? null,
                  ema_momentum: bundle?.ema?.momentum ?? null,
                  price_above_ema21: bundle?.ema?.priceAboveEma21 ?? null,
                  phase_v: bundle?.ph?.v ?? null,
                  phase_zone: bundle?.ph?.z ?? null,
                  saty_v: bundle?.saty?.v ?? null,
                  saty_zone: bundle?.saty?.z ?? null,
                  ripster_c8_9: bundle?.ripster?.c8_9
                    ? { above: !!bundle.ripster.c8_9.above, below: !!bundle.ripster.c8_9.below, inCloud: !!bundle.ripster.c8_9.inCloud }
                    : null,
                  ripster_c5_12: bundle?.ripster?.c5_12
                    ? { above: !!bundle.ripster.c5_12.above, below: !!bundle.ripster.c5_12.below, inCloud: !!bundle.ripster.c5_12.inCloud }
                    : null,
                };
              }
            }
            return {
              ticker: r.ticker,
              ts: r.ts,
              price: r.price,
              state: r.state,
              score: r.score ?? r.rank ?? null,
              rank: r.rank ?? null,
              kanban_stage: r.kanban_stage,
              daily_structure: r.daily_structure || null,
              atr_levels: r.atr_levels || null,
              ema_map: r.ema_map || null,
              pdz_zone_D: r.pdz_zone_D ?? null,
              pdz_pct_D: r.pdz_pct_D ?? null,
              fvg_D: r.fvg_D || null,
              liq_D: r.liq_D || null,
              ema_regime_daily: r.ema_regime_daily ?? null,
              ema_regime_4h: r.ema_regime_4h ?? null,
              ema_regime_1h: r.ema_regime_1h ?? null,
              st_bars_since_flip_D: r.st_bars_since_flip_D ?? null,
              rvol_map: r.rvol_map || null,
              fuel: r.fuel || null,
              entry_path: r.__entry_path || null,
              entry_reason: r.__entry_reason || null,
              entry_block_reason: r.__entry_block_reason || null,
              tf_tech: tfTechCondensed,
              flags: r.flags || {},
              regime_class: r.regime_class ?? null,
              regime_score: r.regime_score ?? null,
            };
          } catch {
            return null;
          }
        };
        for (const { ticker: t, result: r } of pendingTrail) {
          const ts = Number(r?.ts);
          if (!Number.isFinite(ts)) continue;
          const flagsJson = r?.flags ? JSON.stringify(r.flags) : null;
          // Phase-I (2026-04-22): only build + persist the ~2-3 KB forensics
          // payload when explicitly requested (trailForensics=1). Drops D1
          // growth per backtest from ~1.5-2 GB to ~50 MB. Slim fields below
          // still flow. See tasks/d1-storage-reduction-plan-2026-04-22.md
          const payloadJson = trailForensics
            ? (() => {
                const obj = buildForensicsPayload(r);
                return obj ? JSON.stringify(obj) : null;
              })()
            : null;
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
              payloadJson,
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
            if (replayRunId && !trade.run_id) trade.run_id = replayRunId;
            await d1UpsertTrade(env, trade).catch(() => {});
          }
          if (replayRunId) {
            await d1StampRunIdForTrades(
              env,
              replayRunId,
              batchTrades.map((t) => t?.trade_id || t?.id || null),
            );
          }
        } catch (e) {
          errors.push({ ticker: "TRADES_D1_SYNC", error: String(e?.message || e).slice(0, 150) });
        }

        if (replayRunId) {
          try {
            for (const trade of batchTrades) {
              await d1ArchiveRunTrade(env, replayRunId, trade).catch(() => {});
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
          } catch (error) {
            console.warn(
              `[REPLAY] d1InsertPosition failed during open-position sync: ${String(error?.message || error).slice(0, 200)}`
            );
          }
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
          } catch (error) {
            console.warn(
              `[REPLAY] daystate sector KV read failed for ${sym}: ${String(error?.message || error).slice(0, 200)}`
            );
          }
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
      if (dayBlockChainBars && blockChainBars) {
        const room = Math.max(0, BLOCK_CHAIN_CAP - dayBlockChainBars.length);
        if (room > 0) {
          dayBlockChainBars.push(...blockChainBars.slice(0, room));
        }
      }
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
      blockChainBars: blockChainTrace
        ? (fullDay ? (dayBlockChainBars || []) : (blockChainBars || []))
        : undefined,
      blockChainCap: blockChainTrace ? BLOCK_CHAIN_CAP : undefined,
      fullDay: !!fullDay,
    }, 200, corsHeaders(env, req));
  }
}

function _hasTdMinimum(candles) {
  return Array.isArray(candles) && candles.length >= 14;
}
