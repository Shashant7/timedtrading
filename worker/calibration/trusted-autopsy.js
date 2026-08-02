// Trusted calibration scopes — provenance + data-quality for self-tune.
// plans/calibration-trust-loop.plan.md
//
// Autopsy PK is global (trade_id). Always store `${scopeId}::${sourceTradeId}`
// so live and promoted scopes coexist. Never INSERT OR REPLACE raw trade_ids.

export const LIVE_AUTOPSY_SCOPE = "live-trades";
export const LIVE_SCOPE_KIND = "live";
export const PROMOTED_SCOPE_KIND = "promoted_run";

/** Stable autopsy PK that cannot collide across scopes. */
export function scopedAutopsyId(scopeId, sourceTradeId) {
  const scope = String(scopeId || "default").trim() || "default";
  const tid = String(sourceTradeId || "").trim();
  if (!tid) return null;
  if (tid.includes("::") && tid.startsWith(`${scope}::`)) return tid;
  // Strip any prior scope prefix so re-seed stays idempotent.
  const bare = tid.includes("::") ? tid.slice(tid.indexOf("::") + 2) : tid;
  return `${scope}::${bare}`;
}

export function bareTradeId(autopsyTradeId) {
  const s = String(autopsyTradeId || "");
  const i = s.indexOf("::");
  return i >= 0 ? s.slice(i + 2) : s;
}

export function promotedScopeId(datasetOrRunId) {
  const id = String(datasetOrRunId || "").trim();
  if (!id) return null;
  return id.startsWith("promoted:") ? id : `promoted:${id}`;
}

/**
 * Coverage / trust metrics from autopsy rows.
 * @returns {object}
 */
export function computeCalibrationDataQuality(trades = []) {
  const rows = Array.isArray(trades) ? trades : [];
  const n = rows.length;
  let mfePctN = 0;
  let maePctN = 0;
  let mfeAtrN = 0;
  let maeAtrN = 0;
  let vixN = 0;
  let regimeKnownN = 0;
  let approxExcursionN = 0;
  let trueExcursionN = 0;
  let entryTsMin = null;
  let entryTsMax = null;

  for (const t of rows) {
    const mfePct = Number(t.mfe_pct);
    const maePct = Number(t.mae_pct);
    const mfeAtr = Number(t.mfe_atr);
    const maeAtr = Number(t.mae_atr);
    if (Number.isFinite(mfePct) && mfePct > 0) mfePctN++;
    if (Number.isFinite(maePct) && maePct > 0) maePctN++;
    if (Number.isFinite(mfeAtr) && mfeAtr > 0) mfeAtrN++;
    if (Number.isFinite(maeAtr) && maeAtr > 0) maeAtrN++;
    if (Number.isFinite(Number(t.vix_at_entry)) && Number(t.vix_at_entry) > 0) vixN++;
    const reg = String(t.regime_at_entry || "").toLowerCase();
    if (reg && reg !== "unknown" && reg !== "null") regimeKnownN++;
    const src = String(t.excursion_source || t._excursion_source || "").toLowerCase();
    if (src === "ledger" || src === "candle" || src === "backtest_archive") trueExcursionN++;
    else if (src === "approx_entry_exit" || src === "approximate") approxExcursionN++;
    const ets = Number(t.entry_ts);
    if (Number.isFinite(ets) && ets > 0) {
      if (entryTsMin == null || ets < entryTsMin) entryTsMin = ets;
      if (entryTsMax == null || ets > entryTsMax) entryTsMax = ets;
    }
  }

  const pct = (c) => (n > 0 ? Math.round((c / n) * 1000) / 10 : 0);
  const mfeAtrPct = pct(mfeAtrN);
  const maeAtrPct = pct(maeAtrN);
  const mfePctCoverage = pct(mfePctN);
  const vixPct = pct(vixN);
  const regimePct = pct(regimeKnownN);

  // SL/TP ATR recommendations need real ATR excursions — % MFE alone is not enough.
  const sltpTrusted = n >= 20 && mfeAtrPct >= 40 && maeAtrPct >= 25;
  const pathTrusted = n >= 15;
  const regimeTrusted = regimePct >= 40;

  return {
    trade_count: n,
    entry_ts_min: entryTsMin,
    entry_ts_max: entryTsMax,
    mfe_pct_coverage_pct: mfePctCoverage,
    mae_pct_coverage_pct: pct(maePctN),
    mfe_atr_coverage_pct: mfeAtrPct,
    mae_atr_coverage_pct: maeAtrPct,
    vix_coverage_pct: vixPct,
    regime_known_pct: regimePct,
    true_excursion_n: trueExcursionN,
    approx_excursion_n: approxExcursionN,
    sltp_recommendations_trusted: sltpTrusted,
    path_recommendations_trusted: pathTrusted,
    regime_filters_trusted: regimeTrusted,
  };
}

/**
 * Immutable-ish provenance for a calibration report.
 */
export function buildCalibrationProvenance(opts = {}) {
  const {
    scopeId = null,
    scopeKind = "legacy",
    source = "unknown",
    liveOnly = false,
    datasetId = null,
    sourceRunId = null,
    seedOk = null,
    seedError = null,
    excursionSource = null,
    query = null,
    dataQuality = null,
    scoringVersion = null,
    engineGitSha = null,
    configHash = null,
  } = opts;

  const dq = dataQuality || {};
  const blockReasons = [];
  if (liveOnly !== true && scopeKind === "live") {
    blockReasons.push("live_flag_mismatch");
  }
  if (scopeKind !== LIVE_SCOPE_KIND) {
    blockReasons.push("scope_not_live");
  }
  if (dq.sltp_recommendations_trusted === false) {
    blockReasons.push("sltp_excursions_untrusted");
  }
  if (Number(dq.vix_coverage_pct) < 80) {
    blockReasons.push("vix_coverage_below_80");
  }
  if (Number(dq.trade_count) < 80) {
    blockReasons.push("trade_count_below_80");
  }

  const applyEligible = scopeKind === LIVE_SCOPE_KIND
    && liveOnly === true
    && blockReasons.filter((r) => r !== "sltp_excursions_untrusted").length === 0
    // SL/TP can still block specific keys; overall apply may proceed for other keys
    && Number(dq.trade_count) >= 80
    && Number(dq.vix_coverage_pct) >= 80;

  return {
    live_only: !!liveOnly,
    source: String(source || "unknown"),
    scope_id: scopeId,
    scope_kind: scopeKind,
    dataset_id: datasetId,
    source_run_id: sourceRunId,
    seed_ok: seedOk,
    seed_error: seedError,
    excursion_source: excursionSource,
    query,
    scoring_version: scoringVersion,
    engine_git_sha: engineGitSha,
    config_hash: configHash,
    data_quality: dq,
    apply_eligible_base: applyEligible,
    apply_block_reasons: blockReasons,
    // Explicit: promoted/challenger reports must never mutate production.
    production_mutable: scopeKind === LIVE_SCOPE_KIND && liveOnly === true,
  };
}

/**
 * Extra Apply gates from report JSON (beyond existing live/VIX/WFO/n).
 * @returns {{ ok: true } | { ok: false, error, message, details }}
 */
export function evaluateApplyDataQuality(reportJson = {}, opts = {}) {
  const prov = reportJson.calibration_provenance || {};
  const dq = reportJson.data_quality || prov.data_quality || {};
  const minVix = Number(opts.minVixCoveragePct) || 80;
  const minTrades = Number(opts.minTradeCount) || 80;
  const minMfeAtr = Number(opts.minMfeAtrCoveragePct) || 40;
  const requireSltpTrust = opts.requireSltpTrust !== false;

  if (prov.production_mutable === false || prov.live_only !== true) {
    return {
      ok: false,
      error: "calibration_not_production_mutable",
      message: "Report provenance is not production-mutable (need trusted live scope).",
      details: { provenance: { live_only: prov.live_only, scope_kind: prov.scope_kind, source: prov.source } },
    };
  }
  if (Number(dq.trade_count || reportJson.trade_count) < minTrades) {
    return {
      ok: false,
      error: "insufficient_trade_count",
      message: `Need ≥${minTrades} trades in the trusted live autopsy.`,
      details: { trade_count: dq.trade_count },
    };
  }
  if (Number(dq.vix_coverage_pct) < minVix) {
    return {
      ok: false,
      error: "insufficient_vix_coverage",
      message: `VIX coverage ${dq.vix_coverage_pct || 0}% below ${minVix}%.`,
      details: { vix_coverage_pct: dq.vix_coverage_pct, min: minVix },
    };
  }
  if (requireSltpTrust && dq.sltp_recommendations_trusted === false) {
    return {
      ok: false,
      error: "sltp_data_untrusted",
      message: `MFE/MAE ATR coverage too low (mfe_atr ${dq.mfe_atr_coverage_pct || 0}% / need ${minMfeAtr}%). SL/TP floors from zeros must not be applied.`,
      details: {
        mfe_atr_coverage_pct: dq.mfe_atr_coverage_pct,
        mae_atr_coverage_pct: dq.mae_atr_coverage_pct,
        min_mfe_atr_coverage_pct: minMfeAtr,
      },
    };
  }
  return { ok: true, data_quality: dq };
}

/** Resolve MFE/MAE % preferring ledger, then approx from PnL. */
export function resolveExcursions(row = {}, pnlPct = 0, entryPrice = 0, exitPrice = 0) {
  const ledgerMfe = Number(row.max_favorable_excursion ?? row.mfe_pct);
  const ledgerMae = Number(row.max_adverse_excursion ?? row.mae_pct);
  const hasLedger = (Number.isFinite(ledgerMfe) && ledgerMfe > 0)
    || (Number.isFinite(ledgerMae) && ledgerMae > 0);

  if (hasLedger) {
    return {
      mfePct: Number.isFinite(ledgerMfe) && ledgerMfe > 0 ? ledgerMfe : 0,
      maePct: Number.isFinite(ledgerMae) && ledgerMae > 0 ? ledgerMae : 0,
      source: "ledger",
    };
  }

  const moveAbs = entryPrice > 0
    ? Math.abs(exitPrice - entryPrice) / entryPrice * 100
    : 0;
  return {
    mfePct: pnlPct > 0 ? Math.max(pnlPct, moveAbs) : 0,
    maePct: pnlPct < 0 ? Math.max(Math.abs(pnlPct), moveAbs) : 0,
    source: "approx_entry_exit",
  };
}

/** Convert % excursion to ATR units when atr_pct available; else 0. */
export function pctToAtr(pct, atrPct) {
  const p = Number(pct);
  const a = Number(atrPct);
  if (!Number.isFinite(p) || p <= 0 || !Number.isFinite(a) || a <= 0) return 0;
  return Math.round((p / a) * 100) / 100;
}
