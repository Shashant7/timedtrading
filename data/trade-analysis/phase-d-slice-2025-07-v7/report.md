# Phase D slice — 2025-07 (run_id `phase-d-slice-2025-07-v7`)

> v6 + merged backdrop earnings clusters on replay env. **Bug:** clusters were
> built on `replayEnv` but not copied to `result._env`, so the entry gate never
> saw them — TSLA/SWK still entered. Fixed in next commit for v8.

| Metric | v7 | v6 | anchor |
|---|---|---|---|
| Trades | 30 | 26 | 25 |
| WR | 63.3% | 65.4% | 76.0% |
| Sum pnl | +20.52% | +18.08% | +26.05% |

Still below anchor. v8 re-run after `_earningsClusterWindows` wiring fix.
