// Interpret rank evidence conservatively: absent is unknown, and an event
// earns directional points only when its direction is actually supplied.
export const finiteRankInput = value =>
  (typeof value === "number" || (typeof value === "string" && value.trim() !== "")) &&
  Number.isFinite(Number(value)) ? Number(value) : null;
export const rankFlag = value => value === true || value === 1 || value === "true";
export function rankDirection(value) {
  if (["LONG", "BULL", "bullish", 1].includes(value)) return "LONG";
  if (["SHORT", "BEAR", "bearish", -1].includes(value)) return "SHORT";
  return null;
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
