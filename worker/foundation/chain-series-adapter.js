// worker/foundation/chain-series-adapter.js
// ─────────────────────────────────────────────────────────────────────────────
//  FOUNDATION — Phase 2 SEAM: read the scoring pipeline's candles from the
//  CANDLE CHAIN instead of the per-TF D1 store.
//
//  The live scorer (`computeServerSideScores(ticker, getCandles, env, ...)` in
//  worker/indicators.js) consumes candles through a single injected callback:
//    getCandles(env, ticker, tf, limit) -> { ok, candles: [{ts,o,h,l,c,v}] }
//  That callback is the ONLY seam between "where candles come from" and "how
//  they are scored". Phase 2 of tasks/2026-06-14-foundation-rebuild-plan.md
//  cuts indicators + score onto the chain by swapping this one callback for a
//  chain-backed reader — live and replay run the IDENTICAL scoring core over
//  the IDENTICAL input contract, which is what makes backtest ≡ live.
//
//  Crucially, each returned series carries the chain's `complete` flag +
//  `coverage`, so the score layer can REFUSE (UNSCORABLE) on an incomplete /
//  gappy window instead of silently computing on short history — the structural
//  fix for "live looked scored but ran on stale candles".
//
//  Pure: depends only on the candle-chain derive + trading-calendar. No I/O.
// ─────────────────────────────────────────────────────────────────────────────

import { deriveTimeframe } from "./candle-chain.js";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const RTH_MIN_PER_DAY = 390; // 6.5h regular session

const INTRADAY_TF_MIN = { "5": 5, "10": 10, "15": 15, "30": 30, "60": 60, "1H": 60, "240": 240, "4H": 240 };

/**
 * Compute a generous [startMs, endMs) lookback window for `limit` bars of `tf`
 * ending at `asOf`. Over-scans for weekends/holidays; the chain derive clips to
 * the calendar grid and the adapter slices to the last `limit` bars, so a loose
 * window never over-returns.
 */
export function windowForTf(tf, limit, asOf) {
  const tfu = String(tf);
  const endMs = asOf;
  const n = Math.max(1, Number(limit) || 1);
  if (INTRADAY_TF_MIN[tfu]) {
    const barsPerDay = RTH_MIN_PER_DAY / INTRADAY_TF_MIN[tfu];
    const tradingDays = Math.ceil(n / barsPerDay) + 5;
    const calDays = Math.ceil(tradingDays * 1.7) + 3; // weekends/holidays cushion
    return { startMs: endMs - calDays * DAY, endMs };
  }
  if (tfu === "D") return { startMs: endMs - (Math.ceil(n * 1.7) + 10) * DAY, endMs };
  if (tfu === "W") return { startMs: endMs - (n * 9 + 30) * DAY, endMs };
  if (tfu === "M") return { startMs: endMs - (n * 45 + 90) * DAY, endMs };
  return { startMs: endMs - (n * 1.7 + 10) * DAY, endMs };
}

/**
 * Build a `getCandles(env, ticker, tf, limit)` backed by a chain `getSeries`.
 *
 * @param {(ticker:string, tf:string, opts:{startMs,endMs,asOf,source}) => Promise<import("./series-contract.js").SeriesView>} getSeries
 * @param {Object} [opts] { asOf?:number, source?:"live"|"as_of" }
 * @returns {(env:any, ticker:string, tf:string, limit?:number) => Promise<{ok,ticker,tf,candles,complete,coverage}>}
 */
export function makeChainGetCandles(getSeries, opts = {}) {
  const asOf = opts.asOf ?? Date.now();
  const source = opts.source || "as_of";
  return async function getCandles(env, ticker, tf, limit = 300) {
    const tfu = String(tf);
    const { startMs, endMs } = windowForTf(tfu, limit, asOf);
    const view = await getSeries(ticker, tfu, { startMs, endMs, asOf, source });
    const all = (view && Array.isArray(view.bars)) ? view.bars : [];
    const candles = all.slice(-Math.max(1, Number(limit) || 1));
    return {
      ok: candles.length > 0,
      ticker: String(ticker).toUpperCase(),
      tf: tfu,
      candles,
      // Pass the chain's honesty flags up so the score layer can gate on them.
      complete: view ? view.complete : false,
      coverage: view ? view.coverage : null,
    };
  };
}

/**
 * Convenience: a chain `getSeries` built directly from in-memory bases (a 5m
 * base + a daily base) via the pure derive — no Durable Object needed. Used by
 * the parity harness and tests to feed the real scoring pipeline from the chain.
 *
 * @param {Object} bases { base5m:Bar[], baseDaily:Bar[] }
 */
export function getSeriesFromBases({ base5m = [], baseDaily = [] }) {
  return async function getSeries(ticker, tf, { startMs, endMs, asOf, source = "as_of" }) {
    return deriveTimeframe(tf, {
      ticker, base5m, baseDaily,
      asOf: asOf ?? endMs, windowStartMs: startMs, windowEndMs: endMs, source,
    });
  };
}

/** Shorthand: getCandles built straight from in-memory bases. */
export function makeChainGetCandlesFromBases(bases, opts = {}) {
  return makeChainGetCandles(getSeriesFromBases(bases), opts);
}

// The LTF timeframes the chain serves in the HYBRID model — the layer where the
// live≠backtest drift lived (each was an independently-fetched, drift-prone
// series). Derived from one RTH/extended 5m base ⇒ consistent by construction.
export const HYBRID_CHAIN_TFS = ["10", "15", "30", "60"];

/**
 * HYBRID getCandles: route a fixed set of timeframes to the CHAIN and let all
 * others fall through to the LEGACY reader. Rationale (storage-driven, verified
 * 2026-06-15): deriving the DEEP HTF 240 EMA-stack from 5m needs ~years of 5m
 * (~50–100× storage), so 240/D/W/M stay on their existing deep stores while the
 * LTF (10/15/30/60) — cheap to derive from months of 5m and where the drift was
 * — comes from the chain. This is the cutover surface: flip LTF-only first.
 *
 * @param {Function} chainGetCandles  (env,ticker,tf,limit)=>{ok,candles,...}
 * @param {Function} legacyGetCandles (env,ticker,tf,limit)=>{ok,candles,...}
 * @param {Object} [opts] { chainTfs?: string[] }  defaults to HYBRID_CHAIN_TFS
 */
export function makeHybridGetCandles(chainGetCandles, legacyGetCandles, opts = {}) {
  const chainSet = new Set((opts.chainTfs || HYBRID_CHAIN_TFS).map(String));
  // FAIL-SAFE: if the chain can't satisfy a TF (base not deep/seeded enough, or
  // it errors), fall back to the legacy reader for that TF. This makes flipping
  // the cutover flag safe even before every ticker's 5m base is warm — a ticker
  // simply stays on legacy until its chain series is complete. minBars guards
  // against scoring on a too-short derived window.
  const minBars = Number(opts.minBars) || 50;
  const fallback = opts.fallbackOnIncomplete !== false;
  return async function getCandles(env, ticker, tf, limit = 300) {
    if (!chainSet.has(String(tf))) return legacyGetCandles(env, ticker, tf, limit);
    try {
      const r = await chainGetCandles(env, ticker, tf, limit);
      const enough = r && r.ok && Array.isArray(r.candles) && r.candles.length >= minBars && r.complete !== false;
      if (enough || !fallback) return r;
    } catch (_) { /* fall through to legacy */ }
    const lg = await legacyGetCandles(env, ticker, tf, limit);
    if (lg && typeof lg === "object") lg.fellBackFromChain = true;
    return lg;
  };
}

/**
 * REVERSIBLE CUTOVER RESOLVER. Picks the candle source for the live score path
 * based on `env.SCORE_CANDLE_SOURCE`:
 *   • unset / "legacy" (DEFAULT) → the legacy per-TF reader (ZERO behavior change)
 *   • "hybrid_chain"             → chain LTF (10/15/30/60) + legacy 240/D/W/M
 *   • "full_chain"               → chain serves every TF (240 needs deep 5m)
 *
 * The flag defaults OFF, so wiring this into the scoring path is a no-op until
 * the operator flips it — and flipping back is a one-value change. The chain
 * source must be the DO hot-window (not D1) for the cutover to REDUCE D1 reads;
 * pass that as `chainGetCandles`.
 */
export function resolveScoreGetCandles(env, { legacyGetCandles, chainGetCandles, chainTfs } = {}) {
  const mode = String(env?.SCORE_CANDLE_SOURCE || "legacy").toLowerCase();
  if (!chainGetCandles || mode === "legacy") return legacyGetCandles;
  if (mode === "full_chain") return chainGetCandles;
  if (mode === "hybrid_chain") {
    return makeHybridGetCandles(chainGetCandles, legacyGetCandles, { chainTfs: chainTfs || HYBRID_CHAIN_TFS });
  }
  return legacyGetCandles; // unknown value ⇒ fail safe to legacy
}
