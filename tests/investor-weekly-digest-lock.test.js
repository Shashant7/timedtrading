import { describe, it, expect } from "vitest";
import {
  investorWeeklyDigestWeekKey,
  claimInvestorWeeklyDigestLock,
  markInvestorWeeklyDigestSent,
} from "../worker/email.js";

function makeKv(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, val) { store.set(key, String(val)); },
  };
}

describe("investorWeeklyDigestWeekKey", () => {
  it("returns a stable YYYY-Www key", () => {
    // Friday 2026-07-31 16:15 ET ≈ 20:15 UTC
    const key = investorWeeklyDigestWeekKey(Date.parse("2026-07-31T20:15:00Z"));
    expect(key).toMatch(/^2026-W\d{2}$/);
  });
});

describe("claimInvestorWeeklyDigestLock", () => {
  it("allows the first claim and rejects the second", async () => {
    const kv = makeKv();
    const env = { KV_TIMED: kv };
    const now = Date.parse("2026-07-31T20:15:00Z");
    const a = await claimInvestorWeeklyDigestLock(env, now);
    expect(a.ok).toBe(true);
    expect(a.week).toMatch(/^2026-W/);
    const b = await claimInvestorWeeklyDigestLock(env, now);
    expect(b.ok).toBe(false);
    expect(b.reason).toBe("already_sent");
  });

  it("markInvestorWeeklyDigestSent writes status=sent", async () => {
    const kv = makeKv();
    const env = { KV_TIMED: kv };
    const now = Date.parse("2026-08-01T20:15:00Z");
    const lock = await claimInvestorWeeklyDigestLock(env, now);
    expect(lock.ok).toBe(true);
    await markInvestorWeeklyDigestSent(env, { ...lock, claimed_at: now }, { sent: 1, recipients: 1 });
    const raw = await kv.get(lock.lockKey);
    const parsed = JSON.parse(raw);
    expect(parsed.status).toBe("sent");
    expect(parsed.sent).toBe(1);
  });
});
