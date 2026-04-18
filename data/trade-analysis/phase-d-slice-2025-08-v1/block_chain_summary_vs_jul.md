# Block-chain comparison

- **Baseline:** `data/trade-analysis/phase-c-cleanslate-regression-v1/block_chain.jsonl`
- **Challenger:** `data/trade-analysis/phase-d-slice-2025-08-v1/block_chain.jsonl`
- Baseline rejected bars: **28,390**
- Challenger rejected bars: **35,978**
- Delta: **7,588** (negative means challenger rejects fewer bars; positive means more)

## Bar coverage

- Bars rejected by both: **0**
- Bars rejected by baseline only (challenger **passed** these): **28,390**
- Bars rejected by challenger only (newly blocked): **35,978**

## Transition matrix (top)

Counts the (baseline_reason, challenger_reason) pairs. `__PASSED__` means the bar cleared all gates in the challenger.
Only transitions with count ≥ 1 are shown; top 15.

| baseline_reason | challenger_reason | count |
| --- | --- | ---: |
| tt_no_trigger | **__PASSED__** | 10856 |
| tt_pullback_not_deep_enough | **__PASSED__** | 6542 |
| tt_bias_not_aligned | **__PASSED__** | 4686 |
| tt_momentum_30m_5_12_unconfirmed | **__PASSED__** | 1637 |
| rvol_dead_zone | **__PASSED__** | 1388 |
| tt_pullback_non_prime_rank_selective | **__PASSED__** | 973 |
| tt_pullback_5_12_not_reclaimed | **__PASSED__** | 880 |
| tt_short_pullback_not_deep_enough | **__PASSED__** | 418 |
| da_short_rank_too_low | **__PASSED__** | 264 |
| tt_ltf_st_opposed | **__PASSED__** | 260 |
| tt_momentum_ltf_fractured | **__PASSED__** | 220 |
| ctx_short_daily_st_not_bear | **__PASSED__** | 92 |
| tt_pullback_late_session_unreclaimed | **__PASSED__** | 60 |
| tt_pullback_correction_transition_hot_extension | **__PASSED__** | 19 |
| tt_pullback_ema_bounce_unreclaimed_bear_clouds | **__PASSED__** | 18 |

## Per-cohort redistribution

| cohort | baseline_rejected | challenger_rejected | newly_passed | newly_blocked |
| --- | ---: | ---: | ---: | ---: |
| etf | 7,347 | 7,288 | 7,347 | 7,288 |
| t1_stocks | 7,674 | 10,486 | 7,674 | 10,486 |
| t2_stocks | 13,369 | 18,204 | 13,369 | 18,204 |
| all | 28,390 | 35,978 | 28,390 | 35,978 |

## Net reason deltas (challenger − baseline)

Negative = challenger blocks fewer bars on this reason (good if the proposal is meant to relax it). Positive = challenger blocks more (either the proposal is introducing a new gate or the bars that used to be rejected earlier in the chain are now falling through to this gate).

| reason | baseline | challenger | delta |
| --- | ---: | ---: | ---: |
| tt_bias_not_aligned | 4686 | 14231 | +9545 |
| tt_pullback_not_deep_enough | 6542 | 8791 | +2249 |
| tt_no_trigger | 10856 | 8630 | -2226 |
| rvol_dead_zone | 1388 | 368 | -1020 |
| tt_pullback_non_prime_rank_selective | 973 | 332 | -641 |
| tt_momentum_30m_5_12_unconfirmed | 1637 | 1013 | -624 |
| tt_short_pullback_not_deep_enough | 418 | 996 | +578 |
| tt_pullback_5_12_not_reclaimed | 880 | 444 | -436 |
| da_short_rank_too_low | 264 | 576 | +312 |
| tt_ltf_st_opposed | 260 | 116 | -144 |
| ctx_short_daily_st_not_bear | 92 | 210 | +118 |
| tt_momentum_ltf_fractured | 220 | 111 | -109 |
| tt_pullback_late_session_unreclaimed | 60 | 20 | -40 |
| tt_daily_st_conflict | 2 | 37 | +35 |
| tt_pullback_agq_weak_consensus_counter_ltf | 0 | 20 | +20 |

## How to interpret

- **Large `__PASSED__` counts for a specific baseline_reason** = the proposal successfully unblocked those bars at all downstream gates too. This is the signal we want.
- **Large transitions into a *different* reason** = the proposal only shifted bars from one gate to another; the `newly_passed` column will be small for the cohort and the proposal is *symptomatic*, not causal (the T6 failure mode).
- **Positive `delta` on a reason that wasn't touched by the proposal** = the proposal's upstream relaxation sent bars down-chain and they're getting caught there. Consider proposing a joint relaxation.
- **newly_blocked > 0 in any cohort** = the proposal introduced new rejections. Investigate before merging.
