import { describe, it, expect } from "vitest";
import { evaluateReducerAgainstPositions } from "./bridge-guards.js";

describe("evaluateReducerAgainstPositions — never sell what you don't hold", () => {
  it("REJECTS a sell when the account holds no position (the Roth scenario)", () => {
    const r = evaluateReducerAgainstPositions({
      ticker: "AMZN", requestedQty: 3, positions: [{ symbol: "MSFT", qty: 10 }],
    });
    expect(r.action).toBe("reject");
    expect(r.reason).toBe("no_broker_position");
    expect(r.heldQty).toBe(0);
  });

  it("REJECTS when the position exists but is flat (qty 0)", () => {
    const r = evaluateReducerAgainstPositions({
      ticker: "AMZN", requestedQty: 3, positions: [{ symbol: "AMZN", qty: 0 }],
    });
    expect(r.action).toBe("reject");
    expect(r.reason).toBe("position_flat");
  });

  it("REJECTS selling into a short (negative held) — IRA can't short", () => {
    const r = evaluateReducerAgainstPositions({
      ticker: "AMZN", requestedQty: 3, positions: [{ symbol: "AMZN", qty: -5 }],
    });
    expect(r.action).toBe("reject");
  });

  it("PROCEEDS when held >= requested", () => {
    const r = evaluateReducerAgainstPositions({
      ticker: "AMZN", requestedQty: 2.8, positions: [{ symbol: "AMZN", qty: 2.8 }],
    });
    expect(r.action).toBe("proceed");
    expect(r.heldQty).toBeCloseTo(2.8, 5);
  });

  it("CLAMPS when the model asks to sell more than is held (never oversell)", () => {
    const r = evaluateReducerAgainstPositions({
      ticker: "AMZN", requestedQty: 17, positions: [{ symbol: "AMZN", qty: 2.8 }],
    });
    expect(r.action).toBe("clamp");
    expect(r.clampQty).toBeCloseTo(2.8, 5);
  });

  it("matches on ticker or symbol and sums lots", () => {
    const r = evaluateReducerAgainstPositions({
      ticker: "AMZN", requestedQty: 5, positions: [{ ticker: "AMZN", quantity: 3 }, { symbol: "AMZN", position: 4 }],
    });
    expect(r.action).toBe("proceed");
    expect(r.heldQty).toBe(7);
  });
});
