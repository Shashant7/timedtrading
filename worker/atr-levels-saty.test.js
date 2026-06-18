import { describe, expect, it } from "vitest";
import { buildATRLevelMaps, resampleMonthlyCandles } from "./indicators.js";

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

  it("uses exact quarterly and yearly anchors when Q/Y bundles are available", () => {
    const maps = buildATRLevelMaps({
      D: bundle(100, 98, 2),
      W: bundle(105, 101, 4),
      M: bundle(120, 110, 8),
      "3M": bundle(130, 123, 12),
      "12M": bundle(160, 150, 20),
    }, 155);

    expect(maps.quarter).toMatchObject({
      prevClose: 123,
      atr: 12,
      anchor_tf: "3M",
      anchor_status: "exact",
    });
    expect(maps.longterm).toMatchObject({
      prevClose: 150,
      atr: 20,
      anchor_tf: "12M",
      anchor_status: "exact",
    });
  });

  it("derives quarterly and yearly candles from monthly candles", () => {
    const month = (y, m, o, h, l, c) => ({
      ts: Date.UTC(y, m - 1, 1),
      o, h, l, c, v: 1,
    });
    const monthly = [
      month(2025, 1, 10, 12, 9, 11),
      month(2025, 2, 11, 13, 10, 12),
      month(2025, 3, 12, 14, 8, 13),
      month(2025, 4, 13, 15, 12, 14),
      month(2025, 5, 14, 16, 13, 15),
      month(2025, 6, 15, 17, 14, 16),
    ];

    const q = resampleMonthlyCandles(monthly, 3);
    expect(q).toHaveLength(2);
    expect(q[0]).toMatchObject({ o: 10, h: 14, l: 8, c: 13 });
    expect(q[1]).toMatchObject({ o: 13, h: 17, l: 12, c: 16 });

    const y = resampleMonthlyCandles(monthly, 12);
    expect(y).toHaveLength(1);
    expect(y[0]).toMatchObject({ o: 10, h: 17, l: 8, c: 16 });
  });
});
