import { describe, it, expect } from "vitest";
import {
  extractCycleReferencesFromText,
  extractCycleReferencesFromKeyPoints,
  inferFsdCyclePhase,
  cycleAlignment,
  buildDailyCycleComposite,
} from "./daily-cycle-composite.js";

describe("extractCycleReferencesFromText", () => {
  it("finds Daily Cycle Composite phrasing", () => {
    const refs = extractCycleReferencesFromText(
      "NVDA holding above the Daily Cycle Composite support near 880 while semis consolidate.",
      { ticker: "NVDA" },
    );
    expect(refs.length).toBeGreaterThan(0);
    expect(refs[0].kind).toBe("daily_cycle_composite");
    expect(refs[0].ticker).toBe("NVDA");
  });

  it("finds early/late cycle phase language", () => {
    const refs = extractCycleReferencesFromText("SMH is in an early cycle low setup on the daily.");
    expect(refs.some((r) => r.kind === "cycle_phase" || r.kind === "cycle_inflection")).toBe(true);
    expect(inferFsdCyclePhase(refs)).toBe("early");
  });
});

describe("extractCycleReferencesFromKeyPoints", () => {
  it("pulls macro key points mentioning cycle", () => {
    const refs = extractCycleReferencesFromKeyPoints([
      { ticker: "NVDA", kind: "macro", note: "Daily Cycle Composite turning up from cycle low" },
    ], "NVDA");
    expect(refs.length).toBe(1);
    expect(refs[0].kind).toBe("key_point");
  });
});

describe("cycleAlignment", () => {
  it("marks aligned when early FSD phase meets uptrend", () => {
    expect(cycleAlignment("uptrend", "early")).toBe("aligned");
  });

  it("marks divergent when late FSD phase meets uptrend", () => {
    expect(cycleAlignment("uptrend", "late")).toBe("divergent");
  });
});

describe("buildDailyCycleComposite", () => {
  it("builds index + sector rows from KV regimes", async () => {
    const env = {
      KV_TIMED: {
        get: async (key) => {
          if (key === "timed:ticker-index-map") return JSON.stringify({ map: { NVDA: "QQQ" } });
          if (key.startsWith("timed:latest:")) {
            return JSON.stringify({
              regime_class: "BULL",
              ema_regime_daily: 2,
              htf_score: 18,
              saty_phase_pct: 0.35,
              investor_score: 72,
            });
          }
          return null;
        },
      },
      DB: null,
    };
    const out = await buildDailyCycleComposite(env, { tickers: ["NVDA"] });
    expect(out.ok).toBe(true);
    expect(out.breadth_cycle).toBe("uptrend");
    expect(out.indices.SPY.cycle).toBe("uptrend");
    expect(out.tickers.NVDA.computed.cycle).toBe("uptrend");
    expect(out.sectors.length).toBeGreaterThan(5);
  });
});
