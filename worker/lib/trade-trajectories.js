// ═══════════════════════════════════════════════════════════════════════════
// trade-trajectories.js — trade-level bubble-map trajectory recorder (S1.5)
// ═══════════════════════════════════════════════════════════════════════════
//
// Phase 1 step 2 of the trajectory research program
// (tasks/2026-05-18-stochastic-research-program.md §0).
//
// PURPOSE
// -------
// For every closed trade, persist the bubble-map cell sequence through the
// K=12 5-min buckets ending at entry_ts plus all 5-min buckets between
// entry_ts and exit_ts. Sourced from existing trail_5m_facts — no new
// instrumentation. Cell discretization per worker/lib/trajectory-cells.js.
//
// Once populated, Phase 1 S2 cohort lookup uses the entry-cell flat columns
// and setup_name; Phase 2 S2.5 k-NN trajectory similarity uses cell_pre_json
// and cell_during_json; Phase 6 S6 cell-Markov groups by outcome.
//
// PERFORMANCE NOTES
// -----------------
// D1 has per-statement and per-batch limits. The backfill chunks work in
// batches of CHUNK_TRADES trades and uses prepared statements throughout.
// The nightly cron call processes only trades closed in the lookback window
// (default 7 days) so steady-state work per night is ~10-30 trades.
//
// All functions are pure-ish — they take `env` (for env.DB) and return
// plain data. Idempotent: re-running over the same trade range overwrites
// (INSERT OR REPLACE) — safe to invoke from cron and manual admin calls.
// ═══════════════════════════════════════════════════════════════════════════

import {
  cellOfFactWithFlags,
  parseCellKey,
  hammingDistance,
} from "./trajectory-cells.js";

const FIVE_MIN_MS = 5 * 60 * 1000;
const K_PRE_BUCKETS = 12;            // 12 × 5min = 60 minutes of pre-entry context
const CHUNK_TRADES = 50;             // D1-friendly chunk size for backfill
const DEFAULT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;   // 7d for nightly cron
const MAX_DURING_BUCKETS = 144;      // 12 hours guard against runaway trades

// ───────────────────────────────────────────────────────────────────────────
// Schema bootstrap — idempotent, mirrors d1Ensure*Schema pattern elsewhere
// in worker/index.js. Safe to call repeatedly.
// ───────────────────────────────────────────────────────────────────────────

let _trajSchemaReady = false;

export async function ensureTrajectorySchema(env) {
  if (_trajSchemaReady) return true;
  const db = env?.DB;
  if (!db) return false;
  try {
    await db.batch([
      db.prepare(`CREATE TABLE IF NOT EXISTS trade_trajectories (
        trade_id TEXT PRIMARY KEY,
        ticker TEXT NOT NULL,
        direction TEXT,
        setup_name TEXT,
        setup_grade TEXT,
        entry_ts INTEGER NOT NULL,
        exit_ts INTEGER,
        outcome TEXT,
        pnl_pct REAL,
        exit_reason TEXT,
        cell_entry TEXT,
        entry_state TEXT,
        entry_decile INTEGER,
        entry_completion_band INTEGER,
        entry_phase_band INTEGER,
        cell_pre_json TEXT,
        cell_during_json TEXT,
        cell_exit TEXT,
        built_at INTEGER NOT NULL,
        source_version INTEGER NOT NULL DEFAULT 1
      )`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_traj_setup_outcome      ON trade_trajectories (setup_name, outcome)`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_traj_state_decile       ON trade_trajectories (entry_state, entry_decile)`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_traj_cell_entry         ON trade_trajectories (cell_entry)`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_traj_built_at           ON trade_trajectories (built_at)`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_traj_entry_ts           ON trade_trajectories (entry_ts)`),
    ]);
    _trajSchemaReady = true;
    return true;
  } catch (err) {
    console.warn("[trajectory] ensureTrajectorySchema failed:", String(err?.message || err).slice(0, 200));
    return false;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Backfill — given a window of closed trades, build their cell sequences
// and upsert into trade_trajectories. Returns counts for cron logging.
// ───────────────────────────────────────────────────────────────────────────

/**
 * @param {object} env — worker env (uses env.DB)
 * @param {object} [opts]
 * @param {number} [opts.sinceMs]    Only process trades closed at/after this ms epoch. Default: last 7 days.
 * @param {number} [opts.untilMs]    Only process trades closed at/before this ms epoch. Default: now.
 * @param {number} [opts.maxTrades]  Cap total trades processed in this call (D1 timeout safety). Default: 500.
 * @param {boolean} [opts.includeOpen] If true, also includes OPEN trades (no exit) so live cohorts have data. Default: false.
 * @param {boolean} [opts.force]     If true, recompute and overwrite existing trade_trajectories rows. Default: false (skip already-built).
 * @returns {Promise<{ok, scanned, built, skipped, errors, elapsed_ms}>}
 */
export async function backfillTradeTrajectories(env, opts = {}) {
  const t0 = Date.now();
  const result = { ok: false, scanned: 0, built: 0, skipped: 0, errors: 0, elapsed_ms: 0 };

  const db = env?.DB;
  if (!db) { result.elapsed_ms = Date.now() - t0; return result; }

  const ready = await ensureTrajectorySchema(env);
  if (!ready) { result.elapsed_ms = Date.now() - t0; return result; }

  const sinceMs = Number.isFinite(opts.sinceMs) ? Number(opts.sinceMs) : (Date.now() - DEFAULT_LOOKBACK_MS);
  const untilMs = Number.isFinite(opts.untilMs) ? Number(opts.untilMs) : Date.now();
  const maxTrades = Number.isFinite(opts.maxTrades) && opts.maxTrades > 0 ? Math.floor(opts.maxTrades) : 500;
  const includeOpen = !!opts.includeOpen;
  const force = !!opts.force;

  // 1) Pull candidate trades for the window. We always include closed
  //    trades; OPEN trades only when explicitly requested (Phase 2 will
  //    surface live cohort matching on open positions).
  let candidates = [];
  try {
    const statusClause = includeOpen
      ? `t.status IN ('WIN','LOSS','FLAT','OPEN','TP_HIT_TRIM')`
      : `t.status IN ('WIN','LOSS','FLAT')`;
    const { results } = await db.prepare(
      `SELECT t.trade_id, t.ticker, t.direction, t.setup_name, t.setup_grade,
              t.entry_ts, t.exit_ts, t.status, t.pnl_pct, t.exit_reason
       FROM trades t
       WHERE ${statusClause}
         AND COALESCE(t.exit_ts, t.entry_ts) >= ?1
         AND COALESCE(t.exit_ts, t.entry_ts) <= ?2
       ORDER BY COALESCE(t.exit_ts, t.entry_ts) DESC
       LIMIT ?3`,
    ).bind(sinceMs, untilMs, maxTrades).all();
    candidates = results || [];
  } catch (err) {
    console.warn("[trajectory] candidate query failed:", String(err?.message || err).slice(0, 200));
    result.errors += 1;
    result.elapsed_ms = Date.now() - t0;
    return result;
  }

  result.scanned = candidates.length;
  if (candidates.length === 0) {
    result.ok = true;
    result.elapsed_ms = Date.now() - t0;
    return result;
  }

  // 2) If !force, skip trades that already have a trajectory row.
  let existing = new Set();
  if (!force) {
    try {
      const ids = candidates.map(c => c.trade_id);
      // SQLite IN with many params: do in chunks of 100
      for (let i = 0; i < ids.length; i += 100) {
        const chunk = ids.slice(i, i + 100);
        const placeholders = chunk.map((_, j) => `?${j + 1}`).join(",");
        const { results } = await db.prepare(
          `SELECT trade_id FROM trade_trajectories WHERE trade_id IN (${placeholders})`,
        ).bind(...chunk).all();
        for (const row of (results || [])) existing.add(row.trade_id);
      }
    } catch (err) {
      console.warn("[trajectory] existing-id lookup failed:", String(err?.message || err).slice(0, 200));
      // Non-fatal — we'll just recompute everything in the worst case.
    }
  }

  // 3) Process in chunks, building cell sequences from trail_5m_facts.
  const upsertSql = `INSERT OR REPLACE INTO trade_trajectories (
    trade_id, ticker, direction, setup_name, setup_grade,
    entry_ts, exit_ts, outcome, pnl_pct, exit_reason,
    cell_entry, entry_state, entry_decile, entry_completion_band, entry_phase_band,
    cell_pre_json, cell_during_json, cell_exit,
    built_at, source_version
  ) VALUES (?1,?2,?3,?4,?5, ?6,?7,?8,?9,?10, ?11,?12,?13,?14,?15, ?16,?17,?18, ?19, ?20)`;

  for (let i = 0; i < candidates.length; i += CHUNK_TRADES) {
    const chunk = candidates.slice(i, i + CHUNK_TRADES);
    const statements = [];

    for (const trade of chunk) {
      if (existing.has(trade.trade_id)) { result.skipped += 1; continue; }
      try {
        const built = await buildTrajectoryForTrade(db, trade);
        if (!built) { result.skipped += 1; continue; }
        statements.push(db.prepare(upsertSql).bind(
          trade.trade_id,
          trade.ticker || "",
          trade.direction || null,
          trade.setup_name || null,
          trade.setup_grade || null,
          Number(trade.entry_ts),
          trade.exit_ts != null ? Number(trade.exit_ts) : null,
          outcomeOf(trade),
          trade.pnl_pct != null ? Number(trade.pnl_pct) : null,
          trade.exit_reason || null,
          built.cellEntry,
          built.entryState,
          built.entryDecile,
          built.entryCompletionBand,
          built.entryPhaseBand,
          JSON.stringify(built.cellPre),
          JSON.stringify(built.cellDuring),
          built.cellExit,
          Date.now(),
          1,
        ));
      } catch (err) {
        result.errors += 1;
        console.warn(`[trajectory] trade ${trade.trade_id} build failed:`, String(err?.message || err).slice(0, 200));
      }
    }

    if (statements.length === 0) continue;
    try {
      await db.batch(statements);
      result.built += statements.length;
    } catch (err) {
      result.errors += statements.length;
      console.warn(`[trajectory] chunk batch failed (${statements.length} rows):`, String(err?.message || err).slice(0, 200));
    }
  }

  result.ok = true;
  result.elapsed_ms = Date.now() - t0;
  console.log(
    `[trajectory] backfill done: scanned=${result.scanned} built=${result.built} ` +
    `skipped=${result.skipped} errors=${result.errors} elapsed=${result.elapsed_ms}ms`,
  );
  return result;
}

// ── Per-trade trajectory builder ──────────────────────────────────────────

async function buildTrajectoryForTrade(db, trade) {
  const entryTs = Number(trade.entry_ts);
  if (!Number.isFinite(entryTs)) return null;

  const entryBucket = bucketFloor(entryTs);
  const preStart   = entryBucket - K_PRE_BUCKETS * FIVE_MIN_MS;
  const exitTs     = trade.exit_ts != null ? Number(trade.exit_ts) : null;
  const exitBucket = exitTs != null ? bucketFloor(exitTs) : null;
  // Window end: exit bucket if exit known, else cap at K_PRE_BUCKETS forward
  // (defensive — we don't want to pull thousands of buckets for an
  // open / never-exited trade).
  const windowEnd = exitBucket != null
    ? Math.min(exitBucket, entryBucket + MAX_DURING_BUCKETS * FIVE_MIN_MS)
    : entryBucket;

  // One query covers the whole window. trail_5m_facts.bucket_ts is the
  // bucket-start in ms (worker/migrations/add-trail-5m-fact-table.sql).
  const { results } = await db.prepare(
    `SELECT bucket_ts, state, rank, completion, phase_pct,
            had_squeeze_release, had_ema_cross, had_st_flip, had_momentum_elite
     FROM trail_5m_facts
     WHERE ticker = ?1 AND bucket_ts >= ?2 AND bucket_ts <= ?3
     ORDER BY bucket_ts ASC`,
  ).bind(trade.ticker, preStart, windowEnd).all();

  const facts = results || [];
  if (facts.length === 0) {
    // No trail facts in window — nothing we can build. Return null so
    // the row is skipped (will be retried on next backfill if facts
    // backfill later).
    return null;
  }

  // Bucket-keyed map for fast lookup
  const byBucket = new Map();
  for (const f of facts) byBucket.set(Number(f.bucket_ts), f);

  // cellPre: K=12 cells ending at entryBucket (entry bucket is last element)
  const cellPre = [];
  for (let k = K_PRE_BUCKETS - 1; k >= 0; k--) {
    const bts = entryBucket - k * FIVE_MIN_MS;
    const f = byBucket.get(bts);
    cellPre.push(f ? cellOfFactWithFlags(f) : null);
  }
  // cellDuring: buckets strictly after entry through window end
  const cellDuring = [];
  if (exitBucket != null && exitBucket > entryBucket) {
    for (let bts = entryBucket + FIVE_MIN_MS; bts <= windowEnd; bts += FIVE_MIN_MS) {
      const f = byBucket.get(bts);
      cellDuring.push(f ? cellOfFactWithFlags(f) : null);
    }
  }

  // Entry cell + flat columns (preferred: the entry-bucket cell; fall back
  // to the nearest pre-entry non-null cell so cohort filters always have
  // something to match on).
  let cellEntry = cellPre.length > 0 ? cellPre[cellPre.length - 1] : null;
  if (!cellEntry) {
    for (let i = cellPre.length - 2; i >= 0; i--) {
      if (cellPre[i]) { cellEntry = cellPre[i]; break; }
    }
  }
  let entryState = null, entryDecile = null, entryCompletionBand = null, entryPhaseBand = null;
  if (cellEntry) {
    const parsed = parseCellKey(cellEntry);
    if (parsed) {
      entryState = parsed.state;
      entryDecile = parsed.decile;
      entryCompletionBand = parsed.completionBand;
      entryPhaseBand = parsed.phaseBand;
    }
  }

  // Exit cell: last during-cell, or null if no during data
  let cellExit = null;
  for (let i = cellDuring.length - 1; i >= 0; i--) {
    if (cellDuring[i]) { cellExit = cellDuring[i]; break; }
  }
  if (!cellExit && exitBucket != null) {
    const f = byBucket.get(exitBucket);
    cellExit = f ? cellOfFactWithFlags(f) : cellEntry;
  }

  return {
    cellEntry,
    entryState,
    entryDecile,
    entryCompletionBand,
    entryPhaseBand,
    cellPre,
    cellDuring,
    cellExit,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function bucketFloor(tsMs) {
  return Math.floor(Number(tsMs) / FIVE_MIN_MS) * FIVE_MIN_MS;
}

/**
 * Compute cohort metrics from an array of trajectory rows
 * (or any rows shaped { outcome: 'WIN'|'LOSS'|'FLAT', pnl_pct: number }).
 *
 * Used by the /timed/calibration/cohort endpoint (Phase 1 S2) and the
 * upcoming k-NN cohort lookup (Phase 2 S2.5). Same shape both consume.
 *
 * @param {Array<{outcome: string, pnl_pct?: number}>} rows
 * @returns {{
 *   n: number, wins: number, losses: number, flats: number,
 *   win_rate: number|null, avg_R: number|null, expectancy: number|null,
 *   pf: number|null, sum_pnl_pct: number
 * }}
 */
export function computeCohortMetrics(rows) {
  const n = rows.length;
  if (n === 0) {
    return { n: 0, wins: 0, losses: 0, flats: 0, win_rate: null, avg_R: null, expectancy: null, pf: null, sum_pnl_pct: 0 };
  }
  let wins = 0, losses = 0, flats = 0;
  let sumWin = 0, sumLoss = 0;          // sums of pnl_pct
  let sumPnl = 0;
  for (const r of rows) {
    const o = String(r.outcome || "").toUpperCase();
    const p = Number(r.pnl_pct);
    const hasP = Number.isFinite(p);
    if (o === "WIN") { wins += 1; if (hasP) { sumWin += p; sumPnl += p; } }
    else if (o === "LOSS") { losses += 1; if (hasP) { sumLoss += p; sumPnl += p; } }
    else if (o === "FLAT") { flats += 1; if (hasP) { sumPnl += p; } }
  }
  const decided = wins + losses;
  const win_rate = decided > 0 ? wins / decided : null;
  const avg_R = n > 0 ? sumPnl / n : null;
  const expectancy = avg_R; // synonym for compat; expectancy in pnl_pct/trade
  const pf = sumLoss < 0 ? (sumWin / Math.abs(sumLoss)) : (sumWin > 0 ? Infinity : null);
  return {
    n,
    wins,
    losses,
    flats,
    win_rate,
    avg_R: avg_R != null ? Number(avg_R.toFixed(4)) : null,
    expectancy: expectancy != null ? Number(expectancy.toFixed(4)) : null,
    pf: pf != null && Number.isFinite(pf) ? Number(pf.toFixed(3)) : pf,
    sum_pnl_pct: Number(sumPnl.toFixed(4)),
  };
}

/**
 * Phase 2 S2.5 — k-NN trajectory cohort lookup.
 *
 * Given a candidate cell sequence (e.g. the last K=12 cells of a live
 * candidate ticker), find the k nearest historical trade trajectories by
 * Hamming distance over their cell_pre_json arrays, and return the cohort
 * metrics over those neighbors. Gated at n>=minN per owner lock-in.
 *
 * @param {object} env worker env (uses env.DB)
 * @param {string[]} candidateSeq Array of cell-key strings, newest-last
 * @param {object} [opts]
 * @param {number} [opts.k]              Neighbors to keep. Default 50.
 * @param {number} [opts.minN]           Cohort floor. Default 15.
 * @param {number} [opts.maxDistance]    Hard-cut on distance. Default Infinity.
 * @param {string} [opts.setupFilter]    Optional filter to one setup_name.
 * @param {string} [opts.directionFilter] Optional 'LONG' / 'SHORT' filter.
 * @param {number} [opts.lookbackDays]   Window on entry_ts. Default 180.
 * @returns {Promise<{ ok, candidate_seq, neighbors_considered, cohort,
 *                     recent, sample_neighbors, gated, gated_reason }>}
 */
export async function findCohortByTrajectory(env, candidateSeq, opts = {}) {
  const t0 = Date.now();
  const db = env?.DB;
  if (!db) return { ok: false, error: "no_db", elapsed_ms: 0 };
  if (!Array.isArray(candidateSeq) || candidateSeq.length === 0) {
    return { ok: false, error: "candidate_seq_required" };
  }

  const k            = Math.max(1, Math.min(500, Number(opts.k) || 50));
  const minN         = Math.max(1, Math.min(500, Number(opts.minN) || 15));
  const maxDistance  = Number.isFinite(opts.maxDistance) ? Number(opts.maxDistance) : Infinity;
  const setupFilter  = opts.setupFilter ? String(opts.setupFilter) : null;
  const dirFilter    = opts.directionFilter ? String(opts.directionFilter).toUpperCase() : null;
  const lookbackDays = Math.max(1, Math.min(720, Number(opts.lookbackDays) || 180));
  const sinceMs      = Date.now() - lookbackDays * 86400000;

  // Pull all candidate trajectories in the window (closed trades only).
  const where = [`entry_ts >= ?`, `outcome IN ('WIN','LOSS','FLAT')`];
  const params = [sinceMs];
  if (setupFilter) { where.push(`setup_name = ?`); params.push(setupFilter); }
  if (dirFilter)   { where.push(`direction = ?`);  params.push(dirFilter); }

  let rows;
  try {
    const res = await db.prepare(
      `SELECT trade_id, ticker, direction, setup_name, setup_grade,
              outcome, pnl_pct, cell_pre_json, cell_entry, entry_ts
       FROM trade_trajectories
       WHERE ${where.join(" AND ")}`,
    ).bind(...params).all();
    rows = res?.results || [];
  } catch (err) {
    return { ok: false, error: String(err?.message || err).slice(0, 300) };
  }

  if (rows.length === 0) {
    return {
      ok: true,
      candidate_seq: candidateSeq,
      neighbors_considered: 0,
      cohort: computeCohortMetrics([]),
      recent: computeCohortMetrics([]),
      sample_neighbors: [],
      gated: true,
      gated_reason: "no_historical_trajectories_in_window",
      elapsed_ms: Date.now() - t0,
    };
  }

  // Compute distance for each, keep top-k by smallest distance.
  const scored = [];
  for (const r of rows) {
    let seq = null;
    try { seq = r.cell_pre_json ? JSON.parse(r.cell_pre_json) : null; } catch {}
    if (!Array.isArray(seq) || seq.length === 0) continue;
    const d = hammingDistance(candidateSeq, seq);
    if (!Number.isFinite(d) || d > maxDistance) continue;
    scored.push({ row: r, d });
  }
  scored.sort((a, b) => a.d - b.d);
  const neighbors = scored.slice(0, k);

  // Cohort metrics over neighbors (uses the same shape consumed by
  // /timed/calibration/cohort).
  const cohortRows = neighbors.map(n => ({ outcome: n.row.outcome, pnl_pct: n.row.pnl_pct, entry_ts: n.row.entry_ts }));
  const recentCutoff = Date.now() - 30 * 86400000;
  const recentRows = cohortRows.filter(r => Number(r.entry_ts) >= recentCutoff);

  const cohort = computeCohortMetrics(cohortRows);
  const recent = computeCohortMetrics(recentRows);

  const gated = cohort.n < minN;
  return {
    ok: true,
    candidate_seq: candidateSeq,
    neighbors_considered: scored.length,
    config: { k, min_n: minN, max_distance: maxDistance, lookback_days: lookbackDays, setup: setupFilter, direction: dirFilter },
    cohort,
    recent,
    sample_neighbors: neighbors.slice(0, 10).map(n => ({
      trade_id: n.row.trade_id,
      ticker: n.row.ticker,
      direction: n.row.direction,
      setup_name: n.row.setup_name,
      setup_grade: n.row.setup_grade,
      outcome: n.row.outcome,
      pnl_pct: n.row.pnl_pct,
      cell_entry: n.row.cell_entry,
      entry_ts: n.row.entry_ts,
      distance: n.d,
    })),
    gated,
    gated_reason: gated ? `n=${cohort.n} < min_n=${minN}; treat as observational only (no live override)` : null,
    elapsed_ms: Date.now() - t0,
  };
}

function outcomeOf(trade) {
  const s = String(trade.status || "").toUpperCase();
  if (s === "WIN") return "WIN";
  if (s === "LOSS") return "LOSS";
  if (s === "FLAT") return "FLAT";
  if (s === "TP_HIT_TRIM") return "WIN"; // partial+trim still a win for cohort purposes
  return "OPEN";
}
