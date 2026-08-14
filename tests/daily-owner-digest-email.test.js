import { describe, it, expect } from "vitest";
import { buildDailyOwnerDigestEmail, getUserEmailPrefs } from "../worker/email.js";

describe("buildDailyOwnerDigestEmail", () => {
  it("uses the dark branded emailLayout (not a light pre dump)", () => {
    const out = buildDailyOwnerDigestEmail({
      broker: "WEBULL",
      broker_account_id: "WB-9",
      executed: [
        { kind: "fill", label: "BUY", ticker: "IONQ", qty: 3, price: 40 },
        { kind: "sync", label: "SYNC", ticker: "CAT", qty: 1.2, price: null },
      ],
      fill_count: 1,
      sync_count: 1,
      positions: [{ symbol: "IONQ", qty: 3, unrealized_pnl: 4 }],
      day_pnl: { realized: 0, unrealized: 4, total: 4 },
      equity_end: 20000,
    }, { unsubscribeUrl: "https://timed-trading.com/timed/email/unsubscribe?pref=broker_daily_digest" });

    expect(out).toBeTruthy();
    expect(out.subject).toMatch(/Account today — 1 fill, 1 sync/);
    expect(out.html).toContain("logo-discord.png");
    expect(out.html).toContain("#0b0e11");
    expect(out.html).toContain("IONQ");
    expect(out.html).toContain("broker_daily_digest");
    expect(out.html).not.toContain("<pre");
    expect(out.text).toContain("Email preferences");
  });
});

describe("getUserEmailPrefs — broker_daily_digest", () => {
  it("defaults on for paid, off for free", () => {
    expect(getUserEmailPrefs({ tier: "pro" }).broker_daily_digest).toBe(true);
    expect(getUserEmailPrefs({ tier: "free" }).broker_daily_digest).toBe(false);
  });

  it("honors stored false", () => {
    expect(getUserEmailPrefs({
      tier: "pro",
      email_preferences: JSON.stringify({ broker_daily_digest: false }),
    }).broker_daily_digest).toBe(false);
  });
});
