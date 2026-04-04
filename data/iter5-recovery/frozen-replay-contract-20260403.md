# Frozen Replay Contract

Generated: 2026-04-03

## Purpose

This contract defines the minimum frozen inputs required for any replay or backtest to be considered deterministic enough for parity work.

A run that violates this contract may still be useful for exploration, but it cannot be trusted as benchmark evidence.

## Frozen Inputs

### 1. Config

- Default benchmark config file:
  - `configs/julaug-golden-parity-v2-20260402.json`
- Config must be supplied explicitly with `--config-file`.
- `--live-config` is not permitted for parity validation.
- Run registration must archive the applied config at run start.
- Required provenance fields:
  - `config_file`
  - `config_source_run_id`
  - `config_key_count`

### 2. Candle Data

- Replay window is frozen to the requested test range.
- Coverage window must include warmup:
  - `start_date - 60 days` through replay end date
- Preferred mode for deterministic reruns:
  - use a frozen dataset manifest once available
- If a frozen dataset manifest is used, the run is invalid unless:
  - manifest `ok=true`
  - manifest replay window matches the requested replay window
  - manifest coverage window matches expected warmup window
  - manifest reports `supported_tickers_with_gaps = 0`

### 3. Market Events

- Historical macro and earnings events must be seeded before replay begins.
- Full backtests should not rely on ad hoc live fetching during evaluation.
- If events are pre-seeded, the launch may use `--skip-market-events`; otherwise it must seed before replay.
- Event window must match the replay date range.

### 4. Learning And Profile Inputs

- Archived learning outputs are not part of the runtime by default.
- Any replay that uses ticker-profile, CIO-memory, or calibration-derived behavior must declare the exact frozen source.
- Unpinned learning/profile inputs invalidate parity claims.

### 5. Runtime State

- One active replay/backtest process at a time.
- `freshRun=1` required for replay execution.
- `cleanSlate=1` required for the first parity day of any new validation lane.
- No stale replay lock reuse across unrelated runs.
- No mutable carryover from `backtest_run_trades`, KV, or prior trade history is allowed into a fresh lane.

## Accepted Launch Shapes

### Full Backtest

- script: `scripts/full-backtest.sh`
- required properties:
  - explicit `--config-file`
  - single active run
  - archived run registration
  - deterministic candle coverage
  - historical event availability
  - `ticker_batch=15` unless intentionally changed and documented

### Focused Replay

- script: `scripts/replay-focused.sh`
- required properties:
  - explicit `--tickers`
  - explicit `--start`
  - explicit `--end`
  - explicit `--config-file`
  - `freshRun=1`
  - `--clean-slate` for the first day of any parity-focused lane
  - run registration before replay begins

## Required Run Metadata

Every benchmark-eligible run must preserve:

- `run_id`
- label and description
- git SHA
- worker deployment version(s)
- config provenance
- date range
- interval
- ticker batch / ticker subset
- whether it is `trader-only`, `investor-only`, or `sequence`
- whether market events were pre-seeded or seeded inline
- whether a frozen dataset manifest was used

## Invalidating Conditions

A run is not parity-valid if any of these are true:

- live config was used instead of a frozen config file
- more than one replay/backtest was active
- stale run data rehydrated into a supposedly fresh run
- market events were absent for a window where event-risk logic matters
- candle gaps existed in supported tickers
- ticker/profile/CIO memory inputs changed without being pinned and recorded
- a mixed artifact from multiple run IDs is treated as a single-run ground truth

## Current Contract Status

### Already In Place

- run registration snapshots config at launch
- `freshRun=1` is passed by both replay harnesses
- script-level locks exist for full and focused runs
- historical market-event seeding path exists via `scripts/backfill-market-events.js`
- frozen dataset manifest support already exists in `scripts/full-backtest.sh`

### Still Required For Strong Determinism

- dedicated frozen replay dataset manifests for benchmark lanes
- explicit freezing / opt-in promotion of learning inputs
- focused/full harness semantic parity around reset rules, metadata, and checkpointing

## Operator Rule

If a run does not satisfy this contract, archive it as exploratory only.

Do not use it as evidence for:

- golden parity claims
- regression acceptance
- promoted history seeding
- investor/trader promotion decisions
