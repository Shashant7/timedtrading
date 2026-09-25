import { afterEach, describe, expect, it, vi } from "vitest";
import { appendFormingChartCandle, runChartCandleCalendar } from "./chart-candle-calendar.js";
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

describe("runChartCandleCalendar shares the bar lane", () => {
  // The calendar backfill and the every-5-minute TwelveData bar pass are the
  // same work on two schedules and both start at :05 past the hour. Running
  // both in one isolate is what was left of the monolith's `exceededMemory`
  // once the bar pass had a lease of its own.
  afterEach(() => vi.useRealTimers());

  // 10:05 ET on a Monday — `getChartCalendarTasks` gives hourly 1H + 4H.
  const AT_TASK_TIME = Date.UTC(2026, 5, 22, 14, 5);

  // Enough of a D1 handle that the backfill's upsert path is quiet; these
  // tests are about who holds the lane, not about what lands in the table.
  const db = () => ({
    prepare: () => ({ bind: () => ({}) }),
    batch: async (stmts) => stmts.map(() => ({ success: true })),
  });

  function envWithUniverse() {
    return {
      DB: db(),
      KV_TIMED: { async get(key) { return key === "timed:tickers" ? JSON.stringify(["SPY"]) : null; } },
    };
  }

  it("does not start when the lane is already held", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(AT_TASK_TIME);
    const ctx = { waitUntil: vi.fn() };

    const out = await runChartCandleCalendar(envWithUniverse(), ctx, { claimBarLane: () => null });

    expect(out).toEqual({ ran: false, skipped: "bar_lane_busy" });
    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });

  it("holds the lane across the deferred backfill and releases it at the end", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(AT_TASK_TIME);
    let held = false;
    const deferred = [];
    const ctx = { waitUntil: (p) => deferred.push(p) };

    const out = await runChartCandleCalendar(envWithUniverse(), ctx, {
      SECTOR_MAP: { SPY: "ETF" },
      claimBarLane: () => { held = true; return () => { held = false; }; },
    });

    // Claimed synchronously, before the caller can reach the bar pass.
    expect(out.scheduled).toBe(true);
    expect(held).toBe(true);
    expect(deferred).toHaveLength(1);

    vi.useRealTimers();
    await deferred[0];
    expect(held).toBe(false);
  });

  it("releases the lane when there is nothing to back fill", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(AT_TASK_TIME);
    let held = false;

    const out = await runChartCandleCalendar(
      { DB: db(), KV_TIMED: { async get() { return null; } } },
      { waitUntil: vi.fn() },
      { claimBarLane: () => { held = true; return () => { held = false; }; } },
    );

    expect(out).toEqual({ ran: false, tickers: 0 });
    expect(held).toBe(false);
  });

  it("never claims on a tick with no calendar tasks", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 5, 22, 14, 7)); // 10:07 ET — no tasks.
    const claim = vi.fn();

    const out = await runChartCandleCalendar(envWithUniverse(), { waitUntil: vi.fn() }, { claimBarLane: claim });

    expect(out).toEqual({ ran: false });
    expect(claim).not.toHaveBeenCalled();
  });

  it("still runs for a caller that passes no lease", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(AT_TASK_TIME);
    const ctx = { waitUntil: vi.fn() };

    const out = await runChartCandleCalendar(envWithUniverse(), ctx, { SECTOR_MAP: { SPY: "ETF" } });

    expect(out.scheduled).toBe(true);
    expect(ctx.waitUntil).toHaveBeenCalled();
  });
});

describe("appendFormingChartCandle — finer intraday frames for the day-trade score", () => {
  afterEach(() => vi.useRealTimers());

  it("forms the current 10m bar only for a caller that names 10m", async () => {
    const now = Date.UTC(2026, 5, 22, 14, 47); // 10:47 ET: current 10m bucket is 10:40 ET.
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const buckets = expectedIntradayBuckets("2026-06-22", 10).filter((ts) => ts <= now);
    const current = buckets[buckets.length - 1];
    const prior = buckets[buckets.length - 2];
    const candles = [{ ts: prior, o: 740, h: 741, l: 739, c: 740.5, v: 5 }];
    const env = { KV_TIMED: kvWithPrice("QQQ", { p: 742.1 }) };

    const named = await appendFormingChartCandle(env, "QQQ", "10", candles, { formingIntradayTfs: ["10"] });
    expect(named.forming).toBe(true);
    expect(named.candles[1]).toMatchObject({ ts: current, o: 740.5, c: 742.1, forming: true });

    // Chart reads pass `intradayForming` for every frame; 10m must not change for them.
    const chart = await appendFormingChartCandle(env, "QQQ", "10", candles, { intradayForming: true });
    expect(chart.forming).toBe(false);
    expect(chart.candles).toHaveLength(1);
  });

  it("updates, rather than duplicates, a bar already forming in the same bucket", async () => {
    const now = Date.UTC(2026, 5, 22, 14, 47);
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const buckets = expectedIntradayBuckets("2026-06-22", 15).filter((ts) => ts <= now);
    const current = buckets[buckets.length - 1];
    const candles = [{ ts: current, o: 740, h: 741, l: 739.5, c: 740.2, v: 5 }];
    const env = { KV_TIMED: kvWithPrice("QQQ", { p: 738.9 }) };
    const out = await appendFormingChartCandle(env, "QQQ", "15", candles, { formingIntradayTfs: ["15"] });
    expect(out.candles).toHaveLength(1);
    expect(out.candles[0]).toMatchObject({ o: 740, h: 741, l: 738.9, c: 738.9, forming: true });
  });
});
