# Jul-Apr Month-By-Month Execution Plan

Date: 2026-04-16

## Goal

Produce one authentic, full-universe `2025-07-01 -> 2026-04-03` backtest package
that can serve as:

- the public proof package for the strategy
- the official live model baseline
- the future comparison anchor for all later changes

## Current Status

What is true now:

- the live worker code is deployed to both environments
- the live `model_config` now matches the active tested Jul->Oct package exactly
- the replay stale-score seam is fixed and documented
- the remaining October blocker is a real strategy/state issue, not replay
  bookkeeping noise
- the month-compounding ladder remains the correct operating model

## Hard Rules

1. One authoritative lane at a time.
2. No widening past a failed month-compounding gate.
3. Every lane uses a frozen config artifact and frozen dataset contract.
4. Focused proofs are diagnostic only until the equal-scope or full-scope lane
   confirms the result.
5. The full-universe Jul->Apr run is the late promotion gate, not the first
   debugging tool.

## Execution Plan

### Phase 1: Clear October honestly

Objective:

- remove the last known October composition blocker before any November widening

Steps:

1. Freeze the current October state as:
   - replay freshness fixed
   - live model synced
   - active blocker = `FIX` state/setup divergence on `2025-10-03`
2. Trace the `FIX` seam from fresh artifacts:
   - compare the winning October proof state inputs against the fresh runtime
   - identify which upstream component changes `FIX` from
     `HTF_BULL_LTF_PULLBACK` / `93`
     to `HTF_BULL_LTF_BULL` / `72`
3. Implement the smallest fix that restores the correct October branch without
   reintroducing July-September drift.
4. Re-run focused proofs:
   - `FIX` isolation
   - `FIX` carry proof
   - `RIOT` regression guard proof if needed
5. Re-run the controlled `Jul -> Oct` lane and require:
   - July preservation
   - `Jul -> Sep` preservation
   - non-negative October composition

### Phase 2: Resume widening one month at a time

Objective:

- continue from October to April without losing proof quality

For each new month from November through April:

1. Run month isolation on the active accepted parent package.
2. Classify losses into:
   - baseline
   - regime
   - profile
   - ticker-specific
3. If the month is acceptable, run the cumulative lane from July through that
   month.
4. Require the prior accepted cumulative savepoint to remain intact.
5. If the month fails composition, stop widening and repair that month before
   continuing.

Required output for each month:

- artifact bundle
- missing vs spurious trade diff
- winner-retention review
- loser-compression review
- short written decision: pass, hold, or repair

### Phase 3: Full-universe proof run

Objective:

- produce the final authentic strategy proof package

Entry condition:

- controlled basket month-by-month ladder is clean through April

Steps:

1. Freeze the accepted code revision.
2. Freeze the accepted config artifact.
3. Freeze the full-universe run contract:
   - date window
   - ticker universe
   - interval
   - clean-slate mode
   - artifact output
4. Launch the full-universe `Jul -> Apr` run.
5. Archive:
   - run metrics
   - full trade set
   - config snapshot
   - monthly summaries
   - promotion report

### Phase 4: Final live-model promotion

Objective:

- make the proven package the official production baseline

Steps:

1. Compare the full-universe proof run against the current live package.
2. Confirm the final package passes the promotion checklist.
3. Deploy worker code if any final code drift exists.
4. Push the exact final config snapshot into live `model_config`.
5. Record the final official package:
   - git commit SHA
   - config artifact path
   - run id
   - artifact directory
   - promotion date

## Immediate Next Actions

These are the next concrete moves from this plan:

1. Commit the replay freshness fix and documentation.
2. Keep the live model pinned to the active Jul->Oct tested config.
3. Trace and repair the `FIX` Oct 3 state/classification seam.
4. Re-run `Jul -> Oct` on the controlled basket.
5. Only after that pass, move to November isolation.

## Success Condition

This plan is complete when we have all of the following:

- one accepted month-by-month chain from July through April
- one full-universe final backtest artifact
- one matching live code + live config package
- one documented official baseline package that can be referenced publicly and
  internally as the strategy proof set
