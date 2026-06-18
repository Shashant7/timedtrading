import { describe, it, expect, vi, beforeEach } from "vitest";
import { recordCronFailure } from "../worker/alerts.js";

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

  it("pages again when the error signature changes", async () => {
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
    expect(discordCalls).toBe(2);
  });
});
