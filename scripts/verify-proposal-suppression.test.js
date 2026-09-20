import { describe, it, expect } from "vitest";
import { classifyCandidate } from "./verify-proposal-suppression.mjs";

const ctx = (markers = {}, recovered = []) => ({
  recoveredKeys: new Set(recovered),
  markers,
});

describe("nightly proposal submission guards", () => {
  it("suppresses the paper sibling by role, not by its own PF", () => {
    // tt_cloud_pivot_long resolves to the calibration parent only because of
    // sibling_paths; before that fix this candidate filed a proposal a week.
    const r = classifyCandidate({ setup: "tt_cloud_pivot_long", direction: "LONG" }, ctx());
    expect(r).toMatchObject({ filed: false, guard: "isCalibrationPlay" });
    expect(r.key).toBe("deep_audit_setup_demotion_TT Cloud Pivot_long");
  });

  it("suppresses a family whose canonical key already holds the block", () => {
    const r = classifyCandidate({ setup: "tt_ath_breakout", direction: "LONG" }, ctx({
      "deep_audit_setup_demotion_TT ATH Breakout_long": '"blocked"',
    }));
    expect(r).toMatchObject({ filed: false, guard: "already_at_proposed_value" });
  });

  it("still files a bleeder that carries no marker", () => {
    const r = classifyCandidate({ setup: "tt_pullback", direction: "LONG" }, ctx());
    expect(r).toMatchObject({ filed: true, guard: null });
    expect(r.key).toBe("deep_audit_setup_demotion_TT Pullback Reclaim_long");
  });

  it("respects a 30d recovery ahead of every other guard", () => {
    const key = "deep_audit_setup_demotion_TT ATH Breakout_long";
    const r = classifyCandidate({ setup: "tt_ath_breakout", direction: "LONG" },
      ctx({ [key]: '"blocked"' }, [key]));
    expect(r.guard).toBe("recovered30d");
  });

  it("reproduces the live 2026-09-20 card: nothing to file", () => {
    const markers = {
      "deep_audit_setup_demotion_TT ATH Breakout_long": '"blocked"',
      "deep_audit_setup_demotion_TT Cloud Pivot_long": '"allowed"',
    };
    const card = [
      { setup: "tt_cloud_pivot_long", direction: "LONG" },
      { setup: "tt_ath_breakout", direction: "LONG" },
    ];
    expect(card.map((c) => classifyCandidate(c, ctx(markers)).filed)).toEqual([false, false]);
  });
});
