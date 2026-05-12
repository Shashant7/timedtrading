# Reference-Intel Automation

## Scope

Automates the Phase 10 cycle:
- refresh reference-intel artifacts
- run reference drift + CIO drift checks
- run validation matrix
- publish revalidation trigger output

The artifacts produced live under `data/reference-intel/` and are committed
to git. **They are not consumed by the Cloudflare Worker at runtime** —
they exist for offline drift monitoring, CIO feature priors, and the
revalidation trigger that gates promotion of a new reference dataset.

## Runner — GitHub Actions (current)

- Workflow: `.github/workflows/reference-intel-refresh.yml`
- Schedule: 06:15 UTC and 18:15 UTC daily (mirrors the legacy launchd schedule).
- Manual trigger: Actions tab → "Reference Intel Refresh" → "Run workflow".
  Optional input `run_matrix` (default true) controls whether the heavier
  validation matrix runs.
- Auto-commit: refreshed artifacts under `data/reference-intel/` are
  committed back to `main` by `github-actions[bot]`.
- Optional secrets (enable wrangler-backed runtime export):
  - `CLOUDFLARE_API_TOKEN` (D1 read scope on `timed-trading-ledger`)
  - `CLOUDFLARE_ACCOUNT_ID`
  - When present, `daily_market_snapshots` and `market_events` are fetched
    fresh from D1; otherwise cached files are used (`runtime_source_mode`
    in the trigger artifact tells you which mode ran).

### Outputs to inspect

- `data/reference-intel/revalidation-trigger-v1.json` — top-level signal
  (should_revalidate / should_block_promotion / next_step)
- `data/reference-intel/drift-monitor-v1.json` — reference selection drift
- `data/reference-intel/cio-drift-monitor-v1.json` — CIO drift
- `data/reference-intel/validation-go-no-go-v1.json` — validation matrix verdict
- `data/reference-intel/history/` — archived selections per refresh

## Why a GitHub Action and not a Cloudflare Worker cron?

Workers run JavaScript only. The pipeline is ~600 LOC of Python across
~10 sub-scripts (`reference-intel-build`, `reference-trade-selector`,
`reference-coverage-report`, `context-intel-builder`,
`journey-blueprint-builder`, `policy-artifact-builder`,
`reference-cio-feature-pack`, `reference-validation-gates`,
`reference-drift-monitor`, `cio-drift-monitor`,
`reference-validation-matrix`). Porting all of it to JS for a cron whose
artifacts are not even runtime-read would be high-effort, low-value work.
GitHub Actions runs the existing Python end-to-end and commits artifacts
back — same outcome as the launchd job, but cloud-native.

## Legacy launchd path (deprecated)

The macOS launchd job at
`scripts/com.timedtrading.reference-intel-refresh.plist` and its wrapper
`scripts/run-reference-intel-refresh.sh` have been removed. To unload any
remaining local installation on the dev machine:

```bash
launchctl unload "$HOME/Library/LaunchAgents/com.timedtrading.reference-intel-refresh.plist" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/com.timedtrading.reference-intel-refresh.plist"
```

You can still run the pipeline by hand for ad-hoc development:

```bash
python3 scripts/reference-intel-refresh.py --run-matrix
```
