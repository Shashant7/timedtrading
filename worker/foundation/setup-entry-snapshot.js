// worker/foundation/setup-entry-snapshot.js
// -----------------------------------------------------------------------------
// Tier 1: legacy rank_trace_json.setup_snapshot -> synthetic entry diagnostics.
// Exploratory / shadow only — not for calibration promotion until parity gate.
// -----------------------------------------------------------------------------

import { createSetupEvent, normalizeSetupEvents } from "./setup-events.js";
import { deriveSetupEvents } from "./setup-event-derivation.js";
import { detectMeanReversionSequences } from "./setup-sequences.js";
import { buildDiagnosticsContext, summarizeTraderPosture } from "./setup-diagnostics-route.js";

export const LEGACY_ANALYSIS_MODE = "legacy_entry_snapshot";

function stageBucket(stage) {
  const s = Number(stage) || 0;
  if (s >= 8) return "8_entry_ready";
  if (s >= 5) return "5_7_confirmed";
  if (s >= 1) return "1_4_forming";
  return "0_none";
}

const DISCOUNT_ZONES = new Set(["discount", "discount_approach"]);
const PREMIUM_ZONES = new Set(["premium", "premium_approach"]);

export function parseRankTraceJson(raw) {
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function mapTdSeqToPerTf(tdSeq = {}) {
  const out = {};
  for (const [tf, row] of Object.entries(tdSeq)) {
    if (!row || typeof row !== "object") continue;
    out[tf] = {
      bullish_prep_count: Number(row.bull_prep ?? row.bullish_prep_count) || 0,
      bearish_prep_count: Number(row.bear_prep ?? row.bearish_prep_count) || 0,
      bullish_leadup_count: Number(row.bull_leadup ?? row.bullish_leadup_count) || 0,
      bearish_leadup_count: Number(row.bear_leadup ?? row.bearish_leadup_count) || 0,
      td9_bullish: !!(row.td9_bull ?? row.td9_bullish),
      td9_bearish: !!(row.td9_bear ?? row.td9_bearish),
      td13_bullish: !!(row.td13_bull ?? row.td13_bullish),
      td13_bearish: !!(row.td13_bear ?? row.td13_bearish),
    };
  }
  return out;
}

function tfTechFromSetupSnapshot(ss = {}) {
  const tfTech = {};
  const st = ss.st_dir || {};
  const rsi = ss.rsi || {};
  const pdz = ss.pdz || {};
  const mapSt = (tf, key) => {
    const v = st[key];
    if (v == null) return;
    tfTech[tf] = tfTech[tf] || {};
    tfTech[tf].stDir = Number(v);
  };
  mapSt("D", "D");
  mapSt("60", "h1");
  mapSt("240", "h4");
  mapSt("30", "m30");
  for (const [key, val] of Object.entries(rsi)) {
    const tf = key === "D" ? "D" : key === "h1" ? "60" : key === "m30" ? "30" : key;
    tfTech[tf] = tfTech[tf] || {};
    tfTech[tf].rsi = { r5: Number(val) };
  }
  if (pdz.D) {
    tfTech.D = tfTech.D || {};
    tfTech.D.pdz = { zone: pdz.D };
  }
  if (pdz.h4 || pdz["4h"]) {
    tfTech["240"] = tfTech["240"] || {};
    tfTech["240"].pdz = { zone: pdz.h4 || pdz["4h"] };
  }
  return tfTech;
}

export function snapshotFromRankTrace(rankTrace, trade = {}) {
  const rt = parseRankTraceJson(rankTrace);
  if (!rt) return null;
  const ss = rt.setup_snapshot || {};
  const entryTs = Number(trade.entry_ts ?? trade.entryTs ?? rt.ts);
  if (!Number.isFinite(entryTs)) return null;
  const sym = String(trade.ticker || rt.ticker || "").toUpperCase();
  if (!sym) return null;

  return {
    ticker: sym,
    ts: entryTs,
    event_ts: entryTs,
    state: ss.state || rt.state || null,
    setup_snapshot: ss,
    td_sequential: { per_tf: mapTdSeqToPerTf(ss.td_seq || {}) },
    tf_tech: tfTechFromSetupSnapshot(ss),
    pdz_zone_D: ss.pdz?.D || null,
    pdz_zone_4h: ss.pdz?.h4 || ss.pdz?.["4h"] || null,
    phase_pct: Number(rt.phase ?? ss.phase_pct) || null,
    htf_score: Number(ss.htf_score ?? rt.htf) || null,
    ltf_score: Number(ss.ltf_score ?? rt.ltf) || null,
    regime_class: ss.regime_class || null,
    _snapshot_source: "legacy_rank_trace",
    _analysis_mode: LEGACY_ANALYSIS_MODE,
  };
}

export function inferStaticEventsFromSnapshot(snapshot, direction, opts = {}) {
  if (!snapshot) return [];
  const dir = String(direction || "LONG").toUpperCase();
  const ticker = snapshot.ticker;
  const ts = Number(snapshot.ts ?? snapshot.event_ts);
  const source = opts.source || "legacy_static_entry";
  const ss = snapshot.setup_snapshot || {};
  const td = ss.td_seq || {};
  const pdzD = String(ss.pdz?.D || "").toLowerCase();
  const events = [];

  const tdD = td.D || {};
  const tdW = td.W || {};

  if (dir === "LONG") {
    const prep = Math.max(Number(tdD.bull_prep) || 0, Number(tdW.bull_prep) || 0);
    if (prep >= 7) {
      events.push(createSetupEvent({
        ticker, tf: "D", event_ts: ts, event_type: "td_setup_progress", direction: "LONG",
        source, payload: { bull_prep: prep, static: true },
      }));
    }
    if (tdD.td9_bull || tdW.td9_bull) {
      events.push(createSetupEvent({
        ticker, tf: tdD.td9_bull ? "D" : "W", event_ts: ts, event_type: "td9_complete", direction: "LONG",
        source, payload: { static: true },
      }));
    }
    if (tdD.td13_bull || tdW.td13_bull) {
      events.push(createSetupEvent({
        ticker, tf: tdD.td13_bull ? "D" : "W", event_ts: ts, event_type: "td13_complete", direction: "LONG",
        source, payload: { static: true },
      }));
    }
    if (DISCOUNT_ZONES.has(pdzD)) {
      events.push(createSetupEvent({
        ticker, tf: "D", event_ts: ts, event_type: "pdz_discount_entered", direction: "LONG",
        source, payload: { zone: pdzD, static: true },
      }));
    }
    const rsiD = Number(ss.rsi?.D);
    if (Number.isFinite(rsiD) && rsiD <= 30) {
      events.push(createSetupEvent({
        ticker, tf: "D", event_ts: ts, event_type: "rsi_extreme_entered", direction: "LONG",
        source, payload: { rsi: rsiD, static: true },
      }));
    }
  } else if (dir === "SHORT") {
    const prep = Math.max(Number(tdD.bear_prep) || 0, Number(tdW.bear_prep) || 0);
    if (prep >= 7) {
      events.push(createSetupEvent({
        ticker, tf: "D", event_ts: ts, event_type: "td_setup_progress", direction: "SHORT",
        source, payload: { bear_prep: prep, static: true },
      }));
    }
    if (tdD.td9_bear || tdW.td9_bear) {
      events.push(createSetupEvent({
        ticker, tf: tdD.td9_bear ? "D" : "W", event_ts: ts, event_type: "td9_complete", direction: "SHORT",
        source, payload: { static: true },
      }));
    }
    if (PREMIUM_ZONES.has(pdzD)) {
      events.push(createSetupEvent({
        ticker, tf: "D", event_ts: ts, event_type: "pdz_premium_entered", direction: "SHORT",
        source, payload: { zone: pdzD, static: true },
      }));
    }
    const rsiD = Number(ss.rsi?.D);
    if (Number.isFinite(rsiD) && rsiD >= 70) {
      events.push(createSetupEvent({
        ticker, tf: "D", event_ts: ts, event_type: "rsi_extreme_entered", direction: "SHORT",
        source, payload: { rsi: rsiD, static: true },
      }));
    }
  }

  return normalizeSetupEvents(events).events;
}

export function inferStaticStageFromEvents(events = [], direction = "LONG") {
  const dir = String(direction || "LONG").toUpperCase();
  const types = new Set((Array.isArray(events) ? events : [])
    .filter((e) => e.direction === dir)
    .map((e) => e.event_type));

  let stage = 0;
  const evidence = [];

  const longStageChecks = [
    { stage: 1, types: ["td_setup_progress", "phase_entered_extreme", "rsi_extreme_entered", "timing_compression_watch"] },
    { stage: 2, types: ["td9_complete", "td13_complete"] },
    { stage: 3, types: ["pdz_discount_entered", "fvg_filled", "ema200_reclaim"] },
    { stage: 4, types: ["phase_left_accumulation", "phase_left_extreme", "rsi_extreme_left"] },
    { stage: 5, types: ["mean_reversion_target_reached", "ema21_reclaim", "pdz_equilibrium_reached"] },
  ];
  const shortStageChecks = [
    { stage: 1, types: ["td_setup_progress", "phase_entered_extreme", "rsi_extreme_entered", "timing_extension_watch"] },
    { stage: 2, types: ["td9_complete", "td13_complete"] },
    { stage: 3, types: ["pdz_premium_entered", "fvg_filled", "ema200_reject"] },
    { stage: 4, types: ["phase_left_distribution", "phase_left_extreme", "rsi_extreme_left"] },
    { stage: 5, types: ["mean_reversion_target_reached", "ema21_reject", "pdz_equilibrium_reached"] },
  ];

  for (const check of (dir === "SHORT" ? shortStageChecks : longStageChecks)) {
    const hit = check.types.find((t) => types.has(t));
    if (hit) {
      stage = check.stage;
      evidence.push(hit);
    }
  }

  return {
    stage,
    stage_bucket: stageBucket(stage),
    evidence,
    method: "static_entry_inference",
    promotion_safe: false,
  };
}

export function deriveLegacyEntryDiagnostics(trade = {}, rankTraceRaw = null, opts = {}) {
  const rankTrace = parseRankTraceJson(rankTraceRaw ?? trade.rank_trace_json ?? trade.rankTraceJson);
  const snapshot = snapshotFromRankTrace(rankTrace, trade);
  if (!snapshot) {
    return {
      ok: false,
      reason: "no_setup_snapshot_in_rank_trace",
      analysis_mode: LEGACY_ANALYSIS_MODE,
      promotion_safe: false,
    };
  }

  const direction = String(trade.direction || "LONG").toUpperCase();
  const bootstrapEvents = deriveSetupEvents(null, snapshot, {
    bootstrap: true,
    source: opts.source || "legacy_entry_bootstrap",
  });
  const staticEvents = inferStaticEventsFromSnapshot(snapshot, direction, opts);
  const merged = normalizeSetupEvents([...bootstrapEvents, ...staticEvents]).events;
  const context = buildDiagnosticsContext(snapshot, opts.env || {});
  const sequences = detectMeanReversionSequences(merged, {
    ticker: snapshot.ticker,
    context,
    includeEmpty: false,
  });
  const seq = sequences
    .filter((s) => s.direction === direction && s.stage > 0)
    .sort((a, b) => b.stage - a.stage)[0] || null;
  const staticStage = inferStaticStageFromEvents(merged, direction);
  const effectiveStage = Math.max(Number(seq?.stage) || 0, staticStage.stage);

  return {
    ok: true,
    analysis_mode: LEGACY_ANALYSIS_MODE,
    promotion_safe: false,
    snapshot_count: 1,
    has_setup_snapshot: !!(rankTrace?.setup_snapshot && Object.keys(rankTrace.setup_snapshot).length),
    events: merged,
    event_count: merged.length,
    static_stage: staticStage,
    sequences,
    sequence: seq ? {
      ...seq,
      stage: effectiveStage,
      stage_bucket: stageBucket(effectiveStage),
    } : (staticStage.stage > 0 ? {
      sequence_type: direction === "SHORT" ? "td_phase_mean_reversion_short" : "td_phase_mean_reversion_long",
      direction,
      stage: staticStage.stage,
      stage_bucket: staticStage.stage_bucket,
      status: staticStage.stage >= 5 ? "confirmed" : "forming",
      posture: staticStage.stage >= 5 ? (direction === "SHORT" ? "Bearish" : "Bullish") : "Neutral",
      confidence: 0.3,
      static_only: true,
    } : null),
    trader_posture: summarizeTraderPosture(sequences),
    context_used: context,
  };
}
