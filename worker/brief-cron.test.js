import { describe, it, expect } from "vitest";
import {
  decideDailyBriefCronSlot,
  decideIntradayFlashCronSlot,
  shouldDeferHeavyHourlyWorkForBrief,
  isEtWeekday,
} from "./brief-cron.js";

describe("brief-cron scheduling", () => {
  it("fires morning at exact 9 ET and catch-up through 15", () => {
    expect(decideDailyBriefCronSlot("morning", 9)).toEqual({
      fire: true, catchUp: false, reason: "exact",
    });
    expect(decideDailyBriefCronSlot("morning", 10).catchUp).toBe(true);
    expect(decideDailyBriefCronSlot("morning", 15).fire).toBe(true);
    expect(decideDailyBriefCronSlot("morning", 16).fire).toBe(false);
    expect(decideDailyBriefCronSlot("morning", 8).fire).toBe(false);
  });

  it("fires evening at exact 17 ET and catch-up through 20", () => {
    expect(decideDailyBriefCronSlot("evening", 17)).toEqual({
      fire: true, catchUp: false, reason: "exact",
    });
    expect(decideDailyBriefCronSlot("evening", 18).catchUp).toBe(true);
    expect(decideDailyBriefCronSlot("evening", 20).fire).toBe(true);
    expect(decideDailyBriefCronSlot("evening", 21).fire).toBe(false);
  });

  it("skips weekends", () => {
    expect(decideDailyBriefCronSlot("morning", 9, { weekday: false }).fire).toBe(false);
    expect(decideIntradayFlashCronSlot(11, { weekday: false }).fire).toBe(false);
  });

  it("defers heavy hourly work only on exact brief hours", () => {
    expect(shouldDeferHeavyHourlyWorkForBrief(9)).toBe(true);
    expect(shouldDeferHeavyHourlyWorkForBrief(17)).toBe(true);
    expect(shouldDeferHeavyHourlyWorkForBrief(10)).toBe(false);
    expect(shouldDeferHeavyHourlyWorkForBrief(9, { weekday: false })).toBe(false);
  });

  it("intraday flash exact + one-hour catch-up", () => {
    expect(decideIntradayFlashCronSlot(11)).toEqual({
      fire: true, catchUp: false, slotHour: 11, reason: "exact",
    });
    expect(decideIntradayFlashCronSlot(12)).toEqual({
      fire: true, catchUp: true, slotHour: 11, reason: "catch_up_11",
    });
    expect(decideIntradayFlashCronSlot(14).slotHour).toBe(14);
    expect(decideIntradayFlashCronSlot(15).slotHour).toBe(14);
    expect(decideIntradayFlashCronSlot(13).fire).toBe(false);
  });

  it("isEtWeekday uses America/New_York", () => {
    // Wednesday 2026-09-23 13:00 UTC = 9 AM ET weekday
    expect(isEtWeekday(new Date("2026-09-23T13:00:00Z"))).toBe(true);
    // Saturday
    expect(isEtWeekday(new Date("2026-09-26T13:00:00Z"))).toBe(false);
  });
});
