// ═══════════════════════════════════════════════════════════════════════════════
// TwelveData REST API Client
// Implements data-fetching functions for the TwelveData API.
// All functions return normalized shapes matching the data-provider interface.
// ═══════════════════════════════════════════════════════════════════════════════

const TD_BASE = "https://api.twelvedata.com";

// Internal TF key → TwelveData interval string
const TF_TO_TD = {
  "1": "1min",
  "5": "5min",
  "10": null, // aggregated from 5min
  "15": "15min",
  "30": "30min",
  "60": "1h",
  "240": "4h",
  "D": "1day",
  "W": "1week",
  "M": "1month",
};

// Internal crypto symbols → TwelveData format
const CRYPTO_TO_TD = { BTCUSD: "BTC/USD", ETHUSD: "ETH/USD" };
const TD_TO_CRYPTO = Object.fromEntries(
  Object.entries(CRYPTO_TO_TD).map(([k, v]) => [v, k]),
);

// Symbol normalization: internal symbol → TwelveData symbol.
// Legacy VX1! reads still map to TD "VIX"; canonical KV key is VIX (2026-06-23).
const SYM_NORMALIZE = {
  "BRK-B": "BRK.B",
};
const TD_TO_INTERNAL = Object.fromEntries(
  Object.entries(SYM_NORMALIZE).map(([internal, td]) => [td, internal]),
);
const LEGACY_TD_ALIASES = Object.freeze({
  "VX1!": "VIX",
});

// Non-equity tickers that TwelveData cannot serve cleanly via /quote +
// /time_series for our US-equity universe.
//
// P0.7.132 — VX1! maps to TD "VIX" for legacy reads only. TD does NOT
// serve the CBOE VIX index on our plan (404 on /quote and /time_series).
// Canonical live price + timed:latest come from VX1! via MACRO_CANONICAL_SOURCES.
//
// 2026-05-22 — GOLD REMOVED from skip list. GOLD on NYSE is Barrick
// Gold Corp (real US equity, TD serves it via /quote and /time_series
// with currency=USD, type='Common Stock'). It was incorrectly added
// here under the assumption "GOLD = futures alias for gold spot", which
// is wrong — that's GC1! (already in the list). Effect of the bug: the
// price-feed cron stopped updating `timed:prices.GOLD` for 13+ days
// and the daily candle backfill kept returning upserted=0, which
// surfaced as the recurring "Worst D candle stale 8.4d (GOLD)" alarm.
//
// SILVER stays — TD's lookup for "SILVER" resolves to "Aditya Birla
// Sun Life Silver ETF" on NSE (India), not anything in our universe.
const SKIP_TICKERS = new Set([
  "ES1!", "NQ1!", "SILVER", "US500", "GC1!", "SI1!",
  // CBOE VIX index — not on our TwelveData plan; use VX1! → VIX alias instead.
  "VIX",
]);

function getApiKey(env) {
  return env?.TWELVEDATA_API_KEY || "";
}

function isCrypto(sym) {
  return !!CRYPTO_TO_TD[sym];
}

function toTdSymbol(sym) {
  if (CRYPTO_TO_TD[sym]) return CRYPTO_TO_TD[sym];
  if (LEGACY_TD_ALIASES[sym]) return LEGACY_TD_ALIASES[sym];
  return SYM_NORMALIZE[sym] || sym;
}

function fromTdSymbol(tdSym) {
  if (TD_TO_CRYPTO[tdSym]) return TD_TO_CRYPTO[tdSym];
  if (TD_TO_INTERNAL[tdSym]) return TD_TO_INTERNAL[tdSym];
  // TD "VIX" always writes to canonical VIX — never back to VX1!.
  return tdSym;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Core: fetch helper with timeout and error handling
// ═══════════════════════════════════════════════════════════════════════════════

async function parseTdJson(resp) {
  const text = await resp.text().catch(() => "");
  if (!text || String(text).trim().startsWith("<")) {
    return {
      _error: "non_json_response",
      _detail: String(text).slice(0, 200) || `http_${resp.status}`,
    };
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    return {
      _error: "json_parse_failed",
      _detail: String(err?.message || err).slice(0, 200),
    };
  }
}

async function tdFetch(url, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      console.error(`[TWELVEDATA] HTTP ${resp.status}: ${text.slice(0, 300)}`);
      return { _error: `http_${resp.status}`, _detail: text.slice(0, 200) };
    }
    const data = await parseTdJson(resp);
    if (data._error) {
      console.error(`[TWELVEDATA] Parse error: ${data._error} ${data._detail || ""}`);
      return data;
    }
    if (data.status === "error") {
      console.error(`[TWELVEDATA] API error: ${data.message || JSON.stringify(data).slice(0, 200)}`);
      return { _error: "api_error", _detail: data.message || "" };
    }
    return data;
  } catch (err) {
    clearTimeout(timer);
    console.error(`[TWELVEDATA] Fetch error: ${String(err).slice(0, 200)}`);
    return { _error: String(err) };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Time Series — historical OHLCV candles
// Returns: { [symbol]: [ { t, o, h, l, c, v }, ... ] }
// Normalized to Alpaca-compatible bar shape.
// ═══════════════════════════════════════════════════════════════════════════════

export async function tdFetchTimeSeries(env, symbols, interval, start, end = null, outputsize = 5000, opts = {}) {
  const apiKey = getApiKey(env);
  if (!apiKey) return { bars: {}, error: "missing_credentials" };
  if (!symbols || symbols.length === 0) return { bars: {} };

  // P0.7.169 (2026-05-15) — TwelveData enforces outputsize <= 5000. Callers
  // were passing 10000 (intended as "as many as possible") which returned
  // the API error 'Invalid outputsize provided: 10000' for every batch on
  // every */5 cron tick. Clamp at 5000 (TD's max). At 5000 bars, 10m bars
  // = ~35 trading days, 1h bars = ~10 months — far beyond any cron lookback
  // window we use.
  const _outputsizeClamped = Math.max(1, Math.min(5000, Number(outputsize) || 5000));

  const result = {};
  const errors = [];
  const BATCH = 8; // TwelveData supports batch, but safer in small groups
  const filtered = symbols.filter(s => !SKIP_TICKERS.has(s));

  for (let i = 0; i < filtered.length; i += BATCH) {
    const batch = filtered.slice(i, i + BATCH);
    const tdSyms = batch.map(toTdSymbol);
    const params = new URLSearchParams({
      symbol: tdSyms.join(","),
      interval,
      apikey: apiKey,
      outputsize: String(_outputsizeClamped),
      order: "asc",
      timezone: "UTC",
    });
    // TwelveData rejects pre/post on 1h+ timeframes.
    if (["1min", "5min", "15min", "30min"].includes(interval)) {
      params.set("prepost", "true");
    }
    if (start) params.set("start_date", start.replace("Z", "").replace("T", " ").slice(0, 19));
    if (end) params.set("end_date", end.replace("Z", "").replace("T", " ").slice(0, 19));

    const url = `${TD_BASE}/time_series?${params}`;
    const fetchTimeoutMs = Math.max(5000, Number(opts.fetchTimeoutMs) || 60000);
    const data = await tdFetch(url, fetchTimeoutMs);
    if (data._error) {
      errors.push(data._error);
      continue;
    }

    if (tdSyms.length === 1) {
      // Single symbol: response is { meta, values, status }
      const ourSym = fromTdSymbol(tdSyms[0]);
      if (Array.isArray(data.values)) {
        result[ourSym] = data.values.map(tdBarToAlpacaBar);
      }
    } else {
      // Multi-symbol: response is { AAPL: { meta, values, status }, MSFT: { ... } }
      for (const [tdSym, symData] of Object.entries(data)) {
        if (tdSym === "status" || !symData?.values) continue;
        const ourSym = fromTdSymbol(tdSym);
        result[ourSym] = symData.values.map(tdBarToAlpacaBar);
      }
    }
    const batchDelayMs = Math.max(0, Number(opts.batchDelayMs) || 8000);
    if (batchDelayMs > 0 && i + BATCH < filtered.length) {
      await new Promise((r) => setTimeout(r, batchDelayMs));
    }
  }

  if (Object.keys(result).length === 0 && errors.length > 0) {
    return { bars: result, error: errors[0] };
  }
  return { bars: result };
}

// Convert TwelveData bar to Alpaca-compatible shape { t, o, h, l, c, v }
function tdBarToAlpacaBar(tdBar) {
  const dt = tdBar.datetime || "";
  const ts = dt.includes("T")
    ? dt
    : dt.includes(" ")
      ? dt.replace(" ", "T") + "Z"
      : dt + "T00:00:00Z";
  return {
    t: ts.endsWith("Z") ? ts : ts + "Z",
    o: Number(tdBar.open),
    h: Number(tdBar.high),
    l: Number(tdBar.low),
    c: Number(tdBar.close),
    v: Number(tdBar.volume) || 0,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Aggregate 10min bars from 5min bars using time-boundary alignment.
// Groups 5m bars into 10m buckets (e.g. :00+:05 → :00, :10+:15 → :10, etc.)
// so missing bars, session edges, and odd counts don't corrupt the output.
// ═══════════════════════════════════════════════════════════════════════════════

function aggregate5mTo10m(fiveMinBars) {
  if (!Array.isArray(fiveMinBars) || fiveMinBars.length === 0) return [];
  const TEN_MIN_MS = 10 * 60 * 1000;
  const groups = new Map();
  for (const bar of fiveMinBars) {
    const ts = new Date(bar.t).getTime();
    if (!Number.isFinite(ts)) continue;
    const bucket = Math.floor(ts / TEN_MIN_MS) * TEN_MIN_MS;
    if (!groups.has(bucket)) groups.set(bucket, []);
    groups.get(bucket).push({ ...bar, _ts: ts });
  }
  const result = [];
  for (const [, bars] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    bars.sort((a, b) => a._ts - b._ts);
    const first = bars[0], last = bars[bars.length - 1];
    result.push({
      t: first.t,
      o: first.o,
      h: Math.max(...bars.map(b => b.h)),
      l: Math.min(...bars.map(b => b.l)),
      c: last.c,
      v: bars.reduce((s, b) => s + (b.v || 0), 0),
    });
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Quote — batch latest price + daily bar data
// Returns: { [symbol]: { price, trade_ts, dailyOpen, dailyHigh, dailyLow,
//   dailyClose, dailyVolume, prevDailyClose, minuteBar } }
// ═══════════════════════════════════════════════════════════════════════════════

export async function tdFetchQuote(env, symbols) {
  const apiKey = getApiKey(env);
  if (!apiKey) return { snapshots: {}, error: "missing_credentials" };
  if (!symbols || symbols.length === 0) return { snapshots: {} };

  const snapshots = {};
  const filtered = symbols.filter(s => !SKIP_TICKERS.has(s));
  const BATCH = 8;

  for (let i = 0; i < filtered.length; i += BATCH) {
    const batch = filtered.slice(i, i + BATCH);
    const tdSyms = batch.map(toTdSymbol);
    const params = new URLSearchParams({
      symbol: tdSyms.join(","),
      apikey: apiKey,
      prepost: "true",
    });
    const url = `${TD_BASE}/quote?${params}`;
    const data = await tdFetch(url, 15000);
    if (data._error) continue;

    if (tdSyms.length === 1) {
      const ourSym = fromTdSymbol(tdSyms[0]);
      if (data.close) {
        snapshots[ourSym] = parseTdQuote(data);
      }
    } else {
      for (const [tdSym, q] of Object.entries(data)) {
        if (!q?.close) continue;
        snapshots[fromTdSymbol(tdSym)] = parseTdQuote(q);
      }
    }
  }

  return { snapshots };
}

function parseTdQuote(q) {
  const price = Number(q.close) || 0;
  // TwelveData `timestamp` is often the minute-bar open (stale during RTH).
  // `last_quote_at` is when the quote actually updated — use the fresher one
  // so REST snapshot refresh + timed:prices don't freeze (QQQ-class bug 2026-06-18).
  const barTs = q.timestamp ? Number(q.timestamp) * 1000 : 0;
  const quoteAt = q.last_quote_at ? Number(q.last_quote_at) * 1000 : 0;
  const ts = quoteAt > barTs ? quoteAt : (barTs > 0 ? barTs : Date.now());
  return {
    price,
    trade_ts: ts,
    dailyOpen: Number(q.open) || 0,
    dailyHigh: Number(q.high) || 0,
    dailyLow: Number(q.low) || 0,
    dailyClose: price,
    dailyVolume: Number(q.volume) || 0,
    prevDailyClose: Number(q.previous_close) || 0,
    change: Number(q.change) || 0,
    percentChange: Number(q.percent_change) || 0,
    extendedPrice: Number(q.extended_price) || 0,
    extendedChange: Number(q.extended_change) || 0,
    extendedPercentChange: Number(q.extended_percent_change) || 0,
    isMarketOpen: q.is_market_open === true,
    minuteBar: null,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Price — lightweight latest price (1 credit per symbol)
// Returns: { [symbol]: number }
// ═══════════════════════════════════════════════════════════════════════════════

export async function tdFetchPrice(env, symbols) {
  const apiKey = getApiKey(env);
  if (!apiKey) return {};
  const filtered = symbols.filter(s => !SKIP_TICKERS.has(s));
  const prices = {};
  const BATCH = 8;

  for (let i = 0; i < filtered.length; i += BATCH) {
    const batch = filtered.slice(i, i + BATCH);
    const tdSyms = batch.map(toTdSymbol);
    const params = new URLSearchParams({
      symbol: tdSyms.join(","),
      apikey: apiKey,
      prepost: "true",
    });
    const url = `${TD_BASE}/price?${params}`;
    const data = await tdFetch(url, 10000);
    if (data._error) continue;

    if (tdSyms.length === 1) {
      prices[fromTdSymbol(tdSyms[0])] = Number(data.price) || 0;
    } else {
      for (const [tdSym, p] of Object.entries(data)) {
        if (p?.price) prices[fromTdSymbol(tdSym)] = Number(p.price) || 0;
      }
    }
  }

  return prices;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Stock listing — symbol validation and enrichment
// Returns: { [symbol]: { name, exchange, type, currency } }
// ═══════════════════════════════════════════════════════════════════════════════

export async function tdFetchStocks(env, country = "United States") {
  const apiKey = getApiKey(env);
  if (!apiKey) return { stocks: [], error: "missing_credentials" };

  const params = new URLSearchParams({ country, apikey: apiKey });
  const url = `${TD_BASE}/stocks?${params}`;
  const data = await tdFetch(url, 30000);
  if (data._error) return { stocks: [], error: data._error };

  return { stocks: Array.isArray(data.data) ? data.data : [] };
}

export async function tdSearchSymbol(env, symbol) {
  const apiKey = getApiKey(env);
  const sym = String(symbol || "").trim();
  if (!apiKey || !sym) return { data: [], error: "missing_credentials" };

  const params = new URLSearchParams({
    symbol: toTdSymbol(sym),
    outputsize: "10",
    apikey: apiKey,
  });
  const url = `${TD_BASE}/symbol_search?${params}`;
  const data = await tdFetch(url, 15000);
  if (data._error) return { data: [], error: data._error, detail: data._detail || "" };

  const rows = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
  return { data: rows };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Market State — real-time open/closed status (Pro: 1 credit)
// Returns: { is_open, exchange, session, ... }
// ═══════════════════════════════════════════════════════════════════════════════

export async function tdFetchMarketState(env) {
  const apiKey = getApiKey(env);
  if (!apiKey) return { _error: "missing_credentials" };

  const params = new URLSearchParams({
    exchange: "NYSE",
    apikey: apiKey,
  });
  const url = `${TD_BASE}/market_state?${params}`;
  return tdFetch(url, 10000);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Exchange Schedule — full trading schedule with holidays (Ultra: 100 credits)
// Returns: { data: [{ title, name, code, sessions: [...] }] }
// ═══════════════════════════════════════════════════════════════════════════════

export async function tdFetchExchangeSchedule(env, date = "today") {
  const apiKey = getApiKey(env);
  if (!apiKey) return { _error: "missing_credentials" };

  const params = new URLSearchParams({
    mic_code: "XNYS",
    date,
    apikey: apiKey,
  });
  const url = `${TD_BASE}/exchange_schedule?${params}`;
  return tdFetch(url, 15000);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Earnings Calendar — schedule of earnings for date range (40 credits/request)
// Returns: { earnings: { "YYYY-MM-DD": [ { symbol, name, currency, ... } ] } }
// ═══════════════════════════════════════════════════════════════════════════════

export async function tdFetchEarningsCalendar(env, startDate, endDate) {
  const apiKey = getApiKey(env);
  if (!apiKey) return { _error: "missing_credentials" };

  const params = new URLSearchParams({
    start_date: startDate,
    end_date: endDate,
    apikey: apiKey,
  });
  const url = `${TD_BASE}/earnings_calendar?${params}`;
  return tdFetch(url, 15000);
}

// Per-symbol earnings — returns upcoming/recent earnings for a specific ticker
// Returns: { earnings: [ { date, time, eps_estimate, eps_actual, ... } ] }
export async function tdFetchTickerEarnings(env, symbol) {
  const apiKey = getApiKey(env);
  if (!apiKey) return { _error: "missing_credentials" };

  const params = new URLSearchParams({
    symbol: toTdSymbol(symbol),
    apikey: apiKey,
  });
  const url = `${TD_BASE}/earnings?${params}`;
  return tdFetch(url, 10000);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Fundamentals — Profile, Statistics, Earnings History
// Used by GET /timed/admin/fundamentals?ticker=X for the Right Rail Fundamentals tab.
// All endpoints are cached at the route layer (KV, 6h TTL) to amortize credit cost.
// Per-call credit cost (TwelveData Pro plan):
//   /profile      = 10 credits
//   /statistics   = 50 credits
//   /earnings     = 20 credits  (history, up to 1000 rows)
// Total ≈ 80 credits per ticker per refresh window.
// ═══════════════════════════════════════════════════════════════════════════════

export async function tdFetchProfile(env, symbol) {
  const apiKey = getApiKey(env);
  if (!apiKey) return { _error: "missing_credentials" };
  const sym = toTdSymbol(String(symbol || "").toUpperCase());
  if (SKIP_TICKERS.has(symbol)) return { _error: "non_equity" };
  const params = new URLSearchParams({ symbol: sym, apikey: apiKey });
  const url = `${TD_BASE}/profile?${params}`;
  return tdFetch(url, 15000);
}

export async function tdFetchStatistics(env, symbol) {
  const apiKey = getApiKey(env);
  if (!apiKey) return { _error: "missing_credentials" };
  const sym = toTdSymbol(String(symbol || "").toUpperCase());
  if (SKIP_TICKERS.has(symbol)) return { _error: "non_equity" };
  const params = new URLSearchParams({ symbol: sym, apikey: apiKey });
  const url = `${TD_BASE}/statistics?${params}`;
  return tdFetch(url, 20000);
}

// Pull a richer earnings history (up to N records). Used by Fundamentals tab
// to render the per-quarter table with surprise %, growth %, and result class.
export async function tdFetchEarningsHistory(env, symbol, outputsize = 12) {
  const apiKey = getApiKey(env);
  if (!apiKey) return { _error: "missing_credentials" };
  const sym = toTdSymbol(String(symbol || "").toUpperCase());
  if (SKIP_TICKERS.has(symbol)) return { _error: "non_equity" };
  const params = new URLSearchParams({
    symbol: sym,
    apikey: apiKey,
    outputsize: String(outputsize),
  });
  const url = `${TD_BASE}/earnings?${params}`;
  return tdFetch(url, 15000);
}

/** Analyst revenue consensus — annual + quarterly forward sales estimates. */
export async function tdFetchRevenueEstimate(env, symbol) {
  const apiKey = getApiKey(env);
  if (!apiKey) return { _error: "missing_credentials" };
  const sym = toTdSymbol(String(symbol || "").toUpperCase());
  if (SKIP_TICKERS.has(symbol)) return { _error: "non_equity" };
  const params = new URLSearchParams({ symbol: sym, apikey: apiKey });
  const url = `${TD_BASE}/revenue_estimate?${params}`;
  return tdFetch(url, 15000);
}

/**
 * Normalize TwelveData /statistics percent-like fields.
 * Docs show `fifty_two_week_change` as a decimal fraction (0.3756 = 37.56%),
 * but some tickers return values already scaled (53.35 = 53.35%).
 */
export function normalizeTdStatisticsPercent(raw) {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  // TwelveData docs use decimal fractions (0.37 = 37%). Some tickers return
  // values already in percent (53.35). Values with |n| > 15 are treated as percent.
  if (Math.abs(n) > 15) return Number(n.toFixed(2));
  return Number((n * 100).toFixed(2));
}

// ═══════════════════════════════════════════════════════════════════════════════
// Exports for data-provider layer
// ═══════════════════════════════════════════════════════════════════════════════

export {
  TF_TO_TD,
  CRYPTO_TO_TD,
  TD_TO_CRYPTO,
  SKIP_TICKERS,
  toTdSymbol,
  fromTdSymbol,
  isCrypto,
  aggregate5mTo10m,
  tdBarToAlpacaBar,
  parseTdQuote,
};

// ═══════════════════════════════════════════════════════════════════════════════
// Options endpoints (TwelveData /options/* — pro plan or higher)
// ═══════════════════════════════════════════════════════════════════════════════
//
// 2026-05-30 — Added for the Options Tab. Two endpoints:
//   /options/expiration?symbol=AAPL                        → expiration dates
//   /options/chain?symbol=AAPL&expiration_date=2026-06-20  → full chain
//
// Both endpoints require TWELVEDATA_PLAN=pro (we already have it). Apikey
// flows from env.TWELVEDATA_API_KEY exactly like other TD calls.
//
// Response normalization: TD returns slightly different shapes than the
// industry-standard OCC format. We normalize to:
//   { calls: [...], puts: [...], underlying_price, fetched_at, expiration }
//   each leg: { strike, bid, ask, mid, last, volume, open_interest,
//               implied_volatility, delta, gamma, theta, vega, rho, symbol }
//
// Caller is responsible for KV caching — these are fresh fetches.

/**
 * List available expiration dates for an underlying.
 * Tries `/options/expiration` and `/options_chain/expiration` and the
 * underscore form `/options_expiration` (TD docs disagree on the path).
 * @returns {Promise<{ok: boolean, expirations: string[], error?: string, _tried?: object[]}>}
 */
export async function tdFetchOptionsExpirations(env, symbol) {
  const apikey = env?.TWELVEDATA_API_KEY;
  if (!apikey) return { ok: false, error: "missing_api_key", expirations: [] };
  const tdSym = toTdSymbol(symbol);
  const variants = [
    `/options/expiration?symbol=${encodeURIComponent(tdSym)}&apikey=${apikey}`,
    `/options_expiration?symbol=${encodeURIComponent(tdSym)}&apikey=${apikey}`,
  ];
  const tried = [];
  for (const path of variants) {
    try {
      const r = await fetch(`${TD_BASE}${path}`, { cf: { cacheTtl: 60 } });
      tried.push({ path: path.split("?")[0], status: r.status });
      if (!r.ok) continue;
      const j = await r.json();
      if (j?.status === "error") continue;
      const dates = Array.isArray(j?.dates) ? j.dates
        : Array.isArray(j?.values) ? j.values
        : Array.isArray(j) ? j : [];
      const expirations = dates.map(d => typeof d === "string" ? d : d?.date).filter(Boolean);
      if (expirations.length > 0) {
        return { ok: true, symbol: tdSym, expirations, _tried: tried };
      }
    } catch (e) {
      tried.push({ path: path.split("?")[0], error: String(e?.message || e).slice(0, 80) });
    }
  }
  return { ok: false, error: "no_endpoint_returned_data", expirations: [], _tried: tried };
}

/**
 * Fetch the full options chain for a single expiration date.
 * TD docs are inconsistent on the URL path — try `/options/chain` first,
 * fall back to `/options_chain` (the python SDK form). Auth via apikey
 * query param (HTTP header form requires CORS preflight that doesn't fit
 * the Workers cache path).
 * @param {string} expirationDate - ISO date (YYYY-MM-DD)
 * @returns {Promise<{ok, expiration, calls, puts, underlying_price, error?, _tried?: object[]}>}
 */
export async function tdFetchOptionsChain(env, symbol, expirationDate) {
  const apikey = env?.TWELVEDATA_API_KEY;
  if (!apikey) return { ok: false, error: "missing_api_key" };
  if (!expirationDate) return { ok: false, error: "missing_expiration" };
  const tdSym = toTdSymbol(symbol);
  const variants = [
    `/options/chain?symbol=${encodeURIComponent(tdSym)}&expiration_date=${encodeURIComponent(expirationDate)}&apikey=${apikey}`,
    `/options_chain?symbol=${encodeURIComponent(tdSym)}&expiration_date=${encodeURIComponent(expirationDate)}&apikey=${apikey}`,
  ];
  const tried = [];
  let lastErr = null;
  for (const path of variants) {
    try {
      const r = await fetch(`${TD_BASE}${path}`, { cf: { cacheTtl: 60 } });
      tried.push({ path: path.split("?")[0], status: r.status });
      if (!r.ok) { lastErr = `http_${r.status}`; continue; }
      const j = await r.json();
      if (j?.status === "error") { lastErr = j.message || j.code; continue; }
      // Got data — normalize and return.
      const result = _normalizeOptionsChainResponse(j, tdSym, expirationDate);
      result._tried = tried;
      return result;
    } catch (e) {
      tried.push({ path: path.split("?")[0], error: String(e?.message || e).slice(0, 80) });
      lastErr = String(e?.message || e).slice(0, 200);
    }
  }
  return { ok: false, error: lastErr || "no_endpoint_returned_data", _tried: tried };
}

function _normalizeOptionsChainResponse(j, tdSym, expirationDate) {
  const normLeg = (leg) => {
      const bid = Number(leg?.bid);
      const ask = Number(leg?.ask);
      const mid = Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0
        ? Math.round(((bid + ask) / 2) * 100) / 100
        : Number(leg?.last) || null;
      return {
        strike: Number(leg?.strike) || null,
        bid: Number.isFinite(bid) ? bid : null,
        ask: Number.isFinite(ask) ? ask : null,
        mid,
        last: Number(leg?.last) || null,
        volume: Number(leg?.volume) || 0,
        open_interest: Number(leg?.open_interest ?? leg?.oi) || 0,
        implied_volatility: Number(leg?.implied_volatility ?? leg?.iv) || null,
        delta: Number(leg?.delta) || null,
        gamma: Number(leg?.gamma) || null,
        theta: Number(leg?.theta) || null,
        vega:  Number(leg?.vega)  || null,
        rho:   Number(leg?.rho)   || null,
        symbol: leg?.symbol || leg?.contractSymbol || null,
      };
    };
  const calls = Array.isArray(j?.calls) ? j.calls.map(normLeg).filter(l => l.strike > 0) : [];
  const puts  = Array.isArray(j?.puts)  ? j.puts.map(normLeg).filter(l => l.strike > 0)  : [];
  return {
    ok: true,
    symbol: tdSym,
    expiration: expirationDate,
    underlying_price: Number(j?.meta?.regular_market_price ?? j?.meta?.price) || null,
    calls,
    puts,
    fetched_at: Date.now(),
  };
}

/**
 * Find the closest available strike to a target on a chain side.
 * Returns null if no leg within toleranceUSD of target.
 */
export function pickClosestStrike(legs, target, toleranceUSD = Infinity) {
  if (!Array.isArray(legs) || legs.length === 0 || !Number.isFinite(target)) return null;
  let best = null, bestDiff = Infinity;
  for (const l of legs) {
    if (!Number.isFinite(l.strike)) continue;
    const d = Math.abs(l.strike - target);
    if (d < bestDiff) { best = l; bestDiff = d; }
  }
  if (best && bestDiff <= toleranceUSD) return best;
  return null;
}
