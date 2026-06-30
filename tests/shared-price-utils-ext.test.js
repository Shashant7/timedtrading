// @vitest-environment jsdom

import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

function loadPriceUtils() {
  const src = readFileSync(join(process.cwd(), "react-app/shared-price-utils.js"), "utf8");
  // eslint-disable-next-line no-eval
  eval(src);
  return globalThis.TimedPriceUtils;
}

describe("getExtChange", () => {
  let utils;

  beforeAll(() => {
    utils = loadPriceUtils();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockMarketClosed() {
    vi.spyOn(Date.prototype, "toLocaleString").mockImplementation(function (loc, opts) {
      if (opts && opts.timeZone === "America/New_York") {
        return "6/14/2026, 20:30:00";
      }
      return "6/14/2026, 20:30:00";
    });
  }

  it("derives negative EXT pct when extended price is below RTH close (GS case)", () => {
    mockMarketClosed();
    const ext = utils.getExtChange({
      ticker: "GS",
      close: 1090.67,
      price: 1090.67,
      _ah_price: 1083.27,
      _ah_change_pct: 0.66,
      _ah_change: 7.18,
    });
    expect(ext).not.toBeNull();
    expect(ext.price).toBe(1083.27);
    expect(ext.pct).toBeLessThan(0);
    expect(ext.pct).toBeCloseTo(-0.68, 1);
  });

  it("hides EXT line when extended price equals RTH close but ahdp is stale (MU case)", () => {
    mockMarketClosed();
    const ext = utils.getExtChange({
      ticker: "MU",
      close: 1033.90,
      price: 1033.90,
      _ah_price: 1033.90,
      _ah_change_pct: 1.32,
    });
    expect(ext).toBeNull();
  });

  it("uses cached ahdp when no distinct extended price is available", () => {
    mockMarketClosed();
    const ext = utils.getExtChange({
      ticker: "SPY",
      close: 600.0,
      price: 600.0,
      _ah_change_pct: 0.25,
    });
    expect(ext).not.toBeNull();
    expect(ext.pct).toBeCloseTo(0.25, 2);
    expect(ext.price).toBeCloseTo(601.5, 1);
  });

  it("derives negative EXT pct when snapshot price is stale but _live_price has RTH close (GS feed merge)", () => {
    mockMarketClosed();
    const ext = utils.getExtChange({
      ticker: "GS",
      price: 1076.17,
      _live_price: 1090.67,
      _live_prev_close: 1076.17,
      prev_close: 1076.17,
      _ah_price: 1083.27,
      _ah_change_pct: 0.66,
      _ah_change: 7.1,
    });
    expect(ext).not.toBeNull();
    expect(ext.pct).toBeLessThan(0);
    expect(ext.pct).toBeCloseTo(-0.68, 1);
    expect(ext.chg).toBeCloseTo(-7.4, 1);
  });

  it("hides EXT when ahdp mirrors RTH day change without a distinct extended print (GS +6.84% bleed)", () => {
    mockMarketClosed();
    const ext = utils.getExtChange({
      ticker: "GS",
      close: 1090.67,
      price: 1090.67,
      _live_price: 1090.67,
      prev_close: 1020.0,
      _live_prev_close: 1020.0,
      day_change_pct: 6.84,
      change_pct: 6.84,
      _ah_change_pct: 6.84,
    });
    expect(ext).toBeNull();
  });

  it("uses derived RTH close when snapshot close equals prev_close but day pct reflects today", () => {
    mockMarketClosed();
    const ext = utils.getExtChange({
      ticker: "GS",
      close: 1020.0,
      price: 1020.0,
      prev_close: 1020.0,
      day_change_pct: 6.84,
      _ah_price: 1090.67,
      _ah_change_pct: 6.84,
    });
    expect(ext).not.toBeNull();
    expect(Math.abs(ext.pct)).toBeLessThan(0.2);
  });
});

describe("getBubbleFillChange", () => {
  let utils;

  beforeAll(() => {
    utils = loadPriceUtils();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockMarketClosed() {
    vi.spyOn(Date.prototype, "toLocaleString").mockImplementation(function (loc, opts) {
      if (opts && opts.timeZone === "America/New_York") {
        return "6/14/2026, 20:30:00";
      }
      return "6/14/2026, 20:30:00";
    });
  }

  function mockMarketOpen() {
    vi.spyOn(Date.prototype, "toLocaleString").mockImplementation(function (loc, opts) {
      if (opts && opts.timeZone === "America/New_York") {
        return "6/14/2026, 11:00:00";
      }
      return "6/14/2026, 11:00:00";
    });
  }

  it("uses EXT pct for bubble fill outside RTH when extended price differs", () => {
    mockMarketClosed();
    const fill = utils.getBubbleFillChange({
      ticker: "SPY",
      close: 600.0,
      price: 600.0,
      _ah_price: 606.0,
      _ah_change_pct: 1.0,
    });
    expect(fill.source).toBe("ext");
    expect(fill.hasData).toBe(true);
    expect(fill.pct).toBeCloseTo(1.0, 2);
  });

  it("uses RTH daily change during regular session", () => {
    mockMarketOpen();
    const fill = utils.getBubbleFillChange({
      ticker: "SPY",
      price: 602.0,
      _live_price: 602.0,
      _live_prev_close: 600.0,
      prev_close: 600.0,
    });
    expect(fill.source).toBe("rth");
    expect(fill.hasData).toBe(true);
    expect(fill.pct).toBeCloseTo(0.33, 1);
  });
});

describe("inferTraderPosture", () => {
  let utils;

  beforeAll(() => {
    utils = loadPriceUtils();
  });

  it("shows LEAN SHORT when swing consensus is bearish but state fallback is HTF bull", () => {
    const posture = utils.inferTraderPosture({
      ticker: "USO",
      state: "HTF_BULL_LTF_PULLBACK",
      htf_score: 0.9,
      ltf_score: -15,
      kanban_stage: "watch",
      __focus_conviction_score: 38,
      swing_consensus: {
        direction: null,
        bullish_count: 0,
        bearish_count: 5,
        avg_bias: -0.585,
      },
      confluence_verdict: {
        mode: "WAIT",
        side: "NEUTRAL",
      },
    });

    expect(posture.posture).toBe("LEAN_SHORT");
    expect(posture.label).toBe("Leaning bearish");
    expect(posture.direction).toBe("SHORT");
  });

  it("keeps actionable enter stages as confirmed bullish or bearish posture", () => {
    const posture = utils.inferTraderPosture({
      state: "HTF_BULL_LTF_BULL",
      kanban_stage: "enter",
      swing_consensus: {
        direction: "LONG",
        bullish_count: 4,
        bearish_count: 1,
        avg_bias: 0.44,
      },
    });

    expect(posture.posture).toBe("LONG");
    expect(posture.label).toBe("Bullish");
    expect(posture.strength).toBe("confirmed");
  });

  it("supports explicit open-position labels separately from price bias", () => {
    expect(utils.inferTraderPosture({ trader_posture: "OPEN_LONG" }).label).toBe("Open Long");
    expect(utils.inferTraderPosture({ trader_posture: "OPEN_SHORT" }).label).toBe("Open Short");
  });

  it("prefers Open Long when _openTrade is attached (MU trim lane)", () => {
    const posture = utils.inferTraderPosture({
      ticker: "MU",
      kanban_stage: "trim",
      swing_consensus: { direction: "LONG", avg_bias: 0.44 },
      _openTrade: { direction: "LONG", status: "OPEN", entry_price: 770 },
    });
    expect(posture.label).toBe("Open Long");
    expect(posture.strength).toBe("open");
  });

  it("does not treat closed ledger rows as open (INTC setup lane)", () => {
    expect(utils.isTradeOpen({ ticker: "INTC", status: "WIN", direction: "LONG" })).toBe(false);
    expect(utils.isTradeOpen({ ticker: "INTC", status: "OPEN", direction: "LONG", exit_ts: 1 })).toBe(false);
    expect(utils.isTradeOpen({ ticker: "BRK-B", direction: "LONG" })).toBe(false);
    const posture = utils.inferTraderPosture({
      ticker: "INTC",
      kanban_stage: "setup",
      swing_consensus: { direction: "LONG", avg_bias: 0.44 },
      _openTrade: { direction: "LONG", status: "WIN", entry_price: 22 },
    });
    expect(posture.label).not.toBe("Open Long");
    expect(posture.strength).not.toBe("open");
  });

  it("sanitizeTickerOpenPosture strips ghost OPEN labels on setup lane", () => {
    const clean = utils.sanitizeTickerOpenPosture({
      ticker: "BRK-B",
      kanban_stage: "setup",
      trader_posture: "OPEN_LONG",
      has_open_position: true,
      position_direction: "LONG",
    }, null);
    const posture = utils.inferTraderPosture(clean);
    expect(posture.label).not.toBe("Open Long");
    expect(clean.has_open_position).toBe(false);
  });
});
