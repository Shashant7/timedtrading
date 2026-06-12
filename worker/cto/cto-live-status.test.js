import { describe, it, expect } from "vitest";
import {
  enrichCTOLevel,
  computeCTOReadStatus,
  enrichCTOFeedItem,
} from "./cto-live-status.js";

describe("enrichCTOLevel", () => {
  const upLevel = { label: "R1", price: 110, adj_prob: 0.72, distance_pct: 2.5 };

  it("marks upside hit when live price reaches target", () => {
    const out = enrichCTOLevel(upLevel, "up", 110, 100);
    expect(out.level_status).toBe("hit");
    expect(out.live_distance_pct).toBeCloseTo(0, 1);
  });

  it("marks upside faded when price drops materially from anchor", () => {
    const out = enrichCTOLevel(upLevel, "up", 98, 100);
    expect(out.level_status).toBe("faded");
    expect(out.live_distance_pct).toBeGreaterThan(0);
  });

  it("computes live distance from current quote", () => {
    const out = enrichCTOLevel(upLevel, "up", 105, 100);
    expect(out.level_status).toBe("open");
    expect(out.live_distance_pct).toBeCloseTo(4.76, 1);
  });
});

describe("computeCTOReadStatus", () => {
  it("flags upside lean as confirmed when upside magnet hits", () => {
    const item = {
      read_kind: "upside",
      lean: "up",
      top_upside: { level_status: "hit" },
      top_downside: { level_status: "open" },
    };
    expect(computeCTOReadStatus(item).status).toBe("confirmed");
  });

  it("flags upside lean as against when downside hits first", () => {
    const item = {
      read_kind: "upside",
      lean: "up",
      top_upside: { level_status: "open" },
      top_downside: { level_status: "hit" },
    };
    expect(computeCTOReadStatus(item).status).toBe("against");
  });
});

describe("enrichCTOFeedItem", () => {
  it("attaches read_status to feed rows", () => {
    const item = {
      ticker: "SPY",
      read_kind: "upside",
      lean: "up",
      top_upside: { label: "R1", price: 520, adj_prob: 0.8 },
      top_downside: { label: "S1", price: 500, adj_prob: 0.6 },
    };
    const out = enrichCTOFeedItem(item, 525, 510);
    expect(out.live_price).toBe(525);
    expect(out.anchor_price).toBe(510);
    expect(out.top_upside.level_status).toBe("hit");
    expect(out.read_status.status).toBe("confirmed");
  });
});
