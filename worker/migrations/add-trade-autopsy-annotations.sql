-- Trade Autopsy annotations: classification and notes for model training
-- Run: wrangler d1 execute timed-trading-ledger --remote --file=worker/migrations/add-trade-autopsy-annotations.sql --env production

CREATE TABLE IF NOT EXISTS trade_autopsy_annotations (
  trade_id TEXT PRIMARY KEY,
  classification TEXT NOT NULL DEFAULT '',
  notes TEXT,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_autopsy_classification ON trade_autopsy_annotations (classification);
