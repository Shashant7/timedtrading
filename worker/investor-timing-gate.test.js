import { describe, it, expect } from "vitest";
import {
  applyInvestorTimingGate,
  classifyInvestorStage,
  revalidateInvestorTickerAtRead,
  DEFAULT_INVESTOR_CONFIG,
} from "./investor.js";
import { computeTimingOverlay } from "./timing-signals.js";

describe("applyInvestorTimingGate", () => {
  const cfg = DEFAULT_INVESTOR_CONFIG;

  it("blocks new accumulate at TIME_TOP", () => {
    const out = applyInvestorTimingGate(
      { stage: "accumulate", reason: "strong_score" },
      { timing_primary: "TOP", playbook: "TIME_TOP", extension_score: 66 },
      { existingPosition: null, investorScore: 75, cfg },
    );
    expect(out.stage).toBe("watch");
    expect(out.reason).toMatch(/timing_top_block_new_entry/);
    expect(out.timing_primary).toBe("TOP");
  });

  it("downgrades core_hold to watch at TIME_TOP for owned positions", () => {
    const out = applyInvestorTimingGate(
      { stage: "core_hold", reason: "trends_intact" },
      { timing_primary: "TOP", playbook: "TIME_TOP" },
      { existingPosition: { status: "OPEN" }, investorScore: 72, cfg },
    );
    expect(out.stage).toBe("watch");
    expect(out.reason).toMatch(/timing_top_hold_no_adds/);
  });

  it("boosts watch to accumulate at TIME_BOTTOM", () => {
    const out = applyInvestorTimingGate(
      { stage: "watch", reason: "promising" },
      { timing_primary: "BOTTOM", playbook: "TIME_BOTTOM", add_on_dips: true, compression_score: 58 },
      {
        existingPosition: null,
        investorScore: 62,
        marketHealth: 50,
        accumZone: { inZone: true, zoneType: "oversold_bounce" },
        cfg,
      },
    );
    expect(out.stage).toBe("accumulate");
    expect(out.reason).toMatch(/timing_bottom_accumulate_on_dips/);
    expect(out.timing_primary).toBe("BOTTOM");
  });

  it("does not override thesis-breaking reduce", () => {
    const out = applyInvestorTimingGate(
      { stage: "reduce", reason: "monthly_supertrend_bearish" },
      { timing_primary: "BOTTOM", playbook: "TIME_BOTTOM" },
      { existingPosition: { status: "OPEN" }, investorScore: 20, cfg },
    );
    expect(out.stage).toBe("reduce");
  });
});

describe("revalidateInvestorTickerAtRead", () => {
  it("overrides stale accumulate cache when TIME_TOP is live", () => {
    const cached = {
      ticker: "SPY",
      score: 59,
      stage: "accumulate",
      stageReason: "momentum_runner",
      rsRank: 55,
      position: { owned: false },
      actionTier: "act_now",
    };
    const latestTd = {
      ticker: "SPY",
      price: 737.55,
      monthly_bundle: { supertrend_dir: -1, ema_structure: 1, rsi: 75 },
      tf_tech: {
        D: { atr: { xs: 1 }, stDir: -1, ema: { priceAboveEma21: true }, phase: { v: 90.96, z: "HIGH" }, rsi: { r5: 78 } },
        W: { atr: { xs: 1 }, rsi: { r5: 72 } },
      },
      td_sequential: { per_tf: { D: { bearish_prep_count: 8 }, W: { bearish_prep_count: 8 } } },
      regime_forecast: { p_1d: { HTF_BEAR_LTF_BEAR: 0.6, HTF_BULL_LTF_BULL: 0.1 } },
      regime_exhausted: { sigma_above_mean: 23.4 },
      _vix: 19.65,
    };
    const accumZone = { inZone: true, zoneType: "momentum_runner", confidence: 74 };
    const { revalidated, data } = revalidateInvestorTickerAtRead(cached, latestTd, {
      rsRank: 55,
      marketHealth: 50,
      cfg: DEFAULT_INVESTOR_CONFIG,
    });
    expect(revalidated).toBe(true);
    expect(data.stage).toBe("watch");
    expect(data.stageReason).toMatch(/timing_top/);
    expect(data.timing_primary).toBe("TOP");
    expect(data._stage_changed_from_cache?.stage).toBe("accumulate");
    expect(computeTimingOverlay(latestTd).timing_primary).toBe("TOP");
  });
});

describe("classifyInvestorStage + timing overlay", () => {
  it("blocks strong_score accumulate when timing_overlay is TIME_TOP", () => {
    const td = {
      ticker: "SPY",
      price: 500,
      monthly_bundle: { supertrend_dir: -1, ema_structure: 1 },
      tf_tech: { W: { atr: { xs: 1 } }, D: {} },
      timing_overlay: {
        bias: "EXTENSION",
        timing_primary: "TOP",
        playbook: "TIME_TOP",
        extension_score: 66,
        compression_score: 10,
        posture: "RISK_OFF",
      },
    };
    const stage = classifyInvestorStage(td, 78, null, {
      rsRank: 60,
      marketHealth: 55,
      accumZone: { inZone: false },
      cfg: DEFAULT_INVESTOR_CONFIG,
    });
    expect(stage.stage).toBe("watch");
    expect(stage.reason).toMatch(/timing_top_block_new_entry/);
  });
});
