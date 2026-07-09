// worker/cio/cio-memory-loader.js
// Ensures CIO lifecycle calls outside the scoring cron still receive the
// same memory substrate as trader entry CIO — especially research-desk
// ingest (CRO daily note, FSD tactical overrides, per-ticker FSD pubs).

import { buildCIOMemory } from "./cio-memory.js";
import { LOOP2_PULSE_KEY } from "../phase-c-loops.js";

const CACHE_TTL_MS = 5 * 60 * 1000;

function parseJson(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/**
 * Load (or reuse) env._cioMemoryCache with research-desk + macro context.
 * Lighter than the full scoring-cron preload but includes every layer
 * Investor CIO needs: CRO note (15c), tactical override (15b), CTO rollup
 * (15d), engine pulse (16), macro, live prices.
 */
export async function ensureCioMemoryCache(env, opts = {}) {
  const now = Date.now();
  if (
    !opts.force
    && env?._cioMemoryCache
    && Number(env._cioMemoryCacheLoadedAt) > 0
    && (now - env._cioMemoryCacheLoadedAt) < CACHE_TTL_MS
  ) {
    return env._cioMemoryCache;
  }

  const KV = env?.KV_TIMED;
  const cache = {
    pathPerf: new Map(),
    marketSnapshots: [],
    marketEvents: [],
    tickerProfiles: {},
    franchise: null,
    referenceFeatures: null,
    cioDecisions: [],
    screenerCandidates: null,
    coverageGapsSummary: null,
    discoveryGameplan: null,
    macroSnapshot: null,
    livePrices: null,
    insiderSummaries: {},
    newsSummaries: {},
    enginePulse: null,
    croNote: null,
    ctoLevels: null,
    tacticalOverride: null,
    fsdAccuracy: null,
    macroWirePulse: null,
    fsdIntelByTicker: env?._cioMemoryCache?.fsdIntelByTicker || {},
  };

  if (KV) {
    const [croRaw, ovRaw, ctoRaw, macroRaw, pulseRaw, lpRaw, gapsRaw, gameplanRaw, fsdAccRaw, mwRaw] = await Promise.all([
      KV.get("timed:cro:latest").catch(() => null),
      KV.get("cro:tactical_overrides").catch(() => null),
      KV.get("timed:cto:latest").catch(() => null),
      KV.get("timed:macro:cross-asset-summary").catch(() => null),
      KV.get(LOOP2_PULSE_KEY).catch(() => null),
      KV.get("timed:prices").catch(() => null),
      KV.get("timed:discovery:coverage-gaps-summary").catch(() => null),
      KV.get("timed:discovery:gameplan").catch(() => null),
      KV.get("timed:fsd:accuracy").catch(() => null),
      KV.get("timed:discovery:macro-wire-pulse").catch(() => null),
    ]);
    cache.croNote = parseJson(croRaw);
    cache.tacticalOverride = parseJson(ovRaw);
    cache.ctoLevels = parseJson(ctoRaw);
    cache.macroSnapshot = parseJson(macroRaw);
    cache.enginePulse = parseJson(pulseRaw);
    cache.livePrices = parseJson(lpRaw);
    cache.coverageGapsSummary = parseJson(gapsRaw);
    cache.discoveryGameplan = parseJson(gameplanRaw);
    cache.fsdAccuracy = parseJson(fsdAccRaw);
    cache.macroWirePulse = parseJson(mwRaw);
  }

  if (env?.DB) {
    try {
      const [ppLive, snapLive, evLive, franchiseLive] = await Promise.all([
        env.DB.prepare(`SELECT * FROM path_performance WHERE total_trades >= 3`).all().catch(() => ({ results: [] })),
        env.DB.prepare(`SELECT * FROM daily_market_snapshots ORDER BY date DESC LIMIT 30`).all().catch(() => ({ results: [] })),
        env.DB.prepare(`SELECT * FROM market_events WHERE date >= ? ORDER BY date DESC LIMIT 50`).bind(
          new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10),
        ).all().catch(() => ({ results: [] })),
        env.DB.prepare(`SELECT config_value FROM model_config WHERE config_key='cio_franchise_blacklist'`).first().catch(() => null),
      ]);
      for (const r of (ppLive?.results || [])) cache.pathPerf.set(r.entry_path, r);
      cache.marketSnapshots = (snapLive?.results || []).reverse();
      cache.marketEvents = (evLive?.results || []).reverse();
      if (franchiseLive?.config_value) cache.franchise = parseJson(franchiseLive.config_value);
    } catch (e) {
      console.warn("[CIO_MEM_LOADER] D1 preload failed:", String(e?.message || e).slice(0, 120));
    }
  }

  env._cioMemoryCache = cache;
  env._cioMemoryCacheLoadedAt = now;
  return cache;
}

/**
 * Preload per-ticker FSD research-desk intel into memoryCache.fsdIntelByTicker.
 * Caps batch size to avoid blowing the auto-rebalance latency budget.
 */
export async function preloadFsdIntelForTickers(env, tickers, opts = {}) {
  await ensureCioMemoryCache(env);
  const cache = env._cioMemoryCache;
  if (!cache.fsdIntelByTicker) cache.fsdIntelByTicker = {};

  const limit = Number(opts.limit) || 3;
  const lookbackDays = Number(opts.lookbackDays) || 14;
  const maxTickers = Number(opts.maxTickers) || 24;

  const need = [...new Set((tickers || []).map((s) => String(s || "").toUpperCase()).filter(Boolean))]
    .filter((sym) => !cache.fsdIntelByTicker[sym])
    .slice(0, maxTickers);

  if (!need.length) return;

  try {
    const { loadFSDIntelForTicker } = await import("../cro/fsd-ingestion.js");
    await Promise.all(need.map(async (sym) => {
      const intel = await loadFSDIntelForTicker(env, sym, {
        limit,
        lookbackDays,
        includeText: false,
      }).catch(() => null);
      if (intel && Number(intel.count) > 0) {
        cache.fsdIntelByTicker[sym] = intel;
      }
    }));
  } catch (e) {
    console.warn("[CIO_MEM_LOADER] FSD preload failed:", String(e?.message || e).slice(0, 120));
  }
}

/**
 * Build full CIO memory for Investor lifecycle decisions (LONG horizon).
 * Includes research-desk layers when cache is warm.
 */
export async function buildInvestorCioMemory(env, sym, tickerData, allTrades = []) {
  await ensureCioMemoryCache(env);
  const s = String(sym || "").toUpperCase();
  const td = tickerData && typeof tickerData === "object" ? tickerData : { ticker: s };

  // Per-ticker FSD intel — lazy single-ticker fetch if not batch-preloaded.
  if (env._cioMemoryCache && !env._cioMemoryCache.fsdIntelByTicker?.[s]) {
    await preloadFsdIntelForTickers(env, [s], { maxTickers: 1, limit: 4 });
  }

  const mem = buildCIOMemory(s, "LONG", td, allTrades || [], env._cioMemoryCache);

  try {
    if (mem && typeof mem === "object" && td?.latent_regime?.state) {
      mem.latent_regime = {
        state: td.latent_regime.state,
        posterior: td.latent_regime.posterior,
        decoded_at: td.latent_regime.decoded_at,
      };
    }
  } catch (_) { /* best-effort */ }

  mem.investor_mode = true;
  return mem;
}
