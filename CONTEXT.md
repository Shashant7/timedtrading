# Timed Trading — Context (Refresh Here)

Single reference for agents. Read this first to avoid context overload.

## Workflow

- **Plan first**: Non-trivial (3+ steps) → write to `tasks/todo.md` before coding
- **Stop on sideways**: If stuck, re-plan; don't push through
- **Verify before done**: Prove it works; "Would a staff engineer approve?"
- **Lessons**: After user corrections → add to "Lessons" below; review at session start
- **Simplicity**: Minimal impact, no temporary fixes

## Deploy

```bash
npm run deploy          # build:rail + embed dashboard + worker (both envs)
npm run deploy:worker   # worker only (skip right-rail)
```

- **Worker**: `cd worker && wrangler deploy` + `wrangler deploy --env production` — deploy BOTH
- **Pages**: Auto-deploys on `git push main` (static files from `react-app/`)
- **CRITICAL**: `simulation-dashboard.html` and all `react-app/*.html` files are served by **Pages**, NOT the worker. `deploy:worker` does NOT update them. Must `git commit && git push` to trigger Pages deploy.
- **Trades page JSX**: App's return must have a single root. Use `return ( <> <div className="tt-root"> ... <GoProModal /> ... </div> </> );` — no extra `</div>` before GoProModal.
- **Right rail**: Edit `shared-right-rail.js` → run `node scripts/compile-right-rail.js` → update `?v=` cache busters

## Global nav (header + right side)

- **Canonical source**: `index-react.html` — "Unified Nav Bar" comment. All pages must match this structure.
- **Nav links (order)**: Analysis, Trades, System Intelligence, Screener, Tickers, Trade Autopsy, Admin (conditional), Daily Brief.
- **Right side (order)**: Guide, Tour, FAQ, Ask AI, NotificationCenter (bell), UserBadge (avatar), hamburger (md:hidden). No Admin link and no "Paper · $1k/trade" in the right block; Admin lives only in the center nav tabs. Analysis uses buttons for Guide/Tour/Ask AI; other pages use links. Mobile menu includes same links + Contact.
- **Breakpoint**: Use `md` (768px) for desktop nav and `md:hidden` for mobile menu so the full nav is visible on typical desktop widths.
- **Styling**: `border-white/[0.06]`, `background: rgba(10,10,15,0.95)`, same logo and link styles. When adding a new page, copy the nav block from `index-react.html` and set the active link only.
- **Global component**: Nav is currently duplicated per page. A future shared component (e.g. `shared-nav.js` mounting into `#global-nav-root`) would allow one place to edit; not yet implemented.

## Stack

| Layer    | Tech |
|----------|------|
| Frontend | React 18, Tailwind, Babel (index-react, simulation-dashboard, daily-brief, trade-autopsy, etc.) |
| API      | Cloudflare Worker (`worker/index.js`), routes under `/timed/*` |
| Data     | D1 (ticker_candles, trades, positions), KV (timed:latest, timed:prices) |
| External | TwelveData (primary), Alpaca (execution, backfill) |

## Plan

- **`tasks/PLAN.md`** — Consolidated status, phases, and next steps. Read first each session.

## Key Paths

- `worker/index.js` — routes, cron, trade logic
- `worker/indicators.js` — scoring, Alpaca
- `react-app/shared-price-utils.js` — `getDailyChange(t)` (single source for daily change)
- `react-app/auth-gate.js` — auth, paywall
- `tasks/todo.md` — current tasks

## Lessons (Critical)

**Deploy**
- Deploy worker to BOTH default + production envs
- ROUTES array must include new endpoints
- Worker routes use `/timed/` prefix

**D1**
- Batch reads: `db.batch()` max ~500 per call
- No unbounded `ROW_NUMBER() OVER (PARTITION BY ticker)` on large tables
- ALTER TABLE: wrap in try/catch (column may exist)

**Price / Frontend**
- `getDailyChange(t)` from shared-price-utils.js — never inline daily change
- TwelveData native fields over manual `price - prevClose`
- `timed:prices` keys: `p`, `pc`, `dc`, `dp`, `ahp`, `ahdc`, `ahdp`

**Trades**
- `exit_ts` on ALL exit paths
- Replay: load candles with `beforeTs` (ts <= replay date), not latest
- Backfill before replay; 10m candles required for trades
- Replay loads VIX daily candles from D1 for per-day VIX (requires VIX backfill); falls back to static KV
- Replay loads `ticker_profiles` from D1 for personality-aware SL/TP and lineage enrichment
- `signal_snapshot_json.lineage` includes `ticker_character` and `vix_at_entry` for post-trade analysis
- **Trimmed runner stale bug (fixed)**: doa-gate-v2 had 65 `TP_HIT_TRIM` trades at 66% trimmed that never closed — pullback support shield had no time limit, so structural support (price above any cloud low) shielded them indefinitely. Fix: `RUNNER_STALE_FORCE_CLOSE` at 120 market-hours + time-decaying shield buffers (full → zero over 48h) in both `evaluateRunnerExit` and EXIT lane. Config key: `deep_audit_runner_stale_force_close_hours`.
- **`STALL_FORCE_CLOSE` only for untrimmed**: The stall timer at `deep_audit_stall_force_close_hours` only fires when `trimmedPct < 0.01`. Trimmed trades use `RUNNER_STALE_FORCE_CLOSE` instead.
- **DA-3e (risk-off + choppy block) uses live market internals in replay**: execution_profile reads current VIX/internals, not historical. Must be disabled or use historical data during candle replay.

**Breakout Entry Paths**
- Three detectors in `indicators.js`: `detectDailyLevelBreak`, `detectATRBreakout`, `detectEMAStackBreakout`
- Wired via `detectBreakout()` → `tickerData.breakout` in `assembleTickerData`
- Entry path `breakout_{type}_{long/short}` in `qualifiesForEnter` — bypasses rank/completion gates
- Rank boost in `computeRank`: +20 daily_level, +15 atr_breakout, +12 ema_stack
- Config: `deep_audit_breakout_{daily_level|atr_breakout|ema_stack}_enabled`, `_min_rr`, `_min_entry_quality`

**Ticker Learning System**
- `scripts/build-ticker-learning.js` — discovers moves from daily candles (2020+), enriches with 30m signals, classifies personality, writes to `ticker_moves` + `ticker_move_signals` D1 tables
- `scripts/build-ticker-profiles.js` — analyzes signal precision, derives entry/exit params, writes `learning_json` to `ticker_profiles`
- Personalities: VOLATILE_RUNNER, PULLBACK_PLAYER, SLOW_GRINDER, MODERATE, TREND_FOLLOWER
- Trail styles: wide (3.5x runner), adaptive (2.5x), tight (2.0x), standard (2.5x) — in `_getTrailStyleMults()`
- Entry boost: RSI zone alignment (+2), EMA alignment (+2), personality adjust (±1), capped ±4
- Continuous learning: `d1UpdateLearningOnClose()` adjusts SL/TP multipliers per trade outcome
- UI: System Intelligence → Ticker Profiles tab; Trade Autopsy → Learning Profile card

**Inspecting candles**
- `TICKER=FIX DATE=2025-09-18 TIME=12:10 node scripts/inspect-candles.js` — API
- Add `--d1` to query D1 directly via wrangler

**Alpaca**
- BRK.B not BRK-B; one bad symbol fails batch
- Multi-symbol `limit` is TOTAL not per-symbol

**UI**
- Never "you/your" in copy (compliance)
- `window._ttIsPro` for feature gating
- Admin-gate live prices

**Backtest Run Registry & Archival**
- D1 tables: `backtest_runs` (metadata), `backtest_run_metrics` (aggregated stats), `backtest_run_trades` (archived trade copies), `backtest_run_direction_accuracy` (archived DA), `backtest_run_annotations` (archived classifications), `backtest_run_config` (model_config snapshot per run)
- Schema managed by `d1EnsureBacktestRunsSchema(env)` with `_backtestRunsSchemaReady` flag
- Routes: `GET /timed/admin/runs` (list), `GET /timed/admin/runs/live`, `GET /timed/admin/runs/detail`, `GET /timed/admin/runs/trades`, `GET /timed/admin/runs/config`, `POST /timed/admin/runs/register`, `POST /timed/admin/runs/finalize`, `POST /timed/admin/runs/mark-live`, `POST /timed/admin/runs/archive`, `POST /timed/admin/runs/update`, `POST /timed/admin/runs/delete`
- All routes use `requireKeyOrAdmin` (accepts API key OR CF Access JWT)
- **Finalize archives everything**: `POST /timed/admin/runs/finalize` computes metrics AND copies trades → `backtest_run_trades`, DA → `backtest_run_direction_accuracy`, annotations → `backtest_run_annotations`, model_config → `backtest_run_config`. This data survives `reset`.
- `summarizeRunMetrics(db, runId)` — scoped by `run_id`, checks `backtest_run_trades` first (archived), falls back to `trades` table
- `full-backtest.sh` calls `register` at start and `finalize` at end; both snapshot `model_config` (register: INSERT OR IGNORE for initial state, finalize: INSERT OR REPLACE for end state)
- `calibrate.js --run-id <id>` reads from archived tables when available
- UI: System Intelligence → Runs tab (`react-app/system-intelligence.html`)

**Daily Brief**
- GPT-5.4 requires `max_completion_tokens` (not `max_tokens`) — `worker/daily-brief.js`
- Morning brief: 9 AM ET cron via `generateDailyBrief(env, "morning", ...)` at UTC 13:00

**Discord**
- Bot role must be ABOVE assigned roles in hierarchy for `PUT /roles` to work (403 otherwise)
- `discordAddMemberAndRole` failure is caught non-blocking — user gets welcome email even if guild add fails
- Admin fix: `POST /timed/admin/discord/fix-role` with `{"discord_id":"..."}` to diagnose and force-assign role

**Code Hygiene**
- After `git merge` / `git pull`: run `grep -r '<<<<<<<' react-app/ worker/` before committing
- Pages (git-connected): production deploys only via `git push main`, NOT `wrangler pages deploy`
- When restoring old code: diff ROUTES array to verify no endpoints were dropped

## Cross-Run Analysis Key Findings (2026-03-18)

Full report: `data/cross-run-analysis-report.md`. 12 backtests, **2,301 closed trades** from D1 archives.

- **Trimmed = the edge**: 1,328 trades, 85.8% WR, **+$208,617**. Untrimmed: 973 trades, 17.8% WR, -$104,024. Net: +$104,593.
- **max_loss is #1 destroyer**: 311 trades, 0.6% WR, **-$52,009**. Half of all untrimmed drag. Prevent at entry.
- **Crown jewel exits**: PHASE_LEAVE (100% WR, +$33K), SOFT_FUSE_RSI (94.3% WR, +$29K), TD_EXHAUSTION (93% WR, +$9K).
- **All rank buckets profitable** (80+ best at 59.6% WR, +$37K). Earlier small-sample finding corrected.
- **October only losing month** — trim losses doubled. Regime transition protection needed.
- **Blacklist**: AMZN, META, RKLB, RDDT, NVDA (combined -$17K). **Franchise**: PH, AVGO, APP, LITE, AU, CAT, RGLD (combined +$42K).

## ORB Detector (Phase 4, 2026-03-18)

`computeORB()` in `indicators.js` — Opening Range Breakout detection for 4 windows (5m/15m/30m/60m from 9:30 ET).
- **Primary**: 15m OR. Multi-window consensus (`orbBias`) requires 2+ windows for strong signal.
- **Rank boost**: +10-15 for confirmed breakout in trade direction; -5 for fakeout/reclaim.
- **Entry gate (DA-14)**: Fakeout gate halves position size when OR was broken then reclaimed with no consensus.
- **SL anchor**: Confirmed LONG breakout → SL at ORL; SHORT → ORH. Only if tighter than ATR SL and ≥0.3% from entry.
- **Targets**: T1-T4 at 50%/100%/150%/200% of range width. `targetsHitUp`/`targetsHitDn` tracked.
- **Replay**: `rawBars` includes intraday bars; `asOfTs = intervalTs` for correct session detection.
- **Lineage**: Captured in `buildTradeLineageSnapshot()` for post-hoc analysis.

## AI CIO Agent-in-the-Loop (Phase 5, 2026-03-18)

Pre-execution AI review of every trade. Receives structured proposal + 7-layer memory context → returns APPROVE/ADJUST/REJECT.
- **Toggle**: `ai_cio_enabled` in `model_config`. Replay: also requires `ai_cio_replay_enabled`.
- **Timeout**: 15s hard limit (scoring cycles are 5 min). Fallback = APPROVE (model's original intent proceeds).
- **Model**: `gpt-4o-mini`, temperature 0.1, JSON response format.
- **REJECT**: Blocks trade, persists to D1, sends Discord alert with reasoning.
- **ADJUST**: Modifies SL/TP/size with sanity checks. Size clamped 0.25x-1.5x.
- **Accuracy tracking**: D1 `ai_cio_decisions` table. Backfilled with trade outcome on close.
- **Admin API**: `GET /timed/admin/ai-cio/decisions`, `GET /timed/admin/ai-cio/accuracy`.
- **Discord**: Entry embed includes CIO verdict, confidence, edge score when non-fallback.

### CIO Memory Service (Phase 5b)
Seven memory layers assembled by `buildCIOMemory()` — no D1 calls at decision time (pre-loaded caches):
1. **Ticker history**: WR, avg PnL, exit reasons, last 3 trades for this ticker.
2. **Regime context**: WR in current regime + direction.
3. **Entry path track record**: From `path_performance` D1 table.
4. **Ticker personality + franchise/blacklist**: From `ticker_profiles` + model_config.
5. **CIO self-accuracy**: Approval WR, last 3 reject reasons, correctness.
6. **Episodic market backdrop**: Today's VIX/oil/sector rotation + similar historical episodes via `findSimilarEpisodes()`.
7. **Event-driven context**: Macro events (CPI/FOMC/NFP), direct + proxy earnings via `TICKER_PROXY_MAP`, post-event trade patterns.

New D1 tables: `daily_market_snapshots` (macro signals per date incl. `btc_pct`/`eth_pct`, persisted from Daily Brief), `market_events` (macro + earnings results).
`TICKER_PROXY_MAP` in `sector-mapping.js`: peer groups, ETF proxies, earnings correlations (NVDA→AMD/SOXL), crypto correlations (BTCUSD→SPY/QQQ, ETHUSD→IWM/XLF).

**Crypto leading indicator**: BTC leads SPY/QQQ by 2-4 weeks; ETH leads IWM/Financials. `buildCIOMemory()` computes trailing 14-day and 28-day BTC/ETH cumulative change from market snapshots. If BTC trailing 2wk is down >5% or 4wk down >10%, the CIO is warned equity downside is likely ahead. This feeds into `findSimilarEpisodes()` as a 5th matching dimension.

## Phase 6: Optimized Config (2026-03-18)
Data-driven config from 2,301-trade Phase 3 analysis. Key changes:
- **Blacklist**: +5 tickers (AMZN, META, RKLB, RDDT, NVDA) — -$16.9K combined drag.
- **CIO franchise/blacklist**: Top 10 franchise tickers (PH, AVGO, APP...) get favorable CIO treatment; bottom 10 default to REJECT unless exceptional.
- **Loss clipping**: `max_loss_pct` -2% → -1.5%, `hard_loss_cap` $500 → $350. Targets the 311 `max_loss` exits (-$52K).
- **Entry quality**: Floor raised 45 → 55 (>15% WR delta in data).
- **ORB fakeout bug fixed**: `__da_orb_size_mult` now wired into sizing chain.
- **Regime size**: Added `EARLY_BEAR: 0.5x`, `BEAR: 0.4x` (October was only losing month).
- **Runner protection**: Tighter trailing (1.5%/2.0% from 2%/2.5%).
- **Stall close**: 36h → 24h. SHORT min rank: 55 → 50.

## UI Improvements (2026-03-18)
Five frontend/prompt changes deployed together:
1. **Volatility-normalized colors**: `getNormalizedIntensity()` in `shared-price-utils.js`. Cards/bubbles use per-ticker-type daily range (broad_etf=1.2%, growth=3.5%, etc.) or live ATR to normalize color intensity. SPY +0.7% now appears moderate-red instead of faint.
2. **Right-rail chart overlays**: S/R levels (swing highs/lows from daily candles), trendlines (regression on recent swings), pattern annotations (double top/bottom, triangles, flags, ranges), ATR targets, and TF-specific scaling/bar-spacing. All ported from Daily Brief chart engine.
3. **IWM in Daily Brief**: Backend fetches D/1H/5m/4H candles, runs `summarizeTechnical()` + SMC levels. Included in both morning/evening AI prompts and Discord embeds. Frontend chart added for admin and user views.
4. **Condensed brief**: Morning sections: Market Context (~150w), Structure & Scenarios (~100w each SPY/QQQ/IWM), Key Levels & Game Plan (~80w), Earnings (~60w), Sector & Themes (~80w), Active Trader (~80w), Investor (~80w). ~800 words total target. `max_completion_tokens` 6000→4000.
5. **SMC-first key levels**: Renamed to "Key Levels & Game Plan". Prompt instruction: lead with SMC support/resistance, ATR secondary, ORB for intraday context.

## TT Core Engine (Primary, 2026-03-21)

Entry and exit engines switched from frozen `ripster_core` references to `tt_core` (the actively-developed engine).

**Entry** (`worker/pipeline/tt-core-entry.js`):
- Cloud bias alignment (D+1H+10m 34/50) as structural foundation
- 10m-30m bias spread filter: `abs(bias10m) - abs(bias30m) < 0.05` rejects mature/chasing moves. Configurable via `deep_audit_bias_spread_min`.
- Momentum, pullback, reclaim paths (from ripster cloud triggers)
- Opening noise, RSI daily heat, chasing extension guards

**Exit** (`worker/pipeline/tt-core-exit.js`):
- Ripster cloud exits (5/12, 34/50, 72/89) with debounce
- Runner management: trim at exhaustion, hold runner if 34/50 structure + 30m SuperTrend intact
- Runner trailing: exit on structure break or breakeven stop (MFE >= 1%, PnL <= 0.1%)
- Safety nets: regime reversal, SL breach, max loss, DOA, time exits, bias flip

**Dispatcher**: `exit-engine.js` dispatches to `tt-core-exit.js` in `classifyKanbanStage`. Inline legacy code preserved as fallback.

**Config**: `ENTRY_ENGINE = "tt_core"`, `MANAGEMENT_ENGINE = "tt_core"` in wrangler.toml. Both envs.

## Full Lessons

See `tasks/lessons.md` for the complete list (180+ items). Use CONTEXT for quick refresh.
