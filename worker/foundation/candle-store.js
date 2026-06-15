// worker/foundation/candle-store.js
// ─────────────────────────────────────────────────────────────────────────────
//  ADDITIVE candle store — incremental materialization.
//
//  The chain's correctness comes from deriving every TF from ONE 5m base (no
//  per-TF drift). The PERFORMANCE comes from doing that derive INCREMENTALLY:
//  when new 5m bars land we re-resample only the recent TAIL (the buckets the new
//  bars touch) and UPSERT them into a stored, bounded per-TF series. Reads then
//  slice that materialized series (O(N)) — no full-base scan, no per-read resample.
//
//  Invariant (the guardrail, enforced by tests): for any sequence of incremental
//  ingests, the materialized series MUST equal a from-scratch resample of the full
//  base over the same window. Session-anchored buckets make this hold as long as
//  the tail starts on a session boundary (tailBase5 returns whole ET sessions).
//
//  Pure: no storage, no I/O. The shard DO supplies/persists the arrays.
// ─────────────────────────────────────────────────────────────────────────────

import { resampleIntradaySessions, resampleDailyToWeekly, resampleDailyToMonthly } from "./resample.js";
import { defaultSessionClip, normalizeDailyBars, DERIVED_INTRADAY_TFS } from "./candle-chain.js";
import { etDateStr } from "./trading-calendar.js";

export const DEFAULT_MATERIALIZE_CAP = 600; // ≥ 60m EMA200 (≈325 bars) with margin
export const DEFAULT_TAIL_DAYS = 2;          // re-derive the last 2 ET sessions per ingest

/**
 * Upsert `incoming` bars into `existing` by ts (incoming wins on a tie — it's the
 * fresher recompute of a forming/late bucket), keep sorted ascending, and bound to
 * the last `cap` bars. Pure; returns a new array.
 */
export function upsertSeries(existing, incoming, cap = 0) {
  const map = new Map();
  for (const b of existing || []) if (b && Number.isFinite(b.ts)) map.set(b.ts, b);
  for (const b of incoming || []) if (b && Number.isFinite(b.ts)) map.set(b.ts, b);
  let out = [...map.values()].sort((a, b) => a.ts - b.ts);
  if (cap > 0 && out.length > cap) out = out.slice(-cap);
  return out;
}

/**
 * The last `tailDays` ET SESSIONS of a 5m base (whole sessions, so the tail starts
 * on a session boundary → its resample buckets align with a full resample's).
 */
export function tailBase5(base5, tailDays = DEFAULT_TAIL_DAYS) {
  if (!Array.isArray(base5) || base5.length === 0) return [];
  const sorted = [...base5].sort((a, b) => a.ts - b.ts);
  const keepDays = new Set();
  for (let i = sorted.length - 1; i >= 0 && keepDays.size < tailDays; i--) {
    keepDays.add(etDateStr(sorted[i].ts));
  }
  return sorted.filter((b) => keepDays.has(etDateStr(b.ts)));
}

/**
 * Incrementally update one intraday TF's materialized series: re-resample only the
 * recent tail of the 5m base and upsert the produced buckets. O(tail), independent
 * of history depth. Per-TF session policy (extended-hours for 5/10/15/30, RTH for
 * 60/240) via defaultSessionClip unless `sessionClip` is given.
 */
export function materializeIntraday(materialized, base5, tf, opts = {}) {
  const tailDays = opts.tailDays || DEFAULT_TAIL_DAYS;
  const cap = opts.cap || DEFAULT_MATERIALIZE_CAP;
  const clip = opts.sessionClip !== undefined ? opts.sessionClip : defaultSessionClip(tf);
  // `full` (backfill / cold-start): resample the ENTIRE base. Otherwise only the
  // recent tail (the additive steady state — buckets the new bars touch).
  const src = opts.full ? (Array.isArray(base5) ? base5 : []) : tailBase5(base5, tailDays);
  const recent = resampleIntradaySessions(src, Number(tf), { clipToSession: clip });
  return upsertSeries(materialized, recent, cap);
}

/**
 * Materialize ALL intraday TFs from a 5m base (incremental tail). Returns
 * { tf: series }. `prev` carries the existing materialized series to upsert into.
 */
export function materializeAllIntraday(prev, base5, opts = {}) {
  const tfs = opts.tfs || DERIVED_INTRADAY_TFS;
  const out = {};
  for (const tf of tfs) out[tf] = materializeIntraday((prev && prev[tf]) || [], base5, tf, opts);
  return out;
}

/**
 * W/M from the daily base. The daily base is small (years fit in a few hundred
 * bars), so a full re-derive each ingest is already cheap + always correct.
 */
export function materializeDailyDerived(baseDaily, tf, opts = {}) {
  const cap = opts.cap || DEFAULT_MATERIALIZE_CAP;
  const norm = normalizeDailyBars(baseDaily || []);
  if (String(tf) === "W") return resampleDailyToWeekly(norm).slice(-cap);
  if (String(tf) === "M") return resampleDailyToMonthly(norm).slice(-cap);
  return [];
}

/** Slice a materialized series to a window + limit (the hot read path). */
export function readMaterialized(series, { startMs, endMs, limit } = {}) {
  let out = Array.isArray(series) ? series : [];
  if (Number.isFinite(startMs)) out = out.filter((b) => b.ts >= startMs);
  if (Number.isFinite(endMs)) out = out.filter((b) => b.ts < endMs);
  if (Number.isFinite(limit) && limit > 0 && out.length > limit) out = out.slice(-limit);
  return out;
}

/** Newest ts in a base (the additive ingest cursor). 0 when empty. */
export function cursorTs(bars) {
  let mx = 0;
  for (const b of bars || []) { const t = Number(b?.ts) || 0; if (t > mx) mx = t; }
  return mx;
}
