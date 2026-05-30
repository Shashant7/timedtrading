# October Isolation - 2026-04-14 - Jul-Sep Anchor v1

## Lane

- Label: `october-isolation-julsep-anchor-v1`
- Artifact bundle:
  `data/backtest-artifacts/focused-october-isolation-julsep-anchor-v1--20260413-222350`
- Run id:
  `focused_replay_20260413-222350@2026-04-14T05:23:55.154Z`
- Git SHA:
  `d2e6f343ac0615b6ed4a9999fb609469f74076ac`
- Config artifact:
  `data/backtest-artifacts/july-equalscope-deterministic-parity-v1-config-20260410.json`
- Dataset manifest:
  `data/replay-datasets/october-2025-equalscope-focused/manifest.json`
- Interval: `5m`
- Window: `2025-10-01` -> `2025-10-31`
- Tickers:
  `XLY, PH, GRNY, MTZ, ETN, SWK, RIOT, ON, IESC, FIX, AGQ, SGI, CDNS, HUBS, ABT, KWEB`

## Summary

- Total trades: `14`
- Wins / losses: `7 / 7`
- Closed PnL: `+$443.58`

This month is positive enough to keep widening, but it is less comfortable than
September because the edge is narrower and one concentrated loss branch
(`ON`) accounts for a meaningful share of the drag.

## October Loss Classification

### 1. Primary ticker-specific loss cluster

- `ON`: `1` loss, total `-$121.39`

Interpretation:

- This is the cleanest October watch item because it is the single largest
  losing contribution in the month.
- It is still not large enough, by itself, to justify an October-only branch
  before composition testing.

Classification:

- `ticker-specific`
- first candidate if October fails to compose cleanly in cumulative widening

### 2. Secondary ticker-specific / narrow month drag

- `IESC`: net `-$98.11`
- `SGI`: `-$54.09`
- `MTZ`: net `-$22.25`

Interpretation:

- These matter, but each remains materially smaller than the `ON` branch.
- None of them alone yet proves a baseline or cross-symbol October failure.
- `IESC` is worth watching because the month-level net flips negative despite a
  winning trade also being present.

Classification:

- `ticker-specific`
- monitor in cumulative lane before direct intervention

### 3. Background / acceptable friction

- `RIOT`: still net positive at `+$96.65` despite `2` losses
- `FIX`: positive at `+$86.16`
- `GRNY`: positive at `+$104.60`
- `AGQ`: dominant winner at `+$451.98`

Interpretation:

- These names add noise, but they do not create a month-level failure cluster.
- October’s positive result is being held up by a small number of winners rather
  than broad basket strength, so widening is still the right test.

Classification:

- `background`
- no October-only action yet

## Decision

- October isolation is acceptable enough to advance to `Jul -> Oct`.
- Treat `ON` as the named October watch item.
- Treat `IESC` / `SGI` as secondary watch names.
- Do not branch into October-only code changes unless the cumulative
  `Jul -> Oct` lane shows October does not compose cleanly.

## Next Step

Build the focused cumulative `Jul -> Oct` dataset contract and rerun the
`Jul -> Oct` lane from the accepted `Jul -> Sep` checkpoint.
