// worker/foundation/setup-event-derivation.js
// -----------------------------------------------------------------------------
// Shadow-only bridge: real ticker snapshots -> setup-event atoms -> sequences.
//
// Pure functions only. This module intentionally does not write D1/KV and is
// not imported by live scoring or trade-management paths.
// -----------------------------------------------------------------------------

import { createSetupEvent, normalizeSetupEvents } from "./setup-events.js";
import { detectMeanReversionSequences } from "./setup-sequences.js";

const DEFAULT_TD_TFS = ["D", "W", "60"];
const DEFAULT_SIGNAL_TFS = ["D", "60", "30"];

function num(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function bool(v) {
  return v === true || v === 1 || v === "1" || String(v).toLowerCase() === "true";
}

function tsOf(t) {
  const raw = t?.event_ts ?? t?.ingest_ts ?? t?.computedAt ?? t?.updated_at ?? t?.ts ?? t?.timestamp;
  const n = num(raw);
  if (n == null) return Date.now();
  return n > 1e12 ? n : n * 1000;
}

function tickerOf(t) {
  return String(t?.ticker || t?.symbol || "UNKNOWN").toUpperCase();
}

function priceOf(t) {
  return num(t?.price ?? t?.close ?? t?.last_price ?? t?._live_price);
}

function tfAliases(tf) {
  const s = String(tf);
  if (s === "60" || s === "1H") return ["1H", "60"];
  if (s === "240" || s === "4H") return ["4H", "240"];
  return [s];
}

function tfRow(t, tf) {
  const tech = t?.tf_tech || {};
  for (const key of tfAliases(tf)) {
    if (tech[key]) return tech[key];
  }
  return null;
}

function tdRow(t, tf) {
  const td = t?.td_sequential || {};
  for (const key of tfAliases(tf)) {
    if (td?.per_tf?.[key]) return td.per_tf[key];
  }
  return tf === "D" ? td : null;
}

function satyRow(t, tf) {
  return tfRow(t, tf)?.saty || null;
}

function rsiValue(t, tf) {
  return num(tfRow(t, tf)?.rsi?.r5 ?? tfRow(t, tf)?.rsi);
}

function emaValue(t, tf, key) {
  const row = tfRow(t, tf);
  return num(row?.ema?.[key] ?? row?.[key]);
}

function stDir(t, tf) {
  return num(tfRow(t, tf)?.stDir);
}

function pdzZone(t, tf) {
  return String(tfRow(t, tf)?.pdz?.zone || t?.flags?.[`pdz_zone_${tf}`] || "").toLowerCase();
}

function fvgRow(t, tf) {
  return tfRow(t, tf)?.fvg || {};
}

function sqRow(t, tf) {
  return tfRow(t, tf)?.sq || {};
}

function vwapAbove(t, tf) {
  const v = tfRow(t, tf)?.vwapAbove;
  return typeof v === "boolean" ? v : null;
}

function inferDirection(t) {
  const sc = String(t?.swing_consensus?.direction || "").toUpperCase();
  if (sc === "LONG" || sc === "BULLISH") return "LONG";
  if (sc === "SHORT" || sc === "BEARISH") return "SHORT";
  const state = String(t?.state || "").toUpperCase();
  if (state.includes("BEAR")) return "SHORT";
  if (state.includes("BULL")) return "LONG";
  return "NEUTRAL";
}

function emitFactory(prevTicker, currentTicker, opts) {
  const events = [];
  const ticker = tickerOf(currentTicker);
  const event_ts = tsOf(currentTicker);
  const price = priceOf(currentTicker);
  const source = opts.source || "shadow_derivation";
  return {
    events,
    emit(tf, event_type, direction, payload = {}) {
      events.push(createSetupEvent({
        ticker,
        tf,
        event_ts,
        event_type,
        direction,
        price,
        source,
        payload,
      }));
    },
    changedTruthy(prev, cur) {
      return opts.bootstrap ? bool(cur) : bool(cur) && !bool(prev);
    },
    crossedUp(prev, cur, levelPrev, levelCur) {
      if ([prev, cur, levelPrev, levelCur].some((v) => num(v) == null)) return false;
      return num(prev) < num(levelPrev) && num(cur) >= num(levelCur);
    },
    crossedDown(prev, cur, levelPrev, levelCur) {
      if ([prev, cur, levelPrev, levelCur].some((v) => num(v) == null)) return false;
      return num(prev) > num(levelPrev) && num(cur) <= num(levelCur);
    },
  };
}

export function deriveSetupEvents(prevTicker = null, currentTicker = null, opts = {}) {
  if (!currentTicker || typeof currentTicker !== "object") return [];
  const out = emitFactory(prevTicker, currentTicker, opts);
  const tdTfs = opts.tdTfs || DEFAULT_TD_TFS;
  const signalTfs = opts.signalTfs || DEFAULT_SIGNAL_TFS;

  for (const tf of tdTfs) {
    const prev = tdRow(prevTicker, tf) || {};
    const cur = tdRow(currentTicker, tf) || {};
    const prevBullPrep = num(prev.bullish_prep_count) || 0;
    const curBullPrep = num(cur.bullish_prep_count) || 0;
    const prevBearPrep = num(prev.bearish_prep_count) || 0;
    const curBearPrep = num(cur.bearish_prep_count) || 0;
    if (curBullPrep >= 7 && (opts.bootstrap || curBullPrep > prevBullPrep)) {
      out.emit(tf, "td_setup_progress", "LONG", { count: curBullPrep, side: "bullish_prep" });
    }
    if (curBearPrep >= 7 && (opts.bootstrap || curBearPrep > prevBearPrep)) {
      out.emit(tf, "td_setup_progress", "SHORT", { count: curBearPrep, side: "bearish_prep" });
    }
    if (out.changedTruthy(prev.td9_bullish, cur.td9_bullish)) out.emit(tf, "td9_complete", "LONG", { side: "bull" });
    if (out.changedTruthy(prev.td9_bearish, cur.td9_bearish)) out.emit(tf, "td9_complete", "SHORT", { side: "bear" });
    if (out.changedTruthy(prev.td13_bullish, cur.td13_bullish)) out.emit(tf, "td13_complete", "LONG", { side: "bull" });
    if (out.changedTruthy(prev.td13_bearish, cur.td13_bearish)) out.emit(tf, "td13_complete", "SHORT", { side: "bear" });
  }

  for (const tf of signalTfs) {
    const prevSaty = satyRow(prevTicker, tf) || {};
    const curSaty = satyRow(currentTicker, tf) || {};
    const pv = num(prevSaty.v ?? prevSaty.value);
    const cv = num(curSaty.v ?? curSaty.value);
    if (cv != null) {
      if (Math.abs(cv) >= 61.8 && (opts.bootstrap || pv == null || Math.abs(pv) < 61.8)) {
        out.emit(tf, "phase_entered_extreme", cv < 0 ? "LONG" : "SHORT", { value: cv });
      }
      if ((curSaty.l?.accum || (pv != null && pv <= -61.8 && cv > -61.8)) && !(prevSaty.l?.accum)) {
        out.emit(tf, "phase_left_accumulation", "LONG", { prev: pv, value: cv });
      }
      if ((curSaty.l?.distrib || (pv != null && pv >= 61.8 && cv < 61.8)) && !(prevSaty.l?.distrib)) {
        out.emit(tf, "phase_left_distribution", "SHORT", { prev: pv, value: cv });
      }
      if ((curSaty.l?.extDn || (pv != null && pv <= -100 && cv > -100)) && !(prevSaty.l?.extDn)) {
        out.emit(tf, "phase_left_extreme", "LONG", { prev: pv, value: cv });
      }
      if ((curSaty.l?.extUp || (pv != null && pv >= 100 && cv < 100)) && !(prevSaty.l?.extUp)) {
        out.emit(tf, "phase_left_extreme", "SHORT", { prev: pv, value: cv });
      }
    }

    const prsi = rsiValue(prevTicker, tf);
    const crsi = rsiValue(currentTicker, tf);
    if (crsi != null) {
      if (crsi <= 30 && (opts.bootstrap || prsi == null || prsi > 30)) out.emit(tf, "rsi_extreme_entered", "LONG", { rsi: crsi });
      if (crsi >= 70 && (opts.bootstrap || prsi == null || prsi < 70)) out.emit(tf, "rsi_extreme_entered", "SHORT", { rsi: crsi });
      if (prsi != null && prsi <= 30 && crsi > 30) out.emit(tf, "rsi_extreme_left", "LONG", { prev: prsi, rsi: crsi });
      if (prsi != null && prsi >= 70 && crsi < 70) out.emit(tf, "rsi_extreme_left", "SHORT", { prev: prsi, rsi: crsi });
    }

    const row = tfRow(currentTicker, tf) || {};
    const prevRow = tfRow(prevTicker, tf) || {};
    if (out.changedTruthy(prevRow.rsiDiv?.bull?.a, row.rsiDiv?.bull?.a)) out.emit(tf, "rsi_divergence_confirmed", "LONG", { kind: "bull" });
    if (out.changedTruthy(prevRow.rsiDiv?.bear?.a, row.rsiDiv?.bear?.a)) out.emit(tf, "rsi_divergence_confirmed", "SHORT", { kind: "bear" });

    const pPrice = priceOf(prevTicker);
    const cPrice = priceOf(currentTicker);
    for (const [emaKey, reclaim, reject] of [["ema21", "ema21_reclaim", "ema21_reject"], ["ema200", "ema200_reclaim", "ema200_reject"]]) {
      const pe = emaValue(prevTicker, tf, emaKey);
      const ce = emaValue(currentTicker, tf, emaKey);
      if (out.crossedUp(pPrice, cPrice, pe, ce)) out.emit(tf, reclaim, "LONG", { ema: emaKey, level: ce });
      if (out.crossedDown(pPrice, cPrice, pe, ce)) out.emit(tf, reject, "SHORT", { ema: emaKey, level: ce });
    }

    const pst = stDir(prevTicker, tf);
    const cst = stDir(currentTicker, tf);
    if (cst != null && (opts.bootstrap || (pst != null && pst !== cst))) {
      if (cst < 0) out.emit(tf, "supertrend_flip", "LONG", { stDir: cst });
      if (cst > 0) out.emit(tf, "supertrend_flip", "SHORT", { stDir: cst });
    }

    const prevPdz = pdzZone(prevTicker, tf);
    const curPdz = pdzZone(currentTicker, tf);
    if (curPdz && (opts.bootstrap || curPdz !== prevPdz)) {
      if (curPdz.includes("discount")) out.emit(tf, "pdz_discount_entered", "LONG", { zone: curPdz });
      else if (curPdz.includes("premium")) out.emit(tf, "pdz_premium_entered", "SHORT", { zone: curPdz });
      else if (curPdz === "equilibrium") {
        if (prevPdz.includes("discount")) out.emit(tf, "pdz_equilibrium_reached", "LONG", { from: prevPdz });
        if (prevPdz.includes("premium")) out.emit(tf, "pdz_equilibrium_reached", "SHORT", { from: prevPdz });
      }
    }

    const prevFvg = fvgRow(prevTicker, tf);
    const curFvg = fvgRow(currentTicker, tf);
    if (out.changedTruthy(prevFvg.ib, curFvg.ib)) out.emit(tf, "fvg_filled", "LONG", { side: "bull" });
    if (out.changedTruthy(prevFvg.ibr, curFvg.ibr)) out.emit(tf, "fvg_filled", "SHORT", { side: "bear" });

    const prevSq = sqRow(prevTicker, tf);
    const curSq = sqRow(currentTicker, tf);
    if (out.changedTruthy(prevSq.r, curSq.r)) out.emit(tf, "squeeze_release", inferDirection(currentTicker), { tf });

    const pvwap = vwapAbove(prevTicker, tf);
    const cvwap = vwapAbove(currentTicker, tf);
    if (pvwap === false && cvwap === true) out.emit(tf, "vwap_reclaim", "LONG", { tf });
    if (pvwap === true && cvwap === false) out.emit(tf, "vwap_reject", "SHORT", { tf });
  }

  const prevOrb = prevTicker?.orb?.primary || {};
  const curOrb = currentTicker?.orb?.primary || {};
  if (curOrb.breakout && curOrb.breakout !== prevOrb.breakout) {
    out.emit("ORB", "orb_breakout", curOrb.breakout, { window: curOrb.window || "primary" });
  }
  if (curOrb.reclaim && !prevOrb.reclaim) {
    out.emit("ORB", "orb_reclaim", inferDirection(currentTicker), { window: curOrb.window || "primary" });
  }
  if (curOrb.fakeout && !prevOrb.fakeout) {
    out.emit("ORB", "orb_failed_breakout", inferDirection(currentTicker), { window: curOrb.window || "primary" });
  }

  return normalizeSetupEvents(out.events).events;
}

export function deriveSetupDiagnostics(prevTicker = null, currentTicker = null, opts = {}) {
  const derived = deriveSetupEvents(prevTicker, currentTicker, opts);
  const history = normalizeSetupEvents([...(opts.priorEvents || []), ...derived]).events;
  const sequences = detectMeanReversionSequences(history, {
    ticker: tickerOf(currentTicker),
    context: opts.context || {},
    includeEmpty: opts.includeEmptySequences === true,
  });
  return {
    events: derived,
    event_history: history,
    sequences,
  };
}
