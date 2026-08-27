import { describe, it, expect } from "vitest";
import {
  paperEventToActivityType,
  paperEventToNotifType,
  buildPaperLaneActivityRow,
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
});
