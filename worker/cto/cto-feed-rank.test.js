import { describe, it, expect } from "vitest";
import {
  pickLeadingCTOMagnet,
  scoreCTOFeedItem,
  rankCTOFeedItems,
  buildCTOFeedItemsFromRollup,
} from "./cto-service.js";

describe("cto feed ranking", () => {
  const baseItem = (overrides = {}) => ({
    ticker: "AAPL",
    read_kind: "upside",
    lean: "up",
    is_index: false,
    top_upside: {
      label: "R1",
      price: 210,
      adj_prob: 0.72,
      distance_pct: 2.5,
      level_status: "open",
      live_distance_pct: 2.5,
    },
    top_downside: {
      label: "S1",
      price: 190,
      adj_prob: 0.55,
      distance_pct: -3.0,
      level_status: "open",
      live_distance_pct: -3.0,
    },
    read_status: { status: "open", label: "Upside lean open" },
    ...overrides,
  });

  it("picks lean-aligned leading magnet", () => {
    const item = baseItem({ lean: "down", read_kind: "downside" });
    expect(pickLeadingCTOMagnet(item)?.label).toBe("S1");
  });

  it("scores early open setups above exhausted hits", () => {
    const early = scoreCTOFeedItem(baseItem());
    const hit = scoreCTOFeedItem(baseItem({
      top_upside: { ...baseItem().top_upside, level_status: "hit", live_distance_pct: 0.1 },
      read_status: { status: "confirmed", label: "Upside magnet hit" },
    }));
    expect(early).toBeGreaterThan(hit);
  });

  it("ranks movers by composite score and pins indexes", () => {
    const items = [
      baseItem({ ticker: "SPY", is_index: true, sort_prob: 0.6 }),
      baseItem({ ticker: "KO", is_index: false, top_upside: { ...baseItem().top_upside, adj_prob: 0.5 } }),
      baseItem({ ticker: "NVDA", is_index: false, top_upside: { ...baseItem().top_upside, adj_prob: 0.88 } }),
    ];
    const ranked = rankCTOFeedItems(items, { limit: 3 });
    expect(ranked[0].ticker).toBe("SPY");
    expect(ranked[1].ticker).toBe("NVDA");
    expect(ranked[2].ticker).toBe("KO");
  });

  it("buildCTOFeedItemsFromRollup respects limit with index pinning", () => {
    const rollup = {
      results: [
        { ticker: "SPY", ok: true, top_upside: [{ label: "U", price: 500, regime_adjusted_prob: 0.7, distance_pct: 1 }], top_downside: [{ label: "D", price: 480, regime_adjusted_prob: 0.6, distance_pct: -1 }] },
        { ticker: "AAPL", ok: true, top_upside: [{ label: "U", price: 210, regime_adjusted_prob: 0.9, distance_pct: 2 }], top_downside: [{ label: "D", price: 190, regime_adjusted_prob: 0.4, distance_pct: -2 }] },
        { ticker: "MSFT", ok: true, top_upside: [{ label: "U", price: 410, regime_adjusted_prob: 0.5, distance_pct: 2 }], top_downside: [{ label: "D", price: 390, regime_adjusted_prob: 0.4, distance_pct: -2 }] },
      ],
    };
    const out = buildCTOFeedItemsFromRollup(rollup, { limit: 2 });
    expect(out.length).toBe(2);
    expect(out.some((it) => it.ticker === "SPY")).toBe(true);
  });
});
