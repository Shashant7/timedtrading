import { describe, it, expect, beforeEach } from "vitest";
import {
  buildOccSymbol,
  computeOptionOutcome,
  optionMarksEnabled,
  summarizeScorecard,
  _resetOptionMarksSchemaCache,
} from "./options-marks.js";

beforeEach(() => _resetOptionMarksSchemaCache());

describe("buildOccSymbol", () => {
  it("round-trips a SPY call", () => {
    expect(buildOccSymbol("SPY", "2026-08-18", "C", 772)).toBe("SPY260818C00772000");
  });
  it("handles PUT with fractional strike", () => {
    expect(buildOccSymbol("QQQ", "2026-08-18", "PUT", 730.5)).toBe("QQQ260818P00730500");
  });
  it("rejects malformed input", () => {
    expect(buildOccSymbol("", "2026-08-18", "C", 100)).toBeNull();
    expect(buildOccSymbol("SPY", "08/18/2026", "C", 100)).toBeNull();
    expect(buildOccSymbol("SPY", "2026-08-18", "X", 100)).toBeNull();
    expect(buildOccSymbol("SPY", "2026-08-18", "C", 0)).toBeNull();
  });
});

describe("computeOptionOutcome", () => {
  it("captures max gain, max drawdown, and theta drift", () => {
    const marks = [
      { ts: 1, mid: 1.5 },
      { ts: 2, mid: 2.1 },  // +40%
      { ts: 3, mid: 3.0 },  // +100%
      { ts: 4, mid: 2.0 },
      { ts: 5, mid: 1.2 },  // −20%
      { ts: 6, mid: 0.5 },  // close
    ];
    const out = computeOptionOutcome(1.5, marks);
    expect(out.entry_mid).toBe(1.5);
    expect(out.max_mid).toBe(3);
    expect(out.min_mid).toBe(0.5);
    expect(out.max_gain_pct).toBe(100);
    expect(out.max_drawdown_pct).toBeCloseTo(-66.67, 1);
    expect(out.close_pct).toBeCloseTo(-66.67, 1);
    expect(out.tp_hit_25).toBe(2);
    expect(out.tp_hit_50).toBe(3);
    expect(out.tp_hit_100).toBe(3);
    // Right direction hit +100% then bled — theta_realized = close - max_gain
    expect(out.theta_realized_pct).toBeCloseTo(-166.67, 1);
  });

  it("returns null on bad input", () => {
    expect(computeOptionOutcome(null, [])).toBeNull();
    expect(computeOptionOutcome(1, [])).toBeNull();
    expect(computeOptionOutcome(0, [{ ts: 1, mid: 2 }])).toBeNull();
  });

  it("handles a play that never traded (all marks equal entry)", () => {
    const marks = [{ ts: 1, mid: 1.0 }, { ts: 2, mid: 1.0 }, { ts: 3, mid: 0.9 }];
    const out = computeOptionOutcome(1.0, marks);
    expect(out.max_gain_pct).toBe(0);
    expect(out.max_drawdown_pct).toBeCloseTo(-10, 1);
    expect(out.tp_hit_25).toBeNull();
  });
});

describe("optionMarksEnabled", () => {
  it("defaults OFF (feature is dark)", () => {
    expect(optionMarksEnabled({})).toBe(false);
    expect(optionMarksEnabled({ _deepAuditConfig: {} })).toBe(false);
  });
  it("respects true from model_config", () => {
    expect(optionMarksEnabled({ _deepAuditConfig: { options_marks_enabled: "true" } })).toBe(true);
    expect(optionMarksEnabled({ _deepAuditConfig: { options_marks_enabled: true } })).toBe(true);
  });
  it("respects env fallback", () => {
    expect(optionMarksEnabled({ OPTIONS_MARKS_ENABLED: "true" })).toBe(true);
  });
});

describe("summarizeScorecard", () => {
  it("groups by ticker/tier/conviction and produces the right rates", () => {
    const rows = [
      // 3 wins, 1 loss on SPY gamma medium
      { ticker: "SPY", tier: "gamma", day_lean_conviction: "medium", max_gain_pct: 45, max_drawdown_pct: -20, close_pct: 30, tp_hit_25: 1, tp_hit_50: 0, tp_hit_100: 0 },
      { ticker: "SPY", tier: "gamma", day_lean_conviction: "medium", max_gain_pct: 100, max_drawdown_pct: -10, close_pct: 60, tp_hit_25: 1, tp_hit_50: 1, tp_hit_100: 1 },
      { ticker: "SPY", tier: "gamma", day_lean_conviction: "medium", max_gain_pct: 20, max_drawdown_pct: -30, close_pct: 5, tp_hit_25: 0, tp_hit_50: 0, tp_hit_100: 0 },
      { ticker: "SPY", tier: "gamma", day_lean_conviction: "medium", max_gain_pct: 0, max_drawdown_pct: -80, close_pct: -70, tp_hit_25: 0, tp_hit_50: 0, tp_hit_100: 0 },
      // 1 win on QQQ safety high
      { ticker: "QQQ", tier: "safety", day_lean_conviction: "high", max_gain_pct: 40, max_drawdown_pct: -5, close_pct: 25, tp_hit_25: 1, tp_hit_50: 0, tp_hit_100: 0 },
    ];
    const out = summarizeScorecard(rows);
    const spy = out.find((b) => b.ticker === "SPY");
    expect(spy).toBeTruthy();
    expect(spy.n).toBe(4);
    expect(spy.win_rate).toBe(75);
    expect(spy.tp25_rate).toBe(50);
    expect(spy.tp50_rate).toBe(25);
    const qqq = out.find((b) => b.ticker === "QQQ");
    expect(qqq).toBeTruthy();
    expect(qqq.win_rate).toBe(100);
  });

  it("returns [] on empty input", () => {
    expect(summarizeScorecard([])).toEqual([]);
    expect(summarizeScorecard(null)).toEqual([]);
  });
});
