---
title: Handoff to Next Agent — Investor Backtest + Trend-Hold + Accumulation Deep Dive
created: 2026-05-08
from-agent: phase-c-stage1-jul-verdict-2e87 (multi-day session)
to-agent: fresh
---

# Handoff: Investor Backtest + Trend-Hold + Accumulation Deep Dive

**You are starting a fresh session.** This document is everything you need; the prior conversation context has been packed down to this handoff so you don't carry unnecessary churn. The full master plan lives at:

> `tasks/phase-c/INVESTOR_BACKTEST_AND_TREND_HOLD_PLAN.md` ← **read this in full before doing anything**

This file is the bootstrap. Read it, then go to the master plan.

---

## TL;DR — what the user wants

Three interrelated outcomes, in priority order:

1. **Deep-dive forensic analysis** of all the tickers that printed accumulation-then-trend behavior in the Jul 2025 → May 2026 promoted backtest. Specifically called out by user: GOOGL, SOXL, AMD, SNDK, MU. Plus AEHR, BE, GEV, NFLX, PLTR, NVDA, META, AVGO, TSM. For each, **what did our signals say at every key moment** (entry, +5%, +15%, +30%, breakout, peak), and **how should the engine have behaved** to ride them instead of round-tripping out at the first 1-2% pullback?

2. **Build the Trend-Hold hybrid module** — a third trade lifecycle state alongside Active Trader and Investor. A trade gets *promoted* to Trend-Hold when it has worked AND the trend is intact AND the structure is clean. While in Trend-Hold, management switches to investor-style: weekly-EMA trail, no time-based exits, 10/10/80 trim ladder, DCA on pullback instead of full exit. (Already designed in `tasks/phase-c/PHASE_3_DESIGN.md` §1.)

3. **Run a full Investor-mode backtest** for the same Jul→May window, with Trend-Hold enabled. Promote the result so the Trades page Investor column has real numbers and we can compare strategies side-by-side on the equity curve.

> User exact quote that triggered this work: *"hold a trade like SNDK or GOOGL or AMD or MU. These tickers rallied and never really broke trend and only continue to make new ATHs. Maybe its a hybrid between Investor Mode and Active Trader."*

---

## Critical context — what's already done (don't repeat)

### Phase C trader run (DONE — this is the seed)
- `run_id = phase-c-stage1-jul2025-may2026`, `live_config_slot = 1`
- 587 trades, 307W / 280L (52.3% WR), realized **+$40,086.44** (+40.09%)
- 218 trading days, +5.17 Sharpe, max DD -2.67%
- Promoted via `promoted_trade_datasets.dataset_id = 'promoted_phase-c-stage1-jul2025-may2026'`
- Seeded the trader account ledger via `d1SeedAccountLedgerFromPromoted`. Trader account currently shows: cash $140,086.44, realized +$40,086.44.

### What's broken / sensitive (don't trip these wires)

1. **Mystery wipe pattern** — twice in 24h (May 7, ~10am UTC and ~22:37 UTC) the account_ledger and live trades got wiped, replaced with 3 zombie positions (CDNS-1753988400000, CSX-1753987800000, ORCL-1753981200000) carrying their original July-2025 backtest IDs. Recovery each time required: mute cron → purge zombies → restore APD/SNDK from `direction_accuracy` → reseed ledger from promoted. **P0.7.103 added an INTEGRITY GUARD that auto-mutes the cron if trades or ledger row counts drop >50% in one cycle.** If you trigger a wipe during your work, the cron will auto-mute. Inspect via `GET /timed/admin/data-audit-log?key=…` to find which endpoint did it.

2. **Investor-replay returns `opened=0` for every day** — the Phase C trader-only run wrote day-state KV WITHOUT `tf_tech.D/W.stDir` and `monthly_bundle.supertrend_dir`, which the investor entry gate requires. **This is the gating dependency for Phase 3 of the plan.** Two paths to unblock: (a) rehydrate the day-state KV with the missing tech fields, or (b) re-replay all 218 days from raw candles with investor scoring enabled (Option C in PHASE_3_DESIGN.md).

3. **AI CIO is enabled** — `ai_cio_enabled=true` in model_config. The CIO consults `path_performance` (36 paths) and `direction_accuracy` (8,124 rows) for every entry. If you're running backtests that bypass live config, the CIO won't run unless you enable it in the replay env.

4. **Sector ratings updated to Fundstrat May 2026** — Real Estate upgraded to OW, Health Care upgraded to Neutral, Utilities downgraded to UW; Industrials/Tech still Double-OW. Don't revert these.

5. **`d1LoadTradesForSimulation` is hardened** — the live cron now ONLY loads trades with `run_id IS NULL`. Promoted backtest history is NEVER fed back into the live loop. Don't undo this without a careful redesign.

---

## What you have to work with (don't rewrite these)

### Existing tools

| Tool | What it does |
|---|---|
| `worker/replay-interval-step.js` | Interval-based replay (5-min step), supports cleanSlate |
| `worker/replay-candle-batches.js` | Candle batch processor (used for Phase C trader run) |
| `scripts/full-backtest.sh` | Already supports `--investor-only START END`, `--sequence`, `--trader-only` |
| `scripts/investor-backfill-jul-may.sh` | Scaffold that walks dates → calls `/timed/admin/investor-replay` per day |
| `scripts/continuous-slice.sh` | Multi-leg orchestration with `--keep-lock` to keep live cron muted |
| `worker/d1SeedAccountLedgerFromPromoted` | Generic seeder, takes `mode='trader'\|'investor'` |
| `POST /timed/admin/promoted-trades/promote` | Promote a run's trades into the live promoted dataset |
| `POST /timed/admin/account-ledger/seed-from-promoted` | Re-seed the ledger from active dataset |
| `GET /timed/admin/data-audit-log` | View all destructive-op audit trail |
| `worker/phase-c-exit-doctrine.js` | Where Trend-Hold management profile will hook in |
| `worker/pipeline/tt-core-entry.js` | Where investor entry gate logic lives (search `INVESTOR_BASE_ALLOC_PCT`, `monthly_bundle.supertrend_dir`) |

### Data already in D1
- `promoted_trades` — 587 finalized trader trades (Jul→May), with full entry/exit/PnL/setup_grade
- `direction_accuracy` — 8,124 rows of decision snapshots (entry signals, regime, setup, RR, MFE/MAE, exit reason). Use this for the Phase 1 deep dive.
- `path_performance` — 36 entry-path stats (WR, expectancy, recent-WR)
- `backtest_run_trades` / `backtest_run_direction_accuracy` — archived per-run versions

---

## Sequence — start here

1. **Read `tasks/phase-c/INVESTOR_BACKTEST_AND_TREND_HOLD_PLAN.md` in full.** Everything below references it.

2. **Phase 1 first — accumulation deep-dive** (read-only forensics, ~1 session):
   - Build `scripts/forensic-accumulation-tickers.js` to extract per-ticker timelines from `direction_accuracy.signal_snapshot_json` joined with `promoted_trades`.
   - Generate `tasks/phase-c/accumulation-trend-deep-dive.md` with per-ticker tables: at every inflection (entry, +5%, +15%, +30%, +50%, peak, exit), what did HTF state, regime_class, ema_regime, st_dir (D/W/monthly), TD9/TD13, RSI, sector rating, and entry_path say?
   - The deliverable is a pattern table answering: **which signal combinations consistently appeared at "should have held" moments**, and which combinations were red herrings (counter-examples).
   - **Do not** write Trend-Hold module code yet — tuning thresholds without this data risks repeating P0.7.63-65 catastrophic-loss mistakes.

3. **Phase 2 — Trend-Hold module** (~2-3 sessions). Pre-designed in PHASE_3_DESIGN.md §1. Add the schema columns, build `worker/trend-hold.js`, wire into `phase-c-exit-doctrine.js`, behind `deep_audit_trend_hold_enabled` feature flag (default off).

4. **Phase 3 — Investor backtest with Trend-Hold enabled** (~2 sessions). First unblock day-state KV (or fall back to re-replay from raw candles). Then run 11 monthly legs Jul→May. Then promote.

5. **Phase 4 — validate, document, ship** (~1 session). Compare trader vs investor on equity curve. Set `deep_audit_trend_hold_enabled=true` in live model_config. Update HANDOFF for the next round.

---

## Decisions deferred to you

These were debated in the prior session and you should make the call based on the deep-dive:

1. **Trend-Hold promotion threshold for MFE** — start at +5% per the design doc, but the deep-dive may suggest +8% or +12% is the right floor. **Don't promote a 5% gain that's about to roll over.**
2. **Position cap** — 3 simultaneous Trend-Hold positions starts the design, but the user may want more (5-7) given that Investor mode has 15-position cap. Make this configurable via `deep_audit_trend_hold_max_positions`.
3. **Earnings handling for Trend-Hold** — pause promotion 3 days pre-earnings? Or trim 50% pre-earnings and re-add post? The deep-dive should reveal whether the accumulation-trend names tend to gap up or down on earnings (different per `behavior_type`).
4. **DCA aggressiveness** — when a Trend-Hold position pulls back 5-10% but stays in MOMENTUM_ELITE, do we add to the position (DCA the dip) or just hold? Investor mode does this via `dca_next_ts`. The deep-dive should show how often this would have been right vs wrong.

---

## Constraints

- **DO NOT touch live trader trades or the account_ledger** without writing an audit row first (use `auditDataChange()` helper). The integrity guard will mute the cron if you wipe data.
- **DO NOT remove the `run_id IS NULL` filter from `d1LoadTradesForSimulation`** — that's what prevents the zombie-resurrection pattern.
- **DO NOT enable Trend-Hold in live before backtest validation** — same lesson as P0.7.63-65: any new exit doctrine needs a March-2026 leg replay to confirm it doesn't reintroduce catastrophic losses.
- **DO commit per logical change** with descriptive messages and push the branch — the user reviews PRs as you go.
- **DO use the existing audit-log + integrity-guard infrastructure** rather than building parallel observability.

---

## Open questions for the user (before you start coding)

If you need to ask the user anything before kicking off Phase 1, batch them and ask once. Likely candidates:

1. Ticker list for the deep-dive — confirm the initial 14 (GOOGL, SOXL, AMD, SNDK, MU, AEHR, BE, GEV, NFLX, PLTR, NVDA, META, AVGO, TSM) is the right set, or do you want to add SMCI / TSLA / PANW / etc.?
2. Trend-Hold cap — start at 3 simultaneous positions, or higher?
3. Investor backtest scope — full Jul→May with Trend-Hold enabled (recommended), or run two backtests (one with, one without) so we can A/B the Trend-Hold contribution?

---

Good luck. The user is technical, wants concise updates with numbers + tables, and prefers commit-as-you-go over big-bang PRs.
