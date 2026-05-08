# Phase C — Monthly Verdict · 2026-01

_Source: `phase-c-stage1-jul2025-may2026` · Trades in window: **78** · Generated 2026-05-05 13:35 UTC_

> Read this alongside the previous month's verdict. The point is **trajectory** —
> are we drifting toward July or away from it?

## 1 · Headline

- **74 closed trades.** 42W / 32L / 0 flat.
- **Win rate: 56.8%.** Target 55% — PASS.
- **Avg winner / Avg loser: 2.82x** (2.85% / 1.01%). Target 1.60x — PASS.
- **Max drawdown (cum %): 8.02%.** Target ≤ 3.0% — MISS.
- **Sharpe (annualized, daily-pct proxy): 6.48.** Target 1.50 — PASS.
- **Cumulative P&L (sum of pct): +87.24%.**

### Account equity (start $100,000 reference, ~$9,079 avg notional/trade)

_Each trade uses its actual recorded P&L (`trade.pnl` field) — not derived from %._

| Metric | Value |
|---|---|
| **Start balance** (entering this month) | **$130,032** |
| **End balance** (after last trade closed) | **$137,799** |
| **Net $ P&L for the month** | **$+7,767**  (+5.97% of start balance) |
| Sum of winning $ | +$10,253  (42 wins) |
| Sum of losing $ | -$3,311  (32 losses) |
| Biggest winner | **HL** +$1,116 (+13.35%) |
| Biggest loser | **AA** -$452 (-4.05%) |
| Run-to-date peak | $137,799 (on 2026-01-30) |
| Run-to-date max DD | -$2,953 (2.32%) (trough on 2025-11-18) |

### Day-by-day P&L (this month)

| Date | # Trades | Day P&L $ | End-of-day Balance |
|---|---:|---:|---:|
| 2026-01-05 | 3 | $+20 🟢 | $130,052 |
| 2026-01-06 | 4 | $+70 🟢 | $130,122 |
| 2026-01-07 | 6 | $-231 🔴 | $129,891 |
| 2026-01-08 | 5 | $+584 🟢 | $130,475 |
| 2026-01-12 | 2 | $+91 🟢 | $130,566 |
| 2026-01-13 | 5 | $+682 🟢 | $131,248 |
| 2026-01-14 | 7 | $-165 🔴 | $131,083 |
| 2026-01-15 | 3 | $+789 🟢 | $131,872 |
| 2026-01-16 | 2 | $+64 🟢 | $131,935 |
| 2026-01-20 | 11 | $+1,221 🟢 | $133,156 |
| 2026-01-21 | 5 | $+1,632 🟢 | $134,788 |
| 2026-01-22 | 1 | $+186 🟢 | $134,975 |
| 2026-01-23 | 2 | $+59 🟢 | $135,033 |
| 2026-01-26 | 2 | $+216 🟢 | $135,249 |
| 2026-01-27 | 3 | $-85 🔴 | $135,165 |
| 2026-01-28 | 6 | $-114 🔴 | $135,051 |
| 2026-01-29 | 6 | $+921 🟢 | $135,972 |
| 2026-01-30 | 1 | $+1,002 🟢 | $136,974 |

## 2 · The Proud (top winners)

What these have in common — pattern-match on setup, personality, regime, PDZ. If the next month
has fewer trades that look like this, the engine has drifted.

- **HL    ** L | +13.35% | MFE +0.00% / MAE +0.00% | exit: `TP_FULL` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRENDING · PDZ=premium
- **ASTS  ** L |  +9.97% | MFE +0.00% / MAE +0.00% | exit: `ST_FLIP_4H_CLOSE` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRENDING · PDZ=premium_approach
- **CCJ   ** L |  +7.95% | MFE +0.00% / MAE +0.00% | exit: `ST_FLIP_4H_CLOSE` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRENDING · PDZ=premium_approach · [PHv-]
- **BE    ** L |  +5.72% | MFE +0.00% / MAE +0.00% | exit: `peak_lock_ema12_deep_break` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRANSITIONAL · PDZ=premium · [PHv-]
- **KTOS  ** L |  +5.66% | MFE +0.00% / MAE +0.00% | exit: `peak_lock_ema12_deep_break` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRENDING · PDZ=premium

## 3 · The Disappointed (worst losers)

Each one of these is a calibration question: was the entry the issue, the management, or the regime?
If the same `setup × personality × regime × side` shows up in 3+ disappointed trades, the next
calibration should raise the bar for that combo.

- **AA    ** L |  -4.05% | MFE +0.00% / MAE +0.00% | exit: `doctrine_force_exit` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRENDING · PDZ=premium_approach
- **FIX   ** L |  -3.28% | MFE +0.00% / MAE +0.00% | exit: `max_loss_time_scaled_momentum_buffered` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRENDING · PDZ=premium · [PHv-]
- **BWXT  ** L |  -2.94% | MFE +0.00% / MAE +0.00% | exit: `thesis_flip_htf` | TT Tt Gap Reversal Long · ? · ? · PDZ=?
- **MDB   ** L |  -2.66% | MFE +0.00% / MAE +0.00% | exit: `SMART_RUNNER_SUPPORT_BREAK_CLOUD` | TT Tt Gap Reversal Long · ? · ? · PDZ=?
- **NVDA  ** L |  -1.90% | MFE +0.00% / MAE +0.00% | exit: `doctrine_force_exit` | TT Tt N Test Support · VOLATILE_RUNNER · TRANSITIONAL · PDZ=premium_approach · [PHv-]

## 4 · Profit giveback (MFE ≥ 1% closed flat-or-worse)

**0 trade(s).** This is the bucket Loop 1's MFE peak-lock targets directly.
If this list is long, the calibration question is: should peak-lock fire earlier?

_None._ Engine is locking gains well this month.

## 5 · Re-entry chains (tickers traded ≥ 3x)

Negative chains are the engine repeatedly being wrong about the same name.
If a chain is net negative AND we never paused, Loop 2's circuit breaker missed it.

- **KLAC** — 3 trades, 2W/1L, **net +5.26%** 🟢
- **SPY** — 3 trades, 1W/2L, **net -1.12%** 🔴
- **DIA** — 3 trades, 1W/2L, **net -1.99%** 🔴
- **GOOGL** — 3 trades, 2W/0L, **net +5.06%** 🟢
- **SATS** — 3 trades, 1W/2L, **net +1.06%** 🟢
- **APLD** — 3 trades, 1W/2L, **net +0.35%** 🟢

## 6 · Setup performance

Bottom-quartile setups by win-rate AND volume are candidates for the next calibration to guard-rail.

| Setup | N | WR | Avg | Net |
|---|---:|---:|---:|---:|
| `TT Tt Gap Reversal Long` | 57 | 63% | +1.55% | +88.07% |
| `TT Tt N Test Support` | 12 | 33% | +0.14% | +1.69% |
| `TT Tt Reclaim` | 1 | 100% | +0.85% | +0.85% |
| `TT Tt Pullback` | 4 | 25% | -0.84% | -3.37% |

## 7 · Personality × Setup (combos with 2+ trades)

Worst-WR combos at top — these are the immediate Loop 1 candidates.

| Personality | Setup | N | WR | Net |
|---|---|---:|---:|---:|
| PULLBACK_PLAYER | `TT Tt Pullback` | 2 | 0% | -2.37% |
| VOLATILE_RUNNER | `TT Tt N Test Support` | 3 | 33% | +0.17% |
| SLOW_GRINDER | `TT Tt N Test Support` | 6 | 33% | -3.11% |
| VOLATILE_RUNNER | `TT Tt Pullback` | 2 | 50% | -0.99% |
| PULLBACK_PLAYER | `TT Tt N Test Support` | 2 | 50% | +4.66% |
| ? | `TT Tt Gap Reversal Long` | 5 | 60% | -2.83% |
| VOLATILE_RUNNER | `TT Tt Gap Reversal Long` | 38 | 63% | +70.27% |
| PULLBACK_PLAYER | `TT Tt Gap Reversal Long` | 14 | 64% | +20.63% |

## 8 · Loop firing log

Phase C self-adapting loops. Empty for any backtest run before the loops were enabled.

- **Loop 2** — `block`: 369 times
- **Loop 3** — `flat_cut`: 228 times

**Loop 1 scorecard snapshot** (end-of-month, min_samples=3):
- 🔴 BLOCK (6 combos): `tt_n_test_support:transitional:pullback_player:L` (0W/4L), `momentum_score:trending:pullback_player:L` (0W/8L), `tt_n_test_support:trending:moderate:L` (0W/3L), `tt_n_test_support:trending:volatile_runner:L` (1W/5L), `tt_pullback:trending:moderate:L` (1W/4L), `tt_n_test_support:transitional:volatile_runner:L` (1W/3L)
- 🟡 RAISE_BAR (10 combos): `tt_n_test_support:trending:pullback_player:L` (2W/4L), `tt_ath_breakout:trending:pullback_player:L` (5W/10L), `tt_n_test_resistance:transitional:pullback_player:S` (1W/2L), `tt_gap_reversal_short:trending:volatile_runner:S` (1W/2L), `tt_pullback:trending:pullback_player:L` (4W/6L), `tt_ath_breakout:trending:slow_grinder:L` (4W/6L), `tt_n_test_support:transitional:moderate:L` (2W/3L), `tt_pullback:transitional:volatile_runner:L` (3W/4L), `tt_pullback:trending:volatile_runner:L` (4W/5L), `tt_range_reversal_long:trending:pullback_player:L` (4W/5L)
- 🟢 ALLOW (>0.45 WR): 15 combos

## 9 · Calibration notes (fill in by hand after reviewing above)

_Proposed flag deltas for the next month, with one-line justification each._

- [ ] (no change) — engine looks calibrated for this regime
- [ ] _Or list specific flag deltas. e.g.:_
      `deep_audit_mfe_peak_lock_retrace_pct: 50 → 40` because profit giveback list is long.

After deciding, edit `scripts/v15-activate.sh`, commit with message
`phase-c: 2026-01 calibration` and resume the next month.
