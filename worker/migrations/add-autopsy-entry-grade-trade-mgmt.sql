-- Add Entry Grade and Trade Management multi-select to Trade Autopsy
-- Run: wrangler d1 execute timed-trading-ledger --remote --file=worker/migrations/add-autopsy-entry-grade-trade-mgmt.sql --env production

ALTER TABLE trade_autopsy_annotations ADD COLUMN entry_grade TEXT DEFAULT '[]';
ALTER TABLE trade_autopsy_annotations ADD COLUMN trade_management TEXT DEFAULT '[]';
