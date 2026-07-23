// Confirm-stack / family attribution — capture + MFE keep for the thin slice.
// plans/confirm-stack-ema21-slice.plan.md + plans/wow-pnl-adaptive-governor.plan.md

import { computeWindowStats } from "../edge-scorecard.js";

const DAY_MS = 86400000;
const CONFIRM_STACK_FAMILY = "confirm_stack_ema21";

/** Setup display names that historically correlate with confirm-stack fires. */
const CONFIRM_STACK_SETUP_HINTS = new Set([
  "tt pullback reclaim",
  "tt reclaim long",
  "tt momentum push",
  "tt ath breakout",
]);

function parseJson(raw) {
  if (raw == null) return null;
  if (typeof raw === "object") return raw;
  try { return JSON.parse(String(raw)); } catch { return null; }
}

export function isConfirmStackDecision(row) {
  const inputs = parseJson(row?.inputs_json) || {};
  const gates = parseJson(row?.gate_trace_json) || inputs.setup_gates || inputs.gates || {};
  if (inputs.slice_family === CONFIRM_STACK_FAMILY) return true;
  if (inputs.confirm_stack === true) return true;
  if (gates?.stack_full_confirm?.fires === true) return true;
  if (gates?.stack_full_confirm === true) return true;
  return false;
}

export function mfeKeepRate(pnlPct, mfePct) {
  const pnl = Number(pnlPct);
  const mfe = Number(mfePct);
  if (!Number.isFinite(pnl) || !Number.isFinite(mfe) || mfe <= 0) return null;
  return Math.round((pnl / mfe) * 1000) / 1000;
}

/**
 * Pure aggregator used by the API + weekly governor.
 * @param {object} args
 * @param {Array} args.entryDecisions decision_records ENTRY rows
 * @param {Array} args.trades closed/open trades joined by trade_id
 * @param {number|null} args.universeCapturePct from coverage-gaps summary
 */
export function buildFamilyAttributionReport({
  family = CONFIRM_STACK_FAMILY,
  days = 7,
  entryDecisions = [],
  trades = [],
  universeCapturePct = null,
  baselineCapturePct = 4.8,
} = {}) {
  const tradeById = new Map();
  for (const t of trades || []) {
    if (t?.trade_id) tradeById.set(String(t.trade_id), t);
  }

  const familyEntries = [];
  for (const d of entryDecisions || []) {
    if (String(d.event_type || "").toUpperCase() !== "ENTRY") continue;
    if (family === CONFIRM_STACK_FAMILY) {
      if (!isConfirmStackDecision(d)) {
        // Fallback: setup_name hint when provenance predates slice_family stamp.
        const setup = String(d.setup_name || d.inputs_json || "").toLowerCase();
        const hinted = [...CONFIRM_STACK_SETUP_HINTS].some((h) => setup.includes(h));
        if (!hinted) continue;
      }
    } else if (parseJson(d.inputs_json)?.slice_family !== family) {
      continue;
    }
    familyEntries.push(d);
  }

  const closed = [];
  let openN = 0;
  let keepSum = 0;
  let keepN = 0;
  let mfeSum = 0;
  let mfeN = 0;
  const vehicles = {};

  for (const d of familyEntries) {
    const t = tradeById.get(String(d.trade_id || ""));
    if (!t) continue;
    const status = String(t.status || "").toUpperCase();
    const inputs = parseJson(d.inputs_json) || {};
    const vehicle = String(inputs.play_vehicle || inputs.vehicle || "shares");
    vehicles[vehicle] = (vehicles[vehicle] || 0) + 1;

    if (status === "OPEN" || status === "TP_HIT_TRIM") {
      openN++;
      continue;
    }
    if (status !== "WIN" && status !== "LOSS" && status !== "FLAT") continue;

    const mfe = Number(t.max_favorable_excursion ?? t.maxFavorableExcursion ?? t.mfe_pct);
    const pnlPct = Number(t.pnl_pct);
    const keep = mfeKeepRate(pnlPct, mfe);
    if (keep != null) { keepSum += keep; keepN++; }
    if (Number.isFinite(mfe) && mfe > 0) { mfeSum += mfe; mfeN++; }
    closed.push({
      status,
      pnl: Number(t.pnl) || 0,
      pnl_pct: Number.isFinite(pnlPct) ? pnlPct : 0,
      mfe_pct: Number.isFinite(mfe) ? mfe : null,
      keep_rate: keep,
      ticker: t.ticker,
      exit_reason: t.exit_reason,
      setup_name: t.setup_name,
    });
  }

  const stats = computeWindowStats(closed);
  const avgKeep = keepN > 0 ? Math.round((keepSum / keepN) * 1000) / 1000 : null;
  const avgMfe = mfeN > 0 ? Math.round((mfeSum / mfeN) * 100) / 100 : null;
  const familyCapturePct = universeCapturePct != null && Number(universeCapturePct) >= 0
    ? null // universe capture is global; family share reported separately
    : null;

  return {
    ok: true,
    family,
    days,
    entries: familyEntries.length,
    open: openN,
    closed: closed.length,
    stats,
    avg_mfe_pct: avgMfe,
    avg_mfe_keep_rate: avgKeep,
    vehicles,
    universe_capture_rate_pct: universeCapturePct,
    baseline_capture_rate_pct: baselineCapturePct,
    beats_baseline_capture: universeCapturePct != null
      ? Number(universeCapturePct) > baselineCapturePct
      : null,
    sample_closed: closed.slice(0, 12),
    generated_at: Date.now(),
  };
}

/**
 * D1 + KV loader for the admin API / weekly governor.
 */
export async function loadFamilyAttribution(env, opts = {}) {
  const db = env?.DB;
  if (!db) return { ok: false, error: "no_db" };
  const days = Math.min(Math.max(Number(opts.days) || 7, 1), 90);
  const family = String(opts.family || CONFIRM_STACK_FAMILY);
  const since = Date.now() - days * DAY_MS;

  let entryDecisions = [];
  try {
    entryDecisions = (await db.prepare(
      `SELECT decision_id, trade_id, ticker, event_type, ts, reason,
              conviction_tier, inputs_json, gate_trace_json
         FROM decision_records
        WHERE event_type = 'ENTRY' AND ts >= ?1
        ORDER BY ts DESC
        LIMIT 2000`,
    ).bind(since).all())?.results || [];
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }

  const tradeIds = [...new Set(entryDecisions.map((d) => d.trade_id).filter(Boolean))];
  let trades = [];
  if (tradeIds.length) {
    // Chunk IN lists (D1 bind limits).
    for (let i = 0; i < tradeIds.length; i += 80) {
      const chunk = tradeIds.slice(i, i + 80);
      const ph = chunk.map(() => "?").join(",");
      try {
        const rows = (await db.prepare(
          `SELECT trade_id, ticker, status, pnl, pnl_pct, exit_reason, setup_name,
                  max_favorable_excursion, entry_ts, exit_ts
             FROM trades
            WHERE trade_id IN (${ph})`,
        ).bind(...chunk).all())?.results || [];
        trades = trades.concat(rows);
      } catch { /* column may be missing on old schema — retry slim */ 
        try {
          const rows = (await db.prepare(
            `SELECT trade_id, ticker, status, pnl, pnl_pct, exit_reason, setup_name, entry_ts, exit_ts
               FROM trades WHERE trade_id IN (${ph})`,
          ).bind(...chunk).all())?.results || [];
          trades = trades.concat(rows);
        } catch { /* */ }
      }
    }
  }

  let universeCapturePct = null;
  try {
    const kv = env.KV || env.TICKER_KV;
    if (kv?.get) {
      const raw = await kv.get("timed:discovery:coverage-gaps-summary");
      const j = raw ? JSON.parse(raw) : null;
      const cap = j?.capture_rate_pct ?? j?.universe_capture_rate_pct ?? j?.capture_pct;
      if (cap != null && Number.isFinite(Number(cap))) universeCapturePct = Number(cap);
    }
  } catch { /* */ }

  return buildFamilyAttributionReport({
    family,
    days,
    entryDecisions,
    trades,
    universeCapturePct,
  });
}

export { CONFIRM_STACK_FAMILY, DAY_MS };
