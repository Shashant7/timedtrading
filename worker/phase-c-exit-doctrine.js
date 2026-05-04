/**
 * worker/phase-c-exit-doctrine.js
 *
 * Phase C — Stage 1 (2026-05-04) — Context-Aware Exit Doctrine.
 *
 * Sister module to phase-c-setup-admission.js. Instead of choosing
 * WHETHER to enter, this chooses HOW to manage an open trade based on
 * the current regime, the entry regime, and the trade's lifecycle stage.
 *
 * The doctrine is the "be nimble + aware" management layer the user
 * asked for. It maps (setup × entry_regime → current_regime × MFE_state ×
 * age_state) → one of four management modes:
 *
 *   "ride_runner"    — loose stops, big trail, hold through noise.
 *                      Used when regime is favorable and trade is winning.
 *   "manage_normal"  — existing behavior, no overrides.
 *   "tighten"        — lock 50-60% of MFE, smaller trail-giveback.
 *                      Used when regime decays, trade still winning, but
 *                      we want to lock gains.
 *   "force_exit"     — next-bar exit. Used when regime FLIPS opposite,
 *                      age >= threshold, and trade is losing (or barely
 *                      positive). Prevents stale-held disasters.
 *
 * Loaded from KV `phase-c:exit-doctrine`. Falls back to the embedded
 * default doctrine derived from canon Jul-Apr loss-anatomy:
 *   - 18 catastrophic stale-held losses (-290 PnL%) all had:
 *       age > 5 sessions AND regime flipped opposite AND pnl < 0
 *   - 5 "gave back big gain" losses (-86 PnL%) all had:
 *       MFE >= 5% AND giveback >= 50% AND held > 2 sessions
 *
 * Output:
 *   {
 *     action: "ride_runner" | "manage_normal" | "tighten" | "force_exit",
 *     lock_pct: number       // % of MFE to lock (used in trim/exit decisions)
 *     trail_giveback_pct: number  // max giveback before exit
 *     reason: string         // human-readable doctrine match
 *     force_exit: boolean    // shorthand for action=="force_exit"
 *   }
 *
 * Disabled via `daCfg.deep_audit_exit_doctrine_enabled = "false"`.
 */

// ─────────────────────────────────────────────────────────────────────
// Regime classification helpers
// ─────────────────────────────────────────────────────────────────────
const BULL_REGIMES = new Set([
  "STRONG_BULL", "EARLY_BULL", "LATE_BULL", "COUNTER_TREND_BULL",
]);
const BEAR_REGIMES = new Set([
  "STRONG_BEAR", "EARLY_BEAR", "LATE_BEAR", "COUNTER_TREND_BEAR",
]);
const NEUTRAL_REGIMES = new Set(["NEUTRAL"]);

function regimeIsBull(r) { return BULL_REGIMES.has(String(r || "").toUpperCase()); }
function regimeIsBear(r) { return BEAR_REGIMES.has(String(r || "").toUpperCase()); }
function regimeIsNeutral(r) { return NEUTRAL_REGIMES.has(String(r || "").toUpperCase()); }

/**
 * Did the regime flip OPPOSITE the trade direction?
 * For LONG: bull-on-entry → now bear or late-bear-flavored.
 * For SHORT: bear-on-entry → now bull.
 * Neutral on either side does NOT count as a flip.
 */
function regimeFlippedOpposite(direction, entryRegime, currentRegime) {
  const dir = String(direction || "").toUpperCase();
  if (dir === "LONG") {
    const wasBull = regimeIsBull(entryRegime) || regimeIsNeutral(entryRegime);
    const nowBear = regimeIsBear(currentRegime);
    return wasBull && nowBear;
  } else if (dir === "SHORT") {
    const wasBear = regimeIsBear(entryRegime) || regimeIsNeutral(entryRegime);
    const nowBull = regimeIsBull(currentRegime);
    return wasBear && nowBull;
  }
  return false;
}

/**
 * Did the regime STRENGTHEN in the trade's favor?
 * NEUTRAL → STRONG_BULL on a LONG = strengthened.
 * EARLY_BULL → STRONG_BULL on a LONG = strengthened.
 */
function regimeStrengthened(direction, entryRegime, currentRegime) {
  const dir = String(direction || "").toUpperCase();
  const order = ["STRONG_BEAR","LATE_BEAR","COUNTER_TREND_BULL","EARLY_BEAR","NEUTRAL","EARLY_BULL","COUNTER_TREND_BEAR","LATE_BULL","STRONG_BULL"];
  const ei = order.indexOf(String(entryRegime || "").toUpperCase());
  const ci = order.indexOf(String(currentRegime || "").toUpperCase());
  if (ei < 0 || ci < 0) return false;
  if (dir === "LONG") return ci > ei;
  if (dir === "SHORT") return ci < ei;
  return false;
}

// ─────────────────────────────────────────────────────────────────────
// Default doctrine matrix.
//
// Looked up by (setup_key) — but most rules are SHAPE-based (regime
// transition + MFE state + age) rather than per-setup. Per-setup
// overrides allow workhorse cohorts to ride longer.
// ─────────────────────────────────────────────────────────────────────
const DEFAULT_DOCTRINE = {
  // ───────────────────────────────────────────────────────────────────
  // Per-setup parameters (tunable per cohort)
  // ───────────────────────────────────────────────────────────────────
  setups: {
    // Workhorse: ride hardest, lowest force-exit threshold (only on
    // explicit regime-flip + age + pnl<0).
    "tt_gap_reversal_long": {
      ride_runner_lock_pct: 0.50,         // give back up to 50% of MFE before lock
      ride_runner_trail_pct: 0.85,         // very loose trail
      tighten_lock_pct: 0.65,
      tighten_trail_pct: 0.50,
      force_exit_min_age_sessions: 5,
      force_exit_pnl_threshold: -1.0,      // fire if pnl <= -1% AND regime flipped
      gave_back_giveback_pct: 0.55,        // 55% MFE giveback triggers tighten
      gave_back_min_mfe: 5.0,              // only if MFE >= 5%
    },
    "tt_gap_reversal_short": {
      ride_runner_lock_pct: 0.55,
      ride_runner_trail_pct: 0.80,
      tighten_lock_pct: 0.65,
      tighten_trail_pct: 0.50,
      force_exit_min_age_sessions: 4,
      force_exit_pnl_threshold: -1.0,
      gave_back_giveback_pct: 0.55,
      gave_back_min_mfe: 5.0,
    },
    "tt_pullback": {
      ride_runner_lock_pct: 0.55,
      ride_runner_trail_pct: 0.75,
      tighten_lock_pct: 0.65,
      tighten_trail_pct: 0.45,
      force_exit_min_age_sessions: 3,      // pullbacks shouldn't sit long
      force_exit_pnl_threshold: -0.5,
      gave_back_giveback_pct: 0.50,
      gave_back_min_mfe: 4.0,
    },
    "tt_ath_breakout": {
      ride_runner_lock_pct: 0.50,
      ride_runner_trail_pct: 0.80,
      tighten_lock_pct: 0.65,
      tighten_trail_pct: 0.45,
      force_exit_min_age_sessions: 2,      // ATH break MUST work fast or it's wrong
      force_exit_pnl_threshold: -0.5,
      gave_back_giveback_pct: 0.45,
      gave_back_min_mfe: 4.0,
    },
    "tt_atl_breakdown": {
      ride_runner_lock_pct: 0.50,
      ride_runner_trail_pct: 0.80,
      tighten_lock_pct: 0.65,
      tighten_trail_pct: 0.45,
      force_exit_min_age_sessions: 2,
      force_exit_pnl_threshold: -0.5,
      gave_back_giveback_pct: 0.45,
      gave_back_min_mfe: 4.0,
    },
    "tt_n_test_support": {
      // N-Test was the cohort that sat for thousands of hours and turned
      // catastrophic. Aggressive force-exit thresholds.
      ride_runner_lock_pct: 0.65,
      ride_runner_trail_pct: 0.55,
      tighten_lock_pct: 0.75,
      tighten_trail_pct: 0.40,
      force_exit_min_age_sessions: 2,
      force_exit_pnl_threshold: 0.0,       // ANY losing trade in flipped regime
      gave_back_giveback_pct: 0.40,
      gave_back_min_mfe: 3.0,
    },
    "tt_n_test_resistance": {
      ride_runner_lock_pct: 0.65,
      ride_runner_trail_pct: 0.55,
      tighten_lock_pct: 0.75,
      tighten_trail_pct: 0.40,
      force_exit_min_age_sessions: 2,
      force_exit_pnl_threshold: 0.0,
      gave_back_giveback_pct: 0.40,
      gave_back_min_mfe: 3.0,
    },
    "tt_range_reversal_long": {
      ride_runner_lock_pct: 0.60,
      ride_runner_trail_pct: 0.60,
      tighten_lock_pct: 0.70,
      tighten_trail_pct: 0.40,
      force_exit_min_age_sessions: 3,
      force_exit_pnl_threshold: -0.5,
      gave_back_giveback_pct: 0.45,
      gave_back_min_mfe: 4.0,
    },
    "tt_range_reversal_short": {
      ride_runner_lock_pct: 0.60,
      ride_runner_trail_pct: 0.60,
      tighten_lock_pct: 0.70,
      tighten_trail_pct: 0.40,
      force_exit_min_age_sessions: 3,
      force_exit_pnl_threshold: -0.5,
      gave_back_giveback_pct: 0.45,
      gave_back_min_mfe: 4.0,
    },
  },
  // ───────────────────────────────────────────────────────────────────
  // Default fallback for unknown setups
  // ───────────────────────────────────────────────────────────────────
  default: {
    ride_runner_lock_pct: 0.55,
    ride_runner_trail_pct: 0.70,
    tighten_lock_pct: 0.65,
    tighten_trail_pct: 0.45,
    force_exit_min_age_sessions: 4,
    force_exit_pnl_threshold: -0.5,
    gave_back_giveback_pct: 0.50,
    gave_back_min_mfe: 5.0,
  },
};

// ─────────────────────────────────────────────────────────────────────
// Cache (mirrors admission module pattern)
// ─────────────────────────────────────────────────────────────────────
let _doctrineCache = null;
let _doctrineCacheTs = 0;
const DOCTRINE_CACHE_TTL_MS = 60 * 1000;

export async function loadExitDoctrine(KV) {
  const now = Date.now();
  if (_doctrineCache && (now - _doctrineCacheTs) < DOCTRINE_CACHE_TTL_MS) {
    return _doctrineCache;
  }
  let doctrine = DEFAULT_DOCTRINE;
  try {
    if (KV) {
      const stored = await KV.get("phase-c:exit-doctrine", { type: "json" });
      if (stored && typeof stored === "object") {
        doctrine = {
          setups: { ...DEFAULT_DOCTRINE.setups, ...(stored.setups || {}) },
          default: { ...DEFAULT_DOCTRINE.default, ...(stored.default || {}) },
        };
      }
    }
  } catch (_) {
    // fall through to default
  }
  _doctrineCache = doctrine;
  _doctrineCacheTs = now;
  return doctrine;
}

export function clearExitDoctrineCache() {
  _doctrineCache = null;
  _doctrineCacheTs = 0;
}

/**
 * Convert minutes-since-entry into trading sessions held.
 * Approximates: 1 session = 6.5 hours of market hours, but for
 * simplicity we use 24 wall-clock hours = ~1 session (replay engine
 * uses simulated time so this maps cleanly).
 */
function ageInSessions(ageMin) {
  const hours = Number(ageMin) / 60;
  if (!Number.isFinite(hours) || hours <= 0) return 0;
  return hours / 24;
}

/**
 * Pick the per-setup parameters from the doctrine.
 */
function pickSetupParams(doctrine, setupKey) {
  const setups = doctrine?.setups || DEFAULT_DOCTRINE.setups;
  const k = String(setupKey || "").toLowerCase().trim();
  return setups[k] || doctrine?.default || DEFAULT_DOCTRINE.default;
}

/**
 * Decide the management doctrine for a single open position.
 *
 * @param {object} args
 * @param {string} args.setup            entry path
 * @param {string} args.direction        LONG / SHORT
 * @param {string} args.entryRegime      regime at entry time
 * @param {string} args.currentRegime    regime now
 * @param {number} args.mfePct           max favorable excursion %
 * @param {number} args.currentPnlPct    current pnl %
 * @param {number} args.ageMin           minutes since entry
 * @param {object} doctrine              from loadExitDoctrine
 * @returns {{action, lock_pct, trail_giveback_pct, reason, force_exit, params}}
 */
export function chooseExitDoctrine(args, doctrine) {
  const {
    setup, direction, entryRegime, currentRegime,
    mfePct, currentPnlPct, ageMin,
  } = args || {};
  if (!doctrine) doctrine = DEFAULT_DOCTRINE;

  const params = pickSetupParams(doctrine, setup);
  const ageSessions = ageInSessions(ageMin);
  const _mfe = Number(mfePct) || 0;
  const _pnl = Number(currentPnlPct) || 0;

  // ───────────────────────────────────────────────────────────────────
  // 1. FORCE EXIT — regime flipped opposite + age threshold + pnl bad
  //
  // This is the single highest-leverage rule from the loss-anatomy.
  // 18 catastrophic losses (-290 PnL% = 30% of total damage) all fit
  // this profile.
  // ───────────────────────────────────────────────────────────────────
  if (regimeFlippedOpposite(direction, entryRegime, currentRegime)
      && ageSessions >= params.force_exit_min_age_sessions
      && _pnl <= params.force_exit_pnl_threshold) {
    return {
      action: "force_exit",
      force_exit: true,
      lock_pct: 0,
      trail_giveback_pct: 0,
      reason: `doctrine_regime_flip_force_exit: setup=${setup} entry=${entryRegime}→now=${currentRegime} dir=${direction} age=${ageSessions.toFixed(1)}sessions pnl=${_pnl.toFixed(2)}% (thresholds: age>=${params.force_exit_min_age_sessions}, pnl<=${params.force_exit_pnl_threshold})`,
      params,
    };
  }

  // ───────────────────────────────────────────────────────────────────
  // 2. GAVE-BACK BIG GAIN PROTECTION — MFE >= threshold AND
  //    current giveback exceeds threshold AND held >= 1 session.
  //    Forces tighten action (or exit if very far gone).
  // ───────────────────────────────────────────────────────────────────
  if (_mfe >= params.gave_back_min_mfe && ageSessions >= 1) {
    const givebackPct = (_mfe - _pnl) / _mfe; // fraction of MFE given back
    if (givebackPct >= params.gave_back_giveback_pct) {
      // If giveback is severe (>80%) AND age >= 2, force exit instead of tighten
      if (givebackPct >= 0.80 && ageSessions >= 2) {
        return {
          action: "force_exit",
          force_exit: true,
          lock_pct: 0,
          trail_giveback_pct: 0,
          reason: `doctrine_giveback_severe_force_exit: setup=${setup} mfe=${_mfe.toFixed(2)}% pnl=${_pnl.toFixed(2)}% giveback=${(givebackPct*100).toFixed(0)}% age=${ageSessions.toFixed(1)}s`,
          params,
        };
      }
      return {
        action: "tighten",
        force_exit: false,
        lock_pct: params.tighten_lock_pct,
        trail_giveback_pct: params.tighten_trail_pct,
        reason: `doctrine_giveback_tighten: setup=${setup} mfe=${_mfe.toFixed(2)}% pnl=${_pnl.toFixed(2)}% giveback=${(givebackPct*100).toFixed(0)}%`,
        params,
      };
    }
  }

  // ───────────────────────────────────────────────────────────────────
  // 3. RIDE RUNNER — regime is favorable AND trade is winning
  //    AND MFE has cleared a meaningful threshold.
  // ───────────────────────────────────────────────────────────────────
  const regimeFavorable = (
    (String(direction).toUpperCase() === "LONG" && (regimeIsBull(currentRegime) || regimeStrengthened(direction, entryRegime, currentRegime)))
    || (String(direction).toUpperCase() === "SHORT" && (regimeIsBear(currentRegime) || regimeStrengthened(direction, entryRegime, currentRegime)))
  );
  if (regimeFavorable && _pnl >= 1.0 && _mfe >= 2.0) {
    return {
      action: "ride_runner",
      force_exit: false,
      lock_pct: params.ride_runner_lock_pct,
      trail_giveback_pct: params.ride_runner_trail_pct,
      reason: `doctrine_ride_runner: setup=${setup} regime=${currentRegime} mfe=${_mfe.toFixed(2)}% pnl=${_pnl.toFixed(2)}% (favorable)`,
      params,
    };
  }

  // ───────────────────────────────────────────────────────────────────
  // 4. TIGHTEN — regime decayed (no flip but lost favorability) AND
  //    trade is barely winning OR slightly losing.
  // ───────────────────────────────────────────────────────────────────
  const regimeDecayed = (
    (String(direction).toUpperCase() === "LONG" && regimeIsNeutral(currentRegime) && regimeIsBull(entryRegime))
    || (String(direction).toUpperCase() === "SHORT" && regimeIsNeutral(currentRegime) && regimeIsBear(entryRegime))
  );
  if (regimeDecayed && ageSessions >= 1) {
    return {
      action: "tighten",
      force_exit: false,
      lock_pct: params.tighten_lock_pct,
      trail_giveback_pct: params.tighten_trail_pct,
      reason: `doctrine_regime_decay_tighten: setup=${setup} entry=${entryRegime}→now=${currentRegime} age=${ageSessions.toFixed(1)}s`,
      params,
    };
  }

  // ───────────────────────────────────────────────────────────────────
  // 5. DEFAULT — manage_normal, no overrides
  // ───────────────────────────────────────────────────────────────────
  return {
    action: "manage_normal",
    force_exit: false,
    lock_pct: params.tighten_lock_pct,        // baseline
    trail_giveback_pct: params.ride_runner_trail_pct, // baseline
    reason: `doctrine_manage_normal: setup=${setup} regime=${currentRegime}`,
    params,
  };
}

export default {
  chooseExitDoctrine,
  loadExitDoctrine,
  clearExitDoctrineCache,
  regimeFlippedOpposite,
  regimeStrengthened,
};
