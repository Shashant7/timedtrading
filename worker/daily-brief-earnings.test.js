import { describe, it, expect } from "vitest";
import {
  prioritizeWeekEarnings,
  summarizeEarningsWeek,
  buildEarningsCalendarDigest,
  BANK_EARNINGS_TICKERS,
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

  it("does not claim light week when empty", () => {
    const s = summarizeEarningsWeek([]);
    expect(s.intensity).toBe("unknown");
    expect(s.label).not.toMatch(/light earnings week/i);
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
});
