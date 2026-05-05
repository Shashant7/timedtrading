# Phase C — Monthly Verdict · 2025-09

_Source: `phase-c-stage1-jul2025-may2026` · Trades in window: **63** · Generated 2026-05-05 01:43 UTC_

> Read this alongside the previous month's verdict. The point is **trajectory** —
> are we drifting toward July or away from it?

## 1 · Headline

- **52 closed trades.** 28W / 24L / 0 flat.
- **Win rate: 53.8%.** Target 55% — MISS.
- **Avg winner / Avg loser: 2.11x** (3.07% / 1.45%). Target 1.60x — PASS.
- **Max drawdown (cum %): 13.55%.** Target ≤ 3.0% — MISS.
- **Sharpe (annualized, daily-pct proxy): 4.83.** Target 1.50 — PASS.
- **Cumulative P&L (sum of pct): +51.07%.**

### Account equity (start $100,000 reference, ~$10,183 avg notional/trade)

_Each trade uses its actual recorded P&L (`trade.pnl` field) — not derived from %._

| Metric | Value |
|---|---|
| **Start balance** (entering this month) | **$116,358** |
| **End balance** (after last trade closed) | **$122,565** |
| **Net $ P&L for the month** | **$+6,207**  (+5.33% of start balance) |
| Sum of winning $ | +$7,764  (28 wins) |
| Sum of losing $ | -$3,450  (24 losses) |
| Biggest winner | **AEHR** +$1,195 (+12.85%) |
| Biggest loser | **CDNS** -$357 (-3.39%) |
| Run-to-date peak | $123,263 (on 2025-09-29) |
| Run-to-date max DD | -$1,617 (1.43%) (trough on 2025-08-05) |

### Day-by-day P&L (this month)

| Date | # Trades | Day P&L $ | End-of-day Balance |
|---|---:|---:|---:|
| 2025-09-08 | 1 | $-82 🔴 | $116,275 |
| 2025-09-09 | 3 | $-764 🔴 | $115,511 |
| 2025-09-10 | 1 | $-357 🔴 | $115,153 |
| 2025-09-11 | 2 | $+85 🟢 | $115,239 |
| 2025-09-12 | 7 | $-173 🔴 | $115,065 |
| 2025-09-16 | 1 | $-69 🔴 | $114,996 |
| 2025-09-17 | 2 | $+170 🟢 | $115,166 |
| 2025-09-18 | 5 | $+1,491 🟢 | $116,658 |
| 2025-09-19 | 1 | $-222 🔴 | $116,435 |
| 2025-09-22 | 9 | $+1,885 🟢 | $118,321 |
| 2025-09-23 | 3 | $+206 🟢 | $118,526 |
| 2025-09-24 | 5 | $+953 🟢 | $119,479 |
| 2025-09-25 | 8 | $+1,687 🟢 | $121,166 |
| 2025-09-29 | 2 | $-57 🔴 | $121,109 |
| 2025-09-30 | 2 | $-437 🔴 | $120,672 |

## 2 · The Proud (top winners)

What these have in common — pattern-match on setup, personality, regime, PDZ. If the next month
has fewer trades that look like this, the engine has drifted.

- **AEHR  ** L | +12.85% | MFE +0.00% / MAE +0.00% | exit: `peak_lock_ema12_deep_break` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRENDING · PDZ=premium
- **BE    ** L |  +8.77% | MFE +0.00% / MAE +0.00% | exit: `HARD_FUSE_RSI_EXTREME` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRENDING · PDZ=premium · [RSIv-|PHv-]
- **SNDK  ** L |  +8.15% | MFE +0.00% / MAE +0.00% | exit: `sl_breached` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRENDING · PDZ=premium · [PHv-]
- **KLAC  ** L |  +4.99% | MFE +0.00% / MAE +0.00% | exit: `HARD_FUSE_RSI_EXTREME` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRANSITIONAL · PDZ=premium · [PHv-]
- **STX   ** L |  +4.62% | MFE +0.00% / MAE +0.00% | exit: `sl_breached` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRENDING · PDZ=premium

## 3 · The Disappointed (worst losers)

Each one of these is a calibration question: was the entry the issue, the management, or the regime?
If the same `setup × personality × regime × side` shows up in 3+ disappointed trades, the next
calibration should raise the bar for that combo.

- **ALB   ** L |  -6.46% | MFE +0.00% / MAE +0.00% | exit: `v13_hard_pnl_floor` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRANSITIONAL · PDZ=premium_approach · [PHv-]
- **CDNS  ** L |  -3.39% | MFE +0.00% / MAE +0.00% | exit: `SMART_RUNNER_SUPPORT_BREAK_CLOUD` | TT Tt Gap Reversal Long · PULLBACK_PLAYER · TRANSITIONAL · PDZ=premium_approach · [PHv-]
- **QXO   ** L |  -3.38% | MFE +0.00% / MAE +0.00% | exit: `max_loss` | TT Tt Pullback · VOLATILE_RUNNER · TRANSITIONAL · PDZ=premium_approach
- **SATS  ** L |  -1.76% | MFE +0.00% / MAE +0.00% | exit: `phase_i_mfe_fast_cut_zero_mfe` | TT Tt N Test Support · VOLATILE_RUNNER · TRENDING · PDZ=premium_approach · [RSIv-|PHv-]
- **AMZN  ** L |  -1.74% | MFE +0.00% / MAE +0.00% | exit: `phase_i_mfe_fast_cut_zero_mfe` | TT Tt N Test Support · PULLBACK_PLAYER · TRANSITIONAL · PDZ=premium_approach · [PHv-]

## 4 · Profit giveback (MFE ≥ 1% closed flat-or-worse)

**0 trade(s).** This is the bucket Loop 1's MFE peak-lock targets directly.
If this list is long, the calibration question is: should peak-lock fire earlier?

_None._ Engine is locking gains well this month.

## 5 · Re-entry chains (tickers traded ≥ 3x)

Negative chains are the engine repeatedly being wrong about the same name.
If a chain is net negative AND we never paused, Loop 2's circuit breaker missed it.

- **SNDK** — 4 trades, 1W/2L, **net +6.15%** 🟢
- **SPY** — 3 trades, 2W/0L, **net +1.11%** 🟢

## 6 · Setup performance

Bottom-quartile setups by win-rate AND volume are candidates for the next calibration to guard-rail.

| Setup | N | WR | Avg | Net |
|---|---:|---:|---:|---:|
| `TT Tt Gap Reversal Long` | 34 | 59% | +1.49% | +50.78% |
| `TT Tt Ath Breakout` | 4 | 75% | +0.66% | +2.63% |
| `TT Tt N Test Support` | 5 | 40% | +0.34% | +1.69% |
| `TT Tt Reclaim` | 1 | 100% | +0.61% | +0.61% |
| `TT Tt Range Reversal Long` | 2 | 0% | -1.14% | -2.27% |
| `TT Tt Pullback` | 6 | 33% | -0.39% | -2.36% |

## 7 · Personality × Setup (combos with 2+ trades)

Worst-WR combos at top — these are the immediate Loop 1 candidates.

| Personality | Setup | N | WR | Net |
|---|---|---:|---:|---:|
| VOLATILE_RUNNER | `TT Tt Range Reversal Long` | 2 | 0% | -2.27% |
| VOLATILE_RUNNER | `TT Tt Pullback` | 4 | 50% | -0.28% |
| PULLBACK_PLAYER | `TT Tt N Test Support` | 2 | 50% | +2.39% |
| VOLATILE_RUNNER | `TT Tt N Test Support` | 2 | 50% | -0.40% |
| VOLATILE_RUNNER | `TT Tt Gap Reversal Long` | 27 | 56% | +41.04% |
| PULLBACK_PLAYER | `TT Tt Gap Reversal Long` | 7 | 71% | +9.74% |
| SLOW_GRINDER | `TT Tt Ath Breakout` | 3 | 100% | +2.78% |

## 8 · Loop firing log

Phase C self-adapting loops. Empty for any backtest run before the loops were enabled.

- **Loop 3** — `flat_cut`: 280 times
- **Loop 2** — `block`: 65 times

**Loop 1 scorecard snapshot** (end-of-month, min_samples=3):
- 🔴 BLOCK (4 combos): `tt_n_test_support:trending:volatile_runner:L` (0W/4L), `momentum_score:trending:pullback_player:L` (0W/4L), `tt_pullback:trending:moderate:L` (1W/3L), `tt_range_reversal_long:trending:pullback_player:L` (1W/3L)
- 🟡 RAISE_BAR (3 combos): `tt_pullback:transitional:volatile_runner:L` (1W/2L), `tt_ath_breakout:trending:pullback_player:L` (3W/5L), `tt_pullback:trending:pullback_player:L` (4W/5L)
- 🟢 ALLOW (>0.45 WR): 11 combos

## 9 · Calibration notes (fill in by hand after reviewing above)

_Proposed flag deltas for the next month, with one-line justification each._

- [ ] (no change) — engine looks calibrated for this regime
- [ ] _Or list specific flag deltas. e.g.:_
      `deep_audit_mfe_peak_lock_retrace_pct: 50 → 40` because profit giveback list is long.

After deciding, edit `scripts/v15-activate.sh`, commit with message
`phase-c: 2025-09 calibration` and resume the next month.
