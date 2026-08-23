import { describe, it, expect } from "vitest";
import {
  resolvePlay,
  playLabel,
  isPlayPaused,
  canonicalPlayId,
  CORE_PLAYS,
} from "./play-catalog.js";

describe("play catalog", () => {
  it("treats Gap Reversal Long and tt_gap_reversal_long as one play", () => {
    const a = resolvePlay("Gap Reversal Long");
    const b = resolvePlay("tt_gap_reversal_long");
    const c = resolvePlay("TT Gap Reversal (Long)");
    const d = resolvePlay("TT Tt Gap Reversal Long");
    expect(a.id).toBe("tt_gap_reversal_long");
    expect(b.id).toBe(a.id);
    expect(c.id).toBe(a.id);
    expect(d.id).toBe(a.id);
    expect(a.status).toBe("live");
    expect(a.role).toBe("workhorse");
  });

  it("merges unstamped setup_name with a later stamped path", () => {
    expect(canonicalPlayId(null, "Gap Reversal Long")).toBe("tt_gap_reversal_long");
    expect(canonicalPlayId("tt_gap_reversal_long", "Gap Reversal Long")).toBe("tt_gap_reversal_long");
    expect(canonicalPlayId("(unstamped)", "ATH Breakout")).toBe("tt_ath_breakout");
  });

  it("pauses range reversal and keeps the workhorse live", () => {
    expect(isPlayPaused("tt_range_reversal_long")).toBe(true);
    expect(isPlayPaused("Range Reversal (Long)")).toBe(true);
    expect(isPlayPaused("tt_gap_reversal_long")).toBe(false);
    expect(playLabel("tt_n_test_support")).toBe("Support Bounce");
  });

  it("swaps ATH/ATL when direction disagrees with the stored name", () => {
    expect(resolvePlay("Atl Breakdown", "LONG").id).toBe("tt_ath_breakout");
    expect(resolvePlay("tt_ath_breakout", "SHORT").id).toBe("tt_atl_breakdown");
  });

  it("keeps the core set small and unique", () => {
    const ids = CORE_PLAYS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeLessThanOrEqual(16);
    expect(ids).toContain("tt_gap_reversal_long");
  });
});
