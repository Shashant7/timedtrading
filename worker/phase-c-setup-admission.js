/**
 * worker/phase-c-setup-admission.js
 *
 * Phase C — Stage 1 (2026-05-04) — Context-Aware Setup Admission.
 *
 * Replaces blanket `enabled=true/false` setup gates with a regime-aware
 * admission matrix. Each setup is evaluated against:
 *   - regime (NEUTRAL / EARLY_BULL / STRONG_BULL / LATE_BULL /
 *             EARLY_BEAR / LATE_BEAR / STRONG_BEAR / COUNTER_TREND_*)
 *   - grade (Prime / Confirmed / Speculative)
 *   - direction (LONG / SHORT)
 *
 * The matrix is data-derived from the canon Jul-Apr 461-trade dataset
 * (see tasks/phase-c/loss-anatomy-and-ml-edge.md). Each (setup, grade,
 * direction) cohort has a per-regime allow/block decision based on the
 * empirical cohort PnL%, WR, and big_W/big_L counts.
 *
 * Default behavior on ANY combination not in the matrix: ALLOW.
 * The matrix is therefore a focused list of KNOWN-TOXIC combinations,
 * not an allowlist. Setups that fall through (e.g. new ones added later)
 * are not blocked — the existing per-setup flags still apply.
 *
 * Loaded from KV `phase-c:setup-admission` so it can be tuned without a
 * deploy. Falls back to the embedded default matrix if KV is empty.
 *
 * Exports:
 *   admitSetup({setup, grade, direction, regime, conviction, rr}) →
 *     {allow: boolean, reason: string, cohortStat?: object}
 *   loadAdmissionMatrix(KV) → matrix object (cached per-request)
 */

// ─────────────────────────────────────────────────────────────────────
// Default matrix — KEYED on (setup_path, direction, grade).
// Per-key decision lists regimes that BLOCK (or "always" / "never").
// Cohort stats embedded as documentation (also help the loop1 layer).
// ─────────────────────────────────────────────────────────────────────
//
// Format:
//   "tt_setup_path:DIRECTION:Grade": {
//      block_regimes: [...]    // explicit regime names, or
//      block_when: "always"    // hard kill regardless of regime
//      allow_only_in: [...]    // ALLOWLIST (if present, blocks everything not listed)
//      min_rr: number          // optional: also requires rr >= this
//      min_conviction: number  // optional: also requires conviction >= this
//      reason: "human readable" // for logs / verdicts
//      cohort_stats: { n, wr, pnl_sum, big_w, big_l }  // diagnostic only
//   }
//
// Decision precedence:
//   1. block_when="always"   → REJECT (no override)
//   2. allow_only_in present → must match regime, else REJECT
//   3. block_regimes present → matching regime → REJECT
//   4. min_rr / min_conviction → REJECT if below
//   5. Else → ALLOW
const DEFAULT_ADMISSION_MATRIX = {
  // ───────────────────────────────────────────────────────────────────
  // GAP REVERSAL LONG — Workhorse cohort. Always allow.
  // Canon Jul-Apr: 271 trades, 58.7% WR, +664 PnL%, 30 big_W, 10 big_L.
  // ───────────────────────────────────────────────────────────────────
  "tt_gap_reversal_long:LONG:Prime": {
    block_when: null,
    reason: "workhorse — always allow",
    cohort_stats: { n: 216, wr: 0.611, pnl_sum: 663.28, big_w: 28, big_l: 19 },
  },
  "tt_gap_reversal_long:LONG:Confirmed": {
    // 53 trades, 49% WR, +7.45 PnL%. Marginal — allow but loop1 will downsize.
    block_when: null,
    reason: "marginal — allow, loop1 may downsize",
    cohort_stats: { n: 53, wr: 0.491, pnl_sum: 7.45, big_w: 2, big_l: 3 },
  },

  // ───────────────────────────────────────────────────────────────────
  // GAP REVERSAL SHORT — Excellent when allowed, brutal when wrong direction.
  // Canon: 11 trades, 64% WR, +28 PnL%. SHORT direction overall: 24 trades,
  // 29% WR, -49 PnL% (the bad ones are non-gap-reversal-short).
  // Restrict to bear regimes and require Prime grade.
  // ───────────────────────────────────────────────────────────────────
  "tt_gap_reversal_short:SHORT:Prime": {
    allow_only_in: ["LATE_BEAR", "STRONG_BEAR", "EARLY_BEAR", "COUNTER_TREND_BULL"],
    reason: "shorts only in bear or bull-exhaustion regimes",
    cohort_stats: { n: 8, wr: 0.625, pnl_sum: 25.74, big_w: 3, big_l: 0 },
  },
  "tt_gap_reversal_short:SHORT:Confirmed": {
    block_when: "always",
    reason: "Confirmed-grade shorts have no edge in any regime tested",
    cohort_stats: { n: 3, wr: 0.333, pnl_sum: 2.14 },
  },
  "tt_gap_reversal_short:SHORT:Speculative": {
    block_when: "always",
    reason: "Speculative shorts blocked unconditionally",
  },

  // ───────────────────────────────────────────────────────────────────
  // PULLBACK — Decent in trending bulls, weak otherwise.
  // Canon Prime: 24 trades, 58% WR, +33 PnL%. Confirmed: -3 PnL%.
  // ───────────────────────────────────────────────────────────────────
  "tt_pullback:LONG:Prime": {
    block_when: null,
    reason: "allowed — bull bias",
    cohort_stats: { n: 24, wr: 0.583, pnl_sum: 33.36, big_w: 3, big_l: 1 },
  },
  "tt_pullback:LONG:Confirmed": {
    block_regimes: ["LATE_BEAR", "STRONG_BEAR", "EARLY_BEAR", "COUNTER_TREND_BEAR"],
    reason: "Confirmed pullbacks blocked in bear regimes (no edge)",
    cohort_stats: { n: 16, wr: 0.375, pnl_sum: -3.29 },
  },

  // ───────────────────────────────────────────────────────────────────
  // ATH BREAKOUT — Edge ONLY in STRONG_BULL. Otherwise dead money.
  // Canon Prime: 24 trades, 54% WR, +0.6 PnL% (basically zero).
  // Confirmed: 21 trades, 24% WR, -8 PnL%.
  // The fix: only allow Prime in STRONG_BULL/EARLY_BULL.
  // ───────────────────────────────────────────────────────────────────
  "tt_ath_breakout:LONG:Prime": {
    allow_only_in: ["STRONG_BULL", "EARLY_BULL"],
    reason: "ATH breakouts only in bull regimes (need momentum tape)",
    cohort_stats: { n: 24, wr: 0.542, pnl_sum: 0.57, big_w: 0, big_l: 0 },
  },
  "tt_ath_breakout:LONG:Confirmed": {
    block_when: "always",
    reason: "Confirmed ATH breakouts: 24% WR in canon, no edge",
    cohort_stats: { n: 21, wr: 0.238, pnl_sum: -8.41 },
  },
  "tt_atl_breakdown:SHORT:Prime": {
    allow_only_in: ["STRONG_BEAR", "LATE_BEAR"],
    reason: "ATL breakdowns only in bear regimes",
  },
  "tt_atl_breakdown:SHORT:Confirmed": {
    block_when: "always",
    reason: "Confirmed ATL breakdowns blocked",
  },

  // ───────────────────────────────────────────────────────────────────
  // RANGE REVERSAL — Tossup. Block weak grades.
  // Canon: 21 trades, 33% WR, -16.58 PnL%. Mostly Confirmed (-7.12) and
  // Prime (-8.46). Need a regime gate to redeem.
  // ───────────────────────────────────────────────────────────────────
  "tt_range_reversal_long:LONG:Prime": {
    allow_only_in: ["NEUTRAL", "EARLY_BULL", "COUNTER_TREND_BULL"],
    min_rr: 2.5,
    reason: "Range bounces only in chop/early-bull with rr>=2.5",
    cohort_stats: { n: 11, wr: 0.364, pnl_sum: -8.46 },
  },
  "tt_range_reversal_long:LONG:Confirmed": {
    block_when: "always",
    reason: "Confirmed range bounces: no edge in any regime",
    cohort_stats: { n: 7, wr: 0.286, pnl_sum: -7.12 },
  },
  "tt_range_reversal_short:SHORT:Prime": {
    allow_only_in: ["NEUTRAL", "EARLY_BEAR", "LATE_BULL"],
    min_rr: 2.5,
    reason: "Range bounces short side, only in chop/early-bear",
  },
  "tt_range_reversal_short:SHORT:Confirmed": {
    block_when: "always",
    reason: "Confirmed range short: no edge",
  },

  // ───────────────────────────────────────────────────────────────────
  // N-TEST SUPPORT (LONG) — Per cohort autopsy:
  //   Prime: 21 trades, 38% WR, -65.79 PnL%, 2 big_W, 2 big_L (2 catastrophic)
  //   Confirmed: 24 trades, 33% WR, -13.31 PnL%, 0 big_W
  //   Speculative: 7 trades, 57% WR, +1.11 PnL%
  // BUT: in Jul/Aug specifically, Prime N-Test was +6.70 with 1 big_W.
  // The big losses are concentrated in late 2025 / Q1 2026.
  // Calibration: only allow Prime in TRENDING regimes (where support
  // has actual structural meaning), require rr>=2.5.
  // ───────────────────────────────────────────────────────────────────
  "tt_n_test_support:LONG:Prime": {
    allow_only_in: ["EARLY_BULL", "STRONG_BULL", "NEUTRAL"],
    min_rr: 2.5,
    reason: "N-Test Support only in bull/neutral with rr>=2.5 (avoids late-2025 trap)",
    cohort_stats: { n: 21, wr: 0.381, pnl_sum: -65.79, big_w: 2, big_l: 2, catastrophic: 2 },
  },
  "tt_n_test_support:LONG:Confirmed": {
    block_when: "always",
    reason: "Confirmed N-Test Support: 33% WR, no big_W in 24 trades",
    cohort_stats: { n: 24, wr: 0.333, pnl_sum: -13.31 },
  },
  "tt_n_test_support:LONG:Speculative": {
    block_when: null,
    reason: "Speculative N-Test Support: small sample but +EV",
    cohort_stats: { n: 7, wr: 0.571, pnl_sum: 1.11 },
  },

  // ───────────────────────────────────────────────────────────────────
  // N-TEST RESISTANCE (SHORT) — DEAD. 0% WR in canon. Absolute kill.
  // ───────────────────────────────────────────────────────────────────
  "tt_n_test_resistance:SHORT:Prime": {
    allow_only_in: ["LATE_BEAR", "STRONG_BEAR"],
    min_rr: 3.0,
    reason: "N-Test Resistance: only deep bear, rr>=3.0 (extremely picky)",
  },
  "tt_n_test_resistance:SHORT:Confirmed": {
    block_when: "always",
    reason: "N-Test Resistance Confirmed: 0% WR / 3 catastrophic in canon. ALWAYS BLOCK.",
    cohort_stats: { n: 7, wr: 0, pnl_sum: -71.24, big_l: 3, catastrophic: 3 },
  },
  "tt_n_test_resistance:SHORT:Speculative": {
    block_when: "always",
    reason: "N-Test Resistance Speculative: same logic as Confirmed",
  },
};

// ─────────────────────────────────────────────────────────────────────
// Per-request matrix cache. Reset by loadAdmissionMatrix().
// ─────────────────────────────────────────────────────────────────────
let _matrixCache = null;
let _matrixCacheTs = 0;
const MATRIX_CACHE_TTL_MS = 60 * 1000; // 60s

/**
 * Load the admission matrix from KV, falling back to the default.
 * Cached per-process for 60s to avoid hammering KV during a backtest's
 * per-bar entry evaluations.
 */
export async function loadAdmissionMatrix(KV) {
  const now = Date.now();
  if (_matrixCache && (now - _matrixCacheTs) < MATRIX_CACHE_TTL_MS) {
    return _matrixCache;
  }
  let matrix = DEFAULT_ADMISSION_MATRIX;
  try {
    if (KV) {
      const stored = await KV.get("phase-c:setup-admission", { type: "json" });
      if (stored && typeof stored === "object") {
        // Merge stored on top of defaults so partial overrides work.
        matrix = { ...DEFAULT_ADMISSION_MATRIX, ...stored };
      }
    }
  } catch (_) {
    // Fall back to default on any KV error.
  }
  _matrixCache = matrix;
  _matrixCacheTs = now;
  return matrix;
}

export function clearAdmissionMatrixCache() {
  _matrixCache = null;
  _matrixCacheTs = 0;
}

/**
 * Decide whether a setup should be admitted given the current market
 * regime and trade specifics. Pure, sync, no I/O. Caller must have
 * loaded the matrix via loadAdmissionMatrix() first (typically once
 * per scoring cycle).
 *
 * @param {object} args
 * @param {string} args.setup       — entry path ('tt_gap_reversal_long', etc.)
 * @param {string} args.grade       — 'Prime' / 'Confirmed' / 'Speculative'
 * @param {string} args.direction   — 'LONG' / 'SHORT'
 * @param {string} args.regime      — regimeCombined string
 * @param {number} args.conviction  — focus_conviction_score (optional)
 * @param {number} args.rr          — risk:reward at entry (optional)
 * @param {object} matrix           — admission matrix from loadAdmissionMatrix
 * @returns {{allow: boolean, reason: string, cohortStat?: object, matched_key?: string}}
 */
export function admitSetup(args, matrix) {
  const { setup, grade, direction, regime } = args || {};
  if (!matrix) matrix = DEFAULT_ADMISSION_MATRIX;

  const setupKey = String(setup || "").toLowerCase().trim();
  const gradeKey = String(grade || "").trim();
  const dirKey = String(direction || "").toUpperCase().trim();
  const regimeKey = String(regime || "").toUpperCase().trim();

  // No grade means we can't decide; default to allow (safer than blocking).
  if (!setupKey || !gradeKey || !dirKey) {
    return { allow: true, reason: "missing_inputs_default_allow" };
  }

  const matrixKey = `${setupKey}:${dirKey}:${gradeKey}`;
  const entry = matrix[matrixKey];

  // No matrix entry → not on the watchlist → allow.
  if (!entry) {
    return { allow: true, reason: "no_matrix_entry", matched_key: matrixKey };
  }

  // 1. Hard kill
  if (entry.block_when === "always") {
    return {
      allow: false,
      reason: `setup_admission_blocked_always: ${entry.reason || matrixKey}`,
      matched_key: matrixKey,
      cohortStat: entry.cohort_stats || null,
    };
  }

  // 2. Allowlist mode
  if (Array.isArray(entry.allow_only_in) && entry.allow_only_in.length > 0) {
    if (!entry.allow_only_in.includes(regimeKey)) {
      return {
        allow: false,
        reason: `setup_admission_regime_not_allowed: ${matrixKey} requires regime in [${entry.allow_only_in.join(",")}], got ${regimeKey}. ${entry.reason || ""}`.trim(),
        matched_key: matrixKey,
        cohortStat: entry.cohort_stats || null,
      };
    }
  }

  // 3. Blocklist mode
  if (Array.isArray(entry.block_regimes) && entry.block_regimes.includes(regimeKey)) {
    return {
      allow: false,
      reason: `setup_admission_regime_blocked: ${matrixKey} blocked in ${regimeKey}. ${entry.reason || ""}`.trim(),
      matched_key: matrixKey,
      cohortStat: entry.cohort_stats || null,
    };
  }

  // 4. min_rr
  if (Number.isFinite(entry.min_rr) && Number.isFinite(args.rr) && args.rr < entry.min_rr) {
    return {
      allow: false,
      reason: `setup_admission_rr_too_low: ${matrixKey} requires rr>=${entry.min_rr}, got ${Number(args.rr).toFixed(2)}. ${entry.reason || ""}`.trim(),
      matched_key: matrixKey,
      cohortStat: entry.cohort_stats || null,
    };
  }

  // 5. min_conviction
  if (Number.isFinite(entry.min_conviction) && Number.isFinite(args.conviction) && args.conviction < entry.min_conviction) {
    return {
      allow: false,
      reason: `setup_admission_conviction_too_low: ${matrixKey} requires conviction>=${entry.min_conviction}, got ${args.conviction}. ${entry.reason || ""}`.trim(),
      matched_key: matrixKey,
      cohortStat: entry.cohort_stats || null,
    };
  }

  // All gates passed.
  return {
    allow: true,
    reason: `setup_admission_passed: ${matrixKey}. ${entry.reason || ""}`.trim(),
    matched_key: matrixKey,
    cohortStat: entry.cohort_stats || null,
  };
}

/**
 * Convenience wrapper: load matrix + decide in one call.
 * Use this in code paths that don't hot-loop.
 */
export async function admitSetupAsync(args, KV) {
  const matrix = await loadAdmissionMatrix(KV);
  return admitSetup(args, matrix);
}

export default { admitSetup, admitSetupAsync, loadAdmissionMatrix, clearAdmissionMatrixCache };
