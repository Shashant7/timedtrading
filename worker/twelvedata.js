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

// Symbol normalization: BRK-B → BRK.B (some APIs need dot-separated class)
const SYM_NORMALIZE = { "BRK-B": "BRK.B" };
const SYM_REVERSE = Object.fromEntries(
  Object.entries(SYM_NORMALIZE).map(([k, v]) => [v, k]),
);

// Non-equity tickers that TwelveData cannot serve
const SKIP_TICKERS = new Set([
  "ES1!", "NQ1!", "GOLD", "SILVER", "VX1!", "US500", "GC1!", "SI1!",
]);

function getApiKey(env) {
  return env?.TWELVEDATA_API_KEY || "";
}

function isCrypto(sym) {
  return !!CRYPTO_TO_TD[sym];
}

function toTdSymbol(sym) {
  if (CRYPTO_TO_TD[sym]) return CRYPTO_TO_TD[sym];
  return SYM_NORMALIZE[sym] || sym;
}

function fromTdSymbol(tdSym) {
  if (TD_TO_CRYPTO[tdSym]) return TD_TO_CRYPTO[tdSym];
  return SYM_REVERSE[tdSym] || tdSym;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Core: fetch helper with timeout and error handling
// ═══════════════════════════════════════════════════════════════════════════════

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
    const data = await resp.json();
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

export async function tdFetchTimeSeries(env, symbols, interval, start, end = null, outputsize = 5000) {
  const apiKey = getApiKey(env);
  if (!apiKey) return { bars: {}, error: "missing_credentials" };
  if (!symbols || symbols.length === 0) return { bars: {} };

  const result = {};
  const BATCH = 8; // TwelveData supports batch, but safer in small groups
  const filtered = symbols.filter(s => !SKIP_TICKERS.has(s));

  for (let i = 0; i < filtered.length; i += BATCH) {
    const batch = filtered.slice(i, i + BATCH);
    const tdSyms = batch.map(toTdSymbol);
    const params = new URLSearchParams({
      symbol: tdSyms.join(","),
      interval,
      apikey: apiKey,
      outputsize: String(outputsize),
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
    const data = await tdFetch(url, 60000);
    if (data._error) continue;

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
    // TwelveData PRO: 8 req/min → 8s between requests
    if (i + BATCH < filtered.length) {
      await new Promise((r) => setTimeout(r, 8000));
    }
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
  const ts = q.timestamp ? Number(q.timestamp) * 1000 : Date.now();
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
};
