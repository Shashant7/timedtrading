import { describe, it, expect } from "vitest";
import {
  deriveInvestorAlertAction,
  deriveInvestorAccumulationAlertCopy,
} from "./alerts.js";

describe("deriveInvestorAlertAction accumulation_zone", () => {
  it("demotes momentum_runner exhaustion to ON RADAR", () => {
    const action = deriveInvestorAlertAction("accumulation_zone", {
      ticker: "JCI",
      score: 73,
      zoneType: "momentum_runner exhausted",
      simEligible: false,
      inZone: true,
      actionTier: "monitor",
    });
    expect(action.verb).toBe("MODEL · ON RADAR");
  });

  it("uses ACCUMULATE only when execution-ready", () => {
    const action = deriveInvestorAlertAction("accumulation_zone", {
      ticker: "SOFI",
      score: 78,
      zoneType: "oversold_bounce",
      simEligible: true,
      inZone: true,
      actionTier: "act_now",
    });
    expect(action.verb).toBe("MODEL · ACCUMULATE");
  });
});

describe("deriveInvestorAccumulationAlertCopy", () => {
  it("matches ON RADAR headline for monitor-tier zones", () => {
    const data = {
      ticker: "JCI",
      score: 73,
      zoneType: "momentum_runner exhausted",
      simEligible: false,
      inZone: true,
    };
    const action = deriveInvestorAlertAction("accumulation_zone", data);
    const copy = deriveInvestorAccumulationAlertCopy(data, action);
    expect(copy.headline).toMatch(/On Radar/i);
    expect(copy.headline).not.toMatch(/Accumulation Zone/i);
  });
});
