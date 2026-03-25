# Phase 2 DOA Validation - 2026-03-25

## Scope

- Artifact dir: `data/backtest-artifacts/iter5-full-baseline-sequence-ai-cio-off-keep-open--20260325-112842`
- Run id: `backtest_2025-07-01_2026-03-25@2026-03-25T15:28:40.740Z`
- Config snapshot: `data/backtest-artifacts/iter5-full-baseline-sequence-ai-cio-off-keep-open--20260325-112842/model-config.json`
- Tickers: `CDNS`, `CVNA`, `PH`, `TT`, `MSFT`
- Validation window: `2025-07-08 -> 2025-07-29`

## Baseline Evidence

The named ticker set all showed `doa_early_exit` despite the live config snapshot containing:

- `deep_audit_doa_early_exit_enabled=false`

Examples from the baseline artifact:

- `CDNS`: `-0.23%`, hold `1140m`, exit `doa_early_exit`, grade `Prime`
- `CVNA`: `-2.11%`, hold `360m`, exit `doa_early_exit`, grade `Speculative`
- `PH`: `-0.17%`, hold `1110m`, exit `doa_early_exit`, grade `Confirmed`
- `TT`: `-0.99%`, hold `4020m`, exit `doa_early_exit`, grade `Speculative`
- `MSFT`: `-0.35%`, hold `5460m`, exit `doa_early_exit`, grade `Confirmed`

That made phase 2 look like a runtime bug rather than a mere threshold-tuning issue.

## Fix Applied

Patched:

- `worker/pipeline/tt-core-exit.js`
- `worker/pipeline/legacy-exit.js`

Changes:

- DOA exits now honor `deep_audit_doa_early_exit_enabled`.
- The existing SuperTrend structure check was left intact after verifying the codebase uses Pine convention (`stDir = -1` is bullish, `stDir = 1` is bearish).

## Validation

- Lint: clean
- Syntax: clean
- Local gate checks:
  - live-config-disabled -> `doaExit=false`
  - enabled-bullish-long-structure (`stDir=-1`) -> `doaExit=false`
  - enabled-bearish-long-structure (`stDir=1/0`) -> `doaExit=true`

## Before / After Notes

- Before:
  - DOA exits could still fire even when the live config explicitly disabled them.
- After:
  - Current golden-baseline config will no longer leak unwanted `doa_early_exit` exits.
  - If DOA is re-enabled later, it still uses the existing Pine-style SuperTrend direction convention already used elsewhere in the stack.

## Replay Note

No focused replay was launched because the protected full-sequence baseline run is still using the shared replay lane and replay lock.
