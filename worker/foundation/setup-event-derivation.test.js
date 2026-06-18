import { describe, expect, it } from "vitest";
import {
  deriveSetupDiagnostics,
  deriveSetupEvents,
} from "./setup-event-derivation.js";

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
          td13_bullish: false,
          td13_bearish: false,
        },
      },
    },
    tf_tech: {
      D: {
        ema: { ema21: 100, ema200: 90 },
        stDir: 1,
        saty: { v: -70, l: {} },
        rsi: { r5: 25 },
        rsiDiv: {},
        pdz: { zone: "neutral" },
        fvg: { ib: 0, ibr: 0 },
        sq: { r: 0 },
        vwapAbove: false,
      },
    },
    orb: { primary: {} },
    ...overrides,
  };
}

describe("deriveSetupEvents", () => {
  it("derives setup events from real ticker field transitions", () => {
    const prev = ticker();
    const cur = ticker({
      ts: 2000,
      price: 101,
      td_sequential: {
        per_tf: {
          D: {
            bullish_prep_count: 9,
            bearish_prep_count: 0,
            td9_bullish: true,
            td9_bearish: false,
            td13_bullish: false,
            td13_bearish: false,
          },
        },
      },
      tf_tech: {
        D: {
          ema: { ema21: 100, ema200: 90 },
          stDir: -1,
          saty: { v: -50, l: { accum: true } },
          rsi: { r5: 32 },
          rsiDiv: { bull: { a: true, s: 1.5 } },
          pdz: { zone: "discount" },
          fvg: { ib: 1, ibr: 0 },
          sq: { r: 1 },
          vwapAbove: true,
        },
      },
      orb: { primary: { breakout: "LONG", reclaim: true } },
    });

    const events = deriveSetupEvents(prev, cur, { tdTfs: ["D"], signalTfs: ["D"] });
    const keys = events.map((e) => `${e.tf}:${e.event_type}:${e.direction}`);

    expect(keys).toEqual(expect.arrayContaining([
      "D:td_setup_progress:LONG",
      "D:td9_complete:LONG",
      "D:phase_left_accumulation:LONG",
      "D:rsi_extreme_left:LONG",
      "D:rsi_divergence_confirmed:LONG",
      "D:ema21_reclaim:LONG",
      "D:supertrend_flip:LONG",
      "D:pdz_discount_entered:LONG",
      "D:fvg_filled:LONG",
      "D:squeeze_release:LONG",
      "D:vwap_reclaim:LONG",
      "ORB:orb_breakout:LONG",
      "ORB:orb_reclaim:LONG",
    ]));
  });

  it("does not emit unchanged truthy signals twice", () => {
    const prev = ticker({
      td_sequential: { per_tf: { D: { bullish_prep_count: 9, td9_bullish: true } } },
      tf_tech: { D: { saty: { v: -50, l: { accum: true } }, rsi: { r5: 32 }, ema: { ema21: 100 }, pdz: { zone: "discount" }, fvg: { ib: 1 }, sq: { r: 1 }, stDir: -1, vwapAbove: true } },
    });
    const cur = ticker({
      ts: 2000,
      price: 102,
      td_sequential: { per_tf: { D: { bullish_prep_count: 9, td9_bullish: true } } },
      tf_tech: { D: { saty: { v: -45, l: { accum: true } }, rsi: { r5: 34 }, ema: { ema21: 100 }, pdz: { zone: "discount" }, fvg: { ib: 1 }, sq: { r: 1 }, stDir: -1, vwapAbove: true } },
    });

    const events = deriveSetupEvents(prev, cur, { tdTfs: ["D"], signalTfs: ["D"] });
    expect(events.map((e) => e.event_type)).not.toContain("td9_complete");
    expect(events.map((e) => e.event_type)).not.toContain("phase_left_accumulation");
    expect(events.map((e) => e.event_type)).not.toContain("fvg_filled");
  });

  it("feeds derived events into shadow sequence diagnostics", () => {
    const prev = ticker();
    const cur = ticker({
      ts: 2000,
      price: 101,
      td_sequential: { per_tf: { D: { bullish_prep_count: 9, td9_bullish: true } } },
      tf_tech: {
        D: {
          ema: { ema21: 100, ema200: 90 },
          stDir: -1,
          saty: { v: -50, l: { accum: true } },
          rsi: { r5: 32 },
          pdz: { zone: "discount" },
          fvg: { ib: 1 },
          sq: { r: 0 },
          vwapAbove: true,
        },
      },
    });

    const diag = deriveSetupDiagnostics(prev, cur, {
      tdTfs: ["D"],
      signalTfs: ["D"],
      context: { sector_posture: "leading", vix_regime: "low" },
    });

    const longSeq = diag.sequences.find((s) => s.ticker === "USO" && s.direction === "LONG");
    expect(longSeq).toBeTruthy();
    expect(longSeq.stage).toBeGreaterThanOrEqual(4);
    expect(longSeq.posture).toMatch(/Leaning bullish|Bullish/);
    expect(longSeq.path_forecast.context_used.sector_posture).toBe("leading");
  });
});
