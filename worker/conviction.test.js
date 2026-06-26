import { describe, it, expect } from "vitest";
import {
  fuseConviction,
  ema21StructureHolds,
  mrSequenceOpposed,
  resolveDirection,
  FUSION_DEFAULTS,
} from "./conviction.js";

describe("resolveDirection", () => {
  it("prefers explicit, falls back to state", () => {
    expect(resolveDirection({ state: "HTF_BEAR_LTF_PULLBACK" }, { direction: "LONG" })).toBe("LONG");
    expect(resolveDirection({ state: "HTF_BULL_LTF_PULLBACK" })).toBe("LONG");
    expect(resolveDirection({ trigger_dir: "SHORT" })).toBe("SHORT");
  });
});

describe("ema21StructureHolds (the MU bounce pattern)", () => {
  it("true for a LONG reclaiming/holding daily EMA21 in an uptrend", () => {
    expect(ema21StructureHolds({ above_e200: true, bull_stack: true, pct_above_e21: 1.2 }, "LONG")).toBe(true);
  });
  it("false when overextended above EMA21", () => {
    expect(ema21StructureHolds({ above_e200: true, bull_stack: true, pct_above_e21: 9 }, "LONG")).toBe(false);
  });
});

describe("mrSequenceOpposed (wrong-way veto-context)", () => {
  it("flags an MR-long forming while we are SHORT", () => {
    expect(mrSequenceOpposed([{ direction: "LONG", stage: 3, status: "forming" }], "SHORT")).toBe(true);
  });
  it("does not flag an aligned sequence", () => {
    expect(mrSequenceOpposed([{ direction: "LONG", stage: 3, status: "forming" }], "LONG")).toBe(false);
  });
});

describe("fuseConviction", () => {
  it("confirm-stack + EMA21 hold + strong focus => Tier A, size up", () => {
    const r = fuseConviction({
      __focus_conviction_score: 78,
      state: "HTF_BULL_LTF_PULLBACK",
      daily_structure: { above_e200: true, bull_stack: true, pct_above_e21: 1.0 },
      setup_gates: { stack_full_confirm: { fires: true } },
    }, { direction: "LONG" });
    expect(r.tier).toBe("A");
    expect(r.sizeMult).toBeCloseTo(FUSION_DEFAULTS.sizeMultA, 5);
    expect(r.reasons).toContain("stack_full_confirm");
    expect(r.rankBoost).toBeGreaterThan(0);
  });

  it("raw ST flip alone (no confirm stack) gets no edge boost — not fooled by noise", () => {
    const noGate = fuseConviction({ __focus_conviction_score: 55, state: "HTF_BULL_LTF_PULLBACK" }, { direction: "LONG" });
    const withStack = fuseConviction({
      __focus_conviction_score: 55, state: "HTF_BULL_LTF_PULLBACK",
      setup_gates: { stack_full_confirm: { fires: true } },
    }, { direction: "LONG" });
    expect(withStack.score).toBeGreaterThan(noGate.score);
  });

  it("MR sequence opposed to direction penalizes and can veto", () => {
    const r = fuseConviction({
      __focus_conviction_score: 45,
      trigger_dir: "SHORT",
      setup_sequences: [{ direction: "LONG", stage: 3, status: "forming" }],
    }, { direction: "SHORT" });
    expect(r.components.mrOppose).toBe(true);
    expect(r.veto).toBe(true);
  });

  it("degrades gracefully with no signals present (neutral Tier B/C, neutral size)", () => {
    const r = fuseConviction({}, {});
    expect(["B", "C"]).toContain(r.tier);
    expect(r.sizeMult).toBeGreaterThan(0);
    expect(r.version).toBe(1);
  });

  it("the raw MR sequence does NOT create a positive boost (discipline)", () => {
    const aligned = fuseConviction({
      __focus_conviction_score: 60, trigger_dir: "LONG",
      setup_sequences: [{ direction: "LONG", stage: 3, status: "forming" }],
    }, { direction: "LONG" });
    const none = fuseConviction({ __focus_conviction_score: 60, trigger_dir: "LONG" }, { direction: "LONG" });
    expect(aligned.score).toBe(none.score); // aligned MR adds nothing
  });
});
