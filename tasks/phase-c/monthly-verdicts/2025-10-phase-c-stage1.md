# Phase C — Monthly Verdict · 2025-10

_Source: `phase-c-stage1-jul2025-may2026` · Trades in window: **45** · Generated 2026-05-04 03:30 UTC_

> Read this alongside the previous month's verdict. The point is **trajectory** —
> are we drifting toward July or away from it?

## 1 · Headline

- **44 closed trades.** 15W / 29L / 0 flat.
- **Win rate: 34.1%.** Target 55% — MISS.
- **Avg winner / Avg loser: 1.98x** (3.32% / 1.68%). Target 1.60x — PASS.
- **Max drawdown (cum %): 24.44%.** Target ≤ 3.0% — MISS.
- **Sharpe (annualized, daily-pct proxy): 0.11.** Target 1.50 — MISS.
- **Cumulative P&L (sum of pct): +1.11%.**

### Account equity (start $100,000 reference, ~$9,749 avg notional/trade)

_Each trade uses its actual recorded P&L (`trade.pnl` field) — not derived from %._

| Metric | Value |
|---|---|
| **Start balance** (entering this month) | **$116,564** |
| **End balance** (after last trade closed) | **$119,126** |
| **Net $ P&L for the month** | **$+2,562**  (+2.20% of start balance) |
| Sum of winning $ | +$4,527  (15 wins) |
| Sum of losing $ | -$4,720  (29 losses) |
| Biggest winner | **BE** +$1,055 (+7.37%) |
| Biggest loser | **BE** -$749 (-9.23%) |
| Run-to-date peak | $119,607 (on 2025-10-17) |
| Run-to-date max DD | -$1,935 (1.74%) (trough on 2025-09-02) |

### Day-by-day P&L (this month)

| Date | # Trades | Day P&L $ | End-of-day Balance |
|---|---:|---:|---:|
| 2025-10-01 | 1 | $-319 🔴 | $116,245 |
| 2025-10-02 | 1 | $+14 🟢 | $116,259 |
| 2025-10-07 | 6 | $-487 🔴 | $115,772 |
| 2025-10-08 | 1 | $-329 🔴 | $115,443 |
| 2025-10-09 | 2 | $-121 🔴 | $115,321 |
| 2025-10-10 | 2 | $+126 🟢 | $115,447 |
| 2025-10-14 | 4 | $-144 🔴 | $115,303 |
| 2025-10-15 | 3 | $-550 🔴 | $114,753 |
| 2025-10-16 | 2 | $+798 🟢 | $115,551 |
| 2025-10-17 | 6 | $+853 🟢 | $116,404 |
| 2025-10-21 | 4 | $-552 🔴 | $115,852 |
| 2025-10-22 | 3 | $-42 🔴 | $115,810 |
| 2025-10-24 | 1 | $-445 🔴 | $115,365 |
| 2025-10-27 | 1 | $+451 🟢 | $115,816 |
| 2025-10-28 | 1 | $+94 🟢 | $115,910 |
| 2025-10-29 | 3 | $-450 🔴 | $115,461 |
| 2025-10-30 | 1 | $-100 🔴 | $115,361 |
| 2025-10-31 | 2 | $+1,009 🟢 | $116,370 |

## 2 · The Proud (top winners)

What these have in common — pattern-match on setup, personality, regime, PDZ. If the next month
has fewer trades that look like this, the engine has drifted.

- **GLXY  ** L | +12.50% | MFE +0.00% / MAE +0.00% | exit: `peak_lock_ema12_deep_break` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRANSITIONAL · PDZ=premium
- **AVAV  ** L |  +9.44% | MFE +0.00% / MAE +0.00% | exit: `atr_week_618_full_exit` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRENDING · PDZ=premium · [PHv-]
- **BE    ** L |  +7.37% | MFE +0.00% / MAE +0.00% | exit: `mfe_decay_structural_flatten` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRENDING · PDZ=premium_approach · [PHv-]
- **AA    ** L |  +4.24% | MFE +0.00% / MAE +0.00% | exit: `ST_FLIP_4H_CLOSE` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · CHOPPY · PDZ=premium_approach
- **ALB   ** L |  +3.79% | MFE +0.00% / MAE +0.00% | exit: `peak_lock_ema12_deep_break` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRANSITIONAL · PDZ=premium_approach · [PHv-]

## 3 · The Disappointed (worst losers)

Each one of these is a calibration question: was the entry the issue, the management, or the regime?
If the same `setup × personality × regime × side` shows up in 3+ disappointed trades, the next
calibration should raise the bar for that combo.

- **BE    ** L |  -9.23% | MFE +0.00% / MAE +0.00% | exit: `HARD_LOSS_CAP` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRENDING · PDZ=premium_approach · [PHv-]
- **AA    ** L |  -6.14% | MFE +0.00% / MAE +0.00% | exit: `v13_hard_pnl_floor` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRENDING · PDZ=premium_approach · [RSIv-|PHv-]
- **JOBY  ** L |  -3.49% | MFE +0.00% / MAE +0.00% | exit: `HARD_LOSS_CAP` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRENDING · PDZ=premium
- **GOOGL ** L |  -3.29% | MFE +0.00% / MAE +0.00% | exit: `max_loss` | TT Tt Ath Breakout · PULLBACK_PLAYER · CHOPPY · PDZ=premium
- **JOBY  ** L |  -3.22% | MFE +0.00% / MAE +0.00% | exit: `max_loss` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRANSITIONAL · PDZ=premium_approach

## 4 · Profit giveback (MFE ≥ 1% closed flat-or-worse)

**0 trade(s).** This is the bucket Loop 1's MFE peak-lock targets directly.
If this list is long, the calibration question is: should peak-lock fire earlier?

_None._ Engine is locking gains well this month.

## 5 · Re-entry chains (tickers traded ≥ 3x)

Negative chains are the engine repeatedly being wrong about the same name.
If a chain is net negative AND we never paused, Loop 2's circuit breaker missed it.

- **AA** — 4 trades, 1W/3L, **net -5.09%** 🔴
- **BE** — 3 trades, 2W/1L, **net -1.60%** 🔴

## 6 · Setup performance

Bottom-quartile setups by win-rate AND volume are candidates for the next calibration to guard-rail.

| Setup | N | WR | Avg | Net |
|---|---:|---:|---:|---:|
| `TT Tt Gap Reversal Long` | 32 | 47% | +0.55% | +17.48% |
| `TT Tt Range Reversal Long` | 1 | 0% | -0.29% | -0.29% |
| `TT Tt Gap Reversal Short` | 1 | 0% | -0.79% | -0.79% |
| `TT Tt Atl Breakdown` | 1 | 0% | -0.87% | -0.87% |
| `TT Tt Reclaim` | 1 | 0% | -0.93% | -0.93% |
| `TT Tt N Test Support` | 2 | 0% | -1.08% | -2.17% |
| `TT Tt N Test Resistance` | 1 | 0% | -2.25% | -2.25% |
| `TT Tt Pullback` | 2 | 0% | -1.63% | -3.27% |
| `TT Tt Ath Breakout` | 3 | 0% | -1.93% | -5.80% |

## 7 · Personality × Setup (combos with 2+ trades)

Worst-WR combos at top — these are the immediate Loop 1 candidates.

| Personality | Setup | N | WR | Net |
|---|---|---:|---:|---:|
| SLOW_GRINDER | `TT Tt N Test Support` | 2 | 0% | -2.17% |
| MODERATE | `TT Tt Ath Breakout` | 2 | 0% | -2.51% |
| VOLATILE_RUNNER | `TT Tt Gap Reversal Long` | 29 | 45% | +15.69% |
| PULLBACK_PLAYER | `TT Tt Gap Reversal Long` | 3 | 67% | +1.80% |

## 8 · Loop firing log

Phase C self-adapting loops. Empty for any backtest run before the loops were enabled.

- **Loop 2** — `block`: 296 times
- **Loop 3** — `flat_cut`: 140 times

**Loop 1 scorecard snapshot** (end-of-month, min_samples=3):
- 🔴 BLOCK (2 combos): `tt_n_test_support:trending:volatile_runner:L` (0W/4L), `tt_ath_breakout:trending:pullback_player:L` (3W/8L)
- 🟡 RAISE_BAR (7 combos): `tt_range_reversal_long:trending:volatile_runner:L` (1W/2L), `tt_pullback:trending:moderate:L` (1W/2L), `tt_range_reversal_long:transitional:volatile_runner:L` (1W/2L), `tt_pullback:trending:pullback_player:L` (2W/3L), `tt_ath_breakout:trending:slow_grinder:L` (2W/3L), `tt_gap_reversal_long:trending:volatile_runner:L` (9W/11L), `tt_gap_reversal_long:trending:pullback_player:L` (9W/11L)
- 🟢 ALLOW (>0.45 WR): 9 combos

## 9 · Calibration notes (fill in by hand after reviewing above)

_Proposed flag deltas for the next month, with one-line justification each._

- [ ] (no change) — engine looks calibrated for this regime
- [ ] _Or list specific flag deltas. e.g.:_
      `deep_audit_mfe_peak_lock_retrace_pct: 50 → 40` because profit giveback list is long.

After deciding, edit `scripts/v15-activate.sh`, commit with message
`phase-c: 2025-10 calibration` and resume the next month.
