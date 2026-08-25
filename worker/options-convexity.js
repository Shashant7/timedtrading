// worker/options-convexity.js — Lotto / Moonshot convexity plays (2026-06-15)
//
// Single alignment contract for:
//   GET /timed/options/convexity  (Today universe row)
//   GET /timed/options/ticker     (Snapshot panel via convexity block)
//
// Failed gates omit the play — no suppressed[] list exposed.

import {
  validateDayTradePlay,
  isDayTradeTicker,
  pickDayTradeExpiration,
  resolveContractDirection,
  bindChainLegForStrike,
  estimatePremium,
} from "./options-plays.js";

export const CONVEXITY_LOTTO_MAX_LOSS_DEFAULT_USD = 50;
export const CONVEXITY_FRESH_TTL_MS_01_DTE = 5 * 60 * 1000;
export const CONVEXITY_FRESH_TTL_MS_SWING = 15 * 60 * 1000;
export const CONVEXITY_SWING_MAX_DRIFT_PCT = 0.05;
// Earnings-prep lottos buy a ~0.15-delta strike into a binary print. On
// higher-priced or higher-IV names that lands further OTM than a regular
// swing lotto (e.g. INTU 3-DTE 0.15-delta put ≈ 6.5% OTM into an AMC print),
// so the swing drift ceiling would silently filter a valid earnings play.
export const CONVEXITY_EARNINGS_MAX_DRIFT_PCT = 0.15;

const MOONSHOT_ARCH = new Set(["moonshot_call", "moonshot_put"]);
const LOTTO_ARCH = new Set(["lotto_call", "lotto_put"]);

export function playClassFromArchetype(archetype) {
  const a = String(archetype || "").toLowerCase();
  if (MOONSHOT_ARCH.has(a)) return "moonshot";
  if (LOTTO_ARCH.has(a)) return "lotto";
  return null;
}

export function convexityFreshTtlMs(dte) {
  const d = Number(dte);
  if (Number.isFinite(d) && d <= 1) return CONVEXITY_FRESH_TTL_MS_01_DTE;
  return CONVEXITY_FRESH_TTL_MS_SWING;
}

/** Pick best convexity leg from a built ladder (moonshot beats lotto). */
export function extractConvexityPlayFromLadder(ladderResult) {
  if (!ladderResult || typeof ladderResult !== "object") return null;
  const list = Array.isArray(ladderResult.ladder) ? ladderResult.ladder : [];
  const moon = list.find((p) => p?._moonshot_active || MOONSHOT_ARCH.has(String(p?.archetype || "")));
  if (moon) return { play: moon, play_class: "moonshot" };
  const lotto = list.find((p) => p?._lotto_active || LOTTO_ARCH.has(String(p?.archetype || "")));
  if (lotto) return { play: lotto, play_class: "lotto" };
  const prim = ladderResult.primary;
  const pc = playClassFromArchetype(prim?.archetype);
  if (pc && prim) return { play: prim, play_class: pc };
  return null;
}

function resolvePlayDirection(play, contractDir) {
  const arch = String(play?.archetype || "").toLowerCase();
  if (arch.includes("put")) return "SHORT";
  if (arch.includes("call")) return "LONG";
  return String(contractDir || "").toUpperCase() || null;
}

function timingLean(confluence) {
  const t = confluence?.timing || {};
  if (t.call_opportunity) return "LONG";
  if (t.put_opportunity) return "SHORT";
  return null;
}

function floorHeld({ spot, sl, direction }) {
  const px = Number(spot);
  const stop = Number(sl);
  const d = String(direction || "").toUpperCase();
  if (!(px > 0) || !(stop > 0)) return false;
  if (d === "LONG") return px >= stop;
  if (d === "SHORT") return px <= stop;
  return false;
}

/**
 * Shared gate — returns false when play must not surface (no reason exposed).
 */
export function isConvexityPlayActionable({
  play,
  play_class: playClassIn,
  confluence,
  contract,
  spot,
  chain_status: chainStatus,
  as_of_ms: asOfMs,
  now = Date.now(),
} = {}) {
  if (!play || typeof play !== "object") return false;
  const playClass = playClassIn || playClassFromArchetype(play.archetype);
  if (!playClass) return false;
  // Earnings-prep lottos are a distinct product: a deliberately cheap OTM
  // gamma bet into a binary print. They (a) legitimately oppose the base
  // contract direction when the read is a FADE (a put on a name whose base
  // contract is LONG), and (b) sit further OTM than a regular swing lotto.
  // Both are relaxed below, gated on this flag, so the same-day / 1-5d
  // earnings-prep card is not silently filtered by swing-lotto constraints.
  const earnPrep = playClass === "lotto" && !!play._earnings_prep;

  const mode = String(confluence?.mode || "").toUpperCase();
  if (playClass === "lotto") {
    const lottoModes = earnPrep
      ? ["READY", "RIDE", "DRIFT", "WAIT", "FADE"]
      : ["READY", "RIDE", "DRIFT"];
    if (!lottoModes.includes(mode)) return false;
    if (mode === "READY" || mode === "FADE" || (earnPrep && mode === "WAIT")) {
      const side = String(confluence?.side || contract?.direction || "").toUpperCase();
      const timing = timingLean(confluence);
      const floor = floorHeld({
        spot: spot ?? contract?.price,
        sl: contract?.sl,
        direction: side,
      });
      if (mode === "WAIT" && !floor && !play._h4_close_pending) return false;
      if ((mode === "READY" || mode === "FADE") && !floor && timing !== side) return false;
    }
  } else if (playClass === "moonshot") {
    if (!["RIDE", "DRIFT"].includes(mode) && !(play._moonshot_active && mode === "RIDE")) {
      if (mode !== "RIDE" && mode !== "DRIFT") return false;
    }
  }

  // For an earnings-prep FADE, the play intentionally trades the fade side
  // (a put on a bullish base contract). Anchor the alignment check to the
  // confluence side in that case so the fade is not rejected as "opposed" —
  // the play direction is still required to match the confluence + timing
  // lean below, so a genuinely mis-built play is still caught.
  const contractDir = (earnPrep && confluence?.side
    && String(confluence.side).toUpperCase() !== "NEUTRAL")
    ? String(confluence.side).toUpperCase()
    : (resolveContractDirection(contract?.direction, contract?.effective_direction)
      || String(confluence?.side || "").toUpperCase());
  const playDir = resolvePlayDirection(play, contractDir);
  if (playDir && contractDir && playDir !== contractDir) return false;

  const lean = timingLean(confluence);
  if (lean && playDir && lean !== playDir) return false;

  const dte = Number(play?.expiration?.dte);
  const strike = Number(play?.strikes?.primary ?? play?.legs?.[0]?.strike);
  const px = Number(spot ?? contract?.price);
  if (!(px > 0) || !(strike > 0)) return false;

  // Convexity lotto/moonshot is a swing/event debit. 0 DTE belongs on
  // the Index Day-Trade strip (SPY/QQQ/IWM/DIA), not this row.
  if (Number.isFinite(dte) && dte < 1) return false;

  if (Number.isFinite(dte) && dte <= 1) {
    const gate = validateDayTradePlay({
      spot: px,
      strike,
      expirationDte: dte,
      atrPct: contract?.atr_pct ?? contract?.atrPct,
      now,
    });
    if (!gate.valid) return false;
  } else {
    const drift = Math.abs(strike - px) / px;
    const maxDrift = earnPrep ? CONVEXITY_EARNINGS_MAX_DRIFT_PCT : CONVEXITY_SWING_MAX_DRIFT_PCT;
    if (drift > maxDrift) return false;
  }

  const ts = Number(asOfMs ?? now);
  if (Number.isFinite(dte)) {
    if (now - ts > convexityFreshTtlMs(dte)) return false;
  }

  if (String(chainStatus || "").startsWith("exception")) return false;

  const maxLoss = Number(play.max_loss_usd);
  if (!(maxLoss > 0)) return false;

  return true;
}

const SHOT_REASON_MAX = 140;

function firstThemeName(themes) {
  if (!Array.isArray(themes) || !themes.length) return null;
  const t = themes[0];
  if (typeof t === "string" && t.trim()) return t.trim();
  if (t && typeof t === "object") {
    const name = t.name || t.label || t.theme;
    if (name) return String(name).trim();
  }
  return null;
}

function clipShotReason(s) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  if (t.length <= SHOT_REASON_MAX) return t;
  return `${t.slice(0, SHOT_REASON_MAX - 1).replace(/\s+\S*$/, "")}…`;
}

/**
 * One-line hook for why a lotto/moonshot is on the board — earnings,
 * floor + compression, SuperTrend hold, theme. Never "you/your".
 */
export function buildConvexityShotReason({
  play,
  play_class: playClassIn,
  confluence,
  contract,
  spot,
  themes,
  earnings_play: earningsPlay,
} = {}) {
  const h4Pending = !!(play?._h4_close_pending || contract?.h4_close_pending);
  if (h4Pending) {
    return clipShotReason(
      "4H still open — SuperTrend flip or hold confirms after the 1:30 PM ET close.",
    );
  }
  if (earningsPlay?.catalyst) return clipShotReason(earningsPlay.catalyst);

  const playClass = playClassIn || playClassFromArchetype(play?.archetype);
  if (play?._earnings_prep) {
    const d = Number(
      play.earnings_dte
      ?? contract?.earnings_dte
      ?? contract?.days_to_earnings
      ?? earningsPlay?.days_to_print,
    );
    const sess = String(
      play._earnings_session
      ?? contract?.earnings_hour
      ?? contract?.earnings_session
      ?? earningsPlay?.report_session
      ?? "",
    ).toUpperCase();
    if (d === 0) {
      return clipShotReason(
        `Earnings today${sess === "AMC" ? " AMC" : ""} — cheap OTM into the print, not a share entry.`,
      );
    }
    return Number.isFinite(d)
      ? `Earnings in ${d}d — cheap OTM into the print, not a share entry.`
      : "Earnings-prep — cheap OTM into the print, not a share entry.";
  }

  const dir = resolvePlayDirection(play, contract?.direction || confluence?.side);
  const sideWord = dir === "SHORT" ? "short" : dir === "LONG" ? "long" : "";
  const mode = String(confluence?.mode || "").toUpperCase();
  const timing = confluence?.timing || {};
  const floor = floorHeld({
    spot: spot ?? contract?.price,
    sl: contract?.sl,
    direction: dir,
  });
  const hooks = [];

  if (mode === "RIDE") hooks.push(`Tape is in motion (${mode}${sideWord ? ` ${sideWord}` : ""})`);
  else if (mode === "READY") hooks.push(`Setup is READY${sideWord ? ` ${sideWord}` : ""}`);
  else if (mode === "DRIFT") hooks.push("Late drift — SuperTrend still sloped");

  if (floor) hooks.push("floor held");
  if (dir === "LONG" && timing.call_opportunity) hooks.push("call compression");
  else if (dir === "SHORT" && timing.put_opportunity) hooks.push("put extension");

  const hold = confluence?.st_hold;
  if (hold?.held) {
    hooks.push(hold.tf ? `${hold.tf} SuperTrend held` : "SuperTrend held");
  }

  const layers = Number(confluence?.layers_agreeing);
  if (Number.isFinite(layers) && layers > 0) hooks.push(`${layers}/8 layers`);

  const themeName = firstThemeName(themes);
  if (themeName) hooks.push(themeName);

  if (hooks.length === 0) {
    return playClass === "moonshot"
      ? "Gamma window — direction and momentum lined up."
      : "Direction, floor, and timing aligned — cheap OTM if the move fires.";
  }
  if (hooks.length === 1) return clipShotReason(`${hooks[0]}.`);
  return clipShotReason(`${hooks[0]} — ${hooks.slice(1).join(", ")}.`);
}

const EXP_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Short expiry bit matching index day-trade cards (`Aug 24`). */
export function formatConvexityExpShort(exp) {
  const iso = String(exp?.iso || "").slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    const parts = iso.split("-").map(Number);
    return `${EXP_MONTHS[parts[1] - 1]} ${parts[2]}`;
  }
  const label = String(exp?.label || "").trim();
  const m = label.match(/^([A-Za-z]{3}\s+\d{1,2})/);
  if (m) return m[1];
  if (/^\d+\s*DTE$/i.test(label)) return "";
  return label.replace(/\s*\(\d+\s*DTE\)/i, "").trim();
}

/**
 * Day-trade strip grammar for a convexity card (chips / punch / scan).
 * READY or RIDE → BUY. Earnings-prep FADE → BUY (put at a local top)
 * unless the first RTH 4H is still open (same-day AMC confirm).
 */
export function convexityPlanCopy(card = {}) {
  const ticker = String(card.ticker || "").toUpperCase();
  const isMoon = card.play_class === "moonshot";
  const dir = String(card.direction || "").toUpperCase();
  const flavor = dir === "SHORT" ? "put" : "call";
  const strike = Number(card.strike);
  const dte = Number(card.expiration?.dte);
  const mode = String(card.confluence_mode || "").toUpperCase();
  const fadeBuy = !!card.earnings_prep && mode === "FADE";
  const action = card.h4_close_pending
    ? "WAIT"
    : ((mode === "READY" || mode === "RIDE" || fadeBuy) ? "BUY" : "WAIT");
  const expShort = formatConvexityExpShort(card.expiration);
  const contractBit = Number.isFinite(strike) && strike > 0
    ? `${Math.round(strike)}${flavor === "put" ? "P" : "C"}`
    : "";
  const dteBit = Number.isFinite(dte) ? `${dte}DTE` : "";
  const playWord = card.earnings_prep ? "earnings-prep lotto" : (isMoon ? "moonshot" : "lotto");
  const punchCore = [action, "on", ticker, contractBit, expShort, dteBit ? `(${dteBit})` : ""]
    .filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  const punch = `${punchCore} — ${playWord} ${flavor}, premium may go to zero`;
  const scan = [
    Number.isFinite(Number(card.max_loss_usd)) ? `Risk $${Number(card.max_loss_usd)}` : null,
    Number.isFinite(Number(card.top_target_underlying))
      ? `3x+ @ $${Number(card.top_target_underlying).toFixed(2)}` : null,
    Number.isFinite(Number(card.premium_mid))
      ? `Pay \u2264 $${Number(card.premium_mid).toFixed(2)}` : null,
    expShort || null,
    dteBit || null,
  ].filter(Boolean).join(" \u00b7 ");
  return { action, flavor, punch, scan, playWord, expShort, contractBit };
}

/** API card shape for Today row + Snapshot panel. */
export function toConvexityCard({
  ticker,
  play,
  play_class: playClassIn,
  confluence,
  contract,
  spot,
  chain_status: chainStatus,
  as_of_ms: asOfMs,
  themes,
  earnings_play: earningsPlay,
} = {}) {
  if (!play) return null;
  const playClass = playClassIn || playClassFromArchetype(play.archetype);
  if (!playClass) return null;
  const strike = Number(play?.strikes?.primary ?? play?.legs?.[0]?.strike);
  const prem = Number(play?.premium?.mid ?? play?.legs?.[0]?.premium_mid);
  const dir = resolvePlayDirection(play, contract?.direction);
  const mbt = play.multi_bagger_targets || {};
  const topTarget = playClass === "lotto"
    ? (mbt["3x_underlying_at"] ?? mbt["2x_underlying_at"])
    : (mbt["3x_underlying_at"] ?? mbt["5x_underlying_at"]);
  const sl = Number(contract?.sl);

  const card = {
    ticker: String(ticker || "").toUpperCase(),
    play_class: playClass,
    direction: dir,
    archetype: play.archetype,
    strike,
    expiration: play.expiration || null,
    premium_mid: Number.isFinite(prem) ? prem : null,
    max_loss_usd: Number(play.max_loss_usd) || null,
    multi_bagger_targets: mbt,
    top_target_underlying: Number.isFinite(Number(topTarget)) ? Number(topTarget) : null,
    confluence_mode: confluence?.mode || null,
    confluence_score: Number(confluence?.score) || null,
    stop_level: Number.isFinite(sl) && sl > 0 ? sl : null,
    chain_status: chainStatus && !String(chainStatus).includes("not_attempted")
      && !String(chainStatus).startsWith("exception") ? "live" : "estimated",
    as_of_ms: Number(asOfMs) || Date.now(),
    label: play.label || null,
    earnings_prep: !!play._earnings_prep,
    h4_close_pending: !!play._h4_close_pending,
    earnings_session: play._earnings_session || contract?.earnings_hour || null,
    rationale_short: play._earnings_prep
      ? (play._h4_close_pending
        ? "Earnings today AMC — wait for the 1:30 PM ET 4H close before the lotto."
        : "Earnings-prep lotto — cheap OTM into the print; IV crush risk; not a share entry.")
      : playClass === "lotto"
        ? "Short-dated OTM — sized for total premium loss; 3×+ if the move fires."
        : "Gamma window — multi-bagger target if momentum continues.",
    shot_reason: buildConvexityShotReason({
      play,
      play_class: playClass,
      confluence,
      contract,
      spot,
      themes,
      earnings_play: earningsPlay,
    }),
  };
  const copy = convexityPlanCopy(card);
  card.headline = copy.punch;
  card.scan_line = copy.scan;
  card.action = copy.action;
  return card;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Overlay a live chain mid on a convexity card — replaces Black-Scholes
 * estimates that understate earnings IV (e.g. INTU 345P ~$9 vs ~$0.9 BS).
 */
export function overlayConvexityCardPremium(card, chain, ctx = {}) {
  if (!card || !chain?.ok) return card;
  const strike = num(card.strike);
  if (!(strike > 0)) return card;
  const dir = String(card.direction || "").toUpperCase();
  const side = dir === "SHORT" ? "P" : "C";
  const leg = bindChainLegForStrike(chain, side, strike);
  const spot = num(ctx.spot) ?? num(chain.underlying_price);
  const dte = num(card.expiration?.dte);
  const atrPct = num(ctx.atrPct);
  const est = estimatePremium({
    price: spot,
    strike,
    dte,
    atrPct,
    type: side,
    chainLeg: leg,
  });
  const mid = num(est?.mid);
  if (!(mid > 0)) return card;
  card.premium_mid = mid;
  if (num(ctx.lottoMaxLossUsd) > 0) {
    card.max_loss_usd = Math.round(ctx.lottoMaxLossUsd);
  } else if (mid > 0) {
    card.max_loss_usd = Math.round(mid * 100);
  }
  card.chain_status = "live";
  const copy = convexityPlanCopy(card);
  card.headline = copy.punch;
  card.scan_line = copy.scan;
  card.action = copy.action;
  return card;
}

/**
 * Fetch chain mids for ranked convexity cards still on estimates.
 */
export async function enrichConvexityChainPremiums(env, cards, opts = {}) {
  const list = Array.isArray(cards) ? cards : [];
  const fetchChain = opts.fetchChain;
  if (!fetchChain) return list;
  await Promise.all(list.map(async (card) => {
    if (!card?.ticker || !card?.expiration?.iso) return;
    if (card.chain_status === "live") return;
    const sym = String(card.ticker).toUpperCase();
    const expIso = String(card.expiration.iso).slice(0, 10);
    try {
      const chain = await fetchChain(env, sym, expIso, { strikeRangePct: 0.08, skipOI: true });
      overlayConvexityCardPremium(card, chain, {
        spot: opts.spotBySym?.[sym],
        atrPct: opts.atrPctBySym?.[sym],
        lottoMaxLossUsd: opts.lottoMaxLossUsd,
      });
    } catch (_) { /* keep estimate */ }
  }));
  return list;
}

export function rankConvexityCards(cards = []) {
  const list = Array.isArray(cards) ? [...cards] : [];
  list.sort((a, b) => {
    const aMoon = a.play_class === "moonshot" ? 0 : 1;
    const bMoon = b.play_class === "moonshot" ? 0 : 1;
    if (aMoon !== bMoon) return aMoon - bMoon;
    // Prefer earnings-prep lottos over generic quiet-tape lottos.
    const aEarn = a.earnings_prep ? 0 : 1;
    const bEarn = b.earnings_prep ? 0 : 1;
    if (aEarn !== bEarn) return aEarn - bEarn;
    return (Number(b.confluence_score) || 0) - (Number(a.confluence_score) || 0);
  });
  return list;
}
