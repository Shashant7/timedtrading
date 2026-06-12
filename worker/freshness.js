// worker/freshness.js
// ─────────────────────────────────────────────────────────────────────────────
//  Data Age Contract — the Freshness Doctrine (2026-06-11).
//
//  PRINCIPLE: a stale input can never silently become a fresh-looking output.
//
//  Every scored payload carries a `_freshness` block stamped at compute time
//  (see computeServerSideScores in worker/indicators.js). Downstream
//  consumers — computeRank, qualifiesForEnter, the investor compute,
//  /timed/health, the UI — read the block instead of re-deriving candle ages
//  with their own thresholds.
//
//  This module is intentionally a LEAF: no imports from worker/index.js or
//  worker/indicators.js, so it can be consumed anywhere (including tests)
//  without circular-dependency risk.
//
//  SLO philosophy (hard-won — see tasks/lessons.md "Open-position candle
//  freshness"): the market does NOT emit new bars between RTH close and the
//  next open. The freshest possible candle during the overnight/weekend gap
//  IS the last RTH bar — that is correct state, not staleness. So out-of-
//  session SLOs relax to cover the natural gap (96h covers weekend +
//  Monday-holiday + Thanksgiving), while in-session SLOs are tight.
//
//  Grades:
//    FRESH — every critical TF within SLO.
//    AGING — a critical TF breached its SLO (soft), or a non-critical TF
//            breached hard. Payload still usable; heal should be running.
//    STALE — a critical TF breached HARD (2x SLO) or D/60 missing entirely.
//            Payload is quarantined: capped rank, no new entries, excluded
//            from investor zone computes, UI shows refreshing state.
//
//  Modes:
//    live   — ages measured against wall clock; grade is enforced.
//    replay — ages measured against asOfTs; block is stamped for diagnostics
//             but `enforced: false` so historical replays keep parity with
//             validated backtests (replay candle getters already slice to
//             asOf — a "gap" there is a data-coverage question, not a
//             quarantine trigger).
// ─────────────────────────────────────────────────────────────────────────────

export const FRESHNESS_SLO_VERSION = 1;

export const GRADE_FRESH = "FRESH";
export const GRADE_AGING = "AGING";
export const GRADE_STALE = "STALE";

/** Stream-blocklisted / continuous-future symbols — no live intraday ingest. */
export const FRESHNESS_EXEMPT_TICKERS = new Set([
  "BTCUSD", "ETHUSD", "US500", "US100", "US30", "US2000", "VX1!",
  "ES1!", "NQ1!", "YM1!", "RTY1!", "CL1!", "GC1!", "SI1!", "HG1!", "NG1!",
]);

/** True when stale intraday bars are expected (not a data regression). */
export function isFreshnessExemptTicker(ticker) {
  const t = String(ticker || "").toUpperCase();
  if (!t) return false;
  if (FRESHNESS_EXEMPT_TICKERS.has(t)) return true;
  if (/[!]$/.test(t)) return true;
  return false;
}

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// Hard (quarantine) threshold = SLO x HARD_MULT. The buffer band between
// SLO and hard absorbs one transient missed bar / aggregation lag without
// quarantining (same reasoning as the 5m 15min→20min retune on 2026-06-01).
const HARD_MULT = 2;

// TFs whose hard breach drives the STALE grade. D + 60 are the structural
// backbone (cloud bias, trend, ATR targets all derive from them); 30 and the
// leading LTF (10) matter only while the market is emitting intraday bars.
const CRITICAL_ALWAYS = new Set(["D", "60"]);
const CRITICAL_RTH = new Set(["30", "10"]);

// Missing entirely (no candles at all) is graded harder than aging but we
// only let D/60 missing force STALE — a thin new listing without 10m bars
// should be AGING (visible, deprioritized, heal queued), not black-holed.
const MISSING_FORCES_STALE = new Set(["D", "60"]);

function isWeekendUtcApprox(nowMs) {
  const dow = new Date(nowMs).getUTCDay();
  return dow === 0 || dow === 6;
}

/**
 * Approximate NY regular-market-open check, self-contained (no calendar).
 * Weekday + 9:30-16:00 ET only; holidays read as "open" which makes SLOs
 * STRICTER on holidays, never looser — acceptable for a fallback. Callers
 * that have the calendar-aware answer should pass `marketOpen` explicitly.
 */
export function approxNyRegularMarketOpen(nowMs = Date.now()) {
  try {
    const d = new Date(nowMs);
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour12: false,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(d);
    const map = {};
    for (const p of parts) map[p.type] = p.value;
    const wd = String(map.weekday || "").toLowerCase();
    if (wd.startsWith("sat") || wd.startsWith("sun")) return false;
    const mins = (Number(map.hour) || 0) * 60 + (Number(map.minute) || 0);
    return mins >= 570 && mins < 960; // 9:30 AM - 4:00 PM ET
  } catch {
    return true; // fail strict: treat as open so SLOs stay tight
  }
}

/**
 * Session-aware SLO (soft / aging threshold) in ms for a timeframe.
 * Returns null for unknown TFs (they are recorded but never graded).
 */
export function freshnessSloMs(tf, marketOpen, nowMs = Date.now()) {
  const key = String(tf);
  if (marketOpen) {
    switch (key) {
      case "1": return 10 * MIN;
      case "5": return 20 * MIN;   // matches OPEN_POS_STALE_5M_RTH_MS
      case "10": return 30 * MIN;
      case "15": return 45 * MIN;
      case "30": return 45 * MIN;  // matches OPEN_POS_STALE_30M_RTH_MS
      case "60": return 2 * HOUR;  // matches OPEN_POS_STALE_60M_RTH_MS
      case "240": return 6 * HOUR;
      case "D": return isWeekendUtcApprox(nowMs) ? 96 * HOUR : 48 * HOUR;
      case "W": return 9 * DAY;
      case "M": return 40 * DAY;
      default: return null;
    }
  }
  // Out of session: intraday TFs relax to the natural-gap ceiling (96h
  // covers overnight, weekend, Monday-holiday, Thanksgiving — see header).
  switch (key) {
    case "1":
    case "5":
    case "10":
    case "15":
    case "30":
    case "60":
    case "240":
      return 96 * HOUR; // matches OPEN_POS_STALE_60M_OOH_MS
    case "D": return isWeekendUtcApprox(nowMs) ? 96 * HOUR : 48 * HOUR;
    case "W": return 9 * DAY;
    case "M": return 40 * DAY;
    default: return null;
  }
}

/**
 * Compute the `_freshness` block for a scored payload.
 *
 * @param {Object} tfNewestTs - map of tf -> newest candle ts (epoch ms).
 *   A falsy/zero/absent entry means "no candles for this TF".
 * @param {Object} [opts]
 * @param {number}  [opts.nowMs]      - "now" reference (replay passes asOfTs).
 * @param {boolean} [opts.marketOpen] - calendar-aware market-open answer;
 *                                      defaults to the approximation.
 * @param {string}  [opts.mode]       - "live" (default) | "replay".
 * @returns {Object} freshness block (see header).
 */
export function computeFreshnessBlock(tfNewestTs, opts = {}) {
  const nowMs = Number(opts.nowMs) > 0 ? Number(opts.nowMs) : Date.now();
  const mode = opts.mode === "replay" ? "replay" : "live";
  const marketOpen =
    typeof opts.marketOpen === "boolean" ? opts.marketOpen : approxNyRegularMarketOpen(nowMs);

  const perTf = {};
  const staleTfs = [];
  const agingTfs = [];
  const missingTfs = [];
  let worst = null;

  const tfs = Object.keys(tfNewestTs || {});
  for (const tf of tfs) {
    const sloMs = freshnessSloMs(tf, marketOpen, nowMs);
    if (sloMs == null) continue; // unknown TF — not part of the contract
    const ts = Number(tfNewestTs[tf]) || 0;
    const critical = CRITICAL_ALWAYS.has(tf) || (marketOpen && CRITICAL_RTH.has(tf));

    if (ts <= 0) {
      perTf[tf] = { ts: null, age_min: null, slo_min: Math.round(sloMs / MIN), status: "missing", critical };
      missingTfs.push(tf);
      continue;
    }

    const ageMs = Math.max(0, nowMs - ts);
    const hardMs = sloMs * HARD_MULT;
    let status = "fresh";
    if (ageMs > hardMs) status = "stale";
    else if (ageMs > sloMs) status = "aging";

    perTf[tf] = {
      ts,
      age_min: Math.round(ageMs / MIN),
      slo_min: Math.round(sloMs / MIN),
      status,
      critical,
    };
    if (status === "stale") staleTfs.push(tf);
    else if (status === "aging") agingTfs.push(tf);

    // Worst offender by SLO-relative age (4h-old 10m bar is worse than a
    // 30h-old D bar even though the absolute age is smaller).
    const rel = ageMs / sloMs;
    if (!worst || rel > worst._rel) {
      worst = { tf, age_min: Math.round(ageMs / MIN), slo_min: Math.round(sloMs / MIN), _rel: rel };
    }
  }

  // Grade.
  let grade = GRADE_FRESH;
  const criticalStale = staleTfs.some(
    (tf) => CRITICAL_ALWAYS.has(tf) || (marketOpen && CRITICAL_RTH.has(tf)),
  );
  const criticalMissing = missingTfs.some((tf) => MISSING_FORCES_STALE.has(tf));
  if (criticalStale || criticalMissing) {
    grade = GRADE_STALE;
  } else if (
    staleTfs.length > 0 ||
    missingTfs.length > 0 ||
    agingTfs.some((tf) => CRITICAL_ALWAYS.has(tf) || (marketOpen && CRITICAL_RTH.has(tf)))
  ) {
    grade = GRADE_AGING;
  }

  if (worst) delete worst._rel;

  return {
    v: FRESHNESS_SLO_VERSION,
    grade,
    mode,
    // Replay blocks are diagnostic-only — quarantine never acts on them, so
    // validated backtests keep parity.
    enforced: mode === "live",
    market_open: marketOpen,
    checked_at: nowMs,
    per_tf: perTf,
    stale_tfs: staleTfs,
    aging_tfs: agingTfs,
    missing_tfs: missingTfs,
    worst,
  };
}

/** True when this payload's freshness block says "quarantine me" (live STALE). */
export function isQuarantinedByFreshness(payload) {
  const sym = String(payload?.ticker || "").toUpperCase();
  if (sym && isFreshnessExemptTicker(sym)) return false;
  const f = payload?._freshness;
  return !!(f && f.enforced && f.grade === GRADE_STALE);
}

/**
 * Aggregate per-ticker freshness blocks into the universe summary that the
 * scoring cron writes to KV (`timed:freshness:summary`) and /timed/health
 * exposes. `entries` = [{ ticker, block }].
 */
export function buildFreshnessSummary(entries, opts = {}) {
  const nowMs = Number(opts.nowMs) > 0 ? Number(opts.nowMs) : Date.now();
  let fresh = 0;
  let aging = 0;
  let stale = 0;
  const staleTickers = [];
  const agingTickers = [];
  const agesByTf = {};
  let worst = null;

  for (const { ticker, block } of entries || []) {
    if (!block || typeof block !== "object") continue;
    if (isFreshnessExemptTicker(ticker)) {
      fresh++;
      continue;
    }
    if (block.grade === GRADE_STALE) {
      stale++;
      if (staleTickers.length < 25) {
        staleTickers.push({
          ticker,
          stale_tfs: block.stale_tfs || [],
          missing_tfs: block.missing_tfs || [],
          worst: block.worst || null,
        });
      }
    } else if (block.grade === GRADE_AGING) {
      aging++;
      if (agingTickers.length < 25) agingTickers.push(ticker);
    } else {
      fresh++;
    }
    for (const [tf, row] of Object.entries(block.per_tf || {})) {
      if (row?.age_min == null) continue;
      (agesByTf[tf] ||= []).push(row.age_min);
    }
    const wRel =
      block.worst && block.worst.slo_min > 0 ? block.worst.age_min / block.worst.slo_min : 0;
    const cRel = worst && worst.slo_min > 0 ? worst.age_min / worst.slo_min : -1;
    if (block.worst && wRel > cRel) {
      worst = { ticker, ...block.worst };
    }
  }

  const pctl = (arr, p) => {
    if (!arr.length) return null;
    const sorted = [...arr].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  };

  const perTfAges = {};
  for (const [tf, ages] of Object.entries(agesByTf)) {
    perTfAges[tf] = { p50_min: pctl(ages, 50), p95_min: pctl(ages, 95), n: ages.length };
  }

  const total = fresh + aging + stale;
  return {
    v: FRESHNESS_SLO_VERSION,
    computed_at: nowMs,
    total,
    fresh,
    aging,
    stale,
    slo_ok: stale === 0,
    stale_tickers: staleTickers,
    aging_tickers: agingTickers,
    per_tf_ages: perTfAges,
    worst,
  };
}
