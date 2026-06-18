import { describe, it, expect } from "vitest";
import {
  isBriefOpenTradeStatus,
  mapBriefOpenTradeRow,
  buildInfographicPositionRows,
} from "./daily-brief.js";
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
    const { investorHoldings } = buildInfographicPositionRows([], [{
      ticker: "NVDA", shares: 10, avgEntry: 100, stage: "CORE_HOLD",
    }], { NVDA: { p: 110, dp: 1.5 } });
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
});
