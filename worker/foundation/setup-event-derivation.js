// worker/foundation/setup-event-derivation.js
// -----------------------------------------------------------------------------
// Shadow-only bridge: real ticker snapshots -> setup-event atoms -> sequences.
//
// Pure functions only. This module intentionally does not write D1/KV and is
// not imported by live scoring or trade-management paths.
// -----------------------------------------------------------------------------

import { createSetupEvent, normalizeSetupEvents } from "./setup-events.js";
import { detectMeanReversionSequences } from "./setup-sequences.js";
import { computeTDSequential, detectRsiDivergence, rsiSeries } from "../indicators.js";

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

/** Normalize TD row fields across live payload vs rank_trace setup_snapshot names. */
export function normalizeTdRow(raw = {}) {
  if (!raw || typeof raw !== "object") return {};
  return {
    ...raw,
    bullish_prep_count: num(raw.bullish_prep_count ?? raw.bull_prep) ?? raw.bullish_prep_count,
    bearish_prep_count: num(raw.bearish_prep_count ?? raw.bear_prep) ?? raw.bearish_prep_count,
    td9_bullish: raw.td9_bullish ?? raw.td9_bull,
    td9_bearish: raw.td9_bearish ?? raw.td9_bear,
    td13_bullish: raw.td13_bullish ?? raw.td13_bull,
    td13_bearish: raw.td13_bearish ?? raw.td13_bear,
  };
}

function setupSnapshotTd(t, tf) {
  const tdSeq = t?.setup_snapshot?.td_seq
    || t?.__rank_trace?.setup_snapshot?.td_seq
    || null;
  if (!tdSeq || typeof tdSeq !== "object") return null;
  for (const key of tfAliases(tf)) {
    if (tdSeq[key]) return normalizeTdRow(tdSeq[key]);
  }
  return null;
}

function topLevelPdzZone(t, tf) {
  const s = String(tf);
  if (s === "D") return t?.pdz_zone_D || t?.pdz_D?.zone || null;
  if (s === "240" || s === "4H") return t?.pdz_zone_4h || t?.pdz_4h?.zone || null;
  if (s === "60" || s === "1H") return t?.pdz_zone_1h || t?.pdz_zone_h1 || null;
  return t?.[`pdz_zone_${s}`] || null;
}

function setupSnapshotPdz(t, tf) {
  const pdz = t?.setup_snapshot?.pdz || t?.__rank_trace?.setup_snapshot?.pdz || null;
  if (!pdz || typeof pdz !== "object") return null;
  const s = String(tf);
  if (s === "D") return pdz.D || null;
  if (s === "240" || s === "4H") return pdz.h4 || pdz["4h"] || pdz["240"] || null;
  if (s === "60" || s === "1H") return pdz.h1 || pdz["1h"] || pdz["60"] || null;
  return pdz[s] || null;
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
    if (td?.per_tf?.[key]) return normalizeTdRow(td.per_tf[key]);
  }
  const fromSnapshot = setupSnapshotTd(t, tf);
  if (fromSnapshot) return fromSnapshot;
  return tf === "D" ? normalizeTdRow(td) : null;
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
  const fromTf = tfRow(t, tf)?.pdz?.zone;
  const fromFlags = t?.flags?.[`pdz_zone_${tf}`];
  const fromTop = topLevelPdzZone(t, tf);
  const fromSnapshot = setupSnapshotPdz(t, tf);
  return String(fromTf || fromTop || fromSnapshot || fromFlags || "").toLowerCase();
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

function sortSnapshots(snapshots = []) {
  const byTs = new Map();
  for (const s of Array.isArray(snapshots) ? snapshots : []) {
    if (!s || typeof s !== "object") continue;
    byTs.set(tsOf(s), s);
  }
  return [...byTs.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, s]) => s);
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
    if (out.changedTruthy(prev.td9_bullish, cur.td9_bullish) || (opts.bootstrap && cur.td9_bullish)) {
      out.emit(tf, "td9_complete", "LONG", { side: "bull" });
    }
    if (out.changedTruthy(prev.td9_bearish, cur.td9_bearish) || (opts.bootstrap && cur.td9_bearish)) {
      out.emit(tf, "td9_complete", "SHORT", { side: "bear" });
    }
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

    const ema21 = emaValue(currentTicker, tf, "ema21");
    const atr = num(row.atr ?? row.atr14 ?? tfRow(currentTicker, tf)?.atr);
    if (cPrice != null && ema21 != null && ema21 > 0) {
      const distPct = Math.abs((cPrice - ema21) / ema21) * 100;
      const distAtr = atr != null && atr > 0 ? Math.abs(cPrice - ema21) / atr : null;
      const stretched = distPct >= 2.5 || (distAtr != null && distAtr >= 2.0);
      const prevEma21 = emaValue(prevTicker, tf, "ema21");
      const prevPrice = priceOf(prevTicker);
      let prevStretched = false;
      if (prevPrice != null && prevEma21 != null && prevEma21 > 0) {
        const prevDistPct = Math.abs((prevPrice - prevEma21) / prevEma21) * 100;
        const prevDistAtr = atr != null && atr > 0 ? Math.abs(prevPrice - prevEma21) / atr : null;
        prevStretched = prevDistPct >= 2.5 || (prevDistAtr != null && prevDistAtr >= 2.0);
      }
      if (stretched && (opts.bootstrap || !prevStretched)) {
        const direction = cPrice > ema21 ? "SHORT" : "LONG";
        out.emit(tf, "ema21_stretched", direction, {
          dist_pct: Math.round(distPct * 100) / 100,
          dist_atr: distAtr != null ? Math.round(distAtr * 100) / 100 : null,
          ema21,
          price: cPrice,
        });
      }
    }

    const pst = stDir(prevTicker, tf);
    const cst = stDir(currentTicker, tf);
    const prevSlope = num(prevRow.stSlope);
    const curSlope = num(row.stSlope);
    const flatThreshold = 0.08;
    const isFlat = curSlope != null && Math.abs(curSlope) <= flatThreshold;
    const wasFlat = prevSlope != null && Math.abs(prevSlope) <= flatThreshold;
    if (isFlat && cst != null && (opts.bootstrap || !wasFlat)) {
      const direction = cst < 0 ? "LONG" : "SHORT";
      out.emit(tf, "supertrend_flat_opposing", direction, { stDir: cst, stSlope: curSlope });
    }
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

function hasPriorEvent(events, latestTs, eventTypes, direction) {
  const types = new Set(eventTypes);
  return events.some((ev) => (
    types.has(ev.event_type)
    && ev.direction === direction
    && Number(ev.event_ts) < latestTs
  ));
}

function snapshotsAfterEvent(snapshots, eventTs) {
  return snapshots.filter((s) => tsOf(s) >= Number(eventTs));
}

function latestEvent(events, eventTypes, direction, beforeTs = Infinity) {
  const types = new Set(eventTypes);
  const matches = events.filter((ev) => (
    types.has(ev.event_type)
    && ev.direction === direction
    && Number(ev.event_ts) <= beforeTs
  ));
  return matches.length ? matches[matches.length - 1] : null;
}

function windowEvent(latest, tf, event_type, direction, payload = {}, opts = {}) {
  return createSetupEvent({
    ticker: tickerOf(latest),
    tf,
    event_ts: tsOf(latest),
    event_type,
    direction,
    price: priceOf(latest),
    source: opts.source || "shadow_window_derivation",
    payload,
  });
}

function deriveWindowLevelEvents(snapshots, eventHistory, opts = {}) {
  if (!Array.isArray(snapshots) || snapshots.length < 2) return [];
  const latest = snapshots[snapshots.length - 1];
  const latestTs = tsOf(latest);
  const tfs = opts.signalTfs || DEFAULT_SIGNAL_TFS;
  const events = [];
  const minHold = Number(opts.pullbackHoldSnapshots) || 2;
  const tolerancePct = Number.isFinite(Number(opts.pullbackTolerancePct))
    ? Number(opts.pullbackTolerancePct)
    : 0.003;

  for (const tf of tfs) {
    const curPrice = priceOf(latest);
    const ema21 = emaValue(latest, tf, "ema21");
    if (curPrice == null || ema21 == null) continue;

    const longExhaustion = hasPriorEvent(eventHistory, latestTs, [
      "td_setup_progress",
      "td9_complete",
      "td13_complete",
      "phase_entered_extreme",
      "phase_left_accumulation",
      "phase_left_extreme",
    ], "LONG");
    const shortExhaustion = hasPriorEvent(eventHistory, latestTs, [
      "td_setup_progress",
      "td9_complete",
      "td13_complete",
      "phase_entered_extreme",
      "phase_left_distribution",
      "phase_left_extreme",
    ], "SHORT");

    if (longExhaustion && curPrice >= ema21) {
      events.push(windowEvent(latest, tf, "mean_reversion_target_reached", "LONG", { target: "ema21", level: ema21 }, opts));
    }
    if (shortExhaustion && curPrice <= ema21) {
      events.push(windowEvent(latest, tf, "mean_reversion_target_reached", "SHORT", { target: "ema21", level: ema21 }, opts));
    }

    const reclaim = latestEvent(eventHistory, ["ema21_reclaim", "mean_reversion_target_reached"], "LONG", latestTs);
    if (reclaim) {
      const after = snapshotsAfterEvent(snapshots, reclaim.event_ts).slice(-minHold);
      const held = after.length >= minHold && after.every((s) => {
        const p = priceOf(s);
        const e = emaValue(s, tf, "ema21");
        return p != null && e != null && p >= e * (1 - tolerancePct);
      });
      if (held) {
        events.push(windowEvent(latest, tf, "pullback_stabilized", "LONG", { basis: "ema21", minHold, tolerancePct }, opts));
      }
    }

    const reject = latestEvent(eventHistory, ["ema21_reject", "mean_reversion_target_reached"], "SHORT", latestTs);
    if (reject) {
      const after = snapshotsAfterEvent(snapshots, reject.event_ts).slice(-minHold);
      const held = after.length >= minHold && after.every((s) => {
        const p = priceOf(s);
        const e = emaValue(s, tf, "ema21");
        return p != null && e != null && p <= e * (1 + tolerancePct);
      });
      if (held) {
        events.push(windowEvent(latest, tf, "pullback_stabilized", "SHORT", { basis: "ema21", minHold, tolerancePct }, opts));
      }
    }
  }

  return normalizeSetupEvents(events).events;
}

export function deriveSetupEventsFromWindow(snapshots = [], opts = {}) {
  const sorted = sortSnapshots(snapshots);
  if (sorted.length === 0) {
    return { events: [], event_history: normalizeSetupEvents(opts.priorEvents || []).events, sequences: [], latest: null };
  }

  const pairEvents = [];
  if (opts.bootstrapFirst === true) {
    pairEvents.push(...deriveSetupEvents(null, sorted[0], { ...opts, bootstrap: true }));
  }
  for (let i = 1; i < sorted.length; i += 1) {
    pairEvents.push(...deriveSetupEvents(sorted[i - 1], sorted[i], { ...opts, bootstrap: false }));
  }

  const withPrior = normalizeSetupEvents([...(opts.priorEvents || []), ...pairEvents]).events;
  const windowEvents = opts.deriveWindowEvents === false
    ? []
    : deriveWindowLevelEvents(sorted, withPrior, opts);
  const derived = normalizeSetupEvents([...pairEvents, ...windowEvents]).events;
  const history = normalizeSetupEvents([...(opts.priorEvents || []), ...derived]).events;
  const latest = sorted[sorted.length - 1];
  const sequences = detectMeanReversionSequences(history, {
    ticker: tickerOf(latest),
    context: opts.context || {},
    includeEmpty: opts.includeEmptySequences === true,
  });

  return {
    events: derived,
    event_history: history,
    sequences,
    latest,
  };
}

function candlePrefixForTs(dailyCandles = [], ts) {
  const sorted = [...dailyCandles]
    .map((c) => ({
      o: Number(c.o ?? c.open),
      h: Number(c.h ?? c.high),
      l: Number(c.l ?? c.low),
      c: Number(c.c ?? c.close),
      ts: Number(c.ts),
    }))
    .filter((c) => Number.isFinite(c.ts) && Number.isFinite(c.c))
    .sort((a, b) => a.ts - b.ts);
  const anchor = Number(ts);
  if (!Number.isFinite(anchor) || !sorted.length) return [];
  let lastIdx = -1;
  for (let i = 0; i < sorted.length; i += 1) {
    if (sorted[i].ts <= anchor) lastIdx = i;
    else break;
  }
  return lastIdx >= 0 ? sorted.slice(0, lastIdx + 1) : [];
}

/** Stamp daily TD sequential state on each snapshot from D candles (backtest parity). */
export function augmentSnapshotsWithDailyTd(snapshots = [], dailyCandles = []) {
  if (!Array.isArray(snapshots) || !snapshots.length || !Array.isArray(dailyCandles) || !dailyCandles.length) {
    return snapshots;
  }
  return snapshots.map((snap) => {
    const prefix = candlePrefixForTs(dailyCandles, tsOf(snap));
    if (prefix.length < 10) return snap;
    const tdD = computeTDSequential(prefix, "D");
    return {
      ...snap,
      td_sequential: {
        ...(snap.td_sequential || {}),
        per_tf: {
          ...((snap.td_sequential || {}).per_tf || {}),
          D: tdD,
        },
      },
    };
  });
}

/** Reconstruct RSI divergence on trail windows using daily OHLC (5m lacks swing structure). */
export function augmentSnapshotsWithRsiDivergence(snapshots = [], opts = {}) {
  const sorted = sortSnapshots(snapshots);
  if (!sorted.length) return sorted;

  const dailyCandles = Array.isArray(opts.dailyCandles) ? opts.dailyCandles : [];
  if (dailyCandles.length >= 20) {
    return augmentSnapshotsWithDailyRsiDivergence(sorted, dailyCandles, opts);
  }

  if (sorted.length < 20) return sorted;

  const closes = sorted.map((s) => Number(s.price ?? s.close ?? s.price_close) || NaN);
  if (closes.filter(Number.isFinite).length < 20) return sorted;

  const bars = closes.map((c, i) => ({
    o: c,
    h: c,
    l: c,
    c,
    ts: tsOf(sorted[i]),
  }));
  const rsiArr = rsiSeries(closes, Number(opts.rsiPeriod) || 14);
  const pivotLookback = Number(opts.pivotLookback) || 5;
  const maxAge = Number(opts.maxAge) || 96;
  const tfs = Array.isArray(opts.signalTfs) && opts.signalTfs.length
    ? opts.signalTfs
    : ["D", "60", "30"];

  let bullLatched = false;
  let bearLatched = false;

  return sorted.map((snap, i) => {
    const prefixBars = bars.slice(0, i + 1);
    const prefixRsi = rsiArr.slice(0, i + 1);
    const div = detectRsiDivergence(prefixBars, prefixRsi, pivotLookback, maxAge);
    if (div.bull?.active) bullLatched = true;
    if (div.bear?.active) bearLatched = true;
    return stampRsiDivOnSnapshot(snap, { bullLatched, bearLatched, div, rsiVal: prefixRsi[i], tfs });
  });
}

function stampRsiDivOnSnapshot(snap, { bullLatched, bearLatched, div, rsiVal, tfs }) {
  const rsiDiv = {};
  if (bullLatched) {
    rsiDiv.bull = {
      a: true,
      strength: div?.bull?.strength ?? null,
      bs: div?.bull?.barsSince ?? null,
    };
  }
  if (bearLatched) {
    rsiDiv.bear = {
      a: true,
      strength: div?.bear?.strength ?? null,
      bs: div?.bear?.barsSince ?? null,
    };
  }
  const tfPatch = {};
  for (const tf of tfs) {
    tfPatch[tf] = {
      ...(snap.tf_tech?.[tf] || {}),
      rsiDiv: { ...(snap.tf_tech?.[tf]?.rsiDiv || {}), ...rsiDiv },
      rsi: { r5: rsiVal },
    };
  }
  return {
    ...snap,
    tf_tech: { ...(snap.tf_tech || {}), ...tfPatch },
  };
}

export function augmentSnapshotsWithDailyRsiDivergence(snapshots = [], dailyCandles = [], opts = {}) {
  const sortedSnaps = sortSnapshots(snapshots);
  const sortedDaily = [...dailyCandles]
    .map((c) => ({
      o: Number(c.o ?? c.open),
      h: Number(c.h ?? c.high),
      l: Number(c.l ?? c.low),
      c: Number(c.c ?? c.close),
      ts: Number(c.ts),
    }))
    .filter((c) => Number.isFinite(c.ts) && Number.isFinite(c.c))
    .sort((a, b) => a.ts - b.ts);
  if (!sortedSnaps.length || sortedDaily.length < 20) return sortedSnaps;

  const closes = sortedDaily.map((c) => c.c);
  const rsiArr = rsiSeries(closes, Number(opts.rsiPeriod) || 14);
  const pivotLookback = Number(opts.pivotLookback) || 5;
  const maxAge = Number(opts.maxAge) || 30;
  const tfs = Array.isArray(opts.signalTfs) && opts.signalTfs.length
    ? opts.signalTfs
    : ["D", "60", "30"];

  let bullLatched = false;
  let bearLatched = false;
  const divAtDailyTs = [];
  for (let i = 0; i < sortedDaily.length; i += 1) {
    const prefixBars = sortedDaily.slice(0, i + 1);
    const prefixRsi = rsiArr.slice(0, i + 1);
    const div = detectRsiDivergence(prefixBars, prefixRsi, pivotLookback, maxAge);
    if (div.bull?.active) bullLatched = true;
    if (div.bear?.active) bearLatched = true;
    divAtDailyTs.push({
      ts: sortedDaily[i].ts,
      bullLatched,
      bearLatched,
      div,
      rsiVal: prefixRsi[i],
    });
  }

  return sortedSnaps.map((snap) => {
    const ts = tsOf(snap);
    let row = divAtDailyTs[0];
    for (const d of divAtDailyTs) {
      if (d.ts <= ts) row = d;
      else break;
    }
    return stampRsiDivOnSnapshot(snap, {
      bullLatched: row?.bullLatched === true,
      bearLatched: row?.bearLatched === true,
      div: row?.div,
      rsiVal: row?.rsiVal,
      tfs,
    });
  });
}

/** Trail replay enrichment: RSI div + optional daily TD before event derivation. */
export function enrichTrailSnapshotsForDerivation(snapshots = [], opts = {}) {
  let out = augmentSnapshotsWithRsiDivergence(snapshots, opts);
  if (Array.isArray(opts.dailyCandles) && opts.dailyCandles.length) {
    out = augmentSnapshotsWithDailyTd(out, opts.dailyCandles);
  }
  return out;
}
