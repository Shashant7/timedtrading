// ═══════════════════════════════════════════════════════════════════════════
// trigger-hitrate.js — ST flip / EMA cross / squeeze release hit-rate analyzer
// ═══════════════════════════════════════════════════════════════════════════
//
// Phase 2 S1 of the trajectory research program
// (tasks/2026-05-18-stochastic-research-program.md §0).
//
// PURPOSE
// -------
// Quantitatively answer the owner's Q6: "Have we truly looked at our triggers
// in EMA cross and ST flips compared to other variables to know when they
// work and when they do not?"
//
// For every historical event of {had_st_flip / had_ema_cross / had_squeeze_release}
// in trail_5m_facts, look forward N buckets and measure whether price moved
// in the implied direction. Bucket the outcome by:
//   * Bubble-map cell at the event (worker/lib/trajectory-cells.js)
//   * Time-of-day in NY (RTH / pre-mkt / AH bucket)
//   * Trail-side regime label (state code at the event bucket)
//
// We DELIBERATELY measure the OUTCOME of the trigger event itself — not the
// rank correlation of the signal value with returns. The existing
// `signalIC` in the calibration aggregator measures the latter; this measures
// "if you bought when ST flipped at this cell at this hour, did the next
// hour go your way?"
//
// DIRECTION INFERENCE
// -------------------
// trail_5m_facts doesn't store flip direction explicitly. We infer it from
// adjacent buckets:
//   * had_st_flip + state transitions Bear→Bull → bullish flip
//   * had_st_flip + state transitions Bull→Bear → bearish flip
//   * had_st_flip + state unchanged → ambiguous (bucketed but reported separately)
//
// HIT DEFINITION
// --------------
// Compare price_close at the event bucket vs price_close at +N buckets.
// Hit = price moved in the inferred direction by at least min_move_pct
// (default 0.10 %). Stalemate (no significant move) is NOT a hit and is
// reported separately so the consumer can see "trigger fires but nothing
// happens" as distinct from "trigger fires AGAINST you".
//
// MEMORY DISCIPLINE
// -----------------
// This analyzer scans the entire trail_5m_facts (~4.5M rows). To stay
// under D1 query CPU we do ONE big read of just the bucketed snapshot
// fields, stream-process in JS, and emit a compact aggregate.
// ═══════════════════════════════════════════════════════════════════════════

import { cellOfFact } from "./trajectory-cells.js";

const FIVE_MIN_MS = 5 * 60 * 1000;

// Forward horizons we measure: 1h, 2h, 4h (in 5-min buckets).
const HORIZONS = Object.freeze({ h1: 12, h2: 24, h4: 48 });

// Signals we measure outcomes for. Order matters only for the report
// presentation order.
const SIGNALS = Object.freeze([
  { key: "had_st_flip",         name: "st_flip" },
  { key: "had_ema_cross",       name: "ema_cross" },
  { key: "had_squeeze_release", name: "squeeze_release" },
  { key: "had_momentum_elite",  name: "momentum_elite" },
]);

// Default minimum |move %| that counts as a "hit" or "miss" (vs stalemate).
const DEFAULT_MIN_MOVE_PCT = 0.10;

// NY hour-of-day buckets. trail_5m_facts.bucket_ts is in UTC ms; we compute
// the NY hour via Date.toLocaleString (Worker runtime exposes Intl).
function nyHourOfBucket(bucketTs) {
  try {
    const d = new Date(Number(bucketTs));
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour12: false,
      hour: "2-digit",
    }).formatToParts(d);
    const h = Number(parts.find(p => p.type === "hour")?.value || 0);
    return Number.isFinite(h) ? h : -1;
  } catch { return -1; }
}

function sessionBucketOfNyHour(hourNy) {
  if (hourNy < 0) return "unknown";
  // Mirror SessionPill (react-app/today.html): pre 09:30 / RTH 09:30–16:00 / AH 16:00–20:00 / closed
  if (hourNy < 9) return "pre";
  if (hourNy < 16) return "rth";
  if (hourNy < 20) return "ah";
  return "closed";
}

// ── Direction inference ───────────────────────────────────────────────────
//
// Compare the canonical 4-state code at the event bucket vs the previous
// bucket. Bear→Bull = bullish flip; Bull→Bear = bearish; unchanged or
// across pullback variants = ambiguous.

function direction4(stateCode) {
  if (!stateCode) return null;
  if (stateCode === "B" || stateCode === "Bp") return "LONG";
  if (stateCode === "R" || stateCode === "Rp") return "SHORT";
  return null;
}

function inferFlipDirection(prevState, curState) {
  const a = direction4(prevState);
  const b = direction4(curState);
  if (!b) return "ambiguous";
  if (a && b && a !== b) return b;       // explicit flip
  return "continuation";                  // same side or unknown prev
}

// ── Hit classification ────────────────────────────────────────────────────

function classifyHit(priceAtEvent, priceAtHorizon, direction, minMovePct) {
  if (!Number.isFinite(priceAtEvent) || priceAtEvent <= 0) return "no_price";
  if (!Number.isFinite(priceAtHorizon) || priceAtHorizon <= 0) return "no_horizon";
  const pctMove = ((priceAtHorizon - priceAtEvent) / priceAtEvent) * 100;
  const absMove = Math.abs(pctMove);
  if (absMove < minMovePct) return "stalemate";
  if (direction === "LONG")  return pctMove > 0 ? "hit" : "miss";
  if (direction === "SHORT") return pctMove < 0 ? "hit" : "miss";
  // For continuation/ambiguous: report magnitude only
  return "moved";
}

// ── Bucket key helpers ────────────────────────────────────────────────────

function bucketKey(parts) {
  return parts.map(p => p == null ? "_" : String(p)).join("|");
}

function newBucketCounters() {
  return {
    n: 0,
    hits: 0,
    misses: 0,
    stalemates: 0,
    moves: 0,           // for continuation/ambiguous events with magnitude only
    sum_abs_move_pct: 0,
  };
}

function recordBucket(bucket, hitClass, absMovePct) {
  bucket.n += 1;
  if (hitClass === "hit") bucket.hits += 1;
  else if (hitClass === "miss") bucket.misses += 1;
  else if (hitClass === "stalemate") bucket.stalemates += 1;
  else if (hitClass === "moved") bucket.moves += 1;
  if (Number.isFinite(absMovePct)) bucket.sum_abs_move_pct += absMovePct;
}

function summarizeBucket(b) {
  const decided = b.hits + b.misses;
  return {
    n: b.n,
    hits: b.hits,
    misses: b.misses,
    stalemates: b.stalemates,
    moves: b.moves,
    hit_rate: decided > 0 ? Number((b.hits / decided).toFixed(4)) : null,
    decided_pct: b.n > 0 ? Number((decided / b.n).toFixed(4)) : null,
    avg_abs_move_pct: b.n > 0 ? Number((b.sum_abs_move_pct / b.n).toFixed(4)) : null,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * @param {object} env worker env (uses env.DB)
 * @param {object} [opts]
 * @param {number} [opts.sinceMs]   Lower bound on bucket_ts. Default: 90 days.
 * @param {number} [opts.untilMs]   Upper bound on bucket_ts. Default: now.
 * @param {string} [opts.ticker]    Limit to one ticker (debug). Default: all.
 * @param {number} [opts.minMovePct] Hit threshold. Default: 0.10.
 * @returns {Promise<{
 *   ok, window: {since_ms, until_ms},
 *   signals: { [signalName]: {
 *     all: bucket,
 *     by_horizon: { h1: bucket, h2: bucket, h4: bucket },
 *     by_direction: { LONG: bucket, SHORT: bucket, continuation: bucket, ambiguous: bucket },
 *     by_session: { pre: bucket, rth: bucket, ah: bucket, closed: bucket },
 *     by_cell_top20: [ { cell, ...bucket } ]
 *   }},
 *   elapsed_ms
 * }>}
 */
export async function computeTriggerHitRates(env, opts = {}) {
  const t0 = Date.now();
  const db = env?.DB;
  if (!db) return { ok: false, error: "no_db", elapsed_ms: 0 };

  const sinceMs   = Number.isFinite(opts.sinceMs)   ? Number(opts.sinceMs)   : Date.now() - 90 * 86400000;
  const untilMs   = Number.isFinite(opts.untilMs)   ? Number(opts.untilMs)   : Date.now();
  const minMovePct = Number.isFinite(opts.minMovePct) ? Number(opts.minMovePct) : DEFAULT_MIN_MOVE_PCT;
  const tickerFilter = opts.ticker ? String(opts.ticker) : null;

  // One scan of trail_5m_facts in the window. Stream-process in JS for
  // direction inference + horizon lookups. Per-ticker grouping is implicit
  // in the ORDER BY (ticker, bucket_ts) so we can do forward-lookup with
  // a small ring buffer.
  const sql = tickerFilter
    ? `SELECT ticker, bucket_ts, state, rank, completion, phase_pct, price_close,
              had_st_flip, had_ema_cross, had_squeeze_release, had_momentum_elite
       FROM trail_5m_facts
       WHERE ticker = ?1 AND bucket_ts >= ?2 AND bucket_ts <= ?3
       ORDER BY ticker, bucket_ts ASC`
    : `SELECT ticker, bucket_ts, state, rank, completion, phase_pct, price_close,
              had_st_flip, had_ema_cross, had_squeeze_release, had_momentum_elite
       FROM trail_5m_facts
       WHERE bucket_ts >= ?1 AND bucket_ts <= ?2
       ORDER BY ticker, bucket_ts ASC`;

  let rows;
  try {
    const args = tickerFilter ? [tickerFilter, sinceMs, untilMs] : [sinceMs, untilMs];
    const res = await db.prepare(sql).bind(...args).all();
    rows = res?.results || [];
  } catch (err) {
    return { ok: false, error: String(err?.message || err).slice(0, 300), elapsed_ms: Date.now() - t0 };
  }

  // Initialize per-signal accumulators.
  const acc = {};
  for (const { name } of SIGNALS) {
    acc[name] = {
      all: newBucketCounters(),
      by_horizon: {
        h1: newBucketCounters(),
        h2: newBucketCounters(),
        h4: newBucketCounters(),
      },
      by_direction: {
        LONG: newBucketCounters(),
        SHORT: newBucketCounters(),
        continuation: newBucketCounters(),
        ambiguous: newBucketCounters(),
      },
      by_session: {
        pre: newBucketCounters(),
        rth: newBucketCounters(),
        ah: newBucketCounters(),
        closed: newBucketCounters(),
        unknown: newBucketCounters(),
      },
      by_cell: new Map(),   // cellKey → bucket
    };
  }

  // Stream pass. We index rows so we can do `rows[i + HORIZON]` lookahead.
  // Since rows are ordered by (ticker, bucket_ts), check that the +N row
  // is the SAME ticker before measuring.
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const tk = r.ticker;
    // Iterate signals; record only events where the flag was set.
    for (const sig of SIGNALS) {
      if (Number(r[sig.key]) !== 1) continue;

      // Direction inference
      const prevSameTicker = (i > 0 && rows[i - 1].ticker === tk) ? rows[i - 1] : null;
      const dir = inferFlipDirection(
        prevSameTicker ? canonState(prevSameTicker.state) : null,
        canonState(r.state),
      );

      const cellKey = cellOfFact({
        state: r.state,
        rank: r.rank,
        completion: r.completion,
        phase_pct: r.phase_pct,
      });
      const session = sessionBucketOfNyHour(nyHourOfBucket(r.bucket_ts));

      // Per-horizon outcome
      for (const [hKey, nBuckets] of Object.entries(HORIZONS)) {
        const future = rows[i + nBuckets];
        if (!future || future.ticker !== tk) continue;
        const expectedTs = Number(r.bucket_ts) + nBuckets * FIVE_MIN_MS;
        // Tolerate +/-1 bucket of gap (occasional missing 5min row)
        if (Math.abs(Number(future.bucket_ts) - expectedTs) > FIVE_MIN_MS) continue;

        const priceA = Number(r.price_close);
        const priceB = Number(future.price_close);
        if (!Number.isFinite(priceA) || !Number.isFinite(priceB) || priceA <= 0) continue;
        const pctMove = ((priceB - priceA) / priceA) * 100;
        const absMovePct = Math.abs(pctMove);

        const hitClass = classifyHit(priceA, priceB, dir, minMovePct);
        const aSig = acc[sig.name];

        recordBucket(aSig.by_horizon[hKey], hitClass, absMovePct);
        if (hKey === "h1") {
          // Use h1 as the canonical event for the cross-cut aggregations
          // (otherwise n triples). h2 and h4 still feed by_horizon for
          // the time-decay view.
          recordBucket(aSig.all, hitClass, absMovePct);
          recordBucket(aSig.by_direction[dir] || aSig.by_direction.ambiguous, hitClass, absMovePct);
          recordBucket(aSig.by_session[session] || aSig.by_session.unknown, hitClass, absMovePct);
          if (cellKey) {
            let cBucket = aSig.by_cell.get(cellKey);
            if (!cBucket) { cBucket = newBucketCounters(); aSig.by_cell.set(cellKey, cBucket); }
            recordBucket(cBucket, hitClass, absMovePct);
          }
        }
      }
    }
  }

  // Summarize for the response. by_cell trimmed to top-20 by n.
  const report = {};
  for (const sig of SIGNALS) {
    const a = acc[sig.name];
    const cellEntries = Array.from(a.by_cell.entries())
      .map(([cell, b]) => ({ cell, ...summarizeBucket(b) }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 20);
    report[sig.name] = {
      all: summarizeBucket(a.all),
      by_horizon: Object.fromEntries(Object.entries(a.by_horizon).map(([k, b]) => [k, summarizeBucket(b)])),
      by_direction: Object.fromEntries(Object.entries(a.by_direction).map(([k, b]) => [k, summarizeBucket(b)])),
      by_session: Object.fromEntries(Object.entries(a.by_session).map(([k, b]) => [k, summarizeBucket(b)])),
      by_cell_top20: cellEntries,
    };
  }

  return {
    ok: true,
    window: { since_ms: sinceMs, until_ms: untilMs },
    config: { min_move_pct: minMovePct, horizons_5min_buckets: HORIZONS, ticker_filter: tickerFilter },
    counts: { rows_scanned: rows.length },
    signals: report,
    elapsed_ms: Date.now() - t0,
  };
}

// Map raw trail_5m_facts state string to canonical 4-letter code. Mirrors
// stateCode() in trajectory-cells.js (kept local to avoid double-export
// of the same constant table).
function canonState(s) {
  const u = String(s || "").toUpperCase();
  if (u === "HTF_BULL_LTF_BULL") return "B";
  if (u === "HTF_BULL_LTF_PULLBACK") return "Bp";
  if (u === "HTF_BEAR_LTF_BEAR") return "R";
  if (u === "HTF_BEAR_LTF_PULLBACK") return "Rp";
  return null;
}
