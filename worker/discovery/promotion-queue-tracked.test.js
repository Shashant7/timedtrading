import { describe, it, expect } from "vitest";
import {
  dedupePromotionRowsByTicker,
  shouldSuppressTrackedPromotionRow,
} from "./promotion-queue.js";

describe("dedupePromotionRowsByTicker", () => {
  it("keeps the newest row per ticker", () => {
    const rows = [
      { ticker: "AMAT", candidate_id: "AMAT:2026-07-08", updated_at: 100, total_score: 40 },
      { ticker: "AMAT", candidate_id: "AMAT:2026-07-10", updated_at: 300, total_score: 43 },
      { ticker: "AMAT", candidate_id: "AMAT:2026-07-09", updated_at: 200, total_score: 41 },
      { ticker: "SNOW", candidate_id: "SNOW:2026-07-10", updated_at: 150, total_score: 55 },
    ];
    const out = dedupePromotionRowsByTicker(rows);
    expect(out).toHaveLength(2);
    expect(out.find((r) => r.ticker === "AMAT")?.candidate_id).toBe("AMAT:2026-07-10");
  });
});

describe("shouldSuppressTrackedPromotionRow", () => {
  const tracked = new Set(["AMAT", "SNOW"]);

  it("suppresses needs_review and ready_to_add for tracked tickers", () => {
    expect(shouldSuppressTrackedPromotionRow("AMAT", "needs_review", tracked)).toBe(true);
    expect(shouldSuppressTrackedPromotionRow("AMAT", "ready_to_add", tracked)).toBe(true);
  });

  it("does not suppress operator decisions or rejected rows", () => {
    expect(shouldSuppressTrackedPromotionRow("AMAT", "approved", tracked)).toBe(false);
    expect(shouldSuppressTrackedPromotionRow("AMAT", "declined", tracked)).toBe(false);
    expect(shouldSuppressTrackedPromotionRow("AMAT", "rejected", tracked)).toBe(false);
  });

  it("does not suppress net-new tickers", () => {
    expect(shouldSuppressTrackedPromotionRow("LUNR", "needs_review", tracked)).toBe(false);
  });
});
