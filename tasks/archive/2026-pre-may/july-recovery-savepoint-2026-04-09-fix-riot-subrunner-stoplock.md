# July Recovery Save Point — 2026-04-09 — FIX/RIOT Sub-Runner Stop Lock

## Save Point

- Label: `fix-riot-subrunner-stoplock`
- Artifact bundle: `data/backtest-artifacts/focused-fix-riot-postdeploy-structuregate-v5--20260409-011614`
- Deployed worker proof version: `v5`
- Interval: `5m`
- Window: `2025-07-01` -> `2025-07-10`
- Tickers: `XLY, CDNS, GRNY, FIX, RIOT, SOFI, CSCO, SWK`

## Why This Is A Save Point

This is the first trade-management proof lane in the current recovery effort where the user-confirmed target behavior is visibly restored for the two key regression names:

- `FIX` no longer gets forced into the old "trim then early stop ratchet" pattern.
- `RIOT` no longer gets forced into the old "trim then immediate protect/giveback squeeze" pattern.

The key recovery principle frozen here is:

- a partial trim realizes profit
- a partial trim does not, by itself, change invalidation
- sub-runner trimmed trades should not inherit runner-style stop tightening until the trade has genuinely progressed into a later protection phase

## User-Confirmed Proof Points

At save-point capture, the live Trade Autopsy lane for `fix-riot-postdeploy-structuregate-v5` showed:

- `RIOT`
  - status: `TP_HIT_TRIM`
  - no forced post-trim exit yet
  - visible unrealized runner PnL still working
- `FIX`
  - status: `TP_HIT_TRIM`
  - no immediate stop-driven close after the first trim
  - visible unrealized runner PnL still working

This matters more than a narrow metric delta because it confirms the management pattern itself is now aligned with the intended lifecycle behavior.

## Root Cause Frozen Here

The first attempted fix targeted only the obvious trim-related stop paths. That was not enough.

Direct worker-log forensics showed that the same bad outcome could still happen through other stop-tightening families:

- `RSI_DIVERGENCE_TRAIL`
- generic `DEFEND` / breakeven tightening
- TD exhaustion trail paths
- smart-runner defend/tighten behavior
- other sub-runner post-trim protection paths that still treated a `50%` trim like permission to manage the remainder as a runner

The winning fix was to stop treating "trimmed" and "runner" as the same thing.

## Logic Confirmed Present

These behaviors are the validated core of this save point and should be preserved unless a later iteration proves a better full-lane result:

- First partial trim no longer moves `trade.sl`.
- `50%` trimmed trades are treated as sub-runners, not true runners.
- `PROFIT_GIVEBACK` is blocked for sub-runner trims.
- post-trim divergence trails are blocked for sub-runner trims.
- TD exhaustion trails are blocked for sub-runner trims.
- smart-runner defend/tighten logic is blocked for sub-runner trims.
- generic `DEFEND` stop tightening is blocked for sub-runner trims.

## Files Changed For This Save Point

- `worker/index.js`
- `tasks/july-recovery-savepoint-2026-04-09-fix-riot-subrunner-stoplock.md`
- `tasks/july-recovery-iteration-log.md`
- `tasks/lessons.md`

## Guardrails For The Next Step

- Preserve this distinction: `trimmed` does not mean `runner`.
- Do not reintroduce hidden stop ratchets through side-channel management blocks.
- Any next-step breakeven / profit-lock framework must gate all user-visible management surfaces consistently:
  - alerts
  - Kanban lanes
  - bubble map
  - table views
  - right rail
  - Trade Autopsy / replay views
- Future protection upgrades should be stage-based and context-aware, not bolt-on path exceptions.

## Recommended Next Action

Use this save point as the base for the next staged protection iteration:

1. define when a developing trade becomes breakeven-eligible
2. define when breakeven graduates to profit-lock
3. make all lifecycle/UI surfaces narrate the same protection stage the engine is using
