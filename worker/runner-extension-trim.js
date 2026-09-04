// worker/runner-extension-trim.js — trim INTO strength on extended runners.
//
// Operator feedback (TSLA 2026-09-03): LONG from 347.27 ran to 384.04
// (+10.6%) and held 382-383 for ~2 hours. Every protective rule was a
// TRAIL (MFE ratchet floor 376.68, 1H top-formation) — nothing banked
// profit WHILE the extension was happening. The runner finally trimmed
// the next morning at 359.98 after a gap down, giving back ~$23/share on
// the trimmed slice.
//
// This module is the strength-side complement to runner-top-formation:
//   • top-formation trims on WEAKNESS confluence (divergence, cloud break);
//   • extension-trim banks a slice INTO STRENGTH when the position is
//     deep in profit AND price is statistically stretched above the mean
//     (ATR-normalized distance from the daily fast EMA).
//
// Design constraints:
//   • Pure — no I/O; caller owns trimTradeToPct + execState persistence.
//   • Banks a STEP (default +25% of the original position) up to a cap
//     (default 75% trimmed) — the remaining runner stays for the trail
//     rules, so a monster continuation is still participated in.
//   • Fires at most once per NY session per trade, and only at a NEW
//     session extension (price above the last ext-trim print), so chop
//     around the threshold cannot bleed the position out.
//
// Config (model_config deep-audit blob, hot-reload):
//   deep_audit_ext_trim_enabled          default "true"
//   deep_audit_ext_trim_min_pnl_pct      default 8.0   (direction-adjusted)
//   deep_audit_ext_trim_min_atr_ext      default 1.5   (ATRs above daily fast EMA)
//   deep_audit_ext_trim_step_pct         default 0.25  (slice of ORIGINAL size)
//   deep_audit_ext_trim_max_trimmed_pct  default 0.75  (cap; runner keeps >= 25%)

const DEFAULT_CFG = Object.freeze({
  enabled: true,
  minPnlPct: 8.0,
  minAtrExt: 1.5,
  stepPct: 0.25,
  maxTrimmedPct: 0.75,
});

export function loadExtensionTrimCfg(daCfg) {
  const cfg = { ...DEFAULT_CFG };
  if (!daCfg || typeof daCfg !== "object") return cfg;
  const enabledRaw = daCfg.deep_audit_ext_trim_enabled;
  if (enabledRaw != null && enabledRaw !== "") {
    cfg.enabled = String(enabledRaw).toLowerCase() !== "false" && enabledRaw !== false && enabledRaw !== 0;
  }
  const map = {
    deep_audit_ext_trim_min_pnl_pct: "minPnlPct",
    deep_audit_ext_trim_min_atr_ext: "minAtrExt",
    deep_audit_ext_trim_step_pct: "stepPct",
    deep_audit_ext_trim_max_trimmed_pct: "maxTrimmedPct",
  };
  for (const [k, target] of Object.entries(map)) {
    const raw = daCfg[k];
    if (raw == null || raw === "") continue;
    const num = Number(raw);
    if (Number.isFinite(num) && num > 0) cfg[target] = num;
  }
  return cfg;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Daily fast EMA (5 preferred, then 12, then 21) from the snapshot. */
function resolveDailyFastEma(tickerData) {
  const d = tickerData?.tf_tech?.D || {};
  return num(d?.ema?.ema5)
    ?? num(tickerData?.daily_ema5)
    ?? num(d?.ema?.ema12)
    ?? num(d?.ema?.ema21)
    ?? num(tickerData?.ema21)
    ?? null;
}

function resolveDayAtr(tickerData, entryPx) {
  return num(tickerData?.atr_levels?.atr_day)
    ?? num(tickerData?.atr)
    ?? (num(entryPx) ? num(entryPx) * 0.015 : null);
}

/** NY session key so "once per session" survives the UTC date line. */
export function nySessionKey(ts) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Number(ts) || Date.now()));
}

/**
 * @returns {null | {
 *   action: "trim",
 *   reason: "RUNNER_EXTENSION_TRIM",
 *   newTargetTrimPct: number,
 *   pnlPct: number,
 *   atrExt: number,
 *   diag: Object,
 * }} null = hold (no action).
 */
export function assessRunnerExtensionTrim({
  openTrade,
  execState,
  tickerData,
  pxNow,
  entryPx,
  direction,
  daCfg,
  now = Date.now(),
} = {}) {
  const cfg = loadExtensionTrimCfg(daCfg);
  if (!cfg.enabled) return null;
  const px = num(pxNow);
  const entry = num(entryPx) ?? num(openTrade?.entryPrice) ?? num(openTrade?.entry_price);
  if (!(px > 0) || !(entry > 0)) return null;

  const isLong = String(direction || "").toUpperCase() !== "SHORT";
  const pnlPct = (isLong ? (px - entry) / entry : (entry - px) / entry) * 100;
  if (!(pnlPct >= cfg.minPnlPct)) return null;

  const trimmed = Math.max(0, Math.min(1, Number(openTrade?.trimmedPct ?? openTrade?.trimmed_pct ?? 0)));
  if (trimmed >= cfg.maxTrimmedPct - 1e-9) return null;

  const fastEma = resolveDailyFastEma(tickerData);
  const atr = resolveDayAtr(tickerData, entry);
  if (!(fastEma > 0) || !(atr > 0)) return null;
  const atrExt = (isLong ? px - fastEma : fastEma - px) / atr;
  if (!(atrExt >= cfg.minAtrExt)) return null;

  // Once per NY session, and any repeat session must print a NEW high
  // (low for shorts) vs the last extension trim — chop cannot re-fire it.
  const sessionKey = nySessionKey(now);
  if (String(execState?.extTrimSession || "") === sessionKey) return null;
  const lastPx = num(execState?.extTrimPx);
  if (lastPx != null && (isLong ? px <= lastPx : px >= lastPx)) return null;

  const newTargetTrimPct = Math.min(cfg.maxTrimmedPct, trimmed + cfg.stepPct);
  if (newTargetTrimPct - trimmed < 0.01) return null;

  return {
    action: "trim",
    reason: "RUNNER_EXTENSION_TRIM",
    newTargetTrimPct: Math.round(newTargetTrimPct * 10000) / 10000,
    pnlPct: Math.round(pnlPct * 100) / 100,
    atrExt: Math.round(atrExt * 100) / 100,
    diag: {
      fast_ema: fastEma,
      atr_day: atr,
      trimmed_before: trimmed,
      session: sessionKey,
      min_pnl_pct: cfg.minPnlPct,
      min_atr_ext: cfg.minAtrExt,
    },
  };
}
