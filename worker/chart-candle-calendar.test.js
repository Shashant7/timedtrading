import { afterEach, describe, expect, it, vi } from "vitest";
import { appendFormingChartCandle } from "./chart-candle-calendar.js";
import { expectedIntradayBuckets } from "./foundation/trading-calendar.js";

function kvWithPrice(sym, snap) {
  return {
    async get(key) {
      if (key !== "timed:prices") return null;
      return JSON.stringify({ [sym]: snap });
    },
  };
}

describe("appendFormingChartCandle 60m", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("appends the current session-aligned 1H candle when explicitly enabled", async () => {
    const now = Date.UTC(2026, 5, 22, 18, 28); // 14:28 ET, current 60m bucket is 13:30 ET.
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const buckets = expectedIntradayBuckets("2026-06-22", 60);
    const priorBucket = buckets[buckets.length - 4];
    const currentBucket = buckets[buckets.length - 3];
    const candles = [{ ts: priorBucket, o: 100, h: 101, l: 99, c: 100.5, v: 10 }];
    const env = { KV_TIMED: kvWithPrice("SPY", { p: 102 }) };

    const out = await appendFormingChartCandle(env, "SPY", "60", candles, { intradayForming: true });

    expect(out.forming).toBe(true);
    expect(out.candles).toHaveLength(2);
    expect(out.candles[1]).toMatchObject({
      ts: currentBucket,
      o: 100.5,
      h: 102,
      l: 100.5,
      c: 102,
      forming: true,
    });
  });

  it("leaves 1H candles unchanged unless intraday forming is requested", async () => {
    const now = Date.UTC(2026, 5, 22, 18, 28);
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const candles = [{ ts: expectedIntradayBuckets("2026-06-22", 60)[0], o: 100, h: 101, l: 99, c: 100.5 }];
    const env = { KV_TIMED: kvWithPrice("SPY", { p: 102 }) };

    const out = await appendFormingChartCandle(env, "SPY", "60", candles);

    expect(out.forming).toBe(false);
    expect(out.candles).toEqual(candles);
  });
});
