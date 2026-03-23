# Context Intelligence Contract v1

## Objective
Create a reusable context layer for decisioning and explainability:
- ticker personality/profile
- Daily Brief macro/event backdrop
- SPY/QQQ hyper-state for day-trader timing

## Context Entity Keys
- `date` (trading date, UTC day key)
- `ticker`
- optional `run_id` for replay/backtest snapshots

## Context Blocks

### 1) Ticker Profile Block
- `behavior_type`
- `atr_pct_p50`
- `trend_persistence`
- `ichimoku_responsiveness`
- sector/industry tags

### 2) Market Backdrop Block (Daily Brief)
- `regime_overall`, `regime_score`
- VIX level/state
- offense/defense rotation values
- macro event proximity and event impact tags

### 3) SPY/QQQ Hyper-State Block
- intraday trend state
- volatility state
- opening tone classification
- trend persistence / mean-revert tendency

## Context Quality Fields
- `context_complete`
- `profile_present`
- `daily_brief_present`
- `hyper_state_present`
- `source_timestamps`

## Usage
- Inputs to reference scoring and policy selection.
- Inputs to AI CIO memory and confidence interpretation.
- Inputs to UI context overlays and day-trader assist panels.
