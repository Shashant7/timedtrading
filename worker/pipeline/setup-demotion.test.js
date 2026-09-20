import { describe, it, expect } from "vitest";
import {
  checkSetupDemotion,
  demotionProposalConfigKey,
  setupDemotionConfigKey,
  buildDemotionHealUpserts,
  isDemotionKeyBlocked,
  mergeEnforceDemotionPaths,
  SEVERE_BLEEDER_PATHS,
} from "./setup-demotion.js";

describe("setup-demotion heal (2026-07-23)", () => {
  it("maps mangled TT Tt display names to the canonical key", () => {
    expect(demotionProposalConfigKey("TT Tt Ath Breakout", "long"))
      .toBe(setupDemotionConfigKey("tt_ath_breakout", "long"));
    expect(demotionProposalConfigKey("TT ATH Breakout", "LONG"))
      .toBe("deep_audit_setup_demotion_TT ATH Breakout_long");
  });

  it("blocks when canonical key is blocked even without enforce_paths", () => {
    const key = setupDemotionConfigKey("tt_ath_breakout", "long");
    const daCfg = { [key]: "blocked", deep_audit_setup_demotion_index_only: "false" };
    const r = checkSetupDemotion("tt_ath_breakout", "LONG", daCfg, "NVDA");
    expect(r.blocked).toBe(true);
    expect(r.key).toBe(key);
  });

  it("blocks via mangled legacy key after normalization", () => {
    const daCfg = {
      "deep_audit_setup_demotion_TT Tt Ath Breakout_long": "blocked",
      deep_audit_setup_demotion_index_only: "false",
    };
    expect(isDemotionKeyBlocked(daCfg, "tt_ath_breakout", "long").blocked).toBe(true);
    expect(checkSetupDemotion("tt_ath_breakout", "long", daCfg, "AAPL").blocked).toBe(true);
  });

  it("defaults index_only to false so single names are demoted", () => {
    const key = setupDemotionConfigKey("tt_n_test_support", "long");
    const daCfg = { [key]: "blocked" }; // no index_only key
    expect(checkSetupDemotion("tt_n_test_support", "long", daCfg, "HALO").blocked).toBe(true);
  });

  it("still respects index_only=true when set", () => {
    const key = setupDemotionConfigKey("tt_n_test_support", "long");
    const daCfg = {
      [key]: "blocked",
      deep_audit_setup_demotion_index_only: "true",
    };
    expect(checkSetupDemotion("tt_n_test_support", "long", daCfg, "HALO").blocked).toBe(false);
    expect(checkSetupDemotion("tt_n_test_support", "long", daCfg, "SPY").blocked).toBe(true);
  });

  it("buildDemotionHealUpserts expands enforce_paths and does not re-block", () => {
    const { enforce, rows } = buildDemotionHealUpserts({
      existingEnforcePaths: "tt_n_test_support",
      paths: ["tt_ath_breakout", "tt_n_test_support", "tt_range_reversal_long"],
      now: 1,
    });
    expect(enforce).toContain("tt_ath_breakout");
    expect(enforce).toContain("tt_range_reversal_long");
    expect(rows.some((r) => r.config_key.includes("TT ATH Breakout"))).toBe(false);
    const withMarkers = buildDemotionHealUpserts({
      paths: ["tt_ath_breakout"],
      writeBlockedMarkers: true,
      now: 1,
    });
    expect(withMarkers.rows.some((r) => r.config_key.includes("TT ATH Breakout"))).toBe(true);
    expect(mergeEnforceDemotionPaths("tt_a", ["tt_b", "tt_a"])).toBe("tt_a,tt_b");
  });

  it("maps Cloud Pivot keys but does not auto-demote the family", () => {
    expect(SEVERE_BLEEDER_PATHS).not.toContain("tt_cloud_pivot");
    expect(setupDemotionConfigKey("tt_cloud_pivot", "long"))
      .toBe("deep_audit_setup_demotion_TT Cloud Pivot_long");
    expect(demotionProposalConfigKey("TT Cloud Pivot", "LONG"))
      .toBe("deep_audit_setup_demotion_TT Cloud Pivot_long");
  });

  it("collapses the paper sibling paths onto the enforced Cloud Pivot key", () => {
    // The scorecard passes canonicalPlayId, so the key was built from
    // "tt_cloud_pivot_long" with no map entry: the title-case fallback wrote
    // "TT Cloud Pivot Long", a key checkSetupDemotion never reads, while the
    // enforced key stayed "allowed". Approving the block would have changed
    // nothing (proposals 79 + 81, 2026-09-19).
    const enforced = "deep_audit_setup_demotion_TT Cloud Pivot_long";
    expect(setupDemotionConfigKey("tt_cloud_pivot_long", "long")).toBe(enforced);
    expect(demotionProposalConfigKey("tt_cloud_pivot_long", "long")).toBe(enforced);
    expect(demotionProposalConfigKey("tt_cloud_pivot_short", "long")).toBe(enforced);
    // The mangled key must no longer be producible from a live path.
    expect(setupDemotionConfigKey("tt_cloud_pivot_long", "long"))
      .not.toContain("TT Cloud Pivot Long");
    // A marker under the enforced key now governs the sibling path too, so an
    // operator who does decide to pause the family only has one key to write.
    const blocked = isDemotionKeyBlocked({ [enforced]: "blocked" }, "tt_cloud_pivot_long", "long");
    expect(blocked.blocked).toBe(true);
    expect(blocked.key).toBe(enforced);
    expect(isDemotionKeyBlocked({}, "tt_cloud_pivot_long", "long").blocked).toBe(false);
  });

  it("resolves the sibling spelled as a DISPLAY name, not just as a path", () => {
    // The path form was fixed first, but the name map is keyed by path, so a
    // proposal carrying the display string still matched no entry and fell to
    // the title-case fallback. That string is the one both Cloud Pivot
    // proposals actually stored as their config_key.
    const enforced = "deep_audit_setup_demotion_TT Cloud Pivot_long";
    expect(demotionProposalConfigKey("TT Cloud Pivot Long", "long")).toBe(enforced);
    expect(demotionProposalConfigKey("tt cloud pivot short", "long")).toBe(enforced);
    // So a marker written under the old mangled spelling is now honoured
    // rather than sitting inert.
    const healed = isDemotionKeyBlocked(
      { "deep_audit_setup_demotion_TT Cloud Pivot Long_long": "blocked" },
      "tt_cloud_pivot",
      "long",
    );
    expect(healed.blocked).toBe(true);
  });

  it("does not invent a play for a name the catalog does not know", () => {
    expect(demotionProposalConfigKey("TT Not A Real Setup", "long"))
      .toBe("deep_audit_setup_demotion_TT Not A Real Setup_long");
  });

  it("leaves unrelated paths on their own keys", () => {
    expect(setupDemotionConfigKey("tt_ath_breakout", "long"))
      .toBe("deep_audit_setup_demotion_TT ATH Breakout_long");
    expect(setupDemotionConfigKey("tt_pullback", "long"))
      .toBe("deep_audit_setup_demotion_TT Pullback Reclaim_long");
  });
});
