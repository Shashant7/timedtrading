import { describe, it, expect } from "vitest";
import {
  resolveLtfForming,
  resolveHtfForming,
  resolveFormingPair,
  formingPairExemptsHtfColorVeto,
  formingPairEnabled,
  formingPairEntryEnabled,
  formingPairFloorsEnabled,
  isFormingPairFloorContext,
  applyFormingPairConvictionCarveout,
} from "./mtf-forming.js";
import { inferSide } from "./pipeline/trade-context.js";

function tf({ stDir, stSlope = 0, struct = 0, rsi, cloud }) {
  return {
    stDir,
    stSlope,
    ema: { structure: struct },
    rsi: rsi != null ? { r5: rsi } : undefined,
    ripster: cloud ? { c5_12: cloud } : undefined,
  };
}

// TSLA Aug 13: LTF already long, HTF score still red, 4H ST bull,
// daily 21 just reclaimed, daily ST still the bear magnet.
function tslaAug13() {
  return {
    ticker: "TSLA",
    state: "HTF_BEAR_LTF_PULLBACK",
    htf_score: -9.6,
    ltf_score: 13.3,
    daily_structure: { pct_above_e21: 0.35, e21_slope_5d_pct: 0.2, days_above_e21: 1 },
    tf_tech: {
      "10": tf({ stDir: -1, stSlope: 1, struct: 0.4, cloud: { bull: true, above: true, fastSlope: 1 } }),
      "30": tf({ stDir: -1, stSlope: 1, struct: 0.2 }),
      "1H": tf({ stDir: -1, stSlope: 0, struct: 0.1 }),
      "4H": tf({ stDir: -1, stSlope: 1, struct: 0.3 }),
      D: tf({ stDir: 1, stSlope: 0, struct: -0.1 }),
      W: tf({ stDir: 1, stSlope: 0, struct: -0.2 }),
      M: tf({ stDir: 1, stSlope: 0 }),
    },
  };
}

// AAPL June dump after the ATH chase: HTF still green, LTF broken.
function aaplJuneDump() {
  return {
    ticker: "AAPL",
    state: "HTF_BULL_LTF_PULLBACK",
    htf_score: 14.4,
    ltf_score: -16.7,
    daily_structure: { pct_above_e21: -1.8, e21_slope_5d_pct: -0.8, days_above_e21: 0 },
    tf_tech: {
      "10": tf({ stDir: 1, stSlope: -1, struct: -0.6 }),
      "15": tf({ stDir: 1, stSlope: -1, struct: -1, rsi: 40 }),
      "30": tf({ stDir: 1, stSlope: -1, struct: -1, rsi: 38 }),
      "1H": tf({ stDir: 1, stSlope: -1, struct: -0.4 }),
      "4H": tf({ stDir: -1, stSlope: 0, struct: 0.2 }),
      D: tf({ stDir: -1, stSlope: 0, struct: 0.1 }),
      W: tf({ stDir: -1, stSlope: 1 }),
    },
  };
}

// Valid AAPL long (not the June dump): HTF formed, LTF constructing.
function aaplValidLong() {
  return {
    ticker: "AAPL",
    state: "HTF_BULL_LTF_BULL",
    htf_score: 12,
    ltf_score: 8,
    daily_structure: { pct_above_e21: 1.1, e21_slope_5d_pct: 0.4, days_above_e21: 3 },
    tf_tech: {
      "10": tf({ stDir: -1, stSlope: 1, struct: 0.4, cloud: { bull: true, above: true, fastSlope: 1 } }),
      "30": tf({ stDir: -1, stSlope: 1, struct: 0.3 }),
      "1H": tf({ stDir: -1, struct: 0.2 }),
      "4H": tf({ stDir: -1, stSlope: 1, struct: 0.3 }),
      D: tf({ stDir: -1, stSlope: 1, struct: 0.4 }),
      W: tf({ stDir: -1, stSlope: 1 }),
    },
  };
}

// TEAM Jul 8 last-gasp bear print — complementary SHORT, must NOT get
// the LONG floor carve-out (that fade is the start of the +94% rip).
function teamJul8BearFade() {
  return {
    ticker: "TEAM",
    state: "HTF_BEAR_LTF_BEAR",
    htf_score: -12,
    ltf_score: -10,
    daily_structure: { pct_above_e21: -1.2, e21_slope_5d_pct: -0.4, days_above_e21: 0 },
    tf_tech: {
      "10": tf({ stDir: 1, stSlope: -1, struct: -0.5 }),
      "30": tf({ stDir: 1, stSlope: -1, struct: -0.4 }),
      "1H": tf({ stDir: 1, struct: -0.3 }),
      "4H": tf({ stDir: 1, stSlope: -1, struct: -0.4 }),
      D: tf({ stDir: 1, stSlope: -1, struct: -0.5 }),
      W: tf({ stDir: 1, stSlope: -1 }),
    },
  };
}

// TEAM Jul rip: HTF already formed, LTF constructing the next leg.
function teamJulRip() {
  return {
    ticker: "TEAM",
    state: "HTF_BULL_LTF_BULL",
    htf_score: 16.3,
    ltf_score: 16.3,
    daily_structure: { pct_above_e21: 1.8, e21_slope_5d_pct: 1.1, days_above_e21: 4 },
    tf_tech: {
      "10": tf({ stDir: -1, stSlope: 1, struct: 0.5, cloud: { bull: true, above: true, fastSlope: 1 } }),
      "30": tf({ stDir: -1, stSlope: 1, struct: 0.4 }),
      "1H": tf({ stDir: -1, stSlope: 1, struct: 0.3 }),
      "4H": tf({ stDir: -1, stSlope: 1, struct: 0.4 }),
      D: tf({ stDir: -1, stSlope: 1, struct: 0.5 }),
      W: tf({ stDir: -1, stSlope: 1 }),
    },
  };
}

describe("resolveLtfForming / resolveHtfForming", () => {
  it("TSLA Aug 13: LTF forming long, HTF forming (slow turn) not formed", () => {
    const t = tslaAug13();
    const ltf = resolveLtfForming(t, "LONG");
    const htf = resolveHtfForming(t, "LONG");
    expect(ltf.forming).toBe(true);
    expect(htf.forming).toBe(true);
    expect(htf.formed).toBe(false);
    expect(htf.wm_against).toBe(false);
    expect(htf.cues).toContain("4h_st");
    expect(htf.cues).toContain("d21_reclaim_or_hold");
  });

  it("AAPL June dump: LTF not forming (broken 15m+30m)", () => {
    const t = aaplJuneDump();
    expect(resolveLtfForming(t, "LONG").forming).toBe(false);
    expect(resolveLtfForming(t, "LONG").broken).toBe(true);
  });

  it("TEAM Jul: HTF formed + LTF forming", () => {
    const t = teamJulRip();
    expect(resolveLtfForming(t, "LONG").forming).toBe(true);
    expect(resolveHtfForming(t, "LONG").formed).toBe(true);
  });

  it("weekly ST sloping against blocks HTF forming", () => {
    const t = tslaAug13();
    t.tf_tech.W = tf({ stDir: 1, stSlope: -1 });
    expect(resolveHtfForming(t, "LONG").forming).toBe(false);
    expect(resolveHtfForming(t, "LONG").wm_against).toBe(true);
  });
});

describe("resolveFormingPair", () => {
  it("TSLA Aug 13 is a complementary TURN long", () => {
    const p = resolveFormingPair(tslaAug13());
    expect(p.complementary).toBe(true);
    expect(p.side).toBe("LONG");
    expect(p.mode).toBe("turn");
    expect(formingPairExemptsHtfColorVeto(p, "LONG")).toBe(true);
  });

  it("AAPL June dump is not complementary", () => {
    const p = resolveFormingPair(aaplJuneDump());
    expect(p.complementary).toBe(false);
    expect(formingPairExemptsHtfColorVeto(p, "LONG")).toBe(false);
  });

  it("TEAM Jul is complementary CONTINUATION", () => {
    const p = resolveFormingPair(teamJulRip());
    expect(p.complementary).toBe(true);
    expect(p.side).toBe("LONG");
    expect(p.mode).toBe("continuation");
  });

  it("stretch chase (far above 21, days>5, HTF not formed) is not complementary", () => {
    const t = tslaAug13();
    t.htf_score = -8;
    t.daily_structure = { pct_above_e21: 6.2, e21_slope_5d_pct: 0.4, days_above_e21: 8 };
    const p = resolveFormingPair(t);
    expect(p.complementary).toBe(false);
    expect(p.reason).toBe("htf_stretch_chase");
    expect(resolveLtfForming(t, "SHORT").forming).toBe(false);
  });
});

describe("inferSide uses the forming pair over BEAR substring", () => {
  it("HTF_BEAR_LTF_PULLBACK + forming pair → LONG (TSLA)", () => {
    expect(inferSide(tslaAug13(), "HTF_BEAR_LTF_PULLBACK")).toBe("LONG");
  });

  it("HTF_BEAR_LTF_PULLBACK without forming pair still → SHORT", () => {
    const dead = {
      state: "HTF_BEAR_LTF_PULLBACK",
      htf_score: -12,
      ltf_score: -8,
      tf_tech: {
        "10": tf({ stDir: 1, stSlope: -1, struct: -0.8 }),
        "30": tf({ stDir: 1, struct: -0.7 }),
        D: tf({ stDir: 1, stSlope: -1 }),
        W: tf({ stDir: 1, stSlope: -1 }),
      },
    };
    expect(inferSide(dead, "HTF_BEAR_LTF_PULLBACK")).toBe("SHORT");
  });

  it("AAPL dump stays LONG from HTF_BULL (no pair override)", () => {
    expect(inferSide(aaplJuneDump(), "HTF_BULL_LTF_PULLBACK")).toBe("LONG");
  });
});

describe("flags default ON", () => {
  it("enabled and entry default true; explicit false kills", () => {
    expect(formingPairEnabled({})).toBe(true);
    expect(formingPairEntryEnabled({})).toBe(true);
    expect(formingPairFloorsEnabled({})).toBe(true);
    expect(formingPairEnabled({ deep_audit_forming_pair_enabled: "false" })).toBe(false);
    expect(formingPairEntryEnabled({ deep_audit_forming_pair_entry: "false" })).toBe(false);
    expect(formingPairFloorsEnabled({ deep_audit_forming_pair_floors: "false" })).toBe(false);
  });
});

describe("forming-pair LONG floor carve-out (TEAM / TSLA / AAPL)", () => {
  const daOn = {};

  it("TEAM Jul continuation: complementary LONG, floor 80 → 40", () => {
    const t = teamJulRip();
    expect(isFormingPairFloorContext(t, daOn, "LONG")).toBe(true);
    expect(applyFormingPairConvictionCarveout(80, t, daOn, "LONG")).toBe(40);
  });

  it("TSLA Aug 13 turn: complementary LONG, floor 80 → 40", () => {
    const t = tslaAug13();
    expect(isFormingPairFloorContext(t, daOn, "LONG")).toBe(true);
    expect(applyFormingPairConvictionCarveout(80, t, daOn, "LONG")).toBe(40);
    // Parked daily ST/cloud is the turn, not a veto — evaluateEntry
    // qualifies tt_forming_pair before tt_bias_not_aligned.
    expect(t.tf_tech.D.stDir).toBe(1);
    expect(t.state).toBe("HTF_BEAR_LTF_PULLBACK");
  });

  it("valid AAPL long: complementary, same carve-out", () => {
    const t = aaplValidLong();
    expect(resolveFormingPair(t).complementary).toBe(true);
    expect(isFormingPairFloorContext(t, daOn, "LONG")).toBe(true);
    expect(applyFormingPairConvictionCarveout(80, t, daOn, "LONG")).toBe(40);
  });

  it("AAPL June dump: not complementary, floor stays 80", () => {
    const t = aaplJuneDump();
    expect(isFormingPairFloorContext(t, daOn, "LONG")).toBe(false);
    expect(applyFormingPairConvictionCarveout(80, t, daOn, "LONG")).toBe(80);
  });

  it("TEAM Jul 8 bear fade: complementary SHORT, no LONG floor carve-out", () => {
    const t = teamJul8BearFade();
    const p = resolveFormingPair(t);
    expect(p.complementary).toBe(true);
    expect(p.side).toBe("SHORT");
    expect(isFormingPairFloorContext(t, daOn, "LONG")).toBe(false);
    expect(isFormingPairFloorContext(t, daOn, "SHORT")).toBe(false);
    expect(applyFormingPairConvictionCarveout(80, t, daOn, "SHORT")).toBe(80);
  });

  it("explicit floors=false kills the carve-out", () => {
    const t = teamJulRip();
    const daOff = { deep_audit_forming_pair_floors: "false" };
    expect(isFormingPairFloorContext(t, daOff, "LONG")).toBe(false);
    expect(applyFormingPairConvictionCarveout(80, t, daOff, "LONG")).toBe(80);
  });

  it("honors a custom conviction floor and the 35 hard min", () => {
    const t = tslaAug13();
    expect(applyFormingPairConvictionCarveout(80, t, { deep_audit_forming_pair_conviction_floor: 45 }, "LONG")).toBe(45);
    expect(applyFormingPairConvictionCarveout(80, t, { deep_audit_forming_pair_conviction_floor: 20 }, "LONG")).toBe(35);
  });
});
