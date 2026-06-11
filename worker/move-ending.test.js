// worker/move-ending.test.js — pins the B4 exit-excellence semantics.

import { describe, it, expect } from "vitest";
import {
  computeMoveEndingSignal,
  computeTrimLadder,
  buildPositionGuidance,
} from "./move-ending.js";

function lateMovePayload() {
  return {
    ticker: "NVDA",
    price: 150,
    completion: 0.88,
    state: "HTF_BULL_LTF_BULL",
    phase_pct: 95,
    regime_forecast: { p_5_bar: { HTF_BULL_LTF_BULL: 0.3 } },
    regime_exhausted: { sigma_above_mean: 2.4 },
    td_sequential: { per_tf: { D: { bearish_prep_count: 9, bullish_prep_count: 0 } } },
    entry_quality: { details: { rsi1H: 78 } },
    tf_tech: {
      D: { rsi: 76, volRatio: 0.6 },
      30: { stDir: 1, stSlope: -0.2 },
      60: { stDir: 1, stSlope: -0.1 },
    },
    tp_trim: 152, tp_exit: 158, tp_runner: 165, sl: 141,
  };
}

describe("computeMoveEndingSignal", () => {
  it("stacks evidence on a late, exhausted LONG into an EXIT-level signal", () => {
    const sig = computeMoveEndingSignal(lateMovePayload(), { direction: "LONG" });
    expect(sig.level).toBe("EXIT");
    expect(sig.score).toBeGreaterThanOrEqual(60);
    expect(sig.evidence.length).toBeGreaterThanOrEqual(5);
  });

  it("is quiet on a fresh aligned move", () => {
    const sig = computeMoveEndingSignal({
      ticker: "MU",
      completion: 0.2,
      state: "HTF_BULL_LTF_BULL",
      phase_pct: 30,
      regime_forecast: { p_5_bar: { HTF_BULL_LTF_BULL: 0.8 } },
      tf_tech: { D: { rsi: 58, volRatio: 1.4 }, 30: { stDir: 1, stSlope: 0.3 }, 60: { stDir: 1, stSlope: 0.2 } },
      entry_quality: { details: { rsi1H: 55 } },
    }, { direction: "LONG" });
    expect(sig.level).toBe("NONE");
    expect(sig.score).toBeLessThan(25);
  });

  it("direction-awareness: the same exhaustion evidence reads differently for SHORT", () => {
    const payload = lateMovePayload();
    // For a SHORT, bearish TD prep + high RSI are NOT against the position.
    const sig = computeMoveEndingSignal(payload, { direction: "SHORT" });
    const long = computeMoveEndingSignal(payload, { direction: "LONG" });
    expect(sig.score).toBeLessThan(long.score);
  });
});

describe("computeTrimLadder", () => {
  it("builds the ladder against ATR-fib targets with next-level distance", () => {
    const ladder = computeTrimLadder(lateMovePayload(), {
      direction: "LONG", entryPrice: 140, trimmedPct: 0.33,
    });
    expect(ladder.levels).toHaveLength(3);
    expect(ladder.levels[0].name).toBe("TRIM_1");
    expect(ladder.trimmed_pct).toBe(33);
    expect(ladder.sl).toBe(141);
    // price 150 < tp_trim 152 → first level still ahead
    expect(ladder.next.name).toBe("TRIM_1");
    expect(ladder.next.distance_pct).toBeCloseTo(1.3, 1);
  });

  it("marks reached levels for SHORT direction correctly", () => {
    const ladder = computeTrimLadder(
      { price: 90, tp_trim: 95, tp_exit: 88, tp_runner: 80, sl: 105 },
      { direction: "SHORT", entryPrice: 100 },
    );
    const byName = Object.fromEntries(ladder.levels.map((l) => [l.name, l.status]));
    expect(byName.TRIM_1).toBe("reached"); // 90 <= 95
    expect(byName.TRIM_2).toBe("ahead");   // 90 > 88
  });

  it("returns null without targets", () => {
    expect(computeTrimLadder({ price: 100 }, { direction: "LONG" })).toBeNull();
  });
});

describe("buildPositionGuidance", () => {
  it("composes compliant plain-language guidance (no you/your)", () => {
    const g = buildPositionGuidance(lateMovePayload(), {
      direction: "LONG", entryPrice: 140, trimmedPct: 0.33, ticker: "NVDA",
    });
    expect(g.ticker).toBe("NVDA");
    expect(g.where).toContain("move-ending signal: EXIT");
    expect(g.plan).toContain("TRIM_1");
    expect(g.what_changes_the_call.length).toBeGreaterThan(0);
    const text = JSON.stringify(g).toLowerCase();
    expect(text.includes("you ") || text.includes("your ")).toBe(false);
  });
});
