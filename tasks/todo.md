# Tasks / Todo

> Plan first. Verify plan. Track progress. Document results.
> See [WORKFLOW_ORCHESTRATION.md](WORKFLOW_ORCHESTRATION.md) for full workflow.

## Current Focus

**System hardened and production-ready.** Monitoring live performance.

---

## Completed (Feb 2026)

### Kanban & Position Alignment
- [x] D1 `positions` table as single source of truth
- [x] Position-aware `classifyKanbanStage()` — queries D1 for open position context
- [x] Dual-mode Kanban: DISCOVERY (watch → setup → enter) vs MANAGEMENT (active → trim → exit)
- [x] Stage monotonicity enforcement for open positions

### Exit/Trim/SL System
- [x] D1 `positions` table stores `stop_loss` and `take_profit` columns
- [x] Trailing SL persisted to D1 after each adjustment
- [x] 3-tier TP system: TRIM (60%), EXIT (20%), RUNNER (20%)
- [x] SL breach detection in `computeMoveStatus` using position's dynamic SL
- [x] P&L-based exit at -8% loss
- [x] P&L-based trim at +5% profit

### Entry Controls
- [x] Global position limits: `MAX_OPEN_POSITIONS = 15`, `MAX_DAILY_ENTRIES = 8`
- [x] Fallback SL/TP calculation when payload missing values
- [x] Relaxed entry filters for testing (RR 0.3, completion 0.8, phase 0.85)

### UI Alignment
- [x] Simulation Dashboard sources positions from D1
- [x] Open position cards show entry price (bold), since-entry P&L on left
- [x] Kanban lanes match open position state

### Infrastructure
- [x] D1 migration: `add-position-sl.sql` (stop_loss, take_profit columns)
- [x] `d1UpdatePositionSL`, `d1InsertPosition` with SL/TP
- [x] `getPositionContext` returns SL/TP from D1
- [x] Replay scripts working with new system

---

## Backlog

- [ ] Add env knobs for trim/exit thresholds (TRIM_COMPLETION_PCT, EXIT_ADVERSE_PCT)
- [ ] Consistency check endpoint: `GET /timed/debug/consistency-check`
- [ ] Auto-repair endpoint: `POST /timed/admin/repair-alignment`
- [ ] Daily reconciliation cron for position/stage alignment
- [ ] Discord alert on position/stage mismatch

---

## Earlier Completed

- Data lifecycle cron (4 AM UTC: aggregate trail → 5m, purge old)
- Route table in worker (ROUTES, getRouteKey, early 404)
- D1 ledger, positions, trade simulation
- Worker modularization: storage, ingest, trading, api, alerts modules
- Card styling: cyan/fuchsia LONG/SHORT, left accent, consistent borders
- Simulation dashboard: Simulated Account, hero chart, Holdings, Trade History
