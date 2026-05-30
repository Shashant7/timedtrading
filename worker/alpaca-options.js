// worker/alpaca-options.js
//
// ─────────────────────────────────────────────────────────────────────────────
//  Alpaca Options Chain Client
// ─────────────────────────────────────────────────────────────────────────────
//
//  Replaces the TwelveData options endpoint (which returns 404 on our
//  account despite docs claiming pro-plan support). Alpaca's options
//  Market Data API is already authenticated for us (we use the same key
//  for stock execution) and provides:
//
//    • Chain snapshots: GET /v1beta1/options/snapshots/{symbol}
//    • Per-leg: bid, ask, last, daily bar, IV, Greeks (delta, gamma,
//      theta, vega, rho)
//    • Filters by expiration_date, strike range, type (call/put)
//    • Feed: 'opra' (real-time, paid) or 'indicative' (delayed, free)
//
//  Symbol format: OCC standard — e.g. 'AAPL240426C00162500' =
//    AAPL Apr 26 2024 Call $162.50. We parse strike/expiry/right back out.
//
//  Auth: APCA-API-KEY-ID + APCA-API-SECRET-KEY headers.
//  Base URL: https://data.alpaca.markets
//
//  Authored 2026-05-30.

const ALPACA_DATA_BASE = "https://data.alpaca.markets";

function _alpacaHeaders(env) {
  const keyId = env?.ALPACA_API_KEY_ID;
  const secret = env?.ALPACA_API_SECRET_KEY;
  if (!keyId || !secret) return null;
  return {
    "APCA-API-KEY-ID": keyId,
    "APCA-API-SECRET-KEY": secret,
    "Accept": "application/json",
  };
}

/**
 * Parse an OCC option symbol into its components.
 *  Input:  "AAPL240426C00162500"
 *  Output: { underlying: "AAPL", expiration: "2024-04-26",
 *            right: "C", strike: 162.50 }
 */
export function parseOCCSymbol(occ) {
  if (!occ || typeof occ !== "string" || occ.length < 16) return null;
  // OCC format: ROOT (1-6 chars), YYMMDD (6 chars), C|P (1 char), strike (8 chars × 1000)
  // Find the C/P boundary by scanning from the right — strike is 8 digits.
  const m = occ.match(/^([A-Z]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/);
  if (!m) return null;
  const [, root, yy, mm, dd, right, strikeRaw] = m;
  const year = `20${yy}`;
  return {
    underlying: root,
    expiration: `${year}-${mm}-${dd}`,
    right,
    strike: Number(strikeRaw) / 1000,
    occ,
  };
}

/**
 * Fetch the option chain snapshot for an underlying + (optional) expiration.
 * Returns the same shape our strategy engine consumes:
 *   { ok, symbol, expiration, calls: [...], puts: [...], underlying_price, fetched_at }
 * Each leg: { strike, bid, ask, mid, last, volume, open_interest,
 *             implied_volatility, delta, gamma, theta, vega, rho, symbol }
 *
 * @param {string} symbol           — underlying ticker
 * @param {string} expirationDate   — ISO YYYY-MM-DD (exact match)
 * @param {object} opts             — { strikeRangePct?: 0.20 — ±% from underlying }
 */
export async function alpacaFetchOptionsChain(env, symbol, expirationDate, opts = {}) {
  const headers = _alpacaHeaders(env);
  if (!headers) return { ok: false, error: "missing_alpaca_creds" };
  if (!symbol) return { ok: false, error: "missing_symbol" };

  const tdSym = String(symbol).toUpperCase();

  // Build query — exact expiration if provided, else nearest set.
  const params = new URLSearchParams();
  if (expirationDate) params.set("expiration_date", expirationDate);
  params.set("limit", "200");
  // Strike range filter — keep payload small. Default ±25% from underlying.
  const strikeRangePct = opts.strikeRangePct ?? 0.25;
  // We need underlying price to set strike bounds. Try to get it from
  // the price KV cache first (cheap), else skip the strike filter.
  let underlyingPx = null;
  try {
    const pricesRaw = await env.KV_TIMED?.get("timed:prices");
    if (pricesRaw) {
      const prices = JSON.parse(pricesRaw);
      const row = prices?.prices?.[tdSym] || prices?.[tdSym];
      if (row?.p) underlyingPx = Number(row.p);
    }
  } catch (_) {}
  if (underlyingPx > 0 && strikeRangePct > 0) {
    params.set("strike_price_gte", String(Math.floor(underlyingPx * (1 - strikeRangePct))));
    params.set("strike_price_lte", String(Math.ceil(underlyingPx * (1 + strikeRangePct))));
  }

  const url = `${ALPACA_DATA_BASE}/v1beta1/options/snapshots/${encodeURIComponent(tdSym)}?${params.toString()}`;

  try {
    const r = await fetch(url, { headers, cf: { cacheTtl: 60 } });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      return { ok: false, error: `http_${r.status}`, body: body.slice(0, 200) };
    }
    const j = await r.json();
    const snapshots = j?.snapshots || {};

    // Normalize: separate calls vs puts, parse strike from OCC symbol.
    const calls = [];
    const puts = [];
    for (const [occ, snap] of Object.entries(snapshots)) {
      if (!snap || typeof snap !== "object") continue;
      const parsed = parseOCCSymbol(occ);
      if (!parsed) continue;
      // If exact expiration filter was used, Alpaca already filtered, but
      // double-check.
      if (expirationDate && parsed.expiration !== expirationDate) continue;
      const q = snap.latestQuote || {};
      const t = snap.latestTrade || {};
      const g = snap.greeks || {};
      const bid = Number(q.bp);
      const ask = Number(q.ap);
      const mid = Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0
        ? Math.round(((bid + ask) / 2) * 100) / 100
        : Number(t.p) || null;
      const leg = {
        strike: parsed.strike,
        bid: Number.isFinite(bid) ? bid : null,
        ask: Number.isFinite(ask) ? ask : null,
        mid,
        last: Number(t.p) || null,
        volume: Number(snap.dailyBar?.v) || 0,
        // Alpaca doesn't return open_interest directly in snapshots — only
        // contract metadata. For now use bid_size + ask_size as a liquidity
        // proxy. (Real OI requires a separate /contracts endpoint call.)
        open_interest: Math.max(Number(q.bs) || 0, Number(q.as) || 0),
        implied_volatility: Number(snap.impliedVolatility) || null,
        delta: Number(g.delta) || null,
        gamma: Number(g.gamma) || null,
        theta: Number(g.theta) || null,
        vega:  Number(g.vega)  || null,
        rho:   Number(g.rho)   || null,
        symbol: occ,
        expiration: parsed.expiration,
      };
      if (parsed.right === "C") calls.push(leg);
      else if (parsed.right === "P") puts.push(leg);
    }

    // Sort by strike ascending.
    calls.sort((a, b) => a.strike - b.strike);
    puts.sort((a, b) => a.strike - b.strike);

    // 2026-05-30 — Merge real Open Interest from the contracts endpoint.
    // Snapshots don't include OI; we have to make a second call. This
    // happens once per chain fetch and is KV-cached at the caller level
    // for 5min RTH / 30min off-hours, so the cost is bounded.
    let oi_enriched_count = 0;
    if (opts.skipOI !== true && expirationDate) {
      try {
        const oiRes = await alpacaFetchContractOI(env, tdSym, expirationDate);
        if (oiRes.ok) {
          for (const leg of calls.concat(puts)) {
            const oi = oiRes.oi_map[leg.symbol];
            if (oi && Number.isFinite(oi.open_interest)) {
              leg.open_interest = oi.open_interest;
              leg.open_interest_date = oi.open_interest_date;
              oi_enriched_count++;
            }
          }
        }
      } catch (_) { /* OI is bonus — never block chain fetch */ }
    }

    return {
      ok: true,
      symbol: tdSym,
      expiration: expirationDate || null,
      underlying_price: underlyingPx,
      calls,
      puts,
      fetched_at: Date.now(),
      provider: "alpaca",
      feed: opts.feed || "default",
      oi_enriched_count,
    };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
}

/**
 * Fetch the per-contract Open Interest from Alpaca's contracts metadata
 * endpoint. The snapshots endpoint doesn't include OI directly — we have
 * to call /v2/options/contracts to get it. Returns a map of OCC symbol →
 * { open_interest, open_interest_date, contract_symbol }.
 *
 * Caller batches the OCC symbol list (one call returns up to 10000
 * contracts) keyed by underlying. We page through if needed.
 *
 * Note: this uses the BROKER API (https://paper-api.alpaca.markets OR
 * https://api.alpaca.markets), not the market-data API, because contract
 * metadata sits on the broker side.
 *
 * @param {string} symbol - underlying ticker
 * @param {string} expiration - ISO YYYY-MM-DD (exact match filter)
 * @returns {Promise<{ok, oi_map: Record<occ, {open_interest, ...}>}>}
 */
export async function alpacaFetchContractOI(env, symbol, expiration) {
  const keyId = env?.ALPACA_API_KEY_ID;
  const secret = env?.ALPACA_API_SECRET_KEY;
  if (!keyId || !secret) return { ok: false, error: "missing_alpaca_creds", oi_map: {} };
  const brokerBase = env?.ALPACA_BASE_URL || "https://paper-api.alpaca.markets";

  const params = new URLSearchParams({
    underlying_symbols: String(symbol).toUpperCase(),
    status: "active",
    limit: "1000",
  });
  if (expiration) {
    params.set("expiration_date", expiration);
  }
  const url = `${brokerBase}/v2/options/contracts?${params.toString()}`;
  try {
    const r = await fetch(url, {
      headers: {
        "APCA-API-KEY-ID": keyId,
        "APCA-API-SECRET-KEY": secret,
        "Accept": "application/json",
      },
      cf: { cacheTtl: 300 },
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      return { ok: false, error: `http_${r.status}`, body: body.slice(0, 200), oi_map: {} };
    }
    const j = await r.json();
    const contracts = Array.isArray(j?.option_contracts) ? j.option_contracts : [];
    const oi_map = {};
    for (const c of contracts) {
      const occ = c?.symbol;
      if (!occ) continue;
      oi_map[occ] = {
        open_interest: Number(c.open_interest) || 0,
        open_interest_date: c.open_interest_date || null,
      };
    }
    return { ok: true, oi_map, count: contracts.length };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 200), oi_map: {} };
  }
}

/**
 * List available expiration dates for an underlying.
 * Alpaca derives these from the chain snapshot — we fetch all contracts
 * and extract the distinct expiration set.
 *
 * For efficiency, we use a wider strike filter (1 strike either side of
 * ATM) to reduce payload — we only need the unique expirations.
 */
export async function alpacaFetchOptionsExpirations(env, symbol) {
  const headers = _alpacaHeaders(env);
  if (!headers) return { ok: false, error: "missing_alpaca_creds", expirations: [] };
  const tdSym = String(symbol).toUpperCase();
  // Pull underlying price to filter to a narrow strike range.
  let underlyingPx = null;
  try {
    const pricesRaw = await env.KV_TIMED?.get("timed:prices");
    if (pricesRaw) {
      const prices = JSON.parse(pricesRaw);
      const row = prices?.prices?.[tdSym] || prices?.[tdSym];
      if (row?.p) underlyingPx = Number(row.p);
    }
  } catch (_) {}
  const params = new URLSearchParams({ limit: "500" });
  if (underlyingPx > 0) {
    // Tight strike band (±2%) — we only need the expiration set, not the
    // full chain.
    params.set("strike_price_gte", String(Math.floor(underlyingPx * 0.98)));
    params.set("strike_price_lte", String(Math.ceil(underlyingPx * 1.02)));
  }
  const url = `${ALPACA_DATA_BASE}/v1beta1/options/snapshots/${encodeURIComponent(tdSym)}?${params.toString()}`;
  try {
    const r = await fetch(url, { headers, cf: { cacheTtl: 3600 } });
    if (!r.ok) return { ok: false, error: `http_${r.status}`, expirations: [] };
    const j = await r.json();
    const set = new Set();
    for (const occ of Object.keys(j?.snapshots || {})) {
      const parsed = parseOCCSymbol(occ);
      if (parsed?.expiration) set.add(parsed.expiration);
    }
    const expirations = Array.from(set).sort();
    return { ok: true, symbol: tdSym, expirations };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 200), expirations: [] };
  }
}
