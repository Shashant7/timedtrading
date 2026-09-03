import { describe, it, expect } from "vitest";
import { extractWebullPositionRows } from "./bridge-webull-api.js";
import {
  normalizeWebullOptionsPositions,
  parseOccOptionSymbol,
} from "./bridge-webull-options.js";
import {
  formatOptionHoldingLabel,
  optionHoldingKey,
  optionPositionToHoldingItem,
} from "./bridge-positions-options.js";

describe("extractWebullPositionRows", () => {
  it("reads position_list (Webull's common envelope)", () => {
    const rows = extractWebullPositionRows({
      response: {
        data: {
          position_list: [
            { symbol: "SPY", instrument_type: "EQUITY", qty: 1 },
            { symbol: "SPY260920C00777000", instrument_type: "OPTION", qty: 2 },
          ],
        },
      },
    });
    expect(rows).toHaveLength(2);
  });

  it("reads bare positions arrays", () => {
    expect(extractWebullPositionRows({
      response: { data: { positions: [{ symbol: "QQQ", qty: 1 }] } },
    })).toHaveLength(1);
  });
});

describe("normalizeWebullOptionsPositions", () => {
  it("extracts OPTION rows from position_list (the bug that hid SPY calls)", () => {
    const parsed = normalizeWebullOptionsPositions({
      ok: true,
      response: {
        data: {
          position_list: [
            { symbol: "RGLD", instrument_type: "EQUITY", qty: 3 },
            {
              symbol: "SPY260920C00777000",
              instrument_type: "OPTION",
              underlying_symbol: "SPY",
              option_type: "CALL",
              strike_price: 777,
              option_expire_date: "2026-09-20",
              qty: 1,
              cost_price: 1.25,
              market_value: 160,
              unrealized_profit_loss: 35,
            },
          ],
        },
      },
    });
    expect(parsed).toHaveLength(1);
    expect(parsed[0].underlying).toBe("SPY");
    expect(parsed[0].option_type).toBe("CALL");
    expect(parsed[0].strike).toBe(777);
    expect(parsed[0].qty).toBe(1);
  });

  it("detects OCC symbols even when instrument_type is missing", () => {
    const parsed = normalizeWebullOptionsPositions({
      response: {
        data: {
          position_list: [
            { symbol: "SPY260920C00777000", qty: 2, market_value: 320 },
          ],
        },
      },
    });
    expect(parsed).toHaveLength(1);
    expect(parsed[0].underlying).toBe("SPY");
    expect(parsed[0].option_type).toBe("CALL");
    expect(parsed[0].strike).toBe(777);
    expect(parsed[0].expiration).toBe("2026-09-20");
  });
});

describe("parseOccOptionSymbol", () => {
  it("parses SPY 777 call", () => {
    expect(parseOccOptionSymbol("SPY260920C00777000")).toEqual({
      underlying: "SPY",
      expiration: "2026-09-20",
      option_type: "CALL",
      strike: 777,
    });
  });
});

describe("option holding item (end-to-end label)", () => {
  it("formats SPY 777C 09/20 for the holdings list", () => {
    const op = normalizeWebullOptionsPositions({
      response: {
        data: {
          position_list: [{
            symbol: "SPY260920C00777000",
            instrument_type: "OPTION",
            underlying_symbol: "SPY",
            option_type: "CALL",
            strike_price: 777,
            option_expire_date: "2026-09-20",
            qty: 1,
          }],
        },
      },
    })[0];
    const item = optionPositionToHoldingItem(op);
    expect(item.ticker).toBe("SPY 777C 09/20");
    expect(item.instrument).toBe("option");
    expect(item.sync_state).toBe("broker_only");
    expect(item.broker_qty).toBe(1);
    expect(formatOptionHoldingLabel(op)).toBe("SPY 777C 09/20");
    expect(optionHoldingKey(op)).toBe("OPT:SPY260920C00777000");
  });
});
