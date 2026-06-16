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
});
