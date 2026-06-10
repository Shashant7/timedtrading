// Tests for portfolio-level risk controls (P4.S1/S3).

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  computeBookState,
  updateEquitySamples,
  evaluatePortfolioRisk,
  readPortfolioRisk,
  evaluateRegimeShockDerisk,
} from "./portfolio-risk.js";

function makeKV(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, v); },
    _store: store,
  };
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("computeBookState", () => {
  it("computes equity, MTM, and notional for a mixed book", () => {
    const open = [
      { ticker: "AAPL", direction: "LONG", shares: 10, entry_price: 100 },  // px 110 → +100 MTM, 1100 notional
      { ticker: "TSLA", direction: "SHORT", shares: 5, entry_price: 200 },  // px 190 → +50 MTM, 950 notional
    ];
    const prices = { AAPL: { p: 110 }, TSLA: { p: 190 } };
    const s = computeBookState(open, prices, 500, 100000);
    expect(s.open_mtm).toBe(150);
    expect(s.open_notional).toBe(2050);
    expect(s.equity).toBe(100650); // 100000 + 500 realized + 150 MTM
    expect(s.open_notional_pct).toBeCloseTo(2.0, 1);
  });

  it("falls back to entry price (flat MTM) when the feed lacks the ticker", () => {
    const s = computeBookState(
      [{ ticker: "XYZ", direction: "LONG", shares: 10, entry_price: 50 }],
      {}, 0, 100000,
    );
    expect(s.open_mtm).toBe(0);
    expect(s.open_notional).toBe(500); // still counts toward the budget
  });
});

describe("updateEquitySamples", () => {
  it("keeps one sample per day (intraday high wins) and returns the trailing high", async () => {
    const kv = makeKV();
    await updateEquitySamples(kv, 100000);
    const second = await updateEquitySamples(kv, 99000); // same day, lower — high retained
    expect(second.samples).toBe(1);
    expect(second.trailing_high).toBe(100000);
  });
});

describe("evaluatePortfolioRisk", () => {
  const baseArgs = (overrides = {}) => ({
    openRows: [],
    priceMap: {},
    realizedPnl: 0,
    startCash: 100000,
    daCfg: {},
    ...overrides,
  });

  it("requires 5+ daily samples before a DD trip (fresh ring never trips)", async () => {
    const env = { KV_TIMED: makeKV() };
    const state = await evaluatePortfolioRisk(env, baseArgs({ realizedPnl: -10000 }));
    expect(state.dd_trip).toBe(false);
    expect(state.block_new_entries).toBe(false);
  });

  it("trips DD in SHADOW (no block) when threshold exceeded but flag off", async () => {
    // Seed 6 days of equity history peaking at 100k.
    const days = ["2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04", "2026-06-05", "2026-06-08"];
    const kv = makeKV({
      "phase-c:equity-samples": JSON.stringify(days.map((day) => ({ day, equity: 100000 }))),
    });
    const env = { KV_TIMED: kv };
    const state = await evaluatePortfolioRisk(env, baseArgs({ realizedPnl: -8000 })); // equity 92k → 8% DD
    expect(state.dd_pct).toBeGreaterThanOrEqual(8);
    expect(state.dd_trip).toBe(true);
    expect(state.block_new_entries).toBe(false); // shadow
    expect(state.block_reason).toBeNull();
  });

  it("blocks entries when DD trips AND portfolio_dd_breaker_enabled=true", async () => {
    const days = ["2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04", "2026-06-05", "2026-06-08"];
    const kv = makeKV({
      "phase-c:equity-samples": JSON.stringify(days.map((day) => ({ day, equity: 100000 }))),
    });
    const env = { KV_TIMED: kv };
    const state = await evaluatePortfolioRisk(env, baseArgs({
      realizedPnl: -8000,
      daCfg: { portfolio_dd_breaker_enabled: "true" },
    }));
    expect(state.block_new_entries).toBe(true);
    expect(state.block_reason).toMatch(/^portfolio_dd_/);
    // …and the state round-trips through KV for the scoring preload.
    const read = await readPortfolioRisk(kv);
    expect(read.block_new_entries).toBe(true);
  });

  it("trips the capital budget when deployed notional exceeds the threshold", async () => {
    const env = { KV_TIMED: makeKV() };
    // 100k equity, 120k deployed → 120% > default 100%
    const open = [{ ticker: "NVDA", direction: "LONG", shares: 100, entry_price: 1200 }];
    const prices = { NVDA: { p: 1200 } };
    const shadow = await evaluatePortfolioRisk(env, baseArgs({ openRows: open, priceMap: prices }));
    expect(shadow.budget_trip).toBe(true);
    expect(shadow.block_new_entries).toBe(false);

    const enforced = await evaluatePortfolioRisk(env, baseArgs({
      openRows: open, priceMap: prices,
      daCfg: { portfolio_risk_budget_enabled: "true" },
    }));
    expect(enforced.block_new_entries).toBe(true);
    expect(enforced.block_reason).toMatch(/^capital_budget_/);
  });

  it("stays quiet on a healthy book", async () => {
    const env = { KV_TIMED: makeKV() };
    const state = await evaluatePortfolioRisk(env, baseArgs({
      openRows: [{ ticker: "AAPL", direction: "LONG", shares: 10, entry_price: 100 }],
      priceMap: { AAPL: { p: 105 } },
      realizedPnl: 2000,
    }));
    expect(state.dd_trip).toBe(false);
    expect(state.budget_trip).toBe(false);
    expect(state.block_new_entries).toBe(false);
  });
});

describe("evaluateRegimeShockDerisk — S4 shadow advisory", () => {
  const state = { dd_pct: 4.2, dd_threshold_pct: 5, equity_samples: 12 };
  const openRows = [
    { ticker: "AAA", trade_id: "a", direction: "LONG", entry_price: 100 },
    { ticker: "BBB", trade_id: "b", direction: "LONG", entry_price: 100 },
    { ticker: "CCC", trade_id: "c", direction: "SHORT", entry_price: 100 },
    { ticker: "DDD", trade_id: "d", direction: "LONG", entry_price: 100 },
  ];
  const priceMap = { AAA: { p: 97 }, BBB: { p: 104 }, CCC: { p: 95 }, DDD: { p: 101 } };

  it("stays inactive without the index watch, and without DD proximity", () => {
    const noWatch = evaluateRegimeShockDerisk({ state, indexWatch: { active: false }, openRows, priceMap });
    expect(noWatch.active).toBe(false);
    const farFromDd = evaluateRegimeShockDerisk({
      state: { ...state, dd_pct: 1.0 },
      indexWatch: { active: true, breadth: 4 },
      openRows, priceMap,
    });
    expect(farFromDd.active).toBe(false);
    expect(farFromDd.watch_active).toBe(true);
  });

  it("names the weakest quartile (ascending pnl) when watch + DD proximity align", () => {
    const out = evaluateRegimeShockDerisk({
      state, indexWatch: { active: true, breadth: 4 }, openRows, priceMap,
    });
    expect(out.active).toBe(true);
    expect(out.targets).toHaveLength(1); // ceil(4/4)
    expect(out.targets[0].ticker).toBe("AAA"); // -3% is the weakest
    expect(out.targets[0].suggested_trim_pct).toBe(0.25);
    expect(out.headline).toContain("REGIME-SHOCK DE-RISK");
  });

  it("requires >=5 equity samples (fresh ring must not trip)", () => {
    const out = evaluateRegimeShockDerisk({
      state: { ...state, equity_samples: 2 },
      indexWatch: { active: true, breadth: 4 },
      openRows, priceMap,
    });
    expect(out.active).toBe(false);
  });
});
