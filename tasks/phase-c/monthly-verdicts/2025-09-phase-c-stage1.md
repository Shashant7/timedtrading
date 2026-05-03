# Phase C — Monthly Verdict · 2025-09

_Source: `phase-c-stage1-jul2025-may2026` · Trades in window: **79** · Generated 2026-05-03 14:54 UTC_

> Read this alongside the previous month's verdict. The point is **trajectory** —
> are we drifting toward July or away from it?

## 1 · Headline

- **65 closed trades.** 38W / 27L / 0 flat.
- **Win rate: 58.5%.** Target 55% — PASS.
- **Avg winner / Avg loser: 1.79x** (3.17% / 1.77%). Target 1.60x — PASS.
- **Max drawdown (cum %): 19.46%.** Target ≤ 3.0% — MISS.
- **Sharpe (annualized, daily-pct proxy): 5.26.** Target 1.50 — PASS.
- **Cumulative P&L (sum of pct): +72.62%.**

### Account equity (start $100,000 reference, ~$8,423 avg notional/trade)

_Each trade uses its actual recorded P&L (`trade.pnl` field) — not derived from %._

| Metric | Value |
|---|---|
| **Start balance** (entering this month) | **$111,178** |
| **End balance** (after last trade closed) | **$117,188** |
| **Net $ P&L for the month** | **$+6,011**  (+5.41% of start balance) |
| Sum of winning $ | +$9,832  (38 wins) |
| Sum of losing $ | -$3,821  (27 losses) |
| Biggest winner | **AEHR** +$1,025 (+12.85%) |
| Biggest loser | **CDNS** -$306 (-3.39%) |
| Run-to-date peak | $117,963 (on 2025-09-29) |
| Run-to-date max DD | -$1,990 (1.76%) (trough on 2025-08-22) |

### Day-by-day P&L (this month)

| Date | # Trades | Day P&L $ | End-of-day Balance |
|---|---:|---:|---:|
| 2025-09-02 | 1 | $+95 🟢 | $111,273 |
| 2025-09-03 | 1 | $-3 🔴 | $111,270 |
| 2025-09-04 | 1 | $+422 🟢 | $111,692 |
| 2025-09-05 | 6 | $+994 🟢 | $112,686 |
| 2025-09-08 | 2 | $+459 🟢 | $113,145 |
| 2025-09-09 | 6 | $-113 🔴 | $113,032 |
| 2025-09-10 | 2 | $-269 🔴 | $112,763 |
| 2025-09-11 | 2 | $+14 🟢 | $112,778 |
| 2025-09-12 | 6 | $-117 🔴 | $112,660 |
| 2025-09-15 | 1 | $-20 🔴 | $112,640 |
| 2025-09-16 | 1 | $-58 🔴 | $112,581 |
| 2025-09-17 | 1 | $+178 🟢 | $112,759 |
| 2025-09-18 | 6 | $+448 🟢 | $113,207 |
| 2025-09-19 | 1 | $-187 🔴 | $113,020 |
| 2025-09-22 | 6 | $+1,484 🟢 | $114,504 |
| 2025-09-23 | 4 | $-111 🔴 | $114,393 |
| 2025-09-24 | 7 | $+1,694 🟢 | $116,087 |
| 2025-09-25 | 6 | $+1,703 🟢 | $117,790 |
| 2025-09-29 | 2 | $-48 🔴 | $117,741 |
| 2025-09-30 | 3 | $-553 🔴 | $117,188 |

## 2 · The Proud (top winners)

What these have in common — pattern-match on setup, personality, regime, PDZ. If the next month
has fewer trades that look like this, the engine has drifted.

- **AEHR  ** L | +12.85% | MFE +0.00% / MAE +0.00% | exit: `peak_lock_ema12_deep_break` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRENDING · PDZ=premium
- **APP   ** L |  +9.55% | MFE +0.00% / MAE +0.00% | exit: `sl_breached` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRENDING · PDZ=premium · [PHv-]
- **CLS   ** L |  +9.21% | MFE +0.00% / MAE +0.00% | exit: `HARD_FUSE_RSI_EXTREME` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRANSITIONAL · PDZ=premium
- **STX   ** L |  +6.47% | MFE +0.00% / MAE +0.00% | exit: `HARD_FUSE_RSI_EXTREME` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRENDING · PDZ=premium_approach · [RSIv-|PHv-]
- **SNDK  ** L |  +5.36% | MFE +0.00% / MAE +0.00% | exit: `HARD_FUSE_RSI_EXTREME` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRENDING · PDZ=premium

## 3 · The Disappointed (worst losers)

Each one of these is a calibration question: was the entry the issue, the management, or the regime?
If the same `setup × personality × regime × side` shows up in 3+ disappointed trades, the next
calibration should raise the bar for that combo.

- **ALB   ** L |  -6.46% | MFE +0.00% / MAE +0.00% | exit: `v13_hard_pnl_floor` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRANSITIONAL · PDZ=premium_approach · [PHv-]
- **PATH  ** L |  -3.89% | MFE +0.00% / MAE +0.00% | exit: `max_loss` | TT Tt Pullback · VOLATILE_RUNNER · TRENDING · PDZ=premium_approach · [PHv-]
- **SNDK  ** L |  -3.53% | MFE +0.00% / MAE +0.00% | exit: `max_loss` | TT Tt Gap Reversal Long · VOLATILE_RUNNER · TRENDING · PDZ=premium_approach
- **CDNS  ** L |  -3.39% | MFE +0.00% / MAE +0.00% | exit: `SMART_RUNNER_SUPPORT_BREAK_CLOUD` | TT Tt Gap Reversal Long · PULLBACK_PLAYER · TRANSITIONAL · PDZ=premium_approach · [PHv-]
- **QXO   ** L |  -3.38% | MFE +0.00% / MAE +0.00% | exit: `max_loss` | TT Tt Pullback · VOLATILE_RUNNER · TRANSITIONAL · PDZ=premium_approach

## 4 · Profit giveback (MFE ≥ 1% closed flat-or-worse)

**0 trade(s).** This is the bucket Loop 1's MFE peak-lock targets directly.
If this list is long, the calibration question is: should peak-lock fire earlier?

_None._ Engine is locking gains well this month.

## 5 · Re-entry chains (tickers traded ≥ 3x)

Negative chains are the engine repeatedly being wrong about the same name.
If a chain is net negative AND we never paused, Loop 2's circuit breaker missed it.

- **SNDK** — 6 trades, 1W/4L, **net -0.64%** 🔴
- **AAPL** — 3 trades, 2W/0L, **net +8.62%** 🟢
- **STX** — 3 trades, 2W/1L, **net +10.73%** 🟢
- **AXP** — 3 trades, 1W/2L, **net +1.13%** 🟢
- **SPY** — 3 trades, 2W/0L, **net +0.77%** 🟢

## 6 · Setup performance

Bottom-quartile setups by win-rate AND volume are candidates for the next calibration to guard-rail.

| Setup | N | WR | Avg | Net |
|---|---:|---:|---:|---:|
| `TT Tt Gap Reversal Long` | 43 | 63% | +1.62% | +69.87% |
| `TT Tt N Test Support` | 9 | 67% | +0.91% | +8.19% |
| `TT Tt Range Reversal Long` | 4 | 75% | +1.98% | +7.93% |
| `TT Tt Ath Breakout` | 4 | 25% | -1.12% | -4.49% |
| `TT Tt Pullback` | 5 | 20% | -1.78% | -8.89% |

## 7 · Personality × Setup (combos with 2+ trades)

Worst-WR combos at top — these are the immediate Loop 1 candidates.

| Personality | Setup | N | WR | Net |
|---|---|---:|---:|---:|
| PULLBACK_PLAYER | `TT Tt Ath Breakout` | 3 | 0% | -4.69% |
| VOLATILE_RUNNER | `TT Tt Pullback` | 5 | 20% | -8.89% |
| VOLATILE_RUNNER | `TT Tt N Test Support` | 4 | 50% | -2.26% |
| PULLBACK_PLAYER | `TT Tt Gap Reversal Long` | 10 | 60% | +13.23% |
| VOLATILE_RUNNER | `TT Tt Gap Reversal Long` | 32 | 62% | +56.22% |
| VOLATILE_RUNNER | `TT Tt Range Reversal Long` | 3 | 67% | +5.05% |
| PULLBACK_PLAYER | `TT Tt N Test Support` | 2 | 100% | +8.62% |
| SLOW_GRINDER | `TT Tt N Test Support` | 2 | 100% | +2.14% |

## 8 · Loop firing log

Phase C self-adapting loops. Empty for any backtest run before the loops were enabled.

- **Loop 3** — `flat_cut`: 356 times
- **Loop 2** — `block`: 18 times

**Loop 1 scorecard snapshot** (end-of-month, min_samples=3):
- 🔴 BLOCK (8 combos): `momentum_score:trending:pullback_player:L` (0W/4L), `ema_regime_confirmed_long:transitional:pullback_player:L` (0W/3L), `tt_ath_breakout:trending:pullback_player:L` (1W/5L), `tt_pullback:trending:pullback_player:L` (1W/5L), `tt_n_test_support:trending:pullback_player:L` (1W/3L), `tt_n_test_support:trending:volatile_runner:L` (1W/3L), `tt_ath_breakout:transitional:pullback_player:L` (1W/3L), `tt_pullback:transitional:volatile_runner:L` (1W/3L)
- 🟡 RAISE_BAR (6 combos): `tt_gap_reversal_long:trending:pullback_player:L` (4W/9L), `tt_ath_breakout:trending:volatile_runner:L` (1W/2L), `tt_gap_reversal_long:choppy:volatile_runner:L` (2W/3L), `tt_range_reversal_long:trending:pullback_player:L` (2W/3L), `tt_pullback:trending:volatile_runner:L` (3W/4L), `tt_gap_reversal_long:transitional:volatile_runner:L` (8W/10L)
- 🟢 ALLOW (>0.45 WR): 6 combos

## 9 · Calibration notes (fill in by hand after reviewing above)

_Proposed flag deltas for the next month, with one-line justification each._

- [ ] (no change) — engine looks calibrated for this regime
- [ ] _Or list specific flag deltas. e.g.:_
      `deep_audit_mfe_peak_lock_retrace_pct: 50 → 40` because profit giveback list is long.

After deciding, edit `scripts/v15-activate.sh`, commit with message
`phase-c: 2025-09 calibration` and resume the next month.
