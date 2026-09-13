import { describe, expect, it } from "vitest";
import { collapseChartCandles, renderChartSvg } from "./chart-svg.js";

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

  it("collapses 00:00 and 04:00 UTC stamps of the same daily session", () => {
    const dup = [
      { ts: Date.UTC(2026, 5, 22, 0, 0, 0), o: 626.22, h: 641.18, l: 620.69, c: 640.18, v: 10737300 },
      { ts: Date.UTC(2026, 5, 22, 4, 0, 0), o: 626.22, h: 641.18, l: 620.69, c: 640.18, v: 10746253 },
      { ts: Date.UTC(2026, 5, 23, 0, 0, 0), o: 581.93, h: 592.5, l: 573.51, c: 585.88, v: 12035100 },
    ];
    const out = collapseChartCandles(dup, "D");
    expect(out).toHaveLength(2);
    expect(out[0].ts).toBe(Date.UTC(2026, 5, 22, 4, 0, 0));
    expect(out[1].c).toBe(585.88);
    const svg = renderChartSvg({ ticker: "AMAT", tf: "D", style: "candles", candles: dup });
    const bodies = svg.match(/<rect [^>]*fill="#(?:00c853|f43f5e)"/g) || [];
    expect(bodies).toHaveLength(2);
    expect(svg).toContain(">6/22<");
    expect(svg).not.toMatch(/6\/22 20:00/);
  });
});
