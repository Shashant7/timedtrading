/**
 * Index ETF entry model — SPY / QQQ / IWM only.
 *
 * Indices move slower and trade inside defined daily ranges. They must NOT
 * use stock triggers (ATH breakout, deep pullback ST flips, momentum chase).
 * Each index has its own profile (SPY ≠ QQQ ≠ IWM).
 */

export const DEFAULT_INDEX_MODEL_TICKERS = "SPY,QQQ,IWM";

/** Per-ticker slow-range entry + management hints (entry side). */
export const INDEX_TICKER_PROFILES = {
  SPY: {
    label: "slow_range",
    min_rank: 88,
    rvol_min: 0.45,
    pct_above_e48: [0.4, 2.8],
    e21_slope: [0.12, 1.0],
    allowed_states: ["HTF_BULL_LTF_PULLBACK", "HTF_BULL_LTF_BULL"],
    require_m30_reclaim: false,
    allow_in_cloud: true,
    ride_runner_mfe_pct: 0.6,
    stop_max_pct: 0.005,
  },
  QQQ: {
    label: "moderate_range",
    min_rank: 90,
    rvol_min: 0.55,
    pct_above_e48: [0.6, 3.5],
    e21_slope: [0.18, 1.5],
    allowed_states: ["HTF_BULL_LTF_PULLBACK", "HTF_BULL_LTF_BULL"],
    require_m30_reclaim: false,
    allow_in_cloud: true,
    ride_runner_mfe_pct: 0.7,
    stop_max_pct: 0.006,
  },
  IWM: {
    label: "wide_range",
    min_rank: 90,
    rvol_min: 0.60,
    pct_above_e48: [0.8, 4.5],
    e21_slope: [0.22, 2.0],
    allowed_states: ["HTF_BULL_LTF_PULLBACK", "HTF_BULL_LTF_BULL"],
    require_m30_reclaim: false,
    allow_in_cloud: true,
    ride_runner_mfe_pct: 0.8,
    stop_max_pct: 0.007,
  },
};

const STOCK_PATHS_BLOCKED_ON_INDEX = new Set([
  "tt_pullback",
  "tt_reclaim",
  "tt_momentum",
  "tt_ath_breakout",
  "tt_atl_breakdown",
  "tt_n_test_support",
  "tt_n_test_resistance",
  "tt_range_reversal_long",
  "tt_range_reversal_short",
  "tt_gap_reversal_long",
  "tt_gap_reversal_short",
  "tt_mean_revert",
]);

export function parseIndexModelTickerSet(daCfg) {
  const raw = daCfg?.deep_audit_index_model_tickers ?? DEFAULT_INDEX_MODEL_TICKERS;
  return new Set(
    String(raw)
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
  );
}

export function isIndexModelEnabled(daCfg) {
  return String(daCfg?.deep_audit_index_model_enabled ?? "true") === "true";
}

export function isIndexModelTicker(ticker, daCfg) {
  if (!isIndexModelEnabled(daCfg)) return false;
  const tk = String(ticker || "").trim().toUpperCase();
  return tk && parseIndexModelTickerSet(daCfg).has(tk);
}

export function isStockPathBlockedOnIndex(path) {
  return STOCK_PATHS_BLOCKED_ON_INDEX.has(String(path || "").toLowerCase());
}

/** SPY/QQQ/IWM must not use stock triggers — even when index model is OFF. */
export function shouldBlockStockPathOnIndexTicker(ticker, path, daCfg) {
  const tk = String(ticker || "").trim().toUpperCase();
  if (!tk || !parseIndexModelTickerSet(daCfg).has(tk)) return false;
  return isStockPathBlockedOnIndex(path);
}

export function getIndexTickerProfile(ticker, daCfg) {
  const tk = String(ticker || "").trim().toUpperCase();
  const base = INDEX_TICKER_PROFILES[tk];
  if (!base) return null;
  const prefix = `deep_audit_index_model_${tk.toLowerCase()}_`;
  const num = (key, fallback) => {
    const v = Number(daCfg?.[prefix + key]);
    return Number.isFinite(v) ? v : fallback;
  };
  return {
    ...base,
    ticker: tk,
    min_rank: num("min_rank", base.min_rank),
    rvol_min: num("rvol_min", base.rvol_min),
    pct_above_e48: [
      num("pct_above_e48_min", base.pct_above_e48[0]),
      num("pct_above_e48_max", base.pct_above_e48[1]),
    ],
    e21_slope: [
      num("e21_slope_min", base.e21_slope[0]),
      num("e21_slope_max", base.e21_slope[1]),
    ],
    ride_runner_mfe_pct: num("ride_runner_mfe_pct", base.ride_runner_mfe_pct),
    stop_max_pct: num("stop_max_pct", base.stop_max_pct),
  };
}

function inBand(val, band) {
  return Number.isFinite(val) && val >= band[0] && val <= band[1];
}

function ltfLongOk(profile, c10_8, m30Cloud89) {
  if (profile.require_m30_reclaim) {
    return !!m30Cloud89?.above && (c10_8?.above || (profile.allow_in_cloud && c10_8?.inCloud));
  }
  if (c10_8?.above) return true;
  if (profile.allow_in_cloud && c10_8?.inCloud) return true;
  if (m30Cloud89?.above || m30Cloud89?.inCloud) return true;
  return false;
}

function ltfShortOk(profile, c10_8, m30Cloud89) {
  if (profile.require_m30_reclaim) {
    return !!m30Cloud89?.below && (c10_8?.below || (profile.allow_in_cloud && c10_8?.inCloud));
  }
  if (c10_8?.below) return true;
  if (profile.allow_in_cloud && c10_8?.inCloud) return true;
  if (m30Cloud89?.below || m30Cloud89?.inCloud) return true;
  return false;
}

/**
 * Evaluate index-only entry with per-ticker slow-range rules.
 */
export function evaluateIndexEtfModelEntry(ctx, helpers) {
  const {
    qualifyEntry,
    rejectEntry,
    daCfg,
    rankScore,
    side,
    c10_8,
    tf,
  } = helpers;

  const ticker = String(ctx?.ticker || ctx?.raw?.ticker || "").trim().toUpperCase();
  const profile = getIndexTickerProfile(ticker, daCfg);
  if (!profile) {
    return rejectEntry("index_model_unknown_ticker", { ticker });
  }

  const daily = ctx?.daily || ctx?.raw?.daily_structure || null;
  const state = String(ctx?.state || ctx?.raw?.state || "");
  const rvolSignal = Number(ctx?.rvol?.best)
    || Number(ctx?.raw?.rvol_map?.["30"]?.vr)
    || 0.8;
  const m30Cloud89 = tf?.m30?.ripster?.c8_9 || null;
  const pctAbove48 = Number(daily?.pct_above_e48);
  const e21Slope = Number(daily?.e21_slope_5d_pct);

  const diag = {
    ticker,
    profile: profile.label,
    side,
    rank: { value: rankScore, min: profile.min_rank, pass: rankScore >= profile.min_rank },
    rvol: { value: rvolSignal, min: profile.rvol_min, pass: rvolSignal >= profile.rvol_min },
    state: { value: state, allowed: profile.allowed_states },
    pct_above_e48: { value: pctAbove48, band: profile.pct_above_e48 },
    e21_slope: { value: e21Slope, band: profile.e21_slope },
    ltf: {
      c10_8: { above: !!c10_8?.above, inCloud: !!c10_8?.inCloud },
      m30_8_9: { above: !!m30Cloud89?.above, inCloud: !!m30Cloud89?.inCloud },
    },
  };

  if (ctx?.raw) {
    ctx.raw.__index_etf_model_diag = diag;
    ctx.raw.__index_ticker_profile = profile.label;
  }

  if (rankScore < profile.min_rank) {
    return rejectEntry("index_model_rank_floor", { index_model: diag });
  }
  if (rvolSignal < profile.rvol_min) {
    return rejectEntry("index_model_rvol_floor", { index_model: diag });
  }
  if (!daily) {
    return rejectEntry("index_model_no_daily_structure", { index_model: diag });
  }
  if (!profile.allowed_states.includes(state)) {
    return rejectEntry("index_model_state_not_allowed", { index_model: diag });
  }

  // Prevent churn: one index entry per ticker per cooldown window.
  const cooldownH = Number(daCfg.deep_audit_index_model_reentry_cooldown_hours) || 48;
  const nowTs = Number(ctx?.nowTs || ctx?.asOfTs || ctx?.raw?.ts) || Date.now();
  const recent = Array.isArray(ctx?.recentTrades) ? ctx.recentTrades : [];
  const sideUpper = String(side || "").toUpperCase();
  for (const rt of recent) {
    if (String(rt?.ticker || "").toUpperCase() !== ticker) continue;
    if (String(rt?.direction || "").toUpperCase() !== sideUpper) continue;
    const exitTs = Number(rt?.exit_ts) || 0;
    if (!exitTs || exitTs >= nowTs) continue;
    const ageH = (nowTs - exitTs) / 3600000;
    if (ageH < cooldownH) {
      return rejectEntry("index_model_reentry_cooldown", {
        index_model: diag,
        cooldown_hours: cooldownH,
        hours_since_exit: ageH.toFixed(1),
      });
    }
  }

  if (side === "LONG") {
    const structureOk = daily.bull_stack === true
      && daily.above_e200 === true
      && inBand(pctAbove48, profile.pct_above_e48)
      && inBand(e21Slope, profile.e21_slope);
    const ltfOk = ltfLongOk(profile, c10_8, m30Cloud89);

    diag.fired = structureOk && ltfOk;
    diag.entry_mode = structureOk && ltfOk ? "index_slow_range_long" : null;

    if (!structureOk) {
      return rejectEntry("index_model_range_structure_long", { index_model: diag });
    }
    if (!ltfOk) {
      return rejectEntry("index_model_range_ltf_long", { index_model: diag });
    }

    return qualifyEntry(
      "tt_index_etf_swing",
      "medium",
      `index_${profile.label}_range_long`,
      helpers.baseSizing || { sizeMult: 1.0 },
      {
        triggerType: "index_slow_range_long",
        index_model: diag,
        index_ticker_profile: profile,
        index_etf_swing_diag: diag,
      },
    );
  }

  if (side === "SHORT") {
    const pctBand = [-profile.pct_above_e48[1], -profile.pct_above_e48[0]];
    const slopeBand = [-profile.e21_slope[1], -profile.e21_slope[0]];
    const bearStates = ["HTF_BEAR_LTF_BOUNCE", "HTF_BEAR_LTF_BEAR"];
    if (!bearStates.includes(state)) {
      return rejectEntry("index_model_state_not_allowed", { index_model: diag });
    }
    const structureOk = daily.bear_stack === true
      && daily.above_e200 === false
      && inBand(pctAbove48, pctBand)
      && inBand(e21Slope, slopeBand);
    const ltfOk = ltfShortOk(profile, c10_8, m30Cloud89);

    diag.fired = structureOk && ltfOk;
    diag.entry_mode = structureOk && ltfOk ? "index_slow_range_short" : null;

    if (!structureOk) {
      return rejectEntry("index_model_range_structure_short", { index_model: diag });
    }
    if (!ltfOk) {
      return rejectEntry("index_model_range_ltf_short", { index_model: diag });
    }

    return qualifyEntry(
      "tt_index_etf_swing",
      "medium",
      `index_${profile.label}_range_short`,
      helpers.baseSizing || { sizeMult: 1.0 },
      {
        triggerType: "index_slow_range_short",
        index_model: diag,
        index_ticker_profile: profile,
        index_etf_swing_diag: diag,
      },
    );
  }

  return rejectEntry("index_model_no_side", { index_model: diag });
}

export function getIndexRideRunnerMfeThreshold(ticker, daCfg) {
  const p = getIndexTickerProfile(ticker, daCfg);
  return p?.ride_runner_mfe_pct ?? 1.0;
}

export function getIndexStopMaxPct(ticker, daCfg) {
  const p = getIndexTickerProfile(ticker, daCfg);
  return p?.stop_max_pct ?? 0.007;
}
