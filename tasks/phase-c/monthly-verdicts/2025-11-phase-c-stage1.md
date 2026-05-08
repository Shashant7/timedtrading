# Phase C — Monthly Verdict · 2025-11

_Source: `phase-c-stage1-jul2025-may2026` · Trades in window: **21** · Generated 2026-05-05 10:38 UTC_

> Read this alongside the previous month's verdict. The point is **trajectory** —
> are we drifting toward July or away from it?

## 1 · Headline

- **15 closed trades.** 7W / 8L / 0 flat.
- **Win rate: 46.7%.** Target 55% — MISS.
- **Avg winner / Avg loser: 1.42x** (1.97% / 1.38%). Target 1.60x — MISS.
- **Max drawdown (cum %): 8.17%.** Target ≤ 3.0% — MISS.
- **Sharpe (annualized, daily-pct proxy): 1.04.** Target 1.50 — MISS.
- **Cumulative P&L (sum of pct): +2.69%.**

### Account equity (start $100,000 reference, ~$11,679 avg notional/trade)

_Each trade uses its actual recorded P&L (`trade.pnl` field) — not derived from %._

| Metric | Value |
|---|---|
| **Start balance** (entering this month) | **$126,149** |
| **End balance** (after last trade closed) | **$125,800** |
| **Net $ P&L for the month** | **$-349**  (-0.28% of start balance) |
| Sum of winning $ | +$1,843  (7 wins) |
| Sum of losing $ | -$1,354  (8 losses) |
| Biggest winner | **AGQ** +$1,292 (+8.59%) |
| Biggest loser | **SNDK** -$543 (-4.92%) |
| Run-to-date peak | $127,246 (on 2025-10-08) |
| Run-to-date max DD | -$2,953 (2.32%) (trough on 2025-11-18) |

### Day-by-day P&L (this month)

| Date | # Trades | Day P&L $ | End-of-day Balance |
|---|---:|---:|---:|
| 2025-11-04 | 2 | $-286 🔴 | $125,863 |
| 2025-11-05 | 1 | $-17 🔴 | $125,846 |
| 2025-11-17 | 1 | $-543 🔴 | $125,302 |
| 2025-11-18 | 2 | $-96 🔴 | $125,207 |
| 2025-11-20 | 3 | $+280 🟢 | $125,487 |
| 2025-11-21 | 3 | $-33 🔴 | $125,454 |
| 2025-11-28 | 3 | $+1,184 🟢 | $126,638 |

## 2 · The Proud (top winners)

What these have in common — pattern-match on setup, personality, regime, PDZ. If the next month
has fewer trades that look like this, the engine has drifted.

- **AGQ   ** L |  +8.59% | MFE +0.00% / MAE +0.00% | exit: `HARD_FUSE_RSI_EXTREME` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRENDING · PDZ=premium_approach · [PHv-]
- **SWK   ** S |  +1.92% | MFE +0.00% / MAE +0.00% | exit: `mfe_decay_structural_flatten` | TT Tt Gap Reversal Short · VOLATILE_RUNNER · TRENDING · PDZ=discount
- **COST  ** S |  +1.20% | MFE +0.00% / MAE +0.00% | exit: `PROFIT_GIVEBACK_STAGE_HOLD` | TT Tt Gap Reversal Short · MODERATE · TRENDING · PDZ=discount
- **BE    ** L |  +0.76% | MFE +0.00% / MAE +0.00% | exit: `PROFIT_GIVEBACK_STAGE_HOLD` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRENDING · PDZ=premium_approach
- **GOOGL ** L |  +0.60% | MFE +0.00% / MAE +0.00% | exit: `PROFIT_GIVEBACK_STAGE_HOLD` | TT Tt Gap Reversal Long · PULLBACK_PLAYER · TRENDING · PDZ=premium · [RSIv-|PHv-]

## 3 · The Disappointed (worst losers)

Each one of these is a calibration question: was the entry the issue, the management, or the regime?
If the same `setup × personality × regime × side` shows up in 3+ disappointed trades, the next
calibration should raise the bar for that combo.

- **SNDK  ** L |  -4.92% | MFE +0.00% / MAE +0.00% | exit: `HARD_LOSS_CAP` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRENDING · PDZ=premium_approach · [PHv-]
- **CW    ** L |  -2.45% | MFE +0.00% / MAE +0.00% | exit: `doctrine_force_exit` | TT Tt Ath Breakout · PULLBACK_PLAYER · TRENDING · PDZ=premium_approach
- **AGYS  ** L |  -1.52% | MFE +0.00% / MAE +0.00% | exit: `doctrine_force_exit` | TT Tt N Test Support · VOLATILE_RUNNER · CHOPPY · PDZ=discount_approach · [PHv-]
- **IBB   ** L |  -1.14% | MFE +0.00% / MAE +0.00% | exit: `doctrine_force_exit` | TT Tt Ath Breakout · ? · TRENDING · PDZ=premium_approach
- **ABT   ** S |  -0.39% | MFE +0.00% / MAE +0.00% | exit: `max_loss_time_scaled` | TT Tt N Test Resistance · MODERATE · CHOPPY · PDZ=discount_approach · [PHv-]

## 4 · Profit giveback (MFE ≥ 1% closed flat-or-worse)

**0 trade(s).** This is the bucket Loop 1's MFE peak-lock targets directly.
If this list is long, the calibration question is: should peak-lock fire earlier?

_None._ Engine is locking gains well this month.

## 5 · Re-entry chains (tickers traded ≥ 3x)

Negative chains are the engine repeatedly being wrong about the same name.
If a chain is net negative AND we never paused, Loop 2's circuit breaker missed it.

_No chains of 3+ trades on a single ticker this month._

## 6 · Setup performance

Bottom-quartile setups by win-rate AND volume are candidates for the next calibration to guard-rail.

| Setup | N | WR | Avg | Net |
|---|---:|---:|---:|---:|
| `TT Tt Gap Reversal Long` | 7 | 57% | +0.73% | +5.08% |
| `TT Tt Gap Reversal Short` | 2 | 100% | +1.56% | +3.13% |
| `TT Tt Atl Breakdown` | 1 | 0% | -0.11% | -0.11% |
| `TT Tt N Test Resistance` | 2 | 50% | -0.14% | -0.28% |
| `TT Tt N Test Support` | 1 | 0% | -1.52% | -1.52% |
| `TT Tt Ath Breakout` | 2 | 0% | -1.80% | -3.60% |

## 7 · Personality × Setup (combos with 2+ trades)

Worst-WR combos at top — these are the immediate Loop 1 candidates.

| Personality | Setup | N | WR | Net |
|---|---|---:|---:|---:|
| PULLBACK_PLAYER | `TT Tt Gap Reversal Long` | 3 | 33% | +0.08% |
| VOLATILE_RUNNER | `TT Tt Gap Reversal Long` | 4 | 75% | +5.00% |

## 8 · Loop firing log

Phase C self-adapting loops. Empty for any backtest run before the loops were enabled.

- **Loop 2** — `block`: 118 times
- **Loop 3** — `flat_cut`: 38 times

**Loop 1 scorecard snapshot** (end-of-month, min_samples=3):
- 🔴 BLOCK (4 combos): `tt_n_test_support:trending:volatile_runner:L` (0W/5L), `momentum_score:trending:pullback_player:L` (0W/8L), `tt_ath_breakout:trending:pullback_player:L` (3W/9L), `tt_pullback:trending:moderate:L` (1W/3L)
- 🟡 RAISE_BAR (7 combos): `tt_n_test_support:choppy:slow_grinder:L` (1W/2L), `tt_range_reversal_long:trending:pullback_player:L` (3W/5L), `tt_ath_breakout:trending:slow_grinder:L` (3W/5L), `tt_n_test_support:trending:pullback_player:L` (2W/3L), `tt_gap_reversal_long:trending:pullback_player:L` (8W/12L), `tt_pullback:trending:pullback_player:L` (4W/5L), `tt_gap_reversal_long:trending:volatile_runner:L` (9W/11L)
- 🟢 ALLOW (>0.45 WR): 11 combos

## 9 · Calibration notes (fill in by hand after reviewing above)

_Proposed flag deltas for the next month, with one-line justification each._

- [ ] (no change) — engine looks calibrated for this regime
- [ ] _Or list specific flag deltas. e.g.:_
      `deep_audit_mfe_peak_lock_retrace_pct: 50 → 40` because profit giveback list is long.

After deciding, edit `scripts/v15-activate.sh`, commit with message
`phase-c: 2025-11 calibration` and resume the next month.
