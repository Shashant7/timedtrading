// ═══════════════════════════════════════════════════════════════════════════════
// Data Provider Abstraction Layer
//
// Routes data-fetching calls to either TwelveData or Alpaca based on
// env.DATA_PROVIDER ("twelvedata" | "alpaca"). All functions return
// normalized shapes so the rest of the codebase is provider-agnostic.
//
// Switching providers is a config change (DATA_PROVIDER env var), not a
// code change. Upgrading from TwelveData Pro → Ultra is a config change
// (TWELVEDATA_PLAN env var) that unlocks the exchange_schedule endpoint.
// ═══════════════════════════════════════════════════════════════════════════════

import {
  tdFetchTimeSeries,
  tdFetchQuote,
  tdFetchPrice,
  tdFetchStocks,
  tdFetchMarketState,
  tdFetchExchangeSchedule,
  TF_TO_TD,
  SKIP_TICKERS,
  aggregate5mTo10m,
  toTdSymbol,
  fromTdSymbol,
  isCrypto,
} from "./twelvedata.js";

// 2026-05-22 — Alpaca fallback for "never stale" guarantee.
// TwelveData is the primary provider, but some symbols have spotty TD
// coverage that produces stale intraday data — historically PCI (low-
// liquidity CEF), PSTG (M&A corporate-action gap), and intermittently
// some large caps (DELL has gone missing from TD batch responses on
// multiple occasions despite being a fully active public name). Alpaca's
// bars/snapshots endpoints are part of the Algo Trader+ plan we already
// pay for (used for execution), so wiring it as a transparent fallback
// costs nothing and closes the staleness gap.
import {
  alpacaFetchSnapshots,
  alpacaFetchBars,
} from "./indicators.js";

function _hasUsableAlpaca(env) {
  return !!(env?.ALPACA_API_KEY_ID && env?.ALPACA_API_SECRET_KEY);
}

// 2026-05-26 — Per-isolate counters for the TD→Alpaca fallback. Operators
// poll GET /timed/admin/provider-fallback-stats to see which symbols rely
// on the fallback most often. Chronic offenders are candidates to flip to
// Alpaca-primary (or escalate to TD support). Mirrors the SL-guard
// counters pattern from PR #290 — per-isolate in-memory, no KV writes
// in the hot path. Exported so the route handler can read.
const _providerFallbackStats = {
  isolate_started_at: Date.now(),
  isolate_id: Math.random().toString(36).slice(2, 10),
  counts: {
    bars_total_attempts: 0,           // # times _withAlpacaBarsFallback ran
    bars_symbols_missing_from_td: 0,  // total per-symbol gaps seen
    bars_symbols_healed_by_alpaca: 0, // total per-symbol successful heals
    bars_per_symbol_errors: 0,        // Alpaca threw on individual symbol fetch
    snapshots_total_attempts: 0,
    snapshots_symbols_missing_from_td: 0,
    snapshots_symbols_healed_by_alpaca: 0,
    snapshots_alpaca_errors: 0,
  },
  // Per-symbol fail/heal counters so chronic offenders are easy to spot.
  // Keyed by ticker; values: { heals, misses, last_tf, last_ts }.
  per_symbol: {},
};

function _bumpProviderSym(sym, kind, tf) {
  try {
    const k = String(sym || "").toUpperCase();
    if (!k) return;
    const e = _providerFallbackStats.per_symbol[k] || { heals: 0, misses: 0, last_tf: null, last_ts: 0 };
    if (kind === "heal") e.heals++;
    if (kind === "miss") e.misses++;
    e.last_tf = tf || e.last_tf;
    e.last_ts = Date.now();
    _providerFallbackStats.per_symbol[k] = e;
  } catch (_) { /* counters can never throw */ }
}

function getProvider(env) {
  return (env?.DATA_PROVIDER || "twelvedata").toLowerCase();
}

function isUltra(env) {
  return (env?.TWELVEDATA_PLAN || "pro").toLowerCase() === "ultra";
}

// ═══════════════════════════════════════════════════════════════════════════════
// fetchBars — historical OHLCV candles for one or more symbols + timeframe
//
// Returns: { bars: { AAPL: [ { t, o, h, l, c, v }, ... ], ... }, error? }
// Bar shape matches Alpaca format used throughout the codebase.
// ═══════════════════════════════════════════════════════════════════════════════

export async function fetchBars(env, symbols, tfKey, start, end = null, limit = 5) {
  if (getProvider(env) !== "twelvedata") {
    // Alpaca path: delegate to existing alpacaFetchBars (imported by caller)
    return null; // caller falls through to legacy alpaca path
  }
  const tdResult = await _tdFetchBars(env, symbols, tfKey, start, end, limit);
  return _withAlpacaBarsFallback(env, tdResult, symbols, tfKey, start, end, limit);
}

export async function fetchAllBars(env, symbols, tfKey, start, end = null, limit = 1000, opts = {}) {
  if (getProvider(env) !== "twelvedata") return null;
  const tdResult = await _tdFetchBars(env, symbols, tfKey, start, end, limit, opts);
  return _withAlpacaBarsFallback(env, tdResult, symbols, tfKey, start, end, limit);
}

// _withAlpacaBarsFallback — for any symbol where TwelveData returned zero
// bars (e.g. DELL in M&A limbo, PCI as a low-liquidity CEF, IBM after a
// signal recompute that drops it from TD's batch response), retry that
// symbol against Alpaca. Alpaca tends to keep serving symbols TD drops.
// Each healed symbol is logged with [PROVIDER_FALLBACK] for observability.
async function _withAlpacaBarsFallback(env, tdResult, symbols, tfKey, start, end, limit) {
  if (!_hasUsableAlpaca(env)) return tdResult;
  _providerFallbackStats.counts.bars_total_attempts++;
  const tdError = tdResult?.error;
  const tdBars = tdResult?.bars || {};
  const missing = [];
  for (const sym of symbols || []) {
    const arr = tdBars[sym];
    if (!Array.isArray(arr) || arr.length === 0) missing.push(sym);
  }
  // Skip the fallback for crypto pairs — TD's primary path covers them and
  // Alpaca's crypto endpoint requires a different route than the stock bars.
  const stockMissing = missing.filter((s) => !isCrypto(s));
  if (stockMissing.length === 0) return tdResult;
  _providerFallbackStats.counts.bars_symbols_missing_from_td += stockMissing.length;
  for (const s of stockMissing) _bumpProviderSym(s, "miss", tfKey);
  let healedSymbols = 0;
  let healedBars = 0;
  // Cap concurrent fallback fetches to avoid blowing Alpaca's rate limit
  // (200 req/min on the free tier; we typically have ~30 stale tickers max
  // per cron cycle). Sequential per-symbol fetch keeps it simple.
  for (const sym of stockMissing) {
    try {
      const aRes = await alpacaFetchBars(env, [sym], tfKey, start, end, limit);
      const aBars = aRes?.bars?.[sym];
      if (Array.isArray(aBars) && aBars.length > 0) {
        tdBars[sym] = aBars;
        healedSymbols++;
        healedBars += aBars.length;
        _bumpProviderSym(sym, "heal", tfKey);
      }
    } catch (e) {
      _providerFallbackStats.counts.bars_per_symbol_errors++;
      console.warn(`[PROVIDER_FALLBACK] alpaca bars ${sym} TF ${tfKey}:`, String(e?.message || e).slice(0, 150));
    }
  }
  _providerFallbackStats.counts.bars_symbols_healed_by_alpaca += healedSymbols;
  if (healedSymbols > 0) {
    console.log(`[PROVIDER_FALLBACK] alpaca healed ${healedSymbols}/${stockMissing.length} symbols missing from TD for TF ${tfKey} (+${healedBars} bars)${tdError ? ` td_error=${tdError}` : ""}`);
  }
  return { ...tdResult, bars: tdBars };
}

// TwelveData returns most recent N bars when only start_date is used. Use start+end date chunks.
const TD_PAGE_SIZE = 5000;
const CHUNK_DAYS_5MIN = 64;   // ~5000 bars of 5min per chunk
const CHUNK_DAYS_15MIN = 192; // ~5000 bars of 15min per chunk (26 bars/day)
const CHUNK_DAYS_30MIN = 225; // 2 chunks for 450 days

async function _tdFetchBarsChunked(env, symbols, interval, start, end, chunkDays) {
  const allBars = {};
  const targetEnd = end ? new Date(end).getTime() : Date.now() + 86400000;
  let chunkStart = new Date(start).getTime();
  const chunkMs = chunkDays * 24 * 60 * 60 * 1000;

  while (chunkStart < targetEnd) {
    const chunkEnd = Math.min(chunkStart + chunkMs, targetEnd);
    const chunkStartISO = new Date(chunkStart).toISOString();
    const chunkEndISO = new Date(chunkEnd).toISOString();

    const raw = await tdFetchTimeSeries(env, symbols, interval, chunkStartISO, chunkEndISO, TD_PAGE_SIZE);
    if (raw.error) return raw;

    for (const [sym, barArr] of Object.entries(raw.bars || {})) {
      if (!allBars[sym]) allBars[sym] = [];
      allBars[sym].push(...barArr);
    }
    chunkStart = chunkEnd;
    await new Promise((r) => setTimeout(r, 8000));
  }
  return { bars: allBars };
}

async function _tdFetchBars(env, symbols, tfKey, start, end, limit, opts = {}) {
  const tdInterval = TF_TO_TD[tfKey];

  // 10min: fetch 5min bars in chunks (start+end per chunk) and aggregate
  if (tfKey === "10") {
    const raw = await _tdFetchBarsChunked(env, symbols, "5min", start, end, CHUNK_DAYS_5MIN);
    if (raw.error) return raw;
    const bars = {};
    for (const [sym, barArr] of Object.entries(raw.bars || {})) {
      bars[sym] = aggregate5mTo10m(barArr);
    }
    return { bars };
  }

  // 15min: chunked fetch (for 15m vs 10m leading_ltf experiment)
  if (tfKey === "15") {
    return _tdFetchBarsChunked(env, symbols, "15min", start, end, CHUNK_DAYS_15MIN);
  }

  // 30min: chunked fetch
  if (tfKey === "30") {
    return _tdFetchBarsChunked(env, symbols, "30min", start, end, CHUNK_DAYS_30MIN);
  }

  if (!tdInterval) {
    console.warn(`[DATA-PROVIDER] Unknown TF: ${tfKey}`);
    return { bars: {}, error: "bad_timeframe" };
  }

  return tdFetchTimeSeries(env, symbols, tdInterval, start, end, limit, opts);
}

// ═══════════════════════════════════════════════════════════════════════════════
// fetchCryptoBars — crypto-specific bar fetching
//
// TwelveData uses the same /time_series endpoint for crypto with BTC/USD format.
// Returns same shape as fetchBars.
// ═══════════════════════════════════════════════════════════════════════════════

export async function fetchCryptoBars(env, cryptoTickers, tfKey, start, end = null, limit = 10000) {
  if (getProvider(env) === "twelvedata") {
    return _tdFetchBars(env, cryptoTickers, tfKey, start, end, limit);
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// fetchLatestQuotes — real-time snapshot: price, daily OHLCV, prev close
//
// Returns: { snapshots: { AAPL: { price, trade_ts, dailyOpen, dailyHigh,
//   dailyLow, dailyClose, dailyVolume, prevDailyClose, minuteBar }, ... } }
// ═══════════════════════════════════════════════════════════════════════════════

export async function fetchLatestQuotes(env, symbols) {
  if (getProvider(env) !== "twelvedata") return null;
  const tdResult = await tdFetchQuote(env, symbols);
  return _withAlpacaQuotesFallback(env, tdResult, symbols);
}

// _withAlpacaQuotesFallback — same pattern as _withAlpacaBarsFallback but
// for the real-time snapshot path. Any symbol with no price or a missing
// snapshot from TD is retried via Alpaca's bulk snapshot endpoint.
async function _withAlpacaQuotesFallback(env, tdResult, symbols) {
  if (!_hasUsableAlpaca(env)) return tdResult;
  _providerFallbackStats.counts.snapshots_total_attempts++;
  const tdSnaps = tdResult?.snapshots || {};
  const missing = [];
  for (const sym of symbols || []) {
    const snap = tdSnaps[sym];
    if (!snap || !(Number(snap.price) > 0)) missing.push(sym);
  }
  const stockMissing = missing.filter((s) => !isCrypto(s));
  if (stockMissing.length === 0) return tdResult;
  _providerFallbackStats.counts.snapshots_symbols_missing_from_td += stockMissing.length;
  for (const s of stockMissing) _bumpProviderSym(s, "miss", "snapshot");
  try {
    const aRes = await alpacaFetchSnapshots(env, stockMissing);
    const aSnaps = aRes?.snapshots || {};
    let healed = 0;
    for (const sym of stockMissing) {
      const aSnap = aSnaps[sym];
      if (aSnap && Number(aSnap.price) > 0) {
        tdSnaps[sym] = { ...aSnap, _source: "alpaca_fallback" };
        healed++;
        _bumpProviderSym(sym, "heal", "snapshot");
      }
    }
    _providerFallbackStats.counts.snapshots_symbols_healed_by_alpaca += healed;
    if (healed > 0) {
      console.log(`[PROVIDER_FALLBACK] alpaca healed ${healed}/${stockMissing.length} missing snapshots from TD`);
    }
  } catch (e) {
    _providerFallbackStats.counts.snapshots_alpaca_errors++;
    console.warn(`[PROVIDER_FALLBACK] alpaca snapshots failed:`, String(e?.message || e).slice(0, 200));
  }
  return { ...tdResult, snapshots: tdSnaps };
}

// ═══════════════════════════════════════════════════════════════════════════════
// fetchLatestPrices — lightweight price-only fetch (1 credit/symbol)
//
// Returns: { [symbol]: number }
// ═══════════════════════════════════════════════════════════════════════════════

export async function fetchLatestPrices(env, symbols) {
  if (getProvider(env) === "twelvedata") {
    return tdFetchPrice(env, symbols);
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// validateSymbols — check if symbols exist and are tradeable
//
// Returns: { [symbol]: { valid, name, exchange, type } }
// ═══════════════════════════════════════════════════════════════════════════════

export async function validateSymbols(env, symbols) {
  if (getProvider(env) === "twelvedata") {
    const { stocks, error } = await tdFetchStocks(env, "United States");
    if (error) return {};
    const lookup = new Map();
    for (const s of stocks) {
      lookup.set(s.symbol?.toUpperCase(), s);
    }
    const result = {};
    for (const sym of symbols) {
      const match = lookup.get(sym.toUpperCase());
      result[sym] = match
        ? { valid: true, name: match.name, exchange: match.exchange, type: match.type }
        : { valid: false };
    }
    return result;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// enrichSymbols — fetch company name/exchange info for display
//
// Returns: { [symbol]: { name, exchange, currency, type } }
// ═══════════════════════════════════════════════════════════════════════════════

export async function enrichSymbols(env, symbols) {
  if (getProvider(env) === "twelvedata") {
    const { stocks, error } = await tdFetchStocks(env, "United States");
    if (error) return {};
    const lookup = new Map();
    for (const s of stocks) {
      lookup.set(s.symbol?.toUpperCase(), s);
    }
    const result = {};
    for (const sym of symbols) {
      const match = lookup.get(sym.toUpperCase());
      if (match) {
        result[sym] = {
          name: match.name || sym,
          exchange: match.exchange || "",
          currency: match.currency || "USD",
          type: match.type || "Common Stock",
        };
      }
    }
    return result;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// getMarketCalendar — trading calendar with holidays and early closes
//
// Pro: uses /market_state (1 credit) + static holiday list
// Ultra: uses /exchange_schedule (100 credits) for dynamic schedule
//
// Returns: calendar object compatible with market-calendar.js
// ═══════════════════════════════════════════════════════════════════════════════

export async function getMarketCalendar(env) {
  if (getProvider(env) === "twelvedata") {
    if (isUltra(env)) {
      return _tdCalendarUltra(env);
    }
    return _tdCalendarPro(env);
  }
  return null;
}

async function _tdCalendarPro(env) {
  // Pro plan: use /market_state for real-time open/closed + static calendar
  const state = await tdFetchMarketState(env);
  if (state._error) return null; // fall back to static
  return {
    _marketState: state,
    source: "twelvedata_pro",
    fetchedAt: Date.now(),
  };
}

async function _tdCalendarUltra(env) {
  const data = await tdFetchExchangeSchedule(env, "today");
  if (data._error) return null;
  return {
    _schedule: data,
    source: "twelvedata_ultra",
    fetchedAt: Date.now(),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// getMarketState — is the market open right now?
//
// Returns: { is_open: boolean, exchange, session }
// ═══════════════════════════════════════════════════════════════════════════════

export async function getMarketState(env) {
  if (getProvider(env) === "twelvedata") {
    const data = await tdFetchMarketState(env);
    if (data._error) return { is_open: false, error: data._error };
    // TwelveData returns { name, code, country, is_market_open, time_after_open, time_to_open, time_to_close }
    return {
      is_open: data.is_market_open === true,
      exchange: data.name || "NYSE",
      time_to_open: data.time_to_open || null,
      time_to_close: data.time_to_close || null,
    };
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// cronFetchLatest — provider-aware cron bar fetch + D1 upsert
//
// Mirrors the tiered-TF logic of alpacaCronFetchLatest but routes bar
// fetching through the provider layer. Returns null when provider is Alpaca
// (caller falls through to legacy path).
// ═══════════════════════════════════════════════════════════════════════════════

const CRON_TF_LOOKBACK_MS = {
  "5":   2 * 60 * 60 * 1000,
  "10":  3 * 60 * 60 * 1000,
  "15":  4 * 60 * 60 * 1000,
  "30":  6 * 60 * 60 * 1000,
  "60":  24 * 60 * 60 * 1000,
  "240": 48 * 60 * 60 * 1000,
  "D":   7 * 24 * 60 * 60 * 1000,
  "W":   35 * 24 * 60 * 60 * 1000,
  "M":   95 * 24 * 60 * 60 * 1000,
};

const CRYPTO_TF_LOOKBACK_MS = {
  "5":   4 * 60 * 60 * 1000,
  "10":  6 * 60 * 60 * 1000,
  "15":  8 * 60 * 60 * 1000,
  "30":  12 * 60 * 60 * 1000,
  "60":  48 * 60 * 60 * 1000,
  "240": 96 * 60 * 60 * 1000,
  "D":   14 * 24 * 60 * 60 * 1000,
  "W":   42 * 24 * 60 * 60 * 1000,
  "M":   95 * 24 * 60 * 60 * 1000,
};

async function _batchUpsertBars(db, barsBySymbol, tf) {
  const updatedAt = Date.now();
  const stmts = [];
  for (const [sym, bars] of Object.entries(barsBySymbol)) {
    if (!Array.isArray(bars)) continue;
    for (const bar of bars) {
      const ts = new Date(bar.t).getTime();
      if (!Number.isFinite(ts)) continue;
      const { o, h, l, c, v } = bar;
      if (![o, h, l, c].every(x => Number.isFinite(x))) continue;
      stmts.push(
        db.prepare(
          `INSERT INTO ticker_candles (ticker, tf, ts, o, h, l, c, v, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
           ON CONFLICT(ticker, tf, ts) DO UPDATE SET
             o=excluded.o, h=excluded.h, l=excluded.l, c=excluded.c, v=excluded.v,
             updated_at=excluded.updated_at
           WHERE ticker_candles.c != excluded.c
              OR ticker_candles.h != excluded.h
              OR ticker_candles.l != excluded.l
              OR ticker_candles.v IS NOT excluded.v`
        ).bind(sym.toUpperCase(), tf, ts, o, h, l, c, v != null ? v : null, updatedAt)
      );
    }
  }

  let upserted = 0, errors = 0;
  const BATCH_SIZE = 500;
  for (let i = 0; i < stmts.length; i += BATCH_SIZE) {
    const chunk = stmts.slice(i, i + BATCH_SIZE);
    try {
      await db.batch(chunk);
      upserted += chunk.length;
    } catch (batchErr) {
      console.warn(`[DATA-PROVIDER CRON] Batch (${chunk.length}) for TF ${tf} failed, retrying smaller:`, String(batchErr).slice(0, 200));
      for (let j = 0; j < chunk.length; j += 100) {
        const small = chunk.slice(j, j + 100);
        try { await db.batch(small); upserted += small.length; }
        catch (_) { errors += small.length; }
      }
    }
  }
  return { upserted, errors };
}

export async function cronFetchLatest(env, allTickers) {
  if (getProvider(env) !== "twelvedata") return null;

  const db = env?.DB;
  if (!db) return { ok: false, error: "no_db_binding" };
  if (!allTickers?.length) return { ok: false, error: "no_tickers" };

  const minuteOfHour = new Date().getUTCMinutes();
  const slotIdx = Math.floor(minuteOfHour / 5);
  const isTopOfHour = minuteOfHour < 5;

  // P0.7.163 (2026-05-15) / P0.7.164 (2026-05-15) — Three-tier scheduling.
  //
  // Background: during RTH the bar cron wrapper (in index.js) gates REST
  // fetches on `streamActive && !_isTopOfHour` — i.e. only top-of-hour runs
  // REST at all when the WS stream is up. The stream only delivers 5/10/
  // 15/30 minute bars; 60m / 240m / D / W / M MUST come from REST.
  //
  // Prior version sliced `allTickers` into halves by `slotIdx % 2` and ran
  // D/W/M only at top-of-hour. slotIdx === 0 always maps to halfIdx === 0
  // (first half), so D/W/M / 60m / 240m for the SECOND half of the universe
  // was never fetched while the stream was active. User-added tickers and
  // late-added ETFs (PCI, GME, DBA, DIA, GLD, IWM, SPY, XL*, etc.) all
  // landed in the second half, which is why their D/60m/240m bars stuck
  // ~33-61h stale even though their 5m/30m streamed fine.
  //
  // Fix:
  //   tier A — stream-redundant TFs (5/10/15/30): keep the half-slice for
  //            TwelveData rate budget; the stream already covers them.
  //   tier B — stream-uncovered intraday TFs (60/240): at top-of-hour run
  //            against the FULL universe so they refresh every hour for
  //            every ticker. Off-hour cycles keep the half-slice (~10 min
  //            full refresh, fine since stream isn't filling these gaps).
  //   tier C — aggregated TFs (D/W/M): top-of-hour only, full universe.
  //            ~250 tickers × 3 TFs × a handful of bars each is well within
  //            TwelveData's per-minute quota.
  // 10/15/30 are freshness-critical (CRITICAL_RTH in freshness.js) but were
  // lumped into "stream-redundant" and only half-refreshed each */5 tick.
  // PriceStream updates timed:prices only — it does NOT write D1 — so half-
  // slicing left ~half the universe STALE on 10m mid-session (GILD class).
  const criticalIntradayTfs = ["10", "15", "30"];
  const streamRedundantTfs = ["5"];
  const streamUncoveredIntradayTfs = ["60", "240"];
  const aggregatedTfs = isTopOfHour ? ["D", "W", "M"] : [];

  const halfIdx = slotIdx % 2;
  const mid = Math.ceil(allTickers.length / 2);
  const halfTickers = halfIdx === 0 ? allTickers.slice(0, mid) : allTickers.slice(mid);
  // 60/240 use the half slice off-hour for rate control; at top-of-hour they
  // upgrade to the full universe (closes the second-half stale-bar gap).
  const uncoveredIntradayTickers = isTopOfHour ? allTickers : halfTickers;
  console.log(`[TD CRON] critical_intraday=[${criticalIntradayTfs}] (full ${allTickers.length}) redundant=[${streamRedundantTfs}] (half=${halfIdx}, ${halfTickers.length}/${allTickers.length}) uncovered_intraday=[${streamUncoveredIntradayTfs}] (${uncoveredIntradayTickers.length}/${allTickers.length}${isTopOfHour ? ", full @ top-of-hour" : ", half"}) slot=${slotIdx}${isTopOfHour ? ` + aggregated=[${aggregatedTfs}] full` : ""}`);

  let totalUpserted = 0, totalErrors = 0;

  const runTfBatch = async (tfs, tickers, opts = {}) => {
    for (const tf of tfs) {
      try {
        const lookback = CRON_TF_LOOKBACK_MS[tf] || 24 * 60 * 60 * 1000;
        const start = new Date(Date.now() - lookback).toISOString();
        const result = await fetchAllBars(env, tickers, tf, start, null, 10000, opts);
        if (!result?.bars) continue;

        const { upserted, errors } = await _batchUpsertBars(db, result.bars, tf);
        totalUpserted += upserted;
        totalErrors += errors;
      } catch (tfErr) {
        totalErrors++;
        console.warn(`[TD CRON] TF ${tf} error:`, String(tfErr).slice(0, 200));
      }
    }
  };

  // 2026-06-11 — SCORING-STALENESS ROOT CAUSE FIX. Two changes:
  //
  // 1. ORDER: aggregated (D/W/M) and stream-uncovered (60/240) tiers now
  //    run FIRST. The old order ran the stream-REDUNDANT tier (5/10/15/30
  //    — data the websocket already delivers) first, and with the default
  //    8s inter-batch delay that tier alone took ~8+ minutes. The cron
  //    invocation died before tier C ever ran, so D/W/M bars almost never
  //    landed: census 2026-06-11 found 160/281 tickers whose NEWEST daily
  //    bar was Jun 8 and only 3/282 with a current 4H bar — the */5
  //    scoring engine (HTF score = M/W/D/4H EMAs + Ichimoku) was running
  //    on days-old structure for most of the universe.
  //
  // 2. PACING: the D/W/M + 60/240 tiers pass batchDelayMs=2500 (vs the
  //    8000 default tuned for a lower TD plan). At ~8 symbols/call this
  //    is ~24 calls/min ≈ 192 credits/min — inside the Pro plan budget
  //    with headroom — and brings the full top-of-hour pass (3 agg TFs ×
  //    ~33 batches + 2 intraday TFs) under ~5 minutes so it completes
  //    within the invocation.
  //
  // The redundant tier keeps the 8s pacing and runs last: if it gets cut
  // off, the stream covers those TFs anyway.
  const _fastPace = { batchDelayMs: 2500 };
  await runTfBatch(aggregatedTfs, allTickers, _fastPace);
  await runTfBatch(streamUncoveredIntradayTfs, uncoveredIntradayTickers, _fastPace);
  await runTfBatch(criticalIntradayTfs, allTickers, _fastPace);
  await runTfBatch(streamRedundantTfs, halfTickers);

  return { ok: true, upserted: totalUpserted, errors: totalErrors };
}

export async function cronFetchCrypto(env) {
  if (getProvider(env) !== "twelvedata") return null;

  const db = env?.DB;
  if (!db) return { ok: false, error: "no_db_binding" };

  const CRYPTO_TICKERS = ["BTCUSD", "ETHUSD"];

  const minuteOfHour = new Date().getUTCMinutes();
  const isTopOfHour = minuteOfHour < 5;
  const tfsThisCycle = isTopOfHour
    ? ["5", "10", "15", "30", "60", "240", "D", "W", "M"]
    : ["5", "10", "15", "30", "60", "240"];

  let totalUpserted = 0, totalErrors = 0;

  for (const tf of tfsThisCycle) {
    try {
      const lookback = CRYPTO_TF_LOOKBACK_MS[tf] || 48 * 60 * 60 * 1000;
      const start = new Date(Date.now() - lookback).toISOString();
      const result = await fetchCryptoBars(env, CRYPTO_TICKERS, tf, start, null, 10000);
      if (!result?.bars) continue;

      const { upserted, errors } = await _batchUpsertBars(db, result.bars, tf);
      totalUpserted += upserted;
      totalErrors += errors;
    } catch (tfErr) {
      totalErrors++;
      console.warn(`[TD CRON CRYPTO] TF ${tf} error:`, String(tfErr).slice(0, 200));
    }
  }

  return { ok: true, upserted: totalUpserted, errors: totalErrors };
}

// ═══════════════════════════════════════════════════════════════════════════════
// backfill — provider-aware historical backfill (called from admin endpoint)
//
// Mirrors alpacaBackfill but routes through the provider layer.
// Returns null when provider is Alpaca (caller uses legacy path).
// ═══════════════════════════════════════════════════════════════════════════════

// Match REPLAY_TFS — 5m used only by live cron (rolling), not backtest. 15m for leading_ltf experiment.
const BACKFILL_TFS = ["M", "W", "D", "240", "60", "30", "15", "10"];

const DEEP_START_DAYS = {
  "M": 365 * 10, "W": 365 * 6, "D": 365 * 3, "240": 365 * 2,
  "60": 365 * 2, "30": 450, "15": 450, "10": 450,
};

export async function backfill(env, tickers, tfKey = "all", opts = null) {
  if (getProvider(env) !== "twelvedata") return null;

  const db = env?.DB;
  if (!db) return { ok: false, error: "no_db_binding" };

  const optsObj = typeof opts === "object" && opts !== null ? opts : { sinceDays: opts };
  const { sinceDays, startDate: startDateStr, endDate: endDateStr } = optsObj;

  const tfsToBackfill = tfKey === "all" ? BACKFILL_TFS : [tfKey];
  let totalUpserted = 0, totalErrors = 0;
  const perTf = {};
  const DAY_MS = 24 * 60 * 60 * 1000;
  const now = Date.now();

  const KV = env?.KV_TIMED || null;
  const updateProgress = async (status) => {
    if (!KV) return;
    try {
      await KV.put("timed:backfill:status", JSON.stringify({ ...status, updated_at: Date.now() }), { expirationTtl: 3600 });
    } catch { /* best-effort */ }
  };

  const CRYPTO = ["BTCUSD", "ETHUSD"];
  const cryptoSet = new Set(CRYPTO);
  const stockTickers = tickers.filter(t => !cryptoSet.has(t));
  const cryptoTickers = tickers.filter(t => cryptoSet.has(t));

  for (let tfIdx = 0; tfIdx < tfsToBackfill.length; tfIdx++) {
    const tf = tfsToBackfill[tfIdx];
    let start, end = null;
    if (startDateStr && endDateStr) {
      start = new Date(startDateStr + "T00:00:00Z").toISOString();
      end = new Date(endDateStr + "T23:59:59Z").toISOString();
    } else {
      const daysBack = sinceDays || DEEP_START_DAYS[tf] || 140;
      start = new Date(now - daysBack * DAY_MS).toISOString();
    }
    let tfUpserted = 0, tfErrors = 0;

    await updateProgress({
      phase: "fetching", provider: "twelvedata",
      tickers: tickers.length === 1 ? tickers[0] : `${tickers.length} tickers`,
      tf, tfIndex: tfIdx + 1, tfTotal: tfsToBackfill.length,
      upserted: totalUpserted, errors: totalErrors,
    });

    // Crypto
    if (cryptoTickers.length > 0) {
      try {
        const result = await fetchCryptoBars(env, cryptoTickers, tf, start, end, 10000);
        if (result?.bars) {
          const { upserted, errors } = await _batchUpsertBars(db, result.bars, tf);
          tfUpserted += upserted;
          tfErrors += errors;
        }
      } catch (e) {
        tfErrors++;
        console.warn(`[TD BACKFILL] Crypto TF ${tf} error:`, String(e).slice(0, 200));
      }
    }

    // Stocks in batches of 8 (TwelveData batch limit)
    for (let i = 0; i < stockTickers.length; i += 8) {
      const batch = stockTickers.slice(i, i + 8);
      try {
        const result = await fetchAllBars(env, batch, tf, start, end, 5000);
        if (result?.bars) {
          const { upserted, errors } = await _batchUpsertBars(db, result.bars, tf);
          tfUpserted += upserted;
          tfErrors += errors;
        }
      } catch (e) {
        tfErrors++;
        console.warn(`[TD BACKFILL] TF ${tf} batch error:`, String(e).slice(0, 200));
      }
      // TwelveData PRO: 8 req/min. 8s between batches keeps us under limit.
      if (i + 8 < stockTickers.length) {
        await new Promise(r => setTimeout(r, 8000));
      }
    }

    totalUpserted += tfUpserted;
    totalErrors += tfErrors;
    perTf[tf] = { upserted: tfUpserted, errors: tfErrors };
    console.log(`[TD BACKFILL] TF ${tf}: ${tfUpserted} upserted, ${tfErrors} errors`);
  }

  await updateProgress({ phase: "done", upserted: totalUpserted, errors: totalErrors });
  return { ok: true, upserted: totalUpserted, errors: totalErrors, perTf };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Utility exports
// ═══════════════════════════════════════════════════════════════════════════════

export { getProvider, isUltra, SKIP_TICKERS, toTdSymbol, fromTdSymbol, isCrypto };

// 2026-05-26 — Read-only access to the per-isolate provider-fallback
// counters. Consumed by the admin endpoint registered in worker/index.js.
export function getProviderFallbackStats() {
  return _providerFallbackStats;
}
