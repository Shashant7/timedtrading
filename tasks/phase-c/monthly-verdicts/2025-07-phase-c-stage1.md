# Phase C — Monthly Verdict · 2025-07

_Source: `phase-c-stage1-jul2025-may2026` · Trades in window: **100** · Generated 2026-05-03 04:28 UTC_

> Read this alongside the previous month's verdict. The point is **trajectory** —
> are we drifting toward July or away from it?

## 1 · Headline

- **91 closed trades.** 50W / 41L / 0 flat.
- **Win rate: 54.9%.** Target 55% — MISS.
- **Avg winner / Avg loser: 2.31x** (2.74% / 1.19%). Target 1.60x — PASS.
- **Max drawdown (cum %): 7.18%.** Target ≤ 3.0% — MISS.
- **Sharpe (annualized, daily-pct proxy): 4.45.** Target 1.50 — PASS.
- **Cumulative P&L (sum of pct): +88.48%.**

## 2 · The Proud (top winners)

What these have in common — pattern-match on setup, personality, regime, PDZ. If the next month
has fewer trades that look like this, the engine has drifted.

- **AEHR  ** L | +21.18% | MFE +0.00% / MAE +0.00% | exit: `atr_week_618_full_exit` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRENDING · PDZ=premium_approach
- **U     ** L | +12.50% | MFE +0.00% / MAE +0.00% | exit: `sl_breached` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRENDING · PDZ=premium_approach
- **JOBY  ** L | +12.37% | MFE +0.00% / MAE +0.00% | exit: `TP_FULL` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRENDING · PDZ=premium_approach · [RSIv-]
- **IREN  ** L | +10.21% | MFE +0.00% / MAE +0.00% | exit: `sl_breached` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRENDING · PDZ=premium_approach · [PHv-]
- **TPL   ** S |  +6.51% | MFE +0.00% / MAE +0.00% | exit: `ST_FLIP_4H_CLOSE` | TT Tt Gap Reversal Short · VOLATILE_RUNNER · TRENDING · PDZ=discount_approach

## 3 · The Disappointed (worst losers)

Each one of these is a calibration question: was the entry the issue, the management, or the regime?
If the same `setup × personality × regime × side` shows up in 3+ disappointed trades, the next
calibration should raise the bar for that combo.

- **MDB   ** L |  -4.01% | MFE +0.00% / MAE +0.00% | exit: `max_loss` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRANSITIONAL · PDZ=premium_approach
- **INTC  ** L |  -3.23% | MFE +0.00% / MAE +0.00% | exit: `max_loss` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRENDING · PDZ=premium_approach
- **CSX   ** L |  -2.75% | MFE +0.00% / MAE +0.00% | exit: `phase_i_mfe_cut_4h` | TT Tt Pullback · PULLBACK_PLAYER · TRENDING · PDZ=premium_approach · [RSIv-|PHv-]
- **APP   ** L |  -2.52% | MFE +0.00% / MAE +0.00% | exit: `max_loss` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · CHOPPY · PDZ=premium_approach
- **MTZ   ** L |  -2.34% | MFE +0.00% / MAE +0.00% | exit: `max_loss_time_scaled` | TT Tt Ath Breakout · VOLATILE_RUNNER · TRENDING · PDZ=premium_approach · [PHv-]

## 4 · Profit giveback (MFE ≥ 1% closed flat-or-worse)

**0 trade(s).** This is the bucket Loop 1's MFE peak-lock targets directly.
If this list is long, the calibration question is: should peak-lock fire earlier?

_None._ Engine is locking gains well this month.

## 5 · Re-entry chains (tickers traded ≥ 3x)

Negative chains are the engine repeatedly being wrong about the same name.
If a chain is net negative AND we never paused, Loop 2's circuit breaker missed it.

- **SPY** — 3 trades, 2W/0L, **net +1.92%** 🟢
- **AA** — 3 trades, 2W/1L, **net +2.11%** 🟢
- **AWI** — 3 trades, 2W/1L, **net +0.01%** 🟢
- **GE** — 3 trades, 1W/1L, **net +0.56%** 🟢
- **AVGO** — 3 trades, 0W/2L, **net -2.16%** 🔴

## 6 · Setup performance

Bottom-quartile setups by win-rate AND volume are candidates for the next calibration to guard-rail.

| Setup | N | WR | Avg | Net |
|---|---:|---:|---:|---:|
| `TT Tt Gap Reversal Long` | 47 | 66% | +1.76% | +82.74% |
| `TT Tt Gap Reversal Short` | 3 | 100% | +3.16% | +9.48% |
| `TT Tt N Test Support` | 11 | 45% | +0.34% | +3.77% |
| `TT Tt Pullback` | 14 | 36% | +0.04% | +0.54% |
| `TT Tt N Test Resistance` | 1 | 0% | -1.19% | -1.19% |
| `TT Tt Range Reversal Long` | 6 | 33% | -0.37% | -2.24% |
| `TT Tt Ath Breakout` | 9 | 44% | -0.51% | -4.62% |

## 7 · Personality × Setup (combos with 2+ trades)

Worst-WR combos at top — these are the immediate Loop 1 candidates.

| Personality | Setup | N | WR | Net |
|---|---|---:|---:|---:|
| VOLATILE_RUNNER | `TT Tt Pullback` | 4 | 0% | -4.18% |
| VOLATILE_RUNNER | `TT Tt Ath Breakout` | 2 | 0% | -3.79% |
| PULLBACK_PLAYER | `TT Tt Range Reversal Long` | 3 | 0% | -1.98% |
| VOLATILE_RUNNER | `TT Tt N Test Support` | 3 | 33% | -1.00% |
| PULLBACK_PLAYER | `TT Tt Pullback` | 8 | 38% | +2.89% |
| PULLBACK_PLAYER | `TT Tt Ath Breakout` | 6 | 50% | -1.66% |
| SLOW_GRINDER | `TT Tt N Test Support` | 2 | 50% | +0.15% |
| MODERATE | `TT Tt Range Reversal Long` | 2 | 50% | -0.61% |
| PULLBACK_PLAYER | `TT Tt N Test Support` | 5 | 60% | +5.85% |
| VOLATILE_RUNNER | `TT Tt Gap Reversal Long` | 33 | 61% | +65.40% |
| PULLBACK_PLAYER | `TT Tt Gap Reversal Long` | 10 | 70% | +7.50% |
| MODERATE | `TT Tt Gap Reversal Long` | 4 | 100% | +9.84% |
| VOLATILE_RUNNER | `TT Tt Gap Reversal Short` | 2 | 100% | +7.50% |

## 8 · Loop firing log

Phase C self-adapting loops. Empty for any backtest run before the loops were enabled.

- **Loop 3** — `flat_cut`: 550 times

## 9 · Calibration notes (fill in by hand after reviewing above)

_Proposed flag deltas for the next month, with one-line justification each._

- [ ] (no change) — engine looks calibrated for this regime
- [ ] _Or list specific flag deltas. e.g.:_
      `deep_audit_mfe_peak_lock_retrace_pct: 50 → 40` because profit giveback list is long.

After deciding, edit `scripts/v15-activate.sh`, commit with message
`phase-c: 2025-07 calibration` and resume the next month.
