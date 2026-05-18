// ═══════════════════════════════════════════════════════════════════════════
// stage-markov.js — kanban stage transition matrix + recovery probabilities
// ═══════════════════════════════════════════════════════════════════════════
//
// Phase 2 S5 of the trajectory research program
// (tasks/2026-05-18-stochastic-research-program.md §0).
//
// PURPOSE
// -------
// Answer the owner's Q5(d): build the simplest useful Markov chain — the
// kanban stage transitions for open trades — so a live "defend"-stage trade
// can be answered: "P(I recover to WIN | I'm currently in 'defend' for
// N bars in the past)".
//
// DATA SOURCE
// -----------
// trail_5m_facts already stores kanban_stage_end per 5-min bucket per
// ticker. For every closed trade, we have its entry_ts and exit_ts on
// trades, and the stage sequence is just SELECT … WHERE ticker = ?
// AND bucket_ts BETWEEN entry AND exit. This is read-only.
//
// OUTPUTS
// -------
// 1. transition_matrix: P(stage_t+1 = X | stage_t = Y) over all observed
//    one-bucket transitions in closed trades. Symmetric counts so we can
//    derive both forward and backward probabilities.
// 2. recovery_table: for each stage X, P(eventual_outcome = WIN | trade
//    ever touched stage X). With sample counts so the n>=15 gating
//    applies the same way it does in cohort lookup.
// 3. dwell_distribution: for each stage, the median / P75 / max number
//    of consecutive 5-min buckets a trade spent in that stage before
//    transitioning (or exiting). The user's "P(recover | in defend for
//    N bars)" needs this dwell knowledge to interpret.
//
// All read-only. No live admission/exit behavior change.
// ═══════════════════════════════════════════════════════════════════════════

const FIVE_MIN_MS = 5 * 60 * 1000;

/**
 * Build the stage Markov + recovery table from closed trades.
 *
 * @param {object} env worker env (uses env.DB)
 * @param {object} [opts]
 * @param {number} [opts.sinceMs]      Earliest entry_ts to include. Default 180d.
 * @param {number} [opts.maxTrades]    Cap on # trades scanned. Default 2000.
 * @returns {Promise<{
 *   ok,
 *   window: { since_ms, until_ms },
 *   trades_scanned, observations, distinct_stages,
 *   transition_matrix: { [from]: { [to]: { n, p } } },
 *   recovery_table: { [stage]: { n_trades_touched, wins, losses, flats, win_rate, avg_R } },
 *   dwell_distribution: { [stage]: { median, p75, p90, max } },
 *   elapsed_ms
 * }>}
 */
export async function buildStageMarkov(env, opts = {}) {
  const t0 = Date.now();
  const db = env?.DB;
  if (!db) return { ok: false, error: "no_db", elapsed_ms: 0 };

  const sinceMs = Number.isFinite(opts.sinceMs) ? Number(opts.sinceMs) : (Date.now() - 180 * 86400000);
  const untilMs = Number.isFinite(opts.untilMs) ? Number(opts.untilMs) : Date.now();
  const maxTrades = Math.max(10, Math.min(10000, Number(opts.maxTrades) || 2000));

  // 1) Pull closed trades in window.
  let trades;
  try {
    const res = await db.prepare(
      `SELECT trade_id, ticker, entry_ts, exit_ts, status, pnl_pct, setup_name
       FROM trades
       WHERE status IN ('WIN','LOSS','FLAT') AND entry_ts >= ?1 AND entry_ts <= ?2
       ORDER BY entry_ts DESC LIMIT ?3`,
    ).bind(sinceMs, untilMs, maxTrades).all();
    trades = res?.results || [];
  } catch (err) {
    return { ok: false, error: String(err?.message || err).slice(0, 300) };
  }

  if (trades.length === 0) {
    return {
      ok: true,
      window: { since_ms: sinceMs, until_ms: untilMs },
      trades_scanned: 0, observations: 0, distinct_stages: 0,
      transition_matrix: {}, recovery_table: {}, dwell_distribution: {},
      elapsed_ms: Date.now() - t0,
    };
  }

  // Accumulators.
  const transCounts = new Map();      // from → Map(to → count)
  const recoveryCounts = new Map();   // stage → { trades_touched: Set<trade_id>, wins, losses, flats, sum_pnl }
  const dwellSamples = new Map();     // stage → number[] (consecutive-bucket dwell counts)

  let observations = 0;

  // 2) For each trade, fetch its stage sequence and process it.
  for (const trade of trades) {
    const entry = Number(trade.entry_ts);
    const exit  = trade.exit_ts != null ? Number(trade.exit_ts) : Date.now();
    const start = Math.floor(entry / FIVE_MIN_MS) * FIVE_MIN_MS;
    const end   = Math.ceil(exit / FIVE_MIN_MS) * FIVE_MIN_MS;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;

    let stages;
    try {
      const res = await db.prepare(
        `SELECT bucket_ts, kanban_stage_end FROM trail_5m_facts
         WHERE ticker = ?1 AND bucket_ts >= ?2 AND bucket_ts <= ?3
         ORDER BY bucket_ts ASC`,
      ).bind(trade.ticker, start, end).all();
      stages = res?.results || [];
    } catch { continue; }

    if (stages.length === 0) continue;

    // Filter to non-null stage transitions.
    const seq = stages
      .map(s => s.kanban_stage_end)
      .filter(s => s != null && s !== "");
    if (seq.length === 0) continue;

    // Update transition matrix (consecutive pairs).
    for (let i = 0; i < seq.length - 1; i++) {
      const from = seq[i], to = seq[i + 1];
      if (from === to) continue;     // only count actual transitions
      let m = transCounts.get(from);
      if (!m) { m = new Map(); transCounts.set(from, m); }
      m.set(to, (m.get(to) || 0) + 1);
      observations += 1;
    }

    // Update recovery table — every distinct stage the trade touched
    // contributes one observation to that stage's outcome distribution.
    const touched = new Set(seq);
    for (const stage of touched) {
      let r = recoveryCounts.get(stage);
      if (!r) { r = { trades_touched: 0, wins: 0, losses: 0, flats: 0, sum_pnl: 0 }; recoveryCounts.set(stage, r); }
      r.trades_touched += 1;
      const o = String(trade.status || "").toUpperCase();
      if (o === "WIN") r.wins += 1;
      else if (o === "LOSS") r.losses += 1;
      else if (o === "FLAT") r.flats += 1;
      if (Number.isFinite(Number(trade.pnl_pct))) r.sum_pnl += Number(trade.pnl_pct);
    }

    // Update dwell — consecutive-bucket runs per stage.
    let runStage = seq[0], runLen = 1;
    for (let i = 1; i < seq.length; i++) {
      if (seq[i] === runStage) { runLen += 1; continue; }
      let arr = dwellSamples.get(runStage);
      if (!arr) { arr = []; dwellSamples.set(runStage, arr); }
      arr.push(runLen);
      runStage = seq[i];
      runLen = 1;
    }
    if (runStage) {
      let arr = dwellSamples.get(runStage);
      if (!arr) { arr = []; dwellSamples.set(runStage, arr); }
      arr.push(runLen);
    }
  }

  // Format transition matrix with probabilities.
  const matrix = {};
  for (const [from, toMap] of transCounts.entries()) {
    let total = 0;
    for (const v of toMap.values()) total += v;
    matrix[from] = {};
    for (const [to, n] of toMap.entries()) {
      matrix[from][to] = { n, p: total > 0 ? Number((n / total).toFixed(4)) : 0 };
    }
  }

  // Format recovery table.
  const recovery = {};
  for (const [stage, r] of recoveryCounts.entries()) {
    const decided = r.wins + r.losses;
    recovery[stage] = {
      n_trades_touched: r.trades_touched,
      wins: r.wins,
      losses: r.losses,
      flats: r.flats,
      win_rate: decided > 0 ? Number((r.wins / decided).toFixed(4)) : null,
      avg_R: r.trades_touched > 0 ? Number((r.sum_pnl / r.trades_touched).toFixed(4)) : null,
    };
  }

  // Format dwell quantiles.
  const dwell = {};
  for (const [stage, samples] of dwellSamples.entries()) {
    if (samples.length === 0) continue;
    const sorted = samples.slice().sort((a, b) => a - b);
    const q = (p) => {
      const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
      return sorted[i];
    };
    dwell[stage] = {
      n_runs: sorted.length,
      median_buckets: q(0.5),
      p75_buckets: q(0.75),
      p90_buckets: q(0.90),
      max_buckets: sorted[sorted.length - 1],
      median_minutes: q(0.5) * 5,
      p75_minutes: q(0.75) * 5,
      p90_minutes: q(0.90) * 5,
    };
  }

  return {
    ok: true,
    window: { since_ms: sinceMs, until_ms: untilMs },
    trades_scanned: trades.length,
    observations,
    distinct_stages: Object.keys(recovery).length,
    transition_matrix: matrix,
    recovery_table: recovery,
    dwell_distribution: dwell,
    elapsed_ms: Date.now() - t0,
  };
}
