// Interpret rank evidence conservatively: absent is unknown, and an event
// earns directional points only when its direction is actually supplied.
import { computeTdBoostForSide } from "../td-sequential-boost.js";
export const finiteRankInput = value =>
  (typeof value === "number" || (typeof value === "string" && value.trim() !== "")) &&
  Number.isFinite(Number(value)) ? Number(value) : null;
export const rankFlag = value => value === true || value === 1 || value === "true";
export function rankDirection(value) {
  if (["LONG", "BULL", "bullish", 1].includes(value)) return "LONG";
  if (["SHORT", "BEAR", "bearish", -1].includes(value)) return "SHORT";
  return null;
}

export function rankStateContext(state, side) {
  const aligned = side === "LONG" ? state === "HTF_BULL_LTF_BULL"
    : side === "SHORT" ? state === "HTF_BEAR_LTF_BEAR" : false;
  const setup = side === "LONG" ? state === "HTF_BULL_LTF_PULLBACK"
    : side === "SHORT" ? state === "HTF_BEAR_LTF_PULLBACK" : false;
  return { aligned, setup };
}

export function rankStrengthRole(value, side, allowPullback = false) {
  const n = finiteRankInput(value);
  if (n === null || n === 0 || !side) return "unknown_or_neutral";
  if ((n > 0 ? "LONG" : "SHORT") === side) return "aligned_strength";
  return allowPullback ? "pullback_depth" : "opposed_strength";
}

export function normalizeRankWeights(weights) {
  if (!weights || typeof weights !== "object" || Array.isArray(weights)) return null;
  return Object.fromEntries(Object.entries(weights).map(([key, value]) => [key, finiteRankInput(value)])
    .filter(([, value]) => value !== null));
}

const TD_FLAGS = ["td9_bullish", "td9_bearish", "td13_bullish", "td13_bearish"];
const TD_COUNTS = ["bullish_prep_count", "bearish_prep_count", "bullish_leadup_count", "bearish_leadup_count"];
const highTdTf = tf => ["D", "W", "M", "1D", "1W", "1M", "DAILY", "WEEKLY", "MONTHLY"].includes(String(tf || "").toUpperCase());
function tdEvidence(row) {
  if (!row || !TD_FLAGS.every(key => typeof row[key] === "boolean") ||
    !TD_COUNTS.every(key => finiteRankInput(row[key]) !== null && Number.isInteger(Number(row[key])) && Number(row[key]) >= 0)) return null;
  return row;
}
export function tdSequentialRankContribution(td, side) {
  if (!side) return { delta: 0, reason: "unknown_candidate_side" };
  if (td?.per_tf && typeof td.per_tf === "object") {
    const parts = [];
    for (const [tf, weight] of [["D", 1], ["W", 1.5], ["M", 2]]) {
      const row = tdEvidence(td.per_tf[tf]);
      if (row) parts.push({ tf, weight, delta: computeTdBoostForSide(row, side) * weight });
    }
    const raw = parts.reduce((sum, part) => sum + part.delta, 0);
    return { delta: Math.max(-15, Math.min(15, Math.round(raw * 10) / 10)),
      reason: parts.length ? "recomputed_for_candidate" : "missing_higher_tf_evidence", parts };
  }
  const tf = td?.timeframe || td?.tf;
  if (!highTdTf(tf)) return { delta: 0, reason: "unknown_or_intraday_timeframe" };
  const row = tdEvidence(td);
  if (row) return { delta: computeTdBoostForSide(row, side), reason: "recomputed_for_candidate", tf };
  // Legacy aggregate-only data is usable only when its producer side is explicit.
  const boost = finiteRankInput(td?.boost);
  if (boost !== null && rankDirection(td?.boost_side) === side) {
    return { delta: Math.max(-15, Math.min(15, boost)), reason: "matching_producer_side", tf };
  }
  return { delta: 0, reason: "missing_or_opposed_producer_side", tf };
}

// Keep sizing's completion fallback separate: unknown progress is not an
// observed early entry. Reject invalid explicit values; only derive when absent.
export function rankCompletion(d) {
  const explicit = finiteRankInput(d?.completion);
  if (d?.completion != null) return explicit !== null && explicit >= 0 && explicit <= 1 ? explicit : null;
  const price = finiteRankInput(d?.price);
  const trigger = finiteRankInput(d?.trigger_price);
  const target = finiteRankInput(d?.tp);
  if (!(price > 0 && trigger > 0 && target > 0) || target === trigger) return null;
  return Math.max(0, Math.min(1, Math.abs(price - trigger) / Math.abs(target - trigger)));
}

export function rsiRankDelta(divergence, side) {
  const direction = rankDirection(divergence?.type);
  if (!direction || !side || (divergence.active != null && !rankFlag(divergence.active))) return 0;
  const strength = Math.max(0, finiteRankInput(divergence.strength) ?? 0);
  const magnitude = 3 + Math.min(2, strength * 0.1);
  return direction === side ? magnitude : -magnitude;
}

export function breakoutRankDelta(breakout, side) {
  if (!side || rankDirection(breakout?.dir) !== side) return 0;
  const weights = { daily_level: 20, atr_breakout: 15, ema_stack: 12 };
  return Object.hasOwn(weights, breakout?.type) ? weights[breakout.type] : 0;
}

// Both tf_tech.stDir and the entry-lineage supertrend.d copy retain
// Pine's convention: -1=bull, +1=bear. Prefer the current producer field.
export function supertrendRankDirection(d, tf) {
  const pine = finiteRankInput(d?.tf_tech?.[tf]?.stDir ?? d?.supertrend?.[tf]?.d);
  return pine === null || pine === 0 ? null : pine < 0 ? "LONG" : "SHORT";
}

export function triggerRankSummary(d, side) {
  const uniq = [...new Set((Array.isArray(d?.triggers) ? d.triggers : [])
    .filter(t => typeof t === "string" && t.trim()).map(t => t.trim()))];
  const has = name => uniq.includes(name);
  const flags = d?.flags || {};
  const parts = [];
  const add = (event, weight, direction, source, conflict = false) => {
    const delta = conflict || !direction || !side ? 0 : weight * (direction === side ? 1 : -1);
    parts.push({ event, delta, direction, source,
      reason: conflict ? "conflicting_direction" : !side ? "unknown_candidate_side"
        : !direction ? "missing_direction" : direction === side ? "aligned" : "opposed" });
  };
  // One contribution per event/timeframe, regardless of named/flag duplication.
  const named = (event, bull, bear, flag, weight) => {
    const b = has(bull), s = has(bear);
    const flagDirection = rankFlag(flags[flag]) ? rankDirection(flags[flag + "_dir"]) : null;
    const namedDirection = b !== s ? (b ? "LONG" : "SHORT") : null;
    if (b || s) add(event, weight, namedDirection, "triggers",
      (b && s) || !!(flagDirection && namedDirection && flagDirection !== namedDirection));
    else if (rankFlag(flags[flag])) add(event, weight, rankDirection(flags[flag + "_dir"]), "flags");
  };
  for (const [tf, key, weight] of [
    ["1H", "1h", 2], ["30M", "30m", 1], ["10M", "10m", 1],
    ["5M", "5m", 0.5], ["3M", "3m", 0.5], ["1M", "1m", 0.5],
  ]) {
    named("ema_cross_" + key, "EMA_CROSS_" + tf + "_13_48_BULL",
      "EMA_CROSS_" + tf + "_13_48_BEAR", "ema_cross_" + key + "_13_48", weight);
  }
  named("buyable_dip_1h", "BUYABLE_DIP_1H_13_48_LONG", "BUYABLE_DIP_1H_13_48_SHORT",
    "buyable_dip_1h_13_48", 3);
  for (const [tf, key, weight] of [["30", "30M", 2], ["10", "10M", 1],
    ["5", "5M", 0.5], ["3", "3M", 0.5], ["1", "1M", 0.5]]) {
    const flag = "sq" + tf + "_release";
    if (has("SQUEEZE_RELEASE_" + key) || rankFlag(flags[flag])) {
      const direction = rankDirection(flags[flag + "_dir"] ?? d?.tf_tech?.[tf]?.sq?.dir);
      add("squeeze_release_" + tf, weight, direction, has("SQUEEZE_RELEASE_" + key) ? "triggers" : "flags");
    }
  }
  for (const [tf, key, weight] of [["1H", "1h", 1], ["30", "30m", 1],
    ["10", "10m", 0.5], ["5", "5m", 0.5], ["3", "3m", 0.5], ["1", "1m", 0.5]]) {
    const flag = "st_flip_" + key;
    const name = "ST_FLIP_" + (tf === "1H" ? tf : tf + "M");
    if (has(name) || rankFlag(flags[flag])) {
      const direction = rankDirection(flags[flag + "_dir"]) || supertrendRankDirection(d, tf);
      add(flag, weight, direction, has(name) ? "triggers" : "flags");
    }
  }
  const raw = parts.reduce((sum, p) => sum + p.delta, 0);
  const score = Math.max(-6, Math.min(12, raw));
  return { score, raw_score: raw, cap_delta: score - raw, side,
    count: uniq.length, top: uniq.slice(0, 5), parts };
}
