import { describe, it, expect } from "vitest";
import {
  classifyClock,
  classifyProgram,
  buildProgramTimingReport,
} from "./program-timing.js";

/** Wed 2026-07-15 is a session day. EDT = UTC−4. */
function et(hour, minute) {
  return Date.UTC(2026, 6, 15, hour + 4, minute);
}

describe("classifyClock", () => {
  it("maps Cloud Pivot session windows", () => {
    expect(classifyClock(et(9, 45)).session).toBe("open");
    expect(classifyClock(et(10, 20)).session).toBe("ten_am");
    expect(classifyClock(et(11, 30)).session).toBe("midday");
    expect(classifyClock(et(14, 0)).session).toBe("afternoon");
    expect(classifyClock(et(15, 30)).session).toBe("last_hour");
  });

  it("labels first 15m vs open drive", () => {
    expect(classifyClock(et(9, 40)).rth_offset).toBe("first_15");
    expect(classifyClock(et(10, 0)).rth_offset).toBe("open_drive");
  });
});

describe("classifyProgram", () => {
  it("prefers confirm-stack over cloud pivot", () => {
    expect(classifyProgram({
      inputs_json: JSON.stringify({
        slice_family: "confirm_stack_ema21",
        tt_cloud_pivot: true,
      }),
    })).toBe("confirm_stack_ema21");
  });

  it("reads cloud pivot from proposal family", () => {
    expect(classifyProgram({
      inputs_json: JSON.stringify({
        sequence_paper_queue: { family: "tt_cloud_pivot" },
      }),
    })).toBe("tt_cloud_pivot");
  });
});

describe("buildProgramTimingReport", () => {
  it("crowns the session with higher MFE and lower MAE", () => {
    const report = buildProgramTimingReport({
      minN: 2,
      entryDecisions: [
        { event_type: "ENTRY", trade_id: "CP-OPEN-1", inputs_json: JSON.stringify({ slice_family: "tt_cloud_pivot" }) },
        { event_type: "ENTRY", trade_id: "CP-OPEN-2", inputs_json: JSON.stringify({ slice_family: "tt_cloud_pivot" }) },
        { event_type: "ENTRY", trade_id: "CP-10-1", inputs_json: JSON.stringify({ slice_family: "tt_cloud_pivot" }) },
        { event_type: "ENTRY", trade_id: "CP-10-2", inputs_json: JSON.stringify({ slice_family: "tt_cloud_pivot" }) },
        { event_type: "ENTRY", trade_id: "CORE-1", inputs_json: JSON.stringify({ slice_family: "other" }) },
      ],
      trades: [
        { trade_id: "CP-OPEN-1", status: "LOSS", pnl: -20, pnl_pct: -1.0, max_favorable_excursion: 0.4, max_adverse_excursion: -2.2, entry_ts: et(9, 40), ticker: "NVDA" },
        { trade_id: "CP-OPEN-2", status: "LOSS", pnl: -15, pnl_pct: -0.8, max_favorable_excursion: 0.5, max_adverse_excursion: 1.8, entry_ts: et(9, 50), ticker: "AXON" },
        { trade_id: "CP-10-1", status: "WIN", pnl: 40, pnl_pct: 2.0, max_favorable_excursion: 3.2, max_adverse_excursion: -0.4, entry_ts: et(10, 15), ticker: "NVDA" },
        { trade_id: "CP-10-2", status: "WIN", pnl: 30, pnl_pct: 1.5, max_favorable_excursion: 2.8, max_adverse_excursion: 0.5, entry_ts: et(10, 30), ticker: "TSLA" },
        { trade_id: "CORE-1", status: "WIN", pnl: 10, pnl_pct: 0.5, max_favorable_excursion: 1.0, max_adverse_excursion: 0.3, entry_ts: et(11, 0), ticker: "AAPL" },
      ],
    });

    const cp = report.programs.tt_cloud_pivot;
    expect(cp.overall.closed).toBe(4);
    expect(cp.ideal.session.key).toBe("ten_am");
    expect(cp.ideal.session.avg_mfe_pct).toBeGreaterThan(cp.avoid.session.avg_mfe_pct);
    expect(cp.ideal.session.avg_mae_pct).toBeLessThan(cp.avoid.session.avg_mae_pct);
    expect(cp.avoid.session.key).toBe("open");

    const ideal = report.ideals.find((r) => r.program === "tt_cloud_pivot");
    expect(ideal.session_key).toBe("ten_am");
    expect(ideal.thin).toBe(false);
  });
});
