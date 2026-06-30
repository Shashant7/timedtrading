import { describe, it, expect } from "vitest";
import {
  deriveInvestorAccumulationAlertCopy,
  deriveInvestorAlertAction,
} from "./alerts.js";
import {
  buildInvestorQueueDigestBody,
  buildInvestorReduceDigestBody,
  sendInvestorSignalsDigest,
} from "./email.js";

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

  it("omits price line when price is missing or zero", () => {
    const { bodyHtml: missing } = buildInvestorQueueDigestBody(
      [{ type: "accumulation_zone", data: { ticker: "AA", score: 35 } }],
      "https://timed-trading.com",
    );
    expect(missing).not.toContain("$0.00");

    const { bodyHtml: zero } = buildInvestorQueueDigestBody(
      [{ type: "accumulation_zone", data: { ticker: "AA", score: 35, price: 0 } }],
      "https://timed-trading.com",
    );
    expect(zero).not.toContain("$0.00");
  });

  it("shows price when a positive value is present", () => {
    const { bodyHtml } = buildInvestorQueueDigestBody(
      [{ type: "accumulation_zone", data: { ticker: "AA", score: 35, price: 32.15 } }],
      "https://timed-trading.com",
    );
    expect(bodyHtml).toContain("$32.15");
  });
});

describe("buildInvestorReduceDigestBody", () => {
  it("combines reduce tickers with charts, reasons and CIO in one body", () => {
    const alerts = [
      {
        type: "thesis_invalidation",
        data: {
          ticker: "CRDO",
          price: 262.08,
          reasons: ["timing top:primary invalidation breach"],
          cio_reasoning: "CRDO being moved to reduce on thesis invalidation.",
        },
      },
      {
        type: "thesis_invalidation",
        data: { ticker: "RIOT", price: 26.83, reasons: ["primary invalidation breach"] },
      },
    ];
    const { bodyHtml, syms, count } = buildInvestorReduceDigestBody(
      alerts,
      "https://timed-trading.com",
    );
    expect(count).toBe(2);
    expect(syms).toEqual(["CRDO", "RIOT"]);
    expect(bodyHtml).toContain("Model Thesis Shift —");
    expect(bodyHtml).toContain("MODEL · REDUCE (2)");
    expect(bodyHtml).toContain("chart-image?ticker=CRDO");
    expect(bodyHtml).toContain("chart-image?ticker=RIOT");
    expect(bodyHtml).toContain("CRDO being moved to reduce on thesis invalidation.");
  });

  it("ignores non-reduce alert types", () => {
    const { count } = buildInvestorReduceDigestBody(
      [{ type: "accumulation_zone", data: { ticker: "BG" } }],
      "https://timed-trading.com",
    );
    expect(count).toBe(0);
  });
});

describe("sendInvestorSignalsDigest", () => {
  it("is deprecated and sends nothing", async () => {
    const r = await sendInvestorSignalsDigest({}, [{ type: "accumulation_zone", data: { ticker: "BG" } }]);
    expect(r.reason).toBe("deprecated");
    expect(r.sent).toBe(0);
  });
});
