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
  // PHASE 5 R3 (2026-05-19) — Chop-regime size haircut. Stamped by
  // processTradeSimulation when daCfg.gates.chop_size_haircut_enabled
  // is true AND tickerData.regime_class === "CHOPPY". Default 1.0
  // (no haircut) so this is a no-op until the gate is enabled in
  // model_config.gates. See worker/index.js for the stamp site.
  const chop = Number(d.__chop_size_mult) || 1.0;
  const harmonic = Number(d.__harmonic_size_mult) || 1.0;

  // 2026-05-22 Phase B / Tier 2.4 — Markov probability-vector sizing.
  // computeRegimeFavorMultiplier() in worker/lib/regime-markov-policy.js
  // returns a [0.5, 1.5]-clamped multiplier derived from the forecast
  // probability of the favorable continuation state divided by its
  // stationary baseline. Stamped by processTradeSimulation when
  // gates.markov_position_sizing_enabled is true. Default 1.0
  // (no effect) until the operator opts in via model_config.
  const markovFavor = Number(d.__regime_favor_mult) || 1.0;

  const prState = d?._env?._portfolioRiskPause || {};
  const portfolioDd = Number(d.__portfolio_dd_size_mult ?? prState.dd_size_mult) || 1.0;
  const portfolioSector = Number(d.__sector_size_mult ?? prState.sector_size_mult) || 1.0;
  const portfolioCombined = Number(d.__portfolio_size_mult ?? prState.portfolio_size_mult)
    || (portfolioDd * portfolioSector);

  const miOverall = String(
    d._marketInternals?.overall || d._env?._marketInternals?.overall || "",
  );
  const internals = miOverall === "risk_off" ? 0.5
    : miOverall === "balanced" ? 0.8 : 1.0;

  const rawCombined = regime * daRegime * rvol * danger * meanRevert
    * pdz * spy * orb * chop * markovFavor * harmonic * internals * portfolioCombined;
  const combined = Math.max(SIZING_MULT_FLOOR, rawCombined);

  return {
    breakdown: {
      regime, daRegime, rvol, danger, meanRevert, pdz, spy, orb, chop, markovFavor, harmonic, internals,
      portfolioDd, portfolioSector, portfolioCombined,
    },
    rawCombined,
    combined,
  };
}

// ─────────────────────────────────────────────────────────────────────
// CONVICTION-WEIGHTED SIZING (2026-08-20)
//
// The 90d autopsy: risk is tiered by grade (Prime 2% / Confirmed 1% /
// Speculative 0.5%) but the $1k MIN_NOTIONAL floor flattens the bottom
// end, and *alignment* — strategy stance, FSD Core Idea, tape rotation —
// never touched size at all. USO (+$80, the one aligned trade of the
// 13–19 Aug week) was sized the same as three SNOWs. The top-quartile
// trade must be worth 3–4× the bottom-quartile trade or the winners can
// never pay for the losers.
//
// This multiplier stacks ON TOP of the tier risk pct:
//   grade   Prime 1.30 / Confirmed 1.00 / Speculative 0.60
//   stance  tier-1 overweight 1.25 / overweight 1.15 / neutral 1.0 / underweight 0.70
//   fsd     core-idea top 1.30 / bottom 0.50 / none 1.0
//   tape    aligned-with-rotation 1.15 / misaligned (excepted long) 0.70 / neutral 1.0
// Combined clamp [0.40, 2.00].
//
// Effective dollar-risk spread once stacked with the tier pct:
//   best  (Prime × tier-1 OW × FSD-top × aligned):  2.0% × 2.0  = 4.0%
//   worst (Spec  × UW × misaligned):                0.5% × 0.40 = 0.2%
//   → 20:1 asymmetry between the best and worst admitted trade.
//
// Flag: deep_audit_conviction_sizing_enabled (default OFF in code;
// flipped ON in production model_config). MIN_NOTIONAL also scales by
// the multiplier when < 1 so the floor stops flattening low-conviction
// entries up to full size.
// ─────────────────────────────────────────────────────────────────────

const flagOn = (v) => v === true || v === 1 || String(v ?? "").toLowerCase() === "true";

const TAPE_OFFENSE_SECTORS_SZ = new Set([
  "Information Technology",
  "Consumer Discretionary",
  "Communication Services",
  "Industrials",
  "Financials",
]);

/**
 * Pure conviction multiplier. All inputs optional — missing data reads
 * as neutral (1.0 component) so a thin payload can never crush size.
 *
 * @param {object} args
 * @param {string} args.grade          — Prime / Confirmed / Speculative
 * @param {object} args.stance         — getStrategyForTicker result ({ stance, tier })
 * @param {object} args.fsdCoreIdea    — getFsdCoreIdeaForTicker result ({ conviction })
 * @param {string} args.side           — LONG / SHORT
 * @param {string} args.sector         — GICS sector
 * @param {object} args.internals      — market internals ({ overall, sector_rotation.state })
 * @param {object} args.daCfg          — deep-audit config (flag + overrides)
 * @returns {{ mult:number, enabled:boolean, breakdown:object }}
 */
export function computeConvictionSizeMult({
  grade,
  stance,
  fsdCoreIdea,
  side,
  sector,
  internals,
  daCfg,
} = {}) {
  const cfg = daCfg || {};
  const enabled = flagOn(cfg.deep_audit_conviction_sizing_enabled);
  const neutral = { mult: 1.0, enabled, breakdown: { grade: 1, stance: 1, fsd: 1, tape: 1 } };
  if (!enabled) return neutral;

  // Grade component.
  const g = String(grade || "").toLowerCase();
  const gradeMult = g === "prime" ? 1.30 : g === "speculative" ? 0.60 : 1.0;

  // Strategy stance component (playbook alignment).
  const st = String(stance?.stance || "").toLowerCase();
  const tier = String(stance?.tier || "").toLowerCase();
  let stanceMult = 1.0;
  if (st === "overweight") {
    stanceMult = (tier === "tier_1" || tier === "tier1") ? 1.25 : 1.15;
  } else if (st === "underweight") {
    stanceMult = 0.70;
  }

  // FSD Core Idea component (top-of-book desk conviction).
  const conv = String(fsdCoreIdea?.conviction || "").toLowerCase();
  const fsdMult = conv === "top" ? 1.30 : conv === "bottom" ? 0.50 : 1.0;

  // Tape alignment component. LONGs sized up when the sector agrees
  // with the live rotation; sized down when misaligned but excepted
  // through the G8 gate (RS / fundamental pass). SHORTs mirror.
  let tapeMult = 1.0;
  const rot = String(internals?.sector_rotation?.state || internals?.overall || "").toLowerCase();
  const isOffense = TAPE_OFFENSE_SECTORS_SZ.has(String(sector || ""));
  const s = String(side || "LONG").toUpperCase();
  if (rot === "risk_off") {
    if (s === "LONG") tapeMult = isOffense ? 0.70 : 1.15;
    else tapeMult = isOffense ? 1.15 : 0.85;
  } else if (rot === "risk_on") {
    if (s === "LONG") tapeMult = isOffense ? 1.15 : 1.0;
    else tapeMult = isOffense ? 0.70 : 1.0;
  }

  const raw = gradeMult * stanceMult * fsdMult * tapeMult;
  const lo = Number(cfg.deep_audit_conviction_sizing_min) > 0 ? Number(cfg.deep_audit_conviction_sizing_min) : 0.40;
  const hi = Number(cfg.deep_audit_conviction_sizing_max) > 0 ? Number(cfg.deep_audit_conviction_sizing_max) : 2.00;
  const mult = Math.max(lo, Math.min(hi, raw));

  return {
    mult: Math.round(mult * 1000) / 1000,
    enabled,
    breakdown: {
      grade: gradeMult,
      stance: stanceMult,
      fsd: fsdMult,
      tape: tapeMult,
      raw: Math.round(raw * 1000) / 1000,
      clamp_lo: lo,
      clamp_hi: hi,
    },
  };
}

/**
 * Conviction-aware notional floor. The flat $1k MIN_NOTIONAL was
 * up-sizing every low-conviction entry to the same floor as a Prime —
 * exactly the flattening the diagnosis called out. When conviction
 * sizing is on and the multiplier is below 1, the floor scales down
 * with it (still bounded at $250 so fills stay real).
 */
export function convictionAwareMinNotional(baseMinNotional, convictionMult, enabled) {
  const base = Number(baseMinNotional) > 0 ? Number(baseMinNotional) : 1000;
  const m = Number(convictionMult);
  if (!enabled || !Number.isFinite(m) || m >= 1) return base;
  return Math.max(250, Math.round(base * m));
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
  // Always enforce the dollar floor — tier sizing used to skip it, which
  // let wide stops produce sub-MIN_NOTIONAL primes (AXON/IHF Aug 2026).
  if (notional < cfg.MIN_NOTIONAL) {
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
