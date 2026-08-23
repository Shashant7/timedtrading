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
        { trade_id: "CP-1", status: "WIN", pnl: 10, pnl_pct: 1.2, max_favorable_excursion: 3, ticker: "NVDA" },
        { trade_id: "CS-1", status: "OPEN", pnl: 0, pnl_pct: 0, ticker: "AXON" },
        { trade_id: "MC-1", status: "LOSS", pnl: -8, pnl_pct: -0.4, max_favorable_excursion: 1, ticker: "TSLA" },
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
});
