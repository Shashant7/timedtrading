// ═══════════════════════════════════════════════════════════════════════════
// admission-cohort-log.js — log every cohort-gated admission decision
// ═══════════════════════════════════════════════════════════════════════════
//
// Phase 4 of the trajectory research program
// (tasks/2026-05-18-stochastic-research-program.md §0.6).
//
// PURPOSE
// -------
// Persist every accept / reject decision made by the cohort gates (G1 pause
// and G2 cohort-fail-block) along with the cohort metrics that informed
// the decision. This is HOW we measure the impact of the gates after the
// owner enables them — without this log we'd flip the gates on and have
// no idea whether they're helping or hurting.
//
// SCHEMA
// ------
// One row per (ticker, ts, gate) decision. Stored fire-and-forget; D1 write
// failure NEVER blocks the admission path.
//
// PRIVACY / RETENTION
// -------------------
// Pure operational ledger. No PII. Retained indefinitely until we add a
// purge cron (separate PR if/when we have years of data).
// ═══════════════════════════════════════════════════════════════════════════

let _schemaReady = false;

export async function ensureAdmissionCohortLogSchema(env) {
  if (_schemaReady) return true;
  const db = env?.DB;
  if (!db) return false;
  try {
    await db.batch([
      db.prepare(`CREATE TABLE IF NOT EXISTS admission_cohort_log (
        log_id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,                  -- ms epoch of the decision
        ticker TEXT NOT NULL,
        direction TEXT,                       -- LONG / SHORT
        entry_path TEXT,                      -- tt_gap_reversal_long, etc.
        setup_grade TEXT,                     -- Prime / Confirmed / Speculative
        cell_entry TEXT,                      -- cell key at the decision bucket
        gate TEXT NOT NULL,                   -- 'G1_pause' / 'G2_cohort_fail' / 'pass'
        decision TEXT NOT NULL,               -- 'accept' / 'reject'
        reason TEXT,                          -- short reason code
        -- Cohort metrics (NULL when the cohort wasn't computed for this row)
        cohort_n INTEGER,
        cohort_win_rate REAL,
        cohort_avg_r REAL,
        cohort_pf REAL,
        cohort_recent_n INTEGER,
        cohort_recent_win_rate REAL,
        cohort_gated INTEGER,                 -- 1 if n < min_n
        -- Free-form diagnostics (small JSON, ≤ 2KB)
        meta_json TEXT
      )`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_acl_ts        ON admission_cohort_log (ts DESC)`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_acl_ticker    ON admission_cohort_log (ticker, ts DESC)`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_acl_gate      ON admission_cohort_log (gate, ts DESC)`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_acl_decision  ON admission_cohort_log (decision, ts DESC)`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_acl_entrypath ON admission_cohort_log (entry_path, ts DESC)`),
    ]);
    _schemaReady = true;
    return true;
  } catch (err) {
    console.warn("[admission-cohort-log] schema ensure failed:", String(err?.message || err).slice(0, 200));
    return false;
  }
}

/**
 * Fire-and-forget insert. Returns immediately; D1 write happens via
 * ctx.waitUntil() so the admission path never waits on D1 latency. On
 * failure we log to console and move on — the gates' DECISIONS are
 * authoritative; the log is observational.
 *
 * Caller is responsible for wrapping the call in ctx.waitUntil() if it
 * has access to ctx (preferred). When no ctx is available we just fire
 * the promise and ignore.
 *
 * @param {object} env worker env (uses env.DB)
 * @param {object} row {
 *   ts, ticker, direction?, entry_path?, setup_grade?, cell_entry?,
 *   gate, decision, reason?, cohort?, meta?
 * }
 * @returns {Promise<void>}
 */
export async function logAdmissionDecision(env, row) {
  if (!env?.DB || !row) return;
  if (!_schemaReady) {
    // First call lazily ensures schema. Subsequent calls skip the
    // ensure (cached _schemaReady flag inside ensureAdmissionCohortLogSchema).
    try { await ensureAdmissionCohortLogSchema(env); } catch (_) { return; }
  }
  try {
    const cohort = row.cohort || {};
    const recent = row.recent || {};
    await env.DB.prepare(
      `INSERT INTO admission_cohort_log (
        ts, ticker, direction, entry_path, setup_grade, cell_entry,
        gate, decision, reason,
        cohort_n, cohort_win_rate, cohort_avg_r, cohort_pf,
        cohort_recent_n, cohort_recent_win_rate, cohort_gated,
        meta_json
      ) VALUES (?1,?2,?3,?4,?5,?6, ?7,?8,?9, ?10,?11,?12,?13, ?14,?15,?16, ?17)`,
    ).bind(
      Number(row.ts) || Date.now(),
      String(row.ticker || ""),
      row.direction || null,
      row.entry_path || null,
      row.setup_grade || null,
      row.cell_entry || null,
      String(row.gate || "unknown"),
      String(row.decision || "unknown"),
      row.reason || null,
      Number.isFinite(cohort.n) ? Number(cohort.n) : null,
      Number.isFinite(cohort.win_rate) ? Number(cohort.win_rate) : null,
      Number.isFinite(cohort.avg_R) ? Number(cohort.avg_R) : null,
      Number.isFinite(cohort.pf) ? Number(cohort.pf) : null,
      Number.isFinite(recent.n) ? Number(recent.n) : null,
      Number.isFinite(recent.win_rate) ? Number(recent.win_rate) : null,
      row.cohort_gated === true || row.cohort_gated === 1 ? 1 : 0,
      row.meta ? JSON.stringify(row.meta).slice(0, 2000) : null,
    ).run();
  } catch (err) {
    console.warn("[admission-cohort-log] write failed (non-fatal):", String(err?.message || err).slice(0, 150));
  }
}
