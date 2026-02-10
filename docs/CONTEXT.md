# Timed Trading — Project Context

One-page context for the codebase. See [README.md](README.md) for the full doc index.

## What it is

- **Timed Trading** is a trading dashboard and execution-support system: lanes (Setup → Enter → Hold → Defend → Trim → Exit), viewport, bubble chart, right rail, trade tracker.
- Data: Alpaca (candles, snapshots), TradingView (optional webhooks), D1 (candles, trades, positions), KV (ticker index, latest payloads, config).
- Scoring and Kanban classification run in the Worker (cron + on ingest). Dashboard and Ticker Management are React UIs (single-file HTML + Babel).

## Stack

| Layer        | Tech |
|-------------|------|
| Frontend    | React 18, Tailwind, Babel standalone (index-react.html, simulation-dashboard, model-dashboard, ticker-management, screener) |
| Worker      | Cloudflare Worker (Node-compat), D1, KV, Cron |
| Data        | D1 (ticker_candles, ticker_index, ticker_latest, trades, positions, lots), KV (timed:tickers, timed:removed, timed:latest/*, timed:trail/*) |
| External    | Alpaca (bars, snapshots, assets API for validation), optional TradingView webhooks |

## Key flows

- **Ticker add (Ticker Management)**: Validate vs Alpaca Assets API → add to KV + D1 ticker_index + sector_map → trigger 30-day backfill → show in list immediately (optimistic + polling).
- **Ticker remove**: Remove from KV index, add to timed:removed, delete from D1 ticker_index/ticker_latest; keep candle data and trade history.
- **Dashboard data**: GET /timed/all (D1 ticker_latest + open positions), GET /timed/tickers (D1 or KV). Filter: SECTOR_MAP keys minus timed:removed.
- **Ingestion-status**: Canonical list from KV timed:tickers (minus removed); report includes tickers with no candle data (0% coverage).

## Lessons and rules

- See [tasks/lessons.md](../tasks/lessons.md) for patterns to avoid and rules (deploy from worker/, D1 batching, Alpaca symbol handling, replay vs live, etc.).
- Workflow: [tasks/WORKFLOW_ORCHESTRATION.md](../tasks/WORKFLOW_ORCHESTRATION.md); plan non-trivial work in tasks/todo.md.

## Backfill and Alpaca

- **Backfill default**: Previous 30 days when adding tickers; admin backfill supports `?sinceDays=30` or deep history.
- **Alpaca validation**: Equity symbols (non-futures) are checked against Alpaca Assets API before add; invalid symbols return `alpaca_symbol_not_found` with list.
- **Alpaca API base**: Assets check uses `ALPACA_API_BASE` (default `https://paper-api.alpaca.markets`); set to `https://api.alpaca.markets` for live.
