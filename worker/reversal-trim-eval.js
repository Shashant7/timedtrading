// ═══════════════════════════════════════════════════════════════════════════
// worker/reversal-trim-eval.js — Reversal-Trim Advisor, Phase 2 (measure).
//
// Phase 1 (shadow advisor) emits "trim N% near the high" advisories on open
// winners showing reversal risk (worker/timing-signals.js →
// evaluateReversalTrimAdvisory, wired in the scoring-cron tail). This module
// closes the measurement loop so enforcement (Phase 3) is a data-backed
// decision instead of a vibe:
//
//   1. HISTORY — first advisory per trade is recorded in KV
//      `timed:reversal-trim:history` (what the advisor said, at what pnl).
//   2. SCORECARD — nightly (0 4 * * * lifecycle arm) each history entry
//      whose trade has since CLOSED is scored mechanically:
//        saved_pct      = advisory_pnl_pct − exit_pnl_pct
//          (> 0 → trimming at the advisory beat the actual exit;
//           < 0 → the advisory would have cut a winner that kept running)
//        weighted_saved = suggested_trim_pct × saved_pct
//          (the advisory only suggests a PARTIAL trim, so the realistic
//           P&L impact is the suggested fraction times the delta)
//      Aggregates land in KV `timed:reversal-trim:scorecard` and surface at
//      GET /timed/admin/reversal-trim/scorecard.
//
// Plan: tasks/2026-06-10-reversal-trim-plan.md. Promotion rule of thumb:
// enforce only when weighted_saved is positive over ≥20 evaluated
// advisories with hurt_count/evaluated below ~1/3.
// ═══════════════════════════════════════════════════════════════════════════

import { kvGetJSON, kvPutJSON } from "./storage.js";

export const REVERSAL_TRIM_HISTORY_KEY = "timed:reversal-trim:history";
export const REVERSAL_TRIM_SCORECARD_KEY = "timed:reversal-trim:scorecard";
const HISTORY_CAP = 300;

// ─── Pure: merge the current advisory set into the history map ──────────────
// history shape: { entries: { [trade_id]: rec }, updated_at }
// rec: { trade_id, ticker, direction, first_ts, last_seen_ts,
//        advisory_pnl_pct (at FIRST advisory), peak_pnl_pct,
//        suggested_trim_pct, strength, price, entry_price,
//        outcome: null | { exit_ts, exit_pnl_pct, saved_pct, weighted_saved_pct } }
export function updateReversalTrimHistory(history, advisoryResult, now = Date.now()) {
  const entries = { ...(history?.entries || {}) };
  let changed = false;
  for (const a of (advisoryResult?.advisories || [])) {
    const id = a?.trade_id != null ? String(a.trade_id) : null;
    if (!id) continue;
    const prev = entries[id];
    if (!prev) {
      entries[id] = {
        trade_id: id,
        ticker: a.ticker,
        direction: a.direction,
        first_ts: now,
        last_seen_ts: now,
        advisory_pnl_pct: a.pnl_pct,
        peak_pnl_pct: a.pnl_pct,
        suggested_trim_pct: a.suggested_trim_pct,
        strength: a.strength,
        price: a.price,
        entry_price: a.entry_price,
        reasons: a.reasons,
        outcome: null,
      };
      changed = true;
    } else if (!prev.outcome) {
      const peak = Math.max(Number(prev.peak_pnl_pct) || 0, Number(a.pnl_pct) || 0);
      if (peak !== prev.peak_pnl_pct || now - (prev.last_seen_ts || 0) > 60_000) {
        entries[id] = {
          ...prev,
          last_seen_ts: now,
          peak_pnl_pct: peak,
          // strength can upgrade as more reasons stack
          strength: prev.strength === "strong" ? "strong" : a.strength,
        };
        changed = true;
      }
    }
  }
  // Cap by recency of first advisory.
  const ids = Object.keys(entries);
  if (ids.length > HISTORY_CAP) {
    ids.sort((x, y) => (entries[y].first_ts || 0) - (entries[x].first_ts || 0));
    for (const id of ids.slice(HISTORY_CAP)) delete entries[id];
    changed = true;
  }
  return { changed, history: { entries, updated_at: now } };
}

// ─── Pure: stamp closed-trade outcomes + compute the aggregate scorecard ────
// closedTradeById: { [trade_id]: { exit_ts, exit_price, pnl_pct, entry_price, direction, status } }
export function computeReversalTrimScorecard(history, closedTradeById = {}, now = Date.now()) {
  const entries = { ...(history?.entries || {}) };
  let stamped = 0;
  for (const id of Object.keys(entries)) {
    const rec = entries[id];
    if (rec.outcome) continue;
    const t = closedTradeById[id];
    if (!t) continue;
    const status = String(t.status || "").toUpperCase();
    if (status === "OPEN" || status === "TP_HIT_TRIM") continue;
    let exitPnlPct = Number(t.pnl_pct);
    if (!Number.isFinite(exitPnlPct)) {
      const entry = Number(t.entry_price ?? rec.entry_price) || 0;
      const exitPx = Number(t.exit_price) || 0;
      if (entry > 0 && exitPx > 0) {
        const isLong = String(t.direction || rec.direction || "LONG").toUpperCase() !== "SHORT";
        exitPnlPct = isLong ? ((exitPx - entry) / entry) * 100 : ((entry - exitPx) / entry) * 100;
      }
    }
    if (!Number.isFinite(exitPnlPct)) continue;
    const savedPct = Math.round(((rec.advisory_pnl_pct || 0) - exitPnlPct) * 100) / 100;
    entries[id] = {
      ...rec,
      outcome: {
        exit_ts: t.exit_ts || null,
        exit_pnl_pct: Math.round(exitPnlPct * 100) / 100,
        saved_pct: savedPct,
        weighted_saved_pct: Math.round(savedPct * (rec.suggested_trim_pct || 0.25) * 100) / 100,
      },
    };
    stamped++;
  }

  const done = Object.values(entries).filter((r) => r.outcome);
  const pending = Object.values(entries).filter((r) => !r.outcome).length;
  const saved = done.map((r) => r.outcome.saved_pct).sort((a, b) => a - b);
  const sum = (arr) => arr.reduce((s, v) => s + v, 0);
  const scorecard = {
    generated_at: now,
    evaluated: done.length,
    pending,
    stamped_this_run: stamped,
    avg_saved_pct: done.length ? Math.round((sum(saved) / done.length) * 100) / 100 : null,
    median_saved_pct: done.length ? saved[Math.floor(saved.length / 2)] : null,
    avg_weighted_saved_pct: done.length
      ? Math.round((sum(done.map((r) => r.outcome.weighted_saved_pct)) / done.length) * 100) / 100
      : null,
    helped: done.filter((r) => r.outcome.saved_pct > 0.5).length,
    hurt: done.filter((r) => r.outcome.saved_pct < -0.5).length,
    neutral: done.filter((r) => Math.abs(r.outcome.saved_pct) <= 0.5).length,
    verdict: done.length >= 20
      ? (sum(done.map((r) => r.outcome.weighted_saved_pct)) > 0
          && done.filter((r) => r.outcome.saved_pct < -0.5).length / done.length < 1 / 3
          ? "ENFORCEMENT_SUPPORTED"
          : "ENFORCEMENT_NOT_SUPPORTED")
      : "INSUFFICIENT_SAMPLE",
  };
  return { history: { entries, updated_at: now }, scorecard };
}

// ─── Impure orchestrator — nightly evaluation (0 4 * * * lifecycle arm) ─────
export async function evaluateReversalTrimScorecard(env) {
  const KV = env?.KV_TIMED;
  const db = env?.DB;
  if (!KV || !db) return { ok: false, skipped: "missing_kv_or_db" };
  const history = (await kvGetJSON(KV, REVERSAL_TRIM_HISTORY_KEY)) || { entries: {} };
  const pendingIds = Object.values(history.entries || {})
    .filter((r) => !r.outcome)
    .map((r) => String(r.trade_id));
  const closedById = {};
  // Bounded lookups: ≤ HISTORY_CAP single-row reads, batched 50 at a time.
  for (let i = 0; i < pendingIds.length; i += 50) {
    const chunk = pendingIds.slice(i, i + 50);
    try {
      const stmts = chunk.map((id) => db.prepare(
        `SELECT trade_id, direction, entry_price, exit_ts, exit_price, pnl_pct, status
         FROM trades WHERE trade_id = ?1 LIMIT 1`
      ).bind(id));
      const results = await db.batch(stmts);
      for (const res of results) {
        const row = res?.results?.[0];
        if (row?.trade_id != null) closedById[String(row.trade_id)] = row;
      }
    } catch (e) {
      console.warn("[REVERSAL_TRIM_EVAL] D1 chunk failed:", String(e?.message || e).slice(0, 150));
    }
  }
  const { history: stamped, scorecard } = computeReversalTrimScorecard(history, closedById);
  await kvPutJSON(KV, REVERSAL_TRIM_HISTORY_KEY, stamped);
  await kvPutJSON(KV, REVERSAL_TRIM_SCORECARD_KEY, scorecard);
  console.log(`[REVERSAL_TRIM_EVAL] evaluated=${scorecard.evaluated} pending=${scorecard.pending} stamped=${scorecard.stamped_this_run} verdict=${scorecard.verdict}`);
  return { ok: true, scorecard };
}
