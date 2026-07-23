import { describe, it, expect } from "vitest";
import {
  assessRunnerPeakTrimLadder,
  resolveRunnerPeakTrimAnchor,
} from "../worker/runner-peak-trim-ladder.js";

describe("runner-peak-trim-ladder", () => {
  it("RTX: does not re-trim at the same fill using entry as anchor", () => {
    const plan = assessRunnerPeakTrimLadder({
      openTrade: {
        trimmedPct: 0.5,
        // Live getOpenPositionAsTrade historically omitted trim_price —
        // ladder must NOT fall back to entry and fire immediately.
        history: [{ type: "TRIM", price: 207.98 }],
      },
      execState: {},
      pxNow: 207.98,
      entryPx: 194.25,
      isLong: true,
      nowMs: 1_000_000,
    });
    expect(plan).toBeNull();
  });

  it("RTX: stale lower execState peak must not beat the fresh trim fill", () => {
    const anchor = resolveRunnerPeakTrimAnchor({
      openTrade: { trimmedPct: 0.5, trim_price: 207.98 },
      execState: { runnerPeakPrice: 196.54 }, // prior RTX trade residue
      isLong: true,
    });
    expect(anchor).toBe(207.98);

    const plan = assessRunnerPeakTrimLadder({
      openTrade: { trimmedPct: 0.5, trim_price: 207.98 },
      execState: { runnerPeakPrice: 196.54, lastTrimMs: 900_000 },
      pxNow: 207.98,
      isLong: true,
      nowMs: 908_540, // +8.5s — inside cooldown
    });
    expect(plan).toBeNull();
  });

  it("fires only on a true +5% extension above the trim/peak anchor", () => {
    const plan = assessRunnerPeakTrimLadder({
      openTrade: { trimmedPct: 0.5, trim_price: 200 },
      execState: { runnerPeakPrice: 200, lastTrimMs: 0 },
      pxNow: 211, // +5.5%
      isLong: true,
      nowMs: 10 * 60 * 1000,
      minMsSinceTrim: 5 * 60 * 1000,
    });
    expect(plan).not.toBeNull();
    expect(plan.newTargetTrimPct).toBeCloseTo(0.65, 5);
    expect(plan.anchorPx).toBe(200);
  });

  it("returns null when no post-trim anchor exists (no entry fallback)", () => {
    const plan = assessRunnerPeakTrimLadder({
      openTrade: { trimmedPct: 0.5 },
      execState: {},
      pxNow: 210,
      entryPx: 194.25,
      isLong: true,
      nowMs: 10 * 60 * 1000,
    });
    expect(plan).toBeNull();
  });
});
