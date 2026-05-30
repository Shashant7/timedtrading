# Phase C — Monthly Verdict · 2025-12

_Source: `phase-c-stage1-jul2025-may2026` · Trades in window: **54** · Generated 2026-05-05 11:58 UTC_

> Read this alongside the previous month's verdict. The point is **trajectory** —
> are we drifting toward July or away from it?

## 1 · Headline

- **51 closed trades.** 26W / 25L / 0 flat.
- **Win rate: 51.0%.** Target 55% — MISS.
- **Avg winner / Avg loser: 2.18x** (2.12% / 0.97%). Target 1.60x — PASS.
- **Max drawdown (cum %): 10.40%.** Target ≤ 3.0% — MISS.
- **Sharpe (annualized, daily-pct proxy): 4.41.** Target 1.50 — PASS.
- **Cumulative P&L (sum of pct): +30.92%.**

### Account equity (start $100,000 reference, ~$9,735 avg notional/trade)

_Each trade uses its actual recorded P&L (`trade.pnl` field) — not derived from %._

| Metric | Value |
|---|---|
| **Start balance** (entering this month) | **$125,583** |
| **End balance** (after last trade closed) | **$129,348** |
| **Net $ P&L for the month** | **$+3,765**  (+3.00% of start balance) |
| Sum of winning $ | +$5,265  (26 wins) |
| Sum of losing $ | -$2,363  (25 losses) |
| Biggest winner | **SATS** +$989 (+8.38%) |
| Biggest loser | **AGQ** -$309 (-5.06%) |
| Run-to-date peak | $129,775 (on 2025-12-22) |
| Run-to-date max DD | -$2,953 (2.32%) (trough on 2025-11-18) |

### Day-by-day P&L (this month)

| Date | # Trades | Day P&L $ | End-of-day Balance |
|---|---:|---:|---:|
| 2025-12-02 | 1 | $+90 🟢 | $125,673 |
| 2025-12-04 | 4 | $+6 🟢 | $125,678 |
| 2025-12-08 | 1 | $-70 🔴 | $125,608 |
| 2025-12-09 | 1 | $+212 🟢 | $125,820 |
| 2025-12-10 | 2 | $-140 🔴 | $125,681 |
| 2025-12-11 | 4 | $-39 🔴 | $125,642 |
| 2025-12-12 | 7 | $+1,016 🟢 | $126,659 |
| 2025-12-15 | 2 | $+689 🟢 | $127,347 |
| 2025-12-16 | 3 | $+224 🟢 | $127,571 |
| 2025-12-17 | 4 | $+1,208 🟢 | $128,779 |
| 2025-12-18 | 2 | $-39 🔴 | $128,740 |
| 2025-12-22 | 5 | $-25 🔴 | $128,715 |
| 2025-12-23 | 1 | $+5 🟢 | $128,720 |
| 2025-12-24 | 4 | $-86 🔴 | $128,634 |
| 2025-12-26 | 1 | $-158 🔴 | $128,477 |
| 2025-12-29 | 5 | $-527 🔴 | $127,950 |
| 2025-12-30 | 1 | $+19 🟢 | $127,969 |
| 2025-12-31 | 3 | $+516 🟢 | $128,485 |

## 2 · The Proud (top winners)

What these have in common — pattern-match on setup, personality, regime, PDZ. If the next month
has fewer trades that look like this, the engine has drifted.

- **SATS  ** L |  +8.38% | MFE +0.00% / MAE +0.00% | exit: `ST_FLIP_4H_CLOSE` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRENDING · PDZ=premium_approach · [PHv-]
- **IESC  ** L |  +5.96% | MFE +0.00% / MAE +0.00% | exit: `atr_week_618_full_exit` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRENDING · PDZ=premium
- **TSLA  ** L |  +4.24% | MFE +0.00% / MAE +0.00% | exit: `TP_FULL` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRENDING · PDZ=premium_approach
- **SANM  ** L |  +4.02% | MFE +0.00% / MAE +0.00% | exit: `ST_FLIP_4H_CLOSE` | TT Tt Gap Reversal Long · PULLBACK_PLAYER · TRANSITIONAL · PDZ=premium_approach · [PHv-]
- **ALLY  ** L |  +3.97% | MFE +0.00% / MAE +0.00% | exit: `ST_FLIP_4H_CLOSE` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRENDING · PDZ=premium_approach

## 3 · The Disappointed (worst losers)

Each one of these is a calibration question: was the entry the issue, the management, or the regime?
If the same `setup × personality × regime × side` shows up in 3+ disappointed trades, the next
calibration should raise the bar for that combo.

- **AGQ   ** L |  -5.06% | MFE +0.00% / MAE +0.00% | exit: `HARD_LOSS_CAP` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRENDING · PDZ=premium · [PHv-]
- **BABA  ** S |  -1.94% | MFE +0.00% / MAE +0.00% | exit: `doctrine_force_exit` | TT Tt Gap Reversal Short · VOLATILE_RUNNER · TRENDING · PDZ=discount · [PHv-]
- **ALB   ** L |  -1.63% | MFE +0.00% / MAE +0.00% | exit: `doctrine_force_exit` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRENDING · PDZ=premium_approach · [PHv-]
- **PLTR  ** L |  -1.63% | MFE +0.00% / MAE +0.00% | exit: `PRE_EARNINGS_FORCE_EXIT` | TT Tt Pullback · VOLATILE_RUNNER · TRENDING · PDZ=premium_approach
- **AA    ** L |  -1.60% | MFE +0.00% / MAE +0.00% | exit: `doctrine_force_exit` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRENDING · PDZ=premium_approach

## 4 · Profit giveback (MFE ≥ 1% closed flat-or-worse)

**0 trade(s).** This is the bucket Loop 1's MFE peak-lock targets directly.
If this list is long, the calibration question is: should peak-lock fire earlier?

_None._ Engine is locking gains well this month.

## 5 · Re-entry chains (tickers traded ≥ 3x)

Negative chains are the engine repeatedly being wrong about the same name.
If a chain is net negative AND we never paused, Loop 2's circuit breaker missed it.

- **AGQ** — 4 trades, 2W/2L, **net -3.23%** 🔴
- **SPY** — 3 trades, 2W/1L, **net +0.75%** 🟢

## 6 · Setup performance

Bottom-quartile setups by win-rate AND volume are candidates for the next calibration to guard-rail.

| Setup | N | WR | Avg | Net |
|---|---:|---:|---:|---:|
| `TT Tt Gap Reversal Long` | 24 | 67% | +1.35% | +32.46% |
| `TT Tt Ath Breakout` | 8 | 75% | +0.60% | +4.81% |
| `TT Tt N Test Support` | 7 | 29% | +0.06% | +0.43% |
| `TT Tt N Test Resistance` | 2 | 50% | -0.01% | -0.03% |
| `TT Tt Atl Breakdown` | 1 | 0% | -0.04% | -0.04% |
| `TT Tt Gap Reversal Short` | 3 | 0% | -0.82% | -2.45% |
| `TT Tt Pullback` | 6 | 17% | -0.71% | -4.25% |

## 7 · Personality × Setup (combos with 2+ trades)

Worst-WR combos at top — these are the immediate Loop 1 candidates.

| Personality | Setup | N | WR | Net |
|---|---|---:|---:|---:|
| MODERATE | `TT Tt N Test Support` | 2 | 0% | -0.93% |
| VOLATILE_RUNNER | `TT Tt Pullback` | 4 | 0% | -4.48% |
| VOLATILE_RUNNER | `TT Tt Gap Reversal Short` | 2 | 0% | -2.18% |
| VOLATILE_RUNNER | `TT Tt N Test Support` | 2 | 50% | +2.10% |
| PULLBACK_PLAYER | `TT Tt N Test Resistance` | 2 | 50% | -0.03% |
| SLOW_GRINDER | `TT Tt N Test Support` | 2 | 50% | -0.54% |
| VOLATILE_RUNNER | `TT Tt Gap Reversal Long` | 16 | 56% | +19.22% |
| SLOW_GRINDER | `TT Tt Ath Breakout` | 3 | 67% | +0.75% |
| PULLBACK_PLAYER | `TT Tt Ath Breakout` | 4 | 75% | +3.80% |
| PULLBACK_PLAYER | `TT Tt Gap Reversal Long` | 8 | 88% | +13.23% |

## 8 · Loop firing log

Phase C self-adapting loops. Empty for any backtest run before the loops were enabled.

- **Loop 3** — `flat_cut`: 322 times
- **Loop 2** — `block`: 294 times

**Loop 1 scorecard snapshot** (end-of-month, min_samples=3):
- 🔴 BLOCK (5 combos): `tt_n_test_support:trending:volatile_runner:L` (0W/5L), `tt_n_test_support:transitional:pullback_player:L` (0W/4L), `momentum_score:trending:pullback_player:L` (0W/8L), `tt_n_test_support:trending:moderate:L` (0W/3L), `tt_pullback:trending:moderate:L` (1W/4L)
- 🟡 RAISE_BAR (12 combos): `tt_ath_breakout:trending:pullback_player:L` (5W/10L), `tt_n_test_resistance:transitional:pullback_player:S` (1W/2L), `tt_n_test_support:choppy:slow_grinder:L` (1W/2L), `tt_gap_reversal_short:trending:volatile_runner:S` (1W/2L), `tt_range_reversal_long:trending:pullback_player:L` (3W/5L), `tt_n_test_support:trending:pullback_player:L` (2W/3L), `tt_ath_breakout:trending:slow_grinder:L` (4W/6L), `tt_n_test_support:transitional:moderate:L` (2W/3L), `tt_pullback:transitional:volatile_runner:L` (2W/3L), `tt_pullback:trending:volatile_runner:L` (4W/5L)
- 🟢 ALLOW (>0.45 WR): 13 combos

## 9 · Calibration notes (fill in by hand after reviewing above)

_Proposed flag deltas for the next month, with one-line justification each._

- [ ] (no change) — engine looks calibrated for this regime
- [ ] _Or list specific flag deltas. e.g.:_
      `deep_audit_mfe_peak_lock_retrace_pct: 50 → 40` because profit giveback list is long.

After deciding, edit `scripts/v15-activate.sh`, commit with message
`phase-c: 2025-12 calibration` and resume the next month.
