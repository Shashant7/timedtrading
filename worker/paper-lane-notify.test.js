import { describe, it, expect } from "vitest";
import {
  paperEventToActivityType,
  paperEventToNotifType,
  buildPaperLaneActivityRow,
  buildPaperLaneEmailAlert,
} from "./paper-lane-notify.js";

describe("paper-lane-notify", () => {
  it("maps BUY/TRIM/EXIT to trader feed + bell types", () => {
    expect(paperEventToActivityType("BUY")).toBe("TRADE_ENTRY");
    expect(paperEventToActivityType("TRIM")).toBe("TRADE_TRIM");
    expect(paperEventToActivityType("STOP")).toBe("TRADE_EXIT");
    expect(paperEventToNotifType("DCA_ADD")).toBe("trade_entry");
    expect(paperEventToNotifType("TRIM")).toBe("trade_trim");
    expect(paperEventToNotifType("EXIT")).toBe("trade_exit");
  });

  it("builds activity rows with vehicle lane labels", () => {
    const row = buildPaperLaneActivityRow({
      engine: "index_trend_letf",
      event: "TRIM",
      ticker: "SPY",
      vehicleTicker: "SPYU",
      direction: "LONG",
      price: 35.5,
      qty: 57,
      reason: "trim 1r",
      signal_id: "it:SPY:SPYU:LONG:2026-W35",
      embed: { title: "TRIM SPYU · Index Trend (SPY)" },
    });
    expect(row.type).toBe("TRADE_TRIM");
    expect(row.ticker).toBe("SPYU");
    expect(row.underlying).toBe("SPY");
    expect(row.vehicle_lane).toBe("Index Swings");
    expect(row.detail).toContain("TRIM SPYU");
  });

  it("builds LETF exit email alert with entry + PnL like Short Term exits", () => {
    const alert = buildPaperLaneEmailAlert({
      engine: "index_trend_letf",
      event: "EXIT",
      ticker: "SPY",
      vehicleTicker: "SPYU",
      direction: "LONG",
      price: 35.55,
      qty: 43,
      reason: "target_deadline",
      signal_id: "it:SPY:SPYU:LONG:2026-W35",
      book: {
        entry_letf_price: 34.5,
        shares_remaining: 43,
        stop_underlying: 764.77,
        target_underlying: 791.08,
      },
    });
    expect(alert.type).toBe("TRADE_EXIT");
    expect(alert.mode).toBe("trader");
    expect(alert.ticker).toBe("SPYU");
    expect(alert.entry).toBe(34.5);
    expect(alert.exit).toBe(35.55);
    expect(alert.pnlPct).toBeCloseTo(3.04, 1);
    expect(alert.shares).toBe(43);
    expect(alert.setup_name).toBe("TT Index Swings LETF");
    expect(alert.sl).toBe(764.77);
  });

  it("builds day-trade exit email alert with premium entry + PnL", () => {
    const alert = buildPaperLaneEmailAlert({
      engine: "options_day_trade",
      event: "STOP",
      ticker: "QQQ",
      vehicleTicker: "QQQ 715C",
      direction: "LONG",
      price: 1.7,
      book: { entry_premium: 2.03, contracts_remaining: 3 },
    });
    expect(alert.type).toBe("TRADE_EXIT");
    expect(alert.entry).toBe(2.03);
    expect(alert.exit).toBe(1.7);
    expect(alert.pnlPct).toBeLessThan(0);
  });
});
