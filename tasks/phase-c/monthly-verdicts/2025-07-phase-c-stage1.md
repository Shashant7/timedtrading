# Phase C — Monthly Verdict · 2025-07

_Source: `phase-c-stage1-jul2025-may2026` · Trades in window: **103** · Generated 2026-05-03 12:22 UTC_

> Read this alongside the previous month's verdict. The point is **trajectory** —
> are we drifting toward July or away from it?

## 1 · Headline

- **102 closed trades.** 56W / 46L / 0 flat.
- **Win rate: 54.9%.** Target 55% — MISS.
- **Avg winner / Avg loser: 2.12x** (2.81% / 1.32%). Target 1.60x — PASS.
- **Max drawdown (cum %): 12.55%.** Target ≤ 3.0% — MISS.
- **Sharpe (annualized, daily-pct proxy): 4.32.** Target 1.50 — PASS.
- **Cumulative P&L (sum of pct): +96.47%.**

### Account equity (start $100,000 reference, ~$10,104 avg notional/trade)

_Each trade uses its actual recorded P&L (`trade.pnl` field) — not derived from %._

| Metric | Value |
|---|---|
| **Start balance** (entering this month) | **$100,000** |
| **End balance** (after last trade closed) | **$110,306** |
| **Net $ P&L for the month** | **$+10,306**  (+10.31% of start balance) |
| Sum of winning $ | +$16,640  (56 wins) |
| Sum of losing $ | -$6,334  (46 losses) |
| Biggest winner | **AEHR** +$2,462 (+21.18%) |
| Biggest loser | **ORCL** -$621 (-5.17%) |
| Run-to-date peak | $113,047 (on 2025-08-19) |
| Run-to-date max DD | -$1,990 (1.76%) (trough on 2025-08-22) |

### Day-by-day P&L (this month)

| Date | # Trades | Day P&L $ | End-of-day Balance |
|---|---:|---:|---:|
| 2025-07-02 | 3 | $-752 🔴 | $99,248 |
| 2025-07-03 | 2 | $+371 🟢 | $99,618 |
| 2025-07-07 | 2 | $+99 🟢 | $99,718 |
| 2025-07-08 | 5 | $+87 🟢 | $99,805 |
| 2025-07-09 | 1 | $-46 🔴 | $99,759 |
| 2025-07-10 | 6 | $-946 🔴 | $98,813 |
| 2025-07-11 | 5 | $+981 🟢 | $99,794 |
| 2025-07-14 | 2 | $+433 🟢 | $100,227 |
| 2025-07-15 | 8 | $+2,941 🟢 | $103,168 |
| 2025-07-16 | 9 | $+178 🟢 | $103,346 |
| 2025-07-17 | 1 | $+119 🟢 | $103,465 |
| 2025-07-18 | 4 | $-34 🔴 | $103,431 |
| 2025-07-22 | 14 | $+993 🟢 | $104,424 |
| 2025-07-23 | 4 | $+1,122 🟢 | $105,546 |
| 2025-07-24 | 1 | $+11 🟢 | $105,558 |
| 2025-07-25 | 6 | $+1,060 🟢 | $106,618 |
| 2025-07-28 | 8 | $+2,920 🟢 | $109,538 |
| 2025-07-29 | 6 | $-248 🔴 | $109,290 |
| 2025-07-30 | 4 | $+137 🟢 | $109,428 |
| 2025-08-01 | 11 | $+878 🟢 | $110,306 |

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
