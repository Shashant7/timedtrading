# July Challenger - 2026-04-12 - ON + RIOT v1

## Challenger Package

- Label: `july-on-riot-v1-challenger`
- Artifact bundle:
  `data/backtest-artifacts/focused-july-mainline-equalscope-on-riot-v1-20260412--20260412-103307`
- Run id:
  `focused_replay_20260412-103307@2026-04-12T17:33:40.322Z`
- Git SHA:
  `d2e6f343ac0615b6ed4a9999fb609469f74076ac`
- Config artifact:
  `data/backtest-artifacts/july-equalscope-deterministic-parity-v1-config-20260410.json`
- Dataset manifest:
  `data/replay-datasets/july-equalscope-2025-07-01-2025-08-08/manifest.json`
- Interval: `5m`
- Window: `2025-07-01` -> `2025-08-08`
- Tickers:
  `XLY, PH, GRNY, MTZ, ETN, SWK, RIOT, ON, IESC, FIX, AGQ, SGI, CDNS, HUBS, ABT, KWEB`

## Relationship To The Prior July Control

This lane should be treated as the current accepted July challenger against:

- `focused-july-mainline-equalscope-on-roundtrip-v1-20260412--20260412-091738`

The code SHA is unchanged from the accepted `ON` control baseline except for the narrow same-day fragile earnings-entry block retained for `RIOT`.

## Challenger Summary

- Total trades: `24`
- Wins / losses: `19 / 5`
- Closed PnL: `+$5,248.68`
- Avg closed PnL pct: `+2.93%`

Largest remaining losing branches:

- `CDNS-1754326800000`: `-101.48` (`SMART_RUNNER_SUPPORT_BREAK_CLOUD`)
- `GRNY-1753889400000`: `-63.95` (`SMART_RUNNER_SUPPORT_BREAK_CLOUD`)
- `RIOT-1753284000000`: `-32.99` (`PRE_EARNINGS_FORCE_EXIT`)
- `ON-1752516600000`: `-22.29` (`SMART_RUNNER_TRIM_REASSESS_ROUNDTRIP_FAILURE`)
- `GRNY-1753808400000`: `-18.54` (`PRE_EVENT_RECOVERY_EXIT`)

## Delta Vs Accepted ON Control

Accepted ON-only control:

- `25` trades
- `19 / 6`
- `+$4,882.65`

Net challenger delta:

- Trade count: `-1`
- Loss count: `-1`
- Closed PnL delta: `+$366.03`

## Structural Trade Diff

Removed:

- `RIOT-1753977600000` on `2025-07-31`: `-356.18`
- `FIX-1754588400000` on `2025-08-07`: `+16.09`

Added:

- `FIX-1754057400000` on `2025-08-01`: `+25.47`

Material common-trade lifecycle change already preserved from the prior accepted control:

- `ON-1752516600000` remains improved at `-22.29` via `SMART_RUNNER_TRIM_REASSESS_ROUNDTRIP_FAILURE`

## What This Challenger Proves

### 1. The RIOT earnings-day loss is a real removable branch

The bad `RIOT-1753977600000` Jul 31 loser does not need to exist in the basket. The narrow same-day fragile earnings-entry block removes it cleanly.

### 2. The challenger improves July without broad entry drift

Compared with the accepted `ON` control:

- only one bad `RIOT` trade is removed
- one small positive `FIX` trade is replaced by a slightly better `FIX` branch
- July closed PnL improves by `+$366.03`

### 3. The remaining July cloud-break work is now concentrated

After accepting the `ON` and `RIOT` improvements, the next meaningful lifecycle targets are:

- `GRNY-1753889400000`
- `CDNS-1754326800000`

Both still fail via `SMART_RUNNER_SUPPORT_BREAK_CLOUD`, making them the best next focused investigation class.

## Promotion Interpretation

Current classification:

- `keep as active July challenger`
- `good enough to continue forward`
- `not yet final Jul->Apr promotion package`

Reason:

- the lane is materially improved
- the accepted changes are still narrow and evidence-backed
- the remaining work is now more focused, not more ambiguous

## Recommended Next Step

Use this challenger as the active July comparison lane and work `GRNY-1753889400000` next, followed by `CDNS-1754326800000` if needed, before widening further toward the full backtest path.
