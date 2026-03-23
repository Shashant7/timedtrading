# Trade Proof Contract v1

## Objective
Ensure every closed trade can be explained with consistent evidence in UI and operator tooling.

## Minimum Evidence Payload
- identity: `trade_id`, `run_id`, `ticker`, `direction`
- timing: `entry_ts`, `exit_ts`, `hold_days`
- outcome: `pnl`, `pnl_pct`, `status`, `exit_reason`, `exit_class`
- setup lineage: `entry_path`, snapshot summary (`avg_bias`, TF count)
- quality: `MFE`, `MAE` (when available)
- context: `sector`, core regime tags (when available)

## UI Surface Requirements
- Trades page: compact proof strip and link to full autopsy
- Trade Autopsy: full evidence table and context interpretation
- Runs/System Intelligence: run-level audit receipt and comparison support

## Quality Targets
- non-null `trade_id`, `ticker`, `entry_ts`, `status`: 100%
- non-null `entry_path` on closed trades: target >= 95%
- parseable signal snapshot on closed trades: target >= 95%

## Release Impact
If proof targets fail for candidate baseline, promotion is blocked.
