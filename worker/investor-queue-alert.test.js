import { describe, it, expect } from "vitest";
import {
  resolveInvestorKanbanStageForAlert,
  shouldFireInvestorQueueAlert,
} from "./investor.js";

describe("shouldFireInvestorQueueAlert", () => {
  const base = {
    stage: "accumulate",
    score: 72,
    simEligible: true,
    accumZone: { inZone: true, zoneType: "oversold_bounce" },
    position: { owned: false },
  };

  it("allows unowned execution-ready names in accumulate_queued lane", () => {
    expect(shouldFireInvestorQueueAlert(base)).toBe(true);
    expect(resolveInvestorKanbanStageForAlert(base)).toBe("accumulate_queued");
  });

  it("blocks when score is below Avoid threshold", () => {
    expect(shouldFireInvestorQueueAlert({ ...base, score: 28 })).toBe(false);
  });

  it("blocks owned positions (entered lane, not queue)", () => {
    const owned = {
      ...base,
      position: { owned: true, shares: 10, last_action_type: "BUY", first_entry_ts: Date.now() },
    };
    expect(resolveInvestorKanbanStageForAlert(owned)).toBe("accumulate_entered");
    expect(shouldFireInvestorQueueAlert(owned)).toBe(false);
  });

  it("blocks monitor-tier accumulate (maps to On Radar, not Queue)", () => {
    const monitor = { ...base, simEligible: false, score: 55, accumZone: { inZone: true } };
    expect(resolveInvestorKanbanStageForAlert(monitor)).toBe("research_on_watch");
    expect(shouldFireInvestorQueueAlert(monitor)).toBe(false);
  });

  it("blocks research_avoid stage even if zone flag is stale", () => {
    expect(shouldFireInvestorQueueAlert({
      ...base,
      stage: "research_avoid",
      accumZone: { inZone: true },
    })).toBe(false);
  });
});
