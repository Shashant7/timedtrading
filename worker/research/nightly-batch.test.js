// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

function stubDiscoveryModules() {
  const emptyReport = { by_ticker: {} };
  vi.doMock("../discovery/coverage-gaps.js", () => ({
    runCoverageGapAnalysis: async () => ({}),
    buildCoverageGapsSummary: () => emptyReport,
  }));
  vi.doMock("../macro/cross-asset-tracker.js", () => ({
    runMacroSnapshot: async () => ({ ok: true, country_rotation: { top_outperformers: [] } }),
  }));
  vi.doMock("../discovery/insider-tracker.js", () => ({
    fetchAndStoreInsiderTransactions: async () => ({ upserted: 0, errors: 0 }),
  }));
  vi.doMock("../discovery/news-tracker.js", () => ({
    fetchAndStoreNewsForTickers: async () => ({ upserted: 0 }),
    scoreUnscoredNews: async () => ({ scored: 0 }),
  }));
  vi.doMock("../discovery/social-tracker.js", () => ({
    fetchSocialDataForTickers: async () => ({ persisted: 0, attempted: 0, errors: 0 }),
    fetchRedditDataForTickers: async () => ({ persisted: 0, tickers_seen: 0, pages_fetched: 0, spikes_top10: [] }),
  }));
  vi.doMock("../discovery/x-wire-tracker.js", () => ({
    fetchDeltaOnePosts: async () => ({ ok: true, persisted: 0, fanout: 0, macro_hits: 0, discord_sent: 0 }),
  }));
  vi.doMock("../ticker-logos.js", () => ({
    syncUniverseLogos: async () => ({ synced: 0, attempted: 0, failed: 0, remaining_missing: 0 }),
  }));
  vi.doMock("../alerts.js", () => ({
    recordCronFailure: async () => {},
    recordCronSuccess: async () => {},
  }));
}

describe("nightly research batch serialization", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("../discovery/coverage-gaps.js");
    vi.doUnmock("../macro/cross-asset-tracker.js");
    vi.doUnmock("../discovery/insider-tracker.js");
    vi.doUnmock("../discovery/news-tracker.js");
    vi.doUnmock("../discovery/social-tracker.js");
    vi.doUnmock("../discovery/x-wire-tracker.js");
    vi.doUnmock("../ticker-logos.js");
    vi.doUnmock("../alerts.js");
    vi.doUnmock("../coo/coo-orchestrator.js");
    vi.doUnmock("../cro/cro-orchestrator.js");
  });

  it("runs discovery → CRO → COO sequentially (not parallel)", async () => {
    const order = [];
    stubDiscoveryModules();
    vi.doMock("../coo/coo-orchestrator.js", () => ({
      runCooDailyCycle: async () => {
        order.push("coo-start");
        await new Promise((r) => setTimeout(r, 20));
        order.push("coo-end");
        return { ok: true, calibration: { ok: true }, self_healing: { healed: [] }, elapsed_ms: 20 };
      },
    }));
    vi.doMock("../cro/cro-orchestrator.js", () => ({
      runCROFullCycle: async () => {
        order.push("cro-start");
        await new Promise((r) => setTimeout(r, 15));
        order.push("cro-end");
        return {
          cto: { ok: true, tickers_ok: 0, tickers_processed: 0 },
          rotation: { ok: true },
          fsd_ingestion: { ok: true, ingested: 0 },
          extractions: [],
          applies: [],
          cro_daily: { ok: true },
          errors: [],
          elapsed_ms: 15,
        };
      },
    }));

    const { runNightlyResearchLanes } = await import("./nightly-batch.js");
    const env = {
      KV_TIMED: { async get() { return null; }, async put() {} },
      DB: {
        prepare() {
          return {
            bind() { return this; },
            async all() { return { results: [] }; },
            async first() { return null; },
            async run() { return {}; },
          };
        },
      },
    };

    await runNightlyResearchLanes(env);

    const croStart = order.indexOf("cro-start");
    const croEnd = order.indexOf("cro-end");
    const cooStart = order.indexOf("coo-start");
    const cooEnd = order.indexOf("coo-end");
    expect(croStart).toBeGreaterThanOrEqual(0);
    expect(croEnd).toBeGreaterThan(croStart);
    expect(cooStart).toBeGreaterThan(croEnd);
    expect(cooEnd).toBeGreaterThan(cooStart);
  });

  it("runNightlyResearchBatch schedules a single waitUntil", async () => {
    stubDiscoveryModules();
    vi.doMock("../coo/coo-orchestrator.js", () => ({
      runCooDailyCycle: async () => ({ ok: true }),
    }));
    vi.doMock("../cro/cro-orchestrator.js", () => ({
      runCROFullCycle: async () => ({
        cto: { ok: true }, rotation: { ok: true }, fsd_ingestion: { skipped: true },
        extractions: [], applies: [], cro_daily: { ok: true }, errors: [], elapsed_ms: 1,
      }),
    }));

    const { runNightlyResearchBatch } = await import("./nightly-batch.js");
    const waitUntil = vi.fn((p) => p);
    const env = {
      KV_TIMED: { async get() { return null; }, async put() {} },
      DB: { prepare() { return { bind() { return this; }, async all() { return { results: [] }; } }; } },
    };
    runNightlyResearchBatch(env, { waitUntil });
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await waitUntil.mock.calls[0][0];
  });
});
