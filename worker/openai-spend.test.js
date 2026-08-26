import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  isoWeekKey,
  estimatedCostUsd,
  recordOpenAiSpend,
  getWeeklyOpenAiSpendReport,
  shouldScheduleBriefRetry,
} from "./openai-spend.js";
import { isOpenAiQuotaError } from "./alerts.js";

describe("isoWeekKey", () => {
  it("returns ISO week string", () => {
    const k = isoWeekKey(new Date("2026-08-26T12:00:00Z"));
    expect(k).toMatch(/^\d{4}-W\d{2}$/);
  });
});

describe("estimatedCostUsd", () => {
  it("uses token usage when present", () => {
    const usd = estimatedCostUsd("gpt-4o-mini", { prompt_tokens: 1000, completion_tokens: 500 });
    expect(usd).toBeGreaterThan(0);
    expect(usd).toBeLessThan(0.01);
  });

  it("flat estimate for gpt-5 without usage", () => {
    expect(estimatedCostUsd("gpt-5.4", {})).toBe(0.04);
  });
});

describe("recordOpenAiSpend + getWeeklyOpenAiSpendReport", () => {
  let store = {};
  const env = {
    KV_TIMED: {
      get: async (k, type) => {
        const v = store[k];
        if (type === "json") return v ? JSON.parse(v) : null;
        return v;
      },
      put: async (k, v) => { store[k] = v; },
    },
  };

  beforeEach(() => { store = {}; });

  it("rolls up feature spend for the week", async () => {
    await recordOpenAiSpend(env, "daily_brief_morning", { model: "gpt-5.4", usd: 0.12 });
    await recordOpenAiSpend(env, "news_sentiment", { model: "gpt-4o-mini", usd: 0.002 });
    const report = await getWeeklyOpenAiSpendReport(env, { weeks: 1 });
    expect(report.ok).toBe(true);
    expect(report.weeks[0].total_usd).toBeGreaterThan(0.1);
    const morning = report.weeks[0].features.find((f) => f.feature === "daily_brief_morning");
    expect(morning?.usd).toBe(0.12);
  });
});

describe("shouldScheduleBriefRetry", () => {
  it("retries transient failures", () => {
    expect(shouldScheduleBriefRetry({ ok: false, error: "ai_response_too_short" })).toBe(true);
    expect(shouldScheduleBriefRetry({ ok: false, error: "openai_rate_limited" })).toBe(true);
  });

  it("does not retry quota or success", () => {
    expect(shouldScheduleBriefRetry({ ok: true })).toBe(false);
    expect(shouldScheduleBriefRetry({ ok: false, error: "openai_quota_exceeded" })).toBe(false);
    expect(shouldScheduleBriefRetry({ ok: true, skipped: "already_generated" })).toBe(false);
    expect(isOpenAiQuotaError("openai_quota_exceeded")).toBe(true);
  });
});
