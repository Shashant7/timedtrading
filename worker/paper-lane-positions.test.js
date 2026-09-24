import { describe, it, expect } from "vitest";
import {
  dayTradeBookToTrade,
  indexTrendBookToTrade,
  formatDayTradeVehicleLabel,
  indexTrendLetfCandidates,
  applyLivePremiumToTrade,
  normalizePaperLaneActions,
  closedTradesFromPaperActions,
} from "./paper-lane-positions.js";

describe("paper-lane-positions", () => {
  it("formats option vehicle labels", () => {
    const label = formatDayTradeVehicleLabel({
      ticker: "QQQ",
      strike: 715,
      flavor: "call",
      expiration: { iso: "2026-08-27" },
    });
    expect(label).toBe("QQQ 715C Aug 27");
  });

  it("maps day-trade book to trade row", () => {
    const row = dayTradeBookToTrade("QQQ", {
      signal_id: "dt:QQQ:x",
      book: {
        status: "open",
        ticker: "QQQ",
        flavor: "call",
        strike: 715,
        expiration: { iso: "2026-08-27" },
        entry_premium: 2.03,
        last_premium: 2.2,
        contracts: 3,
        contracts_remaining: 3,
        entry_ts: 1000,
      },
    });
    expect(row.status).toBe("OPEN");
    expect(row.instrument).toBe("option");
    expect(row._vehicle_label).toBe("QQQ 715C Aug 27");
    expect(row.pnl_pct).toBeCloseTo(8.4, 1);
    expect(row._paper_lane).toBe("index_day_trade");
    expect(row.entry_premium).toBe(2.03);
    expect(row.last_premium).toBe(2.2);
    expect(row.mark_price).toBe(2.2);
    expect(row.stop_premium).toBeCloseTo(1.01, 2);
    expect(row.sl).toBeCloseTo(1.01, 2);
  });

  it("exposes trim/exit premiums on the kanban trade row", () => {
    const row = dayTradeBookToTrade("SPY", {
      signal_id: "dt:SPY:x",
      book: {
        status: "open",
        ticker: "SPY",
        flavor: "call",
        strike: 777,
        expiration: { iso: "2026-09-04" },
        entry_premium: 0.63,
        last_premium: 0.81,
        trim_premium: 0.95,
        exit_premium: 1.26,
        stop_premium: 0.32,
        contracts: 2,
        contracts_remaining: 2,
        entry_ts: 1000,
      },
    });
    expect(row.trim_premium).toBe(0.95);
    expect(row.exit_premium).toBe(1.26);
    expect(row.tp).toBe(1.26);
    expect(row.tpArray).toEqual([0.95, 1.26]);
    expect(row.stop_premium).toBe(0.32);
  });

  it("overlays a fresh live mid onto mark/last/pnl", () => {
    const row = dayTradeBookToTrade("QQQ", {
      signal_id: "dt:QQQ:x",
      book: {
        status: "open",
        ticker: "QQQ",
        flavor: "call",
        strike: 722,
        expiration: { iso: "2026-09-04" },
        entry_premium: 1.09,
        last_premium: 1.09,
        contracts: 1,
        contracts_remaining: 1,
        entry_ts: 1000,
      },
    });
    const live = applyLivePremiumToTrade(row, 1.42);
    expect(live.mark_price).toBe(1.42);
    expect(live.last_premium).toBe(1.42);
    expect(live.pnl_pct).toBeCloseTo(30.3, 1);
  });

  it("maps index trend book to LETF trade row", () => {
    const row = indexTrendBookToTrade("SPY", "SPYU", {
      signal_id: "it:SPY:SPYU:LONG:2026-W35",
      book: {
        status: "trimmed",
        direction: "LONG",
        letf_ticker: "SPYU",
        entry_letf_price: 34.5,
        last_letf_price: 35.45,
        shares: 76,
        shares_remaining: 57,
        stop_underlying: 764.77,
        target_underlying: 791.08,
        entry_ts: 2000,
      },
    });
    expect(row.status).toBe("TP_HIT_TRIM");
    expect(row.instrument).toBe("letf");
    expect(row._vehicle_label).toBe("SPYU");
    expect(row.kanban_stage).toBe("trim");
    expect(row._paper_lane).toBe("index_swing");
  });

  it("lists SPY index trend LETF candidates", () => {
    const cands = indexTrendLetfCandidates("SPY");
    expect(cands).toContain("SPYU");
    expect(cands).toContain("SPXL");
  });

  it("normalizes DT + LETF actions into one activity feed", () => {
    const actions = normalizePaperLaneActions({
      dayTrade: [
        { ts: 2000, event: "BUY", ticker: "QQQ", signal_id: "dt:1", contracts: 2, premium: 1.1 },
        { ts: 3000, event: "EXIT", ticker: "QQQ", signal_id: "dt:1", contracts: 2, premium: 1.4 },
      ],
      indexTrend: [
        { ts: 2500, event: "BUY", underlying: "SPY", letf_ticker: "SPYU", signal_id: "it:1", shares: 10, letf_price: 40 },
      ],
    });
    expect(actions).toHaveLength(3);
    expect(actions[0].event).toBe("EXIT");
    expect(actions[0].lane).toBe("index_day_trade");
    expect(actions[1].lane).toBe("index_swing");
    expect(actions[1].vehicle).toBe("SPYU");
  });

  it("rebuilds closed paper trades from BUY→EXIT/STOP pairs", () => {
    const actions = normalizePaperLaneActions({
      dayTrade: [
        { ts: 1000, event: "BUY", ticker: "SPY", signal_id: "dt:a", contracts: 3, premium: 1.0 },
        { ts: 1500, event: "TRIM", ticker: "SPY", signal_id: "dt:a", contracts: 1, premium: 1.2 },
        { ts: 2000, event: "EXIT", ticker: "SPY", signal_id: "dt:a", contracts: 2, premium: 1.5 },
      ],
      indexTrend: [
        { ts: 1100, event: "BUY", underlying: "QQQ", letf_ticker: "TQQQ", signal_id: "it:b", shares: 20, letf_price: 50 },
        { ts: 2100, event: "STOP", underlying: "QQQ", letf_ticker: "TQQQ", signal_id: "it:b", shares: 20, letf_price: 45 },
      ],
    });
    const closed = closedTradesFromPaperActions(actions);
    expect(closed).toHaveLength(2);
    const dt = closed.find((t) => t.signal_id === "dt:a");
    expect(dt.status).toBe("WIN");
    expect(dt._paper_lane).toBe("index_day_trade");
    // (1.5 - 1.0) * 2 contracts * 100 = $100
    expect(dt.realized_pnl).toBe(100);
    expect(dt.realized_pct).toBe(50);
    const it = closed.find((t) => t.signal_id === "it:b");
    expect(it.status).toBe("LOSS");
    expect(it._paper_lane).toBe("index_swing");
    // (45 - 50) * 20 = -$100
    expect(it.realized_pnl).toBe(-100);
  });
});
