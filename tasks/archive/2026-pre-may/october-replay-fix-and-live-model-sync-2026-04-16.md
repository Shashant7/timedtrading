# October Replay Fix And Live Model Sync

Date: 2026-04-16

## Scope

This note records three things:

1. the replay scoring-freshness fix that was validated on the active October `FIX`
   proofs
2. the current October blocker state after removing replay bookkeeping noise
3. the live-model sync that aligned production `model_config` with the active
   tested package

## Code Change

File changed:

- `worker/index.js`

Behavioral fix:

- replay candle lanes now recompute `rank` / `score` from the freshly assembled
  interval payload before stage classification and entry gating

Why:

- `assembleTickerData()` spreads `existingData`, so replay intervals can inherit
  stale `rank` / `score` from the previous bar
- before this fix, replay only called `computeRank()` when rank/score were null
  or when stale carry entry state had just been cleared
- that let `qualifiesForEnter()` and downstream stage logic use stale carried
  scores even while the captured `rank_trace` already showed the true current
  score

## Evidence

### Before the fix

Focused carry proof:

- artifact:
  `data/backtest-artifacts/focused-sep26-oct15-fix-carryproof-v3-postdeploy--20260415-174022`

Observed mismatch on `2025-10-03` for `FIX:1759501800000`:

- stored `rank` / `score`: `83`
- `rank_trace.finalScore`: `72`
- state: `HTF_BULL_LTF_BULL`
- block reason: `tt_pullback_non_prime_rank_selective`

Interpretation:

- the replay payload being classified and gated was carrying a stale score even
  though the fresh trace already showed the real bar score

### After the fix

Fresh one-day isolation proof:

- artifact:
  `data/backtest-artifacts/focused-oct03-fix-isolation-v3-freshrank--20260415-174758`

Fresh Oct 1 -> Oct 3 isolation proof:

- artifact:
  `data/backtest-artifacts/focused-oct01-oct03-fix-isolation-v1-freshrank--20260415-174955`

Fresh Sep 26 -> Oct 3 carry proof:

- artifact:
  `data/backtest-artifacts/focused-sep26-oct03-fix-carryproof-v4-freshrank--20260415-175153`

All three now agree on the target bar:

- stored `rank` / `score`: `72`
- `rank_trace.finalScore`: `72`
- state: `HTF_BULL_LTF_BULL`
- block reason: `tt_pullback_non_prime_rank_selective`

Conclusion:

- the stale-score replay seam is fixed
- the remaining `FIX` problem is now a true strategy/state divergence, not a
  replay bookkeeping artifact

## Current October Blocker State

The replay bookkeeping cleanup leaves two separate realities:

### 1. The old positive October proof

Reference artifact:

- `data/backtest-artifacts/focused-oct-full-basket-proof-v1--20260415-120625`

At `2025-10-03`, `FIX` looked like:

- state: `HTF_BULL_LTF_PULLBACK`
- `htf_score`: `45.2`
- `ltf_score`: `-16.3`
- score: `93`
- trade opened as `FIX-1759501800000`

### 2. The current runtime after replay fix

Both fresh isolation and fresh carry proofs now agree that `FIX` at the same
timestamp is:

- state: `HTF_BULL_LTF_BULL`
- `htf_score`: `46.2`
- `ltf_score`: `6.2`
- score: `72`
- blocked by `tt_pullback_non_prime_rank_selective`

Interpretation:

- the stale-score bug was real, but it was not the whole October issue
- the remaining seam is upstream of replay bookkeeping:
  the active runtime is classifying the Oct 3 `FIX` branch as momentum/aligned
  instead of pullback/setup
- because of that state shift, the same bar no longer qualifies for the strong
  pullback branch that previously won in the October basket proof

## October Control Refresh

After the replay freshness fix, the October control itself had to be rerun before
using any old October winner as a repair target.

Refreshed control artifact:

- `data/backtest-artifacts/focused-oct-full-basket-proof-v2-freshrank--20260415-180911`

Headline result:

- old October proof (`v1`): `12` trades, `+1642.69`
- refreshed October proof (`v2`): `13` trades, `+837.40`

Diff vs the old October proof:

- matched trades: `11`
- missing trades: `1`
- spurious trades: `2`
- changed matches: `6`

The missing trade from the old proof was:

- `RIOT-1759345200000` (`+854.41`)

The old `FIX-1759501800000` winner also did not survive as an October control
trade. The refreshed control instead carried:

- `FIX-1760551200000`
- `FIX-1761674400000`

Interpretation:

- the old October proof should no longer be treated as an authoritative control
  artifact after the replay freshness repair
- both old marquee winners (`RIOT-1759345200000` and `FIX-1759501800000`) were
  likely benefiting from stale replay rank inflation rather than representing
  reproducible current-runtime behavior

Supporting evidence:

- refreshed `FIX:1759501800000` still computes to
  `HTF_BULL_LTF_BULL` / `rank=72` / blocked by
  `tt_pullback_non_prime_rank_selective`
- refreshed `RIOT:1759345200000` still computes to
  `HTF_BULL_LTF_PULLBACK` / `rank=83` / blocked by
  `tt_pullback_non_prime_rank_selective`
- the old autopsy snapshots for both trades still show near-identical
  directional structure and execution profile context, which means the large
  old ranks were not trustworthy repair targets once replay started recomputing
  scores correctly every interval

## Trustworthy October Composition Baseline

Once the refreshed October control became the reference, the honest question was
no longer "how do we restore the old October proof?" but "where does the
cumulative Jul -> Oct lane still diverge from the fresh October control?"

Comparison:

- reference:
  `data/backtest-artifacts/focused-oct-full-basket-proof-v2-freshrank--20260415-180911`
- candidate:
  `data/backtest-artifacts/focused-jul-oct-cumulative-julsep-anchor-v4-c512revert-rerun--20260415-065321`
- diff artifact:
  `data/backtest-artifacts/focused-jul-oct-cumulative-julsep-anchor-v4-c512revert-rerun--20260415-065321/oct-v2-control-drift.json`

Headline drift:

- October control: `13` trades, `+837.40`
- Jul -> Oct cumulative October slice: `11` trades, `-546.77`
- matched trades: `11 / 13`
- missing trades: `2`
- spurious trades: `0`

Missing control trades in the cumulative lane:

- `ETN-1760022000000`
- `FIX-1761674400000`

Largest matched-trade damage vs refreshed October control:

- `AGQ`: `-893.11`
- `FIX`: `-582.26`
- `ON`: `-189.48`

What this means:

- the true October composition blockers are now the cumulative path/management
  drifts in `AGQ`, `FIX`, and `ON`
- `RIOT` is still useful as a replay/selectivity sanity check, but it is no
  longer the primary composition target once the stale-proof October control is
  retired

## Live Model Sync

Tested package used as the live target:

- config artifact:
  `data/backtest-artifacts/focused-jul-oct-cumulative-julsep-anchor-v4-c512revert-rerun--20260415-065321/model-config.json`

Deployed code:

- worker deployed to default and production on 2026-04-16

Live `model_config` check before sync:

- artifact keys: `144`
- live keys: `136`
- artifact-only keys: `8`
- changed keys: `9`

Changed keys before sync:

- `adaptive_entry_gates`
- `adaptive_rank_weights`
- `adaptive_sl_tp`
- `consensus_signal_weights`
- `consensus_tf_weights`
- `dynamic_engine_rules`
- `reference_execution_map`
- `scenario_execution_policy`
- `scoring_weight_adj`

Artifact-only keys before sync:

- `deep_audit_min_minutes_since_entry_before_exit_min`
- `deep_audit_pullback_bull_state_ltf_conflict_avg_bias_max`
- `deep_audit_pullback_bull_state_ltf_conflict_guard_enabled`
- `deep_audit_reference_exact_entry_leniency`
- `deep_audit_reference_exact_tolerance_minutes`
- `deep_audit_repeat_churn_guard_enabled`
- `deep_audit_repeat_churn_guard_include_tickers`
- `golden_julaug_reference_run_id`

Sync action:

- wrote the tested artifact config directly into the remote
  `timed-trading-ledger` `model_config` table through `wrangler d1 execute`

Verification after sync:

- artifact keys: `144`
- live keys: `144`
- artifact-only keys: `0`
- live-only keys: `0`
- changed keys: `0`

Conclusion:

- the live model config now matches the latest tested package exactly
- current live drift, if any, should now come from future code/config edits, not
  from an old production config state

## Next Technical Target

The next October fix should focus on cumulative drift against the refreshed
October control, not on restoring the stale pre-refresh October proof.

Concrete objective:

- use the refreshed October proof as the authoritative month control
- classify the cumulative Jul -> Oct damage by real control misses:
  `AGQ`, `FIX`, `ON`, plus the missing `ETN` / later `FIX` control trades
- avoid strategy work whose only goal is to recreate
  `RIOT-1759345200000` or `FIX-1759501800000` from the stale October `v1`
  artifact

Likely surfaces:

- `worker/indicators.js`
- `worker/index.js`
- `worker/pipeline/tt-core-entry.js`
- `worker/pipeline/tt-core-exit.js` or equivalent runner-management surfaces

Promotion rule:

- do not widen past October until the refreshed October control and the
  cumulative lane are reconciled on the real blocker set, then revalidated on
  the cumulative lane
