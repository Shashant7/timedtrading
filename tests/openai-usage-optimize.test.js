import { describe, it, expect } from "vitest";
import { shouldRefreshCroForBriefCadence } from "../worker/cro/cro-service.js";
import {
  getBriefEtDate,
  findExistingDailyBrief,
  findExistingIntradayFlashSlot,
} from "../worker/daily-brief.js";

describe("shouldRefreshCroForBriefCadence", () => {
  const etToday = "2026-07-06";
  const nowMs = Date.parse("2026-07-06T18:00:00-04:00");

  it("skips morning refresh when today's note is fresh and no new FSD", () => {
    const note = { as_of_date: etToday, produced_at: nowMs - 2 * 3600000 };
    expect(shouldRefreshCroForBriefCadence("morning", note, { etToday, nowMs, hasNewFsd: false })).toBe(false);
  });

  it("refreshes morning when note is from a prior ET day", () => {
    const note = { as_of_date: "2026-07-05", produced_at: nowMs - 3600000 };
    expect(shouldRefreshCroForBriefCadence("morning", note, { etToday, nowMs, hasNewFsd: false })).toBe(true);
  });

  it("refreshes evening when note is older than 4h even on same day", () => {
    const note = { as_of_date: etToday, produced_at: nowMs - 5 * 3600000 };
    expect(shouldRefreshCroForBriefCadence("evening", note, { etToday, nowMs, hasNewFsd: false })).toBe(true);
  });

  it("skips evening when note is 2h old and FSD unchanged", () => {
    const note = { as_of_date: etToday, produced_at: nowMs - 2 * 3600000 };
    expect(shouldRefreshCroForBriefCadence("evening", note, { etToday, nowMs, hasNewFsd: false })).toBe(false);
  });

  it("refreshes any slot when new FSD landed since the note", () => {
    const note = { as_of_date: etToday, produced_at: nowMs - 30 * 60000 };
    expect(shouldRefreshCroForBriefCadence("evening", note, { etToday, nowMs, hasNewFsd: true })).toBe(true);
  });
});

describe("brief cron idempotency helpers", () => {
  it("getBriefEtDate returns YYYY-MM-DD in America/New_York", () => {
    const d = getBriefEtDate(new Date("2026-07-06T04:30:00Z"));
    expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("findExistingDailyBrief returns row when D1 has today's brief", async () => {
    const env = {
      DB: {
        prepare(sql) {
          return {
            async run() {},
            bind() {
              return {
                async first() {
                  return { id: "2026-07-06-morning", published_at: Date.now() };
                },
              };
            },
          };
        },
      },
    };
    const row = await findExistingDailyBrief(env, "morning", "2026-07-06");
    expect(row?.id).toBe("2026-07-06-morning");
  });

  it("findExistingIntradayFlashSlot matches ET hour bucket", async () => {
    const publishedAt2pm = Date.parse("2026-07-06T14:05:00-04:00");
    const env = {
      KV_TIMED: {
        async get() {
          return JSON.stringify([
            { id: "intraday-1", date: "2026-07-06", publishedAt: publishedAt2pm, timeET: "2:05 PM ET" },
          ]);
        },
      },
    };
    const hit = await findExistingIntradayFlashSlot(env, "2026-07-06", 14);
    expect(hit?.id).toBe("intraday-1");
    expect(await findExistingIntradayFlashSlot(env, "2026-07-06", 11)).toBeNull();
  });
});
