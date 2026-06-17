import { describe, expect, it } from "vitest";
import { mockSetupEvent, normalizeSetupEvents } from "./setup-events.js";
import {
  detectMeanReversionSequences,
  detectTdPhaseMeanReversionSequence,
} from "./setup-sequences.js";

function ev(event_type, event_ts, direction = "LONG", extra = {}) {
  return mockSetupEvent({
    ticker: extra.ticker || "USO",
    tf: extra.tf || "D",
    event_type,
    event_ts,
    direction,
    price: extra.price || 100 + event_ts,
    payload: extra.payload || {},
  });
}

describe("setup sequence shadow detector", () => {
  it("detects a forming long sequence from mock exhaustion events", () => {
    const seq = detectTdPhaseMeanReversionSequence([
      ev("td_setup_progress", 1),
      ev("phase_entered_extreme", 2),
    ], { ticker: "USO", direction: "LONG" });

    expect(seq.sequence_type).toBe("td_phase_mean_reversion_long");
    expect(seq.status).toBe("forming");
    expect(seq.stage).toBe(1);
    expect(seq.posture).toBe("Leaning bullish");
    expect(seq.path_forecast.primary_path).toBe("drift_base");
  });

  it("detects a confirmed bullish sequence through mean-reversion target", () => {
    const seq = detectTdPhaseMeanReversionSequence([
      ev("td_setup_progress", 1),
      ev("td9_complete", 2),
      ev("pdz_discount_entered", 3),
      ev("phase_left_accumulation", 4),
      ev("ema21_reclaim", 5),
    ], {
      ticker: "USO",
      direction: "LONG",
      context: { vix_regime: "low", sector_posture: "leading" },
    });

    expect(seq.status).toBe("confirmed");
    expect(seq.stage).toBe(5);
    expect(seq.posture).toBe("Bullish");
    expect(seq.confidence).toBeGreaterThan(0.7);
    expect(seq.path_forecast.primary_path).toBe("sharp_reversal");
    expect(seq.path_forecast.pullback_expected).toBe(true);
  });

  it("does not advance stages when events arrive out of order", () => {
    const seq = detectTdPhaseMeanReversionSequence([
      ev("td9_complete", 1),
      ev("td_setup_progress", 2),
      ev("pdz_discount_entered", 3),
    ], { ticker: "USO", direction: "LONG" });

    expect(seq.stage).toBe(1);
    expect(seq.status).toBe("forming");
    expect(seq.stage_results[1]).toMatchObject({ stage: 2, matched: false });
  });

  it("detects an entry-ready short sequence and keeps shorts first-class", () => {
    const seq = detectTdPhaseMeanReversionSequence([
      ev("td_setup_progress", 1, "SHORT"),
      ev("td13_complete", 2, "SHORT"),
      ev("pdz_premium_entered", 3, "SHORT"),
      ev("phase_left_distribution", 4, "SHORT"),
      ev("ema21_reject", 5, "SHORT"),
      ev("supertrend_breakthrough", 6, "SHORT"),
      ev("pullback_stabilized", 7, "SHORT"),
      ev("orb_breakout", 8, "SHORT"),
    ], {
      ticker: "USO",
      direction: "SHORT",
      context: { vix_regime: "high", sector_posture: "lagging" },
    });

    expect(seq.sequence_type).toBe("td_phase_mean_reversion_short");
    expect(seq.status).toBe("entry_ready");
    expect(seq.stage).toBe(8);
    expect(seq.posture).toBe("Bearish");
    expect(seq.path_forecast.primary_path).toBe("trend_continuation");
  });

  it("supports open-position labels without changing sequence direction", () => {
    const seq = detectTdPhaseMeanReversionSequence([
      ev("td_setup_progress", 1),
      ev("td9_complete", 2),
      ev("pdz_discount_entered", 3),
      ev("phase_left_accumulation", 4),
      ev("ema21_reclaim", 5),
    ], { ticker: "USO", direction: "LONG", openPosition: true });

    expect(seq.direction).toBe("LONG");
    expect(seq.posture).toBe("Open Long");
  });

  it("marks a sequence invalidated when an opposite event arrives after the last matched stage", () => {
    const seq = detectTdPhaseMeanReversionSequence([
      ev("td_setup_progress", 1),
      ev("td9_complete", 2),
      ev("pdz_discount_entered", 3),
      ev("phase_left_accumulation", 4),
      ev("ema21_reject", 5),
    ], { ticker: "USO", direction: "LONG" });

    expect(seq.status).toBe("invalidated");
    expect(seq.invalidation_event).toContain("ema21_reject");
  });

  it("detects multiple ticker/direction sequences from one event stream", () => {
    const events = normalizeSetupEvents([
      ev("td_setup_progress", 1, "LONG", { ticker: "USO" }),
      ev("td9_complete", 2, "LONG", { ticker: "USO" }),
      ev("td_setup_progress", 1, "SHORT", { ticker: "TSLA" }),
      ev("td13_complete", 2, "SHORT", { ticker: "TSLA" }),
    ]).events;

    const sequences = detectMeanReversionSequences(events);
    expect(sequences.map((s) => `${s.ticker}:${s.direction}:${s.stage}`)).toEqual([
      "TSLA:SHORT:2",
      "USO:LONG:2",
    ]);
  });
});
