# Phase C — Monthly Verdict · 2026-05

_Source: `phase-c-stage1-jul2025-may2026` · Trades in window: **0** · Generated 2026-05-06 01:13 UTC_

> Read this alongside the previous month's verdict. The point is **trajectory** —
> are we drifting toward July or away from it?

**No closed trades in this month.**

## 2 · The Proud (top winners)

What these have in common — pattern-match on setup, personality, regime, PDZ. If the next month
has fewer trades that look like this, the engine has drifted.

_No winners this month._

## 3 · The Disappointed (worst losers)

Each one of these is a calibration question: was the entry the issue, the management, or the regime?
If the same `setup × personality × regime × side` shows up in 3+ disappointed trades, the next
calibration should raise the bar for that combo.

_No losers this month._

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
| _no data_ | — | — | — | — |

## 7 · Personality × Setup (combos with 2+ trades)

Worst-WR combos at top — these are the immediate Loop 1 candidates.

| Personality | Setup | N | WR | Net |
|---|---|---:|---:|---:|
| _insufficient data_ | — | — | — | — |

## 8 · Loop firing log

Phase C self-adapting loops. Empty for any backtest run before the loops were enabled.

_No loop events recorded against trades this month._

**Loop 1 scorecard snapshot** (end-of-month, min_samples=3):
- 🔴 BLOCK (17 combos): `tt_n_test_support:transitional:pullback_player:L` (0W/4L), `ema_regime_confirmed_long:transitional:pullback_player:L` (0W/6L), `momentum_score:trending:pullback_player:L` (0W/14L), `tt_n_test_support:trending:moderate:L` (0W/3L), `tt_ath_breakout:trending:moderate:L` (0W/6L), `tt_gap_reversal_long:trending:slow_grinder:L` (0W/6L), `tt_atl_breakdown:transitional:moderate:S` (0W/3L), `tt_ath_breakout:trending:pullback_player:L` (3W/17L), `tt_n_test_support:trending:volatile_runner:L` (1W/5L), `tt_pullback:trending:moderate:L` (1W/5L)
- 🟡 RAISE_BAR (10 combos): `tt_n_test_support:transitional:slow_grinder:L` (4W/8L), `tt_n_test_support:choppy:slow_grinder:L` (2W/4L), `tt_pullback:transitional:volatile_runner:L` (4W/8L), `tt_gap_reversal_short:trending:volatile_runner:S` (1W/2L), `tt_pullback:trending:pullback_player:L` (5W/9L), `tt_n_test_support:trending:pullback_player:L` (3W/5L), `tt_pullback:trending:volatile_runner:L` (5W/8L), `tt_range_reversal_long:trending:pullback_player:L` (4W/6L), `tt_n_test_support:transitional:moderate:L` (2W/3L), `tt_gap_reversal_long:choppy:volatile_runner:L` (7W/9L)
- 🟢 ALLOW (>0.45 WR): 18 combos

## 9 · Calibration notes (fill in by hand after reviewing above)

_Proposed flag deltas for the next month, with one-line justification each._

- [ ] (no change) — engine looks calibrated for this regime
- [ ] _Or list specific flag deltas. e.g.:_
      `deep_audit_mfe_peak_lock_retrace_pct: 50 → 40` because profit giveback list is long.

After deciding, edit `scripts/v15-activate.sh`, commit with message
`phase-c: 2026-05 calibration` and resume the next month.
