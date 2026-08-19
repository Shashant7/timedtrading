import { describe, it, expect } from "vitest";
import {
  isHighChopHmm,
  isSpeculativeOrUnknownGrade,
  isFragileChopSetup,
  condenseMtfSequence,
  shouldRejectSpeculativeChop,
  shouldRejectMtfChase,
  applyCioContextVerdict,
} from "./cio-context-gate.js";

const chopHmm = { state: "CHOP", posterior_top: 0.99, confidence_label: "high" };

describe("isHighChopHmm", () => {
  it("accepts CHOP with posterior >= 0.55", () => {
    expect(isHighChopHmm(chopHmm)).toBe(true);
    expect(isHighChopHmm({ state: "CHOP", posterior_top: 0.54 })).toBe(false);
    expect(isHighChopHmm({ state: "BULL_TREND", posterior_top: 0.99 })).toBe(false);
  });
  it("accepts high-confidence CHOP without a numeric posterior", () => {
    expect(isHighChopHmm({ state: "CHOP", confidence_label: "high" })).toBe(true);
  });
});

describe("grade + setup matchers", () => {
  it("treats empty grade as unknown/speculative", () => {
    expect(isSpeculativeOrUnknownGrade("")).toBe(true);
    expect(isSpeculativeOrUnknownGrade("Speculative")).toBe(true);
    expect(isSpeculativeOrUnknownGrade("Prime")).toBe(false);
  });
  it("matches ATH / support / range-reversal family names", () => {
    expect(isFragileChopSetup("TT ATH Breakout")).toBe(true);
    expect(isFragileChopSetup("tt_ath_breakout")).toBe(true);
    expect(isFragileChopSetup("TT Support Bounce")).toBe(true);
    expect(isFragileChopSetup("tt_n_test_support")).toBe(true);
    expect(isFragileChopSetup("TT Range Reversal (Long)")).toBe(true);
    expect(isFragileChopSetup("TT HTF Reclaim")).toBe(false);
  });
});

describe("condenseMtfSequence", () => {
  it("flags 10m trigger opposed on 30m and 1H", () => {
    const seq = condenseMtfSequence({
      tf_tech: {
        "10": { ripster: { c5_12: { bull: true } } },
        "30": { stDir: 1 },
        "1H": { stDir: 1 },
        D: { stDir: -1 },
      },
    }, "LONG");
    expect(seq.trigger_10m).toBe(true);
    expect(seq.htf_opposed).toBe(true);
    expect(seq.aligned_d).toBe(true);
    expect(seq.confirm_count).toBe(1);
  });
  it("counts aligned 30m/1H/D for a clean long", () => {
    const seq = condenseMtfSequence({
      tf_tech: {
        "10": { ripster: { c5_12: { bull: true } } },
        "30": { stDir: -1 },
        "1H": { stDir: -1 },
        D: { stDir: -1 },
      },
    }, "LONG");
    expect(seq.htf_opposed).toBe(false);
    expect(seq.confirm_count).toBe(3);
  });
});

describe("shouldRejectSpeculativeChop", () => {
  it("rejects the HII/GEV/IYT cluster", () => {
    const r = shouldRejectSpeculativeChop({
      direction: "LONG",
      setup: { name: "TT Support Bounce", grade: "Speculative" },
      hmm_regime: chopHmm,
    });
    expect(r.reject).toBe(true);
    expect(r.reason).toBe("speculative_chop_fragile_setup");
  });
  it("does not reject Prime HTF reclaim in CHOP", () => {
    const r = shouldRejectSpeculativeChop({
      direction: "LONG",
      setup: { name: "TT HTF Reclaim", grade: "Prime" },
      hmm_regime: chopHmm,
    });
    expect(r.reject).toBe(false);
  });
  it("does not reject Speculative ATH in BULL_TREND", () => {
    const r = shouldRejectSpeculativeChop({
      direction: "LONG",
      setup: { name: "TT ATH Breakout", grade: "Speculative" },
      hmm_regime: { state: "BULL_TREND", posterior_top: 0.9 },
    });
    expect(r.reject).toBe(false);
  });
});

describe("shouldRejectMtfChase", () => {
  it("rejects a 10m chase opposed on 30m+1H in CHOP", () => {
    const r = shouldRejectMtfChase({
      setup: { name: "TT ATH Breakout", grade: "Speculative" },
      hmm_regime: chopHmm,
      mtf_sequence: { trigger_10m: true, htf_opposed: true, confirm_count: 0 },
    });
    expect(r.reject).toBe(true);
    expect(r.reason).toBe("mtf_10m_chase_htf_opposed");
  });
});

describe("applyCioContextVerdict", () => {
  const proposal = {
    direction: "LONG",
    setup: { name: "TT ATH Breakout", grade: "Speculative" },
    hmm_regime: chopHmm,
  };

  it("upgrades ADJUST to REJECT", () => {
    const out = applyCioContextVerdict(proposal, {
      decision: "ADJUST",
      reasoning: "On-thesis industrials, haircut size.",
      adjustments: { size_mult: 0.75 },
    });
    expect(out.decision).toBe("REJECT");
    expect(out.context_enforced).toBe(true);
    expect(out.adjustments).toBeNull();
    expect(out.risk_flags).toContain("speculative_chop_fragile_setup");
    expect(out.reasoning).toMatch(/context-enforce/);
  });

  it("upgrades APPROVE to REJECT", () => {
    const out = applyCioContextVerdict(proposal, { decision: "APPROVE", reasoning: "ok" });
    expect(out.decision).toBe("REJECT");
  });

  it("leaves an existing REJECT alone", () => {
    const out = applyCioContextVerdict(proposal, {
      decision: "REJECT",
      reasoning: "already no",
    });
    expect(out.decision).toBe("REJECT");
    expect(out.context_enforced).toBeUndefined();
    expect(out.reasoning).toBe("already no");
  });

  it("no-ops when the flag is explicitly false", () => {
    const out = applyCioContextVerdict(proposal, { decision: "ADJUST" }, {
      cio_speculative_chop_reject_enabled: "false",
    });
    expect(out.decision).toBe("ADJUST");
  });

  it("does not touch a Prime reclaim APPROVE", () => {
    const out = applyCioContextVerdict({
      direction: "LONG",
      setup: { name: "TT HTF Reclaim", grade: "Prime" },
      hmm_regime: chopHmm,
    }, { decision: "APPROVE", reasoning: "structure reclaim" });
    expect(out.decision).toBe("APPROVE");
  });
});
