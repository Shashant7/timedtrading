// worker/investor-reentry-cooldown.test.js
// R7 (2026-06-28) — post-loss re-entry cooldown.
// Operator report: Investor Mode re-bought CRDO and MOD 2-3 days after each
// was stopped out on a PRIMARY_INVALIDATION_BREACH, catching the falling knife.
// These pin the pure predicate that blocks those re-entries.
import { describe, it, expect } from "vitest";
import {
  loadInvestorConfig,
  DEFAULT_INVESTOR_CONFIG,
  shouldBlockInvestorReentry,
} from "./investor.js";

const DAY = 86400000;
const NOW = Date.parse("2026-06-26T14:00:00Z"); // matches the CRDO/MOD re-entry date

describe("R7 cooldown — defaults + overrides", () => {
  it("ships the operator-intended defaults", () => {
    expect(DEFAULT_INVESTOR_CONFIG.loss_reentry_cooldown_enabled).toBe(true);
    expect(DEFAULT_INVESTOR_CONFIG.loss_reentry_cooldown_days).toBe(10);
    expect(DEFAULT_INVESTOR_CONFIG.loser_cooldown_consec_losses).toBe(2);
    expect(DEFAULT_INVESTOR_CONFIG.loser_cooldown_days).toBe(45);
  });

  it("applies bounds-checked overrides from daCfg", () => {
    const c = loadInvestorConfig({
      deep_audit_investor_loss_reentry_cooldown_enabled: "false",
      deep_audit_investor_loss_reentry_cooldown_days: "20",
      deep_audit_investor_loser_cooldown_consec_losses: "3",
      deep_audit_investor_loser_cooldown_days: "90",
    });
    expect(c.loss_reentry_cooldown_enabled).toBe(false);
    expect(c.loss_reentry_cooldown_days).toBe(20);
    expect(c.loser_cooldown_consec_losses).toBe(3);
    expect(c.loser_cooldown_days).toBe(90);
  });

  it("rejects nonsense values and keeps defaults", () => {
    const c = loadInvestorConfig({
      deep_audit_investor_loss_reentry_cooldown_days: "-5",
      deep_audit_investor_loser_cooldown_consec_losses: "0",
      deep_audit_investor_loser_cooldown_days: "9999",
    });
    expect(c.loss_reentry_cooldown_days).toBe(10);
    expect(c.loser_cooldown_consec_losses).toBe(2);
    expect(c.loser_cooldown_days).toBe(45);
  });
});

describe("R7 cooldown — predicate", () => {
  const cfg = loadInvestorConfig({});

  it("blocks the CRDO pattern: invalidation-breach close 2 days before re-entry", () => {
    const closes = [
      { closed_at: Date.parse("2026-06-24T15:00:00Z"), close_reason: "PRIMARY_INVALIDATION_BREACH", exit_pnl: -425.69 },
    ];
    const block = shouldBlockInvestorReentry(closes, NOW, cfg);
    expect(block).toBeTruthy();
    expect(block.consec_losses).toBe(1);
    expect(block.cooldown_days).toBe(10);
    expect(block.days_remaining).toBeGreaterThan(0);
  });

  it("blocks a realized loss even when the close reason is non-structural", () => {
    const closes = [
      { closed_at: NOW - 3 * DAY, close_reason: "manual_close", exit_pnl: -120.5 },
    ];
    expect(shouldBlockInvestorReentry(closes, NOW, cfg)).toBeTruthy();
  });

  it("does NOT block a profitable close (take-profit / rebalance)", () => {
    const closes = [
      { closed_at: NOW - 2 * DAY, close_reason: "trim_overweight", exit_pnl: 980.0 },
    ];
    expect(shouldBlockInvestorReentry(closes, NOW, cfg)).toBeNull();
  });

  it("does NOT block once the cooldown window has elapsed", () => {
    const closes = [
      { closed_at: NOW - 15 * DAY, close_reason: "PRIMARY_INVALIDATION_BREACH", exit_pnl: -300 },
    ];
    expect(shouldBlockInvestorReentry(closes, NOW, cfg)).toBeNull();
  });

  it("escalates to the persistent-loser ban after >= 2 consecutive losses (ASTS pattern)", () => {
    // ASTS-style: repeated losing closes. Most recent 12 days ago — past the
    // 10-day single-loss cooldown but inside the 45-day persistent-loser ban.
    const closes = [
      { closed_at: NOW - 12 * DAY, close_reason: "PRIMARY_INVALIDATION_BREACH", exit_pnl: -200 },
      { closed_at: NOW - 25 * DAY, close_reason: "weekly_supertrend_bearish", exit_pnl: -180 },
      { closed_at: NOW - 40 * DAY, close_reason: "investor_score_very_low", exit_pnl: -150 },
    ];
    const block = shouldBlockInvestorReentry(closes, NOW, cfg);
    expect(block).toBeTruthy();
    expect(block.consec_losses).toBe(3);
    expect(block.cooldown_days).toBe(45);
  });

  it("consecutive count stops at the first non-loss (a win breaks the streak)", () => {
    const closes = [
      { closed_at: NOW - 3 * DAY, close_reason: "PRIMARY_INVALIDATION_BREACH", exit_pnl: -200 },
      { closed_at: NOW - 20 * DAY, close_reason: "trim_overweight", exit_pnl: 500 }, // a win
      { closed_at: NOW - 30 * DAY, close_reason: "PRIMARY_INVALIDATION_BREACH", exit_pnl: -100 },
    ];
    const block = shouldBlockInvestorReentry(closes, NOW, cfg);
    expect(block).toBeTruthy();
    expect(block.consec_losses).toBe(1); // streak broken by the win
    expect(block.cooldown_days).toBe(10);
  });

  it("returns null when disabled", () => {
    const disabled = loadInvestorConfig({ deep_audit_investor_loss_reentry_cooldown_enabled: "false" });
    const closes = [{ closed_at: NOW - 1 * DAY, close_reason: "PRIMARY_INVALIDATION_BREACH", exit_pnl: -425 }];
    expect(shouldBlockInvestorReentry(closes, NOW, disabled)).toBeNull();
  });

  it("returns null for empty / missing history", () => {
    expect(shouldBlockInvestorReentry([], NOW, cfg)).toBeNull();
    expect(shouldBlockInvestorReentry(undefined, NOW, cfg)).toBeNull();
  });
});
