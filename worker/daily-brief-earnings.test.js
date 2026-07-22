import { describe, it, expect } from "vitest";
import {
  prioritizeWeekEarnings,
  summarizeEarningsWeek,
  buildEarningsCalendarDigest,
  BANK_EARNINGS_TICKERS,
  normalizeTdEarningsHour,
  flattenTdEarningsCalendar,
  mergeEarningsEventLists,
} from "./daily-brief.js";

describe("prioritizeWeekEarnings", () => {
  const sample = [
    { symbol: "ALV", date: "2026-07-17", revenueEstimate: 2.7e9 },
    { symbol: "FITB", date: "2026-07-17", revenueEstimate: 3.3e9 },
    { symbol: "NFLX", date: "2026-07-16", revenueEstimate: 11e9 },
    { symbol: "USB", date: "2026-07-16", revenueEstimate: 7.6e9 },
    { symbol: "MS", date: "2026-07-15", revenueEstimate: 19.8e9 },
    { symbol: "BLK", date: "2026-07-15", revenueEstimate: 6.8e9 },
    { symbol: "JPM", date: "2026-07-14", revenueEstimate: 49.9e9, hour: "bmo" },
    { symbol: "BAC", date: "2026-07-14", revenueEstimate: 30.7e9, hour: "bmo" },
    { symbol: "WFC", date: "2026-07-14", revenueEstimate: 22e9, hour: "bmo" },
    { symbol: "C", date: "2026-07-14", revenueEstimate: 23.9e9, hour: "bmo" },
    { symbol: "GS", date: "2026-07-14", revenueEstimate: 16.4e9, hour: "bmo" },
  ];

  it("keeps Jul 14 big-bank cluster when capped at 30", () => {
    const padded = [
      ...sample,
      ...Array.from({ length: 25 }, (_, i) => ({
        symbol: `ZZ${i}`,
        date: "2026-07-17",
        revenueEstimate: 1.2e9,
      })),
    ];
    const out = prioritizeWeekEarnings(padded, { ourTickers: new Set(["JPM", "BAC"]), max: 30 });
    const banks = out.filter((e) => BANK_EARNINGS_TICKERS.has(e.symbol) && e.date === "2026-07-14");
    expect(banks.map((e) => e.symbol).sort()).toEqual(["BAC", "C", "GS", "JPM", "WFC"]);
  });

  it("sorts by date ascending", () => {
    const out = prioritizeWeekEarnings(sample, { max: 30 });
    const dates = out.map((e) => e.date);
    expect(dates).toEqual([...dates].sort());
  });
});

describe("summarizeEarningsWeek", () => {
  it("labels bank-heavy weeks as heavy", () => {
    const week = ["JPM", "BAC", "WFC", "C", "GS"].map((symbol) => ({ symbol, date: "2026-07-14" }));
    const s = summarizeEarningsWeek(week);
    expect(s.intensity).toBe("heavy");
    expect(s.label).toMatch(/bank/i);
  });

  it("does not claim light week when empty, and label stays user-safe", () => {
    const s = summarizeEarningsWeek([]);
    expect(s.intensity).toBe("unknown");
    expect(s.label).not.toMatch(/light earnings week/i);
    expect(s.label).not.toMatch(/omit|do not say|do not claim/i);
    expect(s.label).toBe("Earnings calendar unavailable");
  });
});

describe("normalizeTdEarningsHour", () => {
  it("maps TwelveData and Finnhub time strings", () => {
    expect(normalizeTdEarningsHour("Pre Market")).toBe("bmo");
    expect(normalizeTdEarningsHour("Before Market Open")).toBe("bmo");
    expect(normalizeTdEarningsHour("After Hours")).toBe("amc");
    expect(normalizeTdEarningsHour("After Market Close")).toBe("amc");
    expect(normalizeTdEarningsHour("bmo")).toBe("bmo");
    expect(normalizeTdEarningsHour("Time Not Supplied")).toBe("");
  });
});

describe("flattenTdEarningsCalendar", () => {
  it("flattens US rows and skips non-US without US MIC", () => {
    const flat = flattenTdEarningsCalendar({
      earnings: {
        "2026-07-22": [
          {
            symbol: "NFLX",
            country: "United States",
            mic_code: "XNAS",
            time: "After Hours",
            eps_estimate: 5.1,
          },
          {
            symbol: "SAP",
            country: "Germany",
            mic_code: "XETR",
            time: "Pre Market",
            eps_estimate: 1.2,
          },
        ],
      },
    });
    expect(flat).toHaveLength(1);
    expect(flat[0]).toMatchObject({
      symbol: "NFLX",
      date: "2026-07-22",
      hour: "amc",
      epsEstimate: 5.1,
      _source: "twelvedata",
    });
  });
});

describe("mergeEarningsEventLists", () => {
  it("unions by symbol|date and fills missing fields", () => {
    const merged = mergeEarningsEventLists(
      [{ symbol: "jpm", date: "2026-07-14", hour: "bmo", epsEstimate: 4.5, _source: "finnhub" }],
      [{ symbol: "JPM", date: "2026-07-14", revenueEstimate: 49e9, _source: "twelvedata" }],
      [{ symbol: "BAC", date: "2026-07-14", hour: "bmo", _source: "kv_cache" }],
    );
    expect(merged).toHaveLength(2);
    const jpm = merged.find((e) => e.symbol === "JPM");
    expect(jpm.hour).toBe("bmo");
    expect(jpm.epsEstimate).toBe(4.5);
    expect(jpm.revenueEstimate).toBe(49e9);
    expect(jpm._source).toMatch(/finnhub/);
    expect(jpm._source).toMatch(/twelvedata/);
  });
});

describe("buildEarningsCalendarDigest", () => {
  it("includes bank day in week block", () => {
    const digest = buildEarningsCalendarDigest({
      today: "2026-07-13",
      todayEarnings: [],
      weekEarnings: [
        { symbol: "JPM", date: "2026-07-14", hour: "bmo", revenueEstimate: 49e9 },
        { symbol: "BAC", date: "2026-07-14", hour: "bmo", revenueEstimate: 30e9 },
        { symbol: "WFC", date: "2026-07-14", hour: "bmo", revenueEstimate: 22e9 },
        { symbol: "C", date: "2026-07-14", hour: "bmo", revenueEstimate: 23e9 },
        { symbol: "GS", date: "2026-07-14", hour: "bmo", revenueEstimate: 16e9 },
      ],
    });
    expect(digest.weekSummaryLine).toMatch(/heavy|bank/i);
    expect(digest.weekBlock).toMatch(/JPM/);
    expect(digest.weekBlock).toMatch(/big bank day/i);
    expect(digest.promptBlock).toMatch(/WEEK INTENSITY/);
  });

  it("keeps empty-calendar guardrails out of UI summary line", () => {
    const digest = buildEarningsCalendarDigest({
      today: "2026-07-22",
      todayEarnings: [],
      weekEarnings: [],
    });
    expect(digest.weekSummaryLine).toBeNull();
    expect(digest.promptBlock).toMatch(/WEEK INTENSITY: unavailable/);
    expect(digest.promptBlock).not.toMatch(/omit week-intensity claims; do not say light or heavy/);
    expect(digest.weekBlock).toBe("(no calendar rows)");
  });
});
