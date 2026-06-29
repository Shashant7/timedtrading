import { describe, it, expect } from "vitest";
import { parseTdQuote, fromTdSymbol, toTdSymbol } from "./twelvedata.js";

describe("parseTdQuote", () => {
  it("prefers last_quote_at over minute-bar timestamp during RTH", () => {
    const q = parseTdQuote({
      close: "740.93",
      timestamp: 1781789400,
      last_quote_at: 1781812500,
      previous_close: "722.51",
      open: "736.74",
      high: "741.8",
      low: "732.6",
      volume: "4495112",
    });
    expect(q.price).toBe(740.93);
    expect(q.trade_ts).toBe(1781812500 * 1000);
  });
});

describe("fromTdSymbol / toTdSymbol", () => {
  it("round-trips BRK-B through TwelveData BRK.B alias", () => {
    expect(toTdSymbol("BRK-B")).toBe("BRK.B");
    expect(fromTdSymbol("BRK.B")).toBe("BRK-B");
  });
});
