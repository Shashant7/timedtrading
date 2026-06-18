import { describe, it, expect } from "vitest";
import {
  canAccessLivePrices,
  redactTickerSnapshot,
  redactTickerMapForTier,
} from "./api.js";

describe("canAccessLivePrices", () => {
  it("allows authenticated tiers", () => {
    expect(canAccessLivePrices("admin")).toBe(true);
    expect(canAccessLivePrices("pro")).toBe(true);
    expect(canAccessLivePrices("free")).toBe(true);
  });

  it("blocks anonymous callers", () => {
    expect(canAccessLivePrices("anon")).toBe(false);
    expect(canAccessLivePrices(undefined)).toBe(false);
  });
});

describe("redactTickerSnapshot — tier-aware price vs model gating", () => {
  const sample = {
    ticker: "QQQ",
    price: 440.12,
    day_change_pct: 1.2,
    score: 88,
    sl: 430,
    kanban_stage: "enter",
  };

  it("passes through pro/admin untouched", () => {
    expect(redactTickerSnapshot(sample, "pro")).toBe(sample);
    expect(redactTickerSnapshot(sample, "admin")).toBe(sample);
  });

  it("keeps prices but strips model fields for free tier", () => {
    const out = redactTickerSnapshot(sample, "free");
    expect(out.price).toBe(440.12);
    expect(out.day_change_pct).toBe(1.2);
    expect(out.score).toBeUndefined();
    expect(out.sl).toBeUndefined();
    expect(out.kanban_stage).toBeUndefined();
    expect(out._redacted).toBe(true);
  });

  it("strips prices and model fields for anon tier", () => {
    const out = redactTickerSnapshot(sample, "anon");
    expect(out.ticker).toBe("QQQ");
    expect(out.price).toBeUndefined();
    expect(out.score).toBeUndefined();
    expect(out._redacted).toBe(true);
  });
});

describe("redactTickerMapForTier", () => {
  it("applies per-symbol tier redaction", () => {
    const map = {
      QQQ: { ticker: "QQQ", price: 1, score: 2 },
      SPY: { ticker: "SPY", price: 3, score: 4 },
    };
    const out = redactTickerMapForTier(map, "free");
    expect(out.QQQ.price).toBe(1);
    expect(out.QQQ.score).toBeUndefined();
    expect(out.SPY.price).toBe(3);
    expect(out.SPY.score).toBeUndefined();
  });
});
