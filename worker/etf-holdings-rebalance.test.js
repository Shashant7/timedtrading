import { describe, it, expect } from "vitest";
import { isSuspiciousHoldingsDrop } from "./etf-holdings.js";

function mkHoldings(tickers) {
  return tickers.map((ticker) => ({ ticker, weight: 2.5, name: ticker }));
}

describe("isSuspiciousHoldingsDrop", () => {
  it("flags GRNI-style truncated parse (35 -> 7, mass removal)", () => {
    const prev = mkHoldings(["BNY", "CAT", "NVDA", "MSFT", "GOOGL", "TSLA", "JPM", "GS", "META", "AMD",
      "AMZN", "LLY", "UNH", "ORCL", "PLTR", "HOOD", "PNC", "TJX", "DE", "ETN", "GE", "GEV", "KLAC",
      "MNST", "MSTR", "NFLX", "NOC", "NOW", "OKE", "PKG", "PM", "PWR", "TPL", "UNP", "CDNS"]);
    const next = mkHoldings(["AAPL", "AMD", "AMZN", "ANET", "APD", "AVGO", "AXP"]);
    expect(isSuspiciousHoldingsDrop(prev, next, { removed: new Array(28), added: [] })).toBe(true);
  });

  it("allows a modest real rebalance", () => {
    const prev = mkHoldings(["AAPL", "MSFT", "NVDA", "GOOGL", "AMZN", "META", "TSLA", "JPM", "V", "UNH"]);
    const next = mkHoldings(["AAPL", "MSFT", "NVDA", "GOOGL", "AMZN", "META", "TSLA", "JPM", "V", "PLTR"]);
    expect(isSuspiciousHoldingsDrop(prev, next, { removed: [{ ticker: "UNH" }], added: [{ ticker: "PLTR" }] })).toBe(false);
  });

  it("does not flag first-time sync with small count", () => {
    const next = mkHoldings(["AAPL", "AMD", "AMZN"]);
    expect(isSuspiciousHoldingsDrop([], next, { removed: [], added: next })).toBe(false);
  });
});
