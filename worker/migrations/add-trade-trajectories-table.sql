-- ═══════════════════════════════════════════════════════════════════════════
-- TRADE TRAJECTORIES — bubble-map cell sequence per closed trade
-- ═══════════════════════════════════════════════════════════════════════════
--
-- S1.5 of the trajectory research program
-- (tasks/2026-05-18-stochastic-research-program.md, Phase 1).
--
-- For every closed trade, store its sequence of bubble-map cells through
-- the K=12 5-min buckets preceding entry plus all 5-min buckets between
-- entry_ts and exit_ts. Source: existing trail_5m_facts (no new logging
-- required). Cell encoding per worker/lib/trajectory-cells.js (640-cell
-- state space; see that file's header for the schema rationale).
--
-- Once populated:
--   * S2 cohort lookup queries this table by entry-cell columns + setup
--     (Phase 1, immediate).
--   * S2.5 k-NN trajectory similarity uses cell_pre_json + cell_during_json
--     (Phase 2).
--   * S6 win-conditioned vs lose-conditioned cell Markov chain (Phase 6)
--     builds transition matrices grouped by `outcome`.
--
-- Applied via the idempotent CREATE TABLE pattern used by other tables in
-- this repo. Also applied at worker boot via d1EnsureTrajectorySchema() in
-- worker/index.js — see commit message for details.
--
-- Manual apply:
--   wrangler d1 execute timed-trading-ledger --remote \
--     --file=worker/migrations/add-trade-trajectories-table.sql \
--     --env production
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS trade_trajectories (
  -- Identity
  trade_id TEXT PRIMARY KEY,
  ticker TEXT NOT NULL,
  direction TEXT,                       -- LONG / SHORT (from trades.direction)
  setup_name TEXT,                      -- trades.setup_name
  setup_grade TEXT,                     -- trades.setup_grade
  entry_ts INTEGER NOT NULL,            -- trades.entry_ts (ms epoch)
  exit_ts INTEGER,                      -- trades.exit_ts; null if still open

  -- Outcome (denormalized for fast cohort queries — derived from trades.status)
  outcome TEXT,                         -- WIN / LOSS / FLAT / OPEN
  pnl_pct REAL,                         -- trades.pnl_pct (null if open)
  exit_reason TEXT,                     -- trades.exit_reason

  -- Entry-cell flat columns (FAST filter path for Phase 1 cohort lookups
  -- before the JSON-array trajectory matching of Phase 2 lands).
  cell_entry TEXT,                      -- e.g. "B|D2|C0|P0"
  entry_state TEXT,                     -- "B" / "Bp" / "R" / "Rp" / "N"
  entry_decile INTEGER,                 -- 0..9 (NULL only on malformed rows)
  entry_completion_band INTEGER,        -- 0..3
  entry_phase_band INTEGER,             -- 0..3

  -- Trajectory storage
  -- cell_pre_json — JSON array of K=12 cell keys ending at entry_ts.
  --                Newest-last ordering (last element = cell at entry).
  --                Entries may be null for missing buckets (e.g. trade
  --                opened in the first hour of session); analyzers handle.
  -- cell_during_json — JSON array of cells from entry_ts (exclusive) through
  --                exit_ts. Empty array for instantaneous exits.
  cell_pre_json TEXT,                   -- e.g. '["B|D3|C0|P0","B|D3|C1|P0",...]'
  cell_during_json TEXT,                -- same shape; nullable

  -- Optional cell at exit (last during-cell or cell at exit_ts bucket)
  cell_exit TEXT,

  -- Audit
  built_at INTEGER NOT NULL,            -- ms epoch when this row was computed
  source_version INTEGER NOT NULL DEFAULT 1   -- bump when cell schema changes
);

-- Indexes — sized for the dominant Phase 1 query shapes.
--   1) Cohort lookup by setup_name + outcome
--   2) Cohort lookup by entry_state + entry_decile (cell-coarse)
--   3) Cell-exact lookup by cell_entry
--   4) Recency window (built_at) for delta backfill
CREATE INDEX IF NOT EXISTS idx_traj_setup_outcome      ON trade_trajectories (setup_name, outcome);
CREATE INDEX IF NOT EXISTS idx_traj_state_decile       ON trade_trajectories (entry_state, entry_decile);
CREATE INDEX IF NOT EXISTS idx_traj_cell_entry         ON trade_trajectories (cell_entry);
CREATE INDEX IF NOT EXISTS idx_traj_built_at           ON trade_trajectories (built_at);
CREATE INDEX IF NOT EXISTS idx_traj_entry_ts           ON trade_trajectories (entry_ts);
