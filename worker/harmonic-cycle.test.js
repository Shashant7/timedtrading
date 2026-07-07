import { describe, it, expect } from "vitest";
import {
  analyzeHarmonicCycle,
  buildHarmonicWaveSeries,
  detrendLogSeries,
  fitSinusoidAtPeriod,
  harmonicPhasePct,
  labelHarmonicInflection,
  rankHarmonicPeriods,
  scaleWaveToPriceRange,
  addCalendarDays,
  PRIMARY_CYCLE_PERIODS,
} from "./harmonic-cycle.js";

function synthSine(period, n, amp = 1, noise = 0) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(100 + amp * Math.sin((2 * Math.PI * i) / period) + (noise ? (Math.random() - 0.5) * noise : 0));
  }
  return out;
}

describe("fitSinusoidAtPeriod", () => {
  it("finds strong power at the embedded period", () => {
    const series = detrendLogSeries(synthSine(60, 300, 0.05));
    const fit60 = fitSinusoidAtPeriod(series, 60);
    const fit90 = fitSinusoidAtPeriod(series, 90);
    expect(fit60?.power).toBeGreaterThan(fit90?.power);
  });
});

describe("rankHarmonicPeriods", () => {
  it("ranks the true period highest for a clean sine", () => {
    const series = detrendLogSeries(synthSine(180, 360, 0.04));
    const ranked = rankHarmonicPeriods(series, [60, 92, 119, 180, 315], 3);
    expect(ranked[0].period).toBe(180);
  });
});

describe("analyzeHarmonicCycle", () => {
  it("returns dominant periods and a phase label", () => {
    const closes = synthSine(180, 360, 0.05);
    const out = analyzeHarmonicCycle(closes, { minBars: 240, topN: 4 });
    expect(out.ok).toBe(true);
    expect(out.dominant_periods).toContain(180);
    expect(out.primary_period).toBeTruthy();
    expect(out.label).toBeTruthy();
    expect(out.phase_pct).toBeGreaterThanOrEqual(0);
    expect(out.phase_pct).toBeLessThanOrEqual(1);
  });

  it("rejects short series", () => {
    expect(analyzeHarmonicCycle(synthSine(60, 100)).ok).toBe(false);
  });
});

describe("labelHarmonicInflection", () => {
  it("marks late cycle before peak rollover", () => {
    expect(labelHarmonicInflection(0.65, -1)).toBe("late cycle / approaching peak");
    expect(labelHarmonicInflection(0.8, -1)).toBe("past peak / down-cycle");
  });
});

describe("harmonicPhasePct", () => {
  it("maps peak near 0.5", () => {
    expect(harmonicPhasePct(Math.PI / 2)).toBeCloseTo(0.5, 2);
  });
});

describe("PRIMARY_CYCLE_PERIODS", () => {
  it("includes desk windows", () => {
    expect(PRIMARY_CYCLE_PERIODS).toEqual([180, 315]);
  });
});

describe("buildHarmonicWaveSeries", () => {
  it("returns aligned price + scaled wave history and projection", () => {
    const closes = synthSine(60, 240, 8, 0);
    const detrended = detrendLogSeries(closes);
    const ranked = rankHarmonicPeriods(detrended, [60, 92, 180], 3);
    const dates = closes.map((_, i) => `2024-01-${String((i % 28) + 1).padStart(2, "0")}`);
    const series = buildHarmonicWaveSeries(closes, dates, ranked, {
      historyBars: 120,
      projectBars: 10,
    });
    expect(series).toBeTruthy();
    expect(series.history.length).toBe(120);
    expect(series.projection.length).toBe(10);
    expect(series.history[0]).toHaveProperty("p");
    expect(series.history[0]).toHaveProperty("w");
    const histPrices = series.history.map((pt) => pt.p);
    const histWaves = series.history.map((pt) => pt.w);
    const pMin = Math.min(...histPrices);
    const pMax = Math.max(...histPrices);
    expect(Math.min(...histWaves)).toBeGreaterThanOrEqual(pMin - 0.01);
    expect(Math.max(...histWaves)).toBeLessThanOrEqual(pMax + 0.01);
  });
});

describe("scaleWaveToPriceRange", () => {
  it("maps wave extrema onto price extrema", () => {
    const scaled = scaleWaveToPriceRange([-1, 0, 1], [10, 15, 20]);
    expect(scaled[0]).toBeCloseTo(10, 5);
    expect(scaled[2]).toBeCloseTo(20, 5);
  });
});

describe("addCalendarDays", () => {
  it("advances ISO dates", () => {
    expect(addCalendarDays("2026-07-07", 3)).toBe("2026-07-10");
  });
});

describe("analyzeHarmonicCycle series", () => {
  it("includes wave_series when requested", () => {
    const closes = synthSine(180, 360, 0.05);
    const out = analyzeHarmonicCycle(closes, { minBars: 240, topN: 4, includeSeries: true });
    expect(out.ok).toBe(true);
    expect(out.wave_series?.history?.length).toBeGreaterThan(0);
    expect(out.source).toBe("harmonic-cycle.v2");
  });
});
