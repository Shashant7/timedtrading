import { describe, it, expect } from "vitest";
import { assessRunnerTopFormation } from "../worker/runner-top-formation.js";

function baseSndkLikeInputs(overrides = {}) {
  return {
    openTrade: {
      trimmedPct: 0.5,
      entryPrice: 1346,
      maxFavorableExcursion: 35,
    },
    execState: { runnerPeakPrice: 2320 },
    entryPx: 1346,
    pxNow: 2050,
    direction: "LONG",
    tickerData: {
      rsi_divergence: { "1H": { bear: { active: true, strength: 3 } } },
      td_sequential: { per_tf: { "1H": { bearish_prep_count: 8, td9_bearish: false } } },
      tf_tech: {
        "1H": {
          ripster: { c5_12: { crossDn: true, bear: true, below: true } },
          ema: { ema21: 2080 },
        },
      },
    },
    ...overrides,
  };
}

describe("assessRunnerTopFormation", () => {
  it("fires trim on 1H confluence (SNDK-like: bear div + TD prep + 5/12 cloud + 21 EMA break + lower high)", () => {
    const plan = assessRunnerTopFormation(baseSndkLikeInputs());
    expect(plan).not.toBeNull();
    expect(plan.action).toBe("trim");
    expect(plan.confluence).toBeGreaterThanOrEqual(4);
    expect(plan.signals).toContain("1h_bear_divergence");
    expect(plan.signals).toContain("1h_5_12_cloud_break");
    expect(plan.signals).toContain("1h_21ema_break");
    expect(plan.newTargetTrimPct).toBeGreaterThanOrEqual(0.85);
  });

  it("closes remainder when already >= closeAtTrimmedPct", () => {
    const opts = baseSndkLikeInputs();
    opts.openTrade = { ...opts.openTrade, trimmedPct: 0.85 };
    const plan = assessRunnerTopFormation(opts);
    expect(plan).not.toBeNull();
    expect(plan.action).toBe("close");
    expect(plan.newTargetTrimPct).toBeNull();
  });

  it("holds when only one signal fires (no confluence)", () => {
    const plan = assessRunnerTopFormation(baseSndkLikeInputs({
      tickerData: {
        rsi_divergence: { "1H": { bear: { active: true, strength: 3 } } },
        td_sequential: { per_tf: { "1H": { bearish_prep_count: 3 } } },
        tf_tech: { "1H": { ripster: { c5_12: { bull: true, above: true } }, ema: { ema21: 1000 } } },
      },
      execState: { runnerPeakPrice: 2060 }, // no meaningful peak drop
      pxNow: 2050,
    }));
    expect(plan?.action).toBe("hold");
    expect(plan?.confluence).toBeLessThan(2);
  });

  it("returns null when trade is not trimmed", () => {
    const opts = baseSndkLikeInputs();
    opts.openTrade = { ...opts.openTrade, trimmedPct: 0 };
    expect(assessRunnerTopFormation(opts)).toBeNull();
  });

  it("returns null when MFE has not run enough", () => {
    const opts = baseSndkLikeInputs();
    opts.openTrade = { ...opts.openTrade, maxFavorableExcursion: 1.5 };
    expect(assessRunnerTopFormation(opts)).toBeNull();
  });

  it("returns null when trade is red", () => {
    const opts = baseSndkLikeInputs();
    opts.pxNow = 1300;
    expect(assessRunnerTopFormation(opts)).toBeNull();
  });

  it("counts TD9 bearish setup as an exhaustion signal", () => {
    const opts = baseSndkLikeInputs();
    opts.tickerData = {
      ...opts.tickerData,
      td_sequential: { per_tf: { "1H": { bearish_prep_count: 0, td9_bearish: true } } },
    };
    const plan = assessRunnerTopFormation(opts);
    expect(plan?.signals).toContain("1h_td9_sell_setup");
  });

  it("mirrors logic for SHORT direction (bullish exhaustion)", () => {
    const plan = assessRunnerTopFormation({
      openTrade: { trimmedPct: 0.5, entryPrice: 100, maxFavorableExcursion: 20 },
      execState: { runnerPeakPrice: 78 },
      entryPx: 100,
      pxNow: 84,
      direction: "SHORT",
      tickerData: {
        rsi_divergence: { "1H": { bull: { active: true, strength: 3 } } },
        td_sequential: { per_tf: { "1H": { bullish_prep_count: 8 } } },
        tf_tech: {
          "1H": {
            ripster: { c5_12: { crossUp: true, bull: true, above: true } },
            ema: { ema21: 82 },
          },
        },
      },
    });
    expect(plan?.action).toBe("trim");
    expect(plan.signals).toContain("1h_bear_divergence");
  });
});
