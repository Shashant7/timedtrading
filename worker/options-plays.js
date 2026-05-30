// worker/options-plays.js
//
// ─────────────────────────────────────────────────────────────────────────────
//  TT Options Strategy Engine
// ─────────────────────────────────────────────────────────────────────────────
//
//  Translates a Trader prediction contract (direction + SL + targets + setup
//  tier + ATR) into a *ranked ladder* of options strategies, designed
//  FLY-FIRST: the multi-bagger Long Call/Put is the default headline, with
//  cheaper / safer alternatives gradient-shown so any user — from speculator
//  to conservative — has a play that fits their risk profile.
//
//  Architecture:
//    1. Inputs: trader contract (always) + optional live options chain.
//       Without a chain we estimate premium via Black-Scholes using
//       ATR-implied volatility. With a chain we use real bid/ask/IV/OI/Greeks.
//    2. Strategy taxonomy: 9 archetypes covering long, short, spread, and
//       neutral-volatility plays.
//    3. Risk profile: each user has a profile (Speculator / Aggressive /
//       Moderate / Conservative). Strategies are filtered + ranked per
//       profile so the FIRST card the user sees matches their stomach.
//    4. Sizing: every play computes contract count from the user's risk
//       budget (default 0.5%-1% of account) — fully account-aware.
//
//  Public API:
//    buildOptionsLadder(contract, opts) → { ladder, primary, ladder_by_profile }
//    selectStrategy(contract, profile)  → { archetype, rationale }
//    estimatePremium({...})             → { mid, low, high, iv_used }
//
//  Used by:
//    /timed/options/ticker endpoint (per-ticker on-demand)
//    /timed/options/all endpoint (top-conviction setups nightly)
//    Right Rail "Options" tab
//    Today page "Options Plays of the Day" row
//    Phase 3: auto-mirror engine (operator only) — same selector chooses
//             which play to route to the IBKR bridge.
//
//  Authored 2026-05-30.

// ── Leveraged-ETF map ──────────────────────────────────────────────────────
// Per-direction LETF lookup so the ladder can include "no-options leverage"
// alternatives between stock and options. Operator-articulated: "leveraged
// ETFs or pure stocks based on the circumstance — we lean risk on when
// appropriate."
//
// Conservative: 2x/3x ETFs only when the underlying maps cleanly. For
// thematics with no clean LETF, the slot stays empty and the ladder skips
// the LETF tier.
const LETF_MAP = {
  // Broad indices
  SPY:  { long: "SPXL", short: "SPXS",  factor: 3, note: "Direxion 3× S&P 500" },
  QQQ:  { long: "TQQQ", short: "SQQQ",  factor: 3, note: "ProShares 3× Nasdaq-100" },
  IWM:  { long: "TNA",  short: "TZA",   factor: 3, note: "Direxion 3× Russell 2000" },
  DIA:  { long: "UDOW", short: "SDOW",  factor: 3, note: "ProShares 3× Dow" },
  // Sectors
  XLK:  { long: "TECL", short: "TECS",  factor: 3, note: "Direxion 3× Tech" },
  XLF:  { long: "FAS",  short: "FAZ",   factor: 3, note: "Direxion 3× Financials" },
  XLE:  { long: "ERX",  short: "ERY",   factor: 2, note: "Direxion 2× Energy" },
  XLV:  { long: "CURE", short: null,    factor: 3, note: "Direxion 3× Healthcare (long only)" },
  XLI:  { long: "DUSL", short: null,    factor: 3, note: "Direxion 3× Industrials" },
  XLP:  { long: null,   short: null,    factor: 0, note: "No LETF (defensive sector)" },
  // Semis (separately tracked theme)
  SMH:  { long: "SOXL", short: "SOXS",  factor: 3, note: "Direxion 3× Semis" },
  // Crypto-adjacent (high beta proxies for direct BTC/ETH exposure)
  IBIT: { long: "BITX", short: "BITI",  factor: 2, note: "2× Bitcoin (Volatility Shares)" },
  // Volatility
  VIX:  { long: "UVXY", short: "SVXY",  factor: 1.5, note: "ProShares Ultra VIX" },
  // Bonds (rare but useful)
  TLT:  { long: "TMF",  short: "TMV",   factor: 3, note: "Direxion 3× 20+yr Treasury" },
};

// Per-ticker direct LETF mapping. When a single name is the leveraged play
// (e.g. NVDA → NVDL/NVDU 2x), surface it as the LETF slot.
const SINGLE_NAME_LETF = {
  NVDA: { long: "NVDL", short: "NVDD", factor: 2, note: "GraniteShares 2× NVDA" },
  TSLA: { long: "TSLL", short: "TSLZ", factor: 2, note: "GraniteShares 2× TSLA" },
  AAPL: { long: "AAPU", short: "AAPD", factor: 2, note: "Direxion 2× AAPL" },
  AMZN: { long: "AMZU", short: "AMZD", factor: 2, note: "Direxion 2× AMZN" },
  MSFT: { long: "MSFU", short: "MSFD", factor: 2, note: "Direxion 2× MSFT" },
  GOOGL:{ long: "GGLL", short: "GGLS", factor: 2, note: "Direxion 2× GOOGL" },
  META: { long: "METU", short: "METD", factor: 2, note: "Direxion 2× META" },
  COIN: { long: "CONL", short: null,    factor: 2, note: "GraniteShares 2× COIN" },
  MSTR: { long: "MSTU", short: "MSTZ",  factor: 2, note: "T-Rex 2× MSTR" },
  TSM:  { long: "TSMU", short: null,    factor: 2, note: "Direxion 2× TSM" },
};

// Theme-level LETF fallback (when ticker matches a tier-1 theme, suggest the
// thematic LETF as the leverage alternative).
const THEME_LETF = {
  ai_infra_compute:  { long: "SOXL", short: "SOXS", factor: 3, note: "3× Semis" },
  ai_infra_memory:   { long: "SOXL", short: "SOXS", factor: 3, note: "3× Semis" },
  ai_infra_semicap:  { long: "SOXL", short: "SOXS", factor: 3, note: "3× Semis" },
  ai_software:       { long: "TECL", short: "TECS", factor: 3, note: "3× Tech" },
  ai_consumer:       { long: "TECL", short: "TECS", factor: 3, note: "3× Tech" },
  banks_money_center:{ long: "FAS",  short: "FAZ",  factor: 3, note: "3× Financials" },
  banks_regional:    { long: "DPST", short: "WDRW", factor: 3, note: "3× Regional Banks" },
  oil_gas:           { long: "ERX",  short: "ERY",  factor: 2, note: "2× Energy" },
  crypto_proxies:    { long: "BITX", short: "BITI", factor: 2, note: "2× Bitcoin" },
  crypto_etf:        { long: "BITX", short: "BITI", factor: 2, note: "2× Bitcoin" },
};

function lookupLETF(ticker, themes = []) {
  const sym = String(ticker || "").toUpperCase();
  if (SINGLE_NAME_LETF[sym]) return { ticker: sym, ...SINGLE_NAME_LETF[sym] };
  if (LETF_MAP[sym]) return { ticker: sym, ...LETF_MAP[sym] };
  for (const theme of themes || []) {
    if (THEME_LETF[theme]) return { ticker: sym, theme, ...THEME_LETF[theme] };
  }
  return null;
}

// ── Risk profiles ──────────────────────────────────────────────────────────
// Order matters: index = how aggressive the user is. Used to rank ladder.
export const RISK_PROFILES = ["conservative", "moderate", "aggressive", "speculator"];
export const DEFAULT_RISK_PROFILE = "speculator"; // most TT users "want to fly"

export const PROFILE_META = {
  conservative: {
    label: "Conservative",
    icon: "🛡",
    one_liner: "Stock-only. Options reserved for income (covered calls only).",
    preferred: ["stock_long", "stock_short", "covered_call"],
  },
  moderate: {
    label: "Moderate",
    icon: "⚖",
    one_liner: "Sell options for premium income. Defined risk only.",
    preferred: ["cash_secured_put", "covered_call", "vertical_spread", "stock_long"],
  },
  aggressive: {
    label: "Aggressive",
    icon: "🎯",
    one_liner: "Defined-risk spreads. Capped downside, leveraged upside.",
    preferred: ["vertical_spread", "long_call", "long_put", "cash_secured_put"],
  },
  speculator: {
    label: "Speculator",
    icon: "🚀",
    one_liner: "Multi-bagger long calls / puts. Max convexity, time decay accepted.",
    preferred: ["long_call", "long_put", "vertical_spread", "long_straddle"],
  },
};

// ── Strategy taxonomy ──────────────────────────────────────────────────────
// Every archetype declares:
//   directional ∈ {long, short, neutral}
//   risk_class  ∈ {speculator, aggressive, moderate, conservative}
//   max_loss    : "defined" | "undefined" | "capped_at_premium"
//   max_gain    : "defined" | "uncapped"
export const ARCHETYPES = {
  // The Moonshot tier — short-dated OTM single legs that activate only
  // when ALL of: RIDE confluence + ST fresh + underlying in motion +
  // squeeze released + volume above avg + speculator/aggressive profile.
  // Gamma-driven — small premium, can 5-10x if the move continues. Theta
  // is brutal (must work in 5-14 days). This is where TT shines: using
  // the fused 8-layer verdict to time both DIRECTION and MOMENT.
  moonshot_call:       { directional: "long",    risk_class: "speculator",   max_loss: "capped_at_premium", max_gain: "uncapped",  label: "🌙 Moonshot Call" },
  moonshot_put:        { directional: "short",   risk_class: "speculator",   max_loss: "capped_at_premium", max_gain: "uncapped",  label: "🌙 Moonshot Put" },
  long_call:           { directional: "long",    risk_class: "speculator",   max_loss: "capped_at_premium", max_gain: "uncapped",  label: "Long Call" },
  long_put:            { directional: "short",   risk_class: "speculator",   max_loss: "capped_at_premium", max_gain: "uncapped",  label: "Long Put" },
  vertical_spread:     { directional: "either",  risk_class: "aggressive",   max_loss: "defined",           max_gain: "defined",   label: "Vertical Spread" },
  cash_secured_put:    { directional: "long",    risk_class: "moderate",     max_loss: "undefined",         max_gain: "defined",   label: "Cash-Secured Short Put" },
  covered_call:        { directional: "long",    risk_class: "conservative", max_loss: "undefined",         max_gain: "defined",   label: "Covered Call" },
  long_straddle:       { directional: "neutral", risk_class: "speculator",   max_loss: "capped_at_premium", max_gain: "uncapped",  label: "Long Straddle" },
  long_strangle:       { directional: "neutral", risk_class: "speculator",   max_loss: "capped_at_premium", max_gain: "uncapped",  label: "Long Strangle" },
  iron_condor:         { directional: "neutral", risk_class: "aggressive",   max_loss: "defined",           max_gain: "defined",   label: "Iron Condor" },
  stock_long:          { directional: "long",    risk_class: "conservative", max_loss: "undefined",         max_gain: "uncapped",  label: "Stock (Long)" },
  stock_short:         { directional: "short",   risk_class: "moderate",     max_loss: "undefined",         max_gain: "defined",   label: "Stock (Short)" },
};

// ── Strike snapping ────────────────────────────────────────────────────────
// US listed options trade on standard strike grids that vary by price tier.
// Used when we don't have the live chain — gives the user a strike that
// will almost certainly exist on the actual board.
function strikeGrid(price) {
  if (price < 25)   return 0.50;
  if (price < 100)  return 1.00;
  if (price < 200)  return 2.50;
  if (price < 500)  return 5.00;
  if (price < 1000) return 10.00;
  return 25.00;
}

function snapStrike(price, grid = null) {
  const g = grid != null ? grid : strikeGrid(price);
  return Math.round(price / g) * g;
}

// ── Expiration selection ───────────────────────────────────────────────────
// Maps a trader setup's time horizon to a sensible expiration window.
// US weeklies expire every Friday. We bias toward nearest weekly that
// brackets the swing — never less than 5 DTE (avoids 0DTE gamma fryer
// for the default user) and never more than 60 DTE for directional plays
// (theta decay dominates beyond that).
/**
 * Moonshot expiration picker — short-dated weekly. Target 7 DTE; snap to
 * nearest Friday in the 5-14 DTE window. Never goes < 5 DTE (theta cliff)
 * or > 14 DTE (defeats the gamma-engine purpose).
 */
export function pickMoonshotExpiration(now = Date.now()) {
  const dteTarget = 7;
  const target = new Date(now + dteTarget * 86400000);
  const dow = target.getUTCDay();
  const offset = (5 - dow + 7) % 7;
  const friday = new Date(target.getTime() + offset * 86400000);
  friday.setUTCHours(20, 0, 0, 0);
  let dte = Math.round((friday.getTime() - now) / 86400000);
  // If we landed too short (< 5 DTE), bump to next Friday.
  if (dte < 5) {
    friday.setUTCDate(friday.getUTCDate() + 7);
    dte = Math.round((friday.getTime() - now) / 86400000);
  }
  return {
    iso: friday.toISOString().slice(0, 10),
    dte,
    label: `${friday.toLocaleDateString("en-US", { month: "short", day: "numeric" })} (${dte}DTE) · short-dated`,
  };
}

/**
 * Detect "underlying already in motion" — the moonshot ignition condition.
 * The fused TT call has identified BOTH direction AND moment; the move is
 * underway and we want to ride it via gamma.
 *
 * Returns { in_motion, direction, day_change_pct, multi_day_change_pct,
 *           volume_ratio, evidence }.
 */
export function detectMomentumInMotion(tickerData) {
  if (!tickerData) return { in_motion: false, reason: "no_ticker_data" };

  const dayPct = Number(tickerData.day_change_pct ?? tickerData.dailyChgPct ?? tickerData.percent_change ?? 0);
  const fiveDayPct = Number(tickerData.fiveDayChangePct ?? tickerData._5d_change_pct ?? 0);
  const oneDayPct = Number(tickerData.oneDayChangePct ?? dayPct ?? 0);
  // Volume ratio — today's volume vs 20-day avg.
  const volRatio = Number(tickerData.volume_ratio_20 ?? tickerData._vol_ratio ?? 1);

  // Threshold: at least 3% in the trade direction over the day OR 5%+ over 5d.
  const absDay = Math.abs(dayPct);
  const absMulti = Math.abs(fiveDayPct);
  if (absDay < 3 && absMulti < 5) {
    return { in_motion: false, reason: `quiet (day ${dayPct.toFixed(1)}%, 5d ${fiveDayPct.toFixed(1)}%)`, day_change_pct: dayPct, multi_day_change_pct: fiveDayPct };
  }

  // Direction must be consistent — day and 5d should agree (no whipsaw).
  const dayDir  = dayPct > 0 ? "LONG" : dayPct < 0 ? "SHORT" : null;
  const multiDir = fiveDayPct > 0 ? "LONG" : fiveDayPct < 0 ? "SHORT" : null;
  if (dayDir && multiDir && dayDir !== multiDir) {
    return { in_motion: false, reason: "whipsaw (day ↔ 5d disagree)", day_change_pct: dayPct, multi_day_change_pct: fiveDayPct };
  }

  const direction = dayDir || multiDir;
  const evidence = [];
  if (absDay >= 3) evidence.push(`day ${dayPct >= 0 ? "+" : ""}${dayPct.toFixed(1)}%`);
  if (absMulti >= 5) evidence.push(`5d ${fiveDayPct >= 0 ? "+" : ""}${fiveDayPct.toFixed(1)}%`);
  if (Number.isFinite(volRatio) && volRatio >= 1.5) evidence.push(`vol ${volRatio.toFixed(1)}× avg`);

  return {
    in_motion: true,
    direction,
    day_change_pct: dayPct,
    multi_day_change_pct: fiveDayPct,
    volume_ratio: volRatio,
    evidence: evidence.join(" · "),
  };
}

/**
 * Decide whether the Moonshot tier should activate for a given setup.
 *
 * Standard path (gamma-window detection):
 *   - Confluence = RIDE
 *   - SuperTrend freshness = "fresh"
 *   - Underlying in motion (day ≥3% or 5d ≥5% in the trade direction)
 *
 * SMT-elevated path (Smart Money Technique confirms):
 *   - Confluence = RIDE OR DRIFT
 *   - SMT 2-stage CONFIRMED on the index quartet aligned with direction
 *   - This is the highest-edge entry — multi-asset divergence at HTF
 *     levels with LTF PSP confirmation. Standalone 81% historical win
 *     rate per the source — when this confirms our other layers we
 *     activate moonshot even without the in-motion price prerequisite.
 *
 * Returns { activate, reason, motion?, smt_path?: boolean }.
 */
export function shouldActivateMoonshot({ confluence, tickerData, profile }) {
  if (profile !== "speculator" && profile !== "aggressive") {
    return { activate: false, reason: "profile_not_speculator_or_aggressive" };
  }

  // SMT-elevated path: if the index quartet has a confirmed 2-stage SMT
  // aligned with our confluence side, we have institutional reversal
  // confirmation — moonshot is justified at high conviction.
  const quartet = tickerData?._index_quartet || tickerData?.index_quartet;
  const smtConfirmed = quartet?.smt_confirmed || quartet?.SMT_CONFIRMED;
  if (smtConfirmed?.confirmed && confluence && (confluence.mode === "RIDE" || confluence.mode === "DRIFT")) {
    if (smtConfirmed.direction === confluence.side) {
      const motion = detectMomentumInMotion(tickerData);
      return {
        activate: true,
        smt_path: true,
        motion: motion.in_motion ? motion : { in_motion: false, evidence: "SMT confirms — momentum not required" },
        smt_evidence: smtConfirmed.status,
      };
    }
  }

  // Standard path: full gate.
  if (!confluence || confluence.mode !== "RIDE") {
    return { activate: false, reason: `mode_${confluence?.mode || "unknown"}_not_RIDE` };
  }
  const stFresh = confluence?.supertrend_trigger?.freshness;
  if (stFresh !== "fresh") {
    return { activate: false, reason: `st_freshness_${stFresh}_not_fresh` };
  }
  const motion = detectMomentumInMotion(tickerData);
  if (!motion.in_motion) {
    return { activate: false, reason: motion.reason, motion };
  }
  if (motion.direction !== confluence.side) {
    return { activate: false, reason: `motion_${motion.direction}_vs_confluence_${confluence.side}`, motion };
  }
  return { activate: true, motion };
}

function pickExpiration(setupStage, now = Date.now()) {
  // Days-to-expiry target by stage.
  const dteTarget =
    setupStage === "intraday"       ? 7 :
    setupStage === "swing"          ? 21 :
    setupStage === "trim_runner"    ? 35 :
    setupStage === "investor"       ? 90 :
    21; // default

  const target = new Date(now + dteTarget * 86400000);
  // Snap to next Friday on or after target.
  const dow = target.getUTCDay(); // 0 = Sun, 5 = Fri
  const offset = (5 - dow + 7) % 7;
  const friday = new Date(target.getTime() + offset * 86400000);
  friday.setUTCHours(20, 0, 0, 0); // 4 PM ET ≈ 20:00 UTC during DST
  const dte = Math.round((friday.getTime() - now) / 86400000);
  return {
    iso: friday.toISOString().slice(0, 10),
    dte,
    label: `${friday.toLocaleDateString("en-US", { month: "short", day: "numeric" })} (${dte}DTE)`,
  };
}

// ── Black-Scholes (no-chain estimator) ─────────────────────────────────────
// Standard BS for European-style options. Good enough for premium estimates
// when we don't have the live chain. Replaced by chain bid/ask in v2.
//
// IV is the hard input. When we don't have it, we approximate from ATR:
//    ATR% per day × √252 ≈ annualized realized vol.
// This UNDER-estimates IV for stocks with vol premium (most do) so users
// will see slightly LOWER premium estimates than reality — directionally
// fine (estimate floor, not ceiling).
function _normCdf(x) {
  // Abramowitz & Stegun 26.2.17 — good to 7 digits.
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.SQRT2;
  const t = 1.0 / (1.0 + p * ax);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return 0.5 * (1.0 + sign * y);
}

export function blackScholes({ S, K, T, r = 0.045, sigma, type = "C" }) {
  if (!(S > 0 && K > 0 && T > 0 && sigma > 0)) return null;
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const Nd1 = _normCdf(d1), Nd2 = _normCdf(d2);
  const Nmd1 = _normCdf(-d1), Nmd2 = _normCdf(-d2);
  const disc = Math.exp(-r * T);
  const price = type === "P"
    ? K * disc * Nmd2 - S * Nmd1
    : S * Nd1 - K * disc * Nd2;
  const delta = type === "P" ? -Nmd1 : Nd1;
  // Greek approximations (need for sizing + decay warnings).
  const phi_d1 = Math.exp(-d1 * d1 / 2) / Math.sqrt(2 * Math.PI);
  const gamma = phi_d1 / (S * sigma * sqrtT);
  const vega  = S * phi_d1 * sqrtT / 100;                  // per 1 vol pt
  const theta = type === "P"
    ? (-(S * phi_d1 * sigma) / (2 * sqrtT) + r * K * disc * Nmd2) / 365
    : (-(S * phi_d1 * sigma) / (2 * sqrtT) - r * K * disc * Nd2) / 365;
  return {
    price: Math.max(0.01, Math.round(price * 100) / 100),
    delta: Math.round(delta * 1000) / 1000,
    gamma: Math.round(gamma * 10000) / 10000,
    vega:  Math.round(vega * 100) / 100,
    theta: Math.round(theta * 100) / 100,
    prob_itm: type === "C" ? Nd2 : Nmd2,
  };
}

// IV proxy from ATR% (annualized). atrPct = day ATR / price.
function impliedVolFromATR(atrPct) {
  if (!Number.isFinite(atrPct) || atrPct <= 0) return 0.40; // 40% default
  const annualized = atrPct * Math.sqrt(252);
  // Floor at 15% (deep liquid mega-caps), ceiling at 200% (post-news small-caps)
  return Math.max(0.15, Math.min(2.0, annualized));
}

// Convenience wrapper used by builders below.
// Prefers real chain data when `chainLeg` is supplied (v2 — real bid/ask/IV/OI).
// Falls back to Black-Scholes + ATR-implied vol when chainLeg is null (v1).
export function estimatePremium({ price, strike, dte, atrPct, ivOverride, type, chainLeg = null }) {
  // ── Real chain path ────────────────────────────────────────────────
  if (chainLeg && Number.isFinite(chainLeg.mid) && chainLeg.mid > 0) {
    const bid = Number(chainLeg.bid);
    const ask = Number(chainLeg.ask);
    const iv = Number(chainLeg.implied_volatility) || impliedVolFromATR(atrPct);
    return {
      mid: chainLeg.mid,
      low: Number.isFinite(bid) && bid > 0 ? bid : Math.round(chainLeg.mid * 0.95 * 100) / 100,
      high: Number.isFinite(ask) && ask > 0 ? ask : Math.round(chainLeg.mid * 1.05 * 100) / 100,
      iv_used: Math.round(iv * 100) / 100,
      greeks: {
        delta: Number.isFinite(chainLeg.delta) ? chainLeg.delta : null,
        gamma: Number.isFinite(chainLeg.gamma) ? chainLeg.gamma : null,
        vega:  Number.isFinite(chainLeg.vega)  ? chainLeg.vega  : null,
        theta: Number.isFinite(chainLeg.theta) ? chainLeg.theta : null,
        prob_itm: null,
      },
      source: "live_chain",
      volume: chainLeg.volume,
      open_interest: chainLeg.open_interest,
      spread_pct: Number.isFinite(bid) && Number.isFinite(ask) && ask > 0
        ? Math.round(((ask - bid) / ask) * 1000) / 10
        : null,
    };
  }

  // ── Black-Scholes fallback path ────────────────────────────────────
  const sigma = Number.isFinite(ivOverride) && ivOverride > 0
    ? ivOverride
    : impliedVolFromATR(atrPct);
  const T = Math.max(1, dte) / 365;
  const bs = blackScholes({ S: price, K: strike, T, sigma, type });
  if (!bs) return null;
  return {
    mid:  bs.price,
    low:  Math.max(0.01, Math.round(bs.price * 0.90 * 100) / 100),
    high: Math.round(bs.price * 1.10 * 100) / 100,
    iv_used: Math.round(sigma * 100) / 100,
    greeks: {
      delta: bs.delta, gamma: bs.gamma, vega: bs.vega, theta: bs.theta,
      prob_itm: Math.round(bs.prob_itm * 1000) / 1000,
    },
    source: "estimate_bs_atr_iv",
  };
}

// ── Setup → stage classifier ───────────────────────────────────────────────
// Decides which expiration bucket fits the setup. Trader setups are mostly
// intraday-to-swing; investor mode gets long-dated.
function classifySetupStage(contract) {
  const stage = String(contract?.stage || "").toLowerCase();
  const mode = String(contract?.mode || "").toLowerCase();
  if (mode === "investor") return "investor";
  if (stage.includes("intraday") || stage.includes("scalp")) return "intraday";
  if (stage.includes("hold") || stage.includes("trim") || stage.includes("runner")) return "trim_runner";
  return "swing";
}

// ── Strategy builders ──────────────────────────────────────────────────────
// Each builder accepts the normalized contract context and returns a
// Strategy object: { archetype, label, legs[], strikes, expiration, ...metrics }

// Look up a chain leg by strike + side (returns null if no chain or no leg).
function _chainLeg(chain, side, strike) {
  if (!chain) return null;
  const arr = side === "C" ? chain.calls : chain.puts;
  if (!Array.isArray(arr)) return null;
  // Exact match preferred; if not, closest within $1 (handles snap drift).
  const exact = arr.find(l => Math.abs(l.strike - strike) < 0.01);
  if (exact) return exact;
  let best = null, bestDiff = Infinity;
  for (const l of arr) {
    const d = Math.abs(l.strike - strike);
    if (d < bestDiff && d <= 1.0) { best = l; bestDiff = d; }
  }
  return best;
}

/**
 * Carter's Delta Decision Tree — pick the chain leg whose delta matches
 * a target. Used for delta-targeted strike selection instead of blind
 * "snap to ATM":
 *
 *   0.70-0.80 → Stock Replacement (deep ITM, ~1:1 with underlying, low time value)
 *   0.50      → ATM balanced
 *   0.25-0.35 → Moonshot / Speculative OTM (max gamma, cheap)
 *
 * Returns the chain leg whose absolute delta is closest to targetDelta.
 * Falls back to nearest-strike when chain Greeks are missing.
 */
export function pickLegByDelta(chain, side, targetDelta, fallbackPrice = 0) {
  if (!chain) return { leg: null, source: "no_chain" };
  const arr = side === "C" ? chain.calls : chain.puts;
  if (!Array.isArray(arr) || arr.length === 0) return { leg: null, source: "no_legs" };
  // Filter to legs with valid delta + bid/ask (skip illiquid).
  const withDelta = arr.filter(l => Number.isFinite(Number(l.delta)) && Number.isFinite(Number(l.mid)));
  if (withDelta.length === 0) {
    // Fall back to nearest-price strike, no delta info.
    if (!(fallbackPrice > 0)) return { leg: null, source: "no_fallback_price" };
    const snapped = snapStrike(fallbackPrice);
    const near = _chainLeg(chain, side, snapped);
    return near ? { leg: near, source: "fallback_nearest_strike" } : { leg: null, source: "no_match" };
  }
  // Find leg with delta closest to target. Puts have NEGATIVE delta in
  // OCC convention — match on absolute delta.
  let best = null, bestDiff = Infinity;
  for (const leg of withDelta) {
    const d = Math.abs(Math.abs(Number(leg.delta)) - targetDelta);
    if (d < bestDiff) { best = leg; bestDiff = d; }
  }
  return { leg: best, source: "delta_match", diff_from_target: Math.round(bestDiff * 100) / 100 };
}

/**
 * Delta-targeted strike fallback when no chain. Uses a rough Black-Scholes
 * inverse — given desired delta + IV + DTE, what strike approximates it?
 *
 *   For calls:  K = S × exp((r - 0.5σ²)T - σ√T × invNorm(target_delta))
 *   For puts:   K = S × exp((r - 0.5σ²)T + σ√T × invNorm(target_delta))
 *
 * Snapped to standard strike grid. Returns null if inputs invalid.
 */
function _invNorm(p) {
  // Approximation of inverse normal CDF (Beasley-Springer-Moro).
  if (p < 0.5) return -_invNorm(1 - p);
  const t = Math.sqrt(-2 * Math.log(1 - p));
  return t - ((0.010328 * t + 0.802853) * t + 2.515517) /
             (((0.001308 * t + 0.189269) * t + 1.432788) * t + 1);
}

export function deltaToStrikeBS({ price, targetDelta, dte, atrPct, type }) {
  if (!(price > 0 && targetDelta > 0 && dte > 0)) return null;
  const sigma = Number.isFinite(atrPct) && atrPct > 0
    ? Math.max(0.15, Math.min(2.0, atrPct * Math.sqrt(252)))
    : 0.4;
  const T = Math.max(1, dte) / 365;
  const r = 0.045;
  // invNorm(target_delta) — note for puts we invert.
  const dPrime = type === "P" ? _invNorm(1 - targetDelta) : _invNorm(targetDelta);
  const strike = price * Math.exp((r - 0.5 * sigma * sigma) * T - sigma * Math.sqrt(T) * dPrime);
  return snapStrike(strike);
}

function buildLongCall(ctx) {
  const { price, tp1, sl, atrPct, expiration, contracts, chain, targetDelta = 0.50 } = ctx;
  // Delta-targeted strike selection (Carter's framework):
  //   0.70 = stock replacement (deep ITM, low time value)
  //   0.50 = ATM balanced (default)
  //   0.30 = OTM speculative (max gamma)
  let strike, chainLeg, deltaSource = "snap_atm";
  if (chain) {
    const picked = pickLegByDelta(chain, "C", targetDelta, price);
    if (picked.leg) {
      strike = Number(picked.leg.strike);
      chainLeg = picked.leg;
      deltaSource = picked.source;
    }
  }
  if (!strike) {
    // Fall back to BS-derived strike or simple ATM snap.
    strike = deltaToStrikeBS({ price, targetDelta, dte: expiration.dte, atrPct, type: "C" })
          || snapStrike(price);
    chainLeg = chain ? _chainLeg(chain, "C", strike) : null;
    deltaSource = chain ? "chain_no_delta_fallback" : "bs_estimate";
  }
  const prem = estimatePremium({ price, strike, dte: expiration.dte, atrPct, type: "C", chainLeg });
  if (!prem) return null;
  const premPerShare = prem.mid;
  const maxLoss = premPerShare * 100 * contracts;
  const breakeven = strike + premPerShare;
  // Max gain at TP1 — intrinsic value at target.
  const intrinsicAtTP = Math.max(0, tp1 - strike);
  const gainAtTP = (intrinsicAtTP - premPerShare) * 100 * contracts;
  const deltaLabel = targetDelta >= 0.65 ? "Deep ITM (Stock Replacement)"
                    : targetDelta >= 0.40 ? "ATM"
                    : targetDelta >= 0.25 ? "OTM"
                    : "Far OTM";
  const deltaPct = (Math.abs(prem.greeks?.delta || targetDelta) * 100).toFixed(0);
  return {
    archetype: "long_call",
    label: `Long Call (${deltaLabel})`,
    rationale: `Bullish bias to $${tp1?.toFixed(2) ?? "?"}. Strike $${strike} (${deltaPct}Δ via ${deltaSource}) — every $1 underlying ≈ $${deltaPct}/contract. Max loss = premium paid.`,
    target_delta: targetDelta,
    actual_delta: Number(prem.greeks?.delta) || null,
    legs: [
      { action: "BUY", optionType: "CALL", strike, expiration: expiration.iso, qty: contracts },
    ],
    strikes: { primary: strike },
    expiration,
    premium: prem,
    contracts,
    max_loss_usd: Math.round(maxLoss),
    max_gain_usd: intrinsicAtTP > premPerShare ? Math.round(gainAtTP) : null,
    max_gain_label: "Uncapped above target",
    breakeven,
    prob_profit_at_target: prem.greeks.prob_itm,
    notes: [
      `Theta ≈ $${Math.abs(prem.greeks.theta * 100 * contracts).toFixed(2)}/day decay`,
      `Vega ≈ $${(prem.greeks.vega * 100 * contracts).toFixed(2)} per 1% IV change`,
    ],
  };
}

function buildLongPut(ctx) {
  const { price, tp1, sl, atrPct, expiration, contracts, chain, targetDelta = 0.50 } = ctx;
  // Delta-targeted strike selection (Carter's framework, puts mirror calls).
  let strike, chainLeg, deltaSource = "snap_atm";
  if (chain) {
    const picked = pickLegByDelta(chain, "P", targetDelta, price);
    if (picked.leg) {
      strike = Number(picked.leg.strike);
      chainLeg = picked.leg;
      deltaSource = picked.source;
    }
  }
  if (!strike) {
    strike = deltaToStrikeBS({ price, targetDelta, dte: expiration.dte, atrPct, type: "P" })
          || snapStrike(price);
    chainLeg = chain ? _chainLeg(chain, "P", strike) : null;
    deltaSource = chain ? "chain_no_delta_fallback" : "bs_estimate";
  }
  const prem = estimatePremium({ price, strike, dte: expiration.dte, atrPct, type: "P", chainLeg });
  if (!prem) return null;
  const premPerShare = prem.mid;
  const maxLoss = premPerShare * 100 * contracts;
  const breakeven = strike - premPerShare;
  const intrinsicAtTP = Math.max(0, strike - tp1);
  const gainAtTP = (intrinsicAtTP - premPerShare) * 100 * contracts;
  const deltaLabel = targetDelta >= 0.65 ? "Deep ITM (Stock Replacement)"
                    : targetDelta >= 0.40 ? "ATM"
                    : targetDelta >= 0.25 ? "OTM"
                    : "Far OTM";
  const deltaPct = (Math.abs(prem.greeks?.delta || targetDelta) * 100).toFixed(0);
  return {
    archetype: "long_put",
    label: `Long Put (${deltaLabel})`,
    rationale: `Bearish bias to $${tp1?.toFixed(2) ?? "?"}. Strike $${strike} (${deltaPct}Δ via ${deltaSource}) — every $1 down ≈ $${deltaPct}/contract. Max loss = premium paid.`,
    target_delta: targetDelta,
    actual_delta: Number(prem.greeks?.delta) || null,
    legs: [
      { action: "BUY", optionType: "PUT", strike, expiration: expiration.iso, qty: contracts },
    ],
    strikes: { primary: strike },
    expiration,
    premium: prem,
    contracts,
    max_loss_usd: Math.round(maxLoss),
    max_gain_usd: intrinsicAtTP > premPerShare ? Math.round(gainAtTP) : null,
    max_gain_label: "Uncapped below target",
    breakeven,
    prob_profit_at_target: prem.greeks.prob_itm,
    notes: [
      `Theta ≈ $${Math.abs(prem.greeks.theta * 100 * contracts).toFixed(2)}/day decay`,
      `Vega ≈ $${(prem.greeks.vega * 100 * contracts).toFixed(2)} per 1% IV change`,
    ],
  };
}

function buildVerticalSpread(ctx, direction) {
  const { price, tp1, atrPct, expiration, contracts, chain } = ctx;
  const longStrike  = snapStrike(price);
  const shortStrike = direction === "long" ? snapStrike(tp1) : snapStrike(tp1);
  if (direction === "long" && shortStrike <= longStrike) return null;
  if (direction === "short" && shortStrike >= longStrike) return null;
  const type = direction === "long" ? "C" : "P";
  const longLeg  = _chainLeg(chain, type, longStrike);
  const shortLeg = _chainLeg(chain, type, shortStrike);
  const longPrem = estimatePremium({ price, strike: longStrike, dte: expiration.dte, atrPct, type, chainLeg: longLeg });
  const shortPrem = estimatePremium({ price, strike: shortStrike, dte: expiration.dte, atrPct, type, chainLeg: shortLeg });
  if (!longPrem || !shortPrem) return null;
  const netDebit = longPrem.mid - shortPrem.mid;
  if (netDebit <= 0) return null;
  const width = Math.abs(shortStrike - longStrike);
  const maxLoss = netDebit * 100 * contracts;
  const maxGain = (width - netDebit) * 100 * contracts;
  const breakeven = direction === "long" ? longStrike + netDebit : longStrike - netDebit;
  const rrRatio = maxGain / maxLoss;
  return {
    archetype: "vertical_spread",
    label: direction === "long" ? "Bull Call Spread" : "Bear Put Spread",
    rationale: `Defined-risk ${direction === "long" ? "bullish" : "bearish"} play to $${tp1?.toFixed(2) ?? "?"}. Pay ${netDebit.toFixed(2)} to win up to $${width.toFixed(2)} (${rrRatio.toFixed(1)}x R:R). Caps both downside AND upside.`,
    legs: [
      { action: "BUY",  optionType: type === "C" ? "CALL" : "PUT", strike: longStrike,  expiration: expiration.iso, qty: contracts },
      { action: "SELL", optionType: type === "C" ? "CALL" : "PUT", strike: shortStrike, expiration: expiration.iso, qty: contracts },
    ],
    strikes: { long: longStrike, short: shortStrike, width },
    expiration,
    premium: { mid: netDebit, low: netDebit * 0.9, high: netDebit * 1.1, iv_used: longPrem.iv_used },
    contracts,
    max_loss_usd: Math.round(maxLoss),
    max_gain_usd: Math.round(maxGain),
    breakeven,
    prob_profit_at_target: direction === "long" ? longPrem.greeks.prob_itm : (1 - longPrem.greeks.prob_itm),
    notes: [
      `Net debit ${netDebit.toFixed(2)} per spread × ${contracts} = $${Math.round(maxLoss)}`,
      `Reaches max value at ${direction === "long" ? "or above" : "or below"} $${shortStrike}`,
    ],
  };
}

function buildCashSecuredPut(ctx) {
  const { price, sl, atrPct, expiration, contracts, chain } = ctx;
  const strike = snapStrike(sl);
  if (!strike || strike >= price) return null;
  const chainLeg = _chainLeg(chain, "P", strike);
  const prem = estimatePremium({ price, strike, dte: expiration.dte, atrPct, type: "P", chainLeg });
  if (!prem) return null;
  const premPerShare = prem.mid;
  const collateral = strike * 100 * contracts;
  const maxGain = premPerShare * 100 * contracts;
  const breakeven = strike - premPerShare;
  return {
    archetype: "cash_secured_put",
    label: "Cash-Secured Short Put",
    rationale: `Sell ${contracts} put(s) at $${strike} (our stop). If price stays above, keep $${Math.round(maxGain)} premium. If it falls below, get assigned at $${strike} — a level we'd buy anyway. Requires $${Math.round(collateral).toLocaleString()} cash collateral.`,
    legs: [
      { action: "SELL", optionType: "PUT", strike, expiration: expiration.iso, qty: contracts },
    ],
    strikes: { primary: strike },
    expiration,
    premium: prem,
    contracts,
    collateral_usd: Math.round(collateral),
    max_loss_usd: Math.round((strike - 0) * 100 * contracts - maxGain), // theoretical to zero
    max_loss_label: `Assigned at $${strike} (basis $${breakeven.toFixed(2)})`,
    max_gain_usd: Math.round(maxGain),
    breakeven,
    prob_profit_at_target: 1 - prem.greeks.prob_itm, // we want it OTM
    notes: [
      `Annualized yield ≈ ${((maxGain / collateral) * (365 / expiration.dte) * 100).toFixed(1)}%`,
      `Assignment risk if price < $${strike} at expiry`,
    ],
  };
}

function buildCoveredCall(ctx) {
  const { price, tp1, atrPct, expiration, chain } = ctx;
  // Sell call at TP1 (price target) — collect premium PLUS upside to TP.
  // Implicit assumption: user already holds 100 shares per contract.
  const strike = snapStrike(tp1);
  if (!strike || strike <= price) return null;
  const contracts = 1;
  const chainLeg = _chainLeg(chain, "C", strike);
  const prem = estimatePremium({ price, strike, dte: expiration.dte, atrPct, type: "C", chainLeg });
  if (!prem) return null;
  const premPerShare = prem.mid;
  const maxGainOnCalled = (strike - price) * 100 * contracts + premPerShare * 100 * contracts;
  return {
    archetype: "covered_call",
    label: "Covered Call",
    rationale: `Sell 1 call at TP1 strike $${strike}. If price closes above, shares get called away at $${strike} — capping gains but collecting premium + upside. Yield enhancement for existing long stock position.`,
    legs: [
      { action: "SELL", optionType: "CALL", strike, expiration: expiration.iso, qty: contracts },
    ],
    strikes: { primary: strike },
    expiration,
    premium: prem,
    contracts,
    requires_shares: 100 * contracts,
    max_gain_usd: Math.round(maxGainOnCalled),
    max_gain_label: `If called away at $${strike}`,
    notes: [
      `Premium collected: $${Math.round(premPerShare * 100 * contracts)}`,
      `Caps upside above $${strike} — gives up further gains`,
      `Annualized yield ≈ ${((premPerShare / price) * (365 / expiration.dte) * 100).toFixed(1)}%`,
    ],
  };
}

// 🌙 Moonshot — the flagship play. Short-dated OTM single leg that
// activates ONLY when confluence + ST + momentum + squeeze all line up.
// This is where TT shines: using the fused 8-layer verdict to time both
// DIRECTION (call vs put) and MOMENT (gamma window). Premium is small,
// can 5-10x if the move continues; 100% loss if it stalls.
//
// Differs from Long Call/Put:
//   • DTE: 5-14 (vs 14-30 for standard)
//   • Delta: 0.25-0.30 (vs 0.50)
//   • Sizing: 25-50% of standard risk budget (lottery)
//   • Trade mgmt: scale out 100%+ profits aggressively, exit < 3 days
//     if no follow-through (theta cliff)
function buildMoonshot(ctx, direction) {
  const { price, tp1, sl, atrPct, contracts, chain, dollars_at_risk, motion } = ctx;
  const expiration = pickMoonshotExpiration();
  const targetDelta = 0.30; // OTM speculative — max gamma
  const type = direction === "SHORT" ? "P" : "C";

  // Delta-targeted strike selection.
  let strike, chainLeg, deltaSource = "snap";
  if (chain) {
    const picked = pickLegByDelta(chain, type, targetDelta, price);
    if (picked.leg) {
      strike = Number(picked.leg.strike);
      chainLeg = picked.leg;
      deltaSource = picked.source;
    }
  }
  if (!strike) {
    strike = deltaToStrikeBS({ price, targetDelta, dte: expiration.dte, atrPct, type })
          || (direction === "SHORT" ? snapStrike(price * 0.97) : snapStrike(price * 1.03));
    deltaSource = chain ? "no_delta_fallback" : "bs_estimate";
  }

  const prem = estimatePremium({ price, strike, dte: expiration.dte, atrPct, type, chainLeg });
  if (!prem || prem.mid <= 0) return null;
  const premPerShare = prem.mid;

  // Moonshot sizing — cap at 25-50% of standard budget (lottery).
  const moonshotBudget = dollars_at_risk * 0.40;
  const moonshotContracts = Math.max(1, Math.floor(moonshotBudget / (premPerShare * 100)));
  const maxLoss = premPerShare * 100 * moonshotContracts;

  // Theoretical gains: 100%, 200%, 300% of premium.
  const target100 = premPerShare * 2;
  const target200 = premPerShare * 3;
  const target300 = premPerShare * 4;

  // Underlying price required for each multi-bagger (intrinsic ≥ premium × N).
  const underlyingFor = (intrinsicPerShare) => direction === "SHORT"
    ? Math.max(0, strike - intrinsicPerShare)
    : strike + intrinsicPerShare;
  const px2x = underlyingFor(premPerShare);   // intrinsic = premium → 2x play (~100%)
  const px3x = underlyingFor(premPerShare * 2); // 3x play
  const px5x = underlyingFor(premPerShare * 4); // 5x play

  const motionWord = motion?.evidence ? ` Momentum: ${motion.evidence}.` : "";
  const dirWord = direction === "SHORT" ? "down" : "up";
  const archetype = direction === "SHORT" ? "moonshot_put" : "moonshot_call";

  return {
    archetype,
    label: `🌙 Moonshot ${direction === "SHORT" ? "Put" : "Call"} (${expiration.dte}DTE, ${(targetDelta * 100).toFixed(0)}Δ)`,
    rationale: `🌙 The fused verdict says ${direction} with conviction AND the move is underway — gamma play.${motionWord} ${moonshotContracts}× $${strike} ${type === "P" ? "puts" : "calls"} expiring in ${expiration.dte} days. Risk $${Math.round(maxLoss)} for a shot at 2-5× if ${ctx.ticker || "underlying"} keeps moving ${dirWord} to $${px3x.toFixed(2)}+ by expiry. THIS IS A LOTTERY — small position, scale out aggressively on profits.`,
    target_delta: targetDelta,
    actual_delta: Number(prem.greeks?.delta) || null,
    legs: [{ action: "BUY", optionType: type === "P" ? "PUT" : "CALL", strike, expiration: expiration.iso, qty: moonshotContracts }],
    strikes: { primary: strike },
    expiration,
    premium: prem,
    contracts: moonshotContracts,
    max_loss_usd: Math.round(maxLoss),
    max_gain_label: "Uncapped — gamma-driven",
    breakeven: direction === "SHORT" ? strike - premPerShare : strike + premPerShare,
    multi_bagger_targets: {
      "2x_underlying_at": +px2x.toFixed(2),
      "3x_underlying_at": +px3x.toFixed(2),
      "5x_underlying_at": +px5x.toFixed(2),
    },
    moonshot: true,
    sizing_note: `${Math.round(moonshotBudget)}/$${Math.round(dollars_at_risk)} (40% of std risk budget — lottery)`,
    trade_mgmt: [
      "🎯 Scale out at +100% (sell 1/3), +200% (sell 1/2), +300% (let runner)",
      "⏰ Theta cliff — exit if no follow-through within 2-3 trading days",
      `🛡 Hard stop: ${ctx.ticker || "underlying"} closes below the breakout level`,
      `💸 Premium ≈ $${premPerShare.toFixed(2)}/contract × ${moonshotContracts} contracts = $${Math.round(maxLoss)} total at risk`,
    ],
    notes: [
      `Delta ${(Math.abs(prem.greeks?.delta || targetDelta) * 100).toFixed(0)}% — every $1 in direction ≈ $${(Math.abs(prem.greeks?.delta || targetDelta) * 100).toFixed(0)}/contract`,
      `Theta ≈ −$${Math.abs((prem.greeks?.theta || -premPerShare / expiration.dte) * 100 * moonshotContracts).toFixed(2)}/day decay`,
      `Vega ≈ $${((prem.greeks?.vega || 0) * 100 * moonshotContracts).toFixed(2)} per 1% IV change`,
    ],
  };
}

// 2026-05-30 — Leveraged ETF tier. Sits between Stock and Long Call in the
// risk ladder for users who want amplified beta without options' time
// decay / strike / expiration complexity.
function buildLeveragedETF(ctx) {
  const { ticker, price, sl, tp1, direction, dollars_at_risk, themes } = ctx;
  const letf = lookupLETF(ticker, themes);
  if (!letf) return null;
  const sideKey = direction === "SHORT" ? "short" : "long";
  const letfTicker = letf[sideKey];
  if (!letfTicker) {
    // No inverse LETF exists; if user wants short and only long LETF exists,
    // suggest puts on the long LETF as the leverage path — but that becomes
    // an options play, so we skip the LETF tier here.
    return null;
  }
  const factor = Number(letf.factor) || 2;
  // SL/TP geometry translates by factor (approximately, with daily-reset
  // decay above 3% moves — flag in notes).
  const underlyingPctMove = direction === "SHORT"
    ? ((price - tp1) / price)
    : ((tp1 - price) / price);
  const slPctMove = direction === "SHORT"
    ? ((sl - price) / price)
    : ((price - sl) / price);
  const letfExpectedGainPct = underlyingPctMove * factor * 100;
  const letfExpectedLossPct = slPctMove * factor * 100;
  // Position size: same dollars-at-risk constraint, but leverage means
  // smaller dollar allocation captures the same magnitude move.
  const shares = Math.max(1, Math.floor(dollars_at_risk / Math.max(0.5, slPctMove * factor * 100)));
  const notional = Math.round(shares * (price * 0.5)); // rough — LETF price varies
  return {
    archetype: "leveraged_etf",
    label: `${letfTicker} (${factor}× ${direction === "SHORT" ? "inverse" : "long"})`,
    rationale: `${factor}× leveraged ETF on ${ticker} (${letf.note}). No expiration, no Greeks. Daily-reset decay makes it a 1-5 day vehicle, not a buy-and-hold. Expected gain ≈ ${letfExpectedGainPct.toFixed(1)}% if ${ticker} moves to TP1. Risk ≈ ${letfExpectedLossPct.toFixed(1)}% if ${ticker} stops out.`,
    legs: [
      { action: direction === "SHORT" ? "SELL_SHORT" : "BUY", instrument: "ETF", ticker: letfTicker, qty: shares },
    ],
    underlying: ticker,
    letf_ticker: letfTicker,
    factor,
    contracts: shares,
    max_loss_usd: Math.round(dollars_at_risk),
    max_gain_label: `≈${letfExpectedGainPct.toFixed(0)}% on ${shares} shares if ${ticker} → $${tp1?.toFixed(2) ?? "TP"}`,
    notes: [
      `${factor}× daily-reset LETF — beta decay if held > ~5 trading days`,
      `For longer holds, use options or the underlying directly`,
      letf.theme ? `Mapped via theme: ${letf.theme}` : null,
    ].filter(Boolean),
  };
}

function buildLongStraddle(ctx) {
  const { price, atrPct, expiration, contracts, chain } = ctx;
  const strike = snapStrike(price);
  const callLeg = _chainLeg(chain, "C", strike);
  const putLeg  = _chainLeg(chain, "P", strike);
  const callPrem = estimatePremium({ price, strike, dte: expiration.dte, atrPct, type: "C", chainLeg: callLeg });
  const putPrem  = estimatePremium({ price, strike, dte: expiration.dte, atrPct, type: "P", chainLeg: putLeg });
  if (!callPrem || !putPrem) return null;
  const totalPrem = callPrem.mid + putPrem.mid;
  const maxLoss = totalPrem * 100 * contracts;
  return {
    archetype: "long_straddle",
    label: "Long Straddle (ATM)",
    rationale: `Direction unclear but BIG move expected (squeeze release, earnings, catalyst pending). Buy ATM call AND put — profit from any move > $${totalPrem.toFixed(2)} in either direction. Max loss = premium if price expires at strike.`,
    legs: [
      { action: "BUY", optionType: "CALL", strike, expiration: expiration.iso, qty: contracts },
      { action: "BUY", optionType: "PUT",  strike, expiration: expiration.iso, qty: contracts },
    ],
    strikes: { primary: strike },
    expiration,
    premium: { mid: totalPrem, low: totalPrem * 0.9, high: totalPrem * 1.1, iv_used: callPrem.iv_used },
    contracts,
    max_loss_usd: Math.round(maxLoss),
    breakeven_up:   strike + totalPrem,
    breakeven_down: strike - totalPrem,
    max_gain_label: "Uncapped in either direction",
    notes: [
      `Needs ≥ ${((totalPrem / price) * 100).toFixed(1)}% move from $${price.toFixed(2)} to profit`,
      `IV crush after catalyst is the main risk`,
    ],
  };
}

// ── Strategy ranking by profile + confluence + moonshot ───────────────────
// Priority order:
//   1. 🌙 Moonshot active (when ALL conditions met) — top of ladder
//   2. Confluence-boosted plays (RIDE → long premium, FADE → spreads)
//   3. Risk profile preference
// The stock fallback always remains so every profile sees something
// actionable even when WAIT / no confluence.
function rankByProfile(strategies, profile) {
  const order = PROFILE_META[profile]?.preferred || PROFILE_META.speculator.preferred;
  const profileScore = (s) => {
    const idx = order.indexOf(s.archetype);
    return idx === -1 ? 999 : idx;
  };
  return [...strategies].sort((a, b) => {
    // Moonshot wins above everything when active (it IS the gem).
    const aMoon = a._moonshot_active ? -100 : 0;
    const bMoon = b._moonshot_active ? -100 : 0;
    if (aMoon !== bMoon) return aMoon - bMoon;
    // Confluence boost — RIDE ⇒ long premium / FADE ⇒ spreads.
    const aBoost = a._confluence_boost ? -10 : 0;
    const bBoost = b._confluence_boost ? -10 : 0;
    if (aBoost !== bBoost) return aBoost - bBoost;
    return profileScore(a) - profileScore(b);
  });
}

// ── Public: build the full ladder for a contract ───────────────────────────
//
// contract: trader prediction contract object (price, direction, sl, tp1,
//           tp2, tp3, rr, tier, stage, atr_pct, ...).
// opts.profile         — risk profile (defaults to speculator)
// opts.account_value   — for sizing (defaults to 100k baseline)
// opts.risk_budget_pct — per-trade risk (defaults to contract's tier risk %)
// opts.chain           — OPTIONAL live options chain. Without it we use
//                        Black-Scholes + ATR-IV estimates.
// opts.confluence      — OPTIONAL TT Root Strategy verdict from
//                        scoreRootConfluence(). When supplied:
//                          mode=RIDE → bias ladder to long premium (max convexity)
//                          mode=READY → return ladder as "prepare" cards w/ note
//                          mode=DRIFT → demote long premium, prefer spreads
//                          mode=FADE → invert direction or favor credit spreads
//                          mode=WAIT → return iron-condor-only or stock-only
// opts.themes          — OPTIONAL ticker theme list (for LETF lookup)
//
export function buildOptionsLadder(contract, opts = {}) {
  if (!contract || !Number.isFinite(Number(contract.price))) return null;

  const profile = opts.profile && PROFILE_META[opts.profile] ? opts.profile : DEFAULT_RISK_PROFILE;
  const accountValue = Number(opts.account_value) || 100_000;
  const riskBudgetPct = Number(opts.risk_budget_pct) || Number(contract.riskPct) || 0.005;

  const price = Number(contract.price);
  const direction = String(contract.direction || "").toUpperCase();
  const sl = Number(contract.sl);
  const tp1 = Number(contract.tp1 ?? contract.tp ?? (direction === "LONG" ? price * 1.05 : price * 0.95));
  const atrPct = Number(contract.atr_pct ?? contract.atrPct ?? 0.025);
  const expiration = pickExpiration(classifySetupStage(contract));

  // Sizing: dollars at risk = accountValue × riskBudgetPct.
  // Each long-option contract risks 100 × premium. Solve for # contracts.
  const dollarsAtRisk = Math.max(50, accountValue * riskBudgetPct);
  // Estimate ATM premium to back into contract count.
  const atmType = direction === "SHORT" ? "P" : "C";
  const atmEst = estimatePremium({ price, strike: snapStrike(price), dte: expiration.dte, atrPct, type: atmType });
  const atmPrem = atmEst?.mid || 1.0;
  const contracts = Math.max(1, Math.floor(dollarsAtRisk / (atmPrem * 100)));

  // ── Delta target selection by confluence mode + risk profile ────────────
  // Carter's framework codified:
  //   RIDE + Speculator   → 0.70 delta (stock replacement, high conviction)
  //   RIDE + Aggressive   → 0.50 delta (ATM balanced)
  //   READY/DRIFT         → 0.50 delta (don't lean too far in until confirmed)
  //   FADE                → 0.30 delta (countertrend = use OTM for cheap entry)
  //   WAIT                → 0.50 delta (any directional is suppressed anyway)
  const verdictModeForDelta = opts.confluence?.mode || "UNKNOWN";
  const targetDelta = (() => {
    if (verdictModeForDelta === "RIDE") {
      return profile === "speculator" ? 0.70 : 0.50;
    }
    if (verdictModeForDelta === "FADE") return 0.30;
    if (verdictModeForDelta === "READY" || verdictModeForDelta === "DRIFT") return 0.50;
    return 0.50;
  })();

  const ctx = {
    ticker: contract.ticker,
    price, direction, sl, tp1, atrPct, expiration, contracts,
    account_value: accountValue, risk_budget_pct: riskBudgetPct,
    dollars_at_risk: dollarsAtRisk,
    chain: opts.chain || null,
    themes: Array.isArray(opts.themes) ? opts.themes : [],
    targetDelta,
  };

  // ── Moonshot activation check — flagship tier ───────────────────────────
  // Activates only when ALL of: RIDE mode + ST fresh + momentum in motion +
  // Speculator/Aggressive profile. Returns null otherwise.
  const moonshotDecision = shouldActivateMoonshot({
    confluence: opts.confluence,
    tickerData: opts.tickerData || contract,
    profile,
  });

  // ── Root-strategy confluence integration ────────────────────────────────
  // When a verdict is supplied, it influences:
  //   - DIRECTIONAL plays (Long Call/Put) only run if the verdict's side
  //     matches the contract direction OR mode is FADE (in which case we
  //     flip to the FADE side).
  //   - In FADE mode we lean credit spreads + iron condors (sell premium).
  //   - In WAIT mode we suppress directional plays and only show defined-
  //     risk + stock alternatives.
  //   - In RIDE mode the long-premium plays get a `confluence_boost` tag
  //     so the ranker can elevate them.
  const verdict = opts.confluence || null;
  const verdictMode = verdict?.mode || "UNKNOWN";
  const verdictSide = verdict?.side || direction;
  const effectiveDirection = (verdictMode === "FADE" && verdict?.side && verdict.side !== "NEUTRAL")
    ? verdict.side
    : direction;
  // Re-derive context price-target geometry for FADE flips.
  const fadeFlipped = effectiveDirection !== direction;
  const ctxEff = fadeFlipped ? { ...ctx, direction: effectiveDirection, tp1: sl, sl: tp1 } : ctx;

  const ladder = [];

  // Suppress directional plays entirely in WAIT mode.
  const suppressDirectional = verdictMode === "WAIT";

  // 🌙 MOONSHOT — if all activation conditions met, insert at TOP of ladder.
  // This is the gem: short-dated OTM gamma play when the model has identified
  // both direction AND moment with multi-layer confluence.
  if (moonshotDecision.activate && !suppressDirectional) {
    const moonshot = buildMoonshot(
      { ...ctxEff, motion: moonshotDecision.motion },
      effectiveDirection,
    );
    if (moonshot) {
      moonshot._confluence_boost = true; // always top of ladder when active
      moonshot._moonshot_active = true;
      ladder.push(moonshot);
    }
  }

  if (!suppressDirectional && (effectiveDirection === "LONG" || effectiveDirection === "")) {
    const lc = buildLongCall(ctxEff);
    if (lc) {
      if (verdictMode === "RIDE") lc._confluence_boost = true;
      if (verdictMode === "READY") lc._pending_trigger = true;
      if (verdictMode === "DRIFT") lc._late_entry = true;
      ladder.push(lc);
    }
    const bcs = buildVerticalSpread(ctxEff, "long");
    if (bcs) {
      if (verdictMode === "FADE" || verdictMode === "DRIFT") bcs._confluence_boost = true;
      ladder.push(bcs);
    }
    const letfLong = buildLeveragedETF({ ...ctxEff, direction: "LONG" });
    if (letfLong) ladder.push(letfLong);
    const csp = buildCashSecuredPut(ctxEff);
    if (csp) ladder.push(csp);
    const cc = buildCoveredCall(ctxEff);
    if (cc) ladder.push(cc);
    ladder.push({
      archetype: "stock_long",
      label: "Stock (Long)",
      rationale: `Plain stock long at $${price.toFixed(2)}. Stop $${sl?.toFixed(2) ?? "?"}, target $${tp1?.toFixed(2) ?? "?"}. No leverage, no time decay, full participation.`,
      legs: [{ action: "BUY", instrument: "STOCK", qty: Math.floor(dollarsAtRisk / (Math.abs(price - sl) || 1)) }],
      max_loss_usd: Math.round(Math.abs(price - sl) * Math.floor(dollarsAtRisk / (Math.abs(price - sl) || 1))),
      max_gain_usd: Math.round(Math.abs(tp1 - price) * Math.floor(dollarsAtRisk / (Math.abs(price - sl) || 1))),
      notes: ["No expiration", "Full account participation in moves"],
    });
  }

  if (!suppressDirectional && (effectiveDirection === "SHORT" || effectiveDirection === "")) {
    const lp = buildLongPut(ctxEff);
    if (lp) {
      if (verdictMode === "RIDE") lp._confluence_boost = true;
      if (verdictMode === "READY") lp._pending_trigger = true;
      if (verdictMode === "DRIFT") lp._late_entry = true;
      ladder.push(lp);
    }
    const bps = buildVerticalSpread(ctxEff, "short");
    if (bps) {
      if (verdictMode === "FADE" || verdictMode === "DRIFT") bps._confluence_boost = true;
      ladder.push(bps);
    }
    const letfShort = buildLeveragedETF({ ...ctxEff, direction: "SHORT" });
    if (letfShort) ladder.push(letfShort);
    ladder.push({
      archetype: "stock_short",
      label: "Stock (Short)",
      rationale: `Short stock at $${price.toFixed(2)}. Stop $${sl?.toFixed(2) ?? "?"}, target $${tp1?.toFixed(2) ?? "?"}. Requires margin + locate.`,
      legs: [{ action: "SELL_SHORT", instrument: "STOCK", qty: Math.floor(dollarsAtRisk / (Math.abs(price - sl) || 1)) }],
      max_loss_usd: Math.round(Math.abs(price - sl) * Math.floor(dollarsAtRisk / (Math.abs(price - sl) || 1))),
      notes: ["Borrow + locate required", "Margin requirement applies"],
    });
  }

  if (verdictMode === "WAIT" || direction === "" || atrPct >= 0.04) {
    const ls = buildLongStraddle(ctxEff);
    if (ls) ladder.push(ls);
  }

  // 2026-05-30 — Liquidity + IV warnings (per-play). Surfaced as
  // `warnings: [...]` arrays. UI renders as orange chips.
  //
  // Two operating modes:
  //   - With live chain: real bid/ask/OI/IV per leg — full diagnostic.
  //   - Without chain: only IV-crush warning from contract.earnings_dte
  //     vs setup's expected IV (ATR-derived).
  for (const s of ladder) {
    const warns = [];
    for (const leg of (s.legs || [])) {
      if (leg.instrument === "STOCK" || leg.instrument === "ETF") continue;
      const side = leg.optionType === "PUT" ? "P" : "C";
      const cl = opts.chain ? _chainLeg(opts.chain, side, leg.strike) : null;
      if (opts.chain && !cl) {
        warns.push(`No live quote for $${leg.strike} ${leg.optionType} — strike may not exist on the chain.`);
        continue;
      }
      if (cl) {
        const oi = Number(cl.open_interest) || 0;
        const vol = Number(cl.volume) || 0;
        // Liquidity gate: OI < 100 AND volume < 50 = illiquid.
        if (oi < 100 && vol < 50) {
          warns.push(`Illiquid: $${leg.strike} ${leg.optionType} OI=${oi} vol=${vol} — fills may slip $0.10+.`);
        } else if (oi < 100) {
          warns.push(`Low OI on $${leg.strike} ${leg.optionType} (${oi} open) — verify before sizing up.`);
        }
        // Spread gate.
        if (Number.isFinite(cl.bid) && Number.isFinite(cl.ask) && cl.ask > 0) {
          const spreadPct = ((cl.ask - cl.bid) / cl.ask) * 100;
          if (spreadPct > 15) {
            warns.push(`Wide bid-ask on $${leg.strike} ${leg.optionType} (${spreadPct.toFixed(0)}% spread) — limit order required.`);
          } else if (spreadPct > 8) {
            warns.push(`Moderate spread on $${leg.strike} ${leg.optionType} (${spreadPct.toFixed(0)}%) — use mid-price limit.`);
          }
        }
        // IV crush warning.
        const iv = Number(cl.implied_volatility);
        const earnDte = Number(contract.earnings_dte ?? contract.earningsDte);
        if (Number.isFinite(iv) && iv > 0.80 && Number.isFinite(earnDte) && earnDte > 0 && earnDte <= expiration.dte) {
          warns.push(`⚠ Earnings in ${earnDte}d + IV ${(iv * 100).toFixed(0)}% — expect heavy IV crush post-event. Consider exiting before report.`);
        }
        // Elevated IV → suggest spread instead of long single.
        if (Number.isFinite(iv) && iv > 0.60 && (s.archetype === "long_call" || s.archetype === "long_put" || s.archetype === "moonshot_call" || s.archetype === "moonshot_put")) {
          warns.push(`IV elevated (${(iv * 100).toFixed(0)}%) — paying expensive vol. Spread alternatives below offer cheaper exposure.`);
        }
      } else {
        // No chain — at least surface earnings IV crush warning from contract.
        const earnDte = Number(contract.earnings_dte ?? contract.earningsDte);
        if (Number.isFinite(earnDte) && earnDte > 0 && earnDte <= expiration.dte) {
          warns.push(`⚠ Earnings in ${earnDte}d before expiry. Verify IV in your broker chain — IV crush risk post-event.`);
        }
      }
    }
    if (warns.length > 0) s.warnings = warns;
  }

  const ranked = rankByProfile(ladder, profile);
  const primary = ranked[0] || null;

  // Also build a per-profile preview so the UI can show "what each profile
  // would do with this setup" — educational on the Today page.
  const ladder_by_profile = {};
  for (const p of RISK_PROFILES) {
    const r = rankByProfile(ladder, p);
    ladder_by_profile[p] = r[0]?.archetype || null;
  }

  return {
    contract: {
      ticker: contract.ticker,
      direction, price, sl, tp1,
      tier: contract.tier || null,
      rr: Number(contract.rr) || null,
      stage: classifySetupStage(contract),
      atr_pct: atrPct,
    },
    profile,
    profile_meta: PROFILE_META[profile],
    account_value: accountValue,
    risk_budget_pct: riskBudgetPct,
    dollars_at_risk: Math.round(dollarsAtRisk),
    expiration,
    primary,
    ladder: ranked,
    ladder_by_profile,
    using_live_chain: !!opts.chain,
    // Confluence verdict echo + how it shaped the ladder.
    confluence_mode: verdictMode,
    confluence_side: verdictSide,
    confluence_score: Number(verdict?.score) || null,
    confluence_summary: verdict?.actionable_summary || null,
    direction_flipped_by_confluence: fadeFlipped,
    target_delta: targetDelta,
    // Moonshot tier metadata — UI uses to surface special treatment.
    moonshot: {
      activated: !!moonshotDecision.activate,
      reason: moonshotDecision.reason || null,
      motion: moonshotDecision.motion || null,
    },
    estimated_premium_caveat: opts.chain
      ? null
      : "Premium values are Black-Scholes estimates using ATR-implied volatility. Verify in your broker chain before executing.",
    generated_at: Date.now(),
  };
}

/**
 * Pick a single best strategy archetype for a given profile + contract.
 * Used by the auto-mirror engine (Phase 3) to choose which play to route
 * for the operator's account.
 */
export function selectStrategy(contract, profile = DEFAULT_RISK_PROFILE) {
  const ladder = buildOptionsLadder(contract, { profile });
  if (!ladder || !ladder.primary) return null;
  return {
    archetype: ladder.primary.archetype,
    rationale: ladder.primary.rationale,
    play: ladder.primary,
  };
}
