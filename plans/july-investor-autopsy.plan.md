# July investor → Trade Autopsy

## Goal
Load July 2025 **long-term (investor)** positions opened in the month into Trade Autopsy so each can be graded with the same workflow as monthly trader slices. Include OPEN rows, not only closed.

## Design
1. Map `investor_positions` + `investor_lots` → `backtest_run_trades` under a dedicated `run_id`.
2. `POST /timed/admin/trade-autopsy/archive-investor` archives from local D1 or an import payload.
3. Autopsy GET includes OPEN for investor run_ids (or `include_open=1`).
4. `scripts/export-investor-to-autopsy.mjs` copies preprod July opens → production autopsy.
5. `investor-slice.sh` auto-archives at end of each month slice.

## Canonical July long-term book
- `run_id=investor-slice-2025-07-post890`
- Source: preprod D1 positions with `first_entry_ts` in 2025-07 (15 opens)

## Short-term July (already available)
- `phase-c-slice-2025-07-v1` (25)
- `phase-d-slice-2025-07-v2` (42)
