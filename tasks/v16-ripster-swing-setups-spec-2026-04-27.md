# V16: Ripster Swing-Setup Coverage Expansion

Created: 2026-04-27
Status: spec — implementation deferred to V16 cycle, after V15 P0.7.9
        baseline completes
Priority: P2 (edge expansion, not bug fix)

## Context

Ripster (@ripster47) publishes a 5-pattern Swing Setups framework that
maps cleanly to setup types we partially cover today. Our existing
engine is strongest on the "Uptrend Bounce on Key EMA" setup (which
is `tt_pullback` + EMA cloud-hold, the P0.6/P0.7 work). We're weak on
the 3 reversal setups, which are exactly where Ripster says "BEST
SETUP TIME WITH MARKET REVERSAL."

Adding these would expand coverage to setup families we currently miss
without trading off the clean-trend setups we already capture.

## Coverage audit (current state)

| Ripster Setup | Description | Our coverage |
|---|---|---|
| 1. Range Reversal | Buy bounce off range low, stops mid/lower-range | ❌ Not explicit. tt_pullback catches some. No range box detection. |
| 2. Tested Support N-Times | Buy Nth successful test of horizontal support | ⚠️ Partial. No N-test counter. |
| 3. Uptrend Bounce on EMA / 20EMA | Buy the dip to key EMA in clean uptrend | ✅ Strong. tt_pullback + cloud-hold. |
| 4. Breakout / Pocket Pivot at 52w/ATH | Tight base near highs, multibagger setup | ⚠️ Partial. tt_momentum catches breakouts; no 52w-proximity gate. |
| 5. Gap Reversal Best Setup | Gap-down that reverses higher | ❌ Not explicit. We currently BLOCK these via tt_momentum_unfilled_gap_open_chase. |

## P1 — Range Reversal trigger (Setup #1)

**Detection**:
- 20-day price range compression — high - low ≤ 1.5 × daily ATR
- OR Bollinger Bands width < 5th percentile of trailing 60 days
- Tag `tickerData.__in_range_box = true` when either fires

**Trigger**:
- Bullish: price within 0.25 ATR of 20-day low AND a 30m bullish reversal candle (hammer / engulfing) AND RVol > 1.0
- Bearish: mirror at the high

**Conviction boost**: +10 points to `focus_conviction.range_reversal_signal`
**Stop**: 0.5 ATR below the recent low (Ripster's "stops mid or lower ranges")
**Exit**: target the upper edge of the range (or +1.0 ATR from entry)

## P2 — N-Test Support Counter (Setup #2)

**Detection**:
- Maintain rolling list of "support touches" — times price came within
  0.25 × daily ATR of a horizontal level over last 30 days
- Group touches into clusters (within 0.5% price proximity)
- Count tests per cluster

**Trigger**: When N >= 3 AND latest test holds (close > test low + 0.1 ATR)

**Conviction boost**: +5 points + N-test bonus (`+2 × min(N, 5)`)
**Stop**: just below the support cluster (Ripster's "stops right under")

## P3 — 52-week / ATH proximity (Setup #4)

**Detection**:
- `pct_below_52wk_high < 1.5%` (within 1.5% of 52w high)
- OR ATH break (above all-time-high in our data)
- AND tight base — last 5-day range < 3% of price

**Conviction boost**: +5-10 points (especially for high-EPS-growth names)
**Trigger gate**: existing `tt_momentum` if breakout fires; but lower
the rvol threshold from 1.5 → 1.2 when in 52w-proximity zone (the
breakout itself is the catalyst).

## P4 — Gap Reversal (Setup #5)

**Detection**:
- Gap-down at open: `prev_close - open > 2%`
- Within first 30-60 min: `last_30m_close > open` (reclaimed)
- Volume confirmation: `RVol > 1.5`

**Trigger**: Long entry at the reclaim
**Conviction boost**: +10 points
**Stop**: below intraday low

**Currently blocked by**: `tt_pullback_late_session_unreclaimed` — needs
a carve-out: gap-reversal IS the entry signal, not late-session noise.

## Implementation plan

### Step 1 — Indicators (`worker/indicators.js`)

Add three new fields to `tickerData`:
- `range_box`: `{ high, low, atr, days_in_range, compressed }`
- `support_clusters`: array of `{ price, n_tests, last_test_ts }`
- `ath_proximity`: `{ pct_below_52wk_high, days_since_52wk_high, in_tight_base }`
- `gap_reversal`: `{ gap_pct, reclaimed_at_30m, rvol_at_open }`

### Step 2 — Conviction signals (`worker/focus-tier.js`)

Add 4 new signal-scoring functions:
- `scoreRangeReversal(tickerData, ctx)` — 0 to +10 pts
- `scoreNTestSupport(tickerData, ctx)` — 0 to +12 pts
- `scoreAthProximity(tickerData, ctx)` — 0 to +10 pts
- `scoreGapReversal(tickerData, ctx)` — 0 to +10 pts

Wire into `computeConvictionScore`. Adjust ceiling accordingly (+42 max)
and re-tune Tier A/B/C floors.

### Step 3 — Triggers (`worker/pipeline/tt-core-entry.js`)

Add 4 new entry path names:
- `tt_range_reversal`
- `tt_n_test_support`
- `tt_ath_breakout`
- `tt_gap_reversal`

Each gets its own gate logic + DA-keyed kill switch:
- `deep_audit_tt_range_reversal_enabled = true|false`
- `deep_audit_tt_n_test_support_enabled = ...`
- etc.

### Step 4 — Carve-outs

Modify `tt_pullback_late_session_unreclaimed` to skip when
`gap_reversal.reclaimed_at_30m === true` — the gap reversal IS the
late-session entry signal we want.

### Step 5 — Validation (mandatory per tasks/v16-validation-methodology)

For each new trigger:
1. Tag every V15 P0.7.9 baseline trade with whether the new trigger
   would have ALSO fired on it (counterfactual).
2. Identify trades that ONLY the new trigger would catch (incremental
   value).
3. Score the incremental cohort: WR, PnL, PF.
4. Ship only when WR >= 60% AND PF >= 2.5.

### Step 6 — Order-of-rollout

Suggest: P3 (ATH proximity) → P1 (range reversal) → P4 (gap reversal)
→ P2 (N-test support).

ATH proximity is the smallest + safest addition (just a conviction
boost on existing tt_momentum). Range reversal is medium complexity.
Gap reversal touches the carve-out logic so needs the most testing.
N-test support requires the most data infrastructure (rolling cluster
tracking).

## Risks

- **Reversal setups have lower base-rate WR** than continuation setups
  (Ripster himself notes "TIME WITH MARKET REVERSAL" — i.e. only fire
  in confirmed reversal regimes). We should gate the reversal triggers
  on `regime_class != TRENDING_HEALTHY` to avoid false signals in
  strong uptrends.
- **Conviction ceiling needs rebalance** — adding 4 × ~10pts = +40 to
  the score range. Without re-anchoring tier floors, current tiers
  could become trivially achievable.
- **Validation must be per-setup**, not aggregate. A setup with WR 50%
  PF 1.5 across 200 trades would pass an aggregate test but is
  net-zero edge.

## Filed under

- This file: `tasks/v16-ripster-swing-setups-spec-2026-04-27.md`
- Methodology: `tasks/v16-validation-methodology-2026-04-27.md`
- Referenced framework: Ripster `@ripster47` Swing Setups visual
  (5 patterns: Range Reversal, N-Test Support, Uptrend EMA Bounce,
   ATH Breakout, Gap Reversal)
