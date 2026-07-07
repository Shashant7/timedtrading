import { describe, it, expect } from "vitest";
import {
  extractCycleReferencesFromText,
  extractCycleReferencesFromKeyPoints,
  inferFsdCyclePhase,
  cycleAlignment,
  buildDailyCycleComposite,
  resolveComputedCycle,
  detectCycleTransitions,
  summarizeIndexMix,
} from "./daily-cycle-composite.js";
import { indexCyclesFromRegimes } from "./market-regime-index.js";

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

describe("resolveComputedCycle", () => {
  it("prefers the symbol's own EMA/HTF regime over breadth fallback", () => {
    const regimes = {
      SMH: { ema_regime_daily: -3, htf_score: -20 },
      SPY: { ema_regime_daily: 2, htf_score: 18 },
    };
    const cycles = indexCyclesFromRegimes(regimes);
    const r = resolveComputedCycle("SMH", regimes, {}, cycles, "uptrend");
    expect(r.own_cycle).toBe("downtrend");
    expect(r.computed_cycle).toBe("downtrend");
    expect(r.cycle_source).toBe("own_regime");
  });
});

describe("detectCycleTransitions", () => {
  it("flags spotlight and market transitions", () => {
    const prev = {
      breadth_cycle: "uptrend",
      sectors: [{ etf: "XLK", computed_cycle: "uptrend" }],
      spotlights: [{ symbol: "SMH", computed_cycle: "uptrend" }],
    };
    const built = {
      generated_at: new Date().toISOString(),
      breadth_cycle: "transitional",
      sectors: [{ etf: "XLK", computed_cycle: "downtrend" }],
      spotlights: [{ symbol: "SMH", computed_cycle: "downtrend" }],
    };
    const t = detectCycleTransitions(prev, built);
    expect(t.some((x) => x.symbol === "SMH" && x.to === "downtrend")).toBe(true);
    expect(t.some((x) => x.symbol === "MARKET")).toBe(true);
  });
});

describe("summarizeIndexMix", () => {
  it("counts per-index cycle labels", () => {
    expect(summarizeIndexMix({ SPY: "uptrend", QQQ: "uptrend", IWM: "downtrend" }))
      .toEqual({ uptrend: 2, downtrend: 1, transitional: 0 });
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
    expect(out.spotlights.map((s) => s.symbol)).toEqual(["SMH", "NVDA"]);
    const xlv = out.sectors.filter((s) => s.etf === "XLV");
    expect(xlv.length).toBe(1);
  });

  it("uses sector ETF own regime when it diverges from market breadth", async () => {
    const env = {
      KV_TIMED: {
        get: async (key) => {
          if (key === "timed:ticker-index-map") return JSON.stringify({ map: {} });
          if (key === "timed:latest:XLK") {
            return JSON.stringify({ ema_regime_daily: -3, htf_score: -18, regime_class: "BEAR" });
          }
          if (key.startsWith("timed:latest:")) {
            return JSON.stringify({ ema_regime_daily: 2, htf_score: 18, regime_class: "BULL" });
          }
          return null;
        },
      },
      DB: null,
    };
    const out = await buildDailyCycleComposite(env, { tickers: [] });
    const xlk = out.sectors.find((s) => s.etf === "XLK");
    expect(xlk.computed_cycle).toBe("downtrend");
    expect(xlk.own_cycle).toBe("downtrend");
  });
});
