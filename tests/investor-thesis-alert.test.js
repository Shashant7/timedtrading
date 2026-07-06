import { describe, it, expect } from "vitest";
import {
  shouldFireInvestorThesisShiftAlert,
  bumpInvestorReduceStreak,
  isImmediateInvestorReduce,
} from "../worker/investor.js";
import { assessRunnerPeakTrimLadder } from "../worker/runner-peak-trim-ladder.js";

describe("shouldFireInvestorThesisShiftAlert", () => {
  it("suppresses score-only reduce on first hour (TWLO transient dip)", () => {
    const curr = { stage: "reduce", stageReason: "investor_score_very_low", score: 28 };
    const aprev = { stage: "watch" };
    expect(shouldFireInvestorThesisShiftAlert(curr, aprev, { reduceStreak: 1, minSessions: 2 })).toBe(false);
  });

  it("fires score-only reduce after consecutive sessions", () => {
    const curr = { stage: "reduce", stageReason: "investor_score_very_low", score: 28 };
    const aprev = { stage: "watch" };
    expect(shouldFireInvestorThesisShiftAlert(curr, aprev, { reduceStreak: 2, minSessions: 2 })).toBe(true);
  });

  it("does not fire when score recovered above reduce threshold", () => {
    const curr = { stage: "reduce", stageReason: "investor_score_very_low", score: 57 };
    const aprev = { stage: "watch" };
    expect(shouldFireInvestorThesisShiftAlert(curr, aprev, { reduceStreak: 2, minSessions: 2 })).toBe(false);
  });

  it("fires immediately on structural invalidation", () => {
    const curr = { stage: "reduce", stageReason: "monthly_supertrend_bearish", score: 40 };
    const aprev = { stage: "core_hold" };
    expect(shouldFireInvestorThesisShiftAlert(curr, aprev, { reduceStreak: 1, minSessions: 2 })).toBe(true);
    expect(isImmediateInvestorReduce("monthly_supertrend_bearish")).toBe(true);
    expect(isImmediateInvestorReduce("investor_score_very_low")).toBe(false);
  });
});

describe("bumpInvestorReduceStreak", () => {
  it("increments on reduce and resets otherwise", () => {
    let map = {};
    map = bumpInvestorReduceStreak(map, "TWLO", "reduce");
    expect(map.TWLO).toBe(1);
    map = bumpInvestorReduceStreak(map, "TWLO", "reduce");
    expect(map.TWLO).toBe(2);
    map = bumpInvestorReduceStreak(map, "TWLO", "watch");
    expect(map.TWLO).toBe(0);
  });
});

describe("assessRunnerPeakTrimLadder", () => {
  it("trims another slice when price exceeds anchor by bump threshold", () => {
    const plan = assessRunnerPeakTrimLadder({
      openTrade: { trimmedPct: 0.5, trim_price: 1447 },
      execState: { runnerPeakPrice: 1447 },
      pxNow: 1520,
      entryPx: 1346,
      isLong: true,
      cfg: { deep_audit_runner_peak_trim_bump_pct: 5, deep_audit_runner_peak_trim_add_pct: 0.15 },
    });
    expect(plan).not.toBeNull();
    expect(plan.newTargetTrimPct).toBeCloseTo(0.65, 2);
    expect(plan.reason).toBe("RUNNER_PEAK_TRIM_LADDER");
  });

  it("returns null when bump is below threshold", () => {
    const plan = assessRunnerPeakTrimLadder({
      openTrade: { trimmedPct: 0.5, trim_price: 1447 },
      execState: { runnerPeakPrice: 1447 },
      pxNow: 1460,
      entryPx: 1346,
      isLong: true,
      cfg: { deep_audit_runner_peak_trim_bump_pct: 5 },
    });
    expect(plan).toBeNull();
  });
});
