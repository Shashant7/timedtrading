# Live/Replay Parity Contract v1

## Objective
Prevent silent behavior drift between live scoring and replay validation.

## Required Parity Dimensions
- `ENTRY_ENGINE`, `MANAGEMENT_ENGINE`, `LEADING_LTF`
- deep-audit/model-config keys used by entry/management gates
- execution-profile inputs (market internals, regime context)
- timestamp semantics for hold/gate calculations

## Contract Rules
- Any new config key affecting scoring/execution must be loaded in both paths.
- Replay and live must log effective engine/context fields for diagnostics.
- Protected references (e.g. CSX-class journeys) must pass parity checks before promotion.

## Validation Artifacts
- mode-diff trace around protected windows
- interval-level blocked-gate and stage diagnostics
- candidate-vs-reference journey parity report

## Fallback Rule
If parity is unknown for a new policy branch, promotion is blocked.
