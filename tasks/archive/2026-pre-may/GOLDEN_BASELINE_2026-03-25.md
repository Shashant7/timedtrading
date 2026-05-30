# Golden Baseline - 2026-03-25

This file freezes the exact reproduction recipe for the current live sequence run the user designated as the new golden baseline.

## Baseline Identity

- Label: `iter5-full-baseline-sequence-ai-cio-off-keep-open`
- Run id: `backtest_2025-07-01_2026-03-25@2026-03-25T15:28:40.740Z`
- Git SHA: `88a8af67b8d0c03b89149997482721355577a803`
- Artifact dir: `data/backtest-artifacts/iter5-full-baseline-sequence-ai-cio-off-keep-open--20260325-112842`
- Date range: `2025-07-01 -> 2026-03-25`
- Mode: `sequence`
- Keep open at end: `true`
- AI CIO enabled in replay: `false`
- Config snapshot keys captured: `133`

## Exact Launch Command

```sh
./scripts/full-backtest.sh --sequence --keep-open-at-end --label="iter5-full-baseline-sequence-ai-cio-off-keep-open" --desc="Active Trader then Investor sequence from Jul 1 2025 to Mar 25 2026 with AI CIO disabled in replay and end-of-run positions preserved for analysis/CIO refresh" --env-override ai_cio_enabled=false --env-override ai_cio_replay_enabled=false 2025-07-01 2026-03-25 20
```

## Frozen Provenance

The active artifact directory now contains the run-scoped baseline provenance needed to reproduce this lane:

- `manifest.json`
- `run-detail.json`
- `model-config.json`
- `mission-control-monitor.json`
- `mission-control-monitor.jsonl`
- `direction-participation-summary.json`
- `closed-trade-sidecar-summary.json`
- `closed-trade-sidecar-index.json`
- `closed-trade-sidecar-events.jsonl`

## Current Observed State At Freeze Time

- Worker run status: `running`
- Replay phase: `trader`
- Progress: `10 / 192` replay days (`2.6%`)
- Latest monitor snapshot:
  - total trades: `35`
  - closed: `26`
  - open: `9`
  - win rate: `65.38%`
  - pnl: `1459.66`
  - profit factor: `3.55`
- Monitor note at freeze time: opportunity pause was suggested because `doa_early_exit` accounted for most early losses, but the baseline provenance was still preserved exactly as launched.

## Important Notes

- The pre-reset snapshot in this artifact directory was created automatically by `scripts/full-backtest.sh` before the replay reset. That preserves the prior live state for A/B comparison, not the current run's eventual final summary.
- `model-config.json` was exported from the run registry while the run was active so the exact config snapshot is no longer dependent on mutable live `model_config`.
- `run-finalize.json` does not exist yet because the run has not completed. After completion, refresh the artifact bundle with finalized run summary files before any formal promotion step.
- `run-detail.json` currently shows `is_protected_baseline: 0`. Treat this file plus the exact command above as the protected reproduction contract until a formal promotion path is executed.
