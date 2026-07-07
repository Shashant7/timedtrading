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
  selectSectorWatchGroups,
  selectSectorWatchFromRotation,
  buildSectorLeaderPool,
  rankSectorLeaders,
  isGicsSectorEtf,
  SECTOR_LEADER_CONFIG,
  buildSectorRotationSnapshot,
  sectorWatchLabel,
  inferCyclicalPhaseLabel,
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

describe("selectSectorWatchFromRotation", () => {
  it("maps rotation gainers and losers to sector leader rows", () => {
    const sectors = [
      { sector: "Financials", etf: "XLF", day_change_pct: 1.1 },
      { sector: "Communication Services", etf: "XLC", day_change_pct: 0.9 },
      { sector: "Utilities", etf: "XLU", day_change_pct: -0.8 },
    ];
    const rot = {
      gainers: [{ etf: "XLF", sector: "Financials", day_pct: 1.1 }, { etf: "XLC", sector: "Communication Services", day_pct: 0.9 }],
      losers: [{ etf: "XLU", sector: "Utilities", day_pct: -0.8 }],
    };
    const picks = selectSectorWatchFromRotation(sectors, rot, { maxGroups: 4 });
    expect(picks.map((p) => p.sectorRow.etf)).toEqual(["XLF", "XLC", "XLU"]);
    expect(picks[0].reason).toBe("leading_today");
    expect(picks[2].reason).toBe("lagging_today");
  });
});

describe("rankSectorLeaders", () => {
  it("ranks by day pct and excludes sector ETF symbols from output", () => {
    const pool = ["JPM", "GS", "XLF", "BAC"];
    const pct = { JPM: 1.2, GS: 0.8, XLF: 1.1, BAC: 0.3 };
    const leaders = rankSectorLeaders(pool.filter((s) => s !== "XLF"), pct, { maxLeaders: 3 });
    expect(leaders).toEqual(["JPM", "GS", "BAC"]);
  });

  it("includes SOXL in semis pool ranking", () => {
    const pool = ["NVDA", "AMD", "SOXL", "SMH"];
    const pct = { NVDA: 2.1, AMD: 1.5, SOXL: 3.2, SMH: 1.0 };
    const leaders = rankSectorLeaders(pool, pct, { maxLeaders: 4 });
    expect(leaders[0]).toBe("SOXL");
    expect(leaders).toContain("NVDA");
  });
});

describe("buildSectorLeaderPool", () => {
  it("merges curated pool with theme members", () => {
    const pool = buildSectorLeaderPool("Financials", SECTOR_LEADER_CONFIG.Financials, {});
    expect(pool).toContain("JPM");
    expect(pool).toContain("SOFI");
    expect(isGicsSectorEtf("XLF")).toBe(true);
    expect(pool).not.toContain("XLF");
  });
});

describe("selectSectorWatchGroups", () => {
  it("surfaces Financials when its cycle diverges from market breadth", () => {
    const sectors = [
      { sector: "Information Technology", etf: "XLK", computed_cycle: "uptrend", alignment: "aligned" },
      { sector: "Financials", etf: "XLF", computed_cycle: "downtrend", alignment: "divergent" },
    ];
    const picks = selectSectorWatchGroups(sectors, "uptrend", new Set());
    expect(picks.some((p) => p.sectorRow.etf === "XLF")).toBe(true);
    expect(sectorWatchLabel("Financials", {})).toBe("Financials leaders");
  });

  it("prioritizes sectors with a fresh cycle shift", () => {
    const sectors = [
      { sector: "Energy", etf: "XLE", computed_cycle: "downtrend", alignment: "mixed" },
      { sector: "Financials", etf: "XLF", computed_cycle: "transitional", alignment: "mixed" },
    ];
    const picks = selectSectorWatchGroups(sectors, "uptrend", new Set(["XLE"]));
    expect(picks[0].sectorRow.etf).toBe("XLE");
    expect(picks[0].reason).toBe("cycle_shift");
  });
});

describe("buildSectorRotationSnapshot", () => {
  it("ranks gainers and losers by day pct", () => {
    const snap = buildSectorRotationSnapshot([
      { sector: "Tech", etf: "XLK", day_change_pct: 1.2, computed_cycle: "uptrend" },
      { sector: "Utilities", etf: "XLU", day_change_pct: -0.8, computed_cycle: "downtrend" },
      { sector: "Financials", etf: "XLF", day_change_pct: 0.4, computed_cycle: "transitional" },
    ]);
    expect(snap.gainers[0].etf).toBe("XLK");
    expect(snap.losers[0].etf).toBe("XLU");
  });
});

describe("inferCyclicalPhaseLabel", () => {
  it("maps phase zone to cyclical language", () => {
    expect(inferCyclicalPhaseLabel(0.82, "distribution")).toBe("Late phase");
    expect(inferCyclicalPhaseLabel(0.15, null)).toBe("Early phase");
  });
});

describe("buildDailyCycleComposite", () => {
  it("builds index + sector rows from KV regimes", async () => {
    const env = {
      KV_TIMED: {
        get: async (key) => {
          if (key === "timed:ticker-index-map") return JSON.stringify({ map: { NVDA: "QQQ" } });
          if (key.startsWith("timed:latest:")) {
            const sym = key.split(":").pop();
            const sectorEtfs = { XLK: 0.5, XLF: 0.4, XLC: 0.3, XLE: -0.2, XLU: -0.3 };
            return JSON.stringify({
              regime_class: "BULL",
              ema_regime_daily: 2,
              htf_score: 18,
              saty_phase_pct: 0.35,
              investor_score: 72,
              day_change_pct: sectorEtfs[sym] ?? 0.1,
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
    expect(out.sector_watch.length).toBeGreaterThan(0);
    expect(out.sector_rotation.gainers).toBeDefined();
    expect(out.spotlights.length).toBeGreaterThan(0);
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
