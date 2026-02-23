-- Add EMA regime tracking columns to trail_5m_facts
-- ema_regime_D: Daily EMA regime (-2 to +2) at end of 5m bucket
-- had_ema_cross_5_48: Did a 5/48 EMA cross occur in this bucket?
-- had_ema_cross_13_21: Did a 13/21 EMA cross occur in this bucket?

ALTER TABLE trail_5m_facts ADD COLUMN ema_regime_D INTEGER DEFAULT 0;
ALTER TABLE trail_5m_facts ADD COLUMN had_ema_cross_5_48 INTEGER DEFAULT 0;
ALTER TABLE trail_5m_facts ADD COLUMN had_ema_cross_13_21 INTEGER DEFAULT 0;
