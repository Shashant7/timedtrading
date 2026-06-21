// worker/freshness.js
// ─────────────────────────────────────────────────────────────────────────────
//  Data Age Contract — the Freshness Doctrine (2026-06-11).
//
//  PRINCIPLE: a stale input can never silently become a fresh-looking output.
//
//  v2 (2026-06-21): ages are measured against the trading calendar — the last
//  completed RTH session and expected daily bar anchor — not raw wall clock
//  alone. A Thursday close stays FRESH through a Juneteenth + weekend gap.
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
// ─────────────────────────────────────────────────────────────────────────────

import {
  computeMarketSessionReference,
  etDateStr,
  isNyRthOpenAt,
} from "./foundation/trading-calendar.js";

export const FRESHNESS_SLO_VERSION = 2;

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

const HARD_MULT = 2;

const CRITICAL_ALWAYS = new Set(["D", "60"]);
const CRITICAL_RTH = new Set(["30", "10"]);
const MISSING_FORCES_STALE = new Set(["D", "60"]);
const INTRADAY_TFS = new Set(["1", "5", "10", "15", "30", "60", "240"]);

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
    return mins >= 570 && mins < 960;
  } catch {
    return true;
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
      case "5": return 20 * MIN;
      case "10": return 30 * MIN;
      case "15": return 45 * MIN;
      case "30": return 45 * MIN;
      case "60": return 2 * HOUR;
      case "240": return 6 * HOUR;
      case "D": return isWeekendUtcApprox(nowMs) ? 96 * HOUR : 48 * HOUR;
      case "W": return 9 * DAY;
      case "M": return 40 * DAY;
      default: return null;
    }
  }
  switch (key) {
    case "1":
    case "5":
    case "10":
    case "15":
    case "30":
    case "60":
    case "240":
      return 96 * HOUR;
    case "D": return isWeekendUtcApprox(nowMs) ? 96 * HOUR : 48 * HOUR;
    case "W": return 9 * DAY;
    case "M": return 40 * DAY;
    default: return null;
  }
}

/**
 * Calendar-aware effective age: how far behind the last completed session
 * (or expected daily bar) a candle timestamp is. Returns 0 when current.
 */
export function effectiveCandleAgeMs(tf, ts, nowMs, marketOpen, sessionRef) {
  const candleTs = Number(ts) || 0;
  if (candleTs <= 0) return null;

  if (!sessionRef?.last_trading_day) {
    return Math.max(0, nowMs - candleTs);
  }

  const lastDay = sessionRef.last_trading_day;
  const lastDailyMs = Number(sessionRef.last_daily_bar_ms) || 0;
  const openMs = Number(sessionRef.last_rth_open_ms) || 0;
  const closeMs = Number(sessionRef.last_rth_close_ms) || 0;

  if (String(tf) === "D") {
    const barDay = etDateStr(candleTs);
    if (barDay >= lastDay) return 0;
    if (lastDailyMs > 0 && candleTs >= lastDailyMs) return 0;
    return lastDailyMs > 0 ? Math.max(0, lastDailyMs - candleTs) : Math.max(0, nowMs - candleTs);
  }

  if (!marketOpen && INTRADAY_TFS.has(String(tf)) && openMs > 0 && closeMs > 0) {
    if (candleTs >= openMs && candleTs <= closeMs + 15 * MIN) return 0;
    if (etDateStr(candleTs) >= lastDay && candleTs >= openMs) return 0;
    if (candleTs <= closeMs) return Math.max(0, closeMs - candleTs);
  }

  return Math.max(0, nowMs - candleTs);
}

function compactSessionRef(sessionRef) {
  if (!sessionRef) return null;
  return {
    last_trading_day: sessionRef.last_trading_day,
    last_rth_close_ms: sessionRef.last_rth_close_ms,
    next_trading_day: sessionRef.next_trading_day,
    session_phase: sessionRef.session_phase,
  };
}

/**
 * Compute the `_freshness` block for a scored payload.
 *
 * @param {Object} tfNewestTs - map of tf -> newest candle ts (epoch ms).
 * @param {Object} [opts]
 * @param {number}  [opts.nowMs]      - "now" reference (replay passes asOfTs).
 * @param {boolean} [opts.marketOpen] - calendar-aware market-open answer.
 * @param {Object}  [opts.sessionRef] - output of computeMarketSessionReference().
 * @param {string}  [opts.mode]       - "live" (default) | "replay".
 */
export function computeFreshnessBlock(tfNewestTs, opts = {}) {
  const nowMs = Number(opts.nowMs) > 0 ? Number(opts.nowMs) : Date.now();
  const mode = opts.mode === "replay" ? "replay" : "live";
  const sessionRef = opts.sessionRef && typeof opts.sessionRef === "object"
    ? opts.sessionRef
    : (mode === "live" ? computeMarketSessionReference(nowMs) : null);
  const marketOpen = typeof opts.marketOpen === "boolean"
    ? opts.marketOpen
    : (sessionRef ? sessionRef.market_open : approxNyRegularMarketOpen(nowMs));

  const perTf = {};
  const staleTfs = [];
  const agingTfs = [];
  const missingTfs = [];
  let worst = null;

  const tfs = Object.keys(tfNewestTs || {});
  for (const tf of tfs) {
    const sloMs = freshnessSloMs(tf, marketOpen, nowMs);
    if (sloMs == null) continue;
    const ts = Number(tfNewestTs[tf]) || 0;
    const critical = CRITICAL_ALWAYS.has(tf) || (marketOpen && CRITICAL_RTH.has(tf));

    if (ts <= 0) {
      if (!marketOpen && !CRITICAL_ALWAYS.has(tf)) {
        perTf[tf] = {
          ts: null,
          age_min: null,
          slo_min: Math.round(sloMs / MIN),
          status: "not_expected",
          critical: false,
        };
        continue;
      }
      perTf[tf] = {
        ts: null,
        age_min: null,
        slo_min: Math.round(sloMs / MIN),
        status: "missing",
        critical,
      };
      missingTfs.push(tf);
      continue;
    }

    const ageMs = effectiveCandleAgeMs(tf, ts, nowMs, marketOpen, sessionRef) ?? Math.max(0, nowMs - ts);
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

    const rel = ageMs / sloMs;
    if (!worst || rel > worst._rel) {
      worst = { tf, age_min: Math.round(ageMs / MIN), slo_min: Math.round(sloMs / MIN), _rel: rel };
    }
  }

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
    enforced: mode === "live",
    market_open: marketOpen,
    checked_at: nowMs,
    session_ref: compactSessionRef(sessionRef),
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

export { computeMarketSessionReference, isNyRthOpenAt };

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
    market_session: compactSessionRef(computeMarketSessionReference(nowMs)),
  };
}
