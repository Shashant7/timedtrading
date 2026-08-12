import { describe, it, expect } from "vitest";
import { shouldSendDiscordAlert } from "./alerts.js";

// 2026-08-12 — Operator noise cleanup: notifications/emails focus on actual
// actions (buy / sell / stop-target-invalidation updates). Advisory "Exit
// Recommended" warnings no longer page any channel; executed actions still do.
describe("shouldSendDiscordAlert — exit-advisory noise cleanup", () => {
  it("KANBAN_EXIT (exit recommendation) is off in critical mode", () => {
    expect(shouldSendDiscordAlert({}, "KANBAN_EXIT", { ticker: "NVDA" })).toBe(false);
  });

  it("KANBAN_EXIT stays off even when DISCORD_ALERT_MODE=all (dashboard keep_vars)", () => {
    expect(shouldSendDiscordAlert({ DISCORD_ALERT_MODE: "all" }, "KANBAN_EXIT", { ticker: "NVDA" })).toBe(false);
  });

  it("executed exits (TRADE_EXIT) still page", () => {
    expect(shouldSendDiscordAlert({}, "TRADE_EXIT", { ticker: "NVDA" })).toBe(true);
  });

  it("entries still page", () => {
    expect(shouldSendDiscordAlert({}, "TRADE_ENTRY", { ticker: "NVDA" })).toBe(true);
  });

  it("defend (stop update) and trim lane alerts unchanged", () => {
    expect(shouldSendDiscordAlert({}, "KANBAN_DEFEND", { ticker: "NVDA" })).toBe(true);
    expect(shouldSendDiscordAlert({}, "KANBAN_TRIM", { ticker: "NVDA" })).toBe(true);
  });
});
