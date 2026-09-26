// worker/daily-brief-claim.test.js
import { describe, it, expect } from "vitest";
import {
  dailyBriefClaimKey,
  claimDailyBriefGeneration,
  dailyBriefEmailAlreadySent,
} from "./daily-brief.js";

function mockKv(store = {}) {
  return {
    async get(key) {
      return store[key] ?? null;
    },
    async put(key, val) {
      store[key] = val;
    },
    _store: store,
  };
}

describe("daily brief claim + email dedupe", () => {
  it("keys claims by ET date and type", () => {
    expect(dailyBriefClaimKey("evening", "2026-09-25")).toBe("timed:brief:claim:2026-09-25:evening");
    expect(dailyBriefClaimKey("morning", "2026-09-25")).toBe("timed:brief:claim:2026-09-25:morning");
  });

  it("lets the first generator win and blocks the second", async () => {
    const store = {};
    const env = { KV_TIMED: mockKv(store) };
    const first = await claimDailyBriefGeneration(env, "evening", "2026-09-25", { settleMs: 0 });
    expect(first.ok).toBe(true);
    const second = await claimDailyBriefGeneration(env, "evening", "2026-09-25", { settleMs: 0 });
    expect(second.ok).toBe(false);
    expect(second.reason).toBe("already_claimed");
  });

  it("detects same-day email already sent from lastrun", async () => {
    const store = {
      "timed:email:daily_brief:lastrun:evening": JSON.stringify({
        type: "evening",
        date: "2026-09-25",
        sent: 12,
        recipients: 12,
        reason: "ok",
      }),
    };
    const env = { KV_TIMED: mockKv(store) };
    expect(await dailyBriefEmailAlreadySent(env, "evening", "2026-09-25")).toBe(true);
    expect(await dailyBriefEmailAlreadySent(env, "evening", "2026-09-24")).toBe(false);
    expect(await dailyBriefEmailAlreadySent(env, "morning", "2026-09-25")).toBe(false);
  });

  it("does not treat zero-sent lastrun as already mailed", async () => {
    const store = {
      "timed:email:daily_brief:lastrun:evening": JSON.stringify({
        date: "2026-09-25",
        sent: 0,
        reason: "all_failed",
      }),
    };
    const env = { KV_TIMED: mockKv(store) };
    expect(await dailyBriefEmailAlreadySent(env, "evening", "2026-09-25")).toBe(false);
  });
});
