# Phase C — Monthly Verdict · 2025-07

_Source: `phase-c-stage1-jul2025-may2026` · Trades in window: **103** · Generated 2026-05-04 17:37 UTC_

> Read this alongside the previous month's verdict. The point is **trajectory** —
> are we drifting toward July or away from it?

## 1 · Headline

- **91 closed trades.** 50W / 41L / 0 flat.
- **Win rate: 54.9%.** Target 55% — MISS.
- **Avg winner / Avg loser: 1.44x** (1.91% / 1.33%). Target 1.60x — MISS.
- **Max drawdown (cum %): 10.03%.** Target ≤ 3.0% — MISS.
- **Sharpe (annualized, daily-pct proxy): 3.02.** Target 1.50 — PASS.
- **Cumulative P&L (sum of pct): +40.95%.**

### Account equity (start $100,000 reference, ~$9,589 avg notional/trade)

_Each trade uses its actual recorded P&L (`trade.pnl` field) — not derived from %._

| Metric | Value |
|---|---|
| **Start balance** (entering this month) | **$100,000** |
| **End balance** (after last trade closed) | **$103,998** |
| **Net $ P&L for the month** | **$+3,998**  (+4.00% of start balance) |
| Sum of winning $ | +$9,419  (50 wins) |
| Sum of losing $ | -$5,420  (41 losses) |
| Biggest winner | **JOBY** +$1,482 (+12.37%) |
| Biggest loser | **ALB** -$567 (-5.73%) |
| Run-to-date peak | $104,119 (on 2025-07-31) |
| Run-to-date max DD | -$1,567 (1.57%) (trough on 2025-07-11) |

### Day-by-day P&L (this month)

| Date | # Trades | Day P&L $ | End-of-day Balance |
|---|---:|---:|---:|
| 2025-07-02 | 3 | $-644 🔴 | $99,356 |
| 2025-07-03 | 2 | $+371 🟢 | $99,726 |
| 2025-07-07 | 4 | $-12 🔴 | $99,714 |
| 2025-07-08 | 5 | $-280 🔴 | $99,434 |
| 2025-07-09 | 1 | $-46 🔴 | $99,388 |
| 2025-07-10 | 6 | $-389 🔴 | $98,999 |
| 2025-07-11 | 2 | $-232 🔴 | $98,767 |
| 2025-07-14 | 5 | $+242 🟢 | $99,009 |
| 2025-07-15 | 8 | $+2,145 🟢 | $101,154 |
| 2025-07-16 | 4 | $+174 🟢 | $101,328 |
| 2025-07-18 | 6 | $-524 🔴 | $100,804 |
| 2025-07-21 | 1 | $+37 🟢 | $100,841 |
| 2025-07-22 | 13 | $+379 🟢 | $101,220 |
| 2025-07-23 | 1 | $+207 🟢 | $101,427 |
| 2025-07-24 | 4 | $+285 🟢 | $101,712 |
| 2025-07-25 | 5 | $+642 🟢 | $102,354 |
| 2025-07-28 | 4 | $+491 🟢 | $102,845 |
| 2025-07-29 | 8 | $-141 🔴 | $102,705 |
| 2025-07-30 | 1 | $+13 🟢 | $102,717 |
| 2025-07-31 | 8 | $+1,281 🟢 | $103,998 |

## 2 · The Proud (top winners)

What these have in common — pattern-match on setup, personality, regime, PDZ. If the next month
has fewer trades that look like this, the engine has drifted.

- **JOBY  ** L | +12.37% | MFE +0.00% / MAE +0.00% | exit: `TP_FULL` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRENDING · PDZ=premium_approach · [RSIv-]
- **AGQ   ** L |  +7.46% | MFE +0.00% / MAE +0.00% | exit: `sl_breached` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRENDING · PDZ=premium · [PHv-]
- **IESC  ** L |  +5.81% | MFE +0.00% / MAE +0.00% | exit: `TP_FULL` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRANSITIONAL · PDZ=premium_approach
- **LULU  ** S |  +4.63% | MFE +0.00% / MAE +0.00% | exit: `HARD_FUSE_RSI_EXTREME` | TT Tt Gap Reversal Short · ? · ? · PDZ=?
- **SATS  ** L |  +4.14% | MFE +0.00% / MAE +0.00% | exit: `TP_FULL` | TT Tt Gap Reversal Long · ? · ? · PDZ=?

## 3 · The Disappointed (worst losers)

Each one of these is a calibration question: was the entry the issue, the management, or the regime?
If the same `setup × personality × regime × side` shows up in 3+ disappointed trades, the next
calibration should raise the bar for that combo.

- **ALB   ** L |  -5.73% | MFE +0.00% / MAE +0.00% | exit: `HARD_LOSS_CAP` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRENDING · PDZ=premium_approach
- **MDB   ** L |  -4.01% | MFE +0.00% / MAE +0.00% | exit: `max_loss` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRANSITIONAL · PDZ=premium_approach
- **INTC  ** L |  -3.23% | MFE +0.00% / MAE +0.00% | exit: `max_loss` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRENDING · PDZ=premium_approach
- **IBP   ** L |  -3.04% | MFE +0.00% / MAE +0.00% | exit: `max_loss` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRANSITIONAL · PDZ=premium · [PHv-]
- **CRWD  ** L |  -2.80% | MFE +0.00% / MAE +0.00% | exit: `max_loss` | TT Tt Ath Breakout · VOLATILE_RUNNER · TRENDING · PDZ=premium_approach · [RSIv-]

## 4 · Profit giveback (MFE ≥ 1% closed flat-or-worse)

**0 trade(s).** This is the bucket Loop 1's MFE peak-lock targets directly.
If this list is long, the calibration question is: should peak-lock fire earlier?

_None._ Engine is locking gains well this month.

## 5 · Re-entry chains (tickers traded ≥ 3x)

Negative chains are the engine repeatedly being wrong about the same name.
If a chain is net negative AND we never paused, Loop 2's circuit breaker missed it.

- **AVGO** — 4 trades, 1W/3L, **net -2.88%** 🔴
- **AWI** — 3 trades, 2W/1L, **net -0.04%** 🔴
- **JOBY** — 3 trades, 2W/1L, **net +11.79%** 🟢
- **ANET** — 3 trades, 1W/1L, **net -0.39%** 🔴

## 6 · Setup performance

Bottom-quartile setups by win-rate AND volume are candidates for the next calibration to guard-rail.

| Setup | N | WR | Avg | Net |
|---|---:|---:|---:|---:|
| `TT Tt Gap Reversal Long` | 58 | 64% | +0.73% | +42.14% |
| `TT Tt Gap Reversal Short` | 1 | 100% | +4.63% | +4.63% |
| `TT Tt Pullback` | 17 | 47% | +0.17% | +2.81% |
| `TT Tt Range Reversal Long` | 3 | 33% | -0.38% | -1.15% |
| `TT Tt Ath Breakout` | 12 | 25% | -0.62% | -7.47% |

## 7 · Personality × Setup (combos with 2+ trades)

Worst-WR combos at top — these are the immediate Loop 1 candidates.

| Personality | Setup | N | WR | Net |
|---|---|---:|---:|---:|
| VOLATILE_RUNNER | `TT Tt Ath Breakout` | 3 | 0% | -6.45% |
| PULLBACK_PLAYER | `TT Tt Range Reversal Long` | 2 | 0% | -1.50% |
| MODERATE | `TT Tt Pullback` | 3 | 33% | -1.34% |
| VOLATILE_RUNNER | `TT Tt Pullback` | 5 | 40% | -0.76% |
| PULLBACK_PLAYER | `TT Tt Ath Breakout` | 7 | 43% | +1.03% |
| PULLBACK_PLAYER | `TT Tt Pullback` | 8 | 50% | +3.82% |
| VOLATILE_RUNNER | `TT Tt Gap Reversal Long` | 40 | 57% | +25.23% |
| PULLBACK_PLAYER | `TT Tt Gap Reversal Long` | 13 | 69% | +4.80% |
| MODERATE | `TT Tt Gap Reversal Long` | 4 | 100% | +7.97% |

## 8 · Loop firing log

Phase C self-adapting loops. Empty for any backtest run before the loops were enabled.

- **Loop 3** — `flat_cut`: 434 times
- **Loop 2** — `block`: 222 times

**Loop 1 scorecard snapshot** (end-of-month, min_samples=3):
- 🔴 BLOCK (2 combos): `tt_ath_breakout:trending:volatile_runner:L` (0W/3L), `tt_pullback:trending:pullback_player:L` (1W/4L)
- 🟡 RAISE_BAR (3 combos): `tt_gap_reversal_long:transitional:volatile_runner:L` (2W/4L), `tt_ath_breakout:trending:pullback_player:L` (2W/4L), `tt_pullback:trending:volatile_runner:L` (2W/3L)
- 🟢 ALLOW (>0.45 WR): 4 combos

## 9 · Calibration notes (fill in by hand after reviewing above)

_Proposed flag deltas for the next month, with one-line justification each._

- [ ] (no change) — engine looks calibrated for this regime
- [ ] _Or list specific flag deltas. e.g.:_
      `deep_audit_mfe_peak_lock_retrace_pct: 50 → 40` because profit giveback list is long.

After deciding, edit `scripts/v15-activate.sh`, commit with message
`phase-c: 2025-07 calibration` and resume the next month.
