// ═══════════════════════════════════════════════════════════════════════════
// cell-markov.js — bubble-map cell transition matrix + win-conditioned chain
// ═══════════════════════════════════════════════════════════════════════════
//
// Phase 6 prep / Phase 7 visibility item of the trajectory research program
// (tasks/2026-05-18-stochastic-research-program.md §0.6, S6).
//
// PURPOSE
// -------
// Read-only. Builds Markov-chain transition matrices over the 640-cell
// bubble-map state space (worker/lib/trajectory-cells.js), grouped by
// trade outcome. The KEY insight is the comparison of:
//
//   P(cell_t+1 | cell_t, eventually_won)
//     vs
//   P(cell_t+1 | cell_t, eventually_lost)
//
// Cells where the two chains diverge meaningfully are PREDICTIVE — they're
// the trajectory paths that lead to different outcomes. Cells where the
// two chains agree closely are NOISE ZONES — trajectories through them
// don't separate winners from losers.
//
// DATA SOURCE
// -----------
// trade_trajectories.cell_pre_json + cell_during_json — already populated
// by Phase 1 (PR #205). For each closed trade, walk every consecutive
// (cell_t, cell_t+1) pair and increment the chain conditioned on the
// trade's outcome.
//
// OUTPUTS
// -------
// 1. win_chain  — { from_cell: { to_cell: { n, p } } } over winning trades
// 2. lose_chain — same shape, losing trades
// 3. divergent_cells — cells with |p_win[next] - p_lose[next]| above a
//    threshold for the most common transitions. These are the predictive
//    zones the user wants to know about.
// 4. cell_volume — { cell: n_observations } so the consumer can filter
//    low-sample noise.
//
// All read-only. No live admission/exit/sizing behavior change.
// ═══════════════════════════════════════════════════════════════════════════

const DEFAULTS = Object.freeze({
  lookbackDays: 180,
  minCellObs: 5,             // skip cells with < 5 observations
  divergenceThreshold: 0.15, // |p_win - p_lose| ≥ this counts as "divergent"
  topDivergentCells: 50,     // cap the report payload
  maxTrades: 5000,
});

/**
 * @param {object} env worker env (uses env.DB)
 * @param {object} [opts]
 * @param {number} [opts.lookbackDays]      Default 180
 * @param {number} [opts.minCellObs]        Default 5
 * @param {number} [opts.divergenceThreshold] Default 0.15
 * @param {number} [opts.topDivergentCells] Default 50
 * @param {number} [opts.maxTrades]         Default 5000
 * @param {boolean} [opts.includeDuring]    If true, include cell_during sequence too. Default true.
 * @returns {Promise<{
 *   ok, window, config, counts,
 *   win_chain: { [from]: { [to]: { n, p } } },
 *   lose_chain: { [from]: { [to]: { n, p } } },
 *   cell_volume: { [cell]: { n_win, n_lose, total } },
 *   divergent_cells: [{ cell, top_transitions: [{ to, p_win, p_lose, delta }] }],
 *   noise_cells_count: number,
 *   elapsed_ms
 * }>}
 */
// 2026-05-26 — Phase 6 G3 shadow-mode caching.
//
// At admission time we want to read the cell-markov outcome split
// without running the full ~5K-trade scan. Cache the snapshot in KV
// keyed by lookback window, and serve it for `cellMarkovCacheTtlMs`.

const CELL_MARKOV_KV_KEY = "timed:cell-markov:v1";
const CELL_MARKOV_KV_TTL_S = 30 * 86400; // 30 days

export async function persistCellMarkovCache(env, opts = {}) {
  const KV = env?.KV_TIMED;
  if (!KV) return { ok: false, error: "no_kv" };
  const result = await buildCellMarkov(env, {
    lookbackDays: opts.lookbackDays || 180,
    minCellObs: opts.minCellObs || 5,
    divergenceThreshold: opts.divergenceThreshold || 0.15,
    maxTrades: opts.maxTrades || 5000,
  });
  if (!result?.ok) return { ok: false, error: result?.error || "build_failed" };
  // Strip heavy fields (full chains) — the shadow evaluator only needs
  // cell_volume + divergent_cells.
  const slim = {
    schema_version: 1,
    computed_at: Date.now(),
    window: result.window,
    config: result.config,
    counts: result.counts,
    cell_volume: result.cell_volume,
    divergent_cells: result.divergent_cells,
    noise_cells_count: result.noise_cells_count,
  };
  try {
    await KV.put(CELL_MARKOV_KV_KEY, JSON.stringify(slim), { expirationTtl: CELL_MARKOV_KV_TTL_S });
    return { ok: true, kv_key: CELL_MARKOV_KV_KEY, cells: Object.keys(slim.cell_volume || {}).length, divergent: slim.divergent_cells?.length || 0, bytes: JSON.stringify(slim).length };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
}

let _cellMarkovCached = null;
let _cellMarkovCachedAt = 0;
const CELL_MARKOV_CACHE_TTL_MS = 30 * 60 * 1000; // 30 min in-isolate

export async function loadCellMarkovCached(env) {
  const now = Date.now();
  if (_cellMarkovCached && (now - _cellMarkovCachedAt) < CELL_MARKOV_CACHE_TTL_MS) return _cellMarkovCached;
  const KV = env?.KV_TIMED;
  if (!KV) return null;
  try {
    const blob = await KV.get(CELL_MARKOV_KV_KEY, "json");
    if (!blob) return null;
    _cellMarkovCached = blob;
    _cellMarkovCachedAt = now;
    return blob;
  } catch (_) { return null; }
}

export { CELL_MARKOV_KV_KEY };

export async function buildCellMarkov(env, opts = {}) {
  const t0 = Date.now();
  const db = env?.DB;
  if (!db) return { ok: false, error: "no_db", elapsed_ms: 0 };

  const lookbackDays    = Math.max(7, Math.min(720, Number(opts.lookbackDays) || DEFAULTS.lookbackDays));
  const minCellObs      = Math.max(1, Math.min(1000, Number(opts.minCellObs) || DEFAULTS.minCellObs));
  const divergenceTh    = Math.max(0.01, Math.min(1, Number(opts.divergenceThreshold) || DEFAULTS.divergenceThreshold));
  const topDivergentCap = Math.max(1, Math.min(500, Number(opts.topDivergentCells) || DEFAULTS.topDivergentCells));
  const maxTrades       = Math.max(10, Math.min(20000, Number(opts.maxTrades) || DEFAULTS.maxTrades));
  const includeDuring   = opts.includeDuring !== false;

  const sinceMs = Date.now() - lookbackDays * 86400000;

  // 1) Load closed trades with their cell sequences.
  let trajectories;
  try {
    const res = await db.prepare(
      `SELECT trade_id, outcome, cell_pre_json, cell_during_json
       FROM trade_trajectories
       WHERE outcome IN ('WIN','LOSS','FLAT') AND entry_ts >= ?1
       ORDER BY entry_ts DESC
       LIMIT ?2`,
    ).bind(sinceMs, maxTrades).all();
    trajectories = res?.results || [];
  } catch (err) {
    return { ok: false, error: String(err?.message || err).slice(0, 300), elapsed_ms: Date.now() - t0 };
  }

  if (trajectories.length === 0) {
    return {
      ok: true,
      window: { since_ms: sinceMs, until_ms: Date.now() },
      config: { lookback_days: lookbackDays, min_cell_obs: minCellObs, divergence_threshold: divergenceTh },
      counts: { trades_scanned: 0, transitions_observed: 0 },
      win_chain: {}, lose_chain: {}, cell_volume: {}, divergent_cells: [],
      noise_cells_count: 0,
      elapsed_ms: Date.now() - t0,
    };
  }

  // 2) Accumulate transition counts per outcome.
  // Maps: from → Map(to → count). Two chains: win + lose.
  const winChain = new Map();
  const loseChain = new Map();
  const cellVolume = new Map(); // cell → { n_win, n_lose }
  let observations = 0;
  let wins = 0, losses = 0;

  for (const t of trajectories) {
    const outcome = String(t.outcome || "").toUpperCase();
    if (outcome !== "WIN" && outcome !== "LOSS") continue;
    if (outcome === "WIN") wins += 1; else losses += 1;

    const chain = outcome === "WIN" ? winChain : loseChain;
    const volKey = outcome === "WIN" ? "n_win" : "n_lose";

    // Combine pre + during for the full trajectory through cells.
    let seq = [];
    try { seq = seq.concat(JSON.parse(t.cell_pre_json || "[]")); } catch {}
    if (includeDuring) {
      try { seq = seq.concat(JSON.parse(t.cell_during_json || "[]")); } catch {}
    }

    // Strip nulls (missing buckets) but preserve order — we only count
    // transitions between observed cells.
    const cleanSeq = seq.filter(c => typeof c === "string" && c.length > 0);

    // Strip the +flag overlay so we operate on the base 640-cell key.
    // This makes the Markov chain workable — flagged variants would
    // explode the state space and dilute sample sizes.
    const baseSeq = cleanSeq.map(c => c.includes("+") ? c.split("+")[0] : c);

    for (let i = 0; i < baseSeq.length; i++) {
      const cell = baseSeq[i];
      let v = cellVolume.get(cell);
      if (!v) { v = { n_win: 0, n_lose: 0 }; cellVolume.set(cell, v); }
      v[volKey] += 1;
    }

    for (let i = 0; i < baseSeq.length - 1; i++) {
      const from = baseSeq[i], to = baseSeq[i + 1];
      if (from === to) continue;  // count actual transitions, not dwell
      let m = chain.get(from);
      if (!m) { m = new Map(); chain.set(from, m); }
      m.set(to, (m.get(to) || 0) + 1);
      observations += 1;
    }
  }

  // 3) Format chains with probabilities.
  function chainToObj(chain) {
    const out = {};
    for (const [from, toMap] of chain.entries()) {
      let total = 0;
      for (const v of toMap.values()) total += v;
      out[from] = {};
      for (const [to, n] of toMap.entries()) {
        out[from][to] = { n, p: total > 0 ? Number((n / total).toFixed(4)) : 0 };
      }
    }
    return out;
  }

  const winChainObj = chainToObj(winChain);
  const loseChainObj = chainToObj(loseChain);

  // 4) Identify divergent cells. For each cell that appears in BOTH chains
  // with enough volume, find the to-transitions where |p_win - p_lose|
  // exceeds the threshold.
  const cellVolumeObj = {};
  for (const [cell, v] of cellVolume.entries()) {
    cellVolumeObj[cell] = { ...v, total: v.n_win + v.n_lose };
  }

  const divergent = [];
  let noiseCells = 0;
  const fromCells = new Set([...winChain.keys(), ...loseChain.keys()]);
  for (const from of fromCells) {
    const vol = cellVolume.get(from);
    if (!vol || (vol.n_win + vol.n_lose) < minCellObs) continue;
    const winOuts = winChainObj[from] || {};
    const loseOuts = loseChainObj[from] || {};
    const allTos = new Set([...Object.keys(winOuts), ...Object.keys(loseOuts)]);

    const transitions = [];
    let maxDelta = 0;
    for (const to of allTos) {
      const pWin = winOuts[to]?.p || 0;
      const pLose = loseOuts[to]?.p || 0;
      const delta = pWin - pLose;
      const absDelta = Math.abs(delta);
      if (absDelta > maxDelta) maxDelta = absDelta;
      if (absDelta >= divergenceTh) {
        transitions.push({
          to,
          p_win: Number(pWin.toFixed(4)),
          p_lose: Number(pLose.toFixed(4)),
          delta: Number(delta.toFixed(4)),    // positive = winners go here more often
          n_win: winOuts[to]?.n || 0,
          n_lose: loseOuts[to]?.n || 0,
        });
      }
    }

    if (transitions.length === 0) {
      noiseCells += 1;
      continue;
    }
    transitions.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    divergent.push({
      cell: from,
      n_win: vol.n_win,
      n_lose: vol.n_lose,
      max_abs_delta: Number(maxDelta.toFixed(4)),
      top_transitions: transitions.slice(0, 5),
    });
  }
  divergent.sort((a, b) => b.max_abs_delta - a.max_abs_delta);

  return {
    ok: true,
    window: { since_ms: sinceMs, until_ms: Date.now() },
    config: {
      lookback_days: lookbackDays,
      min_cell_obs: minCellObs,
      divergence_threshold: divergenceTh,
      include_during: includeDuring,
    },
    counts: {
      trades_scanned: trajectories.length,
      wins,
      losses,
      transitions_observed: observations,
      distinct_from_cells: fromCells.size,
      distinct_cells: cellVolume.size,
    },
    win_chain: winChainObj,
    lose_chain: loseChainObj,
    cell_volume: cellVolumeObj,
    divergent_cells: divergent.slice(0, topDivergentCap),
    noise_cells_count: noiseCells,
    elapsed_ms: Date.now() - t0,
  };
}
