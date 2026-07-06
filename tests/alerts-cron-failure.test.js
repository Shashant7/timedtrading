import { describe, it, expect, vi, beforeEach } from "vitest";
import { recordCronFailure, cronErrorSignature, cronErrorSeverityBand, isOpenAiQuotaError, normalizeBriefCronError, recordBriefCronOutcome, recordCronSuccess, healDegradedBriefTombstones } from "../worker/alerts.js";

describe("recordCronFailure discord dedup", () => {
  let kvStore;
  let discordCalls;

  beforeEach(() => {
    kvStore = new Map();
    discordCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      discordCalls += 1;
      return { ok: true, status: 200 };
    }));
  });

  function makeEnv() {
    return {
      DISCORD_ENABLE: "true",
      KV_TIMED: {
        async get(key, type) {
          const raw = kvStore.get(key);
          if (!raw) return null;
          return type === "json" ? JSON.parse(raw) : raw;
        },
        async put(key, val) {
          kvStore.set(key, val);
        },
      },
      DISCORD_SYSTEM_WEBHOOK_URL: "https://discord.test/webhook",
    };
  }

  it("pages once for repeated identical failures", async () => {
    const env = makeEnv();
    const opts = {
      op: "investor_compute_stale_candles",
      error: "Excluded 206/257 (80%) — candle freshness regression",
      caller: "investor_compute",
    };
    await recordCronFailure(env, opts);
    await recordCronFailure(env, opts);
    expect(discordCalls).toBe(1);
    const tomb = JSON.parse(kvStore.get("timed:cron:failure:investor_compute_stale_candles"));
    expect(tomb.count).toBe(2);
  });

  // A6 (2026-07-03): same failure shape with different counts must NOT
  // re-page unless the severity band escalates. The Jul 2 incident paged
  // twice within a minute (34% → 76%) purely because the count changed
  // the raw string.
  it("does NOT page again for the same shape at the same severity band", async () => {
    const env = makeEnv();
    await recordCronFailure(env, {
      op: "investor_compute_stale_candles",
      error: "Excluded 90/257 (35%) — candle freshness regression",
      caller: "investor_compute",
    });
    await recordCronFailure(env, {
      op: "investor_compute_stale_candles",
      error: "Excluded 100/257 (39%) — candle freshness regression",
      caller: "investor_compute",
    });
    expect(discordCalls).toBe(1);
  });

  it("does NOT page again when severity de-escalates (recovery is recordCronSuccess's job)", async () => {
    const env = makeEnv();
    await recordCronFailure(env, {
      op: "investor_compute_stale_candles",
      error: "Excluded 206/257 (80%) — candle freshness regression",
      caller: "investor_compute",
    });
    await recordCronFailure(env, {
      op: "investor_compute_stale_candles",
      error: "Excluded 180/257 (70%) — candle freshness regression",
      caller: "investor_compute",
    });
    expect(discordCalls).toBe(1);
  });

  it("pages again when the severity band escalates (34% → 76%)", async () => {
    const env = makeEnv();
    await recordCronFailure(env, {
      op: "investor_compute_stale_candles",
      error: "Excluded 99/291 (34%) — candle freshness regression",
      caller: "investor_compute",
    });
    await recordCronFailure(env, {
      op: "investor_compute_stale_candles",
      error: "Excluded 221/291 (76%) — candle freshness regression",
      caller: "investor_compute",
    });
    expect(discordCalls).toBe(2);
  });

  it("pages again when the failure SHAPE changes", async () => {
    const env = makeEnv();
    await recordCronFailure(env, {
      op: "investor_hourly",
      error: "compute_failed_status_500_after_3_attempts",
      caller: "scheduled_event",
    });
    await recordCronFailure(env, {
      op: "investor_hourly",
      error: "rth_action_failed_timeout",
      caller: "scheduled_event",
    });
    expect(discordCalls).toBe(2);
  });

  it("skipDiscord suppresses paging but still increments the tombstone", async () => {
    const env = makeEnv();
    await recordCronFailure(env, {
      op: "freshness_quarantine_NVDA",
      error: "still STALE after 2 heal attempt(s)",
      caller: "scoring_cron",
      skipDiscord: true,
    });
    expect(discordCalls).toBe(0);
    const tomb = JSON.parse(kvStore.get("timed:cron:failure:freshness_quarantine_NVDA"));
    expect(tomb.count).toBe(1);
  });

  it("normalizeBriefCronError marks OpenAI quota as degraded and skipDiscord", async () => {
    const raw = 'OpenAI 429: {"error":{"message":"You exceeded your current quota, please check your plan and billing details.';
    const norm = normalizeBriefCronError(raw);
    expect(norm.degraded).toBe(true);
    expect(norm.skipDiscord).toBe(true);
    expect(norm.error).toMatch(/openai_quota_exceeded/i);
    expect(isOpenAiQuotaError(raw)).toBe(true);

    const env = makeEnv();
    await recordCronFailure(env, {
      op: "intraday_flash",
      error: norm.error,
      caller: "scheduled_event",
      skipDiscord: norm.skipDiscord,
    });
    expect(discordCalls).toBe(0);
  });

  it("recordBriefCronOutcome heals tombstone on OpenAI quota skip", async () => {
    const env = makeEnv();
    await recordCronFailure(env, {
      op: "intraday_flash",
      error: "openai_quota_exceeded — AI brief skipped",
      caller: "scheduled_event",
      skipDiscord: true,
    });
    expect(JSON.parse(kvStore.get("timed:cron:failure:intraday_flash")).count).toBe(1);
    await recordBriefCronOutcome(env, "intraday_flash", {
      ok: false,
      error: 'OpenAI 429: quota exceeded',
    });
    expect(JSON.parse(kvStore.get("timed:cron:failure:intraday_flash")).count).toBe(0);
  });

  it("healDegradedBriefTombstones clears active quota tombstones", async () => {
    const env = makeEnv();
    await recordCronFailure(env, {
      op: "intraday_flash",
      error: "openai_quota_exceeded — AI brief skipped",
      caller: "scheduled_event",
      skipDiscord: true,
    });
    await healDegradedBriefTombstones(env);
    expect(JSON.parse(kvStore.get("timed:cron:failure:intraday_flash")).count).toBe(0);
  });
});

describe("signature + severity helpers", () => {
  it("normalizes digits out of the signature", () => {
    expect(cronErrorSignature("Excluded 99/291 (34%) — candle freshness regression"))
      .toBe(cronErrorSignature("Excluded 221/291 (76%) — candle freshness regression"));
    expect(cronErrorSignature("timeout after 30s"))
      .not.toBe(cronErrorSignature("http 500 from provider"));
  });

  it("maps percentages to 25/50/75 bands", () => {
    expect(cronErrorSeverityBand("Excluded 10/291 (3%)")).toBe(0);
    expect(cronErrorSeverityBand("Excluded 99/291 (34%)")).toBe(1);
    expect(cronErrorSeverityBand("Excluded 150/291 (52%)")).toBe(2);
    expect(cronErrorSeverityBand("Excluded 221/291 (76%)")).toBe(3);
    expect(cronErrorSeverityBand("no percentage here")).toBeNull();
  });
});
