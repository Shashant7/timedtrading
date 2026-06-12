import { describe, it, expect } from "vitest";
import {
  applyMomentumBreakoutConvictionCarveout,
  normalizeCompletionPct,
  shouldBypassLateDaySmartGate,
  shouldBypassMacroEntrySmartGate,
  stampMomentumBreakoutEarly,
} from "./smart-gates.js";

describe("normalizeCompletionPct", () => {
  it("scales 0-1 values to percent", () => {
    expect(normalizeCompletionPct(0.21)).toBe(21);
  });
  it("passes through percent-scale values", () => {
    expect(normalizeCompletionPct(35)).toBe(35);
  });
});

describe("stampMomentumBreakoutEarly", () => {
  it("stamps near-high momentum elite structural setups", () => {
    const d = {
      rank: 72,
      flags: { momentum_elite: true },
      daily_structure: {
        ath52w: {
          pct_below_high_252: 4,
          breakout_above_prev_high: true,
        },
      },
    };
    const ok = stampMomentumBreakoutEarly(d, { rvol: { best: 2.5 } }, {}, {});
    expect(ok).toBe(true);
    expect(d.__momentum_breakout_early).toBe(true);
  });
});

describe("applyMomentumBreakoutConvictionCarveout", () => {
  it("lowers floor when stamped early breakout qualifies", () => {
    const d = { __momentum_breakout_early: true, rank: 70 };
    expect(applyMomentumBreakoutConvictionCarveout(80, d, {})).toBe(70);
  });
});

describe("shouldBypassLateDaySmartGate", () => {
  it("allows high-rank ATH breakout paths", () => {
    expect(shouldBypassLateDaySmartGate({
      __entry_path: "tt_ath_breakout",
      rank: 80,
      rvol: { best: 2.0 },
      __focus_conviction_score: 78,
      __momentum_breakout_early: true,
    }, {})).toBe(true);
  });

  it("blocks low-rank gap reversal", () => {
    expect(shouldBypassLateDaySmartGate({
      __entry_path: "tt_gap_reversal_long",
      rank: 80,
      rvol: { best: 2.0 },
      __focus_conviction_score: 78,
    }, {})).toBe(false);
  });
});

describe("shouldBypassMacroEntrySmartGate", () => {
  it("allows ATH breakout on macro day with strong scores", () => {
    expect(shouldBypassMacroEntrySmartGate({
      __entry_path: "tt_ath_breakout",
      rank: 82,
      __focus_conviction_score: 80,
      __momentum_breakout_early: true,
    }, { eventType: "macro", eventKey: "PCE" }, {})).toBe(true);
  });

  it("keeps gap reversal blocked on macro day", () => {
    expect(shouldBypassMacroEntrySmartGate({
      __entry_path: "tt_gap_reversal_long",
      rank: 90,
      __focus_conviction_score: 90,
      __momentum_breakout_early: true,
    }, { eventType: "macro", eventKey: "PCE" }, {})).toBe(false);
  });
});
