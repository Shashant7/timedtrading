# Re-run and Kanban — Master Plan

## Overview

1. **Worker = Source of Truth** — Classifies Kanban stages, simulates trades, persists to KV/D1.
2. **UI = Presenter** — Renders 8 Kanban lanes and Trade By Day / P&L / History from Worker data.
3. **Re-run Ingestion** — Clears trades, processes `ingest_receipts` bucket-by-bucket, rebuilds lanes and trades.

---

## 8 Kanban Lanes (Worker → UI)

| Lane | Backend stages | Meaning |
|------|----------------|---------|
| Watching | watch, setup_watch | Pattern forming, not yet confirmed |
| Almost Ready | flip_watch, just_flipped | Needs a bit more to enter |
| Enter Now | enter_now | Time to enter |
| Just Entered | just_entered | Recently entered (entry within 15 min) |
| Hold | hold | Holding (🛡 Defend badge when warnings) |
| Trim | trim | Taking profits |
| Exit | exit | Exiting |
| Archived | archive | Done |

See [KANBAN_LANE_REDESIGN.md](./KANBAN_LANE_REDESIGN.md) for details.

---

## Re-run Flow

1. **Clean slate** — Purge trades for scope (day/ticker); reset `timed:latest` entry fields.
2. **Bucket-by-bucket** — Process `ingest_receipts` by 5-min buckets, Script Version 2.5.0.
3. **Pipeline** — For each payload: `classifyKanbanStage` → `processTradeSimulation` (with `asOfTs`).
4. **Sync** — KV `timed:trades:all` and `timed:latest` updated; D1 ledger synced.

See [PROJECT_RERUN_INGESTION_PLAN.md](./PROJECT_RERUN_INGESTION_PLAN.md) for API design and query strategy.

---

## Data Flow

```
ingest_receipts (D1)
  → replay-ingest endpoint (bucket-by-bucket)
  → classifyKanbanStage (Worker)
  → processTradeSimulation (Worker)
  → KV: timed:trades:all, timed:latest:{ticker}
  → UI: Kanban, Trade By Day, P&L, History
```

---

## Implementation Status

| Component | Status |
|-----------|--------|
| Worker: 8 Kanban stages (just_entered, defend→hold) | ✅ Done |
| UI: 8 lanes, filter pills, Right Rail guidance | ✅ Done |
| Re-run: ingest_receipts bucket-by-bucket | 📋 Planned |
| Re-run: POST /timed/admin/replay-ingest | 📋 Planned |
| Re-run: scripts/replay-ingest.js | 📋 Planned |
