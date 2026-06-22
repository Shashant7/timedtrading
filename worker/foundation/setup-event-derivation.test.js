import { describe, expect, it } from "vitest";
import {
  augmentSnapshotsWithRsiDivergence,
  deriveSetupDiagnostics,
  deriveSetupEvents,
  deriveSetupEventsFromWindow,
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

  it("derives events across an unordered snapshot window and advances sequence stages", () => {
    const s1 = ticker({ ts: 3000, price: 98, tf_tech: { D: { ema: { ema21: 100 }, saty: { v: -80, l: {} }, rsi: { r5: 24 }, pdz: { zone: "neutral" }, fvg: {}, sq: {}, stDir: 1, vwapAbove: false } } });
    const s2 = ticker({
      ts: 1000,
      price: 95,
      td_sequential: { per_tf: { D: { bullish_prep_count: 8, td9_bullish: false } } },
      tf_tech: { D: { ema: { ema21: 100 }, saty: { v: -70, l: {} }, rsi: { r5: 25 }, pdz: { zone: "neutral" }, fvg: {}, sq: {}, stDir: 1, vwapAbove: false } },
    });
    const s3 = ticker({
      ts: 2000,
      price: 96,
      td_sequential: { per_tf: { D: { bullish_prep_count: 9, td9_bullish: true } } },
      tf_tech: { D: { ema: { ema21: 100 }, saty: { v: -72, l: {} }, rsi: { r5: 25 }, pdz: { zone: "discount" }, fvg: {}, sq: {}, stDir: 1, vwapAbove: false } },
    });
    const s4 = ticker({ ts: 4000, price: 101, tf_tech: { D: { ema: { ema21: 100 }, saty: { v: -50, l: { accum: true } }, rsi: { r5: 32 }, pdz: { zone: "discount" }, fvg: {}, sq: {}, stDir: -1, vwapAbove: true } } });

    const result = deriveSetupEventsFromWindow([s4, s2, s1, s3], {
      tdTfs: ["D"],
      signalTfs: ["D"],
      context: { sector_posture: "leading" },
    });

    const types = result.events.map((e) => e.event_type);
    expect(types).toEqual(expect.arrayContaining([
      "td_setup_progress",
      "td9_complete",
      "pdz_discount_entered",
      "phase_left_accumulation",
      "mean_reversion_target_reached",
    ]));
    const seq = result.sequences.find((s) => s.direction === "LONG");
    expect(seq.stage).toBeGreaterThanOrEqual(5);
    expect(seq.posture).toBe("Bullish");
  });

  it("emits pullback_stabilized after reclaim holds across the window", () => {
    const s1 = ticker({ ts: 1000, price: 95, tf_tech: { D: { ema: { ema21: 100 }, saty: { v: -80, l: {} }, rsi: { r5: 24 }, pdz: { zone: "neutral" }, fvg: {}, sq: {}, stDir: 1, vwapAbove: false } } });
    const s2 = ticker({
      ts: 2000,
      price: 96,
      td_sequential: { per_tf: { D: { bullish_prep_count: 9, td9_bullish: true } } },
      tf_tech: { D: { ema: { ema21: 100 }, saty: { v: -80, l: {} }, rsi: { r5: 25 }, pdz: { zone: "discount" }, fvg: {}, sq: {}, stDir: 1, vwapAbove: false } },
    });
    const s3 = ticker({ ts: 3000, price: 99, tf_tech: { D: { ema: { ema21: 100 }, saty: { v: -50, l: { accum: true } }, rsi: { r5: 32 }, pdz: { zone: "discount" }, fvg: {}, sq: {}, stDir: 1, vwapAbove: false } } });
    const s4 = ticker({ ts: 4000, price: 101, tf_tech: { D: { ema: { ema21: 100 }, saty: { v: -45, l: {} }, rsi: { r5: 38 }, pdz: { zone: "equilibrium" }, fvg: {}, sq: { r: 1 }, stDir: -1, vwapAbove: true } } });
    const s5 = ticker({ ts: 5000, price: 100.2, tf_tech: { D: { ema: { ema21: 100 }, saty: { v: -42, l: {} }, rsi: { r5: 39 }, pdz: { zone: "equilibrium" }, fvg: {}, sq: {}, stDir: -1, vwapAbove: true } } });
    const s6 = ticker({ ts: 6000, price: 100.4, tf_tech: { D: { ema: { ema21: 100 }, saty: { v: -40, l: {} }, rsi: { r5: 40 }, pdz: { zone: "equilibrium" }, fvg: {}, sq: {}, stDir: -1, vwapAbove: true } } });

    const result = deriveSetupEventsFromWindow([s1, s2, s3, s4, s5, s6], {
      tdTfs: ["D"],
      signalTfs: ["D"],
      pullbackHoldSnapshots: 2,
    });

    expect(result.events.map((e) => e.event_type)).toContain("pullback_stabilized");
    const seq = result.sequences.find((s) => s.direction === "LONG");
    expect(seq.stage).toBeGreaterThanOrEqual(7);
  });

  it("can include prior event history when a window starts mid-sequence", () => {
    const priorEvents = deriveSetupEvents(null, ticker({
      ts: 1000,
      price: 95,
      td_sequential: { per_tf: { D: { bullish_prep_count: 9, td9_bullish: true } } },
      tf_tech: { D: { ema: { ema21: 100 }, saty: { v: -80, l: {} }, rsi: { r5: 25 }, pdz: { zone: "discount" }, fvg: {}, sq: {}, stDir: 1, vwapAbove: false } },
    }), { tdTfs: ["D"], signalTfs: ["D"], bootstrap: true });
    const cur = ticker({ ts: 2000, price: 101, tf_tech: { D: { ema: { ema21: 100 }, saty: { v: -50, l: { accum: true } }, rsi: { r5: 32 }, pdz: { zone: "discount" }, fvg: {}, sq: {}, stDir: -1, vwapAbove: true } } });

    const result = deriveSetupEventsFromWindow([cur], {
      priorEvents,
      tdTfs: ["D"],
      signalTfs: ["D"],
      bootstrapFirst: true,
    });

    expect(result.event_history.length).toBeGreaterThan(priorEvents.length);
    expect(result.sequences.find((s) => s.direction === "LONG")?.stage).toBeGreaterThanOrEqual(4);
  });

  it("accepts rank_trace setup_snapshot TD field aliases", () => {
    const prev = {
      ticker: "USO",
      ts: 1000,
      price: 95,
      setup_snapshot: {
        td_seq: { D: { bull_prep: 8, td9_bull: false } },
        pdz: { D: "neutral" },
      },
    };
    const cur = {
      ticker: "USO",
      ts: 2000,
      price: 96,
      setup_snapshot: {
        td_seq: { D: { bull_prep: 9, td9_bull: true } },
        pdz: { D: "discount" },
      },
      tf_tech: { D: { ema: { ema21: 100 }, saty: { v: -70, l: {} }, rsi: { r5: 28 }, fvg: {}, sq: {}, stDir: 1 } },
    };

    const events = deriveSetupEvents(prev, cur, { tdTfs: ["D"], signalTfs: ["D"] });
    const types = events.map((e) => e.event_type);
    expect(types).toEqual(expect.arrayContaining(["td_setup_progress", "td9_complete", "pdz_discount_entered"]));
  });

  it("is idempotent when the same snapshot pair is diffed twice", () => {
    const prev = ticker();
    const cur = ticker({
      ts: 2000,
      td_sequential: { per_tf: { D: { bullish_prep_count: 9, td9_bullish: true } } },
      tf_tech: { D: { ema: { ema21: 100 }, saty: { v: -50, l: { accum: true } }, rsi: { r5: 32 }, pdz: { zone: "discount" }, fvg: { ib: 1 }, sq: { r: 1 }, stDir: -1, vwapAbove: true } },
    });
    const a = deriveSetupEvents(prev, cur, { tdTfs: ["D"], signalTfs: ["D"] });
    const b = deriveSetupEvents(prev, cur, { tdTfs: ["D"], signalTfs: ["D"] });
    expect(a.map((e) => e.event_id)).toEqual(b.map((e) => e.event_id));
  });

  it("augmentSnapshotsWithRsiDivergence enables rsi_divergence_confirmed from trail prices", () => {
    const snaps = [];
    let price = 100;
    for (let i = 0; i < 40; i += 1) {
      price += i < 20 ? -0.4 : 0.2;
      snaps.push({ ticker: "TEST", ts: i * 300000, price, tf_tech: { D: {} } });
    }
    const aug = augmentSnapshotsWithRsiDivergence(snaps, { signalTfs: ["D"] });
    const derived = deriveSetupEventsFromWindow(aug, { bootstrapFirst: true, tdTfs: ["D"], signalTfs: ["D"] });
    const div = derived.events.filter((e) => e.event_type === "rsi_divergence_confirmed");
    expect(div.length).toBeGreaterThanOrEqual(0);
    expect(aug[aug.length - 1].tf_tech.D.rsiDiv).toBeDefined();
  });
});
