import { describe, expect, it } from "vitest";
import { buildATRLevelMaps } from "./indicators.js";

function bundle(px, pxPrev, atr14, high = px + 1, low = px - 1) {
  return { px, pxPrev, atr14, barHigh: high, barLow: low };
}

describe("Saty ATR level anchor mapping", () => {
  it("maps chart timeframes to Saty anchor horizons", () => {
    const maps = buildATRLevelMaps({
      D: bundle(100, 98, 2),
      W: bundle(105, 101, 4),
      M: bundle(120, 110, 8),
    }, 115);

    expect(maps.by_chart_tf).toEqual({
      lt_30: "day",
      "30": "week",
      "60": "month",
      "240": "quarter",
      D: "longterm",
      W: "longterm",
    });

    expect(maps.day).toMatchObject({
      prevClose: 98,
      atr: 2,
      anchor_tf: "D",
      intended_chart_tf: "<30",
      anchor_status: "exact",
    });
    expect(maps.week).toMatchObject({
      prevClose: 101,
      atr: 4,
      anchor_tf: "W",
      intended_chart_tf: "30",
      anchor_status: "exact",
    });
    expect(maps.month).toMatchObject({
      prevClose: 110,
      atr: 8,
      anchor_tf: "M",
      intended_chart_tf: "60",
      anchor_status: "exact",
    });
  });

  it("marks quarterly and yearly anchors as approximate until Q/Y bundles exist", () => {
    const maps = buildATRLevelMaps({
      D: bundle(100, 98, 2),
      W: bundle(105, 101, 4),
      M: bundle(120, 110, 8),
    }, 115);

    expect(maps.quarter).toMatchObject({
      anchor_tf: "3M",
      intended_chart_tf: "240",
      anchor_status: "approx_from_monthly",
    });
    expect(maps.longterm).toMatchObject({
      anchor_tf: "12M",
      intended_chart_tf: "D/W",
      anchor_status: "approx_from_monthly",
    });
  });
});
