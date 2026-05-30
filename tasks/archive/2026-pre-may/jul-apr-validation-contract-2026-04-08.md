# Jul->Apr Validation Contract

Date: 2026-04-08

## Purpose

Turn replay and backtest reliability learnings into one preflight contract that every future recovery lane must satisfy before launch.

This document is the launch gate for:

- July focused control lanes
- July broad equal-scope reruns
- August validation
- any later `Jul -> Apr` promotion candidate

## Required Run Contract

Every run must freeze and record all of the following before execution:

- `parent_savepoint_package`
- `parent_savepoint_run_id`
- `code_revision`
- `config_artifact_path`
- `date_window`
- `ticker_scope`
- `mode`
  - focused replay
  - monthly validation replay
  - full backtest
- `interval`
- `clean_slate`
- `reference_execution_mode`
- `event_seed_strategy`
- `artifact_output_dir`
- `expected_evidence_outputs`

## Preflight Gate

Do not launch unless every item below is explicitly checked.

### 1. Lane isolation

- Exactly one authoritative replay/backtest lane is active.
- No stale full backtest, focused replay, or checkpoint resume process is still running.
- Active-run truth is reset and points only to the lane about to launch.
- Replay lock state is known and intentional.

### 2. Clean-slate state

- Fresh validation lanes do not reuse stale archive, KV, or live trade state unless the lane explicitly says so.
- No stale `timed:replay:running` or live-autopsy fallback can masquerade as the current run.
- Fresh runs do not silently rehydrate non-window or non-sentinel trades.

### 3. Historical data readiness

- Required historical candles exist for the full target window.
- Higher-timeframe bundles required by the lane are present and fresh.
- Stale `30m` or `60m` bundles are rejected instead of reused.
- Replay candles are loaded with `beforeTs` semantics, not "latest available" semantics.

### 4. Event and earnings readiness

- Earnings and macro event coverage is seeded for the target window.
- Replay-visible event sources are verified, not assumed from cache presence.
- Single-ticker event seed paths have a fallback when direct provider responses are empty.
- Event guards are validated on clean-lane artifacts when they are part of the test objective.

### 5. Canonical trade context readiness

- Replay management paths carry the full open-trade context needed for lifecycle decisions.
- `openPositionContext` includes canonical MFE, MAE, trim state, shares, and trade reference when needed.
- No lifecycle decision path depends on a stripped position shell when a full trade row is required.

### 6. Scope discipline

- The run declares whether it is:
  - diagnostic-only
  - control
  - challenger
  - promotion-eligible
- Promotion claims are never made from narrowed or mixed-scope challenger baskets.
- Equal-scope comparison requirements are defined before launch.

### 7. Artifact contract

- Artifact directory is named before launch.
- Run manifest is captured before execution.
- Config snapshot is preserved independently of mutable live `model_config`.
- Parent savepoint package is named explicitly rather than inferred.
- Expected outputs are named up front.

## Required Outputs By Lane Type

### Focused diagnostic lane

Must produce:

- run manifest
- artifact bundle
- created vs archived trade counts
- exact target trade presence or absence
- any required runtime trace notes

### Monthly validation lane

Must produce:

- run manifest
- archived trades
- missing vs spurious trade diff
- winner-retention review
- loser-compression review
- notes on any replay or event-parity anomalies

### Promotion candidate lane

Must produce:

- all monthly validation outputs
- sentinel diff artifact
- regime/profile evidence artifact when adaptive logic is involved
- promotion report
- go/no-go receipt

## Comparison Rules

- Use fresh current-code artifacts only.
- Run focused replays sequentially, never in parallel.
- Compare promotion candidates on equal scope to the control.
- Use the baseline package for stability comparison.
- Use the current live lane only for regime-overlay evidence where execution-regime coverage is required.

## Analysis And Calibration Rules

### Analysis

Allowed whenever the candidate lane itself is trustworthy.

Use it to:

- compare control vs challenger
- inspect monthly drift
- inspect regime and profile concentration
- confirm that a fix belongs in baseline, regime, profile, or reject

### Calibration

Diagnostic-only use is allowed only when:

- trail coverage is adequate
- replay validity is already trusted
- the candidate is not over-pruned or contaminated

Apply-stage calibration is allowed only after:

- July control passes
- July equal-scope validation passes
- August control passes

Do not use calibration to rescue:

- broken replay semantics
- stale state contamination
- incomplete event seeding
- missing higher-timeframe coverage

## Stop Conditions

Stop and re-plan immediately if any of the following occur:

- stale or overlapping run activity is discovered
- created trades and archived trades disagree unexpectedly
- non-window or non-scope trades appear in a clean lane
- a trade path disagrees between replay and live due to context-shape mismatch
- required event or HTF coverage is missing
- a candidate improves losers only by collapsing legitimate winners

## Promotion Readiness Handoff

A lane may be handed off for promotion review only when:

- it was launched from a frozen run contract
- it passed all relevant preflight gates
- its evidence outputs are complete
- its comparison scope matches the control scope
- its results are strong enough to enter the hard blocker review in `docs/promotion-checklist-v1.md`

If any of the above is false, the lane remains diagnostic and cannot be treated as promotable.
