# D1 as Source of Truth for Trades

The worker treats **D1 (SQLite)** as the canonical store for trade and execution history. KV is updated after D1 so that reads can eventually be switched to D1 without losing data.

## Behavior

- **Writes:** On every ENTRY, TRIM, EXIT, and SCALE_IN the worker:
  1. Writes (or updates) the trade and events to **D1 first** (`trades` and `trade_events` tables).
  2. Then updates **KV** (`timed:trades:all`) so existing clients that read from KV continue to see the latest state.

- **Reads:**
  - **GET /timed/trades** — By default returns trades from **KV**. Use **`?source=d1`** to return from D1 `trades` + `trade_events`, or **`?source=positions`** to return from D1 `positions` + `execution_actions` (Phase 2 lot-based model). Same response shape; `source` in the JSON indicates which was used.
- **GET /timed/ledger/trades** — Returns trades from **D1** only (paginated, filterable by ticker, status, date range). Event details per trade are available via **GET /timed/ledger/trades/:tradeId** and the decision-card endpoint.

## Tables (D1)

- **trades** — One row per trade: `trade_id`, `ticker`, `direction`, `entry_ts`, `entry_price`, `status`, `exit_ts`, `exit_price`, `trimmed_pct`, `pnl`, etc.
- **trade_events** — One row per execution event: `event_id`, `trade_id`, `ts`, `type` (ENTRY, TRIM, EXIT, SCALE_IN), `price`, `qty_pct_delta`, `qty_pct_total`, `pnl_realized`, `reason`, `meta_json`.
- **positions** (Phase 2) — One per (ticker, direction): `position_id`, `ticker`, `direction`, `status`, `total_qty`, `cost_basis`, `created_at`, `updated_at`, `closed_at`. Worker dual-writes ENTRY/TRIM/EXIT here.
- **lots** (Phase 2) — Each buy: `lot_id`, `position_id`, `ts`, `qty`, `price`, `value`, `remaining_qty`.
- **execution_actions** (Phase 2) — Each execution: `action_id`, `position_id`, `ts`, `action_type` (ENTRY, ADD_ENTRY, TRIM, EXIT), `qty`, `price`, `value`, `pnl_realized`, `reason`.

Apply the Phase 2 schema with:  
`wrangler d1 execute timed-trading-ledger --remote --file=worker/migrations/add-positions-lots-actions.sql --env production`

## Discord alerts

TRADE_ENTRY, TRADE_TRIM, and TRADE_EXIT Discord embeds include an **Execution** field with **Qty**, **Value**, and **Net P&L** so alerts are verifiable against D1 and the UI.

## Migration path

To make the UI read only from D1:

1. Point the Trade Tracker (or any client) at **GET /timed/trades?source=d1**.
2. Optionally stop writing to KV for trades once all clients use D1.

See **tasks/worker-ledger-execution-plan.md** for the full plan (lots, execution_actions, and full verification).
