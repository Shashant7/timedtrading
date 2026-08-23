import { describe, it, expect } from "vitest";
import { classifyBookFill, buildBookAutopsyReport } from "./program-book-autopsy.js";

describe("classifyBookFill", () => {
  it("keeps a canonical support bounce in core even with a paper stamp", () => {
    const cls = classifyBookFill(
      { entry_path: "tt_n_test_support" },
      { inputs_json: JSON.stringify({ slice_family: "confirm_stack_ema21", sequence_paper_queue: { family: "confirm_stack_ema21" } }) },
    );
    expect(cls.program).toBe("core");
    expect(cls.coincident_paper).toBe(true);
    expect(cls.family_stamp).toBe("confirm_stack_ema21");
  });

  it("labels a cloud-pivot-only fill as the experiment", () => {
    const cls = classifyBookFill(
      { entry_path: null },
      { inputs_json: JSON.stringify({ slice_family: "tt_cloud_pivot" }) },
    );
    expect(cls.program).toBe("tt_cloud_pivot");
    expect(cls.coincident_paper).toBe(false);
  });
});

describe("buildBookAutopsyReport", () => {
  it("shows experiment $ drag without moving a core path into the experiment bucket", () => {
    const report = buildBookAutopsyReport({
      trades: [
        { trade_id: "C1", ticker: "NVDA", direction: "LONG", status: "WIN", pnl: 400, pnl_pct: 2, entry_path: "tt_n_test_support", entry_ts: 1, max_favorable_excursion: 3, max_adverse_excursion: -0.5, notional: 20000 },
        { trade_id: "E1", ticker: "AXON", direction: "LONG", status: "LOSS", pnl: -30, pnl_pct: -1, entry_path: null, entry_ts: 2, max_favorable_excursion: 0.4, max_adverse_excursion: -1.2, notional: 200 },
      ],
      decisions: [
        { trade_id: "C1", event_type: "ENTRY", inputs_json: JSON.stringify({ slice_family: "confirm_stack_ema21" }) },
        { trade_id: "E1", event_type: "ENTRY", inputs_json: JSON.stringify({ slice_family: "tt_cloud_pivot" }) },
      ],
    });
    expect(report.headline.core.n).toBe(1);
    expect(report.headline.experiments.n).toBe(1);
    expect(report.headline.pollution.usd_drag).toBe(-30);
    expect(report.headline.coincident.n).toBe(1);
    expect(report.programs.core.pnl_usd).toBe(400);
    expect(report.core.winners[0].key).toBe("NVDA");
    expect(report.coincident.by_family[0].key).toBe("confirm_stack_ema21");
    expect(report.eras.stamped_clean.n).toBe(0);
    expect(report.eras.coincident.n).toBe(1);
  });

  it("keeps summarize.n as fill count when some rows are still open", () => {
    const report = buildBookAutopsyReport({
      trades: [
        { trade_id: "C1", ticker: "NVDA", direction: "LONG", status: "WIN", pnl: 100, pnl_pct: 1, entry_path: "tt_n_test_support", entry_ts: 1 },
        { trade_id: "O1", ticker: "TSLA", direction: "LONG", status: "OPEN", pnl: 0, pnl_pct: 0, entry_path: "tt_ath_breakout", entry_ts: 2 },
      ],
    });
    expect(report.fills).toBe(2);
    expect(report.headline.core.n).toBe(2);
    expect(report.headline.core.closed).toBe(1);
    expect(report.headline.core.open).toBe(1);
    expect(report.open_trades).toHaveLength(1);
    expect(report.open_trades[0].ticker).toBe("TSLA");
  });

  it("lists never-won tickers separately from net losers", () => {
    const report = buildBookAutopsyReport({
      trades: [
        { trade_id: "A1", ticker: "MIX", status: "WIN", pnl: 50, pnl_pct: 1, entry_path: "tt_ath_breakout", entry_ts: 1 },
        { trade_id: "A2", ticker: "MIX", status: "LOSS", pnl: -80, pnl_pct: -1, entry_path: "tt_ath_breakout", entry_ts: 2 },
        { trade_id: "B1", ticker: "DEAD", status: "LOSS", pnl: -40, pnl_pct: -1, entry_path: "tt_ath_breakout", entry_ts: 3 },
        { trade_id: "B2", ticker: "DEAD", status: "LOSS", pnl: -40, pnl_pct: -1, entry_path: "tt_ath_breakout", entry_ts: 4 },
        { trade_id: "B3", ticker: "DEAD", status: "LOSS", pnl: -40, pnl_pct: -1, entry_path: "tt_ath_breakout", entry_ts: 5 },
      ],
    });
    expect(report.core.losers[0].key).toBe("DEAD");
    expect(report.core.never_won.map((r) => r.key)).toEqual(["DEAD"]);
    expect(report.core.stamped_clean_by_path[0].key).toBe("tt_ath_breakout");
  });
});
