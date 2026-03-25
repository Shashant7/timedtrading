# Phase 1 TT Event Validation - 2026-03-25

## Scope

- Artifact dir: `data/backtest-artifacts/iter5-full-baseline-sequence-ai-cio-off-keep-open--20260325-112842`
- Run id: `backtest_2025-07-01_2026-03-25@2026-03-25T15:28:40.740Z`
- Config snapshot: `data/backtest-artifacts/iter5-full-baseline-sequence-ai-cio-off-keep-open--20260325-112842/model-config.json`
- Ticker: `TT`
- Validation window: `2025-07-28 -> 2025-07-30`

## What Was Validated

- Production `market_events` previously lacked the scheduled-event columns added in code (`event_key`, `source`, `status`, `scheduled_ts`, `scheduled_time_et`, `session`).
- The live D1 schema was upgraded in place so the canonical event table now matches the replay/live code expectations.
- The TT earnings row exists in production D1 for `2025-07-30`:
  - `ticker=TT`
  - `event_name=TT Earnings`
  - `event_type=earnings`
  - `date=2025-07-30`
- Even with null schedule/session metadata on the historical row, the current replay logic still treats the event as actionable through the fallback path.

## Trigger Timing Check

Using the same `eventIsDueForRiskReduction()` fallback behavior now in `worker/index.js`:

- `2025-07-28` -> `due=false`
- `2025-07-29` -> `due=true`
- `2025-07-30` -> `due=true`

That is the intended behavior for the TT earnings case: the pre-event reduction window opens on the trading day before the `2025-07-30` earnings event.

## Before / After Notes

- Before:
  - The TT earnings event row already existed.
  - Production D1 schema was stale, so the canonical scheduled-event columns were missing.
- After:
  - Production D1 schema now includes the scheduled-event columns expected by the upgraded event-risk logic.
  - TT remains queryable through the canonical `market_events` table.
  - The fallback timing logic confirms TT becomes eligible for pre-earnings risk reduction on `2025-07-29`.

## Replay Note

No separate focused replay was launched for phase 1 because the protected full-sequence baseline run is still occupying the shared replay lane and replay lock. This validation was intentionally performed without disturbing that baseline run.
