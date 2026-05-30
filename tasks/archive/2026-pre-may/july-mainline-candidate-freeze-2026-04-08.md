# July Mainline Candidate Freeze - 2026-04-08

## Purpose

Freeze the exact July recovery candidate that should be used for the next clean validation lane on `main`.

This file exists to answer one question clearly:

What package are we actually validating before any broader `Jul -> Apr` promotion work?

## Frozen Candidate Identity

- Current `main` workspace revision: `24f03510099b83b1726fcd515cc52417bbb2acec`
- Behavior anchor SHA: `422b606d85178c2b862b3606ebd4457462ff32d3`
- Pinned config artifact:
  `data/backtest-artifacts/focused-july-core-iter1-entrytrim--20260405-021006/model-config.json`
- Acceptable equivalent config artifact:
  `data/backtest-artifacts/focused-grny-july-telemetry-firsttrim-gate-v6-stall-shield-loosened--20260405-193111/model-config.json`

## What This Freeze Includes

### 1. Base July behavior anchor

Preserve the savepoint behavior documented in:

- `tasks/july-recovery-savepoint-2026-04-05.md`
- `tasks/july-recovery-candidate-package-2026-04-06.md`

### 2. Approved later lifecycle overlay

Keep the validated `GRNY` lifecycle/export refinements documented in:

- `tasks/july-recovery-iteration-log.md`

Named overlay items:

- `early-trim-first-gate`
- `smart-runner-bootstrap-trim`
- `grny-journey-td-handoff-v2`
- `replay-trim-persistence-and-logical-dedup`
- `grny-post-trim-td-cooling-window`
- `grny-td-runner-safety-net-v2`
- `first-trim-maturity-guard-v2`
- `first-trim-direct-bypass-guards`

Primary surfaces:

- `worker/index.js`
- `scripts/export-focused-run-artifacts.js`

### 3. Validated July runtime fix

Keep the focused `INTU/JCI` runtime fixes documented in:

- `tasks/july-recovery-savepoint-2026-04-07-intu-jci-runtimefix.md`

Specifically:

- speculative long counter-trend pullbacks require structural reclaim confirmation
- replay `openPositionContext` carries canonical MFE/MAE/trim state plus trade back-reference

Primary surfaces:

- `worker/pipeline/tt-core-entry.js`
- `worker/index.js`

### 4. Hardening-safe `main` work

Keep hardening-safe surfaces already classified in:

- `tasks/july-mainline-merge-matrix-2026-04-06.md`

Including:

- run-manifest and active-run truth
- read models
- lifecycle seam
- profile resolution
- regime vocabulary
- replay/backtest orchestration improvements

## What This Freeze Explicitly Excludes

These changes are not part of the frozen July candidate unless separately validated later:

- weak-context long entry suppression (`tt_weak_context_rank_inflation_guard`)
- weak-context short momentum suppression (`tt_weak_short_context_quality_guard`)
- mirrored short pullback bull-reclaim hard reject from the Sep-Dec experiment branch
- short selective pullback rank gate added during the same unresolved branch
- any claim that the over-pruning Sep-Dec weak-context experiments are now part of the trusted July package

Reason:

- those guards were part of the unresolved `CRM` / `AA` / `SANM` refinement branch
- they helped suppress bad later-window trades, but also over-pruned legitimate survivors
- `v3` collapsing to `0` trades means they are not safe to carry into the July acceptance-control package

## Current Candidate Diff Surfaces Vs The July Anchor

Compared with `422b606...`, the current candidate package still differs materially in:

- `worker/index.js`
- `worker/pipeline/tt-core-entry.js`
- `worker/pipeline/tt-core-exit.js`
- `scripts/export-focused-run-artifacts.js`

Working interpretation:

- `worker/index.js` contains both hardening-safe changes and the approved July/GRNY/INTU-JCI behavior fixes
- `worker/pipeline/tt-core-entry.js` is now reduced to the validated `INTU/JCI` fix plus trace hooks, with the unresolved weak-context experiment guards removed
- `worker/pipeline/tt-core-exit.js` still carries the `ripster_72_89_1h_deferred_structure_reclaim` behavior-sensitive fix and should remain in the validation candidate unless July evidence disproves it
- `scripts/export-focused-run-artifacts.js` keeps the validated logical-dedupe and lifecycle trim-resolution behavior

## Validation Lane That Must Run Next

Launch a clean July focused control lane on this frozen package before any wider rerun.

First inspection basket:

- `RIOT`
- `GRNY`
- `FIX`
- `SOFI`
- `CSCO`
- `SWK`

## Working Rule

Until a clean July control lane says otherwise, this is the exact package that should be treated as the current best July candidate on `main`.
