import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./alerts.js", () => ({
  notifyDiscord: vi.fn(async () => ({ ok: true, status: 204, lane: "trade" })),
}));

import { notifyDiscord } from "./alerts.js";
import { maybeNotifyDayTradePaperEvent } from "./option-day-trade-alerts.js";

function mockEnv(store = {}) {
  return {
    DISCORD_ENABLE: "true",
    DISCORD_WEBHOOK_URL: "https://discord.example/webhook",
    KV_TIMED: {
      async get(k) { return store[k] || null; },
      async put(k, v) { store[k] = v; },
      async delete(k) { delete store[k]; },
    },
  };
}

const payload = {
  profile: "speculator",
  signal_id: "dt:SPY:2026-08-20:2026-08-21:P:763",
  ticker: "SPY",
  flavor: "put",
  strike: 763,
  expiration: { dte: 1, iso: "2026-08-21" },
  now: Date.parse("2026-08-20T10:12:00-04:00"),
  spot: 762.8,
  premium: 0.38,
  execution: {
    action: "BUY",
    sell_kind: null,
    why: "holding the 5-minute 21 EMA",
    premium_band: { buy_ceil: 0.5, pin: 0.5, expected_close: 762.5, premium: 0.38, band: "under" },
    indicators: { ema21: 763.1, st_dir: 1, tf: "5" },
    contract: { ticker: "SPY", flavor: "put", strike: 763, expiration: { dte: 1 } },
  },
  gamePlan: { lean: "SHORT", lean_conviction: "high", bear_target: 762.5, bull_trigger: 766, bear_trigger: 764 },
};

describe("maybeNotifyDayTradePaperEvent", () => {
  beforeEach(() => notifyDiscord.mockClear());

  it("posts BUY once, then stays quiet on the next tick", async () => {
    const store = {};
    const env = mockEnv(store);
    const first = await maybeNotifyDayTradePaperEvent(env, payload);
    expect(first.event).toBe("BUY");
    expect(notifyDiscord).toHaveBeenCalledTimes(1);
    const embed = notifyDiscord.mock.calls[0][0] ? notifyDiscord.mock.calls[0][1] : null;
    expect(notifyDiscord.mock.calls[0][2]).toBe("trade");
    expect(embed.title).toMatch(/BUY/);
    expect(embed.title).toMatch(/Aug 21/);
    expect(embed.fields.some((f) => f.name === "Bracket")).toBe(true);

    const second = await maybeNotifyDayTradePaperEvent(env, payload);
    expect(second.event).toBeNull();
    expect(notifyDiscord).toHaveBeenCalledTimes(1);
  });

  it("skips non-default profiles", async () => {
    const env = mockEnv();
    const out = await maybeNotifyDayTradePaperEvent(env, { ...payload, profile: "moderate" });
    expect(out.skipped).toBe(true);
    expect(notifyDiscord).not.toHaveBeenCalled();
  });

  it("TRIMs a carried overnight book on the next session's signal id", async () => {
    const thuId = payload.signal_id;
    const store = {
      [`timed:opt-dt-book:${thuId}`]: JSON.stringify({
        status: "open",
        held_overnight: true,
        entry_premium: 0.45,
        trim_premium: 0.68,
        exit_premium: 0.90,
        contracts: 2,
        size_label: "medium",
        flavor: "put",
        strike: 763,
      }),
      "timed:opt-dt-carry:SPY": JSON.stringify({
        signal_id: thuId,
        book_key: `timed:opt-dt-book:${thuId}`,
        book: {
          status: "open",
          held_overnight: true,
          entry_premium: 0.45,
          trim_premium: 0.68,
          exit_premium: 0.90,
          contracts: 2,
          flavor: "put",
          strike: 763,
        },
      }),
    };
    const env = mockEnv(store);
    const out = await maybeNotifyDayTradePaperEvent(env, {
      ...payload,
      signal_id: "dt:SPY:2026-08-21:2026-08-24:P:770",
      premium: 0.72,
      execution: {
        ...payload.execution,
        action: "TRIM",
        sell_kind: "open_trim",
        why: "Overnight book — trim at the open",
        hold_overnight: false,
        carry_overnight: true,
      },
    });
    expect(out.event).toBe("TRIM");
    expect(notifyDiscord).toHaveBeenCalledTimes(1);
  });
});
