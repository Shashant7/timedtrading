import { describe, it, expect } from "vitest";
import {
  buildEffectiveSectorTilts,
  buildEffectiveThemeTilts,
  buildSectorRatingsPatch,
  mergeSectorTilt,
  parseStrategyOverrideBlob,
  resolveRatingSectorName,
  setStrategyOverrideCache,
  stanceToBoost,
} from "./strategy-overrides.js";

describe("parseStrategyOverrideBlob", () => {
  it("merges top-level and structural_pending stance changes", () => {
    const parsed = parseStrategyOverrideBlob({
      sector_stance_changes: [{ sector: "Information Technology", new_stance: "neutral" }],
      structural_pending: {
        sector_stance_changes: [{ sector: "Industrials", new_stance: "neutral" }],
      },
    });
    expect(parsed.sector_stance_changes).toHaveLength(2);
  });
});

describe("buildEffectiveSectorTilts", () => {
  it("applies FSD sector stance over playbook base", () => {
    const base = {
      "Information Technology": {
        stance: "overweight",
        multiplier: 1.15,
        rationale_short: "old",
      },
    };
    const merged = buildEffectiveSectorTilts(base, {
      sector_stance_changes: [{
        sector: "Information Technology",
        new_stance: "neutral",
        new_multiplier: 1.0,
        rationale_short: "Mark downgraded to Neutral",
      }],
    });
    expect(merged["Information Technology"].stance).toBe("neutral");
    expect(merged["Information Technology"].multiplier).toBe(1.0);
    expect(merged["Information Technology"].rationale_short).toContain("Neutral");
    expect(merged["Information Technology"]._fsd_applied).toBe(true);
  });
});

describe("buildSectorRatingsPatch", () => {
  it("maps playbook Healthcare to Health Care rating key", () => {
    const base = {
      "Health Care": { rating: "underweight", boost: -4, delta: -2.0 },
    };
    const patch = buildSectorRatingsPatch(base, {
      sector_stance_changes: [{
        sector: "Healthcare",
        new_stance: "overweight",
        new_multiplier: 1.15,
      }],
    });
    expect(patch["Health Care"].rating).toBe("overweight");
    expect(patch["Health Care"].boost).toBeGreaterThan(0);
  });

  it("neutralizes Information Technology scoring boost", () => {
    const base = {
      "Information Technology": { rating: "overweight", boost: 5, delta: 2.5 },
    };
    const patch = buildSectorRatingsPatch(base, {
      sector_stance_changes: [{
        sector: "Information Technology",
        new_stance: "neutral",
        new_multiplier: 1.0,
      }],
    });
    expect(patch["Information Technology"].rating).toBe("neutral");
    expect(patch["Information Technology"].boost).toBe(0);
  });
});

describe("buildEffectiveThemeTilts", () => {
  it("applies theme stance changes", () => {
    const base = {
      ai_infra_compute: { stance: "overweight", multiplier: 1.25, tier: "tier_1", playbook: "MAG7" },
    };
    const merged = buildEffectiveThemeTilts(base, {
      theme_stance_changes: [{ theme: "ai_infra_compute", new_stance: "neutral", new_multiplier: 1.0 }],
    });
    expect(merged.ai_infra_compute.stance).toBe("neutral");
    expect(merged.ai_infra_compute.multiplier).toBe(1.0);
  });
});

describe("stanceToBoost", () => {
  it("derives boost from multiplier when provided", () => {
    expect(stanceToBoost("overweight", 1.15)).toBe(3);
    expect(stanceToBoost("neutral", 1.0)).toBe(0);
  });
});

describe("resolveRatingSectorName", () => {
  it("aliases Healthcare to Health Care", () => {
    expect(resolveRatingSectorName("Healthcare")).toBe("Health Care");
  });
});

describe("setStrategyOverrideCache", () => {
  it("stores parsed override for sync readers", () => {
    setStrategyOverrideCache({
      sector_stance_changes: [{ sector: "Financials", new_stance: "overweight" }],
    });
    const merged = mergeSectorTilt(
      { stance: "neutral", multiplier: 1.0 },
      { new_stance: "overweight", new_multiplier: 1.15 },
    );
    expect(merged.stance).toBe("overweight");
  });
});
