import { describe, it, expect } from "vitest";
import { shouldBuildDailyDigest } from "./bridge-notifications.js";

// The digest cron fires at 21:30 UTC, which is 5:30 PM ET during EDT and
// 4:30 PM ET during EST — after the close on the same ET date either way.
const cronAt = (isoDate) => Date.parse(`${isoDate}T21:30:00Z`);

describe("shouldBuildDailyDigest", () => {
  it("sends on a normal weekday", () => {
    const r = shouldBuildDailyDigest(cronAt("2026-08-17")); // Monday
    expect(r.send).toBe(true);
    expect(r.et_date).toBe("2026-08-17");
  });

  // The reported email: "Account today — 0 fills" delivered Sunday evening.
  it("skips Saturday and Sunday", () => {
    expect(shouldBuildDailyDigest(cronAt("2026-08-15")).send).toBe(false); // Sat
    const sun = shouldBuildDailyDigest(cronAt("2026-08-16"));
    expect(sun.send).toBe(false);
    expect(sun.reason).toBe("not_a_trading_day");
  });

  it("skips full market holidays", () => {
    expect(shouldBuildDailyDigest(cronAt("2026-09-07")).send).toBe(false); // Labor Day
    expect(shouldBuildDailyDigest(cronAt("2026-11-26")).send).toBe(false); // Thanksgiving
    expect(shouldBuildDailyDigest(cronAt("2026-12-25")).send).toBe(false); // Christmas
    expect(shouldBuildDailyDigest(cronAt("2026-01-19")).send).toBe(false); // MLK
    expect(shouldBuildDailyDigest(cronAt("2026-07-03")).send).toBe(false); // Independence Day observed
  });

  // Half-days are trading days — the account really could have moved.
  it("still sends on early-close sessions", () => {
    expect(shouldBuildDailyDigest(cronAt("2026-11-27")).send).toBe(true); // day after Thanksgiving
    expect(shouldBuildDailyDigest(cronAt("2026-12-24")).send).toBe(true); // Christmas Eve
  });

  it("resolves the trading day in ET, not UTC", () => {
    // 01:00 UTC Saturday is still Friday evening in New York.
    const r = shouldBuildDailyDigest(Date.parse("2026-08-15T01:00:00Z"));
    expect(r.et_date).toBe("2026-08-14");
    expect(r.send).toBe(true);
  });

  it("can be forced back on for testing", () => {
    const r = shouldBuildDailyDigest(cronAt("2026-08-16"), { ignoreCalendar: true });
    expect(r.send).toBe(true);
    expect(r.reason).toBe("calendar_override");
  });
});
