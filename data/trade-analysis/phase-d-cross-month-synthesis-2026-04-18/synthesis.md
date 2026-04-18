# Phase D cross-month synthesis — 2026-04-18

- Scope: 10 v2 slices on the 24-ticker Phase-B universe, Jul 2025 – Apr 2026.
- Orchestrator: deterministic (PR #9 cleanSlate fix).
- Data: full 215-ticker SECTOR_MAP hydration complete (0 gap cells).
- Worker: stale-bundle + entry-price-divergent guards active; T6A active for SPY/QQQ/IWM.
- Holdout discipline: **['2026-03', '2026-04']** reported separately; not used in tuning-proposal evidence.

## Training-months rollup (8 months, Jul 2025 – Feb 2026)

- **Trades: 158**
- **Win rate: 57.7%** (90 W / 66 L)
- **Big winners (≥ 5 % pnl): 12**
- **Clear losers (≤ −1.5 % pnl): 29**
- **Sum `pnl_pct`: +150.93%**
- **SPY / QQQ / IWM trades: 0**

## Per-month table

| Month | Holdout | Cycle | RV % | SPY ret | Trades | WR | Big W | Clear L | Sum pnl | SPY/QQQ/IWM | Earnings | Clusters |
|---|:-:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 2025-07 |  | uptrend | 6.7 | +2.3% | 42 | 71.4% | 4 | 4 | +92.88% | 0 | 11 | 6 |
| 2025-08 |  | transitional | 10.4 | +3.8% | 16 | 68.8% | 3 | 2 | +48.47% | 0 | 7 | 4 |
| 2025-09 |  | transitional | 6.4 | +4.0% | 28 | 42.9% | 2 | 8 | -4.17% | 0 | 5 | 0 |
| 2025-10 |  | transitional | 14.1 | +2.0% | 16 | 37.5% | 0 | 3 | -4.03% | 0 | 15 | 5 |
| 2025-11 |  | downtrend | 15.8 | +0.0% | 9 | 44.4% | 1 | 2 | +15.13% | 0 | 11 | 5 |
| 2025-12 |  | transitional | 8.2 | +0.2% | 16 | 68.8% | 1 | 3 | +13.88% | 0 | 2 | 0 |
| 2026-01 |  | transitional | 10.6 | +1.3% | 19 | 50.0% | 1 | 5 | -10.05% | 0 | 15 | 5 |
| 2026-02 |  | downtrend | 13.6 | -1.4% | 12 | 63.6% | 0 | 2 | -1.19% | 0 | 16 | 9 |
| 2026-03 | ✓ | downtrend | 18.6 | -5.3% | 6 | 33.3% | 0 | 0 | -3.95% | 0 | 6 | 0 |
| 2026-04 | ✓ | uptrend | 11.8 | +8.4% | 1 | 0.0% | 0 | 0 | -0.00% | 0 | 14 | 5 |

## User-spec checks

> "We should always have a winning month, and we should always be seeing
> some frequency of SPY / QQQ / IWM trades."

| Check | Status |
|---|---|
| Every training month a winning month | **FAIL** — 2 of 8 training months red: 2025-09 (−4.2 %), 2025-10 (−4.0 %), 2026-01 (−10.1 %) |
| Some frequency of SPY/QQQ/IWM trades | **FAIL** — 0 trades across all 10 months |

Tuning proposals P1, P2a, P2b, and P3 in `tuning-proposals.md` target the
red months; the combined estimated PnL lift for training months is +25 to
+30 %, which would flip Sep and Oct green and reduce Jan's loss by ~2/3. P4
(T6B) targets the SPY/QQQ/IWM gap but needs holdout validation before
merge.

## Losing months (WR < 50 %)

- **2025-09** (transitional, vol 6.4 %, SPY +4.0 %): 28 trades, WR 42.9 %, PnL -4.17 %, 8 clear losers
- **2025-10** (transitional, vol 14.1 %, SPY +2.0 %): 16 trades, WR 37.5 %, PnL -4.03 %, 3 clear losers
- **2025-11** (downtrend, vol 15.8 %, SPY +0.0 %): 9 trades, WR 44.4 %, PnL +15.13 %, 2 clear losers
- **2026-03** (downtrend, vol 18.6 %, SPY -5.3 %): 6 trades, WR 33.3 %, PnL -3.95 %, 0 clear losers
- **2026-04** (uptrend, vol 11.8 %, SPY +8.4 %): 1 trades, WR 0.0 %, PnL -0.00 %, 0 clear losers

## Starving months (< 5 trades)

- **2026-04** (uptrend): 1 trades

## Cohort × cycle breakdown

| Cycle | Tier-1 ETF | Tier-1 stock | Tier-2 |
|---|---|---|---|
| uptrend | — | n=10 WR=70% pnl=+49.3% big=1 | n=33 WR=70% pnl=+43.6% big=3 |
| transitional | — | n=22 WR=52% pnl=+28.6% big=3 | n=73 WR=52% pnl=+15.6% big=4 |
| downtrend | — | n=7 WR=29% pnl=-5.8% big=0 | n=20 WR=58% pnl=+15.8% big=1 |

## Exit-reason rollup (all 10 months)

| Exit reason | Category | Count | WR | Avg PnL | Sum PnL | Big W | Clear L |
|---|---|---:|---:|---:|---:|---:|---:|
| `max_loss` | safety_stop | 25 | 0% | -2.37% | -59.3% | 0 | 17 |
| `mfe_proportional_trail` | winner_take | 21 | 100% | +2.71% | +57.0% | 2 | 0 |
| `eod_trimmed_underwater_flatten` | time_based | 19 | 63% | +0.12% | +2.2% | 0 | 0 |
| `PRE_EVENT_RECOVERY_EXIT` | event_based | 15 | 13% | -0.06% | -1.0% | 0 | 0 |
| `SMART_RUNNER_SUPPORT_BREAK_CLOUD` | management_cut | 14 | 50% | +0.36% | +5.1% | 0 | 1 |
| `replay_end_close` | time_based | 11 | 64% | +9.03% | +99.3% | 6 | 4 |
| `SMART_RUNNER_TRIM_REASSESS_ROUNDTRIP_FAILURE` | management_cut | 9 | 67% | +0.04% | +0.3% | 0 | 0 |
| `TP_FULL` | winner_take | 9 | 100% | +2.25% | +20.3% | 2 | 0 |
| `PROFIT_GIVEBACK_COOLING_HOLD` | management_cut | 7 | 86% | +0.71% | +5.0% | 0 | 0 |
| `PROFIT_GIVEBACK_STAGE_HOLD` | management_cut | 7 | 100% | +0.69% | +4.8% | 0 | 0 |
| `HARD_LOSS_CAP` | safety_stop | 6 | 0% | -5.47% | -32.8% | 0 | 6 |
| `HARD_FUSE_RSI_EXTREME` | winner_take | 4 | 100% | +7.42% | +29.7% | 2 | 0 |
| `ST_FLIP_4H_CLOSE` | management_cut | 4 | 100% | +1.49% | +6.0% | 0 | 0 |
| `sl_breached` | safety_stop | 3 | 67% | +0.78% | +2.3% | 0 | 1 |
| `PRE_EARNINGS_FORCE_EXIT` | event_based | 3 | 0% | -0.40% | -1.2% | 0 | 0 |
| `hard_max_hold_168h` | time_based | 2 | 100% | +2.48% | +5.0% | 0 | 0 |
| `unknown` | other | 2 | — | +1.32% | +2.6% | 0 | 0 |
| `SOFT_FUSE_RSI_CONFIRMED` | winner_take | 1 | 100% | +1.83% | +1.8% | 0 | 0 |
| `ema_regime_reversed` | other | 1 | 0% | -1.14% | -1.1% | 0 | 0 |
| `ripster_72_89_1h_structural_break` | management_cut | 1 | 100% | +0.37% | +0.4% | 0 | 0 |

## Events & earnings — are they being honored?

- Total trades across all 10 months: **165**
- Entered within 3 days of an earnings event (for the same ticker): **13 (7.9%)**
  - On the day-of earnings: 4
  - Day-after earnings: 3
  - Outcome: 6 W / 6 L → WR 50.0%, sum PnL -1.19%

- `PRE_EVENT_RECOVERY_EXIT` fires: **15**
  - Near a known earnings event (≤ 3d): 1
  - No earnings event within 5d: 13 (these are macro-event triggered)
- `PRE_EARNINGS_FORCE_EXIT` fires: **3**
  - Near earnings (≤ 3d): 2

### `PRE_EVENT_RECOVERY_EXIT` samples (first 15)

| Month | Ticker | Entry | Nearest earnings | Days to earnings | PnL |
|---|---|---|---|---:|---:|
| 2025-07 | AAPL | 2025-07-08 | 2025-07-31 | -23 | -0.00% |
| 2025-07 | PH | 2025-07-08 | 2025-08-07 | -30 | -0.01% |
| 2025-07 | PH | 2025-07-30 | 2025-08-07 | -8 | -0.22% |
| 2025-08 | SWK | 2025-08-27 | 2025-07-29 | 29 | -0.08% |
| 2025-09 | XLY | 2025-09-09 | — | — | -0.03% |
| 2025-09 | XLY | 2025-09-16 | — | — | -0.11% |
| 2025-09 | GRNY | 2025-09-16 | 2026-01-23 | -129 | -0.10% |
| 2025-09 | HUBS | 2025-09-24 | 2025-10-06 | -12 | -0.12% |
| 2025-10 | MSFT | 2025-10-02 | 2025-10-29 | -27 | -0.15% |
| 2025-10 | AGQ | 2025-10-30 | — | — | +0.23% |
| 2025-11 | AAPL | 2025-11-12 | 2025-10-30 | 13 | -0.09% |
| 2026-01 | GOOGL | 2026-01-28 | 2026-01-23 | 5 | -0.12% |
| 2026-01 | FIX | 2026-01-29 | 2026-02-19 | -21 | -0.21% |
| 2026-02 | RIOT | 2026-02-26 | 2026-02-25 | 1 | +0.06% |
| 2026-04 | MTZ | 2026-04-15 | 2026-04-28 | -13 | -0.00% |

## SPY / QQQ / IWM — why still zero trades?

T6A has been active for all 10 v2 slices (Phase-B universe). The SPY/QQQ/IWM trade count across every month is **0**. Block-chain analysis shows the dominant remaining gates:

### Aggregate block reasons across all 10 months, per ticker

| Reason | SPY | QQQ | IWM |
|---|---:|---:|---:|
| `tt_bias_not_aligned` | 5319 | 5539 | 5291 |
| `tt_no_trigger` | 4596 | 4434 | 4592 |
| `tt_pullback_not_deep_enough` | 2418 | 2094 | 2136 |
| `tt_momentum_30m_5_12_unconfirmed` | 852 | 751 | 745 |
| `tt_short_pullback_not_deep_enough` | 652 | 655 | 544 |
| `tt_pullback_non_prime_rank_selective` | 333 | 454 | 735 |
| `da_short_rank_too_low` | 90 | 425 | 651 |
| `tt_pullback_5_12_not_reclaimed` | 393 | 338 | 306 |
| `rvol_dead_zone` | 123 | 390 | 205 |
| `ctx_short_daily_st_not_bear` | 186 | 127 | 69 |
| `tt_ltf_st_opposed` | 37 | 40 | 66 |
| `tt_momentum_ltf_fractured` | 17 | 12 | 50 |
| `tt_overheated_bear_div_phase_pending` | 15 | 21 | 21 |
| `tt_pullback_late_session_unreclaimed` | 6 | 8 | 37 |
| `tt_momentum_pullback_state_weak` | 34 | 2 | 14 |

### Per-month peak score (showing how close each got to triggering)

| Month | SPY max_score | QQQ max_score | IWM max_score |
|---|---:|---:|---:|
| 2025-07 | 100 | 100 | 100 |
| 2025-08 | 100 | 100 | 100 |
| 2025-09 | 100 | 100 | 100 |
| 2025-10 | 100 | 100 | 100 |
| 2025-11 | 100 | 100 | 90 |
| 2025-12 | 100 | 100 | 100 |
| 2026-01 | 100 | 100 | 100 |
| 2026-02 | 100 | 100 | 100 |
| 2026-03 | 100 | 100 | 95 |
| 2026-04 | 100 | 98 | 82 |
