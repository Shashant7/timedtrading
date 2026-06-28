/**
 * worker/etf-profile.js
 *
 * Phase C — Stage 1 (2026-05-05) — ETF Management Profile.
 *
 * Treats ETFs as a fundamentally different instrument class than stocks:
 *  - Tighter intraday range (0.5-1.5% vs stocks' 2-5%)
 *  - Different "great trade" benchmark (a 1% SPY rip is a great trade;
 *    a 1% TSLA move is noise)
 *  - Wider stops on ETFs get noise-stopped; needs tighter ATR multipliers
 *  - Slower trim ladder lets profit round-trip; needs faster TP1 (~0.6%)
 *  - Stagnant-exit timer should fire faster (8h MFE-dead vs stocks' 24h)
 *
 * Built from the canon Jul-Apr 461-trade audit:
 *   - 85 ETF trades, -$99.80 cumulative PnL (vs stocks +$700)
 *   - SPY: 18 trades, -$6 sum, avg MFE +0.68% (we hit 0.68% MFE then gave it back)
 *   - QQQ: 11 trades, +$3 sum (basically flat — no edge captured)
 *   - DIA: 10 trades, +$1.21 sum (also flat)
 *   - IWM: 9 trades, +$0.89 sum (flat)
 *   - SPY winners average MFE-capture of just 50% (we keep half the move)
 *   - 5 SPY losses exited via thesis_flip_htf with MFE 0.21% (stopped on noise)
 *
 * Excluded from this profile (treated as stocks per user direction):
 *   - Leveraged ETFs (3x): SOXL, TNA, SQQQ, SPXU, TZA, AGQ
 *   - Inverse ETFs: SH, PSQ, RWM, DOG
 *   - Single-stock ETFs (these don't really exist in our universe)
 *   - Volatility ETPs: VIXY, UVXY (separate beast)
 *
 * Future: separate "leveraged ETF" profile may be warranted but per user
 * direction, treating them as stocks for now is acceptable.
 */

// ─────────────────────────────────────────────────────────────────────
// CLASSIFICATION
// ─────────────────────────────────────────────────────────────────────

// Broad-market index ETFs (the heavyweights — most user-traded)
const ETF_BROAD_INDEX = new Set([
  "SPY", "QQQ", "IWM", "DIA", "VOO", "VTI", "VEA", "VWO", "EFA", "EEM",
  "MDY", "SPLG",
]);

/** Per-index management overrides — slower moves, tighter ranges than stocks. */
const INDEX_ETF_OVERRIDES = {
  SPY: {
    tp_ladder: {
      trim_pct_target: 0.005,
      exit_pct_target: 0.010,
      runner_pct_target: 0.020,
    },
    stop_loss: { max_distance_pct: 0.005 },
    doctrine_overrides: {
      ride_runner_lock_pct: 0.45,
      ride_runner_trail_pct: 0.55,
      gave_back_giveback_pct: 0.75,
      gave_back_min_mfe: 0.5,
    },
    ride_runner_mfe_pct: 0.6,
  },
  QQQ: {
    tp_ladder: {
      trim_pct_target: 0.006,
      exit_pct_target: 0.012,
      runner_pct_target: 0.022,
    },
    stop_loss: { max_distance_pct: 0.006 },
    doctrine_overrides: {
      ride_runner_lock_pct: 0.48,
      ride_runner_trail_pct: 0.58,
    },
    ride_runner_mfe_pct: 0.7,
  },
  IWM: {
    tp_ladder: {
      trim_pct_target: 0.007,
      exit_pct_target: 0.014,
      runner_pct_target: 0.025,
    },
    stop_loss: { max_distance_pct: 0.007 },
    doctrine_overrides: {
      ride_runner_lock_pct: 0.50,
      ride_runner_trail_pct: 0.60,
    },
    ride_runner_mfe_pct: 0.8,
  },
};

// Sector ETFs (S&P sector spiders)
const ETF_SECTOR = new Set([
  "XLE", "XLF", "XLK", "XLV", "XLY", "XLP", "XLU", "XLI", "XLRE", "XLB", "XLC",
  // Sector industry ETFs
  "XHB", "XOP", "XBI", "ITA", "IYR", "IYE", "IYF", "IYH", "IYK", "IYJ",
]);

// Thematic / growth / international ETFs
const ETF_THEMATIC = new Set([
  "IGV", "IBB", "GDX", "GLD", "SLV", "USO", "KWEB", "FXI", "INDA", "EWZ",
  "IAU", "INFL", "BITO", "ETHA", "BITX", "ARKK", "SMH", "SOXX",
  "IGE", "IBB",
]);

// LEVERAGED ETFs — per user direction, treat as stocks for now (NOT in profile)
// Listed here for documentation only.
const ETF_LEVERAGED_STOCKS_FOR_NOW = new Set([
  "SOXL", "TNA", "SQQQ", "SPXU", "TZA", "AGQ", "TQQQ", "FAS", "FAZ",
  "BOIL", "KOLD", "JNUG", "JDST", "NUGT", "DUST", "ERX", "ERY",
  "CURE", "DRIP", "GUSH", "LABU", "LABD", "BULZ", "WEBL", "WEBS",
]);

// VOLATILITY products — also treat as stocks (different management entirely)
const ETF_VOLATILITY_STOCKS_FOR_NOW = new Set([
  "VIXY", "UVXY", "SVXY", "VXX", "VXZ", "SPHB",
]);

// CRYPTO — treat as their own thing (24/7 markets, separate management)
const ETF_CRYPTO_STOCKS_FOR_NOW = new Set([
  "BTCUSD", "ETHUSD",
]);

// Build the master "use ETF profile" set
const ETF_PROFILE_TICKERS = new Set([
  ...ETF_BROAD_INDEX,
  ...ETF_SECTOR,
  ...ETF_THEMATIC,
]);

// ─────────────────────────────────────────────────────────────────────
// PROFILE PARAMETERS
// ─────────────────────────────────────────────────────────────────────

/**
 * The ETF management profile. All numbers calibrated from canon audit
 * + user direction ("a 1% SPY gain is great, trim worthy").
 *
 * ENTRY-time parameters affect TP/SL placement at trade creation.
 * EXIT-time parameters override doctrine + existing exit rules.
 */
const ETF_PROFILE = {
  // ─── TP ladder (tighter than stocks) ───
  // Stock defaults: TRIM at 1.5×ATR, EXIT at 2.5×ATR, RUNNER at 4.0×ATR
  //               + min_trim_pct 1.5% absolute floor
  // ETF profile:   TRIM at 0.6%, EXIT at 1.2%, RUNNER at 2.5%
  //               (no ATR multiplier — ETF ATRs are tiny anyway)
  //               This catches the "a 1% SPY move IS the move" reality.
  tp_ladder: {
    trim_pct_target: 0.006,           // +0.6% absolute
    trim_pct_min: 0.005,              // floor 0.5% (don't trim below this even if ATR suggests)
    trim_pct_max: 0.010,              // ceiling 1.0%
    exit_pct_target: 0.012,           // +1.2%
    exit_pct_min: 0.010,
    exit_pct_max: 0.020,
    runner_pct_target: 0.025,         // +2.5%
    runner_pct_min: 0.020,
    runner_pct_max: 0.040,
    // Trim split (what % of position closes at each tier)
    trim_pct_at_tp1: 0.60,            // 60% off at TP1 (vs 50% for stocks)
    trim_pct_at_tp2: 0.30,            // 30% off at TP2 (cumulative 90%)
    runner_pct_at_tp3: 0.10,          // last 10% as runner
  },

  // ─── Stop loss (ATR-based but tighter floor) ───
  // Stock defaults: 1.5× ATR or whatever volatility-adjusted stop yields
  // ETF profile:    max stop = 0.7% absolute. Anything wider just gets
  //                 noise-stopped because ETF intraday range is 0.5-1.5%.
  stop_loss: {
    max_distance_pct: 0.007,          // 0.7% max stop distance from entry
    min_distance_pct: 0.003,          // 0.3% min (don't be tighter than this)
    // Note: this OVERRIDES the ATR-based stop if the ATR stop would be wider.
  },

  // ─── Exit doctrine overrides (sister to phase-c-exit-doctrine.js) ───
  // Doctrine reads these via getEtfProfile(ticker)?.doctrine_overrides
  // when the ticker matches.
  //
  // V15 P0.7.66 (2026-05-05) — Tier 2 changes per ETF audit findings:
  //   - Tier 2E: ride-runner mode. Once MFE >= 1.0%, "the move happened"
  //     for an ETF. Don't cut on noise. Loosen tighten_lock_pct so the
  //     runner has room. Disable thesis_flip + 24h_dead_money for ETFs
  //     (handled in worker/index.js).
  //   - Tier 2F: SHORT defense. ETF SHORTs need patience for waves.
  //     gave_back_giveback_pct: 0.70 (was 0.40) — give back 70% before tighten.
  //     gave_back_min_mfe: 0.5 — react sooner on smaller MFE.
  doctrine_overrides: {
    // Fresh-failure: ETFs should fail FAST. If a SPY trade is at -0.7%
    // after 1 hour without ever clearing 0.3% MFE, the entry was wrong.
    fresh_fail_max_mfe_pct: 0.3,
    fresh_fail_pnl_threshold: -0.7,
    fresh_fail_min_age_min: 60,        // 2 bars on 30m
    // Regime decay: tighter still — ETFs reflect broad market.
    regime_decay_max_mfe_pct: 0.5,
    regime_decay_pnl_threshold: -0.5,
    regime_decay_min_age_sessions: 0.5,  // 12h
    // Gave-back protection: V15 P0.7.66 — LOOSENED for ETFs.
    // Old 0.40 was triggering tighten on normal SPY noise (Mar-23 case).
    // Now 0.70 — only react when significant gain is being eroded.
    gave_back_giveback_pct: 0.70,
    gave_back_min_mfe: 0.6,
    // Force-exit on regime flip
    force_exit_min_age_sessions: 1,
    force_exit_pnl_threshold: 0.0,
    // Ride-runner: V15 P0.7.66 — LOOSENED. Once an ETF has MFE >= 1%,
    // give it room. Lock just 50% of MFE (was 65%) and accept 60% trail
    // giveback (was 45%). The whole point of riding a runner is to let
    // it work through corrective waves.
    ride_runner_lock_pct: 0.50,
    ride_runner_trail_pct: 0.60,
    // Tighten params (mid-state) — modest tightening, not strangulation.
    tighten_lock_pct: 0.65,    // was 0.75
    tighten_trail_pct: 0.40,    // was 0.30
  },

  // ─── Stagnant-exit (last resort only) ───
  // 2026-06-04 — Operator: IWM should have HELD; levels/TP/SL/doctrine
  // own the exit. Stagnant fires only on old, genuinely stuck losers.
  // Stock default: phase_i_mfe_dead_money_24h @ MFE<1%.
  stagnant_exit: {
    min_age_hours: 16,                    // no stagnant cut in first 16h
    min_loss_pct: -0.5,                   // must be <= -0.5% (not flat chop)
    dead_money_max_age_hours: 24,         // align with stock dead-money horizon
    dead_money_max_mfe_pct: 0.004,        // 0.4% MFE — never really moved
    // Early fast-cut disabled — was cutting valid overnight holds at the open.
    fast_cut_max_age_hours: 999,
    fast_cut_max_mfe_pct: 0.003,
    zero_mfe_max_age_hours: 24,           // was 6h "fast_cut_zero_mfe"
    zero_mfe_max_mfe_pct: 0.0005,         // 0.05%
  },

  // ─── Sizing modifier (smaller positions, ETFs are lower-variance) ───
  // Per user: don't change sizing for ETFs yet (defer until we see
  // P&L improvement from management changes).
  size_multiplier: 1.0,
};

// ─────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────

/**
 * Is the given ticker managed under the ETF profile?
 */
export function isEtfProfileTicker(ticker) {
  if (!ticker) return false;
  return ETF_PROFILE_TICKERS.has(String(ticker).toUpperCase());
}

/**
 * Get the full ETF profile if the ticker matches, else null.
 * Broad index tickers (SPY/QQQ/IWM) merge per-ticker slow-range overrides.
 */
export function getEtfProfile(ticker) {
  if (!isEtfProfileTicker(ticker)) return null;
  const tk = String(ticker).toUpperCase();
  const idx = INDEX_ETF_OVERRIDES[tk];
  if (!idx) return ETF_PROFILE;
  return {
    ...ETF_PROFILE,
    tp_ladder: { ...ETF_PROFILE.tp_ladder, ...(idx.tp_ladder || {}) },
    stop_loss: { ...ETF_PROFILE.stop_loss, ...(idx.stop_loss || {}) },
    doctrine_overrides: { ...ETF_PROFILE.doctrine_overrides, ...(idx.doctrine_overrides || {}) },
    ride_runner_mfe_pct: idx.ride_runner_mfe_pct ?? 1.0,
  };
}

/**
 * Get just the doctrine overrides for the exit doctrine.
 * Returns null if not an ETF (caller falls back to setup defaults).
 */
export function getEtfDoctrineOverrides(ticker) {
  const profile = getEtfProfile(ticker);
  return profile ? profile.doctrine_overrides : null;
}

/**
 * Compute ETF-specific TP array (overrides ATR-based ladder).
 * Returns null if not an ETF (caller falls back to standard ladder).
 *
 * @param {string} ticker
 * @param {number} entryPrice
 * @param {string} direction LONG/SHORT
 * @returns {Array|null} 3-tier TP array or null
 */
export function buildEtfTpArray(ticker, entryPrice, direction) {
  const profile = getEtfProfile(ticker);
  if (!profile || !Number.isFinite(entryPrice) || entryPrice <= 0) return null;
  const isLong = String(direction).toUpperCase() === "LONG";
  const sign = isLong ? 1 : -1;
  const tp = profile.tp_ladder;
  const trimPx = entryPrice * (1 + sign * tp.trim_pct_target);
  const exitPx = entryPrice * (1 + sign * tp.exit_pct_target);
  const runnerPx = entryPrice * (1 + sign * tp.runner_pct_target);
  return [
    {
      price: trimPx,
      trimPct: tp.trim_pct_at_tp1,
      tier: "TRIM",
      label: `ETF TRIM TP @ +${(tp.trim_pct_target*100).toFixed(2)}%`,
      source: "etf_profile",
      timeframe: "D",
      multiplier: 0,
    },
    {
      price: exitPx,
      trimPct: Math.min(0.95, tp.trim_pct_at_tp1 + tp.trim_pct_at_tp2),
      tier: "EXIT",
      label: `ETF EXIT TP @ +${(tp.exit_pct_target*100).toFixed(2)}%`,
      source: "etf_profile",
      timeframe: "D",
      multiplier: 0,
    },
    {
      price: runnerPx,
      trimPct: 1.0,
      tier: "RUNNER",
      label: `ETF RUNNER TP @ +${(tp.runner_pct_target*100).toFixed(2)}%`,
      source: "etf_profile",
      timeframe: "D",
      multiplier: 0,
    },
  ];
}

/**
 * Compute ETF-tightened stop loss. Returns the stop price, or null
 * if the ticker isn't an ETF.
 *
 * Caller should use this ONLY if the value is tighter than the
 * existing ATR-based stop (we don't want to LOOSEN stops).
 */
export function computeEtfStopLoss(ticker, entryPrice, direction) {
  const profile = getEtfProfile(ticker);
  if (!profile || !Number.isFinite(entryPrice) || entryPrice <= 0) return null;
  const isLong = String(direction).toUpperCase() === "LONG";
  const sign = isLong ? -1 : 1;
  return entryPrice * (1 + sign * profile.stop_loss.max_distance_pct);
}

/**
 * V15 P0.7.66 (2026-05-05) — Tier 2E: ETF ride-runner mode.
 *
 * Once an ETF has cleared MFE >= 1.0%, "the move happened" — the trade
 * is working and should be left to play out via structural exits only
 * (RSI fuses, ST flip, gap fill, peak-lock). Time-based and
 * MFE-decay-based exits should NOT fire.
 *
 * Caller: worker/index.js classifyKanbanStage uses this to suppress
 * non-structural exit rules for ETFs in ride-runner state.
 *
 * @param {string} ticker
 * @param {number} mfePct - max favorable excursion %
 * @param {number} currentPnlPct - current pnl %
 * @returns {{active: boolean, reason: string}|null}
 */
export function isEtfRideRunnerMode(ticker, mfePct, currentPnlPct) {
  const profile = getEtfProfile(ticker);
  if (!profile) return null;
  const _mfe = Number(mfePct) || 0;
  const _pnl = Number(currentPnlPct) || 0;
  const threshold = Number(profile.ride_runner_mfe_pct) || 1.0;
  if (_mfe >= threshold && _pnl > 0) {
    return {
      active: true,
      reason: `etf_ride_runner: mfe=${_mfe.toFixed(2)}%>=${threshold} AND pnl=${_pnl.toFixed(2)}%>0`,
    };
  }
  return { active: false, reason: `etf_not_ride_runner: mfe=${_mfe.toFixed(2)}% pnl=${_pnl.toFixed(2)}%` };
}

/* 2026-06-01 — Higher-timeframe context gate.

   Per operator audit of the DIA LONG closed at +0.28% on 2026-06-01:
   the fast_cut_zero_mfe branch fired correctly by its own logic
   (4h elapsed + MFE < 0.05%), but the rule didn't consider that
   Monthly SuperTrend was bullish, Daily was above the 200 EMA, and the
   30m TF was coiling (squeeze) — constructive consolidation, not
   stagnation. DIA broke out immediately after the exit.

   The fix: when a LONG ETF position is in HTF-bullish + actively-coiling
   conditions (or a SHORT ETF in HTF-bearish + coiling), the fast-cut
   defers — let the breakout resolve. The dead-money and pnl-negative
   fast-cut paths are unchanged (those fire when the trade is BOTH slow
   AND losing — that's genuine stagnation, not coil-before-break).

   Inputs are optional. Callers that don't pass `htfContext` get the
   original behavior (backward-compatible). htfContext shape:
     {
       direction:        "LONG" | "SHORT",
       monthly_bull:     boolean, // monthly_bundle.supertrend_dir === -1
       monthly_bear:     boolean, // monthly_bundle.supertrend_dir === 1
       above_d_ema200:   boolean, // daily_structure.above_e200
       below_d_ema200:   boolean,
       squeeze_active:   boolean, // any TF sq.s === 1 or sq.c === 1
     }

   Defer rule (2026-06-04 — relaxed):
     LONG  + monthly_bull + above_d_ema200 → DEFER (squeeze optional)
     SHORT + monthly_bear + below_d_ema200 → DEFER
     Either direction + squeeze_active + HTF monthly aligned → DEFER

   Rationale: flat overnight ETF longs in a bullish structure are
   coil-before-break, not dead money — let TP/SL/levels decide. */
function shouldDeferOnHtfContext(htfContext) {
  if (!htfContext || typeof htfContext !== "object") return false;
  const dir = String(htfContext.direction || "").toUpperCase();
  const squeeze = !!htfContext.squeeze_active;
  if (dir === "LONG") {
    if (htfContext.monthly_bull && htfContext.above_d_ema200) return true;
    if (squeeze && htfContext.monthly_bull) return true;
  }
  if (dir === "SHORT") {
    if (htfContext.monthly_bear && htfContext.below_d_ema200) return true;
    if (squeeze && htfContext.monthly_bear) return true;
  }
  return false;
}

/**
 * Should the ETF stagnant-exit fire?
 * Returns null if not an ETF, otherwise an object with {fire, reason}.
 *
 * V15 P0.7.64 (2026-05-05) — bug fix per user feedback on Mar-18 SPY SHORT.
 * Previously the rule only checked age + MFE, so a winning trade with
 * small-but-positive MFE got cut at its high water mark even though the
 * thesis was working. Mar-18 SPY SHORT cut at +0.20% pnl right before
 * price dropped another 0.7% — left meaningful profit on the table.
 *
 * 2026-06-01 — Added optional htfContext gate so a LONG ETF in a
 * bullish HTF + active squeeze defers the fast_cut_zero_mfe branch.
 * See shouldDeferOnHtfContext above + the DIA 2026-06-01 audit.
 *
 * Logic (2026-06-04 — last-resort stagnant):
 *  - Never fire before min_age_hours (levels/TP/SL manage young holds).
 *  - Never fire if pnl > min_loss_pct (flat/small red holds through chop).
 *  - Never fire if profitable.
 *  - HTF-aligned structure defers all branches (coil-before-break).
 *  - Only dead_money + zero_mfe after long age, both requiring real loss.
 */
export function checkEtfStagnantExit(ticker, mfePct, ageHours, currentPnlPct = null, htfContext = null) {
  const profile = getEtfProfile(ticker);
  if (!profile) return null;
  const stag = profile.stagnant_exit;
  const _mfeAbs = Math.abs(Number(mfePct) || 0) / 100; // mfePct is in %, convert
  const _age = Number(ageHours) || 0;
  const _pnl = currentPnlPct == null ? null : Number(currentPnlPct);
  const _minAge = Number(stag.min_age_hours) || 16;
  const _minLoss = Number(stag.min_loss_pct) ?? -0.5;

  if (_age < _minAge) {
    return { fire: false, reason: `etf_stagnant_too_young: age=${_age.toFixed(1)}h<${_minAge}h (TP/SL/levels first)` };
  }

  if (shouldDeferOnHtfContext(htfContext)) {
    return {
      fire: false,
      reason: `etf_stagnant_DEFERRED_htf_structure: age=${_age.toFixed(1)}h — HTF aligned, let price action resolve`,
    };
  }

  if (_pnl != null && _pnl > 0) {
    return { fire: false, reason: `etf_stagnant_skip_winning_trade: pnl=${_pnl.toFixed(2)}%>0` };
  }

  if (_pnl != null && _pnl > _minLoss) {
    return {
      fire: false,
      reason: `etf_stagnant_skip_flat_chop: pnl=${_pnl.toFixed(2)}%>${_minLoss}% (need meaningful loss or level hit)`,
    };
  }

  const _zeroAge = Number(stag.zero_mfe_max_age_hours) || 24;
  const _zeroMfe = Number(stag.zero_mfe_max_mfe_pct) || 0.0005;
  if (_age >= _zeroAge && _mfeAbs < _zeroMfe && _pnl != null && _pnl <= _minLoss) {
    return {
      fire: true,
      reason: `etf_zero_mfe_loser: age=${_age.toFixed(1)}h>=${_zeroAge}h mfe=${(_mfeAbs * 100).toFixed(3)}% pnl=${_pnl.toFixed(2)}%<=${_minLoss}%`,
    };
  }

  // Legacy fast_cut branch — disabled via fast_cut_max_age_hours=999 in profile.
  if (_age >= stag.fast_cut_max_age_hours && _mfeAbs < stag.fast_cut_max_mfe_pct) {
    if (_pnl != null && _pnl <= _minLoss) {
      return {
        fire: true,
        reason: `etf_fast_cut: age=${_age.toFixed(1)}h mfe=${(_mfeAbs * 100).toFixed(2)}% pnl=${_pnl.toFixed(2)}%`,
      };
    }
  }

  if (_age >= stag.dead_money_max_age_hours && _mfeAbs < stag.dead_money_max_mfe_pct) {
    if (_pnl != null && _pnl <= _minLoss) {
      return {
        fire: true,
        reason: `etf_dead_money: age=${_age.toFixed(1)}h>=${stag.dead_money_max_age_hours}h mfe=${(_mfeAbs * 100).toFixed(2)}% pnl=${_pnl.toFixed(2)}%<=${_minLoss}%`,
      };
    }
  }
  return { fire: false };
}

// Re-export sets for diagnostics / future tooling
export const ETF_TICKER_SETS = {
  broad_index: ETF_BROAD_INDEX,
  sector: ETF_SECTOR,
  thematic: ETF_THEMATIC,
  leveraged_treated_as_stocks: ETF_LEVERAGED_STOCKS_FOR_NOW,
  volatility_treated_as_stocks: ETF_VOLATILITY_STOCKS_FOR_NOW,
  crypto_treated_as_stocks: ETF_CRYPTO_STOCKS_FOR_NOW,
  managed_under_profile: ETF_PROFILE_TICKERS,
};

export default {
  isEtfProfileTicker,
  getEtfProfile,
  getEtfDoctrineOverrides,
  buildEtfTpArray,
  computeEtfStopLoss,
  checkEtfStagnantExit,
  isEtfRideRunnerMode,
  ETF_TICKER_SETS,
};
