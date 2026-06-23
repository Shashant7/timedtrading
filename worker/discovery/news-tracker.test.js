import { describe, it, expect } from "vitest";
import { headlineMentionsTicker } from "../discovery/news-tracker.js";

describe("loadRecentNewsSummary filter", () => {
  it("headlineMentionsTicker rejects unrelated sector headlines", () => {
    expect(headlineMentionsTicker("Sandisk shares surge on NAND outlook", null, "AMZN")).toBe(false);
    expect(headlineMentionsTicker("Amazon AMZN raises AWS guidance", null, "AMZN")).toBe(true);
  });
});
