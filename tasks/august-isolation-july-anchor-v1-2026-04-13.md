# August Isolation - 2026-04-13 - July Anchor v1

## Lane

- Label: `august-isolation-july-anchor-v1`
- Artifact bundle:
  `data/backtest-artifacts/focused-august-isolation-july-anchor-v1--20260413-142741`
- Run id:
  `focused_replay_20260413-142741@2026-04-13T21:28:17.247Z`
- Git SHA:
  `d2e6f343ac0615b6ed4a9999fb609469f74076ac`
- Config artifact:
  `data/backtest-artifacts/july-equalscope-deterministic-parity-v1-config-20260410.json`
- Dataset manifest:
  `data/replay-datasets/august-2025-canonical/manifest.json`
- Interval: `5m`
- Window: `2025-08-01` -> `2025-08-29`
- Tickers:
  `XLY, PH, GRNY, MTZ, ETN, SWK, RIOT, ON, IESC, FIX, AGQ, SGI, CDNS, HUBS, ABT, KWEB`

## Summary

- Total trades: `10`
- Wins / losses: `7 / 3`
- Closed PnL: `+$369.00`

This isolated August lane is acceptable enough to advance into the cumulative
`Jul -> Aug` gate. August did not reproduce the broader `-348` pressure seen in
the older Jul-Sep savepoint as a standalone month-level failure cluster.

## August Loss Classification

### 1. Boundary / cumulative-lane artifact

- `XLY-1756408800000`: `-72.07`, exit `replay_end_close`

Interpretation:

- This is the only meaningfully-sized August loss in isolation.
- It was partially trimmed (`10%`) and then force-closed by the month boundary.
- Because the loss is dominated by isolated-lane closeout behavior, it should be
  judged again in the cumulative `Jul -> Aug` lane before any policy change is
  considered.

Classification:

- `baseline contract / boundary artifact`
- not a standalone August fix candidate yet

### 2. Baseline protective behavior

- `ABT-1756139400000`: `-12.57`, exit `PRE_EVENT_RECOVERY_EXIT`

Interpretation:

- This is a small, controlled pre-event protective exit.
- No trim was taken and there is no evidence here of a runaway lifecycle bug.

Classification:

- `baseline`
- acceptable noise, not a blocker

### 3. Regime / profile-specific minor roundtrip

- `PH-1755103800000`: `-3.41`, exit `SMART_RUNNER_TRIM_REASSESS_ROUNDTRIP_FAILURE`

Interpretation:

- This is a tiny post-trim giveback.
- The trade sat in a `PULLBACK_PLAYER` / `choppy_selective` branch, which makes
  it the only August loser that even faintly resembles the earlier `CDNS`
  lifecycle family.
- The loss is too small to justify a new August-only change without first
  testing whether the cumulative lane preserves or improves it naturally.

Classification:

- `regime/profile`
- monitor in `Jul -> Aug`, do not promote a fix from this evidence alone

## Decision

- No August-only fix is warranted from this lane.
- Promote the evidence to the cumulative `Jul -> Aug` rerun.
- Treat July preservation as the real next gate.
