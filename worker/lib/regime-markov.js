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

// 2026-05-27 (PR #308 — Markov hardening, improvement 1):
// Session-boundary handling. Transitions across time gaps wider than
// this are dropped (treated as "no transition observed"). Prevents
// the matrix from learning bogus "Friday 4 PM HTF_BULL → Monday 9:35
// HTF_BEAR" as a 5-minute transition. Defaults to 12 minutes so a
// single missed bucket (cron skip, brief outage) still counts as one
// transition while a multi-hour gap does not.
export const DEFAULT_MAX_GAP_MS = 12 * 60 * 1000;

// 2026-05-27 (PR #308 — Markov hardening, improvement 5):
// Recency decay. Each observed transition gets a weight of
//   exp(-ln(2) × age_in_days / half_life_days)
// so a transition observed 30 days ago counts half as much as one
// observed today (with the default half-life of 30 days). Counts are
// no longer integers but fractional "effective observations" — same
// matrix shape and read path. Pass `null` to disable (back to
// uniform weighting) for backtests or sanity checks.
export const DEFAULT_DECAY_HALF_LIFE_DAYS = 30;
const LN_2 = Math.log(2);

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

  // 2026-05-27 (PR #308) — improvements 1 + 5.
  //
  // gapThresholdMs: drop transitions across larger gaps. Was a hardcoded
  // 12 min on line 144; now configurable via opts.maxGapMs so backtests
  // / replays can opt out (set to Infinity) and so the constant is named.
  const gapThresholdMs = Number.isFinite(opts.maxGapMs) ? opts.maxGapMs : DEFAULT_MAX_GAP_MS;
  // decayHalfLifeDays: weight observations by exp(-ln(2)·age/halfLife).
  // Default 30d so a 30-day-old transition counts half, 60-day half-of-
  // half, etc. Set to null/undefined-via-explicit-false-positive to disable.
  const decayHalfLifeDays = opts.decayHalfLifeDays === null
    ? null
    : (Number.isFinite(opts.decayHalfLifeDays) ? opts.decayHalfLifeDays : DEFAULT_DECAY_HALF_LIFE_DAYS);
  // nowMs: anchor for the decay calculation. Defaults to Date.now() so
  // tests can pin a value for determinism.
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();

  // counts is now FRACTIONAL — recency weights add fractional contributions.
  const counts = Array.from({ length: N_STATES }, () => new Array(N_STATES).fill(0));
  // rawCounts keeps the integer count for observability (and the
  // low-obs gate uses RAW counts, not the weighted ones — the article's
  // "20 observations" guidance is about real data presence, not weight).
  const rawCounts = Array.from({ length: N_STATES }, () => new Array(N_STATES).fill(0));
  const suspicious = [];
  let suspiciousCount = 0;
  let total = 0;
  // 2026-05-27 (PR #308, improvement 1): track transitions dropped due
  // to session-boundary gaps (>gapThresholdMs). Exposed in output for
  // operator visibility; a sudden spike means tickers stopped scoring.
  let droppedGapTransitions = 0;
  let maxObservedGapMs = 0;
  let sumWeights = 0; // sum of all applied recency weights — for diagnostics

  // Group consecutive same-ticker rows
  let prevTicker = null;
  let prevState = null;
  let prevTs = null;
  const dwellRuns = {}; // state -> [runLength, runLength, …]
  let currentRun = 0;

  // Weight calculator. exp(-λ·age_days), λ = ln(2) / halfLife.
  // Returns 1.0 when decay is disabled, when bucket is in the future,
  // or when bucket is from "right now" (age <= 0).
  const weightForTs = (ts) => {
    if (decayHalfLifeDays == null || !Number.isFinite(decayHalfLifeDays) || decayHalfLifeDays <= 0) return 1;
    const ageDays = Math.max(0, (nowMs - ts) / 86400000);
    return Math.exp(-LN_2 * ageDays / decayHalfLifeDays);
  };

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
    // buckets (gap <= gapThresholdMs). Larger gaps almost always mean a
    // session boundary (Fri 4 PM → Mon 9:35 AM = 65h) or a multi-day
    // outage and learning them as "5-min transitions" biases the matrix.
    const gap = prevTs != null ? ts - prevTs : 0;
    if (gap > maxObservedGapMs) maxObservedGapMs = gap;
    const isConsecutive = gap > 0 && gap <= gapThresholdMs;
    if (isConsecutive) {
      if (skipSelfTransitions && s === prevState) {
        // don't count; just extend the run
      } else {
        const fi = STATE_IDX[prevState];
        const ti = STATE_IDX[s];
        const w = weightForTs(ts);
        counts[fi][ti] += w;
        rawCounts[fi][ti] += 1;
        sumWeights += w;
        total++;
        if (_isDoubleFlip(prevState, s)) {
          suspiciousCount++;
          if (suspicious.length < 50) {
            suspicious.push({ ticker: t, from: prevState, to: s, bucket_ts: ts, gap_ms: gap });
          }
        }
      }
    } else if (prevState && currentRun > 0) {
      // gap broke the run — close it. Count gaps that look session-boundary-y
      // so operators can see how many were excluded (helpful when investigating
      // a sudden change in matrix shape).
      if (gap > gapThresholdMs) droppedGapTransitions++;
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

  // Build P. Use the FRACTIONAL (recency-weighted) counts for the
  // probability MLE — recent transitions matter more. The low-obs gate
  // uses RAW counts, not the weighted ones — the article's "20
  // observations" guidance is about real data presence (Are we actually
  // measuring this transition? — yes/no), not statistical weight.
  const P = Array.from({ length: N_STATES }, () => new Array(N_STATES).fill(0));
  const lowObsCells = [];
  for (let i = 0; i < N_STATES; i++) {
    const rowTotal = counts[i].reduce((a, b) => a + b, 0);
    // Laplace prior: +1 effective observation per cell. Matches the
    // pre-decay behavior — a row with zero observations still produces
    // a uniform row, never NaN.
    const denom = rowTotal + N_STATES;
    for (let j = 0; j < N_STATES; j++) {
      P[i][j] = (counts[i][j] + 1) / denom;
      if (rawCounts[i][j] < minObs) {
        lowObsCells.push({ from: REGIME_STATES[i], to: REGIME_STATES[j], count: rawCounts[i][j] });
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

  // Round the fractional counts for the serialized output — keeps the
  // KV payload size identical to pre-PR-308 while preserving fractional
  // precision in the MLE itself.
  const countsRounded = counts.map((row) => row.map((v) => +v.toFixed(3)));

  return {
    P,
    // Keep the legacy `counts` field as the RAW integer counts for
    // back-compat with downstream readers that interpret it as
    // observation count. The decay-weighted version is exposed
    // separately as effective_counts.
    counts: rawCounts,
    effective_counts: countsRounded,
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
    // 2026-05-27 (PR #308) — new diagnostics
    config: {
      gap_threshold_ms: gapThresholdMs,
      decay_half_life_days: decayHalfLifeDays,
    },
    dropped_gap_transitions: droppedGapTransitions,
    max_observed_gap_ms: maxObservedGapMs,
    // Avg effective weight = sumWeights / total. < 0.5 means most
    // transitions are old; ~1.0 means most are recent.
    avg_effective_weight: total > 0 ? +(sumWeights / total).toFixed(4) : null,
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
 * Returns the 1-step, 5-step, and 20-step forecast vectors from the
 * current state. With 5-min buckets that's roughly "next bar", "next
 * 25 min", and "next 100 min". Cheap (3 matrix powers; with N=4 each
 * multiply is 64 mults).
 */
export function forecastBundle(P, currentState) {
  const s = String(currentState || "").toUpperCase();
  if (STATE_IDX[s] == null) return null;
  return {
    p_next:   nStepForecast(P, s, 1),
    p_5_bar:  nStepForecast(P, s, 5),
    p_20_bar: nStepForecast(P, s, 20),
    state: s,
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
