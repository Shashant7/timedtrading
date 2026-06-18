import { describe, expect, it } from "vitest";
import { mockSetupEvent, normalizeSetupEvents } from "./setup-events.js";
import { detectMeanReversionSequences } from "./setup-sequences.js";
import {
  aggregateSequenceReliability,
  classifyTradeOutcome,
  diagnosticsForEntryWindow,
  joinTradeWithSequenceDiagnostics,
  snapshotsBeforeEntry,
  snapshotsFromTrailRows,
  stageBucket,
} from "./setup-replay-mining.js";

function ticker(overrides = {}) {
  return {
    ticker: "USO",
    ts: 1000,
    price: 99,
    td_sequential: {
      per_tf: {
        D: {
          bullish_prep_count: 8,
          bearish_prep_count: 0,
          td9_bullish: false,
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

describe("setup replay mining", () => {
  it("parses trail API rows with payload field", () => {
    const snaps = snapshotsFromTrailRows([
      { ts: 2000, price: 101, payload: { ticker: "USO", close: 101 } },
    ], "USO");
    expect(snaps).toHaveLength(1);
    expect(snaps[0].ts).toBe(2000);
    expect(snaps[0].ticker).toBe("USO");
  });

  it("builds snapshots from trail scalar columns when payload is missing", () => {
    const snaps = snapshotsFromTrailRows([
      {
        ts: 2000,
        price: 101,
        flags_json: JSON.stringify({ pdz_zone_D: "discount", pdz_zone_4h: "discount_approach" }),
      },
    ], "USO");
    expect(snaps).toHaveLength(1);
    expect(snaps[0]._snapshot_source).toBe("trail_scalars");
    expect(snaps[0].tf_tech.D.pdz.zone).toBe("discount");
  });

  it("filters snapshots to the pre-entry window", () => {
    const snaps = [
      { ts: 1000, price: 95 },
      { ts: 2000, price: 96 },
      { ts: 3000, price: 101 },
      { ts: 4000, price: 102 },
    ];
    const window = snapshotsBeforeEntry(snaps, 3000, { preEntryMs: 2500 });
    expect(window.map((s) => s.ts)).toEqual([1000, 2000, 3000]);
  });

  it("classifies trade outcomes from pnl_pct", () => {
    expect(classifyTradeOutcome({ pnl_pct: 2.5 }).outcome).toBe("win");
    expect(classifyTradeOutcome({ pnl_pct: -1.2 }).outcome).toBe("loss");
    expect(classifyTradeOutcome({}).outcome).toBe("unknown");
  });

  it("maps stages to reliability buckets", () => {
    expect(stageBucket(2)).toBe("1_4_forming");
    expect(stageBucket(6)).toBe("5_7_confirmed");
    expect(stageBucket(8)).toBe("8_entry_ready");
  });

  it("joins a closed trade to sequence diagnostics at entry", () => {
    const s1 = ticker({ ts: 1000, price: 95, tf_tech: { D: { ema: { ema21: 100 }, saty: { v: -80, l: {} }, rsi: { r5: 24 }, pdz: { zone: "neutral" }, fvg: {}, sq: {}, stDir: 1, vwapAbove: false } } });
    const s2 = ticker({
      ts: 2000,
      price: 96,
      td_sequential: { per_tf: { D: { bullish_prep_count: 9, td9_bullish: true } } },
      tf_tech: { D: { ema: { ema21: 100 }, saty: { v: -80, l: {} }, rsi: { r5: 25 }, pdz: { zone: "discount" }, fvg: {}, sq: {}, stDir: 1, vwapAbove: false } },
    });
    const s3 = ticker({ ts: 3000, price: 101, tf_tech: { D: { ema: { ema21: 100 }, saty: { v: -50, l: { accum: true } }, rsi: { r5: 32 }, pdz: { zone: "discount" }, fvg: {}, sq: {}, stDir: -1, vwapAbove: true } } });

    const trade = {
      trade_id: "t1",
      ticker: "USO",
      direction: "LONG",
      entry_ts: 3000,
      pnl_pct: 4.2,
    };

    const joined = joinTradeWithSequenceDiagnostics(trade, [
      { ts: s1.ts, price: s1.price, payload: s1 },
      { ts: s2.ts, price: s2.price, payload: s2 },
      { ts: s3.ts, price: s3.price, payload: s3 },
    ], { derivationOpts: { tdTfs: ["D"], signalTfs: ["D"] } });

    expect(joined.diagnostics_ok).toBe(true);
    expect(joined.outcome).toBe("win");
    expect(joined.sequence?.direction).toBe("LONG");
    expect(joined.sequence?.stage).toBeGreaterThanOrEqual(4);
  });

  it("aggregates reliability tables from joined rows", () => {
    const joined = [
      {
        ticker: "USO",
        outcome: "win",
        pnl_pct: 3,
        sequence: {
          sequence_type: "td_phase_mean_reversion_long",
          direction: "LONG",
          stage_bucket: "5_7_confirmed",
          path_forecast: { primary_path: "sharp_reversal" },
        },
      },
      {
        ticker: "USO",
        outcome: "loss",
        pnl_pct: -2,
        sequence: {
          sequence_type: "td_phase_mean_reversion_long",
          direction: "LONG",
          stage_bucket: "5_7_confirmed",
          path_forecast: { primary_path: "sharp_reversal" },
        },
      },
      {
        ticker: "TSLA",
        outcome: "win",
        pnl_pct: 1,
        sequence: null,
      },
    ];

    const agg = aggregateSequenceReliability(joined);
    expect(agg.total_trades).toBe(3);
    expect(agg.with_sequence).toBe(2);
    expect(agg.by_sequence[0].n).toBe(2);
    expect(agg.by_sequence[0].win_rate).toBe(0.5);
  });

  it("derives diagnostics for an entry window", () => {
    const events = normalizeSetupEvents([
      mockSetupEvent({ ticker: "USO", event_ts: 1000, event_type: "td_setup_progress", direction: "LONG" }),
      mockSetupEvent({ ticker: "USO", event_ts: 2000, event_type: "td9_complete", direction: "LONG" }),
    ]).events;
    const sequences = detectMeanReversionSequences(events, { ticker: "USO" });
    expect(sequences.some((s) => s.direction === "LONG" && s.stage >= 2)).toBe(true);

    const diag = diagnosticsForEntryWindow([
      ticker({ ts: 1000 }),
      ticker({ ts: 2000, td_sequential: { per_tf: { D: { bullish_prep_count: 9, td9_bullish: true } } } }),
    ], 2000, { derivationOpts: { tdTfs: ["D"], signalTfs: ["D"] } });
    expect(diag.ok).toBe(true);
    expect(diag.sequences.length).toBeGreaterThan(0);
  });
});
