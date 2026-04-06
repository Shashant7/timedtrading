# July Recovery Freeze Note

This artifact directory is the current best July recovery checkpoint from `main`.

## Identity

- Label: `july-mainline-reanchor-v5-grnyfix`
- Run ID: `focused_replay_20260406-192436@2026-04-06T23:24:37.390Z`
- Window: `2025-07-01 -> 2025-08-05`
- Universe: `UNP, INTU, SANM, RIOT, B, ORCL, GRNY`
- Config: `model-config.json`
- Manifest: `manifest.json`
- Trades: `trades.json`
- Trade Autopsy export: `trade-autopsy-trades.json`

## Why This Matters

This is the first deployed validation lane in this session where:

- `RIOT-1751902200000` no longer prematurely closes on `PHASE_LEAVE_100`
- `RIOT-1751902200000` reaches `TP_FULL`
- `GRNY-1751387400000` no longer closes via `SMART_RUNNER_TD_EXHAUSTION_RUNNER`
- `GRNY-1751387400000` remains a trimmed runner (`TP_HIT_TRIM`)

## Preservation Files

- `current-relevant-diff.patch` captures the current unreleased code diff for the main surfaces used in this recovery pass.
- `current-git-status.txt` captures workspace state at freeze time.

## Known Remaining Issues

- Entry/exit snapshots are still missing in Trade Autopsy.
- Trade Autopsy active/live run selection can fall back to an older completed run after focused replay finalize.
- Several trades still give back from local peaks before exit.

## Reference URL

- `trade-autopsy.html?run_id=focused_replay_20260406-192436%402026-04-06T23%3A24%3A37.390Z`
