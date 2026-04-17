#!/usr/bin/env node

/**
 * scripts/build-monthly-backdrop.js — Phase B monthly backdrop builder.
 *
 * Emits one JSON per month under data/backdrops/<YYYY-MM>.json with:
 *   - cycle:        market-cycle phase label across Tier-1 daily + 4H tech
 *   - sector_leadership: top/bottom SPDR sectors vs SPY + rotation delta
 *   - regime_frequency:  counts of HTF_BULL_LTF_BULL / BULL_PULLBACK /
 *                        BEAR_LTF_BOUNCE / HTF_BEAR_LTF_BEAR / TRANSITIONAL
 *   - cross_asset_vol:   VIX/MOVE proxies + DXY trend + gold/oil dispersion
 *   - event_density:     earnings count per ticker + macro events in window
 *
 * Data sources
 * ------------
 * - Daily + 4H OHLC: TwelveData /time_series (SPY, QQQ, IWM, AAPL, MSFT,
 *   GOOGL, AMZN, META, NVDA, TSLA).
 * - Sector returns: SPDR ETFs XLK/XLF/XLE/XLY/XLI/XLV/XLP/XLU/XLRE/XLB/XLC.
 * - VIX proxy: VIXY (native ^VIX not on TwelveData plan). MOVE proxy: null.
 * - DXY proxy: UUP (PowerShares US Dollar Index). Gold: GLD. Oil: USO.
 * - Earnings: TwelveData /earnings per ticker.
 * - Macro events: CURATED_MACRO_EVENTS from worker/market-events-seed.js.
 *
 * Usage
 * -----
 *   TWELVE_DATA_API_KEY=xxx node scripts/build-monthly-backdrop.js \
 *     --months=2025-07,2025-08,...,2026-04 \
 *     --out=data/backdrops
 *
 * Flags
 *   --months=YYYY-MM[,YYYY-MM...]   (default: 2025-07 … 2026-04)
 *   --out=PATH                      (default: data/backdrops)
 *   --apikey=KEY                    (default: $TWELVE_DATA_API_KEY)
 *   --cache=PATH                    daily candle cache file (default:
 *                                   data/backdrops/.cache.json); avoids
 *                                   re-pulling the same series on reruns
 *   --no-cache                      disable the cache
 */

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// Universe + reference tickers
// ---------------------------------------------------------------------------

// Tier 1 — drives cycle + regime frequency (plan section "Universe").
const TIER1 = ["SPY", "QQQ", "IWM", "AAPL", "MSFT", "GOOGL", "AMZN", "META", "NVDA", "TSLA"];
// Tier 2 — earnings density only (not regime frequency).
const TIER2 = ["AGQ", "CDNS", "ETN", "FIX", "GRNY", "HUBS", "IESC", "MTZ", "ON", "PH", "RIOT", "SGI", "SWK", "XLY"];
// ETFs without meaningful earnings; skip earnings pull.
const NON_EARNINGS_TICKERS = new Set(["SPY", "QQQ", "IWM", "XLY", "AGQ"]);
const SECTOR_ETFS = ["XLK", "XLF", "XLE", "XLY", "XLI", "XLV", "XLP", "XLU", "XLRE", "XLB", "XLC"];
const SECTOR_ETF_LABELS = {
  XLK: "Technology",
  XLF: "Financials",
  XLE: "Energy",
  XLY: "Consumer Discretionary",
  XLI: "Industrials",
  XLV: "Health Care",
  XLP: "Consumer Staples",
  XLU: "Utilities",
  XLRE: "Real Estate",
  XLB: "Materials",
  XLC: "Communication Services",
};
const CROSS_ASSET = {
  vix_proxy: "VIXY", // native ^VIX not on TwelveData Pro plan
  dxy_proxy: "UUP",
  gold: "GLD",
  oil: "USO",
  tlt: "TLT",
};

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { months: null, outDir: null, apikey: null, cache: null, noCache: false };
  for (const raw of argv) {
    if (raw === "--no-cache") {
      out.noCache = true;
    } else if (raw.startsWith("--months=")) {
      out.months = raw.slice(9).split(",").map((s) => s.trim()).filter(Boolean);
    } else if (raw.startsWith("--out=")) {
      out.outDir = raw.slice(6);
    } else if (raw.startsWith("--apikey=")) {
      out.apikey = raw.slice(9);
    } else if (raw.startsWith("--cache=")) {
      out.cache = raw.slice(8);
    }
  }
  return out;
}

function defaultMonths() {
  return [
    "2025-07", "2025-08", "2025-09", "2025-10", "2025-11",
    "2025-12", "2026-01", "2026-02", "2026-03", "2026-04",
  ];
}

// ---------------------------------------------------------------------------
// Curated macro events (copied inline to avoid ESM/CJS interop with the
// worker module). Keep in sync with worker/market-events-seed.js.
// ---------------------------------------------------------------------------

const CURATED_MACRO_EVENTS = [
  { date: "2025-07-11", name: "CPI (Jun 2025)", impact: "high" },
  { date: "2025-08-14", name: "CPI (Jul 2025)", impact: "high" },
  { date: "2025-09-10", name: "CPI (Aug 2025)", impact: "high" },
  { date: "2025-10-15", name: "CPI (Sep 2025)", impact: "high" },
  { date: "2025-11-13", name: "CPI (Oct 2025)", impact: "high" },
  { date: "2025-12-11", name: "CPI (Nov 2025)", impact: "high" },
  { date: "2026-01-15", name: "CPI (Dec 2025)", impact: "high" },
  { date: "2026-02-12", name: "CPI (Jan 2026)", impact: "high" },
  { date: "2026-03-12", name: "CPI (Feb 2026)", impact: "high" },
  { date: "2025-07-15", name: "PPI (Jun 2025)", impact: "high" },
  { date: "2025-08-12", name: "PPI (Jul 2025)", impact: "high" },
  { date: "2025-09-12", name: "PPI (Aug 2025)", impact: "high" },
  { date: "2025-10-14", name: "PPI (Sep 2025)", impact: "high" },
  { date: "2025-11-14", name: "PPI (Oct 2025)", impact: "high" },
  { date: "2025-12-12", name: "PPI (Nov 2025)", impact: "high" },
  { date: "2026-01-14", name: "PPI (Dec 2025)", impact: "high" },
  { date: "2026-02-13", name: "PPI (Jan 2026)", impact: "high" },
  { date: "2026-03-13", name: "PPI (Feb 2026)", impact: "high" },
  { date: "2025-07-30", name: "FOMC Rate Decision (Jul 2025)", impact: "high" },
  { date: "2025-09-18", name: "FOMC Rate Decision (Sep 2025)", impact: "high" },
  { date: "2025-11-07", name: "FOMC Rate Decision (Nov 2025)", impact: "high" },
  { date: "2025-12-18", name: "FOMC Rate Decision (Dec 2025)", impact: "high" },
  { date: "2026-01-29", name: "FOMC Rate Decision (Jan 2026)", impact: "high" },
  { date: "2026-03-19", name: "FOMC Rate Decision (Mar 2026)", impact: "high" },
  { date: "2025-07-26", name: "PCE Price Index (Jun 2025)", impact: "high" },
  { date: "2025-08-30", name: "PCE Price Index (Jul 2025)", impact: "high" },
  { date: "2025-09-27", name: "PCE Price Index (Aug 2025)", impact: "high" },
  { date: "2025-10-31", name: "PCE Price Index (Sep 2025)", impact: "high" },
  { date: "2025-11-27", name: "PCE Price Index (Oct 2025)", impact: "high" },
  { date: "2025-12-20", name: "PCE Price Index (Nov 2025)", impact: "high" },
  { date: "2026-01-31", name: "PCE Price Index (Dec 2025)", impact: "high" },
  { date: "2026-02-28", name: "PCE Price Index (Jan 2026)", impact: "high" },
  { date: "2025-07-05", name: "Non-Farm Payrolls (Jun 2025)", impact: "high" },
  { date: "2025-08-01", name: "Non-Farm Payrolls (Jul 2025)", impact: "high" },
  { date: "2025-09-06", name: "Non-Farm Payrolls (Aug 2025)", impact: "high" },
  { date: "2025-10-04", name: "Non-Farm Payrolls (Sep 2025)", impact: "high" },
  { date: "2025-11-01", name: "Non-Farm Payrolls (Oct 2025)", impact: "high" },
  { date: "2025-12-06", name: "Non-Farm Payrolls (Nov 2025)", impact: "high" },
  { date: "2026-01-10", name: "Non-Farm Payrolls (Dec 2025)", impact: "high" },
  { date: "2026-02-07", name: "Non-Farm Payrolls (Jan 2026)", impact: "high" },
  { date: "2026-03-07", name: "Non-Farm Payrolls (Feb 2026)", impact: "high" },
  { date: "2025-07-30", name: "GDP Q2 2025 Advance", impact: "high" },
  { date: "2025-10-30", name: "GDP Q3 2025 Advance", impact: "high" },
  { date: "2026-01-30", name: "GDP Q4 2025 Advance", impact: "high" },
  { date: "2025-07-16", name: "Retail Sales (Jun 2025)", impact: "medium" },
  { date: "2025-08-15", name: "Retail Sales (Jul 2025)", impact: "medium" },
  { date: "2025-09-17", name: "Retail Sales (Aug 2025)", impact: "medium" },
  { date: "2025-10-17", name: "Retail Sales (Sep 2025)", impact: "medium" },
  { date: "2025-11-15", name: "Retail Sales (Oct 2025)", impact: "medium" },
  { date: "2025-12-17", name: "Retail Sales (Nov 2025)", impact: "medium" },
  { date: "2026-01-16", name: "Retail Sales (Dec 2025)", impact: "medium" },
  { date: "2026-02-14", name: "Retail Sales (Jan 2026)", impact: "medium" },
  { date: "2026-03-17", name: "Retail Sales (Feb 2026)", impact: "medium" },
  { date: "2025-07-01", name: "ISM Manufacturing PMI (Jun 2025)", impact: "medium" },
  { date: "2025-08-01", name: "ISM Manufacturing PMI (Jul 2025)", impact: "medium" },
  { date: "2025-09-03", name: "ISM Manufacturing PMI (Aug 2025)", impact: "medium" },
  { date: "2025-10-01", name: "ISM Manufacturing PMI (Sep 2025)", impact: "medium" },
  { date: "2025-11-01", name: "ISM Manufacturing PMI (Oct 2025)", impact: "medium" },
  { date: "2025-12-01", name: "ISM Manufacturing PMI (Nov 2025)", impact: "medium" },
  { date: "2026-01-03", name: "ISM Manufacturing PMI (Dec 2025)", impact: "medium" },
  { date: "2026-02-03", name: "ISM Manufacturing PMI (Jan 2026)", impact: "medium" },
  { date: "2026-03-03", name: "ISM Manufacturing PMI (Feb 2026)", impact: "medium" },
];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function monthBounds(ym) {
  // Returns {start, end, prevStart, prevEnd, nextStart} as YYYY-MM-DD.
  const [y, m] = ym.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 0));
  const prevStart = new Date(Date.UTC(y, m - 2, 1));
  const prevEnd = new Date(Date.UTC(y, m - 1, 0));
  const fmt = (d) => d.toISOString().slice(0, 10);
  return {
    start: fmt(start),
    end: fmt(end),
    prevStart: fmt(prevStart),
    prevEnd: fmt(prevEnd),
  };
}

function round(value, digits = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
}

function pct(num, digits = 2) {
  if (!Number.isFinite(Number(num))) return null;
  return round(Number(num) * 100, digits);
}

// ---------------------------------------------------------------------------
// TwelveData client (thin)
// ---------------------------------------------------------------------------

async function httpJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

let _lastTdCall = 0;
const TD_MIN_SPACING_MS = 180; // stay well under Pro plan rate limits

async function tdThrottle() {
  const now = Date.now();
  const wait = Math.max(0, _lastTdCall + TD_MIN_SPACING_MS - now);
  if (wait > 0) await sleep(wait);
  _lastTdCall = Date.now();
}

function nextDayKey(dateKey) {
  const d = new Date(`${dateKey}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

async function tdRequest(url, { retryOnRateLimit = true, emptyOnNotFound = false } = {}) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await tdThrottle();
    const data = await httpJson(url);
    if (data && data.status === "error") {
      const msg = String(data.message || "");
      if (retryOnRateLimit && /out of API credits/i.test(msg)) {
        const wait = 62 * 1000;
        console.warn(`[td] rate-limit hit (attempt ${attempt + 1}); sleeping ${wait} ms`);
        await sleep(wait);
        continue;
      }
      if (emptyOnNotFound && /no earning were found/i.test(msg)) {
        return { earnings: [] };
      }
      throw new Error(`td error: ${msg || JSON.stringify(data)}`);
    }
    return data;
  }
  throw new Error("td error: retries exhausted (rate-limit)");
}

async function tdTimeSeries(apikey, { symbol, interval, start, end, outputsize = 5000 }) {
  // TwelveData's `end_date` is exclusive for daily bars; pass end+1 so the
  // caller can think of `end` as the inclusive last day of the window.
  const qs = new URLSearchParams({
    symbol,
    interval,
    start_date: start,
    end_date: nextDayKey(end),
    outputsize: String(outputsize),
    timezone: "America/New_York",
    order: "ASC",
    apikey,
  });
  const url = `https://api.twelvedata.com/time_series?${qs.toString()}`;
  const data = await tdRequest(url);
  const values = Array.isArray(data?.values) ? data.values : [];
  return values
    .map((v) => ({
      date: String(v.datetime || "").slice(0, 10),
      datetime: String(v.datetime || ""),
      open: Number(v.open),
      high: Number(v.high),
      low: Number(v.low),
      close: Number(v.close),
      volume: Number(v.volume || 0),
    }))
    .filter((c) => Number.isFinite(c.close) && c.date);
}

async function tdEarnings(apikey, { symbol, start, end }) {
  const qs = new URLSearchParams({
    symbol,
    start_date: start,
    end_date: nextDayKey(end),
    outputsize: "120",
    apikey,
  });
  const url = `https://api.twelvedata.com/earnings?${qs.toString()}`;
  const data = await tdRequest(url, { emptyOnNotFound: true });
  const rows = Array.isArray(data?.earnings) ? data.earnings : [];
  return rows
    .map((r) => ({
      date: String(r.date || "").slice(0, 10),
      time: String(r.time || "").trim() || null,
      eps_estimate: r.eps_estimate ?? null,
      eps_actual: r.eps_actual ?? null,
      surprise_pct: r.surprise_prc ?? null,
    }))
    .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date));
}

// ---------------------------------------------------------------------------
// Candle cache (JSON on disk) — avoids re-pulling the same series on reruns
// ---------------------------------------------------------------------------

function loadCache(pathname) {
  try {
    const raw = fs.readFileSync(pathname, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    return { daily: {}, fourH: {}, earnings: {} };
  }
}

function saveCache(pathname, cache) {
  try {
    fs.mkdirSync(path.dirname(pathname), { recursive: true });
    fs.writeFileSync(pathname, JSON.stringify(cache));
  } catch (err) {
    console.warn("[cache] save failed:", err.message);
  }
}

function cacheKey(symbol, interval, start, end) {
  return `${symbol}|${interval}|${start}|${end}`;
}

// ---------------------------------------------------------------------------
// Indicators
// ---------------------------------------------------------------------------

function emaSeries(values, period) {
  if (!Array.isArray(values) || values.length === 0) return [];
  const k = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  let seed = 0;
  for (let i = 0; i < Math.min(period, values.length); i += 1) seed += values[i];
  if (values.length < period) return out;
  let ema = seed / period;
  out[period - 1] = ema;
  for (let i = period; i < values.length; i += 1) {
    ema = values[i] * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

function lastDefined(series) {
  for (let i = series.length - 1; i >= 0; i -= 1) {
    if (series[i] != null && Number.isFinite(series[i])) return series[i];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Per-ticker regime classification
//
// We approximate `tf_tech.D` / `tf_tech.4H` alignment with a compact proxy:
//   - daily bias  = close vs EMA(20, daily) AND EMA(20) slope sign
//   - intraday bias = close vs EMA(20, 4H) AND EMA(20) slope sign
// Joint label:
//   - HTF_BULL_LTF_BULL:   daily BULL  AND 4H BULL
//   - BULL_PULLBACK:       daily BULL  AND 4H BEAR
//   - BEAR_LTF_BOUNCE:     daily BEAR  AND 4H BULL
//   - HTF_BEAR_LTF_BEAR:   daily BEAR  AND 4H BEAR
//   - TRANSITIONAL:        any side NEUTRAL (EMA undefined or very flat)
// ---------------------------------------------------------------------------

const EMA_PERIOD = 20;
const SLOPE_EPS = 1e-4; // ~0 % day-over-day EMA slope threshold

function biasForIndex(closes, emaArr, idx) {
  const close = closes[idx];
  const ema = emaArr[idx];
  const emaPrev = emaArr[idx - 1];
  if (!Number.isFinite(close) || !Number.isFinite(ema)) return "NEUTRAL";
  if (!Number.isFinite(emaPrev)) return "NEUTRAL";
  const above = close > ema;
  const slope = (ema - emaPrev) / (Math.abs(emaPrev) || 1);
  if (Math.abs(slope) < SLOPE_EPS) return "NEUTRAL";
  if (above && slope > 0) return "BULL";
  if (!above && slope < 0) return "BEAR";
  return "NEUTRAL";
}

function jointRegime(dailyBias, intradayBias) {
  if (dailyBias === "NEUTRAL" || intradayBias === "NEUTRAL") return "TRANSITIONAL";
  if (dailyBias === "BULL" && intradayBias === "BULL") return "HTF_BULL_LTF_BULL";
  if (dailyBias === "BULL" && intradayBias === "BEAR") return "BULL_PULLBACK";
  if (dailyBias === "BEAR" && intradayBias === "BULL") return "BEAR_LTF_BOUNCE";
  if (dailyBias === "BEAR" && intradayBias === "BEAR") return "HTF_BEAR_LTF_BEAR";
  return "TRANSITIONAL";
}

// Map joint regime to market-cycle phase per Tier-1 aggregate count.
// (plan language: uptrend / distribution / downtrend / accumulation)
function cycleFromFrequencies(counts) {
  const bull = counts.HTF_BULL_LTF_BULL || 0;
  const pullback = counts.BULL_PULLBACK || 0;
  const bounce = counts.BEAR_LTF_BOUNCE || 0;
  const bear = counts.HTF_BEAR_LTF_BEAR || 0;
  const trans = counts.TRANSITIONAL || 0;
  const total = bull + pullback + bounce + bear + trans || 1;
  const frac = {
    bull: bull / total,
    pullback: pullback / total,
    bounce: bounce / total,
    bear: bear / total,
    trans: trans / total,
  };
  // uptrend: majority HTF_BULL_LTF_BULL and trivial bear share
  if (frac.bull >= 0.5 && frac.bear < 0.15) return { label: "uptrend", fractions: frac };
  // distribution: bull dominates but pullbacks are heavy (>25 %) or transitional spikes while bear is not dominant
  if (frac.bull + frac.pullback >= 0.5 && frac.pullback >= 0.25 && frac.bear < 0.25) {
    return { label: "distribution", fractions: frac };
  }
  // downtrend: bear dominates
  if (frac.bear >= 0.4 || (frac.bear + frac.bounce >= 0.5 && frac.bear >= 0.3)) {
    return { label: "downtrend", fractions: frac };
  }
  // accumulation: low bear, low bull, high transitional / pullback — mixed base
  if (frac.bear < 0.25 && frac.bull < 0.3 && frac.trans + frac.pullback >= 0.5) {
    return { label: "accumulation", fractions: frac };
  }
  return { label: "transitional", fractions: frac };
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

async function ensureDailyCandles(apikey, symbol, start, end, cache) {
  const key = cacheKey(symbol, "1day", start, end);
  if (cache?.daily && cache.daily[key]) return cache.daily[key];
  const candles = await tdTimeSeries(apikey, {
    symbol,
    interval: "1day",
    start,
    end,
    outputsize: 5000,
  });
  if (cache?.daily) cache.daily[key] = candles;
  return candles;
}

async function ensureFourHCandles(apikey, symbol, start, end, cache) {
  const key = cacheKey(symbol, "4h", start, end);
  if (cache?.fourH && cache.fourH[key]) return cache.fourH[key];
  const candles = await tdTimeSeries(apikey, {
    symbol,
    interval: "4h",
    start,
    end,
    outputsize: 5000,
  });
  if (cache?.fourH) cache.fourH[key] = candles;
  return candles;
}

async function ensureEarnings(apikey, symbol, start, end, cache) {
  const key = cacheKey(symbol, "earnings", start, end);
  if (cache?.earnings && cache.earnings[key]) return cache.earnings[key];
  const rows = await tdEarnings(apikey, { symbol, start, end });
  if (cache?.earnings) cache.earnings[key] = rows;
  return rows;
}

function buildTradingDays(spyDaily, start, end) {
  return spyDaily
    .map((c) => c.date)
    .filter((d) => d >= start && d <= end);
}

function firstLastClose(candles, start, end) {
  const inside = candles.filter((c) => c.date >= start && c.date <= end);
  if (inside.length === 0) return { first: null, last: null, high: null, low: null };
  return {
    first: inside[0].close,
    last: inside[inside.length - 1].close,
    high: Math.max(...inside.map((c) => c.high)),
    low: Math.min(...inside.map((c) => c.low)),
    avg_close: inside.reduce((s, c) => s + c.close, 0) / inside.length,
  };
}

function monthlyReturn(candles, start, end) {
  const agg = firstLastClose(candles, start, end);
  if (!Number.isFinite(agg.first) || !Number.isFinite(agg.last) || agg.first === 0) return null;
  return (agg.last - agg.first) / agg.first;
}

async function computeSectorLeadership(apikey, start, end, prevStart, prevEnd, cache) {
  const spyCandles = await ensureDailyCandles(apikey, "SPY", prevStart, end, cache);
  const spyCur = monthlyReturn(spyCandles, start, end);
  const spyPrev = monthlyReturn(spyCandles, prevStart, prevEnd);
  const curRs = {};
  const prevRs = {};
  for (const etf of SECTOR_ETFS) {
    const candles = await ensureDailyCandles(apikey, etf, prevStart, end, cache);
    const retCur = monthlyReturn(candles, start, end);
    const retPrev = monthlyReturn(candles, prevStart, prevEnd);
    curRs[etf] = {
      ret_pct: pct(retCur, 3),
      rs_vs_spy_pct: retCur != null && spyCur != null ? pct(retCur - spyCur, 3) : null,
    };
    prevRs[etf] = {
      ret_pct: pct(retPrev, 3),
      rs_vs_spy_pct: retPrev != null && spyPrev != null ? pct(retPrev - spyPrev, 3) : null,
    };
  }
  const ranked = SECTOR_ETFS
    .map((etf) => ({
      etf,
      label: SECTOR_ETF_LABELS[etf] || etf,
      rs: curRs[etf].rs_vs_spy_pct,
      rs_prev: prevRs[etf].rs_vs_spy_pct,
      ret: curRs[etf].ret_pct,
    }))
    .filter((r) => Number.isFinite(r.rs))
    .sort((a, b) => b.rs - a.rs);
  const top = ranked.slice(0, 3).map((r) => ({
    etf: r.etf,
    label: r.label,
    rs_vs_spy_pct: r.rs,
    ret_pct: r.ret,
    rotation_delta_pp: Number.isFinite(r.rs_prev) ? round(r.rs - r.rs_prev, 3) : null,
  }));
  const bottom = ranked.slice(-3).reverse().map((r) => ({
    etf: r.etf,
    label: r.label,
    rs_vs_spy_pct: r.rs,
    ret_pct: r.ret,
    rotation_delta_pp: Number.isFinite(r.rs_prev) ? round(r.rs - r.rs_prev, 3) : null,
  }));
  return {
    spy_ret_pct: pct(spyCur, 3),
    spy_prev_ret_pct: pct(spyPrev, 3),
    by_sector: curRs,
    top: top,
    bottom: bottom,
  };
}

function bucketFourHByDate(fourHCandles) {
  const byDate = new Map();
  for (const c of fourHCandles) {
    const day = c.datetime.slice(0, 10);
    if (!byDate.has(day)) byDate.set(day, []);
    byDate.get(day).push(c);
  }
  return byDate;
}

async function computeRegimeFrequency(apikey, tradingDays, prevStart, end, cache) {
  // Aggregate (ticker × trading day) regime counts across Tier-1.
  const counts = {
    HTF_BULL_LTF_BULL: 0,
    BULL_PULLBACK: 0,
    BEAR_LTF_BOUNCE: 0,
    HTF_BEAR_LTF_BEAR: 0,
    TRANSITIONAL: 0,
  };
  const perTicker = {};
  for (const sym of TIER1) {
    const daily = await ensureDailyCandles(apikey, sym, prevStart, end, cache);
    const fourH = await ensureFourHCandles(apikey, sym, prevStart, end, cache);
    const dailyCloses = daily.map((c) => c.close);
    const dailyEma = emaSeries(dailyCloses, EMA_PERIOD);
    const dailyBiasByDate = new Map();
    for (let i = 0; i < daily.length; i += 1) {
      dailyBiasByDate.set(daily[i].date, biasForIndex(dailyCloses, dailyEma, i));
    }
    const fourHByDate = bucketFourHByDate(fourH);
    const fourHCloses = fourH.map((c) => c.close);
    const fourHEma = emaSeries(fourHCloses, EMA_PERIOD);
    const fourHBiasByTs = new Map();
    for (let i = 0; i < fourH.length; i += 1) {
      fourHBiasByTs.set(fourH[i].datetime, biasForIndex(fourHCloses, fourHEma, i));
    }
    const tickerCounts = {
      HTF_BULL_LTF_BULL: 0,
      BULL_PULLBACK: 0,
      BEAR_LTF_BOUNCE: 0,
      HTF_BEAR_LTF_BEAR: 0,
      TRANSITIONAL: 0,
    };
    for (const day of tradingDays) {
      const dailyBias = dailyBiasByDate.get(day) || "NEUTRAL";
      // For 4H, use the last 4H bar of that calendar day.
      const dayBars = fourHByDate.get(day) || [];
      const lastBar = dayBars[dayBars.length - 1];
      const ltfBias = lastBar ? (fourHBiasByTs.get(lastBar.datetime) || "NEUTRAL") : "NEUTRAL";
      const label = jointRegime(dailyBias, ltfBias);
      counts[label] += 1;
      tickerCounts[label] += 1;
    }
    perTicker[sym] = tickerCounts;
  }
  return { counts, per_ticker: perTicker };
}

function realizedVolAnnualized(candles, start, end) {
  const inside = candles.filter((c) => c.date >= start && c.date <= end);
  if (inside.length < 3) return null;
  const logRets = [];
  for (let i = 1; i < inside.length; i += 1) {
    const a = inside[i - 1].close;
    const b = inside[i].close;
    if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) continue;
    logRets.push(Math.log(b / a));
  }
  if (logRets.length < 2) return null;
  const mean = logRets.reduce((s, x) => s + x, 0) / logRets.length;
  const variance =
    logRets.reduce((s, x) => s + (x - mean) * (x - mean), 0) / (logRets.length - 1);
  const daily = Math.sqrt(variance);
  return daily * Math.sqrt(252);
}

async function computeCrossAssetVol(apikey, start, end, prevStart, prevEnd, cache) {
  const spy = await ensureDailyCandles(apikey, "SPY", prevStart, end, cache);
  const vix = await ensureDailyCandles(apikey, CROSS_ASSET.vix_proxy, prevStart, end, cache);
  const dxy = await ensureDailyCandles(apikey, CROSS_ASSET.dxy_proxy, prevStart, end, cache);
  const gold = await ensureDailyCandles(apikey, CROSS_ASSET.gold, prevStart, end, cache);
  const oil = await ensureDailyCandles(apikey, CROSS_ASSET.oil, prevStart, end, cache);
  const tlt = await ensureDailyCandles(apikey, CROSS_ASSET.tlt, prevStart, end, cache);

  const spyRvCur = realizedVolAnnualized(spy, start, end);
  const spyRvPrev = realizedVolAnnualized(spy, prevStart, prevEnd);

  const vixAgg = firstLastClose(vix, start, end);
  const vixPrev = firstLastClose(vix, prevStart, prevEnd);
  const dxyRet = monthlyReturn(dxy, start, end);
  const dxyPrevRet = monthlyReturn(dxy, prevStart, prevEnd);
  const goldRet = monthlyReturn(gold, start, end);
  const oilRet = monthlyReturn(oil, start, end);
  const tltRet = monthlyReturn(tlt, start, end);

  let dxyTrend = "flat";
  if (Number.isFinite(dxyRet)) {
    if (dxyRet > 0.005) dxyTrend = "rising";
    else if (dxyRet < -0.005) dxyTrend = "falling";
  }

  return {
    spy_realized_vol: {
      note: "annualized stdev of SPY daily log returns within the month (in-sample proxy for VIX level)",
      annualized_pct: pct(spyRvCur, 3),
      prev_month_annualized_pct: pct(spyRvPrev, 3),
      delta_pp:
        Number.isFinite(spyRvCur) && Number.isFinite(spyRvPrev)
          ? pct(spyRvCur - spyRvPrev, 3)
          : null,
    },
    vix_proxy: {
      symbol: CROSS_ASSET.vix_proxy,
      note: "VIXY (ETF) used because ^VIX is not on the TwelveData plan",
      avg_close: round(vixAgg.avg_close, 3),
      max_close: round(vixAgg.high, 3),
      min_close: round(vixAgg.low, 3),
      prev_month_avg_close: round(vixPrev.avg_close, 3),
    },
    move_proxy: {
      symbol: null,
      note: "MOVE not available via TwelveData; leave null until a bond-vol proxy is wired",
      value: null,
    },
    dxy_proxy: {
      symbol: CROSS_ASSET.dxy_proxy,
      note: "UUP as DXY proxy",
      ret_pct: pct(dxyRet, 3),
      prev_month_ret_pct: pct(dxyPrevRet, 3),
      trend: dxyTrend,
    },
    gold_oil_dispersion: {
      gold_symbol: CROSS_ASSET.gold,
      oil_symbol: CROSS_ASSET.oil,
      gold_ret_pct: pct(goldRet, 3),
      oil_ret_pct: pct(oilRet, 3),
      dispersion_pp:
        Number.isFinite(goldRet) && Number.isFinite(oilRet)
          ? pct(goldRet - oilRet, 3)
          : null,
    },
    rates_proxy: {
      symbol: CROSS_ASSET.tlt,
      note: "TLT as long-duration treasury proxy",
      ret_pct: pct(tltRet, 3),
    },
  };
}

async function computeEventDensity(apikey, start, end, cache) {
  const earningsUniverse = [...TIER1, ...TIER2].filter((t) => !NON_EARNINGS_TICKERS.has(t));
  const perTicker = {};
  const datesSet = new Set();
  for (const sym of earningsUniverse) {
    let rows = [];
    try {
      rows = await ensureEarnings(apikey, sym, start, end, cache);
    } catch (err) {
      console.warn(`[earnings] ${sym} failed:`, err.message);
      rows = [];
    }
    const inside = rows.filter((r) => r.date >= start && r.date <= end);
    perTicker[sym] = inside.map((r) => ({
      date: r.date,
      time: r.time,
      eps_estimate: r.eps_estimate,
      eps_actual: r.eps_actual,
      surprise_pct: r.surprise_pct,
    }));
    for (const r of inside) datesSet.add(r.date);
  }
  const earningsCount = Object.values(perTicker).reduce((s, arr) => s + arr.length, 0);
  const macroInside = CURATED_MACRO_EVENTS
    .filter((ev) => ev.date >= start && ev.date <= end)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const macroDates = new Set(macroInside.map((ev) => ev.date));
  const densityByDate = {};
  for (const d of datesSet) densityByDate[d] = (densityByDate[d] || 0) + 1;
  for (const ev of macroInside) {
    densityByDate[ev.date] = (densityByDate[ev.date] || 0) + 1;
  }
  // Identify earnings clusters: ≥3 tickers reporting within a rolling 3-day window.
  const datesSorted = Array.from(datesSet).sort();
  const clusters = [];
  for (let i = 0; i < datesSorted.length; i += 1) {
    const anchor = datesSorted[i];
    const window = datesSorted.filter((d) => {
      const dt = new Date(`${d}T00:00:00Z`).getTime();
      const at = new Date(`${anchor}T00:00:00Z`).getTime();
      const diff = Math.abs(dt - at);
      return diff <= 2 * 24 * 3600 * 1000;
    });
    const tickersInWindow = new Set();
    for (const d of window) {
      for (const [sym, arr] of Object.entries(perTicker)) {
        if (arr.some((r) => r.date === d)) tickersInWindow.add(sym);
      }
    }
    if (tickersInWindow.size >= 3) {
      clusters.push({
        anchor,
        window_dates: window,
        tickers: Array.from(tickersInWindow).sort(),
      });
    }
  }
  // De-dupe overlapping clusters by anchor.
  const seenAnchors = new Set();
  const dedupedClusters = [];
  for (const c of clusters) {
    if (seenAnchors.has(c.anchor)) continue;
    seenAnchors.add(c.anchor);
    dedupedClusters.push(c);
  }

  return {
    earnings: {
      total_events: earningsCount,
      unique_tickers_reporting: Object.values(perTicker).filter((arr) => arr.length > 0).length,
      by_ticker: perTicker,
      clusters_ge3_tickers_within_3d: dedupedClusters,
    },
    macro: {
      total_events: macroInside.length,
      events: macroInside.map((ev) => ({ date: ev.date, name: ev.name, impact: ev.impact })),
      fomc_count: macroInside.filter((ev) => ev.name.startsWith("FOMC")).length,
      cpi_count: macroInside.filter((ev) => ev.name.startsWith("CPI")).length,
      nfp_count: macroInside.filter((ev) => ev.name.startsWith("Non-Farm Payrolls")).length,
    },
    density_by_date: densityByDate,
    high_density_dates: Object.entries(densityByDate)
      .filter(([_, n]) => n >= 2)
      .map(([d, n]) => ({ date: d, events: n }))
      .sort((a, b) => (a.date < b.date ? -1 : 1)),
  };
}

// ---------------------------------------------------------------------------
// Main assembly
// ---------------------------------------------------------------------------

async function buildMonth(apikey, ym, cache) {
  const { start, end, prevStart, prevEnd } = monthBounds(ym);
  console.log(`[backdrop] building ${ym} (${start} → ${end})`);

  // SPY daily drives the trading day calendar.
  const spyCandles = await ensureDailyCandles(apikey, "SPY", prevStart, end, cache);
  const tradingDays = buildTradingDays(spyCandles, start, end);

  const regime = await computeRegimeFrequency(apikey, tradingDays, prevStart, end, cache);
  const cycle = cycleFromFrequencies(regime.counts);
  const sectorLeadership = await computeSectorLeadership(apikey, start, end, prevStart, prevEnd, cache);
  const crossAssetVol = await computeCrossAssetVol(apikey, start, end, prevStart, prevEnd, cache);
  const eventDensity = await computeEventDensity(apikey, start, end, cache);

  return {
    schema_version: "1.0",
    month: ym,
    generated_at: new Date().toISOString(),
    window: { start, end },
    trading_days: tradingDays,
    universe: { tier1: TIER1, tier2: TIER2 },
    cycle: {
      label: cycle.label,
      fractions: {
        HTF_BULL_LTF_BULL: round(cycle.fractions.bull, 4),
        BULL_PULLBACK: round(cycle.fractions.pullback, 4),
        BEAR_LTF_BOUNCE: round(cycle.fractions.bounce, 4),
        HTF_BEAR_LTF_BEAR: round(cycle.fractions.bear, 4),
        TRANSITIONAL: round(cycle.fractions.trans, 4),
      },
      method: "Tier-1 × trading-day joint EMA(20) daily + 4H bias vote",
    },
    sector_leadership: sectorLeadership,
    regime_frequency: regime,
    cross_asset_vol: crossAssetVol,
    event_density: eventDensity,
    provenance: {
      data_provider: "twelvedata",
      daily_series: "1day",
      intraday_series: "4h",
      ema_period: EMA_PERIOD,
      slope_epsilon: SLOPE_EPS,
      builder: "scripts/build-monthly-backdrop.js",
    },
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const apikey = args.apikey || process.env.TWELVE_DATA_API_KEY;
  if (!apikey) {
    console.error("missing TWELVE_DATA_API_KEY (or --apikey=)");
    process.exit(2);
  }
  const outDir = path.resolve(ROOT, args.outDir || "data/backdrops");
  fs.mkdirSync(outDir, { recursive: true });
  const cachePath = args.noCache
    ? null
    : path.resolve(ROOT, args.cache || "data/backdrops/.cache.json");
  const cache = cachePath ? loadCache(cachePath) : null;
  const months = args.months || defaultMonths();

  for (const ym of months) {
    const payload = await buildMonth(apikey, ym, cache);
    const outFile = path.join(outDir, `${ym}.json`);
    fs.writeFileSync(outFile, `${JSON.stringify(payload, null, 2)}\n`);
    console.log(`[backdrop] wrote ${path.relative(ROOT, outFile)}`);
    if (cachePath) saveCache(cachePath, cache);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
