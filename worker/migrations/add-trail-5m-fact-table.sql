-- ═══════════════════════════════════════════════════════════════════════════════
-- 5-MINUTE AGGREGATED FACT TABLE
-- ═══════════════════════════════════════════════════════════════════════════════
-- Purpose: Store aggregated trail data in 5m buckets for efficient historical queries
-- Benefits: 5x fewer rows, faster queries, reduced storage (~80% savings on old data)
-- 
-- Strategy:
--   - Raw data (timed_trail, ingest_receipts): Keep 48 hours for live trading
--   - 5m facts (trail_5m_facts): Keep 30+ days for analysis
--   - Cron job aggregates raw → facts, then purges old raw data
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS trail_5m_facts (
  ticker TEXT NOT NULL,
  bucket_ts INTEGER NOT NULL,  -- 5-minute bucket start (floor to 300000ms)
  
  -- OHLC for price
  price_open REAL,
  price_high REAL,
  price_low REAL,
  price_close REAL,
  
  -- Score ranges (useful for volatility analysis)
  htf_score_avg REAL,
  htf_score_min REAL,
  htf_score_max REAL,
  ltf_score_avg REAL,
  ltf_score_min REAL,
  ltf_score_max REAL,
  
  -- End-of-bucket state (most recent values)
  state TEXT,              -- HTF_BULL_LTF_BULL, etc.
  rank INTEGER,
  completion REAL,
  phase_pct REAL,
  
  -- Aggregated signals (any flag that was true in the bucket)
  had_squeeze_release INTEGER DEFAULT 0,
  had_ema_cross INTEGER DEFAULT 0,
  had_st_flip INTEGER DEFAULT 0,
  had_momentum_elite INTEGER DEFAULT 0,
  had_flip_watch INTEGER DEFAULT 0,
  
  -- Kanban state changes in bucket
  kanban_stage_start TEXT,
  kanban_stage_end TEXT,
  kanban_changed INTEGER DEFAULT 0,
  
  -- Trade activity in bucket
  trade_entered INTEGER DEFAULT 0,
  trade_exited INTEGER DEFAULT 0,
  
  -- Metadata
  sample_count INTEGER NOT NULL,  -- How many 1m records aggregated
  created_at INTEGER NOT NULL,
  
  PRIMARY KEY (ticker, bucket_ts)
);

CREATE INDEX IF NOT EXISTS idx_trail_5m_facts_ts ON trail_5m_facts (bucket_ts);
CREATE INDEX IF NOT EXISTS idx_trail_5m_facts_ticker_ts ON trail_5m_facts (ticker, bucket_ts);
CREATE INDEX IF NOT EXISTS idx_trail_5m_facts_state ON trail_5m_facts (state);


-- ═══════════════════════════════════════════════════════════════════════════════
-- DAILY SUMMARY TABLE (for dashboards and performance tracking)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS trail_daily_summary (
  ticker TEXT NOT NULL,
  date TEXT NOT NULL,  -- YYYY-MM-DD
  
  -- Price action
  price_open REAL,
  price_high REAL,
  price_low REAL,
  price_close REAL,
  price_change_pct REAL,
  
  -- Score summaries
  htf_score_avg REAL,
  ltf_score_avg REAL,
  
  -- State distribution (minutes in each state)
  minutes_bull_bull INTEGER DEFAULT 0,
  minutes_bull_pullback INTEGER DEFAULT 0,
  minutes_bear_bear INTEGER DEFAULT 0,
  minutes_bear_pullback INTEGER DEFAULT 0,
  
  -- Signal counts
  squeeze_releases INTEGER DEFAULT 0,
  ema_crosses INTEGER DEFAULT 0,
  st_flips INTEGER DEFAULT 0,
  
  -- Kanban activity
  enter_now_count INTEGER DEFAULT 0,
  
  -- Trade activity
  trades_opened INTEGER DEFAULT 0,
  trades_closed INTEGER DEFAULT 0,
  trade_pnl REAL DEFAULT 0,
  
  -- Metadata
  sample_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  
  PRIMARY KEY (ticker, date)
);

CREATE INDEX IF NOT EXISTS idx_trail_daily_summary_date ON trail_daily_summary (date);
