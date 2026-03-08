# Current Tasks

> **Plan:** See `tasks/PLAN.md` for consolidated status, phases, and clear next steps.

## Ripster Tune V2 [2026-03-04]
- [x] Add `RIPSTER_TUNE_V2` feature flag plumbing and keep legacy-safe fallback
- [x] Relax Ripster entry gating (bias + trigger) in strong daily regime
- [x] Tune Ripster exits to reduce early exits (debounce + defend-before-exit)
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

## TradingView 15m Export Import [2026-03-08]
- [ ] Verify new `TV Exports` 15m CSV files and import path
- [ ] Update CSV auto-detection for new futures/index export prefixes
- [ ] Import the new TradingView `15m` CSV exports
- [ ] Verify `15m` candle coverage for the imported symbols

## Variant v2 Hardening [2026-03-04]
- [ ] Mitigate bad exits and upstream/chasing entries from classified variant trades
- [x] Fix Trade Autopsy mobile layout overlap (classification buttons visibility)
- [ ] Fix Evening Daily Brief ES close-source mismatch bug
- [ ] Improve Home initial-load latency on first render
- [ ] Validate with lint + quick replay/UI smoke checks

## Replay Follow-ups [2026-03-04]
- [ ] Harden 10m entry gates (strict EMA21 + ST direction)
- [ ] Fix trimmed-trade P&L consistency in replay/autopsy path
- [ ] Re-run focused replay and verify WMT/H outcomes

## WMT Loss Guard Focused Replay [2026-03-05]
- [x] Add Ripster momentum anti-chase RSI heat gate (30m/1H)
- [x] Add Daily ST conflict gate for Ripster momentum LONG entries
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
