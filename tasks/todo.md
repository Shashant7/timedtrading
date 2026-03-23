# Current Tasks

> **Plan:** See `tasks/PLAN.md` for consolidated status, phases, and clear next steps.

## Paragon Run Audit + Relaunch [2026-03-22]
- [x] Forensic audit: identify exact JUL→AUG archived run with full per-trade annotations/classifications and verify annotation count mismatch root cause
- [x] Cross-run comparison: include both `15m-calibration-only-jul1-mar4` runs and rank best engine/path/regime combos by win quality (high MFE, low MAE, trend hold)
- [x] Produce "Paragon" model_config + dynamic engine profile from archived evidence (run-scoped, replay-safe)
- [ ] Launch clean full backtest with paragon config and monitor to stable progression/completion
- [ ] Write summary + operator notes to `tasks/lessons.md` and `CONTEXT.md` if new pitfalls are discovered

## Reference-Trade Intelligence Roadmap Execution [2026-03-22]
- [x] Phase 0: Publish contracts (`reference-intel`, scoring rubric, gates, parity, proof, context-intel)
- [x] Phase 1: Implement canonical full-history dataset builder (`scripts/reference-intel-build.py`)
- [x] Phase 1: Generate initial artifacts (`trade-intel-canonical-v1.jsonl`, summary, lineage-quality audit)
- [x] Phase 2: Implement hybrid reference trade selector and first ranked output
- [x] Phase 3: Generate first coverage map + scenario gap report
- [x] Phase 3b: Build context-intel snapshot v1 (ticker profile + Daily Brief + SPY/QQQ hyper state)
- [x] Phase 4: Build journey blueprint extraction clusters from selected references
- [x] Phase 5: Generate first versioned dynamic policy artifact from blueprint clusters
- [x] Phase 6: Run first strict gate evaluation artifact (`data/reference-intel/validation-gates-v1.json`)
- [x] Phase 7: Publish first promotion-readiness report (`data/reference-intel/promotion-report-v1.md`)
- [x] Phase 8: Seed drift monitoring artifact (`data/reference-intel/drift-monitor-v1.json`)
- [x] Phase 5b: Build CIO feature pack + eval loop artifacts (`cio-memory-features-v1.json`, `cio-eval-loop-v1.json`) and integration doc
- [x] Phase 5c: Wire feature-flagged CIO reference priors into live/replay CIO memory cache (`ai_cio_reference_enabled`)
- [x] Add hard go/no-go promotion checklist (`docs/promotion-checklist-v1.md`)
- [x] Phase 7b: Run first control-vs-candidate behavioral validation matrix (`validation-matrix-v1.json`, `validation-go-no-go-v1.json`, `cio-validation-v1.json`)
- [x] Phase 10: Implement refresh automation loop (`scripts/reference-intel-refresh.py`) with drift + CIO drift + revalidation trigger artifact
- [x] Phase 10: Add CIO drift monitor (`scripts/cio-drift-monitor.py`) and generate `data/reference-intel/cio-drift-monitor-v1.json`
- [x] Phase 10: Run first automated refresh cycle with trigger output (`data/reference-intel/revalidation-trigger-v1.json`)

## Reference Execution Mapping + Drift Guard [2026-03-23]
- [x] Build cross-run coverage artifact by ticker/date-range with entry/exit engine + model_config lineage
- [x] Generate runtime reference execution map (ticker+date-range primary, date-bucket fallback)
- [x] Wire runtime map into engine resolution for replay/live scoring
- [x] Capture reference parity drift during backtests (expected-vs-actual reference entries)
- [x] Expose drift summary artifact and run-level diagnostics for operator review

## Scenario Policy V1 (Context + Volatility + Setup) [2026-03-23]
- [x] Build scenario policy artifact from reference trades (`ticker + setup + regime + vol + context`)
- [x] Apply policy to `model_config` as runtime memory (`scenario_execution_policy`)
- [x] Wire runtime scenario resolution during in-review and persist on trade lineage
- [x] Apply scenario-guided SL/TP multipliers and management style (`tp_full_bias` vs `smart_exit_bias`)
- [x] Add replay diagnostics for scenario-policy match/miss and blocker reasons

## Scenario Coverage Expansion V2 [2026-03-23]
- [x] Expand reference selection breadth (higher per-ticker/per-sector caps) and regenerate map/policy artifacts
- [x] Promote expanded reference execution map + scenario policy to `model_config`
- [x] Run policy fit/generalization hit-rate report and identify weak tickers dominated by global fallback

## Locked Validation Backtest + Runtime Verification [2026-03-23]
- [x] Clear stale replay/backtest state and archive current run snapshot
- [x] Launch new locked validation backtest on expanded map/policy
- [x] Monitor progression and collect runtime diagnostics during run
- [x] Verify signal snapshot completeness and execution field integrity from API payloads
- [x] Verify dynamic scenario/reference policy selection appears in entry diagnostics and lineage

## Locked Validation Closeout + Weak-Reference Expansion [2026-03-23]
- [x] Finalize current locked-validation-v2 run and persist immutable archive metrics/config snapshot
- [x] Generate weak-reference gap artifact (fallback-heavy tickers/scenarios + quality deltas)
- [x] Propose targeted reference map + scenario policy additions for weak buckets

## Lineage Attribution Hardening (Execution + Scenario) [2026-03-23]
- [x] Persist explicit lineage attribution fields (`selected_engine`, `selected_management_engine`, `engine_source`, `scenario_policy_source`)
- [x] Deploy worker and run focused replay probe to create fresh attributed trades
- [x] Rebuild weak-reference report from attributed run data and verify non-unknown source distribution

## Targeted Promotion Cycle (Weak-Reference Uplift) [2026-03-23]
- [x] Apply targeted reference/scenario upgrades for `B`, `CSCO`, `CVNA`
- [x] Run short focused validation replay and archive results
- [x] Compare before/after attribution + weak-rate metrics and decide full-run promotion

## Drift v2 Semantic Parity (Reference Intelligence Hardening) [2026-03-23]
- [x] Extend reference map artifacts to persist per-trade execution intent (`entry_path`, `engine_source`, `scenario_policy_source`)
- [x] Add and persist `criteria_fingerprint` for each exact reference entry and ticker window cluster
- [x] Upgrade replay drift checks to validate semantic parity (not just timestamp match) and emit mismatch reasons
- [x] Validate on CSX/CDNS/ITT behavioral references and publish a drift v2 evidence artifact

## Drift v2b Semantic Tolerance Profile [2026-03-23]
- [x] Add map-level semantic tolerance profile (execution vs drift modes, field-level compare scope)
- [x] Wire runtime reference resolution to use configurable mismatch budget (instead of hardcoded semantics)
- [x] Wire drift reporting to use strict/diagnostic mode from profile
- [x] Regenerate/apply map + deploy worker + validate with focused interval replay

## Option-A Parity Spec [2026-03-22]
- [x] Build a deterministic parity spec for `option-a-rank-overhaul` using entry-time signal snapshots from artifact trades
- [x] Compare historical tag `95417ae` engine/runtime behavior vs current worker code for Jul 1 entry divergence
- [x] Write operator-ready replication contract (constraints + required gates/config + known non-repro causes)
- [x] Add scripted interval replay diagnostic for target Jul 1 tickers and capture runtime gate/debug traces

## Journey Parity Comparator [2026-03-22]
- [x] Add a script that compares full trade journey parity (entry window, hold duration, exit class, and pnl quality) against the screenshot reference trade set
- [x] Run comparator once and persist a baseline report artifact for mission-control gating

## CSX Forensic Iteration-1 [2026-03-22]
- [x] Build ticker/date-window forensic evidence for CSX (reference trade vs overlapping runs)
- [x] Test a feature-flagged momentum-precedence entry iteration in legacy engine
- [x] Validate iteration in interval replay and capture pass/fail against CSX parity target
- [x] Add entry-time diagnostics and complete Iteration-2 CSX entry-path parity adjustment

## CSX Forensic Iteration-3 (Runner/Exit Path) [2026-03-22]
- [x] Isolate exit-path divergence (BREAKEVEN_STOP after trim causing lifecycle fragmentation)
- [x] Add replay-safe management guard to skip breakeven stop for trimmed runners in parity lane
- [ ] Validate runner-completion parity against reference (`TP_FULL`-like completion timing)
- [ ] Audit TP tier construction for reference-vs-current mismatch (trim threshold and runner target spacing)

## CSX Parity Stabilization — Mode Lock + Diff Trace [2026-03-22]
- [x] Step 1: Lock canonical full-run parity mode in backtest orchestration (interval-first path)
- [x] Step 2: Add focused candle-vs-interval CSX trace artifact around Jul 1 with interval-level trade mutation evidence
- [x] Step 3: Patch only the identified mutation point and re-validate focused CSX window behavior

## TT Tune V2 [2026-03-04]
- [x] Add `TT_TUNE_V2` feature flag plumbing and keep legacy-safe fallback
- [x] Relax TT entry gating (bias + trigger) in strong daily regime
- [x] Tune TT exits to reduce early exits (debounce + defend-before-exit)
- [x] Deploy and run quick validation replay sample

## Next Sprint (Prioritized) [2026-03-06]
- [x] Calibrate from autopsy tags: loosen exits (should_have_held=8) — done
- [x] Trade Autopsy mobile layout: fix classification buttons visibility/overlap
- [x] Review Variant Config modal (rule deltas before launch)
- [x] Historical import: strong July artifacts as named runs
- [x] Experiment infra: 15m vs 10m `leading_ltf` support, rerun, and archive retention
- [ ] Review 15m vs 10m `leading_ltf` results and decide promote/reject
- [ ] Calibrate: keep anti-chase gates (chasing=4)
- [ ] Variant v2 hardening: mitigate bad exits and chasing from classified trades
- [ ] Mean reversion TD9: implement primitives per docs/MEAN_REVERSION_TD9_ALIGNMENT_PLAN.md

## Launch Calibration Build [2026-03-11]
- [x] Define the Active Trader and Investor prediction product contract from the current splash-page promise
- [ ] Refactor calibration storage/reporting to be run-scoped and block partial-run apply to shared `model_config`
- [x] Add a diagnostic-only calibration/report path for the active run
- [ ] Add Carter-style market internals to regime evidence: VIX bands, risk barometers (`AUDJPY`/`USDJPY` when available), sector offense/defense rotation, and TICK support when data exists
- [ ] Promote squeeze/compression from a local setup flag into a first-class regime/timing input with multi-timeframe evidence
- [x] Formalize regime-orchestration inputs and profile selection hooks
- [x] Persist ticker-character and market-context evidence with run/trade lineage
- [ ] Keep Carter/profile overlays diagnostic-only until a fresh post-deploy replay proves they improve the protected baseline
- [ ] Re-anchor the next trader replay on `15m-best-foot-forward-jul1-mar4` plus the recent Ripster trade-management patches
- [ ] Reconcile Fundstrat deck tickers/sectors into `SECTOR_MAP` and queue new universe additions through `watchlist/add`
- [ ] Audit user-facing prediction surfaces so they can show reasoning, levels, regime, and management proof cleanly

## Run-Scoped Trade Retention [2026-03-07]
- [x] Preserve completed backtest trades per `run_id` even after replay reset clears live tables
- [x] Archive Trade Autopsy rows by run so historical run analysis remains available
- [x] Re-snapshot the current `15m-leading-ltf-rerun` trades into the new per-run store
- [x] Add archive-backed ledger lookup for historical `run_id` analysis
- [x] Import saved July artifacts into the run archive store
- [x] Fix Trade Autopsy run picker to default to the latest completed archived run and compare the newest 15m rerun vs the March 7 reference

## Ticker Profile V2 [2026-03-08]
- [x] Unify ticker profile output into a canonical merged contract (legacy profile + learning_json + context stats)
- [x] Add context-aware ticker profile diagnostics segmented by VIX/regime/side/path
- [x] Persist durable market and sector context history for future ticker/regime joins
- [x] Add a first regime-profile mapping endpoint using completed runs and existing regime infrastructure
- [x] Group surviving useful runs into candidate market profiles using dynamic VIX and regime signals
- [x] Define the smaller next-cycle backtest matrix from the regime/profile learnings
- [x] Define the runtime `profile evidence` contract for future adaptive overrides
- [x] Define the first named regime-linked profiles: `trend_riding`, `correction_transition`, `choppy_selective`
- [x] Wire the named execution-profile selector into live scoring so regime + internals + ticker character can pick the active profile at runtime
- [x] Persist execution-profile lineage into `direction_accuracy` and calibration autopsy rows for downstream replay/calibration traceability
- [x] Surface stored market/sector context history in System Intelligence
- [x] Surface richer ticker profiles and regime-profile mapping in System Intelligence
- [x] Surface canonical ticker context evidence inside Trade Autopsy
- [ ] Validate with lint and API/UI smoke checks

## Custom Ticker Add Flow Hardening [2026-03-08]
- [x] Persist worker-side ticker context from shared enrichment sources
- [x] Add background onboarding progress for custom ticker adds
- [x] Add Analysis-page processing modal and subtle post-add loading state
- [x] Deploy worker + Pages changes
- [x] Browser-test custom ticker add flow end to end in production

## Performance Enhancements [2026-03-08]
- [x] Analysis page: reuse cached snapshot across same-tab page navigations and revalidate in background
- [ ] Fix stale market-pulse futures/index updates (`ES1!`, `NQ1!`, `SI1!`) when heartbeat data lags
- [ ] Analysis page: split `/timed/all` into slim first-paint payload + deferred hydration
- [ ] Analysis page: precompute/cache rank + kanban snapshot server-side
- [ ] Tickers page: stop using full `/timed/all` sweep for context on first load
- [ ] Tickers page: add narrow context payload or include context in `ingestion-status`
- [ ] Tickers page: precompute/cache expensive ingestion-status summary

## Tickers Candle Gap Audit [2026-03-08]
- [x] Run production D1 completeness audit for `ticker_candles`
- [x] Compare audit output vs `/timed/admin/ingestion-status` gap reporting
- [x] Determine whether gaps are real missing data or a reporting/calculation issue
- [x] Summarize impact on backtests and define corrective action

## Replay Dataset Freeze [2026-03-10]
- [ ] Add a dedicated script to build and freeze a canonical replay-ready dataset window
- [ ] Add `full-backtest.sh` support for using a frozen dataset manifest and skipping Step 1.5
- [ ] Verify the July 2025 frozen dataset workflow and document the operator commands

## TradingView 15m Export Import [2026-03-08]
- [ ] Verify new `TV Exports` 15m CSV files and import path
- [ ] Update CSV auto-detection for new futures/index export prefixes
- [ ] Import the new TradingView `15m` CSV exports
- [ ] Verify `15m` candle coverage for the imported symbols

## Trail Coverage Repair [2026-03-08]
- [ ] Confirm the current `trail_5m_facts` repair path and narrow it to only missing coverage windows/tickers
- [ ] Backfill missing trail history for the recoverable ticker/date ranges
- [ ] Rebuild / flush `trail_5m_facts` from repaired trail history
- [ ] Re-run missed-move diagnosis and verify `NO_TRAIL_DATA` drops materially
- [ ] Pause the resumed 15m backtest before running trail repair so replay state does not collide
- [ ] Resume the 15m backtest after trail repair completes

## Sparkline Hardening [2026-03-08]
- [ ] Harden `/timed/all` so missing card sparklines are backfilled symbol-by-symbol instead of only when most are absent
- [ ] Preserve prior card sparklines in the Analysis UI when a refresh returns partial ticker payloads
- [ ] Validate the Analysis cards keep sparklines across refresh/poll cycles

## Variant v2 Hardening [2026-03-04]
- [ ] Mitigate bad exits and upstream/chasing entries from classified variant trades
- [x] Fix Trade Autopsy mobile layout overlap (classification buttons visibility)
- [ ] Fix Evening Daily Brief ES close-source mismatch bug
- [ ] Improve Home initial-load latency on first render
- [ ] Validate with lint + quick replay/UI smoke checks

## UI Polish Pass [2026-03-10]
- [ ] Rework homepage top rows so Upcoming Events has its own row and movers wrap cleanly
- [ ] Keep Trade Autopsy mobile footer actions visible above safe-area cutoff
- [ ] Confirm right rail Journey and Technicals ordering/copy changes in production
- [ ] Push only Pages/UI commits after isolating accidental non-UI git changes

## Run Integrity Repair [2026-03-11]
- [x] Trace historical run import path for run -> trades -> classifications linkage
- [ ] Restore/import per-trade autopsy annotations for imported protected/reference runs when artifact data exists
- [x] Make Trade Autopsy-from-Runs load run-scoped classifications instead of only relying on summary metrics
- [ ] Define/archive run lifecycle semantics so calibration only uses runs with linked trade outcomes + annotations
- [ ] Verify protected baseline run opens in Trade Autopsy with its saved classifications

## Replay Follow-ups [2026-03-04]
- [ ] Harden 10m entry gates (strict EMA21 + ST direction)
- [ ] Fix trimmed-trade P&L consistency in replay/autopsy path
- [ ] Re-run focused replay and verify WMT/H outcomes

## WMT Loss Guard Focused Replay [2026-03-05]
- [x] Add TT momentum anti-chase RSI heat gate (30m/1H)
- [x] Add Daily ST conflict gate for TT momentum LONG entries
- [ ] Run focused replay (Jul 1-3) and verify WMT blocked while CSX still passes

## July Variant Guardrails V3 [2026-03-06]
- [x] Exclude replay_forced_eod_close trades and analyze loser clusters
- [x] Implement feature-flagged variant guardrails (entry + early-defend)
- [x] Enable variant and run July backtest
- [x] Compare control vs variant and summarize win-rate/PnL impact

## RSI Extreme Guard (Good-Trade Referenced) [2026-03-05]
- [x] Analyze classified good trades vs bad trades for multi-timeframe RSI extremes
- [x] Add feature-flagged all-timeframe RSI extreme guard with data-driven exception path
- [x] Emit explicit autopsy reason codes for new guard decisions
- [ ] Run focused replay and compare blocked/kept trades vs current baseline

## Backtest Cost Controls [2026-03-05]
- [x] Add low-write replay mode to skip timed_trail writes during backtests
- [x] Add `--low-write` flag to full-backtest orchestration and skip lifecycle in that mode

## Squeeze Hold Guard [2026-03-05]
- [ ] Add management-only squeeze/compression hold guard to reduce premature exits during consolidation
- [ ] Run July replay with keep-open-at-end and compare win-rate + exit-reason mix

## Overnight Auto-Tune + Re-Backtest [2026-03-06]
- [x] Analyze completed July run (loss reasons, trim-giveback, chase blocks, open-position mix)
- [x] Apply targeted calibration/logic adjustments for highest-impact failure modes
- [x] Deploy updated worker logic
- [x] Run fresh full backtest with latest patches and collect final metrics
- [x] Summarize before/after deltas and recommended default settings

## Swing Checklist A/B [2026-03-06]
- [x] Add feature-flagged swing checklist gate (4H EMA stack + daily EMA5 + phase reset near zero + optional squeeze build)
- [ ] Run control replay with swing checklist disabled
- [ ] Run variant replay with swing checklist enabled
- [ ] Compare win rate, realized PnL, loss reasons, and open-trade mix

## Run Registry + Live Baseline [2026-03-06]
- [x] Add D1 run registry tables and metrics persistence (`backtest_runs`, `backtest_run_metrics`)
- [x] Add run endpoints (`register`, `finalize`, `mark-live`, `live`, `list`) and summary view payload
- [x] Add full-backtest orchestration hooks for register/finalize lifecycle
- [x] Fix JSON body parsing in run endpoints (readBodyAsJSON compatibility)
- [x] Validate on fresh control+variant runs and choose baseline `run_id` — Phase 3 promoted to live

## Run Tracking UI + Promotion [2026-03-06]
- [x] Add System Intelligence Runs tab (live run + historical summaries)
- [x] Add Promote Live action wired to `/timed/admin/runs/mark-live`
- [x] Deploy worker + Pages and verify run tracking/promotion flow

## Mean Reversion: TD9 Alignment Setup [2026-03-06]
- [ ] Add primitives: countRecentGapsDown, td9AlignedLong (D+W+60), phaseLeavingDotBullish, isNearPsychLevel
- [ ] Add mean_revert_td9_aligned flag and wire to entry path (feature-flagged)
- [ ] Validate on INTU-style setups (gap-down → TD9 alignment → support confluence → RSI extremes)
- **Plan:** `docs/MEAN_REVERSION_TD9_ALIGNMENT_PLAN.md`

## Experiment Workflow Phases [2026-03-06]
- [x] Phase 1: Convert trail facts to rolling baseline + active experiment storage
- [x] Phase 1: Add Delete Run cleanup semantics for non-protected experiment runs
- [x] Phase 2: Preserve the two July candidates as protected baseline save points
- [x] Phase 3: Re-run and validate official July baseline — completed; promoted to live (71.43% WR, +$2,481)
- [x] Phase 4: Add immutable rule snapshot storage and run detail APIs
- [x] Phase 5: Historical run import + run-scoped trade retention
- [x] Phase 6: Expand Runs UI with protected/archive/delete controls
- [x] Phase 7: Add Create Variant / Review Variant Config flow (Config vs Live deltas)

## 22 Losing Trades Fixes [2026-02-27] ✅
- [x] 1. Stop replay (released lock)
- [x] 2. Apply entry guards: 21 EMA on 10m (LONG: price above, SHORT: price below)
- [x] 3. CAT fix: replay entry price now uses 10m candle close (not "freshest" across TFs)
- [x] 4. Re-run replay for GE, CAT, BABA (July 1, 2025): 0 trades created (guards blocked bad entries)

## Admin Add/Remove/Update Tickers [2026-02-26] ✅
- [x] Fix SL/TP display: hide Kijun when >50% from price
- [x] Backfill reliability: run onboard after Fill Gaps; admin/onboard via requireKeyOrAdmin
- [x] Member ticker save: unsaved indicator, 401 feedback, Save disabled when no changes
- [x] Add-ticker UX: Fill → Score flow, Score button, clearer success message

## Polish Phase [2026-02-26]
- [x] Fix placeholder XXXX in simulation-dashboard (blurred teaser)
- [x] Standardize empty states (contextual messages kept)
- [ ] Consolidate ScoreBar/MarketHealthBar if beneficial
- [ ] Card/spacing consistency pass
- [ ] Verify getDailyChange usage everywhere

## Backtest Exit Management Fix [2026-03-18]
- [x] Diagnose root cause: 65 TP_HIT_TRIM trades at 66% trimmed shielded indefinitely by pullback support with no time limit
- [x] Add `RUNNER_STALE_FORCE_CLOSE` fuse exit for trimmed trades (120 market-hours default, configurable)
- [x] Add time-decaying ATR buffer to `evaluateRunnerExit` pullback shield (full→0 over 48h)
- [x] Add time-decaying ATR buffer to EXIT lane `_exitPullbackShield` (matches Smart Runner)
- [x] Add continuous `runnerPeakPrice` tracking so drawdown circuit breaker works on actual peak
- [x] Add exit reason map entries for `RUNNER_STALE_FORCE_CLOSE`
- [x] Deploy worker and verify in production (deployed 2026-03-18, commit 185550d)
- [ ] Re-run backtest with all improvements and confirm all trades properly managed

## Phase 4: ORB Detector + Scoring Integration [2026-03-18] ✅
- [x] 4.1: Analyze existing breakout detectors + candle data structure
- [x] 4.2: Build `computeORB()` for multiple TFs (5m, 15m, 30m, 60m opening ranges) in `indicators.js`
- [x] 4.3: Integrate ORB levels into scoring pipeline — rank boost for confirmed breakouts, penalty for fakeouts
- [x] 4.4: Wire ORB into entry gates (DA-14 fakeout gate, `__orb_confirmed` confirmation), exit logic (SL anchor at ORL/ORH), and rank boost
- [x] 4.5: Add ORB data to signal snapshot lineage (`buildTradeLineageSnapshot`)
- [x] Pass intraday bars (10m/15m) into replay `rawBars` so ORB works during backtests
- [x] Pass `asOfTs = intervalTs` in replay for correct session-relative ORB computation

## Phase 5: AI CIO Agent-in-the-Loop [2026-03-18] ✅
- [x] 5.1: Map trade entry flow — injection point identified at post-sizing, pre-trade-creation
- [x] 5.2: Build AI CIO evaluation prompt + OpenAI call with 8s timeout/fallback
- [x] 5.3: Wire AI CIO into trade entry pipeline (live only — skipped during replay for cost/perf)
- [x] 5.4: Persist AI CIO decisions in D1 `ai_cio_decisions` table with trade outcome backfill
- [x] 5.5: Add configurable toggle (`ai_cio_enabled` in model_config) + Discord notifications
- [x] Admin API: `GET /timed/admin/ai-cio/decisions` and `GET /timed/admin/ai-cio/accuracy`
- [x] CIO data attached to trade object (`trade.aiCIO`) and Discord entry embed
- [x] REJECT: blocks trade, persists for accuracy tracking, sends Discord alert
- [x] ADJUST: modifies SL/TP/position size with sanity checks (SL correct side, TP correct side, size 0.25x-1.5x)
- [x] APPROVE (incl. fallback): proceeds with model's original intent

## Phase 5b: AI CIO Memory Service [2026-03-18] ✅
- [x] New D1 tables: `daily_market_snapshots` (structured macro signals per date) + `market_events` (individual CPI/FOMC/NFP/earnings results)
- [x] `persistDailyMarketSnapshot()` + `persistMarketEvents()` called from `generateDailyBrief()` after each brief
- [x] `TICKER_PROXY_MAP` in `sector-mapping.js`: peer groups, ETF proxies, earnings-correlated groups (NVDA->AMD/SOXL, etc.)
- [x] `buildCIOMemory()` — 7 memory layers: ticker history, regime context, entry path track record, personality/franchise, CIO self-accuracy, episodic market backdrop, event-driven context (macro + earnings + proxy behavior)
- [x] `findSimilarEpisodes()` — macro condition matching (VIX state, oil direction, sector rotation, regime); requires 3/4 match
- [x] `findRelevantEvents()` — 5-day lookback for macro events, direct earnings, and proxy earnings via `TICKER_PROXY_MAP`
- [x] Updated CIO system prompt: memory-first evaluation priorities (ticker blacklist, event risk, regime alignment, then technicals)
- [x] Updated CIO user template: includes MEMORY section alongside proposal
- [x] `evaluateWithAICIO()` now accepts and passes memory context
- [x] Timeout increased from 8s to 15s (scoring cycles are 5 min, plenty of room)
- [x] `ai_cio_replay_enabled` toggle: CIO now runs during replay when both `ai_cio_enabled` and `ai_cio_replay_enabled` are "true"
- [x] D1 pre-load at replay start: path_performance, market snapshots, market events, ticker profiles, franchise config → `replayCtx.cioMemoryCache`
- [x] Live scoring pre-load: path_performance, last 30 snapshots, last 50 events → `env._cioMemoryCache`
- [x] In-memory CIO decision accumulation during replay with outcome backfill on trade close
- [x] Crypto leading indicator: BTC/ETH trailing 2-4wk trend as forward signal for equities (BTC→SPY/QQQ, ETH→IWM/XLF)
- [x] `btc_pct` + `eth_pct` columns in `daily_market_snapshots` + backfilled 180 trading days
- [x] BTC/ETH added to Daily Brief cross-asset context + `TICKER_PROXY_MAP`
- [x] `findSimilarEpisodes()` uses crypto trend as 5th matching dimension
- [x] Model config toggles set: `ai_cio_enabled = true`, `ai_cio_replay_enabled = true`
- [x] `market_events` backfill: 65 curated macro events (CPI/PPI/FOMC/PCE/NFP/GDP/Retail/ISM/Jobless) + 301 earnings from TwelveData for 89 tickers
- [x] SPY reaction cross-referenced from `daily_market_snapshots` for each event date

## Phase 6: Optimized Model Config [2026-03-18] ✅
- [x] Blacklist expanded: added AMZN, META, RKLB, RDDT, NVDA to `deep_audit_ticker_blacklist` (-$16,912 combined drag)
- [x] CIO franchise/blacklist: `cio_franchise_blacklist` with franchise (PH, AVGO, APP, LITE, AU, CAT, RGLD, HII, ANET, TJX) and blacklist (AMZN, META, RKLB, RDDT, NVDA, LRN, IESC, BG, WMT, ETN)
- [x] Tighter loss controls: `max_loss_pct` normal -2 → -1.5, pdz -5 → -3; `hard_loss_cap` $500 → $350
- [x] Higher entry quality floor: `min_entry_quality` 45 → 55
- [x] ORB fakeout sizing bug fixed: `__da_orb_size_mult` now wired into `_rawCombinedMult` in sizing chain
- [x] Regime size multipliers expanded: added `EARLY_BEAR: 0.50`, `BEAR: 0.40`
- [x] SHORT min rank lowered: 55 → 50
- [x] Tighter runner protection: `post_trim_trail_pct` 2 → 1.5, `runner_trail_pct` 2.5 → 2.0
- [x] Stall force-close reduced: 36h → 24h
- [x] All configs verified in D1, worker deployed

## UI Improvements [2026-03-18] ✅
- [x] Added `TYPICAL_DAILY_RANGE` + `getNormalizedIntensity()` to `shared-price-utils.js` — hybrid per-type bands with ATR override
- [x] Updated `getCardSkin()` and `SVGBubble` color logic to use volatility-normalized intensity (SPY +0.7% now looks as intense as TSLA +3%)
- [x] Ported S/R levels, trend lines, pattern detection (double top/bottom, triangles, flags, ranges), and TF-specific scaling from Daily Brief charts to right-rail `LWChart`
- [x] Added IWM to Daily Brief: backend candle fetch (D, 1H, 5m, 4H), `iwmTechnical` summary, SMC/ATR levels, prompt data; frontend chart symbol in both admin and user lists
- [x] Condensed Daily Brief prompt: merged Risk Factors + Cross-Asset into "Market Context", merged Sector + Almanac into "Sector & Themes", added per-section word limits (~800 words target), removed "Swing Trader Takeaway", reduced `max_completion_tokens` 6000→4000
- [x] Restructured Day Trader Levels to "Key Levels & Game Plan" — SMC support/resistance primary, ATR secondary, ORB context noted
- [x] Fixed all bare `catch {}` in `shared-right-rail.js` for Babel compatibility
- [x] Rebuilt compiled assets (`index-react.compiled.*.js`, `shared-right-rail.compiled.js`), deployed worker + Pages

## Backlog

### Earnings Verification (pre-secondary-check)
- [ ] **Finnhub debug** — Hit `GET /timed/earnings/upcoming?debug=1` to see raw Finnhub response for NFLX, TSLA, AAPL. Compare with public calendars.
- [ ] **TwelveData secondary** — Debug response now includes TwelveData earnings_calendar for same range. Compare `check_tickers_finnhub` vs `check_tickers_twelvedata`. If Finnhub has false positives, gate bubble-chart dashed ring on TwelveData confirmation.

### Emails
- [ ] **Contact Emails** — Centralize support@timed-trading.com, legal@timed-trading.com, and any others (Terms §17, VAPID subject, footer/nav). Ensure consistency across all surfaces.
- [ ] **Welcome Email** — Trigger on signup/subscription.
- [ ] **Reminder Emails** — Re-engagement (e.g., unused features, inactive users).
- [ ] **Transactional / Alert Notifications** — Email delivery for trade alerts, system notifications, etc.
- **Plan:** See `tasks/EMAIL_PLAN.md` for sending (Resend/SendGrid/etc.) and receiving (support/legal + optional inbound parsing).

### Daily Brief
- [ ] **News feed** — Extend beyond `fetchAlpacaEconNews` (economic/macro); add general market news section or broader news source for brief enrichment.

---

## Recently Completed
- **Trade Autopsy v2** [2026-02-26] — Backend: D1 `trade_autopsy_annotations` table, GET/POST `/timed/admin/trade-autopsy/annotations`, GET `/timed/admin/trade-autopsy/trades` (with direction_accuracy). Frontend: filtering (ticker, classification, date range), signal snapshots at entry (signal_snapshot_json, tf_stack_json) and exit context (exit_reason, MFE, MAE) in modal.
- **Trade Autopsy** [2026-02-26] — New `trade-autopsy.html` page: table of all closed trades, click row → modal with TradingView chart (asOfTs for historical candles), notes textarea, classification dropdown (Bad Trade, Valid Loss/Win, Improvement Opportunity, Data Error, Edge Case, Execution Issue, Good Trade). Annotations stored in localStorage. Nav link added (admin-only) to index-react, simulation-dashboard, daily-brief. GET /timed/candles now supports optional `asOfTs` for historical chart data.
- **Backfill for Backtest** [2026-02-27] — alpaca-backfill now accepts startDate/endDate to target the backtest range. full-backtest.sh backfills from 60 days before start (EMA warm-up) through end. Gap check uses same extended range. Fixes "0 candles" when backtest range was misaligned with sinceDays.
- **Losing Trades Report** [2026-02-27] — GET /timed/admin/losing-trades-report endpoint + scripts/losing-trades-report.js for manual review (ticker, dates, P&L, signals at entry). Deploy worker before use.
- **Daily 5/48 EMA + ST Slope Priority** [2026-02-27]
