# July Recovery Candidate Package - 2026-04-06

## Goal

Reconstruct one explicit package for the July recovery effort so future validation lanes stop mixing:

- the 2026-04-05 July savepoint that restored the large `RIOT` runner,
- the later `GRNY` trim/deferral lifecycle refinements,
- unrelated current-head worker/UI/hardening changes,
- and ad hoc live `model_config` snapshots.

## Key Finding

The regression was not caused by config drift between the July savepoint and the later `GRNY` v6 lane.

- Savepoint config artifact:
  - `data/backtest-artifacts/focused-july-core-iter1-entrytrim--20260405-021006/model-config.json`
- Later `GRNY` v6 config artifact:
  - `data/backtest-artifacts/focused-grny-july-telemetry-firsttrim-gate-v6-stall-shield-loosened--20260405-193111/model-config.json`
- Comparison result:
  - no value differences
  - only one extra key in the savepoint bundle: `_path2_probe = ok`

This means the practical divergence came from code/package composition, not from the saved config bundle.

## Base Savepoint Package

- Savepoint note:
  - `tasks/july-recovery-savepoint-2026-04-05.md`
- Base git SHA:
  - `422b606d85178c2b862b3606ebd4457462ff32d3`
- Base focused replay:
  - `focused_replay_20260405-021006@2026-04-05T06:10:07.510Z`
- Base artifact bundle:
  - `data/backtest-artifacts/focused-july-core-iter1-entrytrim--20260405-021006`
- Base replay universe:
  - `UNP, INTU, SANM, RIOT, B, ORCL, GRNY`
- Base window:
  - `2025-07-01 -> 2025-08-05`

## What The Savepoint Explicitly Preserved

Per `tasks/july-recovery-savepoint-2026-04-05.md`, this base package already had:

- recovered `RIOT` runner behavior
- execution-state reset on new entries
- TD exhaustion runner deferral support wired in
- phase-leave runner trail on configurable ATR path
- early completion trims requiring real profit
- speculative bull entry conflict guard enabled in config
- replay timestamp handling using lifecycle-history events
- soft-fuse fresh-entry grace respected

## Later GRNY Refinements To Keep

These came after the savepoint and are the specific code-only overlay that improved the calmer `GRNY` journey:

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

The calmer `GRNY` validation artifact associated with this overlay path is:

- `data/backtest-artifacts/focused-grny-july-telemetry-firsttrim-gate-v6-stall-shield-loosened--20260405-193111`
- run id: `focused_replay_20260405-193111@2026-04-05T23:31:12.549Z`

## Current HEAD Changes That Should NOT Be Assumed Safe

Current `HEAD` is not equivalent to the reconstructed July package.

Reasons:

- `worker/index.js` has extensive additional changes since `422b606`, including hardening work, read models, lineage, profile resolution, and other runtime changes.
- `worker/pipeline/tt-core-entry.js` has changed since `422b606`.
- The post-savepoint `tt-core-entry.js` diff is small in line count, but still material:
  - added a `SOFI` trace case
  - broadened speculative pullback divergence rejection logic
- Those entry changes are not the same thing as the later `GRNY` lifecycle fixes, and they were not frozen as part of the original savepoint package.

## Reconstructed Candidate Package

The most defensible reconstruction is:

1. Base code:
   - `422b606d85178c2b862b3606ebd4457462ff32d3`
2. Base config:
   - `data/backtest-artifacts/focused-july-core-iter1-entrytrim--20260405-021006/model-config.json`
   - acceptable equivalent: `data/backtest-artifacts/focused-grny-july-telemetry-firsttrim-gate-v6-stall-shield-loosened--20260405-193111/model-config.json`
3. Overlay only the later `GRNY` lifecycle/export refinements:
   - from the iteration-log items listed above
   - limited to `worker/index.js` and `scripts/export-focused-run-artifacts.js`
4. Do not automatically include broader current `tt-core-entry.js` changes unless they are separately validated against the July basket.

## What To Exclude

Do not use these as the canonical reconstruction:

- a fresh snapshot of live `model_config`
- current `HEAD` as-is
- current deployed worker plus a frozen runtime config
- any package that assumes all current entry-selectivity logic was already part of the savepoint

## Practical Next Step

Before any new backtest:

1. Materialize a dedicated reconstruction branch/worktree from `422b606`.
2. Port only the later `GRNY` lifecycle/export refinements onto that base.
3. Keep the savepoint config artifact unchanged.
4. Run a July-focused validation lane first.
5. Only after July behavior is confirmed, run the broader Jul->Apr lane.

## Working Definition

Until proven otherwise, the correct candidate package is:

- savepoint code at `422b606`
- savepoint config artifact
- plus only the later `GRNY` lifecycle overlay from the iteration log

That is the package that should be rebuilt and validated next.
