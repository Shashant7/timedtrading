# Jul->Apr Recovery And Promotion Plan

Date: 2026-04-08

## Final Objective

Produce one full `2025-07-01 -> 2026-04-03` backtest package that is:

- behaviorally anchored to the proven July recovery package
- reproducible from a frozen manifest and pinned config
- validated month-by-month before widening scope
- promotion-eligible under one explicit go/no-go standard
- preserved as a named artifact bundle so future work compares against a stable baseline instead of a moving live lane

## This Is Now The Authoritative Recovery Reference

Use this document as the primary operating plan for the current recovery effort.

Supporting references:

- `CONTEXT.md`
- `tasks/PLAN.md`
- `tasks/todo.md`
- `tasks/jul-sep-savepoint-2026-04-11-postdeploy.md`
- `tasks/month-compounding-operating-model-2026-04-11.md`
- `tasks/variable-evidence-matrix-contract-2026-04-11.md`
- `tasks/variable-runtime-policy-map-2026-04-11.md`
- `tasks/ticker-focused-learning-loop-2026-04-11.md`
- `tasks/july-mainline-reconciliation-plan-2026-04-06.md`
- `tasks/july-mainline-merge-matrix-2026-04-06.md`
- `tasks/july-recovery-candidate-package-2026-04-06.md`
- `tasks/july-recovery-savepoint-2026-04-05.md`
- `tasks/july-recovery-savepoint-2026-04-07-intu-jci-runtimefix.md`
- `tasks/system-contract-package-2026-04-05.md`
- `tasks/lessons.md`
- `data/regime-config-decision/baseline-vs-current-comparison-20260407.md`
- `tasks/regime-config-decision-implementation-2026-04-07.md`
- `docs/promotion-checklist-v1.md`

## Authoritative Baseline Package

### Code anchor

- Savepoint SHA: `422b606d85178c2b862b3606ebd4457462ff32d3`

### Config anchor

- Savepoint config artifact:
  `data/backtest-artifacts/focused-july-core-iter1-entrytrim--20260405-021006/model-config.json`

### Base savepoint evidence

- Savepoint run:
  `focused_replay_20260405-021006@2026-04-05T06:10:07.510Z`
- Savepoint artifact:
  `data/backtest-artifacts/focused-july-core-iter1-entrytrim--20260405-021006`

This savepoint restored the large `RIOT` runner and is the behavioral base branch of the current recovery effort, not yet the final promoted lane.

## Current Cumulative Savepoint

Before the next variable-aware recovery cycle, use the latest postdeploy `Jul -> Sep` lane as the active cumulative checkpoint:

- Savepoint run:
  `focused_replay_20260411-082805@2026-04-11T15:28:57.408Z`
- Savepoint artifact:
  `data/backtest-artifacts/focused-jul-sep-mainline-deterministic-postdeploy-v1-20260411--20260411-082805`
- Savepoint note:
  `tasks/jul-sep-savepoint-2026-04-11-postdeploy.md`

Working interpretation:

- July remains the behavioral anchor.
- September now shows real promise and should be preserved.
- August is the active pressure zone for the next refinement cycle.

### Approved overlay on top of the base package

Only the following later code paths are part of the approved July recovery package unless later evidence explicitly says otherwise:

- `early-trim-first-gate`
- `smart-runner-bootstrap-trim`
- `grny-journey-td-handoff-v2`
- `replay-trim-persistence-and-logical-dedup`
- `grny-post-trim-td-cooling-window`
- `grny-td-runner-safety-net-v2`
- `first-trim-maturity-guard-v2`
- `first-trim-direct-bypass-guards`
- the focused `INTU/JCI` runtime fixes that:
  - require structural reclaim for speculative long counter-trend pullbacks
  - carry canonical MFE/MAE/trim state through replay `openPositionContext`

Primary surfaces:

- `worker/index.js`
- `worker/pipeline/tt-core-entry.js`
- `scripts/export-focused-run-artifacts.js`

## Keep / Validate / Ignore Rules

### Keep on `main`

These are hardening-safe unless later evidence proves they distort July behavior:

- `worker/pipeline/lifecycle-seam.js`
- `worker/profile-resolution.js`
- `worker/regime-vocabulary.js`
- `worker/adaptive-lineage.js`
- `worker/read-models.js`
- `worker/onboard-ticker.js`
- `react-app/system-intelligence.html`
- `react-app/trade-autopsy.html`
- `scripts/full-backtest.sh`
- `scripts/replay-focused.sh`
- run-manifest, active-run, sentinel, and read-model surfaces in `worker/index.js`

### Validate before trusting as part of the promotion candidate

These are behavior-sensitive and must be treated as controlled surfaces:

- `worker/index.js` lifecycle / trim / runner / replay-management regions
- `worker/pipeline/tt-core-entry.js`
- `worker/pipeline/tt-core-exit.js`
- `scripts/export-focused-run-artifacts.js`
- any runtime config overlay that changes entry, trim, defend, trail, or exit behavior

### Ignore as code truth for the recovery baseline

Use these as evidence only, not as authoritative behavior sources:

- ad hoc live `model_config` snapshots
- stale or mixed focused replay artifacts
- local lock files
- generated dist assets
- reference-intel outputs unless a specific runtime dependency is being tested

## Consolidated Learnings

### What caused false confidence

- Focused replays must run sequentially. Shared replay state and locks can corrupt archive counts and behavior conclusions.
- Clean-slate means more than resetting the visible run. Stale active-run, archive, or KV rehydration can still contaminate a fresh lane.
- Promotion decisions cannot come from narrowed challenger baskets. Equal-scope reruns are required before a fix is considered promotable.
- Replay/live management must use the same canonical trade context. The `JCI` proof showed that a stripped replay position shell can fabricate exits.
- Broad weak-context suppression can improve loser buckets while still over-pruning survivors, so selective entry work must remain narrow and explicitly prove winner retention.

### What the baseline/current comparison means

Per `data/regime-config-decision/baseline-vs-current-comparison-20260407.md`:

- baseline control defines what "stable enough" means
- the current lane is the better source for regime-overlay evidence because it has full execution-regime coverage
- the correct promotion order is:
  1. baseline logic fix
  2. regime overlay
  3. profile overlay
  4. rare symbol exception

### What calibration is for

Calibration is not a rescue tool for broken replay behavior or contaminated validation lanes.

Use `Analysis` early for candidate comparison.
Use `Calibration` only when:

- the candidate run is trustworthy
- trail coverage is adequate
- the comparison scope is equal to the control
- the decision is about an overlay or refinement, not about recovering basic replay validity

## Execution Path

### Step 0: Freeze the active cumulative savepoint

Before any new implementation:

1. Treat the latest postdeploy `Jul -> Sep` lane as the current cumulative checkpoint.
2. Record its artifact, run id, git SHA, and pinned config as the parent package for the next cycle.
3. Measure all new variable-aware work against this savepoint, not against remembered behavior or stale runtime artifacts.

Supporting operator references:

- `tasks/month-compounding-operating-model-2026-04-11.md`
- `tasks/variable-evidence-matrix-contract-2026-04-11.md`
- `tasks/variable-runtime-policy-map-2026-04-11.md`
- `tasks/ticker-focused-learning-loop-2026-04-11.md`

### Phase 1: Freeze the authoritative recovery package

Before any new full run:

1. Treat `422b606...` plus the pinned savepoint config as the behavioral anchor.
2. Allow only the approved `GRNY` lifecycle overlay and the validated `INTU/JCI` runtime fixes into the candidate package.
3. Keep hardening-safe `main` improvements in place.
4. Do not assume current `HEAD` trading behavior is safe just because hardening work is present.

### Phase 2: Freeze the validation contract

Every new validation run must be launched from an explicit frozen contract. The detailed gate lives in:

- `tasks/jul-apr-validation-contract-2026-04-08.md`

Required contract fields:

- code revision
- config artifact path
- date window
- ticker scope
- replay mode
- clean-slate behavior
- active-run source of truth
- artifact destination
- required evidence outputs

### Phase 3: Re-anchor on July before widening scope

Validation order is strict:

1. July focused control using the saved July package and sentinel names:
   `RIOT`, `GRNY`, `FIX`, `SOFI`, `CSCO`, `SWK`
2. July broad validation on the equal-scope golden basket
3. August validation only if July holds
4. September through April only if August holds
5. Full `Jul -> Apr` candidate only after month-by-month control has remained intact

Each widening step must publish:

- missing vs spurious trade diff
- winner-retention review
- loser-compression review
- run-scoped artifact links
- regime/profile evidence artifact when adaptive logic is involved

### Phase 4: Constrain all future fixes to evidence-backed buckets

Before any new patch, classify it as one of:

- baseline behavior fix
- regime overlay
- profile overlay
- diagnostic-only symbol exception

Admission rules:

- baseline fix:
  issue spans multiple months or at least two profile classes, and the fix improves stability without cutting crown-jewel winners
- regime overlay:
  issue clusters in canonical `executionClass` or `vix.tier`, reproduces across at least two windows, and improves PF or net PnL while preserving winners
- profile overlay:
  issue remains after baseline and regime work, and clusters in a profile class with enough trades to avoid one-symbol overfit
- symbol exception:
  only after broader layers fail, with repeated durable outlier behavior

### Phase 5: Promote only when the full gate passes

Promotion is blocked unless the candidate passes all hard checks in `docs/promotion-checklist-v1.md`:

- parity
- performance and risk
- CIO calibration quality
- explainability and operator proof
- release hygiene

No partial pass counts as promotion-ready.

### Phase 6: Preserve the winning package

The final preserved package must include:

- code revision
- pinned config artifact
- run manifest
- full-run metrics
- monthly diffs vs control
- sentinel diff artifact
- regime/profile evidence artifact
- promotion report
- go/no-go receipt
- named saved run
- archived trade and config snapshots

That package becomes the durable comparison baseline for future work.

## Monthly Execution Ladder

### July focused control

Purpose:

- confirm the baseline package still behaves like the saved July recovery lane
- verify sentinel names before broader scope

Must show:

- `RIOT` runner behavior remains acceptable
- `GRNY` trim/runner path remains acceptable
- no replay contamination
- no fake lifecycle regressions from incomplete replay state

### July broad equal-scope validation

Purpose:

- prove the candidate is promotable on the same scope as the control, not just on selected names

Must show:

- equal-scope comparison to the protected July basket
- no material winner regression
- loser basket improves or stays controlled
- artifact export and autopsy evidence are coherent

### August control

Purpose:

- prove the July fix package survives the next month without needing ad hoc exceptions

Must show:

- no new major regressions introduced by July-targeted fixes
- event parity and replay reliability still hold
- adaptive overlays remain diagnostic unless clearly justified

### September to April expansion

Purpose:

- broaden only after July and August are trustworthy

Must show:

- same widening artifacts at each stage
- regime or profile overlays only where evidence clearly supports them
- no jump directly from July-focused success to a broad full-lane promotion claim

## Operating Rules

- One authoritative replay/backtest lane at a time.
- No promotion claim from contaminated, narrowed, or mixed-scope evidence.
- No new candidate run without a frozen manifest and pinned config.
- No replay or autopsy trust if active-run truth, archive scope, or event coverage is ambiguous.
- No calibration apply step on a lane that has not already cleared July and August control.

## Success Condition

This plan succeeds when the repo has one obvious answer to all of the following:

- what exact package is the behavioral baseline
- what must be true before launching a validation run
- what order windows must be validated in
- what evidence decides whether a change is baseline, regime, profile, or reject
- what artifacts make a full `Jul -> Apr` run promotable and preserved

At that point the full `Jul -> Apr` lane can be executed without relying on memory, side worktrees, or ad hoc shell discipline.
