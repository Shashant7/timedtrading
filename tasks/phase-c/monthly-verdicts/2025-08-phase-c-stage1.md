# Phase C — Monthly Verdict · 2025-08

_Source: `phase-c-stage1-jul2025-may2026` · Trades in window: **65** · Generated 2026-05-04 19:34 UTC_

> Read this alongside the previous month's verdict. The point is **trajectory** —
> are we drifting toward July or away from it?

## 1 · Headline

- **52 closed trades.** 25W / 27L / 0 flat.
- **Win rate: 48.1%.** Target 55% — MISS.
- **Avg winner / Avg loser: 1.62x** (2.21% / 1.37%). Target 1.60x — PASS.
- **Max drawdown (cum %): 15.39%.** Target ≤ 3.0% — MISS.
- **Sharpe (annualized, daily-pct proxy): 2.19.** Target 1.50 — PASS.
- **Cumulative P&L (sum of pct): +18.33%.**

### Account equity (start $100,000 reference, ~$9,062 avg notional/trade)

_Each trade uses its actual recorded P&L (`trade.pnl` field) — not derived from %._

| Metric | Value |
|---|---|
| **Start balance** (entering this month) | **$104,913** |
| **End balance** (after last trade closed) | **$106,115** |
| **Net $ P&L for the month** | **$+1,202**  (+1.15% of start balance) |
| Sum of winning $ | +$4,569  (25 wins) |
| Sum of losing $ | -$3,433  (27 losses) |
| Biggest winner | **MP** +$763 (+6.10%) |
| Biggest loser | **RIOT** -$729 (-5.83%) |
| Run-to-date peak | $107,345 (on 2025-08-19) |
| Run-to-date max DD | -$1,735 (1.62%) (trough on 2025-08-26) |

### Day-by-day P&L (this month)

| Date | # Trades | Day P&L $ | End-of-day Balance |
|---|---:|---:|---:|
| 2025-08-05 | 5 | $-219 🔴 | $104,694 |
| 2025-08-06 | 2 | $+141 🟢 | $104,835 |
| 2025-08-07 | 5 | $+793 🟢 | $105,627 |
| 2025-08-08 | 1 | $-18 🔴 | $105,609 |
| 2025-08-11 | 2 | $+198 🟢 | $105,807 |
| 2025-08-13 | 4 | $+280 🟢 | $106,087 |
| 2025-08-14 | 2 | $-119 🔴 | $105,968 |
| 2025-08-15 | 3 | $+411 🟢 | $106,379 |
| 2025-08-18 | 2 | $+389 🟢 | $106,768 |
| 2025-08-19 | 8 | $-157 🔴 | $106,612 |
| 2025-08-20 | 1 | $-181 🔴 | $106,431 |
| 2025-08-21 | 2 | $+15 🟢 | $106,446 |
| 2025-08-25 | 1 | $-729 🔴 | $105,717 |
| 2025-08-26 | 1 | $-173 🔴 | $105,544 |
| 2025-08-27 | 3 | $+583 🟢 | $106,127 |
| 2025-08-28 | 3 | $-59 🔴 | $106,068 |
| 2025-08-29 | 7 | $-19 🔴 | $106,049 |

## 2 · The Proud (top winners)

What these have in common — pattern-match on setup, personality, regime, PDZ. If the next month
has fewer trades that look like this, the engine has drifted.

- **RDDT  ** L |  +9.35% | MFE +0.00% / MAE +0.00% | exit: `atr_week_618_full_exit` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRANSITIONAL · PDZ=premium
- **MP    ** L |  +6.10% | MFE +0.00% / MAE +0.00% | exit: `TP_FULL` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRENDING · PDZ=premium_approach · [PHv-]
- **BE    ** L |  +6.03% | MFE +0.00% / MAE +0.00% | exit: `ST_FLIP_4H_CLOSE` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRENDING · PDZ=premium
- **ALB   ** L |  +5.11% | MFE +0.00% / MAE +0.00% | exit: `SOFT_FUSE_RSI_CONFIRMED` | TT Tt Range Reversal Long · VOLATILE_RUNNER · TRANSITIONAL · PDZ=premium_approach · [RSIv-|PHv-]
- **APLD  ** L |  +3.83% | MFE +0.00% / MAE +0.00% | exit: `peak_lock_ema12_deep_break` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRANSITIONAL · PDZ=premium · [PHv-]

## 3 · The Disappointed (worst losers)

Each one of these is a calibration question: was the entry the issue, the management, or the regime?
If the same `setup × personality × regime × side` shows up in 3+ disappointed trades, the next
calibration should raise the bar for that combo.

- **RIOT  ** L |  -5.83% | MFE +0.00% / MAE +0.00% | exit: `HARD_LOSS_CAP` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRENDING · PDZ=premium_approach · [PHv-]
- **ALB   ** L |  -3.46% | MFE +0.00% / MAE +0.00% | exit: `phase_i_mfe_fast_cut_2h` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRANSITIONAL · PDZ=premium_approach
- **AEHR  ** L |  -2.51% | MFE +0.00% / MAE +0.00% | exit: `max_loss_time_scaled` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRANSITIONAL · PDZ=premium
- **CVNA  ** L |  -2.51% | MFE +0.00% / MAE +0.00% | exit: `max_loss_time_scaled` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRANSITIONAL · PDZ=discount_approach · [PHv-]
- **LRN   ** L |  -2.29% | MFE +0.00% / MAE +0.00% | exit: `SMART_RUNNER_SUPPORT_BREAK_CLOUD` | TT Tt Gap Reversal Long · ? · ? · PDZ=?

## 4 · Profit giveback (MFE ≥ 1% closed flat-or-worse)

**0 trade(s).** This is the bucket Loop 1's MFE peak-lock targets directly.
If this list is long, the calibration question is: should peak-lock fire earlier?

_None._ Engine is locking gains well this month.

## 5 · Re-entry chains (tickers traded ≥ 3x)

Negative chains are the engine repeatedly being wrong about the same name.
If a chain is net negative AND we never paused, Loop 2's circuit breaker missed it.

- **APLD** — 3 trades, 2W/1L, **net +4.94%** 🟢
- **BE** — 3 trades, 2W/0L, **net +6.85%** 🟢
- **AEHR** — 3 trades, 1W/2L, **net -4.05%** 🔴

## 6 · Setup performance

Bottom-quartile setups by win-rate AND volume are candidates for the next calibration to guard-rail.

| Setup | N | WR | Avg | Net |
|---|---:|---:|---:|---:|
| `TT Tt Gap Reversal Long` | 40 | 50% | +0.42% | +16.88% |
| `TT Tt Range Reversal Long` | 4 | 50% | +0.98% | +3.92% |
| `TT Tt Ath Breakout` | 4 | 25% | -0.16% | -0.65% |
| `TT Tt Pullback` | 4 | 50% | -0.46% | -1.82% |

## 7 · Personality × Setup (combos with 2+ trades)

Worst-WR combos at top — these are the immediate Loop 1 candidates.

| Personality | Setup | N | WR | Net |
|---|---|---:|---:|---:|
| PULLBACK_PLAYER | `TT Tt Ath Breakout` | 2 | 0% | -0.95% |
| ? | `TT Tt Gap Reversal Long` | 3 | 33% | -2.49% |
| PULLBACK_PLAYER | `TT Tt Gap Reversal Long` | 6 | 50% | +3.19% |
| MODERATE | `TT Tt Gap Reversal Long` | 2 | 50% | +1.29% |
| PULLBACK_PLAYER | `TT Tt Pullback` | 2 | 50% | -1.10% |
| VOLATILE_RUNNER | `TT Tt Gap Reversal Long` | 29 | 52% | +14.90% |
| VOLATILE_RUNNER | `TT Tt Range Reversal Long` | 3 | 67% | +5.79% |

## 8 · Loop firing log

Phase C self-adapting loops. Empty for any backtest run before the loops were enabled.

- **Loop 3** — `flat_cut`: 446 times
- **Loop 2** — `block`: 215 times

**Loop 1 scorecard snapshot** (end-of-month, min_samples=3):
- 🔴 BLOCK (4 combos): `tt_range_reversal_long:trending:pullback_player:L` (0W/3L), `tt_pullback:trending:pullback_player:L` (1W/4L), `tt_ath_breakout:trending:pullback_player:L` (2W/6L), `tt_ath_breakout:trending:volatile_runner:L` (1W/3L)
- 🟡 RAISE_BAR (3 combos): `tt_gap_reversal_long:choppy:volatile_runner:L` (1W/2L), `tt_gap_reversal_long:transitional:volatile_runner:L` (5W/9L), `tt_pullback:trending:volatile_runner:L` (2W/3L)
- 🟢 ALLOW (>0.45 WR): 6 combos

## 9 · Calibration notes (fill in by hand after reviewing above)

_Proposed flag deltas for the next month, with one-line justification each._

- [ ] (no change) — engine looks calibrated for this regime
- [ ] _Or list specific flag deltas. e.g.:_
      `deep_audit_mfe_peak_lock_retrace_pct: 50 → 40` because profit giveback list is long.

After deciding, edit `scripts/v15-activate.sh`, commit with message
`phase-c: 2025-08 calibration` and resume the next month.
