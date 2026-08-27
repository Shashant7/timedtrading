import { describe, expect, it } from "vitest";
import {
  buildIndexTrendLetfPlay,
  buildIndexTrendManagement,
  buildIndexTrendSection,
  shouldActivateIndexTrendLetf,
} from "./index-trend-letf.js";

describe("index-trend-letf", () => {
  it("activates LONG trend on FSD rally + RIDE", () => {
    const gate = shouldActivateIndexTrendLetf({
      ticker: "SPY",
      verdict: { mode: "RIDE", side: "LONG", timing: { fsd_macro: { rally_active: true } } },
      fsdMacro: { rally_active: true },
    });
    expect(gate.activate).toBe(true);
    expect(gate.direction).toBe("LONG");
  });

  it("suppresses in chop regime", () => {
    const gate = shouldActivateIndexTrendLetf({
      ticker: "SPY",
      verdict: {
        mode: "WAIT",
        side: "NEUTRAL",
        timing: { compression_score: 62 },
      },
    });
    expect(gate.activate).toBe(false);
    expect(gate.reason).toBe("chop_regime_letf_decay");
  });

  it("builds SPYU play with trim/DCA management", () => {
    const play = buildIndexTrendLetfPlay({
      ticker: "SPY",
      price: 550,
      fsd_macro: { rally_active: true, spx_target: { low: 7900, high: 8000 } },
      verdict: {
        mode: "RIDE",
        side: "LONG",
        timing: { fsd_macro: { rally_active: true }, signals: ["fsd_rally_window"] },
      },
      tickerData: { state: "HTF_BULL_LTF_BULL", htf_score: 18 },
    });
    expect(play).not.toBeNull();
    expect(play._index_trend).toBe(true);
    expect(play._not_day_trade).toBe(true);
    expect(play.letf_ticker).toBe("SPYU");
    expect(play.management.trim_ladder.length).toBeGreaterThan(0);
    expect(play.management.dca_on_dip).toBe(true);
  });

  it("buildIndexTrendSection returns plays separate from day trade", () => {
    const section = buildIndexTrendSection(
      [{ ticker: "SPY", price: 550, state: "HTF_BULL_LTF_BULL", fsd_macro: { rally_active: true } }],
      {
        pricesMap: { SPY: { p: 550 } },
        fsdMacro: { rally_active: true },
        scoreConfluence: () => ({
          mode: "RIDE",
          side: "LONG",
          timing: { fsd_macro: { rally_active: true }, signals: ["fsd_rally_window"] },
        }),
      },
    );
    expect(section.index_trend_count).toBeGreaterThanOrEqual(1);
    expect(section.index_trend_plays[0].letf_ticker).toBe("SPYU");
    expect(section.index_trend_plays[0].play._not_day_trade).toBe(true);
  });

  it("management stamps wider stop than day-trade premium logic", () => {
    const mgmt = buildIndexTrendManagement({
      direction: "LONG",
      price: 500,
      atrPct: 0.01,
      fsdMacro: { target_deadline_ms: Date.UTC(2026, 7, 31) },
    });
    expect(mgmt.stop_underlying).toBeLessThan(500);
    expect(mgmt.trim_ladder[0].at_r).toBe(1);
  });
});
