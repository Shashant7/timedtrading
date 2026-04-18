# Block-chain comparison

- **Baseline:** `data/trade-analysis/phase-d-slice-2025-08-v1/block_chain.jsonl`
- **Challenger:** `data/trade-analysis/phase-d-slice-2025-09-v1/block_chain.jsonl`
- Baseline rejected bars: **35,978**
- Challenger rejected bars: **36,015**
- Delta: **37** (negative means challenger rejects fewer bars; positive means more)

## Bar coverage

- Bars rejected by both: **0**
- Bars rejected by baseline only (challenger **passed** these): **35,978**
- Bars rejected by challenger only (newly blocked): **36,015**

## Transition matrix (top)

Counts the (baseline_reason, challenger_reason) pairs. `__PASSED__` means the bar cleared all gates in the challenger.
Only transitions with count ≥ 1 are shown; top 12.

| baseline_reason | challenger_reason | count |
| --- | --- | ---: |
| tt_bias_not_aligned | **__PASSED__** | 14231 |
| tt_pullback_not_deep_enough | **__PASSED__** | 8791 |
| tt_no_trigger | **__PASSED__** | 8630 |
| tt_momentum_30m_5_12_unconfirmed | **__PASSED__** | 1013 |
| tt_short_pullback_not_deep_enough | **__PASSED__** | 996 |
| da_short_rank_too_low | **__PASSED__** | 576 |
| tt_pullback_5_12_not_reclaimed | **__PASSED__** | 444 |
| rvol_dead_zone | **__PASSED__** | 368 |
| tt_pullback_non_prime_rank_selective | **__PASSED__** | 332 |
| ctx_short_daily_st_not_bear | **__PASSED__** | 210 |
| tt_ltf_st_opposed | **__PASSED__** | 116 |
| tt_momentum_ltf_fractured | **__PASSED__** | 111 |

## Per-cohort redistribution

| cohort | baseline_rejected | challenger_rejected | newly_passed | newly_blocked |
| --- | ---: | ---: | ---: | ---: |
| etf | 7,288 | 7,615 | 7,288 | 7,615 |
| t1_stocks | 10,486 | 11,613 | 10,486 | 11,613 |
| t2_stocks | 18,204 | 16,787 | 18,204 | 16,787 |
| all | 35,978 | 36,015 | 35,978 | 36,015 |

## Net reason deltas (challenger − baseline)

Negative = challenger blocks fewer bars on this reason (good if the proposal is meant to relax it). Positive = challenger blocks more (either the proposal is introducing a new gate or the bars that used to be rejected earlier in the chain are now falling through to this gate).

| reason | baseline | challenger | delta |
| --- | ---: | ---: | ---: |
| tt_bias_not_aligned | 14231 | 10270 | -3961 |
| tt_pullback_not_deep_enough | 8791 | 12266 | +3475 |
| tt_no_trigger | 8630 | 9988 | +1358 |
| tt_short_pullback_not_deep_enough | 996 | 464 | -532 |
| rvol_dead_zone | 368 | 225 | -143 |
| tt_momentum_30m_5_12_unconfirmed | 1013 | 895 | -118 |
| ctx_short_daily_st_not_bear | 210 | 97 | -113 |
| tt_ltf_st_opposed | 116 | 201 | +85 |
| tt_overheated_bear_div_phase_pending | 0 | 37 | +37 |
| tt_momentum_ltf_fractured | 111 | 139 | +28 |
| ctx_short_rank_low | 28 | 0 | -28 |
| tt_daily_st_conflict | 37 | 10 | -27 |

## How to interpret

- **Large `__PASSED__` counts for a specific baseline_reason** = the proposal successfully unblocked those bars at all downstream gates too. This is the signal we want.
- **Large transitions into a *different* reason** = the proposal only shifted bars from one gate to another; the `newly_passed` column will be small for the cohort and the proposal is *symptomatic*, not causal (the T6 failure mode).
- **Positive `delta` on a reason that wasn't touched by the proposal** = the proposal's upstream relaxation sent bars down-chain and they're getting caught there. Consider proposing a joint relaxation.
- **newly_blocked > 0 in any cohort** = the proposal introduced new rejections. Investigate before merging.
