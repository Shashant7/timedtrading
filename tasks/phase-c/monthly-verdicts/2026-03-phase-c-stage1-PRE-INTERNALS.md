# Phase C — Monthly Verdict · 2026-03

_Source: `phase-c-stage1-jul2025-may2026` · Trades in window: **35** · Generated 2026-05-05 21:13 UTC_

> Read this alongside the previous month's verdict. The point is **trajectory** —
> are we drifting toward July or away from it?

## 1 · Headline

- **33 closed trades.** 11W / 22L / 0 flat.
- **Win rate: 33.3%.** Target 55% — MISS.
- **Avg winner / Avg loser: 0.42x** (0.75% / 1.80%). Target 1.60x — MISS.
- **Max drawdown (cum %): 32.67%.** Target ≤ 3.0% — MISS.
- **Sharpe (annualized, daily-pct proxy): -7.15.** Target 1.50 — MISS.
- **Cumulative P&L (sum of pct): -31.26%.**

### Account equity (start $100,000 reference, ~$10,633 avg notional/trade)

_Each trade uses its actual recorded P&L (`trade.pnl` field) — not derived from %._

| Metric | Value |
|---|---|
| **Start balance** (entering this month) | **$140,049** |
| **End balance** (after last trade closed) | **$136,652** |
| **Net $ P&L for the month** | **$-3,396**  (-2.43% of start balance) |
| Sum of winning $ | +$771  (11 wins) |
| Sum of losing $ | -$4,069  (22 losses) |
| Biggest winner | **ABT** +$321 (+3.49%) |
| Biggest loser | **HL** -$812 (-4.05%) |
| Run-to-date peak | $140,234 (on 2026-03-02) |
| Run-to-date max DD | -$4,142 (2.95%) (trough on 2026-03-26) |

### Day-by-day P&L (this month)

| Date | # Trades | Day P&L $ | End-of-day Balance |
|---|---:|---:|---:|
| 2026-03-03 | 8 | $-2,065 🔴 | $137,984 |
| 2026-03-04 | 1 | $-128 🔴 | $137,856 |
| 2026-03-05 | 3 | $-828 🔴 | $137,027 |
| 2026-03-09 | 2 | $-85 🔴 | $136,942 |
| 2026-03-11 | 1 | $-24 🔴 | $136,918 |
| 2026-03-16 | 2 | $-180 🔴 | $136,739 |
| 2026-03-18 | 2 | $-98 🔴 | $136,640 |
| 2026-03-19 | 1 | $-71 🔴 | $136,569 |
| 2026-03-20 | 5 | $+90 🟢 | $136,659 |
| 2026-03-23 | 1 | $-133 🔴 | $136,527 |
| 2026-03-24 | 1 | $-80 🔴 | $136,447 |
| 2026-03-26 | 3 | $-111 🔴 | $136,336 |
| 2026-03-30 | 1 | $+103 🟢 | $136,439 |
| 2026-03-31 | 2 | $+312 🟢 | $136,750 |

## 2 · The Proud (top winners)

What these have in common — pattern-match on setup, personality, regime, PDZ. If the next month
has fewer trades that look like this, the engine has drifted.

- **ABT   ** S |  +3.49% | MFE +0.00% / MAE +0.00% | exit: `TP_FULL` | TT Tt Atl Breakdown · MODERATE · TRANSITIONAL · PDZ=discount_approach · [PHv-]
- **QQQ   ** S |  +1.56% | MFE +0.00% / MAE +0.00% | exit: `TP_FULL` | TT Tt Atl Breakdown · MODERATE · TRANSITIONAL · PDZ=discount · [PHv-]
- **SPY   ** S |  +1.10% | MFE +0.00% / MAE +0.00% | exit: `TP_FULL` | TT Tt Pullback · SLOW_GRINDER · TRENDING · PDZ=discount_approach · [RSIv-|PHv-]
- **XLRE  ** S |  +0.67% | MFE +0.00% / MAE +0.00% | exit: `etf_stagnant_exit` | TT Tt Atl Breakdown · ? · ? · PDZ=?
- **GEV   ** L |  +0.46% | MFE +0.00% / MAE +0.00% | exit: `atr_week_618_full_exit` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRANSITIONAL · PDZ=premium_approach

## 3 · The Disappointed (worst losers)

Each one of these is a calibration question: was the entry the issue, the management, or the regime?
If the same `setup × personality × regime × side` shows up in 3+ disappointed trades, the next
calibration should raise the bar for that combo.

- **ALB   ** L |  -8.82% | MFE +0.00% / MAE +0.00% | exit: `HARD_LOSS_CAP` | TT Tt Gap Reversal Long · ? · ? · PDZ=?
- **STX   ** L |  -4.58% | MFE +0.00% / MAE +0.00% | exit: `doctrine_force_exit` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · CHOPPY · PDZ=premium_approach
- **HL    ** L |  -4.05% | MFE +0.00% / MAE +0.00% | exit: `HARD_LOSS_CAP` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRENDING · PDZ=discount_approach · [RSIv-|PHv-]
- **JCI   ** L |  -3.86% | MFE +0.00% / MAE +0.00% | exit: `doctrine_force_exit` | TT Tt Ath Breakout · PULLBACK_PLAYER · TRENDING · PDZ=premium · [PHv-]
- **CCJ   ** L |  -3.59% | MFE +0.00% / MAE +0.00% | exit: `HARD_LOSS_CAP` | TT Tt Pullback · VOLATILE_RUNNER · TRANSITIONAL · PDZ=discount_approach

## 4 · Profit giveback (MFE ≥ 1% closed flat-or-worse)

**0 trade(s).** This is the bucket Loop 1's MFE peak-lock targets directly.
If this list is long, the calibration question is: should peak-lock fire earlier?

_None._ Engine is locking gains well this month.

## 5 · Re-entry chains (tickers traded ≥ 3x)

Negative chains are the engine repeatedly being wrong about the same name.
If a chain is net negative AND we never paused, Loop 2's circuit breaker missed it.

- **SPY** — 5 trades, 2W/3L, **net +0.13%** 🟢
- **QQQ** — 4 trades, 2W/2L, **net +0.79%** 🟢

## 6 · Setup performance

Bottom-quartile setups by win-rate AND volume are candidates for the next calibration to guard-rail.

| Setup | N | WR | Avg | Net |
|---|---:|---:|---:|---:|
| `TT Tt Atl Breakdown` | 5 | 60% | +0.88% | +4.39% |
| `TT Tt Range Reversal Long` | 1 | 100% | +0.41% | +0.41% |
| `TT Tt N Test Support` | 1 | 0% | -1.05% | -1.05% |
| `TT Tt N Test Resistance` | 5 | 20% | -0.48% | -2.40% |
| `TT Tt Pullback` | 8 | 25% | -0.86% | -6.90% |
| `TT Tt Ath Breakout` | 5 | 0% | -1.73% | -8.66% |
| `TT Tt Gap Reversal Long` | 8 | 50% | -2.13% | -17.05% |

## 7 · Personality × Setup (combos with 2+ trades)

Worst-WR combos at top — these are the immediate Loop 1 candidates.

| Personality | Setup | N | WR | Net |
|---|---|---:|---:|---:|
| PULLBACK_PLAYER | `TT Tt Ath Breakout` | 3 | 0% | -6.40% |
| VOLATILE_RUNNER | `TT Tt Pullback` | 2 | 0% | -4.54% |
| ? | `TT Tt N Test Resistance` | 3 | 33% | -0.20% |
| VOLATILE_RUNNER | `TT Tt Gap Reversal Long` | 5 | 40% | -8.44% |
| ? | `TT Tt Gap Reversal Long` | 2 | 50% | -8.79% |
| SLOW_GRINDER | `TT Tt Pullback` | 4 | 50% | +0.27% |
| ? | `TT Tt Atl Breakdown` | 2 | 50% | +0.06% |
| MODERATE | `TT Tt Atl Breakdown` | 3 | 67% | +4.33% |

## 8 · Loop firing log

Phase C self-adapting loops. Empty for any backtest run before the loops were enabled.

- **Loop 2** — `block`: 152 times
- **Loop 3** — `flat_cut`: 34 times

**Loop 1 scorecard snapshot** (end-of-month, min_samples=3):
- 🔴 BLOCK (12 combos): `tt_n_test_support:transitional:pullback_player:L` (0W/4L), `momentum_score:trending:pullback_player:L` (0W/8L), `tt_n_test_support:trending:moderate:L` (0W/3L), `tt_ath_breakout:trending:moderate:L` (0W/5L), `tt_gap_reversal_long:trending:slow_grinder:L` (0W/5L), `tt_n_test_support:trending:volatile_runner:L` (1W/5L), `tt_pullback:trending:moderate:L` (1W/5L), `tt_ath_breakout:trending:pullback_player:L` (4W/16L), `tt_n_test_resistance:transitional:pullback_player:S` (1W/4L), `tt_atl_breakdown:trending:slow_grinder:S` (1W/4L)
- 🟡 RAISE_BAR (11 combos): `tt_n_test_support:choppy:slow_grinder:L` (2W/4L), `tt_gap_reversal_short:trending:volatile_runner:S` (1W/2L), `tt_n_test_resistance:transitional:slow_grinder:S` (1W/2L), `tt_pullback:trending:volatile_runner:L` (4W/7L), `tt_n_test_support:transitional:slow_grinder:L` (4W/7L), `tt_pullback:transitional:volatile_runner:L` (4W/7L), `tt_n_test_support:trending:pullback_player:L` (3W/5L), `tt_pullback:trending:pullback_player:L` (5W/8L), `tt_range_reversal_long:trending:pullback_player:L` (4W/6L), `tt_n_test_support:transitional:moderate:L` (2W/3L)
- 🟢 ALLOW (>0.45 WR): 15 combos

## 9 · Calibration notes (fill in by hand after reviewing above)

_Proposed flag deltas for the next month, with one-line justification each._

- [ ] (no change) — engine looks calibrated for this regime
- [ ] _Or list specific flag deltas. e.g.:_
      `deep_audit_mfe_peak_lock_retrace_pct: 50 → 40` because profit giveback list is long.

After deciding, edit `scripts/v15-activate.sh`, commit with message
`phase-c: 2026-03 calibration` and resume the next month.
