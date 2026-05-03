# Phase C — Monthly Verdict · 2025-07

_Source: `phase-c-stage1-jul2025-may2026` · Trades in window: **92** · Generated 2026-05-03 16:40 UTC_

> Read this alongside the previous month's verdict. The point is **trajectory** —
> are we drifting toward July or away from it?

## 1 · Headline

- **79 closed trades.** 52W / 27L / 0 flat.
- **Win rate: 65.8%.** Target 55% — PASS.
- **Avg winner / Avg loser: 1.81x** (2.31% / 1.27%). Target 1.60x — PASS.
- **Max drawdown (cum %): 12.22%.** Target ≤ 3.0% — MISS.
- **Sharpe (annualized, daily-pct proxy): 6.54.** Target 1.50 — PASS.
- **Cumulative P&L (sum of pct): +85.58%.**

### Account equity (start $100,000 reference, ~$10,003 avg notional/trade)

_Each trade uses its actual recorded P&L (`trade.pnl` field) — not derived from %._

| Metric | Value |
|---|---|
| **Start balance** (entering this month) | **$100,000** |
| **End balance** (after last trade closed) | **$108,366** |
| **Net $ P&L for the month** | **$+8,366**  (+8.37% of start balance) |
| Sum of winning $ | +$11,889  (52 wins) |
| Sum of losing $ | -$3,523  (27 losses) |
| Biggest winner | **JOBY** +$1,483 (+12.37%) |
| Biggest loser | **INTC** -$388 (-3.23%) |
| Run-to-date peak | $108,518 (on 2025-07-31) |
| Run-to-date max DD | -$605 (0.56%) (trough on 2025-07-29) |

### Day-by-day P&L (this month)

| Date | # Trades | Day P&L $ | End-of-day Balance |
|---|---:|---:|---:|
| 2025-07-02 | 2 | $-579 🔴 | $99,421 |
| 2025-07-03 | 2 | $+371 🟢 | $99,792 |
| 2025-07-07 | 2 | $+99 🟢 | $99,891 |
| 2025-07-08 | 4 | $-38 🔴 | $99,854 |
| 2025-07-10 | 4 | $-80 🔴 | $99,774 |
| 2025-07-11 | 3 | $+794 🟢 | $100,568 |
| 2025-07-14 | 8 | $+442 🟢 | $101,010 |
| 2025-07-15 | 7 | $+2,997 🟢 | $104,007 |
| 2025-07-16 | 5 | $+432 🟢 | $104,439 |
| 2025-07-17 | 1 | $-19 🔴 | $104,420 |
| 2025-07-18 | 3 | $-228 🔴 | $104,192 |
| 2025-07-22 | 8 | $+1,006 🟢 | $105,198 |
| 2025-07-23 | 3 | $+1,127 🟢 | $106,325 |
| 2025-07-24 | 4 | $+274 🟢 | $106,598 |
| 2025-07-25 | 6 | $+866 🟢 | $107,465 |
| 2025-07-28 | 4 | $+627 🟢 | $108,092 |
| 2025-07-29 | 7 | $-534 🔴 | $107,558 |
| 2025-07-30 | 3 | $+117 🟢 | $107,674 |
| 2025-07-31 | 3 | $+692 🟢 | $108,366 |

## 2 · The Proud (top winners)

What these have in common — pattern-match on setup, personality, regime, PDZ. If the next month
has fewer trades that look like this, the engine has drifted.

- **JOBY  ** L | +12.37% | MFE +0.00% / MAE +0.00% | exit: `TP_FULL` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRENDING · PDZ=premium_approach · [RSIv-]
- **IREN  ** L | +10.21% | MFE +0.00% / MAE +0.00% | exit: `sl_breached` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRENDING · PDZ=premium_approach · [PHv-]
- **AGQ   ** L |  +7.46% | MFE +0.00% / MAE +0.00% | exit: `sl_breached` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRENDING · PDZ=premium · [PHv-]
- **ASTS  ** L |  +6.03% | MFE +0.00% / MAE +0.00% | exit: `peak_lock_ema12_deep_break` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRENDING · PDZ=premium_approach · [PHv-]
- **IESC  ** L |  +5.81% | MFE +0.00% / MAE +0.00% | exit: `TP_FULL` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRANSITIONAL · PDZ=premium_approach

## 3 · The Disappointed (worst losers)

Each one of these is a calibration question: was the entry the issue, the management, or the regime?
If the same `setup × personality × regime × side` shows up in 3+ disappointed trades, the next
calibration should raise the bar for that combo.

- **MDB   ** L |  -4.01% | MFE +0.00% / MAE +0.00% | exit: `max_loss` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRANSITIONAL · PDZ=premium_approach
- **INTC  ** L |  -3.23% | MFE +0.00% / MAE +0.00% | exit: `max_loss` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRENDING · PDZ=premium_approach
- **IBP   ** L |  -3.04% | MFE +0.00% / MAE +0.00% | exit: `max_loss` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRANSITIONAL · PDZ=premium · [PHv-]
- **CSX   ** L |  -2.75% | MFE +0.00% / MAE +0.00% | exit: `max_loss_time_scaled` | TT Tt Pullback · PULLBACK_PLAYER · TRENDING · PDZ=premium_approach · [RSIv-|PHv-]
- **AEHR  ** L |  -1.92% | MFE +0.00% / MAE +0.00% | exit: `phase_i_mfe_fast_cut_zero_mfe` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRENDING · PDZ=premium_approach · [RSIv-]

## 4 · Profit giveback (MFE ≥ 1% closed flat-or-worse)

**0 trade(s).** This is the bucket Loop 1's MFE peak-lock targets directly.
If this list is long, the calibration question is: should peak-lock fire earlier?

_None._ Engine is locking gains well this month.

## 5 · Re-entry chains (tickers traded ≥ 3x)

Negative chains are the engine repeatedly being wrong about the same name.
If a chain is net negative AND we never paused, Loop 2's circuit breaker missed it.

- **SPY** — 3 trades, 2W/0L, **net +1.92%** 🟢
- **AWI** — 3 trades, 2W/1L, **net -0.04%** 🔴
- **ALB** — 3 trades, 2W/1L, **net +1.49%** 🟢
- **ANET** — 3 trades, 0W/2L, **net -1.37%** 🔴
- **AVGO** — 3 trades, 0W/2L, **net -2.29%** 🔴

## 6 · Setup performance

Bottom-quartile setups by win-rate AND volume are candidates for the next calibration to guard-rail.

| Setup | N | WR | Avg | Net |
|---|---:|---:|---:|---:|
| `TT Tt Gap Reversal Long` | 49 | 73% | +1.56% | +76.55% |
| `TT Tt Pullback` | 11 | 55% | +0.44% | +4.84% |
| `TT Tt N Test Support` | 6 | 50% | +0.73% | +4.39% |
| `TT Tt Ath Breakout` | 10 | 50% | +0.02% | +0.22% |
| `TT Tt Range Reversal Long` | 3 | 67% | -0.14% | -0.42% |

## 7 · Personality × Setup (combos with 2+ trades)

Worst-WR combos at top — these are the immediate Loop 1 candidates.

| Personality | Setup | N | WR | Net |
|---|---|---:|---:|---:|
| MODERATE | `TT Tt Pullback` | 2 | 50% | -0.26% |
| PULLBACK_PLAYER | `TT Tt N Test Support` | 2 | 50% | +3.43% |
| PULLBACK_PLAYER | `TT Tt Pullback` | 6 | 50% | +3.22% |
| VOLATILE_RUNNER | `TT Tt Pullback` | 2 | 50% | +0.79% |
| PULLBACK_PLAYER | `TT Tt Ath Breakout` | 8 | 50% | +0.84% |
| VOLATILE_RUNNER | `TT Tt N Test Support` | 2 | 50% | +0.06% |
| PULLBACK_PLAYER | `TT Tt Range Reversal Long` | 2 | 50% | -0.77% |
| SLOW_GRINDER | `TT Tt N Test Support` | 2 | 50% | +0.90% |
| VOLATILE_RUNNER | `TT Tt Gap Reversal Long` | 33 | 67% | +54.21% |
| PULLBACK_PLAYER | `TT Tt Gap Reversal Long` | 12 | 83% | +12.51% |
| MODERATE | `TT Tt Gap Reversal Long` | 4 | 100% | +9.84% |

## 8 · Loop firing log

Phase C self-adapting loops. Empty for any backtest run before the loops were enabled.

- **Loop 3** — `flat_cut`: 394 times
- **Loop 2** — `block`: 69 times

**Loop 1 scorecard snapshot** (end-of-month, min_samples=3):
- 🔴 BLOCK (1 combos): `tt_pullback:trending:pullback_player:L` (1W/3L)
- 🟡 RAISE_BAR (1 combos): `tt_ath_breakout:trending:pullback_player:L` (3W/4L)
- 🟢 ALLOW (>0.45 WR): 5 combos

## 9 · Calibration notes (fill in by hand after reviewing above)

_Proposed flag deltas for the next month, with one-line justification each._

- [ ] (no change) — engine looks calibrated for this regime
- [ ] _Or list specific flag deltas. e.g.:_
      `deep_audit_mfe_peak_lock_retrace_pct: 50 → 40` because profit giveback list is long.

After deciding, edit `scripts/v15-activate.sh`, commit with message
`phase-c: 2025-07 calibration` and resume the next month.
