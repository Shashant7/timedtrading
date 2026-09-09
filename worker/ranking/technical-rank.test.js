import { describe, expect, it, vi } from "vitest";
import { createTechnicalRanker, RANK_DRIVER_VERSION } from "./technical-rank.js";
import { rankCompletion, triggerRankSummary, supertrendRankDirection } from "./rank-drivers.js";
import { detectFlags } from "../indicators.js";
import { inferSide } from "../pipeline/trade-context.js";
import { computeCandidateScore } from "./candidate-rank.js";

// Neutral dependencies isolate driver effects without reproducing the formula.
// computeRank, inferSide and detectFlags are the actual production functions.
const resolveSide = d => inferSide(d, String(d.state || ""));
function ranker(extra = {}) {
  return createTechnicalRanker({
    sideFromStateOrScores: resolveSide, computeRR: () => null,
    computeDataCompleteness: () => ({ score: 100 }),
    tfTechAlignmentSummary: () => null, computeMoveStatus: () => ({ status: "ACTIVE" }),
    sectorMap: { OIL: "Energy", BANK: "Financials", COIN: "Crypto" }, ...extra,
  }).computeRank;
}
function payload(side = "LONG", extra = {}) {
  return { ticker: "TEST", state: side === "LONG" ? "HTF_BULL_LTF_BULL" : "HTF_BEAR_LTF_BEAR",
    htf_score: 0, ltf_score: 0, completion: 0.8, phase_pct: 0.4, rr: 1,
    flags: {}, triggers: [], ...extra };
}
function score(d, fn = ranker()) {
  d.rank = fn(d);
  return d._technical_rank.raw_score;
}
function delta(extra, side = "LONG", fn = ranker()) {
  return score(payload(side, extra), fn) - score(payload(side), fn);
}
const v2 = extra => ({ _env: { _deepAuditConfig: { deep_audit_rank_formula: "v2" } }, ...extra });

describe("technical rank input semantics", () => {
  it("does not award early-completion or phase bonuses for missing/invalid evidence", () => {
    for (const value of [undefined, null, "", " ", false, NaN, Infinity, -0.1, 2]) {
      expect(delta({ completion: value, phase_pct: value })).toBe(0);
    }
    expect(delta({ completion: 0, phase_pct: 0 })).toBe(18);
    expect(delta({ completion: "0.1", phase_pct: "0.2" })).toBe(18);
  });

  it("derives completion only from valid observed prices and preserves sizing independence", () => {
    expect(rankCompletion({ price: 100, trigger_price: 100, tp: 110 })).toBe(0);
    expect(rankCompletion({ price: 98, trigger_price: 100, tp: 90 })).toBe(0.2);
    for (const d of [{}, { price: 0, trigger_price: 100, tp: 110 },
      { price: 100, trigger_price: 100, tp: 100 },
      { completion: false, price: 100, trigger_price: 100, tp: 110 }]) {
      expect(rankCompletion(d)).toBeNull();
    }
    expect(delta({ completion: null, price: 100, trigger_price: 100, tp: 110 })).toBe(15);
  });

  it("does not interpret string false as a squeeze or momentum event", () => {
    expect(delta({ flags: { sq30_on: "false", momentum_elite: "false", momentum_elite_dir: "LONG" } })).toBe(0);
  });

  it("gives RSI divergence the candidate's sign and a monotonic strength effect", () => {
    for (const side of ["LONG", "SHORT"]) {
      const aligned = side === "LONG" ? "bullish" : "bearish";
      const opposed = side === "LONG" ? "bearish" : "bullish";
      expect(delta({ rsi: { divergence: { type: aligned, strength: 20 } } }, side)).toBe(5);
      expect(delta({ rsi: { divergence: { type: opposed, strength: 0 } } }, side)).toBe(-3);
      expect(delta({ rsi: { divergence: { type: opposed, strength: 20 } } }, side)).toBe(-5);
      expect(delta({ rsi: { divergence: { type: aligned, strength: 20, active: false } } }, side)).toBe(0);
    }
  });

  it("only rewards recognized breakouts in the candidate direction", () => {
    for (const side of ["LONG", "SHORT"]) {
      for (const [type, weight] of [["daily_level", 20], ["atr_breakout", 15], ["ema_stack", 12]]) {
        expect(delta({ breakout: { type, dir: side } }, side)).toBe(weight);
        expect(delta({ breakout: { type, dir: side === "LONG" ? "SHORT" : "LONG" } }, side)).toBe(0);
        expect(delta({ breakout: { type } }, side)).toBe(0);
      }
      expect(delta({ breakout: { type: "unrecognized", dir: side } }, side)).toBe(0);
    }
  });

  it("requires strong same-direction momentum from the real producer", () => {
    const bundles = { "30": { mom: -3, momStd: 1 }, "10": { mom: -2, momStd: 1 } };
    const bearish = detectFlags(bundles);
    expect(bearish.momentum_elite).toBe(true);
    expect(delta({ flags: bearish }, "LONG")).toBe(0);
    expect(delta({ flags: bearish }, "SHORT")).toBe(15);
    const mixed = detectFlags({ ...bundles, "10": { mom: 2, momStd: 1 } });
    expect(mixed.momentum_elite).toBe(true); // other consumers retain the legacy flag
    expect(mixed.momentum_elite_dir).toBeUndefined();
    expect(delta({ flags: mixed })).toBe(0);
    expect(delta({ flags: { momentum_elite: true } })).toBe(0);
  });

  it("does not reward the EXTREME-zone flag as a favorable transition", () => {
    const flags = detectFlags({ "30": { phaseZone: "EXTREME" } });
    expect(flags.phase_zone_change).toBe(true);
    expect(delta({ flags })).toBe(0);
  });

  it("counts named EMA/dip events once and ignores stale summary scores", () => {
    for (const [flag, trigger, weight] of [
      ["ema_cross_1h_13_48", "EMA_CROSS_1H_13_48_BULL", 2],
      ["buyable_dip_1h_13_48", "BUYABLE_DIP_1H_13_48_LONG", 3],
    ]) {
      const flags = { [flag]: true, [flag + "_dir"]: "LONG" };
      expect(delta({ flags, triggers: [trigger, trigger], trigger_summary: { score: 12, side: "SHORT" } })).toBe(weight);
      expect(delta({ flags })).toBe(weight);
      expect(delta({ flags, triggers: [trigger] }, "SHORT")).toBe(-weight);
    }
  });

  it("does not arbitrarily pick the favorable side of contradictory named triggers", () => {
    const triggers = ["EMA_CROSS_1H_13_48_BULL", "EMA_CROSS_1H_13_48_BEAR"];
    for (const side of ["LONG", "SHORT"]) expect(delta({ triggers }, side)).toBe(0);
    expect(triggerRankSummary({ triggers }, "LONG").parts[0].reason).toBe("conflicting_direction");
    expect(delta({ triggers: ["EMA_CROSS_1H_13_48_BULL"],
      flags: { ema_cross_1h_13_48: true, ema_cross_1h_13_48_dir: "SHORT" } })).toBe(0);
  });

  it("counts squeeze release once in both aligned and pullback setups", () => {
    const flags = detectFlags({ "30": { sqRelease: true, mom: 2 } });
    for (const state of ["HTF_BULL_LTF_BULL", "HTF_BULL_LTF_PULLBACK"]) {
      const base = score(payload("LONG", { state }));
      expect(score(payload("LONG", { state, flags, triggers: ["SQUEEZE_RELEASE_30M"] })) - base).toBe(2);
    }
    expect(delta({ flags }, "SHORT")).toBe(-2);
    expect(delta({ flags: { sq30_release: true } })).toBe(0);
  });

  it("reads EMA and SuperTrend flip direction from producer metadata", () => {
    const flags = detectFlags({ "60": { emaCross13_48_dn: true, stFlip: true, stFlipDir: -1 } });
    expect(delta({ flags }, "LONG")).toBe(-3);
    expect(delta({ flags }, "SHORT")).toBe(3);
    expect(delta({ triggers: ["ST_FLIP_1H"], tf_tech: { "1H": { stDir: -1 } } })).toBe(1);
  });

  it("neutralizes fixed sector priors and unknown TD timeframes", () => {
    for (const side of ["LONG", "SHORT"]) {
      for (const ticker of ["OIL", "BANK", "COIN"]) expect(delta({ ticker }, side)).toBe(0);
      expect(delta({ td_sequential: { boost: 8 } }, side)).toBe(0);
      expect(delta({ td_sequential: { boost: 8, tf: "30" } }, side)).toBe(0);
      expect(delta({ td_sequential: { boost: 8, tf: "D" } }, side)).toBe(8);
    }
  });

  it("does not penalize missing ORB day bias", () => {
    expect(delta({ orb: { primary: { resolved: true } } })).toBe(0);
  });

  it("retains component traces before entry without enabling diagnostic logs", () => {
    const logTrace = vi.fn();
    const d = payload("SHORT", { flags: { momentum_elite: true }, breakout: { type: "daily_level", dir: "LONG" } });
    score(d, ranker({ logTrace }));
    expect(logTrace).not.toHaveBeenCalled();
    expect(d.__rank_trace).toMatchObject({ formula: "v1", side: "SHORT", driver_version: RANK_DRIVER_VERSION });
    expect(d.__rank_trace.parts.reduce((sum, p) => sum + p.delta, 0)).toBe(d._technical_rank.raw_score);
    expect(d.__rank_trace.parts.find(p => p.label === "momentum_elite").reason).toBe("missing_direction");
  });

  it("retains caps, adaptive weights and distinct squeeze-on context", () => {
    const fn = ranker({ getAdaptiveRankWeights: () => ({ completion_early_bonus: 11, momentum_elite_bonus: 7 }) });
    expect(delta({ completion: 0.1 }, "LONG", fn)).toBe(11);
    expect(delta({ flags: { momentum_elite: true, momentum_elite_dir: "LONG" } }, "LONG", fn)).toBe(7);
    expect(delta({ flags: { sq30_on: true } })).toBe(5);
  });
});

describe("v2 driver semantics", () => {
  const diff = (extra, side = "LONG") => score(payload(side, v2(extra))) - score(payload(side, v2({})));
  it("decodes Pine SuperTrend but retires the bonus whose calibration used its sign backwards", () => {
    for (const shape of [{ tf_tech: { "30": { stDir: -1 } } }, { supertrend: { "30": { d: -1 } } }]) {
      expect(supertrendRankDirection(shape, "30")).toBe("LONG");
      expect(diff(shape, "LONG")).toBe(0);
      expect(diff(shape, "SHORT")).toBe(0);
    }
  });
  it("does not reward inactive or conflicting RSI evidence", () => {
    expect(diff({ rsi_divergence: { type: "bullish", active: false } })).toBe(0);
    expect(diff({ rsi_divergence: { D: { bull: { active: true }, bear: { active: true } } } })).toBe(0);
    expect(diff({ rsi_divergence: { D: { bull: { active: true } } } })).toBe(8);
  });
  it("penalizes phase extension in the candidate direction once per timeframe", () => {
    expect(diff({ saty_phase: { "1H": { v: 80, z: "HIGH" } } }, "LONG")).toBe(-8);
    expect(diff({ saty_phase: { "1H": { v: -80, z: "HIGH" } } }, "SHORT")).toBe(-8);
    expect(diff({ saty_phase: { "1H": { v: -80, z: "HIGH" } } }, "LONG")).toBe(0);
    expect(diff({ saty_phase: { "1H": { z: "HIGH" } } })).toBe(0);
  });
  it("does not let post-rank qualification grade increase its own input rank", () => {
    expect(diff({ setup_grade: "Confirmed" })).toBe(0);
    expect(diff({ __setup_grade: "Prime" })).toBe(0);
  });
  it("separates unknown macro data from observed lack of a SPY downtrend", () => {
    expect(diff({ _spyData: { daily_structure: {} } }, "SHORT")).toBe(0);
    expect(diff({ _spyData: { daily_structure: { close_below_e21: false,
      e21_slope_5bar_pct: 0.1, ema_regime_daily: 1 } } }, "SHORT")).toBe(-8);
  });
});

describe("direction agreement across technical rank and overlays", () => {
  it("uses the live candidate direction for a turn against the prior HTF bias", () => {
    const d = payload("SHORT", { state: "HTF_BEAR_LTF_PULLBACK", htf_score: -20, ltf_score: 15,
      _fair_value: { tilt: 4, tilt_enabled: true } });
    score(d);
    expect(d.__rank_trace.side).toBe("LONG");
    expect(computeCandidateScore(d, { resolveSide })).toBe(d._technical_rank.raw_score + 4);
  });
});
