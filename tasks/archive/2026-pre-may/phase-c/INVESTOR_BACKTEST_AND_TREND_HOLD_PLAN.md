---
title: Investor Backtest + Trend-Hold + Accumulation Deep Dive — Master Plan
created: 2026-05-08
owner: next-agent
status: planning
---

# Investor Backtest + Trend-Hold Hybrid — Master Plan

## Why this plan exists

The current live model trades ~150 names with an Active-Trader profile (1-5 day holds, 1-2% risk per name). Forensic on the Phase C Jul→May backtest shows a **systemic edge we've been leaving on the table**:

> "We should hold a trade like SNDK or GOOGL or AMD or MU. These tickers rallied and never really broke trend and only continue to make new ATHs. Maybe it's a hybrid between Investor Mode and Active Trader." — *user, Apr 2026*

Concrete examples from the Jul→May promoted run (already seeded in `promoted_trades`):

| Ticker | Trader trades | Net PnL | What we left on the table |
|---|---:|---:|---|
| **SNDK** | 11 (WR 73%) | +$4,034 | rallied ~80% Aug→Mar without breaking weekly structure. 11 round-trips at ~5% each. **One position held = ~80% return** instead of 5%. |
| **AEHR** | 9 (WR 89%) | +$2,688 | Same pattern: clean uptrend, never let a winner ride |
| **BE** | 9 (WR 78%) | +$2,508 | Same |
| AMD / MU / GOOGL | small n | various | Often filtered out by rank cutoffs; when entered, exited on first ATR pullback |
| SOXL | small n | various | Sectoral mega-trend, exited too early |

The user wants three things, in priority order:

1. **A full Investor-mode backtest** Jul 2025 → May 2026 (Phase C parameters but Investor strategy) — *so the Trades-page Investor column has real numbers, the equity curve compares trader vs investor, and we have an honest baseline of what Investor-mode would have done.*
2. **A deep-dive analysis of accumulation-then-trend tickers** (GOOGL, SOXL, AMD, SNDK, MU, AEHR, BE, etc.) — *what did our signals say while these were ramping, and how do we tune the engine to hold and add instead of round-tripping?*
3. **Trend-Hold hybrid implementation** (already designed in `tasks/phase-c/PHASE_3_DESIGN.md` §1) — *promote Active-Trader winners to a held-and-managed Investor profile when quality + trend integrity + structural-intact gates pass.*

This plan ties all three together as a single workstream with clear handoff points.

---

## Current state (everything the next agent needs to know)

### Live system
- Cron is **unmuted**, model running. P0.7.103 integrity guard auto-mutes if trade/ledger row counts drop >50% in one cycle.
- Account: `$140k cash + ~$10k cost basis` (one OPEN position: SNDK 7sh @ $1348.13). APD was exited as LOSS earlier today.
- AI CIO **enabled** (`ai_cio_enabled=true` in `model_config`). `direction_accuracy` has 8,124 rows (587 promoted + ~7,500 live/historical). `path_performance` has 36 paths.
- Sector ratings updated to Fundstrat May 2026 weights this evening (Real Estate upgraded to OW, Health Care upgraded to Neutral, Utilities downgraded to UW; Industrials/Tech still Double-OW).

### Phase C trader run (the seed)
- `run_id = phase-c-stage1-jul2025-may2026`, `live_config_slot=1`
- 587 trades, 307W / 280L (52.3% WR), realized **+$40,086.44** (+40.09%)
- 218 trading days, +5.17 Sharpe, max DD -2.67%
- Promoted via `promoted_trade_datasets` → seeds the trader account ledger via `d1SeedAccountLedgerFromPromoted`

### Tools we already have (don't rewrite)
- `worker/replay-interval-step.js` — interval-based replay (5-min step) with cleanSlate option
- `worker/replay-candle-batches.js` — candle batch processor (used for trader run)
- `scripts/full-backtest.sh` — already supports `--investor-only START END`, `--sequence`, `--trader-only`
- `scripts/investor-backfill-jul-may.sh` — scaffold for per-day investor-replay walk
- `scripts/continuous-slice.sh` — orchestrates multi-leg backtests with `--keep-lock` to mute live cron
- `worker/d1SeedAccountLedgerFromPromoted` — generic ledger seeder; reads from `promoted_trades` table; takes `mode` parameter (`trader|investor`)
- `POST /timed/admin/promoted-trades/promote` — promote a run's trades into the live promoted dataset
- `POST /timed/admin/account-ledger/seed-from-promoted` — re-seed the ledger from active dataset
- `data_audit_log` — every destructive op now logged (P0.7.95 + P0.7.103)

### Known blockers from prior planning
- **Day-state KV missing tf_tech.D/W.stDir** for the trader-only Phase C run — investor-replay returns `opened=0` because the entry gate requires SuperTrend monthly bullish. **Must rehydrate day-state before per-day investor-replay can work.** OR re-replay from raw candles with investor scoring enabled (Option C in PHASE_3_DESIGN.md).
- Investor entry gate logic lives in `worker/pipeline/tt-core-entry.js` (search for `INVESTOR_BASE_ALLOC_PCT`, `monthly_bundle.supertrend_dir`).

---

## Phase 1 — Accumulation deep-dive (read-only, ~1 day of agent work)

**Goal:** Build a forensic dataset of the 10-15 tickers that printed accumulation-then-trend behavior in the Jul→May window. For each, snapshot what our signals said at every critical inflection (entry, accumulation, breakout, ride, top, exit).

### Target tickers (initial list)
GOOGL, SOXL, AMD, SNDK, MU, AEHR, BE, GEV, NFLX, PLTR, NVDA, META, AVGO, TSM. Augment by querying `promoted_trades` for `ticker IN (...) AND held_days >= 5 AND pnl_pct > 5`.

### Data to extract per ticker (per inflection point)
For each of: entry, +5%, +15%, +30%, +50%, peak, current/exit:

| Field | Source | Why it matters |
|---|---|---|
| HTF state, regime_class, regime_combined | `direction_accuracy.signal_snapshot_json` | tells us what regime classifier said |
| ema_regime (D, 4H, 1H), st_dir (D, W, monthly) | same | trend strength + persistence |
| TD9/TD13 prints | same | exhaustion warnings |
| RSI-D, RSI-4H | same | divergence detection |
| Pivot S/R distance, ATR fib pos | `ticker_scenario` (recompute) | structural support |
| Setup gradeName, conviction score | `direction_accuracy.entry_quality_score` | model's own confidence |
| Sector rating (current) | `getSectorRating()` | tailwind/headwind |
| Market regime (SPY state at that time) | `direction_accuracy` of SPY | broader context |
| **What the model decided** | `path_performance` for that entry_path | did the engine BOOST or DISABLE? |
| **What the model SHOULD have decided** | manual review with hindsight | label for tuning |

### Deliverable
`tasks/phase-c/accumulation-trend-deep-dive.md` containing:
1. Per-ticker timeline with all inflections
2. Pattern table: which signal combinations consistently appeared at "should have held" moments
3. Counter-examples: tickers that LOOKED like accumulation-then-trend but reversed (so we don't over-fit)
4. Concrete tuning recommendations for the trend-hold module (specific thresholds, not vague)

### Scripts to add
- `scripts/forensic-accumulation-tickers.js` — pulls direction_accuracy + signal_snapshot for the target ticker list, joins on promoted_trades, writes CSV + markdown to `data/trade-analysis/accumulation-trend/`

---

## Phase 2 — Trend-Hold module (greenfield code, ~2-3 days)

Pre-designed in `tasks/phase-c/PHASE_3_DESIGN.md` §1. Summary:

### Schema additions
```sql
ALTER TABLE trades ADD COLUMN trend_hold_promoted_at INTEGER;
ALTER TABLE trades ADD COLUMN trend_hold_demoted_at INTEGER;
ALTER TABLE trades ADD COLUMN trend_hold_state TEXT;  -- "active" | "demoted" | null
ALTER TABLE trades ADD COLUMN trend_hold_max_mfe_pct REAL;
```

### New module: `worker/trend-hold.js`
```js
export function shouldPromoteToTrendHold(trade, tickerData, opts)
export function shouldDemoteFromTrendHold(trade, tickerData, opts)
export function getTrendHoldExitDoctrine(trade, tickerData)  // overrides phase-c-exit-doctrine
```

### Promotion criteria (start-points; tune from Phase 1 deep-dive)
- MFE >= +5% (the trade has worked)
- HTF state in {MOMENTUM_ELITE, STRONG_BULL, HTF_BULL_LTF_BULL, HTF_BULL_LTF_PULLBACK}
- Daily SuperTrend bull AND Weekly SuperTrend bull
- No weekly TD9/TD13 sell prints
- Sector rating != underweight
- Not in pre-earnings window (<3 days)
- Not currently in TP_HIT_TRIM with trimmed_pct > 0.5

### Demotion criteria
- Weekly close below EMA-21 (clean — ignore intra-week wicks)
- Daily SuperTrend flips bear AND price closes below pivot S2
- Weekly TD9 sell prints
- HTF state degrades for 3+ consecutive sessions
- Macro shock: SPY -3% in a single session OR VIX > 35

### Management profile (overrides `phase-c-exit-doctrine`)
- **No time-based exits** (no stagnant_exit, no fresh_failure, no doctrine_giveback unless extreme)
- **Trail stop = weekly EMA-21** (not daily ATR-multiple)
- **Trim ladder** = investor-style (10% on +20%, 10% on +50%, hold 80%)
- **Re-entry on pullback** instead of full exit (DCA the dip when stage flips back to BULL after a 5-10% giveback)
- **Cap**: max 3 simultaneous Trend-Hold positions (drop lowest-MFE if a 4th qualifies)

### Wiring
- `worker/phase-c-exit-doctrine.js` — check `trend_hold_state === 'active'` first; if true, delegate to `getTrendHoldExitDoctrine`
- `worker/index.js` `processTradeSimulation` — after each tick, call `shouldPromoteToTrendHold`/`shouldDemoteFromTrendHold` and stamp the trade row
- Frontend (right rail / kanban): `🚀 Trend-Hold` chip when `trend_hold_state === 'active'`. Active Trader stage shows "Riding the runner" instead of "Active management."

### Feature flag
`deep_audit_trend_hold_enabled = false` initially. Enable per-leg in backtest, then live.

---

## Phase 3 — Investor backtest Jul→May (~6-8 hours wall, ~2 days agent work)

Goal: Run the **full Investor-mode backtest** with Trend-Hold enabled, on the same window as the Phase C trader run, then promote the result so the Investor column on Trades page is alive.

### Pre-flight (estimated 1-2 hours)
1. **Rehydrate day-state KV with tf_tech**. The Phase C trader run wrote day-state without `tf_tech.D/W.stDir` and `monthly_bundle.supertrend_dir`. Two paths:
   - Replay each day with `--include-tech-fields` (need to plumb this option through `replay-candle-batches.js`)
   - OR run a separate "tech-only" pass that just computes those fields from raw candles + KV-writes them to the existing day-state blobs
2. **Verify investor-mode entry gate** by hitting `/timed/admin/investor-replay?date=2025-07-01` for a single day — should return `opened > 0` (currently returns 0).
3. **Wire Trend-Hold module behind feature flag** so investor replay uses the hybrid logic.

### Backtest execution (multi-leg, mirroring Phase C trader pattern)
```bash
# Run Jul 2025 → May 2026 in monthly legs to keep individual leg <60 min
./scripts/full-backtest.sh --investor-only --trend-hold-enabled \
  --start 2025-07-01 --end 2025-08-01 --leg-name jul-2025
# ... repeat for each month, with checkpoint resume
# OR use continuous-slice.sh with --keep-lock
./scripts/continuous-slice.sh --mode investor --start 2025-07-01 --end 2026-05-04 --keep-lock
```

Each leg writes:
- `account_ledger mode='investor'` rows (cash + realized P&L per event)
- `investor_positions` rows (open positions with avg_entry, cost_basis, peak_price)
- `investor_lots` rows (each buy/sell lot for tax + DCA tracking)
- `direction_accuracy` rows (one per investor entry, prefixed `inv-promo-` to distinguish)

### Verdict + tuning loop (per leg, ~30 min each)
After each leg:
1. Generate verdict markdown (`tasks/phase-c/monthly-verdicts/2025-MM-investor.md`)
2. Compare to trader leg same month (which trades did we hold vs round-trip? what was the MFE differential?)
3. If Trend-Hold promotions are too aggressive → tighten promotion gates and re-run from checkpoint
4. If too few promotions → loosen criteria within bounds

### Promotion + seed
After all 11 legs complete:
1. Finalize the run via `POST /timed/admin/runs/finalize` (which also runs the P0.7.95 position-status sync to prevent zombies)
2. Promote via `POST /timed/admin/promoted-trades/promote?run_id=phase-c-stage2-investor-jul2025-may2026&seed_account_ledger=true`
3. Verify Trades page Investor column shows the new equity curve
4. Validate `account_ledger mode='investor'` matches expected end balance

### Expected outcomes
- **Investor account end value:** $130-180k (vs trader $140k). Hypothesis: investor strategy is steadier (lower DD) but may underperform trader on raw return because it requires the trend-hold criteria to fire (which limits frequency).
- **Trend-Hold positions captured:** 5-15 throughout the year. SNDK / AEHR / BE almost certainly. GOOGL, AMD, MU contingent on entry-gate tuning.
- **Equity curve shape:** smoother, with 2-3 visible "ride the runner" steps where a trend-hold winner adds 5-10% to the curve over a single month.

---

## Phase 4 — Validate, document, and ship (after Phase 3 completes)

1. **Compare strategies**: Side-by-side trader vs investor on the equity curve UI. Sharpe, max DD, win rate, avg trade.
2. **Promote Trend-Hold to live**: Set `deep_audit_trend_hold_enabled=true` in live model_config. The live cron starts evaluating promotion criteria each tick.
3. **Document in HANDOFF**: Append a "Trend-Hold operational" section explaining the new lifecycle state + how to disable in case of issue.
4. **Add observability**: Discord alert when a position is promoted to Trend-Hold; weekly summary of active Trend-Hold positions and their MFE.

---

## Risks / open questions for the next agent

1. **Day-state KV rehydration** is the gating dependency for Phase 3. If it can't be done cleanly, fall back to **Option B** from PHASE_3_DESIGN.md (re-run all 218 trading days from raw candles with investor scoring enabled — adds ~4 hrs but doesn't depend on KV state).
2. **Trend-Hold could re-introduce the catastrophic losses we cut in P0.7.63-65.** The gave-back rule we tuned (force_exit only when 90% giveback AND now-losing AND 2+ sessions old) is the floor — any Trend-Hold rule must keep this guarantee. Run targeted backtest leg on March 2026 (the rough month) before promoting to live.
3. **Sample size**: even with the Phase C run, only ~10-15 promotions per year. Not enough for ML — must be rule-based, validated against the deep-dive in Phase 1.
4. **Position cap**: 3 simultaneous Trend-Hold capped at 7% each = 21% of account locked in slow-bleed-or-massive-win mode. Plus active-trader positions = 21% + 50% ≈ 71% deployed. Need to ensure cash management doesn't starve new entries.
5. **Earnings windows**: Trend-Hold rules pause during pre-earnings (3-day window) but the deep-dive should validate whether to TRIM ahead of earnings or HOLD through (different decision per ticker behavior_type).

---

## How the next agent should start

1. Read `tasks/phase-c/HANDOFF.md` (the current session summary, separate file).
2. Read `tasks/phase-c/PHASE_3_DESIGN.md` §1 for the original Trend-Hold design rationale.
3. Read this file (`INVESTOR_BACKTEST_AND_TREND_HOLD_PLAN.md`) for the consolidated workplan.
4. **Phase 1 first** — the deep-dive forensics. Don't write any new module code until the per-ticker timeline + pattern table is done. Tuning the promotion thresholds without that data risks repeating P0.7.63-65 mistakes.
5. Then sequence: Phase 2 (module) → Phase 3 (backtest) → Phase 4 (promote + ship).

---

## Estimated total effort

| Phase | Scope | Wall time | Agent compute |
|---|---|---|---|
| 1 — Deep dive | Forensics on 14 tickers, no code beyond the extraction script | ~1 session | low |
| 2 — Trend-Hold module | New file, schema migration, wiring, unit tests | ~2-3 sessions | medium |
| 3 — Investor backtest | Day-state rehydration + 11 monthly legs + per-leg verdicts | ~2 sessions (mostly waiting for replay) | high (compute) |
| 4 — Validate + ship | Strategy comparison, doc, live promotion | ~1 session | low |

Total: 4 focused sessions for a new agent to deliver this end-to-end.
