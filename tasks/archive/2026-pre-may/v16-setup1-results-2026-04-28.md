# V16 Setup #1 — Range Reversal Final Results

Status: **READY** — validated, ready for production
Run: setup4and1-sep-oct-1777375183

## What it does

Captures the "buy bounce off range low / sell bounce at range high"
pattern (Ripster Setup #1). V14 caught these as `tt_pullback` with
permissive gates; current gates filter them out as "counter-trend"
or "not deep enough pullback". Setup #1 routes them as their own
trigger with appropriate gating.

## Cumulative Sept-Oct 2025 impact

| Configuration | Trades | WR | PnL | PF |
|---|---:|---:|---:|---:|
| P0.7.11 (no new setups) | 12 | 25.0% | -12.01% | 0.26 |
| + Setup #4 (ATH breakout) | 53 | 47.2% | -4.13% | 0.89 |
| **+ Setups #4 + #1** | **53** | **47.2%** | **+6.41%** | **1.16** |

**+18.42% PnL improvement vs no setups, +10.54% vs Setup #4 alone.**

The Sept-Oct window went from net negative to clean profitable
purely through trigger diversification.

## Setup #1 standalone contribution

**12 range-reversal trades fired in Sept-Oct:**

```
AMZN  09-02 LONG  +4.45%  ST_FLIP_4H_CLOSE
KWEB  09-02 LONG  +2.88%  HARD_FUSE_RSI_EXTREME
CCJ   09-03 LONG  +2.91%  mfe_decay_structural_flatten
SGI   09-11 LONG  -2.21%  max_loss_time_scaled
WAL   09-11 LONG  -1.05%  phase_i_mfe_fast_cut_zero_mfe
AMZN  09-12 LONG  +1.08%  peak_lock_ema12_deep_break
APD   09-15 LONG  -1.94%  phase_i_mfe_fast_cut_zero_mfe
CAT   09-26 LONG  +4.33%  HARD_FUSE_RSI_EXTREME
PANW  09-29 LONG  -1.01%  atr_day_adverse_382_cut
ETN   10-08 LONG  +2.51%  (replay_end_close)
ETN   10-14 LONG  -0.29%  max_loss
QQQ   10-15 LONG  +1.74%  TP_FULL
```

**Stats:** 7W / 5L = WR 58%, total PnL +13.40% (+10.89% clean).

## Path breakdown after Setup #1 added

```
tt_ath_breakout       25 clean trades  WR 60%   PnL  +4.49%
tt_range_reversal     11 clean trades  WR 55%   PnL +10.89%  ← biggest
tt_pullback           15 clean trades  WR 27%   PnL  -6.89%  ← weakest
tt_atl_breakdown       1 clean trade   WR  0%   PnL  -0.87%
tt_reclaim             1 clean trade   WR  0%   PnL  -1.20%
```

Three profitable setup families now operate simultaneously:
- ATH/52w breakouts in bull-grind regimes
- Range reversals in chop / consolidation
- Pullbacks in clean uptrends (with the existing infra)

## V14 winners that V16 now captures

| V14 winner | V16 path | V16 PnL |
|---|---|---:|
| AMZN equiv (different timing) | tt_range_reversal_long | +4.45% |
| KWEB Sep 3 +2.63% | tt_range_reversal_long Sep 2 | +2.88% |
| CCJ Sep 3 +3.45% | tt_range_reversal_long Sep 3 | +2.91% |
| CAT (V14 had multiple) | tt_range_reversal_long Sep 26 | +4.33% |

V16 doesn't catch every V14 entry timing exactly — but the cohort
is captured at comparable PnL.

## V14 winners still missing

```
GOOGL Sep 2 +8.43% — entered later (Sept 25 GOOGL +1.57% via range)
IESC Sep 9 +3.11% — captured via tt_pullback at +0.31% (exit-side gap)
PWR Sep 25 +3.37% — captured via tt_pullback at -0.47% (worse exit)
STRL Oct 14 +2.63% — still missed
GDX Oct 14 +3.80% — captured via tt_pullback at -1.21% (worse exit)
```

The remaining gap is **exit-side calibration**: when our gates DO
admit the trade, our exits often clip wins or scratch them. Setup
#5 (Gap Reversal) and exit-rule tuning are the next levers.

## DA keys

```
deep_audit_range_reversal_enabled = true
deep_audit_range_reversal_min_rvol = 1.0
deep_audit_range_reversal_min_touches = 2
```

## Range box detection rules

`worker/indicators.js` tracks for daily TF:
- 12-bar window (configurable) range high/low
- Touch counts (within 5% of range edge = "touch")
- Range pct (high-low / mid-price)
- Position-in-range (0 = at low, 1 = at high)
- Bullish/bearish reversal candle (close in upper/lower 55%)
- Today bullish/bearish day (close vs prior close)

`is_valid_range`: range 3-15% AND ≥2 touches of either edge.
`long_setup_active`: pos < 0.55, ≥2 low touches, ≤6 bars since
  low touch, AND (bullish reversal OR today bullish day).
`short_setup_active`: mirror.

## Files

- `worker/indicators.js` — adds rangeBox to TF bundle.
- `worker/focus-tier.js` — adds scoreRangeReversal (0-12 pts).
- `worker/pipeline/tt-core-entry.js` — adds rangeReversalTrigger
  evaluation, routes to `tt_range_reversal_long/short`.
- `worker/replay-candle-batches.js` — exposes range_box +
  range_reversal_diag in block-chain trace.
- `scripts/v15-activate.sh` — DA registration.

## Next

**Setup #5 (Gap Reversal)** — captures gap-down-and-reclaim patterns
currently blocked by `tt_pullback_late_session_unreclaimed`. Less
common but high-value when it fires.

**Exit-side calibration** — V14 PnLs on shared trades are 2-3x
higher than ours. The carve-out / cloud-hold / peak-lock work helps
but pullback-side exits are still clipping wins early. Worth a
focused audit.

**Setup #2 (N-Test Support)** — most data-heavy add (rolling
support cluster tracking). Defer until #5 + exits are tuned.
