import { describe, it, expect } from "vitest";
import {
  dayTradeBookToTrade,
  indexTrendBookToTrade,
  formatDayTradeVehicleLabel,
  indexTrendLetfCandidates,
  applyLivePremiumToTrade,
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
});
