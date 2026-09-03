import { describe, it, expect } from "vitest";
import {
  formatOptionHoldingLabel,
  optionHoldingKey,
  optionPositionToHoldingItem,
} from "./bridge-positions-options.js";

describe("formatOptionHoldingLabel", () => {
  it("formats SPY 777 call with expiration", () => {
    expect(formatOptionHoldingLabel({
      underlying: "SPY",
      option_type: "CALL",
      strike: 777,
      expiration: "2026-09-20",
    })).toBe("SPY 777C 09/20");
  });

  it("formats puts and fractional strikes", () => {
    expect(formatOptionHoldingLabel({
      underlying: "QQQ",
      option_type: "PUT",
      strike: 480.5,
      expiration: "2026-10-17",
    })).toBe("QQQ 480.50P 10/17");
  });
});

describe("optionPositionToHoldingItem", () => {
  it("marks holdings as broker_only options", () => {
    const item = optionPositionToHoldingItem({
      symbol: "SPY260920C00777000",
      underlying: "SPY",
      qty: 2,
      option_type: "CALL",
      strike: 777,
      expiration: "2026-09-20",
      avg_cost: 1.25,
      market_value: 320,
      unrealized_pnl: 70,
    });
    expect(item.instrument).toBe("option");
    expect(item.option_type).toBe("CALL");
    expect(item.sync_state).toBe("broker_only");
    expect(item.managed).toBe(false);
    expect(item.ticker).toBe("SPY 777C 09/20");
    expect(item.broker_qty).toBe(2);
    expect(optionHoldingKey({ symbol: "SPY260920C00777000" })).toBe("OPT:SPY260920C00777000");
  });
});
