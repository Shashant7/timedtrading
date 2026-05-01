# VWAP Analysis Synthesis (2026-04-30)

## Coverage confirmation

**566 of 588 closed trades (96%)** in the canonical Jul 2025 → Apr 2026 dataset have full VWAP capture across 6 timeframes (10m, 30m, 1H, 4H, D, W) — 564 also have W. The P0.7.33 `setup_snapshot.vwap` plumbing is working end-to-end.

Each TF carries six fields:
- `vwap` — cumulative VWAP value (anchored to dataset start)
- `rolling_20` — 20-bar rolling VWAP (session-relevant)
- `dist_pct` — `(price − vwap) / vwap × 100` (signed)
- `slope_5bar` — VWAP slope over 5 bars (% per bar)
- `above` — boolean: price above VWAP at entry
- `touch_bars` — bars since last VWAP touch

## What's actually useful (and what isn't)

### Not useful

- **Cumulative `dist_pct` is misleading.** The cumulative VWAP is anchored to dataset start (months ago), not session start, so `dist_pct` is dominated by long-history drift. Median value for winners on Daily TF is +35% — every entry "looks extended" because cumulative VWAP is far below current price. We can't use raw `dist_pct` for entry filtering.
- **`above` is uninformative at entry.** The model already biases toward with-trend setups via HTF/LTF scoring. Only **8 of 558** trades entered against 1H VWAP, and only 3 against 4H. There's not enough against-VWAP volume to gate on.
- **`touch_bars` is uninformative.** 463 of 566 trades have `touch_bars >= 50` (max bucket). The metric is saturated and doesn't discriminate.
- **VWAP at entry doesn't predict PROFIT_GIVEBACK losses.** Of 20 PG-losses, the 1H slope at entry was healthy in most. The reversal happens *in trade*, not at entry — VWAP would only be useful as a **live exit signal** (cross back below VWAP), which we don't currently have wired.

### Genuinely useful

**1. `slope_5bar` per TF is the best entry-quality signal we have from VWAP.** Higher in-direction slope → higher WR + larger avg PnL. Cleanest split is on the 1H slope:

| 1H slope (signed by direction) | n | WR | avg pnl% | cum$ |
|---|---:|---:|---:|---:|
| `> 0.05` (sharp with us) | 412 | 54% | +0.96 | +$42,949 |
| `0.01–0.05` (mild with) | 138 | 45% | -0.03 | -$191 |
| `flat` | 15 | 53% | +0.03 | +$301 |
| `< -0.05` (sharp against) | 1 | 0% | -4.05 | -$1,041 |

The mild/ambiguous-slope cohort (`0.01–0.05`) is the only large group with negative expectancy. **Skipping it would drop 138 trades for ~$0 portfolio impact** — not the home run, but a clean trade-count reducer.

**2. Personality × 1H slope reveals VOLATILE_RUNNER's edge concentrates on strong-slope entries.**

| Personality | strong slope (>0.1) | mild (0–0.1) | against |
|---|---|---|---|
| **VOLATILE_RUNNER** | 197 trades, **+1.31% avg, +$28.8k** | 85 trades, +0.69%, +$7.8k | **8 trades, -1.40%, -$1.7k** |
| PULLBACK_PLAYER | 44 trades, +0.41% | 117 trades, +0.40% | 4 trades, +1.13% |
| SLOW_GRINDER | 1 trade | 54 trades, **-0.12%, -$743** | 1 trade |
| MODERATE | 4 trades | 48 trades, +0.18% | 3 trades, +1.03% |

VOLATILE_RUNNER's bread-and-butter is **strong-slope continuation** (+$28.8k from 197 trades). PULLBACK_PLAYER doesn't care about slope — its edge is independent of trend strength. SLOW_GRINDER's mild-slope cohort is net-negative.

**3. Rolling-20 dist `< -1%` cohort (price extended *against* the rolling VWAP) is a tiny-but-strong WR cohort.** 13 trades, 69% WR, +$2,858. These are "snap-back" entries where price has already dipped below the recent VWAP. Too small to act on as a standalone gate but useful as a **bonus signal**.

## Re-prioritized list with VWAP additions

The Phase B-1 plan (P4 + S2 + S3) is unchanged. VWAP gives us a fourth low-risk candidate:

### New candidate — **S4: Block "weak-slope, no-other-edge" entries**

- **Rule**: skip an entry when `1H slope` is in `[0.01, 0.05]` AND `4H slope` is in `[0.01, 0.1]` AND there's no compensating signal (no premium-stack PDZ, no momentum_elite, no fresh-from-VWAP touch).
- **Estimated impact**: skips ~50–80 trades, saves ~$2–5k, won't hurt the bread-and-butter.
- **Risk**: low. The cohort already has near-zero expectancy in baseline; skipping it can only help PnL or trim trade count slightly.
- **Status**: needs a **small cross-check first** to confirm we're not double-blocking trades the existing entry-quality gate already filters.

### Optional — VWAP slope as a personality input (no new gate)

Personality × slope reveals SLOW_GRINDER × mild-slope (-$743 over 54 trades) as a structural negative — **but we already added the S3 personality-aware fast-cut grace for SLOW_GRINDER**. The exit-side fix likely captures this without an additional entry-side block.

## What the analysis tells us we DON'T need to add

- No "VWAP-against entry block" — too few trades qualify.
- No "VWAP-distance gate" using cumulative `dist_pct` — the metric is structurally broken for our use case (anchored too far back).
- No "VWAP-touch-recency gate" using `touch_bars` — saturated at the max bucket.
- No live VWAP cross-down exit signal yet — would be valuable for PROFIT_GIVEBACK protection but requires runtime VWAP cross detection that we don't currently emit.

## Recommendation

**Phase B-1 stays as P4 + S2 + S3.** Do not bundle VWAP work into Phase B-1.

**Add S4 as a Phase B-2 candidate** (with B1, B2, B3, B4 from the autopsy). The combined Phase B-2 batch will be:
- B1 (block strong adv-RSI div)
- B2 (block discount_approach LONG on VR/PB)
- B3 (block tt_n_test_resistance · SHORT)
- B4 (block tt_ath_breakout × MODERATE/SLOW_GRINDER)
- **S4 (block weak-slope ambiguous-context entries)**

## Stop-and-think check

The cumulative VWAP being anchored to dataset start is a **data plumbing observation worth fixing**. For exit-time decisions in live trading, we'd want session-anchored VWAP (resets each trading day). Our current capture is fine for forensic analysis of slope and rolling_20, but if we ever want to wire VWAP-cross as a live exit signal (which the PG-loss analysis suggests would be valuable), we need the cumulative VWAP to reset at each session open. Logging that as a backlog item.
