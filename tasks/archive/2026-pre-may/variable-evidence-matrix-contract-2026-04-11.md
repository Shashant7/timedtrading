# Variable Evidence Matrix Contract

Date: 2026-04-11

## Purpose

Define the first durable evidence contract for variable-aware behavior selection.

The goal is to turn past trades, autopsies, ticker profiles, and regime evidence into a matrix that can justify:

- baseline fixes
- regime overlays
- profile overlays
- ticker-specific exceptions

without turning the system into ad hoc overfit logic.

## Matrix Record

Each policy evidence row should be keyed by:

- `ticker`
- `sector`
- `regime_execution_class`
- `vix_tier`
- `market_backdrop_class`
- `setup_family`
- `entry_path`
- `entry_engine`
- `management_engine`
- `month_bucket`
- `quarter_bucket`
- `static_behavior_profile`
- `learned_personality`

For v1, the required working subset is:

- `ticker`
- `sector`
- `regime_execution_class`
- `vix_tier`
- `setup_family`
- `entry_engine`
- `management_engine`
- `month_bucket`
- `static_behavior_profile`
- `learned_personality`

## Source Of Truth

Build the matrix from these surfaces:

- archived run artifacts
- `trade_autopsy` / run-scoped autopsy exports
- `direction_accuracy`
- `ticker_profiles.learning_json`
- profile resolution and lineage fields
- regime evidence produced by:
  `scripts/build-regime-evidence-matrix.js`

Primary interpretation files:

- `scripts/build-regime-evidence-matrix.js`
- `scripts/trade-intelligence.js`
- `worker/profile-resolution.js`
- `worker/pipeline/trade-context.js`

## Required Metrics Per Cell

Each matrix cell should record:

- `closed_trades`
- `wins`
- `losses`
- `flats`
- `net_pnl`
- `avg_pnl`
- `profit_factor`
- `avg_win_pct`
- `avg_loss_pct`
- `max_loss`
- `top_winners_concentration`
- `top_losers_concentration`
- `months_present`
- `windows_present`
- `unique_tickers_present`

For ticker-specific rows, also record:

- `same_setup_count`
- `same_entry_path_count`
- `neighbor_sector_support`
- `cumulative_rerun_status`

## Evidence Levels

### Level 0: visible only

Use when:

- `closed_trades >= 3`

Purpose:

- diagnostic visibility only
- not sufficient for policy promotion

### Level 1: candidate-worthy

Use when:

- regime cell: `closed_trades >= 8` and `months_present >= 2`
- profile cell: `closed_trades >= 10` and `months_present >= 2`
- ticker cell: `closed_trades >= 8` and `months_present >= 2`

Purpose:

- worthy of manual review and hypothesis generation
- still not enough for automatic runtime promotion

### Level 2: promotable for controlled runtime use

Use when:

- regime cell: `closed_trades >= 12` and `months_present >= 2`
- profile cell: `closed_trades >= 14` and `months_present >= 2`
- ticker cell: `closed_trades >= 10`, `months_present >= 2`, and a successful cumulative rerun

And all of the following are true:

- the candidate improves the target month
- the candidate survives the cumulative rerun
- winner retention is acceptable
- the behavior is explainable in lineage and autopsy

## Promotion Order

Use this sequence for all matrix decisions:

1. baseline behavior
2. regime overlay
3. profile overlay
4. ticker-specific exception

If a higher layer explains the issue well enough, do not promote a lower-layer rule.

## Ticker-Specific Early Policy Rule

Ticker-specific behavior is allowed early in this framework, but only under stricter conditions.

A ticker-specific policy may be considered only when:

- the issue is durable for that ticker
- broader regime/profile explanations are weaker
- the ticker has enough repeated evidence
- the candidate survives cumulative rerun validation

Ticker-specific policy should be treated as:

- explicit
- attributable
- reversible

Never silent.

## Policy Recommendation Output

Every promotable matrix row should recommend one of:

- `baseline_fix`
- `regime_overlay`
- `profile_overlay`
- `ticker_exception`
- `reject`

And one or more runtime targets:

- `entry_engine`
- `management_engine`
- `guard_bundle`
- `exit_style`
- `position_size_multiplier`
- `sl_cushion_multiplier`
- `min_rr`
- `max_completion`
- `defend_winner_bias`

## Anti-Overfit Rules

- A single spectacular trade must never dominate a cell decision.
- A single bad trade must never justify a broad new policy by itself.
- Ticker-specific cells must always be cross-checked against:
  - the parent cumulative savepoint
  - nearby sector behavior
  - the same setup family in other names
- If the candidate only improves by collapsing valid winners, mark it `reject`.

## Required Artifacts

Every matrix generation pass should produce:

- machine-readable JSON
- operator-readable Markdown
- explicit promotion recommendations
- a list of high-risk outlier cells

## Immediate Use

Use this contract to build the first matrix around the active parent savepoint:

- `tasks/jul-sep-savepoint-2026-04-11-postdeploy.md`

Primary question for the first pass:

- what belongs in baseline vs regime vs profile vs ticker-specific treatment for the August pressure zone while preserving July and September
