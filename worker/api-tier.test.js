import { describe, it, expect } from "vitest";
import {
  canAccessLivePrices,
  redactTickerSnapshot,
  redactTickerMapForTier,
  computeUserDataTier,
  promoteAdminEmailUser,
} from "./api.js";

describe("canAccessLivePrices", () => {
  it("allows Pro/VIP (collapsed to 'pro' by computeUserDataTier) and Admin", () => {
    expect(canAccessLivePrices("admin")).toBe(true);
    expect(canAccessLivePrices("pro")).toBe(true); // pro + vip both map to "pro"
  });

  it("blocks Members ('free') and anonymous callers", () => {
    expect(canAccessLivePrices("free")).toBe(false); // 'free' tier == a Member
    expect(canAccessLivePrices("anon")).toBe(false);
    expect(canAccessLivePrices(undefined)).toBe(false);
  });
});

describe("computeUserDataTier — admin promotion", () => {
  it("treats ADMIN_EMAIL as admin even when DB role is member", () => {
    const tier = computeUserDataTier(
      { email: "Ops@Example.com", role: "member", tier: "free" },
      { ADMIN_EMAIL: "ops@example.com" },
    );
    expect(tier).toBe("admin");
  });

  it("promoteAdminEmailUser mutates operator row in place", () => {
    const user = { email: "ops@example.com", role: "member", tier: "free" };
    promoteAdminEmailUser(user, { ADMIN_EMAIL: "ops@example.com" });
    expect(user.role).toBe("admin");
    expect(user.tier).toBe("admin");
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

  it("passes through pro/admin (incl VIP) untouched", () => {
    expect(redactTickerSnapshot(sample, "pro")).toBe(sample);
    expect(redactTickerSnapshot(sample, "admin")).toBe(sample);
  });

  it("strips BOTH prices and model fields for Members ('free')", () => {
    const out = redactTickerSnapshot(sample, "free");
    expect(out.price).toBeUndefined();
    expect(out.day_change_pct).toBeUndefined();
    expect(out.score).toBeUndefined();
    expect(out.sl).toBeUndefined();
    expect(out.kanban_stage).toBeUndefined();
    expect(out.ticker).toBe("QQQ"); // identity survives for skeleton render
    expect(out._redacted).toBe(true);
  });

  it("strips prices and model fields for anon tier", () => {
    const out = redactTickerSnapshot(sample, "anon");
    expect(out.ticker).toBe("QQQ");
    expect(out.price).toBeUndefined();
    expect(out.score).toBeUndefined();
    expect(out._redacted).toBe(true);
  });

  it("strips EXT overlay aliases that used to leak past the live-price set", () => {
    const out = redactTickerSnapshot({
      ticker: "QQQ",
      _ah_price: 706.94,
      _ah_change: -9.82,
      _ah_change_pct: -1.37,
      ah_price: 701.29,
      ah_change: -6.54,
      ah_change_pct: -0.92,
      extended_price: 706.94,
      extended_change: -9.82,
      extended_percent_change: -1.37,
    }, "anon");
    expect(out._ah_price).toBeUndefined();
    expect(out._ah_change).toBeUndefined();
    expect(out._ah_change_pct).toBeUndefined();
    expect(out.ah_price).toBeUndefined();
    expect(out.ah_change).toBeUndefined();
    expect(out.ah_change_pct).toBeUndefined();
    expect(out.extended_price).toBeUndefined();
    expect(out.extended_change).toBeUndefined();
    expect(out.extended_percent_change).toBeUndefined();
    expect(out.ticker).toBe("QQQ");
  });
});

describe("redactTickerMapForTier", () => {
  it("strips prices + model for Members ('free')", () => {
    const map = {
      QQQ: { ticker: "QQQ", price: 1, score: 2 },
      SPY: { ticker: "SPY", price: 3, score: 4 },
    };
    const out = redactTickerMapForTier(map, "free");
    expect(out.QQQ.price).toBeUndefined();
    expect(out.QQQ.score).toBeUndefined();
    expect(out.SPY.price).toBeUndefined();
    expect(out.SPY.score).toBeUndefined();
  });

  it("passes Pro/VIP/Admin through untouched", () => {
    const map = { QQQ: { ticker: "QQQ", price: 1, score: 2 } };
    expect(redactTickerMapForTier(map, "pro")).toBe(map);
    expect(redactTickerMapForTier(map, "admin")).toBe(map);
  });
});
