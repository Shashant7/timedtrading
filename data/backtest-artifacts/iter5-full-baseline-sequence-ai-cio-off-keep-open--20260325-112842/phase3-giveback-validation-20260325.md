# Phase 3 Giveback Validation - 2026-03-25

## Scope

- Artifact dir: `data/backtest-artifacts/iter5-full-baseline-sequence-ai-cio-off-keep-open--20260325-112842`
- Run id: `backtest_2025-07-01_2026-03-25@2026-03-25T15:28:40.740Z`
- Config snapshot: `data/backtest-artifacts/iter5-full-baseline-sequence-ai-cio-off-keep-open--20260325-112842/model-config.json`
- Tickers: `CRS`, `CELH`, `APP`, `COIN`, `AVGO`, `TSLA`
- Validation window: `2025-07-01 -> 2025-08-12`

## Baseline Evidence

The targeted set includes several trimmed winners that still closed under `PROFIT_GIVEBACK` with small remaining green PnL:

- `CRS`: `+0.30%`, `PROFIT_GIVEBACK`
- `CELH`: `+0.20%`, `PROFIT_GIVEBACK`
- `APP`: `+1.24%` and `+1.63%`, `PROFIT_GIVEBACK`
- `COIN`: `+1.33%`, `PROFIT_GIVEBACK`
- `AVGO`: `-0.20%` on one targeted giveback case, `SMART_RUNNER_TD_EXHAUSTION_RUNNER` on another
- `TSLA`: `-2.19%`, `PROFIT_GIVEBACK`

This matches the user’s concern: we are flattening some normal cooling after a trim instead of letting the remaining runner be managed by structure-aware logic.

## Fix Applied

Patched:

- `worker/index.js`

Change:

- `PROFIT_GIVEBACK` no longer force-closes a trade when all of the following are true:
  - the trade is still green
  - it has already been trimmed (`trimmedPct >= 0.5`)
  - the Daily SuperTrend still supports the trade direction

In that case the system now marks a cooling-hold condition and lets the downstream runner/smart-exit logic continue managing the remainder.

## Why This Is Conservative

- The protection only applies to already-trimmed runners.
- It only applies while the remaining position is still green.
- It only applies when Daily structure still supports the trade direction.
- Losers such as the TSLA case still close through the existing protection path.

## Validation Notes

- Syntax: clean
- Lint: clean
- The modified branch leaves `PROFIT_GIVEBACK` unchanged for red remainder positions and for green trades without Daily support.
- The intended effect is to stop premature closure of “cooling but still healthy” remainder positions so later structure-aware logic can decide whether to exit.

## Replay Note

No focused replay was launched because the protected full-sequence baseline run is still using the shared replay lane and replay lock.
