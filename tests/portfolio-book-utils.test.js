import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

describe("portfolio-book-utils", () => {
  let bookTotalPnlPct;
  let tradeLane;
  let tradeMatchesLane;

  beforeAll(() => {
    require("../react-app/portfolio-book-utils.js");
    ({ bookTotalPnlPct, tradeLane, tradeMatchesLane } = globalThis.TimedPortfolioBookUtils);
  });

  describe("bookTotalPnlPct", () => {
    it("uses realized + open over startCash when both known", () => {
      const pct = bookTotalPnlPct(
        { summary: { startCash: 100000, cumRealized: 5000, totalReturnPct: 1 } },
        2500,
        100000,
      );
      expect(pct).toBeCloseTo(7.5, 5);
    });

    it("falls back to equity-curve totalReturnPct when open is unknown", () => {
      expect(bookTotalPnlPct(
        { summary: { startCash: 100000, cumRealized: 5000, totalReturnPct: 4.2 } },
        null,
      )).toBe(4.2);
    });

    it("uses Day Trader sleeve default when startCash missing", () => {
      const pct = bookTotalPnlPct(
        { summary: { cumRealized: 1000 } },
        500,
        25000,
      );
      expect(pct).toBeCloseTo(6, 5);
    });

    it("returns null when nothing usable", () => {
      expect(bookTotalPnlPct(null, null)).toBeNull();
      expect(bookTotalPnlPct({ summary: {} }, undefined)).toBeNull();
    });
  });

  describe("tradeLane / tradeMatchesLane", () => {
    it("maps investor lots via _source_mode when _lane is missing", () => {
      const cf = {
        ticker: "CF",
        entry_price: 128.98,
        exit_price: 128.98,
        exit_ts: 1,
        status: "FLAT",
        _source_mode: "investor",
      };
      expect(tradeLane(cf)).toBe("investor");
      expect(tradeMatchesLane(cf, "index_day_trade")).toBe(false);
      expect(tradeMatchesLane(cf, "investor")).toBe(true);
    });

    it("keeps index day-trade paper rounds under Day Trader", () => {
      const spy = {
        ticker: "SPY",
        _lane: "index_day_trade",
        _paper_lane: "index_day_trade",
        exit_ts: 2,
        status: "LOSS",
      };
      expect(tradeMatchesLane(spy, "index_day_trade")).toBe(true);
      expect(tradeMatchesLane(spy, "investor")).toBe(false);
    });

    it("excludes index_swing and equity books from Day Trader", () => {
      expect(tradeMatchesLane({ _paper_lane: "index_swing" }, "index_day_trade")).toBe(false);
      expect(tradeMatchesLane({ _lane: "trader" }, "index_day_trade")).toBe(false);
      expect(tradeMatchesLane({ _lane: "investor" }, "index_day_trade")).toBe(false);
    });
  });
});
