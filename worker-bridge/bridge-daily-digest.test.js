import { describe, it, expect } from "vitest";
import {
  midnightNyMs,
  renderDailyOwnerDigestEmail,
} from "./bridge-notifications.js";

describe("midnightNyMs", () => {
  it("returns a timestamp on the NY calendar day at ~00:00", () => {
    // 2026-08-13 16:30 ET = 20:30 UTC (EDT)
    const now = Date.parse("2026-08-13T20:30:00Z");
    const mid = midnightNyMs(now);
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    });
    const parts = Object.fromEntries(fmt.formatToParts(new Date(mid)).map((p) => [p.type, p.value]));
    expect(`${parts.year}-${parts.month}-${parts.day}`).toBe("2026-08-13");
    expect(parts.hour).toBe("00");
    expect(parts.minute).toBe("00");
  });
});

describe("renderDailyOwnerDigestEmail", () => {
  it("counts fills and syncs in the subject (not a misleading 0 trades)", () => {
    const email = renderDailyOwnerDigestEmail({
      broker: "WEBULL",
      broker_account_id: "WB-1",
      executed: [
        { kind: "fill", label: "BUY", ticker: "NVDA", qty: 1, price: 180, ts: 1 },
        { kind: "sync", label: "SYNC", ticker: "PLTR", qty: 1.5, price: null, ts: 2 },
      ],
      fill_count: 1,
      sync_count: 1,
      rejected_count: 0,
      positions: [
        { symbol: "NVDA", qty: 1, unrealized_pnl: 12 },
        { symbol: "PLTR", qty: 1.5, unrealized_pnl: 80 },
      ],
      options_positions: [],
      day_pnl: { realized: 0, unrealized: 92, total: 92 },
      equity_end: 16000,
      open_trades: [],
    });
    expect(email.subject).toMatch(/1 fill/);
    expect(email.subject).toMatch(/1 sync/);
    expect(email.subject).not.toMatch(/Your account/);
    expect(email.html).toContain("Timed Trading");
    expect(email.html).toContain("Executed today");
    expect(email.html).toContain("NVDA");
    expect(email.html).toContain("my-account.html#email");
    expect(email.html).not.toContain("<pre");
  });

  it("says 0 fills when nothing executed (not 0 trades)", () => {
    const email = renderDailyOwnerDigestEmail({
      broker: "WEBULL",
      executed: [],
      fill_count: 0,
      sync_count: 0,
      rejected_count: 0,
      positions: [{ symbol: "AAPL", qty: 2, unrealized_pnl: 1 }],
      day_pnl: { realized: 0, unrealized: 1, total: 1 },
      equity_end: 1000,
      open_trades: [],
    });
    expect(email.subject).toMatch(/0 fills/);
    expect(email.subject).not.toMatch(/0 trades/);
  });
});
