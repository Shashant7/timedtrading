# Phase C — Monthly Verdict · 2026-03

_Source: `phase-c-stage1-jul2025-may2026` · Trades in window: **36** · Generated 2026-05-05 23:06 UTC_

> Read this alongside the previous month's verdict. The point is **trajectory** —
> are we drifting toward July or away from it?

## 1 · Headline

- **35 closed trades.** 12W / 23L / 0 flat.
- **Win rate: 34.3%.** Target 55% — MISS.
- **Avg winner / Avg loser: 0.48x** (0.86% / 1.78%). Target 1.60x — MISS.
- **Max drawdown (cum %): 30.70%.** Target ≤ 3.0% — MISS.
- **Sharpe (annualized, daily-pct proxy): -6.81.** Target 1.50 — MISS.
- **Cumulative P&L (sum of pct): -30.70%.**

### Account equity (start $100,000 reference, ~$10,794 avg notional/trade)

_Each trade uses its actual recorded P&L (`trade.pnl` field) — not derived from %._

| Metric | Value |
|---|---|
| **Start balance** (entering this month) | **$140,091** |
| **End balance** (after last trade closed) | **$136,965** |
| **Net $ P&L for the month** | **$-3,126**  (-2.23% of start balance) |
| Sum of winning $ | +$1,106  (12 wins) |
| Sum of losing $ | -$4,196  (23 losses) |
| Biggest winner | **ABT** +$347 (+3.49%) |
| Biggest loser | **HL** -$812 (-4.05%) |
| Run-to-date peak | $140,165 (on 2026-03-02) |
| Run-to-date max DD | -$3,869 (2.76%) (trough on 2026-03-26) |

### Day-by-day P&L (this month)

| Date | # Trades | Day P&L $ | End-of-day Balance |
|---|---:|---:|---:|
| 2026-03-03 | 8 | $-2,144 🔴 | $137,947 |
| 2026-03-04 | 1 | $-128 🔴 | $137,819 |
| 2026-03-05 | 3 | $-829 🔴 | $136,990 |
| 2026-03-09 | 2 | $-34 🔴 | $136,956 |
| 2026-03-11 | 1 | $-24 🔴 | $136,932 |
| 2026-03-16 | 3 | $+6 🟢 | $136,937 |
| 2026-03-17 | 1 | $-61 🔴 | $136,876 |
| 2026-03-18 | 2 | $-99 🔴 | $136,778 |
| 2026-03-19 | 1 | $-71 🔴 | $136,707 |
| 2026-03-20 | 5 | $+97 🟢 | $136,804 |
| 2026-03-23 | 1 | $-133 🔴 | $136,671 |
| 2026-03-24 | 1 | $-80 🔴 | $136,591 |
| 2026-03-26 | 3 | $-128 🔴 | $136,463 |
| 2026-03-30 | 1 | $+200 🟢 | $136,663 |
| 2026-03-31 | 2 | $+338 🟢 | $137,001 |

## 2 · The Proud (top winners)

What these have in common — pattern-match on setup, personality, regime, PDZ. If the next month
has fewer trades that look like this, the engine has drifted.

- **ABT   ** S |  +3.49% | MFE +0.00% / MAE +0.00% | exit: `TP_FULL` | TT Tt Atl Breakdown · MODERATE · TRANSITIONAL · PDZ=discount_approach · [PHv-]
- **QQQ   ** S |  +1.51% | MFE +0.00% / MAE +0.00% | exit: `TP_FULL` | TT Tt Pullback · MODERATE · TRENDING · PDZ=discount_approach
- **XLE   ** L |  +1.19% | MFE +0.00% / MAE +0.00% | exit: `TP_FULL` | TT Tt Ath Breakout · PULLBACK_PLAYER · TRENDING · PDZ=premium_approach
- **SPY   ** S |  +1.10% | MFE +0.00% / MAE +0.00% | exit: `TP_FULL` | TT Tt Pullback · SLOW_GRINDER · TRENDING · PDZ=discount_approach · [RSIv-|PHv-]
- **QQQ   ** S |  +0.78% | MFE +0.00% / MAE +0.00% | exit: `doctrine_force_exit` | TT Tt N Test Resistance · MODERATE · CHOPPY · PDZ=discount_approach · [RSIv-|PHv-]

## 3 · The Disappointed (worst losers)

Each one of these is a calibration question: was the entry the issue, the management, or the regime?
If the same `setup × personality × regime × side` shows up in 3+ disappointed trades, the next
calibration should raise the bar for that combo.

- **ALB   ** L |  -8.44% | MFE +0.00% / MAE +0.00% | exit: `HARD_LOSS_CAP` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRANSITIONAL · PDZ=discount_approach
- **STX   ** L |  -4.58% | MFE +0.00% / MAE +0.00% | exit: `doctrine_force_exit` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · CHOPPY · PDZ=premium_approach
- **HL    ** L |  -4.05% | MFE +0.00% / MAE +0.00% | exit: `HARD_LOSS_CAP` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRENDING · PDZ=discount_approach · [RSIv-|PHv-]
- **JCI   ** L |  -3.86% | MFE +0.00% / MAE +0.00% | exit: `tape_capitulation_force_exit` | TT Tt Ath Breakout · PULLBACK_PLAYER · TRENDING · PDZ=premium · [PHv-]
- **CCJ   ** L |  -3.59% | MFE +0.00% / MAE +0.00% | exit: `HARD_LOSS_CAP` | TT Tt Pullback · VOLATILE_RUNNER · TRANSITIONAL · PDZ=discount_approach

## 4 · Profit giveback (MFE ≥ 1% closed flat-or-worse)

**0 trade(s).** This is the bucket Loop 1's MFE peak-lock targets directly.
If this list is long, the calibration question is: should peak-lock fire earlier?

_None._ Engine is locking gains well this month.

## 5 · Re-entry chains (tickers traded ≥ 3x)

Negative chains are the engine repeatedly being wrong about the same name.
If a chain is net negative AND we never paused, Loop 2's circuit breaker missed it.

- **SPY** — 5 trades, 2W/3L, **net +0.13%** 🟢
- **QQQ** — 4 trades, 3W/1L, **net +1.78%** 🟢

## 6 · Setup performance

Bottom-quartile setups by win-rate AND volume are candidates for the next calibration to guard-rail.

| Setup | N | WR | Avg | Net |
|---|---:|---:|---:|---:|
| `TT Tt Atl Breakdown` | 4 | 50% | +0.71% | +2.83% |
| `TT Tt Range Reversal Long` | 1 | 100% | +0.41% | +0.41% |
| `TT Tt N Test Support` | 1 | 0% | -1.05% | -1.05% |
| `TT Tt N Test Resistance` | 5 | 40% | -0.27% | -1.36% |
| `TT Tt Pullback` | 9 | 33% | -0.60% | -5.39% |
| `TT Tt Ath Breakout` | 7 | 14% | -1.21% | -8.46% |
| `TT Tt Gap Reversal Long` | 8 | 38% | -2.21% | -17.69% |

## 7 · Personality × Setup (combos with 2+ trades)

Worst-WR combos at top — these are the immediate Loop 1 candidates.

| Personality | Setup | N | WR | Net |
|---|---|---:|---:|---:|
| VOLATILE_RUNNER | `TT Tt Pullback` | 2 | 0% | -4.54% |
| PULLBACK_PLAYER | `TT Tt Ath Breakout` | 5 | 20% | -5.90% |
| VOLATILE_RUNNER | `TT Tt Gap Reversal Long` | 7 | 29% | -17.86% |
| MODERATE | `TT Tt Atl Breakdown` | 2 | 50% | +2.77% |
| SLOW_GRINDER | `TT Tt Pullback` | 4 | 50% | +0.27% |
| MODERATE | `TT Tt Pullback` | 2 | 50% | +0.12% |
| MODERATE | `TT Tt N Test Resistance` | 3 | 67% | +0.12% |

## 8 · Loop firing log

Phase C self-adapting loops. Empty for any backtest run before the loops were enabled.

- **Loop 2** — `block`: 219 times
- **Loop 3** — `flat_cut`: 60 times

**Loop 1 scorecard snapshot** (end-of-month, min_samples=3):
- 🔴 BLOCK (16 combos): `tt_n_test_support:transitional:pullback_player:L` (0W/4L), `ema_regime_confirmed_long:transitional:pullback_player:L` (0W/6L), `momentum_score:trending:pullback_player:L` (0W/14L), `tt_n_test_support:trending:moderate:L` (0W/3L), `tt_ath_breakout:trending:moderate:L` (0W/6L), `tt_gap_reversal_long:trending:slow_grinder:L` (0W/6L), `tt_atl_breakdown:transitional:moderate:S` (0W/3L), `tt_ath_breakout:trending:pullback_player:L` (3W/17L), `tt_n_test_support:trending:volatile_runner:L` (1W/5L), `tt_pullback:trending:moderate:L` (1W/5L)
- 🟡 RAISE_BAR (10 combos): `tt_pullback:trending:volatile_runner:L` (4W/8L), `tt_n_test_support:transitional:slow_grinder:L` (4W/8L), `tt_n_test_support:choppy:slow_grinder:L` (2W/4L), `tt_pullback:transitional:volatile_runner:L` (4W/8L), `tt_gap_reversal_short:trending:volatile_runner:S` (1W/2L), `tt_pullback:trending:pullback_player:L` (5W/9L), `tt_n_test_support:trending:pullback_player:L` (3W/5L), `tt_range_reversal_long:trending:pullback_player:L` (4W/6L), `tt_n_test_support:transitional:moderate:L` (2W/3L), `tt_gap_reversal_long:transitional:volatile_runner:L` (9W/11L)
- 🟢 ALLOW (>0.45 WR): 16 combos

## 9 · Calibration notes (fill in by hand after reviewing above)

_Proposed flag deltas for the next month, with one-line justification each._

- [ ] (no change) — engine looks calibrated for this regime
- [ ] _Or list specific flag deltas. e.g.:_
      `deep_audit_mfe_peak_lock_retrace_pct: 50 → 40` because profit giveback list is long.

After deciding, edit `scripts/v15-activate.sh`, commit with message
`phase-c: 2026-03 calibration` and resume the next month.
