import { describe, expect, it } from "vitest";
import {
  normalizeTacticalSignalDirections,
  parseMacroContextFromOverlay,
  parseSpxTargetRange,
  pickMonthEndRallyExpiration,
  mergeFsdMacroContexts,
} from "./fsd-macro-context.js";

describe("fsd-macro-context", () => {
  it("parses S&P 500 7,900-8,000 target range", () => {
    const t = "setting the stage for S&P 500 to reach 7,900-8,000 by month end";
    const r = parseSpxTargetRange(t);
    expect(r).toEqual({ low: 7900, high: 8000, mid: 7950 });
  });

  it("normalizes spx_target bullish_stretched to bullish_target", () => {
    const out = normalizeTacticalSignalDirections([{
      signal: "spx_target_7900_8000",
      pair: "^SPX",
      direction: "bullish_stretched",
    }]);
    expect(out[0].direction).toBe("bullish_target");
  });

  it("builds rally context from tactical overlay blob", () => {
    const ctx = parseMacroContextFromOverlay({
      tactical_overlay: "S&P 500 targeting 7,900-8,000; ETH leadership continues.",
      tactical_signals: [{
        signal: "spx_target_7900_8000",
        pair: "^SPX",
        direction: "bullish_target",
        horizon: "tactical",
      }],
      applied_at: Date.now(),
    });
    expect(ctx.rally_active).toBe(true);
    expect(ctx.spx_target.high).toBe(8000);
    expect(ctx.target_month_end).toBe(true);
  });

  it("picks month-end expiration when rally window active", () => {
    const now = Date.UTC(2026, 7, 26, 14, 0, 0); // Aug 26 2026
    const exp = pickMonthEndRallyExpiration(now, {
      target_month_end: true,
      target_deadline_ms: Date.UTC(2026, 7, 31, 21, 0, 0),
    });
    expect(exp).not.toBeNull();
    expect(exp.dte).toBeGreaterThanOrEqual(2);
    expect(exp.dte).toBeLessThanOrEqual(10);
  });

  it("merges month-end SPX target when live overlay is a newer single-name note", () => {
    const monthEnd = parseMacroContextFromOverlay({
      tactical_overlay: "S&P 500 targeting 7,900-8,000 by month end.",
      tactical_signals: [{
        signal: "spx_target_7900_8000",
        pair: "^SPX",
        direction: "bullish_target",
      }],
      applied_at: Date.UTC(2026, 7, 25, 12, 0, 0),
    });
    const nvidia = parseMacroContextFromOverlay({
      tactical_overlay: "NVIDIA strong earnings; semis rally.",
      tactical_signals: [{
        signal: "nvidia_earnings_positive_impact",
        pair: "IGV/SMH",
        direction: "favor_a_over_b",
      }],
      applied_at: Date.UTC(2026, 7, 27, 12, 0, 0),
    });
    expect(nvidia.rally_active).toBe(false);
    const merged = mergeFsdMacroContexts(nvidia, monthEnd);
    expect(merged.rally_active).toBe(true);
    expect(merged.spx_target.high).toBe(8000);
    expect(merged.target_month_end).toBe(true);
  });
});
