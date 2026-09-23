import { describe, it, expect } from "vitest";
import {
  aggregateMfeCapture,
  buildAllFamilyAttributionReport,
  buildFamilyAttributionReport,
  mfeKeepRate,
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

// 2026-09-22 — the live cloud-pivot window reported avg_mfe_keep_rate
// -1.456 against a 0.35 widen bar, which reads as a family giving back
// 145% of everything it was offered. It was one row: ULTA ran +0.104% and
// closed -5.13%, scoring -49.21 on its own. Over 47 trades that is -1.05 of
// the -1.456. Aggregate capture over the same window was +0.096.
describe("mfeKeepRate: a move too small to keep has no keep rate", () => {
  it("scores a normal trade as the fraction of its peak that was held", () => {
    expect(mfeKeepRate(2, 4)).toBe(0.5);
    expect(mfeKeepRate(-1, 2)).toBe(-0.5);
  });

  it("returns null once the excursion is below the floor, rather than a huge ratio", () => {
    expect(mfeKeepRate(-5.13, 0.104)).toBeNull();
    expect(mfeKeepRate(-5.13, 0.499)).toBeNull();
    expect(mfeKeepRate(-5.13, 0.5)).toBe(-10.26);
  });

  it("still returns null for a non-positive or unusable excursion", () => {
    expect(mfeKeepRate(1, 0)).toBeNull();
    expect(mfeKeepRate(1, -2)).toBeNull();
    expect(mfeKeepRate(NaN, 4)).toBeNull();
  });
});

describe("aggregateMfeCapture: no single trade can carry the number", () => {
  it("is total kept over total offered, not the mean of per-trade ratios", () => {
    const closed = [
      { pnl_pct: 5, mfe_pct: 10 },
      { pnl_pct: -5.13, mfe_pct: 0.104 },
    ];
    // mean of ratios would be (0.5 + -49.3) / 2 ~= -24.4
    expect(aggregateMfeCapture(closed)).toBeCloseTo(-0.013, 3);
  });

  it("lands on +0.096 for the live cloud-pivot totals the mean read as -1.456", () => {
    // Verbatim from D1 over the 47-trade window:
    //   SUM(pnl_pct) = 22.18, SUM(max_favorable_excursion) = 231.18
    expect(aggregateMfeCapture([{ pnl_pct: 22.18, mfe_pct: 231.18 }])).toBeCloseTo(0.096, 3);
  });

  it("returns null when nothing in the window ever moved favourably", () => {
    expect(aggregateMfeCapture([{ pnl_pct: -1, mfe_pct: 0 }])).toBeNull();
    expect(aggregateMfeCapture([])).toBeNull();
  });
});

describe("widen_ready needs both keep measures, and reports each leg", () => {
  const entry = (id) => ({
    event_type: "ENTRY",
    trade_id: id,
    inputs_json: JSON.stringify({ tt_cloud_pivot: true }),
  });
  const trade = (id, direction, pnlPct, mfe) => ({
    trade_id: id,
    status: pnlPct > 0 ? "WIN" : "LOSS",
    pnl: pnlPct * 10,
    pnl_pct: pnlPct,
    max_favorable_excursion: mfe,
    direction,
    setup_name: "TT Cloud Pivot",
  });

  it("withholds size when the aggregate is thin even though the mean clears", () => {
    // Five small, tidy winners (mean keep 0.5) and one large giveback the
    // mean barely feels but which eats the family's whole return.
    const rows = [
      trade("A", "SHORT", 1, 2), trade("B", "SHORT", 1, 2), trade("C", "SHORT", 1, 2),
      trade("D", "SHORT", 1, 2), trade("E", "SHORT", 1, 2),
      trade("F", "LONG", -4, 40),
    ];
    const report = buildFamilyAttributionReport({
      family: "tt_cloud_pivot",
      entryDecisions: rows.map((t) => entry(t.trade_id)),
      trades: rows,
    });
    expect(report.avg_mfe_keep_rate).toBeGreaterThanOrEqual(0.35);
    expect(report.mfe_capture_rate).toBeLessThan(0.35);
    expect(report.widen_ready).toBe(false);
  });

  it("widens when both measures clear and the book is profitable", () => {
    const rows = [
      trade("A", "SHORT", 3, 4), trade("B", "SHORT", 3, 4), trade("C", "SHORT", 3, 4),
      trade("D", "SHORT", 3, 4), trade("E", "SHORT", 3, 4), trade("F", "SHORT", -1, 2),
    ];
    const report = buildFamilyAttributionReport({
      family: "tt_cloud_pivot",
      entryDecisions: rows.map((t) => entry(t.trade_id)),
      trades: rows,
    });
    expect(report.avg_mfe_keep_rate).toBeGreaterThanOrEqual(0.35);
    expect(report.mfe_capture_rate).toBeGreaterThanOrEqual(0.35);
    expect(report.widen_ready).toBe(true);
  });

  it("splits the legs so a pooled number cannot hide a one-sided family", () => {
    const rows = [
      trade("S1", "SHORT", 4, 5), trade("S2", "SHORT", 4, 5), trade("S3", "SHORT", 4, 5),
      trade("L1", "LONG", -3, 5), trade("L2", "LONG", -3, 5), trade("L3", "LONG", -3, 5),
    ];
    const report = buildFamilyAttributionReport({
      family: "tt_cloud_pivot",
      entryDecisions: rows.map((t) => entry(t.trade_id)),
      trades: rows,
    });
    expect(report.by_direction.SHORT.wins).toBe(3);
    expect(report.by_direction.SHORT.mfe_capture_rate).toBeCloseTo(0.8, 3);
    expect(report.by_direction.LONG.losses).toBe(3);
    expect(report.by_direction.LONG.mfe_capture_rate).toBeCloseTo(-0.6, 3);
    // The pooled view is the average of two opposite books and describes
    // neither — which is exactly why the split is reported.
    expect(report.mfe_capture_rate).toBeCloseTo(0.1, 3);
  });
});
