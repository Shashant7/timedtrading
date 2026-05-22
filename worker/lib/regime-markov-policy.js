// worker/lib/regime-markov-policy.js
//
// Phase B of the Markov framework — converts the matrix produced in
// Phase A (worker/lib/regime-markov.js) into specific trading decisions:
//
//   Tier 1.3  adaptChopHaircut()              — scale chop size haircut by
//                                                stationary + dwell context
//   Tier 2.4  computeRegimeFavorMultiplier()  — position sizing multiplier
//                                                derived from forecast vs.
//                                                stationary baseline
//   Tier 2.5  computeDwellExhaustion()        — flag when the current state
//                                                has dwelled longer than its
//                                                long-run typical run length
//
// All three are PURE functions: same inputs → same outputs, no side
// effects, no async. They get called from index.js with feature-flag
// gating (model_config) so each can be enabled / tuned / disabled at
// runtime without a redeploy.
//
// Reference: the article "How To Use Markov Chains To Win Every Single
// Trade" by Roan (Tier 1.3 + 2.4 + 2.5 of the breakdown in our
// 2026-05-22 conversation).

// ────────────────────────────────────────────────────────────────────
// Bounded clamps — never let one signal blow up risk
// ────────────────────────────────────────────────────────────────────
const REGIME_FAVOR_MIN = 0.5;   // never less than 50% of nominal size
const REGIME_FAVOR_MAX = 1.5;   // never more than 150% of nominal size
const CHOP_HAIRCUT_MIN = 0.25;  // never less than 25% of nominal size
const CHOP_HAIRCUT_MAX = 1.0;   // 1.0 = no haircut applied
const DWELL_EXHAUSTION_DEFAULT_SIGMA = 2.0; // run > mean + 2σ -> exhausted

// Each state belongs to one of the four quadrants; we use these helpers
// to find the "favorable" continuation state for a given direction.
const FAVOR_FOR_DIR = {
  LONG: "HTF_BULL_LTF_BULL",
  SHORT: "HTF_BEAR_LTF_BEAR",
};

function _num(v, fb) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fb;
}

// ────────────────────────────────────────────────────────────────────
// Tier 1.3 — Adaptive chop haircut
// ────────────────────────────────────────────────────────────────────
//
// Today the chop haircut is binary: when regime_class === "CHOPPY" and
// the feature flag is on, multiply size by a fixed factor (default
// 0.5). That's clearly a starting heuristic — the article points out
// that the stationary distribution + mean dwell time together tell
// you HOW MUCH of a tail risk you're really taking on by trading into
// chop.
//
// The adaptive haircut layers two refinements onto the base factor:
//
//   1. If the chop state is over-represented in the stationary
//      distribution (we're stuck in a market that lives in chop a
//      lot), tighten the haircut further — chop is structural, not
//      transient.
//   2. If the current run length in the chop state has exceeded its
//      long-run mean dwell + 1σ (we've been stuck in THIS instance
//      of chop longer than usual), tighten further — a transition is
//      statistically overdue.
//   3. If the forecast says next 5 bars are mostly EXITING chop, RELAX
//      the haircut (the model says we'll be out soon — don't haircut
//      ourselves out of the entry).
//
// All adjustments are bounded; the worst-case haircut is CHOP_HAIRCUT_MIN
// (0.25x); the best-case relaxation never exceeds the baseline.
//
// Inputs:
//   baseFactor        - the operator-configured chop size haircut (e.g. 0.5)
//   currentState      - the ticker's current state string ("HTF_..._...")
//   forecast          - regime_forecast bundle from regime-markov.js
//                       (or null if the matrix isn't available yet)
//   stationary        - matrix.stationary { state -> π }
//   runLength         - bars in current run (5-min buckets)
//   meanDwell, dwellStd - per-state mean / std of dwell time
//
// Output (object):
//   factor            - effective multiplier (clamped)
//   baseFactor        - the input baseFactor (for audit)
//   reasons           - array of strings describing each adjustment
//   stationary_overrep - boolean
//   dwell_overrun      - boolean
//   forecast_exit_p    - 0..1 probability of leaving current state in 5 bars
export function adaptChopHaircut({
  baseFactor,
  currentState,
  forecast,
  stationary,
  runLength,
  meanDwell,
  dwellStd,
}) {
  const reasons = [];
  let factor = _num(baseFactor, 0.5);
  factor = Math.max(CHOP_HAIRCUT_MIN, Math.min(CHOP_HAIRCUT_MAX, factor));

  // (1) Stationary over-representation. If π(current) > 0.30, the market
  // structurally lives in this state — tighten the haircut by 25%
  // (e.g. 0.5 -> 0.375).
  const piCurrent = stationary && currentState ? _num(stationary[currentState], 0) : 0;
  const stationaryOverrep = piCurrent > 0.30;
  if (stationaryOverrep) {
    factor *= 0.75;
    reasons.push(`stationary_overrep(π=${piCurrent.toFixed(2)})`);
  }

  // (2) Dwell overrun. If runLength > mean + 1σ, we've been stuck longer
  // than typical — chop is overdue to break. Tighten 20% (entry less
  // attractive into a stale state).
  const md = meanDwell && currentState ? _num(meanDwell[currentState], NaN) : NaN;
  const sd = dwellStd && currentState ? _num(dwellStd[currentState], NaN) : NaN;
  const rl = _num(runLength, 0);
  let dwellOverrun = false;
  if (Number.isFinite(md) && Number.isFinite(sd) && rl > 0) {
    if (rl > md + sd) {
      dwellOverrun = true;
      factor *= 0.80;
      reasons.push(`dwell_overrun(run=${rl}, mean=${md.toFixed(1)})`);
    }
  }

  // (3) Forecast says we're EXITING chop soon. If P(stay in current
  // state) < 0.40 over the next 5 bars, RELAX the haircut by 15%
  // (cap at the baseline). The model thinks we'll be out of chop;
  // don't punish the trade.
  let exitP = null;
  if (forecast && currentState) {
    const p5 = forecast.p_5_bar || {};
    const pStay = _num(p5[currentState], NaN);
    if (Number.isFinite(pStay)) {
      exitP = +(1 - pStay).toFixed(3);
      if (pStay < 0.40) {
        factor = Math.min(baseFactor, factor * 1.15);
        reasons.push(`forecast_exit(p_stay=${pStay.toFixed(2)})`);
      }
    }
  }

  factor = Math.max(CHOP_HAIRCUT_MIN, Math.min(CHOP_HAIRCUT_MAX, factor));
  return {
    factor: +factor.toFixed(3),
    baseFactor: _num(baseFactor, 0.5),
    reasons,
    stationary_overrep: stationaryOverrep,
    dwell_overrun: dwellOverrun,
    forecast_exit_p: exitP,
  };
}

// ────────────────────────────────────────────────────────────────────
// Tier 2.4 — Probability-vector position sizing
// ────────────────────────────────────────────────────────────────────
//
// Today admission is binary and sizing is fixed-by-tier. The article's
// smarter approach: scale risk by the model's confidence that we'll
// END UP in the favorable state for this trade.
//
// For LONG, "favorable" = HTF_BULL_LTF_BULL.
// For SHORT, "favorable" = HTF_BEAR_LTF_BEAR.
//
// We compute the multiplier as:
//
//     m = P(favorable @ 5 bars ahead) / π(favorable)
//
// where π is the stationary baseline. So:
//   - When the forecast says we're MORE likely than baseline to be in
//     the favorable state in 5 bars, m > 1 — scale up.
//   - When the forecast says we're LESS likely than baseline to be in
//     the favorable state, m < 1 — scale down.
//   - Clamped to [REGIME_FAVOR_MIN, REGIME_FAVOR_MAX] so a single
//     signal can never blow up risk.
//
// Returns:
//   multiplier        - clamped float, defaults to 1.0 when data missing
//   raw_ratio         - the unclamped forecast/baseline ratio (for audit)
//   p_favor_forecast  - the forecast prob of favorable state @ 5 bars
//   p_favor_baseline  - the stationary prob of favorable state
//   favorable_state   - which state we treat as favorable for this direction
//   reasons           - string[] for the admission log
export function computeRegimeFavorMultiplier({ forecast, stationary, direction }) {
  const dir = String(direction || "").toUpperCase();
  const favor = FAVOR_FOR_DIR[dir];
  if (!favor || !forecast || !stationary) {
    return {
      multiplier: 1.0,
      raw_ratio: null,
      p_favor_forecast: null,
      p_favor_baseline: null,
      favorable_state: favor || null,
      reasons: ["insufficient_data"],
    };
  }
  const pForecast = _num((forecast.p_5_bar || {})[favor], NaN);
  const pBaseline = _num(stationary[favor], NaN);
  if (!Number.isFinite(pForecast) || !Number.isFinite(pBaseline) || pBaseline <= 0) {
    return {
      multiplier: 1.0,
      raw_ratio: null,
      p_favor_forecast: Number.isFinite(pForecast) ? pForecast : null,
      p_favor_baseline: Number.isFinite(pBaseline) ? pBaseline : null,
      favorable_state: favor,
      reasons: ["baseline_zero_or_nan"],
    };
  }
  const raw = pForecast / pBaseline;
  const clamped = Math.max(REGIME_FAVOR_MIN, Math.min(REGIME_FAVOR_MAX, raw));
  return {
    multiplier: +clamped.toFixed(3),
    raw_ratio: +raw.toFixed(3),
    p_favor_forecast: +pForecast.toFixed(3),
    p_favor_baseline: +pBaseline.toFixed(3),
    favorable_state: favor,
    reasons: [
      raw >= 1
        ? `forecast_above_baseline(ratio=${raw.toFixed(2)})`
        : `forecast_below_baseline(ratio=${raw.toFixed(2)})`,
    ],
  };
}

// ────────────────────────────────────────────────────────────────────
// Tier 2.5 — Mean-dwell exhaustion gate
// ────────────────────────────────────────────────────────────────────
//
// For a given ticker's CURRENT regime state, compare how long we've
// been in it (run length) to the long-run mean ± std for that state.
// When the run length exceeds mean + sigma × N, the state is statistically
// "exhausted" — a transition is overdue.
//
// This is an ADVISORY signal — the worker writes regime_exhausted=true
// on the payload and the AI CIO / exit doctrine can choose to act on
// it. We never force a trade open or closed based on this alone.
//
// Inputs:
//   currentState      - HTF_..._... string
//   runLength         - bars in current run
//   meanDwell, dwellStd - per-state mean / std from matrix
//   sigmaThreshold    - N (default 2.0)
//
// Output:
//   exhausted         - boolean
//   run_length        - input echo
//   mean_dwell        - input echo
//   dwell_std         - input echo
//   sigma_above_mean  - (run - mean) / std
//   threshold_sigma   - N used
export function computeDwellExhaustion({
  currentState,
  runLength,
  meanDwell,
  dwellStd,
  sigmaThreshold = DWELL_EXHAUSTION_DEFAULT_SIGMA,
}) {
  if (!currentState) return { exhausted: false, reason: "no_state" };
  const md = meanDwell && currentState ? _num(meanDwell[currentState], NaN) : NaN;
  const sd = dwellStd && currentState ? _num(dwellStd[currentState], NaN) : NaN;
  const rl = _num(runLength, 0);
  if (!Number.isFinite(md) || !Number.isFinite(sd) || sd <= 0 || rl <= 0) {
    return { exhausted: false, reason: "insufficient_stats", run_length: rl, mean_dwell: md, dwell_std: sd };
  }
  const sigmaAbove = (rl - md) / sd;
  return {
    exhausted: sigmaAbove >= sigmaThreshold,
    run_length: rl,
    mean_dwell: +md.toFixed(2),
    dwell_std: +sd.toFixed(2),
    sigma_above_mean: +sigmaAbove.toFixed(2),
    threshold_sigma: sigmaThreshold,
  };
}

export const REGIME_POLICY_CONSTANTS = Object.freeze({
  REGIME_FAVOR_MIN,
  REGIME_FAVOR_MAX,
  CHOP_HAIRCUT_MIN,
  CHOP_HAIRCUT_MAX,
  DWELL_EXHAUSTION_DEFAULT_SIGMA,
});
