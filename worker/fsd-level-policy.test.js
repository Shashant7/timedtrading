import { describe, it, expect } from "vitest";
import {
  parseLevelString,
  buildLevelConditionedModes,
  mergeFsdLevelsIntoScenarioLevels,
  mergeFsdLevelPolicyOverlay,
} from "./fsd-level-policy.js";

describe("parseLevelString", () => {
  it("parses single price", () => {
    expect(parseLevelString("880.5")).toEqual({ low: 880.5, high: 880.5, mid: 880.5 });
  });

  it("parses range", () => {
    const r = parseLevelString("341-350");
    expect(r.low).toBe(341);
    expect(r.high).toBe(350);
    expect(r.mid).toBeCloseTo(345.5);
  });
});

describe("buildLevelConditionedModes", () => {
  const levels = [
    { kind: "support", price: 900, low: 900, high: 900 },
    { kind: "resistance", price: 980, low: 980, high: 980 },
  ];

  it("selects defensive below FSD support", () => {
    const modes = buildLevelConditionedModes(levels, 890);
    expect(modes.active_mode).toBe("defensive");
    expect(modes.active_rule.recommend.guard_bundle).toBe("orb_defensive");
  });

  it("selects aggressive above FSD resistance", () => {
    const modes = buildLevelConditionedModes(levels, 990);
    expect(modes.active_mode).toBe("aggressive");
    expect(modes.active_rule.recommend.guard_bundle).toBe("trend_confirmed");
  });

  it("selects neutral between support and resistance", () => {
    const modes = buildLevelConditionedModes(levels, 940);
    expect(modes.active_mode).toBe("neutral");
  });
});

describe("mergeFsdLevelsIntoScenarioLevels", () => {
  it("adds FSD levels with source tag", () => {
    const scenario = {
      price: 925,
      levels: { support: [], resistance: [] },
    };
    const merged = mergeFsdLevelsIntoScenarioLevels(scenario, [
      { kind: "support", price: 900, low: 900, high: 900 },
      { kind: "resistance", price: 980, low: 980, high: 980 },
    ]);
    expect(merged.levels.support.some((l) => l.source === "fsd")).toBe(true);
    expect(merged.levels.resistance.some((l) => l.source === "fsd")).toBe(true);
  });
});

describe("mergeFsdLevelPolicyOverlay", () => {
  it("overlays FSD recommend onto base policy", () => {
    const base = {
      source: "ticker_learning_policy",
      recommend: { guard_bundle: "reclaim_confirmation", entry_engine: "tt_core" },
    };
    const fsd = {
      active_mode: "defensive",
      active_rule: { recommend: { guard_bundle: "orb_defensive", sl_tp_style: "tight_defensive" } },
    };
    const merged = mergeFsdLevelPolicyOverlay(base, fsd);
    expect(merged.recommend.guard_bundle).toBe("orb_defensive");
    expect(merged.recommend.entry_engine).toBe("tt_core");
    expect(merged.source).toContain("fsd_level");
  });
});
