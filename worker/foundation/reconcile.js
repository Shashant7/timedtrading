// worker/foundation/reconcile.js
// ─────────────────────────────────────────────────────────────────────────────
//  FOUNDATION — base-fidelity reconciliation (Phase 1b).
//
//  Once every timeframe is DERIVED from one base, cross-timeframe consistency is
//  guaranteed by construction — a 30m bar is definitionally its six 5m bars. So
//  correctness reduces to: is the 5m BASE complete and faithful? The provider's
//  own intraday higher-TF bars are NOT a reliable ground truth (the shadow
//  reconcile showed its 60m/240m don't equal the aggregate of its own 5m), so we
//  do NOT validate derived intraday against them.
//
//  The strong, anchor-independent "calculated vs source" check is the DAILY
//  ROLL-UP: aggregate each day's 5m base and compare to the provider's daily
//  bar. High/Low/Volume must match (any missing/extra/bad 5m bar shows up
//  immediately); Open/Close are reported informationally because provider daily
//  O/C often come from the opening/closing auction, not the first/last 5m bar.
//
//  Pure, deterministic, no I/O.
// ─────────────────────────────────────────────────────────────────────────────

import { etDateStr } from "./trading-calendar.js";

// Daily bars are stamped at the trading day's 00:00 in the provider's
// convention (TwelveData uses 00:00 UTC of the trading day). Mapping that with
// etDateStr would shift 00:00Z back to the PREVIOUS ET day, mis-aligning every
// daily bar by one — a bug a web ground-truth spot-check caught (2026-06-15).
// A daily bar's trading date is the UTC calendar date of its (near-midnight)
// stamp; intraday bars (stamped at session time) use the ET date.
function utcDateStr(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * CROSS-SOURCE GROUND TRUTH. Immutable historical OHLC should agree across
 * independent providers; where ≥`quorum` sources agree (within `priceTol`) that
 * is ground truth, and any disagreeing source is an outlier to re-fetch / audit.
 * This is the determination LOGIC; the fetchers (TwelveData, Alpaca, web/exa,
 * Finnhub) are the wiring that feeds it.
 *
 * Tolerance is the LARGER of an absolute floor (`priceTol`) and a relative band
 * (`relTol` × anchor price). The relative band matters at high prices: a $950
 * stock's 5m bars routinely differ by a few cents between SIP feeds (< 0.01%),
 * which an absolute $0.02 floor alone would falsely flag as a disagreement
 * (verified 2026-06-15 on MU 5m). Daily official OHLC are "round" and agree
 * inside the absolute floor, so the default relTol is conservative.
 *
 * @param {Object<string,{o?,h,l,c,v?}>} sources  e.g. { td:{...}, alpaca:{...}, web:{...} }
 * @param {Object} [opts] { fields=["h","l","c"], priceTol=0.02, relTol=0.0005, quorum=2 }
 * @returns {{ agreed:boolean, consensus:object, field_agreement:object,
 *             outliers:string[], sources:string[] }}
 */
export function crossSourceConsensus(sources, opts = {}) {
  const fields = opts.fields || ["h", "l", "c"];
  const absTol = opts.priceTol ?? 0.02;
  const relTol = opts.relTol ?? 0.0005; // 5 bps of price
  const quorum = opts.quorum ?? 2;
  const names = Object.keys(sources || {});
  const consensus = {};
  const field_agreement = {};
  const outliers = new Set();
  let agreed = names.length >= quorum;

  // Two prices agree if within max(absolute floor, relative band of their level).
  const within = (a, b) => Math.abs(a - b) <= Math.max(absTol, relTol * Math.max(Math.abs(a), Math.abs(b)));

  for (const f of fields) {
    const vals = names
      .filter((n) => sources[n] && Number.isFinite(+sources[n][f]))
      .map((n) => ({ name: n, v: +sources[n][f] }));
    // largest cluster whose members are all within tol of an anchor
    let best = [];
    for (const a of vals) {
      const g = vals.filter((b) => within(b.v, a.v));
      if (g.length > best.length) best = g;
    }
    field_agreement[f] = best.length;
    if (best.length >= quorum) {
      consensus[f] = median(best.map((x) => x.v));
      const inGroup = new Set(best.map((x) => x.name));
      for (const v of vals) if (!inGroup.has(v.name)) outliers.add(v.name);
    } else {
      consensus[f] = null;
      agreed = false;
    }
  }
  return { agreed, consensus, field_agreement, outliers: [...outliers], sources: names };
}

/** Aggregate a day's bars: o=first, h=max, l=min, c=last, v=sum. */
function rollup(bars) {
  let o = bars[0].o, h = bars[0].h, l = bars[0].l, c = bars[bars.length - 1].c, v = 0;
  for (const b of bars) { if (b.h > h) h = b.h; if (b.l < l) l = b.l; v += Number(b.v) || 0; }
  return { o, h, l, c, v };
}

/**
 * Reconcile a 5m base against the provider's daily bars (the source).
 * Completeness verdict uses High/Low/Volume; Open/Close deltas are advisory.
 *
 * @param {Array} base5m            5m base bars
 * @param {Array} providerDaily     provider daily bars (one per trading day)
 * @param {Object} [opts]
 * @param {number} [opts.priceTol=0.011]      abs price tolerance for H/L (2dp data)
 * @param {number} [opts.volTolFrac=0.005]    fractional volume tolerance
 * @param {boolean} [opts.requireOpenClose=false]  also gate the verdict on O/C
 * @returns {{
 *   days:number, matched:number, mismatched:number, missing_daily:number,
 *   only_intraday:number, ok:boolean,
 *   mismatches:Array<{date,field,base,provider,delta}>
 * }}
 */
export function reconcileDailyRollup(base5m, providerDaily, opts = {}) {
  const priceTol = opts.priceTol ?? 0.011;
  const volTolFrac = opts.volTolFrac ?? 0.005;
  const requireOC = opts.requireOpenClose === true;

  const byDay = new Map();
  for (const b of base5m || []) {
    if (!b || !Number.isFinite(Number(b.ts))) continue;
    const d = etDateStr(Number(b.ts));
    (byDay.get(d) || byDay.set(d, []).get(d)).push(b);
  }
  for (const arr of byDay.values()) arr.sort((a, b) => a.ts - b.ts);

  const dailyByDay = new Map();
  for (const d of providerDaily || []) {
    if (!d || !Number.isFinite(Number(d.ts))) continue;
    // Daily stamped near midnight → trading date is its UTC calendar date.
    dailyByDay.set(utcDateStr(Number(d.ts)), d);
  }

  const pOk = (a, b) => Math.abs(a - b) <= priceTol;
  // Volume is NOT equality-reconcilable between intraday roll-up and the
  // official daily bar: the daily includes opening/closing-auction prints (and
  // odd-lots) that never appear in intraday bars (~10-25% of a day). Verified
  // 2026-06-15 via web ground truth: RTH 5m H/L matched the daily to the penny
  // while 5m volume was ~75% of daily. So the VERDICT is High/Low (price
  // completeness); volume is a banded ratio that only flags a GROSS undercount
  // (< volMinRatio), which indicates genuinely missing bars.
  const volMinRatio = opts.volMinRatio ?? 0.5;

  let matched = 0, mismatched = 0;
  const mismatches = [];
  for (const [date, dayBars] of byDay) {
    const prov = dailyByDay.get(date);
    if (!prov) continue; // counted as only_intraday below
    const agg = rollup(dayBars);
    const provVol = +prov.v || 0;
    const volRatio = provVol > 0 ? agg.v / provVol : 1;
    const checks = [
      ["high", agg.h, +prov.h, pOk(agg.h, +prov.h)],
      ["low", agg.l, +prov.l, pOk(agg.l, +prov.l)],
      ["volume", agg.v, provVol, !(provVol > 0) || volRatio >= volMinRatio],
    ];
    if (requireOC) {
      checks.push(["open", agg.o, +prov.o, pOk(agg.o, +prov.o)]);
      checks.push(["close", agg.c, +prov.c, pOk(agg.c, +prov.c)]);
    }
    const bad = checks.filter(([, , , ok]) => !ok);
    if (bad.length === 0) matched++;
    else {
      mismatched++;
      for (const [field, base, provider] of bad) {
        if (mismatches.length < 50) mismatches.push({ date, field, base, provider, delta: base - provider });
      }
    }
  }

  const missing_daily = [...byDay.keys()].filter((d) => !dailyByDay.has(d)).length;
  const only_intraday = missing_daily;
  return {
    days: byDay.size,
    matched,
    mismatched,
    missing_daily,
    only_intraday,
    ok: mismatched === 0,
    mismatches,
  };
}
