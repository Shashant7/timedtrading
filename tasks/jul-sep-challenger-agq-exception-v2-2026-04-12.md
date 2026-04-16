# Jul-Sep Challenger - 2026-04-12 - AGQ Exception v2

## Challenger Package

- Label: `jul-sep-agq-exception-v2-challenger`
- Artifact bundle:
  `data/backtest-artifacts/focused-julsep-mainline-agq-exception-v2-20260412--20260411-225718`
- Run id:
  `focused_replay_20260411-225718@2026-04-12T05:58:06.895Z`
- Git SHA:
  `d2e6f343ac0615b6ed4a9999fb609469f74076ac`
- Config artifact:
  `data/backtest-artifacts/july-equalscope-deterministic-parity-v1-config-20260410.json`
- Interval: `5m`
- Window: `2025-07-01` -> `2025-09-30`
- Tickers:
  `XLY, PH, GRNY, MTZ, ETN, SWK, RIOT, ON, IESC, FIX, AGQ, SGI, CDNS, HUBS, ABT, KWEB`

## Relationship To The Frozen Savepoint

This lane is not a replacement savepoint yet.

It should be treated as the active challenger against:

- `tasks/jul-sep-savepoint-2026-04-11-postdeploy.md`

The code SHA is unchanged from the frozen cumulative savepoint. The difference is runtime behavior from the narrow `AGQ` pullback exception applied through the replay config/runtime surface.

## Challenger Summary

- Total trades: `60`
- Wins / losses / flats: `38 / 21 / 1`
- Realized PnL: `+$5,745.13`
- Win rate: `63.33%`

Monthly breakdown:

- July: `+$4,582.72`
- August: `+$443.52`
- September: `+$718.89`

## Delta Vs Frozen Savepoint

Frozen savepoint:

- `61` trades
- `37 / 23 / 1`
- `+$5,396.41`

Net challenger delta:

- Trade count: `-1`
- Wins / losses: `+1 win`, `-2 losses`
- PnL delta: `+$348.72`

Monthly delta:

- July: `-128.36`
- August: `+791.62`
- September: `-314.55`

## Structural Trade Diff

Removed:

- `AGQ-1754678400000` on `2025-08-08`: `-236.34`
- `AGQ-1755273000000` on `2025-08-15`: `-503.50`
- `RIOT-1751900400000` on `2025-07-07`: `+985.53`

Added:

- `AGQ-1755869400000` on `2025-08-22`: `+48.13`
- `RIOT-1751902200000` on `2025-07-07`: `+857.63`

Preserved critical branch:

- `AGQ-1756129200000` on `2025-08-25` remains and improves slightly (`+172.02` -> `+173.11`)

## What This Challenger Proves

### 1. The AGQ exception survives the full cumulative lane

The focused proof result was not an isolated artifact. In the full `Jul -> Sep` basket:

- Aug 8 AGQ loser is gone
- Aug 15 AGQ loser is gone
- Aug 25 AGQ winner remains
- a new late-August AGQ win appears on Aug 22

### 2. August is no longer the red month

This is the main reason to keep the challenger alive:

- frozen savepoint August: `-$348.10`
- challenger August: `+$443.52`

That is the first cumulative proof in this cycle that turns the active pressure month green without breaking the lane outright.

### 3. The challenger still has a non-AGQ drift caveat

The lane is improved overall, but it is not a pure one-for-one replay improvement:

- the early July `RIOT` timestamp still substitutes to a nearby branch
- the Sep 4 `RIOT` trade keeps the same trade id and same effective move percentage but realizes materially less PnL

That means the challenger is valid as a live candidate, but not yet a zero-drift promotion package.

## Promotion Interpretation

Current classification:

- `keep as challenger`
- `not yet promote as replacement savepoint`

Reason:

- August improvement is large and real
- the new behavior is still narrow and evidence-backed
- residual `RIOT` drift needs explicit classification before promotion

## Recommended Next Step

Use this challenger as the new comparison lane for any follow-up work on the `AGQ` exception.

Before replacing the frozen cumulative savepoint, complete a focused `RIOT` drift review and decide whether the remaining path/sizing drift is acceptable or needs to be neutralized.
