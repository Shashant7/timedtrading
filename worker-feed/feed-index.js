// ═══════════════════════════════════════════════════════════════════════════
// tt-feed — standalone */1 price-feed worker (P2 decomposition, Step 1).
//
// Runs the EXACT pipeline the monolith runs (worker/feed/price-feed-cron.js)
// on its own cron, CPU budget, and deploy cadence, so a research-lane CPU
// blowup in the monolith can never stall the price feed again — and vice
// versa. See tasks/2026-06-10-worker-decomposition-plan.md.
//
// CUTOVER CONTRACT (single-writer guarantee for timed:prices):
//   1. Deploy this worker (crons fire but FEED_ENABLED defaults "false" →
//      every tick no-ops in ~1ms).
//   2. Verify a manual tick: GET /feed/run-once?key=<TIMED_API_KEY>.
//   3. Flip FEED_ENABLED=true here, then PRICE_FEED_EXTERNAL=true on the
//      monolith (both envs). Order matters: a one-tick overlap is harmless
//      (same data, last write wins); a gap is not.
//   4. Watch timed:prices freshness via GET /feed/health for 24h.
//   Rollback = unset both vars.
//
// The monolith REMAINS the Durable Object owner — this worker reaches
// PriceStream / PriceHub / AlpacaStream / TradovateStream through
// script_name bindings (see wrangler.toml). No DO migrations.
// ═══════════════════════════════════════════════════════════════════════════

import { runPriceFeedCron, runFeedStreamKeepAlives } from "../worker/feed/price-feed-cron.js";
import { computeFeedWindow } from "../worker/feed/feed-window.js";
import {
  mergeFreshnessIntoLatest,
  syncLivePricesToChartCandles,
} from "../worker/feed/feed-outputs.js";
import {
  loadCalendar,
  isNyRegularMarketOpen as calIsNyRegularMarketOpen,
  isWithinOperatingHours as calIsWithinOH,
  getEasternParts,
} from "../worker/market-calendar.js";
import * as DataProvider from "../worker/data-provider.js";
import { alpacaFetchSnapshots } from "../worker/indicators.js";
import { kvGetJSON } from "../worker/storage.js";

// ─── Provider routing (mirrors worker/index.js) ─────────────────────────────

function usesTwelveData(env) {
  return (env?.DATA_PROVIDER || "twelvedata").toLowerCase() === "twelvedata";
}

function isTradovateEnabled(env) {
  return String(env?.TRADOVATE_ENABLED || "false").toLowerCase() === "true";
}

async function dataFetchSnapshots(env, symbols) {
  if (usesTwelveData(env)) {
    const result = await DataProvider.fetchLatestQuotes(env, symbols);
    return result || { snapshots: {} };
  }
  return alpacaFetchSnapshots(env, symbols);
}

// ─── Session checks (calendar-aware with static fallback) ───────────────────

function makeIsNyRegularMarketOpen(cal) {
  return (now = new Date()) => {
    if (cal) {
      try { return calIsNyRegularMarketOpen(cal, now); } catch (_) {}
    }
    // Static fallback before/without calendar: weekday 9:30-16:00 ET.
    try {
      const { weekday, hour, minute } = getEasternParts(now);
      if (["Sat", "Sun"].includes(weekday)) return false;
      const mins = hour * 60 + minute;
      return mins >= 570 && mins < 960;
    } catch {
      return true; // fail open (matches monolith behavior)
    }
  };
}

function makeIsWithinOperatingHours(cal) {
  return (now = new Date()) => {
    if (cal) {
      try { return calIsWithinOH(cal, now); } catch (_) {}
    }
    // Static fallback: 4 AM - 8 PM ET weekdays.
    try {
      const { weekday, hour, minute } = getEasternParts(now);
      if (["Sat", "Sun"].includes(weekday)) return false;
      const mins = hour * 60 + minute;
      return mins >= 4 * 60 && mins < 20 * 60;
    } catch {
      return false;
    }
  };
}

// ─── Universe (SECTOR_MAP + user tickers; 60s in-process cache) ─────────────

let _userTickersCache = null;
let _userTickersCacheTs = 0;
async function d1GetActiveUserTickersCached(env) {
  const now = Date.now();
  if (_userTickersCache && (now - _userTickersCacheTs) < 60_000) return _userTickersCache;
  try {
    const rows = await env.DB.prepare(
      `SELECT DISTINCT ticker FROM user_tickers WHERE deleted_at IS NULL`
    ).all();
    _userTickersCache = (rows?.results || []).map((r) => r.ticker).filter(Boolean);
  } catch (e) {
    console.warn("[tt-feed USER_TICKERS] fetch failed:", String(e?.message || e).slice(0, 200));
    _userTickersCache = _userTickersCache || [];
  }
  _userTickersCacheTs = now;
  return _userTickersCache;
}

// ─── DO stub helpers (script_name bindings → monolith-owned DOs) ────────────

async function _doFetch(binding, path, init) {
  if (!binding) return null;
  try {
    const id = binding.idFromName("global");
    const stub = binding.get(id);
    const res = await stub.fetch(new Request(`https://internal${path}`, init));
    return res.json();
  } catch (e) {
    console.warn(`[tt-feed DO] ${path} failed:`, String(e).slice(0, 200));
    return null;
  }
}

async function notifyPriceHub(env, payload) {
  if (!env.PRICE_HUB) return;
  try {
    const id = env.PRICE_HUB.idFromName("global");
    const hub = env.PRICE_HUB.get(id);
    await hub.fetch(new Request("https://internal/ws/notify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }));
  } catch (e) {
    console.warn("[tt-feed WS NOTIFY] Error:", String(e).slice(0, 200));
  }
}

const priceStreamStart = (env, symbols) => _doFetch(env.PRICE_STREAM, "/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ symbols }) });
const priceStreamStatus = (env) => _doFetch(env.PRICE_STREAM, "/status");
const alpacaStreamStart = (env, symbols) => _doFetch(env.ALPACA_STREAM, "/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ symbols }) });
const alpacaStreamStatus = (env) => _doFetch(env.ALPACA_STREAM, "/status");
const dataStreamStart = (env, symbols) => (usesTwelveData(env) ? priceStreamStart(env, symbols) : alpacaStreamStart(env, symbols));
const dataStreamStatus = (env) => (usesTwelveData(env) ? priceStreamStatus(env) : alpacaStreamStatus(env));
const tradovateStreamStart = (env, tvSymbols) => _doFetch(env.TRADOVATE_STREAM, "/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tvSymbols }) });
const tradovateStreamStatus = (env) => _doFetch(env.TRADOVATE_STREAM, "/status");

// ─── Deps assembly ───────────────────────────────────────────────────────────

function buildDeps(cal) {
  const isNyRegularMarketOpen = makeIsNyRegularMarketOpen(cal);
  return {
    // price-feed deps
    isNyRegularMarketOpen,
    d1GetActiveUserTickersCached,
    dataFetchSnapshots,
    notifyPriceHub,
    mergeFreshnessIntoLatest,
    syncLivePricesToChartCandles: (env, pricesMap, opts) =>
      syncLivePricesToChartCandles(env, pricesMap, opts, { isNyRegularMarketOpen }),
    // keep-alive deps
    usesTwelveData,
    isWithinOperatingHours: makeIsWithinOperatingHours(cal),
    dataStreamStatus,
    dataStreamStart,
    isTradovateEnabled,
    tradovateStreamStatus,
    tradovateStreamStart,
  };
}

function feedEnabled(env) {
  return String(env?.FEED_ENABLED || "false").toLowerCase() === "true";
}

async function runFeedTick(env, ctx, { force = false } = {}) {
  const cal = await loadCalendar(env).catch(() => null);
  const deps = buildDeps(cal);
  const win = computeFeedWindow(new Date());
  let ran = false;
  if ((win.isPriceFeedCron || force) && (env.ALPACA_ENABLED === "true" || usesTwelveData(env))) {
    await runPriceFeedCron(
      env,
      ctx,
      { isLightweight: force ? false : win.isLightweight, utcMinute: win.utcMinute },
      deps,
    );
    ran = true;
  }
  // Keep-alives run on every tick (mirrors the monolith's _isEveryMin arm).
  await runFeedStreamKeepAlives(env, ctx, deps);
  return { ran, window: win };
}

export default {
  async scheduled(event, env, ctx) {
    if (env && !env.KV) env.KV = env.KV_TIMED;
    // Cutover gate — default OFF so deploying this worker changes nothing
    // until the operator flips FEED_ENABLED=true (see header runbook).
    if (!feedEnabled(env)) return;
    try {
      await runFeedTick(env, ctx);
    } catch (e) {
      console.error("[tt-feed] tick failed:", String(e?.message || e).slice(0, 300));
    }
  },

  async fetch(request, env, ctx) {
    if (env && !env.KV) env.KV = env.KV_TIMED;
    const url = new URL(request.url);

    // Health: timed:prices age + enablement, for the watchdog + cutover.
    if (url.pathname === "/feed/health") {
      let priceAgeSec = null;
      let tickerCount = null;
      let source = null;
      try {
        const raw = await kvGetJSON(env.KV_TIMED, "timed:prices");
        if (raw?.updated_at) priceAgeSec = Math.round((Date.now() - Number(raw.updated_at)) / 1000);
        tickerCount = raw?.ticker_count ?? null;
        source = raw?._source ?? null;
      } catch (_) {}
      const win = computeFeedWindow(new Date());
      let operatingHours = null;
      let nyRthOpen = null;
      try {
        const cal = await loadCalendar(env);
        operatingHours = calIsWithinOH(cal);
        nyRthOpen = calIsNyRegularMarketOpen(cal);
      } catch (_) { /* best-effort — watchdog falls back to monolith flags */ }
      return new Response(JSON.stringify({
        ok: true,
        worker: "tt-feed",
        feed_enabled: feedEnabled(env),
        prices_age_sec: priceAgeSec,
        ticker_count: tickerCount,
        source,
        operating_hours: operatingHours,
        ny_rth_open: nyRthOpen,
        price_feed_cron_active: win.isPriceFeedCron,
        feed_mode: win.isPriceFeedCron ? (win.isLightweight ? "lightweight" : "full") : "quiet",
      }), { headers: { "Content-Type": "application/json" } });
    }

    // Manual one-shot tick for cutover verification. Requires the API key
    // in X-API-Key (same secret as the monolith). Runs even when
    // FEED_ENABLED=false — that is the point (verify before flipping).
    if (url.pathname === "/feed/run-once" && request.method === "POST") {
      const key = request.headers.get("X-API-Key") || "";
      if (!env.TIMED_API_KEY || key !== env.TIMED_API_KEY) {
        return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
      }
      try {
        const result = await runFeedTick(env, ctx, { force: true });
        return new Response(JSON.stringify({ ok: true, ...result }), { headers: { "Content-Type": "application/json" } });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: String(e?.message || e).slice(0, 300) }), { status: 500, headers: { "Content-Type": "application/json" } });
      }
    }

    return new Response(JSON.stringify({ ok: false, error: "not_found" }), { status: 404, headers: { "Content-Type": "application/json" } });
  },
};
