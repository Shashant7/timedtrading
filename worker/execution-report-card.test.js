import { describe, it, expect } from "vitest";
import { gradeExecution, replayEntryCaps, realMfeCeiling, summarize } from "./execution-report-card.js";

// Tue 2026-08-18: 14:06 ET = 18:06Z
const T = (iso) => new Date(iso).getTime();
const row = (o) => ({
  ticker: "GEV", direction: "LONG", status: "LOSS", entry_ts: T("2026-08-18T18:06:00Z"), exit_ts: T("2026-08-19T14:00:00Z"),
  pnl_pct: -0.94, max_favorable_excursion: 14.25, entry_path: "tt_ath_breakout", exit_reason: "max_loss", entry_price: 1000.75, ...o,
});

describe("summarize", () => {
  it("reports n, win rate, sum, mean, median", () => {
    expect(summarize([{ pnl_pct: 1 }, { pnl_pct: -2 }, { pnl_pct: 3 }])).toEqual({ n: 3, win_rate_pct: 67, sum_pct: 2, mean_pct: 0.67, median_pct: 1 });
    expect(summarize([])).toEqual({ n: 0 });
  });
});

describe("realMfeCeiling", () => {
  it("flags a recorded MFE no candle could have produced (GEV 14.25% vs 4.9% ceiling)", () => {
    const candles = [
      { ts: T("2026-08-18T04:00:00Z"), h: 1049.9, l: 986.17 },
      { ts: T("2026-08-19T04:00:00Z"), h: 1003, l: 963.76 },
    ];
    const ceil = realMfeCeiling(row(), candles);
    expect(ceil).toBeCloseTo(4.91, 1);
    const g = gradeExecution([row()], { GEV: candles });
    expect(g.mfe.corrupt_n).toBe(1);
    expect(g.mfe.giveback.core.armed).toBe(0);
  });
  it("counts a real winner that gave back below 40% of its peak", () => {
    const r = row({ ticker: "AXON", pnl_pct: 0.5, max_favorable_excursion: 9.17, entry_price: 596.89 });
    const candles = [{ ts: T("2026-08-19T04:00:00Z"), h: 651.61, l: 617.64 }];
    const g = gradeExecution([r], { AXON: candles });
    expect(g.mfe.corrupt_n).toBe(0);
    expect(g.mfe.giveback.core).toEqual({ armed: 1, closed_below_40pct: 1 });
  });
});

describe("replayEntryCaps", () => {
  it("blocks the 7th core entry of a day and the 4th family entry", () => {
    const day = (i, path) => row({ ticker: `T${i}`, entry_ts: T("2026-08-18T14:00:00Z") + i * 60000, entry_path: path, pnl_pct: -1 });
    const rows = [...Array.from({ length: 8 }, (_, i) => day(i, "tt_ath_breakout")), ...Array.from({ length: 5 }, (_, i) => day(10 + i, "tt_cloud_pivot_long"))];
    const { blocked, kept } = replayEntryCaps(rows);
    expect(kept.filter((r) => r.entry_path === "tt_ath_breakout")).toHaveLength(6);
    expect(blocked.filter((r) => r.entry_path === "tt_ath_breakout")).toHaveLength(2);
    expect(kept.filter((r) => r.entry_path.includes("cloud_pivot"))).toHaveLength(3);
  });
});

describe("gradeExecution", () => {
  it("buckets core entries by ET hour and splits lanes", () => {
    const rows = [
      row({ ticker: "A", entry_ts: T("2026-08-18T13:45:00Z"), pnl_pct: 1.2, max_favorable_excursion: 1.5 }), // 09:45 ET
      row({ ticker: "B", entry_ts: T("2026-08-18T19:05:00Z"), pnl_pct: -2.0, max_favorable_excursion: 0.2 }), // 15:05 ET
      row({ ticker: "C", entry_ts: T("2026-08-18T13:50:00Z"), pnl_pct: -1.0, entry_path: "tt_cloud_pivot_long", max_favorable_excursion: 0 }),
    ];
    const g = gradeExecution(rows, {});
    expect(g.baseline.core.n).toBe(2);
    expect(g.baseline.family.n).toBe(1);
    expect(g.core.by_entry_hour_et["09:30-10:30"].n).toBe(1);
    expect(g.core.by_entry_hour_et["15:00-16:00"]).toMatchObject({ n: 1, sum_pct: -2 });
    expect(g.core.by_setup.tt_ath_breakout.n).toBe(2);
    expect(g.mfe.corrupt_n).toBe(0); // no candles -> cannot judge, never flagged
  });
});
