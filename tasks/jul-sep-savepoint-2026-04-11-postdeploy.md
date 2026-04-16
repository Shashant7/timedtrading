# Jul-Sep Save Point - 2026-04-11 - Postdeploy Deterministic Lane

## Save Point

- Label: `jul-sep-postdeploy-deterministic-v1`
- Artifact bundle:
  `data/backtest-artifacts/focused-jul-sep-mainline-deterministic-postdeploy-v1-20260411--20260411-082805`
- Run id:
  `focused_replay_20260411-082805@2026-04-11T15:28:57.408Z`
- Git SHA:
  `d2e6f343ac0615b6ed4a9999fb609469f74076ac`
- Config artifact:
  `data/backtest-artifacts/july-equalscope-deterministic-parity-v1-config-20260410.json`
- Interval: `5m`
- Window: `2025-07-01` -> `2025-09-30`
- Tickers:
  `XLY, PH, GRNY, MTZ, ETN, SWK, RIOT, ON, IESC, FIX, AGQ, SGI, CDNS, HUBS, ABT, KWEB`

## Why This Is A Save Point

This is the first clean postdeploy `Jul -> Sep` cumulative lane in the current recovery cycle that should be treated as the active working checkpoint before any new variable-aware execution work begins.

It matters because it captures three things at once:

- the latest known-good deployed worker behavior
- a cumulative multi-month lane rather than a narrow proof basket
- a concrete pressure map showing what now looks stable versus what still needs refinement

This save point does not replace the original July behavioral anchor. It sits on top of it as the current cumulative checkpoint.

## Lane Summary Frozen Here

- Total trades: `61`
- Wins / losses / flats: `37 / 23 / 1`
- Realized PnL: `+$5,396.41`
- Win rate: `60.66%`

Monthly interpretation:

- July: `22` trades, `+$4,711.08`
- August: `18` trades, `-$348.10`
- September: `21` trades, `+$1,033.44`

Working interpretation:

- July remains the behavioral anchor.
- September now shows real promise and should be preserved.
- August is the current pressure zone and the primary source of the next refinement cycle.

## What This Save Point Proves

### 1. The earnings-adjacent SWK / RIOT failure mode is no longer the main problem

Compared with the earlier stale-runtime artifact, this lane confirms the current deployed worker is handling the known earnings issue materially better:

- `SWK-1753461000000` (`2025-07-25`) is now a winner: `+$59.03`, exit `TP_FULL`
- `RIOT-1753284000000` (`2025-07-23`) is now a controlled de-risk event: `-$33.00`, exit `PRE_EARNINGS_FORCE_EXIT`

So the earlier `SWK` / `RIOT` earnings-adjacent failure should be treated as resolved for the current package.

### 2. The lane still has a clear pressure cluster

The remaining pressure is no longer "missed pre-earnings enforcement." It is concentrated in a smaller set of still-costly losers, especially:

- `AGQ-1755273000000`: `-$503.50`
- `RIOT-1753977600000`: `-$356.18`
- `CDNS-1758559800000`: `-$300.62`
- `FIX-1755180000000`: `-$252.10`
- `ON-1752516600000`: `-$152.62`

That means the next cycle should focus on move-lifecycle and regime-aware trade handling, not on re-litigating the earlier earnings bug.

## Relationship To Earlier Anchors

Use the save points in this order:

1. `tasks/july-recovery-savepoint-2026-04-05.md`
   - original July behavioral anchor
2. `tasks/july-recovery-savepoint-2026-04-07-intu-jci-runtimefix.md`
   - replay/runtime correctness anchor
3. `tasks/july-recovery-savepoint-2026-04-09-fix-riot-subrunner-stoplock.md`
   - sub-runner stop/management anchor
4. this file
   - first cumulative postdeploy `Jul -> Sep` checkpoint

The key rule is:

- the July save points explain what behavior is trusted
- this Jul-Sep save point explains what cumulative behavior is currently working

## Guardrails For The Next Step

- Do not treat this save point as a license to refit July from scratch.
- Do not break July or September while trying to improve August.
- Any new variable-aware policy must be measured against this exact lane, not against memory or mixed historical artifacts.
- Every future refinement should first identify whether it belongs in:
  - baseline behavior
  - regime overlay
  - profile overlay
  - ticker-specific exception

## Recommended Next Action

Use this save point as `Step 0` for the variable-aware recovery effort:

1. freeze this lane as the current cumulative checkpoint
2. formalize the month-compounding workflow around it
3. build the first evidence-gated variable matrix from this and prior trustworthy artifacts
4. only then begin promoting context-aware entry / stop / TP / management policies
