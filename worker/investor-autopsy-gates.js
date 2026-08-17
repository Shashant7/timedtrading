// worker/investor-autopsy-gates.js
// Investor (long-horizon) lane gate pack — from
// tasks/2026-08-17-investor-stop-forensics.md.
//
// D2 is a DEFECT FIX and ships ON (its flag is a kill switch). D3 and D4 are
// tuning gates and are DEFAULT OFF until armed in model_config.
//
// The finding these answer: 44 of 47 closed long-term positions (2026-05 ->
// 2026-08) exited on PRIMARY_INVALIDATION_BREACH for -$11k, on a MEDIAN breach
// of 1.29%, on days when SPY was above its own 21 EMA in 11 of 12 cases. 18 of
// 23 of those exits saw price close back above the exit price within 20
// sessions (median: 1 session), average maximum recovery +7.3%. The exits are
// directionally defensible over a month but are executed at the 29th
// percentile of the local range. Meanwhile every position the stop never
// touched is profitable.
//
// Gates:
//   D2 weekly_st_dir_fix   [ON]  — `tf_tech.W.atr.xs` is only present on a
//                                  SuperTrend flip bar AND encodes the sign of
//                                  stDir, so `xs === 1` means BEARISH under the
//                                  Pine convention (-1 = bull) used everywhere
//                                  else in investor.js. Consumers read it as
//                                  bullish. Result: trendDurability scored 0 on
//                                  all 35 recorded entries, and Weekly
//                                  SuperTrend never became an invalidation
//                                  candidate (0 of 28 exits used it).
//   D3 require_session_close     — the published rule is "exit if price CLOSES
//                                  below $X", but `sustained_hold_below` fires
//                                  intraday and is the dominant confirm (5 of 6
//                                  readable August exits). Of 28 exits, the 7
//                                  whose own session close reclaimed the floor
//                                  averaged +1.52% at +20 sessions vs -8.93%
//                                  for the 16 that did not. Average execution
//                                  cost of waiting for the close: +0.02%.
//   D4 shallow_breach_score_hold — do not liquidate on a sub-2% breach while
//                                  the engine's own score still rates the name
//                                  a buy. CRDO exited at score 82, IESC 80.8,
//                                  SANM 73 on a 0.01% breach.
//
// D3 and D4 are strictly WIDENING: each can only defer an exit that would
// otherwise fire; neither can create an exit that does not already fire. D2 is
// a bug fix and moves scores in both directions.
//
// NOT SHIPPED — the invalidation floor ratchet. `resolveStickyPrimaryInvalidation`
// is monotonically non-decreasing while owned and always trails 4-12% under the
// LIVE mark, so the floor detaches from the level the position was opened
// against (IESC ratcheted $668.41 -> $757.00 in four days, ending above its own
// $755.99 cost basis, then closed the position for +0.02%). Two obvious clamps
// both fail: capping at the entry anchor hands back most of the open gain on
// genuine winners (PLTR is +37% with a floor at -2.2% from live), and a
// peak-giveback trailing cap does not catch IESC at all because its ratchet was
// fast rather than deep. Those are different problems and picking a giveback
// fraction needs data this book does not yet have. See the task file.

const flagOn = (v) =>
  v === true || v === 1 || String(v ?? "").toLowerCase() === "true";

// For defect fixes that ship ON. The flag exists only as a kill switch, so an
// unset key means "corrected behaviour" and only an explicit false reverts.
const flagOffExplicit = (v) =>
  v === false || v === 0 || String(v ?? "").toLowerCase() === "false";

const num = (v, fallback = null) => {
  if (v === null || v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * D2 — resolve weekly SuperTrend bullishness from the PERSISTENT direction
 * field rather than the flip-only, sign-mirrored `atr.xs`.
 *
 * Producer (worker/indicators.js): `atr.xs = b.stDir < 0 ? -1 : 1`, wrapped in
 * `if (!b.stFlip) return null`. So `xs` mirrors the sign of stDir and exists
 * only on a flip bar. Under the Pine convention used throughout investor.js
 * (`-1 = bull` — see the monthly check in generateThesis and the daily
 * SuperTrend bonus in computeInvestorScore) `xs === 1` therefore means BEARISH.
 *
 * This is a DEFECT FIX and ships ON — `deep_audit_investor_weekly_st_dir_fix`
 * is a kill switch, so only an explicit `false` restores the legacy
 * `atr.xs === 1` reading. Corrected, it reads `stDir === -1` off the
 * persistent field with the weekly bundle's `supertrend_dir` as a fallback.
 *
 * Verified against the live book 2026-08-17: `W.atr.xs` was undefined on all
 * 17 open positions and `trendDurability` was 0 on all 302 scored names, while
 * `W.stDir` was populated and agreed with `weekly_bundle.supertrend_dir` in
 * every case.
 *
 * @param {object} args
 * @param {object} args.tfW   — tickerData.tf_tech.W
 * @param {object} args.wb    — resolved weekly bundle
 * @param {object} args.daCfg — deep-audit config
 * @returns {boolean} weekly SuperTrend is bullish
 */
export function weeklySupertrendBull({ tfW = null, wb = null, daCfg = null } = {}) {
  if (flagOffExplicit(daCfg?.deep_audit_investor_weekly_st_dir_fix)) {
    return tfW?.atr?.xs === 1;
  }
  return weeklySupertrendDir({ tfW, wb }) === 1;
}

/**
 * D2 companion — the bearish half. Kept separate from `!weeklySupertrendBull`
 * because "unknown" must not read as bearish: several call sites use the bear
 * reading to trigger a REDUCE, and `weekly_supertrend_bearish` is in
 * `IMMEDIATE_INVESTOR_REDUCE_REASONS` (it skips `reduce_trim_min_sessions`).
 * Missing data has to mean "no signal", never "sell".
 *
 * @param {object} args
 * @param {object} args.tfW   — tickerData.tf_tech.W
 * @param {object} args.wb    — resolved weekly bundle
 * @param {object} args.daCfg — deep-audit config
 * @returns {boolean} weekly SuperTrend is bearish
 */
export function weeklySupertrendBear({ tfW = null, wb = null, daCfg = null } = {}) {
  if (flagOffExplicit(daCfg?.deep_audit_investor_weekly_st_dir_fix)) {
    return tfW?.atr?.xs === -1;
  }
  return weeklySupertrendDir({ tfW, wb }) === -1;
}

/**
 * Tri-state weekly SuperTrend direction, normalised to the *plain* convention
 * so callers read naturally: `1` = bull, `-1` = bear, `0` = unknown.
 *
 * Note this is the OPPOSITE sign to the raw Pine field it reads from, which is
 * exactly the trap that produced the bug — so the conversion happens here,
 * once, instead of at eight call sites.
 *
 * @param {object} args
 * @param {object} args.tfW — tickerData.tf_tech.W
 * @param {object} args.wb  — resolved weekly bundle
 * @returns {1|-1|0}
 */
export function weeklySupertrendDir({ tfW = null, wb = null } = {}) {
  const stDir = num(tfW?.stDir);
  if (stDir !== null && stDir !== 0) return stDir < 0 ? 1 : -1;
  const bundleDir = num(wb?.supertrend_dir);
  if (bundleDir !== null && bundleDir !== 0) return bundleDir < 0 ? 1 : -1;
  return 0;
}

/**
 * D3 — require the session's own close to confirm the breach.
 *
 * `resolvePrimaryInvalidationMovie` fires on `sustained_hold_below` (180 RTH
 * minutes) and `prior_daily_close` while the market is still open. Both are
 * intraday liquidations of a long-horizon position. With this gate armed only
 * `session_close_mark` — the post-16:00 ET path, where the mark IS today's RTH
 * close — may fire, which is the discipline the UI already publishes.
 *
 * The legacy-tick confirm is deliberately not covered: when the movie feature
 * itself is disabled the operator has explicitly opted out of confirm
 * discipline, and this gate should not silently re-impose it.
 *
 * @param {object} args
 * @param {string} args.confirm — movie confirm kind
 * @param {boolean} args.marketOpen
 * @param {object} args.daCfg   — deep-audit config
 * @returns {boolean} true when the fire should be deferred
 */
export function deferForSessionClose({ confirm = null, marketOpen = false, daCfg = null } = {}) {
  if (!flagOn(daCfg?.deep_audit_investor_require_session_close)) return false;
  if (!marketOpen) return false;
  const c = String(confirm || "");
  return c === "sustained_hold_below" || c === "prior_daily_close";
}

/**
 * D4 — hold through a shallow breach when the engine's own score still rates
 * the name a buy.
 *
 * Median breach across the 28 historical invalidation exits was 1.29%; the
 * extremes were SANM at 0.01% and IESC at 0.11%, with scores of 73 and 80.8.
 * This defers the liquidation while BOTH hold: the penetration is shallower
 * than `deep_audit_investor_shallow_breach_pct` (default 2.0) AND the score is
 * at or above `deep_audit_investor_breach_hold_score_min` (default 65). A
 * deeper break, or a score that has actually deteriorated, still fires.
 *
 * @param {object} args
 * @param {number} args.price  — live price
 * @param {object} args.breach — { price, label }
 * @param {number} args.score  — investor score at this pass
 * @param {object} args.daCfg  — deep-audit config
 * @returns {{hold: boolean, breachPct: number|null, score: number|null, detail: object|null}}
 */
export function shallowBreachScoreHold({ price = null, breach = null, score = null, daCfg = null } = {}) {
  if (!flagOn(daCfg?.deep_audit_investor_shallow_breach_score_hold)) {
    return { hold: false, breachPct: null, score: null, detail: null };
  }
  const px = num(price);
  const floor = num(breach?.price);
  const sc = num(score);
  if (px === null || floor === null || floor <= 0 || sc === null) {
    return { hold: false, breachPct: null, score: sc, detail: null };
  }
  const breachPct = ((floor - px) / floor) * 100;
  if (!(breachPct > 0)) return { hold: false, breachPct: null, score: sc, detail: null };

  const rounded = Math.round(breachPct * 100) / 100;
  const maxPct = Math.max(0, num(daCfg?.deep_audit_investor_shallow_breach_pct, 2) ?? 2);
  const minScore = num(daCfg?.deep_audit_investor_breach_hold_score_min, 65) ?? 65;
  if (!(breachPct < maxPct && sc >= minScore)) {
    return { hold: false, breachPct: rounded, score: sc, detail: null };
  }
  return {
    hold: true,
    breachPct: rounded,
    score: sc,
    detail: {
      breach_pct: rounded,
      max_pct: maxPct,
      score: sc,
      min_score: minScore,
      floor,
      label: String(breach?.label || ""),
    },
  };
}

export const __investorGateInternals = { flagOn, num };
