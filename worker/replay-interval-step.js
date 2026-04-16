export function createIntervalReplayStep(deps = {}) {
  const {
    sendJSON,
    corsHeaders,
    kvPutJSON,
    REPLAY_TRADES_KV_KEY,
    loadRunManifest,
    buildReplayTradeScope,
    loadReplayRuntimeConfig,
    applyReplayRuntimeCaches,
    loadReplayTickerProfiles,
    isRunManifestCleanLane,
    loadReplayScopedTrades,
    kvGetJSON,
    d1EnsureBacktestRunsSchema,
    sanitizeReplayTradesForScope,
    d1GetCandlesAllTfs,
    loadReplayTickerState,
    normalizeLearnedTickerProfile,
    computeServerSideScores,
    computeRank,
    computeRR,
    computeRRWarning,
    computeMoveStatus,
    qualifiesForEnter,
    classifyKanbanStage,
    sideFromStateOrScores,
    deriveKanbanMeta,
    processTradeSimulation,
    slimPayloadForD1,
    minimalPayloadForD1,
    d1UpsertTrade,
    d1StampRunIdForTrades,
    d1ArchiveRunTrade,
    clearReplayRunningMarker,
    runInvestorDailyReplay,
    snapshotBothPortfolios,
    _semanticToleranceOptions,
    _parseJsonObjectMaybe,
    _criteriaFingerprintCompare,
    _runtimeCriteriaFingerprintFromTrade,
    isoToMs,
    isOpenTradeStatus,
    nyWallTimeToUtcMs,
    normalizeTfKey,
    SECTOR_MAP,
  } = deps;

  return async function runIntervalReplayStepImpl({ req, env, url }) {
    try {
      const db = env?.DB;
      const KV = env?.KV;
      if (!db) return sendJSON({ ok: false, error: "no_db_binding" }, 500, corsHeaders(env, req));

      const dateParam = url.searchParams.get("date");
      if (!dateParam || !/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
        return sendJSON({ ok: false, error: "date param required (YYYY-MM-DD)" }, 400, corsHeaders(env, req));
      }
      const intervalIdx = Number(url.searchParams.get("interval"));
      if (!Number.isFinite(intervalIdx) || intervalIdx < 0) {
        return sendJSON({ ok: false, error: "interval param required (0-based index)" }, 400, corsHeaders(env, req));
      }

      const intervalMinutes = Math.max(1, Math.min(30, Number(url.searchParams.get("intervalMinutes")) || 5));
      const cleanSlate = url.searchParams.get("cleanSlate") === "1";
      const freshRun = url.searchParams.get("freshRun") === "1";
      const disableReferenceExecution = url.searchParams.get("disableReferenceExecution") === "1"
        || (url.searchParams.get("enableReferenceExecution") !== "1" && cleanSlate);
      const skipInvestor = url.searchParams.get("skipInvestor") === "1" || url.searchParams.get("traderOnly") === "1";
      const endOfDay = url.searchParams.get("endOfDay") === "1";
      const tickerFilter = url.searchParams.get("tickers");

      const replayEnv = { ...env, _isReplay: true };
      for (const overrideKey of ["LEADING_LTF", "TT_EXIT_DEBOUNCE_BARS", "TT_TUNE_V2", "RIPSTER_TUNE_V2", "ENTRY_ENGINE", "MANAGEMENT_ENGINE"]) {
        const ov = url.searchParams.get(overrideKey);
        if (ov != null && ov !== "") replayEnv[overrideKey] = ov;
      }
      const replayLeadingLtf = normalizeTfKey(replayEnv.LEADING_LTF || "10") || "10";

      let allTickers;
      if (tickerFilter) {
        allTickers = tickerFilter.split(",").map((t) => t.trim().toUpperCase()).filter(Boolean);
      } else {
        allTickers = Object.keys(SECTOR_MAP);
      }
      const spyIdx = allTickers.indexOf("SPY");
      if (spyIdx > 0) {
        allTickers.splice(spyIdx, 1);
        allTickers.unshift("SPY");
      }

      const marketOpenMs = nyWallTimeToUtcMs(dateParam, 9, 30, 0);
      const marketCloseMs = nyWallTimeToUtcMs(dateParam, 16, 0, 0);
      if (!marketOpenMs || !marketCloseMs) {
        return sendJSON({ ok: false, error: "failed_to_compute_market_hours" }, 500, corsHeaders(env, req));
      }

      const intervalMs = intervalMinutes * 60 * 1000;
      const totalIntervals = Math.floor((marketCloseMs - marketOpenMs) / intervalMs) + 1;
      const intervalTs = marketOpenMs + (intervalIdx * intervalMs);
      if (intervalIdx >= totalIntervals) {
        return sendJSON({ ok: true, scored: 0, message: "interval_out_of_range", totalIntervals }, 200, corsHeaders(env, req));
      }

      if (cleanSlate && intervalIdx === 0) {
        await kvPutJSON(KV, "timed:trades:all", []);
        await kvPutJSON(KV, REPLAY_TRADES_KV_KEY, []);
        await kvPutJSON(KV, "timed:portfolio:v1", null);
        await kvPutJSON(KV, "timed:activity:feed", null);
        try {
          await db.batch([
            db.prepare("DELETE FROM trade_events"),
            db.prepare("DELETE FROM trades"),
          ]);
        } catch {}
        for (const tbl of ["positions", "execution_actions", "lots", "alerts", "ticker_latest", "account_ledger", "investor_positions", "investor_lots", "portfolio_snapshots", "timed_trail"]) {
          try { await db.prepare(`DELETE FROM ${tbl}`).run(); } catch {}
        }
        for (const ticker of allTickers) {
          try { await KV.delete(`timed:latest:${ticker}`); } catch {}
        }
      }

      await kvPutJSON(KV, "timed:replay:running", { since: Date.now(), date: dateParam, interval: intervalIdx, mode: "single_interval" });
      const replayLockVal = await KV.get("timed:replay:lock") || null;
      const replayManifest = replayLockVal ? await loadRunManifest(db, replayLockVal) : null;
      const replayTradeScope = buildReplayTradeScope(replayManifest);
      const {
        replayAdaptiveEntryGates: replayAdaptiveEntryGates,
        replayAdaptiveRegimeGates: replayAdaptiveRegimeGates,
        replayAdaptiveSLTP: replayAdaptiveSLTP,
        replayCalibratedSlAtr: replayCalibratedSlAtr,
        replayCalibratedRankMin: replayCalibratedRankMin,
        calibratedTPTiers,
        dynamicEngineRules,
        referenceExecutionMap,
        scenarioExecutionPolicy,
        goldenProfiles: replayGoldenProfiles,
      } = await loadReplayRuntimeConfig({
        db,
        KV,
        replayConfigRunHint: replayLockVal,
        replayEnv,
        logPrefix: "[INTERVAL REPLAY]",
        disableReferenceExecution,
      });
      applyReplayRuntimeCaches?.({
        calibratedTPTiers,
        dynamicEngineRules,
        referenceExecutionMap,
        scenarioExecutionPolicy,
      });
      replayEnv._deepAuditConfig = replayEnv._deepAuditConfig || {};

      const replayTickerProfiles = await loadReplayTickerProfiles(db, allTickers, { logPrefix: "[INTERVAL REPLAY]" });

      const intervalCleanSlate = cleanSlate && intervalIdx === 0;
      const cleanReplayLane = !!(freshRun || intervalCleanSlate || isRunManifestCleanLane(replayManifest));
      const { scopedTrades: initialIntervalReplayTrades } = await loadReplayScopedTrades({
        env,
        KV,
        db,
        replayLockVal,
        replayTradeScope,
        cleanReplayLane,
        resetTrades: intervalCleanSlate,
        logPrefix: "[REPLAY RESUME]",
        scopeDropLabel: `before ${dateParam} interval ${intervalIdx}`,
        deps: {
          kvGetJSON,
          kvPutJSON,
          d1EnsureBacktestRunsSchema,
          sanitizeReplayTradesForScope,
          REPLAY_TRADES_KV_KEY,
        },
      });
      const replayCtx = {
        allTrades: initialIntervalReplayTrades,
        execStates: new Map(),
        processDebug: [],
        _blockedEntries: {},
        _leadingLtf: replayLeadingLtf,
        replayTradeScope,
        strictSingleTickerPosition: cleanReplayLane,
      };

      const LIVE_TF_CONFIGS = [
        { tf: "W", limit: 100 }, { tf: "D", limit: 250 },
        { tf: "240", limit: 250 }, { tf: "60", limit: 150 },
        { tf: "30", limit: 100 }, { tf: "15", limit: 100 },
        { tf: "10", limit: 100 }, { tf: replayLeadingLtf, limit: 100 },
        { tf: "M", limit: 24 },
      ];

      let scored = 0, tradesCreated = 0, skipped = 0;
      const errors = [];
      const stageCounts = {};
      const blockReasons = {};
      const entryDiagnostics = {};
      const pendingTrail = [];
      const { SECTOR_ETF_MAP = {} } = require("./sector-mapping.js");

      const TICKER_BATCH_SIZE = 15;
      for (let batchStart = 0; batchStart < allTickers.length; batchStart += TICKER_BATCH_SIZE) {
        const batchTickers = allTickers.slice(batchStart, batchStart + TICKER_BATCH_SIZE);
        const batchPromises = batchTickers.map(async (ticker) => {
          try {
            let existing = await loadReplayTickerState({
              db,
              KV,
              ticker,
              logPrefix: "[INTERVAL REPLAY]",
              deps: { kvGetJSON },
            });

            const candleResult = await d1GetCandlesAllTfs(replayEnv, ticker, LIVE_TF_CONFIGS, { beforeTs: intervalTs });
            const getCandlesCached = async (_env, _ticker, tf, _limit) => {
              const tfKey = normalizeTfKey(tf);
              return candleResult[tfKey] || { ok: false, candles: [] };
            };

            if (replayTickerProfiles[ticker]) {
              existing._tickerProfile = normalizeLearnedTickerProfile(replayTickerProfiles[ticker], {
                ticker,
                source: "replay_d1_batch",
              });
            }

            const result = await computeServerSideScores(ticker, getCandlesCached, replayEnv, existing);
            if (!result) {
              skipped++;
              return;
            }

            result.ts = intervalTs;
            result.ingest_ts = intervalTs;
            result.data_source = "interval_replay";
            result.data_source_ts = intervalTs;
            result.trigger_ts = intervalTs;

            result.rank = computeRank(result);
            result.score = result.rank;
            result.rr = computeRR(result);
            if (result.rr != null && Number(result.rr) > 25) result.rr = 25;
            if (Number.isFinite(result.rr)) result.rr_warning = computeRRWarning(result.rr);
            result.move_status = computeMoveStatus(result);
            if (result.flags) {
              result.flags.move_invalidated = result.move_status?.status === "INVALIDATED";
              result.flags.move_completed = result.move_status?.status === "COMPLETED";
            }

            const tickerSector = SECTOR_MAP[ticker] || "Unknown";
            const rSpyData = await kvGetJSON(KV, "timed:latest:SPY");
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
            const rSectorETF = SECTOR_ETF_MAP[tickerSector];
            const rSectorData = rSectorETF ? (await kvGetJSON(KV, `timed:latest:${rSectorETF}`)) : null;
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
              _deepAuditConfig: replayEnv._deepAuditConfig || null,
              _leadingLtf: replayLeadingLtf,
              _universeSize: allTickers.length,
              _replayBlockedEntries: replayCtx._blockedEntries || null,
              _entryEngine: replayEnv.ENTRY_ENGINE || "tt_core",
              _managementEngine: replayEnv.MANAGEMENT_ENGINE || "tt_core",
              _referenceExecutionMap: referenceExecutionMap || null,
              _scenarioExecutionPolicy: scenarioExecutionPolicy || null,
              _ripsterTuneV2: replayEnv.RIPSTER_TUNE_V2 || "true",
              _ripsterExitDebounceBars: replayEnv.TT_EXIT_DEBOUNCE_BARS || "3",
            };

            try {
              const vixData = await kvGetJSON(KV, "timed:latest:VIX");
              if (vixData?.price) result._vix = Number(vixData.price);
            } catch {}

            if (existing?.entry_ts != null && result.entry_ts == null) result.entry_ts = existing.entry_ts;
            if (existing?.entry_price != null && result.entry_price == null) result.entry_price = existing.entry_price;
            if (existing?.kanban_cycle_enter_now_ts != null) result.kanban_cycle_enter_now_ts = existing.kanban_cycle_enter_now_ts;
            if (existing?.kanban_cycle_trigger_ts != null) result.kanban_cycle_trigger_ts = existing.kanban_cycle_trigger_ts;
            if (existing?.kanban_cycle_side != null) result.kanban_cycle_side = existing.kanban_cycle_side;

            const openTrade = replayCtx.allTrades.find((t) => String(t?.ticker || "").toUpperCase() === ticker && isOpenTradeStatus(t?.status)) || null;
            const prevStage = existing?.kanban_stage;
            const stage = classifyKanbanStage(result, openTrade, intervalTs);
            let finalStage = stage;

            if (["watch", "setup", "discovery", "in_review", "enter", "enter_now"].includes(stage) && result.state) {
              const diagEntry = qualifiesForEnter(result, intervalTs);
              if (!diagEntry.qualifies) {
                result.__entry_block_reason = diagEntry.reason;
                blockReasons[diagEntry.reason] = (blockReasons[diagEntry.reason] || 0) + 1;
                if (!entryDiagnostics[ticker]) {
                  entryDiagnostics[ticker] = {
                    qualifies: false,
                    reason: diagEntry.reason,
                    engine: diagEntry.engine || null,
                    path: diagEntry.path || null,
                    selectedEngine: diagEntry.selectedEngine || null,
                    engineSource: diagEntry.engineSource || null,
                    scenarioPolicySource: diagEntry?.scenarioPolicy?.source || result?.__scenario_policy?.source || null,
                    scenarioPolicyMatch: diagEntry?.scenarioPolicy?.match || result?.__scenario_policy?.match || null,
                    scenarioExitStyle: diagEntry?.scenarioPolicy?.recommend?.exit_style || result?.__scenario_policy?.recommend?.exit_style || null,
                    ripster_bias: diagEntry.ripster_bias || null,
                    metadata: diagEntry.metadata || null,
                  };
                }
              } else {
                delete result.__entry_block_reason;
                if (!entryDiagnostics[ticker]) {
                  entryDiagnostics[ticker] = {
                    qualifies: true,
                    reason: diagEntry.reason || null,
                    engine: diagEntry.engine || null,
                    path: diagEntry.path || null,
                    selectedEngine: diagEntry.selectedEngine || null,
                    engineSource: diagEntry.engineSource || null,
                    scenarioPolicySource: diagEntry?.scenarioPolicy?.source || result?.__scenario_policy?.source || null,
                    scenarioPolicyMatch: diagEntry?.scenarioPolicy?.match || result?.__scenario_policy?.match || null,
                    scenarioExitStyle: diagEntry?.scenarioPolicy?.recommend?.exit_style || result?.__scenario_policy?.recommend?.exit_style || null,
                    metadata: diagEntry.metadata || null,
                  };
                }
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
              const price = Number(result?.price);
              if (Number.isFinite(price) && price > 0) {
                result.entry_price = price;
                result.entry_ts = intervalTs;
              }
            }
            if (!isNewEntry && finalStage && existing?.entry_price && result.entry_price == null) {
              result.entry_price = existing.entry_price;
              result.entry_ts = existing.entry_ts;
            }

            if (prevStage && finalStage && String(prevStage) !== String(finalStage)) {
              result.prev_kanban_stage = String(prevStage);
              result.prev_kanban_stage_ts = intervalTs;
            }
            result.kanban_stage = finalStage;
            result.kanban_meta = deriveKanbanMeta(result, finalStage);
            stageCounts[finalStage || "null"] = (stageCounts[finalStage || "null"] || 0) + 1;

            {
              const simEnv = { ...replayEnv, DISCORD_ENABLE: "false", DISCORD_WEBHOOK_URL: null, EMAIL_ENABLED: "false", SENDGRID_API_KEY: null };
              const countBefore = replayCtx.allTrades.filter((x) => String(x?.ticker).toUpperCase() === ticker).length;
              await processTradeSimulation(KV, ticker, result, existing, simEnv, {
                forceUseIngestTs: true,
                replayBatchContext: replayCtx,
                asOfTs: intervalTs,
              });
              const countAfter = replayCtx.allTrades.filter((x) => String(x?.ticker).toUpperCase() === ticker).length;
              if (countAfter > countBefore) tradesCreated += countAfter - countBefore;
            }

            await kvPutJSON(KV, `timed:latest:${ticker}`, result);
            pendingTrail.push({ ticker, result: { ...result } });
            scored++;
          } catch (e) {
            errors.push({ ticker, ts: intervalTs, error: String(e?.message || e).slice(0, 150) });
          }
        });
        await Promise.all(batchPromises);
      }

      let trailWritten = 0;
      if (pendingTrail.length > 0 && db) {
        try {
          const trailStmts = pendingTrail.map(({ ticker: t, result: r }) => {
            const ts = Number(r?.ts);
            if (!Number.isFinite(ts)) return null;
            const flagsJson = r?.flags ? JSON.stringify(r.flags) : null;
            return db.prepare(
              `INSERT OR REPLACE INTO timed_trail (ticker, ts, price, htf_score, ltf_score, completion, phase_pct, state, rank, flags_json, trigger_reason, trigger_dir, kanban_stage, payload_json)
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
            );
          }).filter(Boolean);
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
      {
        const stateStmts = [];
        for (const { ticker, result: s } of pendingTrail) {
          try {
            let slim = slimPayloadForD1(s);
            let json = JSON.stringify(slim);
            if (json.length > 50000) {
              slim = minimalPayloadForD1(s);
              json = JSON.stringify(slim);
            }
            if (json.length > 50000) continue;
            const ts = Number(s?.ts) || Date.now();
            stateStmts.push(
              db.prepare(
                `INSERT INTO ticker_latest (ticker, ts, updated_at, kanban_stage, prev_kanban_stage, payload_json)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(ticker) DO UPDATE SET
                 ts=excluded.ts, updated_at=excluded.updated_at, kanban_stage=excluded.kanban_stage,
                 prev_kanban_stage=excluded.prev_kanban_stage, payload_json=excluded.payload_json`
              ).bind(ticker.toUpperCase(), ts, Date.now(), s?.kanban_stage ?? null, s?.prev_kanban_stage ?? null, json)
            );
          } catch {}
        }
        const D1_BATCH_MAX = 100;
        for (let i = 0; i < stateStmts.length; i += D1_BATCH_MAX) {
          try {
            await db.batch(stateStmts.slice(i, i + D1_BATCH_MAX));
            d1StateWritten += Math.min(D1_BATCH_MAX, stateStmts.length - i);
          } catch {}
        }
      }

      replayCtx.allTrades = sanitizeReplayTradesForScope(replayCtx.allTrades, replayTradeScope);
      try { await kvPutJSON(KV, REPLAY_TRADES_KV_KEY, replayCtx.allTrades); } catch {}
      if (db) {
        for (const trade of replayCtx.allTrades) {
          try {
            if (replayLockVal && !trade.run_id) trade.run_id = replayLockVal;
            await d1UpsertTrade(env, trade).catch(() => {});
          } catch {}
        }
        if (replayLockVal) {
          await d1StampRunIdForTrades(
            env,
            replayLockVal,
            replayCtx.allTrades.map((t) => t?.trade_id || t?.id || null),
          );
          for (const trade of replayCtx.allTrades) {
            try { await d1ArchiveRunTrade(env, replayLockVal, trade).catch(() => {}); } catch {}
          }
        }
      }

      if (endOfDay) {
        await clearReplayRunningMarker(KV);
        if (!skipInvestor) {
          try {
            const invResult = await runInvestorDailyReplay(env, KV, replayCtx, dateParam);
            if (invResult?.opened || invResult?.closed) console.log(`[INTERVAL_REPLAY] Investor: +${invResult.opened} -${invResult.closed}`);
          } catch {}
          try { await snapshotBothPortfolios(env, KV, replayCtx, dateParam); } catch {}
        }
      }

      const referenceDriftEvents = (() => {
        const map = replayEnv?._referenceExecutionMap;
        const driftSemantic = _semanticToleranceOptions(map, "drift");
        const exact = Array.isArray(map?.exact_reference_entries) ? map.exact_reference_entries : [];
        if (!exact.length) return [];
        const expected = [];
        for (const e of exact) {
          const refTs = Number(e?.entry_ts);
          const tolMs = Math.max(60_000, (Number(e?.tolerance_minutes) || 20) * 60_000);
          const ticker = String(e?.ticker || "").toUpperCase();
          if (!ticker || !Number.isFinite(refTs)) continue;
          if (tickerFilter && !allTickers.includes(ticker)) continue;
          if (Math.abs(intervalTs - refTs) > tolMs) continue;
          expected.push({
            ticker,
            refTs,
            tolMs,
            trade_id: e?.trade_id || null,
            run_id: e?.run_id || null,
            entry_path_expected: e?.entry_path_expected || null,
            engine_source_expected: e?.engine_source_expected || null,
            scenario_policy_source_expected: e?.scenario_policy_source_expected || null,
            criteria_fingerprint: (e?.criteria_fingerprint && typeof e.criteria_fingerprint === "object") ? e.criteria_fingerprint : null,
          });
        }
        const events = [];
        for (const ex of expected) {
          const matchedTrade = (replayCtx.allTrades || []).find((t) => {
            if (String(t?.ticker || "").toUpperCase() !== ex.ticker) return false;
            const ets = Number(t?.entry_ts || t?.entryTs || isoToMs(t?.entryTime));
            return Number.isFinite(ets) && Math.abs(ets - ex.refTs) <= ex.tolMs;
          }) || null;
          const diag = entryDiagnostics?.[ex.ticker] || null;
          const snap = _parseJsonObjectMaybe(matchedTrade?.signal_snapshot_json);
          const lineage = snap?.lineage && typeof snap.lineage === "object" ? snap.lineage : {};
          const runtimeEntryPath = matchedTrade?.entry_path || lineage?.entry_path || diag?.path || null;
          const runtimeEngineSource = lineage?.engine_source || diag?.engineSource || null;
          const runtimeScenarioPolicySource = lineage?.scenario_policy_source || diag?.scenarioPolicySource || null;

          const semanticMismatches = [];
          const mismatchSeen = new Set();
          const pushMismatch = (field, expectedVal, actualVal) => {
            const key = `${String(field)}|${String(expectedVal)}|${String(actualVal)}`;
            if (mismatchSeen.has(key)) return;
            mismatchSeen.add(key);
            semanticMismatches.push({
              field,
              expected: expectedVal,
              actual: actualVal == null ? null : actualVal,
            });
          };
          const eqNorm = (a, b) => String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
          const driftHasPath = (p) => Array.isArray(driftSemantic?.comparePaths) && driftSemantic.comparePaths.includes(String(p));
          if (matchedTrade) {
            if (driftSemantic.enabled && driftHasPath("entry_path") && ex.entry_path_expected && !eqNorm(runtimeEntryPath, ex.entry_path_expected)) {
              pushMismatch("entry_path", ex.entry_path_expected, runtimeEntryPath || null);
            }
            if (driftSemantic.enabled && driftHasPath("engine_source") && ex.engine_source_expected && !eqNorm(runtimeEngineSource, ex.engine_source_expected)) {
              pushMismatch("engine_source", ex.engine_source_expected, runtimeEngineSource || null);
            }
            if (driftSemantic.enabled && driftHasPath("scenario_policy_source") && ex.scenario_policy_source_expected && !eqNorm(runtimeScenarioPolicySource, ex.scenario_policy_source_expected)) {
              pushMismatch("scenario_policy_source", ex.scenario_policy_source_expected, runtimeScenarioPolicySource || null);
            }
            const fpCmp = _criteriaFingerprintCompare(
              ex.criteria_fingerprint,
              _runtimeCriteriaFingerprintFromTrade(matchedTrade, diag),
              {
                strictMissing: driftSemantic.strictMissing,
                ignoreUnknownExpected: driftSemantic.ignoreUnknownExpected,
                paths: driftSemantic.comparePaths,
                requiredPaths: driftSemantic.requiredPaths,
              },
            );
            if (driftSemantic.enabled && fpCmp.available && fpCmp.mismatches.length > driftSemantic.maxMismatches) {
              for (const mm of fpCmp.mismatches) pushMismatch(mm?.field || "unknown", mm?.expected ?? null, mm?.actual ?? null);
            }
          }
          events.push({
            ticker: ex.ticker,
            reference_entry_ts: ex.refTs,
            matched: !!matchedTrade,
            semantic_matched: !!matchedTrade && semanticMismatches.length === 0,
            matched_trade_id: matchedTrade?.id || matchedTrade?.trade_id || null,
            entry_engine: diag?.engine || null,
            block_reason: !matchedTrade ? (diag?.reason || "no_entry") : null,
            expected_entry_path: ex.entry_path_expected || null,
            actual_entry_path: runtimeEntryPath || null,
            expected_engine_source: ex.engine_source_expected || null,
            actual_engine_source: runtimeEngineSource || null,
            expected_scenario_policy_source: ex.scenario_policy_source_expected || null,
            actual_scenario_policy_source: runtimeScenarioPolicySource || null,
            criteria_fingerprint_expected: ex.criteria_fingerprint || null,
            criteria_fingerprint_actual: matchedTrade ? _runtimeCriteriaFingerprintFromTrade(matchedTrade, diag) : null,
            semantic_mismatch_reasons: semanticMismatches,
            reference_trade_id: ex.trade_id,
            reference_run_id: ex.run_id,
          });
        }
        return events;
      })();

      return sendJSON({
        ok: true,
        date: dateParam,
        interval: intervalIdx,
        intervalTs,
        totalIntervals,
        tickersProcessed: allTickers.length,
        scored,
        skipped,
        tradesCreated,
        totalTrades: replayCtx.allTrades.length,
        errorsCount: errors.length,
        errors: errors.slice(0, 10),
        stageCounts,
        blockReasons,
        d1StateWritten,
        trailWritten,
        processDebug: replayCtx?.processDebug?.slice(0, 40) || [],
        blockedEntryGates: replayCtx?._blockedEntries || {},
        entryDiagnostics,
        referenceDrift: {
          expected: referenceDriftEvents.length,
          matched: referenceDriftEvents.filter((e) => e.matched).length,
          missed: referenceDriftEvents.filter((e) => !e.matched).length,
          semantic_matched: referenceDriftEvents.filter((e) => e.semantic_matched).length,
          semantic_mismatched: referenceDriftEvents.filter((e) => e.matched && !e.semantic_matched).length,
          events: referenceDriftEvents.slice(0, 25),
        },
      }, 200, corsHeaders(env, req));
    } catch (intervalReplayErr) {
      console.error(
        "[INTERVAL_REPLAY] Handler error:",
        String(intervalReplayErr?.message || intervalReplayErr).slice(0, 500),
        intervalReplayErr?.stack?.slice(0, 500),
      );
      return sendJSON({
        ok: false,
        error: "interval_replay_error",
        detail: String(intervalReplayErr?.message || intervalReplayErr).slice(0, 300),
      }, 500, corsHeaders(env, req));
    }
  };
}
