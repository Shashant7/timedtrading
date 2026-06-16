import { describe, it, expect } from "vitest";
import {
  mergeTickerUniverse,
  resolveScoringUniverse,
  loadScoringUniverse,
} from "./universe.js";

describe("mergeTickerUniverse", () => {
  it("dedupes, uppercases, and sorts across sources", () => {
    const out = mergeTickerUniverse({
      sectorMapKeys: ["aapl", "MSFT"],
      userTickers: ["nvda", "AAPL"],
      kvTickers: ["TSLA", "msft"],
    });
    expect(out).toEqual(["AAPL", "MSFT", "NVDA", "TSLA"]);
  });

  it("filters the removed blocklist (array or Set, case-insensitive)", () => {
    expect(
      mergeTickerUniverse({ sectorMapKeys: ["AAPL", "MSFT"], removed: ["msft"] }),
    ).toEqual(["AAPL"]);
    expect(
      mergeTickerUniverse({ kvTickers: ["AAPL", "MSFT"], removed: new Set(["AAPL"]) }),
    ).toEqual(["MSFT"]);
  });

  it("includes market pulse only when passed", () => {
    expect(mergeTickerUniverse({ sectorMapKeys: ["AAPL"], marketPulse: ["BTCUSD"] }))
      .toEqual(["AAPL", "BTCUSD"]);
    expect(resolveScoringUniverse({ sectorMapKeys: ["AAPL"], marketPulse: ["BTCUSD"] }))
      .toEqual(["AAPL"]); // scoring universe never includes market pulse
  });

  it("ignores empty/falsey entries", () => {
    expect(mergeTickerUniverse({ kvTickers: ["", null, undefined, "  ", "AAPL"] }))
      .toEqual(["AAPL"]);
  });

  it("is order-independent", () => {
    const a = mergeTickerUniverse({ sectorMapKeys: ["A"], kvTickers: ["B"] });
    const b = mergeTickerUniverse({ kvTickers: ["B"], sectorMapKeys: ["A"] });
    expect(a).toEqual(b);
  });
});

describe("resolveScoringUniverse — the orphan-closing union", () => {
  it("includes screener-promoted KV tickers that are NOT in SECTOR_MAP", () => {
    // SMCI promoted via screener → written to KV timed:tickers only.
    // It MUST now appear in the scored universe (previously orphaned).
    const out = resolveScoringUniverse({
      sectorMapKeys: ["AAPL", "MSFT"],
      userTickers: ["NVDA"],
      kvTickers: ["SMCI"],
    });
    expect(out).toContain("SMCI");
    expect(out).toEqual(["AAPL", "MSFT", "NVDA", "SMCI"]);
  });
});

describe("loadScoringUniverse", () => {
  it("merges async sources and survives a failing reader", async () => {
    const out = await loadScoringUniverse({}, {
      sectorMapKeys: ["AAPL"],
      getKvTickers: async () => ["SMCI"],
      getUserTickers: async () => { throw new Error("d1 down"); },
      getRemoved: async () => ["AAPL"],
    });
    // AAPL removed; SMCI from KV survives; failing user-ticker read tolerated.
    expect(out).toEqual(["SMCI"]);
  });
});
