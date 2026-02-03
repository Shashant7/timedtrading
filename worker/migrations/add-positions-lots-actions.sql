-- Phase 2: Lot-based execution model (position = ticker+direction, lots = each buy, actions = ENTRY/ADD_ENTRY/TRIM/EXIT)
-- Run: wrangler d1 execute timed-trading-ledger --remote --file=worker/migrations/add-positions-lots-actions.sql --env production

-- Positions: one per (ticker, direction), current state
CREATE TABLE IF NOT EXISTS positions (
  position_id TEXT PRIMARY KEY,
  ticker TEXT NOT NULL,
  direction TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN',
  total_qty REAL NOT NULL DEFAULT 0,
  cost_basis REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  closed_at INTEGER,
  script_version TEXT
);

CREATE INDEX IF NOT EXISTS idx_positions_ticker_dir ON positions (ticker, direction);
CREATE INDEX IF NOT EXISTS idx_positions_status ON positions (status);

-- Lots: each buy is one lot (remaining_qty reduced by trims/exits)
CREATE TABLE IF NOT EXISTS lots (
  lot_id TEXT PRIMARY KEY,
  position_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  qty REAL NOT NULL,
  price REAL NOT NULL,
  value REAL NOT NULL,
  remaining_qty REAL NOT NULL,
  FOREIGN KEY (position_id) REFERENCES positions(position_id)
);

CREATE INDEX IF NOT EXISTS idx_lots_position ON lots (position_id);

-- Execution actions: every entry/trim/exit with full execution details
CREATE TABLE IF NOT EXISTS execution_actions (
  action_id TEXT PRIMARY KEY,
  position_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  action_type TEXT NOT NULL,
  qty REAL NOT NULL,
  price REAL NOT NULL,
  value REAL NOT NULL,
  pnl_realized REAL,
  lot_id TEXT,
  reason TEXT,
  meta_json TEXT,
  FOREIGN KEY (position_id) REFERENCES positions(position_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_actions_idempotent
  ON execution_actions (position_id, action_type, ts);
CREATE INDEX IF NOT EXISTS idx_execution_actions_position_ts
  ON execution_actions (position_id, ts);
