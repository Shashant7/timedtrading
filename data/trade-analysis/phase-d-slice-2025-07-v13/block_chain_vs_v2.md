# Block-chain comparison

- **Baseline:** `/workspace/data/trade-analysis/phase-d-slice-2025-07-v13/block_chain.jsonl`
- **Challenger:** `/workspace/data/trade-analysis/phase-d-slice-2025-07-v2/block_chain.jsonl`
- Baseline rejected bars: **36,189**
- Challenger rejected bars: **35,177**
- Delta: **-1,012** (negative means challenger rejects fewer bars; positive means more)

## Bar coverage

- Bars rejected by both: **32,060**
- Bars rejected by baseline only (challenger **passed** these): **4,129**
- Bars rejected by challenger only (newly blocked): **3,117**

## Transition matrix (top)

Counts the (baseline_reason, challenger_reason) pairs. `__PASSED__` means the bar cleared all gates in the challenger.
Only transitions with count ≥ 1 are shown; top 30.

| baseline_reason | challenger_reason | count |
| --- | --- | ---: |
| focus_conviction_below_floor | focus_conviction_below_floor | 10227 |
| h3_consensus_below_min | h3_consensus_below_min | 6017 |
| focus_tier_c_below_c_floor | focus_conviction_below_floor | 1632 |
| tt_d_ema_long_overextended | tt_d_ema_long_overextended | 1400 |
| h3_short_blocked_in_uptrend | h3_short_blocked_in_uptrend | 1210 |
| tt_pullback_not_deep_enough | tt_pullback_not_deep_enough | 1091 |
| focus_tier_c_below_c_floor | focus_tier_c_below_c_floor | 1000 |
| tt_no_trigger | tt_no_trigger | 914 |
| rvol_dead_zone | rvol_dead_zone | 745 |
| phase_i_reentry_throttle | **__PASSED__** | 628 |
| v15_veto_all_signals_oppose | v15_veto_all_signals_oppose | 585 |
| focus_conviction_below_floor | **__PASSED__** | 578 |
| phase_i_reentry_throttle | phase_i_reentry_throttle | 546 |
| tt_bias_not_aligned | tt_bias_not_aligned | 525 |
| h3_consensus_below_min | **__PASSED__** | 508 |
| h3_consensus_below_min | da_ticker_blacklisted | 507 |
| focus_tier_c_below_c_floor | **__PASSED__** | 467 |
| tt_cohort_slope_too_flat | tt_cohort_slope_too_flat | 459 |
| index_model_stock_path_blocked | **__PASSED__** | 408 |
| tt_pullback_not_deep_enough | **__PASSED__** | 371 |
| h3_consensus_below_min | phase_i_reentry_throttle | 370 |
| phase4_paused_gap_reversal_long | phase4_paused_gap_reversal_long | 276 |
| tt_cohort_extension_too_wide | tt_cohort_extension_too_wide | 256 |
| earnings_cluster_entry_block | h3_consensus_below_min | 245 |
| focus_tier_c_below_c_floor | h3_consensus_below_min | 243 |
| earnings_cluster_entry_block | phase_i_reentry_throttle | 243 |
| tt_pullback_not_deep_enough | da_ticker_blacklisted | 228 |
| rvol_dead_zone | **__PASSED__** | 221 |
| phase_c_loop2_breaker | **__PASSED__** | 215 |
| earnings_cluster_high_rank_member_block | **__PASSED__** | 207 |

## Per-cohort redistribution

| cohort | baseline_rejected | challenger_rejected | newly_passed | newly_blocked |
| --- | ---: | ---: | ---: | ---: |
| etf | 5,214 | 3,579 | 1,635 | 0 |
| t1_stocks | 9,635 | 10,618 | 415 | 1,398 |
| all | 36,189 | 35,177 | 4,129 | 3,117 |

## Net reason deltas (challenger − baseline)

Negative = challenger blocks fewer bars on this reason (good if the proposal is meant to relax it). Positive = challenger blocks more (either the proposal is introducing a new gate or the bars that used to be rejected earlier in the chain are now falling through to this gate).

| reason | baseline | challenger | delta |
| --- | ---: | ---: | ---: |
| focus_conviction_below_floor | 11091 | 13631 | +2540 |
| focus_tier_c_below_c_floor | 3431 | 1328 | -2103 |
| da_ticker_blacklisted | 0 | 1463 | +1463 |
| earnings_cluster_entry_block | 1015 | 0 | -1015 |
| index_model_stock_path_blocked | 668 | 0 | -668 |
| tt_pullback_not_deep_enough | 2003 | 1669 | -334 |
| earnings_cluster_high_rank_member_block | 324 | 0 | -324 |
| tt_cohort_sector_etf_paused | 0 | 306 | +306 |
| tt_cohort_slope_too_flat | 838 | 578 | -260 |
| rvol_dead_zone | 966 | 774 | -192 |
| phase_c_loop2_breaker | 242 | 52 | -190 |
| h3_consensus_below_min | 7512 | 7330 | -182 |
| h3_short_blocked_in_uptrend | 1464 | 1289 | -175 |
| phase_i_reentry_throttle | 1741 | 1893 | +152 |
| tt_no_trigger | 1329 | 1208 | -121 |
| tt_bias_not_aligned | 562 | 620 | +58 |
| tt_cohort_extension_too_wide | 256 | 305 | +49 |
| tt_momentum_30m_5_12_unconfirmed | 105 | 77 | -28 |
| da_short_rank_too_low | 3 | 29 | +26 |
| tt_d_ema_long_overextended | 1465 | 1446 | -19 |
| tt_pullback_non_prime_rank_selective | 167 | 183 | +16 |
| tt_pullback_5_12_not_reclaimed | 67 | 51 | -16 |
| v15_veto_all_signals_oppose | 585 | 597 | +12 |
| tt_pullback_late_session_unreclaimed | 12 | 5 | -7 |
| tt_momentum_ltf_fractured | 11 | 6 | -5 |
| tt_momentum_impulse_chase | 2 | 5 | +3 |
| tt_pullback_correction_transition_hot_extension | 4 | 7 | +3 |
| phase4_paused_gap_reversal_long | 324 | 323 | -1 |
| tt_momentum_r5_correction_transition_biased | 2 | 2 | 0 |

## How to interpret

- **Large `__PASSED__` counts for a specific baseline_reason** = the proposal successfully unblocked those bars at all downstream gates too. This is the signal we want.
- **Large transitions into a *different* reason** = the proposal only shifted bars from one gate to another; the `newly_passed` column will be small for the cohort and the proposal is *symptomatic*, not causal (the T6 failure mode).
- **Positive `delta` on a reason that wasn't touched by the proposal** = the proposal's upstream relaxation sent bars down-chain and they're getting caught there. Consider proposing a joint relaxation.
- **newly_blocked > 0 in any cohort** = the proposal introduced new rejections. Investigate before merging.
