import { describe, it, expect } from "vitest";
import {
  buildAllFamilyAttributionReport,
  buildFamilyAttributionReport,
  PAPER_EXPERIMENT_FAMILIES,
} from "./family-attribution.js";

describe("buildAllFamilyAttributionReport", () => {
  it("returns one report per paper experiment family from a single row set", () => {
    const report = buildAllFamilyAttributionReport({
      days: 7,
      entryDecisions: [
        {
          event_type: "ENTRY",
          trade_id: "CP-1",
          inputs_json: JSON.stringify({ slice_family: "tt_cloud_pivot" }),
        },
        {
          event_type: "ENTRY",
          trade_id: "CS-1",
          inputs_json: JSON.stringify({ slice_family: "confirm_stack_ema21" }),
        },
        {
          event_type: "ENTRY",
          trade_id: "MC-1",
          inputs_json: JSON.stringify({ slice_family: "momentum_continuation" }),
        },
      ],
      trades: [
        { trade_id: "CP-1", status: "WIN", pnl: 10, pnl_pct: 1.2, max_favorable_excursion: 3, max_adverse_excursion: -0.4, ticker: "NVDA", entry_ts: Date.UTC(2026, 6, 15, 14, 20) },
        { trade_id: "CS-1", status: "OPEN", pnl: 0, pnl_pct: 0, ticker: "AXON", entry_ts: Date.UTC(2026, 6, 15, 14, 0) },
        { trade_id: "MC-1", status: "LOSS", pnl: -8, pnl_pct: -0.4, max_favorable_excursion: 1, max_adverse_excursion: 1.1, ticker: "TSLA", entry_ts: Date.UTC(2026, 6, 15, 15, 30) },
      ],
      universeCapturePct: 5.2,
    });
    expect(report.ok).toBe(true);
    expect(report.days).toBe(7);
    expect(report.rows_scanned).toBe(3);
    expect(Object.keys(report.families)).toEqual([...PAPER_EXPERIMENT_FAMILIES]);
    expect(report.families.tt_cloud_pivot.entries).toBe(1);
    expect(report.families.tt_cloud_pivot.closed).toBe(1);
    expect(report.families.tt_cloud_pivot.avg_mfe_keep_rate).toBe(0.4);
    expect(report.families.confirm_stack_ema21.entries).toBe(1);
    expect(report.families.confirm_stack_ema21.open).toBe(1);
    expect(report.families.momentum_continuation.closed).toBe(1);
    expect(report.families.tt_cloud_pivot.widen_ready).toBe(false);
    expect(report.timing.ok).toBe(true);
    expect(report.timing.programs.tt_cloud_pivot.overall.closed).toBe(1);
  });
});

describe("buildFamilyAttributionReport cloud pivot", () => {
  it("does not mark widen_ready on a single closed print", () => {
    const report = buildFamilyAttributionReport({
      family: "tt_cloud_pivot",
      entryDecisions: [{
        event_type: "ENTRY",
        trade_id: "X",
        inputs_json: JSON.stringify({ tt_cloud_pivot: true }),
      }],
      trades: [{ trade_id: "X", status: "WIN", pnl: 20, pnl_pct: 2, max_favorable_excursion: 4 }],
    });
    expect(report.entries).toBe(1);
    expect(report.widen_ready).toBe(false);
  });

  it("excludes a core setup that only carries a coincident cloud-pivot stamp", () => {
    const report = buildFamilyAttributionReport({
      family: "tt_cloud_pivot",
      entryDecisions: [
        { event_type: "ENTRY", trade_id: "CP", inputs_json: JSON.stringify({ tt_cloud_pivot: true }) },
        { event_type: "ENTRY", trade_id: "SB", inputs_json: JSON.stringify({ tt_cloud_pivot: true }) },
      ],
      trades: [
        // real cloud-pivot paper trade — kept
        { trade_id: "CP", status: "WIN", pnl: 20, pnl_pct: 2, max_favorable_excursion: 4, setup_name: "TT Cloud Pivot" },
        // core Support Bounce carrying the coincident stamp — must NOT pollute
        { trade_id: "SB", status: "LOSS", pnl: -50, pnl_pct: -3, max_favorable_excursion: 5, setup_name: "TT Support Bounce" },
      ],
    });
    expect(report.entries).toBe(1);
    expect(report.proposals).toBe(2);
    expect(report.closed).toBe(1);
    expect(report.stats.losses).toBe(0);
    expect(report.stats.wins).toBe(1);
  });
});
