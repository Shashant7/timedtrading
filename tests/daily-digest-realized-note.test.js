import { describe, it, expect } from "vitest";
import { buildDailyOwnerDigestEmail } from "../worker/email.js";

function digest(dayPnl) {
  return {
    broker: "WEBULL",
    broker_account_id: "WB-1",
    executed: [{ label: "SELL", ticker: "AMZN", qty: 17, price: 120, kind: "fill" }],
    fill_count: 1,
    positions: [],
    equity_end: 16793,
    day_pnl: dayPnl,
  };
}

describe("Account today — realized line", () => {
  it("shows a non-zero realized figure when the day had sells", () => {
    const out = buildDailyOwnerDigestEmail(digest({
      realized: 220.5, unrealized: 109.35, total: 329.85, realized_sell_count: 1,
    }));
    expect(out.html).toContain("$220.50");
    expect(out.text).toContain("Realized $220.50");
  });

  it("renders a realized loss with a leading minus", () => {
    const out = buildDailyOwnerDigestEmail(digest({
      realized: -84.2, unrealized: 0, total: -84.2, realized_sell_count: 2,
    }));
    expect(out.html).toContain("-$84.20");
    expect(out.text).toContain("Realized -$84.20");
  });

  it("says the number is partial when a sell had no cost basis", () => {
    const out = buildDailyOwnerDigestEmail(digest({
      realized: 100, unrealized: 0, total: 100,
      realized_sell_count: 2, realized_partial: true, realized_unattributed_sells: 1,
    }));
    expect(out.html).toContain("partial");
    expect(out.html).toContain("1 sell missing a recorded cost basis");
  });

  it("says when the basis came from the broker average rather than the ledger", () => {
    const out = buildDailyOwnerDigestEmail(digest({
      realized: 220, unrealized: 0, total: 220,
      realized_sell_count: 1, realized_partial: false, realized_estimated_sells: 1,
    }));
    expect(out.html).toContain("priced off the broker average cost");
  });

  it("just counts the sells when every share had a recorded basis", () => {
    const out = buildDailyOwnerDigestEmail(digest({
      realized: 50, unrealized: 0, total: 50, realized_sell_count: 3,
    }));
    expect(out.html).toContain("3 sells");
    expect(out.html).not.toContain("partial");
  });

  it("adds no note on a day with no sells", () => {
    const out = buildDailyOwnerDigestEmail(digest({
      realized: 0, unrealized: 109.35, total: 109.35, realized_sell_count: 0,
    }));
    expect(out.html).toContain("Realized <span");
    expect(out.html).not.toContain("sell");
  });
});
