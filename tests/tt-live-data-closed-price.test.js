// @vitest-environment jsdom

import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

function loadLiveData() {
  globalThis.React = {
    useEffect: () => {},
    useRef: (v) => ({ current: v }),
    useState: (v) => [v, () => {}],
    useCallback: (fn) => fn,
  };
  const priceSrc = readFileSync(join(process.cwd(), "react-app/shared-price-utils.js"), "utf8");
  // eslint-disable-next-line no-eval
  eval(priceSrc);
  const src = readFileSync(join(process.cwd(), "react-app/tt-live-data.js"), "utf8");
  // eslint-disable-next-line no-eval
  eval(src);
  return globalThis.TimedPriceUtils;
}

describe("applyPriceFeedOverlay closed-market hardening", () => {
  let overlay;

  beforeAll(() => {
    loadLiveData();
    overlay = globalThis.TimedPriceUtils.applyPriceFeedOverlay;
  });

  const existing = {
    ticker: "NVDA",
    close: 140.0,
    price: 140.0,
    _live_price: 140.0,
    _ah_price: 141.5,
    _ah_change_pct: 1.07,
    _ah_change: 1.5,
  };

  it("KV poll: p=RTH close + ahp=EXT updates both headline and EXT", () => {
    const out = overlay(existing, { p: 140.0, ahp: 142.0, ahdc: 2.0, ahdp: 1.43 }, false);
    expect(out.price).toBe(140.0);
    expect(out.close).toBe(140.0);
    expect(out._live_price).toBe(140.0);
    expect(out._ah_price).toBe(142.0);
    expect(out._ah_change_pct).toBeCloseTo(1.43, 2);
  });

  it("WS tick without ahp: last=EXT keeps RTH headline and refreshes EXT", () => {
    const out = overlay(existing, { p: 141.8, session: "PRE" }, false);
    expect(out.price).toBe(140.0);
    expect(out.close).toBe(140.0);
    expect(out._live_price).toBe(140.0);
    expect(out._ah_price).toBe(141.8);
    expect(out._ah_change_pct).toBeCloseTo(((141.8 - 140.0) / 140.0) * 100, 1);
  });

  it("WS tick without ahp does not wipe EXT when last matches RTH close", () => {
    const out = overlay(existing, { p: 140.0 }, false);
    expect(out.price).toBe(140.0);
    expect(out._ah_price).toBeUndefined();
  });

  it("RTH open: headline follows live tick", () => {
    const out = overlay(existing, { p: 143.2 }, true);
    expect(out.price).toBe(143.2);
    expect(out._live_price).toBe(143.2);
    expect(out.close).toBeUndefined();
  });

  it("KV poll without ahp still updates poisoned close to authoritative p", () => {
    const poisoned = {
      ticker: "QQQ",
      close: 703.45,
      price: 703.45,
      _live_price: 703.45,
      prev_close: 722.82,
      _ah_price: 703.60,
    };
    const out = overlay(poisoned, { p: 722.82, pc: 722.82, dc: -1.2, dp: -0.17 }, false);
    expect(out.price).toBe(722.82);
    expect(out.close).toBe(722.82);
    expect(out._live_price).toBe(722.82);
    expect(out._rth_session_close).toBe(722.82);
  });

  it("WS PRE tick keeps _rth_session_close anchor and refreshes EXT", () => {
    const qqq = {
      ticker: "QQQ",
      close: 722.82,
      price: 722.82,
      _live_price: 722.82,
      _rth_session_close: 722.82,
      prev_close: 709.43,
      _live_prev_close: 709.43,
    };
    const out = overlay(qqq, { p: 703.45, session: "PRE", ahChgPct: -2.68 }, false);
    expect(out.price).toBe(722.82);
    expect(out._rth_session_close).toBe(722.82);
    expect(out._ah_price).toBe(703.45);
  });
});

describe("getHeadlinePrice pre-market session close anchor", () => {
  let utils;

  beforeAll(() => {
    loadLiveData();
    utils = globalThis.TimedPriceUtils;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockPreMarketJuly8() {
    vi.spyOn(Date.prototype, "toLocaleString").mockImplementation(function (loc, opts) {
      if (opts && opts.timeZone === "America/New_York") {
        return "7/8/2026, 08:27:00";
      }
      return "7/8/2026, 08:27:00";
    });
  }

  it("uses _rth_session_close (timed:prices p), not stale pc/prev_close (QQQ Jul 8)", () => {
    mockPreMarketJuly8();
    const px = utils.getHeadlinePrice({
      ticker: "QQQ",
      close: 703.45,
      price: 703.45,
      _live_price: 703.45,
      _rth_session_close: 722.82,
      prev_close: 709.43,
      _live_prev_close: 709.43,
      _ah_price: 703.60,
      _ah_change_pct: 0.02,
      _price_updated_at: Date.now() - 60 * 1000,
      _price_value_ts: Date.now() - 60 * 1000,
    });
    expect(px).toBeCloseTo(722.82, 2);
    expect(px).not.toBeCloseTo(709.43, 2);
  });
});
