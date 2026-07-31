import { describe, it, expect } from "vitest";
import {
  nyWeekKey,
  detectWeeklyMoves,
  classifyWeeklyCapture,
  classifyMissReason,
  buildWeeklyAutopsyReport,
} from "./weekly-move-autopsy.js";

describe("weekly-move-autopsy", () => {
  it("nyWeekKey maps mid-week to Monday", () => {
    // 2026-07-15 is Wednesday ET → week of 2026-07-13
    const key = nyWeekKey(Date.parse("2026-07-15T16:00:00Z"));
    expect(key).toBe("2026-07-13");
  });

  it("detectWeeklyMoves finds ≥10% open-close weeks", () => {
    const mon = Date.parse("2026-07-13T14:00:00Z");
    const candles = [
      { ts: mon, o: 100, h: 102, l: 99, c: 101 },
      { ts: mon + 86400000, o: 101, h: 108, l: 100, c: 107 },
      { ts: mon + 2 * 86400000, o: 107, h: 115, l: 106, c: 112 },
    ];
    const moves = detectWeeklyMoves(candles, { minPct: 10 });
    expect(moves.length).toBe(1);
    expect(moves[0].direction).toBe("LONG");
    expect(moves[0].oc_pct).toBeGreaterThanOrEqual(10);
  });

  it("classifyWeeklyCapture labels MISSED / TOUCHED / PARTIAL", () => {
    const move = {
      week_key: "2026-07-13",
      direction: "LONG",
      move_pct: 20,
      oc_pct: 20,
    };
    expect(classifyWeeklyCapture(move, []).label).toBe("MISSED");
    const touched = classifyWeeklyCapture(move, [{
      trade_id: "T1",
      direction: "LONG",
      entry_ts: Date.parse("2026-07-14T15:00:00Z"),
      exit_ts: Date.parse("2026-07-16T15:00:00Z"),
      pnl_pct: 12,
      max_favorable_excursion: 18,
    }]);
    expect(touched.label).toBe("TOUCHED");
    const partial = classifyWeeklyCapture(move, [{
      trade_id: "T2",
      direction: "LONG",
      entry_ts: Date.parse("2026-07-14T15:00:00Z"),
      exit_ts: Date.parse("2026-07-15T15:00:00Z"),
      pnl_pct: 2,
      max_favorable_excursion: 3,
    }]);
    expect(partial.label).toBe("PARTIAL");
  });

  it("classifyMissReason prefers late_bull / low_rank / wrong_state", () => {
    expect(classifyMissReason({}, { direction: "LONG" })).toBe("not_scored");
    expect(classifyMissReason(
      { regime_class: "LATE_BULL", rank: 80, state: "HTF_BULL_LTF_BULL" },
      { direction: "LONG" },
    )).toBe("late_bull_block");
    expect(classifyMissReason(
      { rank: 55, state: "HTF_BULL_LTF_BULL" },
      { direction: "LONG" },
    )).toBe("low_rank");
    expect(classifyMissReason(
      { rank: 90, state: "HTF_BEAR_LTF_PULLBACK" },
      { direction: "LONG" },
    )).toBe("wrong_state");
  });

  it("buildWeeklyAutopsyReport aggregates canary miss rate", () => {
    const report = buildWeeklyAutopsyReport({
      weeks: 4,
      tickerMoves: [{
        ticker: "DELL",
        moves: [{
          week_key: "2026-07-06",
          direction: "LONG",
          move_pct: 40,
          oc_pct: 40,
          range_pct: 44,
        }],
        trades: [],
        payload: { rank: 55, state: "HTF_BULL_LTF_BULL", regime_class: "LATE_BULL" },
      }],
    });
    expect(report.summary.missed).toBe(1);
    expect(report.summary.canary_missed).toBe(1);
    expect(report.top_missed[0].ticker).toBe("DELL");
    expect(report.top_missed[0].miss_reason).toBe("late_bull_block");
  });
});
