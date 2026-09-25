import { describe, it, expect } from "vitest";
import {
  formatOptionHoldingLabel,
  optionHoldingKey,
  optionPositionToHoldingItem,
  looksLikeOptionPosition,
  extractOptionsFromPositionsResult,
  attachPortfolioOptions,
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

describe("extractOptionsFromPositionsResult", () => {
  const spyCall = {
    symbol: "SPY260920C00777000",
    underlying: "SPY",
    qty: 2,
    option_type: "CALL",
    strike: 777,
    expiration: "2026-09-20",
    avg_cost: 1.25,
    market_value: 320,
    unrealized_pnl: 70,
  };

  it("prefers bundled .options over equity .positions", () => {
    const rows = extractOptionsFromPositionsResult({
      ok: true,
      positions: [{ ticker: "AAPL", qty: 10 }],
      options: [spyCall],
    });
    expect(rows).toEqual([spyCall]);
  });

  it("does not treat an equity book as option lots", () => {
    expect(extractOptionsFromPositionsResult({
      ok: true,
      positions: [{ ticker: "AAPL", qty: 10 }, { ticker: "MSFT", qty: 4 }],
    })).toEqual([]);
  });

  it("accepts a dedicated getOptionsPositions payload", () => {
    const rows = extractOptionsFromPositionsResult({ ok: true, positions: [spyCall] });
    expect(rows).toEqual([spyCall]);
  });

  it("pulls IBKR OPT rows out of response", () => {
    const rows = extractOptionsFromPositionsResult({
      ok: true,
      response: [
        { ticker: "AAPL", assetClass: "STK", position: 5, mktValue: 1000 },
        { ticker: "SPY", assetClass: "OPT", putOrCall: "C", strike: 777, expiry: "2026-09-20", position: 2, mktValue: 320, avgCost: 1.25 },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].underlying).toBe("SPY");
    expect(rows[0].option_type).toBe("C");
    expect(rows[0].qty).toBe(2);
  });
});

describe("attachPortfolioOptions", () => {
  it("stamps options_positions without changing equity positions_count", () => {
    const summary = { user_id: "a@b.com", positions_count: 3 };
    attachPortfolioOptions(summary, {
      ok: true,
      positions: [{ ticker: "AAPL", qty: 10 }],
      options: [{
        symbol: "SPY260920C00777000",
        underlying: "SPY",
        qty: 2,
        option_type: "CALL",
        strike: 777,
        expiration: "2026-09-20",
        avg_cost: 1.25,
        market_value: 320,
        unrealized_pnl: 70,
      }],
    });
    expect(summary.positions_count).toBe(3);
    expect(summary.options_count).toBe(1);
    expect(summary.options_positions[0].instrument).toBe("option");
    expect(summary.options_positions[0].ticker).toBe("SPY 777C 09/20");
    expect(summary.options_positions[0].broker_qty).toBe(2);
  });

  it("dedupes the same OCC symbol", () => {
    const summary = {};
    const op = {
      symbol: "SPY260920C00777000",
      underlying: "SPY",
      qty: 1,
      option_type: "CALL",
      strike: 777,
      expiration: "2026-09-20",
    };
    attachPortfolioOptions(summary, { options: [op, { ...op, qty: 2 }] });
    expect(summary.options_count).toBe(1);
  });
});

describe("looksLikeOptionPosition", () => {
  it("does not flag a share lot", () => {
    expect(looksLikeOptionPosition({ ticker: "AAPL", qty: 10, market_value: 2000 })).toBe(false);
  });
});
