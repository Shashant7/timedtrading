import { describe, it, expect } from "vitest";
import { encodeTvLevelsSeed, buildSeedSymbolInfo } from "./tv-levels-seed.js";

describe("tv-levels-seed", () => {
  it("encodes main, meta, and level symbols", () => {
    const out = encodeTvLevelsSeed({
      ticker: "AAPL",
      in_universe: true,
      direction: "LONG",
      bias: "BULL_PULLBACK",
      stage: "setup",
      rank: 68,
      price: 190,
      stop: 178.5,
      tp_trim: 195,
      tp_runner: 208,
      levels: [{ price: 192.3, label: "Swing High", role: "resistance" }],
    }, new Date("2026-06-06T12:00:00Z"));

    expect(out.symbols.length).toBe(3);
    expect(out.symbols[0].symbol).toBe("AAPL");
    expect(out.symbols[0].csv).toContain("20260606T,208,178.5,195,190,68");
    expect(out.symbols[1].symbol).toBe("AAPL_META");
    expect(out.symbols[2].symbol).toBe("AAPL_LV1");
  });

  it("buildSeedSymbolInfo matches symbol count", () => {
    const { symbols } = encodeTvLevelsSeed({
      ticker: "MSFT", direction: "NEUTRAL", in_universe: false, price: 400,
    });
    const info = buildSeedSymbolInfo(symbols);
    expect(info.body.symbol.length).toBe(symbols.length);
  });
});
