import { describe, it, expect } from "vitest";
import {
  ratchetRunnerPeak,
  runnerStaleAnchorMs,
  assessRunnerStaleDefer,
} from "../worker/runner-stale-policy.js";

describe("runner-stale-policy", () => {
  it("ratchets runner peak and timestamp on new high", () => {
    const now = 1_700_000_000_000;
    const execState = { runnerPeakPrice: 1447, runnerPeakTs: now - 86400000 };
    const openTrade = { trimmedPct: 0.5 };
    const out = ratchetRunnerPeak(execState, openTrade, 1745, "LONG", now);
    expect(out.updated).toBe(true);
    expect(out.execState.runnerPeakPrice).toBe(1745);
    expect(out.execState.runnerPeakTs).toBe(now);
  });

  it("uses max(trimMs, peakMs) as stale anchor", () => {
    const trimMs = 1_700_000_000_000;
    const peakMs = 1_750_000_000_000;
    const anchor = runnerStaleAnchorMs(
      { lastTrimMs: trimMs, runnerPeakTs: peakMs },
      {},
    );
    expect(anchor).toBe(peakMs);
  });

  it("defers stale close for hot momentum runner with intact HTF", () => {
    const defer = assessRunnerStaleDefer({
      openTrade: { maxFavorableExcursion: 74 },
      tickerData: {
        flags: { momentum_elite: true },
        _theme_tilt: 3,
        market_internals: { sector_rotation: { state: "risk_on" } },
        _env: { _deepAuditConfig: {} },
      },
      pxNow: 1745,
      entryPx: 1346,
      isLong: true,
      holdHours: 130,
      limitHours: 120,
      htfIntact: true,
    });
    expect(defer.defer).toBe(true);
  });

  it("does not defer when HTF broken", () => {
    const defer = assessRunnerStaleDefer({
      openTrade: { maxFavorableExcursion: 74 },
      tickerData: { flags: { momentum_elite: true }, _env: { _deepAuditConfig: {} } },
      pxNow: 1745,
      entryPx: 1346,
      isLong: true,
      holdHours: 130,
      limitHours: 120,
      htfIntact: false,
    });
    expect(defer.defer).toBe(false);
  });
});
