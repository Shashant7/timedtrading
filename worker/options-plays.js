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

function buildLongCall(ctx) {
  const { price, tp1, sl, atrPct, expiration, contracts, chain } = ctx;
  const strike = snapStrike(price);
  const chainLeg = _chainLeg(chain, "C", strike);
  const prem = estimatePremium({ price, strike, dte: expiration.dte, atrPct, type: "C", chainLeg });
  if (!prem) return null;
  const premPerShare = prem.mid;
  const maxLoss = premPerShare * 100 * contracts;
  const breakeven = strike + premPerShare;
  // Max gain at TP1 — intrinsic value at target.
  const intrinsicAtTP = Math.max(0, tp1 - strike);
  const gainAtTP = (intrinsicAtTP - premPerShare) * 100 * contracts;
  return {
    archetype: "long_call",
    label: "Long Call (ATM)",
    rationale: `Bullish bias to $${tp1?.toFixed(2) ?? "?"}. ATM call gives ~${(prem.greeks.delta * 100).toFixed(0)}% delta — every $1 the underlying moves up nets ~$${(prem.greeks.delta * 100).toFixed(0)}/contract. Max loss = premium paid.`,
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
  const { price, tp1, sl, atrPct, expiration, contracts, chain } = ctx;
  const strike = snapStrike(price);
  const chainLeg = _chainLeg(chain, "P", strike);
  const prem = estimatePremium({ price, strike, dte: expiration.dte, atrPct, type: "P", chainLeg });
  if (!prem) return null;
  const premPerShare = prem.mid;
  const maxLoss = premPerShare * 100 * contracts;
  const breakeven = strike - premPerShare;
  const intrinsicAtTP = Math.max(0, strike - tp1);
  const gainAtTP = (intrinsicAtTP - premPerShare) * 100 * contracts;
  return {
    archetype: "long_put",
    label: "Long Put (ATM)",
    rationale: `Bearish bias to $${tp1?.toFixed(2) ?? "?"}. ATM put gives ~${(Math.abs(prem.greeks.delta) * 100).toFixed(0)}% delta — every $1 down nets ~$${(Math.abs(prem.greeks.delta) * 100).toFixed(0)}/contract. Max loss = premium paid.`,
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

// ── Strategy ranking by profile ────────────────────────────────────────────
// Returns ladder ranked by profile preference — first card is the headline,
// subsequent cards are gradient alternatives (cheaper / safer or more
// convex). Always includes at least the stock fallback so EVERY profile
// sees something actionable.
function rankByProfile(strategies, profile) {
  const order = PROFILE_META[profile]?.preferred || PROFILE_META.speculator.preferred;
  const score = (s) => {
    const idx = order.indexOf(s.archetype);
    return idx === -1 ? 999 : idx;
  };
  return [...strategies].sort((a, b) => score(a) - score(b));
}

// ── Public: build the full ladder for a contract ───────────────────────────
//
// contract: trader prediction contract object (price, direction, sl, tp1,
//           tp2, tp3, rr, tier, stage, atr_pct, ...).
// opts.profile        — risk profile (defaults to speculator)
// opts.account_value  — for sizing (defaults to 100k baseline)
// opts.risk_budget_pct— per-trade risk (defaults to contract's tier risk %)
// opts.chain          — OPTIONAL live options chain (v2). If absent we use
//                       Black-Scholes + ATR-IV estimates.
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

  const ctx = {
    price, direction, sl, tp1, atrPct, expiration, contracts,
    account_value: accountValue, risk_budget_pct: riskBudgetPct,
    dollars_at_risk: dollarsAtRisk,
    chain: opts.chain || null, // v2 — real chain data when supplied
  };

  const ladder = [];

  if (direction === "LONG" || direction === "") {
    // Always offer the multi-bagger play first when bias is bullish.
    const lc = buildLongCall(ctx);
    if (lc) ladder.push(lc);
    const bcs = buildVerticalSpread(ctx, "long");
    if (bcs) ladder.push(bcs);
    const csp = buildCashSecuredPut(ctx);
    if (csp) ladder.push(csp);
    const cc = buildCoveredCall(ctx);
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

  if (direction === "SHORT" || direction === "") {
    const lp = buildLongPut(ctx);
    if (lp) ladder.push(lp);
    const bps = buildVerticalSpread(ctx, "short");
    if (bps) ladder.push(bps);
    ladder.push({
      archetype: "stock_short",
      label: "Stock (Short)",
      rationale: `Short stock at $${price.toFixed(2)}. Stop $${sl?.toFixed(2) ?? "?"}, target $${tp1?.toFixed(2) ?? "?"}. Requires margin + locate.`,
      legs: [{ action: "SELL_SHORT", instrument: "STOCK", qty: Math.floor(dollarsAtRisk / (Math.abs(price - sl) || 1)) }],
      max_loss_usd: Math.round(Math.abs(price - sl) * Math.floor(dollarsAtRisk / (Math.abs(price - sl) || 1))),
      notes: ["Borrow + locate required", "Margin requirement applies"],
    });
  }

  if (direction === "" || atrPct >= 0.04) {
    // Direction-neutral OR very volatile setup → straddle option.
    const ls = buildLongStraddle(ctx);
    if (ls) ladder.push(ls);
  }

  // 2026-05-30 — Liquidity + IV warnings (only computable with live chain).
  // Surface as `warnings: [...]` on each play. UI renders these as orange
  // chips on the strategy card so users can defer / pick a different
  // strategy if a leg is illiquid.
  if (opts.chain) {
    for (const s of ladder) {
      const warns = [];
      for (const leg of (s.legs || [])) {
        if (leg.instrument === "STOCK") continue;
        const side = leg.optionType === "PUT" ? "P" : "C";
        const cl = _chainLeg(opts.chain, side, leg.strike);
        if (!cl) {
          warns.push(`No live quote for $${leg.strike} ${leg.optionType} — strike may not exist on the chain.`);
          continue;
        }
        if ((cl.open_interest || 0) < 100) {
          warns.push(`Low OI on $${leg.strike} ${leg.optionType} (${cl.open_interest || 0} contracts) — fills may be poor.`);
        }
        if (Number.isFinite(cl.bid) && Number.isFinite(cl.ask) && cl.ask > 0) {
          const spreadPct = ((cl.ask - cl.bid) / cl.ask) * 100;
          if (spreadPct > 10) {
            warns.push(`Wide bid-ask on $${leg.strike} ${leg.optionType} (${spreadPct.toFixed(0)}% spread) — expect slippage.`);
          }
        }
        // IV crush check: if implied vol > 80% AND earnings within DTE window.
        const iv = Number(cl.implied_volatility);
        if (Number.isFinite(iv) && iv > 0.80 && Number(contract.earnings_dte) > 0 && Number(contract.earnings_dte) <= expiration.dte) {
          warns.push(`Earnings before expiry + IV ${(iv * 100).toFixed(0)}% — heavy IV crush risk post-event.`);
        }
      }
      if (warns.length > 0) s.warnings = warns;
    }
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
