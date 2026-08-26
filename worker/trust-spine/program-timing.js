// Program-timing scan — slice filled entries by experiment (program) and
// clock. Observational: among fills that already happened, which session /
// hour / weekday printed the best MFE and the least MAE.
// This is NOT a counterfactual replay of "what if entry was 30m later."

import { computeWindowStats } from "../edge-scorecard.js";
import { tradeIsForeignCoreSetup } from "../foundation/tt-cloud-pivot.js";

export const CONFIRM_STACK_FAMILY = "confirm_stack_ema21";
export const CLOUD_PIVOT_FAMILY = "tt_cloud_pivot";
export const CONTINUATION_FAMILY = "momentum_continuation";
export const CORE_PROGRAM = "core";

export const PROGRAM_LABELS = Object.freeze({
  [CONFIRM_STACK_FAMILY]: "Confirm-stack",
  [CLOUD_PIVOT_FAMILY]: "Cloud Pivot",
  [CONTINUATION_FAMILY]: "Continuation",
  [CORE_PROGRAM]: "Core book",
});

export const PROGRAM_ORDER = Object.freeze([
  CONFIRM_STACK_FAMILY,
  CLOUD_PIVOT_FAMILY,
  CONTINUATION_FAMILY,
  CORE_PROGRAM,
]);

const SESSION_DEFS = [
  { key: "premarket", start: 0, end: 9 * 60 + 30, label: "Premarket" },
  { key: "open", start: 9 * 60 + 30, end: 10 * 60, label: "Open 9:30–10:00" },
  { key: "ten_am", start: 10 * 60, end: 10 * 60 + 45, label: "10am 10:00–10:45" },
  { key: "midday", start: 10 * 60 + 45, end: 13 * 60 + 30, label: "Midday 10:45–13:30" },
  { key: "afternoon", start: 13 * 60 + 30, end: 15 * 60, label: "Afternoon 13:30–15:00" },
  { key: "last_hour", start: 15 * 60, end: 16 * 60, label: "Last hour 15:00–16:00" },
  { key: "afterhours", start: 16 * 60, end: 24 * 60, label: "After hours" },
];

const RTH_START = 9 * 60 + 30;

function parseJson(raw) {
  if (raw == null) return null;
  if (typeof raw === "object") return raw;
  try { return JSON.parse(String(raw)); } catch { return null; }
}

function setupBlob(decision, trade) {
  return `${decision?.setup_name || ""} ${trade?.setup_name || ""} ${
    typeof decision?.inputs_json === "string" ? decision.inputs_json : JSON.stringify(decision?.inputs_json || "")
  } ${typeof decision?.gate_trace_json === "string" ? decision.gate_trace_json : JSON.stringify(decision?.gate_trace_json || "")}`.toLowerCase();
}

function mfeKeepRate(pnlPct, mfePct) {
  const pnl = Number(pnlPct);
  const mfe = Number(mfePct);
  if (!Number.isFinite(pnl) || !Number.isFinite(mfe) || mfe <= 0) return null;
  return Math.round((pnl / mfe) * 1000) / 1000;
}

/**
 * Assign a fill to a paper experiment or the core book.
 * Confirm-stack wins ties (same priority as the live queue).
 */
export function classifyProgram(decision = {}, trade = {}) {
  const inputs = parseJson(decision.inputs_json) || {};
  const gates = parseJson(decision.gate_trace_json) || inputs.setup_gates || inputs.gates || {};
  const stamped = trade.slice_family || trade.entry_family || inputs.slice_family;
  const blob = setupBlob(decision, trade);
  // A trade whose executed setup is a canonical core play is CORE, even if a
  // coincident cloud-pivot stamp rode along — keeps the paper timing report
  // measuring the cloud-pivot doctrine, not core setups it merely tagged.
  const foreignCore = tradeIsForeignCoreSetup(trade);
  if (stamped === CONFIRM_STACK_FAMILY) return CONFIRM_STACK_FAMILY;
  if (stamped === CLOUD_PIVOT_FAMILY && !foreignCore) return CLOUD_PIVOT_FAMILY;
  if (stamped === CONTINUATION_FAMILY) return CONTINUATION_FAMILY;
  if (
    inputs.slice_family === CONFIRM_STACK_FAMILY
    || inputs.confirm_stack === true
    || gates?.stack_full_confirm?.fires === true
    || gates?.stack_full_confirm === true
    || blob.includes("confirm_stack")
    || blob.includes("confirm-stack")
  ) {
    return CONFIRM_STACK_FAMILY;
  }
  if (
    !foreignCore
    && (
      inputs.slice_family === CLOUD_PIVOT_FAMILY
      || inputs.tt_cloud_pivot === true
      || inputs.sequence_paper_queue?.family === CLOUD_PIVOT_FAMILY
      || blob.includes("tt_cloud_pivot")
      || blob.includes("cloud pivot")
      || blob.includes("cloud_pivot")
    )
  ) {
    return CLOUD_PIVOT_FAMILY;
  }
  if (
    inputs.slice_family === CONTINUATION_FAMILY
    || inputs.momentum_continuation === true
    || inputs.sequence_paper_queue?.family === CONTINUATION_FAMILY
    || blob.includes("momentum_continuation")
  ) {
    return CONTINUATION_FAMILY;
  }
  return CORE_PROGRAM;
}

export function etParts(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = n < 1e12 ? n * 1000 : n;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(new Date(ms));
  const get = (t) => parts.find((p) => p.type === t)?.value;
  let hour = Number(get("hour"));
  const minute = Number(get("minute"));
  if (hour === 24) hour = 0;
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return {
    weekday: String(get("weekday") || ""),
    hour,
    minute,
    minutes: hour * 60 + minute,
  };
}

export function classifySession(minutes) {
  if (!Number.isFinite(minutes)) return { key: "unknown", label: "Unknown" };
  for (const s of SESSION_DEFS) {
    if (minutes >= s.start && minutes < s.end) return { key: s.key, label: s.label };
  }
  return { key: "unknown", label: "Unknown" };
}

export function classifyRthOffset(minutes) {
  if (!Number.isFinite(minutes)) return { key: "unknown", label: "Unknown" };
  const off = minutes - RTH_START;
  if (off < 0 || minutes >= 16 * 60) return { key: "off_session", label: "Off session" };
  if (off < 15) return { key: "first_15", label: "First 15m" };
  if (off < 45) return { key: "open_drive", label: "Open drive 15–45m" };
  if (off < 120) return { key: "morning", label: "Morning 45–120m" };
  if (off < 240) return { key: "midday", label: "Midday 2–4h" };
  if (off < 330) return { key: "afternoon", label: "Afternoon 4–5.5h" };
  return { key: "last_hour", label: "Last hour" };
}

export function classifyClock(ts) {
  const p = etParts(ts);
  if (!p) {
    return {
      session: "unknown",
      session_label: "Unknown",
      rth_offset: "unknown",
      rth_offset_label: "Unknown",
      weekday: "—",
      hour_et: null,
    };
  }
  const session = classifySession(p.minutes);
  const rth = classifyRthOffset(p.minutes);
  return {
    session: session.key,
    session_label: session.label,
    rth_offset: rth.key,
    rth_offset_label: rth.label,
    weekday: p.weekday,
    hour_et: p.hour,
    minutes_et: p.minutes,
  };
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function absMae(v) {
  const n = numOrNull(v);
  return n == null ? null : Math.abs(n);
}

function mean(arr) {
  if (!arr.length) return null;
  return Math.round((arr.reduce((s, x) => s + x, 0) / arr.length) * 1000) / 1000;
}

function summarizeFills(fills) {
  const closed = fills.filter((f) => f.closed);
  const mfe = closed.map((f) => f.mfe).filter((v) => v != null && v > 0);
  const mae = closed.map((f) => f.mae).filter((v) => v != null);
  const keep = closed.map((f) => f.keep).filter((v) => v != null);
  const stats = computeWindowStats(closed.map((f) => ({
    status: f.status,
    pnl: f.pnl,
    pnl_pct: f.pnl_pct,
  })));
  const avgMfe = mean(mfe);
  const avgMae = mean(mae);
  const edge = avgMfe != null && avgMae != null
    ? Math.round((avgMfe - avgMae) * 1000) / 1000
    : null;
  const ratio = avgMfe != null && avgMae != null && avgMae > 0
    ? Math.round((avgMfe / avgMae) * 100) / 100
    : (avgMfe != null && avgMae === 0 ? 99 : null);
  return {
    n: fills.length,
    open: fills.length - closed.length,
    closed: closed.length,
    avg_mfe_pct: avgMfe,
    avg_mae_pct: avgMae,
    mfe_mae_edge: edge,
    mfe_mae_ratio: ratio,
    avg_mfe_keep_rate: mean(keep),
    stats,
  };
}

function groupBy(fills, keyFn) {
  const map = new Map();
  for (const f of fills) {
    const key = keyFn(f);
    if (key == null || key === "") continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(f);
  }
  return map;
}

function rankBuckets(map, { minN = 3, labelFn } = {}) {
  const rows = [];
  for (const [key, fills] of map.entries()) {
    const stats = summarizeFills(fills);
    rows.push({
      key,
      label: labelFn ? labelFn(key, fills) : key,
      ...stats,
      thin: stats.closed < minN,
    });
  }
  rows.sort((a, b) => {
    const ae = a.mfe_mae_edge;
    const be = b.mfe_mae_edge;
    if (ae == null && be == null) return b.closed - a.closed;
    if (ae == null) return 1;
    if (be == null) return -1;
    if (be !== ae) return be - ae;
    const am = a.avg_mae_pct ?? 99;
    const bm = b.avg_mae_pct ?? 99;
    if (am !== bm) return am - bm;
    return (b.avg_mfe_pct ?? 0) - (a.avg_mfe_pct ?? 0);
  });
  const qualified = rows.filter((r) => !r.thin && r.mfe_mae_edge != null);
  return {
    buckets: rows,
    best: (qualified[0] || rows.find((r) => r.mfe_mae_edge != null) || null),
    worst: (qualified.length
      ? qualified[qualified.length - 1]
      : rows.filter((r) => r.mfe_mae_edge != null).slice(-1)[0] || null),
  };
}

function joinFills(entryDecisions = [], trades = []) {
  const tradeById = new Map();
  for (const t of trades || []) {
    if (t?.trade_id) tradeById.set(String(t.trade_id), t);
  }
  const used = new Set();
  const fills = [];

  for (const d of entryDecisions || []) {
    if (String(d.event_type || "ENTRY").toUpperCase() !== "ENTRY") continue;
    const t = tradeById.get(String(d.trade_id || ""));
    if (t) used.add(String(t.trade_id));
    const src = t || {};
    const status = String(src.status || "").toUpperCase();
    const closed = status === "WIN" || status === "LOSS" || status === "FLAT";
    const mfe = numOrNull(src.max_favorable_excursion ?? src.maxFavorableExcursion ?? src.mfe_pct);
    const mae = absMae(src.max_adverse_excursion ?? src.maxAdverseExcursion ?? src.mae_pct);
    const pnlPct = numOrNull(src.pnl_pct);
    const entryTs = numOrNull(src.entry_ts ?? d.ts);
    const clock = classifyClock(entryTs);
    fills.push({
      trade_id: src.trade_id || d.trade_id || null,
      ticker: src.ticker || d.ticker || null,
      program: classifyProgram(d, src),
      status,
      closed,
      open: status === "OPEN" || status === "TP_HIT_TRIM",
      pnl: numOrNull(src.pnl) || 0,
      pnl_pct: pnlPct || 0,
      mfe: mfe != null && mfe > 0 ? mfe : null,
      mae,
      keep: mfeKeepRate(pnlPct, mfe),
      entry_ts: entryTs,
      ...clock,
    });
  }

  for (const t of trades || []) {
    const id = t?.trade_id ? String(t.trade_id) : null;
    if (id && used.has(id)) continue;
    const status = String(t.status || "").toUpperCase();
    const closed = status === "WIN" || status === "LOSS" || status === "FLAT";
    const mfe = numOrNull(t.max_favorable_excursion ?? t.maxFavorableExcursion ?? t.mfe_pct);
    const mae = absMae(t.max_adverse_excursion ?? t.maxAdverseExcursion ?? t.mae_pct);
    const pnlPct = numOrNull(t.pnl_pct);
    const entryTs = numOrNull(t.entry_ts);
    const clock = classifyClock(entryTs);
    fills.push({
      trade_id: t.trade_id || null,
      ticker: t.ticker || null,
      program: classifyProgram({}, t),
      status,
      closed,
      open: status === "OPEN" || status === "TP_HIT_TRIM",
      pnl: numOrNull(t.pnl) || 0,
      pnl_pct: pnlPct || 0,
      mfe: mfe != null && mfe > 0 ? mfe : null,
      mae,
      keep: mfeKeepRate(pnlPct, mfe),
      entry_ts: entryTs,
      ...clock,
    });
  }

  return fills;
}

function programBlock(program, fills, minN) {
  const session = rankBuckets(groupBy(fills, (f) => f.session), {
    minN,
    labelFn: (key, rows) => rows[0]?.session_label || key,
  });
  const hour = rankBuckets(groupBy(fills, (f) => f.hour_et == null ? null : String(f.hour_et)), {
    minN,
    labelFn: (key) => `${key}:00 ET`,
  });
  const weekday = rankBuckets(groupBy(fills, (f) => f.weekday), { minN });
  const rth = rankBuckets(groupBy(fills, (f) => f.rth_offset), {
    minN,
    labelFn: (key, rows) => rows[0]?.rth_offset_label || key,
  });
  return {
    program,
    label: PROGRAM_LABELS[program] || program,
    overall: summarizeFills(fills),
    by_session: session,
    by_hour: hour,
    by_weekday: weekday,
    by_rth_offset: rth,
    ideal: {
      session: session.best,
      hour: hour.best,
      weekday: weekday.best,
      rth_offset: rth.best,
    },
    avoid: {
      session: session.worst,
      hour: hour.worst,
    },
  };
}

/**
 * @param {object} args
 * @param {Array} args.entryDecisions
 * @param {Array} args.trades
 * @param {number} [args.days]
 * @param {number} [args.minN] closed fills required to crown a bucket
 */
export function buildProgramTimingReport({
  entryDecisions = [],
  trades = [],
  days = 30,
  minN = 3,
} = {}) {
  const fills = joinFills(entryDecisions, trades);
  const programs = {};
  for (const program of PROGRAM_ORDER) {
    const subset = fills.filter((f) => f.program === program);
    programs[program] = programBlock(program, subset, minN);
  }

  const ideals = PROGRAM_ORDER
    .map((p) => {
      const block = programs[p];
      const session = block.ideal.session;
      if (!session || session.closed === 0) return null;
      return {
        program: p,
        label: block.label,
        session: session.label,
        session_key: session.key,
        hour: block.ideal.hour?.label || null,
        weekday: block.ideal.weekday?.key || null,
        n: session.closed,
        avg_mfe_pct: session.avg_mfe_pct,
        avg_mae_pct: session.avg_mae_pct,
        mfe_mae_edge: session.mfe_mae_edge,
        thin: session.thin,
      };
    })
    .filter(Boolean);

  return {
    ok: true,
    days,
    min_n: minN,
    fills: fills.length,
    closed: fills.filter((f) => f.closed).length,
    programs,
    ideals,
    note: "Observational on filled clocks — not a counterfactual replay of delayed/early entry.",
    generated_at: Date.now(),
  };
}

export { SESSION_DEFS };
