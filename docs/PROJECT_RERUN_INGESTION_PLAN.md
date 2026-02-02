# Project Re-run Ingestion — Plan

> **Related**: [KANBAN_LANE_REDESIGN.md](./KANBAN_LANE_REDESIGN.md) — Worker maintains 8 Kanban lanes; re-run uses same `classifyKanbanStage` + `processTradeSimulation` pipeline.

## Goals

1. **Trades cleared out** — Clean slate for the re-run scope
2. **Trade By Day, Trade By P&L, Trade History start fresh** — All UI components reflect only re-run results (source: KV `timed:trades:all`)
3. **Run by ticker or by day or both** — Flexible scope
4. **Runs fast** — Avoid D1 memory limits, minimize round-trips
5. **Kanban lanes accurate** — Re-run processes ingest bucket-by-bucket; Worker classifies stages; UI presents 8 lanes (Watching → Archived)

---

## Data Source: ingest_receipts

| Column        | Purpose                          |
|---------------|----------------------------------|
| receipt_id    | PK                               |
| ticker        | Filter by ticker                 |
| ts            | Chronological order              |
| bucket_5m     | `floor(ts/300000)*300000` — 5-min buckets |
| script_version| **Filter for 2.5.0**             |
| payload_json  | Full ingest snapshot             |

**Indexes**: `idx_ingest_receipts_bucket`, `idx_ingest_receipts_ticker_bucket`

---

## Processing Model: Bucket-by-Bucket (Real-Time Simulation)

Process buckets in chronological order, as if ingestion were happening in real time:

```
9:30 ET (bucket B1) → process all receipts in B1 → update state
9:35 ET (bucket B2) → process all receipts in B2 → update state
...
4:00 ET (bucket B78)
```

**Why buckets?**
- Small, bounded result sets per request (avoids D1 memory limits)
- Matches real-time semantics (5-min cadence)
- Indexed by `bucket_5m` — efficient queries

---

## Query Strategy (Avoid D1 Limits)

**Problem**: `payload_json` can be large; selecting many rows hits "Invalid string length" / memory limits.

**Approach**: Two-phase fetch per bucket

1. **Phase 1 (lightweight)**:  
   `SELECT receipt_id, ticker, ts FROM ingest_receipts  
    WHERE bucket_5m = ? AND script_version = '2.5.0'  
    [AND ticker = ?]  
    ORDER BY ts ASC  
    LIMIT ? OFFSET ?`

2. **Phase 2 (per row)**:  
   `SELECT payload_json FROM ingest_receipts WHERE receipt_id = ?`  
   — One fetch per receipt; ~20–50 per batch to stay under subrequest limits.

**Alternative**: Single query but **exclude** `payload_json`, then fetch payload only for rows we actually process. `ingest_receipts` has `receipt_id` PK, so single-row fetch by `receipt_id` is cheap.

---

## API Design

### Endpoint: `POST /timed/admin/replay-ingest`

| Param       | Required | Description                                      |
|-------------|----------|--------------------------------------------------|
| `date`      | No       | YYYY-MM-DD (default: today ET)                   |
| `ticker`    | No       | Single ticker (e.g. BE); omit = all tickers      |
| `scriptVersion` | No   | Default `2.5.0`                                  |
| `bucket`    | No       | Single bucket (ms) to process; omit = full day   |
| `limit`     | No       | Rows per batch (default 25, max 50)              |
| `offset`    | No       | Pagination within day                            |
| `cleanSlate`| No       | 1 = clear trades/state for scope before processing |

**Response**:
```json
{
  "ok": true,
  "date": "2026-02-02",
  "ticker": "BE",
  "bucketProcessed": 1738517400000,
  "rowsProcessed": 12,
  "tradesCreated": 1,
  "tradesPurged": 0,
  "nextBucket": 1738517700000,
  "hasMore": true
}
```

---

## Flow

### 1. Resolve scope

- `tsStart` = 9:30 AM ET for `date`
- `tsEnd` = 4:00 PM ET for `date` (or 11:59 PM if preferred)
- `buckets` = list of bucket_5m in [tsStart, tsEnd], e.g. 78 buckets for a full day

### 2. Clean slate (if `cleanSlate=1`)

- **By day**: Purge from KV `timed:trades:all` all trades with `entry_ts` in [tsStart, tsEnd]. Reset `timed:latest` entry fields for tickers in scope.
- **By ticker**: Purge only that ticker’s trades in the date range; reset only that ticker’s `timed:latest` entry state.

### 3. Process buckets

For each bucket (or for `bucket` if specified):

- Query `ingest_receipts` for `bucket_5m = B` and `script_version = '2.5.0'`, optionally `ticker = X`.
- Fetch `receipt_id, ticker, ts` only (small result).
- For each row (or batch of N rows):
  - Fetch `payload_json` by `receipt_id`.
  - Parse payload, set `payload.ts = ts`, `payload.ingest_ts = ts`.
  - Run existing pipeline: **`classifyKanbanStage`** (8 lanes: watch, setup_watch, flip_watch, just_flipped, enter_now, just_entered, hold, trim, exit, archive) → **`processTradeSimulation`** with `asOfTs = ts`.
  - Update in-memory state; at end of batch, write `timed:latest:{ticker}` and `timed:trades:all` to KV.

### 4. Sync

- Call `d1SyncLatestBatchFromKV` (or equivalent) so D1 ledger reflects KV trades.

---

## Client Script: `scripts/replay-ingest.js`

```bash
# Full day, all tickers, script 2.5.0
DATE=2026-02-02 CLEAN_SLATE=1 TIMED_API_KEY=x node scripts/replay-ingest.js

# Single ticker
TICKER=BE DATE=2026-02-02 CLEAN_SLATE=1 TIMED_API_KEY=x node scripts/replay-ingest.js

# Single bucket (for debugging)
BUCKET=1738517400000 TICKER=BE TIMED_API_KEY=x node scripts/replay-ingest.js
```

**Script behavior**:

- Loop over buckets from 9:30 ET to end of day.
- For each bucket, call `/timed/admin/replay-ingest` with `date`, `ticker` (if set), `bucket`, `cleanSlate` (only on first batch).
- Accumulate `rowsProcessed`, `tradesCreated`, `tradesPurged`.
- Run `force-sync` at end.
- Optional: configurable delay between buckets to reduce load.

---

## Performance Optimizations

1. **Batch payload fetches**  
   Use `Promise.all` for up to ~20 `SELECT payload_json WHERE receipt_id = ?` per batch to reduce latency.

2. **In-memory state per request**  
   Load `timed:latest` and `timed:trades:all` once per request; update in memory; write once at end.

3. **Bucket-level batching**  
   Process one bucket per request. Client iterates; worker stays within CPU time limits.

4. **Index usage**  
   - `WHERE bucket_5m = ?` uses `idx_ingest_receipts_bucket`
   - `WHERE ticker = ? AND bucket_5m = ?` uses `idx_ingest_receipts_ticker_bucket`
   - Add index on `(script_version, bucket_5m)` if filtering by version is frequent.

---

## Out of Scope (Future)

- Streaming / HTTP streaming
- Webhook or queue-driven processing
- Incremental replay (only new buckets since last run)

---

## Implementation Order

1. Implement `POST /timed/admin/replay-ingest` with bucket-scoped logic and two-phase fetch.
2. Add `replay-ingest.js` script that iterates buckets and calls the endpoint.
3. Test with `TICKER=BE` and `DATE=2026-02-02`.
4. Validate Trade By Day, P&L, History in the UI.
5. Run full-day replay and tune batch sizes / limits if needed.
