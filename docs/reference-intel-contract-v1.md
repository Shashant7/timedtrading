# Reference Intelligence Contract v1

## Purpose
Define the canonical row contract for full-history, trade-level intelligence used by selection, journey mapping, policy generation, and validation.

## Primary Key
- `run_id`
- `trade_id`

## Required Fields
- `run_id`, `run_label`, `run_start_date`, `run_end_date`
- `trade_id`, `ticker`, `direction`
- `entry_ts`, `status`
- `entry_path` (nullable but tracked for quality)
- `pnl`, `pnl_pct` (nullable for open rows)
- `exit_reason`, `exit_class`

## Lineage Fields
- `signal_snapshot_json` (raw string if present)
- `tf_stack_json` (raw string if present)
- `snapshot_avg_bias`
- `snapshot_tf_count`
- `consensus_direction`
- `max_favorable_excursion`
- `max_adverse_excursion`
- `annotation_classification`, `annotation_entry_grade`, `annotation_trade_management`

## Context Fields
- `sector`
- `industry` (nullable until consistently available)
- `regime_daily`, `regime_weekly`, `regime_combined` (nullable in artifact-only mode)
- `execution_profile_name`, `execution_profile_confidence` (nullable in artifact-only mode)

## Derived Fields
- `hold_days`
- `is_closed`
- `is_forced_close`
- `lineage_quality_flags`:
  - `has_entry_path`
  - `has_signal_snapshot`
  - `has_tf_stack`
  - `has_mfe_mae`
  - `has_exit_reason`

## Exit Class Mapping
- `tp_full`: `TP_FULL` appears in `exit_reason`
- `fuse`: `FUSE` appears in `exit_reason`
- `loss_protect`: `MAX_LOSS`, `SL_BREACHED`, `TRIGGER_BREACHED`, `LARGE_ADVERSE_MOVE`
- `regime_reversal`: `REGIME`, `EMA_REGIME`
- `trim_related`: `TRIM`
- `other`: any non-empty reason not above
- `unknown`: empty/null reason

## Quality Rules
- One canonical row per `(run_id, trade_id)` in the main dataset.
- If duplicate rows exist, prefer a closed status over open status.
- Preserve raw provenance (`source_file`, `artifact_dir`) for auditability.
