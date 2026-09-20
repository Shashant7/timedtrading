import { describe, it, expect } from "vitest";
import { extractRows, parseMarkers, inertMarkers, stats } from "./weekend-trim-split-review.mjs";

/** Wrangler prints warnings before the JSON array; the parser must skip them. */
const d1 = (results) => `▲ [WARNING] Unexpected fields\n${JSON.stringify([{ results, success: true }])}`;

describe("weekend trim-split review", () => {
  it("reads a wrangler payload past its warning preamble", () => {
    expect(extractRows(d1([{ pnl: 1 }, { pnl: -2 }]))).toHaveLength(2);
  });

  it("separates the trim cohorts by PF, not by win count alone", () => {
    const s = stats([{ pnl: 10 }, { pnl: 10 }, { pnl: -5 }]);
    expect(s).toMatchObject({ n: 3, pnl: 15 });
    expect(s.pf).toBeCloseTo(4);
  });

  it("unwraps both the JSON-encoded and raw spellings D1 holds", () => {
    // Real production rows: the governor writes JSON, learning_proposals does not.
    const markers = parseMarkers(d1([
      { config_key: "deep_audit_setup_demotion_TT ATH Breakout_long", config_value: '"blocked"', updated_by: "weekly_governor_auto_demote" },
      { config_key: "deep_audit_setup_demotion_TT Support Bounce_long", config_value: "blocked", updated_by: "learning_proposals" },
    ]));
    expect(markers["deep_audit_setup_demotion_TT ATH Breakout_long"].value).toBe("blocked");
    expect(markers["deep_audit_setup_demotion_TT Support Bounce_long"].value).toBe("blocked");
  });

  it("names the canonical key a misspelled marker is standing in for", () => {
    const inert = inertMarkers(parseMarkers(d1([
      // The 2026-09-20 shape: a key naming the paper sibling.
      { config_key: "deep_audit_setup_demotion_TT Cloud Pivot Long_long", config_value: '"blocked"', updated_by: "weekly_governor" },
      // The 2026-07-23 shape: a duplicated TT prefix.
      { config_key: "deep_audit_setup_demotion_TT Tt Ath Breakout_long", config_value: '"blocked"', updated_by: "edge_scorecard" },
      { config_key: "deep_audit_setup_demotion_TT ATH Breakout_long", config_value: '"blocked"', updated_by: "weekly_governor" },
      // Scalars share the prefix but are not markers.
      { config_key: "deep_audit_setup_demotion_enforce_paths", config_value: '"tt_ath_breakout"', updated_by: "weekly_governor" },
      { config_key: "deep_audit_setup_demotion_index_only", config_value: '"false"', updated_by: "weekly_governor" },
    ])));
    expect(inert.map((r) => r.key)).toEqual([
      "deep_audit_setup_demotion_TT Cloud Pivot Long_long",
      "deep_audit_setup_demotion_TT Tt Ath Breakout_long",
    ]);
    // Both collapse onto the key checkSetupDemotion actually reads. They are
    // now honoured by the heal-read rather than ignored, but an operator still
    // wants them reported: the spelling is the thing that made them ambiguous.
    expect(inert[0].canonical).toBe("deep_audit_setup_demotion_TT Cloud Pivot_long");
    expect(inert[1].canonical).toBe("deep_audit_setup_demotion_TT ATH Breakout_long");
  });

  it("calls the live production marker set clean", () => {
    expect(inertMarkers(parseMarkers(d1([
      { config_key: "deep_audit_setup_demotion_TT ATH Breakout_long", config_value: '"blocked"', updated_by: "weekly_governor_auto_demote" },
      { config_key: "deep_audit_setup_demotion_TT Cloud Pivot_long", config_value: '"allowed"', updated_by: "learning_desk_cio" },
      { config_key: "deep_audit_setup_demotion_TT Range Reversal (Long)_long", config_value: '"blocked"', updated_by: "weekly_governor_heal" },
      { config_key: "deep_audit_setup_demotion_TT Support Bounce_long", config_value: "blocked", updated_by: "learning_proposals" },
    ])))).toEqual([]);
  });
});
