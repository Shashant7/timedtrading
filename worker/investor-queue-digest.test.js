import { describe, it, expect } from "vitest";
import {
  deriveInvestorAccumulationAlertCopy,
  deriveInvestorAlertAction,
} from "./alerts.js";
import { buildInvestorQueueDigestBody, sendInvestorSignalsDigest } from "./email.js";

describe("Entered Queue copy", () => {
  it("uses Entered Queue headline for execution-ready zones", () => {
    const data = {
      ticker: "BG",
      score: 66,
      zoneType: "weekly_oversold_monthly_intact",
      simEligible: true,
      inZone: true,
      actionTier: "act_now",
    };
    const action = deriveInvestorAlertAction("accumulation_zone", data);
    const copy = deriveInvestorAccumulationAlertCopy(data, action);
    expect(action.verb).toBe("MODEL · QUEUE");
    expect(copy.headline).toBe("Entered Queue");
    expect(copy.subjectBase).toContain("Entered Queue");
    expect(copy.headline).not.toMatch(/Accumulate/i);
  });
});

describe("buildInvestorQueueDigestBody", () => {
  it("combines queue tickers with charts and CIO in one body", () => {
    const alerts = [
      {
        type: "accumulation_zone",
        data: {
          ticker: "BG",
          score: 66,
          confidence: 40,
          rsRank: 100,
          zoneType: "weekly_oversold_monthly_intact",
          signals: ["weekly_oversold_monthly_intact", "monthly_trend_bullish"],
          price: 110.9,
          cio_reasoning: "Sample CIO note for BG.",
        },
      },
      {
        type: "accumulation_zone",
        data: {
          ticker: "GDX",
          score: 60,
          confidence: 40,
          rsRank: 100,
          zoneType: "weekly_oversold_monthly_intact",
          price: 77.66,
        },
      },
    ];

    const { bodyHtml, syms, count } = buildInvestorQueueDigestBody(
      alerts,
      "https://timed-trading.com",
    );
    expect(count).toBe(2);
    expect(syms).toEqual(["BG", "GDX"]);
    expect(bodyHtml).toContain("Entered Queue —");
    expect(bodyHtml).toContain("ENTERED QUEUE (2)");
    expect(bodyHtml).toContain("chart-image?ticker=BG");
    expect(bodyHtml).toContain("chart-image?ticker=GDX");
    expect(bodyHtml).toContain("Sample CIO note for BG.");
    expect(bodyHtml).not.toContain("Investor Signals —");
  });
});

describe("sendInvestorSignalsDigest", () => {
  it("is deprecated and sends nothing", async () => {
    const r = await sendInvestorSignalsDigest({}, [{ type: "accumulation_zone", data: { ticker: "BG" } }]);
    expect(r.reason).toBe("deprecated");
    expect(r.sent).toBe(0);
  });
});
