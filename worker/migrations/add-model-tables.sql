-- Phase 2: Self-Learning Model Tables
-- Apply: wrangler d1 execute timed-trading-ledger --file=worker/migrations/add-model-tables.sql --env production --remote

-- =============================================================================
-- model_predictions: every meaningful signal the system fires
-- =============================================================================
CREATE TABLE IF NOT EXISTS model_predictions (
  prediction_id TEXT PRIMARY KEY,                 -- ulid or ticker:ts:type
  ticker TEXT NOT NULL,
  ts INTEGER NOT NULL,                            -- ms epoch when prediction was made
  price REAL NOT NULL,                            -- price at prediction time

  -- Prediction
  direction TEXT NOT NULL,                        -- UP / DOWN
  trigger_type TEXT NOT NULL,                     -- enter_now, setup, exit, trim, state_flip, signal
  confidence TEXT,                                -- high / medium / low
  horizon_days INTEGER DEFAULT 5,                 -- prediction horizon (days)

  -- Scoring snapshot at prediction time
  htf_score REAL,
  ltf_score REAL,
  state TEXT,                                     -- HTF_BULL_LTF_BULL etc.
  completion REAL,
  phase_pct REAL,
  rank INTEGER,
  kanban_stage TEXT,
  entry_path TEXT,                                -- gold_long, momentum_score, etc.
  entry_reason TEXT,
  sector TEXT,

  -- Flags snapshot (JSON for flexibility)
  flags_json TEXT,                                -- serialized flags object

  -- Pattern match
  matched_patterns TEXT,                          -- comma-separated pattern_ids that matched

  -- Resolution
  resolved INTEGER NOT NULL DEFAULT 0,            -- 0=open, 1=resolved
  outcome_id TEXT,                                -- FK to model_outcomes (set on resolution)

  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mp_ticker_ts ON model_predictions (ticker, ts);
CREATE INDEX IF NOT EXISTS idx_mp_resolved ON model_predictions (resolved);
CREATE INDEX IF NOT EXISTS idx_mp_trigger_type ON model_predictions (trigger_type);
CREATE INDEX IF NOT EXISTS idx_mp_direction ON model_predictions (direction);
CREATE INDEX IF NOT EXISTS idx_mp_ts ON model_predictions (ts);

-- =============================================================================
-- model_outcomes: links prediction → actual result
-- =============================================================================
CREATE TABLE IF NOT EXISTS model_outcomes (
  outcome_id TEXT PRIMARY KEY,                    -- prediction_id + "_outcome"
  prediction_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  prediction_ts INTEGER NOT NULL,                 -- copied for query convenience

  -- Actual result
  resolution_ts INTEGER NOT NULL,                 -- when outcome was determined
  price_at_prediction REAL,
  price_at_resolution REAL,
  actual_return_pct REAL,                         -- (end - start) / start * 100
  actual_return_pts REAL,                         -- end - start (dollar value)

  -- Excursion analysis
  max_favorable_excursion_pct REAL,               -- best unrealized gain during horizon
  max_adverse_excursion_pct REAL,                 -- worst unrealized loss during horizon
  time_to_peak_days REAL,                         -- trading days from prediction to peak/trough

  -- Outcome classification
  hit INTEGER,                                    -- 1 = moved in predicted direction ≥ threshold
  miss INTEGER,                                   -- 1 = moved opposite or flat
  magnitude_bucket TEXT,                          -- small (<5%), medium (5-15%), large (>15%)

  -- Trade linkage
  trade_id TEXT,                                  -- FK to trades (nullable — signal_only if no trade)
  action_taken TEXT NOT NULL DEFAULT 'signal_only', -- traded / skipped / missed_opportunity

  -- Resolution method
  resolution_reason TEXT,                         -- horizon_expired, tp_hit, sl_hit, manual, position_closed

  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mo_prediction_id ON model_outcomes (prediction_id);
CREATE INDEX IF NOT EXISTS idx_mo_ticker ON model_outcomes (ticker);
CREATE INDEX IF NOT EXISTS idx_mo_hit ON model_outcomes (hit);
CREATE INDEX IF NOT EXISTS idx_mo_resolution_ts ON model_outcomes (resolution_ts);

-- =============================================================================
-- pattern_library: living catalog of predictive patterns
-- =============================================================================
CREATE TABLE IF NOT EXISTS pattern_library (
  pattern_id TEXT PRIMARY KEY,                    -- slug: bull_state_dominance, squeeze_release_bear, etc.
  name TEXT NOT NULL,
  description TEXT,
  expected_direction TEXT,                        -- UP / DOWN / null (neutral)

  -- Rule definition (JSON): conditions to match against a scoring snapshot
  definition_json TEXT NOT NULL,

  -- Performance metrics
  hit_rate REAL,                                  -- 0.0–1.0
  sample_count INTEGER DEFAULT 0,
  avg_return REAL,                                -- average return when pattern fires
  avg_magnitude REAL,                             -- average |magnitude| of moves
  expected_value REAL,                            -- (upPct * avgUp - downPct * avgDn) / 100
  directional_accuracy REAL,                      -- % of time direction matches expectedDir

  -- Lifecycle
  confidence REAL DEFAULT 0.5,                    -- 0.0–1.0, Bayesian-updated
  status TEXT NOT NULL DEFAULT 'active',          -- active / degraded / retired / candidate
  version INTEGER NOT NULL DEFAULT 1,

  -- Timestamps
  last_hit_ts INTEGER,
  last_updated INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pl_status ON pattern_library (status);
CREATE INDEX IF NOT EXISTS idx_pl_expected_dir ON pattern_library (expected_direction);

-- =============================================================================
-- model_changelog: audit trail for every model change
-- =============================================================================
CREATE TABLE IF NOT EXISTS model_changelog (
  change_id TEXT PRIMARY KEY,
  change_type TEXT NOT NULL,                      -- add_pattern, retire_pattern, update_threshold,
                                                  -- update_hit_rate, degrade_pattern, promote_pattern
  pattern_id TEXT,                                -- affected pattern (nullable for global changes)
  description TEXT NOT NULL,

  -- Before/after
  old_value_json TEXT,
  new_value_json TEXT,

  -- Evidence
  evidence_json TEXT,                             -- data supporting the change

  -- Approval workflow
  status TEXT NOT NULL DEFAULT 'proposed',        -- proposed / approved / rejected / auto_applied
  proposed_at INTEGER NOT NULL,
  approved_at INTEGER,
  approved_by TEXT,                               -- 'system' for auto, 'human' for manual

  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mc_status ON model_changelog (status);
CREATE INDEX IF NOT EXISTS idx_mc_pattern_id ON model_changelog (pattern_id);
CREATE INDEX IF NOT EXISTS idx_mc_proposed_at ON model_changelog (proposed_at);
