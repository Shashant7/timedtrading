import { describe, it, expect } from "vitest";
import {
  canPaperFillOptions,
  buildOptionsPaperFill,
  markOptionsPaperPosition,
  buildLetfPaperFill,
  applyModelPlaySimToTrade,
  isModelPlaySimEnabled,
} from "./model-play-sim.js";

const longCallPlay = {
  archetype: "long_call",
  label: "Long Call",
  net_side: "debit",
  max_loss_usd: 420,
  breakeven: 108,
  expiration: { iso: "2026-08-15", label: "Aug 15" },
  legs: [{
    kind: "option",
    action: "BUY",
    type: "CALL",
    strike: 105,
    expiration: "2026-08-15",
    qty: 1,
    premium_mid: 4.20,
  }],
};

describe("options paper fill", () => {
  it("accepts long debit calls", () => {
    expect(canPaperFillOptions(longCallPlay)).toBe(true);
  });

  it("rejects covered calls", () => {
    expect(canPaperFillOptions({
      archetype: "covered_call",
      net_side: "credit",
      legs: [{ kind: "option", action: "SELL", type: "CALL", strike: 110, premium_mid: 1.5 }],
    })).toBe(false);
  });

  it("sizes contracts from risk budget", () => {
    const fill = buildOptionsPaperFill({
      play: longCallPlay,
      riskBudgetUsd: 900,
      cash: 50_000,
      underlyingEntry: 100,
      underlyingSl: 95,
      underlyingTp: 108,
      atrPct: 0.02,
      asOfMs: Date.parse("2026-07-19T16:00:00Z"),
    });
    expect(fill.contracts).toBe(2); // 900 / 420
    expect(fill.debit_usd).toBeCloseTo(840, 5);
    expect(fill.premium_entry).toBe(4.2);
    expect(fill.mark_source).toBe("bs_atr_proxy");
  });

  it("marks premium higher when underlying rallies", () => {
    const fill = buildOptionsPaperFill({
      play: longCallPlay,
      riskBudgetUsd: 500,
      cash: 50_000,
      underlyingEntry: 100,
      underlyingSl: 95,
      underlyingTp: 108,
      atrPct: 0.02,
      asOfMs: Date.parse("2026-07-19T16:00:00Z"),
    });
    const atEntry = markOptionsPaperPosition(fill, {
      underlyingPrice: 100,
      atrPct: 0.02,
      asOfMs: Date.parse("2026-07-19T16:00:00Z"),
    });
    const atRally = markOptionsPaperPosition(fill, {
      underlyingPrice: 108,
      atrPct: 0.02,
      asOfMs: Date.parse("2026-07-22T16:00:00Z"),
    });
    expect(atRally.mark_premium).toBeGreaterThan(atEntry.mark_premium);
    expect(atRally.pnl_usd).toBeGreaterThan(atEntry.pnl_usd);
  });
});

describe("letf paper fill", () => {
  it("fills mapped LETF when quote exists", () => {
    const fill = buildLetfPaperFill({
      pick: { letf_ticker: "TQQQ", label: "TQQQ 3x" },
      riskBudgetUsd: 500,
      cash: 50_000,
      underlyingEntry: 100,
      underlyingSl: 95,
      underlyingTp: 108,
      letfPrice: 50,
    });
    expect(fill.letf_ticker).toBe("TQQQ");
    expect(fill.shares).toBeGreaterThan(0);
    expect(fill.notional).toBeCloseTo(fill.shares * 50, 5);
  });

  it("returns null without quote", () => {
    expect(buildLetfPaperFill({
      pick: { letf_ticker: "TQQQ" },
      riskBudgetUsd: 500,
      cash: 50_000,
      letfPrice: null,
    })).toBeNull();
  });
});

describe("applyModelPlaySimToTrade", () => {
  it("converts shares trade to options paper and adjusts cash", () => {
    const trade = {
      ticker: "QQQ",
      direction: "LONG",
      entryPrice: 100,
      shares: 50,
      sl: 95,
      tp: 108,
      pointValue: 1,
      notional: 5000,
      trimTiers: [{ pct: 0.5 }],
    };
    const portfolio = { cash: 95_000 }; // already debited 5k from 100k
    const menu = {
      pick: {
        vehicle: "option",
        play_vehicle: "options",
        label: "Long Call",
        suitability: 80,
        why: "convexity",
      },
    };
    const res = applyModelPlaySimToTrade({
      trade,
      portfolio,
      menu,
      optionsPlay: longCallPlay,
      riskBudgetUsd: 900,
      atrPct: 0.02,
      asOfMs: Date.parse("2026-07-19T16:00:00Z"),
    });
    expect(res.executed_vehicle).toBe("options");
    expect(trade.vehicle).toBe("options");
    expect(trade.shares).toBe(2);
    expect(trade.entryPrice).toBe(4.2);
    expect(trade.pointValue).toBe(100);
    expect(trade.sl).toBe(95); // underlying trigger preserved
    expect(trade.underlying_entry).toBe(100);
    expect(portfolio.cash).toBeCloseTo(100_000 - 840, 5);
  });

  it("falls back to shares when options cannot fill", () => {
    const trade = {
      ticker: "QQQ", entryPrice: 100, shares: 10, sl: 95, tp: 108, notional: 1000,
    };
    const portfolio = { cash: 99_000 };
    const res = applyModelPlaySimToTrade({
      trade,
      portfolio,
      menu: { pick: { play_vehicle: "options", vehicle: "option" } },
      optionsPlay: { archetype: "covered_call", net_side: "credit" },
      riskBudgetUsd: 500,
    });
    expect(res.executed_vehicle).toBe("shares");
    expect(portfolio.cash).toBe(99_000); // re-debited shares
  });
});

describe("isModelPlaySimEnabled", () => {
  it("defaults on for live, off for replay", () => {
    expect(isModelPlaySimEnabled({}, { isReplay: false })).toBe(true);
    expect(isModelPlaySimEnabled({}, { isReplay: true })).toBe(false);
    expect(isModelPlaySimEnabled({
      _deepAuditConfig: { deep_audit_model_play_sim_enabled: "false" },
    })).toBe(false);
  });
});
