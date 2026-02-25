# Replay and Full Backtest

Historical candle-based replay for the full universe (Active Trader + Investor), with gap-based backfill and a local control UI.

## Quick start

**Replay Control UI (recommended)**

```bash
npm run replay-ui
```

Open **http://localhost:3847**. Use the UI to:

- **Start (fresh)** — Reset and replay from 2025-07-01 through end date (clears log).
- **Resume** — Continue from the last checkpoint (appends to log).
- **Pause** — Stop the replay process (SIGTERM); you can resume later.

Status and a live log tail refresh every few seconds.

**Command line**

```bash
# Full run (gap check → backfill if needed → replay)
./scripts/full-backtest.sh 2025-07-01 2026-02-23 15

# Resume from checkpoint (after pause or interrupt)
./scripts/full-backtest.sh --resume

# Trader only (faster: skips investor replay + snapshots at end of each day)
./scripts/full-backtest.sh --trader-only 2025-07-01 2026-02-23 20
./scripts/full-backtest.sh --resume --trader-only

# Investor-only backfill (run after trader-only; uses saved day state)
./scripts/full-backtest.sh --investor-only 2025-07-01 2026-02-23

# Sequence: trader-only then investor-only in one run (recommended for full backtest)
./scripts/full-backtest.sh --sequence 2025-07-01 2026-02-23 20

# Default interval is 5 min. Optional: 10 min for faster replay (4th arg).
./scripts/full-backtest.sh --sequence 2025-07-01 2026-02-23 40
```

## What it does

1. **Lock** — Acquires a replay lock (KV) so only one run is active.
2. **Reset** — Clears trade state (D1 + KV): `trades`, `account_ledger`, `investor_positions`, `investor_lots`, `portfolio_snapshots`, and related keys. Candles in `ticker_candles` are **not** cleared.
3. **Backfill (gap-based)** — Calls `GET /timed/admin/candle-gaps?startDate=...&endDate=...`. If `allClear` is true, skips backfill. Otherwise backfills only tickers with missing candle coverage (same universe as replay, ~152).
4. **Replay** — For each trading day in range (skips weekends and listed holidays), calls `POST /timed/admin/candle-replay` in batches (e.g. 15 tickers per batch). At end of each day: runs investor daily replay and snapshots both portfolios (unless `--trader-only` or `--sequence`; then day state is saved to KV for investor-only backfill).
5. **Sequence (optional)** — If `--sequence` was used, after the replay loop the script runs an investor-only pass: for each day it calls `POST /timed/admin/investor-replay?date=...` using the saved day state. No candles are loaded again.
6. **Checkpoint** — After each day, writes `data/replay-checkpoint.txt` (next date, end date, batch size) so you can resume with `--resume`.
7. **Unlock** — On completion, releases the replay lock and removes the checkpoint.

## Files

| File | Purpose |
|------|--------|
| `scripts/full-backtest.sh` | Orchestrates lock, reset, gap check, backfill, replay loop, checkpoint. |
| `scripts/replay-ui-server.js` | Local server: serves Replay Control UI and API (status, start, resume, pause). |
| `data/replay.log` | Log output when running from the UI (or when using `tee data/replay.log`). |
| `data/replay-checkpoint.txt` | Last processed date + end date + batch size + interval; used by `--resume`. |

## APIs used

- `POST /timed/admin/replay-lock` — Acquire lock.
- `POST /timed/admin/reset?resetLedger=1` — Clear trade state.
- `GET /timed/admin/candle-gaps?startDate=...&endDate=...` — Check candle coverage; returns `tickersNeedingBackfill` if gaps exist.
- `POST /timed/admin/alpaca-backfill` — Backfill candles (per-ticker or batched).
- `POST /timed/admin/candle-replay?date=...&tickerOffset=...&tickerBatch=...` — Run one replay batch. **`&fullDay=1`** — worker runs all batches for that day in one request (fewer round-trips, faster when orchestrated from the script). Optional `&skipInvestor=1` (or `traderOnly=1`) skips end-of-day investor replay and snapshots and saves day state to `timed:replay:daystate:YYYY-MM-DD` for investor-only backfill.
- `POST /timed/admin/investor-replay?date=YYYY-MM-DD` — Run investor daily replay + portfolio snapshots for one day using stored day state (from a prior trader-only replay). Returns 400 if day state is missing.
- `DELETE /timed/admin/replay-lock` — Release lock.

## Speed

- **Full day in worker:** The script uses **`fullDay=1`** by default: one request per day instead of many (worker runs all batches for that day internally). This removes round-trips and local sleeps and is much faster than replaying batch-by-batch from the client.
- **Batch size:** Default 25; use 30–40 for fewer batches per day inside the worker (152÷40 ≈ 4). Use 15 if the worker times out.
- **Interval:** We use **5 min** (78 scoring points per day) by default. 10 min is an optional speed trade-off (4th arg or UI).
- **End-of-day:** Last batch each day runs investor replay + snapshots (~30–60s). To run **Active Trader only** (faster), use **Trader only** in the UI or `--trader-only` in the script; this skips investor replay and portfolio snapshots so each day finishes without the 30–60s wait, and saves that day’s ticker state to KV (`timed:replay:daystate:YYYY-MM-DD`) for a later investor-only backfill.
- **Investor-only backfill:** After a trader-only run, run `--investor-only start end` to replay investor logic (and snapshots) for each day using the saved state. No candles are loaded again.
- **Sequence:** Use **Sequence** in the UI or `--sequence` to run trader-only for the full range, then investor-only for the same range in one script invocation. Same result as full replay but faster (no 30–60s EOD block during phase 1).

## Resilience

- The replay loop retries each `candle-replay` request up to 5 times (30s between attempts) on network/timeout errors so a single failure doesn’t stop the run.
- Use **Resume** after a pause or interrupt; the checkpoint ensures no duplicate days.

## Related

- [D1_LEDGER_SOURCE_OF_TRUTH.md](D1_LEDGER_SOURCE_OF_TRUTH.md) — Ledger and trade storage.
- [tasks/lessons.md](../tasks/lessons.md) — Replay and backfill lessons (e.g. `beforeTs`, golden profiles, holidays).
