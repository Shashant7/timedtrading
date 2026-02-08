-- Add kanban_stage column to timed_trail for time-travel support
-- This captures the computed Kanban lane at each trail point, enabling:
--   1. Proper kanban_stage aggregation in trail_5m_facts
--   2. Time-travel queries without re-computation
--   3. Historical Kanban lane analysis
ALTER TABLE timed_trail ADD COLUMN kanban_stage TEXT;

CREATE INDEX IF NOT EXISTS idx_timed_trail_kanban_stage ON timed_trail (kanban_stage);
