import { describe, it, expect } from "vitest";
import {
  normalizeScreenerResult,
  screenerErrorHint,
  isScreenerRunActive,
} from "./screener-runner.js";

describe("screener-runner errors", () => {
  it("screenerErrorHint maps finnhub_not_configured", () => {
    expect(screenerErrorHint("finnhub_not_configured")).toContain("FINNHUB_API_KEY");
  });

  it("normalizeScreenerResult lifts nested weekly.error for all mode", () => {
    const out = normalizeScreenerResult({
      ok: false,
      mode: "all",
      weekly: { ok: false, error: "finnhub_not_configured" },
      github: { ok: false, error: "github_http_403" },
    });
    expect(out.error).toBe("finnhub_not_configured");
    expect(out.hint).toContain("FINNHUB_API_KEY");
  });

  it("isScreenerRunActive detects fresh running status", () => {
    expect(isScreenerRunActive({ status: "running", started_at: Date.now() })).toBe(true);
    expect(isScreenerRunActive({ status: "completed" })).toBe(false);
    expect(isScreenerRunActive({ status: "running", started_at: Date.now() - 20 * 60 * 1000 })).toBe(false);
  });
});
