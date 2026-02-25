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
      prepost: "true",
    });
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
  }

  return { bars: result };
}

// Convert TwelveData bar to Alpaca-compatible shape { t, o, h, l, c, v }
function tdBarToAlpacaBar(tdBar) {
  const dt = tdBar.datetime || "";
  const ts = dt.includes("T") ? dt : dt + "T00:00:00Z";
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
// Aggregate 10min bars from 5min bars
// Pairs consecutive 5min candles into 10min candles.
// ═══════════════════════════════════════════════════════════════════════════════

function aggregate5mTo10m(fiveMinBars) {
  if (!Array.isArray(fiveMinBars) || fiveMinBars.length === 0) return [];
  const sorted = [...fiveMinBars].sort((a, b) => {
    const ta = new Date(a.t).getTime();
    const tb = new Date(b.t).getTime();
    return ta - tb;
  });

  const result = [];
  for (let i = 0; i < sorted.length; i += 2) {
    const bar1 = sorted[i];
    const bar2 = sorted[i + 1];
    if (!bar2) {
      result.push(bar1);
      break;
    }
    result.push({
      t: bar1.t,
      o: bar1.o,
      h: Math.max(bar1.h, bar2.h),
      l: Math.min(bar1.l, bar2.l),
      c: bar2.c,
      v: (bar1.v || 0) + (bar2.v || 0),
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
