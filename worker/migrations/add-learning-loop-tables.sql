-- Learning Loop tables: direction accuracy tracking, path performance, and model config
-- Apply with: wrangler d1 execute timed_trading_db --file=worker/migrations/add-learning-loop-tables.sql --env production

-- =============================================================================
-- direction_accuracy: tracks every trade's direction signals for retrospective
-- =============================================================================
CREATE TABLE IF NOT EXISTS direction_accuracy (
  trade_id TEXT PRIMARY KEY,
  ticker TEXT NOT NULL,
  ts INTEGER NOT NULL,                            -- entry timestamp (ms epoch)

  -- Direction from each source at entry time
  traded_direction TEXT NOT NULL,                  -- actual direction traded (LONG/SHORT)
  consensus_direction TEXT,                        -- swing_consensus.direction (LONG/SHORT/null)
  htf_score_direction TEXT,                        -- htf_score >= 0 ? LONG : SHORT
  state_direction TEXT,                            -- state-based (BULL->LONG, BEAR->SHORT)
  direction_source TEXT,                           -- which source was used: consensus/state_bull/state_bear/htf_score

  -- Context at entry
  htf_score REAL,
  ltf_score REAL,
  regime_daily TEXT,                               -- uptrend/downtrend/transition
  regime_weekly TEXT,
  regime_combined TEXT,
  bullish_count INTEGER,                           -- swing consensus bullish TF count
  bearish_count INTEGER,                           -- swing consensus bearish TF count
  tf_stack_json TEXT,                              -- per-TF bias snapshot
  entry_path TEXT,                                 -- gold_long, gold_short, momentum, etc.
  rank INTEGER,
  rr REAL,
  entry_price REAL,

  -- Outcome (filled on trade close)
  exit_ts INTEGER,
  exit_price REAL,
  pnl REAL,
  pnl_pct REAL,
  direction_correct INTEGER,                       -- 1 if price moved in traded direction, 0 if not
  max_favorable_excursion REAL,                    -- best price move in traded direction (%)
  max_adverse_excursion REAL,                      -- worst price move against traded direction (%)
  status TEXT                                      -- WIN/LOSS/FLAT/OPEN
);

CREATE INDEX IF NOT EXISTS idx_da_ticker_ts ON direction_accuracy (ticker, ts);
CREATE INDEX IF NOT EXISTS idx_da_direction_source ON direction_accuracy (direction_source);
CREATE INDEX IF NOT EXISTS idx_da_traded_direction ON direction_accuracy (traded_direction);
CREATE INDEX IF NOT EXISTS idx_da_status ON direction_accuracy (status);
CREATE INDEX IF NOT EXISTS idx_da_entry_path ON direction_accuracy (entry_path);

-- =============================================================================
-- path_performance: rolling metrics per entry path (updated by retrospective)
-- =============================================================================
CREATE TABLE IF NOT EXISTS path_performance (
  entry_path TEXT PRIMARY KEY,
  total_trades INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  flats INTEGER NOT NULL DEFAULT 0,
  win_rate REAL,                                   -- wins / (wins + losses)
  avg_pnl REAL,
  avg_pnl_pct REAL,
  avg_hold_minutes REAL,
  avg_mfe REAL,                                    -- avg max favorable excursion %
  avg_mae REAL,                                    -- avg max adverse excursion %
  recent_win_rate REAL,                            -- last 30 days
  recent_trades INTEGER DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,              -- 0 = auto-disabled by learning loop
  disable_reason TEXT,
  quality_gate_adj REAL DEFAULT 0,                 -- adjustment to entry quality gate threshold
  last_updated INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pp_enabled ON path_performance (enabled);

-- =============================================================================
-- model_config: key-value store for learned weights and parameters
-- =============================================================================
CREATE TABLE IF NOT EXISTS model_config (
  config_key TEXT PRIMARY KEY,
  config_value TEXT NOT NULL,                      -- JSON-encoded value
  description TEXT,
  updated_at INTEGER NOT NULL,
  updated_by TEXT DEFAULT 'system'                 -- 'system' or 'admin'
);
