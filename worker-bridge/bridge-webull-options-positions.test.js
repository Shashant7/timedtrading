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

// The shape Webull actually returns (captured live 2026-09-24). The contract
// lives on `legs[]`; the top level carries only the underlying and the combo
// quantity. Reading the top level alone made every option position strike 0 /
// expiration null / right CALL — which is what rejected the IWM 279P stop-out
// with `no_held_position` while the contract sat long in the account.
function webullComboRow(strike, { optionType = "PUT", qty = "1", cost = "0.65" } = {}) {
  return {
    currency: "USD",
    quantity: qty,
    cost: String(Number(cost) * 100),
    legs: [{
      symbol: "IWM",
      cost,
      leg_id: `LEG${strike}`,
      instrument_type: "OPTION",
      last_price: "0.525",
      option_type: optionType,
      option_expire_date: "2026-09-25",
      option_exercise_price: String(strike),
      option_contract_multiplier: "100",
    }],
    position_id: `POS${strike}`,
    symbol: "IWM",
    option_strategy: "SINGLE",
    instrument_type: "OPTION",
    cost_price: cost,
    last_price: "0.53",
    market_value: "52.50",
  };
}

describe("normalizeWebullOptionsPositions — Webull combo/legs shape", () => {
  it("reads strike, expiration and right off the leg", () => {
    const [p] = normalizeWebullOptionsPositions({
      response: { data: { position_list: [webullComboRow(279)] } },
    });
    expect(p.underlying).toBe("IWM");
    expect(p.option_type).toBe("PUT");
    expect(p.strike).toBe(279);
    expect(p.expiration).toBe("2026-09-25");
    expect(p.qty).toBe(1);
  });

  it("synthesizes an OCC symbol so two strikes do not collide", () => {
    const parsed = normalizeWebullOptionsPositions({
      response: { data: { position_list: [webullComboRow(279), webullComboRow(280)] } },
    });
    expect(parsed).toHaveLength(2);
    expect(parsed.map((p) => p.symbol)).toEqual([
      "IWM260925P00279000",
      "IWM260925P00280000",
    ]);
    expect(new Set(parsed.map(optionHoldingKey)).size).toBe(2);
  });

  it("labels the holding by its real contract, not IWM 0C", () => {
    const [p] = normalizeWebullOptionsPositions({
      response: { data: { position_list: [webullComboRow(279)] } },
    });
    expect(formatOptionHoldingLabel(p)).toBe("IWM 279P 09/25");
    expect(optionPositionToHoldingItem(p).option_type).toBe("PUT");
  });

  it("never guesses a right it was not given", () => {
    const [p] = normalizeWebullOptionsPositions({
      response: {
        data: {
          position_list: [{
            symbol: "IWM",
            instrument_type: "OPTION",
            quantity: "1",
            legs: [{
              symbol: "IWM",
              instrument_type: "OPTION",
              option_expire_date: "2026-09-25",
              option_exercise_price: "279",
            }],
          }],
        },
      },
    });
    expect(p.option_type).toBeNull();
  });

  it("marks an unlabelled multi-leg combo as direction-unknown", () => {
    const parsed = normalizeWebullOptionsPositions({
      response: {
        data: {
          position_list: [{
            symbol: "SPY",
            instrument_type: "OPTION",
            option_strategy: "VERTICAL",
            quantity: "1",
            legs: [
              { symbol: "SPY", instrument_type: "OPTION", option_type: "CALL", option_expire_date: "2026-09-25", option_exercise_price: "770" },
              { symbol: "SPY", instrument_type: "OPTION", option_type: "CALL", option_expire_date: "2026-09-25", option_exercise_price: "775" },
            ],
          }],
        },
      },
    });
    expect(parsed).toHaveLength(2);
    expect(parsed.every((p) => p.direction_unknown)).toBe(true);
  });

  it("signs an explicitly short leg negative", () => {
    const [p] = normalizeWebullOptionsPositions({
      response: {
        data: {
          position_list: [{
            symbol: "SPY",
            instrument_type: "OPTION",
            quantity: "2",
            legs: [{
              symbol: "SPY",
              side: "SELL",
              instrument_type: "OPTION",
              option_type: "PUT",
              option_expire_date: "2026-09-25",
              option_exercise_price: "760",
            }],
          }],
        },
      },
    });
    expect(p.qty).toBe(-2);
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
