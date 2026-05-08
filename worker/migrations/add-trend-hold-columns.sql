-- Phase C — Stage 2 (2026-05-08) — Trend-Hold lifecycle state.
--
-- Adds columns to `trades` for the Trend-Hold hybrid lifecycle state
-- alongside Active Trader and Investor. A trade gets *promoted* to
-- Trend-Hold when it has worked AND the trend is intact AND the
-- structure is clean (gates implemented in worker/trend-hold.js).
--
-- ALL behavior is gated on `model_config.deep_audit_trend_hold_enabled`
-- which defaults to "false" — schema is forward-compatible but the
-- feature is dark until backtest-validated.
--
-- Apply with:
--   wrangler d1 execute timed_trading_db \
--     --file=worker/migrations/add-trend-hold-columns.sql --env production

ALTER TABLE trades ADD COLUMN trend_hold_state TEXT;            -- "active" | "demoted" | NULL
ALTER TABLE trades ADD COLUMN trend_hold_promoted_at INTEGER;   -- ms epoch
ALTER TABLE trades ADD COLUMN trend_hold_demoted_at INTEGER;    -- ms epoch
ALTER TABLE trades ADD COLUMN trend_hold_max_mfe_pct REAL;      -- max MFE seen while in active state
ALTER TABLE trades ADD COLUMN trend_hold_flavor TEXT;           -- "CLEAN_TREND" | "RESILIENT_TREND" | NULL
ALTER TABLE trades ADD COLUMN trend_hold_promote_reason TEXT;   -- short string, debug-only
ALTER TABLE trades ADD COLUMN trend_hold_demote_reason TEXT;    -- short string, debug-only

CREATE INDEX IF NOT EXISTS idx_trades_trend_hold_state ON trades (trend_hold_state);
