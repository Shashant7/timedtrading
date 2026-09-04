import { describe, it, expect } from "vitest";
import {
  resolvePlay,
  playLabel,
  isPlayPaused,
  isPlayRestricted,
  canonicalPlayId,
  canAutoDemotePlay,
  isCalibrationPlay,
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
    expect(isPlayRestricted("tt_ath_breakout")).toBe(true);
    expect(isPlayRestricted("tt_cloud_pivot")).toBe(true);
    expect(isPlayRestricted("TT Cloud Pivot")).toBe(true);
    expect(isPlayRestricted("tt_index_etf_swing")).toBe(true);
    expect(isPlayRestricted("tt_gap_reversal_long")).toBe(false);
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
    expect(ids).toContain("tt_cloud_pivot");
    expect(ids).toContain("tt_forming_pair");
  });

  // F10 (2026-09-04 ledger audit) — every display alias observed in the
  // live public ledger must collapse to one canonical id. The legacy
  // write bug produced double-prefixed names ("TT Tt N Test Support")
  // that split the proof-page cohorts (ATH showed as two setups hiding a
  // combined 110-trade PF 0.55 result).
  it("collapses every live ledger alias to its canonical play id", () => {
    const expectId = {
      "TT Tt Gap Reversal Long": "tt_gap_reversal_long",
      "TT Gap Reversal (Long)": "tt_gap_reversal_long",
      "TT Tt Gap Reversal Short": "tt_gap_reversal_short",
      "TT Tt Ath Breakout": "tt_ath_breakout",
      "TT ATH Breakout": "tt_ath_breakout",
      "TT Tt Atl Breakdown": "tt_atl_breakdown",
      "TT Tt N Test Support": "tt_n_test_support",
      "TT Support Bounce": "tt_n_test_support",
      "TT Tt N Test Resistance": "tt_n_test_resistance",
      "TT Tt Range Reversal Long": "tt_range_reversal_long",
      "TT Range Reversal (Long)": "tt_range_reversal_long",
      "TT Tt Pullback": "tt_pullback",
      "TT Pullback Reclaim": "tt_pullback",
      "TT Cloud Pivot": "tt_cloud_pivot",
      "TT HTF Reclaim": "tt_htf_reclaim",
      "TT Tt Momentum": "tt_momentum",
      "TT Momentum": "tt_momentum",
      "TT Tt Reclaim": "tt_reclaim",
    };
    for (const [name, id] of Object.entries(expectId)) {
      expect(canonicalPlayId(null, name), name).toBe(id);
    }
    // Junk names with no catalog play stay null (frontend falls back to
    // display grouping) — they must not be forced onto a real cohort.
    expect(canonicalPlayId(null, "TT Setup")).toBeNull();
    expect(canonicalPlayId(null, "TT Confirmed Long")).toBeNull();
  });

  it("keeps Cloud Pivot on the calibration path, not auto-demote", () => {
    expect(resolvePlay("tt_cloud_pivot").role).toBe("calibration");
    expect(isCalibrationPlay("TT Cloud Pivot")).toBe(true);
    expect(canAutoDemotePlay("tt_cloud_pivot").ok).toBe(false);
    expect(canAutoDemotePlay("tt_cloud_pivot").reason).toBe("calibration_family");
    expect(canAutoDemotePlay("tt_ath_breakout").ok).toBe(true);
    expect(canAutoDemotePlay("tt_gap_reversal_long").ok).toBe(false);
  });
});
