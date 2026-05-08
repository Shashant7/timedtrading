/**
 * worker/trend-hold.js
 *
 * Phase C — Stage 2 (2026-05-08) — Trend-Hold hybrid lifecycle module.
 *
 * Promotes "Active Trader" winners to a managed-runner state when:
 *   1. The trade has worked (MFE >= +5%), AND
 *   2. The trend is intact across 3 close-discipline filters
 *      (weekly EMA-21, daily EMA-21, 4H EMA-21), AND
 *   3. Higher-timeframe SuperTrend confirms (weekly + monthly bull), AND
 *   4. No exhaustion (weekly TD9 sell-9, RSI-W extreme), AND
 *   5. Sector rating is not underweight, AND
 *   6. Not in pre-earnings window (≤ 3 days), AND
 *   7. Not already mostly trimmed (trimmed_pct < 0.5).
 *
 * While `trend_hold_state === "active"`, the management profile changes:
 *   - Suppress 5 premature-exit doctrines that fired most on the
 *     Trend-Hold-candidate cohort during the Phase C run:
 *       HARD_FUSE_RSI_EXTREME
 *       PROFIT_GIVEBACK_STAGE_HOLD
 *       SMART_RUNNER_SUPPORT_BREAK_CLOUD
 *       mfe_decay_structural_flatten
 *       ST_FLIP_4H_CLOSE   (flip on the 4H is too tactical for a runner)
 *   - DCA-the-dip on cloud reclaim (RESILIENT_TREND only).
 *   - Trail = weekly EMA-21 close-break (not daily ATR-multiple).
 *
 * Demotion (drop back to Active Trader management) when ANY of:
 *   - 2+ consecutive weekly closes below EMA-21 (PRIMARY)
 *   - Weekly TD9 sell-setup count >= 9 (exhaustion confirmed)
 *   - Monthly SuperTrend flips bear
 *   - Macro shock: SPY -3% in single session OR VIX > 35
 *   - Cascade flip: weekly + daily + 4H all close below EMA-21
 *
 * All thresholds are tunable via `model_config` and `KV phase-c:trend-hold`.
 *
 * The module is pure (no I/O). Caller is responsible for hydrating the
 * `tickerData` snapshot (signal context) and reading the trade row.
 *
 * FEATURE FLAG: `daCfg.deep_audit_trend_hold_enabled === "true"` to enable.
 * Default is "false" — schema is forward-compatible but the feature is
 * dark until Phase 3 backtest validation.
 *
 * Source-of-truth findings driving these thresholds:
 *   tasks/phase-c/accumulation-trend-deep-dive.md
 *   tasks/phase-c/cohort-segmentation.md
 */

// ─────────────────────────────────────────────────────────────────────
// Default configuration (overridable via model_config / KV)
// ─────────────────────────────────────────────────────────────────────
export const DEFAULT_TREND_HOLD_CONFIG = Object.freeze({
  // ── Promotion gates ────────────────────────────────────────────────
  promote_min_mfe_pct: 5.0,
  // Weekly + Daily + 4H close >= EMA-21 are required at promotion.
  // (Daily 5/12 cloud is NOT a promotion gate — only 54% of TH
  // candidates were above-cloud at oracle entry; many accumulate inside
  // the cloud. Cloud is for DCA / re-entry, not promotion.)
  promote_require_weekly_ema21: true,
  promote_require_daily_ema21: true,
  promote_require_4h_ema21: true,
  promote_require_weekly_supertrend_bull: true,
  promote_require_monthly_supertrend_bull: true,
  promote_max_weekly_td9_sell_count: 8, // < 9 = not at exhaustion
  promote_max_weekly_rsi: 88,           // exhaustion guard on weekly RSI
  promote_min_days_to_earnings: 3,
  promote_disallow_underweight_sector: true,
  promote_max_trimmed_pct: 0.5,
  // Anti-thrash: a freshly demoted trade can't immediately re-promote.
  promote_cooldown_after_demote_ms: 6 * 60 * 60 * 1000, // 6h

  // ── Demotion gates (any one fires) ─────────────────────────────────
  demote_consecutive_weekly_closes_below_ema21: 2,
  demote_on_weekly_td9_sell_setup_complete: 9, // >= 9
  demote_on_monthly_supertrend_bear: true,
  demote_on_cascade_flip: true,
  demote_on_macro_shock: true,
  demote_spy_single_day_drop_pct: -3.0,
  demote_vix_threshold: 35.0,

  // ── DCA-the-dip trigger (RESILIENT_TREND only) ─────────────────────
  dca_enabled_for_flavor: ["RESILIENT_TREND"],
  dca_require_weekly_ema21_intact: true,
  dca_require_cloud_reclaim: true,
  dca_max_pullback_pct: -10.0, // pullback from avg_entry must be >= -10%
  dca_min_seconds_between_adds: 24 * 60 * 60,

  // ── Position cap (per user direction: 5-7 to start) ────────────────
  max_simultaneous_positions: 6,
  // Drop policy when a 7th candidate qualifies and cap is reached:
  //   "drop_lowest_mfe"   — demote the active TH with lowest MFE
  //   "block_new"         — refuse to promote (defer to next tick)
  cap_overflow_policy: "drop_lowest_mfe",

  // ── Exit-doctrine suppression list (active only when state=active) ─
  // These are the doctrines we determined as premature on the
  // Trend-Hold candidate cohort. Suppressed → routes through demotion
  // path instead (which only fires on the structural breaks above).
  suppressed_exit_reasons: [
    "HARD_FUSE_RSI_EXTREME",
    "PROFIT_GIVEBACK_STAGE_HOLD",
    "PROFIT_GIVEBACK_COOLING_HOLD",
    "SMART_RUNNER_SUPPORT_BREAK_CLOUD",
    "mfe_decay_structural_flatten",
    "ST_FLIP_4H_CLOSE",
    "doctrine_giveback",
    "fresh_failure",
    "stagnant_exit",
  ],
});

// ─────────────────────────────────────────────────────────────────────
// Config loader — reads daCfg overrides for the user-tunable knobs.
//
// The KV-backed override path (phase-c:trend-hold) is expected later
// when we want per-environment tuning without redeploys; for now we
// read the simple feature-flag flavors out of daCfg.
// ─────────────────────────────────────────────────────────────────────
export function loadTrendHoldConfig(daCfg) {
  const cfg = { ...DEFAULT_TREND_HOLD_CONFIG };
  if (!daCfg || typeof daCfg !== "object") return cfg;
  // Position cap override (user-facing tunable).
  const capOverride = Number(daCfg.deep_audit_trend_hold_max_positions);
  if (Number.isFinite(capOverride) && capOverride > 0 && capOverride <= 50) {
    cfg.max_simultaneous_positions = capOverride;
  }
  return cfg;
}

export function isTrendHoldEnabled(daCfg) {
  return String(daCfg?.deep_audit_trend_hold_enabled ?? "false") === "true";
}

// ─────────────────────────────────────────────────────────────────────
// Snapshot extractor — normalize the dirty `tickerData` shape into a
// minimal predicate input. Returns null if essential signals missing.
//
// All values are CLOSE-discipline (per user direction) — the upstream
// indicator pipeline already computes ema21 / stDir / etc. on bar
// closes only.
//
// SUPERTREND SIGN-CONVENTION NORMALIZATION (critical):
//   The worker stores SuperTrend with TWO different conventions:
//     * tf_tech.{D,W,4H,M}.stDir       → PINE convention: -1 = BULL, +1 = BEAR
//                                        (see worker/indicators.js stFlipDir;
//                                         worker/index.js line ~33180:
//                                         "_stDBull = stDir === -1")
//     * monthly_bundle.supertrend_dir  → STANDARD:         +1 = BULL, -1 = BEAR
//                                        (see worker/investor.js line ~67:
//                                         "if (mb.supertrend_dir === 1)
//                                          components.monthlyTrend += 7")
//   We normalize ALL values in the snapshot to the standard convention
//   (+1 = bull, -1 = bear) so downstream predicates read as `stDir === 1`
//   for bull regardless of source. tfTechStDir() inverts the Pine sign;
//   bundleStDir() passes through.
// ─────────────────────────────────────────────────────────────────────
export function extractTrendSnapshot(tickerData, openPosition) {
  if (!tickerData || typeof tickerData !== "object") return null;
  const tt = tickerData.tf_tech || {};
  const td = tickerData.td_sequential?.per_tf || {};

  const close = num(tickerData.priceClose ?? tickerData.close ?? tickerData.price);

  const dailyEma21 = num(tt.D?.ema21);
  const dailyStDir = tfTechStDir(tt.D?.stDir);

  const weeklyEma21 = num(tt.W?.ema21);
  const weeklyStDir = tfTechStDir(tt.W?.stDir);

  const fourHEma21 = num(tt["4H"]?.ema21);

  // Monthly: prefer monthly_bundle.supertrend_dir (STANDARD convention),
  // fall back to tf_tech.M.stDir (PINE convention, inverted via
  // tfTechStDir()).
  const monthlyStDir = bundleStDir(tickerData.monthly_bundle?.supertrend_dir)
    ?? tfTechStDir(tt.M?.stDir);

  // Weekly RSI / TD9 sell-setup count.
  const weeklyRsi = num(tt.W?.rsi);
  // td_sequential reports "bearish_prep_count" as the bullish-exhaustion
  // (sell-setup) count by their convention — see worker/index.js
  // ~line 29830. Sell-setup = TD9 sell pattern = bearish-prep.
  const weeklyTd9SellCount = num(td.W?.bearish_prep_count) ?? 0;

  const dailyRsi = num(tt.D?.rsi);
  const fourHRsi = num(tt["4H"]?.rsi);

  // Daily 5/12 cloud status (close vs min(EMA5, EMA12)).
  const dailyEma5 = num(tt.D?.ema5);
  const dailyEma12 = num(tt.D?.ema12);
  let cloudStatus = null;
  if (close != null && dailyEma5 != null && dailyEma12 != null) {
    const floor = Math.min(dailyEma5, dailyEma12);
    const ceil = Math.max(dailyEma5, dailyEma12);
    if (close >= ceil) cloudStatus = "above";
    else if (close <= floor) cloudStatus = "below";
    else cloudStatus = "inside";
  }

  // Macro context.
  const spyDayChangePct = num(tickerData.spy_day_change_pct ?? tickerData.spyDayChangePct);
  const vixLevel = num(tickerData.vix_level ?? tickerData.vix);

  // Sector rating ("OW" / "DOUBLE_OW" / "NEUTRAL" / "UW" / null).
  const sectorRating = String(
    tickerData.sector_rating || tickerData.sectorRating || ""
  ).toUpperCase() || null;

  // Days to next earnings (calendar — caller must populate).
  const daysToEarnings = num(tickerData.days_to_earnings ?? tickerData.daysToEarnings);

  // Streak: consecutive weekly closes below EMA-21 ending now.
  // Caller may supply this directly; otherwise derive from a recent
  // weekly close history if present.
  const consecutiveWeeklyBelow = num(
    tickerData.weekly_consecutive_closes_below_ema21
    ?? tickerData.weekly_below_streak
  ) ?? 0;

  // Position open-trade fields (for promotion gating).
  const trade = openPosition || {};
  const mfePct = num(trade.maxFavorableExcursion ?? trade.max_favorable_excursion ?? trade.mfe ?? trade.mfe_pct);
  const trimmedPct = num(trade.trimmed_pct ?? trade.trimmedPct) ?? 0;
  const direction = String(trade.direction || "").toUpperCase();

  return {
    ticker: String(tickerData.ticker || trade.ticker || "").toUpperCase(),
    close,
    direction,
    mfePct,
    trimmedPct,
    daily: {
      ema21: dailyEma21,
      ema21_above: close != null && dailyEma21 != null ? close >= dailyEma21 : null,
      ema5: dailyEma5,
      ema12: dailyEma12,
      cloud_status: cloudStatus,
      stDir: dailyStDir,
      rsi: dailyRsi,
    },
    weekly: {
      ema21: weeklyEma21,
      ema21_above: close != null && weeklyEma21 != null ? close >= weeklyEma21 : null,
      stDir: weeklyStDir,
      rsi: weeklyRsi,
      td9_sell_count: weeklyTd9SellCount,
      consecutive_below_ema21: consecutiveWeeklyBelow,
    },
    fourH: {
      ema21: fourHEma21,
      ema21_above: close != null && fourHEma21 != null ? close >= fourHEma21 : null,
      rsi: fourHRsi,
    },
    monthly: { stDir: monthlyStDir },
    macro: {
      spy_day_change_pct: spyDayChangePct,
      vix: vixLevel,
    },
    sector_rating: sectorRating,
    days_to_earnings: daysToEarnings,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Pure predicates
// ─────────────────────────────────────────────────────────────────────

/**
 * Promotion gate. Returns `{ promote: boolean, reason: string, flavor: string|null }`.
 * `flavor` is "CLEAN_TREND" if max DD on the trade so far is shallow AND
 * 4H is above EMA-21 (low-vol grinder), else "RESILIENT_TREND".
 */
export function shouldPromoteToTrendHold(snap, trade, cfg) {
  const c = cfg || DEFAULT_TREND_HOLD_CONFIG;
  if (!snap || !trade) return reject("no_snapshot");

  // Only LONG promotions for now — Trend-Hold is structurally a long-trend
  // hybrid; shorts are typically faster-cycle.
  if (snap.direction !== "LONG") return reject(`direction=${snap.direction} not_long`);

  // 1. MFE proves the setup worked.
  if (snap.mfePct == null || snap.mfePct < c.promote_min_mfe_pct) {
    return reject(`mfe=${fmt(snap.mfePct)}<${c.promote_min_mfe_pct}`);
  }

  // 2. Trend filter agreement (closes-only) — weekly + daily + 4H.
  if (c.promote_require_weekly_ema21 && snap.weekly.ema21_above !== true) {
    return reject(`weekly_ema21_below_close`);
  }
  if (c.promote_require_daily_ema21 && snap.daily.ema21_above !== true) {
    return reject(`daily_ema21_below_close`);
  }
  if (c.promote_require_4h_ema21 && snap.fourH.ema21_above !== true) {
    return reject(`4h_ema21_below_close`);
  }

  // 3. Higher-timeframe SuperTrend confirms.
  if (c.promote_require_weekly_supertrend_bull && snap.weekly.stDir !== 1) {
    return reject(`weekly_st_not_bull (dir=${snap.weekly.stDir})`);
  }
  if (c.promote_require_monthly_supertrend_bull && snap.monthly.stDir !== 1) {
    return reject(`monthly_st_not_bull (dir=${snap.monthly.stDir})`);
  }

  // 4. No exhaustion.
  if (
    snap.weekly.td9_sell_count != null &&
    snap.weekly.td9_sell_count > c.promote_max_weekly_td9_sell_count
  ) {
    return reject(`weekly_td9_sell_at_${snap.weekly.td9_sell_count}>=${c.promote_max_weekly_td9_sell_count + 1}`);
  }
  if (snap.weekly.rsi != null && snap.weekly.rsi >= c.promote_max_weekly_rsi) {
    return reject(`weekly_rsi_${fmt(snap.weekly.rsi)}>=${c.promote_max_weekly_rsi}`);
  }

  // 5. Sector rating not underweight.
  if (
    c.promote_disallow_underweight_sector &&
    snap.sector_rating &&
    /^UW|UNDERWEIGHT/.test(snap.sector_rating)
  ) {
    return reject(`sector_rating=${snap.sector_rating}`);
  }

  // 6. Pre-earnings guard.
  if (
    snap.days_to_earnings != null &&
    snap.days_to_earnings >= 0 &&
    snap.days_to_earnings < c.promote_min_days_to_earnings
  ) {
    return reject(`days_to_earnings=${snap.days_to_earnings}<${c.promote_min_days_to_earnings}`);
  }

  // 7. Not already mostly trimmed.
  if (snap.trimmedPct != null && snap.trimmedPct >= c.promote_max_trimmed_pct) {
    return reject(`trimmed_pct=${fmt(snap.trimmedPct)}>=${c.promote_max_trimmed_pct}`);
  }

  // 8. Cooldown after recent demotion (anti-thrash).
  const demotedAt = num(trade.trend_hold_demoted_at);
  if (demotedAt != null && Date.now() - demotedAt < c.promote_cooldown_after_demote_ms) {
    return reject(`cooldown_after_demote ${Math.round((Date.now() - demotedAt) / 1000)}s<${c.promote_cooldown_after_demote_ms / 1000}s`);
  }

  // Flavor: CLEAN_TREND if 4H is bull AND daily 5/12 cloud is above AND
  // RSI-W moderate (not at extreme); else RESILIENT_TREND.
  const isClean =
    snap.fourH.ema21_above === true &&
    snap.daily.cloud_status === "above" &&
    (snap.weekly.rsi == null || snap.weekly.rsi < 75);
  const flavor = isClean ? "CLEAN_TREND" : "RESILIENT_TREND";

  return {
    promote: true,
    reason: `mfe=${fmt(snap.mfePct)}% wkEMA21↑ dEMA21↑ 4hEMA21↑ wkST=bull mST=bull wkTD9=${snap.weekly.td9_sell_count ?? 0}<${c.promote_max_weekly_td9_sell_count + 1}`,
    flavor,
  };
}

/**
 * Demotion gate. Fires when ANY structural break is detected.
 * Returns `{ demote, reason }`.
 */
export function shouldDemoteFromTrendHold(snap, trade, cfg) {
  const c = cfg || DEFAULT_TREND_HOLD_CONFIG;
  if (!snap || !trade) return { demote: false, reason: "no_snapshot" };

  // PRIMARY: macro trend break — 2+ consecutive weekly closes below EMA-21.
  if (
    snap.weekly.consecutive_below_ema21 != null &&
    snap.weekly.consecutive_below_ema21 >= c.demote_consecutive_weekly_closes_below_ema21
  ) {
    return demote(`weekly_below_ema21_streak=${snap.weekly.consecutive_below_ema21}>=${c.demote_consecutive_weekly_closes_below_ema21}`);
  }

  // Weekly TD9 sell setup completed (>= 9) — exhaustion confirmed.
  if (
    snap.weekly.td9_sell_count != null &&
    snap.weekly.td9_sell_count >= c.demote_on_weekly_td9_sell_setup_complete
  ) {
    return demote(`weekly_td9_sell_setup_complete=${snap.weekly.td9_sell_count}`);
  }

  // Monthly SuperTrend flips bear.
  if (c.demote_on_monthly_supertrend_bear && snap.monthly.stDir === -1) {
    return demote(`monthly_supertrend_bear`);
  }

  // Cascade flip: weekly + daily + 4H all below EMA-21 (close-discipline).
  if (
    c.demote_on_cascade_flip &&
    snap.weekly.ema21_above === false &&
    snap.daily.ema21_above === false &&
    snap.fourH.ema21_above === false
  ) {
    return demote(`cascade_flip_w_d_4h_all_below_ema21`);
  }

  // Macro shock: SPY -3% single session OR VIX > 35.
  if (c.demote_on_macro_shock) {
    if (snap.macro.spy_day_change_pct != null && snap.macro.spy_day_change_pct <= c.demote_spy_single_day_drop_pct) {
      return demote(`spy_drop=${fmt(snap.macro.spy_day_change_pct)}%<=${c.demote_spy_single_day_drop_pct}`);
    }
    if (snap.macro.vix != null && snap.macro.vix >= c.demote_vix_threshold) {
      return demote(`vix=${fmt(snap.macro.vix)}>=${c.demote_vix_threshold}`);
    }
  }

  return { demote: false, reason: "all_structural_filters_intact" };
}

/**
 * DCA-the-dip trigger. RESILIENT_TREND only.
 *
 * Fires when:
 *   - daily close was BELOW the 5/12 cloud last bar AND is ABOVE the
 *     cloud now (cloud reclaim, close-discipline)
 *   - weekly EMA-21 still intact
 *   - pullback from avg_entry >= -10%
 *   - cooldown since last DCA respected
 *
 * Caller must supply `prev_daily_cloud_status` on the snapshot for
 * the reclaim detection (we only see the current snapshot here).
 */
export function shouldDcaTrendHold(snap, trade, cfg) {
  const c = cfg || DEFAULT_TREND_HOLD_CONFIG;
  if (!snap || !trade) return { dca: false, reason: "no_snapshot" };
  if (trade.trend_hold_state !== "active") return { dca: false, reason: "not_active" };
  if (!c.dca_enabled_for_flavor.includes(trade.trend_hold_flavor)) {
    return { dca: false, reason: `flavor=${trade.trend_hold_flavor} not_in_dca_list` };
  }

  if (c.dca_require_weekly_ema21_intact && snap.weekly.ema21_above !== true) {
    return { dca: false, reason: "weekly_ema21_broken" };
  }

  // Cloud reclaim detection.
  if (c.dca_require_cloud_reclaim) {
    if (snap.daily.cloud_status !== "above") return { dca: false, reason: `cloud_status=${snap.daily.cloud_status} not_above` };
    if (snap.prev_daily_cloud_status !== "below") {
      return { dca: false, reason: `prev_cloud=${snap.prev_daily_cloud_status} not_below (no reclaim)` };
    }
  }

  // Pullback from average entry.
  const avgEntry = num(trade.avgEntry ?? trade.avg_entry ?? trade.entryPrice ?? trade.entry_price);
  if (avgEntry == null || snap.close == null) return { dca: false, reason: "no_price_data" };
  const pullbackPct = (snap.close / avgEntry - 1) * 100;
  if (pullbackPct < c.dca_max_pullback_pct) {
    return { dca: false, reason: `pullback=${fmt(pullbackPct)}%<${c.dca_max_pullback_pct}% (too deep)` };
  }

  // Cooldown.
  const lastDca = num(trade.last_dca_ts ?? trade.lastDcaTs);
  if (lastDca != null && (Date.now() - lastDca) / 1000 < c.dca_min_seconds_between_adds) {
    return { dca: false, reason: `dca_cooldown` };
  }

  return { dca: true, reason: `cloud_reclaim wkEMA21↑ pullback=${fmt(pullbackPct)}%` };
}

/**
 * Helper: is this trade currently in active Trend-Hold state?
 * Defensive against missing/legacy schema (returns false if column
 * isn't present yet).
 */
export function isTrendHoldActive(trade) {
  return !!trade && String(trade.trend_hold_state || "").toLowerCase() === "active";
}

/**
 * Wrap a base exit decision with Trend-Hold suppression rules.
 *
 * @param {object} trade           — open trade row (must have trend_hold_state)
 * @param {string} proposedReason  — exit reason the caller would otherwise emit
 * @param {object} cfg             — TrendHold config
 * @returns {object} { suppress: boolean, reason: string }
 *   When `suppress` is true the caller should NOT execute the exit.
 *   The structural demotion path (shouldDemoteFromTrendHold) is the
 *   only thing that closes a Trend-Hold position via demotion.
 */
export function evaluateExitSuppression(trade, proposedReason, cfg) {
  const c = cfg || DEFAULT_TREND_HOLD_CONFIG;
  if (!isTrendHoldActive(trade)) return { suppress: false, reason: "not_active" };
  if (!proposedReason) return { suppress: false, reason: "no_reason" };
  const r = String(proposedReason);
  for (const banned of c.suppressed_exit_reasons) {
    if (r === banned) {
      return {
        suppress: true,
        reason: `trend_hold_active_suppress(${r})`,
      };
    }
  }
  return { suppress: false, reason: "not_in_suppress_list" };
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────
function reject(reason) { return { promote: false, reason, flavor: null }; }
function demote(reason) { return { demote: true, reason }; }

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalize a tf_tech.{D,W,4H,M}.stDir reading.
 * Pine convention used in worker/indicators.js:
 *   stDir = -1  →  bull   →  return +1 (standard)
 *   stDir = +1  →  bear   →  return -1
 *   stDir =  0  →  flat   →  return  0
 */
function tfTechStDir(v) {
  const n = Number(v);
  if (n === -1) return 1;
  if (n === 1) return -1;
  if (n === 0) return 0;
  return null;
}

/**
 * Normalize a monthly_bundle.supertrend_dir reading.
 * Standard convention used in worker/investor.js:
 *   supertrend_dir = +1  →  bull   →  return +1
 *   supertrend_dir = -1  →  bear   →  return -1
 *   supertrend_dir =  0  →  flat   →  return  0
 */
function bundleStDir(v) {
  const n = Number(v);
  if (n === 1) return 1;
  if (n === -1) return -1;
  if (n === 0) return 0;
  return null;
}
function fmt(x, dp = 2) {
  if (x == null || !Number.isFinite(x)) return String(x);
  const m = Math.pow(10, dp);
  return String(Math.round(x * m) / m);
}
