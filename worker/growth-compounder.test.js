// worker/growth-compounder.test.js
// Pins growth compounder / revenue path semantics.

import { describe, it, expect } from "vitest";
import {
  buildRevenueTrajectory,
  classifyGrowthCompounder,
  buildHoldThesisBullets,
  detectCompounderDipBuy,
  computeCompounderScoreBoost,
  extractGrowthCompounderSignal,
  buildInvestorHoldbook,
  buildInvestorHoldbookCache,
  overlayHoldbookPrices,
  enrichHoldbookRowNames,
  enrichHoldbookScoreRows,
  attachCompounderFromSnapshot,
  attachCompounderFromLatest,
  normalizeRevenueEstimates,
  COMPOUNDER_TIER_LABELS,
} from "./growth-compounder.js";
import { extractFairValueSignal } from "./fair-value.js";

function muLikeSnapshot() {
  return {
    ticker: "MU",
    valuation: {
      market_cap: 180e9,
      ps_ratio: 3.1,
      fair_value_price: 1200,
      fair_value_premium_pct: 15,
      fair_value_class: "premium",
    },
    growth: {
      rev_growth_pct: 94,
      eps_growth_pct: 120,
      rev_growth_class: "explosive",
      eps_growth_class: "explosive",
      roe_ttm_pct: 18,
      profit_margin_pct: 22,
    },
    earnings: {
      beat_rate_pct: 87.5,
      avg_surprise_pct: 12,
      revenue_history: [
        { date: "2023-03-01", revenue_actual: 3.7e9 },
        { date: "2023-06-01", revenue_actual: 3.8e9 },
        { date: "2023-09-01", revenue_actual: 4.0e9 },
        { date: "2023-12-01", revenue_actual: 4.7e9 },
        { date: "2024-03-01", revenue_actual: 5.8e9 },
        { date: "2024-06-01", revenue_actual: 6.8e9 },
        { date: "2024-09-01", revenue_actual: 7.7e9 },
        { date: "2024-12-01", revenue_actual: 8.7e9 },
      ],
      revenue_estimates: [
        { date: "2026-08-31", period: "current_year", avg_estimate: 112e9, number_of_analysts: 28, sales_growth_pct: 94 },
        { date: "2027-08-31", period: "next_year", avg_estimate: 199e9, number_of_analysts: 30, sales_growth_pct: 77 },
      ],
    },
    capital_structure: {
      free_cash_flow_ttm: 22e9,
    },
  };
}

describe("normalizeRevenueEstimates", () => {
  it("converts analyst rows to billions", () => {
    const rows = normalizeRevenueEstimates([
      { date: "2026-08-31", period: "current_year", avg_estimate: 50e9, number_of_analysts: 12, sales_growth_pct: 0.25 },
    ]);
    expect(rows[0].revenue_b).toBe(50);
    expect(rows[0].yoy_pct).toBe(25);
  });
});

describe("buildRevenueTrajectory", () => {
  it("prefers analyst consensus for forward bars", () => {
    const traj = buildRevenueTrajectory(muLikeSnapshot());
    expect(traj.forward_source).toBe("analyst_consensus");
    expect(traj.points.some((p) => p.source === "analyst_consensus")).toBe(true);
    expect(traj.points.some((p) => p.analysts === 28)).toBe(true);
  });

  it("falls back to market cap / P/S when revenue rows are sparse", () => {
    const traj = buildRevenueTrajectory({
      valuation: { market_cap: 100e9, ps_ratio: 5 },
      growth: { rev_growth_pct: 40 },
    });
    expect(traj.ltm_b).toBe(20);
    expect(traj.forward_source).toBe("model_projection");
  });
});

describe("classifyGrowthCompounder", () => {
  it("classifies explosive revenue + quality A as growth_elite", () => {
    const snap = muLikeSnapshot();
    const fv = extractFairValueSignal(snap);
    const comp = classifyGrowthCompounder(snap, fv);
    expect(comp.tier).toBe("growth_elite");
    expect(comp.tier_label).toBe(COMPOUNDER_TIER_LABELS.growth_elite);
    expect(comp.hold_thesis.length).toBeGreaterThan(0);
  });
});

describe("buildHoldThesisBullets", () => {
  it("leads with compounding core guidance for growth_elite", () => {
    const snap = muLikeSnapshot();
    const fv = extractFairValueSignal(snap);
    const traj = buildRevenueTrajectory(snap);
    const bullets = buildHoldThesisBullets(snap, fv, traj, "growth_elite");
    expect(bullets.some((b) => /Compounding core/i.test(b))).toBe(true);
  });
});

describe("overlayHoldbookPrices", () => {
  it("overlays timed:prices onto cached holdings", () => {
    const out = overlayHoldbookPrices(
      {
        ok: true,
        count: 1,
        holdings: [{ ticker: "MU", price: null, dailyChgPct: null }],
        groups: { in_book: [], building: [], on_radar: [{ ticker: "MU" }] },
      },
      { MU: { p: 120, dp: 2.5 } },
    );
    expect(out.holdings[0].price).toBe(120);
    expect(out.holdings[0].dailyChgPct).toBe(2.5);
    expect(out.groups.on_radar[0].price).toBe(120);
  });
});

describe("buildInvestorHoldbookCache", () => {
  it("builds a persistable holdbook payload from score rows", async () => {
    const snap = muLikeSnapshot();
    const book = await buildInvestorHoldbookCache(
      [{
        ticker: "MU",
        stage: "watch",
        score: 72,
        rsRank: 90,
        compounder: extractGrowthCompounderSignal(snap),
      }],
      {
        kvGetJSON: () => Promise.resolve(null),
        kvKeyFn: (t) => `timed:fundamentals_v7:${t}`,
      },
    );
    expect(book.count).toBe(1);
    expect(book.holdings[0].ticker).toBe("MU");
  });
});

describe("enrichHoldbookScoreRows", () => {
  it("live-fetches fundamentals when KV snapshot is missing", async () => {
    const snap = muLikeSnapshot();
    const fetched = [];
    const rows = await enrichHoldbookScoreRows(
      [{ ticker: "MU", stage: "watch", score: 72 }],
      () => Promise.resolve(null),
      () => "timed:fundamentals_v7:MU",
      {
        fetchSnapshot: async (ticker) => {
          fetched.push(ticker);
          return { ok: true, snapshot: { ...snap, compounder: extractGrowthCompounderSignal(snap) } };
        },
        liveFetchCap: 5,
      },
    );
    expect(fetched).toEqual(["MU"]);
    expect(rows[0].compounder?.tier).toBe("growth_elite");
  });

  it("prioritizes holdbook candidate stages for live fetch", async () => {
    const snap = muLikeSnapshot();
    const fetched = [];
    await enrichHoldbookScoreRows(
      [
        { ticker: "ZZ", stage: "avoid", score: 99 },
        { ticker: "MU", stage: "watch", score: 60 },
      ],
      () => Promise.resolve(null),
      (t) => `timed:fundamentals_v7:${t}`,
      {
        fetchSnapshot: async (ticker) => {
          fetched.push(ticker);
          return { ok: true, snapshot: snap };
        },
        liveFetchCap: 1,
      },
    );
    expect(fetched).toEqual(["MU"]);
  });
});

describe("enrichHoldbookRowNames", () => {
  it("fills companyName from timed:context KV", async () => {
    const kv = {
      "timed:context:MOD": { name: "Modine Manufacturing Company" },
    };
    const rows = await enrichHoldbookRowNames(
      [{ ticker: "MOD" }, { ticker: "MU", companyName: "Micron" }],
      (key) => Promise.resolve(kv[key] || null),
    );
    expect(rows[0].companyName).toBe("Modine Manufacturing Company");
    expect(rows[1].companyName).toBe("Micron");
  });
});

describe("buildInvestorHoldbook", () => {
  it("groups owned compounders into in_book", () => {
    const book = buildInvestorHoldbook([
      {
        ticker: "MU",
        stage: "core_hold",
        score: 72,
        rsRank: 99,
        position: { owned: true },
        compounder: { tier: "growth_elite", tier_label: "COMPOUND CORE", hold_thesis: ["test"] },
      },
    ]);
    expect(book.count).toBe(1);
    expect(book.groups.in_book).toHaveLength(1);
  });
});

describe("attachCompounderFromLatest", () => {
  it("fills compounder from timed:latest payload", () => {
    const row = attachCompounderFromLatest(
      { ticker: "MU", stage: "watch", score: 68 },
      {
        _compounder: {
          tier: "growth_elite",
          tier_label: "COMPOUND CORE",
          hold_thesis: ["test"],
        },
      },
    );
    expect(row.compounder?.tier).toBe("growth_elite");
  });
});

describe("attachCompounderFromSnapshot", () => {
  it("fills compounder from fundamentals snapshot", () => {
    const snap = muLikeSnapshot();
    const row = attachCompounderFromSnapshot({ ticker: "MU", stage: "watch", score: 68 }, snap);
    expect(row.compounder?.tier).toBe("growth_elite");
  });
});

describe("detectCompounderDipBuy", () => {
  it("detects timing bottom as dip", () => {
    const dip = detectCompounderDipBuy(
      { price: 100, tf_tech: { W: { rsi: { r5: 48 } } }, monthly_bundle: { rsi: 55 } },
      { timing_primary: "BOTTOM", add_on_dips: true },
      null,
    );
    expect(dip.isDip).toBe(true);
  });
});

describe("computeCompounderScoreBoost", () => {
  it("adds extra boost on dip days", () => {
    const elite = { eligible: true, tier: "growth_elite" };
    expect(computeCompounderScoreBoost(elite, { isDip: true })).toBe(7);
  });
});

describe("extractGrowthCompounderSignal", () => {
  it("returns compact compounder payload", () => {
    const sig = extractGrowthCompounderSignal(muLikeSnapshot());
    expect(sig.tier).toBe("growth_elite");
    expect(sig.trajectory?.forward_source).toBe("analyst_consensus");
  });
});
