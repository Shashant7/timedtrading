-- Add trim_ts to existing trades table (run once if table was created before trim_ts existed).
-- Run: wrangler d1 execute timed-trading-ledger --remote --file=worker/migrations/add-trim-ts.sql --env production
ALTER TABLE trades ADD COLUMN trim_ts INTEGER;
