import { describe, it, expect } from "vitest";
import {
  isBriefOpenTradeStatus,
  mapBriefOpenTradeRow,
  buildInfographicPositionRows,
  liveDayPctFromPriceFeedRow,
  countInvestorOpenBook,
  buildBriefInvestorBook,
} from "./daily-brief.js";
import { parseBriefPositionGuidanceByTicker, stripBriefInvestorPortfolioBody } from "./daily-brief-markdown.js";
import { resolveOwnedInvestorKanbanStage } from "./investor.js";

describe("daily-brief open positions", () => {
  it("isBriefOpenTradeStatus matches ledger open filter", () => {
    expect(isBriefOpenTradeStatus("OPEN")).toBe(true);
    expect(isBriefOpenTradeStatus("TP_HIT_TRIM")).toBe(true);
    expect(isBriefOpenTradeStatus("WIN")).toBe(false);
    expect(isBriefOpenTradeStatus("LOSS")).toBe(false);
    expect(isBriefOpenTradeStatus(null)).toBe(true);
  });

  it("mapBriefOpenTradeRow keeps separate rows per trade_id (same ticker)", () => {
    const a = mapBriefOpenTradeRow({
      trade_id: "t1", ticker: "SNDK", direction: "LONG", status: "OPEN",
      entry_price: 100, pnl_pct: 1.2,
    });
    const b = mapBriefOpenTradeRow({
      trade_id: "t2", ticker: "SNDK", direction: "LONG", status: "TP_HIT_TRIM",
      entry_price: 110, pnl_pct: -0.5,
    });
    expect(a?.tradeId).toBe("t1");
    expect(b?.tradeId).toBe("t2");
    const { traderPositions } = buildInfographicPositionRows([a, b], [], {});
    expect(traderPositions).toHaveLength(2);
    expect(traderPositions.map((r) => r.ticker)).toEqual(["SNDK", "SNDK"]);
  });

  it("buildInfographicPositionRows includes investor holdings", () => {
    const now = Date.now();
    const { investorHoldings } = buildInfographicPositionRows([], [{
      ticker: "NVDA", shares: 10, avgEntry: 100, stage: "CORE_HOLD",
    }], { NVDA: { p: 110, dp: 1.5, p_ts: now } });
    expect(investorHoldings).toHaveLength(1);
    expect(investorHoldings[0].ticker).toBe("NVDA");
    expect(investorHoldings[0].unrealPct).toBeCloseTo(10, 1);
  });

  it("resolveOwnedInvestorKanbanStage prefers live scores over stale D1 column", () => {
    expect(resolveOwnedInvestorKanbanStage({ stage: "reduce" }, "accumulate")).toBe("reduce");
    expect(resolveOwnedInvestorKanbanStage({ stage: "accumulate", actionTier: "monitor" }, "accumulate")).toBe("watch");
    expect(resolveOwnedInvestorKanbanStage({ stage: "accumulate", actionTier: "act_now" }, "accumulate")).toBe("accumulate");
    expect(resolveOwnedInvestorKanbanStage(null, "accumulate")).toBe("accumulate");
  });

  it("buildInfographicPositionRows uses RTH dp when marketOpen=true (evening email path)", () => {
    const now = Date.now();
    const pf = { GRNY: { p: 27.86, pc: 27.64, dp: 0.82, ahp: 27.86, ahdp: 0, p_ts: now, t: now } };
    const { traderPositions } = buildInfographicPositionRows([{
      ticker: "GRNY", direction: "LONG", entryPrice: 27.64, pnlPct: 0.4, status: "OPEN",
    }], [], pf, true);
    expect(traderPositions[0].dayPct).toBeCloseTo(0.82, 2);
  });

  it("buildInfographicPositionRows falls back to RTH dp when EXT is flat outside RTH", () => {
    const now = Date.now();
    const pf = { GRNY: { p: 27.86, pc: 27.64, dp: 0.82, ahp: 27.86, ahdp: 0, p_ts: now, t: now } };
    const { traderPositions } = buildInfographicPositionRows([{
      ticker: "GRNY", direction: "LONG", entryPrice: 27.64, pnlPct: 0.4, status: "OPEN",
    }], [], pf, false);
    // Flat EXT (ahp parked on RTH close) should not stamp a bogus 0% — use RTH dp.
    expect(traderPositions[0].dayPct).toBeCloseTo(0.82, 2);
  });

  it("liveDayPctFromPriceFeedRow falls back to p vs pc when dp is zero during RTH", () => {
    const now = Date.now();
    const pct = liveDayPctFromPriceFeedRow(
      { p: 101, pc: 100, dp: 0, t: now, q_ts: now },
      true,
      now,
    );
    expect(pct).toBeCloseTo(1, 2);
  });

  it("buildBriefInvestorBook merges score-owned tickers missing from D1", () => {
    const book = buildBriefInvestorBook(
      [],
      {
        NVDA: { position: { owned: true, shares: 12, avg_entry: 100 }, stage: "core_hold" },
        TWLO: { position: { owned: true, shares: 5, avg_entry: 80 }, stage: "accumulate", actionTier: "monitor" },
      },
    );
    expect(book).toHaveLength(2);
    expect(book.map((p) => p.ticker).sort()).toEqual(["NVDA", "TWLO"]);
    expect(book.find((p) => p.ticker === "TWLO")?.stage).toBe("watch");
  });

  it("stripBriefInvestorPortfolioBody hides empty state when holdings exist", () => {
    const out = stripBriefInvestorPortfolioBody("• No investor positions.", true);
    expect(out).toBe("");
    const kept = stripBriefInvestorPortfolioBody("- **NVDA**: thesis intact · hold", true);
    expect(kept).toContain("thesis intact");
  });

  it("countInvestorOpenBook merges D1 rows with score-owned tickers", () => {
    const n = countInvestorOpenBook(
      [{ ticker: "NVDA", status: "OPEN", total_shares: 10 }],
      { AAPL: { position: { owned: true } }, MSFT: { position: { owned: true } } },
    );
    expect(n).toBe(3);
  });

  it("parseBriefPositionGuidanceByTicker maps ticker bullets to guidance lines", () => {
    const body = [
      "- **BRK-B**: thesis intact · HOLD near $514",
      "- **TWLO** watch · software laggard",
      "KO · accumulate on dips",
    ].join("\n");
    const map = parseBriefPositionGuidanceByTicker(body);
    expect(map["BRK-B"]).toContain("thesis intact");
    expect(map.TWLO).toContain("watch");
    expect(map.KO).toContain("accumulate");
  });
});
