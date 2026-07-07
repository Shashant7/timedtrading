import { describe, it, expect } from "vitest";
import { deduplicateCandles, nyTradingDayKey } from "./indicators.js";

describe("deduplicateCandles", () => {
  it("merges two D bars on the same NY session day with different UTC dates", () => {
    // Friday Jan 10 2025 4:00 PM ET = 21:00 UTC
    const closeBar = { ts: Date.parse("2025-01-10T21:00:00.000Z"), o: 50, h: 55, l: 49, c: 54 };
    // Friday Jan 10 2025 9:00 PM ET = Saturday Jan 11 02:00 UTC (twin-bug shape)
    const lateBar = { ts: Date.parse("2025-01-11T02:00:00.000Z"), o: 54, h: 56, l: 53, c: 55 };
    expect(nyTradingDayKey(closeBar.ts)).toBe(nyTradingDayKey(lateBar.ts));

    const out = deduplicateCandles([closeBar, lateBar], "D");
    expect(out).toHaveLength(1);
    expect(out[0].o).toBe(50);
    expect(out[0].c).toBe(55);
    expect(out[0].h).toBe(56);
    expect(out[0].l).toBe(49);
  });

  it("dedupes intraday bars by exact timestamp", () => {
    const a = { ts: 1000, o: 1, h: 2, l: 0.5, c: 1.5 };
    const b = { ts: 1000, o: 9, h: 9, l: 9, c: 9 };
    const c = { ts: 2000, o: 2, h: 3, l: 1.5, c: 2.5 };
    const out = deduplicateCandles([a, b, c], "60");
    expect(out).toHaveLength(2);
    expect(out[0].ts).toBe(1000);
    expect(out[0].c).toBe(9);
  });

  it("merges weekly bars sharing the same NY Monday week key", () => {
    const mon = { ts: Date.parse("2025-01-06T15:00:00.000Z"), o: 10, h: 12, l: 9, c: 11 };
    const fri = { ts: Date.parse("2025-01-10T21:00:00.000Z"), o: 11, h: 14, l: 10, c: 13 };
    const out = deduplicateCandles([mon, fri], "W");
    expect(out).toHaveLength(1);
    expect(out[0].o).toBe(10);
    expect(out[0].c).toBe(13);
  });
});
