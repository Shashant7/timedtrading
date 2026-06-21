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
  classifyMoveAlignment,
  aggregateMoveAlignment,
  normalizeMoveDirection,
  compareCapturedVsMissed,
  stageBucket,
  resolveMoveDirection,
  extractPatternProfile,
  buildPatternCensusReport,
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

  it("builds snapshots from trail_5m_facts bucket rows", () => {
    const snaps = snapshotsFromTrailRows([
      {
        bucket_ts: 2000,
        price_close: 101,
        state: "HTF_BULL_LTF_PULLBACK",
        kanban_stage_end: "setup",
        phase_pct: 0.35,
        pdz_zone: "discount",
        pdz_pct: 22,
        had_squeeze_release: 1,
      },
    ], "SPY");
    expect(snaps).toHaveLength(1);
    expect(snaps[0]._snapshot_source).toBe("trail_5m_facts");
    expect(snaps[0].kanban_stage).toBe("setup");
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

  it("aggregates move-direction alignment buckets", () => {
    const rows = [
      {
        ticker: "NVDA",
        move_id: "NVDA:1",
        move_atr: 10,
        move_pct: -12,
        direction: "DOWN",
        sequence: { sequence_type: "td_phase_mean_reversion_long", direction: "LONG", stage_bucket: "1_4_forming" },
        move_alignment: classifyMoveAlignment({ move_pct: -12, direction: "DOWN" }, { direction: "LONG" }),
      },
      {
        ticker: "SPY",
        move_id: "SPY:1",
        move_atr: 3,
        move_pct: 5,
        direction: "UP",
        sequence: { sequence_type: "td_phase_mean_reversion_long", direction: "LONG", stage_bucket: "1_4_forming" },
        move_alignment: classifyMoveAlignment({ move_pct: 5, direction: "UP" }, { direction: "LONG" }),
      },
      {
        ticker: "ALLY",
        move_id: "ALLY:1",
        move_atr: 5,
        move_pct: 8,
        sequence: null,
        move_alignment: classifyMoveAlignment({ move_pct: 8 }, null),
      },
    ];
    const align = aggregateMoveAlignment(rows);
    expect(align.total).toBe(3);
    expect(align.opposed).toBe(1);
    expect(align.aligned).toBe(1);
    expect(align.none).toBe(1);
    expect(align.by_move_atr_tier.high_atr.opposed).toBe(1);
  });

  it("normalizes UP/DOWN discovery directions to LONG/SHORT for alignment", () => {
    expect(normalizeMoveDirection("UP", 5)).toBe("LONG");
    expect(normalizeMoveDirection("DOWN", -3)).toBe("SHORT");
    const aligned = classifyMoveAlignment({ direction: "UP", move_pct: 10 }, { direction: "LONG" });
    expect(aligned.outcome).toBe("aligned");
    expect(aligned.move_dir).toBe("LONG");
    const opposed = classifyMoveAlignment({ direction: "LONG", move_pct: -10 }, { direction: "LONG" });
    expect(opposed.outcome).toBe("opposed");
    expect(opposed.move_dir).toBe("SHORT");
  });

  it("compares captured vs missed sequence buckets", () => {
    const cmp = compareCapturedVsMissed(
      [{
        cohort: "live_trades",
        outcome: "win",
        direction: "LONG",
        sequence: { sequence_type: "td_phase_mean_reversion_long", direction: "LONG", stage_bucket: "1_4_forming" },
      }],
      [{
        cohort: "discovery_missed",
        move_pct: 12,
        direction: "UP",
        sequence: { sequence_type: "td_phase_mean_reversion_long", direction: "LONG", stage_bucket: "1_4_forming" },
      }],
    );
    expect(cmp.captured.n).toBe(1);
    expect(cmp.missed.n).toBe(1);
    expect(cmp.missed.aligned).toBe(1);
    expect(cmp.captured.aligned).toBe(1);
  });

  it("resolveMoveDirection prefers move_pct sign over stale direction", () => {
    expect(resolveMoveDirection({ direction: "LONG", move_pct: -12.5 })).toBe("SHORT");
    expect(resolveMoveDirection({ direction: "UP", move_pct: 8.2 })).toBe("LONG");
  });

  it("extractPatternProfile surfaces confirmation events and both MR stages", () => {
    const diag = {
      events: [
        { event_type: "td9_complete", event_ts: 1000 },
        { event_type: "supertrend_flip", event_ts: 1100 },
        { event_type: "ema21_stretched", event_ts: 900 },
      ],
      sequences: [
        { direction: "LONG", stage: 6, status: "confirmed", stage_results: [{ key: "exhaustion_forming", matched: true }, { key: "breakthrough_with_momentum", matched: true }] },
        { direction: "SHORT", stage: 1, status: "forming", stage_results: [{ key: "exhaustion_forming", matched: true }] },
      ],
    };
    const profile = extractPatternProfile(diag, { moveDir: "LONG" });
    expect(profile.has_td9).toBe(true);
    expect(profile.has_st_flip).toBe(true);
    expect(profile.aligned_mr_stage).toBe(6);
    expect(profile.short_mr_stage).toBe(1);
    expect(profile.aligned_matched_stages).toContain("breakthrough_with_momentum");
  });

  it("buildPatternCensusReport splits missed aligned vs opposed by event type", () => {
    const rows = [
      {
        cohort: "discovery_missed",
        move_alignment: { outcome: "aligned" },
        pattern_profile: { event_types: ["td9_complete"], aligned_mr_stage: 2, aligned_matched_stages: ["exhaustion_confirmed"], has_td9: true, has_st_flip: false, has_squeeze_release: false, has_ema21_reclaim: false, has_ema200_reclaim: false, invalidated: false, long_mr_stage: 2, short_mr_stage: 0 },
      },
      {
        cohort: "discovery_missed",
        move_alignment: { outcome: "opposed" },
        pattern_profile: { event_types: ["ema21_stretched"], aligned_mr_stage: 1, aligned_matched_stages: ["exhaustion_forming"], has_td9: false, has_st_flip: false, has_squeeze_release: false, has_ema21_reclaim: false, has_ema200_reclaim: false, invalidated: false, long_mr_stage: 1, short_mr_stage: 2 },
      },
    ];
    const report = buildPatternCensusReport(rows);
    expect(report.headline.total).toBe(2);
    expect(report.headline.missed_aligned).toBe(1);
    expect(report.headline.missed_opposed).toBe(1);
    expect(report.by_event_type.find((r) => r.key === "td9_complete")?.missed_aligned?.n).toBe(1);
  });
});
