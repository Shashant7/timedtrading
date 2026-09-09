import { describe, expect, it, vi } from "vitest";
import { createTechnicalRanker, RANK_DRIVER_VERSION } from "./technical-rank.js";
import { rankCompletion, triggerRankSummary, supertrendRankDirection, tdSequentialRankContribution } from "./rank-drivers.js";
import { detectFlags, computeTDSequential, computeTDSequentialMultiTF } from "../indicators.js";
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
      expect(delta({ td_sequential: { boost: 8, tf: "D" } }, side)).toBe(0);
      expect(delta({ td_sequential: { boost: 8, tf: "D", boost_side: side } }, side)).toBe(8);
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

  it("does not award either formula points for stronger opposing HTF evidence", () => {
    for (const formula of ["v1", "v2"]) for (const side of ["LONG", "SHORT"]) {
      for (const magnitude of [5, 15, 25, 40]) {
        const d = payload(side, { htf_score: magnitude * (side === "LONG" ? -1 : 1),
          _env: { _deepAuditConfig: { deep_audit_rank_formula: formula } } });
        score(d);
        const parts = d.__rank_trace.parts.filter(p => p.label.includes("htf_") && !p.label.includes("divergence"));
        expect(parts.reduce((s, p) => s + p.delta, 0)).toBe(0);
        expect(parts.some(p => p.role === "opposed_strength")).toBe(true);
      }
    }
  });

  it("requires the scored state to describe the actual candidate side", () => {
    for (const formula of ["v1", "v2"]) {
      const d = payload("SHORT", { swing_consensus: { direction: "LONG" },
        _env: { _deepAuditConfig: { deep_audit_rank_formula: formula } } });
      score(d);
      expect(d.__rank_trace.side).toBe("LONG");
      expect(d.__rank_trace.parts.some(p => p.label.endsWith("aligned_state"))).toBe(false);
      expect(d.__rank_trace.parts.find(p => p.label.endsWith("state_context")).delta).toBe(0);
    }
  });

  it("labels intentional pullback depth and suppresses unrelated opposing LTF strength", () => {
    for (const formula of ["v1", "v2"]) {
      const env = { _deepAuditConfig: { deep_audit_rank_formula: formula } };
      const pullback = payload("LONG", { state: "HTF_BULL_LTF_PULLBACK", htf_score: 25, ltf_score: -20, _env: env });
      const opposed = payload("LONG", { htf_score: 25, ltf_score: -20, _env: env });
      score(pullback); score(opposed);
      const p = pullback.__rank_trace.parts.filter(p => p.role === "pullback_depth");
      expect(p).toHaveLength(1);
      expect(p[0].delta).toBe(formula === "v2" ? 8 : 6);
      expect(opposed.__rank_trace.parts.filter(p => p.role === "opposed_strength").every(p => p.delta === 0)).toBe(true);
    }
  });

  it("uses candidate side for the HMM multiplier and clears obsolete attribution", () => {
    const d = payload("SHORT", { state: "HTF_BEAR_LTF_PULLBACK", htf_score: -20, ltf_score: 15,
      latent_regime: { state: "BEAR_TREND", posterior: { BEAR_TREND: 0.8, BULL_TREND: 0.2 } },
      _env: { _deepAuditConfig: { gates: { adaptive_scoring_v1: true } } } });
    score(d);
    expect(d.__rank_trace.side).toBe("LONG");
    expect(d.__adaptive_v1).toMatchObject({ multiplier: 0.93, candidate_side: "LONG", reason: "bull_vs_bear_macro" });
    expect(d.__rank_trace.parts.reduce((sum, p) => sum + p.delta, 0)).toBeCloseTo(d._technical_rank.raw_score, 10);
    d._env._deepAuditConfig.gates.adaptive_scoring_v1 = false;
    score(d);
    expect(d.__adaptive_v1).toBeUndefined();
    expect(d.__rank_trace.adaptive_v1).toBeNull();
  });

  it("parses adaptive numeric strings arithmetically and rejects nonnumeric overrides", () => {
    expect(delta({ completion: 0.1 }, "LONG", ranker({ getAdaptiveRankWeights: () => ({ completion_early_bonus: "11" }) }))).toBe(11);
    for (const invalid of [false, "", "bad", Infinity]) {
      expect(delta({ completion: 0.1 }, "LONG", ranker({ getAdaptiveRankWeights: () => ({ completion_early_bonus: invalid }) }))).toBe(15);
    }
    expect(delta({ completion: 0.1 }, "LONG", ranker({ getAdaptiveRankWeights: () => ({ completion_early_bonus: 0 }) }))).toBe(0);
  });

  it("requires confidence in the decoded HMM state rather than confidence in another state", () => {
    const d = payload("LONG", {
      latent_regime: { state: "BULL_TREND", posterior: { BULL_TREND: 0.2, BEAR_TREND: 0.8 } },
      _env: { _deepAuditConfig: { gates: { adaptive_scoring_v1: true } } },
    });
    expect(score(d)).toBe(score(payload("LONG")));
    expect(d.__rank_trace.adaptive_v1).toBeNull();
  });
});

describe("TD producer basis and ranking", () => {
  const bars = closes => closes.map((c, i) => ({ ts: i * 86400000, o: c, c, h: c + 2, l: c - 2, v: 1000 }));
  const bullSetup = bars([20, 20, 20, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11]);

  it("preserves the producer's boost while recomputing it for an opposing candidate", () => {
    const td = computeTDSequential(bullSetup, "D", { htfBull: true });
    expect(td).toMatchObject({ td9_bullish: true, boost: 5, boost_side: "LONG" });
    expect(delta({ td_sequential: td }, "LONG")).toBe(5);
    expect(delta({ td_sequential: td }, "SHORT")).toBe(-5);
    expect(td.boost).toBe(5); // rank must not change the shared indicator payload
  });

  it("recomputes approach bonuses instead of naively negating a producer's score", () => {
    // Keep enough warmup bars for the producer while ending at prep count 7.
    const candles = bars([20, 20, 20, ...bullSetup.slice(0, -2).map(b => b.c)]);
    const td = computeTDSequential(candles, "D", { htfBull: true });
    expect(td.bullish_prep_count).toBe(7);
    expect(td.boost).toBe(2);
    expect(delta({ td_sequential: td }, "SHORT")).toBe(0);
  });

  it("matches the real multi-TF producer in the candidate direction across varied candle sequences", () => {
    for (const slope of [-1, 1]) for (const count of [14, 19, 35, 60]) {
      const candles = bars(Array.from({ length: count }, (_, i) => 100 + slope * i + Math.sin(i * 0.7) * 3));
      const byTf = { D: candles, W: candles.slice(0, -1), M: candles.slice(0, -2), "30": candles };
      const fromBull = computeTDSequentialMultiTF(byTf, true);
      const fromBear = computeTDSequentialMultiTF(byTf, false);
      expect(tdSequentialRankContribution(fromBull, "LONG").delta).toBe(fromBull.boost);
      expect(tdSequentialRankContribution(fromBull, "SHORT").delta).toBe(fromBear.boost);
      expect(tdSequentialRankContribution(fromBear, "LONG").delta).toBe(fromBull.boost);
    }
  });

  it("does not award an aggregate-only or malformed TD boost without compatible evidence", () => {
    expect(delta({ td_sequential: { tf: "D", boost: 12, boost_side: "SHORT" } }, "LONG")).toBe(0);
    expect(delta({ td_sequential: { tf: "D", boost: 12, per_tf: { D: { td9_bullish: "false" } } } })).toBe(0);
    expect(delta({ td_sequential: { tf: "30", boost: 12, boost_side: "LONG" } })).toBe(0);
  });
});
