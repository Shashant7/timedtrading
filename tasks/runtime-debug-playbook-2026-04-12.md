# Runtime Debug Playbook

Date: 2026-04-12

## Purpose

Give one practical workflow for answering three concrete questions about any trade:

1. why did it fire
2. how was it sized
3. why did it exit the way it did

This is an operator/debugging playbook, not a design proposal.

Use it when a replay or autopsy shows a trade that looks surprising, mismatched, or path-drifted.

## Core Principle

Do not start by guessing at the root cause.

Classify the issue first:

- entry-selection issue
- gate/guard issue
- management-overlay issue
- sizing/capital-path issue
- lifecycle/exit issue

Most confusion comes from mixing those together.

## Primary Evidence Sources

For one trade, start with:

- `trade-autopsy-trades.json`
- `trades.json`
- `signal_snapshot_json`
- `exit_snapshot_json`
- `execution_profile_json`
- `entry_path`
- `consensus_direction`
- lineage fields inside the snapshots

Relevant runtime fields to read first:

- `trade_id`
- `ticker`
- `entry_ts`
- `trim_ts`
- `exit_ts`
- `status`
- `exit_reason`
- `pnl`
- `pnl_pct`
- `entry_price`
- `trim_price`
- `exit_price`

## Fast Triage

Use this first-pass classifier before deeper reading.

### Case A: same trade id, same timestamps, same prices, different dollar PnL

Likely cause:

- sizing or capital-path drift

Usually not:

- new entry logic
- new exit logic

### Case B: same day, nearby timestamp, different trade id, same ticker/setup family

Likely cause:

- entry-path substitution
- gate timing drift
- engine-selection drift

### Case C: same trade id, same entry, different exit timestamp or exit reason

Likely cause:

- lifecycle or management-engine drift
- exit-style bias
- protect/runner logic change

### Case D: trade disappears completely

Likely cause:

- universal gate
- context gate
- guard bundle
- engine-routing change
- narrow ticker exception

## Step 1: Explain Why The Trade Fired

Read these fields from `signal_snapshot_json` and lineage:

- `entry_path`
- `state`
- `regime_class`
- `avg_bias`
- `swing_consensus`
- `entry_quality_score`
- `overnight_gap`
- `orb`
- `selected_engine`
- `selected_management_engine`
- `engine_source`
- `scenario_policy_source`
- `learning_policy_source`

Then classify the path:

### If `engine_source` is:

- `reference_exact`
- `reference_ticker_window`
- `reference_exact_forced`

Interpretation:

- trade is being deliberately steered by reference execution

### If `engine_source` is:

- `ticker_learning_policy`
- `ticker_learning_policy_default`

Interpretation:

- ticker-specific learned policy influenced engine selection

### If `engine_source` is:

- `dynamic_v2`
- `dynamic_v2_regime_dir`

Interpretation:

- broad regime/direction/sector routing selected the playbook

### If `engine_source` is:

- `env_default`
- `dynamic_default`

Interpretation:

- no stronger routing surface matched; default engine won

Next question:

- did the trade fire because the engine was special, or because default engine plus context was already enough?

That distinction matters a lot.

## Step 2: Explain Why It Qualified Instead Of Getting Blocked

Read:

- `entry_path`
- `regime_class`
- `regime_params`
- `entry_quality_score`
- `rvol_best`
- `tf_stack_json`
- `overnight_gap`
- `orb`

Then check whether the trade carries evidence of overlay or guard influence:

- `scenario_policy`
- `learning_policy`
- `adaptive_influence.runtime_facts`

Interpretation guide:

### If `scenario_policy` is present

Ask:

- did it change `management_engine`
- did it set `exit_style`
- did it recommend a `guard_bundle`

### If `learning_policy` is present

Ask:

- did it enforce reclaim/reversal/orb confirmation
- did it downgrade or block the trade through a guard bundle

### If both are absent

Interpretation:

- the trade mostly came from base engine logic plus enriched context, not an explicit scenario/ticker override

This is the most common live case right now.

## Step 3: Explain How It Was Sized

If prices and timestamps look unchanged but dollars moved, move here immediately.

Read:

- `regime_params.positionSizeMultiplier`
- `execution_profile.adjustments.positionSizeMultiplierAdj`
- `market_internals.overall`
- any sizing overlay fields in lineage
- dollar `pnl`
- percentage `pnl_pct`

Practical rule:

### If `pnl_pct` is stable but `pnl` changes materially

That is almost always:

- size drift
- account-path drift
- capital allocation drift

not:

- entry or exit semantic drift

### If `pnl_pct` also changes

Then look deeper:

- trim timing
- exit timing
- changed entry timestamp
- changed exit path

## Step 4: Explain Why It Exited The Way It Did

Read from the trade row and `exit_snapshot_json`:

- `exit_reason`
- `trimmed_pct`
- `trim_ts`
- `exit_ts`
- `selected_management_engine`
- `scenario_policy.recommend.exit_style`
- `regime_params.defendWinnerBias`

Then classify:

### If exit reason changed but entry is the same

Look for:

- management engine change
- scenario exit style change
- defend-winner bias change
- stop cushion change

### If exit reason is the same but realized dollars changed

Look for:

- size drift
- different prior capital state

### If trim timing changed first and exit drift followed later

Look for:

- runner-protection logic
- trim persistence
- post-trim defer logic
- smart-runner safety-net behavior

## Step 5: Separate Semantic Drift From Capital-Path Drift

Use this table.

### Semantic drift

Usually means one of these changed:

- trade id
- entry ts
- exit ts
- entry path
- selected engine
- management engine
- exit reason
- `pnl_pct`

### Capital-path drift

Usually means these stayed the same:

- trade id
- timestamps
- prices
- exit reason
- `pnl_pct`

but these changed:

- dollar `pnl`
- implied notional
- position size

## Step 6: Decide Which Policy Surface Owns The Problem

After classification, route the issue to the right layer.

### If the problem is:

- wrong playbook selected

Own it in:

- `reference_execution_map`
- ticker learning engine override
- dynamic engine rules

### If the problem is:

- good playbook, wrong threshold or aggressiveness

Own it in:

- `execution_profile`
- `regime_params`
- sizing overlays

### If the problem is:

- good entry, wrong post-entry management

Own it in:

- `management_engine`
- `scenario_execution_policy`
- ticker learning runtime policy
- lifecycle bias fields like `defendWinnerBias`

### If the problem is:

- one ticker has a narrow recurring exception shape

Own it in:

- ticker learning policy first
- core engine seam only if approved runtime carriers are too coarse

## Worked Interpretation Patterns

### Pattern 1: trade missing from challenger

Check in order:

1. did engine source change
2. did entry path disappear
3. did a scenario/ticker guard appear
4. did a narrow ticker exception block the branch
5. did a universal gate tighten through `regime_params`

### Pattern 2: same trade, much smaller PnL

Check in order:

1. is `pnl_pct` unchanged
2. are entry/trim/exit timestamps unchanged
3. is exit reason unchanged
4. did `positionSizeMultiplier` or other sizing overlays differ

If yes, treat it as capital-path drift first.

### Pattern 3: same entry, different exit shape

Check in order:

1. management engine
2. `exit_style`
3. `defendWinnerBias`
4. `slCushionMultiplier`
5. trim timing

## Recommended Debug Sequence

Use this exact order when investigating one trade:

1. compare row-level identity:
   - trade id, timestamps, prices, status, exit reason, `pnl`, `pnl_pct`
2. compare signal lineage:
   - `entry_path`, `selected_engine`, `engine_source`, `scenario_policy`, `learning_policy`
3. compare adaptive overlays:
   - `execution_profile`, `regime_params`, sizing overlays
4. compare exit lineage:
   - management engine, exit style, defend bias, trim/exit timing
5. only then decide whether the issue belongs to:
   - entry logic
   - overlay logic
   - sizing
   - lifecycle

## What This Playbook Prevents

It prevents three common mistakes:

- blaming a ticker exception for what is really sizing drift
- blaming engine selection for what is really a lifecycle bias change
- treating a same-day timestamp substitution as if it were a full logic collapse

## Bottom Line

When a trade looks wrong, debug it in this order:

1. identity
2. engine source
3. overlays
4. sizing
5. lifecycle

That order is usually enough to tell whether you are looking at:

- a real regression
- acceptable adaptive variation
- or simple capital-path drift on top of the same underlying trade behavior
