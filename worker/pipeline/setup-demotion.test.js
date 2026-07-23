import { describe, it, expect } from "vitest";
import {
  checkSetupDemotion,
  demotionProposalConfigKey,
  setupDemotionConfigKey,
  buildDemotionHealUpserts,
  isDemotionKeyBlocked,
  mergeEnforceDemotionPaths,
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

  it("buildDemotionHealUpserts expands enforce_paths and writes blocked markers", () => {
    const { enforce, rows } = buildDemotionHealUpserts({
      existingEnforcePaths: "tt_n_test_support",
      paths: ["tt_ath_breakout", "tt_n_test_support", "tt_range_reversal_long"],
      now: 1,
    });
    expect(enforce).toContain("tt_ath_breakout");
    expect(enforce).toContain("tt_range_reversal_long");
    expect(rows.some((r) => r.config_key.includes("TT ATH Breakout"))).toBe(true);
    expect(mergeEnforceDemotionPaths("tt_a", ["tt_b", "tt_a"])).toBe("tt_a,tt_b");
  });
});
