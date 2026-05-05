# Phase C — Monthly Verdict · 2026-02

_Source: `phase-c-stage1-jul2025-may2026` · Trades in window: **74** · Generated 2026-05-05 15:30 UTC_

> Read this alongside the previous month's verdict. The point is **trajectory** —
> are we drifting toward July or away from it?

## 1 · Headline

- **70 closed trades.** 34W / 36L / 0 flat.
- **Win rate: 48.6%.** Target 55% — MISS.
- **Avg winner / Avg loser: 1.41x** (2.07% / 1.47%). Target 1.60x — MISS.
- **Max drawdown (cum %): 14.53%.** Target ≤ 3.0% — MISS.
- **Sharpe (annualized, daily-pct proxy): 1.71.** Target 1.50 — PASS.
- **Cumulative P&L (sum of pct): +17.56%.**

### Account equity (start $100,000 reference, ~$9,266 avg notional/trade)

_Each trade uses its actual recorded P&L (`trade.pnl` field) — not derived from %._

| Metric | Value |
|---|---|
| **Start balance** (entering this month) | **$137,799** |
| **End balance** (after last trade closed) | **$140,038** |
| **Net $ P&L for the month** | **$+2,239**  (+1.63% of start balance) |
| Sum of winning $ | +$6,508  (34 wins) |
| Sum of losing $ | -$5,430  (36 losses) |
| Biggest winner | **GEV** +$650 (+6.61%) |
| Biggest loser | **BE** -$566 (-4.73%) |
| Run-to-date peak | $140,038 (on 2026-02-27) |
| Run-to-date max DD | -$2,953 (2.32%) (trough on 2025-11-18) |

### Day-by-day P&L (this month)

| Date | # Trades | Day P&L $ | End-of-day Balance |
|---|---:|---:|---:|
| 2026-02-03 | 6 | $-906 🔴 | $136,893 |
| 2026-02-04 | 6 | $+1,016 🟢 | $137,910 |
| 2026-02-05 | 1 | $-31 🔴 | $137,879 |
| 2026-02-09 | 7 | $-329 🔴 | $137,550 |
| 2026-02-10 | 3 | $-97 🔴 | $137,453 |
| 2026-02-11 | 2 | $+45 🟢 | $137,497 |
| 2026-02-12 | 7 | $-243 🔴 | $137,255 |
| 2026-02-13 | 4 | $+618 🟢 | $137,873 |
| 2026-02-17 | 2 | $+492 🟢 | $138,365 |
| 2026-02-18 | 4 | $-483 🔴 | $137,881 |
| 2026-02-19 | 4 | $+169 🟢 | $138,050 |
| 2026-02-23 | 6 | $-678 🔴 | $137,373 |
| 2026-02-24 | 3 | $+108 🟢 | $137,480 |
| 2026-02-25 | 2 | $+365 🟢 | $137,845 |
| 2026-02-26 | 11 | $+610 🟢 | $138,455 |
| 2026-02-27 | 2 | $+421 🟢 | $138,877 |

## 2 · The Proud (top winners)

What these have in common — pattern-match on setup, personality, regime, PDZ. If the next month
has fewer trades that look like this, the engine has drifted.

- **DY    ** L |  +6.83% | MFE +0.00% / MAE +0.00% | exit: `sl_breached` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · CHOPPY · PDZ=premium · [RSIv-|PHv-]
- **GEV   ** L |  +6.61% | MFE +0.00% / MAE +0.00% | exit: `sl_breached` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRANSITIONAL · PDZ=premium_approach
- **FIX   ** L |  +5.45% | MFE +0.00% / MAE +0.00% | exit: `sl_breached` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRANSITIONAL · PDZ=premium
- **CRS   ** L |  +4.30% | MFE +0.00% / MAE +0.00% | exit: `hard_max_hold_504h` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRANSITIONAL · PDZ=premium_approach
- **GEV   ** L |  +4.17% | MFE +0.00% / MAE +0.00% | exit: `ST_FLIP_4H_CLOSE` | TT Tt Gap Reversal Long · ? · ? · PDZ=?

## 3 · The Disappointed (worst losers)

Each one of these is a calibration question: was the entry the issue, the management, or the regime?
If the same `setup × personality × regime × side` shows up in 3+ disappointed trades, the next
calibration should raise the bar for that combo.

- **BE    ** L |  -4.73% | MFE +0.00% / MAE +0.00% | exit: `HARD_LOSS_CAP` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRENDING · PDZ=premium_approach
- **SN    ** L |  -3.85% | MFE +0.00% / MAE +0.00% | exit: `max_loss_time_scaled_momentum_buffered` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRANSITIONAL · PDZ=premium_approach
- **GS    ** L |  -3.37% | MFE +0.00% / MAE +0.00% | exit: `max_loss` | TT Tt Gap Reversal Long · PULLBACK_PLAYER · TRANSITIONAL · PDZ=premium_approach · [PHv-]
- **ANET  ** L |  -3.19% | MFE +0.00% / MAE +0.00% | exit: `doctrine_force_exit` | TT Tt Pullback · VOLATILE_RUNNER · TRANSITIONAL · PDZ=premium_approach
- **AU    ** L |  -3.16% | MFE +0.00% / MAE +0.00% | exit: `PRE_EARNINGS_FORCE_EXIT` | TT Tt Range Reversal Long · VOLATILE_RUNNER · TRANSITIONAL · PDZ=premium_approach

## 4 · Profit giveback (MFE ≥ 1% closed flat-or-worse)

**0 trade(s).** This is the bucket Loop 1's MFE peak-lock targets directly.
If this list is long, the calibration question is: should peak-lock fire earlier?

_None._ Engine is locking gains well this month.

## 5 · Re-entry chains (tickers traded ≥ 3x)

Negative chains are the engine repeatedly being wrong about the same name.
If a chain is net negative AND we never paused, Loop 2's circuit breaker missed it.

- **AA** — 4 trades, 3W/1L, **net +2.88%** 🟢
- **DY** — 3 trades, 1W/2L, **net +2.46%** 🟢
- **SPY** — 3 trades, 2W/1L, **net -0.01%** 🔴
- **FIX** — 3 trades, 2W/1L, **net +8.35%** 🟢

## 6 · Setup performance

Bottom-quartile setups by win-rate AND volume are candidates for the next calibration to guard-rail.

| Setup | N | WR | Avg | Net |
|---|---:|---:|---:|---:|
| `TT Tt Gap Reversal Long` | 51 | 53% | +0.53% | +27.12% |
| `TT Tt Pullback` | 5 | 60% | -0.07% | -0.36% |
| `TT Tt N Test Support` | 7 | 43% | -0.30% | -2.07% |
| `TT Tt Ath Breakout` | 5 | 20% | -0.61% | -3.04% |
| `TT Tt Range Reversal Long` | 2 | 0% | -2.04% | -4.09% |

## 7 · Personality × Setup (combos with 2+ trades)

Worst-WR combos at top — these are the immediate Loop 1 candidates.

| Personality | Setup | N | WR | Net |
|---|---|---:|---:|---:|
| PULLBACK_PLAYER | `TT Tt Ath Breakout` | 2 | 0% | -2.17% |
| PULLBACK_PLAYER | `TT Tt Gap Reversal Long` | 13 | 31% | -0.90% |
| SLOW_GRINDER | `TT Tt N Test Support` | 5 | 40% | -1.05% |
| PULLBACK_PLAYER | `TT Tt N Test Support` | 2 | 50% | -1.03% |
| MODERATE | `TT Tt Ath Breakout` | 2 | 50% | -0.64% |
| VOLATILE_RUNNER | `TT Tt Pullback` | 2 | 50% | -2.40% |
| VOLATILE_RUNNER | `TT Tt Gap Reversal Long` | 30 | 57% | +18.88% |
| ? | `TT Tt Gap Reversal Long` | 5 | 60% | +4.90% |
| MODERATE | `TT Tt Gap Reversal Long` | 3 | 100% | +4.23% |
| PULLBACK_PLAYER | `TT Tt Pullback` | 2 | 100% | +3.59% |

## 8 · Loop firing log

Phase C self-adapting loops. Empty for any backtest run before the loops were enabled.

- **Loop 2** — `block`: 301 times
- **Loop 3** — `flat_cut`: 196 times

**Loop 1 scorecard snapshot** (end-of-month, min_samples=3):
- 🔴 BLOCK (6 combos): `tt_n_test_support:transitional:pullback_player:L` (0W/4L), `momentum_score:trending:pullback_player:L` (0W/8L), `tt_n_test_support:trending:moderate:L` (0W/3L), `tt_n_test_support:trending:volatile_runner:L` (1W/5L), `tt_pullback:trending:moderate:L` (1W/5L), `tt_n_test_support:transitional:volatile_runner:L` (1W/3L)
- 🟡 RAISE_BAR (10 combos): `tt_ath_breakout:trending:pullback_player:L` (5W/11L), `tt_n_test_resistance:transitional:pullback_player:S` (1W/2L), `tt_n_test_support:choppy:slow_grinder:L` (2W/4L), `tt_gap_reversal_short:trending:volatile_runner:S` (1W/2L), `tt_ath_breakout:trending:slow_grinder:L` (4W/7L), `tt_n_test_support:trending:pullback_player:L` (3W/5L), `tt_range_reversal_long:trending:pullback_player:L` (4W/6L), `tt_n_test_support:transitional:moderate:L` (2W/3L), `tt_pullback:trending:volatile_runner:L` (4W/5L), `tt_pullback:transitional:volatile_runner:L` (4W/5L)
- 🟢 ALLOW (>0.45 WR): 15 combos

## 9 · Calibration notes (fill in by hand after reviewing above)

_Proposed flag deltas for the next month, with one-line justification each._

- [ ] (no change) — engine looks calibrated for this regime
- [ ] _Or list specific flag deltas. e.g.:_
      `deep_audit_mfe_peak_lock_retrace_pct: 50 → 40` because profit giveback list is long.

After deciding, edit `scripts/v15-activate.sh`, commit with message
`phase-c: 2026-02 calibration` and resume the next month.
