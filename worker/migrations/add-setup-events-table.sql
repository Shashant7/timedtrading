-- Setup events ledger (Phase 2B — Active Trader hardening)
-- Append-only, idempotent on event_id.

CREATE TABLE IF NOT EXISTS setup_events (
  event_id TEXT PRIMARY KEY,
  ticker TEXT NOT NULL,
  tf TEXT NOT NULL,
  event_ts INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  direction TEXT,
  price REAL,
  source TEXT NOT NULL,
  confidence REAL,
  payload_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_setup_events_ticker_ts ON setup_events (ticker, event_ts);
CREATE INDEX IF NOT EXISTS idx_setup_events_type_ts ON setup_events (event_type, event_ts);
