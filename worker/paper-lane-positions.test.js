import { describe, it, expect } from "vitest";
import {
  dayTradeBookToTrade,
  indexTrendBookToTrade,
  formatDayTradeVehicleLabel,
  indexTrendLetfCandidates,
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
