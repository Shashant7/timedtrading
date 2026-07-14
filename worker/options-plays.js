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
  SPY:  { long: "SPXL", short: "SPXS",  long_alts: ["SPYU"], short_alts: ["SPXU"], factor: 3, note: "Direxion 3× S&P 500" },
  QQQ:  { long: "TQQQ", short: "SQQQ",  factor: 3, note: "ProShares 3× Nasdaq-100" },
  IWM:  { long: "TNA",  short: "TZA",   factor: 3, note: "Direxion 3× Russell 2000" },
  DIA:  { long: "UDOW", short: "SDOW",  factor: 3, note: "ProShares 3× Dow" },
  // Sectors & themes
  XLK:  { long: "TECL", short: "TECS",  factor: 3, note: "Direxion 3× Tech" },
  XLF:  { long: "FAS",  short: "FAZ",   factor: 3, note: "Direxion 3× Financials" },
  XLE:  { long: "ERX",  short: "ERY",   factor: 2, note: "Direxion 2× Energy" },
  XLV:  { long: "CURE", short: null,    factor: 3, note: "Direxion 3× Healthcare (long only)" },
  XLI:  { long: "DUSL", short: null,    factor: 3, note: "Direxion 3× Industrials" },
  XLP:  { long: null,   short: null,    factor: 0, note: "No LETF (defensive sector)" },
  XBI:  { long: "LABU", short: "LABD",  factor: 3, note: "Direxion 3× Biotech" },
  KRE:  { long: "DPST", short: null,    factor: 3, note: "Direxion 3× Regional Banks" },
  FXI:  { long: "YINN", short: "YANG",  factor: 3, note: "Direxion 3× China" },
  KWEB: { long: "YINN", short: "YANG",  factor: 3, note: "Direxion 3× China" },
  // Semis (separately tracked theme)
  SMH:  { long: "SOXL", short: "SOXS",  factor: 3, note: "Direxion 3× Semis" },
  // Crypto-adjacent (high beta proxies for direct BTC/ETH exposure)
  IBIT: { long: "BITX", short: "BITI",  factor: 2, note: "2× Bitcoin (Volatility Shares)" },
  BITO: { long: "BITX", short: "BITI",  factor: 2, note: "2× Bitcoin proxy" },
  BTCUSD: { long: "BTCL", short: "BTCZ", factor: 2, note: "2× Bitcoin" },
  // Volatility
  VIX:  { long: "UVXY", short: "SVXY",  long_alts: ["VIXY"], factor: 1.5, note: "ProShares Ultra VIX" },
  // Bonds (rare but useful)
  TLT:  { long: "TMF",  short: "TMV",   factor: 3, note: "Direxion 3× 20+yr Treasury" },
};

// Per-ticker direct LETF mapping. When a single name is the leveraged play
// (e.g. NVDA → NVDU/NVDL 2x), surface it as the LETF slot.
const SINGLE_NAME_LETF = {
  AMD:  { long: "AMDL", short: null,    factor: 2, note: "GraniteShares 2× AMD" },
  NVDA: { long: "NVDU", short: "NVDD", long_alts: ["NVDL"], factor: 2, note: "2× NVDA" },
  TSLA: { long: "TSLL", short: "TSLZ", long_alts: ["TSLT"], short_alts: ["TSLQ", "TSLS"], factor: 2, note: "2× TSLA" },
  AAPL: { long: "AAPU", short: "AAPD", factor: 2, note: "Direxion 2× AAPL" },
  AMZN: { long: "AMZU", short: "AMZD", factor: 2, note: "Direxion 2× AMZN" },
  MSFT: { long: "MSFU", short: "MSFD", factor: 2, note: "Direxion 2× MSFT" },
  GOOGL:{ long: "GGLL", short: "GGLS", factor: 2, note: "Direxion 2× GOOGL" },
  META: { long: "METU", short: "METD", factor: 2, note: "Direxion 2× META" },
  NFLX: { long: "NFXL", short: "NFXS", factor: 2, note: "Direxion 2× NFLX" },
  LLY:  { long: "LLYX", short: null,    factor: 2, note: "Leverage Shares 2× LLY" },
  COIN: { long: "CONL", short: null,    factor: 2, note: "GraniteShares 2× COIN" },
  MSTR: { long: "MSTU", short: "MSTZ", long_alts: ["MSTX"], short_alts: ["SMST"], factor: 2, note: "2× MSTR" },
  TSM:  { long: "TSMU", short: null,    factor: 2, note: "Direxion 2× TSM" },
  AEHR: { long: "AEHG", short: null,    factor: 2, note: "Leverage Shares 2× AEHR" },
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
  china_names:       { long: "YINN", short: "YANG", factor: 3, note: "3× China" },
  biotech:           { long: "LABU", short: "LABD", factor: 3, note: "3× Biotech" },
};

export function lookupLETF(ticker, themes = []) {
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
    one_liner: "Stock-only or stock-replacement LEAPs. Long-dated, defined risk.",
    // LEAPs are appropriate here: they behave like leveraged shares with
    // defined max loss, ideal for the conservative investor who wants
    // exposure without margin/forced-exit risk.
    preferred: ["stock_long", "leap_call", "stock_short", "covered_call"],
  },
  moderate: {
    label: "Moderate",
    icon: "⚖",
    one_liner: "Sell options for premium income, LEAPs for long-term exposure.",
    preferred: ["leap_call", "long_call", "vertical_spread", "cash_secured_put", "covered_call", "stock_long"],
  },
  aggressive: {
    label: "Aggressive",
    icon: "🎯",
    one_liner: "Defined-risk spreads + LEAPs. Capped downside, leveraged upside.",
    preferred: ["vertical_spread", "leap_call", "long_call", "long_put", "cash_secured_put"],
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
  lotto_call:          { directional: "long",    risk_class: "speculator",   max_loss: "capped_at_premium", max_gain: "uncapped",  label: "🎲 Lotto Call" },
  lotto_put:           { directional: "short",   risk_class: "speculator",   max_loss: "capped_at_premium", max_gain: "uncapped",  label: "🎲 Lotto Put" },
  long_call:           { directional: "long",    risk_class: "speculator",   max_loss: "capped_at_premium", max_gain: "uncapped",  label: "Long Call" },
  long_put:            { directional: "short",   risk_class: "speculator",   max_loss: "capped_at_premium", max_gain: "uncapped",  label: "Long Put" },
  // LEAPs — Long-term Equity AnticiPation Securities. By SEC/CBOE convention
  // any option with > 12 months DTE. The Investor-mode "stock replacement"
  // play: deep-ITM long call at ~365-540 DTE gives ~1:1 participation with
  // a fraction of the capital (and a defined max loss). Theta is glacial,
  // delta is high, so it behaves like leveraged shares — perfect for the
  // Investor thesis ("I'm long-term bullish; I want exposure but not full
  // capital tie-up"). Risk class = aggressive (not speculator) because the
  // long DTE + high delta makes it materially less risky than short-dated
  // OTM gambles. See tasks/2026-06-01-trade-aware-mirror-sync-design.md §2.3.
  leap_call:           { directional: "long",    risk_class: "aggressive",   max_loss: "capped_at_premium", max_gain: "uncapped",  label: "LEAP Call (Stock Replacement)" },
  leap_put:            { directional: "short",   risk_class: "aggressive",   max_loss: "capped_at_premium", max_gain: "uncapped",  label: "LEAP Put (Long-Term Hedge)" },
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
 * Lotto expiration — 0–3 DTE. Indices use daily 0/1DTE picker; singles use
 * the nearest weekday within three sessions (Mon–Fri listed weeklies).
 */
export function pickLottoExpiration(ticker, now = Date.now()) {
  const sym = String(ticker || "").toUpperCase();
  if (isDayTradeTicker(sym)) {
    return pickDayTradeExpiration(now);
  }
  const _isWeekendUtc = (d) => { const dow = d.getUTCDay(); return dow === 0 || dow === 6; };
  for (let d = 0; d <= 3; d++) {
    const day = new Date(now + d * 86400000);
    if (_isWeekendUtc(day)) continue;
    const iso = day.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const labelDate = day.toLocaleDateString("en-US", {
      timeZone: "America/New_York",
      month: "short",
      day: "numeric",
    });
    return {
      iso,
      dte: d,
      label: d === 0 ? `Today ${labelDate} (${d}DTE)` : `${labelDate} (${d}DTE)`,
    };
  }
  return pickDayTradeExpiration(now, { forceTomorrow: true });
}

/**
 * Lotto activation — floor + timing at READY; no in-motion prerequisite.
 * Speculator / aggressive only (same as moonshot).
 */
export function shouldActivateLotto({ confluence, contract, profile, direction }) {
  if (profile !== "speculator" && profile !== "aggressive") {
    return { activate: false, reason: "profile_not_speculator_or_aggressive" };
  }
  if (!confluence) return { activate: false, reason: "no_confluence" };
  const mode = String(confluence.mode || "").toUpperCase();
  if (!["READY", "RIDE", "DRIFT"].includes(mode)) {
    return { activate: false, reason: `mode_${mode}_not_lotto_eligible` };
  }
  const side = String(confluence.side || direction || contract?.direction || "").toUpperCase();
  if (side !== "LONG" && side !== "SHORT") {
    return { activate: false, reason: "no_directional_side" };
  }
  if (mode === "READY") {
    const timing = confluence.timing || {};
    const price = Number(contract?.price);
    const sl = Number(contract?.sl);
    const timingOk = (side === "LONG" && timing.call_opportunity)
      || (side === "SHORT" && timing.put_opportunity);
    const floorOk = (side === "LONG" && price > 0 && sl > 0 && price >= sl)
      || (side === "SHORT" && price > 0 && sl > 0 && price <= sl);
    if (!timingOk && !floorOk) {
      return { activate: false, reason: "ready_no_floor_or_compression_timing" };
    }
  }
  return { activate: true, side };
}

/**
 * Resolve calendar days to next earnings from contract / ticker payloads.
 * Returns null when unknown.
 */
export function resolveEarningsDte(contract = {}, tickerData = {}) {
  const candidates = [
    contract?.earnings_dte,
    contract?.earningsDte,
    contract?.days_to_earnings,
    tickerData?.earnings_dte,
    tickerData?.earningsDte,
    tickerData?.days_to_earnings,
    tickerData?.daysToEarnings,
  ];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return null;
}

/**
 * Advisory earnings-prep lotto — surface cheap OTM convexity into a print
 * WITHOUT loosening Active Trader share entry / flatten risk-off.
 *
 * Window: earnings in 1–5 calendar days. Allows READY/RIDE/DRIFT and WAIT
 * (WAIT only when the directional floor is held — pre-catalyst hesitation
 * is common). Requires floor, compression timing, or a reclaim/pullback
 * structure flag.
 */
export function shouldActivateEarningsPrepLotto({
  confluence,
  contract,
  profile,
  direction,
  tickerData,
  earningsDte,
} = {}) {
  if (profile !== "speculator" && profile !== "aggressive") {
    return { activate: false, reason: "profile_not_speculator_or_aggressive" };
  }
  const dte = resolveEarningsDte(
    { ...(contract || {}), earnings_dte: earningsDte ?? contract?.earnings_dte },
    tickerData || {},
  );
  if (!Number.isFinite(dte) || dte < 1 || dte > 5) {
    return { activate: false, reason: "earnings_dte_out_of_window" };
  }
  if (!confluence) return { activate: false, reason: "no_confluence" };
  const mode = String(confluence.mode || "").toUpperCase();
  if (!["READY", "RIDE", "DRIFT", "WAIT"].includes(mode)) {
    return { activate: false, reason: `mode_${mode}_not_earnings_prep` };
  }
  const side = String(confluence.side || direction || contract?.direction || "").toUpperCase();
  if (side !== "LONG" && side !== "SHORT") {
    return { activate: false, reason: "no_directional_side" };
  }
  const price = Number(contract?.price);
  const sl = Number(contract?.sl);
  const timing = confluence.timing || {};
  const timingOk = (side === "LONG" && timing.call_opportunity)
    || (side === "SHORT" && timing.put_opportunity);
  const floorOk = (side === "LONG" && price > 0 && sl > 0 && price >= sl)
    || (side === "SHORT" && price > 0 && sl > 0 && price <= sl);
  const state = String(tickerData?.state || contract?.state || "").toUpperCase();
  const path = String(tickerData?.entry_path || tickerData?.entryPath || "").toLowerCase();
  const reclaimOk = /RECLAIM|PULLBACK|BOUNCE/.test(state)
    || /reclaim|pullback|bounce/.test(path)
    || !!(tickerData?.flags?.phase_leave)
    || !!(confluence?.supertrend_trigger?.reclaimed);
  if (!floorOk && !timingOk && !reclaimOk) {
    return { activate: false, reason: "no_floor_timing_or_reclaim" };
  }
  if (mode === "WAIT" && !floorOk) {
    return { activate: false, reason: "wait_requires_floor" };
  }
  return { activate: true, side, earnings_dte: dte, earnings_prep: true };
}

/**
 * LEAP expiration picker — long-dated, used by Investor-mode entries.
 *
 * LEAP definition (CBOE / SEC): any options contract with > 12 months to
 * expiration. By convention the most liquid LEAPs are listed for the
 * January 3rd-Friday cycle of each year (annual LEAPs) and some popular
 * underlyings also list June + December cycles.
 *
 * Strategy here: target ~540 DTE (18 months), snap to the 3rd Friday of
 * the target month. If that lands < 365 DTE (can happen if the user calls
 * this near year-end with a January-only chain), step forward one year so
 * we always qualify as a true LEAP. The caller is responsible for falling
 * back to a chain-driven expiration if the snapped date does not exist on
 * the live chain.
 *
 * Returns { iso, dte, label } same shape as pickExpiration / pickMoonshotExpiration.
 */
export function pickLeapExpiration(now = Date.now(), { targetDte = 540 } = {}) {
  const _thirdFriday = (y, m) => {
    const first = new Date(Date.UTC(y, m, 1));
    const firstDow = first.getUTCDay(); // 0 = Sun, 5 = Fri
    const firstFridayDom = 1 + ((5 - firstDow + 7) % 7);
    const tf = new Date(Date.UTC(y, m, firstFridayDom + 14));
    tf.setUTCHours(20, 0, 0, 0); // 4 PM ET ≈ 20:00 UTC (DST), close enough for label
    return tf;
  };
  const target = new Date(now + Math.max(365, targetDte) * 86400000);
  let tf = _thirdFriday(target.getUTCFullYear(), target.getUTCMonth());
  let dte = Math.round((tf.getTime() - now) / 86400000);
  if (dte < 365) {
    tf = _thirdFriday(target.getUTCFullYear() + 1, target.getUTCMonth());
    dte = Math.round((tf.getTime() - now) / 86400000);
  }
  return {
    iso: tf.toISOString().slice(0, 10),
    dte,
    label: `${tf.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })} (${dte}DTE · LEAP)`,
  };
}

/* 2026-06-01 — Day-trade expiration picker for SPY / QQQ / IWM.

   Operator request: "For our SPY, QQQ, IWM predictions, is it possible
   to provide an options play valid for the day? straddle, call, put,
   spread, etc, this would be primarily for day traders who use 0 or
   1 DTE."

   Index ETFs (and SPX) have DAILY expirations Monday-Friday — the only
   listings on the US tape with this cadence. Day traders typically run
   0DTE (same-day expiry, max gamma + max theta) or 1DTE (next-trading-
   day expiry, slightly more cushion). This picker:

     - Before 3 PM ET on a weekday: returns TODAY's expiration as 0DTE.
     - At/after 3 PM ET OR after close: returns the NEXT trading day's
       expiration as 1DTE. The final hour of RTH burns ~10% theta/hour
       on 0DTE — new entries there are not actionable scalps.
     - Skips weekends (no expirations).
     - Caller can force 1DTE via `{ forceTomorrow: true }` for the
       conservative/moderate profiles. */
function _nyEtClock(now = Date.now()) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
    }).formatToParts(new Date(now));
    const map = {};
    for (const p of parts) {
      if (p.type === "weekday") map.weekday = p.value;
      else map[p.type] = Number(p.value);
    }
    const mins = (map.hour || 0) * 60 + (map.minute || 0);
    const wd = String(map.weekday || "");
    const isWeekday = /^Mon|^Tue|^Wed|^Thu|^Fri/i.test(wd);
    return { mins, isWeekday, weekday: wd };
  } catch {
    return { mins: 720, isWeekday: true, weekday: "Mon" };
  }
}

export function pickDayTradeExpiration(now = Date.now(), { forceTomorrow = false } = {}) {
  const _isWeekendUtc = (d) => { const dow = d.getUTCDay(); return dow === 0 || dow === 6; };
  const _nextTradingDay = (d) => {
    const next = new Date(d.getTime() + 86400000);
    while (_isWeekendUtc(next)) next.setUTCDate(next.getUTCDate() + 1);
    return next;
  };
  const nowDt = new Date(now);
  const { mins: _etMins, isWeekday: _etWeekday } = _nyEtClock(now);
  // 3 PM ET = 900 mins — final-hour theta cliff; 4 PM ET = 960 = RTH close.
  const _finalHour = _etWeekday && _etMins >= 900 && _etMins < 960;
  const _afterClose = !_etWeekday || _etMins >= 960 || _etMins < 240;
  const useTomorrow = forceTomorrow || _afterClose || _finalHour || !_etWeekday;

  let expiry = useTomorrow ? _nextTradingDay(nowDt) : new Date(nowDt);
  if (useTomorrow) {
    while (_isWeekendUtc(expiry)) expiry = _nextTradingDay(expiry);
  }
  const iso = expiry.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const labelDate = expiry.toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
  });
  const dte = useTomorrow ? 1 : 0;
  return {
    iso,
    dte,
    label: dte === 0
      ? `Today ${labelDate} (0DTE)`
      : `${labelDate} (1DTE)`,
  };
}

/** Max distance from live spot for 0/1 DTE index plays — beyond this,
 *  gamma is negligible and theta burns premium without a realistic move. */
export const DAY_TRADE_MAX_STRIKE_DRIFT_PCT = 0.02;

/* 2026-06-10 — 0DTE needs a much tighter leash than the generic 2%.
   Incident: DIA "$510 call (spot $502.92), 1.4% from spot, 0DTE" — DIA's
   daily ATR is ~0.8%, so a same-day 1.4% OTM strike is a lottery ticket
   (delta ≈ 0, BE needs a >1.4% afternoon move). The cap is ATR-aware:
   the strike must sit within ~60% of one day's typical range (floor
   0.3% so quiet tape doesn't suppress true-ATM plays, ceiling 1%).
   1DTE keeps the 2% cap — overnight gap risk justifies more room. */
export function dayTradeMaxDriftPct(dte, atrPct) {
  if (Number(dte) !== 0) return DAY_TRADE_MAX_STRIKE_DRIFT_PCT;
  const atr = Number(atrPct) || 0.008;
  return Math.min(0.01, Math.max(0.003, atr * 0.6));
}

/** Live spot for day-trade strike anchoring: EXT print when closed, else RTH. */
export function resolveDayTradeSpot(pricesMap, ticker, { marketOpen = true } = {}) {
  const sym = String(ticker || "").toUpperCase();
  const rthP = Number(pricesMap?.[sym]?.p) || 0;
  const ahP = Number(pricesMap?.[sym]?.ahp) || 0;
  if (!marketOpen && ahP > 0) return ahP;
  return rthP > 0 ? rthP : 0;
}

/** Resolve spot for swing/investor ladder anchoring — prefer live KV over snapshot. */
export function resolveLadderSpotPrice({ ticker, contract, data, pricesMap, marketOpen = true } = {}) {
  const sym = String(ticker || contract?.ticker || data?.ticker || "").toUpperCase();
  if (pricesMap && sym) {
    const live = resolveDayTradeSpot(pricesMap, sym, { marketOpen });
    if (live > 0) return { price: live, source: "live_kv" };
  }
  const snapshotPx = Number(contract?.price) || Number(data?.price) || 0;
  if (snapshotPx > 0) return { price: snapshotPx, source: "snapshot" };
  return { price: null, source: "none" };
}

function _targetPriceFromContract(contract, label) {
  const targets = Array.isArray(contract?.targets) ? contract.targets : [];
  const hit = targets.find((t) => String(t?.label || "").toLowerCase() === String(label).toLowerCase());
  const px = Number(hit?.price);
  return Number.isFinite(px) && px > 0 ? px : null;
}

function _investorTargetLadder(price, sl) {
  const px = Number(price);
  if (!(px > 0)) return { tp1: null, tp2: null, tp3: null };
  const inv = Number(sl);
  const riskPct = Number.isFinite(inv) && inv > 0 && inv < px
    ? (px - inv) / px
    : 0.08;
  const mult = (m) => Math.round(px * m * 100) / 100;
  return {
    tp1: mult(1 + Math.max(0.05, riskPct * 0.75)),
    tp2: mult(1 + Math.max(0.10, riskPct * 1.5)),
    tp3: mult(1 + Math.max(0.18, riskPct * 2.5)),
  };
}

/**
 * Normalize prediction contract + snapshot into buildOptionsLadder() input.
 * Uses corrected risk.stop_loss / targets[] from buildTraderPredictionContract.
 */
export function contractToLadderInput(contract, data = {}, opts = {}) {
  const isInvestorMode = opts.mode === "investor"
    || String(contract?.mode || "").toLowerCase() === "investor";
  const investorData = opts.investorData || null;
  const spot = resolveLadderSpotPrice({
    ticker: opts.ticker || contract?.ticker || data?.ticker,
    contract,
    data,
    pricesMap: opts.pricesMap,
    marketOpen: opts.marketOpen,
  });

  let sl = Number(contract?.risk?.stop_loss);
  if (!Number.isFinite(sl) || sl <= 0) {
    if (isInvestorMode && investorData) {
      sl = Number(investorData.thesisInvalidationPrice)
        || Number(investorData.primaryInvalidation?.price)
        || null;
    }
    if (!Number.isFinite(sl) || sl <= 0) sl = Number(data?.sl) || null;
  }

  let tp1 = _targetPriceFromContract(contract, "Trim");
  let tp2 = _targetPriceFromContract(contract, "Exit");
  let tp3 = _targetPriceFromContract(contract, "Runner");

  if (!Number.isFinite(tp1) || tp1 <= 0) {
    tp1 = Number(contract?.tp_trim ?? contract?.tp1 ?? contract?.tp ?? data?.tp_trim ?? data?.tp1) || null;
  }
  if (!Number.isFinite(tp2) || tp2 <= 0) {
    tp2 = Number(contract?.tp_exit ?? data?.tp_exit) || null;
  }
  if (!Number.isFinite(tp3) || tp3 <= 0) {
    tp3 = Number(contract?.tp_runner ?? data?.tp_runner) || null;
  }

  const pxForTargets = spot.price || Number(data?.price) || 0;
  if (isInvestorMode && pxForTargets > 0 && (!Number.isFinite(tp1) || tp1 <= 0)) {
    const invTargets = _investorTargetLadder(pxForTargets, sl);
    tp1 = invTargets.tp1;
    tp2 = invTargets.tp2;
    tp3 = invTargets.tp3;
  }

  const atrDay = Number(data?.atr_levels?.atr_day || data?.atr_day || 0);
  const px = spot.price || Number(data?.price) || 0;
  const atrPct = Number.isFinite(Number(opts.atr_pct))
    ? Number(opts.atr_pct)
    : (atrDay > 0 && px > 0 ? atrDay / px : 0.025);

  const levels = Array.isArray(contract?.levels) && contract.levels.length
    ? contract.levels
    : (Array.isArray(data?.levels) ? data.levels : []);

  return {
    ticker: String(opts.ticker || contract?.ticker || data?.ticker || "").toUpperCase(),
    price: spot.price,
    price_source: spot.source,
    direction: isInvestorMode ? "LONG" : (contract?.direction || data?.direction || null),
    sl: Number.isFinite(sl) && sl > 0 ? sl : null,
    tp1: Number.isFinite(tp1) && tp1 > 0 ? tp1 : null,
    tp2: Number.isFinite(tp2) && tp2 > 0 ? tp2 : null,
    tp3: Number.isFinite(tp3) && tp3 > 0 ? tp3 : null,
    rr: Number(contract?.risk?.rr ?? contract?.rr ?? data?.rr) || null,
    tier: contract?.setup_tier ?? contract?.tier ?? data?.setup_tier ?? null,
    riskPct: Number(contract?.setup_tier_risk_pct ?? contract?.riskPct ?? data?.setup_tier_risk_pct) || null,
    stage: isInvestorMode ? "investor" : (contract?.stage || data?.kanban_stage || "swing"),
    atr_pct: atrPct,
    earnings_dte: contract?.earnings_dte ?? data?.earnings_dte ?? null,
    mode: isInvestorMode ? "investor" : "trader",
    levels,
    invalidation: Array.isArray(contract?.invalidation) ? contract.invalidation.filter(Boolean) : [],
    contract_direction: contract?.direction || null,
  };
}

/** Snap a delta-derived strike to the nearest model S/R level within tolerance. */
export function refineStrikeWithModelLevels(strike, levels = [], { maxDriftPct = 0.08 } = {}) {
  const k = Number(strike);
  if (!(k > 0) || !Array.isArray(levels) || !levels.length) return snapStrike(k);
  let best = snapStrike(k);
  let bestDist = Infinity;
  for (const row of levels) {
    const lv = Number(row?.price);
    if (!Number.isFinite(lv) || lv <= 0) continue;
    const drift = Math.abs(lv - k) / k;
    if (drift > maxDriftPct) continue;
    const snapped = snapStrike(lv);
    const dist = Math.abs(snapped - k);
    if (dist < bestDist) {
      bestDist = dist;
      best = snapped;
    }
  }
  return best;
}

/** Exit target for P&L projection — prefer Exit over Trim when direction-valid. */
export function pickExitTargetPrice(ctx) {
  const price = Number(ctx?.price);
  const dir = String(ctx?.direction || "").toUpperCase();
  const tp2 = Number(ctx?.tp2);
  const tp1 = Number(ctx?.tp1);
  if (Number.isFinite(tp2) && tp2 > 0) {
    if (dir === "LONG" && (!Number.isFinite(price) || tp2 > price)) return tp2;
    if (dir === "SHORT" && (!Number.isFinite(price) || tp2 < price)) return tp2;
    if (dir !== "LONG" && dir !== "SHORT") return tp2;
  }
  return Number.isFinite(tp1) && tp1 > 0 ? tp1 : null;
}

/** Short leg anchor for vertical spreads — Exit target, else Trim. */
export function pickSpreadShortStrikePrice(ctx) {
  return pickExitTargetPrice(ctx) ?? Number(ctx?.tp1);
}

/** Reconcile trader contract bias vs confluence for UI + alerts. */
export function buildOptionsModelReconciliation({
  contractDirection,
  confluenceSide,
  effectiveDirection,
  directionFlipped,
  directionAlignment,
  contract,
} = {}) {
  const contractDir = String(contractDirection || contract?.contract_direction || contract?.direction || "").toUpperCase() || null;
  const layerSide = String(confluenceSide || "").toUpperCase() || null;
  const effDir = String(effectiveDirection || contractDir || "").toUpperCase() || null;
  const signalSplit = (contractDir === "LONG" || contractDir === "SHORT")
    && (layerSide === "LONG" || layerSide === "SHORT")
    && contractDir !== layerSide;
  const lines = [];
  if (contractDir && layerSide && contractDir === layerSide && !directionFlipped) {
    lines.push(`Trader contract and layer fusion both read ${contractDir}.`);
  } else if (directionFlipped && contractDir && effDir && contractDir !== effDir) {
    lines.push(`Confluence FADE expresses ${effDir}; swing contract reads ${contractDir} — intentional counter-trend options expression.`);
  } else if (signalSplit) {
    lines.push(`Swing contract is ${contractDir} while layers lean ${layerSide} — options play follows confluence timing, not contract direction alone.`);
  }
  if (directionAlignment?.timing_override) {
    lines.push(`Timing override (${String(directionAlignment.reason || "timing").replace(/_/g, " ")}) opened a directional window despite split fusion.`);
  }
  const sl = Number(contract?.sl);
  const trim = Number(contract?.tp1);
  const exit = Number(contract?.tp2);
  const runner = Number(contract?.tp3);
  if (Number.isFinite(sl) && sl > 0) {
    lines.push(`Invalidation / stop reference $${sl.toFixed(2)}${contract?.price_source === "live_kv" ? " (live spot anchor)" : ""}.`);
  }
  if (Number.isFinite(trim) && trim > 0 && Number.isFinite(exit) && exit > 0 && Math.abs(trim - exit) > 0.01) {
    lines.push(`Targets: Trim $${trim.toFixed(2)} · Exit $${exit.toFixed(2)}${Number.isFinite(runner) && runner > 0 ? ` · Runner $${runner.toFixed(2)}` : ""}.`);
  } else if (Number.isFinite(exit) && exit > 0) {
    lines.push(`Primary target (Exit) $${exit.toFixed(2)}.`);
  } else if (Number.isFinite(trim) && trim > 0) {
    lines.push(`Primary target (Trim) $${trim.toFixed(2)}.`);
  }
  return {
    contract_direction: contractDir,
    confluence_side: layerSide,
    effective_direction: effDir,
    signal_split: signalSplit,
    direction_flipped: !!directionFlipped,
    timing_override: !!(directionAlignment?.timing_override),
    lines,
    model_levels: {
      stop: Number.isFinite(sl) && sl > 0 ? sl : null,
      trim: Number.isFinite(trim) && trim > 0 ? trim : null,
      exit: Number.isFinite(exit) && exit > 0 ? exit : null,
      runner: Number.isFinite(runner) && runner > 0 ? runner : null,
      price: Number(contract?.price) || null,
      price_source: contract?.price_source || null,
    },
  };
}

/** Validate short-dated index day-trade strike + DTE against live spot and ET clock.
 *  Returns { valid, reason?, strike?, spot?, drift_pct? }. */
export function validateDayTradePlay({
  spot,
  strike,
  expirationDte,
  atrPct = null,
  now = Date.now(),
} = {}) {
  const px = Number(spot);
  const k = Number(strike);
  const dte = Number(expirationDte);
  if (!(px > 0)) return { valid: false, reason: "no_live_spot" };
  if (!(k > 0)) return { valid: false, reason: "no_strike" };
  const drift = Math.abs(k - px) / px;
  const maxDrift = dayTradeMaxDriftPct(dte, atrPct);
  if (drift > maxDrift) {
    return {
      valid: false,
      reason: `strike_drift_${(drift * 100).toFixed(1)}pct_from_spot`,
      strike: k,
      spot: px,
      drift_pct: drift * 100,
      max_drift_pct: maxDrift * 100,
    };
  }
  if (dte === 0) {
    const { mins, isWeekday } = _nyEtClock(now);
    // 0DTE new entries: weekday only, 4 AM–3 PM ET (final-hour theta cliff).
    if (!isWeekday || mins >= 900 || mins < 240) {
      return { valid: false, reason: "0dte_final_hour_or_after_close" };
    }
  }
  return { valid: true, reason: null };
}

/* 2026-06-01 — Set of tickers that get day-trade options play coverage.
   Strict allow-list. The day-trade builder assumes daily listed-options
   cadence + deep liquidity at every strike — only SPY/QQQ/IWM clear
   that bar on the US tape today. SPX could be added later but trades
   cash-settled European-style which changes the management story. */
// 2026-06-01 — DIA added per operator request after a profitable manual
// 510C day-trade. DIA's options chain has daily expiries + ATM liquidity
// on par with SPY/QQQ/IWM at every major broker (IBKR, Robinhood, RH).
// All four index ETFs share the same regime (S&P / DJIA / Nasdaq /
// Russell) so day-trade signals on any of them are first-class.
export const DAY_TRADE_TICKERS = new Set(["SPY", "QQQ", "IWM", "DIA"]);
export function isDayTradeTicker(ticker) {
  return DAY_TRADE_TICKERS.has(String(ticker || "").toUpperCase());
}

/**
 * Resolve the trader prediction contract's directional bias.
 */
export function resolveContractDirection(direction, effectiveDirection) {
  const d = String(direction || "").toUpperCase();
  if (d === "LONG" || d === "SHORT") return d;
  const e = String(effectiveDirection || "").toUpperCase();
  if (e === "LONG" || e === "SHORT") return e;
  return null;
}

/** Infer LONG/SHORT lean from explicit direction or SL/TP geometry vs spot. */
export function inferLevelLean(price, sl, tp1, direction) {
  const d = String(direction || "").toUpperCase();
  if (d === "LONG" || d === "SHORT") return d;
  const px = Number(price);
  const stop = Number(sl);
  const target = Number(tp1);
  if (!(px > 0) || !(stop > 0) || !(target > 0)) return null;
  if (stop < px && target > px) return "LONG";
  if (stop > px && target < px) return "SHORT";
  return null;
}

/** Ensure SL/TP match the stated play direction (avoids SHORT geometry on a long label). */
export function normalizeDirectionalLevels(price, sl, tp1, direction, atrPct = 0.025) {
  const px = Number(price);
  const d = String(direction || "").toUpperCase();
  if (!(px > 0) || !d) return { sl, tp1 };
  const pad = Math.max(0.015, Math.min(0.05, Number(atrPct) || 0.025));
  if (d === "LONG") {
    const stop = Number.isFinite(sl) && sl < px ? sl : px * (1 - pad);
    const target = Number.isFinite(tp1) && tp1 > px ? tp1 : px * (1 + pad * 2);
    return { sl: stop, tp1: target };
  }
  if (d === "SHORT") {
    const stop = Number.isFinite(sl) && sl > px ? sl : px * (1 + pad);
    const target = Number.isFinite(tp1) && tp1 < px ? tp1 : px * (1 - pad * 2);
    return { sl: stop, tp1: target };
  }
  return { sl, tp1 };
}

/**
 * Gate index-ETF directional options on root-strategy alignment.
 *
 * WAIT explicitly means "no directional bet" — never emit single-leg
 * calls/puts on WAIT, even when the swing-consensus contract disagrees.
 * RIDE / READY / DRIFT require confluence side to match contract direction.
 * FADE is handled upstream via effectiveDirection flip.
 */
export function shouldAllowIndexDirectional({
  verdictMode,
  verdictSide,
  direction,
  effectiveDirection,
  timingOverlay,
  confluence,
}) {
  const contractDir = resolveContractDirection(direction, effectiveDirection);
  if (!contractDir) {
    return { allow: false, reason: "no_contract_direction" };
  }
  const mode = String(verdictMode || "WAIT").toUpperCase();
  const side = String(verdictSide || "NEUTRAL").toUpperCase();
  const timing = timingOverlay || confluence?.timing || null;

  // Compression timing: bounce calls at support even when the swing contract is
  // SHORT/neutral — layer fusion WAIT + compression stack (signal split).
  if (timing?.call_opportunity && (contractDir === "LONG" || timing?.add_on_dips)) {
    if (mode === "WAIT" || side === "SHORT" || side === "NEUTRAL") {
      return {
        allow: true,
        reason: "compression_call_timing",
        contractDir: contractDir || "LONG",
        side: "LONG",
        timing_override: true,
      };
    }
  }
  if (timing?.long_opportunity && contractDir === "LONG" && mode === "FADE") {
    return { allow: true, reason: "compression_fade_long", contractDir, side: "LONG" };
  }

  // Extension timing: puts when trader contract is SHORT + exhaustion stack,
  // even if layer fusion is still WAIT / LONG (signal split at index tops).
  if (timing?.put_opportunity && contractDir === "SHORT") {
    if (mode === "WAIT" || side === "LONG" || side === "NEUTRAL") {
      return {
        allow: true,
        reason: "extension_put_timing",
        contractDir,
        side: "SHORT",
        timing_override: true,
      };
    }
  }
  if (timing?.short_opportunity && contractDir === "SHORT" && mode === "FADE") {
    return { allow: true, reason: "extension_fade_short", contractDir, side: "SHORT" };
  }

  if (mode === "WAIT") {
    return { allow: false, reason: "wait_no_directional_bet", contractDir, side };
  }
  if (mode === "FADE") {
    return { allow: true, reason: "fade_mode", contractDir, side };
  }
  if (mode === "RIDE" || mode === "READY" || mode === "DRIFT") {
    if (side === "NEUTRAL") {
      return { allow: false, reason: `${mode.toLowerCase()}_side_neutral`, contractDir, side };
    }
    if (side !== contractDir) {
      return {
        allow: false,
        reason: `contract_${contractDir.toLowerCase()}_vs_confluence_${side.toLowerCase()}`,
        contractDir,
        side,
      };
    }
    return { allow: true, reason: `${mode.toLowerCase()}_aligned`, contractDir, side };
  }
  return { allow: false, reason: `mode_${mode.toLowerCase()}_unsupported`, contractDir, side };
}

const SETUP_GUIDANCE_TIER_META = {
  not_good: {
    color: "#f87171", bg: "rgba(248,113,113,0.10)", border: "rgba(248,113,113,0.30)",
    label: "NOT A GOOD SETUP",
    action: "Sit out — no options entry",
    desc: "Timing or alignment does not support a directional options bet.",
  },
  forming: {
    color: "#f5c25c", bg: "rgba(245,194,92,0.10)", border: "rgba(245,194,92,0.30)",
    label: "SETUP FORMING",
    action: "Prepare only — do not enter yet",
    desc: "Layers are leaning but the entry trigger has not fired.",
  },
  valid: {
    color: "#60a5fa", bg: "rgba(96,165,250,0.10)", border: "rgba(96,165,250,0.30)",
    label: "VALID SETUP",
    action: "Defined-risk only if entering",
    desc: "A play may exist, but timing is not ideal — prefer spreads over naked premium.",
  },
  good: {
    color: "#34d399", bg: "rgba(52,211,153,0.10)", border: "rgba(52,211,153,0.30)",
    label: "GOOD SETUP",
    action: "Timing aligned — size for theta",
    desc: "Direction and trigger agree. This is the window Timed Trading targets.",
  },
};

/**
 * Plain-English setup-quality guidance for the Options tab.
 * Emphasizes TIMING — options punish early/late entries more than shares,
 * especially on high-volatility names.
 */
export function buildOptionsSetupGuidance({
  confluence,
  contract,
  directionAlignment,
  primary,
  moonshot,
  isInvestorMode,
}) {
  const mode = String(confluence?.mode || "WAIT").toUpperCase();
  const side = String(confluence?.side || "NEUTRAL").toUpperCase();
  const st = confluence?.supertrend_trigger || {};
  const stFresh = String(st.freshness || "none");
  const score = Number(confluence?.score) || 0;
  const atrPct = Number(contract?.atr_pct ?? contract?.atrPct ?? 0.025);
  const ticker = String(contract?.ticker || "").toUpperCase();
  const isHighVol = atrPct >= 0.035;
  const align = directionAlignment;
  const hasPlay = !!primary;
  const investor = !!isInvestorMode;

  let tier = "not_good";
  let why = `Insufficient signal for directional options (${score}/100).`;

  const timing = confluence?.timing;
  if (timing?.call_opportunity && align?.reason === "compression_call_timing") {
    tier = "valid";
    why = `Compression timing — trader call is LONG while layers still lean ${side}. CALL window is open on defined risk only; theta punishes early entry. Wait for ST slope / ORB confirm before sizing.`;
  } else if (timing?.put_opportunity && align?.reason === "extension_put_timing") {
    tier = "valid";
    why = `Extension timing — trader call is SHORT while layers still lean ${side}. PUT window is open on defined risk only; theta punishes early entry. Wait for ST slope / ORB confirm before sizing.`;
  } else if (timing?.add_on_dips && mode === "WAIT" && timing?.bias === "COMPRESSION") {
    tier = "forming";
    why = `Compression watch (${timing.compression_score}/100) — add on dips, do not add index shorts. Directional calls stage on trigger; layers are split (${score}/100).`;
  } else if (timing?.trim_winners && mode === "WAIT") {
    tier = "forming";
    why = `Extension watch (${timing.extension_score}/100) — trim winners, do not add index longs. Directional puts stage on trigger; layers are split (${score}/100).`;
  } else if (align && align.allow === false) {
    tier = "not_good";
    if (align.reason === "wait_no_directional_bet") {
      why = `Confluence is WAIT (${score}/100). Layers are split and SuperTrend has not confirmed. Directional calls and puts are suppressed on purpose — forcing a trade here invites whiplash.`;
    } else if (String(align.reason || "").includes("vs_confluence")) {
      why = `The trader contract points ${align.contractDir || "—"} but confluence reads ${align.side || "NEUTRAL"}. Until layers align, buying calls or puts is effectively a coin flip.`;
    } else {
      why = `Root-strategy gates block directional options (${String(align.reason || "blocked").replace(/_/g, " ")}).`;
    }
  } else if (mode === "WAIT") {
    tier = "not_good";
    why = `Mixed signals (${score}/100) with no SuperTrend trigger. Directional options are not warranted — premium decays (theta) while the model waits for a clear edge.`;
  } else if (mode === "READY") {
    tier = "forming";
    why = `Confluence leans ${side} (${score}/100) but SuperTrend slope has not ignited. ENTRY PENDING — stage the order, do not chase. Options entered before the trigger often draw down harder than shares.`;
  } else if (mode === "FADE") {
    if (hasPlay) {
      tier = "valid";
      why = `FADE ${side} — countertrend setup. Prefer a credit spread (sell premium, collect income, capped loss) over buying calls or puts. Fades are timing-fragile.`;
    } else {
      tier = "not_good";
      why = `Countertrend fade detected but no suitable options expression for this risk profile.`;
    }
  } else if (mode === "DRIFT") {
    if (hasPlay) {
      tier = "valid";
      why = `DRIFT ${side} — partial confluence (${score}/100) with SuperTrend already in motion. Late entry: long premium bleeds theta. Defined-risk spreads below are preferred over naked calls/puts.`;
    } else {
      tier = "forming";
      why = `Partial confluence but no play surfaced for this profile. Wait for cleaner timing or adjust risk profile.`;
    }
  } else if (mode === "RIDE") {
    if (stFresh === "fresh" && hasPlay) {
      tier = "good";
      why = moonshot?.activated
        ? `RIDE ${side} — ${score}/100 confluence, fresh SuperTrend trigger, and momentum aligned. Short-dated gamma play — size small, theta burns fast.`
        : `RIDE ${side} — ${score}/100 confluence with a fresh SuperTrend trigger. Direction and timing agree — size for theta and move speed.`;
    } else if ((stFresh === "in_motion" || stFresh === "mature") && hasPlay) {
      tier = "valid";
      why = `RIDE ${side} but SuperTrend is ${stFresh === "mature" ? "mature" : "in motion"} — not the freshest entry. Tight sizing only; avoid chasing an extended move.`;
    } else if (hasPlay) {
      tier = "valid";
      why = `RIDE ${side} (${score}/100). Review SuperTrend freshness before sizing — options punish late entries harder than equity.`;
    } else {
      tier = "forming";
      why = `Confluence is RIDE ${side} but no options play matched this profile. Check horizon or risk profile.`;
    }
  }

  if (investor && tier === "not_good" && mode !== "WAIT" && hasPlay) {
    tier = "valid";
    why = `Investor horizon uses LEAPs (≥1y DTE) where short-term timing is less punitive than swing premium. Thesis: ${side} bias (${score}/100). Roll discipline still applies.`;
  }

  const meta = SETUP_GUIDANCE_TIER_META[tier] || SETUP_GUIDANCE_TIER_META.not_good;
  const timingNote = isHighVol
    ? `${ticker || "This name"} runs ~${(atrPct * 100).toFixed(1)}% daily ATR — options magnify timing errors. Entering too early bleeds theta; entering too late chases a move that may reverse.`
    : "Options decay faster than shares — entry timing matters more than direction alone.";

  return {
    tier,
    mode,
    action: meta.action,
    desc: meta.desc,
    why: why.trim(),
    timing_note: timingNote,
    color: meta.color,
    bg: meta.bg,
    border: meta.border,
    label: meta.label,
    high_volatility: isHighVol,
    atr_pct: atrPct,
    // Legacy aliases — older clients may still read these.
    headline: meta.action,
    body: why.trim(),
    timing_focus: timingNote,
  };
}

/**
 * Plain-English model disposition for options UI — answers whether the
 * system would size this play vs show it for education only.
 */
export function buildOptionsModelDisposition({
  confluence,
  contractDirection,
  effectiveDirection,
  directionFlipped,
  directionAlignment,
  setupGuidance,
  primary,
  moonshot,
}) {
  const score = Number(confluence?.score) || 0;
  const mode = String(confluence?.mode || "WAIT").toUpperCase();
  const side = String(confluence?.side || "NEUTRAL").toUpperCase();
  const contractDir = String(contractDirection || "").toUpperCase() || null;
  const effDir = String(effectiveDirection || contractDir || "").toUpperCase() || null;
  const tier = String(setupGuidance?.tier || "not_good");
  const hasPlay = !!primary;
  const timingOverride = !!(directionAlignment?.timing_override || confluence?.timing_override);
  const signalSplit = (contractDir === "LONG" || contractDir === "SHORT")
    && (side === "LONG" || side === "SHORT")
    && contractDir !== side;
  const faded = !!directionFlipped;

  const fusionBand = score >= 65 ? "strong" : score >= 40 ? "mixed" : "weak";
  const fusionLabel = fusionBand === "strong"
    ? "Strong fusion"
    : fusionBand === "mixed"
      ? "Mixed fusion"
      : "Weak fusion";

  let stance = "sit_out";
  let stanceLabel = "MODEL SITS OUT";
  let stanceColor = "#9ca3af";
  let summary = "";
  let detail = "";

  if (!hasPlay) {
    summary = "No options expression matched this setup.";
    detail = setupGuidance?.why || "The model would not route capital here.";
  } else if (tier === "good" && mode === "RIDE" && fusionBand === "strong") {
    stance = "enter";
    stanceLabel = "MODEL ALIGNED";
    stanceColor = "#34d399";
    summary = "High fusion and fresh timing — the model targets this expression on trigger.";
    detail = moonshot?.activated
      ? "Moonshot tier: direction and momentum agree. Size small; gamma decays fast."
      : (setupGuidance?.why || "");
  } else if (tier === "forming" || mode === "READY") {
    stance = "stage";
    stanceLabel = "WAIT FOR TRIGGER";
    stanceColor = "#f5c25c";
    summary = "Setup forming — stage the order; do not chase before SuperTrend confirms.";
    detail = setupGuidance?.why || "";
  } else if (tier === "valid" && (mode === "RIDE" || mode === "DRIFT") && fusionBand !== "weak") {
    stance = "stage";
    stanceLabel = "DEFINED-RISK OK";
    stanceColor = "#60a5fa";
    summary = "Valid expression with partial or late alignment — tight sizing only.";
    detail = setupGuidance?.why || "";
  } else if (hasPlay && tier !== "not_good" && (mode === "FADE" || timingOverride || faded || signalSplit)) {
    stance = "fade_risk";
    stanceLabel = faded || mode === "FADE" ? "COUNTER-TREND / TIMING" : "TIMING PLAY";
    stanceColor = "#a78bfa";
    if (faded && contractDir && effDir && contractDir !== effDir) {
      summary = `Play expresses ${effDir} while trader contract reads ${contractDir} — intentional fade, not a data bug.`;
    } else if (signalSplit) {
      summary = `Layers lean ${side} while trader contract is ${contractDir} — timing-driven expression only.`;
    } else {
      summary = "Timing opened a narrow window despite weak or split layer fusion.";
    }
    detail = `${fusionLabel} (${score}/100). ${setupGuidance?.why || ""} Valid as small defined-risk — not a full-conviction trend entry.`.trim();
  } else if (hasPlay && tier === "valid") {
    stance = "fade_risk";
    stanceLabel = "SMALL SIZE ONLY";
    stanceColor = "#60a5fa";
    summary = "Play is valid but fusion is not strong enough for a full conviction entry.";
    detail = setupGuidance?.why || "";
  } else if (hasPlay) {
    stance = "educational";
    stanceLabel = "EDUCATIONAL ONLY";
    stanceColor = "#9ca3af";
    summary = "Shown for context — the model would not size a directional entry here.";
    detail = setupGuidance?.why || "";
  }

  return {
    stance,
    stance_label: stanceLabel,
    stance_color: stanceColor,
    summary,
    detail: detail.trim(),
    fusion_score: score,
    fusion_band: fusionBand,
    fusion_label: fusionLabel,
    fusion_help: "Fusion is how strongly the 8 strategy layers agree (0–100). Low scores mean layers are split — not a win probability.",
    contract_direction: contractDir,
    effective_direction: effDir,
    confluence_side: side,
    confluence_mode: mode,
    direction_flipped: faded,
    signal_split: signalSplit,
    timing_driven: timingOverride || mode === "FADE" || faded,
    would_model_enter: stance === "enter",
    would_model_stage: stance === "stage" || stance === "fade_risk",
    valid_play: hasPlay && stance !== "sit_out" && stance !== "educational",
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
  // Exception: a decisive day reclaim (≥4%) may override a lingering 5d
  // pullback (common into earnings: multi-day dip, then reclaim ignition).
  const dayDir  = dayPct > 0 ? "LONG" : dayPct < 0 ? "SHORT" : null;
  const multiDir = fiveDayPct > 0 ? "LONG" : fiveDayPct < 0 ? "SHORT" : null;
  let direction = dayDir || multiDir;
  let reclaimOverride = false;
  if (dayDir && multiDir && dayDir !== multiDir) {
    if (absDay >= 4) {
      direction = dayDir;
      reclaimOverride = true;
    } else {
      return { in_motion: false, reason: "whipsaw (day ↔ 5d disagree)", day_change_pct: dayPct, multi_day_change_pct: fiveDayPct };
    }
  }

  const evidence = [];
  if (absDay >= 3) evidence.push(`day ${dayPct >= 0 ? "+" : ""}${dayPct.toFixed(1)}%`);
  if (absMulti >= 5) evidence.push(`5d ${fiveDayPct >= 0 ? "+" : ""}${fiveDayPct.toFixed(1)}%`);
  if (reclaimOverride) evidence.push("day reclaim vs 5d pullback");
  if (Number.isFinite(volRatio) && volRatio >= 1.5) evidence.push(`vol ${volRatio.toFixed(1)}× avg`);

  return {
    in_motion: true,
    direction,
    day_change_pct: dayPct,
    multi_day_change_pct: fiveDayPct,
    volume_ratio: volRatio,
    evidence: evidence.join(" · "),
    reclaim_override: reclaimOverride || undefined,
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

// Index ETFs (SPY/QQQ/IWM/DIA) list daily expiries — profile should steer
// DTE and structure, not just reorder the same swing ladder.
const _INDEX_MULTI_LEG = new Set([
  "vertical_spread", "long_straddle", "long_strangle", "iron_condor", "day_trade_straddle",
]);
const _INDEX_SINGLE_LEG = new Set([
  "long_call", "long_put", "moonshot_call", "moonshot_put",
  "day_trade_call", "day_trade_put",
]);

/**
 * Profile-aware expiration for the options ladder.
 * Index ETFs in Trader mode bias short-dated for Speculator/Aggressive and
 * longer-dated / weekly for Conservative.
 */
export function pickExpirationForProfile(contract, profile = DEFAULT_RISK_PROFILE, now = Date.now()) {
  const ticker = String(contract?.ticker || "").toUpperCase();
  const mode = String(contract?.mode || "").toLowerCase();
  const stage = classifySetupStage(contract);
  if (isDayTradeTicker(ticker) && mode !== "investor") {
    if (profile === "speculator" || profile === "aggressive") {
      return pickDayTradeExpiration(now);
    }
    if (profile === "moderate") {
      return pickDayTradeExpiration(now, { forceTomorrow: true });
    }
    // Conservative: weekly swing (~21 DTE) — defined-risk spreads / LEAPs.
    return pickExpiration("swing", now);
  }
  return pickExpiration(stage, now);
}

/** Distinct ISO expiration dates present on a normalized options chain. */
export function listChainExpirationDates(chain) {
  const set = new Set();
  if (!chain || typeof chain !== "object") return [];
  if (chain.expiration) set.add(String(chain.expiration));
  for (const leg of [...(chain.calls || []), ...(chain.puts || [])]) {
    if (leg?.expiration) set.add(String(leg.expiration));
  }
  return Array.from(set).sort();
}

/**
 * Snap an ideal expiration (often a synthetic Friday) to the nearest
 * listed chain date by DTE distance. ETFs like CIBR list monthly cycles
 * (e.g. Jul 21 / Aug 21) — not every Friday.
 */
export function snapExpirationToChain(ideal, listedExpirations, now = Date.now()) {
  if (!ideal || typeof ideal !== "object") return ideal;
  const list = Array.isArray(listedExpirations) ? listedExpirations.filter(Boolean) : [];
  if (!list.length) return ideal;
  const targetDte = Number.isFinite(Number(ideal.dte)) ? Number(ideal.dte) : 21;

  let bestIso = null;
  let bestDist = Infinity;
  for (const iso of list) {
    const ms = Date.parse(`${iso}T21:00:00Z`);
    if (!Number.isFinite(ms)) continue;
    const dte = Math.round((ms - now) / 86400000);
    if (dte < 1) continue;
    const dist = Math.abs(dte - targetDte);
    if (dist < bestDist) {
      bestDist = dist;
      bestIso = iso;
    }
  }
  if (!bestIso) {
    for (const iso of list) {
      const ms = Date.parse(`${iso}T21:00:00Z`);
      if (!Number.isFinite(ms)) continue;
      if (Math.round((ms - now) / 86400000) >= 1) {
        bestIso = iso;
        break;
      }
    }
  }
  if (!bestIso || bestIso === ideal.iso) return ideal;

  const d = new Date(`${bestIso}T21:00:00Z`);
  const dte = Math.round((d.getTime() - now) / 86400000);
  return {
    iso: bestIso,
    dte,
    label: `${d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })} (${dte}DTE)`,
    chain_snapped: true,
    ideal_iso: ideal.iso,
  };
}

/** Keep only legs for one expiration (chain payloads may mix dates). */
export function filterChainToExpiration(chain, expirationIso) {
  if (!chain || !expirationIso) return chain;
  const iso = String(expirationIso);
  const calls = (chain.calls || []).filter((l) => !l.expiration || l.expiration === iso);
  const puts = (chain.puts || []).filter((l) => !l.expiration || l.expiration === iso);
  return { ...chain, expiration: iso, calls, puts };
}

/** Resolve ideal profile expiration against a live chain's listed dates. */
export function resolveExpirationWithChain(ideal, chain, now = Date.now()) {
  return snapExpirationToChain(ideal, listChainExpirationDates(chain), now);
}

function _chainLegCount(chain) {
  return (chain?.calls?.length || 0) + (chain?.puts?.length || 0);
}

/**
 * List expirations, snap the ideal profile date to a listed cycle, then
 * fetch a chain for that date. Broad-chain Alpaca fallback when the snapped
 * date has no legs (monthly ETF cycles like CIBR Jul 21 / Aug 21).
 *
 * fetchExpirations / fetchChain are injected so callers can wire Alpaca +
 * TwelveData and unit tests can mock providers.
 */
export async function resolveAndFetchOptionsChain({
  env,
  ticker,
  idealExp,
  fetchExpirations,
  fetchChain,
  fetchChainFallback = null,
  listedExpirations = null,
  now = Date.now(),
  strikeRangePct = 0.25,
}) {
  let resolvedExp = idealExp;
  let chain = null;
  let status = "not_attempted";
  let provider = "alpaca";

  const listed = Array.isArray(listedExpirations) && listedExpirations.length
    ? listedExpirations
    : null;
  if (listed) {
    resolvedExp = snapExpirationToChain(idealExp, listed, now);
  } else if (typeof fetchExpirations === "function") {
    const expRes = await fetchExpirations(env, ticker);
    if (expRes?.ok && expRes.expirations?.length) {
      resolvedExp = snapExpirationToChain(idealExp, expRes.expirations, now);
    }
  }

  let chainRes = await fetchChain(env, ticker, resolvedExp?.iso || null, { strikeRangePct });
  if (!chainRes?.ok || _chainLegCount(chainRes) === 0) {
    if (typeof fetchChainFallback === "function" && resolvedExp?.iso) {
      const fb = await fetchChainFallback(env, ticker, resolvedExp.iso);
      if (fb?.ok && _chainLegCount(fb) > 0) {
        chainRes = fb;
        provider = "twelvedata";
      }
    }
  }

  if (chainRes?.ok && _chainLegCount(chainRes) > 0) {
    chain = filterChainToExpiration(chainRes, resolvedExp.iso);
    status = `fresh_fetch:${provider}`;
    return { chain, resolvedExp, status, raw: chainRes };
  }

  const broadRes = await fetchChain(env, ticker, null, { strikeRangePct });
  if (broadRes?.ok && _chainLegCount(broadRes) > 0) {
    resolvedExp = resolveExpirationWithChain(idealExp, broadRes, now);
    chain = filterChainToExpiration(broadRes, resolvedExp.iso);
    if (_chainLegCount(chain) > 0) {
      status = "broad_chain_fallback";
      return { chain, resolvedExp, status, raw: broadRes };
    }
  }

  status = `provider_error:${chainRes?.error || broadRes?.error || "empty_chain"}`;
  return { chain: null, resolvedExp, status, raw: null };
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

/* 2026-06-02 — Estimate the option's premium when the underlying
   later reaches `targetPrice`, after `holdDays` of time decay.

   Used by single-leg builders (calls, puts, LEAPs) to project the
   option's value at the trade's TP and SL — the live exit points
   the operator actually uses. Reports "Max gain at target: $0"
   when intrinsic < premium is technically correct for hold-to-
   expiration but misleading because we never hold to expiration:
   the live trade exits at TP or SL with whatever the option is
   worth at that moment.

   Method:
     1. Compute remaining DTE after holdDays.
     2. Re-price the option via blackScholes() with S=targetPrice,
        T=remainingDte/365, sigma=ATR-derived IV (same proxy used
        elsewhere). Prefer ivOverride from the chain when known so
        we don't undercount IV crush in trader timeframes.
     3. Return { price, pl_per_contract, total_pl_usd } for the
        scenario.

   holdDays heuristic: rough number of ATR moves needed to cover
   the distance. Caller can override with explicit holdDays. */
export function estimateOptionAtTargetPrice({
  currentPrice,
  targetPrice,
  strike,
  type,
  currentDte,
  premiumPaid,
  contracts = 1,
  atrPct,
  ivOverride,
  holdDays = null,
}) {
  if (!(currentPrice > 0 && targetPrice > 0 && strike > 0 && currentDte > 0 && premiumPaid > 0)) {
    return null;
  }
  // Estimate hold days as the number of ATR moves to cover distance.
  let resolvedHoldDays = holdDays;
  if (resolvedHoldDays == null) {
    const distancePct = Math.abs(targetPrice - currentPrice) / currentPrice;
    const dailyAtrPct = (atrPct > 0 && atrPct < 1) ? atrPct : 0.015;
    resolvedHoldDays = Math.max(1, Math.ceil(distancePct / dailyAtrPct));
    // Cap at 60% of DTE — past that we're hold-to-expiration territory.
    resolvedHoldDays = Math.min(resolvedHoldDays, Math.floor(currentDte * 0.6));
    resolvedHoldDays = Math.max(1, resolvedHoldDays);
  }
  const remainingDte = Math.max(1, currentDte - resolvedHoldDays);
  const sigma = Number.isFinite(ivOverride) && ivOverride > 0
    ? ivOverride
    : impliedVolFromATR(atrPct);
  const T = remainingDte / 365;
  const bs = blackScholes({ S: targetPrice, K: strike, T, sigma, type });
  if (!bs) return null;
  const estPrem = bs.price;
  const plPerContract = (estPrem - premiumPaid) * 100;
  const totalPl = plPerContract * contracts;
  return {
    est_premium: Math.round(estPrem * 100) / 100,
    hold_days: resolvedHoldDays,
    remaining_dte: remainingDte,
    pl_per_contract: Math.round(plPerContract),
    total_pl_usd: Math.round(totalPl),
    total_value_usd: Math.round(estPrem * 100 * contracts),
  };
}

// Convenience wrapper used by builders below.
// Prefers real chain data when `chainLeg` is supplied (v2 — real bid/ask/IV/OI).
// Falls back to Black-Scholes + ATR-implied vol when chainLeg is null (v1).
export function resolveChainLegMid(chainLeg, { price = null, strike = null, type = null } = {}) {
  if (!chainLeg || typeof chainLeg !== "object") return null;
  const bid = Number(chainLeg.bid);
  const ask = Number(chainLeg.ask);
  let mid = null;
  if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0) {
    mid = Math.round(((bid + ask) / 2) * 100) / 100;
  } else if (Number.isFinite(Number(chainLeg.mid)) && Number(chainLeg.mid) > 0) {
    mid = Number(chainLeg.mid);
  } else if (Number.isFinite(Number(chainLeg.last)) && Number(chainLeg.last) > 0) {
    mid = Number(chainLeg.last);
  }
  if (!(mid > 0)) return null;
  // ITM floor: reject last-trade zombies that print below intrinsic.
  const px = Number(price);
  const k = Number(strike);
  const side = String(type || "").toUpperCase();
  if (Number.isFinite(px) && px > 0 && Number.isFinite(k) && k > 0) {
    const intrinsic = side === "P" || side === "PUT"
      ? Math.max(0, k - px)
      : Math.max(0, px - k);
    if (intrinsic > 0.5 && mid + 0.05 < intrinsic * 0.85) return null;
  }
  return mid;
}

export function estimatePremium({ price, strike, dte, atrPct, ivOverride, type, chainLeg = null }) {
  // ── Real chain path ────────────────────────────────────────────────
  const liveMid = resolveChainLegMid(chainLeg, { price, strike, type });
  if (chainLeg && liveMid > 0) {
    const bid = Number(chainLeg.bid);
    const ask = Number(chainLeg.ask);
    const iv = Number(chainLeg.implied_volatility) || impliedVolFromATR(atrPct);
    return {
      mid: liveMid,
      bid: Number.isFinite(bid) && bid > 0 ? bid : null,
      ask: Number.isFinite(ask) && ask > 0 ? ask : null,
      low: Number.isFinite(bid) && bid > 0 ? bid : Math.round(liveMid * 0.95 * 100) / 100,
      high: Number.isFinite(ask) && ask > 0 ? ask : Math.round(liveMid * 1.05 * 100) / 100,
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
      expiration: chainLeg.expiration || null,
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

/** Re-bind chain leg after strike refine — prevents pricing strike A with leg B. */
export function bindChainLegForStrike(chain, side, strike, prevLeg = null) {
  const exact = _chainLeg(chain, side, strike);
  if (exact) return exact;
  if (prevLeg && Math.abs(Number(prevLeg.strike) - Number(strike)) < 0.01) return prevLeg;
  return null;
}

/** Prefer a chain already filtered to `expirationIso`; else null. */
export function chainForExpiration(chain, expirationIso) {
  if (!chain || !expirationIso) return null;
  const filtered = filterChainToExpiration(chain, expirationIso);
  if (_chainLegCount(filtered) > 0) return filtered;
  return null;
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
  const { price, tp1, tp2, sl, atrPct, expiration, contracts, chain, targetDelta = 0.50, levels = [] } = ctx;
  const exitTarget = pickExitTargetPrice(ctx) ?? tp1;
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
  strike = refineStrikeWithModelLevels(strike, levels);
  chainLeg = bindChainLegForStrike(chain, "C", strike, chainLeg);
  const prem = estimatePremium({ price, strike, dte: expiration.dte, atrPct, type: "C", chainLeg });
  if (!prem) return null;
  const premPerShare = prem.mid;
  const maxLoss = premPerShare * 100 * contracts;
  const breakeven = strike + premPerShare;
  // Max gain at exit target — intrinsic value at target.
  const intrinsicAtTP = Math.max(0, exitTarget - strike);
  const gainAtTP = (intrinsicAtTP - premPerShare) * 100 * contracts;
  /* 2026-06-02 — Live-trade exit projections. The user never holds
     to expiration; the trade exits at TP or SL with whatever the
     option is worth THEN. Project both via BS at reduced DTE. */
  const ivUsed = Number(prem.iv_used) || null;
  const estAtTp = (Number.isFinite(exitTarget) && exitTarget > 0) ? estimateOptionAtTargetPrice({
    currentPrice: price, targetPrice: exitTarget, strike, type: "C",
    currentDte: expiration.dte, premiumPaid: premPerShare,
    contracts, atrPct, ivOverride: ivUsed,
  }) : null;
  const estAtSl = (Number.isFinite(sl) && sl > 0) ? estimateOptionAtTargetPrice({
    currentPrice: price, targetPrice: sl, strike, type: "C",
    currentDte: expiration.dte, premiumPaid: premPerShare,
    contracts, atrPct, ivOverride: ivUsed,
  }) : null;
  const targetClearsBreakeven = Number.isFinite(exitTarget) ? exitTarget > breakeven : null;
  const deltaLabel = targetDelta >= 0.65 ? "Deep ITM (Stock Replacement)"
                    : targetDelta >= 0.40 ? "ATM"
                    : targetDelta >= 0.25 ? "OTM"
                    : "Far OTM";
  const deltaPct = (Math.abs(prem.greeks?.delta || targetDelta) * 100).toFixed(0);
  const targetLine = Number.isFinite(tp2) && tp2 > 0 && Math.abs(tp2 - exitTarget) < 0.01 && Number.isFinite(tp1) && Math.abs(tp1 - tp2) > 0.01
    ? `Trim $${tp1?.toFixed(2) ?? "?"} · Exit $${exitTarget?.toFixed(2) ?? "?"}`
    : `$${exitTarget?.toFixed(2) ?? "?"}`;
  return {
    archetype: "long_call",
    label: `Long Call (${deltaLabel})`,
    rationale: `Bullish bias to ${targetLine}. Strike $${strike} (${deltaPct}Δ via ${deltaSource}) — every $1 underlying ≈ $${deltaPct}/contract. Max loss = premium paid.`,
    target_delta: targetDelta,
    actual_delta: Number(prem.greeks?.delta) || null,
    legs: [
      {
        action: "BUY", optionType: "CALL", strike, expiration: expiration.iso, qty: contracts,
        premium_mid: Number(prem.mid?.toFixed(2)) || null,
        premium_bid: prem.bid != null ? Number(Number(prem.bid).toFixed(2)) : null,
        premium_ask: prem.ask != null ? Number(Number(prem.ask).toFixed(2)) : null,
        leg_cost_usd: Math.round(prem.mid * 100 * contracts),
        side_label: "debit",
      },
    ],
    strikes: { primary: strike },
    expiration,
    premium: prem,
    contracts,
    max_loss_usd: Math.round(maxLoss),
    max_gain_usd: intrinsicAtTP > premPerShare ? Math.round(gainAtTP) : null,
    max_gain_label: "Uncapped above target",
    breakeven,
    target_clears_breakeven: targetClearsBreakeven,
    est_at_tp: estAtTp,
    est_at_sl: estAtSl,
    prob_profit_at_target: prem.greeks.prob_itm,
    notes: [
      `Theta ≈ $${Math.abs(prem.greeks.theta * 100 * contracts).toFixed(2)}/day decay`,
      `Vega ≈ $${(prem.greeks.vega * 100 * contracts).toFixed(2)} per 1% IV change`,
    ],
  };
}

/**
 * LEAP Call — long-dated, deep-ITM single call. The "stock replacement"
 * play for long-term bullish theses: synthetic long exposure with leverage
 * at a fraction of the capital, defined max loss, and minimal theta drag.
 *
 * Differs from buildLongCall:
 *   - Forces a LEAP expiration (≥270 DTE) via pickLeapExpiration() —
 *     ignores ctx.expiration if it's shorter.
 *   - Default delta target = 0.80 (deep ITM) instead of 0.50. This makes
 *     the LEAP behave like ~80% of shares with a fraction of the outlay.
 *   - Notes call out the multi-year horizon, the PMCC follow-on play,
 *     and roll discipline (close at T-180 days to avoid the theta cliff).
 *   - Surfaces a capital-efficiency floor warning (< 2× means you're
 *     overpaying — strike too deep ITM, or the LEAP is the wrong tool).
 *   - LEAP-aware liquidity gate (lower OI threshold than weeklies).
 *
 * Returns the same Strategy shape as buildLongCall so the rest of the
 * ladder (ranker, profile preview, warnings) just works.
 */
function buildLeapCall(ctx) {
  const { price, tp1, tp2, sl, atrPct, contracts, targetDelta = 0.80, levels = [] } = ctx;
  const exitTarget = pickExitTargetPrice(ctx) ?? tp1;
  // Force a real LEAP expiration. Caller may have passed a short one
  // (e.g. classifySetupStage routes Investor → 90 DTE today); override
  // unless the caller already supplied a LEAP-grade DTE.
  const expiration = (ctx.expiration && Number(ctx.expiration.dte) >= 270)
    ? ctx.expiration
    : pickLeapExpiration();

  // CRITICAL: only price LEAPs off a chain for the LEAP expiration.
  // The ladder often attaches a short swing chain (e.g. 66 DTE); using those
  // bids for a Jan LEAP label produced AEHR $55C @ $24 vs live ~$45.
  let chain = ctx.leap_chain || null;
  if (!chain && ctx.chain) {
    const dates = listChainExpirationDates(ctx.chain);
    if (dates.includes(expiration.iso) || !dates.length) {
      chain = chainForExpiration(ctx.chain, expiration.iso) || (
        // Unlabeled legs on a single-expiry payload: accept only if the
        // chain.expiration matches the LEAP date.
        (ctx.chain.expiration === expiration.iso || !ctx.chain.expiration)
          ? ctx.chain
          : null
      );
    }
  }
  // Reject legs that belong to a different listed expiration.
  if (chain) {
    const misfit = [...(chain.calls || []), ...(chain.puts || [])]
      .some((l) => l?.expiration && l.expiration !== expiration.iso);
    if (misfit) chain = chainForExpiration(chain, expiration.iso);
  }

  let strike, chainLeg, deltaSource = "snap_itm_deep";
  if (chain) {
    const picked = pickLegByDelta(chain, "C", targetDelta, price);
    if (picked.leg) {
      strike = Number(picked.leg.strike);
      chainLeg = picked.leg;
      deltaSource = picked.source;
    }
  }
  if (!strike) {
    strike = deltaToStrikeBS({ price, targetDelta, dte: expiration.dte, atrPct, type: "C" })
          || snapStrike(price * 0.85); // deep-ITM ≈ 0.85× spot when sized
    chainLeg = chain ? _chainLeg(chain, "C", strike) : null;
    deltaSource = chain ? "chain_no_delta_fallback" : "bs_estimate_deep_itm";
  }
  strike = refineStrikeWithModelLevels(strike, levels);
  chainLeg = bindChainLegForStrike(chain, "C", strike, chainLeg);
  const prem = estimatePremium({ price, strike, dte: expiration.dte, atrPct, type: "C", chainLeg });
  if (!prem) return null;
  const premPerShare = prem.mid;
  const maxLoss = premPerShare * 100 * contracts;
  const breakeven = strike + premPerShare;
  const intrinsicAtTP = Math.max(0, exitTarget - strike);
  const gainAtTP = (intrinsicAtTP - premPerShare) * 100 * contracts;
  const actualDelta = Math.abs(prem.greeks?.delta || targetDelta);
  const sharesEquivalent = Math.round(contracts * 100 * actualDelta);
  const sharesCapital = Math.round(sharesEquivalent * price);
  const leapCapital = Math.round(premPerShare * 100 * contracts);
  const capitalEfficiency = leapCapital > 0 ? (sharesCapital / leapCapital) : null;
  const deltaPct = (actualDelta * 100).toFixed(0);

  // ── PMCC (Poor Man's Covered Call) suggestion ──────────────────────────
  // Classic LEAP follow-on: sell a 30-45 DTE OTM call against the LEAP to
  // monetize theta in your favor without giving up the long-term upside.
  // Pick a strike that's ~5% OTM and one monthly cycle out (~35 DTE).
  // We don't auto-build the short leg — just surface it as guidance so
  // the user knows the LEAP isn't a "set and forget" trade.
  const pmccShortStrike = snapStrike(price * 1.05);
  const pmccShortDte = 35;

  // ── IV at entry — Carter rule: cheap LEAP = low IV ─────────────────────
  // High IV at entry means you're paying expensive vol on a contract with
  // 18 months of vega exposure. The vol-crush risk is real. We surface a
  // warning without blocking the trade — operator knows their thesis.
  const ivAtEntry = Number(prem.iv_used) || null;
  const ivIsExpensive = Number.isFinite(ivAtEntry) && ivAtEntry > 0.55;
  const ivIsCheap = Number.isFinite(ivAtEntry) && ivAtEntry < 0.30;

  // ── Capital-efficiency target ──────────────────────────────────────────
  // Target 3-5× efficiency for a "good" LEAP entry. Below 2× and you're
  // either too deep ITM (strike close to spot, not enough leverage) or
  // the underlying is too cheap to justify the leverage premium. Surface
  // as a soft warning in the notes so the operator can adjust.
  const efficiencyHealthy = capitalEfficiency != null && capitalEfficiency >= 2.5;

  const notes = [
    `Synthetic long: ~${sharesEquivalent} share equivalent for $${leapCapital.toLocaleString()} (${capitalEfficiency ? capitalEfficiency.toFixed(1) + "× capital efficient" : "—"} vs ${sharesEquivalent} shares @ $${sharesCapital.toLocaleString()})`,
    `Theta ≈ $${Math.abs(prem.greeks.theta * 100 * contracts).toFixed(2)}/day decay (low — long DTE; theta accelerates inside T-180 days)`,
    `Roll discipline: ${expiration.dte > 365 ? "close at T-180 days and roll to next-year LEAP cycle — never carry into the last 6 months" : "this contract is already inside the theta cliff zone; consider rolling to a longer-dated LEAP"}`,
    `PMCC follow-on: once thesis confirms, sell a ${pmccShortDte} DTE ~$${pmccShortStrike} call (≈5% OTM) against this LEAP to monetize theta without capping LEAP upside`,
  ];
  if (!efficiencyHealthy) {
    notes.push(`⚠ Capital efficiency only ${capitalEfficiency ? capitalEfficiency.toFixed(1) + "×" : "n/a"} — below the 3-5× target. Strike may be too deep ITM, or the LEAP is the wrong tool for this name.`);
  }
  if (ivIsExpensive) {
    notes.push(`⚠ IV at entry ${(ivAtEntry * 100).toFixed(0)}% — premium is expensive. Vol crush is real on multi-year vega exposure. Best LEAP entries are at low IV; consider waiting for a vol contraction.`);
  } else if (ivIsCheap) {
    notes.push(`✓ IV at entry ${(ivAtEntry * 100).toFixed(0)}% — vol is cheap relative to typical pricing. Favorable entry timing for a long-vega contract.`);
  }

  return {
    archetype: "leap_call",
    label: `LEAP Call (${expiration.dte}DTE · Stock Replacement)`,
    rationale: `Long-term bullish to $${exitTarget?.toFixed(2) ?? "?"}. Deep-ITM ${expiration.iso} call at $${strike} (${deltaPct}Δ) tracks ~${deltaPct}% of every $1 move with ~${capitalEfficiency ? capitalEfficiency.toFixed(1) + "×" : "?"} less capital than buying ${sharesEquivalent} shares outright. Max loss = premium paid; no margin call, no forced exit on drawdown. Plan to roll at T-180 days and consider stacking a poor-man's covered call once your thesis confirms.`,
    target_delta: targetDelta,
    actual_delta: Number(prem.greeks?.delta) || null,
    legs: [
      {
        action: "BUY", optionType: "CALL", strike, expiration: expiration.iso, qty: contracts,
        premium_mid: Number(prem.mid?.toFixed(2)) || null,
        premium_bid: prem.bid != null ? Number(Number(prem.bid).toFixed(2)) : null,
        premium_ask: prem.ask != null ? Number(Number(prem.ask).toFixed(2)) : null,
        leg_cost_usd: leapCapital,
        side_label: "debit",
      },
    ],
    strikes: { primary: strike },
    expiration,
    premium: prem,
    contracts,
    max_loss_usd: Math.round(maxLoss),
    max_gain_usd: intrinsicAtTP > premPerShare ? Math.round(gainAtTP) : null,
    max_gain_label: "Uncapped above target — held to thesis exit or T-180 roll",
    breakeven,
    target_clears_breakeven: Number.isFinite(exitTarget) ? exitTarget > breakeven : null,
    /* LEAPs are held for months → the user actually approximates the
       hold-to-expiration scenario. Still surface est_at_tp so the
       UI/email can show the projection; the est_at_sl is less
       relevant for LEAPs (no hard stop) but reported for symmetry. */
    est_at_tp: (Number.isFinite(exitTarget) && exitTarget > 0) ? estimateOptionAtTargetPrice({
      currentPrice: price, targetPrice: exitTarget, strike, type: "C",
      currentDte: expiration.dte, premiumPaid: premPerShare,
      contracts, atrPct, ivOverride: Number(prem.iv_used) || null,
    }) : null,
    prob_profit_at_target: prem.greeks.prob_itm,
    // LEAP-specific metadata for UI / notifications.
    shares_equivalent: sharesEquivalent,
    shares_capital_usd: sharesCapital,
    capital_efficiency: capitalEfficiency != null ? Math.round(capitalEfficiency * 10) / 10 : null,
    iv_at_entry: ivAtEntry,
    iv_assessment: ivIsExpensive ? "expensive" : (ivIsCheap ? "cheap" : "normal"),
    pmcc_suggestion: {
      short_strike: pmccShortStrike,
      short_dte_target: pmccShortDte,
      rationale: "Sell ~5% OTM ~35 DTE call against this LEAP once thesis confirms (poor man's covered call).",
    },
    roll_target: expiration.dte > 365 ? "T-180_days" : "roll_now_to_longer_leap",
    notes,
  };
}

function buildLongPut(ctx) {
  const { price, tp1, tp2, sl, atrPct, expiration, contracts, chain, targetDelta = 0.50, levels = [] } = ctx;
  const exitTarget = pickExitTargetPrice(ctx) ?? tp1;
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
  strike = refineStrikeWithModelLevels(strike, levels);
  const prem = estimatePremium({ price, strike, dte: expiration.dte, atrPct, type: "P", chainLeg });
  if (!prem) return null;
  const premPerShare = prem.mid;
  const maxLoss = premPerShare * 100 * contracts;
  const breakeven = strike - premPerShare;
  const intrinsicAtTP = Math.max(0, strike - exitTarget);
  const gainAtTP = (intrinsicAtTP - premPerShare) * 100 * contracts;
  const ivUsed = Number(prem.iv_used) || null;
  const deltaLabel = targetDelta >= 0.65 ? "Deep ITM (Stock Replacement)"
                    : targetDelta >= 0.40 ? "ATM"
                    : targetDelta >= 0.25 ? "OTM"
                    : "Far OTM";
  const deltaPct = (Math.abs(prem.greeks?.delta || targetDelta) * 100).toFixed(0);
  return {
    archetype: "long_put",
    label: `Long Put (${deltaLabel})`,
    rationale: `Bearish bias to $${exitTarget?.toFixed(2) ?? "?"}. Strike $${strike} (${deltaPct}Δ via ${deltaSource}) — every $1 down ≈ $${deltaPct}/contract. Max loss = premium paid.`,
    target_delta: targetDelta,
    actual_delta: Number(prem.greeks?.delta) || null,
    legs: [
      {
        action: "BUY", optionType: "PUT", strike, expiration: expiration.iso, qty: contracts,
        premium_mid: Number(prem.mid?.toFixed(2)) || null,
        premium_bid: prem.bid != null ? Number(Number(prem.bid).toFixed(2)) : null,
        premium_ask: prem.ask != null ? Number(Number(prem.ask).toFixed(2)) : null,
        leg_cost_usd: Math.round(prem.mid * 100 * contracts),
        side_label: "debit",
      },
    ],
    strikes: { primary: strike },
    expiration,
    premium: prem,
    contracts,
    max_loss_usd: Math.round(maxLoss),
    max_gain_usd: intrinsicAtTP > premPerShare ? Math.round(gainAtTP) : null,
    max_gain_label: "Uncapped below target",
    breakeven,
    target_clears_breakeven: Number.isFinite(exitTarget) ? exitTarget < breakeven : null,
    est_at_tp: (Number.isFinite(exitTarget) && exitTarget > 0) ? estimateOptionAtTargetPrice({
      currentPrice: price, targetPrice: exitTarget, strike, type: "P",
      currentDte: expiration.dte, premiumPaid: premPerShare,
      contracts, atrPct, ivOverride: ivUsed,
    }) : null,
    est_at_sl: (Number.isFinite(sl) && sl > 0) ? estimateOptionAtTargetPrice({
      currentPrice: price, targetPrice: sl, strike, type: "P",
      currentDte: expiration.dte, premiumPaid: premPerShare,
      contracts, atrPct, ivOverride: Number(prem.iv_used) || null,
    }) : null,
    prob_profit_at_target: prem.greeks.prob_itm,
    notes: [
      `Theta ≈ $${Math.abs(prem.greeks.theta * 100 * contracts).toFixed(2)}/day decay`,
      `Vega ≈ $${(prem.greeks.vega * 100 * contracts).toFixed(2)} per 1% IV change`,
    ],
  };
}

function buildVerticalSpread(ctx, direction) {
  const { price, tp1, tp2, atrPct, expiration, contracts, chain, levels = [] } = ctx;
  const spreadTarget = pickSpreadShortStrikePrice({ ...ctx, direction: direction === "long" ? "LONG" : "SHORT" });
  const longStrike  = refineStrikeWithModelLevels(snapStrike(price), levels);
  const shortStrike = refineStrikeWithModelLevels(snapStrike(spreadTarget), levels);
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
    rationale: `Defined-risk ${direction === "long" ? "bullish" : "bearish"} play to $${spreadTarget?.toFixed(2) ?? "?"}${Number.isFinite(tp2) && tp2 > 0 && Math.abs(tp2 - spreadTarget) < 0.01 && Number.isFinite(tp1) ? ` (Exit; Trim $${tp1.toFixed(2)})` : ""}. Pay ${netDebit.toFixed(2)} to win up to $${width.toFixed(2)} (${rrRatio.toFixed(1)}x R:R). Caps both downside AND upside.`,
    // 2026-05-30 — Attach per-leg premium so the UI's "How This Works"
    // panel can show the math: e.g. "BUY $510 CALL @ $X" + "SELL $540
    // CALL @ $Y" → "Net debit X - Y = $7.45". Without per-leg prices
    // the user can't see WHY the spread costs $7.45 (which was the
    // direct user feedback on the original How This Works text).
    legs: [
      {
        action: "BUY", optionType: type === "C" ? "CALL" : "PUT",
        strike: longStrike, expiration: expiration.iso, qty: contracts,
        premium_mid:  Number(longPrem.mid?.toFixed(2))  || null,
        premium_bid:  longPrem.bid  != null ? Number(Number(longPrem.bid).toFixed(2))  : null,
        premium_ask:  longPrem.ask  != null ? Number(Number(longPrem.ask).toFixed(2))  : null,
        leg_cost_usd: Math.round(longPrem.mid * 100 * contracts),
        side_label: "debit",  // you PAY this much
      },
      {
        action: "SELL", optionType: type === "C" ? "CALL" : "PUT",
        strike: shortStrike, expiration: expiration.iso, qty: contracts,
        premium_mid:  Number(shortPrem.mid?.toFixed(2)) || null,
        premium_bid:  shortPrem.bid != null ? Number(Number(shortPrem.bid).toFixed(2)) : null,
        premium_ask:  shortPrem.ask != null ? Number(Number(shortPrem.ask).toFixed(2)) : null,
        leg_cost_usd: Math.round(shortPrem.mid * 100 * contracts),
        side_label: "credit",  // you COLLECT this much
      },
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
  const { price, sl, atrPct, expiration, contracts, chain, levels = [] } = ctx;
  const strike = refineStrikeWithModelLevels(snapStrike(sl), levels);
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
      {
        action: "SELL", optionType: "PUT", strike, expiration: expiration.iso, qty: contracts,
        premium_mid: Number(prem.mid?.toFixed(2)) || null,
        premium_bid: prem.bid != null ? Number(Number(prem.bid).toFixed(2)) : null,
        premium_ask: prem.ask != null ? Number(Number(prem.ask).toFixed(2)) : null,
        leg_cost_usd: Math.round(prem.mid * 100 * contracts),
        side_label: "credit", // you COLLECT premium for selling
      },
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
      {
        action: "SELL", optionType: "CALL", strike, expiration: expiration.iso, qty: contracts,
        premium_mid: Number(prem.mid?.toFixed(2)) || null,
        premium_bid: prem.bid != null ? Number(Number(prem.bid).toFixed(2)) : null,
        premium_ask: prem.ask != null ? Number(Number(prem.ask).toFixed(2)) : null,
        leg_cost_usd: Math.round(prem.mid * 100 * contracts),
        side_label: "credit",
      },
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
function buildLotto(ctx, direction, { lottoMaxLossUsd = 50 } = {}) {
  const { price, sl, atrPct, chain, ticker } = ctx;
  const expiration = pickLottoExpiration(ticker, Date.now());
  const targetDelta = 0.15;
  const type = direction === "SHORT" ? "P" : "C";

  let strike, chainLeg;
  if (chain) {
    const picked = pickLegByDelta(chain, type, targetDelta, price);
    if (picked.leg) {
      strike = Number(picked.leg.strike);
      chainLeg = picked.leg;
    }
  }
  if (!strike) {
    strike = deltaToStrikeBS({ price, targetDelta, dte: expiration.dte, atrPct, type })
          || (direction === "SHORT" ? snapStrike(price * 0.98) : snapStrike(price * 1.02));
  }

  const prem = estimatePremium({ price, strike, dte: expiration.dte, atrPct, type, chainLeg });
  if (!prem || prem.mid <= 0) return null;
  const premPerShare = prem.mid;
  const budget = Math.max(25, Number(lottoMaxLossUsd) || 50);
  const lottoContracts = Math.max(1, Math.floor(budget / (premPerShare * 100)));
  const maxLoss = premPerShare * 100 * lottoContracts;

  const underlyingFor = (intrinsicPerShare) => direction === "SHORT"
    ? Math.max(0, strike - intrinsicPerShare)
    : strike + intrinsicPerShare;
  const px2x = underlyingFor(premPerShare);
  const px3x = underlyingFor(premPerShare * 2);

  const archetype = direction === "SHORT" ? "lotto_put" : "lotto_call";
  return {
    archetype,
    label: `🎲 Lotto ${direction === "SHORT" ? "Put" : "Call"} (${expiration.dte}DTE, ${(targetDelta * 100).toFixed(0)}Δ)`,
    rationale: `🎲 Floor + timing align — cheap OTM gamma before/at the move. ${lottoContracts}× $${strike} ${type === "P" ? "puts" : "calls"} exp ${expiration.dte}DTE. Risk $${Math.round(maxLoss)} (premium may go to zero) for 3×+ if ${ticker || "underlying"} runs to $${px3x.toFixed(2)}.`,
    target_delta: targetDelta,
    actual_delta: Number(prem.greeks?.delta) || null,
    legs: [{
      action: "BUY", optionType: type === "P" ? "PUT" : "CALL",
      strike, expiration: expiration.iso, qty: lottoContracts,
      premium_mid: Number(prem.mid?.toFixed(2)) || null,
      leg_cost_usd: Math.round(prem.mid * 100 * lottoContracts),
      side_label: "debit",
    }],
    strikes: { primary: strike },
    expiration,
    premium: prem,
    contracts: lottoContracts,
    max_loss_usd: Math.round(maxLoss),
    max_gain_label: "Uncapped — gamma-driven",
    breakeven: direction === "SHORT" ? strike - premPerShare : strike + premPerShare,
    multi_bagger_targets: {
      "2x_underlying_at": +px2x.toFixed(2),
      "3x_underlying_at": +px3x.toFixed(2),
    },
    lotto: true,
    sizing_note: `Fixed $${Math.round(budget)} max-loss budget`,
    trade_mgmt: [
      "🎯 Take profit at +100% / +200% — do not hold to zero theta",
      `🛡 Hard stop: ${ticker || "underlying"} violates floor $${Number(sl || 0).toFixed(2) || "SL"}`,
      `💸 Premium ≈ $${premPerShare.toFixed(2)}/contract × ${lottoContracts} = $${Math.round(maxLoss)} at risk`,
    ],
  };
}

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
    legs: [{
      action: "BUY", optionType: type === "P" ? "PUT" : "CALL",
      strike, expiration: expiration.iso, qty: moonshotContracts,
      premium_mid: Number(prem.mid?.toFixed(2)) || null,
      premium_bid: prem.bid != null ? Number(Number(prem.bid).toFixed(2)) : null,
      premium_ask: prem.ask != null ? Number(Number(prem.ask).toFixed(2)) : null,
      leg_cost_usd: Math.round(prem.mid * 100 * moonshotContracts),
      side_label: "debit",
    }],
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
export function buildLeveragedETFPlay(ctx) {
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

/* 2026-06-01 — Build a single day-trade options play for SPY/QQQ/IWM.

   Returns one of three structures depending on the day's directional
   signal:
     - LONG  bias (verdict RIDE/READY long, OR direction LONG) → ATM call
     - SHORT bias (verdict RIDE/READY short, OR direction SHORT) → ATM put
     - NEUTRAL high-vol (no clear direction, atrPct >= 0.012)    → ATM straddle

   Conservative defaults that match retail day-trader expectations:
     - 1 contract sizing (operator can scale via the per-vehicle cap
       in Mission Control)
     - ATM strike (max gamma, max sensitivity to intraday move)
     - 0DTE if before market close, 1DTE otherwise (pickDayTradeExpiration)
     - Max loss = premium paid (always defined; never undefined)

   Returns null if the ticker isn't on the day-trade allow-list. */

/** Compact game-plan levels for Today day-trade cards (index playbook). */
export function summarizeDayTradeGamePlan(gamePlan) {
  if (!gamePlan || typeof gamePlan !== "object") return null;
  const lean = String(gamePlan.lean || "").toUpperCase() || null;
  return {
    lean,
    lean_conviction: gamePlan.lean_conviction || gamePlan.leanConviction || null,
    bull_trigger: Number(gamePlan.bull_trigger ?? gamePlan.bullTrigger) || null,
    bull_target: Number(gamePlan.bull_target ?? gamePlan.bullTarget) || null,
    bear_trigger: Number(gamePlan.bear_trigger ?? gamePlan.bearTrigger) || null,
    bear_target: Number(gamePlan.bear_target ?? gamePlan.bearTarget) || null,
  };
}

/** When buildDayTradePlay returns null, explain why (Today suppressed row). */
export function explainDayTradeSuppression(ctx) {
  const ticker = String(ctx?.ticker || "").toUpperCase();
  if (!isDayTradeTicker(ticker)) return { reason: "not_day_trade_ticker" };
  const price = Number(ctx?.price);
  if (!(price > 0)) return { reason: "no_live_spot" };

  const profile = ctx?.profile && PROFILE_META[ctx.profile] ? ctx.profile : DEFAULT_RISK_PROFILE;
  const direction = String(ctx?.direction || "").toUpperCase();
  const verdictMode = String(ctx?.verdict?.mode || "UNKNOWN").toUpperCase();
  const verdictSide = ctx?.verdict?.side || direction;
  const atrPct = Number(ctx?.atrPct) || 0.012;
  const wantsSingleLeg = profile === "speculator" || profile === "aggressive";
  const dayLean = String(ctx?.dayLean || "").toUpperCase();
  const dayLeanConv = String(ctx?.dayLeanConviction || "").toLowerCase();
  const leanActionable = (dayLean === "LONG" || dayLean === "SHORT")
    && (dayLeanConv === "medium" || dayLeanConv === "high");

  if (leanActionable) return { reason: "build_failed", day_lean: dayLean, day_lean_conviction: dayLeanConv };

  const align = shouldAllowIndexDirectional({
    verdictMode,
    verdictSide,
    direction,
    effectiveDirection: direction,
    confluence: ctx?.verdict,
    timingOverlay: ctx?.verdict?.timing,
  });

  if (!align.allow) {
    if (dayLean && dayLeanConv === "low") {
      return {
        reason: "day_lean_low_conviction",
        day_lean: dayLean,
        day_lean_conviction: dayLeanConv,
        confluence_mode: verdictMode,
      };
    }
    if (verdictMode === "WAIT" && wantsSingleLeg && atrPct < 0.012) {
      return {
        reason: "no_directional_signal_low_vol",
        confluence_mode: verdictMode,
        day_lean: dayLean || null,
        day_lean_conviction: dayLeanConv || null,
      };
    }
    return {
      reason: align.reason || "wait_no_directional_bet",
      confluence_mode: verdictMode,
      day_lean: dayLean || null,
      day_lean_conviction: dayLeanConv || null,
    };
  }
  return { reason: "build_failed", confluence_mode: verdictMode };
}

export function buildDayTradePlay(ctx) {
  const ticker = String(ctx?.ticker || "").toUpperCase();
  if (!isDayTradeTicker(ticker)) return null;
  const price = Number(ctx?.price);
  if (!Number.isFinite(price) || price <= 0) return null;

  const profile = ctx?.profile && PROFILE_META[ctx.profile] ? ctx.profile : DEFAULT_RISK_PROFILE;
  const direction = String(ctx?.direction || "").toUpperCase();
  const verdictMode = ctx?.verdict?.mode || "UNKNOWN";
  const verdictSide = ctx?.verdict?.side || direction;
  const atrPct = Number(ctx?.atrPct) || 0.012;
  const expiration = ctx?.expiration || pickDayTradeExpiration(Date.now(), {
    forceTomorrow: profile === "conservative" || profile === "moderate",
  });
  const chain = ctx?.chain || null;
  const wantsSingleLeg = profile === "speculator" || profile === "aggressive";
  const align = shouldAllowIndexDirectional({
    verdictMode,
    verdictSide,
    direction,
    effectiveDirection: direction,
    confluence: ctx?.verdict,
    timingOverlay: ctx?.verdict?.timing,
  });

  // 2026-06-16 — Day lean drives the 0/1DTE flavor. These are SAME-DAY
  // instruments, so the correct-horizon signal is the day-trade lean (the same
  // source the Today Predictions + brief Index Playbook lead with), NOT the
  // multi-day confluence gate. When the lean has conviction it sets the flavor
  // directly so the option play agrees with the prediction the trader just
  // read; otherwise we fall back to the confluence-gated behavior.
  const dayLean = String(ctx?.dayLean || "").toUpperCase();
  const dayLeanConv = String(ctx?.dayLeanConviction || "").toLowerCase();
  const leanActionable = (dayLean === "LONG" || dayLean === "SHORT")
    && (dayLeanConv === "medium" || dayLeanConv === "high");

  // Decide flavor.
  let flavor;
  let _flavorSource = "confluence";
  if (leanActionable) {
    flavor = dayLean === "SHORT" ? "put" : "call";
    _flavorSource = "day_lean";
  } else if (!align.allow) {
    // WAIT / misaligned: straddle only for conservative/moderate on high-vol days.
    if (verdictMode === "WAIT" && !wantsSingleLeg && atrPct >= 0.012) {
      flavor = "straddle";
    } else {
      return null;
    }
  } else if (align.contractDir === "SHORT") {
    flavor = "put";
  } else {
    flavor = "call";
  }

  // 2026-06-10 — Day-trade index ETFs list $1 strikes (SPY/QQQ/IWM/DIA
  // all do). The generic strikeGrid() heuristic is for the broad stock
  // universe and jumps to a $10 grid above $500 — that's what produced
  // the DIA "$510 call on a $502.92 spot" incident: speculator +0.5%
  // → 505.43, snapped to the nearest $10 → $510 (1.4% OTM on a 0DTE).
  // With the real $1 grid the same play snaps to $505 (0.4% OTM).
  const _dtGrid = 1.0;
  // Speculator: slight OTM for more gamma; others stay ATM.
  const strike = (profile === "speculator" && (flavor === "call" || flavor === "put"))
    ? snapStrike(flavor === "call" ? price * 1.005 : price * 0.995, _dtGrid)
    : snapStrike(price, _dtGrid);
  const contracts = 1; // intentional minimum; operator scales via MC
  const _dteForBs = Math.max(expiration.dte, 0.5); // BS estimator needs > 0

  if (flavor === "call" || flavor === "put") {
    const optType = flavor === "call" ? "C" : "P";
    const chainLeg = chain ? _chainLeg(chain, optType, strike) : null;
    const prem = estimatePremium({ price, strike, dte: _dteForBs, atrPct, type: optType, chainLeg });
    if (!prem) return null;
    const premMid = prem.mid;
    const maxLoss = premMid * 100 * contracts;
    const breakeven = flavor === "call" ? strike + premMid : strike - premMid;
    return {
      archetype: flavor === "call" ? "day_trade_call" : "day_trade_put",
      label: flavor === "call"
        ? `Day-Trade Call (ATM · ${expiration.label})`
        : `Day-Trade Put (ATM · ${expiration.label})`,
      rationale: flavor === "call"
        ? `Bullish day-trade on ${ticker}: ATM call at $${strike} expiring ${expiration.label}. Max convexity to today's move; max loss = premium paid. Manage actively — theta accelerates inside the final 2 hours.`
        : `Bearish day-trade on ${ticker}: ATM put at $${strike} expiring ${expiration.label}. Max convexity to today's downside; max loss = premium paid. Manage actively — theta accelerates inside the final 2 hours.`,
      legs: [{
        action: "BUY",
        optionType: flavor === "call" ? "CALL" : "PUT",
        strike, expiration: expiration.iso, qty: contracts,
        premium_mid: Number(premMid?.toFixed(2)) || null,
        premium_bid: prem.bid != null ? Number(Number(prem.bid).toFixed(2)) : null,
        premium_ask: prem.ask != null ? Number(Number(prem.ask).toFixed(2)) : null,
        leg_cost_usd: Math.round(premMid * 100 * contracts),
        side_label: "debit",
      }],
      strikes: { primary: strike },
      expiration,
      premium: prem,
      contracts,
      max_loss_usd: Math.round(maxLoss),
      max_gain_label: flavor === "call" ? "Uncapped above strike + premium" : "Capped at strike − premium (intrinsic ceiling)",
      breakeven,
      notes: [
        `Same-day or next-day expiration (${expiration.dte}DTE) — theta is the dominant risk; treat as scalp, not swing`,
        `Best windows: 9:45-11 AM ET (post-open trend), 2:30-3:45 PM ET (close-of-day push); avoid 12-1:30 PM lunch chop`,
        `Sizing capped at ${contracts} contract — scale via Mission Control "Day Trade" cap when comfortable`,
      ],
      _day_trade: true,
      _day_trade_flavor: flavor,
      _day_trade_flavor_source: _flavorSource,
      _day_trade_lean: dayLean || null,
    };
  }

  // Straddle — direction-neutral day-trade play.
  const callLeg = chain ? _chainLeg(chain, "C", strike) : null;
  const putLeg = chain ? _chainLeg(chain, "P", strike) : null;
  const callPrem = estimatePremium({ price, strike, dte: _dteForBs, atrPct, type: "C", chainLeg: callLeg });
  const putPrem = estimatePremium({ price, strike, dte: _dteForBs, atrPct, type: "P", chainLeg: putLeg });
  if (!callPrem || !putPrem) return null;
  const totalPrem = callPrem.mid + putPrem.mid;
  const maxLoss = totalPrem * 100 * contracts;
  return {
    archetype: "day_trade_straddle",
    label: `Day-Trade Straddle (ATM · ${expiration.label})`,
    rationale: `No clear direction on ${ticker} but vol elevated (${(atrPct * 100).toFixed(2)}% ATR). Buy ATM call + put expiring ${expiration.label} — profits from a move > $${totalPrem.toFixed(2)} in either direction. Max loss = total premium ($${Math.round(maxLoss)}). Watch first 30 min: if range is < breakeven, close half before lunch chop and re-evaluate.`,
    legs: [
      {
        action: "BUY", optionType: "CALL", strike, expiration: expiration.iso, qty: contracts,
        premium_mid: Number(callPrem.mid?.toFixed(2)) || null,
        leg_cost_usd: Math.round(callPrem.mid * 100 * contracts),
        side_label: "debit",
      },
      {
        action: "BUY", optionType: "PUT", strike, expiration: expiration.iso, qty: contracts,
        premium_mid: Number(putPrem.mid?.toFixed(2)) || null,
        leg_cost_usd: Math.round(putPrem.mid * 100 * contracts),
        side_label: "debit",
      },
    ],
    strikes: { primary: strike },
    expiration,
    premium: { mid: totalPrem, source: callPrem.source, call_mid: callPrem.mid, put_mid: putPrem.mid },
    contracts,
    max_loss_usd: Math.round(maxLoss),
    breakeven_up: strike + totalPrem,
    breakeven_down: strike - totalPrem,
    max_gain_label: "Uncapped in either direction",
    notes: [
      `Needs ≥ ${((totalPrem / price) * 100).toFixed(2)}% intraday move from $${price.toFixed(2)} to break even`,
      `0DTE straddles burn ~10% theta/hour after 12 PM ET — exit aggressively if neither side is working by lunch`,
      `Sizing capped at ${contracts} pair — scale via Mission Control "Day Trade" cap when comfortable`,
    ],
    _day_trade: true,
    _day_trade_flavor: "straddle",
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
  // Source = live_chain only if BOTH legs came from chain.
  const source = (callPrem.source === "live_chain" && putPrem.source === "live_chain")
    ? "live_chain" : "estimate_bs_atr_iv";
  return {
    archetype: "long_straddle",
    label: "Long Straddle (ATM)",
    rationale: `Direction unclear but BIG move expected (squeeze release, earnings, catalyst pending). Buy ATM call AND put — profit from any move > $${totalPrem.toFixed(2)} in either direction. Max loss = premium if price expires at strike.`,
    legs: [
      {
        action: "BUY", optionType: "CALL", strike, expiration: expiration.iso, qty: contracts,
        premium_mid: Number(callPrem.mid?.toFixed(2)) || null,
        premium_bid: callPrem.bid != null ? Number(Number(callPrem.bid).toFixed(2)) : null,
        premium_ask: callPrem.ask != null ? Number(Number(callPrem.ask).toFixed(2)) : null,
        leg_cost_usd: Math.round(callPrem.mid * 100 * contracts),
        side_label: "debit",
      },
      {
        action: "BUY", optionType: "PUT", strike, expiration: expiration.iso, qty: contracts,
        premium_mid: Number(putPrem.mid?.toFixed(2)) || null,
        premium_bid: putPrem.bid != null ? Number(Number(putPrem.bid).toFixed(2)) : null,
        premium_ask: putPrem.ask != null ? Number(Number(putPrem.ask).toFixed(2)) : null,
        leg_cost_usd: Math.round(putPrem.mid * 100 * contracts),
        side_label: "debit",
      },
    ],
    strikes: { primary: strike },
    expiration,
    premium: {
      mid: totalPrem,
      low: totalPrem * 0.9,
      high: totalPrem * 1.1,
      iv_used: callPrem.iv_used,
      source,
      call_mid: callPrem.mid,
      put_mid: putPrem.mid,
    },
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
//   1. Moonshot active (when ALL conditions met) — top of ladder
//   2. Confluence-boosted plays (RIDE -> long premium, FADE -> spreads)
//   3. Risk profile preference
// The stock fallback always remains so every profile sees something
// actionable even when WAIT / no confluence.
function rankByProfile(strategies, profile, { ticker } = {}) {
  const order = PROFILE_META[profile]?.preferred || PROFILE_META.speculator.preferred;
  const sym = String(ticker || "").toUpperCase();
  const isIndexTrader = isDayTradeTicker(sym);
  const wantsSingleLeg = isIndexTrader && (profile === "speculator" || profile === "aggressive");
  const wantsDefinedRisk = isIndexTrader && (profile === "conservative" || profile === "moderate");

  const profileScore = (s) => {
    const idx = order.indexOf(s.archetype);
    let score = idx === -1 ? 999 : idx;
    // WAIT-day vol: only Speculator headlines straddle; others prefer lean/directional.
    if (profile !== "speculator" && s.archetype === "long_straddle") {
      score += profile === "aggressive" ? 35 : 40;
    }
    if (s._wait_vol && profile === "speculator" && s.archetype === "long_straddle") score -= 25;
    if (s._wait_lean) {
      if (profile === "moderate" && s.archetype === "long_call") score -= 20;
      if (profile === "moderate" && s.archetype === "vertical_spread") score += 15;
      if (profile === "aggressive" && s.archetype === "long_call") score -= 10;
      if (profile === "speculator" && (s.archetype === "long_call" || s.archetype === "vertical_spread")) score += 25;
    }
    if (profile === "conservative" && (s.archetype === "long_call" || s.archetype === "long_put")) score += 12;
    if (profile === "moderate" && (s.archetype === "long_call" || s.archetype === "long_put")) score -= 10;
    if (profile === "moderate" && s.archetype === "vertical_spread") score -= 6;
    if (profile === "aggressive" && s.archetype === "long_call") score -= 5;
    if ((profile === "moderate" || profile === "aggressive") && s.archetype === "stock_long") score += 12;
    // Index ETFs: penalize multi-leg structures when profile wants singles.
    if (wantsSingleLeg && _INDEX_MULTI_LEG.has(s.archetype)) score += 25;
    if (wantsSingleLeg && _INDEX_SINGLE_LEG.has(s.archetype)) score -= 5;
    // Conservative/moderate index: prefer spreads over naked long premium.
    if (wantsDefinedRisk && _INDEX_MULTI_LEG.has(s.archetype)) score -= 8;
    if (wantsDefinedRisk && (s.archetype === "long_call" || s.archetype === "long_put")) score += 6;
    return score;
  };

  const confluenceBoost = (s) => {
    if (!s._confluence_boost) return 0;
    // DRIFT/FADE boosts spreads — but on index ETFs Speculator should still
    // headline single-leg gamma plays, not a vertical spread.
    if (wantsSingleLeg && _INDEX_MULTI_LEG.has(s.archetype)) return 0;
    return -10;
  };

  return [...strategies].sort((a, b) => {
    const aMoon = a._moonshot_active ? -100 : 0;
    const bMoon = b._moonshot_active ? -100 : 0;
    if (aMoon !== bMoon) return aMoon - bMoon;
    const aInv = a._investor_boost ? -50 : 0;
    const bInv = b._investor_boost ? -50 : 0;
    if (aInv !== bInv) return aInv - bInv;
    const aOptFirst = a._options_first_boost ? -80 : 0;
    const bOptFirst = b._options_first_boost ? -80 : 0;
    if (aOptFirst !== bOptFirst) return aOptFirst - bOptFirst;
    const aStockDep = a._options_first_deprioritize ? 35 : 0;
    const bStockDep = b._options_first_deprioritize ? 35 : 0;
    if (aStockDep !== bStockDep) return aStockDep - bStockDep;
    const aBoost = confluenceBoost(a);
    const bBoost = confluenceBoost(b);
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
  const tp1Raw = Number(contract.tp1 ?? contract.tp);
  const tp1 = Number.isFinite(tp1Raw) && tp1Raw > 0
    ? tp1Raw
    : (direction === "LONG" ? price * 1.05 : price * 0.95);
  const tp2 = Number(contract.tp2);
  const tp3 = Number(contract.tp3);
  const levels = Array.isArray(contract.levels) ? contract.levels : [];
  const atrPct = Number(contract.atr_pct ?? contract.atrPct ?? 0.025);
  const isInvestorMode = String(contract?.mode || "").toLowerCase() === "investor"
    || classifySetupStage(contract) === "investor";
  let expiration = pickExpirationForProfile(contract, profile, opts.now || Date.now());
  let chain = opts.chain || null;
  let leapChain = opts.leap_chain || null;
  if (chain && listChainExpirationDates(chain).length) {
    expiration = resolveExpirationWithChain(expiration, chain, opts.now || Date.now());
    chain = filterChainToExpiration(chain, expiration.iso);
  }
  // Prefer an explicitly fetched LEAP cycle; else reuse a full_chain blob
  // that already contains the LEAP expiry.
  if (!leapChain && opts.full_chain) {
    const leapIdeal = pickLeapExpiration(opts.now || Date.now());
    const listed = listChainExpirationDates(opts.full_chain);
    const leapResolved = listed.length
      ? snapExpirationToChain(leapIdeal, listed, opts.now || Date.now())
      : leapIdeal;
    leapChain = chainForExpiration(opts.full_chain, leapResolved.iso);
  }
  const tickerSym = String(contract.ticker || "").toUpperCase();
  const isIndexTrader = isDayTradeTicker(tickerSym) && !isInvestorMode;
  const indexWantsSingleLeg = isIndexTrader && (profile === "speculator" || profile === "aggressive");
  const indexWantsDefinedRisk = isIndexTrader && (profile === "conservative" || profile === "moderate");

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
    if (isIndexTrader) {
      if (profile === "speculator") {
        return verdictModeForDelta === "FADE" ? 0.30 : 0.45;
      }
      if (profile === "aggressive") return 0.50;
      if (profile === "conservative") return 0.70;
    }
    if (verdictModeForDelta === "RIDE") {
      return profile === "speculator" ? 0.70 : 0.50;
    }
    if (verdictModeForDelta === "FADE") return 0.30;
    if (verdictModeForDelta === "READY" || verdictModeForDelta === "DRIFT") return 0.50;
    return 0.50;
  })();

  const ctx = {
    ticker: contract.ticker,
    price, direction, sl,
    tp1: Number.isFinite(tp1) ? tp1 : null,
    tp2: Number.isFinite(tp2) && tp2 > 0 ? tp2 : null,
    tp3: Number.isFinite(tp3) && tp3 > 0 ? tp3 : null,
    atrPct, expiration, contracts,
    account_value: accountValue, risk_budget_pct: riskBudgetPct,
    dollars_at_risk: dollarsAtRisk,
    chain: chain,
    leap_chain: leapChain,
    themes: Array.isArray(opts.themes) ? opts.themes : [],
    levels,
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
  const fadeEffectiveDirection = (verdictMode === "FADE" && verdict?.side && verdict.side !== "NEUTRAL")
    ? verdict.side
    : direction;

  const directionalAlign = shouldAllowIndexDirectional({
    verdictMode,
    verdictSide,
    direction,
    effectiveDirection: fadeEffectiveDirection,
    confluence: verdict,
    timingOverlay: verdict?.timing,
  });
  const timingPlayDir = (directionalAlign?.timing_override && directionalAlign?.side)
    ? directionalAlign.side
    : null;
  const playDirection = timingPlayDir || fadeEffectiveDirection;
  const fadeFlipped = playDirection !== direction && !timingPlayDir;
  const levelLean = inferLevelLean(price, sl, tp1, direction)
    || (verdict?.timing?.call_opportunity ? "LONG" : null)
    || (verdict?.timing?.put_opportunity ? "SHORT" : null);
  const activeDir = String(playDirection || levelLean || "").toUpperCase();

  const lottoDecision = shouldActivateLotto({
    confluence: opts.confluence,
    contract: { ...contract, price, sl },
    profile,
    direction: activeDir,
  });
  const earningsPrepDecision = shouldActivateEarningsPrepLotto({
    confluence: opts.confluence,
    contract: { ...contract, price, sl },
    profile,
    direction: activeDir,
    tickerData: opts.tickerData || contract,
    earningsDte: resolveEarningsDte(contract, opts.tickerData || {}),
  });

  const exitForFade = pickExitTargetPrice(ctx) ?? tp1;
  let ctxEff;
  if (fadeFlipped) {
    ctxEff = { ...ctx, direction: playDirection, tp1: sl, tp2: tp3, tp3: tp2, sl: exitForFade };
  } else if (activeDir === "LONG" || activeDir === "SHORT") {
    const norm = normalizeDirectionalLevels(price, sl, tp1, activeDir, atrPct);
    ctxEff = { ...ctx, direction: activeDir, sl: norm.sl, tp1: norm.tp1 };
  } else {
    ctxEff = ctx;
  }

  const ladder = [];

  /* 2026-06-01 — Investor mode bypasses the trader-side WAIT suppression.

     The trader confluence verdict (RIDE / READY / DRIFT / FADE / WAIT) is
     a short-horizon "do we have a 1-5 day direction signal right now?"
     judgment. The Investor Accumulate stage is a multi-month thesis built
     on Monthly SuperTrend + Weekly EMA(200) + RS Rank — a fundamentally
     different time-horizon signal. The Investor stage IS the directional
     verdict; a trader-side WAIT (e.g. intraday chop or pre-catalyst
     hesitation) should not strip the LEAP from the Investor ladder and
     leave only a direction-neutral straddle.

     Real-world bug this fixes: CRS in Investor Accumulate / ON-THESIS,
     trader confluence was WAIT (pre-catalyst), and the ladder showed a
     Long Straddle (ATM) as PRIMARY PLAY — visually contradicting the
     "we are accumulating LONG" investor thesis. Operator flagged it. */
  const directionalAlignForIndex = isIndexTrader ? directionalAlign : null;
  const suppressDirectional = !isInvestorMode && (
    (verdictMode === "WAIT" && !directionalAlign?.timing_override)
    || (isIndexTrader && !directionalAlign?.allow)
  );

  // 🌙 MOONSHOT — if all activation conditions met, insert at TOP of ladder.
  // This is the gem: short-dated OTM gamma play when the model has identified
  // both direction AND moment with multi-layer confluence.
  if (moonshotDecision.activate && !suppressDirectional) {
    const moonshot = buildMoonshot(
      { ...ctxEff, motion: moonshotDecision.motion },
      activeDir || playDirection,
    );
    if (moonshot) {
      moonshot._confluence_boost = true;
      moonshot._moonshot_active = true;
      ladder.push(moonshot);
    }
  }

  // Standard lotto needs directional allowance; earnings-prep lotto is
  // advisory only (premium-defined risk) and may surface even under WAIT
  // when the floor is held into a 1–5d earnings window.
  const activateStandardLotto = lottoDecision.activate && !suppressDirectional && !moonshotDecision.activate;
  const activateEarningsPrepLotto = earningsPrepDecision.activate && !moonshotDecision.activate
    && !activateStandardLotto;
  if (activateStandardLotto || activateEarningsPrepLotto) {
    const lottoMax = Number(opts.lotto_max_loss_usd) || 50;
    const lotto = buildLotto(
      { ...ctxEff, chain },
      activeDir || playDirection,
      { lottoMaxLossUsd: lottoMax },
    );
    if (lotto) {
      lotto._lotto_active = true;
      if (activateEarningsPrepLotto) {
        const ed = earningsPrepDecision.earnings_dte;
        lotto._earnings_prep = true;
        lotto.label = `⚡ Earnings Prep Lotto ${String(activeDir || playDirection).toUpperCase() === "SHORT" ? "Put" : "Call"} (${lotto.expiration?.dte ?? "?"}DTE)`;
        lotto.rationale = `⚡ Earnings in ${ed}d — advisory OTM gamma into the print (IV crush risk; not a share entry signal). `
          + (lotto.rationale || "");
        lotto.trade_mgmt = [
          `⚠ Print in ~${ed}d — size for total premium loss; prefer exit before report unless the thesis is explicitly event-driven`,
          ...(Array.isArray(lotto.trade_mgmt) ? lotto.trade_mgmt : []),
        ];
      }
      ladder.push(lotto);
    }
  }

  // 2026-06-01 — LEAPs always appear in the long-side ladder, regardless
  // of stage. Rationale: every long-direction ticker has a "what if I
  // wanted long-term exposure?" answer, and surfacing the LEAP alongside
  // the swing-flavor Long Call lets the operator choose by horizon, not
  // just by direction. The `_investor_boost` flag pins the LEAP as
  // primary only for Investor-stage setups (or when the caller passed
  // `mode: "investor"` explicitly); Trader-stage setups keep their
  // short-dated long_call as primary and the LEAP sits below in the
  // ladder as an alternative.
  const _isInvestorStage = classifySetupStage(contract) === "investor";

  const buildDir = String(ctxEff.direction || activeDir || "").toUpperCase();

  if (!suppressDirectional && (buildDir === "LONG" || buildDir === "")) {
    if (!indexWantsSingleLeg) {
      const leapIdeal = pickLeapExpiration(opts.now || Date.now());
      const leapExp = leapChain
        ? (resolveExpirationWithChain(leapIdeal, leapChain, opts.now || Date.now()) || leapIdeal)
        : leapIdeal;
      const leap = buildLeapCall({
        ...ctxEff,
        leap_chain: leapChain,
        expiration: leapExp,
        targetDelta: 0.80,
      });
      if (leap) {
        if (_isInvestorStage) leap._investor_boost = true;
        if (verdictMode === "RIDE") leap._confluence_boost = true;
        ladder.push(leap);
      }
    }
    const lc = buildLongCall(ctxEff);
    if (lc) {
      if (verdictMode === "RIDE") lc._confluence_boost = true;
      if (verdictMode === "READY") lc._pending_trigger = true;
      if (verdictMode === "DRIFT") lc._late_entry = true;
      ladder.push(lc);
    }
    if (!indexWantsSingleLeg || indexWantsDefinedRisk) {
      const bcs = buildVerticalSpread(ctxEff, "long");
      if (bcs) {
        if (verdictMode === "FADE" || verdictMode === "DRIFT") bcs._confluence_boost = true;
        ladder.push(bcs);
      }
    }
    if (!indexWantsSingleLeg) {
      const letfLong = buildLeveragedETFPlay({ ...ctxEff, direction: "LONG" });
      if (letfLong) ladder.push(letfLong);
    }
    if (!indexWantsSingleLeg) {
      const csp = buildCashSecuredPut(ctxEff);
      if (csp) ladder.push(csp);
      const cc = buildCoveredCall(ctxEff);
      if (cc) ladder.push(cc);
    }
    const longNorm = normalizeDirectionalLevels(price, ctxEff.sl, ctxEff.tp1, "LONG", atrPct);
    ladder.push({
      archetype: "stock_long",
      label: "Stock (Long)",
      rationale: `Plain stock long at $${price.toFixed(2)}. Stop $${longNorm.sl?.toFixed(2) ?? "?"}, target $${longNorm.tp1?.toFixed(2) ?? "?"}. No leverage, no time decay, full participation.`,
      legs: [{ action: "BUY", instrument: "STOCK", qty: Math.floor(dollarsAtRisk / (Math.abs(price - longNorm.sl) || 1)) }],
      max_loss_usd: Math.round(Math.abs(price - longNorm.sl) * Math.floor(dollarsAtRisk / (Math.abs(price - longNorm.sl) || 1))),
      max_gain_usd: Math.round(Math.abs(longNorm.tp1 - price) * Math.floor(dollarsAtRisk / (Math.abs(price - longNorm.sl) || 1))),
      notes: ["No expiration", "Full account participation in moves"],
    });
  }

  if (!suppressDirectional && (buildDir === "SHORT" || buildDir === "")) {
    const lp = buildLongPut(ctxEff);
    if (lp) {
      if (verdictMode === "RIDE") lp._confluence_boost = true;
      if (verdictMode === "READY") lp._pending_trigger = true;
      if (verdictMode === "DRIFT") lp._late_entry = true;
      ladder.push(lp);
    }
    if (!indexWantsSingleLeg || indexWantsDefinedRisk) {
      const bps = buildVerticalSpread(ctxEff, "short");
      if (bps) {
        if (verdictMode === "FADE" || verdictMode === "DRIFT") bps._confluence_boost = true;
        ladder.push(bps);
      }
    }
    if (!indexWantsSingleLeg) {
      const letfShort = buildLeveragedETFPlay({ ...ctxEff, direction: "SHORT" });
      if (letfShort) ladder.push(letfShort);
    }
    const shortNorm = normalizeDirectionalLevels(price, ctxEff.sl, ctxEff.tp1, "SHORT", atrPct);
    ladder.push({
      archetype: "stock_short",
      label: "Stock (Short)",
      rationale: `Short stock at $${price.toFixed(2)}. Stop $${shortNorm.sl?.toFixed(2) ?? "?"}, target $${shortNorm.tp1?.toFixed(2) ?? "?"}. Requires margin + locate.`,
      legs: [{ action: "SELL_SHORT", instrument: "STOCK", qty: Math.floor(dollarsAtRisk / (Math.abs(price - shortNorm.sl) || 1)) }],
      max_loss_usd: Math.round(Math.abs(price - shortNorm.sl) * Math.floor(dollarsAtRisk / (Math.abs(price - shortNorm.sl) || 1))),
      notes: ["Borrow + locate required", "Margin requirement applies"],
    });
  }

  /* 2026-06-01 — Direction-neutral plays (Long Straddle, by direction-
     neutral construction) are excluded from Investor mode entirely. The
     Investor thesis is "I'm long-term bullish; I want LONG exposure" —
     a straddle that profits from a big move in EITHER direction does
     NOT express that thesis. It only confused the operator: CRS at
     Accumulate + ON-THESIS but the headline play was "Direction unclear
     but BIG move expected". Trader mode still gets the straddle when
     atr_pct >= 4% or verdict is WAIT — that's where direction-neutral
     volatility expressions are appropriate (catalyst pending, squeeze
     release, no clear short-term direction). */
  const allowDirectionNeutral = !isInvestorMode && !indexWantsSingleLeg;
  if (allowDirectionNeutral && (verdictMode === "WAIT" || direction === "" || atrPct >= 0.04)) {
    // Skip vol-neutral straddle when timing overlay already picked a directional lean.
    if (!directionalAlign?.timing_override) {
      const ls = buildLongStraddle(ctxEff);
      if (ls) {
        if (verdictMode === "WAIT") ls._wait_vol = true;
        ladder.push(ls);
      }
    }
  }

  // WAIT / misaligned layers on non-index names: add lean-direction options +
  // stock expressions with geometry that matches the label.
  if (suppressDirectional && !isIndexTrader) {
    const waitNote = "Layer fusion is WAIT — lean-direction only until the entry trigger fires.";
    const waitLean = levelLean || activeDir || null;
    if (waitLean === "LONG" || waitLean === "SHORT") {
      const waitNorm = normalizeDirectionalLevels(price, sl, tp1, waitLean, atrPct);
      const waitCtx = { ...ctxEff, direction: waitLean, sl: waitNorm.sl, tp1: waitNorm.tp1 };
      if (waitLean === "LONG") {
        const lc = buildLongCall(waitCtx);
        if (lc) ladder.push({ ...lc, _wait_lean: true });
        const bcs = buildVerticalSpread(waitCtx, "long");
        if (bcs) ladder.push({ ...bcs, _wait_lean: true });
      } else {
        const lp = buildLongPut(waitCtx);
        if (lp) ladder.push({ ...lp, _wait_lean: true });
        const bps = buildVerticalSpread(waitCtx, "short");
        if (bps) ladder.push({ ...bps, _wait_lean: true });
      }
      const stockArchetype = waitLean === "LONG" ? "stock_long" : "stock_short";
      if (!ladder.some((s) => s.archetype === stockArchetype)) {
        const riskPerShare = Math.abs(price - waitNorm.sl) || 1;
        const qty = Math.floor(dollarsAtRisk / riskPerShare);
        if (waitLean === "LONG") {
          ladder.push({
            archetype: "stock_long",
            label: "Stock (Long)",
            rationale: `${waitNote} Plain stock long at $${price.toFixed(2)}. Stop $${waitNorm.sl?.toFixed(2) ?? "?"}, target $${waitNorm.tp1?.toFixed(2) ?? "?"}. No options decay.`,
            legs: [{ action: "BUY", instrument: "STOCK", qty }],
            max_loss_usd: Math.round(Math.abs(price - waitNorm.sl) * qty),
            max_gain_usd: Math.round(Math.abs(waitNorm.tp1 - price) * qty),
            notes: ["No expiration", "Conservative expression when options direction is gated"],
          });
        } else {
          ladder.push({
            archetype: "stock_short",
            label: "Stock (Short)",
            rationale: `${waitNote} Short stock at $${price.toFixed(2)}. Stop $${waitNorm.sl?.toFixed(2) ?? "?"}, target $${waitNorm.tp1?.toFixed(2) ?? "?"}. Requires margin + locate.`,
            legs: [{ action: "SELL_SHORT", instrument: "STOCK", qty }],
            max_loss_usd: Math.round(Math.abs(price - waitNorm.sl) * qty),
            notes: ["Borrow + locate required", "Conservative expression when options direction is gated"],
          });
        }
      }
    }
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
        // 2026-06-01 — LEAP-aware liquidity gate. LEAPs trade an order of
        // magnitude thinner than weeklies because most users hold them; OI
        // < 50 is normal on liquid mega-cap LEAPs and rarely causes fill
        // problems below 5-10 contracts. Volume thresholds also relax —
        // LEAPs rotate maybe 1-5 contracts/day even on AAPL. We keep the
        // strict gate for short-dated single legs (where OI directly
        // bounds your fill quality) and soften it for LEAPs.
        const _isLeapLeg = s.archetype === "leap_call" || s.archetype === "leap_put";
        const oiHard = _isLeapLeg ? 25 : 100;
        const oiSoft = _isLeapLeg ? 100 : 100;
        const volHard = _isLeapLeg ? 5 : 50;
        if (oi < oiHard && vol < volHard) {
          warns.push(`${_isLeapLeg ? "LEAP " : ""}Illiquid: $${leg.strike} ${leg.optionType} OI=${oi} vol=${vol} — fills may slip $0.${_isLeapLeg ? "20" : "10"}+. ${_isLeapLeg ? "Limit-only orders required; size down." : ""}`.trim());
        } else if (oi < oiSoft) {
          warns.push(`${_isLeapLeg ? "LEAP " : ""}Low OI on $${leg.strike} ${leg.optionType} (${oi} open) — ${_isLeapLeg ? "expected for LEAPs; mid-price limits will still fill on liquid names" : "verify before sizing up"}.`);
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

  const convictionTier = String(
    opts.convictionTier || opts.tickerData?.__conviction_tier || contract?.tier || "",
  ).toUpperCase();
  const optionsFirstActive = verdictMode === "RIDE" && convictionTier === "A";
  if (optionsFirstActive) {
    for (const s of ladder) {
      if (s.archetype === "long_call" || s.archetype === "long_put" || s.archetype === "vertical_spread") {
        s._options_first_boost = true;
      }
      if (s.archetype === "stock_long" || s.archetype === "stock_short") {
        s._options_first_deprioritize = true;
      }
    }
  }

  const ranked = rankByProfile(ladder, profile, { ticker: tickerSym });
  let primary = ranked[0] || null;
  // Lotto is additive for convexity surfaces — do not hijack Options tab primary.
  if (primary && (primary.lotto || String(primary.archetype || "").startsWith("lotto_"))) {
    primary = ranked.find((s) => !s.lotto && !String(s.archetype || "").startsWith("lotto_")) || primary;
  }

  // Also build a per-profile preview so the UI can show "what each profile
  // would do with this setup" — educational on the Today page.
  const ladder_by_profile = {};
  for (const p of RISK_PROFILES) {
    const r = rankByProfile(ladder, p, { ticker: tickerSym });
    ladder_by_profile[p] = r[0]?.archetype || null;
  }

  return {
    contract: {
      ticker: contract.ticker,
      direction,
      contract_direction: contract.contract_direction || direction,
      price,
      price_source: contract.price_source || null,
      sl: Number.isFinite(sl) && sl > 0 ? sl : null,
      tp1: Number.isFinite(tp1) && tp1 > 0 ? tp1 : null,
      tp2: Number.isFinite(tp2) && tp2 > 0 ? tp2 : null,
      tp3: Number.isFinite(tp3) && tp3 > 0 ? tp3 : null,
      invalidation: Array.isArray(contract.invalidation) ? contract.invalidation.slice(0, 4) : [],
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
    direction_alignment: isIndexTrader ? directionalAlignForIndex : null,
    direction_flipped_by_confluence: fadeFlipped,
    target_delta: targetDelta,
    // Moonshot tier metadata — UI uses to surface special treatment.
    moonshot: {
      activated: !!moonshotDecision.activate,
      reason: moonshotDecision.reason || null,
      motion: moonshotDecision.motion || null,
    },
    options_first_recommended: optionsFirstActive,
    ...(() => {
      const setup_guidance = buildOptionsSetupGuidance({
        confluence: verdict,
        contract: { ticker: tickerSym, atr_pct: atrPct, direction },
        directionAlignment: isIndexTrader ? directionalAlignForIndex : null,
        primary,
        moonshot: {
          activated: !!moonshotDecision.activate,
          reason: moonshotDecision.reason || null,
        },
        isInvestorMode,
      });
      const model_disposition = buildOptionsModelDisposition({
        confluence: verdict,
        contractDirection: direction,
        effectiveDirection: playDirection,
        directionFlipped: fadeFlipped,
        directionAlignment: isIndexTrader ? directionalAlignForIndex : null,
        setupGuidance: setup_guidance,
        primary,
        moonshot: {
          activated: !!moonshotDecision.activate,
          reason: moonshotDecision.reason || null,
        },
      });
      return {
        setup_guidance,
        contract_direction: direction,
        effective_direction: playDirection,
        model_disposition,
        model_reconciliation: buildOptionsModelReconciliation({
          contractDirection: contract.contract_direction || direction,
          confluenceSide: verdictSide,
          effectiveDirection: playDirection,
          directionFlipped: fadeFlipped,
          directionAlignment: isIndexTrader ? directionalAlignForIndex : null,
          contract: {
            direction,
            contract_direction: contract.contract_direction || direction,
            sl: Number.isFinite(sl) && sl > 0 ? sl : null,
            tp1: Number.isFinite(tp1) && tp1 > 0 ? tp1 : null,
            tp2: Number.isFinite(tp2) && tp2 > 0 ? tp2 : null,
            tp3: Number.isFinite(tp3) && tp3 > 0 ? tp3 : null,
            price,
            price_source: contract.price_source || null,
          },
        }),
      };
    })(),
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
/**
 * When the swing ladder is empty for an index ETF, attach a 0-1 DTE play
 * built from the trader contract direction + live spot.
 */
export function attachIndexDayTradeFallback(ladder, ctx) {
  if (!ladder || ladder.primary) return ladder;
  const ticker = String(ctx?.ticker || "").toUpperCase();
  if (!isDayTradeTicker(ticker)) return ladder;
  const align = shouldAllowIndexDirectional({
    verdictMode: ctx?.verdict?.mode,
    verdictSide: ctx?.verdict?.side,
    direction: ctx?.direction,
    effectiveDirection: ctx?.direction,
    confluence: ctx?.verdict,
    timingOverlay: ctx?.verdict?.timing,
  });
  if (!align.allow) return ladder;
  const dt = buildDayTradePlay(ctx);
  if (!dt) return ladder;
  const spot = Number(ctx?.price) || 0;
  const strike = Number(dt?.strikes?.primary) || 0;
  const dte = Number(dt?.expiration?.dte ?? ctx?.expiration?.dte);
  const gate = validateDayTradePlay({ spot, strike, expirationDte: dte });
  if (!gate.valid) return ladder;
  return {
    ...ladder,
    primary: dt,
    ladder: [dt, ...(Array.isArray(ladder.ladder) ? ladder.ladder : [])],
    day_trade_fallback: true,
    direction_alignment: align,
  };
}

export function selectStrategy(contract, profile = DEFAULT_RISK_PROFILE) {
  const ladder = buildOptionsLadder(contract, { profile });
  if (!ladder || !ladder.primary) return null;
  return {
    archetype: ladder.primary.archetype,
    rationale: ladder.primary.rationale,
    play: ladder.primary,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// Compact play formatters — shared by Trader/Investor entry notifications
// ═══════════════════════════════════════════════════════════════════════
//
// When a TRADE_ENTRY fires we want the Discord embed AND the email to
// surface the recommended options play alongside the equity entry. Both
// surfaces are bandwidth-constrained (Discord field caps at 1024 chars;
// email should stay scannable), so we use a single normalized shape
// (`compactOptionsPlay`) and two thin renderers — Discord and email.
//
// This is the canonical compact representation; UI / app reads the full
// strategy object (premium, greeks, warnings) instead of this summary.

/**
 * Compose the compact play summary used by entry notifications.
 *
 * @param {object} play  A strategy object from buildOptionsLadder().primary
 * @param {object} [meta] Optional extras: { ticker, mode }
 * @returns {object|null} { archetype, label, headline, lines:[], net_cost_usd,
 *                          breakeven, max_loss_usd, max_gain_usd, legs:[...],
 *                          ticker, mode } or null when play is missing.
 */
export function compactOptionsPlay(play, meta = {}) {
  if (!play || typeof play !== "object") return null;
  const ticker = meta?.ticker || null;
  const mode = String(meta?.mode || "").toLowerCase() || null;

  const legs = Array.isArray(play.legs) ? play.legs.map(l => {
    if (!l) return null;
    if (l.instrument === "STOCK" || l.instrument === "ETF") {
      return {
        kind: "equity",
        action: String(l.action || "").toUpperCase(),
        qty: Number(l.qty) || 0,
        side_label: l.side_label || null,
      };
    }
    return {
      kind: "option",
      action: String(l.action || "").toUpperCase(),
      type: String(l.optionType || "").toUpperCase(),
      strike: Number(l.strike) || null,
      expiration: l.expiration || null,
      qty: Number(l.qty) || 0,
      premium_mid: l.premium_mid != null ? Number(l.premium_mid) : null,
      leg_cost_usd: l.leg_cost_usd != null ? Number(l.leg_cost_usd) : null,
      side_label: l.side_label || null,
    };
  }).filter(Boolean) : [];

  // Net cost (signed): sum of debit legs minus credit legs.
  const netCost = legs.reduce((sum, l) => {
    if (l.kind !== "option") return sum;
    const cost = Number(l.leg_cost_usd) || 0;
    if (!Number.isFinite(cost)) return sum;
    return (l.side_label === "credit") ? sum - cost : sum + cost;
  }, 0);

  const tickerPart = ticker ? `${ticker} ` : "";
  const dteLabel = play.expiration?.label || play.expiration?.iso || null;
  const headline = `${play.label || play.archetype || "Options Play"}${dteLabel ? ` · ${dteLabel}` : ""}`;

  // One-line per leg, e.g. "BUY 2× CALL $260 exp 2027-01-15  @ $12.45 mid (–$2,490)".
  const lines = legs.map(l => {
    if (l.kind === "equity") return `${l.action} ${l.qty} ${ticker || "shares"}`;
    const premPart = l.premium_mid != null ? `@ $${l.premium_mid.toFixed(2)} mid` : "";
    const costPart = l.leg_cost_usd != null
      ? ` (${(l.side_label === "credit" ? "+" : "–")}$${Math.abs(l.leg_cost_usd).toLocaleString()})`
      : "";
    const expPart = l.expiration ? ` exp ${l.expiration}` : "";
    const sidePart = l.side_label ? ` [${l.side_label}]` : "";
    return `${l.action} ${l.qty}× ${l.type} $${l.strike}${expPart}${sidePart}  ${premPart}${costPart}`.trim();
  });

  return {
    ticker,
    mode,
    archetype: play.archetype || null,
    label: play.label || null,
    headline,
    lines,
    rationale: play.rationale || null,
    legs,
    net_cost_usd: Number.isFinite(netCost) ? Math.round(netCost) : null,
    net_side: netCost >= 0 ? "debit" : "credit",
    max_loss_usd: (play.max_loss_usd != null && Number.isFinite(Number(play.max_loss_usd))) ? Math.round(Number(play.max_loss_usd)) : null,
    /* 2026-06-02 — CRITICAL: must check `!= null` BEFORE Number(...).
       Number(null) === 0, so the prior code converted nulls to 0 and
       the Discord embed surfaced "Max gain at target: $0" even when
       the builder explicitly returned null because TP < breakeven.
       Caused operator confusion on the SPY long-call alert. */
    max_gain_usd: (play.max_gain_usd != null && Number.isFinite(Number(play.max_gain_usd))) ? Math.round(Number(play.max_gain_usd)) : null,
    breakeven: (play.breakeven != null && Number.isFinite(Number(play.breakeven))) ? Number(play.breakeven) : null,
    expiration: play.expiration || null,
    /* Live-trade exit projections — what the option is actually
       worth when the underlying trade hits TP or SL. Use these
       instead of the misleading "Max gain at target" for single-
       leg long calls/puts. See estimateOptionAtTargetPrice. */
    target_clears_breakeven: play.target_clears_breakeven ?? null,
    est_at_tp: play.est_at_tp || null,
    est_at_sl: play.est_at_sl || null,
    // LEAP-specific extras (no-op for other archetypes).
    shares_equivalent: Number.isFinite(Number(play.shares_equivalent)) ? Number(play.shares_equivalent) : null,
    capital_efficiency: Number.isFinite(Number(play.capital_efficiency)) ? Number(play.capital_efficiency) : null,
  };
}

/**
 * Render a compact Discord embed field for an options play.
 * Returns null if the play is missing or empty. Always returns a single
 * field (`inline: false`) under Discord's 1024-char value cap.
 *
 * @param {object} compact  Output of compactOptionsPlay()
 * @returns {{name:string, value:string, inline:false}|null}
 */
export function optionsPlayDiscordField(compact) {
  if (!compact || !Array.isArray(compact.lines) || compact.lines.length === 0) return null;
  const dollar = (n) => n == null ? null : `$${Math.abs(Math.round(n)).toLocaleString()}`;
  const signedDollar = (n) => n == null ? null : `${n >= 0 ? "+" : "-"}$${Math.abs(Math.round(n)).toLocaleString()}`;
  const metricsParts = [];
  if (compact.net_cost_usd != null) {
    const sign = compact.net_side === "credit" ? "+" : "–";
    metricsParts.push(`Net ${compact.net_side}: ${sign}${dollar(compact.net_cost_usd)}`);
  }
  if (compact.breakeven != null) metricsParts.push(`Breakeven: $${compact.breakeven.toFixed(2)}`);
  /* 2026-06-02 — Live-trade exit projections take priority over the
     hold-to-expiration "Max gain at target" because the user never
     holds to expiration. Operator feedback: "we would look to exit
     with profit or at our stop loss. The option premium is unknown
     at those junctures but I doubt we let this go to zero or not
     take profit." */
  const liveExitParts = [];
  if (compact.est_at_tp && compact.est_at_tp.total_pl_usd != null) {
    liveExitParts.push(`If TP hit (~${compact.est_at_tp.hold_days}d): est. P&L ${signedDollar(compact.est_at_tp.total_pl_usd)} (premium ≈ $${compact.est_at_tp.est_premium.toFixed(2)})`);
  }
  if (compact.est_at_sl && compact.est_at_sl.total_pl_usd != null) {
    liveExitParts.push(`If SL hit (~${compact.est_at_sl.hold_days}d): est. P&L ${signedDollar(compact.est_at_sl.total_pl_usd)} (premium ≈ $${compact.est_at_sl.est_premium.toFixed(2)})`);
  }
  /* "Max loss" now qualified as expiration-only (the actual exit happens
     at TP or SL, where the option still has time value). */
  if (compact.max_loss_usd != null) metricsParts.push(`Max loss (if held to exp): ${dollar(compact.max_loss_usd)}`);
  if (compact.max_gain_usd != null) metricsParts.push(`Max gain at expiration: ${dollar(compact.max_gain_usd)}`);
  // LEAP-specific capital-efficiency hint.
  if (compact.shares_equivalent && compact.capital_efficiency) {
    metricsParts.push(`Synthetic: ~${compact.shares_equivalent} share-equiv · ${compact.capital_efficiency.toFixed(1)}× capital efficient`);
  }

  let value = `**${compact.headline}**\n` + compact.lines.map(l => `• ${l}`).join("\n");
  if (liveExitParts.length) value += `\n\n📍 **Live exit projections**\n` + liveExitParts.map(l => `• ${l}`).join("\n");
  /* Warn loudly when the TP is below the option breakeven — that's
     a sign the chosen strike is too far OTM for this trade plan. */
  if (compact.target_clears_breakeven === false) {
    value += `\n\n⚠️ TP below breakeven — consider deeper-ITM strike or smaller premium`;
  }
  if (metricsParts.length) value += `\n\n${metricsParts.join(" · ")}`;
  if (compact.rationale) {
    // Truncate rationale so we stay within Discord's 1024-char field cap.
    const remaining = 1024 - value.length - 4;
    if (remaining > 60) {
      const trimmed = compact.rationale.length > remaining
        ? compact.rationale.slice(0, remaining - 1).trimEnd() + "…"
        : compact.rationale;
      value += `\n\n_${trimmed}_`;
    }
  }
  if (value.length > 1024) value = value.slice(0, 1020).trimEnd() + "…";
  const isLeap = compact.archetype === "leap_call" || compact.archetype === "leap_put";
  const icon = isLeap ? "🪜" : "🎯";
  return {
    name: `${icon} Options Play (${compact.mode === "investor" ? "Investor LEAP" : "Trader"})`,
    value,
    inline: false,
  };
}

/**
 * Render an HTML section for an options play in trade-alert emails.
 * Returns null if the play is missing or empty. The caller is responsible
 * for wrapping in the section card; we just return inner HTML.
 *
 * @param {object} compact  Output of compactOptionsPlay()
 * @returns {string|null}  HTML or null
 */
export function optionsPlayEmailHtml(compact) {
  if (!compact || !Array.isArray(compact.lines) || compact.lines.length === 0) return null;
  const _esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const dollar = (n) => n == null ? null : `$${Math.abs(Math.round(n)).toLocaleString()}`;

  const legsHtml = compact.lines.map(l => `<li style="margin:0 0 4px;color:rgba(255,255,255,0.85);font-size:12px;font-family:Menlo,Monaco,monospace">${_esc(l)}</li>`).join("");
  const metricsParts = [];
  const signedDollar = (n) => n == null ? null : `${n >= 0 ? "+" : "-"}$${Math.abs(Math.round(n)).toLocaleString()}`;
  if (compact.net_cost_usd != null) {
    const sign = compact.net_side === "credit" ? "+" : "–";
    metricsParts.push(`Net ${compact.net_side}: <strong style="color:white">${sign}${dollar(compact.net_cost_usd)}</strong>`);
  }
  if (compact.breakeven != null) metricsParts.push(`Breakeven: <strong style="color:white">$${compact.breakeven.toFixed(2)}</strong>`);
  if (compact.max_loss_usd != null) metricsParts.push(`Max loss (if held to exp): <strong style="color:#f43f5e">${dollar(compact.max_loss_usd)}</strong>`);
  if (compact.max_gain_usd != null) metricsParts.push(`Max gain at expiration: <strong style="color:#10b981">${dollar(compact.max_gain_usd)}</strong>`);
  if (compact.shares_equivalent && compact.capital_efficiency) {
    metricsParts.push(`Synthetic: <strong style="color:white">~${compact.shares_equivalent} share-equiv</strong>, <strong style="color:white">${compact.capital_efficiency.toFixed(1)}×</strong> capital efficient`);
  }
  const metricsHtml = metricsParts.length
    ? `<div style="margin:10px 0 0;color:rgba(255,255,255,0.85);font-size:12px;line-height:1.5">${metricsParts.join("<br>")}</div>`
    : "";

  /* 2026-06-02 — Live-trade exit projections (BS at reduced DTE for
     the moment the underlying hits TP/SL). Shows up before the
     hold-to-expiration metrics because that's how the user actually
     exits the trade. */
  const liveExitParts = [];
  if (compact.est_at_tp && compact.est_at_tp.total_pl_usd != null) {
    const plColor = compact.est_at_tp.total_pl_usd >= 0 ? "#10b981" : "#f43f5e";
    liveExitParts.push(`If TP hit (~${compact.est_at_tp.hold_days}d): est. P&L <strong style="color:${plColor}">${signedDollar(compact.est_at_tp.total_pl_usd)}</strong> &middot; premium ≈ $${compact.est_at_tp.est_premium.toFixed(2)}`);
  }
  if (compact.est_at_sl && compact.est_at_sl.total_pl_usd != null) {
    const plColor = compact.est_at_sl.total_pl_usd >= 0 ? "#10b981" : "#f43f5e";
    liveExitParts.push(`If SL hit (~${compact.est_at_sl.hold_days}d): est. P&L <strong style="color:${plColor}">${signedDollar(compact.est_at_sl.total_pl_usd)}</strong> &middot; premium ≈ $${compact.est_at_sl.est_premium.toFixed(2)}`);
  }
  const liveExitHtml = liveExitParts.length
    ? `<div style="margin:10px 0 0;padding:8px 10px;background:rgba(56,189,248,0.08);border-left:3px solid #38bdf8;border-radius:4px"><div style="color:#38bdf8;font-size:11px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;margin-bottom:4px">Live Exit Projections</div><div style="color:rgba(255,255,255,0.85);font-size:12px;line-height:1.6">${liveExitParts.join("<br>")}</div></div>`
    : "";
  const warnHtml = compact.target_clears_breakeven === false
    ? `<div style="margin:8px 0 0;padding:6px 10px;background:rgba(251,191,36,0.10);border-left:3px solid #fbbf24;color:#fcd34d;font-size:12px">⚠️ TP below breakeven — consider deeper-ITM strike or smaller premium</div>`
    : "";

  const rationaleHtml = compact.rationale
    ? `<div style="margin:10px 0 0;color:rgba(255,255,255,0.65);font-size:12px;line-height:1.5;font-style:italic">${_esc(compact.rationale)}</div>`
    : "";

  return `
    <div style="margin:0 0 6px;color:white;font-size:13px;font-weight:600">${_esc(compact.headline)}</div>
    <ul style="margin:0;padding:0 0 0 18px;list-style:none">${legsHtml}</ul>
    ${liveExitHtml}
    ${warnHtml}
    ${metricsHtml}
    ${rationaleHtml}
  `;
}
