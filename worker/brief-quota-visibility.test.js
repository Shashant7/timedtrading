import { describe, it, expect, beforeEach } from "vitest";
import {
  isOpenAiQuotaError,
  isOpenAiRateLimitError,
  normalizeBriefCronError,
  recordBriefCronOutcome,
  healDegradedBriefTombstones,
} from "./alerts.js";

// Minimal in-memory KV that mimics Cloudflare Workers KV_TIMED for the
// two shapes recordCronFailure / recordCronSuccess touch:
//   KV.get(key, "json")     → last stored JSON value
//   KV.put(key, jsonString) → replace stored value
function makeKV() {
  const store = new Map();
  return {
    store,
    async get(key, kind) {
      const raw = store.get(key);
      if (raw == null) return null;
      if (kind === "json") return JSON.parse(raw);
      return raw;
    },
    async put(key, value, _opts) {
      store.set(key, String(value));
    },
    async delete(key) {
      store.delete(key);
    },
    async list({ prefix, cursor } = {}) {
      const keys = [];
      for (const k of store.keys()) {
        if (!prefix || k.startsWith(prefix)) keys.push({ name: k });
      }
      return { keys, list_complete: true, cursor: null };
    },
  };
}

function makeEnv(overrides = {}) {
  return {
    KV_TIMED: makeKV(),
    // notifyDiscord skips cleanly when DISCORD_ENABLE !== "true",
    // so the recordCronFailure alert path is a no-op in tests without
    // us having to stub fetch.
    DISCORD_ENABLE: "false",
    ...overrides,
  };
}

describe("OpenAI 429 error classifiers", () => {
  it("recognizes the bare openai_quota_exceeded throw", () => {
    expect(isOpenAiQuotaError("openai_quota_exceeded")).toBe(true);
    expect(isOpenAiRateLimitError("openai_quota_exceeded")).toBe(false);
  });

  it("recognizes the normalized quota tombstone message so heal skips it", () => {
    const msg = "openai_quota_exceeded — AI brief blocked (top up OpenAI billing at https://platform.openai.com/account/billing/overview)";
    expect(isOpenAiQuotaError(msg)).toBe(true);
    expect(isOpenAiRateLimitError(msg)).toBe(false);
  });

  it("recognizes the wrapped Error message that generateDailyBrief returns", () => {
    expect(isOpenAiQuotaError("Error: openai_quota_exceeded")).toBe(true);
  });

  it("recognizes the wire-format 429 body (space, not underscore)", () => {
    const body = "OpenAI 429: {\"error\":{\"message\":\"You exceeded your current quota\"}}";
    expect(isOpenAiQuotaError(body)).toBe(true);
  });

  it("recognizes bare openai_rate_limited AND the normalized variant", () => {
    expect(isOpenAiRateLimitError("openai_rate_limited")).toBe(true);
    expect(isOpenAiRateLimitError("openai_rate_limited — AI brief skipped (retry next slot)")).toBe(true);
    expect(isOpenAiQuotaError("openai_rate_limited")).toBe(false);
  });

  it("does not classify infra failures as OpenAI 429", () => {
    expect(isOpenAiQuotaError("ai_response_too_short")).toBe(false);
    expect(isOpenAiRateLimitError("ai_response_too_short")).toBe(false);
    expect(isOpenAiQuotaError("D1_ERROR: no such table")).toBe(false);
  });
});

describe("normalizeBriefCronError", () => {
  it("flags quota exhaustion as operator-actionable + alertable", () => {
    const n = normalizeBriefCronError("openai_quota_exceeded");
    expect(n.degraded).toBe(true);
    expect(n.requiresOperatorAction).toBe(true);
    expect(n.skipDiscord).toBe(false);
    expect(n.error).toMatch(/openai_quota_exceeded/);
    expect(n.error).toMatch(/top up OpenAI billing/);
  });

  it("keeps rate-limit degradation silent (self-heals next tick)", () => {
    const n = normalizeBriefCronError("openai_rate_limited");
    expect(n.degraded).toBe(true);
    expect(n.requiresOperatorAction).toBe(false);
    expect(n.skipDiscord).toBe(true);
  });

  it("passes genuine infra failures through as non-degraded", () => {
    const n = normalizeBriefCronError("ai_response_too_short");
    expect(n.degraded).toBe(false);
    expect(n.requiresOperatorAction).toBe(false);
  });
});

describe("recordBriefCronOutcome — quota outage visibility", () => {
  const OP = "daily_brief_morning";
  const TOMBSTONE_KEY = `timed:cron:failure:${OP}`;

  let env;
  beforeEach(() => { env = makeEnv(); });

  it("writes a tombstone on first quota-exhausted attempt so /timed/admin/cron-status surfaces it", async () => {
    await recordBriefCronOutcome(env, OP, { ok: false, error: "Error: openai_quota_exceeded" });
    const row = await env.KV_TIMED.get(TOMBSTONE_KEY, "json");
    expect(row).toBeTruthy();
    expect(row.op).toBe(OP);
    expect(row.count).toBe(1);
    expect(row.error).toMatch(/openai_quota_exceeded/);
    expect(row.error).toMatch(/top up OpenAI billing/);
  });

  it("increments count on repeat quota ticks without re-paging", async () => {
    await recordBriefCronOutcome(env, OP, { ok: false, error: "openai_quota_exceeded" });
    await recordBriefCronOutcome(env, OP, { ok: false, error: "openai_quota_exceeded" });
    await recordBriefCronOutcome(env, OP, { ok: false, error: "openai_quota_exceeded" });
    const row = await env.KV_TIMED.get(TOMBSTONE_KEY, "json");
    expect(row.count).toBe(3);
  });

  it("still leaves rate-limit failures silent (no tombstone written)", async () => {
    await recordBriefCronOutcome(env, OP, { ok: false, error: "openai_rate_limited" });
    const row = await env.KV_TIMED.get(TOMBSTONE_KEY, "json");
    expect(row).toBeNull();
  });

  it("heals the tombstone once the brief succeeds after a quota outage", async () => {
    await recordBriefCronOutcome(env, OP, { ok: false, error: "openai_quota_exceeded" });
    await recordBriefCronOutcome(env, OP, { ok: true, id: "2026-07-29-morning", elapsed: 4200 });
    const row = await env.KV_TIMED.get(TOMBSTONE_KEY, "json");
    expect(row).toBeTruthy();
    expect(row.count).toBe(0);
    expect(row.last_ok_ts).toBeGreaterThan(0);
  });

  it("tombstones an infra failure through the standard recordCronFailure path", async () => {
    await recordBriefCronOutcome(env, OP, { ok: false, error: "ai_response_too_short" });
    const row = await env.KV_TIMED.get(TOMBSTONE_KEY, "json");
    expect(row.count).toBe(1);
    expect(row.error).toBe("ai_response_too_short");
  });
});

describe("healDegradedBriefTombstones — quota tombstones must stick", () => {
  it("clears transient rate-limit tombstones (self-recovering noise)", async () => {
    const env = makeEnv();
    const OP = "daily_brief_morning";
    const KEY = `timed:cron:failure:${OP}`;
    await env.KV_TIMED.put(KEY, JSON.stringify({
      op: OP, error: "openai_rate_limited — AI brief skipped (retry next slot)",
      ts: Date.now(), caller: "scheduled_event", count: 2, last_ok_ts: Date.now() - 3600_000,
    }));
    await healDegradedBriefTombstones(env);
    const row = await env.KV_TIMED.get(KEY, "json");
    expect(row.count).toBe(0);
  });

  it("does NOT clear quota-exhausted tombstones — those need operator top-up", async () => {
    const env = makeEnv();
    const OP = "daily_brief_morning";
    const KEY = `timed:cron:failure:${OP}`;
    const originalTs = Date.now();
    await env.KV_TIMED.put(KEY, JSON.stringify({
      op: OP,
      error: "openai_quota_exceeded — AI brief blocked (top up OpenAI billing at https://platform.openai.com/account/billing/overview)",
      ts: originalTs, caller: "scheduled_event", count: 5, last_ok_ts: null,
    }));
    await healDegradedBriefTombstones(env);
    const row = await env.KV_TIMED.get(KEY, "json");
    expect(row.count).toBe(5);
    expect(row.error).toMatch(/openai_quota_exceeded/);
  });
});
