import { describe, it, expect } from "vitest";
import {
  deriveInvestorAlertAction,
  deriveInvestorAccumulationAlertCopy,
  createInvestorAlertEmbed,
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

  it("uses QUEUE only when execution-ready", () => {
    const action = deriveInvestorAlertAction("accumulation_zone", {
      ticker: "SOFI",
      score: 78,
      zoneType: "oversold_bounce",
      simEligible: true,
      inZone: true,
      actionTier: "act_now",
    });
    expect(action.verb).toBe("MODEL · QUEUE");
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

describe("createInvestorAlertEmbed buy actions", () => {
  it("uses prominent DOING title for rebalance open", () => {
    const embed = createInvestorAlertEmbed("position_open", {
      ticker: "FIX",
      shares: 3.58,
      price: 1957.31,
      value: 7000,
      stage: "accumulate",
      score: 72,
    });
    expect(embed.title).toContain("**FIX**");
    expect(embed.title).toContain("DOING");
    expect(embed.title).toContain("BOUGHT");
  });

  it("uses prominent DOING title for rebalance add", () => {
    const embed = createInvestorAlertEmbed("position_add", {
      ticker: "CAT",
      shares: 7.09,
      price: 987.85,
      value: 7000,
      stage: "accumulate",
      score: 68,
    });
    expect(embed.title).toContain("**CAT**");
    expect(embed.title).toContain("DOING");
    expect(embed.title).toContain("ADD");
  });
});
