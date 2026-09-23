// worker/edge-scorecard.test.js — pins the B5 stats core.

import { describe, it, expect } from "vitest";
import {
  computeWindowStats,
  findDemotionCandidates,
  deriveEdgeFlags,
  setupGroupKey,
  groupTradesBySetup,
  entryFaultDemotions,
  regimeGateCandidates,
} from "./edge-scorecard.js";

const W = (pnl, pct = 1) => ({ status: "WIN", pnl, pnl_pct: pct });
const L = (pnl, pct = -1) => ({ status: "LOSS", pnl: -Math.abs(pnl), pnl_pct: -Math.abs(pct) });

describe("computeWindowStats", () => {
  it("computes WR, PF, expectancy, and drawdown", () => {
    const s = computeWindowStats([W(100), L(50), W(200), L(100), W(50)]);
    expect(s.n).toBe(5);
    expect(s.wins).toBe(3);
    expect(s.losses).toBe(2);
    expect(s.win_rate_pct).toBe(60);
    expect(s.profit_factor).toBeCloseTo(350 / 150, 2);
    expect(s.pnl_usd).toBe(200);
    expect(s.expectancy_usd).toBe(40);
    // equity path: 100, 50, 250, 150, 200 → peak 250, trough 150 → dd 100
    expect(s.max_drawdown_usd).toBe(100);
  });

  it("handles all-win (PF capped) and empty inputs", () => {
    expect(computeWindowStats([W(10)]).profit_factor).toBe(99);
    const empty = computeWindowStats([]);
    expect(empty.n).toBe(0);
    expect(empty.win_rate_pct).toBeNull();
    expect(empty.expectancy_usd).toBeNull();
  });
});

describe("setupGroupKey", () => {
  it("collapses Cloud Pivot display name and path onto one id", () => {
    expect(setupGroupKey({ setup_name: "TT Cloud Pivot", direction: "LONG" })).toBe("tt_cloud_pivot");
    expect(setupGroupKey({ entry_path: "tt_cloud_pivot", setup_name: "Cloud Pivot" })).toBe("tt_cloud_pivot");
  });
});

describe("groupTradesBySetup", () => {
  it("does not let paper siblings contaminate the core outcome cohort", () => {
    const grouped = groupTradesBySetup([
      { entry_path: "tt_cloud_pivot", setup_name: "TT Cloud Pivot", direction: "LONG", ...W(50) },
      { entry_path: "tt_cloud_pivot_long", setup_name: "TT Cloud Pivot", direction: "LONG", ...L(10) },
    ], 1);
    expect(grouped).toHaveLength(2);
    expect(grouped.find(s => s.setup === "tt_cloud_pivot").stats.pnl_usd).toBe(50);
    expect(grouped.find(s => s.setup === "tt_cloud_pivot_long").stats.pnl_usd).toBe(-10);
  });

  it("groups 30d vs 90d independently", () => {
    const rows = [
      { setup_name: "TT Support Bounce", direction: "LONG", status: "WIN", pnl: 50, pnl_pct: 1 },
      { setup_name: "TT Support Bounce", direction: "LONG", status: "WIN", pnl: 40, pnl_pct: 1 },
      { setup_name: "TT Support Bounce", direction: "LONG", status: "WIN", pnl: 30, pnl_pct: 1 },
      { setup_name: "tt_cloud_pivot", direction: "LONG", status: "LOSS", pnl: -20, pnl_pct: -1 },
    ];
    const grouped = groupTradesBySetup(rows);
    const sb = grouped.find((s) => s.setup === "tt_n_test_support");
    expect(sb.stats.n).toBe(3);
    expect(sb.stats.pnl_usd).toBe(120);
  });
});

describe("findDemotionCandidates", () => {
  it("flags setups with n>=10 and PF<0.8 only", () => {
    const perSetup = [
      { setup: "tt_ath_breakout", direction: "LONG", stats: { n: 14, profit_factor: 0.55, win_rate_pct: 28, pnl_usd: -900 } },
      { setup: "tt_gap_reversal_long", direction: "LONG", stats: { n: 40, profit_factor: 2.9, win_rate_pct: 62, pnl_usd: 4000 } },
      { setup: "tt_momentum", direction: "LONG", stats: { n: 4, profit_factor: 0.2, win_rate_pct: 25, pnl_usd: -200 } }, // n too small
    ];
    const out = findDemotionCandidates(perSetup);
    expect(out).toHaveLength(1);
    expect(out[0].setup).toBe("tt_ath_breakout");
  });

  // 2026-09-23 — a low profit factor says the trade lost money, not that the
  // signal was wrong. Support Bounce ran 60 days bleeding while its entries
  // beat the book on both excursion axes and converted 5% of what they found.
  it("proposes fix_management, not demote, when the entries beat the book", () => {
    const out = findDemotionCandidates([{
      setup: "tt_n_test_support",
      direction: "LONG",
      stats: { n: 24, profit_factor: 0.6, win_rate_pct: 29, pnl_usd: -215 },
      entry_quality: { entry_edge: "confirmed", mfe_mae_ratio: 1.81, hit_rate_2pct: 54.2, why: "beats the book" },
      mfe_capture_rate: 0.051,
    }]);
    expect(out[0].owner).toBe("management");
    expect(out[0].action).toBe("fix_management");
    expect(out[0].why).toMatch(/do not demote the signal/);
  });

  it("still proposes demote when the signal itself is not finding moves", () => {
    const out = findDemotionCandidates([{
      setup: "tt_ath_breakout",
      direction: "LONG",
      stats: { n: 20, profit_factor: 0.13, win_rate_pct: 35, pnl_usd: -945 },
      entry_quality: { entry_edge: "absent", mfe_mae_ratio: 0.78, hit_rate_2pct: 35, why: "more heat than opportunity" },
      mfe_capture_rate: -0.385,
    }]);
    expect(out[0].owner).toBe("entry");
    expect(out[0].action).toBe("demote");
  });

  it("leaves a marginal entry with management rather than deleting the signal", () => {
    const out = findDemotionCandidates([{
      setup: "tt_cloud_pivot_long",
      direction: "LONG",
      stats: { n: 27, profit_factor: 0.23, win_rate_pct: 38.5, pnl_usd: -244 },
      entry_quality: { entry_edge: "neutral", mfe_mae_ratio: 1.48, hit_rate_2pct: 48.1, why: "indistinguishable" },
      mfe_capture_rate: -0.287,
    }]);
    expect(out[0].action).toBe("fix_management");
  });

  // ATH Breakout's pooled "absent" is 11 risk-on entries that work averaged
  // with 33 balanced-regime ones that do not. Retiring it deletes the half
  // that works; the defect is that nothing stops it firing out of season.
  const REGIME_SELECTIVE = {
    setup: "tt_ath_breakout",
    direction: "LONG",
    stats: { n: 44, profit_factor: 0.3, win_rate_pct: 29, pnl_usd: -900 },
    entry_quality: { entry_edge: "absent", mfe_mae_ratio: 0.78, hit_rate_2pct: 30, why: "more heat than opportunity" },
    regime_fit: {
      pattern: "regime_selective",
      works_in: ["risk_on"],
      fails_in: ["balanced"],
      off_regime_share_pct: 75,
      why: "confirmed in risk_on and absent in balanced — gate the detector by regime rather than retiring it",
    },
    mfe_capture_rate: -0.385,
  };

  it("asks for a regime gate instead of a demote when the edge is seasonal", () => {
    const out = findDemotionCandidates([REGIME_SELECTIVE]);
    expect(out[0].action).toBe("gate_by_regime");
    expect(out[0].owner).toBe("entry");
    expect(out[0].works_in).toEqual(["risk_on"]);
    expect(out[0].off_regime_share_pct).toBe(75);
  });

  it("keeps a regime gate out of the list of things to actually demote", () => {
    const flat = {
      ...REGIME_SELECTIVE,
      setup: "tt_atl_breakdown",
      regime_fit: null,
    };
    const out = findDemotionCandidates([REGIME_SELECTIVE, flat]);
    expect(entryFaultDemotions(out).map((c) => c.setup)).toEqual(["tt_atl_breakdown"]);
    expect(regimeGateCandidates(out).map((c) => c.setup)).toEqual(["tt_ath_breakout"]);
  });

  it("ignores a regime split on a setup whose entries are fine", () => {
    const out = findDemotionCandidates([{
      ...REGIME_SELECTIVE,
      entry_quality: { entry_edge: "confirmed", mfe_mae_ratio: 1.9, hit_rate_2pct: 55, why: "beats the book" },
    }]);
    expect(out[0].action).toBe("fix_management");
  });
});

describe("groupTradesBySetup grades the entry separately from the outcome", () => {
  const row = (setup, mfe, mae, pnlPct) => ({
    setup_name: setup,
    direction: "LONG",
    status: pnlPct > 0 ? "WIN" : "LOSS",
    pnl: pnlPct * 10,
    pnl_pct: pnlPct,
    max_favorable_excursion: mfe,
    max_adverse_excursion: -mae,
  });

  it("separates a detector with good entries and bad exits from one with bad entries", () => {
    const rows = [
      // Good entries, all of it given back.
      ...Array.from({ length: 12 }, () => row("Leaky", 6, 2, 0.1)),
      // Bad entries — more heat than opportunity.
      ...Array.from({ length: 12 }, () => row("Blind", 1.2, 3, -0.9)),
    ];
    const grouped = groupTradesBySetup(rows);
    const leaky = grouped.find((s) => s.setup === "Leaky");
    const blind = grouped.find((s) => s.setup === "Blind");

    expect(leaky.entry_quality.entry_edge).toBe("confirmed");
    expect(leaky.diagnosis.owner).toBe("management");
    expect(leaky.mfe_capture_rate).toBeLessThan(0.35);

    expect(blind.entry_quality.entry_edge).toBe("absent");
    expect(blind.diagnosis.owner).toBe("entry");
  });

  it("grades against the window's own book, so a quiet tape does not fail everyone", () => {
    // Same relative shape as above, every excursion halved.
    const rows = [
      ...Array.from({ length: 12 }, () => row("Leaky", 3, 1, 0.05)),
      ...Array.from({ length: 12 }, () => row("Blind", 0.6, 1.5, -0.45)),
    ];
    const grouped = groupTradesBySetup(rows);
    expect(grouped.find((s) => s.setup === "Leaky").entry_quality.entry_edge).toBe("confirmed");
    expect(grouped.find((s) => s.setup === "Blind").entry_quality.entry_edge).toBe("absent");
  });
});

describe("deriveEdgeFlags", () => {
  it("flags non-positive 30d expectancy and PF<1", () => {
    const flags = deriveEdgeFlags({
      d30: { n: 20, expectancy_usd: -5, profit_factor: 0.9, pnl_usd: -100, max_drawdown_usd: 150 },
      d90: { n: 50, expectancy_pct: 0.1, pnl_usd: 100 },
    }, { d90_pct: 4 });
    expect(flags.some((f) => f.includes("30d expectancy"))).toBe(true);
    expect(flags.some((f) => f.includes("profit factor"))).toBe(true);
  });

  it("calls out no-edge-over-buy-hold quarters", () => {
    const flags = deriveEdgeFlags({
      d30: { n: 15, expectancy_usd: 2, profit_factor: 1.1, pnl_usd: 30, max_drawdown_usd: 40 },
      d90: { n: 40, expectancy_pct: 0, pnl_usd: -50 },
    }, { d90_pct: 6.5 });
    expect(flags.some((f) => f.includes("no edge over buy-hold"))).toBe(true);
  });

  it("reports a clean bill when healthy", () => {
    const flags = deriveEdgeFlags({
      d30: { n: 20, expectancy_usd: 45, profit_factor: 1.8, pnl_usd: 900, max_drawdown_usd: 200 },
      d90: { n: 60, expectancy_pct: 0.9, pnl_usd: 2500 },
    }, { d90_pct: 3 });
    expect(flags).toEqual(["no structural red flags in the trailing 30d"]);
  });
});
