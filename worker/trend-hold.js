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
  // V15 P0.7.123 (2026-05-10) — Phase 3.8: raise from 0.5 to 0.85.
  // The first preprod backtest run discovered that the existing TP ladder
  // trims trades to 50%+ remaining BEFORE the TH lifecycle eval block
  // gets a chance to evaluate (per-tick ordering in
  // processTradeSimulation: MFE update → TH eval → exit doctrine →
  // TP/trim logic). All 20 MFE ≥ 5% candidates in that run had
  // trimmed_pct in [0.5, 1.0], so the original 0.5 cap rejected
  // 100% of TH-eligible trades.
  //
  // Raising to 0.85 captures partially-trimmed runners (50-85%
  // trimmed) that still have meaningful upside left. Above 85%
  // trimmed, the position is too small to materially benefit from
  // suppression of the giveback exits.
  //
  // Longer-term refinement (Phase 3.9): move TH eval BEFORE the TP
  // ladder fires, so promotion can happen at first MFE >= 5% before
  // any trim. Tracked in PRE_PROD_ENV_RUNBOOK.md follow-ups.
  promote_max_trimmed_pct: 0.85,
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
// SUPERTREND SIGN-CONVENTION (verified empirically against day-state KV):
//   ALL persisted SuperTrend values use PINE convention:
//     * tf_tech.{D,W,4H,M}.stDir       → -1 = BULL, +1 = BEAR
//     * monthly_bundle.supertrend_dir  → -1 = BULL, +1 = BEAR
//
//   Verification: timed:replay:daystate:2025-07-01 shows AAPL/MSFT/SPY/
//   QQQ/NVDA/META/GOOGL all with monthly_bundle.supertrend_dir === -1
//   during a clear monthly-bull period.
//
//   Confirmation in worker code:
//     - worker/indicators.js stFlipDir (Pine source)
//     - worker/index.js line 33333: investor entry gate
//       `_stMBull = c.td?.monthly_bundle?.supertrend_dir === -1`
//   (The misleading comment "1 = bullish" at indicators.js:5050 is a
//    code-comment bug — bM.stDir comes from the same Pine SuperTrend
//    pipeline as every other stDir, all Pine convention.)
//
//   We normalize ALL values to STANDARD convention (+1 = bull, -1 = bear)
//   in the snapshot so downstream predicates read as `stDir === 1` for
//   bull. Both tfTechStDir() and bundleStDir() invert the Pine sign.
//
// EMA / RSI ACCESS SHAPE:
//   The worker persists tf_tech with NESTED ema/rsi objects, NOT flat
//   numeric fields:
//     tf_tech.{TF}.ema.priceAboveEma21   ← derived bool (canonical)
//     tf_tech.{TF}.ema.depth/structure/momentum/stack
//     tf_tech.{TF}.rsi.r5                ← canonical RSI access
//   See worker/indicators.js line ~4664 (priceAboveEma21 derivation)
//   and the persisted day-state KV blob shape inspected at
//   timed:replay:daystate:YYYY-MM-DD.
//
//   We prefer the derived `priceAboveEma21` boolean. If absent (older
//   day-states or alternate ingest paths) we fall back to computing
//   `close >= ema21` from raw numeric fields if both exist.
// ─────────────────────────────────────────────────────────────────────
export function extractTrendSnapshot(tickerData, openPosition) {
  if (!tickerData || typeof tickerData !== "object") return null;
  const tt = tickerData.tf_tech || {};
  const td = tickerData.td_sequential?.per_tf || {};

  const close = num(tickerData.priceClose ?? tickerData.close ?? tickerData.price);

  const dailyEma21Above = readPriceAboveEma21(tt.D, close);
  const dailyStDir = tfTechStDir(tt.D?.stDir);

  const weeklyEma21Above = readPriceAboveEma21(tt.W, close);
  const weeklyStDir = tfTechStDir(tt.W?.stDir);

  const fourHEma21Above = readPriceAboveEma21(tt["4H"], close);

  // Monthly: prefer monthly_bundle.supertrend_dir (STANDARD convention),
  // fall back to tf_tech.M.stDir (PINE convention, inverted via
  // tfTechStDir()). Sparse population is common — many tickers have
  // null monthly_bundle until the monthly bar settles.
  const monthlyStDir = bundleStDir(tickerData.monthly_bundle?.supertrend_dir)
    ?? tfTechStDir(tt.M?.stDir);

  // RSI: tf_tech.*.rsi.r5 is the canonical 5-period RSI; some upstream
  // shapes store rsi as a bare number. Try both.
  const weeklyRsi = num(tt.W?.rsi?.r5 ?? tt.W?.rsi);
  // td_sequential reports "bearish_prep_count" as the bullish-exhaustion
  // (sell-setup) count by their convention — see worker/index.js
  // ~line 29830. Sell-setup = TD9 sell pattern = bearish-prep.
  const weeklyTd9SellCount = num(td.W?.bearish_prep_count) ?? 0;

  const dailyRsi = num(tt.D?.rsi?.r5 ?? tt.D?.rsi);
  const fourHRsi = num(tt["4H"]?.rsi?.r5 ?? tt["4H"]?.rsi);

  // Daily 5/12 cloud status (close vs min(EMA5, EMA12)).
  // Day-state KV doesn't persist EMA-5/12 numerics, but it does persist
  // tt.D.ema.depth which is "close - ema21" in some normalized form.
  // For cohort/replay purposes we treat absent ema5/12 as "unknown
  // cloud status" — caller must populate from a richer pipeline if
  // they want cloud-reclaim DCA to fire.
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
      ema21_above: dailyEma21Above,
      ema5: dailyEma5,
      ema12: dailyEma12,
      cloud_status: cloudStatus,
      stDir: dailyStDir,
      rsi: dailyRsi,
    },
    weekly: {
      ema21_above: weeklyEma21Above,
      stDir: weeklyStDir,
      rsi: weeklyRsi,
      td9_sell_count: weeklyTd9SellCount,
      consecutive_below_ema21: consecutiveWeeklyBelow,
    },
    fourH: {
      ema21_above: fourHEma21Above,
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
  // Weekly is STRICT — there's always enough weekly history; null is anomalous.
  if (c.promote_require_weekly_supertrend_bull && snap.weekly.stDir !== 1) {
    return reject(`weekly_st_not_bull (dir=${snap.weekly.stDir})`);
  }
  // Monthly is PERMISSIVE — recent spinoffs / new IPOs / sparse-history tickers
  // legitimately have null monthly_bundle until enough bars accumulate. Reject
  // only on EXPLICIT bear; allow null / 0 / 1. The stricter D/W/4H trend
  // filters above plus the weekly-st-bull requirement carry sufficient signal.
  if (c.promote_require_monthly_supertrend_bull && snap.monthly.stDir === -1) {
    return reject(`monthly_st_bear (dir=${snap.monthly.stDir})`);
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
 * Read "is close above EMA-21" for one timeframe block.
 *
 * Day-state KV persists this as a derived boolean at `tfBlock.ema.priceAboveEma21`
 * — the canonical access path. Live tickerData usually provides the same shape
 * via the indicator pipeline (worker/indicators.js ~line 4664).
 *
 * Falls back to numeric `tfBlock.ema21` + close comparison if the derived
 * bool is absent. Returns `null` when the timeframe block is missing or empty
 * (e.g. tt.W = {} for tickers with insufficient weekly history).
 */
function readPriceAboveEma21(tfBlock, close) {
  if (!tfBlock || typeof tfBlock !== "object") return null;
  // Empty block → no signal. (Day-state has tt.W = {} for sparse tickers.)
  const ema = tfBlock.ema;
  if (ema && typeof ema === "object" && Object.keys(ema).length > 0) {
    if (typeof ema.priceAboveEma21 === "boolean") return ema.priceAboveEma21;
  }
  // Fallback: numeric ema21 + close.
  const ema21Num = Number(tfBlock.ema21);
  if (Number.isFinite(ema21Num) && close != null) {
    return close >= ema21Num;
  }
  return null;
}

/**
 * Normalize a tf_tech.{D,W,4H,M}.stDir reading.
 * Pine convention used in worker/indicators.js:
 *   stDir = -1  →  bull   →  return +1 (standard)
 *   stDir = +1  →  bear   →  return -1
 *   stDir =  0  →  flat   →  return  0
 *   null/undefined/NaN    →  return null  (signal absent — distinct from "flat")
 */
function tfTechStDir(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (n === -1) return 1;
  if (n === 1) return -1;
  if (n === 0) return 0;
  return null;
}

/**
 * Normalize a monthly_bundle.supertrend_dir reading.
 *
 * Despite the misleading "1 = bullish" comment in
 * worker/indicators.js:5050, monthly_bundle.supertrend_dir is sourced
 * from the same Pine SuperTrend pipeline as tf_tech.*.stDir and uses
 * the same Pine convention. Verified empirically — the investor entry
 * gate at worker/index.js:33333 reads `=== -1` as bull, and that gate
 * fires correctly on real bull-market dates.
 *
 *   supertrend_dir = -1  →  bull   →  return +1 (standard)
 *   supertrend_dir = +1  →  bear   →  return -1
 *   supertrend_dir =  0  →  flat   →  return  0
 *   null/undefined/NaN   →  return null  (signal absent)
 *
 * Currently identical to tfTechStDir() — kept as a separate function
 * so that if the worker schema diverges in future the two access
 * paths can be normalized independently.
 */
function bundleStDir(v) {
  return tfTechStDir(v);
}
function fmt(x, dp = 2) {
  if (x == null || !Number.isFinite(x)) return String(x);
  const m = Math.pow(10, dp);
  return String(Math.round(x * m) / m);
}
