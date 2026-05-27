// worker/lib/regime-markov.js
//
// Markov regime transition matrix over the 4 HTF/LTF quadrant states
// produced by the scoring engine. Sourced from trail_5m_facts.state
// (5-minute granularity, 365-day retention as of D1 retention policy
// PR #255). All reads — zero added D1 write cost.
//
// Background: tasks/2026-05-22-markov-framework.md and the article
// "How To Use Markov Chains To Win Every Single Trade" (Roan, 2026-05-13).
// Tier 1.1, 1.2, 4.7, 4.8 of the framework live in this module:
//
//   1.1 buildTransitionMatrix()      — counts -> probabilities
//   1.2 nStepForecast()              — Chapman–Kolmogorov via matrixPower()
//   4.7 detectSuspiciousTransitions()— flag impossible 2-cell jumps
//   4.8 MIN_TRANSITIONS_PER_CELL     — minimum obs guard
//
// Tier 1.3 (stationary distribution) and Tier 2.5 (mean dwell) are
// also implemented here because they're trivial follow-on math from
// the same data — Phase B will wire them into the chop haircut.

// ─────────────────────────────────────────────────────────────────────
// State space — single source of truth
// ─────────────────────────────────────────────────────────────────────
//
// These are the four strings classifyState() in worker/indicators.js
// emits (line ~2178). Mutually exclusive, collectively exhaustive,
// keyed by sign of (htfScore, ltfScore). The Pine mirror in
// tradingview/TimedTrading_ScoreEngine.pine line ~387 uses the same
// labels.
export const REGIME_STATES = Object.freeze([
  "HTF_BULL_LTF_BULL",
  "HTF_BULL_LTF_PULLBACK",
  "HTF_BEAR_LTF_BEAR",
  "HTF_BEAR_LTF_PULLBACK",
]);

const N_STATES = REGIME_STATES.length;
const STATE_IDX = Object.freeze(REGIME_STATES.reduce((m, s, i) => { m[s] = i; return m; }, {}));

// Article §5 — "Always check that every cell in your transition matrix
// has been estimated from at least 20 to 30 observed transitions. If
// not, consider merging states or extending your data history."
// We default to 20; if the universe-wide aggregate has fewer it falls
// back to the uniform-prior baseline.
export const MIN_TRANSITIONS_PER_CELL = 20;

// Article §5 — "Time homogeneity is violated… The probability of a bull
// regime transitioning to bear was very different in 2008 than in 2021."
// Rolling-window estimation. 90 days = ~63 trading days × 78 RTH 5-min
// buckets = ~5K observations per ticker, ample for the 4×4 matrix.
export const DEFAULT_WINDOW_DAYS = 90;

// Article §3 — "the stationary distribution is the long-run baseline."
// Power-iteration convergence parameters.
const STATIONARY_TOL = 1e-9;
const STATIONARY_MAX_ITER = 500;

// Tier 4.7 — physical/structural impossibility heuristic.
// In our 2x2 HTF/LTF state space, a "direct flip" is when BOTH the
// HTF axis AND the LTF axis flip in the same 5-min bucket:
//   HTF_BULL_LTF_BULL → HTF_BEAR_LTF_BEAR
//   HTF_BULL_LTF_PULLBACK → HTF_BEAR_LTF_PULLBACK   (HTF flips, LTF flips)
// These shouldn't be common — HTF is by construction the slower axis.
// We flag them in the diagnostic output so an operator can see if data
// looks weird (e.g. a state-classifier bug or bad ingest).
const HTF_AXIS = { HTF_BULL_LTF_BULL: "BULL", HTF_BULL_LTF_PULLBACK: "BULL", HTF_BEAR_LTF_BEAR: "BEAR", HTF_BEAR_LTF_PULLBACK: "BEAR" };
const LTF_AXIS = { HTF_BULL_LTF_BULL: "BULL", HTF_BULL_LTF_PULLBACK: "PULL", HTF_BEAR_LTF_BEAR: "BEAR", HTF_BEAR_LTF_PULLBACK: "PULL" };

function _isDoubleFlip(from, to) {
  if (from === to) return false;
  return HTF_AXIS[from] !== HTF_AXIS[to] && LTF_AXIS[from] !== LTF_AXIS[to];
}

// ─────────────────────────────────────────────────────────────────────
// 2026-05-27 (PR #311 — improvement 2): Expanded state space.
// ─────────────────────────────────────────────────────────────────────
//
// The 4-quadrant state space (HTF_BULL_LTF_BULL etc.) is coarse: a
// stock in a strong HTF_BULL trend MID-move behaves very differently
// from one EARLY (just barely past trigger) or LATE (at completion).
// By splitting each quadrant into 3 completion-bands (EARLY / MID /
// LATE) we get 12 states total, capturing where in the move a ticker
// sits.
//
// Completion bands:
//   EARLY   completion <  30%
//   MID     30% ≤ completion ≤ 70%
//   LATE    completion >  70%
//
// State naming: `<original_state>_<band>` so the expansion is
// reversible (strip suffix → base quadrant). Backwards-compatible:
// the 4-state matrix is still built + persisted alongside the 12-state
// version. Consumers opt-in by reading `regime_forecast.expanded`
// (the new payload field).
export const COMPLETION_BANDS = Object.freeze([
  { key: "EARLY", min: 0,  max: 30 },
  { key: "MID",   min: 30, max: 70 },
  { key: "LATE",  min: 70, max: Infinity },
]);

export const EXPANDED_REGIME_STATES = Object.freeze(
  REGIME_STATES.flatMap((base) => COMPLETION_BANDS.map((b) => `${base}_${b.key}`)),
);

const EXPANDED_STATE_IDX = Object.freeze(
  EXPANDED_REGIME_STATES.reduce((m, s, i) => { m[s] = i; return m; }, {}),
);

/**
 * completionBandFor — map a numeric completion % into one of the 3 band keys.
 * Defaults to "MID" for missing / non-numeric inputs so unknowns don't
 * disappear from the state count.
 */
export function completionBandFor(completionPct) {
  const c = Number(completionPct);
  if (!Number.isFinite(c)) return "MID";
  if (c < 30) return "EARLY";
  if (c > 70) return "LATE";
  return "MID";
}

/**
 * expandedStateFor — combine base 4-state + completion% → expanded 12-state.
 * Returns null when the base state is invalid (unknown quadrant).
 *
 *   expandedStateFor("HTF_BULL_LTF_BULL", 45)  // → "HTF_BULL_LTF_BULL_MID"
 *   expandedStateFor("HTF_BULL_LTF_BULL", 85)  // → "HTF_BULL_LTF_BULL_LATE"
 */
export function expandedStateFor(baseState, completionPct) {
  const s = String(baseState || "").toUpperCase();
  if (STATE_IDX[s] == null) return null;
  return `${s}_${completionBandFor(completionPct)}`;
}

/**
 * baseStateOf — inverse of expandedStateFor; strip the band suffix.
 *
 *   baseStateOf("HTF_BULL_LTF_BULL_MID")  // → "HTF_BULL_LTF_BULL"
 */
export function baseStateOf(expandedState) {
  const s = String(expandedState || "");
  const m = s.match(/^(.*)_(EARLY|MID|LATE)$/);
  return m ? m[1] : s;
}

// ─────────────────────────────────────────────────────────────────────
// Tier 1.1 — buildTransitionMatrix
// ─────────────────────────────────────────────────────────────────────
//
// Input: array of per-ticker bucket rows, sorted ascending by bucket_ts:
//   [{ ticker, bucket_ts, state }, …]
//
// Output:
//   {
//     P:             [[..]] 4×4 row-stochastic transition matrix
//     counts:        [[..]] 4×4 raw transition counts
//     stationary:    [..]   stationary distribution π (length 4)
//     mean_dwell:    {..}   per-state average run length (in 5-min buckets)
//     dwell_std:     {..}   std of run lengths
//     suspicious:    [..]   sample of double-flip transitions
//     suspicious_pct: number  share of all transitions that are double-flips
//     total_transitions: int
//     low_obs_cells: [..]   cells with count < MIN_TRANSITIONS_PER_CELL
//     observed_states: int  count of distinct states seen (sanity)
//     computed_at:   int    Date.now()
//   }
//
// The matrix gets a Laplace add-one smoothing for any cell with
// observation count below MIN_TRANSITIONS_PER_CELL — keeps the matrix
// row-stochastic in the face of low data while flagging the
// low-confidence cells separately so downstream consumers can refuse
// to act on them.
export function buildTransitionMatrix(buckets, opts = {}) {
  const minObs = Number.isFinite(opts.minObs) ? opts.minObs : MIN_TRANSITIONS_PER_CELL;
  const skipSelfTransitions = !!opts.skipSelfTransitions; // for "dwell-removed" matrix; default false

  const counts = Array.from({ length: N_STATES }, () => new Array(N_STATES).fill(0));
  const suspicious = [];
  let suspiciousCount = 0;
  let total = 0;

  // Group consecutive same-ticker rows
  let prevTicker = null;
  let prevState = null;
  let prevTs = null;
  const dwellRuns = {}; // state -> [runLength, runLength, …]
  let currentRun = 0;

  for (let i = 0; i < buckets.length; i++) {
    const r = buckets[i];
    const t = String(r?.ticker || "").toUpperCase();
    const s = String(r?.state || "").toUpperCase();
    const ts = Number(r?.bucket_ts) || 0;
    if (!t || !s || STATE_IDX[s] == null) {
      // Unknown state — close any run and reset; do not count it.
      if (prevTicker && currentRun > 0 && prevState && STATE_IDX[prevState] != null) {
        (dwellRuns[prevState] || (dwellRuns[prevState] = [])).push(currentRun);
      }
      prevTicker = t || null; prevState = null; prevTs = null; currentRun = 0;
      continue;
    }

    if (t !== prevTicker) {
      // New ticker — close prior ticker's run and start fresh.
      if (prevState && currentRun > 0) {
        (dwellRuns[prevState] || (dwellRuns[prevState] = [])).push(currentRun);
      }
      prevTicker = t; prevState = s; prevTs = ts; currentRun = 1;
      continue;
    }

    // Same ticker, has a prev — record transition. Only count consecutive
    // 5-min buckets (within 10 min). Gaps imply a missing bucket; skipping
    // avoids spurious "double flips" caused by ingest holes.
    const gap = prevTs != null ? ts - prevTs : 0;
    const isConsecutive = gap > 0 && gap <= 12 * 60 * 1000; // 12 min tolerance for one missed bucket
    if (isConsecutive) {
      if (skipSelfTransitions && s === prevState) {
        // don't count; just extend the run
      } else {
        const fi = STATE_IDX[prevState];
        const ti = STATE_IDX[s];
        counts[fi][ti]++;
        total++;
        if (_isDoubleFlip(prevState, s)) {
          suspiciousCount++;
          if (suspicious.length < 50) {
            suspicious.push({ ticker: t, from: prevState, to: s, bucket_ts: ts, gap_ms: gap });
          }
        }
      }
    } else if (prevState && currentRun > 0) {
      // gap broke the run — close it.
      (dwellRuns[prevState] || (dwellRuns[prevState] = [])).push(currentRun);
      currentRun = 0;
    }

    if (s === prevState) {
      currentRun++;
    } else {
      // close the prior run, start a new one of length 1
      if (prevState && currentRun > 0) {
        (dwellRuns[prevState] || (dwellRuns[prevState] = [])).push(currentRun);
      }
      currentRun = 1;
    }
    prevState = s;
    prevTs = ts;
  }
  if (prevState && currentRun > 0) {
    (dwellRuns[prevState] || (dwellRuns[prevState] = [])).push(currentRun);
  }

  // Build P. For cells with count >= minObs use the empirical MLE.
  // For cells with low obs, fall back to a Laplace add-one smoothing
  // so the matrix is still row-stochastic. Mark low-obs cells.
  const P = Array.from({ length: N_STATES }, () => new Array(N_STATES).fill(0));
  const lowObsCells = [];
  for (let i = 0; i < N_STATES; i++) {
    const rowTotal = counts[i].reduce((a, b) => a + b, 0);
    const denom = rowTotal + N_STATES; // Laplace
    for (let j = 0; j < N_STATES; j++) {
      // Always Laplace-smooth so a zero cell doesn't lock out a state.
      P[i][j] = (counts[i][j] + 1) / denom;
      if (counts[i][j] < minObs) {
        lowObsCells.push({ from: REGIME_STATES[i], to: REGIME_STATES[j], count: counts[i][j] });
      }
    }
  }

  const stationary = computeStationary(P);

  // Mean and std of dwell time per state.
  const meanDwell = {};
  const dwellStd = {};
  for (const s of REGIME_STATES) {
    const runs = dwellRuns[s] || [];
    if (runs.length === 0) {
      meanDwell[s] = null;
      dwellStd[s] = null;
      continue;
    }
    const mean = runs.reduce((a, b) => a + b, 0) / runs.length;
    const variance = runs.reduce((a, b) => a + (b - mean) ** 2, 0) / runs.length;
    meanDwell[s] = +mean.toFixed(3);
    dwellStd[s] = +Math.sqrt(variance).toFixed(3);
  }

  return {
    P,
    counts,
    stationary,
    mean_dwell: meanDwell,
    dwell_std: dwellStd,
    suspicious,
    suspicious_pct: total > 0 ? +(suspiciousCount / total * 100).toFixed(3) : 0,
    suspicious_count: suspiciousCount,
    total_transitions: total,
    low_obs_cells: lowObsCells,
    states: REGIME_STATES.slice(),
    min_obs: minObs,
    computed_at: Date.now(),
  };
}

// ─────────────────────────────────────────────────────────────────────
// Tier 1.2 — matrix power + n-step forecast
// ─────────────────────────────────────────────────────────────────────
//
// Article §3 — Chapman–Kolmogorov: P^(n)(i,j) = (P^n)_{ij}.
// Repeated squaring gives O(log n) matrix multiplies.

function matMul(A, B) {
  const n = A.length;
  const m = B[0].length;
  const k = B.length;
  const C = Array.from({ length: n }, () => new Array(m).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      let s = 0;
      for (let l = 0; l < k; l++) s += A[i][l] * B[l][j];
      C[i][j] = s;
    }
  }
  return C;
}

export function matrixPower(P, n) {
  if (!Number.isFinite(n) || n < 0) throw new Error("matrixPower: n must be a non-negative integer");
  const dim = P.length;
  // identity
  let result = Array.from({ length: dim }, (_, i) => Array.from({ length: dim }, (_, j) => i === j ? 1 : 0));
  let base = P.map(r => r.slice());
  let exp = Math.floor(n);
  while (exp > 0) {
    if (exp & 1) result = matMul(result, base);
    exp >>= 1;
    if (exp > 0) base = matMul(base, base);
  }
  return result;
}

/**
 * nStepForecast — Given a current state (string) and a transition matrix
 * P, return the probability vector over states after n bucket transitions.
 *
 * Returns a plain object like:
 *   { HTF_BULL_LTF_BULL: 0.62, HTF_BULL_LTF_PULLBACK: 0.24, ... }
 */
export function nStepForecast(P, currentState, n) {
  const idx = STATE_IDX[String(currentState || "").toUpperCase()];
  if (idx == null) return null;
  const Pn = matrixPower(P, n);
  const out = {};
  for (let j = 0; j < N_STATES; j++) {
    out[REGIME_STATES[j]] = +Pn[idx][j].toFixed(4);
  }
  return out;
}

/**
 * forecastBundle — convenience wrapper used by the scoring path.
 *
 * Short-horizon vectors (1, 5, 20 bars) for intraday trading + LONG-
 * horizon vectors (12, 60, 240 bars) for investor / multi-day context
 * (added 2026-05-27 PR #310 — improvement 4).
 *
 * With 5-min RTH buckets the bar→time mapping is:
 *
 *    INTRADAY:
 *       1 bar   ≈   5 min     ← p_next
 *       5 bars  ≈  25 min     ← p_5_bar
 *      20 bars  ≈ 100 min     ← p_20_bar   (~rest of a 2-hour window)
 *
 *    LONGER HORIZON:
 *      12 bars  ≈  1 hour     ← p_1h        (filled gap between 20-bar
 *                                            and 1-day)
 *      78 bars  ≈  1 RTH day  ← p_1d        (390 RTH min / 5 = 78 bars)
 *     390 bars  ≈  5 RTH days ← p_1w        (one trading week)
 *
 * Cost: matrixPower uses repeated squaring → O(log n) multiplies.
 * For n=390 that's ~9 multiplies of a 4×4 matrix (~600 FLOPs total).
 * Cheap enough to compute every 5-minute scoring tick.
 */
export function forecastBundle(P, currentState) {
  const s = String(currentState || "").toUpperCase();
  if (STATE_IDX[s] == null) return null;
  return {
    state: s,
    // Intraday horizons — short-term setup quality
    p_next:   nStepForecast(P, s, 1),
    p_5_bar:  nStepForecast(P, s, 5),
    p_20_bar: nStepForecast(P, s, 20),
    // Longer horizons — multi-day investor context (PR #310)
    p_1h:     nStepForecast(P, s, 12),
    p_1d:     nStepForecast(P, s, 78),
    p_1w:     nStepForecast(P, s, 390),
  };
}

// ─────────────────────────────────────────────────────────────────────
// Stationary distribution (used here, exposed for Phase B)
// ─────────────────────────────────────────────────────────────────────
//
// Article §3 — π = π · P, computed via power iteration. Start from the
// uniform vector; iterate until L1 change < tol or MAX_ITER.

export function computeStationary(P) {
  const n = P.length;
  let pi = new Array(n).fill(1 / n);
  for (let iter = 0; iter < STATIONARY_MAX_ITER; iter++) {
    const next = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        next[j] += pi[i] * P[i][j];
      }
    }
    // Normalize (defensive — should already be row-stochastic).
    const sum = next.reduce((a, b) => a + b, 0);
    if (sum > 0) for (let k = 0; k < n; k++) next[k] /= sum;
    let delta = 0;
    for (let k = 0; k < n; k++) delta += Math.abs(next[k] - pi[k]);
    pi = next;
    if (delta < STATIONARY_TOL) break;
  }
  const out = {};
  for (let i = 0; i < n; i++) out[REGIME_STATES[i]] = +pi[i].toFixed(4);
  return out;
}

// ─────────────────────────────────────────────────────────────────────
// Helper — sanity-check a candidate live transition
// ─────────────────────────────────────────────────────────────────────
//
// Tier 4.7 — operator-facing helper. Given a (prev_state, new_state)
// pair, classifies the transition as one of:
//   "normal"        — same-axis or single-axis change
//   "double_flip"   — both HTF and LTF axes flipped in the same bucket
//   "self"          — no transition
//   "unknown"       — one or both states not recognized
// The compute path uses this to count suspicious transitions in
// detectSuspiciousTransitions(). Downstream (ingest pipeline) can use
// it on the live stream to log when a double-flip arrives — usually
// indicates either a flash event, a stale-data race, or a state-
// classifier bug. We log only; we don't reject the data.
export function classifyTransition(prev, next) {
  const p = String(prev || "").toUpperCase();
  const n = String(next || "").toUpperCase();
  if (!p || !n) return "unknown";
  if (STATE_IDX[p] == null || STATE_IDX[n] == null) return "unknown";
  if (p === n) return "self";
  return _isDoubleFlip(p, n) ? "double_flip" : "normal";
}

// Quick at-a-glance summary string for logs/UI.
export function summarizeMatrix(report) {
  if (!report || !report.P) return "(no matrix)";
  const rows = REGIME_STATES.map((s, i) => {
    const top = REGIME_STATES
      .map((to, j) => ({ to, p: report.P[i][j] }))
      .sort((a, b) => b.p - a.p)[0];
    return `${s} -> ${top.to} ${(top.p * 100).toFixed(1)}%`;
  });
  return rows.join(" | ");
}

// ═══════════════════════════════════════════════════════════════════════
// 2026-05-27 (PR #311 — improvement 2): Expanded state space — 12-state
// matrix builder + forecast helpers.
// ═══════════════════════════════════════════════════════════════════════
//
// Same math as the 4-state buildTransitionMatrix above. Difference:
// each input bucket is mapped to a 12-state key (quadrant × completion-
// band) before the counts are tallied. The resulting matrix is 12×12.
//
// Why a separate function instead of parameterizing buildTransitionMatrix:
// avoids invasive refactoring of a 200-line function. The matrix-builder
// math is small enough to clone with the constants swapped.

const EXPANDED_N_STATES = EXPANDED_REGIME_STATES.length;

// Looser min-obs for the expanded matrix — 144 cells instead of 16
// means each cell will have ~9× fewer observations. The article's
// "20 per cell" is a heuristic; for the expanded matrix we accept 8.
export const EXPANDED_MIN_TRANSITIONS_PER_CELL = 8;

/**
 * buildExpandedTransitionMatrix
 *
 * Input: same shape as buildTransitionMatrix, but each bucket MUST
 * include a `completion` field (number, 0-100 percentage) used to
 * decide the band.
 *
 *   [{ ticker, bucket_ts, state, completion }, …]
 *
 * Returns: same shape as buildTransitionMatrix output but with
 *   states = EXPANDED_REGIME_STATES (length 12) and matrix shape 12×12.
 */
export function buildExpandedTransitionMatrix(buckets, opts = {}) {
  const minObs = Number.isFinite(opts.minObs) ? opts.minObs : EXPANDED_MIN_TRANSITIONS_PER_CELL;

  const counts = Array.from({ length: EXPANDED_N_STATES }, () => new Array(EXPANDED_N_STATES).fill(0));
  let total = 0;

  let prevTicker = null;
  let prevExpanded = null;
  let prevTs = null;

  for (let i = 0; i < buckets.length; i++) {
    const r = buckets[i];
    const t = String(r?.ticker || "").toUpperCase();
    const baseState = String(r?.state || "").toUpperCase();
    const expanded = expandedStateFor(baseState, r?.completion);
    const ts = Number(r?.bucket_ts) || 0;

    if (!t || !expanded || EXPANDED_STATE_IDX[expanded] == null) {
      prevTicker = t || null; prevExpanded = null; prevTs = null;
      continue;
    }

    if (t !== prevTicker) {
      prevTicker = t; prevExpanded = expanded; prevTs = ts;
      continue;
    }

    const gap = prevTs != null ? ts - prevTs : 0;
    // Same 12-minute consecutive-bucket gate as the 4-state matrix —
    // drops session-boundary transitions.
    if (gap > 0 && gap <= 12 * 60 * 1000 && prevExpanded) {
      const fi = EXPANDED_STATE_IDX[prevExpanded];
      const ti = EXPANDED_STATE_IDX[expanded];
      counts[fi][ti]++;
      total++;
    }
    prevExpanded = expanded;
    prevTs = ts;
  }

  // Build P with Laplace add-one smoothing for low-obs cells.
  const P = Array.from({ length: EXPANDED_N_STATES }, () => new Array(EXPANDED_N_STATES).fill(0));
  const lowObsCells = [];
  for (let i = 0; i < EXPANDED_N_STATES; i++) {
    const rowTotal = counts[i].reduce((a, b) => a + b, 0);
    const denom = rowTotal + EXPANDED_N_STATES;
    for (let j = 0; j < EXPANDED_N_STATES; j++) {
      P[i][j] = (counts[i][j] + 1) / denom;
      if (counts[i][j] < minObs) {
        lowObsCells.push({ from: EXPANDED_REGIME_STATES[i], to: EXPANDED_REGIME_STATES[j], count: counts[i][j] });
      }
    }
  }

  return {
    P,
    counts,
    states: EXPANDED_REGIME_STATES.slice(),
    total_transitions: total,
    low_obs_cells: lowObsCells,
    min_obs: minObs,
    n_states: EXPANDED_N_STATES,
    computed_at: Date.now(),
  };
}

/**
 * expandedForecastBundle — Chapman-Kolmogorov over the 12-state matrix.
 *
 * Returns n-step distributions for the same horizons as forecastBundle(),
 * but rolled UP to the base 4-state space so the UI consumer doesn't
 * need to know about EARLY/MID/LATE. The collapsed view sums over the
 * 3 bands per quadrant.
 *
 * Also returns the raw expanded vectors under `_expanded` for callers
 * who want the full 12-state distribution (e.g. an "early-bull
 * 67% chance" indicator).
 */
export function expandedForecastBundle(P, currentExpandedState) {
  const s = String(currentExpandedState || "").toUpperCase();
  if (EXPANDED_STATE_IDX[s] == null) return null;

  const horizons = { p_next: 1, p_5_bar: 5, p_20_bar: 20 };
  const out = {
    state: s,
    base_state: baseStateOf(s),
    band: s.match(/_(EARLY|MID|LATE)$/)?.[1] || "MID",
    _expanded: {},
  };

  // Helper: collapse a 12-state vector down to the 4 base quadrants.
  const collapseTo4 = (vec) => {
    const out4 = {};
    for (const s of REGIME_STATES) out4[s] = 0;
    for (const exp of EXPANDED_REGIME_STATES) {
      const base = baseStateOf(exp);
      out4[base] += vec[exp] || 0;
    }
    return out4;
  };

  for (const [field, n] of Object.entries(horizons)) {
    const Pn = matrixPower(P, n);
    const i = EXPANDED_STATE_IDX[s];
    const dist = {};
    for (let j = 0; j < EXPANDED_N_STATES; j++) {
      dist[EXPANDED_REGIME_STATES[j]] = Pn[i][j];
    }
    out._expanded[field] = dist;
    out[field] = collapseTo4(dist);
  }
  return out;
}
