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
  kanban_stage TEXT, -- computed Kanban lane at this point (for time-travel)
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
  updated_at INTEGER NOT NULL,
  trim_ts INTEGER
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

-- -----------------------------------------------------------------------------
-- Latest snapshot tables (fast UI reads)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ticker_index (
  ticker TEXT PRIMARY KEY,
  first_seen_ts INTEGER NOT NULL,
  last_seen_ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ticker_latest (
  ticker TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  kanban_stage TEXT,
  prev_kanban_stage TEXT,
  payload_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ticker_latest_ts ON ticker_latest (ts);
CREATE INDEX IF NOT EXISTS idx_ticker_latest_kanban_stage ON ticker_latest (kanban_stage);
CREATE INDEX IF NOT EXISTS idx_ticker_latest_prev_kanban_stage ON ticker_latest (prev_kanban_stage);

-- -----------------------------------------------------------------------------
-- Position tracking (execution adapter + replay sync)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS positions (
  position_id TEXT PRIMARY KEY,
  ticker TEXT NOT NULL,
  direction TEXT NOT NULL,
  status TEXT DEFAULT 'OPEN',
  total_qty REAL DEFAULT 0,
  cost_basis REAL DEFAULT 0,
  stop_loss REAL,
  take_profit REAL,
  script_version TEXT,
  created_at INTEGER,
  updated_at INTEGER,
  closed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_positions_ticker_status ON positions (ticker, status);

-- -----------------------------------------------------------------------------
-- Users: authenticated users via Cloudflare Access (Google SSO)
-- Auto-provisioned on first login. Tier gates premium features.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
  email TEXT PRIMARY KEY,
  display_name TEXT,
  role TEXT NOT NULL DEFAULT 'member',   -- admin, member
  tier TEXT NOT NULL DEFAULT 'free',     -- free, pro, admin
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_login_at INTEGER,
  expires_at INTEGER                     -- subscription expiry (ms epoch), null = no expiry
);

CREATE INDEX IF NOT EXISTS idx_users_role ON users (role);
CREATE INDEX IF NOT EXISTS idx_users_tier ON users (tier);

-- -----------------------------------------------------------------------------
-- Terms acceptance: audit trail for legal proof of user consent
-- Users must accept Terms of Use before accessing the platform.
-- The users.terms_accepted_at column provides a fast lookup;
-- this table provides a versioned audit trail.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS terms_acceptance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  terms_version TEXT NOT NULL DEFAULT '1.0',
  accepted_at INTEGER NOT NULL,           -- ms epoch (UTC)
  ip_address TEXT,
  user_agent TEXT
);

CREATE INDEX IF NOT EXISTS idx_terms_acceptance_email ON terms_acceptance (email);

