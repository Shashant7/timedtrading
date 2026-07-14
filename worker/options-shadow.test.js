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
import { buildOptionsLadder, lookupLETF } from "./options-plays.js";

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

describe("shadowOptionsPlayDiscordField — expression ladder", () => {
  it("renders shares, LETF, and option tier blocks", () => {
    const field = shadowOptionsPlayDiscordField({
      shadow: true,
      shadow_desk: "trader",
      expressions: [
        {
          expression_key: "shares",
          expression_label: "Conservative",
          headline: "Stock (Long)",
          lines: ["BUY 50 AMD"],
        },
        {
          expression_key: "letf",
          expression_label: "Risk on",
          headline: "AMDL (2× long)",
          lines: ["BUY 120 AMDL"],
          letf_ticker: "AMDL",
          letf_factor: 2,
          underlying: "AMD",
        },
        ...SHADOW_TIER_DEFS.map((d, i) => ({
          expression_key: "options",
          expression_label: "Extra risk on",
          tier_key: d.key,
          tier_label: d.label,
          headline: `Long Call · tier ${i}`,
          lines: [`BUY 1× CALL $100 exp 2026-08-15 @ $2.50 mid`],
          limit_guidance: { suggested_limit: 2.5, spread_pct: 8, wide_spread: false },
          actual_delta: 0.5,
          profile: "speculator",
        })),
      ],
    });
    expect(field).not.toBeNull();
    expect(field.name).toContain("Trade Expression Ladder");
    expect(field.value).toContain("Conservative");
    expect(field.value).toContain("Risk on");
    expect(field.value).toContain("Extra risk on");
    expect(field.value).toContain("Model default");
    expect(field.value).toContain("advisory only");
  });
});

describe("buildShadowOptionsPlayAsync — expression ladder", () => {
  it("returns shares + LETF + ranked option tiers for AMD", async () => {
    const bundle = await buildShadowOptionsPlayAsync({
      ticker: "AMD",
      direction: "LONG",
      price: 150,
      sl: 140,
      tp: 170,
      mode: "trader",
      shares: 40,
      tickerData: { atr_pct: 0.025, confluence: { mode: "RIDE" } },
      env: { OPTIONS_SHADOW_MODE: "1", OPTIONS_SHADOW_FETCH_CHAIN: "0" },
    });
    expect(bundle).not.toBeNull();
    expect(bundle.shadow_ladder).toBe(true);
    expect(bundle.expressions.length).toBeGreaterThanOrEqual(3);
    expect(bundle.expressions[0].expression_key).toBe("shares");
    expect(bundle.expressions[0].lines[0]).toContain("40");
    const letf = bundle.expressions.find((e) => e.expression_key === "letf");
    expect(letf).toBeTruthy();
    expect(letf.letf_ticker).toBe("AMDL");
    const opts = bundle.expressions.filter((e) => e.expression_key === "options");
    expect(opts.length).toBeGreaterThanOrEqual(1);
    expect(opts[0].tier_key).toBe("default");
  });

  it("maps LLY to LLYX leveraged ETF", async () => {
    const bundle = await buildShadowOptionsPlayAsync({
      ticker: "LLY",
      direction: "LONG",
      price: 800,
      sl: 760,
      tp: 880,
      mode: "trader",
      shares: 10,
      tickerData: { atr_pct: 0.02, confluence: { mode: "READY" } },
      env: { OPTIONS_SHADOW_MODE: "1", OPTIONS_SHADOW_FETCH_CHAIN: "0" },
    });
    const letf = bundle?.expressions?.find((e) => e.expression_key === "letf");
    expect(letf?.letf_ticker).toBe("LLYX");
  });
});

describe("lookupLETF — single-name mappings", () => {
  it("maps AMD to AMDL and LLY to LLYX", () => {
    expect(lookupLETF("AMD")?.long).toBe("AMDL");
    expect(lookupLETF("LLY")?.long).toBe("LLYX");
    expect(lookupLETF("NVDA")?.long).toBe("NVDU");
    expect(lookupLETF("NVDA")?.short).toBe("NVDD");
  });

  it("maps AEHR to AEHG (2× Leverage Shares)", () => {
    expect(lookupLETF("AEHR")?.long).toBe("AEHG");
    expect(lookupLETF("AEHR")?.factor).toBe(2);
    expect(lookupLETF("aehr")?.long).toBe("AEHG");
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
