# Phase C — Monthly Verdict · 2025-10

_Source: `phase-c-stage1-jul2025-may2026` · Trades in window: **53** · Generated 2026-05-05 04:50 UTC_

> Read this alongside the previous month's verdict. The point is **trajectory** —
> are we drifting toward July or away from it?

## 1 · Headline

- **44 closed trades.** 15W / 29L / 0 flat.
- **Win rate: 34.1%.** Target 55% — MISS.
- **Avg winner / Avg loser: 1.25x** (1.57% / 1.25%). Target 1.60x — MISS.
- **Max drawdown (cum %): 15.09%.** Target ≤ 3.0% — MISS.
- **Sharpe (annualized, daily-pct proxy): -2.47.** Target 1.50 — MISS.
- **Cumulative P&L (sum of pct): -12.81%.**

### Account equity (start $100,000 reference, ~$10,830 avg notional/trade)

_Each trade uses its actual recorded P&L (`trade.pnl` field) — not derived from %._

| Metric | Value |
|---|---|
| **Start balance** (entering this month) | **$125,639** |
| **End balance** (after last trade closed) | **$126,268** |
| **Net $ P&L for the month** | **$+629**  (+0.50% of start balance) |
| Sum of winning $ | +$2,477  (15 wins) |
| Sum of losing $ | -$3,715  (29 losses) |
| Biggest winner | **AA** +$529 (+3.49%) |
| Biggest loser | **AA** -$472 (-6.14%) |
| Run-to-date peak | $127,315 (on 2025-10-08) |
| Run-to-date max DD | -$1,617 (1.43%) (trough on 2025-08-05) |

### Day-by-day P&L (this month)

| Date | # Trades | Day P&L $ | End-of-day Balance |
|---|---:|---:|---:|
| 2025-10-07 | 5 | $-305 🔴 | $125,334 |
| 2025-10-08 | 1 | $-352 🔴 | $124,982 |
| 2025-10-09 | 6 | $-745 🔴 | $124,237 |
| 2025-10-10 | 7 | $+380 🟢 | $124,617 |
| 2025-10-13 | 1 | $-92 🔴 | $124,525 |
| 2025-10-14 | 1 | $-109 🔴 | $124,416 |
| 2025-10-15 | 1 | $+332 🟢 | $124,748 |
| 2025-10-16 | 1 | $-68 🔴 | $124,680 |
| 2025-10-17 | 3 | $-27 🔴 | $124,653 |
| 2025-10-21 | 5 | $-350 🔴 | $124,304 |
| 2025-10-22 | 2 | $+22 🟢 | $124,326 |
| 2025-10-24 | 1 | $-472 🔴 | $123,853 |
| 2025-10-27 | 1 | $+424 🟢 | $124,278 |
| 2025-10-28 | 3 | $+470 🟢 | $124,748 |
| 2025-10-29 | 5 | $-389 🔴 | $124,359 |
| 2025-10-30 | 1 | $+42 🟢 | $124,401 |

## 2 · The Proud (top winners)

What these have in common — pattern-match on setup, personality, regime, PDZ. If the next month
has fewer trades that look like this, the engine has drifted.

- **AVAV  ** L |  +3.80% | MFE +0.00% / MAE +0.00% | exit: `ST_FLIP_4H_CLOSE` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRENDING · PDZ=premium
- **ALB   ** L |  +3.79% | MFE +0.00% / MAE +0.00% | exit: `peak_lock_ema12_deep_break` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRANSITIONAL · PDZ=premium_approach · [PHv-]
- **AA    ** L |  +3.49% | MFE +0.00% / MAE +0.00% | exit: `ST_FLIP_4H_CLOSE` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRENDING · PDZ=premium_approach · [PHv-]
- **NVDA  ** L |  +2.75% | MFE +0.00% / MAE +0.00% | exit: `HARD_FUSE_RSI_EXTREME` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRANSITIONAL · PDZ=premium_approach
- **STX   ** L |  +2.52% | MFE +0.00% / MAE +0.00% | exit: `mfe_decay_structural_flatten` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRANSITIONAL · PDZ=discount_approach · [PHv-]

## 3 · The Disappointed (worst losers)

Each one of these is a calibration question: was the entry the issue, the management, or the regime?
If the same `setup × personality × regime × side` shows up in 3+ disappointed trades, the next
calibration should raise the bar for that combo.

- **AA    ** L |  -6.14% | MFE +0.00% / MAE +0.00% | exit: `doctrine_force_exit` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRENDING · PDZ=premium_approach · [RSIv-|PHv-]
- **AMD   ** L |  -3.83% | MFE +0.00% / MAE +0.00% | exit: `doctrine_force_exit` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRENDING · PDZ=premium
- **JOBY  ** L |  -3.49% | MFE +0.00% / MAE +0.00% | exit: `HARD_LOSS_CAP` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRENDING · PDZ=premium
- **AA    ** L |  -2.59% | MFE +0.00% / MAE +0.00% | exit: `doctrine_force_exit` | TT Tt Pullback · VOLATILE_RUNNER · TRENDING · PDZ=premium_approach
- **FIX   ** L |  -2.31% | MFE +0.00% / MAE +0.00% | exit: `doctrine_force_exit` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRENDING · PDZ=premium · [PHv-]

## 4 · Profit giveback (MFE ≥ 1% closed flat-or-worse)

**0 trade(s).** This is the bucket Loop 1's MFE peak-lock targets directly.
If this list is long, the calibration question is: should peak-lock fire earlier?

_None._ Engine is locking gains well this month.

## 5 · Re-entry chains (tickers traded ≥ 3x)

Negative chains are the engine repeatedly being wrong about the same name.
If a chain is net negative AND we never paused, Loop 2's circuit breaker missed it.

- **AA** — 4 trades, 1W/3L, **net -5.84%** 🔴
- **AMD** — 3 trades, 2W/1L, **net -2.28%** 🔴
- **SPY** — 3 trades, 1W/2L, **net -0.54%** 🔴

## 6 · Setup performance

Bottom-quartile setups by win-rate AND volume are candidates for the next calibration to guard-rail.

| Setup | N | WR | Avg | Net |
|---|---:|---:|---:|---:|
| `TT Tt Range Reversal Long` | 2 | 50% | +0.20% | +0.40% |
| `TT Tt Gap Reversal Short` | 1 | 0% | -0.10% | -0.10% |
| `TT Tt Atl Breakdown` | 1 | 0% | -0.87% | -0.87% |
| `TT Tt Pullback` | 3 | 67% | -0.54% | -1.62% |
| `TT Tt N Test Support` | 4 | 0% | -0.72% | -2.89% |
| `TT Tt Ath Breakout` | 6 | 17% | -0.64% | -3.82% |
| `TT Tt Gap Reversal Long` | 27 | 41% | -0.14% | -3.90% |

## 7 · Personality × Setup (combos with 2+ trades)

Worst-WR combos at top — these are the immediate Loop 1 candidates.

| Personality | Setup | N | WR | Net |
|---|---|---:|---:|---:|
| SLOW_GRINDER | `TT Tt N Test Support` | 3 | 0% | -2.17% |
| PULLBACK_PLAYER | `TT Tt Ath Breakout` | 3 | 0% | -2.59% |
| VOLATILE_RUNNER | `TT Tt Gap Reversal Long` | 24 | 38% | -3.45% |
| SLOW_GRINDER | `TT Tt Ath Breakout` | 2 | 50% | -0.63% |
| PULLBACK_PLAYER | `TT Tt Range Reversal Long` | 2 | 50% | +0.40% |
| VOLATILE_RUNNER | `TT Tt Pullback` | 2 | 50% | -2.37% |
| PULLBACK_PLAYER | `TT Tt Gap Reversal Long` | 3 | 67% | -0.45% |

## 8 · Loop firing log

Phase C self-adapting loops. Empty for any backtest run before the loops were enabled.

- **Loop 2** — `block`: 367 times
- **Loop 3** — `flat_cut`: 152 times

**Loop 1 scorecard snapshot** (end-of-month, min_samples=3):
- 🔴 BLOCK (4 combos): `tt_n_test_support:trending:volatile_runner:L` (0W/4L), `momentum_score:trending:pullback_player:L` (0W/4L), `tt_pullback:trending:moderate:L` (1W/3L), `tt_ath_breakout:trending:pullback_player:L` (3W/8L)
- 🟡 RAISE_BAR (7 combos): `tt_n_test_support:choppy:slow_grinder:L` (1W/2L), `tt_gap_reversal_long:trending:volatile_runner:L` (7W/13L), `tt_range_reversal_long:trending:pullback_player:L` (3W/5L), `tt_ath_breakout:trending:slow_grinder:L` (3W/5L), `tt_n_test_support:trending:pullback_player:L` (2W/3L), `tt_gap_reversal_long:trending:pullback_player:L` (8W/12L), `tt_pullback:trending:pullback_player:L` (4W/5L)
- 🟢 ALLOW (>0.45 WR): 11 combos

## 9 · Calibration notes (fill in by hand after reviewing above)

_Proposed flag deltas for the next month, with one-line justification each._

- [ ] (no change) — engine looks calibrated for this regime
- [ ] _Or list specific flag deltas. e.g.:_
      `deep_audit_mfe_peak_lock_retrace_pct: 50 → 40` because profit giveback list is long.

After deciding, edit `scripts/v15-activate.sh`, commit with message
`phase-c: 2025-10 calibration` and resume the next month.
