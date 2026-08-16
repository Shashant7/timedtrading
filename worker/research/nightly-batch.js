// ═══════════════════════════════════════════════════════════════════════════
// worker/research/nightly-batch.js — the 22:00 UTC research mega-batch.
//
// P2 decomposition Step 2, v1 (2026-06-10). The three HEAVY nightly lanes —
// AI COO daily cycle, CRO/CTO full cycle, and the discovery batch — were
// extracted VERBATIM from worker/index.js scheduled()'s `0 22 * * *` gate.
// They are fully self-contained (every dependency is already a module), so
// unlike worker/feed/* there is no deps seam: both hosts call the same
// function:
//
//   - the MONOLITH keeps calling it from the 22:00 gate while
//     RESEARCH_SLOTS_EXTERNAL is unset/false (zero behavior change), and
//   - the standalone `tt-research` worker (worker-research/) runs it on its
//     own `0 22 * * *` cron + CPU budget once the operator cuts over
//     (RESEARCH_ENABLED=true there, RESEARCH_SLOTS_EXTERNAL=true here).
//     NOTE: the cutover flag is RESEARCH_SLOTS_EXTERNAL — not RESEARCH_EXTERNAL.
//
// These lanes are exactly the CPU bombs the decomposition exists for: the
// CRO full cycle alone is ~30-40 CPU-seconds, and the calibration cron was
// previously REMOVED from the monolith for CPU overruns. Moving them off
// the trade-path worker means a research blowup can never starve scoring.
//
// 2026-08-04 — SERIALIZE the three lanes (was 3× parallel ctx.waitUntil).
// Parallel launch pounded the shared D1 with COO calibration reseed + CRO
// + discovery at once → `D1 DB is overloaded. Requests queued for too long`
// and Discord "AI COO · Nightly Calibration BLOCKED". Order:
//   1) discovery batch (builds auxiliary blobs)
//   2) CRO/CTO full cycle
//   3) COO daily last (calibration is the heaviest D1 writer; also retries
//      transient D1 overload inside runCooCalibrationCycle)
// Each lane still has its own try/catch so one failure does not skip the rest.
//
// The CIO nightly chain (outcome backfill → authority eval → learning bus)
// deliberately STAYS in the monolith's 22:00 gate — it is cheap D1 work and
// tightly coupled to monolith-local helpers; it moves in Step 2 v2.
//
// NOTE for tt-research host: the COO calibration step dispatches through
// `env._selfDispatch` when present — the tt-research entry maps that onto
// the MAIN service binding so cross-worker calls avoid the CF-1042 class.
// ═══════════════════════════════════════════════════════════════════════════

import { SECTOR_MAP } from "../sector-mapping.js";
import { recordCronFailure, recordCronSuccess } from "../alerts.js";
import { runCooDailyCycle } from "../coo/coo-orchestrator.js";

async function runDiscoveryBatchLane(env) {
  const KV = env.KV_TIMED;
  const batchStart = Date.now();
  console.log("[DISCOVERY BATCH] Starting daily discovery pipeline...");

  // 1. Coverage gaps (Phase 1).
  try {
    const CoverageGaps = await import("../discovery/coverage-gaps.js");
    const tickers = Object.keys(SECTOR_MAP).slice(0, 250);
    const report = await CoverageGaps.runCoverageGapAnalysis(env, {
      lookbackDays: 14, minAtrMult: 3, tickers,
    });
    const summary = CoverageGaps.buildCoverageGapsSummary(report);
    await KV.put("timed:discovery:coverage-gaps-summary", JSON.stringify(summary), { expirationTtl: 7 * 86400 });
    console.log(`[DISCOVERY BATCH 1/5] Coverage-gap summary: ${Object.keys(summary.by_ticker).length} tickers with gaps`);
    recordCronSuccess(env, "discovery_coverage_gaps_refresh").catch(() => {});
  } catch (e) {
    console.error("[DISCOVERY BATCH 1/5] Coverage-gap refresh failed:", String(e?.message || e).slice(0, 300));
    recordCronFailure(env, { op: "discovery_coverage_gaps_refresh", error: String(e?.message || e).slice(0, 200), caller: "scheduled_event" }).catch(() => {});
  }

  // 2. Cross-asset macro snapshot (Phase 5).
  try {
    const Macro = await import("../macro/cross-asset-tracker.js");
    const result = await Macro.runMacroSnapshot(env);
    if (result?.ok) {
      console.log(`[DISCOVERY BATCH 2/5] Macro snapshot: top outperformers ${(result.country_rotation?.top_outperformers || []).map(c => c.label).join(", ")}`);
      recordCronSuccess(env, "macro_cross_asset_refresh").catch(() => {});
    } else {
      recordCronFailure(env, { op: "macro_cross_asset_refresh", error: result?.error || "unknown", caller: "scheduled_event" }).catch(() => {});
    }
  } catch (e) {
    console.error("[DISCOVERY BATCH 2/5] Macro failed:", String(e?.message || e).slice(0, 300));
    recordCronFailure(env, { op: "macro_cross_asset_refresh", error: String(e?.message || e).slice(0, 200), caller: "scheduled_event" }).catch(() => {});
  }

  // 3. Insider transactions (Phase 4a).
  try {
    const InsiderTracker = await import("../discovery/insider-tracker.js");
    const openResult = await env.DB.prepare(`SELECT DISTINCT ticker FROM positions WHERE status='OPEN'`).all().catch(() => ({ results: [] }));
    const openTickers = (openResult?.results || []).map((r) => String(r.ticker || "").toUpperCase()).filter(Boolean);
    const screenerRaw = await KV.get("timed:screener:candidates");
    const candidates = screenerRaw ? (JSON.parse(screenerRaw)?.candidates || []) : [];
    const screenerTickers = [...new Set(candidates.map((c) => String(c.ticker || "").toUpperCase()))].slice(0, 25);
    const tickers = [...new Set([...openTickers, ...screenerTickers])].slice(0, 50);
    if (tickers.length === 0) {
      console.log("[DISCOVERY BATCH 3/5] No tickers to fetch — skipping");
    } else {
      const result = await InsiderTracker.fetchAndStoreInsiderTransactions(env, tickers, { lookbackDays: 30 });
      console.log(`[DISCOVERY BATCH 3/5] Insider: ${tickers.length} fetched, ${result.upserted} new rows, ${result.errors} errors`);
      recordCronSuccess(env, "insider_refresh").catch(() => {});
    }
  } catch (e) {
    console.error("[DISCOVERY BATCH 3/5] Insider failed:", String(e?.message || e).slice(0, 300));
    recordCronFailure(env, { op: "insider_refresh", error: String(e?.message || e).slice(0, 200), caller: "scheduled_event" }).catch(() => {});
  }

  // 4. News + sentiment scoring (Phase 2).
  try {
    const NewsTracker = await import("../discovery/news-tracker.js");
    const openResult = await env.DB.prepare(`SELECT DISTINCT ticker FROM positions WHERE status='OPEN'`).all().catch(() => ({ results: [] }));
    const openTickers = (openResult?.results || []).map((r) => String(r.ticker || "").toUpperCase()).filter(Boolean);
    const screenerRaw = await KV.get("timed:screener:candidates");
    const candidates = screenerRaw ? (JSON.parse(screenerRaw)?.candidates || []) : [];
    const screenerTickers = [...new Set(candidates.map((c) => String(c.ticker || "").toUpperCase()))].slice(0, 50);
    const tickers = [...new Set([...openTickers, ...screenerTickers])].slice(0, 60);
    if (tickers.length > 0) {
      const fetchResult = await NewsTracker.fetchAndStoreNewsForTickers(env, tickers, { lookbackDays: 5 });
      const scoreResult = await NewsTracker.scoreUnscoredNews(env, { limit: 200 });
      console.log(`[DISCOVERY BATCH 4/5] News: ${fetchResult.upserted} headlines fetched, ${scoreResult.scored} scored`);
      recordCronSuccess(env, "news_refresh_and_score").catch(() => {});
    }
  } catch (e) {
    console.error("[DISCOVERY BATCH 4/5] News failed:", String(e?.message || e).slice(0, 300));
    recordCronFailure(env, { op: "news_refresh_and_score", error: String(e?.message || e).slice(0, 200), caller: "scheduled_event" }).catch(() => {});
  }

  // 4.5. Social buzz (StockTwits Phase 1).
  //
  // 2026-05-29 — added after user feedback "SNOW has been getting a
  // lot of mention on X and by other traders. Not sure how we
  // factor in a broader reach of news." StockTwits is free, no
  // API key, ticker-native, captures bullish/bearish user tags
  // and watchlist count. We fetch up to 60 tickers/day (same
  // budget as news) — open positions plus top screener candidates.
  try {
    const SocialTracker = await import("../discovery/social-tracker.js");
    const openResult = await env.DB.prepare(`SELECT DISTINCT ticker FROM positions WHERE status='OPEN'`).all().catch(() => ({ results: [] }));
    const openTickers = (openResult?.results || []).map((r) => String(r.ticker || "").toUpperCase()).filter(Boolean);
    const screenerRaw = await KV.get("timed:screener:candidates");
    const candidates = screenerRaw ? (JSON.parse(screenerRaw)?.candidates || []) : [];
    const screenerTickers = [...new Set(candidates.map((c) => String(c.ticker || "").toUpperCase()))].slice(0, 50);
    const tickers = [...new Set([...openTickers, ...screenerTickers])].slice(0, 60);
    if (tickers.length > 0) {
      const result = await SocialTracker.fetchSocialDataForTickers(env, tickers, { delayMs: 200 });
      console.log(`[DISCOVERY BATCH 4.5/5] Social (StockTwits): ${result.persisted}/${result.attempted} persisted, ${result.errors} errors`);
      recordCronSuccess(env, "social_refresh").catch(() => {});
    }
  } catch (e) {
    console.error("[DISCOVERY BATCH 4.5/5] Social failed:", String(e?.message || e).slice(0, 300));
    recordCronFailure(env, { op: "social_refresh", error: String(e?.message || e).slice(0, 200), caller: "scheduled_event" }).catch(() => {});
  }

  // 4.6. Reddit mentions (Apewisdom Phase 2).
  //
  // 2026-05-29 — Phase 2 of the social-signal stack. Apewisdom
  // aggregates r/wallstreetbets + r/stocks + r/options + r/investing
  // + r/StockMarket + r/pennystocks and returns mention count,
  // 24h-spike ratio, rank, and upvote totals in a single batched
  // crawl (~14 pages, <2 sec total). We persist snapshots for:
  //   - Our open positions
  //   - Our top screener candidates
  //   - ANY ticker with 2x+ spike + ≥25 mentions (early discovery —
  //     surfaces names BEFORE they hit our other screeners)
  //   - ANY ticker in apewisdom top-25 rank
  try {
    const SocialTracker = await import("../discovery/social-tracker.js");
    const openResult = await env.DB.prepare(`SELECT DISTINCT ticker FROM positions WHERE status='OPEN'`).all().catch(() => ({ results: [] }));
    const openTickers = (openResult?.results || []).map((r) => String(r.ticker || "").toUpperCase()).filter(Boolean);
    const screenerRaw = await KV.get("timed:screener:candidates");
    const candidates = screenerRaw ? (JSON.parse(screenerRaw)?.candidates || []) : [];
    const screenerTickers = [...new Set(candidates.map((c) => String(c.ticker || "").toUpperCase()))].slice(0, 60);
    const tickers = [...new Set([...openTickers, ...screenerTickers])];
    const result = await SocialTracker.fetchRedditDataForTickers(env, tickers, { pageDelayMs: 200 });
    console.log(`[DISCOVERY BATCH 4.6/5] Social (Reddit/Apewisdom): ${result.persisted} persisted from ${result.tickers_seen} seen, ${result.pages_fetched} pages`);
    if (result.spikes_top10?.length > 0) {
      console.log(`[DISCOVERY BATCH 4.6/5] Top spikes:`, result.spikes_top10.slice(0, 5).map(s => `${s.ticker}=${s.spike}x(${s.mentions})`).join(", "));
    }
    recordCronSuccess(env, "social_reddit_refresh").catch(() => {});
  } catch (e) {
    console.error("[DISCOVERY BATCH 4.6/5] Reddit failed:", String(e?.message || e).slice(0, 300));
    recordCronFailure(env, { op: "social_reddit_refresh", error: String(e?.message || e).slice(0, 200), caller: "scheduled_event" }).catch(() => {});
  }

  // 4.7. X wire accounts (Phase 3) — curated macro/flow handles.
  try {
    const XWire = await import("../discovery/x-wire-tracker.js");
    const wireResult = await XWire.fetchDeltaOnePosts(env, { delayMs: 400 });
    if (wireResult.ok) {
      console.log(`[DISCOVERY BATCH 4.7/5] X wire: ${wireResult.persisted} new posts, ${wireResult.fanout} ticker_news rows, ${wireResult.macro_hits} macro hits, ${wireResult.discord_sent || 0} discord`);
      if (wireResult.persisted > 0) {
        const NewsTracker = await import("../discovery/news-tracker.js");
        const scoreResult = await NewsTracker.scoreUnscoredNews(env, { limit: 50 });
        console.log(`[DISCOVERY BATCH 4.7/5] X wire news scored: ${scoreResult.scored}`);
      }
      recordCronSuccess(env, "x_wire_refresh").catch(() => {});
    } else if (wireResult.error !== "no_x_api_bearer_token") {
      recordCronFailure(env, { op: "x_wire_refresh", error: wireResult.error || "failed", caller: "scheduled_event" }).catch(() => {});
    }
  } catch (e) {
    console.error("[DISCOVERY BATCH 4.7/5] X wire failed:", String(e?.message || e).slice(0, 300));
    recordCronFailure(env, { op: "x_wire_refresh", error: String(e?.message || e).slice(0, 200), caller: "scheduled_event" }).catch(() => {});
  }

  // 5. Promotion queue rebuild — DEFERRED to 23:00 COO screener lane.
  // At 22:00 the GitHub screener POST (22:30) hasn't landed yet, so
  // rebuilding here scored stale/empty KV and COO auto-promote found
  // zero needs_review rows. See runCooScreenerLane @ 0 23 * * 1-5.
  console.log("[DISCOVERY BATCH 5/5] Promotion queue deferred to 23:00 COO screener lane (post-22:30 ingest)");

  // 6. Ticker logos — cache missing universe logos in KV (Finnhub → eodhd).
  try {
    const Logos = await import("../ticker-logos.js");
    const result = await Logos.syncUniverseLogos(env, {
      max: 40,
      onlyMissing: true,
      sectorMapKeys: Object.keys(SECTOR_MAP),
    });
    console.log(`[DISCOVERY BATCH 6/6] Logos: synced ${result.synced}/${result.attempted}, failed ${result.failed}, remaining ~${result.remaining_missing}`);
    recordCronSuccess(env, "ticker_logos_sync").catch(() => {});
  } catch (e) {
    console.error("[DISCOVERY BATCH 6/6] Logo sync failed:", String(e?.message || e).slice(0, 300));
    recordCronFailure(env, { op: "ticker_logos_sync", error: String(e?.message || e).slice(0, 200), caller: "scheduled_event" }).catch(() => {});
  }

  console.log(`[DISCOVERY BATCH] Complete in ${Date.now() - batchStart}ms`);
}

async function runCroCtoLane(env) {
  try {
    const { runCROFullCycle } = await import("../cro/cro-orchestrator.js");
    const summary = await runCROFullCycle(env, { force: false });
    console.log(`[CRO/CTO daily] cto=${summary.cto?.ok ? `${summary.cto.tickers_ok}/${summary.cto.tickers_processed}` : 'err'} rotation=${summary.rotation?.ok ? 'ok' : 'err'} fsd=${summary.fsd_ingestion?.ok ? `ingested ${summary.fsd_ingestion.ingested ?? 0}` : (summary.fsd_ingestion?.skipped || 'err')} extractions=${summary.extractions?.length || 0} applies=${(summary.applies || []).filter((a) => a.applied).length} cro_daily=${summary.cro_daily?.ok ? 'ok' : (summary.cro_daily?.skipped || 'err')} elapsed=${summary.elapsed_ms}ms`);
    if (summary.errors?.length) {
      console.warn(`[CRO/CTO daily] errors=${summary.errors.length}: ${summary.errors.slice(0, 3).join(" | ").slice(0, 400)}`);
    }
    recordCronSuccess(env, "cro_full_cycle").catch(() => {});
  } catch (e) {
    console.error("[CRO/CTO daily] threw:", String(e?.message || e).slice(0, 200));
    recordCronFailure(env, { op: "cro_full_cycle", error: String(e?.message || e).slice(0, 200), caller: "scheduled_event" }).catch(() => {});
  }

  // Macro Minute — Vimeo captions on the FSD post (primary), then YouTube
  // as a best-effort mirror. After the FSD cycle so a same-evening video
  // is in the overnight extraction window; fsd-evening (00-03 UTC) catches
  // later posts before the 9 AM ET morning brief.
  try {
    const { enrichVideoTranscripts, countMacroMinuteIngested } = await import("../cro/fsd-ingestion.js");
    // Macro Minute and Newton's Daily Technical Strategy both ship as video.
    const vr = await enrichVideoTranscripts(env, { limit: 8 });
    console.log(`[FSD_VIDEO_VIMEO] scanned=${vr.scanned ?? 0} attempted=${vr.attempted ?? 0} ingested=${vr.ingested ?? 0}`);
    if (vr.ingested > 0) recordCronSuccess(env, "macro_minute_vimeo_enrich").catch(() => {});
    if ((vr.ingested || 0) > 0) {
      // The night-take sync is Macro Minute only; a Newton video still flows
      // through the normal FSD extract path below.
      if (countMacroMinuteIngested(vr) > 0) {
        const { syncLatestMacroMinuteProposals } = await import("../cro/fsd-ingestion.js");
        await syncLatestMacroMinuteProposals(env, { limit: 1, force: true });
      }
      const { runCRODaily } = await import("../cro/cro-service.js");
      await runCRODaily(env, { force: true });
    }
    const { assessAndPersistMacroMinuteFreshness } = await import("../cro/macro-minute-freshness.js");
    await assessAndPersistMacroMinuteFreshness(env);
  } catch (e) {
    console.error("[MACRO_MINUTE_VIMEO] threw:", String(e?.message || e).slice(0, 200));
    recordCronFailure(env, { op: "macro_minute_vimeo_enrich", error: String(e?.message || e).slice(0, 200), caller: "scheduled_event" }).catch(() => {});
  }
  try {
    const { isMacroMinuteYtEnabled, ingestMacroMinuteFromYoutube } = await import("../cro/macro-minute-youtube.js");
    if (isMacroMinuteYtEnabled(env)) {
      const { ingestFromBlob } = await import("../cro/fsd-ingestion.js");
      const r = await ingestMacroMinuteFromYoutube(env, { limit: 5, ingestFromBlob });
      console.log(`[MACRO_MINUTE_YT] discovered=${r.discovered ?? 0} ingested=${r.ingested ?? 0}${r.note ? ` note=${r.note}` : ""}`);
      if (r.ingested > 0) recordCronSuccess(env, "macro_minute_yt_ingest").catch(() => {});
    }
  } catch (e) {
    console.error("[MACRO_MINUTE_YT] threw:", String(e?.message || e).slice(0, 200));
    recordCronFailure(env, { op: "macro_minute_yt_ingest", error: String(e?.message || e).slice(0, 200), caller: "scheduled_event" }).catch(() => {});
  }
}

async function runCooDailyLane(env) {
  try {
    const summary = await runCooDailyCycle(env);
    console.log(`[COO daily] calibration=${summary?.calibration?.ok ? 'ok' : 'skipped/err'} healed=${summary?.self_healing?.healed?.length || 0} elapsed=${summary?.elapsed_ms}ms`);
  } catch (e) {
    console.error("[COO daily] threw:", String(e?.message || e).slice(0, 200));
  }
}

/**
 * Run the three heavy research lanes sequentially on one waitUntil.
 * Exported for unit tests (order + isolation of failures).
 */
export async function runNightlyResearchLanes(env) {
  // Discovery first (auxiliary blobs), CRO next, COO calibration last.
  await runDiscoveryBatchLane(env);
  await runCroCtoLane(env);
  await runCooDailyLane(env);
}

export function runNightlyResearchBatch(env, ctx) {
  // Single waitUntil — do NOT fan out three parallel D1 storms.
  ctx.waitUntil(runNightlyResearchLanes(env));
}
