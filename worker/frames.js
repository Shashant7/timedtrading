// worker/frames.js
//
// Frame Digest — Phase 1 of the context-first scoring plan
// (tasks/2026-08-05-context-first-scoring-plan.md).
//
// Condenses the ticker's recent "movie" into a fixed, tiny feature block
// (`_frames`) that rides the scored payload. Zero extra candle loops on the
// hot path: everything derives from data ALREADY on the payload (tf_tech,
// journey ring, week/day lows) plus the compact context rollup produced by
// worker/context-ledger.js (anchors respect, recent tests, move stats).
//
// The digest answers, per anchor: where is price relative to the level
// RIGHT NOW and what just happened (approaching / testing / reclaiming /
// below / above)? Combined with ledger respect memory this is exactly the
// input the CAT Weekly-Breakout-Retest playbook needed and never had.

const DAY_MS = 86400000;

export const FRAME_DIGEST_VERSION = 1;

/** Anchor classification bands (pct of level). Mirrors CONTEXT_ANCHORS. */
export const FRAME_ANCHOR_SPECS = Object.freeze({
  W_EMA21: { tf: "W", bandPct: 3.5, approachPct: 8 },
  W_ST: { tf: "W", bandPct: 3.5, approachPct: 8 },
  D_EMA21: { tf: "D", bandPct: 1.5, approachPct: 4 },
});

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Resolve current level for each anchor from payload fields. */
export function resolveAnchorLevels(td = {}) {
  const tfW = td?.tf_tech?.W || {};
  const tfD = td?.tf_tech?.D || {};
  const wEma21 = num(td?.weekly_bundle?.ema21)
    ?? num(tfW?.ema?.ema21) ?? num(tfW?.ema?.e21);
  // Weekly SuperTrend is a support anchor only while in bull mode.
  let wSt = num(td?.st_support?.W);
  if (wSt == null) {
    const stLine = num(td?.weekly_bundle?.supertrend_line);
    const stDir = num(td?.weekly_bundle?.supertrend_dir);
    if (stLine != null && stDir === -1) wSt = stLine;
  }
  const dEma21 = num(td?.daily_bundle?.ema21)
    ?? num(tfD?.ema?.ema21) ?? num(tfD?.ema?.e21);
  return { W_EMA21: wEma21, W_ST: wSt, D_EMA21: dEma21 };
}

/** Session low used to detect a "touch" per timeframe. */
function resolveTouchLow(td = {}, tf) {
  if (tf === "W") {
    return num(td?.week_low) ?? num(td?.wl) ?? num(td?.tf_tech?.W?.low);
  }
  return num(td?.day_low) ?? num(td?.dl) ?? num(td?.tf_tech?.D?.low);
}

/**
 * Classify price vs one anchor level. STATIC states only — day-1 shadow
 * lesson (2026-08-06): session lows are NOT on the scored payload, so any
 * state that depends on "the low touched earlier" (the old "reclaiming")
 * could never occur and no playbook ever triggered. Reclaims are now
 * TRANSITIONS detected by the playbook state machine (last_state → state),
 * with the ledger's structural_test facts covering touches the 5-min
 * print never saw.
 *
 * States (support-role):
 *   below       — price under the level beyond the band
 *   testing     — price inside the band around the level
 *   approaching — above the level, inside the approach zone
 *   above       — comfortably above
 */
export function classifyAnchorState({ price, level, low, bandPct, approachPct }) {
  if (!(price > 0) || !(level > 0)) return null;
  const distPct = ((price - level) / level) * 100;
  const lowDistPct = low > 0 ? ((low - level) / level) * 100 : null;
  const touched = lowDistPct != null
    && lowDistPct <= bandPct
    && lowDistPct >= -bandPct * 1.5;
  let state;
  if (distPct < -bandPct * 1.5) state = "below";
  else if (distPct <= bandPct) state = "testing";
  else if (distPct <= approachPct) state = "approaching";
  else state = "above";
  return {
    state,
    dist_pct: Math.round(distPct * 100) / 100,
    low_dist_pct: lowDistPct != null ? Math.round(lowDistPct * 100) / 100 : null,
    touched,
  };
}

/**
 * Build the frame digest. Pure; safe on partial data.
 *
 * @param {object} args.td      scored payload (fresh result)
 * @param {object} args.context compact rollup from context-ledger (KV timed:context:<T>)
 * @param {number} args.now
 */
export function buildFrameDigest({ td = {}, context = null, now = Date.now() } = {}) {
  const price = num(td?._live_price) ?? num(td?.price) ?? num(td?.close);
  const levels = resolveAnchorLevels(td);
  const ctxAnchors = context?.anchors || {};

  const anchors = {};
  for (const [key, spec] of Object.entries(FRAME_ANCHOR_SPECS)) {
    const level = levels[key];
    if (!(level > 0) || !(price > 0)) continue;
    const cls = classifyAnchorState({
      price,
      level,
      low: resolveTouchLow(td, spec.tf),
      bandPct: spec.bandPct,
      approachPct: spec.approachPct,
    });
    if (!cls) continue;
    const mem = ctxAnchors[key] || null;
    anchors[key] = {
      level: Math.round(level * 100) / 100,
      ...cls,
      respect: mem?.respect === true,
      held: Number(mem?.held) || 0,
      failed: Number(mem?.failed) || 0,
    };
  }

  // Score trajectory from the journey ring (already maintained per tick).
  const jf = td?._journey?.features || null;

  // Position history recency from the rollup.
  const lastEntryTs = num(context?.last_entry?.ts);
  const lastExitTs = num(context?.last_exit?.ts);
  const daysAgo = (ts) => (ts > 0 ? Math.round(((now - ts) / DAY_MS) * 10) / 10 : null);

  const windowDays = Number(context?.window_days) || 30;
  const recentTests = (context?.recent_tests || [])
    .filter((t) => Number(t?.ts) > now - windowDays * DAY_MS)
    .slice(0, 4)
    .map((t) => ({
      anchor: t.anchor,
      days_ago: daysAgo(Number(t.ts)),
      resolution: t.resolution,
    }));

  return {
    v: FRAME_DIGEST_VERSION,
    ts: now,
    window_days: windowDays,
    leadin_days: Number(context?.leadin_days) || 5,
    price: price != null ? Math.round(price * 100) / 100 : null,
    anchors,
    score_slope_1h: jf?.score_slope_1h ?? null,
    score_slope_1d: jf?.score_slope_1d ?? null,
    journey_direction: jf?.direction ?? null,
    last_entry_days: daysAgo(lastEntryTs),
    last_exit_days: daysAgo(lastExitTs),
    last_exit_pnl_pct: context?.last_exit?.pnl_pct ?? null,
    recent_tests: recentTests,
    median_move_pct: context?.moves?.median_pct ?? null,
  };
}
