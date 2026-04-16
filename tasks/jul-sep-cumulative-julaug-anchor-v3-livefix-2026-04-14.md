# Jul-Sep Cumulative - 2026-04-14 - Jul-Aug Anchor v3 Livefix

## Lane

- Label: `jul-sep-cumulative-julaug-anchor-v3-livefix`
- Artifact bundle:
  `data/backtest-artifacts/focused-jul-sep-cumulative-julaug-anchor-v3-livefix--20260413-200322`
- Run id:
  `focused_replay_20260413-200322@2026-04-14T03:03:27.699Z`
- Git SHA:
  `d2e6f343ac0615b6ed4a9999fb609469f74076ac`
- Config artifact:
  `data/backtest-artifacts/july-equalscope-deterministic-parity-v1-config-20260410.json`
- Dataset manifest:
  `data/replay-datasets/july-september-2025-equalscope-focused/manifest.json`
- Interval: `5m`
- Window: `2025-07-01` -> `2025-09-30`
- Tickers:
  `XLY, PH, GRNY, MTZ, ETN, SWK, RIOT, ON, IESC, FIX, AGQ, SGI, CDNS, HUBS, ABT, KWEB`

## Headline Summary

- Total trades: `61`
- Wins / losses / flats: `42 / 18 / 1`
- Closed PnL: `+$7,366.83`

Month slices from the cumulative artifact:

- July-only (`2025-07-01` -> `2025-07-31`): `21` trades, `17 / 4`, `+$5,144.26`
- August-only (`2025-08-01` -> `2025-08-29`): `17` trades, `12 / 5`, `+$635.60`
- September-only (`2025-09-01` -> `2025-09-30`): `23` trades, `13 / 9 / 1`, `+$1,586.97`

## July Preservation Check

Primary preservation reference:

- `tasks/jul-aug-cumulative-july-anchor-v2-2026-04-14.md`
- artifact `data/backtest-artifacts/focused-jul-aug-cumulative-july-anchor-v2-focused-dataset--20260413-163146`

Window-aligned comparison through the old July boundary (`2025-08-08`):

- accepted `Jul -> Aug` checkpoint ids through `2025-08-08`: `24`
- new `Jul -> Sep` cumulative ids through `2025-08-08`: `24`
- missing ids vs accepted cumulative checkpoint: `1`
- spurious ids vs accepted cumulative checkpoint: `1`

Residual id drift versus the accepted cumulative checkpoint:

- missing: `ON-1752516600000`
- replacement: `ON-1752694800000`

Interpretation:

- The earlier residual `RIOT` timing shift from the July anchor did **not** widen further in
  this lane.
- Relative to the accepted `Jul -> Aug` checkpoint, July preservation stayed tight and only
  introduced one `ON` stem substitution.
- The substitution is not catastrophic basket loss. It is the same symbol family and the same
  exit class (`SMART_RUNNER_TRIM_REASSESS_ROUNDTRIP_FAILURE`), with a modest PnL drag:
  `-22.29` -> `-25.76`.

Important common-id deltas versus the accepted `Jul -> Aug` checkpoint through `2025-08-08`:

- `ETN-1752250200000`: `+18.84`
- `ON` replacement pair: about `-3.47`
- all other common-id drift is de minimis

## Relationship To The Frozen July Anchor

Reference July anchor:

- `tasks/july-challenger-on-riot-grny-cdns-v1-2026-04-13.md`
- artifact `data/backtest-artifacts/focused-artifact-repro-candidate-cdns-v1--20260413-134230`

Against the shorter July anchor through the same old boundary (`2025-08-08`), the cumulative
lane still differs by two substitutions:

- retained known residual: `RIOT-1751900400000` -> `RIOT-1751902200000`
- new cumulative-only substitution vs the shorter anchor: `ON-1752516600000` -> `ON-1752694800000`

This means the new lane is not perfect July parity, but it remains materially closer to the
accepted cumulative checkpoint than to the earlier broken basket-drift attempts.

## September Composition Check

Reference isolation lane:

- `tasks/september-isolation-julaug-anchor-v1-2026-04-14.md`
- artifact `data/backtest-artifacts/focused-september-isolation-julaug-anchor-v1-rerun-skip-events--20260413-173719`

September comparison:

- isolation: `19` trades, `9 / 10`, `+$748.48`
- cumulative September slice: `23` trades, `13 / 9 / 1`, `+$1,586.97`

Interpretation:

- September composes **better** inside the wider cumulative lane than it did in isolation.
- The month remains noisier than July or August, but the cumulative evidence does not show a
  collapse when September is widened on top of the prior months.
- The named `CDNS` watch item remains real, but it is materially reduced in the cumulative lane.

Most relevant September ticker shifts versus isolation:

- `CDNS`: `-$532.79` in isolation -> `-$297.10` in cumulative
- `FIX`: `-$0.45` in isolation -> `+$231.22` in cumulative
- `IESC`: `+$51.55` in isolation -> `+$457.12` in cumulative
- `RIOT`: `+$859.38` in isolation -> `+$907.15` in cumulative
- `ABT`: `-$189.49` in isolation -> `-$200.14` in cumulative
- `MTZ`: `-$97.95` in isolation -> `-$103.42` in cumulative

September still has localized friction:

- `CDNS`: largest remaining single-name loser
- `ABT` and `MTZ`: secondary losses still present
- `GRNY` and `HUBS`: background drag remains

But the month-level composition is strong enough that September does not currently justify
branching into a dedicated fix before continuing the month-compounding ladder.

## Operational Note

This lane also served as the first validation pass after repairing live `Trade Autopsy`
visibility for active focused replays. The cumulative rerun showed live rows correctly during
execution and still finalized cleanly with `61` archived trades and `144` archived config rows.

## Decision

- Treat this lane as the current cumulative `Jul -> Sep` checkpoint.
- Do not call it perfect July parity.
- The lane is acceptable enough to continue widening.
- Preserve the new `ON` substitution and the older `RIOT` timing substitution as explicit
  watch items for future cumulative widening and final promotion review.

## Next Step

Advance to October isolation from this `Jul -> Sep` checkpoint, then rerun the cumulative
`Jul -> Oct` lane before widening farther.
