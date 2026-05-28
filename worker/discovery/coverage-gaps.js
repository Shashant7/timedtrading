// worker/discovery/coverage-gaps.js
//
// 2026-05-28 — Universe Coverage Gap Diagnostic.
//
// User concern (paraphrased): "We are light on finding tickers in our
// universe that may be getting lost in our setup detection but are valid
// movers."
//
// This module answers that concern. For every in-universe ticker, find days
// with an ATR-relative big move, then check whether a trade was opened in
// that window. For each missed move, classify *why* no trade fired by
// reading admission_cohort_log, ticker_latest freshness, and trades table.
//
// Surfaced via:
//   - GET /timed/admin/discovery/coverage-gaps?lookback_days=10&min_atr_mult=3
//   - Nightly cron writes a per-ticker summary to KV
//     (timed:discovery:coverage-gaps-summary) so CIO memory L9 can read it
//     without re-running the analysis per CIO call.
//
// Cost: ~1-2 s per 30-day window over 250 tickers. Cheap.

const DEFAULT_LOOKBACK_DAYS = 10;
const DEFAULT_MIN_ATR_MULT = 3.0;
const ATR_PERIOD = 14;
const SAME_DAY_TRADE_WINDOW_MS = 18 * 60 * 60 * 1000; // 18h from day-open covers full RTH + AH
const SCORING_STALE_HOURS = 24; // ticker_latest older than this = "not_scored"
const NY_DAY_MS = 24 * 60 * 60 * 1000;

// Reasons a missed move can be classified into. Ordered by specificity —
// classifier picks the first matching reason.
const GAP_REASONS = {
  NOT_SCORED: "not_scored",
  GATE_BLOCKED: "gate_blocked",
  COHORT_FAIL: "cohort_fail",
  LOW_RANK: "low_rank",
  EVENT_RISK_BLOCKED: "event_risk_blocked",
  SHORT_GATE_TOO_TIGHT: "short_gate_too_tight",
  CAPITAL_BLOCKED: "capital_blocked",
  SETUP_NOT_DETECTED: "setup_not_detected",
};

// Compute 14-day average true range from a chronological array of daily
// candles. Returns array same length where atr[i] is the ATR ending at i.
// Wilder smoothing.
function computeAtr14(dailyCandles) {
  const n = dailyCandles.length;
  if (n < 2) return new Array(n).fill(null);
  const trs = [];
  for (let i = 0; i < n; i++) {
    if (i === 0) {
      trs.push(Number(dailyCandles[0].h) - Number(dailyCandles[0].l));
      continue;
    }
    const c = dailyCandles[i];
    const prev = dailyCandles[i - 1];
    const tr = Math.max(
      Number(c.h) - Number(c.l),
      Math.abs(Number(c.h) - Number(prev.c)),
      Math.abs(Number(c.l) - Number(prev.c)),
    );
    trs.push(tr);
  }
  const atrs = new Array(n).fill(null);
  // Seed at ATR_PERIOD index with simple average of first PERIOD TRs.
  if (n < ATR_PERIOD) return atrs;
  let sum = 0;
  for (let i = 0; i < ATR_PERIOD; i++) sum += trs[i];
  atrs[ATR_PERIOD - 1] = sum / ATR_PERIOD;
  for (let i = ATR_PERIOD; i < n; i++) {
    atrs[i] = (atrs[i - 1] * (ATR_PERIOD - 1) + trs[i]) / ATR_PERIOD;
  }
  return atrs;
}

// Convert a ms timestamp into the day-key the engine uses for trade rows
// (NY trading day boundary at 4 PM ET ≈ 20:00 UTC).
function dayKeyFromMs(ms) {
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

// Find big-move days for one ticker and classify each missed move.
async function analyzeTickerGaps(env, db, ticker, lookbackDays, minAtrMult, sinceMs) {
  const sym = String(ticker || "").toUpperCase();
  if (!sym) return null;

  // 1. Load enough daily candles for ATR-14 seed + the lookback window.
  //    We need (lookback + 2 * ATR_PERIOD) bars to be safe.
  const lookbackMs = sinceMs - (lookbackDays + 2 * ATR_PERIOD) * NY_DAY_MS;
  const dailyRows = (await db.prepare(
    `SELECT ts, o, h, l, c, v FROM ticker_candles
      WHERE ticker = ?1 AND tf = 'D' AND ts >= ?2
      ORDER BY ts ASC`
  ).bind(sym, lookbackMs).all().catch(() => ({ results: [] })))?.results || [];

  if (dailyRows.length < ATR_PERIOD + 1) {
    return { ticker: sym, skipped: true, reason: "insufficient_candles" };
  }
  const candles = dailyRows.map((r) => ({
    ts: Number(r.ts), o: Number(r.o), h: Number(r.h), l: Number(r.l),
    c: Number(r.c), v: Number(r.v) || 0,
  }));
  const atrs = computeAtr14(candles);

  // 2. Detect big-move days inside the lookback window.
  const bigMoves = [];
  for (let i = 1; i < candles.length; i++) {
    if (candles[i].ts < sinceMs) continue;
    const move = Math.abs(candles[i].c - candles[i - 1].c);
    const atr = atrs[i];
    if (!Number.isFinite(atr) || atr <= 0) continue;
    const atrMult = move / atr;
    if (atrMult < minAtrMult) continue;
    const direction = candles[i].c >= candles[i - 1].c ? "up" : "down";
    const changePct = (candles[i].c - candles[i - 1].c) / candles[i - 1].c * 100;
    bigMoves.push({
      day_ms: candles[i].ts,
      day: dayKeyFromMs(candles[i].ts),
      move_abs: +move.toFixed(2),
      atr: +atr.toFixed(2),
      atr_mult: +atrMult.toFixed(2),
      direction,
      change_pct: +changePct.toFixed(2),
      open: candles[i].o,
      close: candles[i].c,
      volume: candles[i].v,
    });
  }
  if (bigMoves.length === 0) {
    return { ticker: sym, big_moves: [], gaps: [], capture_rate: null };
  }

  // 3. Check trade capture per big-move day.
  const startMs = bigMoves[0].day_ms - NY_DAY_MS;
  const endMs = bigMoves[bigMoves.length - 1].day_ms + SAME_DAY_TRADE_WINDOW_MS;
  const tradesRows = (await db.prepare(
    `SELECT trade_id, entry_ts, exit_ts, status, pnl, direction, run_id
       FROM trades
      WHERE ticker = ?1 AND entry_ts >= ?2 AND entry_ts <= ?3
        AND (run_id IS NULL OR run_id = '')
      ORDER BY entry_ts ASC`
  ).bind(sym, startMs, endMs).all().catch(() => ({ results: [] })))?.results || [];

  // 4. Pull admission_cohort_log rows in the same window for "why didn't we trade?" classification.
  const admissionRows = (await db.prepare(
    `SELECT ts, gate, decision, entry_path, cohort_n, cohort_win_rate
       FROM admission_cohort_log
      WHERE ticker = ?1 AND ts >= ?2 AND ts <= ?3
      ORDER BY ts ASC`
  ).bind(sym, startMs, endMs).all().catch(() => ({ results: [] })))?.results || [];

  // 5. For each big move, find trade-on-that-day or classify the miss.
  const gaps = [];
  let captured = 0;
  for (const bm of bigMoves) {
    const dayStart = bm.day_ms;
    const dayEnd = bm.day_ms + SAME_DAY_TRADE_WINDOW_MS;
    const trade = tradesRows.find((t) => {
      const ets = Number(t.entry_ts) || 0;
      return ets >= dayStart && ets <= dayEnd;
    });
    if (trade) {
      captured++;
      continue;
    }
    // No trade — classify why.
    const dayAdmissions = admissionRows.filter((r) => {
      const ts = Number(r.ts) || 0;
      return ts >= dayStart && ts <= dayEnd;
    });
    const reason = classifyMiss(dayAdmissions);
    gaps.push({
      ...bm,
      reason: reason.reason,
      reason_detail: reason.detail,
      admission_rows: dayAdmissions.length,
    });
  }

  return {
    ticker: sym,
    big_moves_found: bigMoves.length,
    captured,
    gaps_count: gaps.length,
    capture_rate: bigMoves.length > 0 ? +(captured / bigMoves.length * 100).toFixed(1) : null,
    big_moves: bigMoves,
    gaps,
  };
}

// Classify why no trade fired on a big-move day given the admission_cohort_log
// rows for that ticker+day. Returns { reason, detail }.
function classifyMiss(dayAdmissions) {
  if (!dayAdmissions || dayAdmissions.length === 0) {
    return { reason: GAP_REASONS.NOT_SCORED, detail: { hint: "No admission_cohort_log rows — scoring may not have processed this ticker on this day" } };
  }
  // Group by decision.
  const decisions = {};
  for (const r of dayAdmissions) {
    const d = String(r.decision || "unknown");
    if (!decisions[d]) decisions[d] = [];
    decisions[d].push(r);
  }
  // Any ACCEPT means scoring saw entry potential — bigger story.
  if (decisions.accept) {
    return {
      reason: GAP_REASONS.SETUP_NOT_DETECTED,
      detail: {
        hint: "Cohort accepted, but no trade fired — entry-path filter or sizing path blocked it",
        accept_count: decisions.accept.length,
        entry_paths: [...new Set(decisions.accept.map((r) => r.entry_path).filter(Boolean))].slice(0, 5),
      },
    };
  }
  // Any cohort-related block?
  const cohortBlocks = dayAdmissions.filter((r) =>
    String(r.gate || "").includes("cohort") ||
    String(r.decision || "").includes("cohort_fail"),
  );
  if (cohortBlocks.length > 0) {
    return {
      reason: GAP_REASONS.COHORT_FAIL,
      detail: {
        hint: "Cohort floor blocked admission (cohort_min_n / cohort_wr_floor / cohort_pf_floor)",
        block_count: cohortBlocks.length,
        avg_cohort_n: avg(cohortBlocks.map((r) => Number(r.cohort_n))),
        avg_cohort_wr: avg(cohortBlocks.map((r) => Number(r.cohort_win_rate))),
      },
    };
  }
  // Pause/halt gate?
  const pauseBlocks = dayAdmissions.filter((r) => String(r.gate || "").includes("pause") || String(r.gate || "").includes("g1"));
  if (pauseBlocks.length > 0) {
    return {
      reason: GAP_REASONS.GATE_BLOCKED,
      detail: { hint: "G1 pause gate fired", block_count: pauseBlocks.length, gates: [...new Set(pauseBlocks.map((r) => r.gate))] },
    };
  }
  // Generic reject — dominant gate.
  const gateCounts = {};
  for (const r of dayAdmissions) {
    const g = String(r.gate || "unknown");
    gateCounts[g] = (gateCounts[g] || 0) + 1;
  }
  const topGate = Object.entries(gateCounts).sort((a, b) => b[1] - a[1])[0];
  return {
    reason: GAP_REASONS.GATE_BLOCKED,
    detail: {
      hint: "Gate blocked admission",
      dominant_gate: topGate?.[0] || "unknown",
      block_count: topGate?.[1] || 0,
      total_admissions: dayAdmissions.length,
    },
  };
}

function avg(arr) {
  const valid = arr.filter((x) => Number.isFinite(x));
  if (valid.length === 0) return null;
  return +(valid.reduce((s, v) => s + v, 0) / valid.length).toFixed(2);
}

// Run coverage gap analysis for a list of tickers.
// Returns { summary, per_ticker }.
export async function runCoverageGapAnalysis(env, opts = {}) {
  const db = env?.DB;
  if (!db) throw new Error("d1_not_configured");

  const lookbackDays = Math.max(1, Math.min(60, Number(opts.lookbackDays) || DEFAULT_LOOKBACK_DAYS));
  const minAtrMult = Math.max(0.5, Math.min(10, Number(opts.minAtrMult) || DEFAULT_MIN_ATR_MULT));
  const tickers = Array.isArray(opts.tickers) && opts.tickers.length > 0
    ? opts.tickers.map((t) => String(t || "").toUpperCase()).filter(Boolean)
    : [];
  if (tickers.length === 0) throw new Error("tickers_required");

  const sinceMs = Date.now() - lookbackDays * NY_DAY_MS;

  const perTicker = [];
  // Sequential by ticker to keep D1 contention low; each ticker is 2 queries + (maybe 1 admission query).
  // For 250 tickers this is ~750 D1 reads = a few seconds. Acceptable.
  for (const t of tickers) {
    try {
      const r = await analyzeTickerGaps(env, db, t, lookbackDays, minAtrMult, sinceMs);
      if (r) perTicker.push(r);
    } catch (e) {
      perTicker.push({ ticker: t, error: String(e?.message || e).slice(0, 200) });
    }
  }

  // Roll-up summary.
  let totalBig = 0, totalCaptured = 0, totalGaps = 0;
  const reasonCounts = {};
  const topMissedTickers = [];
  for (const t of perTicker) {
    if (t.big_moves_found != null) totalBig += t.big_moves_found;
    if (t.captured != null) totalCaptured += t.captured;
    if (t.gaps_count != null) totalGaps += t.gaps_count;
    for (const g of (t.gaps || [])) {
      reasonCounts[g.reason] = (reasonCounts[g.reason] || 0) + 1;
    }
    if ((t.gaps_count || 0) >= 2) {
      topMissedTickers.push({
        ticker: t.ticker,
        big_moves: t.big_moves_found,
        gaps: t.gaps_count,
        capture_rate: t.capture_rate,
        dominant_reason: Object.entries(t.gaps.reduce((acc, g) => {
          acc[g.reason] = (acc[g.reason] || 0) + 1;
          return acc;
        }, {})).sort((a, b) => b[1] - a[1])[0]?.[0] || null,
      });
    }
  }
  topMissedTickers.sort((a, b) => b.gaps - a.gaps);

  return {
    summary: {
      lookback_days: lookbackDays,
      min_atr_mult: minAtrMult,
      since_ms: sinceMs,
      universe_size: tickers.length,
      tickers_with_data: perTicker.filter((t) => !t.skipped && !t.error).length,
      tickers_skipped: perTicker.filter((t) => t.skipped).length,
      tickers_errored: perTicker.filter((t) => t.error).length,
      big_moves_found: totalBig,
      trades_captured: totalCaptured,
      gaps_count: totalGaps,
      capture_rate_pct: totalBig > 0 ? +(totalCaptured / totalBig * 100).toFixed(1) : null,
      reason_counts: reasonCounts,
      top_missed_tickers: topMissedTickers.slice(0, 30),
      computed_at: Date.now(),
    },
    per_ticker: perTicker,
  };
}

// Build a per-ticker summary blob suitable for KV storage + CIO memory L9
// consumption. Compact (one row per ticker that has a non-zero history).
export function buildCoverageGapsSummary(report) {
  const byTicker = {};
  for (const t of (report?.per_ticker || [])) {
    if (!t.ticker || (t.big_moves_found || 0) === 0) continue;
    const reasonCounts = {};
    for (const g of (t.gaps || [])) {
      reasonCounts[g.reason] = (reasonCounts[g.reason] || 0) + 1;
    }
    const dominantReason = Object.entries(reasonCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    byTicker[t.ticker] = {
      big_moves: t.big_moves_found,
      captured: t.captured,
      gaps: t.gaps_count,
      capture_rate_pct: t.capture_rate,
      dominant_miss_reason: dominantReason,
      last_gap_day: t.gaps?.[t.gaps.length - 1]?.day || null,
    };
  }
  return {
    window: {
      lookback_days: report?.summary?.lookback_days,
      since_ms: report?.summary?.since_ms,
      computed_at: report?.summary?.computed_at,
    },
    by_ticker: byTicker,
    universe_capture_rate_pct: report?.summary?.capture_rate_pct,
    universe_reason_mix: report?.summary?.reason_counts || {},
  };
}
