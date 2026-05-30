# July Challenger - 2026-04-13 - ON + RIOT + GRNY + CDNS v1

## Challenger Package

- Label: `july-on-riot-grny-cdns-v1-challenger`
- Artifact bundle:
  `data/backtest-artifacts/focused-artifact-repro-candidate-cdns-v1--20260413-134230`
- Run id:
  `focused_replay_20260413-134230@2026-04-13T20:43:23.007Z`
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

This lane should now be treated as the current accepted July challenger against:

- `tasks/july-challenger-on-riot-grny-v1-2026-04-13.md`

The replay contract is the same as the prior accepted challenger: same code SHA, same pinned config, same frozen dataset manifest, same ticker basket, and same closeout behavior. The only intended behavioral change is the narrow `CDNS` runner-management refinement for shallow `PULLBACK_PLAYER` / `correction_transition` branches after trim.

## Challenger Summary

- Total trades: `24`
- Wins / losses: `20 / 4`
- Closed PnL: `+$5,432.82`

Largest remaining losing branches:

- `RIOT-1753284000000`: `-32.99` (`PRE_EARNINGS_FORCE_EXIT`)
- `ON-1752516600000`: `-22.29` (`SMART_RUNNER_TRIM_REASSESS_ROUNDTRIP_FAILURE`)
- `GRNY-1753808400000`: `-18.52` (`PRE_EVENT_RECOVERY_EXIT`)
- `GRNY-1753889400000`: `-4.81` (`PRE_EVENT_RECOVERY_EXIT`)

## Delta Vs Prior ON + RIOT + GRNY Challenger

Prior accepted challenger:

- `24` trades
- `19 / 5`
- `+$5,298.54`

Net challenger delta:

- Trade count: `flat`
- Trade ids: `identical`
- Closed PnL delta: `+$134.28`

## Structural Trade Diff

Removed:

- none

Added:

- none

Material common-trade lifecycle change:

- `CDNS-1754326800000` improved from `SMART_RUNNER_SUPPORT_BREAK_CLOUD` at `-101.47` to `SMART_RUNNER_TRIM_REASSESS_ROUNDTRIP_FAILURE` at `+32.75`

Minor residual common-id drift:

- `FIX`: `+0.02`
- `GRNY`: `+0.04`

## What This Challenger Proves

### 1. The earlier “basket drift” conclusion was a replay-shape artifact

The rejected `CDNS` candidate only looked toxic when compared on a hand-built replay trace that did not reproduce the accepted challenger contract. Once the lane was replayed through the same focused-run launcher shape, frozen dataset manifest, and run registration/finalization path, the candidate kept the exact same 24 trade ids as the accepted control.

### 2. The CDNS refinement is genuinely narrow

The refined branch does not reshuffle the basket. It changes the lifecycle of the exact target trade in place and exits the shallow post-trim `CDNS` branch earlier as `SMART_RUNNER_TRIM_REASSESS_ROUNDTRIP_FAILURE`.

### 3. July’s main remaining damage is no longer concentrated in CDNS

With `CDNS` repaired in place, the remaining July loss stack is now headed by:

- `RIOT-1753284000000`
- `ON-1752516600000`
- `GRNY-1753808400000`

## Promotion Interpretation

Current classification:

- `keep as active July challenger`
- `promotable over the prior ON + RIOT + GRNY lane`
- `good enough to continue forward`

Reason:

- the targeted `CDNS` loser improved in place
- no trade ids were added or removed versus the accepted prior challenger
- the net July basket improved by `+$134.28`

## Recommended Next Step

Use this challenger as the active July comparison lane and move to the next remaining July loss branch, with `RIOT-1753284000000` as the first obvious review target.
