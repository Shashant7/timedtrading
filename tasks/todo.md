# Tasks / Todo

> Plan first. Verify plan. Track progress. Document results.
> See [WORKFLOW_ORCHESTRATION.md](WORKFLOW_ORCHESTRATION.md) for full workflow.

## Current Focus

- **Worker as source of truth & execution history** — See [worker-ledger-execution-plan.md](worker-ledger-execution-plan.md) for the full plan.
- **Architecture: D1-first trade reads** — Move ingest path to read trades from D1 (trades + positions), deprecate KV for trade state.

### D1 Migration Plan (done)
- [x] Ledger API reads from D1 (GET /timed/ledger/trades)
- [x] Open position lookup prefers D1 (getOpenPositionAsTrade)
- [x] **Ingest path**: Load allTrades from D1 when env.DB exists, fallback to KV
- [x] **GET /timed/trades**: Default to D1 (use ?source=kv to force KV)
- [ ] Optional: Stop writing timed:trades:all to KV (kept for backward compat / replay sync)

## Recently Completed (2026-02)

- **Card styling**: Unified Kanban, Position, Viewport — cyan/fuchsia LONG/SHORT, left accent, consistent borders
- **Simulation dashboard**: Renamed to "Simulated Account", hero chart (1D/5D/10D/30D/1Y), Holdings, Trade History by day/ticker
- **Worker modularization**: storage, ingest, trading, api, alerts modules; route table; data lifecycle cron
- **UI**: ReferenceError guards, Time Travel layout, Kanban sizing, daily summary, P&L on cards
- **Doc consolidation & workflow**: tasks/, docs/README, archive

## Completed (earlier)

- Data lifecycle cron (4 AM UTC: aggregate trail → 5m, purge old)
- Route table in worker (ROUTES, getRouteKey, early 404)
- D1 ledger, positions, trade simulation
- 3-tier TP, Kanban lanes, Time Travel
