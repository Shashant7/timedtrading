# Phase C — Monthly Verdict · 2025-08

_Source: `phase-c-stage1-jul2025-may2026` · Trades in window: **82** · Generated 2026-05-03 23:09 UTC_

> Read this alongside the previous month's verdict. The point is **trajectory** —
> are we drifting toward July or away from it?

## 1 · Headline

- **67 closed trades.** 34W / 33L / 0 flat.
- **Win rate: 50.7%.** Target 55% — MISS.
- **Avg winner / Avg loser: 1.28x** (1.67% / 1.30%). Target 1.60x — MISS.
- **Max drawdown (cum %): 20.82%.** Target ≤ 3.0% — MISS.
- **Sharpe (annualized, daily-pct proxy): 1.50.** Target 1.50 — PASS.
- **Cumulative P&L (sum of pct): +13.74%.**

### Account equity (start $100,000 reference, ~$9,893 avg notional/trade)

_Each trade uses its actual recorded P&L (`trade.pnl` field) — not derived from %._

| Metric | Value |
|---|---|
| **Start balance** (entering this month) | **$109,442** |
| **End balance** (after last trade closed) | **$110,495** |
| **Net $ P&L for the month** | **$+1,053**  (+0.96% of start balance) |
| Sum of winning $ | +$4,883  (34 wins) |
| Sum of losing $ | -$4,346  (33 losses) |
| Biggest winner | **ETHA** +$843 (+9.53%) |
| Biggest loser | **LMND** -$390 (-4.71%) |
| Run-to-date peak | $111,394 (on 2025-08-19) |
| Run-to-date max DD | -$1,323 (1.19%) (trough on 2025-08-28) |

### Day-by-day P&L (this month)

| Date | # Trades | Day P&L $ | End-of-day Balance |
|---|---:|---:|---:|
| 2025-08-04 | 1 | $-111 🔴 | $109,331 |
| 2025-08-05 | 5 | $-167 🔴 | $109,164 |
| 2025-08-06 | 2 | $+200 🟢 | $109,364 |
| 2025-08-07 | 5 | $-135 🔴 | $109,230 |
| 2025-08-08 | 1 | $-19 🔴 | $109,211 |
| 2025-08-11 | 2 | $+199 🟢 | $109,410 |
| 2025-08-12 | 1 | $+54 🟢 | $109,464 |
| 2025-08-13 | 10 | $+855 🟢 | $110,319 |
| 2025-08-14 | 2 | $-316 🔴 | $110,002 |
| 2025-08-15 | 3 | $+443 🟢 | $110,445 |
| 2025-08-18 | 1 | $-36 🔴 | $110,409 |
| 2025-08-19 | 10 | $-305 🔴 | $110,105 |
| 2025-08-20 | 5 | $-367 🔴 | $109,737 |
| 2025-08-21 | 2 | $+314 🟢 | $110,051 |
| 2025-08-22 | 1 | $-359 🔴 | $109,692 |
| 2025-08-26 | 1 | $+87 🟢 | $109,780 |
| 2025-08-27 | 2 | $+142 🟢 | $109,922 |
| 2025-08-28 | 6 | $-278 🔴 | $109,644 |
| 2025-08-29 | 7 | $+336 🟢 | $109,980 |

## 2 · The Proud (top winners)

What these have in common — pattern-match on setup, personality, regime, PDZ. If the next month
has fewer trades that look like this, the engine has drifted.

- **ETHA  ** L |  +9.53% | MFE +0.00% / MAE +0.00% | exit: `HARD_FUSE_RSI_EXTREME` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRENDING · PDZ=premium
- **BE    ** L |  +6.03% | MFE +0.00% / MAE +0.00% | exit: `ST_FLIP_4H_CLOSE` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRENDING · PDZ=premium
- **SGI   ** L |  +3.86% | MFE +0.00% / MAE +0.00% | exit: `sl_breached` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRANSITIONAL · PDZ=premium
- **APLD  ** L |  +3.83% | MFE +0.00% / MAE +0.00% | exit: `peak_lock_ema12_deep_break` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRANSITIONAL · PDZ=premium · [PHv-]
- **B     ** L |  +3.77% | MFE +0.00% / MAE +0.00% | exit: `mfe_decay_structural_flatten` | TT Tt Gap Reversal Long · PULLBACK_PLAYER · TRANSITIONAL · PDZ=premium

## 3 · The Disappointed (worst losers)

Each one of these is a calibration question: was the entry the issue, the management, or the regime?
If the same `setup × personality × regime × side` shows up in 3+ disappointed trades, the next
calibration should raise the bar for that combo.

- **LMND  ** L |  -4.71% | MFE +0.00% / MAE +0.00% | exit: `v13_hard_pnl_floor` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRENDING · PDZ=premium_approach · [RSIv-|PHv-]
- **ALB   ** L |  -3.46% | MFE +0.00% / MAE +0.00% | exit: `max_loss` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRANSITIONAL · PDZ=premium_approach
- **SN    ** L |  -3.07% | MFE +0.00% / MAE +0.00% | exit: `max_loss` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRANSITIONAL · PDZ=premium_approach
- **FIX   ** L |  -2.68% | MFE +0.00% / MAE +0.00% | exit: `max_loss_time_scaled` | TT Tt N Test Support · VOLATILE_RUNNER · TRENDING · PDZ=premium_approach · [PHv-]
- **STX   ** L |  -2.59% | MFE +0.00% / MAE +0.00% | exit: `max_loss_time_scaled` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRENDING · PDZ=premium · [PHv-]

## 4 · Profit giveback (MFE ≥ 1% closed flat-or-worse)

**0 trade(s).** This is the bucket Loop 1's MFE peak-lock targets directly.
If this list is long, the calibration question is: should peak-lock fire earlier?

_None._ Engine is locking gains well this month.

## 5 · Re-entry chains (tickers traded ≥ 3x)

Negative chains are the engine repeatedly being wrong about the same name.
If a chain is net negative AND we never paused, Loop 2's circuit breaker missed it.

- **GE** — 3 trades, 0W/3L, **net -1.55%** 🔴
- **APLD** — 3 trades, 2W/1L, **net +4.94%** 🟢
- **SPY** — 3 trades, 1W/1L, **net -0.85%** 🔴
- **FIX** — 3 trades, 1W/2L, **net -1.73%** 🔴
- **AEHR** — 3 trades, 1W/2L, **net -2.58%** 🔴

## 6 · Setup performance

Bottom-quartile setups by win-rate AND volume are candidates for the next calibration to guard-rail.

| Setup | N | WR | Avg | Net |
|---|---:|---:|---:|---:|
| `TT Tt Gap Reversal Long` | 42 | 57% | +0.54% | +22.68% |
| `TT Tt Ath Breakout` | 7 | 43% | +0.07% | +0.51% |
| `TT Tt Pullback` | 5 | 60% | +0.04% | +0.22% |
| `TT Tt Reclaim` | 1 | 0% | -1.39% | -1.39% |
| `TT Tt Range Reversal Long` | 3 | 33% | -0.64% | -1.92% |
| `TT Tt N Test Resistance` | 2 | 0% | -1.34% | -2.69% |
| `TT Tt N Test Support` | 7 | 43% | -0.52% | -3.66% |

## 7 · Personality × Setup (combos with 2+ trades)

Worst-WR combos at top — these are the immediate Loop 1 candidates.

| Personality | Setup | N | WR | Net |
|---|---|---:|---:|---:|
| PULLBACK_PLAYER | `TT Tt Ath Breakout` | 3 | 0% | -0.96% |
| MODERATE | `TT Tt Pullback` | 2 | 0% | -1.92% |
| VOLATILE_RUNNER | `TT Tt N Test Support` | 2 | 0% | -4.69% |
| VOLATILE_RUNNER | `TT Tt Range Reversal Long` | 2 | 50% | -0.06% |
| VOLATILE_RUNNER | `TT Tt Ath Breakout` | 2 | 50% | +0.10% |
| MODERATE | `TT Tt N Test Support` | 2 | 50% | +0.94% |
| VOLATILE_RUNNER | `TT Tt Gap Reversal Long` | 33 | 55% | +13.04% |
| PULLBACK_PLAYER | `TT Tt Gap Reversal Long` | 8 | 62% | +7.17% |
| PULLBACK_PLAYER | `TT Tt Pullback` | 2 | 100% | +0.45% |
| SLOW_GRINDER | `TT Tt N Test Support` | 2 | 100% | +1.32% |

## 8 · Loop firing log

Phase C self-adapting loops. Empty for any backtest run before the loops were enabled.

- **Loop 3** — `flat_cut`: 492 times
- **Loop 2** — `block`: 179 times

**Loop 1 scorecard snapshot** (end-of-month, min_samples=3):
- 🔴 BLOCK (2 combos): `tt_n_test_support:trending:volatile_runner:L` (0W/3L), `tt_ath_breakout:trending:pullback_player:L` (2W/7L)
- 🟡 RAISE_BAR (2 combos): `tt_pullback:trending:pullback_player:L` (2W/3L), `tt_gap_reversal_long:transitional:volatile_runner:L` (6W/9L)
- 🟢 ALLOW (>0.45 WR): 7 combos

## 9 · Calibration notes (fill in by hand after reviewing above)

_Proposed flag deltas for the next month, with one-line justification each._

- [ ] (no change) — engine looks calibrated for this regime
- [ ] _Or list specific flag deltas. e.g.:_
      `deep_audit_mfe_peak_lock_retrace_pct: 50 → 40` because profit giveback list is long.

After deciding, edit `scripts/v15-activate.sh`, commit with message
`phase-c: 2025-08 calibration` and resume the next month.
