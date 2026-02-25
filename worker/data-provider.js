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

function getProvider(env) {
  return (env?.DATA_PROVIDER || "alpaca").toLowerCase();
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
  if (getProvider(env) === "twelvedata") {
    return _tdFetchBars(env, symbols, tfKey, start, end, limit);
  }
  // Alpaca path: delegate to existing alpacaFetchBars (imported by caller)
  return null; // caller falls through to legacy alpaca path
}

export async function fetchAllBars(env, symbols, tfKey, start, end = null, limit = 1000) {
  if (getProvider(env) === "twelvedata") {
    return _tdFetchBars(env, symbols, tfKey, start, end, limit);
  }
  return null;
}

async function _tdFetchBars(env, symbols, tfKey, start, end, limit) {
  const tdInterval = TF_TO_TD[tfKey];

  // 10min: fetch 5min bars and aggregate
  if (tfKey === "10") {
    const raw = await tdFetchTimeSeries(env, symbols, "5min", start, end, limit * 2);
    if (raw.error) return raw;
    const bars = {};
    for (const [sym, barArr] of Object.entries(raw.bars || {})) {
      bars[sym] = aggregate5mTo10m(barArr);
    }
    return { bars };
  }

  if (!tdInterval) {
    console.warn(`[DATA-PROVIDER] Unknown TF: ${tfKey}`);
    return { bars: {}, error: "bad_timeframe" };
  }

  return tdFetchTimeSeries(env, symbols, tdInterval, start, end, limit);
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
  if (getProvider(env) === "twelvedata") {
    return tdFetchQuote(env, symbols);
  }
  return null;
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

  const tfsThisCycle = isTopOfHour
    ? ["5", "10", "30", "60", "240", "D", "W", "M"]
    : ["5", "10", "30", "60", "240"];

  const halfIdx = slotIdx % 2;
  const mid = Math.ceil(allTickers.length / 2);
  const tickersThisCycle = halfIdx === 0 ? allTickers.slice(0, mid) : allTickers.slice(mid);
  console.log(`[TD CRON] TFs=[${tfsThisCycle}] half=${halfIdx} tickers=${tickersThisCycle.length}/${allTickers.length} slot=${slotIdx}${isTopOfHour ? " (hourly D/W/M)" : ""}`);

  let totalUpserted = 0, totalErrors = 0;

  for (const tf of tfsThisCycle) {
    try {
      const lookback = CRON_TF_LOOKBACK_MS[tf] || 24 * 60 * 60 * 1000;
      const start = new Date(Date.now() - lookback).toISOString();
      const result = await fetchAllBars(env, tickersThisCycle, tf, start, null, 10000);
      if (!result?.bars) continue;

      const { upserted, errors } = await _batchUpsertBars(db, result.bars, tf);
      totalUpserted += upserted;
      totalErrors += errors;
    } catch (tfErr) {
      totalErrors++;
      console.warn(`[TD CRON] TF ${tf} error:`, String(tfErr).slice(0, 200));
    }
  }

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
    ? ["5", "10", "30", "60", "240", "D", "W", "M"]
    : ["5", "10", "30", "60", "240"];

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

const BACKFILL_TFS = ["M", "W", "D", "240", "60", "30", "10", "5"];

const DEEP_START_DAYS = {
  "M": 365 * 10, "W": 365 * 6, "D": 450, "240": 200,
  "60": 140, "30": 140, "10": 140, "5": 140,
};

export async function backfill(env, tickers, tfKey = "all", sinceDays = null) {
  if (getProvider(env) !== "twelvedata") return null;

  const db = env?.DB;
  if (!db) return { ok: false, error: "no_db_binding" };

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
    const daysBack = sinceDays || DEEP_START_DAYS[tf] || 140;
    const start = new Date(now - daysBack * DAY_MS).toISOString();
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
        const result = await fetchCryptoBars(env, cryptoTickers, tf, start, null, 10000);
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
        const result = await fetchAllBars(env, batch, tf, start, null, 5000);
        if (result?.bars) {
          const { upserted, errors } = await _batchUpsertBars(db, result.bars, tf);
          tfUpserted += upserted;
          tfErrors += errors;
        }
      } catch (e) {
        tfErrors++;
        console.warn(`[TD BACKFILL] TF ${tf} batch error:`, String(e).slice(0, 200));
      }
      // Rate-limit pacing
      if (i + 8 < stockTickers.length) {
        await new Promise(r => setTimeout(r, 800));
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
