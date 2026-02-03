# D1 as Source of Truth for Trades

The worker treats **D1 (SQLite)** as the canonical store for trade and execution history. KV is updated after D1 so that reads can eventually be switched to D1 without losing data.

## Behavior

- **Writes:** On every ENTRY, TRIM, EXIT, and SCALE_IN the worker:
  1. Writes (or updates) the trade and events to **D1 first** (`trades` and `trade_events` tables).
  2. Then updates **KV** (`timed:trades:all`) so existing clients that read from KV continue to see the latest state.

- **Reads:**
  - **GET /timed/trades** — By default returns trades from **KV**. Use **`?source=d1`** to return trades from D1 with event history included (same response shape, `source: "d1"` in the JSON).
  - **GET /timed/ledger/trades** — Returns trades from **D1** only (paginated, filterable by ticker, status, date range). Event details per trade are available via **GET /timed/ledger/trades/:tradeId** and the decision-card endpoint.

## Tables (D1)

- **trades** — One row per trade: `trade_id`, `ticker`, `direction`, `entry_ts`, `entry_price`, `status`, `exit_ts`, `exit_price`, `trimmed_pct`, `pnl`, etc.
- **trade_events** — One row per execution event: `event_id`, `trade_id`, `ts`, `type` (ENTRY, TRIM, EXIT, SCALE_IN), `price`, `qty_pct_delta`, `qty_pct_total`, `pnl_realized`, `reason`, `meta_json`.

## Discord alerts

TRADE_ENTRY, TRADE_TRIM, and TRADE_EXIT Discord embeds include an **Execution** field with **Qty**, **Value**, and **Net P&L** so alerts are verifiable against D1 and the UI.

## Migration path

To make the UI read only from D1:

1. Point the Trade Tracker (or any client) at **GET /timed/trades?source=d1**.
2. Optionally stop writing to KV for trades once all clients use D1.

See **tasks/worker-ledger-execution-plan.md** for the full plan (lots, execution_actions, and full verification).
