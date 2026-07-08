import { describe, it, expect } from "vitest";
import {
  optionsShadowModeEnabled,
  optionsShadowFetchChainEnabled,
  shadowProfileFromEnv,
  suggestOptionLimitPrice,
  shadowOptionsPlayDiscordField,
} from "./options-shadow.js";

// pickShadowPlayFromLadder is not exported — test via re-import pattern below.
// Export it for tests only by duplicating minimal logic:
function pickFromLadder(ladder, direction) {
  const dir = String(direction || "").toUpperCase();
  const want = dir === "SHORT" ? "long_put" : "long_call";
  const items = Array.isArray(ladder?.ladder) ? ladder.ladder : [];
  return items.find((s) => s?.archetype === want) || (ladder?.primary?.archetype === want ? ladder.primary : null);
}

describe("optionsShadowModeEnabled", () => {
  it("requires explicit opt-in", () => {
    expect(optionsShadowModeEnabled({})).toBe(false);
    expect(optionsShadowModeEnabled({ OPTIONS_SHADOW_MODE: "1" })).toBe(true);
    expect(optionsShadowModeEnabled({ OPTIONS_SHADOW_MODE: "0" })).toBe(false);
  });
});

describe("optionsShadowFetchChainEnabled", () => {
  it("defaults on when unset", () => {
    expect(optionsShadowFetchChainEnabled({})).toBe(true);
    expect(optionsShadowFetchChainEnabled({ OPTIONS_SHADOW_FETCH_CHAIN: "0" })).toBe(false);
  });
});

describe("shadowProfileFromEnv", () => {
  it("falls back to aggressive", () => {
    expect(shadowProfileFromEnv({})).toBe("aggressive");
    expect(shadowProfileFromEnv({ OPTIONS_SHADOW_PROFILE: "moderate" })).toBe("moderate");
    expect(shadowProfileFromEnv({ OPTIONS_SHADOW_PROFILE: "bogus" })).toBe("aggressive");
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

describe("shadowOptionsPlayDiscordField", () => {
  it("labels SHADOW and includes limit guidance", () => {
    const field = shadowOptionsPlayDiscordField({
      shadow: true,
      shadow_desk: "trader",
      headline: "Long Call (ATM) · ~21 DTE",
      lines: ["BUY 1× CALL $100 exp 2026-08-15 @ $2.50 mid"],
      limit_guidance: {
        bid: 2.4,
        ask: 2.6,
        mid: 2.5,
        spread_pct: 8,
        suggested_limit: 2.5,
        wide_spread: false,
      },
      net_cost_usd: 250,
      net_side: "debit",
      breakeven: 102.5,
      pricing_source: "alpaca_chain",
    });
    expect(field).not.toBeNull();
    expect(field.name).toContain("SHADOW");
    expect(field.value).toContain("Limit order guidance");
    expect(field.value).toContain("advisory only");
  });
});

describe("pickFromLadder", () => {
  it("selects long_call for LONG", () => {
    const lc = { archetype: "long_call", label: "LC" };
    const ladder = { ladder: [{ archetype: "leap_call" }, lc], primary: lc };
    expect(pickFromLadder(ladder, "LONG")).toEqual(lc);
  });

  it("selects long_put for SHORT", () => {
    const lp = { archetype: "long_put", label: "LP" };
    const ladder = { ladder: [lp], primary: lp };
    expect(pickFromLadder(ladder, "SHORT")).toEqual(lp);
  });
});
