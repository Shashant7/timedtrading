import { describe, expect, it } from "vitest";
import {
  buildDiagnosticsContext,
  parseTrailSnapshotRow,
  runSetupDiagnostics,
  summarizeTraderPosture,
  vixRegimeFromValue,
} from "./setup-diagnostics-route.js";
import { detectMeanReversionSequences } from "./setup-sequences.js";
import { mockSetupEvent, normalizeSetupEvents } from "./setup-events.js";

function ticker(overrides = {}) {
  return {
    ticker: "USO",
    ts: 1000,
    price: 99,
    state: "HTF_BULL_LTF_PULLBACK",
    swing_consensus: { direction: "LONG" },
    td_sequential: {
      per_tf: {
        D: {
          bullish_prep_count: 8,
          bearish_prep_count: 0,
          td9_bullish: false,
          td9_bearish: false,
        },
      },
    },
    tf_tech: {
      D: {
        ema: { ema21: 100, ema200: 90 },
        stDir: 1,
        saty: { v: -70, l: {} },
        rsi: { r5: 25 },
        pdz: { zone: "neutral" },
        fvg: {},
        sq: {},
        vwapAbove: false,
      },
    },
    orb: { primary: {} },
    ...overrides,
  };
}

describe("setup diagnostics route helpers", () => {
  it("maps VIX to regime buckets", () => {
    expect(vixRegimeFromValue(14)).toBe("low");
    expect(vixRegimeFromValue(20)).toBe("elevated");
    expect(vixRegimeFromValue(28)).toBe("high");
    expect(vixRegimeFromValue(40)).toBe("panic");
    expect(vixRegimeFromValue(null)).toBeNull();
  });

  it("builds path-forecast context from snapshot fields", () => {
    const ctx = buildDiagnosticsContext({
      _vix: 27,
      execution_profile: { personality: "pullback_player" },
      _env: { _sectorRegime: { posture: "leading" } },
      strategy_alignment: "supportive",
      regime_forecast: { state: "HTF_BULL_LTF_PULLBACK", confidence: 0.72 },
      market_internals: { overall: "risk_on" },
    });
    expect(ctx).toMatchObject({
      vix_regime: "high",
      sector_posture: "leading",
      research_alignment: "supportive",
      ticker_personality: "pullback_player",
      index_posture: "risk_on",
      regime_forecast_state: "HTF_BULL_LTF_PULLBACK",
      regime_forecast_confidence: 0.72,
    });
  });

  it("summarizes trader posture from active sequences", () => {
    const events = normalizeSetupEvents([
      mockSetupEvent({ ticker: "USO", event_ts: 1, event_type: "td_setup_progress", direction: "LONG" }),
      mockSetupEvent({ ticker: "USO", event_ts: 2, event_type: "td9_complete", direction: "LONG" }),
      mockSetupEvent({ ticker: "USO", event_ts: 3, event_type: "pdz_discount_entered", direction: "LONG" }),
      mockSetupEvent({ ticker: "USO", event_ts: 4, event_type: "phase_left_accumulation", direction: "LONG" }),
      mockSetupEvent({ ticker: "USO", event_ts: 5, event_type: "ema21_reclaim", direction: "LONG" }),
    ]).events;
    const sequences = detectMeanReversionSequences(events, { ticker: "USO" });
    const summary = summarizeTraderPosture(sequences);
    expect(summary.posture).toBe("Bullish");
    expect(summary.stage).toBeGreaterThanOrEqual(5);
  });

  it("parses timed_trail rows into snapshot objects", () => {
    const snap = parseTrailSnapshotRow({
      ts: 5000,
      price: 101.5,
      state: "BULL",
      kanban_stage: "setup",
      payload_json: JSON.stringify({ ticker: "uso", close: 101.2, tf_tech: {} }),
    }, "USO");
    expect(snap.ticker).toBe("USO");
    expect(snap.ts).toBe(5000);
    expect(snap.price).toBe(101.5);
    expect(snap.state).toBe("BULL");
  });

  it("runs shadow diagnostics over a snapshot window", () => {
    const s1 = ticker({ ts: 1000, price: 95, tf_tech: { D: { ema: { ema21: 100 }, saty: { v: -80, l: {} }, rsi: { r5: 24 }, pdz: { zone: "neutral" }, fvg: {}, sq: {}, stDir: 1, vwapAbove: false } } });
    const s2 = ticker({
      ts: 2000,
      price: 96,
      td_sequential: { per_tf: { D: { bullish_prep_count: 9, td9_bullish: true } } },
      tf_tech: { D: { ema: { ema21: 100 }, saty: { v: -80, l: {} }, rsi: { r5: 25 }, pdz: { zone: "discount" }, fvg: {}, sq: {}, stDir: 1, vwapAbove: false } },
    });
    const s3 = ticker({ ts: 3000, price: 101, tf_tech: { D: { ema: { ema21: 100 }, saty: { v: -50, l: { accum: true } }, rsi: { r5: 32 }, pdz: { zone: "discount" }, fvg: {}, sq: {}, stDir: -1, vwapAbove: true } } });

    const out = runSetupDiagnostics([s1, s2, s3], {
      context: { vix_regime: "low", sector_posture: "leading" },
      tdTfs: ["D"],
      signalTfs: ["D"],
    });

    expect(out.shadow).toBe(true);
    expect(out.snapshot_count).toBe(3);
    expect(out.events.length).toBeGreaterThan(0);
    expect(out.path_forecasts.length).toBeGreaterThan(0);
    expect(out.active_sequences.some((s) => s.direction === "LONG" && s.stage >= 4)).toBe(true);
    expect(out.path_forecasts[0].path_forecast).toBeTruthy();
  });
});
