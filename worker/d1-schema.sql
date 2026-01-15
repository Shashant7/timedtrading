-- D1 schema for 7-day historical ingest trail
-- Apply with: wrangler d1 execute timed_trading_db --file=worker/d1-schema.sql --env production

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS timed_trail (
  ticker TEXT NOT NULL,
  ts INTEGER NOT NULL, -- milliseconds since epoch (UTC)

  price REAL,
  htf_score REAL,
  ltf_score REAL,
  completion REAL,
  phase_pct REAL,
  state TEXT,
  rank INTEGER,

  flags_json TEXT,
  trigger_reason TEXT,
  trigger_dir TEXT,
  payload_json TEXT, -- full ingest payload (JSON string) for accurate replays

  PRIMARY KEY (ticker, ts)
);

CREATE INDEX IF NOT EXISTS idx_timed_trail_ts ON timed_trail (ts);
CREATE INDEX IF NOT EXISTS idx_timed_trail_ticker_ts ON timed_trail (ticker, ts);

-- -----------------------------------------------------------------------------
-- Ingest receipts: raw webhook capture (idempotent)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ingest_receipts (
  receipt_id TEXT PRIMARY KEY, -- ticker:ts:hash
  ticker TEXT NOT NULL,
  ts INTEGER NOT NULL, -- payload timestamp (ms UTC)
  bucket_5m INTEGER NOT NULL, -- floor(ts/300000)*300000
  received_ts INTEGER NOT NULL, -- server receipt time (ms UTC)
  payload_hash TEXT NOT NULL,
  script_version TEXT,
  payload_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_ingest_receipts_ts ON ingest_receipts (ts);
CREATE INDEX IF NOT EXISTS idx_ingest_receipts_bucket ON ingest_receipts (bucket_5m);
CREATE INDEX IF NOT EXISTS idx_ingest_receipts_ticker_bucket ON ingest_receipts (ticker, bucket_5m);

-- -----------------------------------------------------------------------------
-- Ledger tables: alerts + trades + trade_events
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS alerts (
  alert_id TEXT PRIMARY KEY,
  ticker TEXT NOT NULL,
  ts INTEGER NOT NULL, -- ms since epoch UTC

  side TEXT, -- LONG/SHORT
  state TEXT,
  rank INTEGER,
  rr_at_alert REAL,
  trigger_reason TEXT,
  dedupe_day TEXT, -- YYYY-MM-DD (UTC)

  discord_sent INTEGER NOT NULL DEFAULT 0, -- 0/1
  discord_status INTEGER, -- HTTP status if attempted
  discord_error TEXT,

  payload_json TEXT, -- full snapshot at decision time
  meta_json TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_ticker_ts ON alerts (ticker, ts);
CREATE INDEX IF NOT EXISTS idx_alerts_dedupe_day ON alerts (dedupe_day);
CREATE INDEX IF NOT EXISTS idx_alerts_ticker_day ON alerts (ticker, dedupe_day);

CREATE TABLE IF NOT EXISTS trades (
  trade_id TEXT PRIMARY KEY,
  ticker TEXT NOT NULL,
  direction TEXT NOT NULL, -- LONG/SHORT

  entry_ts INTEGER NOT NULL,
  entry_price REAL,
  rank INTEGER,
  rr REAL,
  status TEXT, -- OPEN / TP_HIT_TRIM / WIN / LOSS

  exit_ts INTEGER,
  exit_price REAL,
  exit_reason TEXT,

  trimmed_pct REAL,
  pnl REAL,
  pnl_pct REAL,

  script_version TEXT,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_trades_ticker_dir_entry_ts
  ON trades (ticker, direction, entry_ts);
CREATE INDEX IF NOT EXISTS idx_trades_entry_ts ON trades (entry_ts);
CREATE INDEX IF NOT EXISTS idx_trades_status ON trades (status);

CREATE TABLE IF NOT EXISTS trade_events (
  event_id TEXT PRIMARY KEY,
  trade_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL, -- ENTRY / TRIM / EXIT / SCALE_IN / ENTRY_CORRECTION

  price REAL,
  qty_pct_delta REAL,
  qty_pct_total REAL,
  pnl_realized REAL,
  reason TEXT,
  meta_json TEXT,

  FOREIGN KEY (trade_id) REFERENCES trades(trade_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_trade_events_idempotent
  ON trade_events (trade_id, type, ts);
CREATE INDEX IF NOT EXISTS idx_trade_events_trade_ts
  ON trade_events (trade_id, ts);

