/**
 * Canonical Ticker Scenario module (V15 P0.7.72 — Phase 2 Q1 unification)
 *
 * Background:
 *   The Daily Brief AI prompt computed S/R levels server-side from one
 *   candle source. The Right Rail Model card computed S/R levels client-
 *   side from a different candle source. Same ticker, same minute, two
 *   different sets of numbers — exactly what the user saw and flagged:
 *     "Daily Brief showed levels for SPY/QQQ/IWM that weren't in line
 *      with what shows on the Right Rail Model Guidance and Setup
 *      sections."
 *
 * Resolution:
 *   This module is the canonical per-ticker scenario builder. Both the
 *   Daily Brief generator (server-side) and the Right Rail Model card
 *   (client-side via /timed/ticker-scenario?ticker=X) consume the same
 *   object. Fix a number once → both views update.
 *
 * Output shape (canonical):
 *   {
 *     ticker: "SPY",
 *     price: 723.77,
 *     prev_close: 689.53,
 *     atr14: 6.50,
 *     bias: "BULL_PULLBACK" | "BULL_TREND" | "BEAR_TREND" | "NEUTRAL" | ...,
 *     levels: {
 *       support: [{ price, label, source }, ...],   // sorted: nearest below first
 *       resistance: [{ price, label, source }, ...],// sorted: nearest above first
 *     },
 *     pivots: { pp, r1, r2, s1, s2, prevHigh, prevLow, prevClose },
 *     atr_fib: { up_618, up_100, down_618, down_100 },
 *     golden_gate: {
 *       direction: "UP" | "DOWN" | null,
 *       label: "Weekly GG Up",
 *       trigger: 720.50,
 *       target_50: 745.10,
 *       target_618: 752.30,
 *       probability_pct: 64,
 *       distance_pct: 0.4,
 *     } | null,
 *     game_plan: {
 *       bull_trigger: 720.50,
 *       bull_target: 740.41,
 *       bear_trigger: 715.00,
 *       bear_target: 700.00,
 *     },
 *     generated_at: "2026-05-06T03:50:00Z",
 *     source: "ticker-scenario.v1",
 *   }
 *
 * Usage:
 *   - Server (Daily Brief): `import { buildTickerScenario } from './ticker-scenario.js'`
 *     then embed the object into the AI prompt as a JSON block; the AI
 *     mirrors the levels back into the rendered Markdown.
 *   - Client (Right Rail): fetch `/timed/ticker-scenario?ticker=SPY`,
 *     render the levels array as horizontal lines on the chart and the
 *     bias/GG info in the Model card.
 */

import { kvGetJSON } from "./storage.js";
import {
  isIndexDayTradeEtf,
  computeOvernightRangeFromM5,
  computeOpeningRangeFromM5,
  buildOvernightDayTradeGamePlan,
} from "./day-trade-game-plan.js";
import { STRATEGY_PHASE } from "./strategy-context.js";

/**
 * Research-desk directional posture as a bounded ±1 tilt for the day lean.
 * Sourced from the active playbook's probability-weighted scenario view
 * (STRATEGY_PHASE.scenario_weights) — the CRO/FSD structural read. Modest by
 * design: it nudges the lean and is surfaced as a reason, never overriding the
 * intraday tape.
 */
function researchBiasForIndexLean() {
  try {
    const sw = STRATEGY_PHASE?.scenario_weights || {};
    const up = Number(sw.grind_higher_to_target) || 0;
    const dn = Number(sw.bear_case_retest_lows) || 0;
    return Math.max(-1, Math.min(1, up - dn));
  } catch (_) {
    return 0;
  }
}

const SCENARIO_VERSION = "ticker-scenario.v2";

function rnd2(v) {
  return Math.round(Number(v) * 100) / 100;
}

/** Detect swing highs/lows in a candle series. lookback=2 means 2 bars on each side. */
function detectSwingPoints(candles, lookback = 2) {
  const highs = [];
  const lows = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const c = candles[i];
    const h = Number(c.h);
    const l = Number(c.l);
    if (!Number.isFinite(h) || !Number.isFinite(l)) continue;
    let isSwingHigh = true;
    let isSwingLow = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      const oh = Number(candles[j]?.h);
      const ol = Number(candles[j]?.l);
      if (Number.isFinite(oh) && oh >= h) isSwingHigh = false;
      if (Number.isFinite(ol) && ol <= l) isSwingLow = false;
    }
    if (isSwingHigh) highs.push({ price: h, ts: Number(c.ts) });
    if (isSwingLow) lows.push({ price: l, ts: Number(c.ts) });
  }
  return { highs, lows };
}

/** ATR-14 from a candle series using true range. */
function computeATR14(candles) {
  if (!Array.isArray(candles) || candles.length < 2) return 0;
  const recent = candles.slice(-15);
  let atrSum = 0;
  let atrCount = 0;
  for (let i = 1; i < recent.length; i++) {
    const h = Number(recent[i].h);
    const l = Number(recent[i].l);
    const pc = Number(recent[i - 1].c);
    if (!Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(pc)) continue;
    const tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    if (tr > 0) {
      atrSum += tr;
      atrCount++;
    }
  }
  return atrCount > 0 ? atrSum / atrCount : 0;
}

/** Standard floor-trader pivots from prev session H/L/C. */
function computePivots(prevHigh, prevLow, prevClose) {
  if (![prevHigh, prevLow, prevClose].every(Number.isFinite)) return null;
  const pp = (prevHigh + prevLow + prevClose) / 3;
  return {
    pp: rnd2(pp),
    r1: rnd2(2 * pp - prevLow),
    r2: rnd2(pp + (prevHigh - prevLow)),
    s1: rnd2(2 * pp - prevHigh),
    s2: rnd2(pp - (prevHigh - prevLow)),
    prevHigh: rnd2(prevHigh),
    prevLow: rnd2(prevLow),
    prevClose: rnd2(prevClose),
  };
}

/** Classify HTF/LTF state into a single bias label. */
function classifyBias(latestData) {
  const state = String(latestData?.state || "").toUpperCase();
  if (state.includes("HTF_BULL_LTF_PULLBACK")) return "BULL_PULLBACK";
  if (state.includes("HTF_BULL")) return "BULL_TREND";
  if (state.includes("HTF_BEAR_LTF_BOUNCE")) return "BEAR_BOUNCE";
  if (state.includes("HTF_BEAR")) return "BEAR_TREND";
  if (state.includes("NEUTRAL")) return "NEUTRAL";
  if (state.includes("PULLBACK")) return "BULL_PULLBACK";
  return state || "NEUTRAL";
}

/**
 * Load up to `limit` daily candles for a ticker from D1.
 * Uses the same `ticker_candles` table that the Right Rail's
 * /timed/candles endpoint reads from, guaranteeing identical inputs.
 */
async function loadDailyCandles(env, ticker, limit = 40) {
  const db = env?.DB;
  if (!db) return [];
  try {
    const rows = (await db.prepare(
      `SELECT ts, o, h, l, c FROM ticker_candles
       WHERE tf = 'D' AND ticker = ?1
       ORDER BY ts DESC LIMIT ?2`
    ).bind(String(ticker).toUpperCase(), limit).all())?.results || [];
    return rows.reverse().map(r => ({
      ts: Number(r.ts),
      o: Number(r.o),
      h: Number(r.h),
      l: Number(r.l),
      c: Number(r.c),
    }));
  } catch {
    return [];
  }
}

/** Load 5m candles for overnight / opening-range game plans. */
async function loadM5Candles(env, ticker, limit = 100) {
  const db = env?.DB;
  if (!db) return [];
  try {
    const rows = (await db.prepare(
      `SELECT ts, o, h, l, c FROM ticker_candles
       WHERE tf = '5' AND ticker = ?1
       ORDER BY ts DESC LIMIT ?2`
    ).bind(String(ticker).toUpperCase(), limit).all())?.results || [];
    return rows.reverse().map(r => ({
      ts: Number(r.ts),
      o: Number(r.o),
      h: Number(r.h),
      l: Number(r.l),
      c: Number(r.c),
    }));
  } catch {
    return [];
  }
}

/** Load latest snapshot for the ticker (price, state, bias inputs). */
async function loadLatestSnapshot(env, ticker) {
  const KV = env?.KV_TIMED;
  if (!KV) return null;
  try {
    return await kvGetJSON(KV, `timed:latest:${String(ticker).toUpperCase()}`);
  } catch {
    return null;
  }
}

/**
 * Build the canonical ticker scenario.
 *
 * @param {object} env - { DB, KV_TIMED }
 * @param {string} ticker
 * @returns {Promise<object|null>} canonical scenario, or null if data unavailable
 */
export async function buildTickerScenario(env, ticker, opts = {}) {
  const sym = String(ticker || "").toUpperCase();
  if (!sym) return null;

  const useOvernightPlaybook = isIndexDayTradeEtf(sym);
  const [latest, dailies, m5Candles] = await Promise.all([
    loadLatestSnapshot(env, sym),
    loadDailyCandles(env, sym, 40),
    useOvernightPlaybook ? loadM5Candles(env, sym, 100) : Promise.resolve([]),
  ]);

  if (!latest || dailies.length < 5) {
    return {
      ticker: sym,
      ok: false,
      error: "insufficient_data",
      generated_at: new Date().toISOString(),
      source: SCENARIO_VERSION,
    };
  }

  // 2026-06-05 — Optional live-price override. The snapshot price is the RTH
  // close while the market is closed; callers that want the game plan + levels
  // anchored to the LIVE (pre/post-market) price pass priceOverride so the
  // triggers/targets regenerate around where the index actually is now.
  const _override = Number(opts.priceOverride);
  const price = (Number.isFinite(_override) && _override > 0)
    ? _override
    : (Number(latest.price) || Number(latest.close) || 0);
  const prevClose = Number(latest.prev_close) || Number(dailies[dailies.length - 2]?.c) || 0;
  const atr14 = computeATR14(dailies);
  const bias = classifyBias(latest);

  // Swing-based S/R from 40 daily candles (same source as Right Rail)
  const { highs, lows } = detectSwingPoints(dailies, 2);
  const nearResistances = highs
    .filter(h => h.price > price * 0.985 && h.price < price * 1.10)
    .sort((a, b) => a.price - b.price)
    .slice(0, 3);
  const nearSupports = lows
    .filter(l => l.price < price * 1.015 && l.price > price * 0.90)
    .sort((a, b) => b.price - a.price)
    .slice(0, 3);

  // Pivots from previous daily candle
  const prevDay = dailies[dailies.length - 2];
  const pivots = prevDay
    ? computePivots(Number(prevDay.h), Number(prevDay.l), Number(prevDay.c))
    : null;

  // ATR fib from prev close anchor
  const anchor = Number(prevClose) || price;
  const atrFib = atr14 > 0 ? {
    up_618: rnd2(anchor + atr14 * 0.618),
    up_100: rnd2(anchor + atr14 * 1.0),
    down_618: rnd2(anchor - atr14 * 0.618),
    down_100: rnd2(anchor - atr14 * 1.0),
  } : null;

  // Compose canonical levels list (sorted, deduped, with provenance)
  const supportLevels = [];
  const resistanceLevels = [];
  // Prev close (always added as anchor)
  if (Number.isFinite(anchor)) {
    if (anchor < price) supportLevels.push({ price: rnd2(anchor), label: "Prev Close", source: "anchor" });
    else if (anchor > price) resistanceLevels.push({ price: rnd2(anchor), label: "Prev Close", source: "anchor" });
  }
  // Pivots
  if (pivots) {
    if (pivots.s1 < price) supportLevels.push({ price: pivots.s1, label: "S1 (pivot)", source: "pivot" });
    if (pivots.s2 < price) supportLevels.push({ price: pivots.s2, label: "S2 (pivot)", source: "pivot" });
    if (pivots.r1 > price) resistanceLevels.push({ price: pivots.r1, label: "R1 (pivot)", source: "pivot" });
    if (pivots.r2 > price) resistanceLevels.push({ price: pivots.r2, label: "R2 (pivot)", source: "pivot" });
  }
  // Swing levels
  for (const h of nearResistances) {
    resistanceLevels.push({ price: rnd2(h.price), label: `Swing R ${rnd2(h.price)}`, source: "swing" });
  }
  for (const l of nearSupports) {
    supportLevels.push({ price: rnd2(l.price), label: `Swing S ${rnd2(l.price)}`, source: "swing" });
  }
  // ATR fib (only when far from anchor)
  if (atrFib && atr14 > 0) {
    const dist = price - anchor;
    if (dist > atr14 * 0.382) {
      resistanceLevels.push({ price: atrFib.up_618, label: "ATR +61.8%", source: "atr_fib" });
      resistanceLevels.push({ price: atrFib.up_100, label: "ATR +100%", source: "atr_fib" });
    } else if (dist < -atr14 * 0.382) {
      supportLevels.push({ price: atrFib.down_618, label: "ATR -61.8%", source: "atr_fib" });
      supportLevels.push({ price: atrFib.down_100, label: "ATR -100%", source: "atr_fib" });
    }
  }
  // Sort + dedupe (keep first occurrence by price within $0.10)
  function dedupeAndSort(arr, asc) {
    const sorted = [...arr].sort((a, b) => asc ? a.price - b.price : b.price - a.price);
    const out = [];
    for (const lvl of sorted) {
      const dup = out.find(o => Math.abs(o.price - lvl.price) < 0.10);
      if (!dup) out.push(lvl);
    }
    return out;
  }
  const finalSupports = dedupeAndSort(supportLevels.filter(l => l.price < price), false).slice(0, 4);
  const finalResistances = dedupeAndSort(resistanceLevels.filter(l => l.price > price), true).slice(0, 4);

  // Game plan: index ETFs use overnight + opening-range playbook (shared
  // with daily-brief summarizeTechnical). Other tickers keep swing S/R.
  let game_plan;
  if (useOvernightPlaybook) {
    const overnightRange = computeOvernightRangeFromM5(m5Candles);
    const openingRange = computeOpeningRangeFromM5(m5Candles);
    const anchor = Number(prevClose) || price;
    // Daily structure nudge for the day lean: last close vs 5-day SMA,
    // clamped to ±1 (±1% deviation ≈ full weight). Minor vs the intraday
    // evidence, but tilts NEUTRAL tape toward the prevailing daily drift.
    let _trendBias = 0;
    try {
      const _closes = (dailies || []).map((d) => Number(d.c)).filter(Number.isFinite);
      if (_closes.length >= 6) {
        const _sma5 = _closes.slice(-5).reduce((a, b) => a + b, 0) / 5;
        const _last = _closes[_closes.length - 1];
        if (_sma5 > 0) _trendBias = Math.max(-1, Math.min(1, ((_last - _sma5) / _sma5) / 0.01));
      }
    } catch (_) {}
    game_plan = buildOvernightDayTradeGamePlan({
      curPrice: price,
      anchor,
      dayAtr: atr14,
      overnightRange,
      openingRange,
      trendBias: _trendBias,
      researchBias: researchBiasForIndexLean(),
      snakeCase: true,
    });
  }
  if (!game_plan) {
    const _MIN_GAP = Math.max(atr14 * 0.50, price * 0.004);
    const bullTrigger = finalResistances[0]?.price || rnd2(price + atr14 * 0.25);
    const bearTrigger = finalSupports[0]?.price || rnd2(price - atr14 * 0.25);
    const _pickFurther = (levels, fromPrice, dir) => {
      const minOk = dir > 0 ? fromPrice + _MIN_GAP : fromPrice - _MIN_GAP;
      for (const l of levels) {
        if (dir > 0 && l.price >= minOk) return l.price;
        if (dir < 0 && l.price <= minOk) return l.price;
      }
      return null;
    };
    const bullTarget = _pickFurther(finalResistances, bullTrigger, +1) || rnd2(bullTrigger + Math.max(atr14 * 1.0, _MIN_GAP));
    const bearTarget = _pickFurther(finalSupports, bearTrigger, -1) || rnd2(bearTrigger - Math.max(atr14 * 1.0, _MIN_GAP));
    game_plan = {
      bull_trigger: rnd2(bullTrigger),
      bull_target: rnd2(bullTarget),
      bear_trigger: rnd2(bearTrigger),
      bear_target: rnd2(bearTarget),
      playbook: "swing_reclaim",
    };
  }

  // Golden Gate: best-effort from latest snapshot. Not all tickers have GG,
  // so this is null when not available. Daily Brief will skip the section.
  const golden_gate = (latest?.golden_gate && typeof latest.golden_gate === "object")
    ? {
      direction: latest.golden_gate.direction || null,
      label: latest.golden_gate.label || "GG",
      trigger: Number(latest.golden_gate.trigger) || null,
      target_50: Number(latest.golden_gate.target_50) || null,
      target_618: Number(latest.golden_gate.target_618) || null,
      probability_pct: Number(latest.golden_gate.probability_pct) || null,
      distance_pct: latest.golden_gate.trigger
        ? rnd2(((price - Number(latest.golden_gate.trigger)) / Number(latest.golden_gate.trigger)) * 100)
        : null,
    }
    : null;

  return {
    ok: true,
    ticker: sym,
    price: rnd2(price),
    prev_close: rnd2(prevClose),
    atr14: rnd2(atr14),
    bias,
    state_raw: latest?.state || null,
    levels: {
      support: finalSupports,
      resistance: finalResistances,
    },
    pivots,
    atr_fib: atrFib,
    golden_gate,
    game_plan,
    generated_at: new Date().toISOString(),
    source: SCENARIO_VERSION,
  };
}
