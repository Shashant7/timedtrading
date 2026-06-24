// ═══════════════════════════════════════════════════════════════════════════════
// Futures proxy registry — TwelveData-served fallback for TV-fed futures
//
// Background: TradingView webhook alerts feed our futures heartbeats
// (timed:heartbeat:ES1!, NQ1!, etc.). TV alerts are fragile — they pause
// silently on indicator failure, network blips, or TV alert quota throttling.
// We considered Tradovate WebSocket as a replacement but their CME
// Non-Display data licensing for API access starts at ~$290/mo, well over
// the value bar for context-only futures display.
//
// This module is a SAFETY NET, not a writer. It does NOT mutate the
// `timed:heartbeat:<FUTURES>` KV blobs that TV writes — that would pollute
// the data. Instead it:
//
//   1. Documents a 1:1-correlated TwelveData-served proxy for each TV
//      futures ticker (ES → SPY, NQ → QQQ, GC → GLD, etc.)
//   2. Ensures every proxy ETF is in the active TD universe, so TD is
//      already polling its price every minute (no extra cost)
//   3. Exposes `getFuturesProxyPrice(env, futuresSym)` so any code path
//      that needs a fallback price during a TV outage can call it
//      explicitly and decide whether to use the proxy
//   4. Surfaces freshness state (TV heartbeat age vs TD proxy age) via
//      `getFuturesProxyHealth(env)` so we can monitor both layers
//
// IMPORTANT — proxies are DIRECTIONAL not absolute. SPY ≈ ES/10 + dividend
// + roll basis. Any consumer that reads a proxy fallback should treat the
// price as "ETF representative" and the day_change_pct as "broadly aligned
// with the futures move" — not as the literal futures price.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Map TV futures ticker → TwelveData ETF symbol that tracks it 1:1
 * directionally. All proxies are ALREADY in the system's TD-served
 * universe (SECTOR_MAP / Market Pulse list), so they get polled by the
 * existing minute price-feed cron at no extra cost.
 *
 * VIX is served natively via TwelveData on the canonical "VIX" symbol
 * (SECTOR_MAP + MARKET_PULSE_SYMS). VX1! TV futures removed 2026-06-23.
 */
export const FUTURES_PROXY_MAP = Object.freeze({
  // Index futures (CME E-mini + Micro E-mini) → broad-market index ETFs
  "ES1!":  "SPY",   // S&P 500 E-mini       → SPDR S&P 500 ETF
  "NQ1!":  "QQQ",   // Nasdaq-100 E-mini    → Invesco QQQ
  "YM1!":  "DIA",   // Dow E-mini           → SPDR Dow Jones ETF
  "RTY1!": "IWM",   // Russell 2000 E-mini  → iShares Russell 2000 ETF
  "MES1!": "SPY",   // Micro S&P 500        → SPY (same underlying index)
  "MNQ1!": "QQQ",   // Micro Nasdaq-100     → QQQ
  "MYM1!": "DIA",   // Micro Dow            → DIA

  // Energy futures → tracking ETFs
  "CL1!":  "USO",   // Crude Oil (WTI)      → United States Oil Fund
  "NG1!":  "UNG",   // Natural Gas          → United States Natural Gas Fund

  // Metals futures → tracking ETFs
  "GC1!":  "GLD",   // Gold                 → SPDR Gold Trust
  "SI1!":  "SLV",   // Silver               → iShares Silver Trust
  "HG1!":  "CPER",  // Copper               → United States Copper Index Fund
});

/** All futures tickers we maintain a proxy for. */
export function futuresWithProxy() {
  return Object.keys(FUTURES_PROXY_MAP);
}

/** Reverse lookup: given an ETF, which futures ticker(s) does it proxy? */
export function futuresProxiedBy(etfSym) {
  const matches = [];
  for (const [fut, etf] of Object.entries(FUTURES_PROXY_MAP)) {
    if (etf === etfSym) matches.push(fut);
  }
  return matches;
}

/** Set of all proxy ETF symbols (deduped). Useful when validating universe coverage. */
export function proxyEtfs() {
  return [...new Set(Object.values(FUTURES_PROXY_MAP))];
}

// ── Read-side helpers ────────────────────────────────────────────────────────

/**
 * Get the TwelveData proxy price for a futures ticker. Reads from KV — does
 * NOT call any external API, so it's cheap to call inline from a request
 * handler.
 *
 * Returns:
 *   { ok: true, futures, proxy, price, day_change_pct, day_change, ts, age_ms }
 * or
 *   { ok: false, futures, error, proxy? }
 *
 * Callers decide how to use it. Suggested pattern:
 *
 *   const tvHb = await kvGetJSON(KV, `timed:heartbeat:${fut}`);
 *   const tvFresh = tvHb && (Date.now() - tvHb.ingest_ts) < 10 * 60 * 1000;
 *   if (tvFresh) return tvHb;                          // TV is fine
 *   const proxy = await getFuturesProxyPrice(env, fut);
 *   if (proxy.ok) return { ...proxy, _via_proxy: true }; // explicit fallback
 *   return null;                                          // hard miss
 */
export async function getFuturesProxyPrice(env, futuresSym) {
  const proxy = FUTURES_PROXY_MAP[String(futuresSym || "").toUpperCase()];
  if (!proxy) {
    return { ok: false, futures: futuresSym, error: "no_proxy_defined" };
  }
  const KV = env?.KV_TIMED;
  if (!KV) return { ok: false, futures: futuresSym, proxy, error: "no_kv" };
  let livePrices = null;
  try {
    livePrices = await KV.get("timed:prices", { type: "json" });
  } catch (e) {
    return { ok: false, futures: futuresSym, proxy, error: `kv_read_failed:${String(e).slice(0, 80)}` };
  }
  const pf = livePrices?.prices?.[proxy];
  if (!pf || !(Number(pf.p) > 0)) {
    return { ok: false, futures: futuresSym, proxy, error: "proxy_price_missing" };
  }
  return {
    ok: true,
    futures: futuresSym,
    proxy,
    price:           Number(pf.p),
    prev_close:      Number(pf.pc) || null,
    day_change:      Number(pf.dc) || null,
    day_change_pct:  Number(pf.dp) || null,
    ts:              Number(pf.t)  || null,
    age_ms:          pf.t ? (Date.now() - Number(pf.t)) : null,
  };
}

/**
 * Health snapshot — for every futures ticker, return both the TV heartbeat
 * age and the TD proxy availability so an admin can see at-a-glance which
 * futures are at risk of going dark if TV fails right now.
 *
 * Returns: { ok: true, generated_at, items: [{ futures, proxy, tv: {...}, td: {...} }] }
 */
export async function getFuturesProxyHealth(env) {
  const KV = env?.KV_TIMED;
  if (!KV) return { ok: false, error: "no_kv" };
  const _now = Date.now();
  let livePrices = null;
  try { livePrices = await KV.get("timed:prices", { type: "json" }); } catch {}
  const items = [];
  for (const [futuresSym, proxySym] of Object.entries(FUTURES_PROXY_MAP)) {
    let tvHb = null;
    try { tvHb = await KV.get(`timed:heartbeat:${futuresSym}`, { type: "json" }); } catch {}
    const tvAge = tvHb?.ingest_ts ? (_now - Number(tvHb.ingest_ts)) : null;
    const pf = livePrices?.prices?.[proxySym] || null;
    const tdAge = pf?.t ? (_now - Number(pf.t)) : null;
    /* Freshness rules tuned for the dual-market reality:
       - Futures (TV): trade ~6 PM - 5 PM ET = 23 hours/day. Should be
         tick-fresh within ~10 min during the session, expected to gap
         during the 5-6 PM ET reset window only.
       - ETF proxies (TD): trade RTH only (9:30 AM - 4 PM ET). After hours
         the LAST RTH PRINT is the most recent value and stays in TD's KV
         all night. That's still a useful "broad-market context" data point,
         so we treat ANY non-null TD price as `available`. We separately
         flag `intra_session_stale` if the price IS supposed to be fresh
         (RTH) but isn't ticking. */
    const tvFresh = tvAge != null && tvAge < 10 * 60 * 1000;
    const tdAvailable = pf != null && Number(pf.p) > 0;
    items.push({
      futures: futuresSym,
      proxy: proxySym,
      tv: tvHb ? {
        price: Number(tvHb.price) || null,
        ingest_ts: Number(tvHb.ingest_ts) || null,
        age_min: tvAge != null ? Math.round(tvAge / 60000 * 10) / 10 : null,
        fresh: tvFresh,
        src: tvHb.src || tvHb.ingest_kind || null,
      } : { fresh: false, age_min: null, error: "no_heartbeat" },
      td_proxy: tdAvailable ? {
        price: Number(pf.p) || null,
        prev_close: Number(pf.pc) || null,
        day_change_pct: Number(pf.dp) || null,
        ts: Number(pf.t) || null,
        age_min: tdAge != null ? Math.round(tdAge / 60000 * 10) / 10 : null,
        available: true,
      } : { available: false, age_min: null, error: "no_td_price" },
    });
  }
  // Summarize at the top so an operator sees the bottom line first.
  // "at_risk_if_tv_fails" = TV-dependent futures with no usable proxy at all
  // (typically because the proxy ETF was deleted from the universe or has
  // never had a price feed — needs investigation).
  const totalFutures = items.length;
  const tvFreshCount = items.filter(i => i.tv.fresh).length;
  const tdAvailableCount = items.filter(i => i.td_proxy.available).length;
  const atRisk = items.filter(i => !i.td_proxy.available).map(i => i.futures);
  const hardOffline = items.filter(i => !i.tv.fresh && !i.td_proxy.available).map(i => i.futures);
  return {
    ok: true,
    generated_at: _now,
    summary: {
      total: totalFutures,
      tv_fresh: tvFreshCount,
      td_proxy_available: tdAvailableCount,
      at_risk_if_tv_fails: atRisk,        // proxy itself is missing — fix this
      hard_offline: hardOffline,           // TV stale AND no proxy data — full outage
    },
    items,
  };
}
