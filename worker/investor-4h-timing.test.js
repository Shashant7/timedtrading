// 4H SuperTrend + 1H EMA21 timing gate for Investor capital deployment.
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
      "4H": { stDir: -1, stSlopeUp: true, stSlope: 1, ema: { ema21: 95 } },
      "1H": { ema: { ema21: 98 } },
    },
    ...bullishMonthly,
    ...overrides,
  };
}

describe("4H timing snapshot", () => {
  it("detects bearish 4H with slope down and below 1H EMA21", () => {
    const h4 = resolveInvestor4hTiming(td({
      price: 90,
      _live_price: 90,
      tf_tech: {
        D: { stDir: -1 },
        W: { stDir: -1 },
        "4H": { stDir: 1, stSlopeDn: true, stSlope: -2 },
        "1H": { ema: { ema21: 95 } },
      },
    }));
    expect(h4.is4hBear).toBe(true);
    expect(h4.stSlopeDn).toBe(true);
    expect(h4.belowEma21_1h).toBe(true);
  });
});

describe("4H capital deployment block", () => {
  it("blocks when 4H SuperTrend is bearish (CRDO/MOD pattern)", () => {
    const block = investor4hCapitalDeploymentBlock(td({
      price: 250,
      tf_tech: {
        D: { stDir: 1 },
        W: { stDir: 1, atr: { xs: -1 } },
        "4H": { stDir: 1, stSlopeDn: true, stSlope: -3 },
        "1H": { ema: { ema21: 260 } },
      },
    }));
    expect(block).toMatchObject({ reason: "4h_supertrend_bearish_slope" });
  });

  it("blocks when price is below 1H EMA21 even if 4H is bull", () => {
    const block = investor4hCapitalDeploymentBlock(td({
      price: 90,
      _live_price: 90,
      tf_tech: {
        D: { stDir: -1 },
        W: { stDir: -1 },
        "4H": { stDir: -1, stSlopeUp: true },
        "1H": { ema: { ema21: 95 } },
      },
    }));
    expect(block).toMatchObject({ reason: "below_1h_ema21" });
  });

  it("returns null when timing is aligned", () => {
    expect(investor4hCapitalDeploymentBlock(td())).toBeNull();
  });

  it("honors disable flag", () => {
    const cfg = loadInvestorConfig({ deep_audit_investor_4h_gate_enabled: "false" });
    expect(investor4hCapitalDeploymentBlock(td({ tf_tech: { "4H": { stDir: 1, stSlopeDn: true } } }), cfg)).toBeNull();
  });
});

describe("simEligible includes 4H", () => {
  it("requires 4H bull when gate enabled", () => {
    expect(computeInvestorSimEligible(td())).toBe(true);
    expect(computeInvestorSimEligible(td({ tf_tech: { D: { stDir: -1 }, W: { stDir: -1 }, "4H": { stDir: 1 }, "1H": { ema: { ema21: 50 } } } }))).toBe(false);
  });
});

describe("stage gate", () => {
  it("downgrades accumulate to watch when 4H blocks", () => {
    const r = applyInvestor4hStageGate(
      { stage: "accumulate", reason: "strong_score" },
      td({ tf_tech: { D: { stDir: -1 }, W: { stDir: -1 }, "4H": { stDir: 1, stSlopeDn: true }, "1H": { ema: { ema21: 50 } } } }),
      { existingPosition: null, cfg: DEFAULT_INVESTOR_CONFIG },
    );
    expect(r.stage).toBe("watch");
    expect(r.reason).toContain("4h_timing_block");
  });
});

describe("score component fourHourTiming", () => {
  it("penalizes bearish 4H in the investor score", () => {
    const good = computeInvestorScore(td(), { rsRank: 80, sectorRsRank: 50, marketHealth: 60 }).components.fourHourTiming;
    const bad = computeInvestorScore(td({
      tf_tech: { D: { stDir: -1 }, W: { stDir: -1 }, "4H": { stDir: 1, stSlopeDn: true }, "1H": { ema: { ema21: 50 } } },
    }), { rsRank: 80, sectorRsRank: 50, marketHealth: 60 }).components.fourHourTiming;
    expect(bad).toBeLessThan(good);
  });
});

describe("classifyInvestorStage integration", () => {
  it("does not emit accumulate for bearish 4H on strong-score path", () => {
    const stage = classifyInvestorStage(
      td({
        tf_tech: { D: { stDir: -1 }, W: { stDir: -1, atr: { xs: 1 } }, "4H": { stDir: 1, stSlopeDn: true }, "1H": { ema: { ema21: 50 } } },
      }),
      72,
      null,
      { rsRank: 90, marketHealth: 60, cfg: DEFAULT_INVESTOR_CONFIG },
    );
    expect(stage.stage).not.toBe("accumulate");
  });
});
