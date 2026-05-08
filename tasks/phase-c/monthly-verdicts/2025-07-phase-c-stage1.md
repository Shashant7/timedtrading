# Phase C — Monthly Verdict · 2025-07

_Source: `phase-c-stage1-jul2025-may2026` · Trades in window: **98** · Generated 2026-05-04 22:04 UTC_

> Read this alongside the previous month's verdict. The point is **trajectory** —
> are we drifting toward July or away from it?

## 1 · Headline

- **89 closed trades.** 52W / 37L / 0 flat.
- **Win rate: 58.4%.** Target 55% — PASS.
- **Avg winner / Avg loser: 2.67x** (3.08% / 1.15%). Target 1.60x — PASS.
- **Max drawdown (cum %): 5.77%.** Target ≤ 3.0% — MISS.
- **Sharpe (annualized, daily-pct proxy): 4.15.** Target 1.50 — PASS.
- **Cumulative P&L (sum of pct): +117.64%.**

### Account equity (start $100,000 reference, ~$10,203 avg notional/trade)

_Each trade uses its actual recorded P&L (`trade.pnl` field) — not derived from %._

| Metric | Value |
|---|---|
| **Start balance** (entering this month) | **$100,000** |
| **End balance** (after last trade closed) | **$112,083** |
| **Net $ P&L for the month** | **$+12,083**  (+12.08% of start balance) |
| Sum of winning $ | +$16,535  (52 wins) |
| Sum of losing $ | -$4,452  (37 losses) |
| Biggest winner | **JOBY** +$5,097 (+42.52%) |
| Biggest loser | **INTC** -$425 (-3.54%) |
| Run-to-date peak | $112,153 (on 2025-07-31) |
| Run-to-date max DD | -$761 (0.71%) (trough on 2025-07-22) |

### Day-by-day P&L (this month)

| Date | # Trades | Day P&L $ | End-of-day Balance |
|---|---:|---:|---:|
| 2025-07-02 | 3 | $-681 🔴 | $99,319 |
| 2025-07-03 | 2 | $+402 🟢 | $99,722 |
| 2025-07-07 | 3 | $+85 🟢 | $99,807 |
| 2025-07-08 | 6 | $-291 🔴 | $99,516 |
| 2025-07-09 | 1 | $-46 🔴 | $99,470 |
| 2025-07-10 | 5 | $+74 🟢 | $99,544 |
| 2025-07-11 | 2 | $+676 🟢 | $100,220 |
| 2025-07-14 | 6 | $+691 🟢 | $100,911 |
| 2025-07-15 | 6 | $+226 🟢 | $101,137 |
| 2025-07-16 | 8 | $+5,324 🟢 | $106,461 |
| 2025-07-17 | 1 | $-19 🔴 | $106,442 |
| 2025-07-18 | 4 | $+8 🟢 | $106,450 |
| 2025-07-21 | 1 | $-45 🔴 | $106,405 |
| 2025-07-22 | 11 | $+301 🟢 | $106,706 |
| 2025-07-23 | 2 | $+388 🟢 | $107,095 |
| 2025-07-24 | 4 | $+403 🟢 | $107,498 |
| 2025-07-25 | 4 | $+822 🟢 | $108,320 |
| 2025-07-28 | 9 | $+2,746 🟢 | $111,065 |
| 2025-07-29 | 9 | $+528 🟢 | $111,593 |
| 2025-07-31 | 2 | $+489 🟢 | $112,083 |

## 2 · The Proud (top winners)

What these have in common — pattern-match on setup, personality, regime, PDZ. If the next month
has fewer trades that look like this, the engine has drifted.

- **JOBY  ** L | +42.52% | MFE +0.00% / MAE +0.00% | exit: `HARD_FUSE_RSI_EXTREME` | TT Tt Gap Reversal Long · ? · ? · PDZ=?
- **AMD   ** L | +10.04% | MFE +0.00% / MAE +0.00% | exit: `HARD_FUSE_RSI_EXTREME` | TT Tt Gap Reversal Long · ? · ? · PDZ=?
- **CARR  ** L |  +8.43% | MFE +0.00% / MAE +0.00% | exit: `TP_FULL` | TT Tt Gap Reversal Long · ? · ? · PDZ=?
- **AGQ   ** L |  +7.46% | MFE +0.00% / MAE +0.00% | exit: `sl_breached` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRENDING · PDZ=premium · [PHv-]
- **AMD   ** L |  +7.40% | MFE +0.00% / MAE +0.00% | exit: `sl_breached` | TT Tt Range Reversal Long · VOLATILE_RUNNER · TRANSITIONAL · PDZ=premium_approach · [PHv-]

## 3 · The Disappointed (worst losers)

Each one of these is a calibration question: was the entry the issue, the management, or the regime?
If the same `setup × personality × regime × side` shows up in 3+ disappointed trades, the next
calibration should raise the bar for that combo.

- **INTC  ** L |  -3.54% | MFE +0.00% / MAE +0.00% | exit: `max_loss` | TT Tt Gap Reversal Long · ? · ? · PDZ=?
- **IBP   ** L |  -3.04% | MFE +0.00% / MAE +0.00% | exit: `max_loss` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRANSITIONAL · PDZ=premium · [PHv-]
- **CVNA  ** L |  -3.03% | MFE +0.00% / MAE +0.00% | exit: `max_loss_time_scaled` | TT Tt N Test Support · VOLATILE_RUNNER · TRENDING · PDZ=premium_approach
- **CSX   ** L |  -2.75% | MFE +0.00% / MAE +0.00% | exit: `max_loss_time_scaled` | TT Tt Pullback · PULLBACK_PLAYER · TRENDING · PDZ=premium_approach · [RSIv-|PHv-]
- **APP   ** L |  -2.52% | MFE +0.00% / MAE +0.00% | exit: `thesis_flip_htf` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · CHOPPY · PDZ=premium_approach

## 4 · Profit giveback (MFE ≥ 1% closed flat-or-worse)

**0 trade(s).** This is the bucket Loop 1's MFE peak-lock targets directly.
If this list is long, the calibration question is: should peak-lock fire earlier?

_None._ Engine is locking gains well this month.

## 5 · Re-entry chains (tickers traded ≥ 3x)

Negative chains are the engine repeatedly being wrong about the same name.
If a chain is net negative AND we never paused, Loop 2's circuit breaker missed it.

- **SPY** — 3 trades, 1W/2L, **net +0.09%** 🟢
- **AVGO** — 3 trades, 1W/2L, **net -2.21%** 🔴
- **ANET** — 3 trades, 1W/2L, **net -1.07%** 🔴
- **BA** — 3 trades, 0W/3L, **net -2.19%** 🔴
- **CLS** — 3 trades, 1W/2L, **net -2.25%** 🔴

## 6 · Setup performance

Bottom-quartile setups by win-rate AND volume are candidates for the next calibration to guard-rail.

| Setup | N | WR | Avg | Net |
|---|---:|---:|---:|---:|
| `TT Tt Gap Reversal Long` | 50 | 66% | +2.24% | +112.14% |
| `TT Tt Range Reversal Long` | 5 | 60% | +1.33% | +6.63% |
| `TT Tt Pullback` | 14 | 50% | +0.15% | +2.05% |
| `TT Tt Gap Reversal Short` | 1 | 100% | +1.98% | +1.98% |
| `TT Tt Ath Breakout` | 12 | 42% | -0.16% | -1.87% |
| `TT Tt N Test Support` | 7 | 43% | -0.47% | -3.28% |

## 7 · Personality × Setup (combos with 2+ trades)

Worst-WR combos at top — these are the immediate Loop 1 candidates.

| Personality | Setup | N | WR | Net |
|---|---|---:|---:|---:|
| VOLATILE_RUNNER | `TT Tt Pullback` | 2 | 0% | -1.28% |
| SLOW_GRINDER | `TT Tt Ath Breakout` | 2 | 0% | -1.00% |
| PULLBACK_PLAYER | `TT Tt N Test Support` | 3 | 33% | -1.04% |
| PULLBACK_PLAYER | `TT Tt Pullback` | 6 | 33% | -1.70% |
| VOLATILE_RUNNER | `TT Tt Ath Breakout` | 3 | 33% | -3.34% |
| VOLATILE_RUNNER | `TT Tt N Test Support` | 3 | 33% | -2.96% |
| PULLBACK_PLAYER | `TT Tt Ath Breakout` | 6 | 50% | +1.06% |
| PULLBACK_PLAYER | `TT Tt Range Reversal Long` | 2 | 50% | -0.77% |
| VOLATILE_RUNNER | `TT Tt Gap Reversal Long` | 26 | 54% | +23.68% |
| ? | `TT Tt Gap Reversal Long` | 15 | 73% | +74.18% |
| ? | `TT Tt Pullback` | 4 | 75% | +3.19% |
| PULLBACK_PLAYER | `TT Tt Gap Reversal Long` | 5 | 80% | +4.44% |
| MODERATE | `TT Tt Gap Reversal Long` | 4 | 100% | +9.84% |
| VOLATILE_RUNNER | `TT Tt Range Reversal Long` | 2 | 100% | +7.75% |

## 8 · Loop firing log

Phase C self-adapting loops. Empty for any backtest run before the loops were enabled.

- **Loop 3** — `flat_cut`: 372 times

**Loop 1 scorecard snapshot** (end-of-month, min_samples=3):
- 🔴 BLOCK (1 combos): `tt_gap_reversal_long:transitional:volatile_runner:L` (1W/4L)
- 🟡 RAISE_BAR (3 combos): `tt_pullback:trending:volatile_runner:L` (1W/2L), `tt_ath_breakout:trending:volatile_runner:L` (1W/2L), `tt_pullback:trending:pullback_player:L` (3W/4L)
- 🟢 ALLOW (>0.45 WR): 4 combos

## 9 · Calibration notes (fill in by hand after reviewing above)

_Proposed flag deltas for the next month, with one-line justification each._

- [ ] (no change) — engine looks calibrated for this regime
- [ ] _Or list specific flag deltas. e.g.:_
      `deep_audit_mfe_peak_lock_retrace_pct: 50 → 40` because profit giveback list is long.

After deciding, edit `scripts/v15-activate.sh`, commit with message
`phase-c: 2025-07 calibration` and resume the next month.
