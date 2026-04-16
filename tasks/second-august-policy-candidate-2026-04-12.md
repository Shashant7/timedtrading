# Second August Policy Candidate [2026-04-12]

## Purpose

Define the next August recovery candidate now that the AGQ replay lifecycle parity bug is fixed and the focused proof can be trusted again.

## Status

- Candidate ID: `agq_august_pullback_exception_v2`
- Status: `prepared_not_applied`
- Policy bucket: `ticker_exception`
- Pressure zone: `2025-08`
- Active surface: existing `tt_core` long-pullback guard family in `worker/pipeline/tt-core-entry.js`

## Why The First Surface Is Rejected

The first August candidate tightened the broad `choppy_selective` profile on the approved regime/profile surface and produced no meaningful change.

With AGQ lifecycle parity now repaired, that no-op can no longer be blamed on replay drift. The remaining August damage is real strategy behavior, not archive/finalize noise.

That means the next pass should not retry a wider `choppy_selective` scalar adjustment. The broad surface is too coarse.

## Why The Next Surface Is Ticker-Specific

The repaired savepoint now shows:

- `AGQ-1754678400000` on Aug 8 is a real `LOSS` at `-3.98%`
- `AGQ-1755273000000` on Aug 15 is a real `LOSS` at `-3.65%`
- `AGQ-1756129200000` on Aug 25 is a real `WIN` that exits naturally in early September

All three trades route through `tt_pullback`, and all three were seen under the August capital-protection neighborhood. But the winner is structurally different from the two losers in a way that a broad regime/profile scalar cannot express cleanly.

## Evidence Summary

### Aug 8 loser: `AGQ-1754678400000`

- `execution_profile`: `choppy_selective`
- `regime_class`: `TRANSITIONAL`
- `avg_bias`: `0.497`
- `entry_quality_score`: `64`
- `overnight_gap.fullGapFilled`: `true`
- `overnight_gap.priceVsOpenPct`: `-0.301`
- `overnight_gap.barsSinceOpen`: `31`
- `15m` is bearish while `30m/1H/4H/D` are mostly still bullish
- Daily `supertrend` is still negative

Interpretation: this is a late, already-filled-gap pullback entry with weak local structure even though higher timeframes still look acceptable.

### Aug 15 loser: `AGQ-1755273000000`

- `execution_profile`: `choppy_selective`
- `regime_class`: `TRANSITIONAL`
- `avg_bias`: `-0.008`
- `consensus_direction`: `null`
- `entry_quality_score`: `77`
- `overnight_gap.fullGapFilled`: `true`
- `overnight_gap.priceVsOpenPct`: `0.622`
- `overnight_gap.barsSinceOpen`: `14`
- `30m` and `1H` are bearish at entry
- `1H` cross is down with age `0`
- ORB shows `breakout: LONG` and `holdingAbove: true`, but the broader lower-TF stack is still countertrend

Interpretation: this is the cleaner AGQ failure shape. The trade entered inside `choppy_selective` with effectively no consensus edge and still-lower-timeframe opposition.

### Aug 25 winner: `AGQ-1756129200000`

- `execution_profile`: `choppy_selective`
- `regime_class`: `CHOPPY`
- `avg_bias`: `0.676`
- `consensus_direction`: `LONG`
- `entry_quality_score`: `66`
- `overnight_gap.fullGapFilled`: `false`
- `overnight_gap.priceVsOpenPct`: `0.544`
- `overnight_gap.barsSinceOpen`: `1`
- `30m/1H/4H/D` are all bullish
- Bull divergence support is present on `4H`

Interpretation: this is early, directional, and structurally supported. Any second candidate that blocks this branch is too blunt.

## Surface Selection

Do not use these as the next carrier:

- `scenario_execution_policy`: too tuple-oriented; good for engine/management routing, not this exact entry filter
- ticker `runtime_policy`: current `guard_bundle` options are too coarse (`reclaim_confirmation`, `reversal_confirmation`, `orb_defensive`, etc.)
- another broad `choppy_selective` scalar adjustment: already tested and rejected as a no-op

Use this surface instead:

- the existing `tt_core` long-pullback guard family in `worker/pipeline/tt-core-entry.js`
- implemented as a config-backed, ticker-scoped refinement so the exception remains narrow and reversible

## Prepared Candidate

Prepare one narrow `AGQ` exception package with two clauses.

### Clause A: weak-consensus counter-LTF pullback

Block `AGQ` long pullbacks when all of the following are true:

- execution profile is still capital-protection context (`choppy_selective`)
- no reclaim / continuation confirmation is present
- `avg_bias <= 0.10`
- `consensus_direction != LONG`
- `30m` and `1H` are still countertrend bearish, or equivalent lower-TF countertrend structure is true

Intent: block the Aug 15 branch without touching the Aug 25 winner.

### Clause B: late filled-gap weak-support pullback

Block `AGQ` long pullbacks when all of the following are true:

- execution profile is `choppy_selective`
- overnight gap has already fully filled
- entry occurs late enough to be a mature intraday pullback (`barsSinceOpen >= 20`)
- price is still below the open at entry
- entry quality remains sub-premium (`entry_quality_score < 70`)
- the lower timeframe remains fractured rather than cleanly reclaimed

Intent: catch the Aug 8 branch without requiring a broader rule that would threaten the Aug 25 winner.

## Why This Candidate Is Narrow Enough

- It does not downgrade global `tt_pullback`
- It does not re-tune all `TRANSITIONAL` names
- It does not alter `choppy_selective` sizing/scalars again
- It only targets one ticker and only inside the already-identified August failure family

## Validation Plan

1. Apply the `AGQ` pullback exception behind config keys or a small ticker include list on the existing guard seam.
2. Run an `AGQ` focused August proof first to confirm both Aug 8 and Aug 15 losses are removed while Aug 25 remains.
3. If the focused proof is green, rerun the August pressure board.
4. Only then decide whether the candidate earns a cumulative `Jul -> Sep` rerun.

## Promotion Rule

Reject the candidate immediately if it removes `AGQ-1756129200000` or materially harms unrelated August names. This pass is allowed to be narrow; it is not allowed to become another blunt regime/profile change.
