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
} from "./options-plays.js";

export const CONVEXITY_LOTTO_MAX_LOSS_DEFAULT_USD = 50;
export const CONVEXITY_FRESH_TTL_MS_01_DTE = 5 * 60 * 1000;
export const CONVEXITY_FRESH_TTL_MS_SWING = 15 * 60 * 1000;
export const CONVEXITY_SWING_MAX_DRIFT_PCT = 0.05;

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

  const mode = String(confluence?.mode || "").toUpperCase();
  if (playClass === "lotto") {
    const earnPrep = !!play._earnings_prep;
    const lottoModes = earnPrep
      ? ["READY", "RIDE", "DRIFT", "WAIT"]
      : ["READY", "RIDE", "DRIFT"];
    if (!lottoModes.includes(mode)) return false;
    if (mode === "READY" || (earnPrep && mode === "WAIT")) {
      const side = String(confluence?.side || contract?.direction || "").toUpperCase();
      const timing = timingLean(confluence);
      const floor = floorHeld({
        spot: spot ?? contract?.price,
        sl: contract?.sl,
        direction: side,
      });
      if (mode === "WAIT" && !floor) return false;
      if (mode === "READY" && !floor && timing !== side) return false;
    }
  } else if (playClass === "moonshot") {
    if (!["RIDE", "DRIFT"].includes(mode) && !(play._moonshot_active && mode === "RIDE")) {
      if (mode !== "RIDE" && mode !== "DRIFT") return false;
    }
  }

  const contractDir = resolveContractDirection(contract?.direction, contract?.effective_direction)
    || String(confluence?.side || "").toUpperCase();
  const playDir = resolvePlayDirection(play, contractDir);
  if (playDir && contractDir && playDir !== contractDir) return false;

  const lean = timingLean(confluence);
  if (lean && playDir && lean !== playDir) return false;

  const dte = Number(play?.expiration?.dte);
  const strike = Number(play?.strikes?.primary ?? play?.legs?.[0]?.strike);
  const px = Number(spot ?? contract?.price);
  if (!(px > 0) || !(strike > 0)) return false;

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
    if (drift > CONVEXITY_SWING_MAX_DRIFT_PCT) return false;
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

  return {
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
    rationale_short: play._earnings_prep
      ? "Earnings-prep lotto — cheap OTM into the print; IV crush risk; not a share entry."
      : playClass === "lotto"
        ? "Short-dated OTM — sized for total premium loss; 3×+ if the move fires."
        : "Gamma window — multi-bagger target if momentum continues.",
  };
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
