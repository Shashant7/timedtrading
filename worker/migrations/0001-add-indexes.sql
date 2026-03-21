-- Migration: Add comprehensive indexes for all hot query paths
-- Apply: wrangler d1 execute timed_trading_db --file=worker/migrations/0001-add-indexes.sql --env production
-- Date: 2026-03-17
-- Safe: All CREATE INDEX IF NOT EXISTS — idempotent, no data changes

-- ═══════════════════════════════════════════════════════════════════════════
-- timed_trail (biggest table, ~200k+ rows)
-- ═══════════════════════════════════════════════════════════════════════════
-- Snapshot-replay: fast ts-range filter for rows with payload_json
CREATE INDEX IF NOT EXISTS idx_trail_ts_payload ON timed_trail (ts) WHERE payload_json IS NOT NULL;
-- NOTE: ticker_candles already has PK(ticker,tf,ts) + idx_candles_tf_ts(tf,ts)
-- which covers all query patterns. Additional composite indexes exceed D1 memory limits on 5.8GB table.

-- ═══════════════════════════════════════════════════════════════════════════
-- trades
-- ═══════════════════════════════════════════════════════════════════════════
-- Per-ticker status lookups (open trade check in processTradeSimulation)
CREATE INDEX IF NOT EXISTS idx_trades_ticker_status ON trades (ticker, status);
-- Recent streak: WHERE exit_ts > ? AND status IN ('WIN','LOSS')
CREATE INDEX IF NOT EXISTS idx_trades_exit_status ON trades (exit_ts, status);
-- Daily summary aggregation
CREATE INDEX IF NOT EXISTS idx_trades_ticker_entry_ts ON trades (ticker, entry_ts);
CREATE INDEX IF NOT EXISTS idx_trades_ticker_exit_ts ON trades (ticker, exit_ts);

-- ═══════════════════════════════════════════════════════════════════════════
-- trade_events
-- ═══════════════════════════════════════════════════════════════════════════
CREATE INDEX IF NOT EXISTS idx_trade_events_type_ts ON trade_events (type, ts);

-- ═══════════════════════════════════════════════════════════════════════════
-- account_ledger
-- ═══════════════════════════════════════════════════════════════════════════
-- PnL aggregate: WHERE mode=? AND ts BETWEEN ? AND ? AND event_type IN (...)
CREATE INDEX IF NOT EXISTS idx_ledger_mode_ts_type ON account_ledger (mode, ts, event_type);
-- Balance lookup: WHERE mode=? ORDER BY ts DESC, ledger_id DESC LIMIT 1
CREATE INDEX IF NOT EXISTS idx_ledger_mode_ts_id ON account_ledger (mode, ts DESC, ledger_id DESC);

-- ═══════════════════════════════════════════════════════════════════════════
-- direction_accuracy (analysis queries, calibration, path performance)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE INDEX IF NOT EXISTS idx_da_ticker_ts ON direction_accuracy (ticker, ts);
CREATE INDEX IF NOT EXISTS idx_da_direction_source ON direction_accuracy (direction_source);
CREATE INDEX IF NOT EXISTS idx_da_entry_path ON direction_accuracy (entry_path);
CREATE INDEX IF NOT EXISTS idx_da_status ON direction_accuracy (status);
-- Composite: WHERE status IN ('WIN','LOSS') AND entry_path IS NOT NULL
CREATE INDEX IF NOT EXISTS idx_da_status_entry_path ON direction_accuracy (status, entry_path);
-- Calibration: WHERE status IN ('WIN','LOSS') AND pnl_pct IS NOT NULL
CREATE INDEX IF NOT EXISTS idx_da_status_pnl ON direction_accuracy (status, pnl_pct);
-- Per-ticker analysis: GROUP BY ticker with status filter
CREATE INDEX IF NOT EXISTS idx_da_ticker_status ON direction_accuracy (ticker, status);

-- ═══════════════════════════════════════════════════════════════════════════
-- ai_cio_decisions
-- ═══════════════════════════════════════════════════════════════════════════
CREATE INDEX IF NOT EXISTS idx_cio_created ON ai_cio_decisions (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cio_ticker ON ai_cio_decisions (ticker, created_at DESC);

-- ═══════════════════════════════════════════════════════════════════════════
-- positions
-- ═══════════════════════════════════════════════════════════════════════════
CREATE INDEX IF NOT EXISTS idx_positions_ticker_status ON positions (ticker, status);
CREATE INDEX IF NOT EXISTS idx_positions_status_created_at ON positions (status, created_at);

-- ═══════════════════════════════════════════════════════════════════════════
-- ticker_profiles / sector_profiles
-- ═══════════════════════════════════════════════════════════════════════════
CREATE INDEX IF NOT EXISTS idx_tp_sector ON ticker_profiles (sector);

-- ═══════════════════════════════════════════════════════════════════════════
-- backtest_run_trades
-- ═══════════════════════════════════════════════════════════════════════════
CREATE INDEX IF NOT EXISTS idx_brt_run_ticker ON backtest_run_trades (run_id, ticker);
CREATE INDEX IF NOT EXISTS idx_brt_run_status ON backtest_run_trades (run_id, status);

-- ═══════════════════════════════════════════════════════════════════════════
-- investor tables
-- ═══════════════════════════════════════════════════════════════════════════
CREATE INDEX IF NOT EXISTS idx_inv_pos_ticker_status ON investor_positions (ticker, status);
CREATE INDEX IF NOT EXISTS idx_inv_pos_status_updated ON investor_positions (status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_inv_pos_dca ON investor_positions (dca_enabled, dca_next_ts);
CREATE INDEX IF NOT EXISTS idx_inv_lots_pos_ts ON investor_lots (position_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_inv_lots_ticker ON investor_lots (ticker, ts);

-- ═══════════════════════════════════════════════════════════════════════════
-- path_performance + trade_autopsy_annotations
-- ═══════════════════════════════════════════════════════════════════════════
CREATE INDEX IF NOT EXISTS idx_pp_enabled ON path_performance (enabled);
CREATE INDEX IF NOT EXISTS idx_autopsy_classification ON trade_autopsy_annotations (classification);

-- ═══════════════════════════════════════════════════════════════════════════
-- Misc: ingest_receipts, users, lots, sessions, feature_usage
-- ═══════════════════════════════════════════════════════════════════════════
CREATE INDEX IF NOT EXISTS idx_ingest_receipts_received_ts ON ingest_receipts (received_ts);
CREATE INDEX IF NOT EXISTS idx_users_stripe ON users (stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_lots_position_ts ON lots (position_id, ts);
