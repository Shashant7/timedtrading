# Phase C — Monthly Verdict · 2025-08

_Source: `phase-c-stage1-jul2025-may2026` · Trades in window: **81** · Generated 2026-05-03 18:05 UTC_

> Read this alongside the previous month's verdict. The point is **trajectory** —
> are we drifting toward July or away from it?

## 1 · Headline

- **64 closed trades.** 32W / 32L / 0 flat.
- **Win rate: 50.0%.** Target 55% — MISS.
- **Avg winner / Avg loser: 1.76x** (1.87% / 1.06%). Target 1.60x — PASS.
- **Max drawdown (cum %): 12.89%.** Target ≤ 3.0% — MISS.
- **Sharpe (annualized, daily-pct proxy): 2.99.** Target 1.50 — PASS.
- **Cumulative P&L (sum of pct): +25.87%.**

### Account equity (start $100,000 reference, ~$9,902 avg notional/trade)

_Each trade uses its actual recorded P&L (`trade.pnl` field) — not derived from %._

| Metric | Value |
|---|---|
| **Start balance** (entering this month) | **$110,103** |
| **End balance** (after last trade closed) | **$111,807** |
| **Net $ P&L for the month** | **$+1,703**  (+1.55% of start balance) |
| Sum of winning $ | +$5,171  (32 wins) |
| Sum of losing $ | -$3,594  (32 losses) |
| Biggest winner | **ETHA** +$838 (+9.53%) |
| Biggest loser | **CVNA** -$369 (-2.51%) |
| Run-to-date peak | $112,020 (on 2025-08-19) |
| Run-to-date max DD | -$1,033 (0.92%) (trough on 2025-08-20) |

### Day-by-day P&L (this month)

| Date | # Trades | Day P&L $ | End-of-day Balance |
|---|---:|---:|---:|
| 2025-08-04 | 1 | $-110 🔴 | $109,993 |
| 2025-08-05 | 5 | $-167 🔴 | $109,826 |
| 2025-08-06 | 2 | $+200 🟢 | $110,026 |
| 2025-08-07 | 5 | $-134 🔴 | $109,893 |
| 2025-08-08 | 1 | $-19 🔴 | $109,874 |
| 2025-08-11 | 2 | $+199 🟢 | $110,073 |
| 2025-08-12 | 1 | $+53 🟢 | $110,126 |
| 2025-08-13 | 9 | $+970 🟢 | $111,096 |
| 2025-08-14 | 3 | $+47 🟢 | $111,142 |
| 2025-08-15 | 2 | $+255 🟢 | $111,397 |
| 2025-08-18 | 1 | $-36 🔴 | $111,361 |
| 2025-08-19 | 10 | $-377 🔴 | $110,984 |
| 2025-08-20 | 4 | $-124 🔴 | $110,860 |
| 2025-08-21 | 3 | $+271 🟢 | $111,131 |
| 2025-08-22 | 1 | $-181 🔴 | $110,949 |
| 2025-08-27 | 3 | $+653 🟢 | $111,602 |
| 2025-08-28 | 5 | $-357 🔴 | $111,245 |
| 2025-08-29 | 6 | $+435 🟢 | $111,680 |

## 2 · The Proud (top winners)

What these have in common — pattern-match on setup, personality, regime, PDZ. If the next month
has fewer trades that look like this, the engine has drifted.

- **ETHA  ** L |  +9.53% | MFE +0.00% / MAE +0.00% | exit: `HARD_FUSE_RSI_EXTREME` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRENDING · PDZ=premium
- **BE    ** L |  +6.03% | MFE +0.00% / MAE +0.00% | exit: `ST_FLIP_4H_CLOSE` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRENDING · PDZ=premium
- **ALB   ** L |  +5.11% | MFE +0.00% / MAE +0.00% | exit: `SOFT_FUSE_RSI_CONFIRMED` | TT Tt Range Reversal Long · VOLATILE_RUNNER · TRANSITIONAL · PDZ=premium_approach · [RSIv-|PHv-]
- **SGI   ** L |  +3.86% | MFE +0.00% / MAE +0.00% | exit: `sl_breached` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRANSITIONAL · PDZ=premium
- **B     ** L |  +3.77% | MFE +0.00% / MAE +0.00% | exit: `mfe_decay_structural_flatten` | TT Tt Gap Reversal Long · PULLBACK_PLAYER · TRANSITIONAL · PDZ=premium

## 3 · The Disappointed (worst losers)

Each one of these is a calibration question: was the entry the issue, the management, or the regime?
If the same `setup × personality × regime × side` shows up in 3+ disappointed trades, the next
calibration should raise the bar for that combo.

- **ALB   ** L |  -3.46% | MFE +0.00% / MAE +0.00% | exit: `max_loss` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRANSITIONAL · PDZ=premium_approach
- **SN    ** L |  -3.07% | MFE +0.00% / MAE +0.00% | exit: `max_loss` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRANSITIONAL · PDZ=premium_approach
- **STX   ** L |  -2.59% | MFE +0.00% / MAE +0.00% | exit: `max_loss_time_scaled` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRENDING · PDZ=premium · [PHv-]
- **CVNA  ** L |  -2.51% | MFE +0.00% / MAE +0.00% | exit: `max_loss_time_scaled` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRANSITIONAL · PDZ=discount_approach · [PHv-]
- **ANET  ** L |  -2.24% | MFE +0.00% / MAE +0.00% | exit: `max_loss_time_scaled` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRENDING · PDZ=premium · [RSIv-|PHv-]

## 4 · Profit giveback (MFE ≥ 1% closed flat-or-worse)

**0 trade(s).** This is the bucket Loop 1's MFE peak-lock targets directly.
If this list is long, the calibration question is: should peak-lock fire earlier?

_None._ Engine is locking gains well this month.

## 5 · Re-entry chains (tickers traded ≥ 3x)

Negative chains are the engine repeatedly being wrong about the same name.
If a chain is net negative AND we never paused, Loop 2's circuit breaker missed it.

- **GE** — 3 trades, 0W/3L, **net -1.55%** 🔴
- **APLD** — 3 trades, 2W/1L, **net +4.63%** 🟢
- **SPY** — 3 trades, 1W/1L, **net -0.20%** 🔴

## 6 · Setup performance

Bottom-quartile setups by win-rate AND volume are candidates for the next calibration to guard-rail.

| Setup | N | WR | Avg | Net |
|---|---:|---:|---:|---:|
| `TT Tt Gap Reversal Long` | 39 | 59% | +0.71% | +27.84% |
| `TT Tt Range Reversal Long` | 4 | 25% | +0.60% | +2.38% |
| `TT Tt Pullback` | 5 | 60% | +0.25% | +1.23% |
| `TT Tt Ath Breakout` | 7 | 29% | -0.08% | -0.56% |
| `TT Tt N Test Support` | 6 | 50% | -0.16% | -0.97% |
| `TT Tt N Test Resistance` | 3 | 0% | -1.35% | -4.05% |

## 7 · Personality × Setup (combos with 2+ trades)

Worst-WR combos at top — these are the immediate Loop 1 candidates.

| Personality | Setup | N | WR | Net |
|---|---|---:|---:|---:|
| PULLBACK_PLAYER | `TT Tt N Test Resistance` | 2 | 0% | -2.47% |
| PULLBACK_PLAYER | `TT Tt Ath Breakout` | 3 | 0% | -0.96% |
| VOLATILE_RUNNER | `TT Tt Range Reversal Long` | 3 | 33% | +4.25% |
| VOLATILE_RUNNER | `TT Tt Ath Breakout` | 2 | 50% | +0.10% |
| MODERATE | `TT Tt N Test Support` | 2 | 50% | +0.94% |
| VOLATILE_RUNNER | `TT Tt Gap Reversal Long` | 30 | 57% | +18.20% |
| PULLBACK_PLAYER | `TT Tt Gap Reversal Long` | 8 | 62% | +7.17% |
| PULLBACK_PLAYER | `TT Tt Pullback` | 2 | 100% | +0.45% |
| SLOW_GRINDER | `TT Tt N Test Support` | 2 | 100% | +1.32% |

## 8 · Loop firing log

Phase C self-adapting loops. Empty for any backtest run before the loops were enabled.

- **Loop 3** — `flat_cut`: 530 times
- **Loop 2** — `block`: 156 times

**Loop 1 scorecard snapshot** (end-of-month, min_samples=3):
- 🔴 BLOCK (1 combos): `tt_ath_breakout:trending:pullback_player:L` (3W/7L)
- 🟡 RAISE_BAR (3 combos): `tt_range_reversal_long:transitional:volatile_runner:L` (1W/2L), `tt_pullback:trending:pullback_player:L` (2W/3L), `tt_gap_reversal_long:transitional:volatile_runner:L` (7W/9L)
- 🟢 ALLOW (>0.45 WR): 7 combos

## 9 · Calibration notes (fill in by hand after reviewing above)

_Proposed flag deltas for the next month, with one-line justification each._

- [ ] (no change) — engine looks calibrated for this regime
- [ ] _Or list specific flag deltas. e.g.:_
      `deep_audit_mfe_peak_lock_retrace_pct: 50 → 40` because profit giveback list is long.

After deciding, edit `scripts/v15-activate.sh`, commit with message
`phase-c: 2025-08 calibration` and resume the next month.
