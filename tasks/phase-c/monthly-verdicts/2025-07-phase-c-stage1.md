# Phase C — Monthly Verdict · 2025-07

_Source: `phase-c-stage1-jul2025-may2026` · Trades in window: **103** · Generated 2026-05-03 11:54 UTC_

> Read this alongside the previous month's verdict. The point is **trajectory** —
> are we drifting toward July or away from it?

## 1 · Headline

- **102 closed trades.** 56W / 46L / 0 flat.
- **Win rate: 54.9%.** Target 55% — MISS.
- **Avg winner / Avg loser: 2.12x** (2.81% / 1.32%). Target 1.60x — PASS.
- **Max drawdown (cum %): 12.55%.** Target ≤ 3.0% — MISS.
- **Sharpe (annualized, daily-pct proxy): 4.32.** Target 1.50 — PASS.
- **Cumulative P&L (sum of pct): +96.47%.**

### Account equity ($100K starting bankroll, 1% notional per trade)

| Metric | Value |
|---|---|
| **Start balance** (1st trade of month) | **$100,000** |
| **End balance** (last trade of month) | **$246,715** |
| **Net $ P&L** | **$+146,715**  (+146.71% of start balance) |
| Total winning $ | +$243,443 |
| Total losing $ | -$96,728 |
| Biggest winner | **AEHR** +$39,994 (+21.18%) |
| Biggest loser | **ORCL** -$12,378 (-5.17%) |
| Run-to-date peak | $341,722 |
| Run-to-date max DD | -$52,677 (15.42%) |

### Day-by-day P&L (this month)

| Date | Day P&L $ |
|---|---:|
| 2025-07-02 | $-6,149 |
| 2025-07-03 | $+4,395 |
| 2025-07-07 | $+1,993 |
| 2025-07-08 | $+874 |
| 2025-07-09 | $-580 |
| 2025-07-10 | $-8,969 |
| 2025-07-11 | $+7,745 |
| 2025-07-14 | $+4,162 |
| 2025-07-15 | $+32,265 |
| 2025-07-16 | $+3,666 |
| 2025-07-17 | $+1,376 |
| 2025-07-18 | $-1,078 |
| 2025-07-22 | $+10,955 |
| 2025-07-23 | $+17,773 |
| 2025-07-24 | $+228 |
| 2025-07-25 | $+13,755 |
| 2025-07-28 | $+46,686 |
| 2025-07-29 | $-3,651 |
| 2025-07-30 | $+3,956 |
| 2025-08-01 | $+17,312 |

## 2 · The Proud (top winners)

What these have in common — pattern-match on setup, personality, regime, PDZ. If the next month
has fewer trades that look like this, the engine has drifted.

- **AEHR  ** L | +21.18% | MFE +0.00% / MAE +0.00% | exit: `atr_week_618_full_exit` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRENDING · PDZ=premium_approach
- **U     ** L | +12.50% | MFE +0.00% / MAE +0.00% | exit: `sl_breached` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRENDING · PDZ=premium_approach
- **JOBY  ** L | +12.37% | MFE +0.00% / MAE +0.00% | exit: `TP_FULL` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRENDING · PDZ=premium_approach · [RSIv-]
- **IREN  ** L | +10.21% | MFE +0.00% / MAE +0.00% | exit: `sl_breached` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRENDING · PDZ=premium_approach · [PHv-]
- **LITE  ** L |  +8.70% | MFE +0.00% / MAE +0.00% | exit: `sl_breached` | TT Tt Pullback · VOLATILE_RUNNER · TRENDING · PDZ=premium_approach

## 3 · The Disappointed (worst losers)

Each one of these is a calibration question: was the entry the issue, the management, or the regime?
If the same `setup × personality × regime × side` shows up in 3+ disappointed trades, the next
calibration should raise the bar for that combo.

- **ORCL  ** L |  -5.17% | MFE +0.00% / MAE +0.00% | exit: `HARD_LOSS_CAP` | TT Momentum · PULLBACK_PLAYER · TRENDING · PDZ=premium_approach
- **MDB   ** L |  -4.01% | MFE +0.00% / MAE +0.00% | exit: `max_loss` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRANSITIONAL · PDZ=premium_approach
- **CDNS  ** L |  -3.24% | MFE +0.00% / MAE +0.00% | exit: `max_loss` | TT Momentum · PULLBACK_PLAYER · TRENDING · PDZ=premium_approach
- **INTC  ** L |  -3.23% | MFE +0.00% / MAE +0.00% | exit: `max_loss` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRENDING · PDZ=premium_approach
- **CSX   ** L |  -2.75% | MFE +0.00% / MAE +0.00% | exit: `phase_i_mfe_cut_4h` | TT Tt Pullback · PULLBACK_PLAYER · TRENDING · PDZ=premium_approach · [RSIv-|PHv-]

## 4 · Profit giveback (MFE ≥ 1% closed flat-or-worse)

**0 trade(s).** This is the bucket Loop 1's MFE peak-lock targets directly.
If this list is long, the calibration question is: should peak-lock fire earlier?

_None._ Engine is locking gains well this month.

## 5 · Re-entry chains (tickers traded ≥ 3x)

Negative chains are the engine repeatedly being wrong about the same name.
If a chain is net negative AND we never paused, Loop 2's circuit breaker missed it.

- **SPY** — 3 trades, 2W/1L, **net -0.22%** 🔴
- **AA** — 3 trades, 2W/1L, **net +2.11%** 🟢
- **AWI** — 3 trades, 2W/1L, **net +0.01%** 🟢
- **GE** — 3 trades, 1W/2L, **net +0.05%** 🟢
- **AVGO** — 3 trades, 1W/2L, **net +0.13%** 🟢

## 6 · Setup performance

Bottom-quartile setups by win-rate AND volume are candidates for the next calibration to guard-rail.

| Setup | N | WR | Avg | Net |
|---|---:|---:|---:|---:|
| `TT Tt Gap Reversal Long` | 51 | 65% | +1.68% | +85.61% |
| `TT Tt Pullback` | 16 | 44% | +0.72% | +11.53% |
| `TT Tt Gap Reversal Short` | 3 | 100% | +3.16% | +9.48% |
| `TT Tt N Test Support` | 11 | 45% | +0.34% | +3.77% |
| `TT Tt Range Reversal Long` | 7 | 43% | +0.01% | +0.08% |
| `TT Tt N Test Resistance` | 1 | 0% | -1.19% | -1.19% |
| `TT Tt Ath Breakout` | 11 | 45% | -0.40% | -4.40% |
| `TT Momentum` | 2 | 0% | -4.20% | -8.41% |

## 7 · Personality × Setup (combos with 2+ trades)

Worst-WR combos at top — these are the immediate Loop 1 candidates.

| Personality | Setup | N | WR | Net |
|---|---|---:|---:|---:|
| PULLBACK_PLAYER | `TT Momentum` | 2 | 0% | -8.41% |
| PULLBACK_PLAYER | `TT Tt Range Reversal Long` | 4 | 25% | +0.34% |
| VOLATILE_RUNNER | `TT Tt Pullback` | 6 | 33% | +6.81% |
| VOLATILE_RUNNER | `TT Tt Ath Breakout` | 3 | 33% | -1.43% |
| VOLATILE_RUNNER | `TT Tt N Test Support` | 3 | 33% | -1.00% |
| PULLBACK_PLAYER | `TT Tt Pullback` | 8 | 38% | +2.89% |
| PULLBACK_PLAYER | `TT Tt Ath Breakout` | 6 | 50% | -1.66% |
| SLOW_GRINDER | `TT Tt N Test Support` | 2 | 50% | +0.15% |
| SLOW_GRINDER | `TT Tt Ath Breakout` | 2 | 50% | -1.31% |
| MODERATE | `TT Tt Range Reversal Long` | 2 | 50% | -0.61% |
| PULLBACK_PLAYER | `TT Tt N Test Support` | 5 | 60% | +5.85% |
| PULLBACK_PLAYER | `TT Tt Gap Reversal Long` | 13 | 62% | +7.83% |
| VOLATILE_RUNNER | `TT Tt Gap Reversal Long` | 34 | 62% | +67.94% |
| MODERATE | `TT Tt Gap Reversal Long` | 4 | 100% | +9.84% |
| VOLATILE_RUNNER | `TT Tt Gap Reversal Short` | 2 | 100% | +7.50% |

## 8 · Loop firing log

Phase C self-adapting loops. Empty for any backtest run before the loops were enabled.

- **Loop 3** — `flat_cut`: 594 times

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
`phase-c: 2025-07 calibration` and resume the next month.
