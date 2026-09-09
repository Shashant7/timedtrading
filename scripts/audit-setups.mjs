#!/usr/bin/env node
// Read local JSON exports only. No service requests, replay, fitting or mutations.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { canonicalPlayId } from "../worker/foundation/play-catalog.js";

const round = n => Number.isFinite(n) ? Math.round(n * 10000) / 10000 : null;
const num = v => v == null || typeof v === "boolean" || typeof v === "object"
  || (typeof v === "string" && !v.trim()) || !Number.isFinite(Number(v)) ? null : Number(v);
const object = v => {
  if (v && typeof v === "object" && !Array.isArray(v)) return v;
  try { const p = JSON.parse(v); return p && typeof p === "object" && !Array.isArray(p) ? p : null; } catch { return null; }
};
const ts = v => { const n = num(v); return n > 0 ? (n < 1e12 ? n * 1000 : n) : null; };
const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
const day = n => Number.isFinite(n) && n > 0 ? new Date(n).toISOString().slice(0, 10) : null;
const month = n => n ? new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit" }).format(new Date(n)) : "unknown";

function groups(rows, key) {
  const out = new Map();
  for (const row of rows) {
    const k = key(row);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(row);
  }
  return [...out].map(([key, rows]) => ({ key, rows }));
}

export function setupStats(rows) {
  const pnls = rows.map(r => r.pnl).filter(v => v != null);
  const rets = rows.map(r => r.ret).filter(v => v != null);
  const positive = pnls.filter(p => p > 0).reduce((a, b) => a + b, 0);
  const negative = -pnls.filter(p => p < 0).reduce((a, b) => a + b, 0);
  const sorted = [...rets].sort((a, b) => a - b);
  return {
    n: rows.length, pnl_observed: pnls.length, return_observed: rets.length,
    winners: pnls.filter(p => p > 0).length,
    win_rate_pct: pnls.length ? round(100 * pnls.filter(p => p > 0).length / pnls.length) : null,
    reported_pnl_usd: pnls.length ? round(pnls.reduce((a, b) => a + b, 0)) : null,
    profit_factor_usd: negative ? round(positive / negative) : null,
    zero_gross_loss: negative === 0,
    mean_return_pct: round(mean(rets)),
    median_return_pct: sorted.length ? round((sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2) : null,
    tickers: new Set(rows.map(r => r.ticker)).size,
    entry_months: new Set(rows.map(r => r.month)).size,
  };
}

function concentration(rows) {
  const tickers = groups(rows, r => r.ticker).map(g => ({ ticker: g.key, ...setupStats(g.rows) }))
    .sort((a, b) => (b.reported_pnl_usd ?? -Infinity) - (a.reported_pnl_usd ?? -Infinity));
  const best = tickers[0]?.ticker;
  return {
    top_pnl_ticker: best || null,
    top_ticker_stats: tickers[0] || null,
    without_top_pnl_ticker: tickers.length > 1 ? setupStats(rows.filter(r => r.ticker !== best)) : null,
  };
}

function adverse(divergence, side) {
  const obj = object(divergence);
  if (!obj) return "unknown";
  const key = side === "SHORT" ? "bull" : "bear";
  return Object.values(obj).some(row => row?.[key]?.active === true || row?.[key]?.a === true) ? "active" : "not_active_in_snapshot";
}

function contexts(row, snapshot, trace) {
  const l = object(snapshot?.lineage) || {};
  const s = object(trace?.setup_snapshot) || {};
  const dir = row.direction;
  const rvols = [l.rvol?.["30m"], l.rvol?.["1H"], s.rvol_30m, s.rvol_best].map(num).filter(v => v != null && v >= 0);
  const rvol = rvols.length ? Math.max(...rvols) : null;
  const st = [l.supertrend?.D?.d ?? s.st_dir?.D, l.supertrend?.["1H"]?.d ?? s.st_dir?.h1].map(num);
  const stKnown = st.every(v => v === 1 || v === -1);
  const aligned = st.filter(v => v === (dir === "SHORT" ? 1 : -1)).length;
  const displacement = num(l.atr_disp?.week?.d);
  const stAge = num(l.st_bars_since_flip_D);
  return {
    execution_profile: l.execution_profile?.active_profile || l.execution_profile?.name || s.execution_profile || "unknown",
    execution_personality: l.execution_profile?.personality || s.ticker_personality || "unknown",
    learned_personality: l.ticker_character?.learned_profile?.personality || "unknown",
    execution_regime: l.regime_vocabulary?.execution_regime_class || l.regime_class || s.regime_class || "unknown",
    rvol: rvol == null ? "unknown" : rvol < 1 ? "below_1x" : rvol < 2 ? "1_to_2x" : "2x_plus",
    daily_hourly_st: stKnown ? `${aligned}_of_2_aligned` : "unknown",
    adverse_rsi: adverse(l.rsi_divergence, dir),
    adverse_phase: adverse(l.phase_divergence, dir),
    weekly_atr_extension: displacement == null ? "unknown" : Math.abs(displacement) >= 0.618 ? "beyond_0.618_atr" : "within_0.618_atr",
    daily_st_flip_age: stAge == null || stAge < 0 ? "unknown" : stAge <= 3 ? "0_to_3_bars" : stAge <= 15 ? "4_to_15_bars" : "over_15_bars",
    // These exports cannot prove absence, attribution or an ordered history.
    catalyst_asof_verified: "unknown",
    preceding_sequence_verified: "unknown",
  };
}

function matchedContrast(rows, feature, value) {
  const cells = groups(rows.filter(r => r.context[feature] !== "unknown" && r.ret != null), r => `${r.play}|${r.direction}|${r.month}`);
  const usable = cells.map(c => {
    const on = c.rows.filter(r => r.context[feature] === value);
    const off = c.rows.filter(r => r.context[feature] !== value);
    return { on, off };
  }).filter(c => c.on.length >= 3 && c.off.length >= 3);
  let numerator = 0, denominator = 0;
  for (const c of usable) {
    const weight = c.on.length * c.off.length / (c.on.length + c.off.length);
    numerator += weight * (mean(c.on.map(r => r.ret)) - mean(c.off.map(r => r.ret)));
    denominator += weight;
  }
  return {
    setup_side_month_cells_min_3_each: usable.length,
    matched_n: usable.reduce((s, c) => s + c.on.length + c.off.length, 0),
    weighted_return_difference_pp: denominator ? round(numerator / denominator) : null,
    interpretation: "exploratory association; selected entries, no causal or out-of-sample validation",
  };
}

export function auditSetupExport(data, { asOfTs } = {}) {
  if (!(asOfTs > 0)) throw new Error("An explicit as-of timestamp is required");
  const input = Array.isArray(data) ? data : data.trades || data.rows;
  if (!Array.isArray(input)) throw new Error("Expected a trades/rows array");
  const seen = new Set();
  let duplicates = 0, futureExits = 0, unmapped = 0, futureSnapshots = 0;
  const all = [];
  for (const [i, row] of input.entries()) {
    const id = row.trade_id || row.id;
    const key = id ? `${row.run_id || ""}|${id}` : `missing_id_row_${i}`;
    if (seen.has(key)) { duplicates++; continue; }
    seen.add(key);
    const entry = ts(row.entry_ts ?? row.entryTime);
    const exit = ts(row.exit_ts ?? row.exitTime);
    const direction = String(row.direction || "").toUpperCase();
    const play = canonicalPlayId(row.entry_path, row.setup_name, direction);
    if (!play) unmapped++;
    let snap = object(row.signal_snapshot_json);
    let trace = object(row.rank_trace_json ?? row.rankTraceJson);
    const snapTs = ts(snap?.snapshot_ts ?? snap?.ts);
    const traceTs = ts(trace?.setup_snapshot?.evaluation?.as_of_ts ?? trace?.ts);
    // Explicitly later evidence is unusable at entry. Missing timestamps do
    // not prove leakage-free provenance; such history stays exploratory.
    if (entry && snapTs && snapTs > entry) { snap = null; futureSnapshots++; }
    if (entry && traceTs && traceTs > entry) { trace = null; futureSnapshots++; }
    const closedStatus = ["WIN", "LOSS", "FLAT", "CLOSED"].includes(String(row.status || "").toUpperCase());
    if (closedStatus && exit > asOfTs) futureExits++;
    const normalized = {
      ticker: row.ticker || "unknown", play: play || `unmapped:${row.setup_name || "unknown"}`,
      direction, entry, exit, month: month(entry),
      pnl: num(row.pnl), ret: num(row.pnl_pct ?? row.pnlPct),
      closed: closedStatus && exit != null && exit <= asOfTs,
      snapshot: snap != null, lineage: !!object(snap?.lineage),
      rank_trace: trace != null, evaluation: !!trace?.setup_snapshot?.evaluation,
      engine_version: row.script_version || row.scriptVersion || "unknown",
      identity_corrected: !!row.canonical_play_id && row.canonical_play_id !== play,
      context: contexts({ direction }, snap, trace),
    };
    all.push(normalized);
  }
  const closed = all.filter(r => r.closed);
  const bySetup = groups(closed, r => `${r.play}|${r.direction}`).map(g => ({
    setup_side: g.key, ...setupStats(g.rows), ...concentration(g.rows),
  })).sort((a, b) => b.n - a.n);
  const coverage = Object.fromEntries(Object.keys(contexts({}, {}, {})).map(feature => [feature, {
    observed: closed.filter(r => r.context[feature] !== "unknown").length,
    unknown: closed.filter(r => r.context[feature] === "unknown").length,
  }]));
  const conditional = [];
  for (const setup of groups(closed, r => `${r.play}|${r.direction}`).filter(g => g.rows.length >= 10)) {
    for (const feature of Object.keys(coverage)) {
      const bins = groups(setup.rows.filter(r => r.context[feature] !== "unknown"), r => r.context[feature]);
      if (bins.length < 2) continue;
      conditional.push({
        setup_side: setup.key, feature,
        missing: setup.rows.filter(r => r.context[feature] === "unknown").length,
        bins: bins.map(g => ({ value: g.key, ...setupStats(g.rows), ...concentration(g.rows), matched: matchedContrast(setup.rows, feature, g.key) })),
      });
    }
  }
  return {
    as_of: new Date(asOfTs).toISOString(), input_rows: input.length,
    has_more: data.hasMore ?? null, duplicates_removed: duplicates, future_closed_excluded: futureExits,
    future_entry_snapshots_excluded: futureSnapshots,
    unmapped_identity_rows: unmapped, exported_identity_disagreements: all.filter(r => r.identity_corrected).length,
    first_entry: day(Math.min(...all.map(r => r.entry).filter(Boolean))),
    last_entry: day(Math.max(...all.map(r => r.entry).filter(Boolean))),
    last_closed_exit: day(Math.max(...closed.map(r => r.exit).filter(Boolean))),
    closed: setupStats(closed),
    entry_evidence: {
      signal_snapshots: closed.filter(r => r.snapshot).length,
      lineage_snapshots: closed.filter(r => r.lineage).length,
      rank_traces: closed.filter(r => r.rank_trace).length,
      setup_evaluations: closed.filter(r => r.evaluation).length,
    },
    versions: groups(closed, r => r.engine_version).map(g => ({ version: g.key, n: g.rows.length })),
    by_setup_side: bySetup,
    by_entry_month: groups(closed, r => r.month).map(g => ({ month: g.key, ...setupStats(g.rows) })),
    trailing_by_exit: [7, 30, 90].map(days => ({ days, by_setup_side: groups(closed.filter(r => r.exit >= asOfTs - days * 86400000), r => `${r.play}|${r.direction}`).map(g => ({ setup_side: g.key, ...setupStats(g.rows) })) })),
    context_coverage: coverage, conditional_comparisons: conditional,
    limitations: [
      "Executed selected trades only; no rejected-candidate denominator or independent setup overlap rate.",
      "Reported realized dollars use exported accounting; not independently reconciled fees/fills or portfolio returns.",
      "Mean trade return is equal-trade-weighted, not a portfolio return. USD stats depend on sizing and management.",
      "Historical snapshots are exploratory; model/profile calibration vintages and as-of provenance may differ from current runtime.",
      "Matched cells condition on setup, side and entry month only; ticker/regime/selection confounding remains.",
      "Catalyst absence and ordered preceding signals cannot be inferred from missing entry snapshots or static indicator flags.",
      "No threshold fitted, setup paused/promoted, or performance claim validated by this report.",
    ],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const index = args.indexOf("--as-of");
  if (index < 0) throw new Error("Usage: audit-setups.mjs --as-of ISO_TIMESTAMP export.json [...export.json]");
  const asOfTs = Date.parse(args[index + 1]);
  args.splice(index, 2);
  if (!args.length) throw new Error("At least one export is required");
  const sources = args.map(file => {
    const raw = fs.readFileSync(file, "utf8");
    return { file: path.basename(file), sha256: crypto.createHash("sha256").update(raw).digest("hex"), ...auditSetupExport(JSON.parse(raw), { asOfTs }) };
  });
  process.stdout.write(JSON.stringify({ audit_version: "setup-audit-v1", sources }, null, 2) + "\n");
}
