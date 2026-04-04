# Jul/Aug Recovery Anchor

Generated: 2026-04-02

## Target Golden Run

- Run ID: `backtest_2025-07-01_2025-08-08@2026-03-31T13:20:22.786Z`
- Artifact bundle: `data/backtest-artifacts/candidate-tsm-gdx-julaug-v6-v4b-rankrecompute-export-20260402`
- Summary:
  - 24 trades
  - 22 wins / 2 losses
  - realized PnL: `4513.611471157675`

## Historical Apples-to-Apples Reference

- Run ID: `backtest_2025-07-01_2026-03-31@2026-03-31T21:26:48.269Z`
- Artifact bundle: `data/backtest-artifacts/iter5-jul1-apr1-mar31-fullrun-export-20260402`
- Parity report: `data/iter5-recovery/julaug-vs-mar31-fullrun-parity.json`
- Result:
  - basket parity: `1.0`
  - entry timing parity: `1.0`
  - path parity: `1.0`
  - lifecycle parity: `0.9166666666666666`

This proves the Jul/Aug basket was reproducible by a historical full run and that the current failures are regression / harness issues, not a missing evidence problem.

## Current Frozen Recovery Config

- Config file: `configs/julaug-golden-parity-v2-20260402.json`
- Exact reference entries: `24`
- Intent: only the golden Jul/Aug trades are allowed to trigger exact-reference leniency

## Recovery-Critical Local Changes

The active local recovery work is concentrated in:

- `worker/index.js`
- `worker/pipeline/tt-core-entry.js`
- `worker/pipeline/trade-context.js`
- `worker/storage.js`
- `scripts/full-backtest.sh`
- `scripts/replay-focused.sh`

High-signal harness fixes already applied locally:

1. `worker/index.js`
   - `freshRun=1` disables stale `backtest_run_trades` rehydration in `candle-replay`
   - `freshRun=1` disables stale `backtest_run_trades` rehydration in `interval-replay`
   - `cleanSlate` strips replay carry state and clears per-ticker KV state

2. `scripts/full-backtest.sh`
   - passes `freshRun=1` on every standard `candle-replay` batch
   - refuses concurrent runs via a local script lock

3. `scripts/replay-focused.sh`
   - passes `freshRun=1` on `candle-replay`
   - refuses concurrent runs via a local script lock

## Root Causes Confirmed During Recovery

1. Concurrent backtest/replay processes were running at the same time and contaminating the lane.
2. Fresh replay runs were rehydrating old trades from archived run tables, which triggered:
   - `loss_streak_cooldown`
   - `recent_trade`
   and blocked valid golden entries.
3. A broader merged exact-reference config introduced too many non-golden exact references and created spurious entries.

## Operator Rule

From this point, recovery validation must only use:

- one active replay/backtest process
- one frozen config (`configs/julaug-golden-parity-v2-20260402.json`)
- one target report (`data/iter5-recovery/golden-julaug-evidence.json`)
- one comparison report per run, written under `data/iter5-recovery/`
