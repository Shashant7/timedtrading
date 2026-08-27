import { describe, expect, it } from "vitest";
import {
  EXECUTION_LETF_SYMBOLS,
  getLetfFactor,
  pickPreferredLetfTicker,
  resolveLetfHorizon,
  scoreLetfSuitability,
  resolvePlayPrefs,
  TREND_LETF_PLAY_PREFS,
  DEFAULT_PLAY_PREFS,
} from "./letf-vehicles.js";

const SPY_LETF = {
  long: "SPXL",
  short: "SPXS",
  long_alts: ["SPYU"],
  short_alts: ["SPXU"],
  factor: 3,
  note: "Direxion 3× S&P 500",
};

describe("letf-vehicles", () => {
  it("includes index and single-name execution symbols", () => {
    expect(EXECUTION_LETF_SYMBOLS).toContain("SPYU");
    expect(EXECUTION_LETF_SYMBOLS).toContain("SPXU");
    expect(EXECUTION_LETF_SYMBOLS).toContain("AAPU");
    expect(EXECUTION_LETF_SYMBOLS).toContain("TQQQ");
  });

  it("getLetfFactor returns 4 for SPYU", () => {
    expect(getLetfFactor("SPYU", SPY_LETF)).toBe(4);
    expect(getLetfFactor("SPXL", SPY_LETF)).toBe(3);
  });

  it("pickPreferredLetfTicker prefers SPYU on swing FSD rally", () => {
    expect(pickPreferredLetfTicker(SPY_LETF, "LONG", {
      fsdMacro: { rally_active: true },
      horizon: "swing_trend",
    })).toBe("SPYU");
    expect(pickPreferredLetfTicker(SPY_LETF, "LONG", {
      fsdMacro: { rally_active: true },
      horizon: "day_trade",
    })).toBe("SPXL");
  });

  it("pickPreferredLetfTicker prefers SPXU on extension exhaustion swing", () => {
    expect(pickPreferredLetfTicker(SPY_LETF, "SHORT", {
      horizon: "swing_trend",
      timing: { extension_score: 58, put_opportunity: true },
    })).toBe("SPXU");
    expect(pickPreferredLetfTicker(SPY_LETF, "SHORT", {
      horizon: "day_trade",
    })).toBe("SPXS");
  });

  it("resolveLetfHorizon flags chop", () => {
    expect(resolveLetfHorizon({
      confluenceMode: "WAIT",
      timingOverlay: { compression_score: 60 },
    })).toBe("avoid_chop");
    expect(resolveLetfHorizon({ dayTradeContext: true })).toBe("day_trade");
    expect(resolveLetfHorizon({ confluenceMode: "RIDE" })).toBe("swing_trend");
  });

  it("scoreLetfSuitability boosts passive trend rider", () => {
    const s = scoreLetfSuitability({
      direction: "LONG",
      letfEntry: SPY_LETF,
      letfTicker: "SPYU",
      tickerData: { htf_score: 20, state: "HTF_BULL_LTF_BULL" },
      confluence: { mode: "RIDE", timing: { signals: ["fsd_rally_window"] } },
      fsdMacro: { rally_active: true },
      expectedMovePct: 7,
      passiveProfile: true,
    });
    expect(s.score).toBeGreaterThanOrEqual(75);
    expect(s.horizon).toBe("swing_trend");
  });

  it("resolvePlayPrefs returns trend LETF prefs only when explicitly requested", () => {
    expect(resolvePlayPrefs({ mode: "investor" })).toEqual(DEFAULT_PLAY_PREFS);
    expect(resolvePlayPrefs({ passiveLetf: true })).toEqual(TREND_LETF_PLAY_PREFS);
  });
});
