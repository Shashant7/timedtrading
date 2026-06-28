/**
 * Enrich timed:replay:daystate:{date} with monthly_bundle (+ tf_tech.M) so
 * investor-replay's D/W/M SuperTrend gate can fire on historical slices.
 *
 * Root cause (2026-06-28): trader candle-replay saves day-state from
 * timed:latest, but replay's M bundle requires endIdx >= 50 while Jul 2025
 * only has ~13 unique monthly bars in D1 — monthly_bundle stays null and
 * runInvestorDailyReplay opens 0 every day.
 */

import { computeTfBundle } from "./indicators.js";

/** Minimum bars to compute an investor-grade monthly bundle (computeTfBundle needs 15). */
export const INVESTOR_DAYSTATE_M_MIN_BARS = 15;

export function buildMonthlyBundleFromBars(bars) {
  const bM = computeTfBundle(Array.isArray(bars) ? bars : []);
  if (!bM) return null;
  return {
    supertrend_dir: bM.stDir,
    supertrend_line: bM.stLine ? Math.round(bM.stLine * 100) / 100 : undefined,
    ema_depth: bM.emaDepth,
    ema_structure: Math.round((bM.emaStructure || 0) * 1000) / 1000,
    ema_momentum: Math.round((bM.emaMomentum || 0) * 1000) / 1000,
    ema200: bM.e200 ? Math.round(bM.e200 * 100) / 100 : undefined,
    rsi: bM.rsi ? Math.round(bM.rsi * 10) / 10 : undefined,
    atr14: bM.atr14 ? Math.round(bM.atr14 * 100) / 100 : undefined,
    phase_osc: bM.phaseOsc ? Math.round(bM.phaseOsc * 10) / 10 : undefined,
    px: bM.px ? Math.round(bM.px * 100) / 100 : undefined,
  };
}

export function mergeMonthlyIntoTickerRow(td, monthlyBundle, bM) {
  if (!td || typeof td !== "object" || !monthlyBundle) return td;
  const next = { ...td, monthly_bundle: monthlyBundle };
  const tfTech = { ...(next.tf_tech || {}) };
  tfTech.M = {
    ...(tfTech.M || {}),
    stDir: bM.stDir,
    stLine: monthlyBundle.supertrend_line,
    rsi: monthlyBundle.rsi != null ? { r5: monthlyBundle.rsi } : tfTech.M?.rsi,
  };
  next.tf_tech = tfTech;
  return next;
}

export function sliceCandlesBeforeTs(candles, beforeTs) {
  if (!Array.isArray(candles) || !Number.isFinite(beforeTs)) return [];
  let lo = 0;
  let hi = candles.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].ts <= beforeTs) lo = mid + 1;
    else hi = mid - 1;
  }
  return candles.slice(0, hi + 1);
}

/**
 * Patch one day's replay day-state in place. Returns counts; mutates dayState.
 */
export async function enrichInvestorDayState({
  env,
  dayState,
  dateParam,
  tickers = null,
  minMonthlyBars = INVESTOR_DAYSTATE_M_MIN_BARS,
  d1GetCandlesAllTfs,
}) {
  if (!dayState || typeof dayState !== "object") {
    return { ok: false, error: "no_day_state" };
  }
  if (typeof d1GetCandlesAllTfs !== "function") {
    return { ok: false, error: "missing_d1GetCandlesAllTfs" };
  }

  const marketCloseMs = new Date(`${dateParam}T20:00:00Z`).getTime();
  if (!Number.isFinite(marketCloseMs)) {
    return { ok: false, error: "bad_date" };
  }

  const symList = Array.isArray(tickers) && tickers.length
    ? tickers.map((s) => String(s || "").toUpperCase()).filter(Boolean)
    : Object.keys(dayState);

  let patched = 0;
  let skippedHasBundle = 0;
  let skippedNoBars = 0;
  let failed = 0;

  const tfConfigs = [{ tf: "M", limit: 250 }];

  for (const sym of symList) {
    const td = dayState[sym];
    if (!td || typeof td !== "object") continue;
    if (td.monthly_bundle?.supertrend_dir != null) {
      skippedHasBundle++;
      continue;
    }

    try {
      const batch = await d1GetCandlesAllTfs(env, sym, tfConfigs, { beforeTs: marketCloseMs });
      const raw = batch?.M?.ok === false ? [] : (batch?.M?.candles || []);
      const mBars = sliceCandlesBeforeTs(raw, marketCloseMs);
      if (mBars.length < minMonthlyBars) {
        skippedNoBars++;
        continue;
      }
      const bM = computeTfBundle(mBars);
      const monthlyBundle = buildMonthlyBundleFromBars(mBars);
      if (!bM || !monthlyBundle) {
        skippedNoBars++;
        continue;
      }
      dayState[sym] = mergeMonthlyIntoTickerRow(td, monthlyBundle, bM);
      patched++;
    } catch {
      failed++;
    }
  }

  return {
    ok: true,
    date: dateParam,
    tickersRequested: symList.length,
    patched,
    skippedHasBundle,
    skippedNoBars,
    failed,
  };
}
