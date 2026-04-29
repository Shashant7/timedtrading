// worker/pipeline/entry-selector.js
//
// Phase C — Rank-All-Take-Top-N Entry Selection
//
// Pure functions for the candidate buffer + batch commit pattern.
//
// Background: today's engine enters trades greedily as it iterates through
// tickers. When a high-quality candidate gets blocked by a quality filter,
// the freed slot fills with a lower-quality alternative. This is the
// "slot-fill cascade" that defeated FIX 9, FIX 12 V3, and FIX 12 V4.
//
// Phase C eliminates the cascade by:
//   1. Buffering all eligible candidates per bar
//   2. Scoring each with a composite quality score (rank + conviction +
//      divergence + PDZ + TD + personality modifiers)
//   3. Selecting the top N by score (capacity scales with open slots)
//   4. Committing only the winners; rejected candidates re-eligible next bar
//
// All functions in this module are pure: no I/O, no global state, no mutation
// of inputs. This makes them trivially unit-testable and reusable across the
// replay and live execution paths.
//
// See: tasks/phase-c-rank-all-take-top-n-design.md
//      tasks/2026-04-29-cascade-lessons.md

// ───────────────────────────────────────────────────────────────────────────
// Default weights — empirically derived from the 2026-04-29 forensic on
// v16-baseline-ctx (101 trades, 67.3% WR). All weights are DA-keyed and may
// be overridden by env._deepAuditConfig at runtime.
//
// A sensitivity sweep (scripts/phase-c-sensitivity-sweep.py) is mandatory
// before locking in production weights.
// ───────────────────────────────────────────────────────────────────────────
const DEFAULT_WEIGHTS = {
  rank:           1.00,   // primary — already 0..100 normalized
  conviction:     0.50,   // secondary — 0..160 conviction score range
  divergence:     1.00,   // F4-style modifiers (-25..+5)
  pdz:            1.00,   // PDZ stack modifiers (-5..+10)
  td:             1.00,   // TD exhaustion (-10..+5)
  personality:    1.00,   // -5..+5
  rr:             0.00,   // R:R is used as a TIEBREAKER, not a contributor
};

const DEFAULT_CAPACITY = {
  fill_factor:        0.20,   // fraction of remaining open slots per bar
  hard_cap_per_bar:   8,      // never enter more than this in one bar
  hard_cap_per_cycle: 8,      // same for live cron cycle
  quality_score_min:  -20,    // absolute floor; below this = reject
};

// ───────────────────────────────────────────────────────────────────────────
// Modifier helpers — pure functions that read tickerData snapshot fields
// and return a numeric modifier. Sign convention: POSITIVE = bullish for
// the trade direction, NEGATIVE = bearish. The selector flips sign for
// SHORT trades automatically via `directionMultiplier`.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Divergence modifier — based on adverse RSI + adverse phase divergence.
 *
 * Empirical evidence (v16-baseline-ctx 101 trades, 67.3% WR baseline):
 *   - NONE adverse phase div                : 51 trades, 76% WR  ★
 *   - BOTH adv RSI + adv phase active (F4)  :  7 trades, 29% WR  ✗ -17.95% PnL
 *   - adv phase strongest TF in [10m, 30m]  : 17 trades, 53% WR
 *
 * F4 cohort had -17.95% block-PnL on the baseline — pure loser detection.
 * In Phase C, F4 becomes a -25 score penalty (was a binary block in V4).
 */
export function divergenceModifier(div) {
  // null/undefined = "not computed" — return 0 (no info, no signal)
  if (div === null || div === undefined) return 0;
  if (typeof div !== "object") return 0;

  const advRsi = Number((div.adverse_rsi || div.adverseRsi || {}).count) || 0;
  const advPhase = Number((div.adverse_phase || div.adversePhase || {}).count) || 0;
  const advPhaseStrongTf = String(
    ((div.adverse_phase || div.adversePhase || {}).strongest || {}).tf || ""
  ).toLowerCase();

  // F4: BOTH active = severe exhaustion = strongest penalty
  if (advRsi >= 1 && advPhase >= 1) return -25;

  // LTF strongest divergence = late entry into a tiring move
  if (advPhase >= 1 && (advPhaseStrongTf === "10m" || advPhaseStrongTf === "30m")) return -10;

  // Any adverse RSI div alone
  if (advRsi >= 1) return -10;

  // Any adverse phase div alone
  if (advPhase >= 1) return -5;

  // Empty object (computed, no divergence found) = pristine setup
  return +5;
}

/**
 * PDZ (Premium / Equilibrium / Discount) zone modifier.
 *
 * Empirical evidence on LONG entries:
 *   - PDZ_Daily=premium               : 27 trades, 78% WR  ★
 *   - PDZ D+4h both 'premium'         : 14 trades, 93% WR  ★★
 *   - PDZ D='premium_approach'        : 68 trades, 62% WR  (baseline)
 *   - PDZ D='discount_approach' (LONG):  2 trades, 100% WR (small N — cautious)
 *
 * Counter-intuitive: 'premium' is the BEST zone for LONG because it indicates
 * the asset is in a sustained uptrend (price above range midpoint). Buying in
 * 'discount' would be mean-reversion which works less reliably here.
 */
export function pdzModifier(pdz, side) {
  if (!pdz || typeof pdz !== "object") return 0;
  const isLong = String(side || "LONG").toUpperCase() !== "SHORT";
  const dz = String(pdz.D || "").toLowerCase();
  const h4z = String(pdz.h4 || pdz["4H"] || "").toLowerCase();

  // For SHORTS, flip the zone meaning (premium for SHORT = discount for LONG)
  const favorablePremium = isLong ? "premium" : "discount";
  const favorableApproach = isLong ? "premium_approach" : "discount_approach";

  let mod = 0;
  if (dz === favorablePremium && h4z === favorablePremium) mod = +10;          // premium-stack
  else if (dz === favorablePremium) mod = +5;                                  // single TF premium
  else if (dz === favorableApproach && h4z === favorablePremium) mod = +3;     // building stack
  // Approach alone is neutral (62% WR — baseline)
  return mod;
}

/**
 * TD Sequential exhaustion modifier.
 *
 * Empirical evidence on LONG entries:
 *   - TD bear_prep 4h 1-3   : 31 trades, 81% WR  ★ (early HTF strength)
 *   - TD bear_prep D >= 8   : sample of 4, 50% WR (cautious — signals exhaustion)
 *   - TD9_bear fired on D   : explicit reversal warning
 *
 * For LONG, BEAR_PREP is opposite-direction signal (counter-trend pressure
 * building). Low bear_prep = clean uptrend, high bear_prep = topping risk.
 */
export function tdExhaustionModifier(tdSeq, side) {
  if (!tdSeq || typeof tdSeq !== "object") return 0;
  const isLong = String(side || "LONG").toUpperCase() !== "SHORT";
  const dailyTd = tdSeq.D || {};
  const fourhTd = tdSeq["240"] || tdSeq["4H"] || {};

  // For LONG: bear_prep counts against (counter-trend exhaustion)
  // For SHORT: bull_prep counts against
  const adversePrepKey = isLong ? "bear_prep" : "bull_prep";
  const adverseTd9Key = isLong ? "td9_bear" : "td9_bull";

  const dailyAdvPrep = Number(dailyTd[adversePrepKey]) || 0;
  const fourhAdvPrep = Number(fourhTd[adversePrepKey]) || 0;
  const dailyTd9Adv = !!dailyTd[adverseTd9Key];

  let mod = 0;
  if (dailyTd9Adv) return -15; // hard signal — TD9 just fired against us
  if (dailyAdvPrep >= 8) mod -= 10;       // about to TD9 against us
  else if (dailyAdvPrep >= 6) mod -= 5;   // pressure building
  if (fourhAdvPrep >= 1 && fourhAdvPrep <= 3) mod += 5;  // early HTF strength (the 81% WR cohort)
  return mod;
}

/**
 * Ticker personality modifier.
 *
 * Personality categories (from ticker_character.personality):
 *   - VOLATILE_RUNNER : explosive moves (LITE/AVGO/PLTR class). Boost.
 *   - PULLBACK_PLAYER : tradeable pullbacks. Slight penalty (mean-reverting bias).
 *   - MEAN_REVERT     : reverts hard. Penalty for trend trades.
 *   - default/empty   : neutral.
 *
 * Connects to Phase 1 (per-ticker runner protection) — same personality
 * field is used to modulate exit logic.
 */
export function personalityModifier(personality, entryPath) {
  const p = String(personality || "").toUpperCase();
  const path = String(entryPath || "").toLowerCase();
  const isReversalSetup = path.includes("reversal") || path.includes("n_test_resistance");

  if (p === "VOLATILE_RUNNER") return +5;            // boost explosive runners
  if (p === "PULLBACK_PLAYER" && !isReversalSetup) return -3;  // mild penalty for trend setups
  if (p === "MEAN_REVERT" && !isReversalSetup) return -5;      // penalty for trend setups
  if (p === "MEAN_REVERT" && isReversalSetup) return +3;       // mean-revert + reversal setup = good fit
  return 0;
}

// ───────────────────────────────────────────────────────────────────────────
// Quality score — composite of rank, conviction, and the 4 modifiers.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Compute the composite quality score for a candidate.
 *
 * Returns an object with the breakdown so callers (and the
 * phase_c_decisions log) can see WHY a candidate scored what it did.
 *
 * @param {object} tickerData - The full tickerData with score, rank, snapshot,
 *                              divergence, pdz, td_seq, ticker_character, etc.
 * @param {object} weights - Optional override; defaults to DEFAULT_WEIGHTS.
 * @returns {object} { composite, rank, conviction, rr, div_modifier, pdz_modifier, td_modifier, personality_mod, raw }
 */
export function computeQualityScore(tickerData, weights = DEFAULT_WEIGHTS) {
  const w = { ...DEFAULT_WEIGHTS, ...(weights || {}) };

  const t = tickerData || {};
  const snap = t.__entry_setup_snapshot || {};
  const direction = String(t.__entry_direction || t.direction || "LONG").toUpperCase();

  const rank = Number(t.rank ?? t.score) || 0;
  const conviction = Number(t.__focus_conviction_score ?? snap.focus_conviction_score) || 0;
  const rr = Number(t.rr ?? snap.rr) || 0;

  // Divergence: prefer the explicitly-stamped __entry_divergence_summary
  const div = t.__entry_divergence_summary || snap.divergence || null;
  const div_modifier = divergenceModifier(div);

  // PDZ: pull from snapshot or live tickerData fields
  const pdz = snap.pdz || {
    D: t.pdz_zone_D,
    h4: t.pdz_zone_4h,
    h1: t.pdz_zone_1h || t.pdz_zone_h1,
  };
  const pdz_modifier = pdzModifier(pdz, direction);

  // TD: pull from td_sequential.per_tf or snapshot.td_seq
  const tdSeq = snap.td_seq
    || (t.td_sequential && t.td_sequential.per_tf)
    || null;
  const td_modifier = tdExhaustionModifier(tdSeq, direction);

  // Personality: pull from ticker_character / execution_profile
  const personality = String(
    t._ticker_profile?.learning?.personality
    || t.ticker_character?.learned_profile?.personality
    || t.ticker_character?.personality
    || t.execution_profile?.personality
    || t._ticker_profile?.personality
    || ""
  ).toUpperCase();
  const personality_mod = personalityModifier(personality, t.__entry_path);

  const composite =
      w.rank        * rank
    + w.conviction  * conviction
    + w.divergence  * div_modifier
    + w.pdz         * pdz_modifier
    + w.td          * td_modifier
    + w.personality * personality_mod;

  return {
    composite,
    rank,
    conviction,
    rr,
    div_modifier,
    pdz_modifier,
    td_modifier,
    personality_mod,
    personality,
    direction,
    raw: {
      weighted: {
        rank: w.rank * rank,
        conviction: w.conviction * conviction,
        divergence: w.divergence * div_modifier,
        pdz: w.pdz * pdz_modifier,
        td: w.td * td_modifier,
        personality: w.personality * personality_mod,
      },
      weights: w,
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Capacity calculation
// ───────────────────────────────────────────────────────────────────────────

/**
 * Compute the maximum number of entries allowed for this bar/cycle.
 *
 * Scales with remaining open capacity so we don't pile in everything when the
 * book is empty, and don't miss waves when there's room.
 *
 * @param {number} maxOpenPositions - Hard cap on simultaneous open positions
 * @param {number} currentOpenCount - How many positions are currently open
 * @param {object} cfg - Config; defaults to DEFAULT_CAPACITY
 * @returns {number} - Max entries allowed this bar (always >= 1 if any capacity)
 */
export function computeCapacityForBar(maxOpenPositions, currentOpenCount, cfg = DEFAULT_CAPACITY) {
  const c = { ...DEFAULT_CAPACITY, ...(cfg || {}) };
  const remainingOpen = Math.max(0, Number(maxOpenPositions) - Number(currentOpenCount));
  if (remainingOpen <= 0) return 0;
  const fillFactor = Math.max(0.05, Math.min(1.0, Number(c.fill_factor)));
  const scaled = Math.ceil(remainingOpen * fillFactor);
  const capped = Math.min(scaled, Number(c.hard_cap_per_bar));
  return Math.max(1, capped);  // always allow at least 1 if any room
}

// ───────────────────────────────────────────────────────────────────────────
// Tiebreaker — applied when two candidates have identical composite scores
// ───────────────────────────────────────────────────────────────────────────

/**
 * Compute a tiebreaker key for sorting candidates with identical composite_score.
 * Higher = better.
 *
 * Order: R:R desc → ticker historical WR desc → insertion order (lower idx wins).
 *
 * @param {object} candidate - { ticker, score, tickerData, insertionIdx }
 * @returns {Array} - [rr, historicalWr, -insertionIdx] for descending sort
 */
export function tiebreakerKey(candidate) {
  const t = candidate.tickerData || {};
  const snap = t.__entry_setup_snapshot || {};
  const rr = Number(candidate.score?.rr ?? t.rr ?? snap.rr) || 0;

  // Ticker historical WR — from learned profile or live stats
  const profile = t._ticker_profile || t.ticker_character?.learned_profile || t.ticker_character || {};
  const historicalWr = Number(
    profile.win_rate
    ?? profile.winRate
    ?? profile.stats?.win_rate
    ?? profile.lifetime_stats?.win_rate
  ) || 0;

  // Lower insertion index = wins
  const insertionPriority = -Number(candidate.insertionIdx || 0);

  return [rr, historicalWr, insertionPriority];
}

// ───────────────────────────────────────────────────────────────────────────
// Top-N selection
// ───────────────────────────────────────────────────────────────────────────

/**
 * Select the top-N candidates by composite_score with tiebreakers.
 *
 * @param {Array} buffer - Array of { ticker, tickerData, score, insertionIdx }
 *                         where score is the result of computeQualityScore()
 * @param {number} capacity - Max winners to select (from computeCapacityForBar)
 * @param {object} opts - { quality_score_min: number }
 * @returns {{winners: Array, losers: Array}}
 */
export function selectTopN(buffer, capacity, opts = {}) {
  const minScore = Number(opts.quality_score_min ?? DEFAULT_CAPACITY.quality_score_min);
  if (!Array.isArray(buffer) || buffer.length === 0) return { winners: [], losers: [] };
  if (capacity <= 0) return { winners: [], losers: buffer.map(c => ({ ...c, reject_reason: "no_capacity" })) };

  // Stamp insertion index for tiebreaker if not already set
  const stamped = buffer.map((c, i) => ({ ...c, insertionIdx: c.insertionIdx ?? i }));

  // Filter by absolute floor
  const aboveFloor = [];
  const belowFloor = [];
  for (const c of stamped) {
    if ((c.score?.composite || 0) < minScore) {
      belowFloor.push({ ...c, reject_reason: "below_quality_floor" });
    } else {
      aboveFloor.push(c);
    }
  }

  // Sort by composite desc, then tiebreaker keys desc
  aboveFloor.sort((a, b) => {
    const scoreDiff = (b.score?.composite || 0) - (a.score?.composite || 0);
    if (Math.abs(scoreDiff) > 1e-9) return scoreDiff;
    const tbA = tiebreakerKey(a);
    const tbB = tiebreakerKey(b);
    for (let i = 0; i < tbA.length; i++) {
      const d = tbB[i] - tbA[i];
      if (Math.abs(d) > 1e-9) return d;
    }
    return 0;
  });

  const winners = aboveFloor.slice(0, capacity);
  const losersAboveFloor = aboveFloor.slice(capacity).map(c => ({ ...c, reject_reason: "below_topn" }));
  return {
    winners,
    losers: [...losersAboveFloor, ...belowFloor],
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Convenience: load weights + capacity from DA config with safe fallbacks
// ───────────────────────────────────────────────────────────────────────────

export function loadPhaseCConfig(deepAuditCfg = {}) {
  const cfg = deepAuditCfg || {};
  const num = (k, def) => {
    const v = Number(cfg[k]);
    return Number.isFinite(v) ? v : def;
  };
  const bool = (k, def) => {
    const v = String(cfg[k] ?? def).toLowerCase();
    return v === "true" || v === "1";
  };
  return {
    enabled: bool("deep_audit_phase_c_enabled", "false"),
    weights: {
      rank:        num("deep_audit_phase_c_w_rank",        DEFAULT_WEIGHTS.rank),
      conviction:  num("deep_audit_phase_c_w_conviction",  DEFAULT_WEIGHTS.conviction),
      divergence:  num("deep_audit_phase_c_w_divergence",  DEFAULT_WEIGHTS.divergence),
      pdz:         num("deep_audit_phase_c_w_pdz",         DEFAULT_WEIGHTS.pdz),
      td:          num("deep_audit_phase_c_w_td",          DEFAULT_WEIGHTS.td),
      personality: num("deep_audit_phase_c_w_personality", DEFAULT_WEIGHTS.personality),
      rr:          num("deep_audit_phase_c_w_rr",          DEFAULT_WEIGHTS.rr),
    },
    capacity: {
      fill_factor:        num("deep_audit_phase_c_fill_factor",        DEFAULT_CAPACITY.fill_factor),
      hard_cap_per_bar:   num("deep_audit_phase_c_hard_cap_per_bar",   DEFAULT_CAPACITY.hard_cap_per_bar),
      hard_cap_per_cycle: num("deep_audit_phase_c_hard_cap_per_cycle", DEFAULT_CAPACITY.hard_cap_per_cycle),
      quality_score_min:  num("deep_audit_phase_c_quality_score_min",  DEFAULT_CAPACITY.quality_score_min),
    },
  };
}

// Re-export defaults for tests / docs
export const DEFAULTS = {
  WEIGHTS: DEFAULT_WEIGHTS,
  CAPACITY: DEFAULT_CAPACITY,
};
