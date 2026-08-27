// worker/letf-vehicles.js
// Leveraged ETF vehicle layer — quote symbols, horizon-aware picker, decay scoring.
//
// Doctrine (daily-reset LETFs):
//   • Trending days: leverage compounds WITH the move (ride SPY July uptrend).
//   • Chop / mean-revert: +1% / −1% / +1% leaves the LETF net-negative (vol drag).
//   • Day trades: tight plan, 3× often enough; exit same session.
//   • Swing trend (days–weeks): 4× SPYU/SPXU when FSD + RIDE align; trim on
//     exhaustion, DCA back on compression — not a buy-and-hold forever hold.
//   • Signal always on the UNDERLYING (SPY, AAPL); LETF is the expression vehicle.

/** Quote-only symbols for timed:prices — NOT scored in the HTF/LTF universe. */
export const EXECUTION_LETF_SYMBOLS = Object.freeze([
  // S&P 500
  "SPYU", "SPXL", "SPXU", "SPXS",
  // Nasdaq-100
  "TQQQ", "SQQQ",
  // Russell / Dow
  "TNA", "TZA", "UDOW", "SDOW",
  // Sectors / themes (ladder + play-the-move)
  "TECL", "TECS", "FAS", "FAZ", "ERX", "ERY", "CURE", "DUSL", "LABU", "LABD",
  "DPST", "YINN", "YANG", "SOXL", "SOXS", "BITX", "BITI", "BTCL", "BTCZ",
  "UVXY", "SVXY", "VIXY", "TMF", "TMV",
  // Single-name LETFs (SINGLE_NAME_LETF map)
  "AMDL", "NVDU", "NVDD", "NVDL", "TSLL", "TSLZ", "TSLT", "TSLQ", "TSLS",
  "AAPU", "AAPD", "AMZU", "AMZD", "MSFU", "MSFD", "GGLL", "GGLS", "METU", "METD",
  "NFXL", "NFXS", "LLYX", "CONL", "MSTU", "MSTZ", "MSTX", "SMST", "TSMU", "AEHG",
]);

/** Passive / trend-rider profile: LETF + shares only (no options complexity). */
export const TREND_LETF_PLAY_PREFS = Object.freeze({
  allowed_vehicles: ["letf", "shares"],
});

/** Active trader: all three vehicles. */
export const DEFAULT_PLAY_PREFS = Object.freeze({
  allowed_vehicles: ["shares", "letf", "options"],
});

const LETF_FACTOR_OVERRIDES = Object.freeze({
  SPYU: 4,
});

export function getLetfFactor(letfTicker, letfEntry = null) {
  const sym = String(letfTicker || "").toUpperCase();
  if (LETF_FACTOR_OVERRIDES[sym]) return LETF_FACTOR_OVERRIDES[sym];
  return Number(letfEntry?.factor) || 2;
}

/**
 * Horizon for LETF expression:
 *   day_trade     — same-session scalp; prefer 3× (less whipsaw than 4× intraday)
 *   swing_trend   — multi-day trend ride; 4× alts when macro/trend align
 *   avoid_chop    — compression / WAIT chop; LETF decay dominates
 */
export function resolveLetfHorizon({
  holdIntent,
  confluenceMode,
  timingOverlay,
  expectedMovePct,
  dayTradeContext = false,
} = {}) {
  if (dayTradeContext) return "day_trade";

  const mode = String(confluenceMode || "").toUpperCase();
  const hold = String(holdIntent || "SWING").toUpperCase();
  const timing = timingOverlay || {};
  const compressions = Number(timing.compression_score) || 0;
  const extension = Number(timing.extension_score) || 0;
  const chop = mode === "WAIT"
    && compressions >= 50
    && !timing.call_opportunity
    && !timing.put_opportunity
    && !timing.add_on_dips;

  if (chop) return "avoid_chop";

  if (mode === "RIDE" || mode === "DRIFT") return "swing_trend";
  if (mode === "FADE" && (timing.put_opportunity || timing.short_opportunity)) return "swing_trend";
  if (hold === "POSITION" || hold === "SWING") {
    if (expectedMovePct != null && Math.abs(expectedMovePct) >= 4) return "swing_trend";
  }
  if (mode === "READY") return "day_trade";
  return "swing_trend";
}

/** Prefer 4× alts on swing trends; 3× primary on fast day-trade expressions. */
export function pickPreferredLetfTicker(letfEntry, direction, opts = null) {
  if (!letfEntry) return null;
  const sideKey = direction === "SHORT" ? "short" : "long";
  const primary = letfEntry[sideKey];
  if (!primary) return null;

  const fsdMacro = opts && typeof opts === "object" && !Array.isArray(opts)
    ? (opts.fsdMacro ?? opts.fsd_macro ?? null)
    : null;
  const horizon = opts?.horizon || null;
  const timing = opts?.timing || opts?.timingOverlay || null;

  const longAlts = Array.isArray(letfEntry.long_alts) ? letfEntry.long_alts : [];
  const shortAlts = Array.isArray(letfEntry.short_alts) ? letfEntry.short_alts : [];

  if (direction === "LONG") {
    if (horizon === "day_trade") return primary;
    const rallyWindow = !!fsdMacro?.rally_active
      || timing?.signals?.includes?.("fsd_rally_window")
      || timing?.signals?.includes?.("fsd_rally_dip_buy");
    if ((horizon === "swing_trend" || rallyWindow) && longAlts.includes("SPYU")) return "SPYU";
    if (longAlts.includes("SPYU") && fsdMacro?.rally_active) return "SPYU";
    return primary;
  }

  // SHORT — inverse LETF (buy bear fund, not short stock)
  if (horizon === "day_trade") return primary;
  const bearTrend = !!timing?.put_opportunity
    || !!timing?.short_opportunity
    || timing?.signals?.includes?.("fsd_rally_dip_buy") === false && fsdMacro?.rally_active === false;
  const extensionExhaust = Number(timing?.extension_score) >= 52;
  if ((horizon === "swing_trend" || extensionExhaust || bearTrend) && shortAlts.includes("SPXU")) {
    return "SPXU";
  }
  if (shortAlts.includes("SPXU") && extensionExhaust) return "SPXU";
  return primary;
}

/**
 * Score 0–100 for LETF vs shares/options. Decay-aware: penalize chop, boost
 * aligned trends + FSD macro windows.
 */
export function scoreLetfSuitability({
  direction,
  letfEntry,
  letfTicker,
  tickerData = {},
  confluence = null,
  fsdMacro = null,
  expectedMovePct = null,
  holdIntent = null,
  dayTradeContext = false,
  passiveProfile = false,
} = {}) {
  if (!letfEntry || !letfTicker) return { score: 0, reasons: ["no_mapped_letf"], horizon: null };

  const timing = confluence?.timing || tickerData?.timing_overlay || {};
  const mode = String(confluence?.mode || tickerData?.confluence_verdict?.mode || "").toUpperCase();
  const hold = String(holdIntent || tickerData?.hold_intent || tickerData?.horizon_bucket || "SWING").toUpperCase();
  const horizon = resolveLetfHorizon({
    holdIntent: hold,
    confluenceMode: mode,
    timingOverlay: timing,
    expectedMovePct,
    dayTradeContext,
  });

  if (horizon === "avoid_chop") {
    return {
      score: 22,
      horizon,
      reasons: ["chop/compression regime — daily-reset decay dominates; prefer shares or defined-risk options"],
    };
  }

  const factor = getLetfFactor(letfTicker, letfEntry);
  let score = passiveProfile ? 62 : 48;
  const reasons = [`${factor}× via ${letfTicker} (${letfEntry.note || "leveraged ETF"})`];

  const htf = Number(tickerData?.htf_score) || 0;
  const aligned = String(tickerData?.state || "") === (direction === "LONG" ? "HTF_BULL_LTF_BULL" : "HTF_BEAR_LTF_BEAR");
  if (Math.abs(htf) >= 12 && aligned) {
    score += 14;
    reasons.push("aligned HTF/LTF trend — daily reset compounds with the move");
  }

  if (mode === "RIDE" || mode === "DRIFT") {
    score += 12;
    reasons.push(`${mode} mode — trend in motion; LETF fits ride-and-trim`);
  }

  if (fsdMacro?.rally_active && direction === "LONG") {
    score += 10;
    reasons.push("macro rally window — index LETF expresses desk upside thesis");
  }
  if (direction === "SHORT" && (timing.put_opportunity || timing.short_opportunity)) {
    score += 10;
    reasons.push("extension/exhaustion stack — inverse LETF for faster downside capture");
  }

  if (horizon === "swing_trend") {
    score += 8;
    reasons.push("swing-trend horizon (days–weeks) — trim on strength, add on compression");
  }
  if (horizon === "day_trade") {
    score += 6;
    reasons.push("day-trade horizon — same-session plan; exit before overnight decay");
  }

  if (expectedMovePct != null && Math.abs(expectedMovePct) >= 6) {
    score += 6;
    reasons.push(`expected move ${expectedMovePct}% — leverage amplifies the target path`);
  } else if (expectedMovePct != null && Math.abs(expectedMovePct) < 2.5) {
    score -= 12;
    reasons.push("small expected move — leverage noise may exceed edge");
  }

  if (hold === "POSITION") {
    score -= 8;
    reasons.push("position hold — prefer unleveraged shares or LEAPs for multi-month carry");
  }

  if (passiveProfile) {
    score += 15;
    reasons.push("passive/trend profile — LETF preferred over options Greeks");
  }

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    horizon,
    reasons,
    letf_ticker: letfTicker,
    factor,
  };
}

export function resolvePlayPrefs(input = {}) {
  if (input.playPrefs?.allowed_vehicles) return input.playPrefs;
  if (input.prefs?.allowed_vehicles) return input.prefs;
  // Explicit passive/trend profile only — never strip options from investor mode globally.
  if (input.passiveLetf || input.trendLetfOnly) {
    return TREND_LETF_PLAY_PREFS;
  }
  return DEFAULT_PLAY_PREFS;
}
