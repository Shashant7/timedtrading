// worker/structural-stop.js
//
// Stop placement beyond recent structure (deep_audit_stop_beyond_swing_*,
// default OFF).
//
// Measured on 188 live Short Term trades (May-Sep 2026,
// scripts/replay-stop-context.mjs): 40% of plan stops sat INSIDE the prior
// 5-day swing range. Those were touched more often (50% vs 40%) and, once
// touched, recovered to entry about one time in four (10/38) — noise stops.
// Stops beyond the swing recovered 3 times in 45: when they are hit, the
// thesis is dead. Context at the touch (oversold RSI, phase extremes, volume,
// gaps) did not separate the two; placement did.
//
// scripts/replay-stop-placement.mjs: moving an inside-the-swing stop just
// beyond the 5-day swing (0.1 daily ATR, capped at 3 ATR) took the 57 moved
// trades from -21.7R to +0.2R at equal dollar risk (sizing is risk-based, so
// the wider stop buys fewer shares). Robust across buffer 0-0.25 ATR, cap
// 2-3 ATR and 5-20 session horizons (+11.7R to +22.8R).
//
// Only ever WIDENS the stop, never past `capAtr` daily ATRs from entry.

export const STRUCTURAL_STOP_DEFAULTS = Object.freeze({
  enabled: false,
  days: 5,
  bufferAtr: 0.1,
  capAtr: 3,
});

function num(v, d) {
  if (v == null || v === "") return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

/**
 * Daily ATR in price units. `tf_tech.D.atr` is the ATR *band* object, not a
 * number; the magnitude is `tf_tech.D.atrPct` (ATR as % of price).
 */
export function dailyAtrOf(tickerData, px) {
  const pct = Number(tickerData?.tf_tech?.D?.atrPct);
  const p = Number(px) || Number(tickerData?.daily_structure?.px) || 0;
  return pct > 0 && p > 0 ? (pct / 100) * p : 0;
}

export function loadStructuralStopConfig(daCfg = {}) {
  const d = STRUCTURAL_STOP_DEFAULTS;
  const days = num(daCfg?.deep_audit_stop_beyond_swing_days, d.days);
  return {
    enabled: String(daCfg?.deep_audit_stop_beyond_swing_enabled ?? d.enabled).toLowerCase() === "true",
    days: days >= 10 ? 10 : 5,
    bufferAtr: Math.max(0, num(daCfg?.deep_audit_stop_beyond_swing_buffer_atr, d.bufferAtr)),
    capAtr: Math.max(0.5, num(daCfg?.deep_audit_stop_beyond_swing_cap_atr, d.capAtr)),
  };
}

/**
 * The level a stop must sit beyond: the prior N-day swing low (LONG) / high
 * (SHORT) plus a buffer, but never further than `capAtr` ATRs from entry.
 * Null when the swing, ATR or entry is missing or the level is on the wrong
 * side of entry.
 */
export function structuralStopLevel({ direction, entryPx, dailyStructure, dailyAtr, daCfg }) {
  const cfg = loadStructuralStopConfig(daCfg);
  const dir = String(direction || "").toUpperCase();
  const entry = Number(entryPx);
  const atr = Number(dailyAtr);
  const a = dailyStructure?.ath52w || {};
  const swing = Number(dir === "LONG" ? a[`swing_low_${cfg.days}`] : a[`swing_high_${cfg.days}`]);
  if (!(entry > 0) || !(atr > 0) || !(swing > 0)) return null;
  if (dir === "LONG") {
    const lvl = Math.max(swing - cfg.bufferAtr * atr, entry - cfg.capAtr * atr);
    return lvl < entry ? lvl : null;
  }
  if (dir === "SHORT") {
    const lvl = Math.min(swing + cfg.bufferAtr * atr, entry + cfg.capAtr * atr);
    return lvl > entry ? lvl : null;
  }
  return null;
}

/**
 * Widen `sl` to the structural level when it sits inside it.
 * Returns { sl, moved, level }.
 */
export function applyStructuralStop(sl, ctx) {
  const cfg = loadStructuralStopConfig(ctx?.daCfg);
  const cur = Number(sl);
  if (!cfg.enabled || !Number.isFinite(cur)) return { sl, moved: false, level: null };
  const level = structuralStopLevel(ctx);
  if (level == null) return { sl, moved: false, level: null };
  const dir = String(ctx.direction || "").toUpperCase();
  const inside = dir === "LONG" ? cur > level : cur < level;
  if (!inside) return { sl, moved: false, level };
  return { sl: Math.round(level * 100) / 100, moved: true, level };
}

/**
 * A later clamp (the ETF 0.7% max stop) may tighten the stop, but not back
 * inside the structural level. Returns the clamp level to use.
 */
export function clampRespectingStructure(clampLevel, ctx) {
  const cfg = loadStructuralStopConfig(ctx?.daCfg);
  const c = Number(clampLevel);
  if (!cfg.enabled || !Number.isFinite(c)) return clampLevel;
  const level = structuralStopLevel(ctx);
  if (level == null) return clampLevel;
  return String(ctx.direction || "").toUpperCase() === "LONG" ? Math.min(c, level) : Math.max(c, level);
}

export const STRUCTURAL_STOP_DA_KEYS = [
  "deep_audit_stop_beyond_swing_enabled",
  "deep_audit_stop_beyond_swing_days",
  "deep_audit_stop_beyond_swing_buffer_atr",
  "deep_audit_stop_beyond_swing_cap_atr",
];
