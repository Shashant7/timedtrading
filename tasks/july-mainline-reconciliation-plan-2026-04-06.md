# July Mainline Reconciliation Plan - 2026-04-06

## Goal

Make `main` the one authoritative trunk again while restoring the solid July recovery behavior.

This plan explicitly avoids relying on additional worktrees. The target is not "preserve every side lane"; the target is:

- keep the completed hardening/refactor-safe work on `main`
- re-anchor trading behavior to the proven July savepoint package
- re-apply only the later validated `GRNY` lifecycle overlay
- validate on July before any broader rerun

## Canonical Baselines

### Behavior baseline

- Savepoint SHA: `422b606d85178c2b862b3606ebd4457462ff32d3`
- Savepoint artifact: `data/backtest-artifacts/focused-july-core-iter1-entrytrim--20260405-021006`
- Savepoint config: `data/backtest-artifacts/focused-july-core-iter1-entrytrim--20260405-021006/model-config.json`

### Current trunk baseline

- Current branch target: `main`
- Current branch tip in this workspace: `3a572d0`

## Guardrails

1. `main` is the only canonical destination.
2. Do not chase parity through extra worktrees.
3. Do not assume current `HEAD` trading behavior is safe just because hardening work is present.
4. Keep hardening/read-model/contract work unless it directly changes trading behavior.
5. Revalidate any entry/exit/management logic that changed after the July savepoint.

## Change Buckets

### Keep by default: hardening / refactor-safe

These changes improve determinism, explainability, lineage, or operator tooling and should remain on `main` unless they are proven to distort trade behavior:

- `worker/pipeline/lifecycle-seam.js`
- `worker/profile-resolution.js`
- `worker/regime-vocabulary.js`
- `worker/adaptive-lineage.js`
- `worker/read-models.js`
- `worker/indicators.js`
- `worker/onboard-ticker.js`
- `worker/pipeline/trade-context.js`
- `react-app/system-intelligence.html`
- `react-app/trade-autopsy.html`
- `scripts/full-backtest.sh`
- `scripts/replay-focused.sh`
- run-manifest / active-run / sentinel validation surfaces in `worker/index.js`

### Validate before trusting for July behavior

These directly affect entry quality, trim timing, stop behavior, runner hold/deferral, or replay trade interpretation:

- `worker/index.js`
- `worker/pipeline/tt-core-entry.js`
- `worker/pipeline/tt-core-exit.js`
- `scripts/export-focused-run-artifacts.js`
- any runtime config overlays or dynamic engine artifacts that influence entry/exit behavior

### Ignore / archive for mainline reconciliation

These are not authoritative behavior sources for the recovery merge:

- fresh live `model_config` freezes
- ad hoc focused replay artifacts
- local lock files
- generated dist assets until source reconciliation is settled
- reference-intel refresh outputs unless a specific runtime dependency is proven relevant to July behavior

## Proven July Overlay To Preserve

The post-savepoint overlay that should be re-applied on top of the behavior baseline is limited to:

- `early-trim-first-gate`
- `smart-runner-bootstrap-trim`
- `grny-journey-td-handoff-v2`
- `replay-trim-persistence-and-logical-dedup`
- `grny-post-trim-td-cooling-window`
- `grny-td-runner-safety-net-v2`
- `first-trim-maturity-guard-v2`
- `first-trim-direct-bypass-guards`

Primary files:

- `worker/index.js`
- `scripts/export-focused-run-artifacts.js`

## Known Post-Savepoint Risk On Main

`worker/pipeline/tt-core-entry.js` changed after the savepoint and is not part of the proven July package.

Known current diff themes:

- extra trace case additions
- broader speculative pullback divergence rejection

Those may be good ideas, but they are not yet part of the trusted July package and should not be treated as canonical without validation.

## Execution Sequence

### Phase 1: Mainline merge matrix

Produce one file-backed matrix that answers:

- what on `main` is hardening-safe and stays
- what on `main` is behavior-sensitive and must be compared to `422b606`
- what can be ignored for the July recovery objective

### Phase 2: Behavior re-anchor on `main`

For the behavior-sensitive files:

1. compare current `main` to `422b606`
2. restore savepoint behavior where needed
3. re-apply only the validated `GRNY` overlay
4. leave unrelated hardening pieces intact

### Phase 3: Package freeze on `main`

Freeze one explicit mainline candidate package containing:

- current `main` code with reconciled behavior-sensitive surfaces
- savepoint config artifact
- exact run parameters for July validation

### Phase 4: July validation first

Before any full backtest:

1. run July-focused validation
2. inspect sentinel names first: `RIOT`, `GRNY`, `FIX`, `SOFI`, `CSCO`, `SWK`
3. confirm recovered hold/trim/deferral behavior

### Phase 5: Broaden only after July holds

Only after July is solid again:

1. extend to August
2. then broader Jul -> Apr
3. keep monthly validation discipline

## Immediate Actions

1. Build the explicit `main` reconciliation matrix.
2. Inspect `worker/index.js`, `worker/pipeline/tt-core-entry.js`, `worker/pipeline/tt-core-exit.js`, and `scripts/export-focused-run-artifacts.js` against `422b606`.
3. Reconstruct the July behavior package directly on `main`.
4. Freeze the reconciled package before launching any replay.

## Success Condition

`main` becomes trustworthy when all of the following are true:

- hardening/refactor-safe work remains intact
- July savepoint behavior is restored
- later `GRNY` lifecycle improvements remain present
- there is one explicit package definition for validation
- no future run depends on "whatever happened to be live"
