/**
 * Dedicated index ETF entry model (SPY / QQQ / IWM).
 *
 * Index names do NOT use stock tt_core paths (pullback, ATH, support, etc.).
 * Only tt_index_etf_swing with stricter daily-structure + LTF reclaim rules.
 */

export const DEFAULT_INDEX_MODEL_TICKERS = "SPY,QQQ,IWM";

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

export function isStockPathBlockedOnIndex(path) {
  return STOCK_PATHS_BLOCKED_ON_INDEX.has(String(path || "").toLowerCase());
}

function num(daCfg, key, fallback) {
  const v = Number(daCfg?.[key]);
  return Number.isFinite(v) ? v : fallback;
}

function flag(daCfg, key, fallback = true) {
  const raw = daCfg?.[key];
  if (raw == null) return fallback;
  return String(raw).toLowerCase() !== "false" && raw !== false && raw !== 0;
}

/**
 * Evaluate index-only entry. Returns EntryResult via qualifyEntry / rejectEntry.
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

  const daily = ctx?.daily || ctx?.raw?.daily_structure || null;
  const state = String(ctx?.state || ctx?.raw?.state || "");
  const rvolSignal = Number(ctx?.rvol?.best)
    || Number(ctx?.raw?.rvol_map?.["30"]?.vr)
    || 1.0;
  const m30Cloud89 = tf?.m30?.ripster?.c8_9 || null;

  const minRank = num(daCfg, "deep_audit_index_model_min_rank", 95);
  const rvolMin = num(daCfg, "deep_audit_index_model_rvol_min", 1.0);
  const pctAboveMin = num(daCfg, "deep_audit_index_model_pct_above_e48_min", 1.5);
  const pctAboveMax = num(daCfg, "deep_audit_index_model_pct_above_e48_max", 4.5);
  const e21SlopeMin = num(daCfg, "deep_audit_index_model_e21_slope_min", 0.4);
  const e21SlopeMax = num(daCfg, "deep_audit_index_model_e21_slope_max", 2.0);
  const requireM30Reclaim = flag(daCfg, "deep_audit_index_model_require_m30_reclaim", true);
  const pullbackStateOnly = flag(daCfg, "deep_audit_index_model_pullback_state_only", true);

  const pctAbove48 = Number(daily?.pct_above_e48);
  const e21Slope = Number(daily?.e21_slope_5d_pct);

  const diag = {
    side,
    rank: { value: rankScore, min: minRank, pass: rankScore >= minRank },
    rvol: { value: rvolSignal, min: rvolMin, pass: rvolSignal >= rvolMin },
    state: { value: state, pullbackOnly: pullbackStateOnly },
    pct_above_e48: { value: pctAbove48, band: [pctAboveMin, pctAboveMax] },
    e21_slope: { value: e21Slope, band: [e21SlopeMin, e21SlopeMax] },
    m30_8_9: {
      above: !!m30Cloud89?.above,
      below: !!m30Cloud89?.below,
      requireReclaim: requireM30Reclaim,
    },
    c10_8: { above: !!c10_8?.above, below: !!c10_8?.below, inCloud: !!c10_8?.inCloud },
  };

  if (ctx?.raw) ctx.raw.__index_etf_model_diag = diag;

  if (rankScore < minRank) {
    return rejectEntry("index_model_rank_floor", { index_model: diag });
  }
  if (rvolSignal < rvolMin) {
    return rejectEntry("index_model_rvol_floor", { index_model: diag });
  }
  if (!daily) {
    return rejectEntry("index_model_no_daily_structure", { index_model: diag });
  }

  if (side === "LONG") {
    const stateOk = pullbackStateOnly
      ? state === "HTF_BULL_LTF_PULLBACK"
      : (state === "HTF_BULL_LTF_PULLBACK" || state === "HTF_BULL_LTF_BULL");
    const structureOk = daily.bull_stack === true
      && daily.above_e200 === true
      && Number.isFinite(pctAbove48)
      && pctAbove48 >= pctAboveMin
      && pctAbove48 <= pctAboveMax
      && Number.isFinite(e21Slope)
      && e21Slope >= e21SlopeMin
      && e21Slope <= e21SlopeMax
      && stateOk;
    const ltfOk = requireM30Reclaim
      ? (!!m30Cloud89?.above && (c10_8?.above || c10_8?.inCloud))
      : (c10_8?.above || c10_8?.inCloud || m30Cloud89?.above || m30Cloud89?.inCloud);

    diag.fired = structureOk && ltfOk;
    if (!structureOk) {
      return rejectEntry("index_model_structure_long", { index_model: diag });
    }
    if (!ltfOk) {
      return rejectEntry("index_model_ltf_reclaim_long", { index_model: diag });
    }

    return qualifyEntry(
      "tt_index_etf_swing",
      "medium",
      "index_model_daily_pullback_reclaim",
      helpers.baseSizing || { sizeMult: 1.0 },
      {
        triggerType: "index_etf_model_long",
        index_model: diag,
        index_etf_swing_diag: diag,
      },
    );
  }

  if (side === "SHORT") {
    const stateOk = pullbackStateOnly
      ? state === "HTF_BEAR_LTF_BOUNCE"
      : (state === "HTF_BEAR_LTF_BOUNCE" || state === "HTF_BEAR_LTF_BEAR");
    const pctBelowMin = num(daCfg, "deep_audit_index_model_pct_below_e48_min", 1.5);
    const pctBelowMax = num(daCfg, "deep_audit_index_model_pct_below_e48_max", 4.5);
    const structureOk = daily.bear_stack === true
      && daily.above_e200 === false
      && Number.isFinite(pctAbove48)
      && pctAbove48 <= -pctBelowMin
      && pctAbove48 >= -pctBelowMax
      && Number.isFinite(e21Slope)
      && e21Slope <= -e21SlopeMin
      && e21Slope >= -e21SlopeMax
      && stateOk;
    const ltfOk = requireM30Reclaim
      ? (!!m30Cloud89?.below && (c10_8?.below || c10_8?.inCloud))
      : (c10_8?.below || c10_8?.inCloud || m30Cloud89?.below || m30Cloud89?.inCloud);

    diag.fired = structureOk && ltfOk;
    if (!structureOk) {
      return rejectEntry("index_model_structure_short", { index_model: diag });
    }
    if (!ltfOk) {
      return rejectEntry("index_model_ltf_reclaim_short", { index_model: diag });
    }

    return qualifyEntry(
      "tt_index_etf_swing",
      "medium",
      "index_model_daily_bounce_reclaim",
      helpers.baseSizing || { sizeMult: 1.0 },
      {
        triggerType: "index_etf_model_short",
        index_model: diag,
        index_etf_swing_diag: diag,
      },
    );
  }

  return rejectEntry("index_model_no_side", { index_model: diag });
}
