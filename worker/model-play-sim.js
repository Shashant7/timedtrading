// worker/model-play-sim.js
// -----------------------------------------------------------------------------
// Model play simulated execution — fill the vehicle the model chose.
//
// MVP:
//   • options — long debit single-leg paper (premium × 100 × contracts)
//   • letf    — stock-like fill of mapped LETF when a live quote exists
//   • shares  — unchanged baseline
//
// Options marks use Black-Scholes + ATR IV proxy (same estimator as
// options-plays). Not OPRA. Always stamp mark_source.
// -----------------------------------------------------------------------------

import { blackScholes } from "./options-plays.js";
import { normalizePlayVehicle, playVehicleLabel } from "./play-the-move.js";

function impliedVolFromATR(atrPct) {
  if (!Number.isFinite(atrPct) || atrPct <= 0) return 0.40;
  const annualized = atrPct * Math.sqrt(252);
  return Math.max(0.15, Math.min(2.0, annualized));
}

const LONG_DEBIT_ARCHETYPES = new Set([
  "long_call", "long_put",
  "leap_call", "leap_put",
  "moonshot_call", "moonshot_put",
  "lotto_call", "lotto_put",
]);

export function isModelPlaySimEnabled(env, { isReplay = false } = {}) {
  // DEFAULT OFF until D1 positions/trades hydrate vehicle fills
  // (options_paper / letf_paper) and close/trim cash paths are vehicle-aware.
  // Flip deep_audit_model_play_sim_enabled=true only after that lands.
  // Replay stays shares-only unless explicitly forced.
  if (isReplay) {
    return String(env?._deepAuditConfig?.deep_audit_model_play_sim_replay ?? "false") === "true";
  }
  const cfg = env?._deepAuditConfig?.deep_audit_model_play_sim_enabled
    ?? env?.MODEL_PLAY_SIM_ENABLED
    ?? "false";
  return String(cfg) === "true";
}

/** Long debit single-leg only — credit/undefined-risk stays counterfactual. */
export function canPaperFillOptions(play) {
  if (!play || typeof play !== "object") return false;
  const arch = String(play.archetype || "").toLowerCase();
  if (!LONG_DEBIT_ARCHETYPES.has(arch) && play.net_side && play.net_side !== "debit") {
    return false;
  }
  if (!LONG_DEBIT_ARCHETYPES.has(arch) && !arch.includes("call") && !arch.includes("put")) {
    // Allow compact plays that expose a single long option leg without archetype.
    const legs = Array.isArray(play.legs) ? play.legs.filter((l) => l?.kind === "option") : [];
    if (legs.length !== 1) return false;
    if (String(legs[0].action || "").toUpperCase() !== "BUY") return false;
  } else if (!LONG_DEBIT_ARCHETYPES.has(arch)) {
    return false;
  }
  const leg = resolvePrimaryOptionLeg(play);
  if (!leg) return false;
  const prem = Number(leg.premium_mid ?? play.premium_mid ?? play.net_cost_usd);
  // net_cost_usd is total; prefer per-share mid.
  const premium = Number(leg.premium_mid);
  if (!(premium > 0) && !(Number(play.net_cost_usd) > 0)) return false;
  if (!(Number(leg.strike) > 0)) return false;
  return true;
}

export function resolvePrimaryOptionLeg(play) {
  const legs = Array.isArray(play?.legs) ? play.legs.filter((l) => l && l.kind === "option") : [];
  if (!legs.length) {
    // Some compact shapes omit legs but carry strike/type on the play.
    if (play?.strike && play?.type) {
      return {
        kind: "option",
        action: "BUY",
        type: String(play.type).toUpperCase(),
        strike: Number(play.strike),
        expiration: play.expiration?.iso || play.expiration || null,
        premium_mid: Number(play.premium_mid) || null,
        qty: 1,
      };
    }
    return null;
  }
  const buy = legs.find((l) => String(l.action || "").toUpperCase() === "BUY") || legs[0];
  return buy;
}

/**
 * Size long-premium paper fill from the same risk budget as shares.
 * @returns fill object or null
 */
export function buildOptionsPaperFill({
  play,
  riskBudgetUsd,
  cash,
  underlyingEntry,
  underlyingSl,
  underlyingTp,
  atrPct,
  asOfMs = Date.now(),
} = {}) {
  if (!canPaperFillOptions(play)) return null;
  const leg = resolvePrimaryOptionLeg(play);
  let premium = Number(leg.premium_mid);
  if (!(premium > 0) && Number(play.net_cost_usd) > 0) {
    // Fall back: net debit for 1 contract → per-share premium.
    premium = Number(play.net_cost_usd) / 100;
  }
  if (!(premium > 0)) return null;

  const maxLossPerContract = Number(play.max_loss_usd) > 0
    ? Number(play.max_loss_usd)
    : premium * 100;
  const budget = Math.max(0, Number(riskBudgetUsd) || 0);
  const available = Math.max(0, Number(cash) || 0);
  if (!(budget > 0) || !(available > 0)) return null;

  let contracts = Math.floor(budget / maxLossPerContract);
  if (contracts < 1) {
    // Allow 1 contract if cash covers premium and max loss ≤ 1.5× budget.
    if (maxLossPerContract <= budget * 1.5 && premium * 100 <= available) contracts = 1;
    else return null;
  }
  // Cap by cash (debit).
  while (contracts > 0 && premium * 100 * contracts > available) contracts -= 1;
  if (contracts < 1) return null;

  const debitUsd = Math.round(premium * 100 * contracts * 100) / 100;
  const right = String(leg.type || "").toUpperCase().startsWith("P") ? "P" : "C";
  const expIso = leg.expiration || play.expiration?.iso || play.expiration || null;
  const expMs = expIso ? Date.parse(String(expIso).length <= 10 ? `${expIso}T21:00:00Z` : expIso) : null;
  const dte = Number.isFinite(expMs)
    ? Math.max(1, Math.ceil((expMs - asOfMs) / 86400000))
    : (Number(play.dte) || 30);

  return {
    vehicle: "options",
    play_vehicle: "options",
    mark_source: "bs_atr_proxy",
    archetype: play.archetype || null,
    label: play.label || play.headline || playVehicleLabel("options"),
    right,
    strike: Number(leg.strike),
    expiration_iso: expIso ? String(expIso).slice(0, 10) : null,
    expiration_ms: Number.isFinite(expMs) ? expMs : null,
    dte_at_entry: dte,
    premium_entry: Math.round(premium * 100) / 100,
    contracts,
    multiplier: 100,
    debit_usd: debitUsd,
    max_loss_usd: Math.round(maxLossPerContract * contracts),
    underlying_entry: Number(underlyingEntry) || null,
    underlying_sl: Number(underlyingSl) || null,
    underlying_tp: Number(underlyingTp) || null,
    atr_pct: Number(atrPct) || null,
    breakeven: play.breakeven ?? null,
    filled_at: asOfMs,
  };
}

/** Mark long option paper at current underlying. */
export function markOptionsPaperPosition(paper, { underlyingPrice, atrPct, asOfMs = Date.now() } = {}) {
  if (!paper || paper.vehicle !== "options") return null;
  const S = Number(underlyingPrice);
  const K = Number(paper.strike);
  const premPaid = Number(paper.premium_entry);
  const contracts = Number(paper.contracts) || 0;
  if (!(S > 0 && K > 0 && premPaid > 0 && contracts > 0)) return null;

  let dte = Number(paper.dte_at_entry) || 30;
  if (Number.isFinite(Number(paper.expiration_ms))) {
    dte = Math.max(0, Math.ceil((Number(paper.expiration_ms) - asOfMs) / 86400000));
  }
  // Expired → intrinsic only.
  if (dte <= 0) {
    const intrinsic = paper.right === "P"
      ? Math.max(0, K - S)
      : Math.max(0, S - K);
    const mark = Math.round(intrinsic * 100) / 100;
    const pnl = (mark - premPaid) * 100 * contracts;
    return {
      mark_premium: mark,
      mark_source: "expired_intrinsic",
      dte: 0,
      value_usd: Math.round(mark * 100 * contracts * 100) / 100,
      pnl_usd: Math.round(pnl * 100) / 100,
      pnl_pct: premPaid > 0 ? Math.round(((mark - premPaid) / premPaid) * 10000) / 100 : null,
    };
  }

  const sigma = impliedVolFromATR(
    Number.isFinite(Number(atrPct)) ? Number(atrPct)
      : (Number.isFinite(Number(paper.atr_pct)) ? Number(paper.atr_pct) : 0.02),
  );
  const bs = blackScholes({
    S, K, T: dte / 365, sigma, type: paper.right === "P" ? "P" : "C",
  });
  if (!bs) return null;
  const mark = bs.price;
  const pnl = (mark - premPaid) * 100 * contracts;
  return {
    mark_premium: mark,
    mark_source: "bs_atr_proxy",
    dte,
    delta: bs.delta,
    value_usd: Math.round(mark * 100 * contracts * 100) / 100,
    pnl_usd: Math.round(pnl * 100) / 100,
    pnl_pct: premPaid > 0 ? Math.round(((mark - premPaid) / premPaid) * 10000) / 100 : null,
  };
}

/**
 * LETF stock-like fill when a live quote exists for the mapped ticker.
 */
export function buildLetfPaperFill({
  pick,
  riskBudgetUsd,
  cash,
  underlyingEntry,
  underlyingSl,
  underlyingTp,
  letfPrice,
  asOfMs = Date.now(),
} = {}) {
  const letfTicker = String(pick?.letf_ticker || "").toUpperCase();
  const px = Number(letfPrice);
  if (!letfTicker || !(px > 0)) return null;
  const budget = Math.max(0, Number(riskBudgetUsd) || 0);
  const available = Math.max(0, Number(cash) || 0);
  if (!(budget > 0) || !(available > 0)) return null;

  // Approximate stop distance from underlying geometry, applied to LETF price.
  const uEntry = Number(underlyingEntry);
  const uSl = Number(underlyingSl);
  let stopPct = 0.03;
  if (uEntry > 0 && uSl > 0) {
    stopPct = Math.max(0.005, Math.abs(uEntry - uSl) / uEntry);
    // 3x LETF ≈ 3× underlying move — widen stop distance in LETF space.
    stopPct = Math.min(0.25, stopPct * 3);
  }
  const riskPerShare = px * stopPct;
  if (!(riskPerShare > 0)) return null;
  let shares = Math.floor(budget / riskPerShare);
  if (shares < 1) shares = 1;
  while (shares > 0 && shares * px > available) shares -= 1;
  if (shares < 1) return null;

  const dirLong = true; // LETF ticker already encodes short (SQQQ etc.)
  const sl = Math.round(px * (1 - stopPct) * 100) / 100;
  const uTp = Number(underlyingTp);
  let tp = null;
  if (uEntry > 0 && uTp > 0) {
    const tpPct = Math.abs(uTp - uEntry) / uEntry * 3;
    tp = Math.round(px * (1 + tpPct) * 100) / 100;
  }

  return {
    vehicle: "letf",
    play_vehicle: "letf",
    mark_source: "letf_quote",
    letf_ticker: letfTicker,
    label: pick?.label || `${letfTicker} leveraged ETF`,
    entry_price: px,
    shares,
    notional: Math.round(shares * px * 100) / 100,
    sl,
    tp,
    underlying_entry: uEntry || null,
    underlying_sl: uSl || null,
    underlying_tp: uTp || null,
    filled_at: asOfMs,
    direction_note: dirLong ? "long_letf_ticker" : null,
  };
}

/**
 * Apply chosen play to an already-sized shares trade + portfolio cash.
 * Refunds shares notional, applies vehicle fill. Mutates trade + portfolio.
 *
 * @returns {{ executed_vehicle, fill }} 
 */
export function applyModelPlaySimToTrade({
  trade,
  portfolio,
  menu,
  optionsPlay,
  riskBudgetUsd,
  letfPrice = null,
  atrPct = null,
  asOfMs = Date.now(),
} = {}) {
  const pick = menu?.pick || null;
  const playVehicle = normalizePlayVehicle(pick?.play_vehicle || pick?.vehicle) || "shares";
  if (playVehicle === "shares" || !pick) {
    return { executed_vehicle: "shares", fill: null };
  }

  const sharesCost = Number(trade.entryPrice) * Number(trade.shares);
  const cashBeforeRefund = Number(portfolio?.cash);
  // Portfolio was already debited for shares — refund before vehicle fill.
  if (portfolio && Number.isFinite(sharesCost) && sharesCost > 0) {
    portfolio.cash = cashBeforeRefund + sharesCost;
  }

  if (playVehicle === "options") {
    const fill = buildOptionsPaperFill({
      play: optionsPlay || pick,
      riskBudgetUsd: riskBudgetUsd || sharesCost * 0.02, // fallback: ~2% of prior notional
      cash: Number(portfolio?.cash),
      underlyingEntry: trade.entryPrice,
      underlyingSl: trade.sl,
      underlyingTp: trade.tp,
      atrPct,
      asOfMs,
    });
    if (!fill) {
      // Re-debit shares; keep baseline.
      if (portfolio && Number.isFinite(sharesCost)) portfolio.cash -= sharesCost;
      return { executed_vehicle: "shares", fill: null, fallback_reason: "options_fill_unavailable" };
    }
    trade.vehicle = "options";
    trade.executed_vehicle = "options";
    trade.play_vehicle = "options";
    trade.underlying_ticker = trade.ticker;
    trade.underlying_entry = Number(trade.entryPrice);
    trade.underlying_sl = Number(trade.sl);
    trade.underlying_tp = Number(trade.tp);
    // Exit triggers stay on underlying levels (sl/tp unchanged).
    trade.entryPrice = fill.premium_entry;
    trade.shares = fill.contracts;
    trade.contracts = fill.contracts;
    trade.pointValue = 100;
    trade.notional = fill.debit_usd;
    trade.options_paper = fill;
    // All-or-nothing premium book — single full exit at underlying TP.
    trade.trimTiers = [
      { tier: "EXIT", pct: 1.0, hit: false, hitTs: null },
    ];
    trade.no_partial_trims = true;
    if (portfolio) portfolio.cash = Number(portfolio.cash) - fill.debit_usd;
    return { executed_vehicle: "options", fill };
  }

  if (playVehicle === "letf") {
    const fill = buildLetfPaperFill({
      pick,
      riskBudgetUsd: riskBudgetUsd || (Number.isFinite(sharesCost) ? sharesCost * 0.02 : 0),
      cash: Number(portfolio?.cash),
      underlyingEntry: trade.entryPrice,
      underlyingSl: trade.sl,
      underlyingTp: trade.tp,
      letfPrice,
      asOfMs,
    });
    if (!fill) {
      if (portfolio && Number.isFinite(sharesCost)) portfolio.cash -= sharesCost;
      return { executed_vehicle: "shares", fill: null, fallback_reason: "letf_quote_unavailable" };
    }
    // Keep trade.ticker = underlying so management still runs on the
    // scored symbol; LETF marks/levels live on letf_paper + entry/sl/tp.
    trade.vehicle = "letf";
    trade.executed_vehicle = "letf";
    trade.play_vehicle = "letf";
    trade.underlying_ticker = trade.ticker;
    trade.underlying_entry = Number(trade.entryPrice);
    trade.letf_ticker = fill.letf_ticker;
    trade.entryPrice = fill.entry_price;
    trade.shares = fill.shares;
    trade.pointValue = 1;
    trade.notional = fill.notional;
    trade.sl = fill.sl;
    if (fill.tp != null) trade.tp = fill.tp;
    trade.letf_paper = fill;
    trade.mark_symbol = fill.letf_ticker;
    if (portfolio) portfolio.cash = Number(portfolio.cash) - fill.notional;
    return { executed_vehicle: "letf", fill };
  }

  if (portfolio && Number.isFinite(sharesCost)) portfolio.cash -= sharesCost;
  return { executed_vehicle: "shares", fill: null };
}

/** PnL components for options paper (premium space). */
export function computeOptionsPaperPnl(trade, tickerData, { asOfMs = Date.now() } = {}) {
  const paper = trade?.options_paper;
  if (!paper) return null;
  const underlyingPx = Number(
    tickerData?.price ?? trade?.currentUnderlying ?? trade?.underlying_mark ?? paper.underlying_entry,
  );
  const atrPct = Number(
    tickerData?.atr_pct ?? tickerData?.atrPct ?? paper.atr_pct,
  );
  const mark = markOptionsPaperPosition(paper, {
    underlyingPrice: underlyingPx,
    atrPct,
    asOfMs,
  });
  if (!mark) return null;
  const realized = Number(trade?.realizedPnl || 0) || 0;
  const unrealized = mark.pnl_usd;
  const pnl = realized + unrealized;
  const notional = Number(trade?.notional) || paper.debit_usd;
  return {
    pnl,
    pnlPct: notional > 0 ? (pnl / notional) * 100 : mark.pnl_pct,
    realized,
    unrealized,
    mark_premium: mark.mark_premium,
    mark_source: mark.mark_source,
    dte: mark.dte,
  };
}
