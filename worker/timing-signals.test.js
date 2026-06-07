import { describe, it, expect } from "vitest";
import {
  detectExhaustionWarnings,
  detectCompressionSignals,
  computeTimingOverlay,
  applyTimingOverlayToConfluence,
  evaluateBroadIndexExtensionWatch,
  evaluateBroadIndexCompressionWatch,
  bearishTdPrepCount,
  bullishTdPrepCount,
} from "./timing-signals.js";

describe("detectExhaustionWarnings — per_tf TD9 path", () => {
  it("reads daily and weekly bearish prep from per_tf", () => {
    const warnings = detectExhaustionWarnings({
      td_sequential: {
        per_tf: {
          D: { bearish_prep_count: 8, td9_bearish: false },
          W: { bearish_prep_count: 9, td9_bearish: true },
        },
      },
      tf_tech: { D: { phase: { v: 135, z: "EXTREME" } } },
      regime_forecast: {
        p_1d: { HTF_BEAR_LTF_BEAR: 0.55, HTF_BULL_LTF_BULL: 0.15 },
      },
      _vix: 26,
    });
    expect(warnings).toContain("daily_td9_at_8");
    expect(warnings).toContain("weekly_td9_at_9");
    expect(warnings).toContain("weekly_td9_sell_complete");
    expect(warnings).toContain("daily_phase_extreme_135");
    expect(warnings).toContain("markov_1d_bearish");
    expect(warnings).toContain("vix_elevated_26.0");
  });
});

describe("computeTimingOverlay", () => {
  it("flags dump watch on stacked extension signals", () => {
    const overlay = computeTimingOverlay({
      ticker: "SPY",
      td_sequential: {
        per_tf: {
          D: { bearish_prep_count: 9, td9_bearish: true },
          W: { bearish_prep_count: 8 },
        },
      },
      tf_tech: {
        D: { phase: { v: 140, z: "EXTREME" }, rsi: { r5: 78 }, pdz: { zone: "premium" } },
        W: { rsi: { r5: 86 } },
      },
      regime_forecast: { p_1d: { HTF_BEAR_LTF_BEAR: 0.6, HTF_BULL_LTF_BULL: 0.1 } },
      _vix: 28,
      mean_revert_td9: { active: true, side: "SHORT" },
    });
    expect(overlay.posture).toBe("DUMP_WATCH");
    expect(overlay.trim_winners).toBe(true);
    expect(overlay.short_opportunity).toBe(true);
    expect(overlay.extension_score).toBeGreaterThanOrEqual(70);
  });
});

describe("applyTimingOverlayToConfluence", () => {
  it("elevates WAIT+LONG split to FADE SHORT on index extension", () => {
    const conf = {
      mode: "WAIT",
      side: "LONG",
      wait: true,
      long_agree: 4,
      short_agree: 1,
      score: 22,
      supertrend_trigger: { side: "SHORT", triggered: true },
      actionable_summary: "WAIT",
    };
    const overlay = {
      bias: "EXTENSION",
      extension_score: 62,
      compression_score: 10,
      posture: "RISK_OFF",
      short_opportunity: true,
      put_opportunity: true,
      trim_winners: true,
      td9_complete: true,
      flash_detail: "TD9 sell setup complete",
      timing_primary: "TOP",
      playbook: "TIME_TOP",
    };
    const out = applyTimingOverlayToConfluence(conf, overlay, { ticker: "SPY", trigger_dir: "SHORT" });
    expect(out.mode).toBe("FADE");
    expect(out.side).toBe("SHORT");
    expect(out.put_timing).toBe(true);
    expect(out.timing_override).toBe("extension_fade_short");
  });
});

describe("evaluateBroadIndexExtensionWatch", () => {
  it("activates when 3+ indexes are stretched", () => {
    const mk = (score, posture = "RISK_OFF") => ({
      timing_overlay: { extension_score: score, posture },
    });
    const mkLow = () => ({ timing_overlay: { extension_score: 20, posture: "RISK_ON" } });
    const watch = evaluateBroadIndexExtensionWatch({
      SPY: mk(58),
      QQQ: mk(55),
      IWM: mk(52),
      DIA: mkLow(),
    });
    expect(watch.active).toBe(true);
    expect(watch.breadth).toBe(3);
    expect(watch.headline).toMatch(/INDEX EXTENSION WATCH/i);
  });
});

describe("bearishTdPrepCount", () => {
  it("returns 9 when td9_bearish flag set", () => {
    expect(bearishTdPrepCount({
      td_sequential: { per_tf: { D: { td9_bearish: true, bearish_prep_count: 9 } } },
    }, "D")).toBe(9);
  });
});

describe("fsd / macro risk-off hint", () => {
  it("flags broad index ETFs when active playbook risks are elevated", () => {
    const warnings = detectExhaustionWarnings({
      ticker: "SPY",
      td_sequential: { per_tf: { D: { bearish_prep_count: 6 } } },
    });
    expect(warnings).toContain("fsd_macro_risk_off");
  });
});

describe("detectCompressionSignals — per_tf TD9 buy path", () => {
  it("reads daily and weekly bullish prep from per_tf", () => {
    const signals = detectCompressionSignals({
      td_sequential: {
        per_tf: {
          D: { bullish_prep_count: 8, td9_bullish: false },
          W: { bullish_prep_count: 9, td9_bullish: true },
        },
      },
      tf_tech: { D: { phase: { v: -135, z: "EXTREME" }, rsi: { r5: 28 } } },
      regime_forecast: {
        p_1d: { HTF_BULL_LTF_BULL: 0.55, HTF_BEAR_LTF_BEAR: 0.15 },
      },
      ticker: "SPY",
    });
    expect(signals).toContain("daily_td9_buy_at_8");
    expect(signals).toContain("weekly_td9_buy_at_9");
    expect(signals).toContain("weekly_td9_buy_complete");
    expect(signals).toContain("markov_1d_bullish");
    expect(signals).toContain("fsd_macro_risk_on");
  });
});

describe("computeTimingOverlay — compression side", () => {
  it("flags rally watch on stacked capitulation signals", () => {
    const overlay = computeTimingOverlay({
      ticker: "SPY",
      td_sequential: {
        per_tf: {
          D: { bullish_prep_count: 9, td9_bullish: true },
          W: { bullish_prep_count: 8 },
        },
      },
      tf_tech: {
        D: { phase: { v: -140, z: "EXTREME" }, rsi: { r5: 25 }, pdz: { zone: "discount" } },
        W: { rsi: { r5: 30 } },
      },
      regime_forecast: { p_1d: { HTF_BULL_LTF_BULL: 0.6, HTF_BEAR_LTF_BEAR: 0.1 } },
      _vix: 28,
      mean_revert_td9: { active: true, side: "LONG" },
    });
    expect(overlay.bias).toBe("COMPRESSION");
    expect(overlay.posture).toBe("RALLY_WATCH");
    expect(overlay.add_on_dips).toBe(true);
    expect(overlay.long_opportunity).toBe(true);
    expect(overlay.timing_primary).toBe("BOTTOM");
    expect(overlay.playbook).toBe("TIME_BOTTOM");
  });
});

describe("applyTimingOverlayToConfluence — trend catch suppressed at top", () => {
  it("overrides RIDE LONG to TIME THE TOP fade short", () => {
    const conf = {
      mode: "RIDE",
      side: "LONG",
      ride: true,
      wait: false,
      long_agree: 6,
      short_agree: 1,
      score: 78,
      supertrend_trigger: { side: "LONG", triggered: true },
      actionable_summary: "RIDE LONG",
    };
    const overlay = {
      bias: "EXTENSION",
      extension_score: 68,
      compression_score: 10,
      posture: "RISK_OFF",
      short_opportunity: true,
      put_opportunity: true,
      trim_winners: true,
      td9_complete: true,
      flash_detail: "TD9 sell prep building",
      playbook: "TIME_TOP",
      timing_primary: "TOP",
    };
    const out = applyTimingOverlayToConfluence(conf, overlay, { ticker: "SPY", trigger_dir: "SHORT" });
    expect(out.mode).toBe("FADE");
    expect(out.side).toBe("SHORT");
    expect(out.timing_override).toBe("timing_top_overrides_trend");
    expect(out.trend_catch_suppressed).toBe(true);
    expect(out.playbook).toBe("TIME_TOP");
    expect(out.actionable_summary).toMatch(/TIME THE TOP/i);
  });

  it("labels RIDE as trend catch when timing is neutral", () => {
    const conf = {
      mode: "RIDE",
      side: "LONG",
      ride: true,
      wait: false,
      long_agree: 6,
      short_agree: 1,
      score: 78,
      supertrend_trigger: { side: "LONG", triggered: true },
      actionable_summary: "RIDE LONG — confluence 78/100",
    };
    const overlay = {
      bias: "NEUTRAL",
      extension_score: 20,
      compression_score: 15,
      posture: "RISK_ON",
      short_opportunity: false,
      long_opportunity: false,
      playbook: "NEUTRAL",
      timing_primary: null,
    };
    const out = applyTimingOverlayToConfluence(conf, overlay, { ticker: "AAPL" });
    expect(out.mode).toBe("RIDE");
    expect(out.trend_catch).toBe(true);
    expect(out.playbook).toBe("TREND_CATCH");
  });
});

describe("evaluateBroadIndexCompressionWatch", () => {
  it("activates when 3+ indexes are compressed", () => {
    const mk = (score, posture = "RISK_ON_BUY") => ({
      timing_overlay: { compression_score: score, posture, bias: "COMPRESSION" },
    });
    const watch = evaluateBroadIndexCompressionWatch({
      SPY: mk(58),
      QQQ: mk(55),
      IWM: mk(52),
      DIA: { timing_overlay: { compression_score: 20, posture: "NEUTRAL" } },
    });
    expect(watch.active).toBe(true);
    expect(watch.breadth).toBe(3);
    expect(watch.headline).toMatch(/INDEX COMPRESSION WATCH/i);
  });
});

describe("bullishTdPrepCount", () => {
  it("returns 9 when td9_bullish flag set", () => {
    expect(bullishTdPrepCount({
      td_sequential: { per_tf: { D: { td9_bullish: true, bullish_prep_count: 9 } } },
    }, "D")).toBe(9);
  });
});
