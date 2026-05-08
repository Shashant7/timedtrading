# Phase C — Monthly Verdict · 2026-04

_Source: `phase-c-stage1-jul2025-may2026` · Trades in window: **22** · Generated 2026-05-06 01:00 UTC_

> Read this alongside the previous month's verdict. The point is **trajectory** —
> are we drifting toward July or away from it?

## 1 · Headline

- **19 closed trades.** 12W / 7L / 0 flat.
- **Win rate: 63.2%.** Target 55% — PASS.
- **Avg winner / Avg loser: 4.64x** (3.16% / 0.68%). Target 1.60x — PASS.
- **Max drawdown (cum %): 2.30%.** Target ≤ 3.0% — PASS.
- **Sharpe (annualized, daily-pct proxy): 10.01.** Target 1.50 — PASS.
- **Cumulative P&L (sum of pct): +33.13%.**

### Account equity (start $100,000 reference, ~$9,150 avg notional/trade)

_Each trade uses its actual recorded P&L (`trade.pnl` field) — not derived from %._

| Metric | Value |
|---|---|
| **Start balance** (entering this month) | **$136,970** |
| **End balance** (after last trade closed) | **$140,224** |
| **Net $ P&L for the month** | **$+3,254**  (+2.38% of start balance) |
| Sum of winning $ | +$3,655  (12 wins) |
| Sum of losing $ | -$401  (7 losses) |
| Biggest winner | **XYZ** +$959 (+9.58%) |
| Biggest loser | **APD** -$120 (-1.20%) |
| Run-to-date peak | $140,266 (on 2026-04-29) |
| Run-to-date max DD | -$3,869 (2.76%) (trough on 2026-03-26) |

### Day-by-day P&L (this month)

| Date | # Trades | Day P&L $ | End-of-day Balance |
|---|---:|---:|---:|
| 2026-04-07 | 2 | $-135 🔴 | $136,835 |
| 2026-04-08 | 1 | $+59 🟢 | $136,894 |
| 2026-04-09 | 1 | $+392 🟢 | $137,286 |
| 2026-04-10 | 1 | $+83 🟢 | $137,369 |
| 2026-04-13 | 1 | $+52 🟢 | $137,420 |
| 2026-04-14 | 1 | $+335 🟢 | $137,755 |
| 2026-04-15 | 2 | $+621 🟢 | $138,376 |
| 2026-04-17 | 1 | $-110 🔴 | $138,267 |
| 2026-04-20 | 2 | $-99 🔴 | $138,168 |
| 2026-04-22 | 1 | $+170 🟢 | $138,337 |
| 2026-04-24 | 1 | $+959 🟢 | $139,297 |
| 2026-04-27 | 2 | $+455 🟢 | $139,752 |
| 2026-04-29 | 2 | $+514 🟢 | $140,266 |
| 2026-04-30 | 1 | $-42 🔴 | $140,224 |

## 2 · The Proud (top winners)

What these have in common — pattern-match on setup, personality, regime, PDZ. If the next month
has fewer trades that look like this, the engine has drifted.

- **XYZ   ** L |  +9.58% | MFE +0.00% / MAE +0.00% | exit: `atr_week_618_full_exit` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRANSITIONAL · PDZ=premium_approach
- **CLS   ** L |  +5.24% | MFE +0.00% / MAE +0.00% | exit: `TP_FULL` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRANSITIONAL · PDZ=premium_approach · [PHv-]
- **MTZ   ** L |  +5.09% | MFE +0.00% / MAE +0.00% | exit: `sl_breached` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRENDING · PDZ=premium_approach
- **PWR   ** L |  +4.42% | MFE +0.00% / MAE +0.00% | exit: `TP_FULL` | TT Tt Momentum · PULLBACK_PLAYER · TRANSITIONAL · PDZ=premium_approach · [PHv-]
- **PATH  ** S |  +3.99% | MFE +0.00% / MAE +0.00% | exit: `mfe_decay_structural_flatten` | TT Tt Gap Reversal Short · VOLATILE_RUNNER · TRANSITIONAL · PDZ=discount_approach · [PHv-]

## 3 · The Disappointed (worst losers)

Each one of these is a calibration question: was the entry the issue, the management, or the regime?
If the same `setup × personality × regime × side` shows up in 3+ disappointed trades, the next
calibration should raise the bar for that combo.

- **APD   ** L |  -1.20% | MFE +0.00% / MAE +0.00% | exit: `tape_capitulation_force_exit` | TT Tt Ath Breakout · MODERATE · TRANSITIONAL · PDZ=premium_approach · [PHv-]
- **APD   ** L |  -1.09% | MFE +0.00% / MAE +0.00% | exit: `doctrine_force_exit` | TT Tt Ath Breakout · MODERATE · TRANSITIONAL · PDZ=premium_approach · [PHv-]
- **TSM   ** L |  -1.02% | MFE +0.00% / MAE +0.00% | exit: `phase_i_mfe_fast_cut_2h` | TT Tt Momentum · PULLBACK_PLAYER · TRANSITIONAL · PDZ=premium_approach · [PHv-]
- **GEV   ** L |  -0.81% | MFE +0.00% / MAE +0.00% | exit: `phase_i_mfe_fast_cut_2h` | TT Tt Ath Breakout · VOLATILE_RUNNER · TRENDING · PDZ=premium
- **CW    ** L |  -0.26% | MFE +0.00% / MAE +0.00% | exit: `doctrine_force_exit` | TT Tt Ath Breakout · PULLBACK_PLAYER · TRANSITIONAL · PDZ=premium_approach · [PHv-]

## 4 · Profit giveback (MFE ≥ 1% closed flat-or-worse)

**0 trade(s).** This is the bucket Loop 1's MFE peak-lock targets directly.
If this list is long, the calibration question is: should peak-lock fire earlier?

_None._ Engine is locking gains well this month.

## 5 · Re-entry chains (tickers traded ≥ 3x)

Negative chains are the engine repeatedly being wrong about the same name.
If a chain is net negative AND we never paused, Loop 2's circuit breaker missed it.

- **CSX** — 3 trades, 2W/1L, **net +2.06%** 🟢

## 6 · Setup performance

Bottom-quartile setups by win-rate AND volume are candidates for the next calibration to guard-rail.

| Setup | N | WR | Avg | Net |
|---|---:|---:|---:|---:|
| `TT Tt Gap Reversal Long` | 6 | 83% | +3.70% | +22.22% |
| `TT Tt Gap Reversal Short` | 1 | 100% | +3.99% | +3.99% |
| `TT Tt Momentum` | 2 | 50% | +1.70% | +3.40% |
| `TT Tt Pullback` | 1 | 100% | +2.95% | +2.95% |
| `TT Tt Ath Breakout` | 9 | 44% | +0.06% | +0.56% |

## 7 · Personality × Setup (combos with 2+ trades)

Worst-WR combos at top — these are the immediate Loop 1 candidates.

| Personality | Setup | N | WR | Net |
|---|---|---:|---:|---:|
| MODERATE | `TT Tt Ath Breakout` | 3 | 33% | -1.46% |
| PULLBACK_PLAYER | `TT Tt Ath Breakout` | 4 | 50% | +1.80% |
| PULLBACK_PLAYER | `TT Tt Momentum` | 2 | 50% | +3.40% |
| VOLATILE_RUNNER | `TT Tt Ath Breakout` | 2 | 50% | +0.22% |
| VOLATILE_RUNNER | `TT Tt Gap Reversal Long` | 6 | 83% | +22.22% |

## 8 · Loop firing log

Phase C self-adapting loops. Empty for any backtest run before the loops were enabled.

- **Loop 2** — `block`: 98 times
- **Loop 3** — `flat_cut`: 78 times

**Loop 1 scorecard snapshot** (end-of-month, min_samples=3):
- 🔴 BLOCK (17 combos): `tt_n_test_support:transitional:pullback_player:L` (0W/4L), `ema_regime_confirmed_long:transitional:pullback_player:L` (0W/6L), `momentum_score:trending:pullback_player:L` (0W/14L), `tt_n_test_support:trending:moderate:L` (0W/3L), `tt_ath_breakout:trending:moderate:L` (0W/6L), `tt_gap_reversal_long:trending:slow_grinder:L` (0W/6L), `tt_atl_breakdown:transitional:moderate:S` (0W/3L), `tt_ath_breakout:trending:pullback_player:L` (3W/17L), `tt_n_test_support:trending:volatile_runner:L` (1W/5L), `tt_pullback:trending:moderate:L` (1W/5L)
- 🟡 RAISE_BAR (10 combos): `tt_n_test_support:transitional:slow_grinder:L` (4W/8L), `tt_n_test_support:choppy:slow_grinder:L` (2W/4L), `tt_pullback:transitional:volatile_runner:L` (4W/8L), `tt_gap_reversal_short:trending:volatile_runner:S` (1W/2L), `tt_pullback:trending:pullback_player:L` (5W/9L), `tt_n_test_support:trending:pullback_player:L` (3W/5L), `tt_pullback:trending:volatile_runner:L` (5W/8L), `tt_range_reversal_long:trending:pullback_player:L` (4W/6L), `tt_n_test_support:transitional:moderate:L` (2W/3L), `tt_gap_reversal_long:choppy:volatile_runner:L` (7W/9L)
- 🟢 ALLOW (>0.45 WR): 18 combos

## 9 · Calibration notes (fill in by hand after reviewing above)

_Proposed flag deltas for the next month, with one-line justification each._

- [ ] (no change) — engine looks calibrated for this regime
- [ ] _Or list specific flag deltas. e.g.:_
      `deep_audit_mfe_peak_lock_retrace_pct: 50 → 40` because profit giveback list is long.

After deciding, edit `scripts/v15-activate.sh`, commit with message
`phase-c: 2026-04 calibration` and resume the next month.
