# Phase C — Monthly Verdict · 2025-08

_Source: `phase-c-stage1-jul2025-may2026` · Trades in window: **76** · Generated 2026-05-03 12:22 UTC_

> Read this alongside the previous month's verdict. The point is **trajectory** —
> are we drifting toward July or away from it?

## 1 · Headline

- **59 closed trades.** 29W / 30L / 0 flat.
- **Win rate: 49.2%.** Target 55% — MISS.
- **Avg winner / Avg loser: 1.75x** (2.03% / 1.16%). Target 1.60x — PASS.
- **Max drawdown (cum %): 18.49%.** Target ≤ 3.0% — MISS.
- **Sharpe (annualized, daily-pct proxy): 2.83.** Target 1.50 — PASS.
- **Cumulative P&L (sum of pct): +24.10%.**

### Account equity (start $100,000 reference, ~$9,976 avg notional/trade)

_Each trade uses its actual recorded P&L (`trade.pnl` field) — not derived from %._

| Metric | Value |
|---|---|
| **Start balance** (entering this month) | **$110,306** |
| **End balance** (after last trade closed) | **$111,796** |
| **Net $ P&L for the month** | **$+1,490**  (+1.35% of start balance) |
| Sum of winning $ | +$5,233  (29 wins) |
| Sum of losing $ | -$3,743  (30 losses) |
| Biggest winner | **MP** +$815 (+6.10%) |
| Biggest loser | **CVNA** -$375 (-2.51%) |
| Run-to-date peak | $113,047 (on 2025-08-19) |
| Run-to-date max DD | -$1,990 (1.76%) (trough on 2025-08-22) |

### Day-by-day P&L (this month)

| Date | # Trades | Day P&L $ | End-of-day Balance |
|---|---:|---:|---:|
| 2025-08-01 | 1 | $-138 🔴 | $110,168 |
| 2025-08-05 | 5 | $+8 🟢 | $110,176 |
| 2025-08-06 | 3 | $+186 🟢 | $110,361 |
| 2025-08-07 | 5 | $+846 🟢 | $111,208 |
| 2025-08-08 | 1 | $-19 🔴 | $111,189 |
| 2025-08-11 | 2 | $+212 🟢 | $111,400 |
| 2025-08-12 | 1 | $+55 🟢 | $111,455 |
| 2025-08-13 | 6 | $+471 🟢 | $111,926 |
| 2025-08-14 | 3 | $+46 🟢 | $111,972 |
| 2025-08-15 | 1 | $+117 🟢 | $112,089 |
| 2025-08-18 | 2 | $+415 🟢 | $112,504 |
| 2025-08-19 | 8 | $-551 🔴 | $111,953 |
| 2025-08-20 | 4 | $-709 🔴 | $111,244 |
| 2025-08-21 | 2 | $+16 🟢 | $111,260 |
| 2025-08-22 | 1 | $-203 🔴 | $111,057 |
| 2025-08-27 | 3 | $+661 🟢 | $111,718 |
| 2025-08-28 | 5 | $-361 🔴 | $111,357 |
| 2025-08-29 | 6 | $+439 🟢 | $111,796 |

## 2 · The Proud (top winners)

What these have in common — pattern-match on setup, personality, regime, PDZ. If the next month
has fewer trades that look like this, the engine has drifted.

- **RDDT  ** L |  +9.35% | MFE +0.00% / MAE +0.00% | exit: `atr_week_618_full_exit` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRANSITIONAL · PDZ=premium
- **MP    ** L |  +6.10% | MFE +0.00% / MAE +0.00% | exit: `TP_FULL` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRENDING · PDZ=premium_approach · [PHv-]
- **BE    ** L |  +6.03% | MFE +0.00% / MAE +0.00% | exit: `ST_FLIP_4H_CLOSE` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRENDING · PDZ=premium
- **ALB   ** L |  +5.11% | MFE +0.00% / MAE +0.00% | exit: `SOFT_FUSE_RSI_CONFIRMED` | TT Tt Range Reversal Long · VOLATILE_RUNNER · TRANSITIONAL · PDZ=premium_approach · [RSIv-|PHv-]
- **B     ** L |  +3.77% | MFE +0.00% / MAE +0.00% | exit: `mfe_decay_structural_flatten` | TT Tt Gap Reversal Long · PULLBACK_PLAYER · TRANSITIONAL · PDZ=premium

## 3 · The Disappointed (worst losers)

Each one of these is a calibration question: was the entry the issue, the management, or the regime?
If the same `setup × personality × regime × side` shows up in 3+ disappointed trades, the next
calibration should raise the bar for that combo.

- **ALB   ** L |  -3.46% | MFE +0.00% / MAE +0.00% | exit: `max_loss` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRANSITIONAL · PDZ=premium_approach
- **SN    ** L |  -3.07% | MFE +0.00% / MAE +0.00% | exit: `max_loss` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRANSITIONAL · PDZ=premium_approach
- **CVNA  ** L |  -2.51% | MFE +0.00% / MAE +0.00% | exit: `max_loss_time_scaled` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRANSITIONAL · PDZ=discount_approach · [PHv-]
- **ANET  ** L |  -2.24% | MFE +0.00% / MAE +0.00% | exit: `max_loss_time_scaled` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRENDING · PDZ=premium · [RSIv-|PHv-]
- **STX   ** L |  -2.12% | MFE +0.00% / MAE +0.00% | exit: `max_loss_time_scaled` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRENDING · PDZ=premium · [PHv-]

## 4 · Profit giveback (MFE ≥ 1% closed flat-or-worse)

**0 trade(s).** This is the bucket Loop 1's MFE peak-lock targets directly.
If this list is long, the calibration question is: should peak-lock fire earlier?

_None._ Engine is locking gains well this month.

## 5 · Re-entry chains (tickers traded ≥ 3x)

Negative chains are the engine repeatedly being wrong about the same name.
If a chain is net negative AND we never paused, Loop 2's circuit breaker missed it.

- **APLD** — 3 trades, 2W/1L, **net +4.63%** 🟢
- **BE** — 3 trades, 2W/0L, **net +6.85%** 🟢
- **AAPL** — 3 trades, 0W/2L, **net -2.15%** 🔴
- **SPY** — 3 trades, 1W/1L, **net -0.20%** 🔴

## 6 · Setup performance

Bottom-quartile setups by win-rate AND volume are candidates for the next calibration to guard-rail.

| Setup | N | WR | Avg | Net |
|---|---:|---:|---:|---:|
| `TT Tt Gap Reversal Long` | 37 | 59% | +0.82% | +30.36% |
| `TT Tt Range Reversal Long` | 4 | 25% | +0.64% | +2.54% |
| `TT Tt Pullback` | 4 | 50% | +0.23% | +0.91% |
| `TT Tt Ath Breakout` | 4 | 25% | -0.16% | -0.65% |
| `TT Confirmed Long` | 1 | 0% | -1.55% | -1.55% |
| `TT Tt N Test Resistance` | 3 | 33% | -1.05% | -3.15% |
| `TT Tt N Test Support` | 6 | 33% | -0.73% | -4.35% |

## 7 · Personality × Setup (combos with 2+ trades)

Worst-WR combos at top — these are the immediate Loop 1 candidates.

| Personality | Setup | N | WR | Net |
|---|---|---:|---:|---:|
| PULLBACK_PLAYER | `TT Tt N Test Support` | 2 | 0% | -2.70% |
| PULLBACK_PLAYER | `TT Tt Ath Breakout` | 2 | 0% | -0.95% |
| VOLATILE_RUNNER | `TT Tt Range Reversal Long` | 3 | 33% | +4.41% |
| PULLBACK_PLAYER | `TT Tt N Test Resistance` | 3 | 33% | -3.15% |
| PULLBACK_PLAYER | `TT Tt Gap Reversal Long` | 6 | 50% | +2.61% |
| VOLATILE_RUNNER | `TT Tt Gap Reversal Long` | 30 | 63% | +27.95% |
| SLOW_GRINDER | `TT Tt N Test Support` | 2 | 100% | +1.32% |

## 8 · Loop firing log

Phase C self-adapting loops. Empty for any backtest run before the loops were enabled.

- **Loop 3** — `flat_cut`: 484 times

**Loop 1 scorecard snapshot** (end-of-month, min_samples=3):
- 🔴 BLOCK (6 combos): `tt_n_test_support:trending:pullback_player:L` (0W/3L), `momentum_score:trending:pullback_player:L` (0W/4L), `tt_pullback:trending:pullback_player:L` (1W/5L), `tt_ath_breakout:trending:pullback_player:L` (1W/4L), `tt_range_reversal_long:trending:pullback_player:L` (1W/3L), `tt_gap_reversal_long:transitional:volatile_runner:L` (3W/8L)
- 🟡 RAISE_BAR (5 combos): `tt_gap_reversal_long:trending:pullback_player:L` (3W/6L), `tt_ath_breakout:trending:volatile_runner:L` (1W/2L), `tt_range_reversal_long:transitional:volatile_runner:L` (1W/2L), `tt_pullback:trending:volatile_runner:L` (2W/3L), `tt_gap_reversal_long:choppy:volatile_runner:L` (2W/3L)
- 🟢 ALLOW (>0.45 WR): 3 combos

## 9 · Calibration notes (fill in by hand after reviewing above)

_Proposed flag deltas for the next month, with one-line justification each._

- [ ] (no change) — engine looks calibrated for this regime
- [ ] _Or list specific flag deltas. e.g.:_
      `deep_audit_mfe_peak_lock_retrace_pct: 50 → 40` because profit giveback list is long.

After deciding, edit `scripts/v15-activate.sh`, commit with message
`phase-c: 2025-08 calibration` and resume the next month.
