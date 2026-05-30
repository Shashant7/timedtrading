# Worker Cron Orchestrator for Backtests

**Status:** Implemented (not yet deployed)  
**Date:** 2026-04-22  
**Branch:** `cursor/phase-i-implementation-2e87`

---

## Why

The cursor-cloud-agent VM running `scripts/continuous-slice.sh` + watchdog was
getting idle-paused by Cursor's VM management, silently freezing backtests
mid-run. Waking required the user to send a chat message.

**The fix:** move orchestration into the Cloudflare Worker itself. Workers
are serverless and always-available. A cron tick every 2 minutes advances
whichever managed backtest is running.

No more VM. No more babysitting. No more `continuous-slice.sh` or watchdog.

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  User enqueues a run                                     │
│    POST /timed/admin/backtest/enqueue                    │
│    body: { run_id, start_date, end_date, tickers, … }    │
│                                                          │
│  Inserts a row in managed_backtest_runs (status=queued)  │
└──────────────┬───────────────────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────────────────┐
│  Cron tick every 2 minutes (inside scheduled handler,    │
│  gated on _utcM % 2 === 0)                               │
│                                                          │
│  orchestratorTick(env):                                  │
│    1. Find oldest queued/running run                     │
│    2. Try to claim cron lock (3-min TTL)                 │
│    3. Advance one trading day:                           │
│       - Self-HTTP POST /timed/admin/candle-replay        │
│         for each ticker batch (up to 5 per tick)         │
│       - When hasMore=false, day is complete              │
│    4. Update last_completed_date                         │
│    5. Release lock                                       │
│                                                          │
│  If tick budget exhausted mid-day: next tick resumes     │
│  from offset=0 (idempotent; existing replays dedupe).    │
└──────────────┬───────────────────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────────────────┐
│  When next_day is past end_date → finalize run           │
│    - status = completed                                  │
│    - notes logged                                        │
│    - Trades available via /timed/admin/trade-autopsy     │
└──────────────────────────────────────────────────────────┘
```

### Lock semantics

- `cron_claimed_at`: unix ms when the last tick claimed this run.
- TTL = 180 seconds (`ORCHESTRATOR_CRON_LOCK_TTL_SEC`). Any tick can override a
  stale claim.
- Single-run-per-tick: only one managed run processes per cron invocation
  (avoids Worker CPU contention). First-claimed wins.

### Throughput

- ~2-3 min per day × 1 tick per 2 min = **near real-time progress**.
- Each tick processes up to 5 batches (24 tickers each) before yielding.
- Per-batch timeout = 45s (CF Worker CPU soft limit around 30s; the scheduled
  handler runs in `waitUntil` with extended budget up to 15 min).
- 70-day smoke: ~3.5 hours wall clock. 210-day full run: ~10.5 hours.

---

## Files changed

- **`worker/backtest-orchestrator.js`** — new. The orchestrator logic:
  - `ensureOrchestratorSchema()`: creates `managed_backtest_runs` table
  - `enqueueManagedRun()`, `cancelManagedRun()`, `getManagedRun()`, `listManagedRuns()`
  - `orchestratorTick()`: the cron entry point
  - `isTradingDay()`, `nextTradingDayAfter()`: NYSE business-day iteration

- **`worker/index.js`**:
  - Import orchestrator module (line ~160)
  - Add 4 route handlers (post-`market-events/coverage`):
    - `POST /timed/admin/backtest/enqueue`
    - `POST /timed/admin/backtest/cancel`
    - `GET  /timed/admin/backtest/status`
    - `POST /timed/admin/backtest/tick` (manual tick for testing)
  - Wire cron in `scheduled()` handler: on `*/1` cron with even-minute gate,
    invoke `orchestratorTick()` via `ctx.waitUntil()`.

- **`wrangler.toml`**: no change needed. Existing `*/1 * * * *` cron is reused.

---

## Usage

### 1. Configure DA keys (same as before)

```bash
# e.g. activate W1+W2+W3
scripts/phase-i/99-combined-w1-w2-w3.sh
```

### 2. Enqueue a managed run

```bash
curl -sS -X POST "https://timed-trading-ingest.shashant.workers.dev/timed/admin/backtest/enqueue?key=$TIMED_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "run_id": "phase-i-v11-fullrun",
    "start_date": "2025-07-01",
    "end_date": "2026-04-30",
    "tickers": "AA,AAPL,ABT,...",
    "ticker_batch": 24,
    "interval_min": 30,
    "notes": "Phase-I W1+W2+W3 validation run"
  }'
```

Returns: `{ ok: true, run_id, status: "queued", ... }`

### 3. Monitor

```bash
# Single run
curl "https://.../timed/admin/backtest/status?run_id=phase-i-v11-fullrun&key=$TIMED_API_KEY"

# All runs
curl "https://.../timed/admin/backtest/status?key=$TIMED_API_KEY"
```

### 4. Cancel

```bash
curl -X POST "https://.../timed/admin/backtest/cancel?key=$TIMED_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"run_id":"phase-i-v11-fullrun"}'
```

### 5. Force-tick (for fast feedback loops during development)

```bash
curl -X POST "https://.../timed/admin/backtest/tick?key=$TIMED_API_KEY"
```

---

## Migration from cloud-agent orchestration

The cloud-agent `scripts/continuous-slice.sh` + `scripts/v9-watchdog.sh`
continue to work — this orchestrator is additive. When enqueueing through
the orchestrator, do NOT launch `continuous-slice.sh` on the same run_id;
the orchestrator will acquire the replay-lock and progress independently.

For Phase-I onward, prefer the orchestrator for all backtests.

---

## Open questions / future work

- **Partial-day resume**: if a tick exhausts its budget mid-day, the next
  tick restarts at offset=0 for that day. Existing replays dedupe by
  (run_id, date, tickerOffset) at the data layer, so idempotent, but
  there's some wasted CPU re-scoring the first few batches. Future:
  store `last_offset_reached` in D1 so next tick skips ahead.
- **Multiple parallel runs**: orchestrator is single-run-per-tick by
  design. If multiple managed runs are queued, they process in order.
  Could be relaxed to run N in parallel with per-run locks, but probably
  not needed — the Worker CPU limit is the real bottleneck.
- **Web UI**: `/trade-autopsy` or a new admin page could show orchestrator
  status live. For now, `GET /timed/admin/backtest/status` is the source
  of truth.
