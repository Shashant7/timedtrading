# September Isolation - 2026-04-14 - Jul-Aug Anchor v1

## Lane

- Label: `september-isolation-julaug-anchor-v1-rerun-skip-events`
- Artifact bundle:
  `data/backtest-artifacts/focused-september-isolation-julaug-anchor-v1-rerun-skip-events--20260413-173719`
- Run id:
  `focused_replay_20260413-173719@2026-04-14T00:37:22.729Z`
- Git SHA:
  `d2e6f343ac0615b6ed4a9999fb609469f74076ac`
- Config artifact:
  `data/backtest-artifacts/july-equalscope-deterministic-parity-v1-config-20260410.json`
- Dataset manifest:
  `data/replay-datasets/september-2025-equalscope-focused/manifest.json`
- Interval: `5m`
- Window: `2025-09-01` -> `2025-09-30`
- Tickers:
  `XLY, PH, GRNY, MTZ, ETN, SWK, RIOT, ON, IESC, FIX, AGQ, SGI, CDNS, HUBS, ABT, KWEB`

## Summary

- Total trades: `19`
- Wins / losses: `9 / 10`
- Closed PnL: `+$748.48`

The lane is positive enough to keep widening, but September is materially less
comfortable than August because one concentrated loser family dominates the loss
stack.

## September Loss Classification

### 1. Ticker-specific high-value branch

- `CDNS`: `2` losses, total `-$532.79`

Interpretation:

- This is the dominant September pressure cluster by a wide margin.
- September is still net positive overall, so the month does not require an
  immediate emergency branch before composition testing.
- But if the cumulative `Jul -> Sep` lane fails or regresses materially, `CDNS`
  should be treated as the first obvious September-specific deep dive.

Classification:

- `ticker-specific`
- first candidate if September needs direct intervention later

### 2. Secondary ticker-specific losses

- `ABT`: `-$189.49`
- `MTZ`: `-$97.95`

Interpretation:

- These are meaningful but still notably smaller than the `CDNS` stack.
- They do not form a cross-symbol baseline pattern from this evidence alone.

Classification:

- `ticker-specific`
- monitor in cumulative lane before taking action

### 3. Background noise / minor friction

- `GRNY`: `-$49.90`
- `HUBS`: `-$19.93`
- `SGI`: `-$13.81`
- `XLY`: `-$8.67`
- `FIX`: `-$0.45`

Interpretation:

- These are not large enough to justify September-only changes from isolation
  evidence alone.

Classification:

- `background`

## Decision

- September isolation is acceptable enough to advance to `Jul -> Sep`.
- Treat `CDNS` as the named September watch item.
- Do not branch into September-only code changes unless the cumulative lane
  proves the month does not compose cleanly.
