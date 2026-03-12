-- Trade grading: setup name, grade, and risk budget for grade-based position sizing
-- Apply with: wrangler d1 execute timed_trading_db --file=worker/migrations/add-trade-grading.sql --env production

ALTER TABLE trades ADD COLUMN setup_name TEXT;
ALTER TABLE trades ADD COLUMN setup_grade TEXT;
ALTER TABLE trades ADD COLUMN risk_budget REAL;

ALTER TABLE direction_accuracy ADD COLUMN setup_name TEXT;
ALTER TABLE direction_accuracy ADD COLUMN setup_grade TEXT;
ALTER TABLE direction_accuracy ADD COLUMN risk_budget REAL;
