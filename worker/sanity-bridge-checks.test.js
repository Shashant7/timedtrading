import { describe, it, expect } from "vitest";
import {
  evaluateBridgeMirrorCoverage,
  evaluateBrokerReconcilerFreshness,
  evaluateBrokerRejectDensity,
  isExpectedBridgeReject,
} from "./sanity-sweep.js";

describe("evaluateBridgeMirrorCoverage", () => {
  const now = Date.parse("2026-07-24T16:00:00Z");

  it("is quiet when mirror disabled", () => {
    expect(evaluateBridgeMirrorCoverage({
      mirrorEnabled: false,
      recentLotCount: 9,
      ring: [],
      nowMs: now,
    })).toEqual([]);
  });

  it("does not warn when Long Term book is quiet even if Short Term ring is busy", () => {
    const ring = Array.from({ length: 50 }, (_, i) => ({
      ts: now - i * 60000,
      trade_id: `TT-${i}`,
      status: "ok",
    }));
    expect(evaluateBridgeMirrorCoverage({
      mirrorEnabled: true,
      recentLotCount: 0,
      ring,
      nowMs: now,
    })).toEqual([]);
  });

  it("warns when recent investor lots have zero inv-* dispatches", () => {
    const an = evaluateBridgeMirrorCoverage({
      mirrorEnabled: true,
      recentLotCount: 9,
      oldestRecentLotTs: now - 20 * 3600000,
      newestRecentLotTs: now - 19 * 3600000,
      ring: [{ ts: now, trade_id: "TT-1", status: "ok" }],
      nowMs: now,
    });
    expect(an).toHaveLength(1);
    expect(an[0].severity).toBe("warn");
    expect(an[0].detail).toMatch(/ZERO inv-\*/);
  });

  it("is ok when inv-* calls cover the lot window", () => {
    const lotTs = now - 10 * 3600000;
    expect(evaluateBridgeMirrorCoverage({
      mirrorEnabled: true,
      recentLotCount: 3,
      oldestRecentLotTs: lotTs,
      newestRecentLotTs: lotTs,
      ring: [{ ts: lotTs + 1000, trade_id: "inv-KO-auto-1", status: "ok" }],
      nowMs: now,
    })).toEqual([]);
  });
});

describe("evaluateBrokerReconcilerFreshness", () => {
  it("graces overnight last_run in the first 45m of the RTH window", () => {
    // 13:10 UTC weekday — market-hours gate open, reconciler may not have run yet
    const nowMs = Date.parse("2026-07-24T13:10:00Z");
    const lastRunMs = nowMs - 845 * 60000;
    expect(evaluateBrokerReconcilerFreshness({
      lastRunMs,
      lastTickMs: nowMs - 4 * 60000,
      nowMs,
      bridgeConfigured: true,
    })).toEqual([]);
  });

  it("fails when last_run is stale after open grace", () => {
    const nowMs = Date.parse("2026-07-24T14:00:00Z");
    const lastRunMs = nowMs - 845 * 60000;
    const an = evaluateBrokerReconcilerFreshness({
      lastRunMs,
      lastTickMs: nowMs - 4 * 60000,
      nowMs,
      bridgeConfigured: true,
    });
    expect(an.some((a) => a.detail.includes("last ran"))).toBe(true);
    expect(an.find((a) => a.detail.includes("last ran")).severity).toBe("fail");
  });

  it("warns when last_tick is stale (cron dead)", () => {
    const nowMs = Date.parse("2026-07-24T15:00:00Z");
    const an = evaluateBrokerReconcilerFreshness({
      lastRunMs: nowMs - 10 * 60000,
      lastTickMs: nowMs - 45 * 60000,
      nowMs,
      bridgeConfigured: true,
    });
    expect(an.some((a) => a.detail.includes("last_tick"))).toBe(true);
  });

  it("is quiet overnight even with stale last_run", () => {
    const nowMs = Date.parse("2026-07-24T02:00:00Z");
    expect(evaluateBrokerReconcilerFreshness({
      lastRunMs: nowMs - 600 * 60000,
      lastTickMs: nowMs - 3 * 60000,
      nowMs,
      bridgeConfigured: true,
    })).toEqual([]);
  });
});

describe("evaluateBrokerRejectDensity", () => {
  const now = Date.parse("2026-09-11T04:10:00Z");

  it("treats no_broker_position and ETH limit-only as expected rejects", () => {
    expect(isExpectedBridgeReject({ reject_reason: "no_broker_position" })).toBe(true);
    expect(isExpectedBridgeReject({
      error: "Only limit orders are supported for extended-hours trading. Please consider placing a limit order to trade during extended hours.",
    })).toBe(true);
    expect(isExpectedBridgeReject({ reject_reason: "hmac_mismatch" })).toBe(false);
  });

  it("does not page when the 6h window is only expected rejects", () => {
    const ring = [
      { ts: now - 10 * 60000, ticker: "TNA", side: "exit", status: "error", reject_reason: "no_broker_position" },
      { ts: now - 20 * 60000, ticker: "UDOW", side: "exit", status: "error", reject_reason: "Only limit orders are supported for extended-hours trading" },
      { ts: now - 30 * 60000, ticker: "TQQQ", side: "exit", status: "error", error: "no_broker_position" },
      { ts: now - 40 * 60000, ticker: "SPY", side: "entry", status: "ok" },
    ];
    expect(evaluateBrokerRejectDensity({ ring, nowMs: now })).toEqual([]);
  });

  it("still pages real unresolved fetch errors", () => {
    const ring = Array.from({ length: 8 }, (_, i) => ({
      ts: now - i * 60000,
      ticker: `T${i}`,
      side: "exit",
      status: "fetch_error",
      error: "hmac_mismatch",
    }));
    const an = evaluateBrokerRejectDensity({ ring, nowMs: now });
    expect(an).toHaveLength(1);
    expect(an[0].severity).toBe("fail");
    expect(an[0].detail).toMatch(/expected rejects excluded/);
  });
});
