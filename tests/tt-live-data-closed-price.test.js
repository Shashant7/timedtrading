// @vitest-environment jsdom

import { describe, it, expect, beforeAll } from "vitest";
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
});
