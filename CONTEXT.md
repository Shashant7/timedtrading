# Timed Trading — Context (Refresh Here)

Single reference for agents. Read this first to avoid context overload.

> **New agent? Start at [AGENTS.md](AGENTS.md).** Then return here for the
> condensed-lesson reference.
> **Need to DO a common operation?** Skim [`skills/README.md`](skills/README.md)
> first — most "how do I X?" questions are already answered there.

## Workflow

- **Plan first**: Non-trivial (3+ steps) → write to `tasks/todo.md` before coding
- **Stop on sideways**: If stuck, re-plan; don't push through
- **Verify before done**: Prove it works; "Would a staff engineer approve?"
- **Lessons**: After user corrections → add to "Lessons" below; review at session start
- **Simplicity**: Minimal impact, no temporary fixes
- **Skills first**: Before inventing a new method, check [`skills/`](skills/) for an existing playbook. If you do something new that's reusable, write a skill for it before exiting.

## Design System — canonical source

**`DESIGN.md` at the repo root is the normative UI spec.** Read it before
any UX change — tokens (color / typography / spacing / rounded), component
definitions, and do/don't rules all live there. Runtime CSS is at
`react-app/tt-tokens.css`; both must stay in sync.

Before shipping UX changes:
1. Update `DESIGN.md` if the change introduces or alters a token
2. `npx @google/design.md lint DESIGN.md` — zero errors required, warnings OK
3. Mirror in `tt-tokens.css`, build, verify

Three rules enforced by the spec:
- Never mix Instrument Serif and Inter on the same element
- All numbers a user compares use `num-*` tokens (JetBrains Mono, tabular)
- No ad-hoc hex in JSX or page-specific stylesheets — go through tokens

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

## Product entry point (post May 2026)

The product is now split into dedicated journey pages. The user-facing
entry point is **`/today.html`** (not `/index-react.html`). Authenticated
root redirect lives in `react-app/_worker.js`.

| Page | Path | Replaces / What it does |
|---|---|---|
| Today | `/today.html` | Daily Ingest — Market Pulse, Brief, Bubble Map + Viewport |
| Active Trader | `/active-trader.html` | Kanban lanes + narrative brief |
| Investor | `/investor.html` | Investor cards + search/filter |
| Portfolio | `/portfolio.html` | Equity curves, calendar, open positions tables |
| Insights | `/insights.html` | System Intelligence + CIO Watchlist |
| Learn | `/learn.html` | Step Zero educational walkthrough |
| Splash | `/splash.html` | Public landing |
| Index | `/index-react.html` | **Legacy monolithic admin dashboard — still source-of-truth reference for component logic** |

**Rule:** journey pages must **port** existing components from
`index-react.source.html` verbatim, not redesign them. Full handoff doc at
`tasks/2026-05-17-session-handoff.md`.

**Login redirect target lives in 3 places — keep in sync:**
1. `react-app/_worker.js` — Pages worker root redirect
2. `react-app/index.html` — meta-refresh fallback
3. `react-app/auth-gate.js` — `handleLogin()` redirect target

**Right rail on a journey page requires:**
```html
<script src="https://unpkg.com/lightweight-charts@4.1.1/dist/lightweight-charts.standalone.production.js"></script>
<script src="ticker-spider-chart.js?v=..."></script>
<script src="shared-rail-helpers.js?v=..."></script>
<script src="shared-right-rail.compiled.js?v=..."></script>
<script src="shared-rail-bootstrap.js?v=..."></script>
```

**CF Access policy regex (User Pages) must list every new HTML page** or
authenticated users hit a login loop. Current shape:
```
(index-react|simulation-dashboard|daily-brief|alerts|investor-dashboard|today|active-trader|investor|portfolio|insights|learn)\.html
```
Only the user can update this — it lives in the Cloudflare Dashboard.

## Plan

- **`tasks/PLAN.md`** — Consolidated status, phases, and next steps. Read first each session.
- **`tasks/2026-05-17-session-handoff.md`** — full UX redesign + May calibration session handoff.
- **`tasks/may-2026-performance-analysis.md`** — full performance writeup + P0/P1 calibration plan.

## Key Paths

- `worker/index.js` — routes, cron, trade logic
- `worker/indicators.js` — scoring, Alpaca
- `react-app/shared-price-utils.js` — `getDailyChange(t)` (single source for daily change)
- `react-app/auth-gate.js` — auth, paywall
- `tasks/todo.md` — current tasks

## Lessons (Critical)

**Mission Control polish (2026-05-30 evening)**
- **Endpoints polled on every page load MUST return HTTP 200 with a structured `{ok:false,error_kind,hint}` payload**, not 4xx/5xx. Chrome logs 4xx as red even with `.catch()`. Reserve real non-2xx for auth failures or genuinely missing routes. Pattern: `sendJSON({ok:false, error_kind:"url_missing", hint:"..."}, 200, corsHeaders(env,req))`.
- **Interactive write buttons need INLINE feedback**, not `alert()`. Operators dismiss alerts. Pattern: optimistic flash on click → inline error chip + `console.warn` on failure. See `react-app/mission-control.html → CioDecisionReview.submitReview`.
- **CF error `1042` = worker-to-worker loopback rejected.** Body `error code: 1042` on a 404 from a Workers subrequest means Cloudflare's loop detector blocked the call. Migrate to **Service Bindings** (`services = [...]` in wrangler.toml), call `env.BRIDGE.fetch()` instead of HTTP fetch.

**Options Engine + Fused-POV (PR #371-#377, May 2026)**
- **Confluence enrichments ordered FIRST**: in `/timed/options/ticker`, inject `_vp`, `_index_quartet`, `_strategy_stance` onto the ticker snapshot BEFORE `scoreRootConfluence()`. Layer evidence strings are the smoke test — L4 must say `VP: Above/Inside/Below VAH/VAL`, L5 must mention `SMT` or `ORB` when active. (PR #375)
- **`timed:all` is keyed by symbol** — `{ data: { SYM: {...} } }`, NOT a `tickers[]` array. Normalize via `Object.values(all?.data || {})` before iterating. `/timed/options/all` shipped with 0 plays for an hour because of this. (PR #374)
- **IBKR `IBKR_DH_PRIME` env var must hold ONLY the hex prime**, not the full `openssl dhparam -text -noout` output. Operators paste the human-readable diagnostic (`generator: 2 (0x2)` trailer) → naive hex-strip leaked letters → 530 hex chars instead of 512 → wrong shared secret K → `lst_signature_mismatch`. `_extractDHPrimeHex` now slices at `generator`/`prime:` BEFORE stripping. Validate length = 256/384/512 bytes. (PR #375)
- **TwelveData options endpoints are unreliable** — both `/options/chain` and `/options_chain` 404 despite docs. Default options chain provider is Alpaca (`/v1beta1/options/snapshots/{sym}` + Broker API `/v2/options/contracts` for real OI). TD only as fallback. (PR #374)
- **Outside-RTH price source is TODAY's close**: `resolveDisplayPrice` must prefer `src.close` → `src.price` → `src.prev_close`. Defaulting to `prev_close` shows yesterday's $317 on DELL when today's gap-up close is $421. The label "RTH CLOSE" means TODAY's. (PR #377)
- **Legacy targets need sanity caps before UI render**: `buildTraderPredictionContract` enforces `MAX_TARGET_DISTANCE_PCT=0.35` + `MIN_PRICE_FLOOR=0.50`. Without this, CVNA SHORT at $73 produced `TP_runner=-$8.59` (negative price). Fall back to ATR-fib targets when legacy is out of bounds; clamp the ATR-fib too. (PR #376)
- **Trader-tab confluence chip pre-fetches**: `optionsTabData` `useEffect` gate is `railTab in {OPTIONS, SETUP, SNAPSHOT}` so the Trader tab gets the verdict without the user visiting Options first. When two tabs share derived data, both tab keys go in the `needsX` gate. (PR #376)
- **Moonshot is RIDE-only (or SMT 2-stage confirmed)**: `shouldActivateMoonshot` requires `confluence.mode === "RIDE"` + ST trigger fresh + underlying already in motion (≥5% intraday or ≥10% 5d) — OR an SMT 2-stage CONFIRMED override. Prevents moonshot pollution on every speculator-profile request. (PR #374)
- **SuperTrend (10,3) slope is the trigger gate** for RIDE/READY/DRIFT/FADE/WAIT mode resolution — not just another layer vote. `computeSupertrendTrigger` is called separately from the 8 layers; its output gates whether confluence ≥ 0.5 becomes RIDE or READY (and whether ≤ -0.5 becomes FADE or DRIFT). Never adversely actioned when ST is sloping in the trade direction. (PR #373)
- **All 8 layers must score with non-zero strength to ship**: if a layer always returns `strength: 0`, its required fields are missing from the ticker snapshot. Don't ship until each layer either fires or has a documented "data unavailable" path. The L4 ICT layer originally returned neutral on every ticker because `fvg_D`/`liq_D` weren't on the snapshot — `tf_tech.D.fvg` was the correct field. (PR #373 follow-up)

**Deploy**
- Deploy worker to BOTH default + production envs
- ROUTES array must include new endpoints
- Worker routes use `/timed/` prefix
- **"Deploy Failure" emails can be lying** — `Check react-app-dist is up-to-date` workflow's `IGNORE_PATTERN` must list every per-build varying string. If build adds a new cache-bust insertion point, extend the regex in `.github/workflows/check-dist.yml` at the same time. (PR #303)
- **`git apply` silently clobbers** when rebasing a PR onto a fresh main that has co-merged dependency PRs. Use `git cherry-pick <original-commit>` instead — it surfaces real conflicts. After ANY rebase that touches files a dependency PR also touched, `grep -nE` for the dependency's added symbols to verify. (PR #311 incident)

**D1**
- Batch reads: `db.batch()` max ~500 per call
- No unbounded `ROW_NUMBER() OVER (PARTITION BY ticker)` on large tables
- ALTER TABLE: wrap in try/catch (column may exist)

**Price / Frontend**
- `getDailyChange(t)` from shared-price-utils.js — never inline daily change
- TwelveData native fields over manual `price - prevClose`
- `timed:prices` keys: `p`, `pc`, `dc`, `dp`, `ahp`, `ahdc`, `ahdp`
- **Babel-standalone pages MUST render nav as static HTML** outside `<div id="root">` — JSX compile is 1-3s cold-load → blank-page bug otherwise. See `today.html` / `active-trader.html` for the pattern. (PR #304)
- **New pages using `.nav-links` markup MUST be added to `JOURNEY_PATHS`** in `tt-nav-extras.js` (line ~370). Otherwise the script prepends a duplicate journey-link strip. (PR #304)
- **Don't render `<TimedNotificationCenter />` + `<TimedUserBadge />` in React** on pages with `tt-nav-extras.js` — `injectRightWidgets()` already mounts them. Double-rendering = two bells + two avatars. (PR #304)
- **TwelveData margin fields all multiply by 100** (decimal → percent) — `profit_margin`, `operating_margin`, `gross_margin`, `return_on_equity_ttm`, `return_on_assets_ttm`. Forgetting on any one ships impossible values like `gross_margin 0.7%` when net is `41.5%`. (PR #306)
- **TwelveData FCF: `free_cash_flow_ttm` is canonical** — `levered_free_cash_flow_ttm` is inconsistently populated per ticker. Use the fallback chain in `worker/index.js` to avoid 8× under-reports. (PR #306)
- **Saty ATR labels are jargon to users** — `DAY GATE / +38.2%` should render as `Today's Range / Expected High` in any UI a non-Saty-reader will see. Math unchanged; vocab swapped. (PR #305)

**Trades**
- `exit_ts` on ALL exit paths
- Replay: load candles with `beforeTs` (ts <= replay date), not latest
- Backfill before replay; 10m candles required for trades
- `replay-ticker-d1` needs `timed_trail.payload_json`; rows can exist with empty payloads (`rows>0`, `rows_with_payload_json=0`) and then diagnostics/replay process zero rows.
- Replay loads VIX daily candles from D1 for per-day VIX (requires VIX backfill); falls back to static KV
- Replay loads `ticker_profiles` from D1 for personality-aware SL/TP and lineage enrichment
- `signal_snapshot_json.lineage` includes `ticker_character` and `vix_at_entry` for post-trade analysis
- **Trimmed runner stale bug (fixed)**: doa-gate-v2 had 65 `TP_HIT_TRIM` trades at 66% trimmed that never closed — pullback support shield had no time limit, so structural support (price above any cloud low) shielded them indefinitely. Fix: `RUNNER_STALE_FORCE_CLOSE` at 120 market-hours + time-decaying shield buffers (full → zero over 48h) in both `evaluateRunnerExit` and EXIT lane. Config key: `deep_audit_runner_stale_force_close_hours`.
- **`STALL_FORCE_CLOSE` only for untrimmed**: The stall timer at `deep_audit_stall_force_close_hours` only fires when `trimmedPct < 0.01`. Trimmed trades use `RUNNER_STALE_FORCE_CLOSE` instead.
- **DA-3e (risk-off + choppy block) uses live market internals in replay**: execution_profile reads current VIX/internals, not historical. Must be disabled or use historical data during candle replay.
- **Current July iter-5 challenger is validated on equal scope**: Full recovered-baseline replay with current TT-core guards (`focused-iter5-full-baseline-current-guard--20260325-105601`) beat the recovered reference (`focused-iter5-validation-recovered-20260325--20260325-024751`) from 32 trades / 19W / 13L / +$634.63 to 20 trades / 18W / 2L / +$1,978.99. Biggest deltas: `FIX` -$99.90 → +$538.36, `RBLX` +$446.91 → +$466.97 with the bad `07-22` loser removed, `CELH` -$30.58 → +$24.39, `ETN` +$90.54 → +$364.20, `ULTA` +$155.28 → +$386.86, `CAT` +$72.38 → +$198.19.
- **The surgical TT-core guard that removed the last `RBLX` loser**: In `worker/pipeline/tt-core-entry.js`, block `LONG` `tt_pullback` entries in `correction_transition` when both 10m `5-12` and `8-9` are already above the cloud with meaningful extension and move-phase is already exhausted. This preserved the `RBLX` `07-08` / `07-10` winners while removing the `07-22` loser, and the equal-scope replay confirmed the broader lane still improved materially.

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
- `build-ticker-learning.js` must sanitize candle arrays before indicator/canonical enrichment: drop unreasonable future timestamps and trim each TF to `since` + bounded warmup so legacy manual-history outliers (for example `SPX`) do not blow up `slice(0, idx + 1)` costs.

**Markov / Regime Forecast** (5m bars, daily KV refresh)
- 5m bar = 1 tick → `timed_trail`; daily aggregation → `trail_5m_facts` (per `bucket_ts = floor(ts/300000)*300000`); daily compute → `timed:regime:matrix:global`
- **Universe matrix** + **per-ticker matrices for top-50 active tickers** at `timed:regime:matrix:ticker:{TICKER}` (manifest at `:_manifest`). Forecast read path prefers per-ticker, falls back to universe. (PR #309)
- **Expanded 12-state matrix** at `timed:regime:matrix:expanded:global` (4 quadrants × 3 completion bands: EARLY <30% / MID 30-70% / LATE >70%). Surfaced in `regime_forecast.expanded` alongside the 4-state version. 4-state still primary. (PR #311)
- Forecast payload: `regime_forecast = { state, p_next, p_5_bar, p_20_bar, p_1h, p_1d, p_1w, matrix_source, matrix_total_transitions, matrix_window_days, matrix_computed_at, expanded: {...} }`. Horizons via `matrixPower()` repeated squaring (cheap). (PR #310 added the long-horizon set)
- Matrix builder hardening (PR #308): `maxGapMs=12min` drops cross-session transitions; exponential recency decay (half-life 30d) means recent transitions count more. `counts` stays integer (back-compat); new `effective_counts` is weighted.
- Mathematically correct longer horizons via `P^n` — by `p_1w` (390 bars) the distribution converges to the stationary π (long-run regime baseline). Not a bug; informative for investor-mode users.
- Operator gates: `gates.markov_per_ticker_enabled` (default-on), `gates.adaptive_scoring_v1` (default-off), `gates.cell_markov_divergence_enabled` (default-off, shadow only).

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
- **`/timed/all` returns `data: { SYM: { ts, price, ... } }` — the value object has NO `ticker` field.** Always extract via `Object.entries(data).map(([k, v]) => ({ ticker: k, ...(v || {}) }))`. `Object.values(...).filter(t => t.ticker)` silently drops every entry.

**Engine — where the levers live** (May 2026 calibration session)
- `worker/pipeline/gates.js` — universal gates: RVOL dead zone, SHORT min rank, ticker blacklist (Gate 3 = `deep_audit_ticker_blacklist` from model_config; Gate 4 = hardcoded May calibration list NFLX/APD).
- `worker/pipeline/tt-core-entry.js` — entry pipeline. **Cohort overlays** (index_etf, megacap_tech, industrial, speculative, sector_etf) impose per-cohort caps. **`extensionMaxOverride` for megacap_tech was 8% — silently rejected every NVDA/TSLA/MSFT entry in trending tape for 60 days**. Raised to 15% in PR #194. Cohort ticker lists go stale; review quarterly.
- `worker/phase-c-setup-admission.js` — `(setup × DIRECTION × Grade)` admission matrix. Block via `block_when: "always"`, restrict via `allow_only_in: [...]`, gate via `min_rr` / `min_conviction`.
- `worker/phase-c-exit-doctrine.js` — per-setup force_exit / fresh_fail / regime_decay thresholds. `force_exit_pnl_threshold` was too aggressive at -1.0% (workhorse) / -0.5% (ATH); softened to -1.5% / -1.0% in PR #194 to stop killing trades on regime noise. Fresh-fail window shortened from 90 → 60 min so doctrine fires BEFORE the hard-loss cap.
- `worker/index.js` line ~18896 — Hard Loss Cap (`_hlcCapDollar`, `_hlcCapPct`, `_hlcMinHoldMs`). Defaults tightened to $250 / 4% / 15min in PR #194.

**Setup names (memorize)**
- LONG: `tt_gap_reversal_long` (workhorse, PF 2.98), `tt_pullback`, `tt_ath_breakout` (bleeding), `tt_range_reversal_long`, `tt_n_test_support`, `tt_momentum`
- SHORT: `tt_gap_reversal_short` (PF 8.86 — bear-regime only by design; **do not** open up in bull tape), `tt_atl_breakdown`, `tt_n_test_resistance`, `tt_range_reversal_short`
- Grades: Prime / Confirmed / Speculative. Speculative is generally blocked.
- Regimes: STRONG_BULL / EARLY_BULL / LATE_BULL / COUNTER_TREND_BULL / NEUTRAL / EARLY_BEAR / LATE_BEAR / STRONG_BEAR / COUNTER_TREND_BEAR

**Performance analysis recipe**
- `curl /timed/ledger/trades?limit=1000` → `python3 tasks/scripts/may-2026-perf.py`
- Always compute multiple windows (7d, current month, prior months, 30d, 90d, all-time). A single window misleads — March -$3K → April +$3K → May -$1K is a noisy 90-day flat, not a structural break.
- The diagnostic calibration report at `/timed/calibration/report` is authoritative for all-time per-setup stats (`entry_paths`). VIX buckets and regime_filters are currently empty (known calibration-pipeline gap).
- Calibration apply rejects `diagnostic_only: true` reports. The Insights `handleApply` transparently re-runs as promotion candidate first — replicate that pattern in any new apply consumer.

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
