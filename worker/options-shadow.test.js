import { describe, it, expect } from "vitest";
import {
  optionsShadowModeEnabled,
  optionsShadowFetchChainEnabled,
  modelOptionsProfile,
  modelTargetDelta,
  suggestOptionLimitPrice,
  shadowOptionsPlayDiscordField,
  SHADOW_TIER_DEFS,
  buildShadowOptionsPlayAsync,
} from "./options-shadow.js";
import { buildOptionsLadder } from "./options-plays.js";

describe("optionsShadowModeEnabled", () => {
  it("requires explicit opt-in", () => {
    expect(optionsShadowModeEnabled({})).toBe(false);
    expect(optionsShadowModeEnabled({ OPTIONS_SHADOW_MODE: "1" })).toBe(true);
    expect(optionsShadowModeEnabled({ OPTIONS_SHADOW_MODE: "0" })).toBe(false);
  });
});

describe("modelOptionsProfile", () => {
  it("matches buildEntryOptionsPlay defaults", () => {
    expect(modelOptionsProfile({}, "trader")).toBe("speculator");
    expect(modelOptionsProfile({}, "investor")).toBe("moderate");
    expect(modelOptionsProfile({ OPTIONS_DEFAULT_PROFILE: "aggressive" }, "trader")).toBe("aggressive");
  });
});

describe("modelTargetDelta", () => {
  it("elevates delta on RIDE + speculator", () => {
    expect(modelTargetDelta({
      profile: "speculator",
      confluence: { mode: "RIDE" },
      ticker: "NVDA",
      isInvestor: false,
    })).toBe(0.70);
  });
});

describe("suggestOptionLimitPrice", () => {
  it("uses mid on tight spreads", () => {
    const r = suggestOptionLimitPrice({ bid: 1.04, ask: 1.06, mid: 1.05, action: "BUY" });
    expect(r.suggested_limit).toBe(1.05);
    expect(r.wide_spread).toBe(false);
  });

  it("anchors below mid on wide spreads for buys", () => {
    const r = suggestOptionLimitPrice({ bid: 1.0, ask: 2.0, mid: 1.5, action: "BUY" });
    expect(r.wide_spread).toBe(true);
    expect(r.suggested_limit).toBe(1.25);
  });
});

describe("shadowOptionsPlayDiscordField — ranked tiers", () => {
  it("renders three tier blocks", () => {
    const field = shadowOptionsPlayDiscordField({
      shadow: true,
      shadow_desk: "trader",
      tiers: SHADOW_TIER_DEFS.map((d, i) => ({
        tier_key: d.key,
        tier_label: d.label,
        headline: `Long Call · tier ${i}`,
        lines: [`BUY 1× CALL $100 exp 2026-08-15 @ $2.50 mid`],
        limit_guidance: { suggested_limit: 2.5, spread_pct: 8, wide_spread: false },
        actual_delta: 0.5,
        profile: "speculator",
      })),
    });
    expect(field).not.toBeNull();
    expect(field.name).toContain("3 ranked");
    expect(field.value).toContain("Model default");
    expect(field.value).toContain("Looser");
    expect(field.value).toContain("Loosest valid");
    expect(field.value).toContain("advisory only");
  });
});

describe("buildShadowOptionsPlayAsync — tier bundle", () => {
  it("returns ranked tiers when shadow mode on", async () => {
    const bundle = await buildShadowOptionsPlayAsync({
      ticker: "AAPL",
      direction: "LONG",
      price: 200,
      sl: 190,
      tp: 220,
      mode: "trader",
      tickerData: { atr_pct: 0.025, confluence: { mode: "RIDE" } },
      env: { OPTIONS_SHADOW_MODE: "1", OPTIONS_SHADOW_FETCH_CHAIN: "0" },
    });
    expect(bundle).not.toBeNull();
    expect(bundle.shadow_ranked).toBe(true);
    expect(bundle.tiers.length).toBeGreaterThanOrEqual(1);
    expect(bundle.tiers[0].tier_key).toBe("default");
  });
});

describe("ladder long_call available for shadow tiers", () => {
  it("buildOptionsLadder includes long_call for LONG", () => {
    const ladder = buildOptionsLadder({
      ticker: "AAPL",
      direction: "LONG",
      price: 200,
      sl: 190,
      tp: 220,
      atr_pct: 0.025,
      mode: "trader",
      stage: "swing",
    }, { profile: "speculator" });
    const hasLc = ladder.ladder.some((s) => s.archetype === "long_call");
    expect(hasLc).toBe(true);
  });
});
