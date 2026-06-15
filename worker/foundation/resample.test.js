// worker/foundation/resample.test.js
import { describe, it, expect } from "vitest";
import {
  resampleAligned, resampleIntradaySessions,
  resampleDailyToWeekly, resampleDailyToMonthly,
} from "./resample.js";
import { expectedIntradayBuckets, sessionBoundsUtc } from "./trading-calendar.js";

// Build a synthetic full 5m session for 2026-06-12 with deterministic OHLCV.
function session5m(dateStr) {
  return expectedIntradayBuckets(dateStr, 5).map((ts, i) => ({
    ts, o: 100 + i, h: 100 + i + 0.5, l: 100 + i - 0.5, c: 100 + i + 0.2, v: 10,
  }));
}

describe("resample: OHLCV aggregation", () => {
  it("aggregates o=first h=max l=min c=last v=sum", () => {
    const anchor = 0;
    const bars = [
      { ts: 0, o: 10, h: 12, l: 9, c: 11, v: 5 },
      { ts: 300000, o: 11, h: 15, l: 8, c: 14, v: 7 },
    ];
    const out = resampleAligned(bars, 10, anchor); // both into one 10m bucket
    expect(out.length).toBe(1);
    expect(out[0]).toMatchObject({ ts: 0, o: 10, h: 15, l: 8, c: 14, v: 12 });
  });
});

describe("resample: session-anchored intraday derive", () => {
  const base = session5m("2026-06-12");

  it("78x5m → 13x30m, session-anchored at the open", () => {
    const out = resampleIntradaySessions(base, 30);
    expect(out.length).toBe(13);
    expect(out[0].ts).toBe(sessionBoundsUtc("2026-06-12").openMs);
    // first 30m bucket aggregates the first six 5m bars (i=0..5)
    expect(out[0]).toMatchObject({ o: 100, h: 105.5, l: 99.5, v: 60 });
  });

  it("78x5m → 6x60m + a final partial (13:00 last hour) ... 60m count", () => {
    const out = resampleIntradaySessions(base, 60);
    // 6.5h → 6 full 60m buckets + 1 half (15:30-16:00) = 7
    expect(out.length).toBe(7);
  });

  it("is deterministic (same input → identical output)", () => {
    expect(resampleIntradaySessions(base, 30)).toEqual(resampleIntradaySessions(base, 30));
  });

  it("derived 30m bars reconcile exactly to the base they came from", () => {
    const out = resampleIntradaySessions(base, 30);
    // total volume conserved
    const baseVol = base.reduce((s, b) => s + b.v, 0);
    const outVol = out.reduce((s, b) => s + b.v, 0);
    expect(outVol).toBe(baseVol);
  });
});

describe("resample: daily → W/M", () => {
  // 30 consecutive calendar days of daily bars spanning two months.
  const daily = [];
  for (let d = 0; d < 45; d++) {
    const ts = Date.UTC(2026, 4, 15, 13, 30) + d * 24 * 3600 * 1000; // from 2026-05-15
    daily.push({ ts, o: d, h: d + 1, l: d - 1, c: d + 0.5, v: 1 });
  }
  it("monthly groups by calendar month", () => {
    const m = resampleDailyToMonthly(daily);
    expect(m.length).toBe(2); // May + June (spans into late June)
  });
  it("weekly groups by ISO week", () => {
    const w = resampleDailyToWeekly(daily);
    expect(w.length).toBeGreaterThanOrEqual(6);
    expect(w.length).toBeLessThanOrEqual(8);
  });
});
