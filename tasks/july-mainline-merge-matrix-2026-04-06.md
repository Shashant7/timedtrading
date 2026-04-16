# July Mainline Merge Matrix - 2026-04-06

## Purpose

This matrix answers one question:

What on current `main` should be kept, what should be validated against the July savepoint, and what should be ignored for the objective of restoring solid July performance?

## Baselines

- Behavior baseline: `422b606d85178c2b862b3606ebd4457462ff32d3`
- Current mainline workspace branch tip: `3a572d0`
- Proven July package doc: `tasks/july-recovery-candidate-package-2026-04-06.md`
- Mainline execution plan: `tasks/july-mainline-reconciliation-plan-2026-04-06.md`

## Matrix

| Surface | Bucket | Current Assessment | Action |
|---|---|---|---|
| `worker/pipeline/lifecycle-seam.js` | keep | Hardening/refactor seam extracted to unify lifecycle dispatch. Supports maintainability and determinism. | Keep on `main`. |
| `worker/profile-resolution.js` | keep | Explicit profile resolution contract; not itself a July behavior patch. | Keep on `main`. |
| `worker/regime-vocabulary.js` | keep | Canonical regime mapping layer; contract/hardening work. | Keep on `main`. |
| `worker/adaptive-lineage.js` | keep | Attribution and explainability only. | Keep on `main`. |
| `worker/read-models.js` | keep | Stable operator/read-model support for admin surfaces. | Keep on `main`. |
| `worker/indicators.js` | keep/validate-lightly | Mostly contract and profile/regime plumbing, but can indirectly affect runtime evidence. | Keep; only investigate if July parity still drifts after core reconciliation. |
| `worker/onboard-ticker.js` | keep | Onboarding/profile plumbing, not part of the July replay core. | Keep on `main`. |
| `worker/pipeline/trade-context.js` | keep/validate-lightly | Contract-oriented context construction. Could affect payload shape but not yet implicated as the primary July drift source. | Keep unless later evidence points here. |
| `react-app/system-intelligence.html` | keep | UI/operator work only. | Keep on `main`. |
| `react-app/trade-autopsy.html` | keep | UI/operator work only; useful for validation once behavior is restored. | Keep on `main`. |
| `scripts/full-backtest.sh` | keep | Orchestration/hardening improvements should remain. | Keep on `main`. |
| `scripts/replay-focused.sh` | keep | Deterministic focused replay orchestration improvements should remain. | Keep on `main`. |
| `scripts/export-focused-run-artifacts.js` | validate-and-keep | The logical dedupe and lifecycle-history trim persistence are part of the validated `GRNY` overlay. | Keep the validated overlay behavior. |
| `worker/pipeline/tt-core-entry.js` | validate | Savepoint comparison showed a small post-savepoint divergence reject expansion. | Re-anchored to savepoint logic on `main`; retain only the trace-only `SOFI` case. |
| `worker/pipeline/tt-core-exit.js` | validate-and-keep | Contains the `ripster_72_89_1h_deferred_structure_reclaim` fix for `CSCO`-style structural reclaim. Additive and aligned with later user feedback, but still behavior-sensitive. | Keep for now; validate in July/December sentinels. |
| `worker/index.js` hardening regions | keep | Run manifest, active-run truth, read models, lineage wiring, profile/regime plumbing are hardening-safe by intent. | Keep on `main`. |
| `worker/index.js` lifecycle / trim / runner regions | validate | This is where the proven July savepoint and later `GRNY` overlay live, but it also contains many other post-savepoint changes. | Inspect and re-anchor surgically against `422b606` while preserving hardening-only sections. |
| `configs/dynamic-engine-rules-reference-v1.json` | ignore for July recovery | Runtime artifact/config data; not a trusted July behavior source by itself. | Ignore for current reconciliation unless a specific dependency emerges. |
| `data/reference-intel/*` | ignore for July recovery | Generated reference-intel outputs are not the authoritative July recovery package. | Ignore for current reconciliation. |
| `react-app-dist/*` | ignore until sources settle | Built artifacts should follow source truth, not drive reconciliation. | Ignore for current reconciliation. |
| `data/backtest-artifacts/*` | evidence only | Useful as forensic evidence, not as code truth. | Use for comparison only. |

## Current Execution Status

### Completed

- July candidate package documented.
- `main`-only reconciliation plan documented.
- `tt-core-entry.js` speculative pullback divergence guard restored to savepoint logic.

### In Progress

- `worker/index.js` merge split:
  - keep hardening/read-model/manifest/profile/regime changes
  - preserve proven July and later `GRNY` lifecycle overlay
  - identify any unvalidated extra behavior changes mixed into the lifecycle path

### Next Surgical Targets

1. `worker/index.js`
   - first-trim maturity
   - smart-runner bootstrap trim
   - TD exhaustion post-trim cooling / safety net
   - stall-force-close thesis-intact shield
2. `scripts/export-focused-run-artifacts.js`
   - confirm logical dedupe + lifecycle trim resolution stay intact
3. `worker/pipeline/tt-core-exit.js`
   - keep the `72/89` structural reclaim defer path unless validation disproves it

## Working Rule

If a change on `main` cannot be justified as either:

- hardening/refactor-safe, or
- part of the proven July + `GRNY` overlay package,

then it should not be trusted as part of the July recovery candidate until it is explicitly validated.
