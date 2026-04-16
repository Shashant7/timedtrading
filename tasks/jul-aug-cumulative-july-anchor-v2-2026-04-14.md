# Jul-Aug Cumulative - 2026-04-14 - July Anchor v2 Focused Dataset

## Lane

- Label: `jul-aug-cumulative-july-anchor-v2-focused-dataset`
- Artifact bundle:
  `data/backtest-artifacts/focused-jul-aug-cumulative-july-anchor-v2-focused-dataset--20260413-163146`
- Run id:
  `focused_replay_20260413-163146@2026-04-13T23:32:28.153Z`
- Git SHA:
  `d2e6f343ac0615b6ed4a9999fb609469f74076ac`
- Config artifact:
  `data/backtest-artifacts/july-equalscope-deterministic-parity-v1-config-20260410.json`
- Dataset manifest:
  `data/replay-datasets/july-august-2025-equalscope-focused/manifest.json`
- Interval: `5m`
- Window: `2025-07-01` -> `2025-08-29`
- Tickers:
  `XLY, PH, GRNY, MTZ, ETN, SWK, RIOT, ON, IESC, FIX, AGQ, SGI, CDNS, HUBS, ABT, KWEB`

## Why This Lane Matters

This is the first `Jul -> Aug` cumulative lane in this cycle that was launched on
the corrected basket-scoped focused dataset contract rather than the weaker
generic gap-check manifest. The contract repair materially changed the replay
shape and removed the large July basket drift seen on the prior cumulative
attempt.

## Headline Summary

- Total trades: `36`
- Wins / losses: `27 / 9`
- Closed PnL: `+$5,517.45`

## July Preservation Check

Reference July anchor:

- `tasks/july-challenger-on-riot-grny-cdns-v1-2026-04-13.md`
- artifact `focused-artifact-repro-candidate-cdns-v1--20260413-134230`
- headline July anchor PnL `+$5,432.82`

Preservation result through the old July validation window (`2025-07-01 -> 2025-08-08`):

- anchor trade ids: `24`
- cumulative trade ids through `Aug 8`: `24`
- missing ids: `1`
- spurious ids: `1`

Residual structural drift:

- missing: `RIOT-1751900400000`
- replacement: `RIOT-1751902200000`

Interpretation:

- The earlier cumulative attempt failed badly (`9` missing / `12` spurious).
- The corrected focused dataset contract collapses that drift to one timestamp
  substitution on the same symbol family rather than a broad basket reshuffle.

## Residual Risk

The remaining `RIOT` drift is not free:

- anchor branch: `RIOT-1751900400000`, `+$985.53`, exit `sl_breached`
- cumulative replacement: `RIOT-1751902200000`, `+$857.63`, exit `sl_breached`

Other common-trade lifecycle deltas are comparatively small, with the next
largest differences coming from later closeout behavior such as:

- `GRNY-1754413800000`: about `-86`
- `FIX-1754588400000`: about `-9.24`

These are meaningful enough to record, but no longer large enough to block the
month-compounding ladder on their own.

## Decision

- Treat this lane as the current cumulative checkpoint.
- Do not call it perfect July parity.
- It is acceptable enough to proceed to September isolation, with the residual
  `RIOT` timing shift explicitly preserved as a watch item for future cumulative
  widening and final promotion review.
# Jul-Aug Cumulative - 2026-04-14 - July Anchor v2

## Lane

- Label: `jul-aug-cumulative-july-anchor-v2-focused-dataset`
- Artifact bundle:
  `data/backtest-artifacts/focused-jul-aug-cumulative-july-anchor-v2-focused-dataset--20260413-163146`
- Run id:
  `focused_replay_20260413-163146@2026-04-13T23:32:28.153Z`
- Git SHA:
  `d2e6f343ac0615b6ed4a9999fb609469f74076ac`
- Config artifact:
  `data/backtest-artifacts/july-equalscope-deterministic-parity-v1-config-20260410.json`
- Dataset manifest:
  `data/replay-datasets/july-august-2025-equalscope-focused/manifest.json`
- Interval: `5m`
- Window: `2025-07-01` -> `2025-08-29`
- Tickers:
  `XLY, PH, GRNY, MTZ, ETN, SWK, RIOT, ON, IESC, FIX, AGQ, SGI, CDNS, HUBS, ABT, KWEB`

## Summary

- Total trades: `36`
- Wins / losses: `27 / 9`
- Closed PnL: `+$5,517.45`

## July Preservation Check

Comparison baseline:

- `tasks/july-challenger-on-riot-grny-cdns-v1-2026-04-13.md`
- artifact `data/backtest-artifacts/focused-artifact-repro-candidate-cdns-v1--20260413-134230`

Window-aligned preservation result through the old July boundary (`2025-08-08`):

- anchor trade count: `24`
- cumulative trade count through `2025-08-08`: `24`
- missing ids: `1`
- spurious ids: `1`

Residual id drift:

- missing: `RIOT-1751900400000`
- replacement: `RIOT-1751902200000`

Interpretation:

- The broad basket reshuffle from the first broken cumulative attempt is gone.
- The repaired focused dataset contract restored the trusted July basket shape.
- The only remaining id drift is a single `RIOT` stem shifting by `30m`, not a
  multi-name basket rewrite.

## Common-Trade Lifecycle Notes

The largest common-id deltas versus the frozen July anchor are not fresh entry
contamination. They come from trades that were still active near the old July
window edge and therefore had more room to evolve in the wider lane.

Most meaningful examples:

- `GRNY-1754413800000`: anchor exited `replay_end_close`; cumulative exited
  earlier as `SMART_RUNNER_SUPPORT_BREAK_CLOUD` (`-86.00` delta vs the forced
  boundary close in the shorter lane)
- `FIX-1754588400000`: anchor exited `replay_end_close`; cumulative exited as
  `PROFIT_GIVEBACK` (`-9.24` delta)

These should be treated as expected cumulative-lane lifecycle differences, not
as proof that the July basket itself was lost.

## Promotion Read

Classification:

- `acceptable cumulative checkpoint`
- `good enough to continue widening`

Reason:

- August isolated cleanly and stayed net positive.
- The cumulative lane no longer shows major July basket contamination.
- July count integrity is restored and only one residual `RIOT` timing stem
  remains.

## Next Step

Advance to September isolation from this `Jul -> Aug` checkpoint, then rerun
the cumulative `Jul -> Sep` lane before widening farther.
