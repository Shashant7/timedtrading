// 4H SuperTrend opposing-slope gate for Investor capital deployment.
import { describe, it, expect } from "vitest";
import {
  DEFAULT_INVESTOR_CONFIG,
  loadInvestorConfig,
  resolveInvestor4hTiming,
  investor4hCapitalDeploymentBlock,
  computeInvestorSimEligible,
  applyInvestor4hStageGate,
  classifyInvestorStage,
  computeInvestorScore,
} from "./investor.js";

const bullishMonthly = { monthly_bundle: { supertrend_dir: -1, ema_structure: 1, rsi: 65, ema_depth: 8 } };

function td(overrides = {}) {
  return {
    price: 100,
    _live_price: 100,
    tf_tech: {
      D: { stDir: -1 },
      W: { stDir: -1, atr: { xs: 1 } },
      "4H": { stDir: -1, stSlopeUp: true, stSlope: 1 },
    },
    ...bullishMonthly,
    ...overrides,
  };
}

describe("4H ST slope snapshot", () => {
  it("detects opposing slope without requiring bearish direction flip", () => {
    const snap = resolveInvestor4hTiming(td({
      tf_tech: {
        D: { stDir: -1 },
        W: { stDir: -1 },
        "4H": { stDir: -1, stSlopeDn: true, stSlope: -2 },
      },
    }));
    expect(snap.opposingSlope).toBe(true);
    expect(snap.is4hBull).toBe(true);
  });

  it("treats flat bearish ST as non-opposing", () => {
    const snap = resolveInvestor4hTiming(td({
      tf_tech: {
        D: { stDir: -1 },
        W: { stDir: -1 },
        "4H": { stDir: 1, stSlope: 0 },
      },
    }));
    expect(snap.is4hBear).toBe(true);
    expect(snap.stSlopeFlat).toBe(true);
    expect(snap.opposingSlope).toBe(false);
  });
});

describe("capital deployment block — slope only", () => {
  it("blocks when 4H SuperTrend is sloping down (CRDO/MOD observation)", () => {
    const block = investor4hCapitalDeploymentBlock(td({
      tf_tech: {
        D: { stDir: -1 },
        W: { stDir: -1, atr: { xs: 1 } },
        "4H": { stDir: 1, stSlopeDn: true, stSlope: -3 },
      },
    }));
    expect(block).toMatchObject({ reason: "supertrend_opposing_slope", opposingSlope: true });
  });

  it("does NOT block bearish-but-flat SuperTrend", () => {
    expect(investor4hCapitalDeploymentBlock(td({
      tf_tech: {
        D: { stDir: -1 },
        W: { stDir: -1 },
        "4H": { stDir: 1, stSlope: 0 },
      },
    }))).toBeNull();
  });

  it("does NOT block on price below hourly EMA alone", () => {
    expect(investor4hCapitalDeploymentBlock(td({
      price: 90,
      _live_price: 90,
      tf_tech: {
        D: { stDir: -1 },
        W: { stDir: -1 },
        "4H": { stDir: -1, stSlopeUp: true, stSlope: 1 },
        "1H": { ema: { ema21: 95 } },
      },
    }))).toBeNull();
  });

  it("returns null when timing is aligned", () => {
    expect(investor4hCapitalDeploymentBlock(td())).toBeNull();
  });

  it("honors disable flag", () => {
    const cfg = loadInvestorConfig({ deep_audit_investor_st_slope_gate_enabled: "false" });
    expect(investor4hCapitalDeploymentBlock(td({ tf_tech: { "4H": { stDir: 1, stSlopeDn: true } } }), cfg)).toBeNull();
  });
});

describe("simEligible", () => {
  it("requires no opposing 4H slope when gate enabled", () => {
    expect(computeInvestorSimEligible(td())).toBe(true);
    expect(computeInvestorSimEligible(td({
      tf_tech: { D: { stDir: -1 }, W: { stDir: -1 }, "4H": { stDir: 1, stSlopeDn: true, stSlope: -1 } },
    }))).toBe(false);
    expect(computeInvestorSimEligible(td({
      tf_tech: { D: { stDir: -1 }, W: { stDir: -1 }, "4H": { stDir: 1, stSlope: 0 } },
    }))).toBe(true);
  });
});

describe("stage gate", () => {
  it("downgrades accumulate to watch when opposing slope blocks", () => {
    const r = applyInvestor4hStageGate(
      { stage: "accumulate", reason: "strong_score" },
      td({ tf_tech: { D: { stDir: -1 }, W: { stDir: -1 }, "4H": { stDir: 1, stSlopeDn: true, stSlope: -2 } } }),
      { existingPosition: null, cfg: DEFAULT_INVESTOR_CONFIG },
    );
    expect(r.stage).toBe("watch");
    expect(r.reason).toContain("st_slope_block");
  });

  it("allows accumulate when ST is bearish but flat", () => {
    const r = applyInvestor4hStageGate(
      { stage: "accumulate", reason: "strong_score" },
      td({ tf_tech: { D: { stDir: -1 }, W: { stDir: -1 }, "4H": { stDir: 1, stSlope: 0 } } }),
      { existingPosition: null, cfg: DEFAULT_INVESTOR_CONFIG },
    );
    expect(r.stage).toBe("accumulate");
  });
});

describe("score component fourHourTiming", () => {
  it("penalizes only opposing slope, not flat bearish direction", () => {
    const good = computeInvestorScore(td(), { rsRank: 80, sectorRsRank: 50, marketHealth: 60 }).components.fourHourTiming;
    const slopeDown = computeInvestorScore(td({
      tf_tech: { D: { stDir: -1 }, W: { stDir: -1 }, "4H": { stDir: 1, stSlopeDn: true, stSlope: -2 } },
    }), { rsRank: 80, sectorRsRank: 50, marketHealth: 60 }).components.fourHourTiming;
    const flatBear = computeInvestorScore(td({
      tf_tech: { D: { stDir: -1 }, W: { stDir: -1 }, "4H": { stDir: 1, stSlope: 0 } },
    }), { rsRank: 80, sectorRsRank: 50, marketHealth: 60 }).components.fourHourTiming;
    expect(slopeDown).toBeLessThan(flatBear);
    expect(flatBear).toBe(0);
  });
});

describe("classifyInvestorStage integration", () => {
  it("does not emit accumulate when 4H ST is sloping down", () => {
    const stage = classifyInvestorStage(
      td({ tf_tech: { D: { stDir: -1 }, W: { stDir: -1, atr: { xs: 1 } }, "4H": { stDir: 1, stSlopeDn: true, stSlope: -2 } } }),
      72,
      null,
      { rsRank: 90, marketHealth: 60, cfg: DEFAULT_INVESTOR_CONFIG },
    );
    expect(stage.stage).not.toBe("accumulate");
  });

  it("may emit accumulate when 4H ST is bearish but flat", () => {
    const stage = classifyInvestorStage(
      td({ tf_tech: { D: { stDir: -1 }, W: { stDir: -1, atr: { xs: 1 } }, "4H": { stDir: 1, stSlope: 0 } } }),
      72,
      null,
      { rsRank: 90, marketHealth: 60, cfg: DEFAULT_INVESTOR_CONFIG },
    );
    expect(stage.stage).toBe("accumulate");
  });
});
