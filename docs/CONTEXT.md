# Timed Trading — Project Context

One-page context for the codebase. See [README.md](README.md) for the full doc index.

## What it is

- **Timed Trading** is a trading dashboard and execution-support system: lanes (Setup → Enter → Hold → Defend → Trim → Exit), viewport, bubble chart, right rail, trade tracker.
- Data: TwelveData (primary — quotes, candles, extended hours), Alpaca (execution, historical backfill), TradingView (optional webhooks), D1 (candles, trades, positions), KV (ticker index, latest payloads, config, prices).
- Scoring and Kanban classification run in the Worker (cron + on ingest). Dashboard and Ticker Management are React UIs (single-file HTML + Babel).

## Stack

| Layer        | Tech |
|-------------|------|
| Frontend    | React 18, Tailwind, Babel standalone (index-react.html, simulation-dashboard, model-dashboard, ticker-management, screener) |
| Worker      | Cloudflare Worker (Node-compat), D1, KV, Cron |
| Data        | D1 (ticker_candles, ticker_index, ticker_latest, trades, positions, lots), KV (timed:tickers, timed:removed, timed:latest/*, timed:trail/*) |
| External    | TwelveData (quotes w/ `prepost=true`, candles, extended hours), Alpaca (execution, bars, assets API for validation), optional TradingView webhooks |

## Key flows

- **Ticker add (Ticker Management)**: Validate vs Alpaca Assets API → add to KV + D1 ticker_index + sector_map → trigger 30-day backfill → show in list immediately (optimistic + polling).
- **Ticker remove**: Remove from KV index, add to timed:removed, delete from D1 ticker_index/ticker_latest; keep candle data and trade history.
- **Dashboard data**: GET /timed/all (D1 ticker_latest + open positions), GET /timed/tickers (D1 or KV). Filter: SECTOR_MAP keys minus timed:removed.
- **Ingestion-status**: Canonical list from KV timed:tickers (minus removed); report includes tickers with no candle data (0% coverage).

## Lessons and rules

- See [tasks/lessons.md](../tasks/lessons.md) for patterns to avoid and rules (deploy from worker/, D1 batching, Alpaca symbol handling, replay vs live, etc.).
- Workflow: [tasks/WORKFLOW_ORCHESTRATION.md](../tasks/WORKFLOW_ORCHESTRATION.md); plan non-trivial work in tasks/todo.md.

## Price Data Pipeline

- **TwelveData** is the primary data provider (`DATA_PROVIDER=twelvedata`). `parseTdQuote()` in `worker/twelvedata.js` parses `/quote?prepost=true` responses including native `change`, `percent_change`, `extended_change`, `extended_percent_change`, `extended_price`, `is_market_open`.
- **`timed:prices` KV**: Compact price feed using short keys: `p` (price), `pc` (prev close), `dc` (day change $), `dp` (day change %), `ahp` (extended price), `ahdc` (AH change $), `ahdp` (AH change %). Written by cron jobs (lightweight every 1m, full every 5m). AH fields persist last-known values — never overwritten with `undefined`.
- **`/timed/all` endpoint**: Merges `timed:prices` fields onto ticker objects as `_ah_change_pct`, `_ah_change`, `_ah_price`. Also sets `_live_price`, `_live_daily_high/low/volume`.
- **Frontend single source of truth**: `getDailyChange(t)` in `react-app/shared-price-utils.js` returns `{ dayPct, dayChg }`. All pages (index-react, investor-dashboard, trades) import this utility. Server endpoints provide field aliases (`prev_close`, `day_change_pct`, `day_change`) so the fallback chain works everywhere.
- **RTH/ETH movers**: Top Gainers/Losers bar has two rows — RTH (sorted by `getDailyChange(t).dayPct`, intraday momentum) and EXT (sorted by `_ah_change_pct`, earnings/news reactions). EXT row shows last-known data even overnight. Crypto (BTCUSD, ETHUSD) excluded from EXT row.
- **Attribution**: Footer includes "Market data powered by Twelve Data" per licensing requirements.

## Backfill and Alpaca

- **Backfill default**: Previous 30 days when adding tickers; admin backfill supports `?sinceDays=30` or deep history.
- **Alpaca validation**: Equity symbols (non-futures) are checked against Alpaca Assets API before add; invalid symbols return `alpaca_symbol_not_found` with list.
- **Alpaca API base**: Assets check uses `ALPACA_API_BASE` (default `https://paper-api.alpaca.markets`); set to `https://api.alpaca.markets` for live.
