import { describe, it, expect } from "vitest";
import {
  parseIntelJson,
  aggregateRiskTone,
  buildTopCatalysts,
  macroWireContextForTicker,
  isMacroWireKind,
} from "./macro-wire-intel.js";
import {
  postTiltContribution,
  computeMacroRiskTiltMap,
  MACRO_RISK_MAX,
} from "../macro-risk-tilt.js";

describe("macro-wire-intel", () => {
  it("recognizes macro_wire kind", () => {
    expect(isMacroWireKind("macro_wire")).toBe(true);
    expect(isMacroWireKind("general")).toBe(false);
  });

  it("parses and validates intel JSON", () => {
    const intel = parseIntelJson({
      sentiment: "bearish",
      urgency: "high",
      risk_tone: "risk-off",
      is_catalyst: true,
      catalyst_strength: 9,
      themes: ["defense", "fake_theme"],
      tickers: ["LMT", "BAD123"],
    });
    expect(intel.sentiment).toBe("bearish");
    expect(intel.themes).toEqual(["defense"]);
    expect(intel.tickers).toEqual(["LMT"]);
  });

  it("aggregates risk tone from posts", () => {
    const tone = aggregateRiskTone([
      { intel: { risk_tone: "risk-off", urgency: "high", catalyst_strength: 8 } },
      { intel: { risk_tone: "risk-off", urgency: "medium", catalyst_strength: 6 } },
    ]);
    expect(tone).toBe("risk-off");
  });

  it("builds top catalysts sorted by score", () => {
    const top = buildTopCatalysts([
      { text: "noise headline", handle: "DeItaone", intel_json: JSON.stringify({ sentiment: "neutral", urgency: "low", catalyst_strength: 1, is_catalyst: false }) },
      { text: "US CPI HOT", handle: "DeItaone", intel_json: JSON.stringify({ sentiment: "bearish", urgency: "high", catalyst_strength: 9, is_catalyst: true, themes: ["banks_money_center"] }) },
    ], 2);
    expect(top[0].headline).toContain("CPI");
    expect(top[0].score).toBeGreaterThan(top[1].score);
  });

  it("builds per-ticker CIO context from pulse", () => {
    const pulse = {
      risk_tone: "risk-off",
      dominant_themes: [{ theme: "defense", count: 2 }],
      posts: [{
        handle: "DeItaone",
        text: "NATO summit escalation",
        created_at: "2026-07-08T22:00:00Z",
        intel: { urgency: "high", sentiment: "bearish", themes: ["defense"], tickers: ["LMT"] },
      }],
    };
    const ctx = macroWireContextForTicker(pulse, "LMT");
    expect(ctx.risk_tone).toBe("risk-off");
    expect(ctx.relevant_headlines.length).toBe(1);
  });
});

describe("macro-risk-tilt", () => {
  it("scores bullish defense headline positive for LMT", () => {
    const intel = { sentiment: "bullish", urgency: "high", catalyst_strength: 8, themes: ["defense"], tickers: ["LMT"] };
    const c = postTiltContribution(intel, { sym: "LMT", themes: ["defense"], sector: "Industrials" });
    expect(c).toBeGreaterThan(0);
    expect(c).toBeLessThanOrEqual(MACRO_RISK_MAX);
  });

  it("computes tilt map from pulse", () => {
    const map = computeMacroRiskTiltMap({
      pulse: {
        risk_tone: "risk-on",
        posts: [{
          intel: {
            sentiment: "bullish",
            urgency: "high",
            catalyst_strength: 8,
            themes: ["defense"],
            tickers: [],
          },
        }],
      },
    });
    expect(map.by_ticker.LMT).toBeTruthy();
    expect(map.by_ticker.LMT.tilt).toBeGreaterThan(0);
  });
});
