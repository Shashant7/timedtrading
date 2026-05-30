# Option-A Parity Spec (Jul 1 Focus)

Date: 2026-03-22
Target label: `option-a-rank-overhaul`
Primary artifact: `data/backtest-artifacts/option-a-rank-overhaul--20260309-202532/trade-autopsy-trades.json`
Historical code tag: `95417ae` (`v2-rank-overhaul-tt-core`)

## 1) What We Can Inspect at Entry Time

Yes, we can inspect the exact entry-time signals from the artifact rows.

For each trade, the artifact contains:
- `entry_ts`
- `entry_path`
- `signal_snapshot_json` (includes `avg_bias` and TF-level signal payload)
- `tf_stack_json`

This is enough to reconstruct a deterministic "entry fingerprint" per trade timestamp.

## 2) Jul 1 Entry Fingerprint Contract

The earliest Jul 1 sequence in the artifact is:

1. `CDNS` LONG @ `2025-07-01 13:30 UTC`
   - `entry_path`: `ripster_momentum`
   - `avg_bias`: `0.696`
   - TF bias: `10m 0.908`, `30m 0.886`, `1H 0.391`, `4H 0.820`, `D 0.548`
2. `ORCL` LONG @ `2025-07-01 13:45 UTC`
   - `entry_path`: `ripster_momentum`
   - `avg_bias`: `0.937`
   - TF bias: `10m 0.971`, `30m 0.929`, `1H 0.933`, `4H 0.868`, `D 0.970`
3. `CSX` LONG @ `2025-07-01 13:45 UTC`
   - `entry_path`: `ripster_momentum`
   - `avg_bias`: `0.787`
   - TF bias: `10m 0.650`, `30m 0.377`, `1H 0.875`, `4H 0.965`, `D 0.975`
4. `ITT` LONG @ `2025-07-01 14:15 UTC`
   - `entry_path`: `ripster_momentum`
   - `avg_bias`: `0.598`
   - TF bias: `10m 0.609`, `30m 0.376`, `1H 0.392`, `4H 0.448`, `D 0.976`

Operational contract for parity:
- First Jul 1 entries should include these symbols/timestamps with `entry_path=ripster_momentum`.
- Side should be LONG for these four.
- Bias magnitudes should be directionally similar (not exact floating-point equality).

## 3) Critical Artifact Constraint (Why Replays Drift)

`option-a-rank-overhaul` is not a single native run. It is an imported blend.

Observed composition:
- Total autopsy rows in artifact sample: `20`
- Distinct `run_id`s: `3`
  - `backtest_2025-07-01_2026-03-04@2026-03-09T04:30:58.006Z` (15 rows)
  - `backtest_2025-07-18_2026-03-04@2026-03-09T22:28:56.402Z` (4 rows)
  - `backtest_2025-07-17_2026-03-04@2026-03-09T12:33:04.032Z` (1 row)

Implication:
- Treat `option-a-rank-overhaul` as a curated portfolio artifact, not a single-run ground truth.
- Reproducing it 1:1 via one replay command is not expected without stitching behavior.

## 4) Code State Review: 95417ae vs Current

### A) Engine architecture changed materially
- In `95417ae`, entry logic is monolithic in `worker/index.js`.
- Current code uses dispatcher-style pipelines + dynamic engine resolution.
- At `95417ae`, `worker/pipeline/*` engine modules are not present in tree; now they are core runtime surfaces.

### B) Engine mapping semantics changed
- Historical behavior (from diff): `ripster_core` was mapped to `tt_core` in `resolveEngineMode`.
- Current behavior keeps `ripster_core` and `tt_core` distinct.

Impact:
- Running `ripster_core` today is not equivalent to historical `ripster_core` expectation from that tag.

### C) Dynamic engine rules exist now
- Current `qualifiesForEnter()` resolves via `resolveEntryEngine()` and can block with `dynamic_engine_blacklisted`.
- This path did not exist in the same form in the historical monolith.

Impact:
- `dynamic_engine_rules` cache/config can alter ticker-level dispatch even when ticker list is fixed.

### D) Replay pre-pipeline behavior changed
- Current code has replay-era pre-pipeline fields and gates (including pullback confirmation plumbing and universal/context gates).
- Current code includes a temporary diagnostic line:
  - `d.__pullback_confirmed = true; // TEMP: force pullback confirmed to diagnose zero-trade issue`

Impact:
- This can materially change path eligibility and divergence vs historical behavior.

## 5) Config Snapshot Gaps

- `backtest_run_config` does not contain rows for the source run IDs above.
- Imported run metadata (`backtest_runs`) has `params_json = null` for the stitched label.

Implication:
- We cannot recover a canonical full model_config snapshot directly from run registry for this artifact.
- Parity must use:
  1) artifact entry-time signal fingerprints, and
  2) historical code behavior deltas from `95417ae`.

## 6) Replication Contract (Operator-Ready)

To claim "Jul 1 parity":
- Use exact symbol subset for the first-window test: `CDNS, ORCL, CSX, ITT` (plus control symbols if needed).
- Start replay at Jul 1 RTH open and evaluate first 2-3 intervals.
- Require:
  - same side (LONG),
  - same `entry_path` family (`ripster_momentum`),
  - timestamp tolerance within one interval,
  - no alternate early substitutions (e.g., `AMZN/PH/KO` replacing all four).

If not met, inspect in this order:
1. `resolveEngineMode` + actual engine selected at runtime.
2. `dynamic_engine_rules` effect and cache reload.
3. Pre-pipeline pullback confirmation behavior.
4. Context/universal gates introduced post-`95417ae`.

## 7) Recommended Next Implementation Step

Add a one-shot "parity diagnostic" endpoint for Jul 1 that emits, per target ticker per interval:
- selected engine,
- `qualifiesForEnter` decision + reason,
- first failing gate name,
- chosen `entry_path` (if qualified),
- key snapshot fields (`avg_bias`, TF biases, RSI).

This will close the remaining gap faster than broad replay reruns.
