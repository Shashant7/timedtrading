// worker/pipeline/sizing.js
// Composable sizing pipeline — consolidates all multipliers and risk-based sizing.

const PORTFOLIO_START_CASH = 100000;
const SIZING_MULT_FLOOR = 0.30;

let _sizingConfig = null;

export function getSizingConfig(env) {
  if (_sizingConfig) return _sizingConfig;
  const e = (key, def) => {
    const v = Number(env?.[key]);
    return Number.isFinite(v) && v > 0 ? v : def;
  };
  _sizingConfig = {
    BASE_RISK_PCT: e("SIZING_BASE_RISK_PCT", 0.01),
    MIN_RISK_PCT: e("SIZING_MIN_RISK_PCT", 0.005),
    MAX_RISK_PCT: e("SIZING_MAX_RISK_PCT", 0.02),
    MIN_NOTIONAL: e("SIZING_MIN_NOTIONAL", 1000),
    MAX_NOTIONAL: e("SIZING_MAX_NOTIONAL", 20000),
    VIX_HIGH: e("SIZING_VIX_HIGH", 25),
    VIX_EXTREME: e("SIZING_VIX_EXTREME", 35),
  };
  return _sizingConfig;
}

export function resetSizingConfig() {
  _sizingConfig = null;
}

function clamp(x, lo, hi) {
  const n = Number(x);
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Gather all sizing multipliers from tickerData side-effects and entry result.
 * Returns a structured breakdown + combined multiplier.
 */
export function gatherSizingMultipliers(tickerData, entryResult) {
  const d = tickerData || {};

  const regime = Number(d.regime_params?.positionSizeMultiplier) || 1.0;
  const daRegime = Number(d.__da_regime_size_mult) || 1.0;
  const rvol = Number(d.__da_rvol_high_size_mult) || 1.0;
  const danger = Number(d.__da_danger_size_mult) || 1.0;
  const meanRevert = Number(d.__da_mean_revert_size_mult) || 1.0;
  const pdz = Number(d.__pdz_size_mult) || 1.0;
  const spy = Number(d.__spy_size_mult) || 1.0;
  const orb = Number(d.__da_orb_size_mult) || 1.0;

  const miOverall = String(
    d._marketInternals?.overall || d._env?._marketInternals?.overall || "",
  );
  const internals = miOverall === "risk_off" ? 0.5
    : miOverall === "balanced" ? 0.8 : 1.0;

  const rawCombined = regime * daRegime * rvol * danger * meanRevert
    * pdz * spy * orb * internals;
  const combined = Math.max(SIZING_MULT_FLOOR, rawCombined);

  return {
    breakdown: { regime, daRegime, rvol, danger, meanRevert, pdz, spy, orb, internals },
    rawCombined,
    combined,
  };
}

/**
 * Compute PDZ-based sizing multiplier from zone and side.
 */
export function computePdzSizeMult(pdzZone, side) {
  const zone = String(pdzZone || "unknown");
  if (side === "LONG") {
    if (zone === "discount") return 1.25;
    if (zone === "discount_approach") return 1.1;
    if (zone === "premium_approach") return 0.75;
    if (zone === "premium") return 0.5;
  } else if (side === "SHORT") {
    if (zone === "premium") return 1.25;
    if (zone === "premium_approach") return 1.1;
    if (zone === "discount_approach") return 0.75;
    if (zone === "discount") return 0.5;
  }
  return 1.0;
}

/**
 * Risk-based position sizing.
 */
export function computeRiskBasedSize(
  confidence, accountValue, entryPrice, stopLoss, vixLevel, env, tierRiskPct,
) {
  const cfg = getSizingConfig(env);
  const acctVal = Number.isFinite(accountValue) && accountValue > 0
    ? accountValue : PORTFOLIO_START_CASH;

  let vixMultiplier = 1.0;
  const vix = Number(vixLevel);
  if (Number.isFinite(vix) && vix > 0) {
    if (vix > cfg.VIX_EXTREME) vixMultiplier = 0.5;
    else if (vix > cfg.VIX_HIGH) vixMultiplier = 0.75;
  }

  let riskPct, maxDollarRisk;
  const usingTier = Number.isFinite(tierRiskPct) && tierRiskPct > 0;
  if (usingTier) {
    riskPct = tierRiskPct;
    maxDollarRisk = acctVal * riskPct * vixMultiplier;
  } else {
    riskPct = cfg.MIN_RISK_PCT
      + (cfg.MAX_RISK_PCT - cfg.MIN_RISK_PCT) * clamp(confidence, 0, 1);
    maxDollarRisk = acctVal * riskPct * vixMultiplier;
  }

  const riskPerShare = Math.abs(Number(entryPrice) - Number(stopLoss));
  if (!Number.isFinite(riskPerShare) || riskPerShare <= 0) {
    const fallbackNotional = clamp(
      cfg.MIN_NOTIONAL + (cfg.MAX_NOTIONAL - cfg.MIN_NOTIONAL) * confidence,
      cfg.MIN_NOTIONAL, cfg.MAX_NOTIONAL,
    );
    return {
      shares: fallbackNotional / entryPrice,
      notional: fallbackNotional,
      riskPct, maxDollarRisk,
      riskPerShare: 0,
      vixMultiplier,
      method: "notional_fallback",
    };
  }

  let shares = maxDollarRisk / riskPerShare;
  let notional = shares * Number(entryPrice);

  const maxPositionNotional = acctVal * 0.20;
  if (notional > maxPositionNotional) {
    notional = maxPositionNotional;
    shares = notional / Number(entryPrice);
  }
  if (!usingTier && notional < cfg.MIN_NOTIONAL) {
    notional = cfg.MIN_NOTIONAL;
    shares = notional / Number(entryPrice);
  }

  return {
    shares, notional, riskPct, maxDollarRisk,
    riskPerShare, vixMultiplier,
    method: "risk_based",
  };
}

export { PORTFOLIO_START_CASH, SIZING_MULT_FLOOR };
