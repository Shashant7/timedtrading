import { describe, it, expect } from "vitest";
import { buildDiscordBriefEmbed } from "../worker/daily-brief.js";

describe("buildDiscordBriefEmbed", () => {
  const baseData = {
    today: "2026-06-17",
    openTrades: [{ ticker: "SNDK", direction: "LONG", pnlPct: 27.7 }],
    todayEconomicEvents: [],
  };

  const infographic = {
    leadSummary: "SPY finished at $740.96 (-1.25%) after the FOMC held at 3.75%.",
    headline: {
      regime: "risk_off",
      vix: { level: 19.25, bucket: "normal" },
      breadth: { green: 2, total: 11 },
      openTrades: 3,
    },
    indices: [
      { sym: "SPY", price: 740.96, chgPct: -1.25 },
      { sym: "QQQ", price: 722.71, chgPct: -0.98 },
      { sym: "IWM", price: 289.88, chgPct: -0.75 },
    ],
    macro: [{ sym: "VIX", label: "VIX", value: 19.25, chgPct: 2.72 }],
    topHeadlines: [{ title: "Headline one", source: "Reuters" }],
    traderPositions: [{ ticker: "GS", direction: "LONG", pnlPct: 4.1 }],
  };

  it("uses leadSummary and infographic index snapshot (not raw futures)", () => {
    const embed = buildDiscordBriefEmbed(
      "evening",
      baseData,
      "## The Market Read\nBody.",
      "ES lean bear below 7600",
      "SPY below day gate",
      "QQQ pullback",
      "IWM flat",
      infographic,
    );
    expect(embed.description).toContain("SPY finished at $740.96");
    const names = embed.fields.map((f) => f.name);
    expect(names).toContain("Index Outlook & Game Plan");
    expect(names).toContain("Index Snapshot");
    expect(names).not.toContain("Market Snapshot");
    expect(names).not.toContain("ATR Reference Levels");
    const snap = embed.fields.find((f) => f.name === "Index Snapshot");
    expect(snap.value).toContain("SPY $740.96 (-1.25%)");
    expect(snap.value).not.toContain("ES 7586");
  });
});
