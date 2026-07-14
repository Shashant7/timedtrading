import { describe, it, expect } from "vitest";
import {
  classifyAlignmentBucket,
  resolveBubbleRr,
  resolveBubbleProbability,
  probabilityStrokeStyle,
  resolveBubbleOrigin,
  resolveBubbleForecastTarget,
  ALIGN_FILL,
} from "./bubble-map-encode.js";

describe("bubble map encode", () => {
  it("classifies alignment buckets for fill legend", () => {
    expect(classifyAlignmentBucket("HTF_BULL_LTF_BULL", 20, 15)).toBe("bull_aligned");
    expect(classifyAlignmentBucket("HTF_BULL_LTF_BULL", 20, 4)).toBe("bull_mixed");
    expect(classifyAlignmentBucket("HTF_BULL_LTF_PULLBACK")).toBe("pullback");
    expect(classifyAlignmentBucket("HTF_BULL_LTF_BEAR_PULLBACK")).toBe("pullback");
    expect(classifyAlignmentBucket("HTF_BULL_LTF_NEUTRAL")).toBe("bull_mixed");
    expect(classifyAlignmentBucket("HTF_BEAR_LTF_BEAR", -20, -15)).toBe("bear_aligned");
    expect(classifyAlignmentBucket("HTF_BEAR_LTF_BEAR", -20, -3)).toBe("bear_mixed");
    // Production bounce state — must NOT land in yellow pullback.
    expect(classifyAlignmentBucket("HTF_BEAR_LTF_PULLBACK")).toBe("bear_mixed");
    expect(classifyAlignmentBucket("HTF_BEAR_LTF_BULL_BOUNCE")).toBe("bear_mixed");
    expect(ALIGN_FILL.pullback).toBe("#eab308");
    expect(ALIGN_FILL.bull_aligned).toBe(ALIGN_FILL.bull_mixed);
  });

  it("resolves R:R from price vs tp_exit and SL", () => {
    expect(resolveBubbleRr({ rr: 2.4 })).toBe(2.4);
    expect(resolveBubbleRr({ price: 100, sl: 90, tp_exit: 130 })).toBeCloseTo(3, 5);
  });

  it("maps conviction to stroke tiers (medium inherits none)", () => {
    expect(probabilityStrokeStyle(resolveBubbleProbability({ focus_conviction_score: 25 })).tier).toBe("none");
    expect(probabilityStrokeStyle(resolveBubbleProbability({ focus_conviction_score: 55 })).tier).toBe("none");
    expect(probabilityStrokeStyle(resolveBubbleProbability({ focus_conviction_score: 80 })).tier).toBe("high");
    expect(probabilityStrokeStyle(55).dash).toBeNull();
  });

  it("reads journey origin and markov forecast targets", () => {
    const origin = resolveBubbleOrigin({
      htf_score: 20,
      ltf_score: -10,
      _journey: { recent: [{ htf: 5, ltf: 2 }, { htf: 20, ltf: -10 }] },
    });
    expect(origin).toEqual({ htf: 5, ltf: 2 });

    const fc = resolveBubbleForecastTarget({
      regime_forecast: { p_next: { HTF_BEAR_LTF_BEAR: 0.55, HTF_BULL_LTF_BULL: 0.1 } },
    });
    expect(fc.htf).toBe(-28);
    expect(fc.ltf).toBe(-18);
  });
});
