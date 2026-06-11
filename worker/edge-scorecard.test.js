// worker/edge-scorecard.test.js — pins the B5 stats core.

import { describe, it, expect } from "vitest";
import {
  computeWindowStats,
  findDemotionCandidates,
  deriveEdgeFlags,
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
