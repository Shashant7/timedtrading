import { describe, expect, it } from "vitest";
import { renderChartSvg } from "./chart-svg.js";

function sampleCandles(n = 8) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const o = 100 + i;
    const c = o + (i % 2 === 0 ? 1.5 : -1.2);
    out.push({
      ts: Date.UTC(2026, 8, 1 + i, 20, 0, 0),
      o,
      h: Math.max(o, c) + 0.8,
      l: Math.min(o, c) - 0.6,
      c,
    });
  }
  return out;
}

describe("renderChartSvg", () => {
  it("defaults to a close line so trade-alert emails stay unchanged", () => {
    const svg = renderChartSvg({
      ticker: "AAPL",
      tf: "60",
      candles: sampleCandles(),
      entry: 104,
      sl: 99.5,
      tp: 110,
    });
    expect(svg).toContain("<polyline");
    expect(svg).not.toMatch(/<rect [^>]*fill="#00c853"/);
    expect(svg).toContain("E 104.0");
    expect(svg).toContain("SL");
    expect(svg).toContain("TP");
  });

  it("draws candle bodies, wicks, and a labeled trendline", () => {
    const svg = renderChartSvg({
      ticker: "CRDO",
      tf: "D",
      style: "candles",
      candles: sampleCandles(12),
      tl0: 102,
      tl1: 108,
      tlSpan: 6,
      tlLabel: "Resistance",
      subtitle: "Falling resistance at $108.00",
    });
    expect(svg).toMatch(/<rect [^>]*fill="#00c853"/);
    expect(svg).not.toContain("<polyline");
    expect(svg).toContain("Resistance 108.0");
    expect(svg).toContain("#a78bfa");
    expect(svg).toContain("Falling resistance");
  });

  it("labels a horizontal shelf as Support instead of E", () => {
    const svg = renderChartSvg({
      ticker: "ORCL",
      tf: "D",
      style: "candles",
      candles: sampleCandles(),
      entry: 105,
      levelLabel: "Support",
    });
    expect(svg).toContain("Support 105.0");
    expect(svg).not.toContain("E 105");
  });
});
