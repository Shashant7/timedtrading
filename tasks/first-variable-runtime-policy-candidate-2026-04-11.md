# First Variable Runtime Policy Candidate [2026-04-11]

## Purpose

Prepare the first narrow, evidence-routed runtime policy candidate from the active `Jul -> Sep` savepoint without promoting it yet.

## Candidate Summary

- Candidate ID: `august_transitional_choppy_selective_v1`
- Evidence source: `data/regime-config-decision/jul-sep-savepoint-regime-evidence-20260411.json`
- Pressure zone: `2025-08`
- Policy bucket: `regime_overlay`
- Runtime carrier: `regime_params` via execution-profile adjustments in `worker/indicators.js`
- Status: `prepared_not_applied`

## Why This Surface

The August pressure cluster is concentrated in the runtime context already labeled by the engine as capital-protection mode:

- `choppy_selective + TRANSITIONAL + balanced + VOLATILE_RUNNER`: `4` trades, `-$824.48`
- `choppy_selective + TRANSITIONAL + balanced + PULLBACK_PLAYER`: `1` trade, `-$57.70`

That means the engine is already recognizing the bad neighborhood. The next step is not to invent a new adaptive layer, but to tighten the existing one on the correct surface.

`scenario_execution_policy` is not the preferred first carrier for this case because it matches exact scenario tuples and does not naturally express the execution-profile refinement we want. The cleaner route is to adjust the `choppy_selective` behavior package itself, which already flows into `regime_params`.

## Proposed Runtime Adjustment

Current `choppy_selective` profile in `worker/indicators.js`:

- `minHTFScoreAdj: 8`
- `minRRAdj: 0.4`
- `maxCompletionAdj: -0.1`
- `positionSizeMultiplierAdj: 0.7`
- `slCushionMultiplierAdj: 1.1`
- `requireSqueezeRelease: true`
- `defendWinnerBias: quick_defend`

Prepared candidate delta:

- `minHTFScoreAdj: 10`
- `minRRAdj: 0.55`
- `maxCompletionAdj: -0.15`
- `positionSizeMultiplierAdj: 0.6`
- `slCushionMultiplierAdj: 1.1`
- `requireSqueezeRelease: true`
- `defendWinnerBias: quick_defend`

## Intent

This candidate is deliberately narrow:

- It does not change the global baseline.
- It does not introduce ticker exceptions.
- It does not change the active profile selection logic.
- It only tightens selectivity and size once the engine has already decided the trade lives in the `choppy_selective` capital-protection regime.

## Expected Effect

The candidate is meant to reduce August-style transitional damage by:

- rejecting weaker continuation and reclaim attempts earlier
- demanding better reward-to-risk before entry
- cutting size in the exact context where the engine already believes capital protection should dominate

## Validation Plan

1. Run an August-isolated pressure-board replay from the frozen savepoint config with only this `choppy_selective` adjustment changed.
2. Verify whether the cluster led by `AGQ`, `PH`, `SWK`, `IESC`, and related transitional names improves without damaging July crown-jewel retention.
3. If the pressure board improves, rerun `Jul -> Sep` cumulatively.
4. If the board does not improve, keep the savepoint unchanged and split the next pass into either:
   - a profile overlay refinement, or
   - a true ticker-specific exception for `AGQ`

## Artifact

The machine-readable candidate package is stored at:

- `data/regime-config-decision/august-transitional-choppy-selective-candidate-v1-20260411.json`
