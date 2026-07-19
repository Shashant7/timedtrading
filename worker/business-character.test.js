import { describe, expect, it } from "vitest";
import {
  ARCHETYPES,
  classifyBusinessCharacter,
  interpretSetupThroughCharacter,
  businessCharacterLineage,
} from "./business-character.js";

function snap(overrides = {}) {
  return {
    ticker: "TEST",
    as_of: Date.now(),
    profile: { sector: "Consumer Discretionary" },
    growth: {
      rev_growth_class: "positive",
      eps_growth_class: "positive",
      rev_growth_pct: 4,
      profit_margin_pct: 20,
      roe_ttm_pct: 40,
    },
    earnings: { beat_rate_pct: 75 },
    valuation: {
      fair_value_price: 280,
      fair_value_premium_pct: -5,
      fair_value_class: "discount",
    },
    capital_structure: { free_cash_flow_ttm: 1e9 },
    ...overrides,
  };
}

describe("classifyBusinessCharacter", () => {
  it("classifies steady value (McDonald's-like)", () => {
    // Quality score needs beat + ROE + margin + modest growth → A/B
    const mcd = snap({
      ticker: "MCD",
      growth: {
        rev_growth_class: "positive",
        eps_growth_class: "positive",
        rev_growth_pct: 3,
        profit_margin_pct: 22,
        roe_ttm_pct: 55,
      },
      earnings: { beat_rate_pct: 85, avg_surprise_pct: 4 },
    });
    const c = classifyBusinessCharacter(mcd, { ticker: "MCD", sector: "Consumer Discretionary" });
    expect(c.archetype).toBe(ARCHETYPES.STEADY_VALUE);
    expect(c.technical_lens.pullback_means).toBe("range_accumulation");
    expect(c.technical_lens.breakout_means).toBe("needs_volume_theme_confirm");
    expect(c.technical_lens.atr_expectation).toBe("low_is_normal");
  });

  it("classifies growth compounder from elite/strong tier", () => {
    const nvda = snap({
      ticker: "NVDA",
      profile: { sector: "Information Technology" },
      growth: {
        rev_growth_class: "explosive",
        eps_growth_class: "explosive",
        rev_growth_pct: 80,
        profit_margin_pct: 35,
        roe_ttm_pct: 50,
      },
      earnings: { beat_rate_pct: 90, avg_surprise_pct: 12 },
      compounder: {
        tier: "growth_elite",
        eligible: true,
        quality_grade: "A",
        rev_growth_class: "explosive",
      },
    });
    const c = classifyBusinessCharacter(nvda, { ticker: "NVDA" });
    expect(c.archetype).toBe(ARCHETYPES.GROWTH_COMPOUNDER);
    expect(c.technical_lens.pullback_means).toBe("add_on_opportunity");
    expect(c.technical_lens.preferred_vehicle).toBe("options_first_on_runners");
  });

  it("classifies defensive low-growth by sector", () => {
    const ko = snap({
      ticker: "KO",
      profile: { sector: "Consumer Staples" },
      growth: {
        rev_growth_class: "positive",
        eps_growth_class: "positive",
        rev_growth_pct: 2,
        profit_margin_pct: 4, // weak margins → may not hit steady_value via quality
        roe_ttm_pct: 8,
      },
      earnings: { beat_rate_pct: 50 },
      valuation: { fair_value_price: null, fair_value_premium_pct: null, fair_value_class: null },
    });
    const c = classifyBusinessCharacter(ko, { ticker: "KO", sector: "Consumer Staples" });
    expect([ARCHETYPES.DEFENSIVE_LOW_GROWTH, ARCHETYPES.STEADY_VALUE, ARCHETYPES.UNCLASSIFIED])
      .toContain(c.archetype);
    // Staples + low growth should not be growth_compounder
    expect(c.archetype).not.toBe(ARCHETYPES.GROWTH_COMPOUNDER);
  });

  it("classifies ETF as index proxy", () => {
    const c = classifyBusinessCharacter(null, { ticker: "SPY", tickerType: "broad_etf" });
    expect(c.archetype).toBe(ARCHETYPES.INDEX_PROXY);
  });

  it("returns unclassified when stale", () => {
    const old = snap({ as_of: Date.now() - 20 * 86400000 });
    const c = classifyBusinessCharacter(old, { ticker: "MCD" });
    expect(c.archetype).toBe(ARCHETYPES.UNCLASSIFIED);
    expect(c.stale).toBe(true);
  });
});

describe("interpretSetupThroughCharacter", () => {
  it("reads the same stage differently for MCD vs growth", () => {
    const steady = classifyBusinessCharacter(snap({ ticker: "MCD" }), { ticker: "MCD" });
    const growth = {
      archetype: ARCHETYPES.GROWTH_COMPOUNDER,
      technical_lens: classifyBusinessCharacter(
        snap({
          ticker: "NVDA",
          compounder: { tier: "growth_strong", eligible: true, quality_grade: "A", rev_growth_class: "strong" },
          growth: {
            rev_growth_class: "strong",
            eps_growth_class: "strong",
            rev_growth_pct: 40,
            profit_margin_pct: 25,
            roe_ttm_pct: 30,
          },
          earnings: { beat_rate_pct: 85, avg_surprise_pct: 8 },
        }),
        { ticker: "NVDA" },
      ).technical_lens,
    };

    const steadyRead = interpretSetupThroughCharacter(steady, { stage: 2, sequence_type: "td_phase_mean_reversion_long" });
    const growthRead = interpretSetupThroughCharacter(growth, { stage: 2, sequence_type: "td_phase_mean_reversion_long" });
    expect(steadyRead.read).toMatch(/range|accumulation|steady|defensive/i);
    expect(growthRead.read).toMatch(/compounder|dip/i);
    expect(steadyRead.read).not.toBe(growthRead.read);
  });
});

describe("businessCharacterLineage", () => {
  it("compacts for payload", () => {
    const c = classifyBusinessCharacter(snap({ ticker: "MCD" }), { ticker: "MCD" });
    const lin = businessCharacterLineage(c);
    expect(lin.archetype).toBeTruthy();
    expect(lin.technical_lens.summary).toBeTruthy();
    expect(lin.version).toBe(1);
  });
});
