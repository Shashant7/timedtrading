# July Challenger - 2026-04-13 - ON + RIOT + GRNY v1

## Challenger Package

- Label: `july-on-riot-grny-v1-challenger`
- Artifact bundle:
  `data/backtest-artifacts/focused-july-mainline-equalscope-grny-first-trim-floor-v2b-20260413--20260413-071043`
- Run id:
  `focused_replay_20260413-071043@2026-04-13T14:11:28.162Z`
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

## Relationship To The Prior July Challenger

This lane should be treated as the current accepted July challenger against:

- `tasks/july-challenger-on-riot-v1-2026-04-12.md`

The code SHA is unchanged from the prior accepted July challenger except for the narrow first-trim maturity guard now applied to `ATR_RANGE_EXHAUST` for `SLOW_GRINDER` names.

## Challenger Summary

- Total trades: `24`
- Wins / losses: `19 / 5`
- Closed PnL: `+$5,298.54`

Largest remaining losing branches:

- `CDNS-1754326800000`: `-101.47` (`SMART_RUNNER_SUPPORT_BREAK_CLOUD`)
- `RIOT-1753284000000`: `-32.99` (`PRE_EARNINGS_FORCE_EXIT`)
- `ON-1752516600000`: `-22.29` (`SMART_RUNNER_TRIM_REASSESS_ROUNDTRIP_FAILURE`)
- `GRNY-1753808400000`: `-18.54` (`PRE_EVENT_RECOVERY_EXIT`)
- `GRNY-1753889400000`: `-4.85` (`PRE_EVENT_RECOVERY_EXIT`)

## Delta Vs Prior ON + RIOT Challenger

Prior accepted challenger:

- `24` trades
- `19 / 5`
- `+$5,248.68`

Net challenger delta:

- Trade count: `flat`
- Closed PnL delta: `+$49.86`

## Structural Trade Diff

Removed:

- `FIX-1754057400000` on `2025-08-01`: `+25.47`

Added:

- `FIX-1754588400000` on `2025-08-07`: `+16.17`

Material common-trade lifecycle change:

- `GRNY-1753889400000` improved from `SMART_RUNNER_SUPPORT_BREAK_CLOUD` at `-63.95` to `PRE_EVENT_RECOVERY_EXIT` at `-4.85`

## What This Challenger Proves

### 1. The GRNY early-trim issue was real and fixable

The prior GRNY loser was not another `ON`-style large masked runner giveback. The real problem was an overly eager first trim through `ATR_RANGE_EXHAUST` on a `SLOW_GRINDER` branch that had not earned a meaningful first trim yet.

### 2. The narrowed fix stayed contained

The earlier broad version improved `GRNY` but created unacceptable collateral in `CDNS` and early `RIOT/FIX` pathing. Narrowing the guard to `SLOW_GRINDER` preserved the GRNY improvement while leaving `CDNS` and `RIOT` behavior effectively unchanged.

### 3. The remaining July work is now concentrated on CDNS

After accepting `ON`, `RIOT`, and `GRNY`, the next meaningful July lifecycle target is:

- `CDNS-1754326800000`

## Promotion Interpretation

Current classification:

- `keep as active July challenger`
- `good enough to continue forward`
- `not yet final Jul->Apr promotion package`

Reason:

- cumulative July PnL improved again
- the accepted changes remain narrow and evidence-backed
- the remaining July damage is now concentrated into a single main lifecycle branch

## Recommended Next Step

Use this challenger as the active July comparison lane and work `CDNS-1754326800000` next.
