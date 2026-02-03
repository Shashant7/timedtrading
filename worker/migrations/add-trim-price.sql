-- Add trim_price to trades table (price at which trim occurred).
-- Run: wrangler d1 execute timed-trading-ledger --remote --file=worker/migrations/add-trim-price.sql --env production
ALTER TABLE trades ADD COLUMN trim_price REAL;
