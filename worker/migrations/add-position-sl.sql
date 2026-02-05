-- Add stop_loss column to positions table for trailing SL tracking
-- Run: wrangler d1 execute timed-trading-ledger --remote --file=worker/migrations/add-position-sl.sql --env production

ALTER TABLE positions ADD COLUMN stop_loss REAL;
ALTER TABLE positions ADD COLUMN take_profit REAL;

-- Index for quick lookups of positions that might need SL checks
CREATE INDEX IF NOT EXISTS idx_positions_sl ON positions (stop_loss);
