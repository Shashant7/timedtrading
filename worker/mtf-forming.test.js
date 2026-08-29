import { describe, it, expect } from "vitest";
import {
  resolveLtfForming,
  resolveHtfForming,
  resolveFormingPair,
  formingPairExemptsHtfColorVeto,
  formingPairEnabled,
  formingPairEntryEnabled,
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
    expect(formingPairEnabled({ deep_audit_forming_pair_enabled: "false" })).toBe(false);
    expect(formingPairEntryEnabled({ deep_audit_forming_pair_entry: "false" })).toBe(false);
  });
});
