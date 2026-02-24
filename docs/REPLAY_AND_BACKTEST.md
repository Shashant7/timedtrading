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
```

## What it does

1. **Lock** — Acquires a replay lock (KV) so only one run is active.
2. **Reset** — Clears trade state (D1 + KV): `trades`, `account_ledger`, `investor_positions`, `investor_lots`, `portfolio_snapshots`, and related keys. Candles in `ticker_candles` are **not** cleared.
3. **Backfill (gap-based)** — Calls `GET /timed/admin/candle-gaps?startDate=...&endDate=...`. If `allClear` is true, skips backfill. Otherwise backfills only tickers with missing candle coverage (same universe as replay, ~152).
4. **Replay** — For each trading day in range (skips weekends and listed holidays), calls `POST /timed/admin/candle-replay` in batches (e.g. 15 tickers per batch). At end of each day: runs investor daily replay and snapshots both portfolios.
5. **Checkpoint** — After each day, writes `data/replay-checkpoint.txt` (next date, end date, batch size) so you can resume with `--resume`.
6. **Unlock** — On completion, releases the replay lock and removes the checkpoint.

## Files

| File | Purpose |
|------|--------|
| `scripts/full-backtest.sh` | Orchestrates lock, reset, gap check, backfill, replay loop, checkpoint. |
| `scripts/replay-ui-server.js` | Local server: serves Replay Control UI and API (status, start, resume, pause). |
| `data/replay.log` | Log output when running from the UI (or when using `tee data/replay.log`). |
| `data/replay-checkpoint.txt` | Last processed date + end date + batch size; used by `--resume`. |

## APIs used

- `POST /timed/admin/replay-lock` — Acquire lock.
- `POST /timed/admin/reset?resetLedger=1` — Clear trade state.
- `GET /timed/admin/candle-gaps?startDate=...&endDate=...` — Check candle coverage; returns `tickersNeedingBackfill` if gaps exist.
- `POST /timed/admin/alpaca-backfill` — Backfill candles (per-ticker or batched).
- `POST /timed/admin/candle-replay?date=...&tickerOffset=...&tickerBatch=...` — Run one replay batch.
- `DELETE /timed/admin/replay-lock` — Release lock.

## Resilience

- The replay loop retries each `candle-replay` request up to 5 times (30s between attempts) on network/timeout errors so a single failure doesn’t stop the run.
- Use **Resume** after a pause or interrupt; the checkpoint ensures no duplicate days.

## Related

- [D1_LEDGER_SOURCE_OF_TRUTH.md](D1_LEDGER_SOURCE_OF_TRUTH.md) — Ledger and trade storage.
- [tasks/lessons.md](../tasks/lessons.md) — Replay and backfill lessons (e.g. `beforeTs`, golden profiles, holidays).
