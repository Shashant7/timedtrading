// tests/module-contracts.test.js
//
// Static contract tests: assert that named exports referenced by
// one module actually EXIST in the target module. Stops the class
// of bugs where a refactor renames an exported function and a caller
// still references the old name — which silently bundles in CF
// Workers and only throws at runtime.
//
// Examples of past bugs this would have caught:
//   • COO orchestrator referenced PromotionQueue.listPromotionQueue
//     when the actual export was loadPromotionQueueRows. Caused
//     /timed/admin/discovery/run-related screener auto-promote
//     calls to throw at runtime.
//   • move-discovery.js exported runMoveDiscovery; admin endpoint
//     imported it as Discovery.runMoveDiscovery (dynamic import).
//     This test fails fast if the export disappears.

import { describe, it, expect } from "vitest";

describe("module contracts", () => {
  it("worker/discovery/promotion-queue.js exposes expected named exports", async () => {
    const mod = await import("../worker/discovery/promotion-queue.js");
    for (const fn of [
      "ensurePromotionQueueSchema",
      "rebuildPromotionQueue",
      "loadPromotionQueueRows",
      "loadThesisForTicker",
      "decideOnCandidate",
    ]) {
      expect(typeof mod[fn], `expected exported function ${fn}`).toBe("function");
    }
  });

  it("worker/discovery/move-discovery.js exposes runMoveDiscovery", async () => {
    const mod = await import("../worker/discovery/move-discovery.js");
    expect(typeof mod.runMoveDiscovery).toBe("function");
  });

  it("worker/discovery/diagnose-missed.js exposes runDiagnosis", async () => {
    const mod = await import("../worker/discovery/diagnose-missed.js");
    expect(typeof mod.runDiagnosis).toBe("function");
  });

  it("worker/coo/coo-orchestrator.js exposes the surface the worker imports", async () => {
    const mod = await import("../worker/coo/coo-orchestrator.js");
    for (const fn of [
      "runCooDailyCycle",
      "runCooCalibrationCycle",
      "runSelfHealing",
      "getRecentCooActions",
      "getLatestCooCycle",
      "runScreenerAutoPromote",
      "runMoveDiscoveryCycle",
    ]) {
      expect(typeof mod[fn], `expected exported function ${fn}`).toBe("function");
    }
  });

  it("worker/trade-trim-display.js exposes trim economics helpers", async () => {
    const mod = await import("../worker/trade-trim-display.js");
    for (const fn of [
      "formatTrimDeltaPct",
      "buildTrimEconomicsSummary",
      "isPhantomTrimRealized",
    ]) {
      expect(typeof mod[fn], `expected exported function ${fn}`).toBe("function");
    }
  });

  it("worker/runner-stale-policy.js exposes stale fuse helpers", async () => {
    const mod = await import("../worker/runner-stale-policy.js");
    for (const fn of [
      "ratchetRunnerPeak",
      "runnerStaleAnchorMs",
      "assessRunnerStaleDefer",
    ]) {
      expect(typeof mod[fn], `expected exported function ${fn}`).toBe("function");
    }
  });

  it("worker/sanity-sweep.js exposes the cron + endpoint helpers", async () => {
    const mod = await import("../worker/sanity-sweep.js");
    for (const fn of [
      "runSanitySweep",
      "persistSweep",
      "sanitySweepCron",
    ]) {
      expect(typeof mod[fn], `expected exported function ${fn}`).toBe("function");
    }
  });
});
