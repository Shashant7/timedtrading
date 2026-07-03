// @vitest-environment jsdom
//
// A7 (2026-07-03 stabilization plan) — SESSION-MATRIX ANCHOR CONTRACT.
//
// For every session state the market can be in, the three anchor resolvers
// must pick the correct reference:
//   getHeadlinePrice — RTH: live tick; otherwise: today's RTH close
//   getDailyChange   — always vs prev close, session-aware staleness
//   getExtChange     — only outside RTH, vs today's RTH close
//
// Existing tests (tests/shared-price-utils-ext.test.js) pin specific bug
// classes (GS zombie, MU stale ahdp, split heals). This suite pins the
// SESSION dimension exhaustively: RTH, pre-market, after-hours, weekend,
// full holiday during would-be RTH hours, and the early-close afternoon.

import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

function loadPriceUtils() {
  const src = readFileSync(join(process.cwd(), "react-app/shared-price-utils.js"), "utf8");
  // eslint-disable-next-line no-eval
  eval(src);
  return globalThis.TimedPriceUtils;
}

// getNyClock parses `new Date().toLocaleString("en-US", { timeZone: "America/New_York" })`
// → "M/D/YYYY, HH:MM:SS". Each matrix row mocks that string.
function mockNyClock(str) {
  vi.spyOn(Date.prototype, "toLocaleString").mockImplementation(function (loc, opts) {
    if (opts && opts.timeZone === "America/New_York") return str;
    return str;
  });
}

function freshTicker(extra = {}) {
  const ts = Date.now() - 60 * 1000;
  return {
    ticker: "SPY",
    price: 600.0,          // today's RTH close in the snapshot
    close: 600.0,
    _live_price: 601.5,    // live tick during RTH
    prev_close: 594.0,
    _live_prev_close: 594.0,
    _price_updated_at: ts,
    _price_value_ts: ts,
    _quote_receipt_ts: ts,
    scored_at: ts,
    ...extra,
  };
}

// Outside RTH the pipeline contract locks `p` to the RTH close and the
// frontend merge writes price/close/_live_price from it (see
// .cursor/rules/price-data-pipeline.mdc "Outside RTH client merge") —
// extended prints ride ONLY on the _ah_* / extended_* fields.
function oohTicker(extra = {}) {
  return freshTicker({ _live_price: 600.0, ...extra });
}

const SESSIONS = {
  rth: { clock: "7/6/2026, 11:00:00", open: true, label: "RTH (Mon 2026-07-06 11:00 ET)" },
  preMarket: { clock: "7/6/2026, 08:00:00", open: false, label: "pre-market (Mon 08:00 ET)" },
  afterHours: { clock: "7/6/2026, 17:30:00", open: false, label: "after-hours (Mon 17:30 ET)" },
  weekend: { clock: "7/5/2026, 12:00:00", open: false, label: "weekend (Sun 12:00 ET)" },
  holidayRthHours: { clock: "7/3/2026, 11:00:00", open: false, label: "holiday during would-be RTH (Fri Jul 3 11:00 ET)" },
  earlyCloseAfternoon: { clock: "11/27/2026, 13:30:00", open: false, label: "early-close afternoon (Fri Nov 27 13:30 ET)" },
  earlyCloseMorning: { clock: "11/27/2026, 11:00:00", open: true, label: "early-close morning (Fri Nov 27 11:00 ET)" },
};

let utils;
beforeAll(() => { utils = loadPriceUtils(); });
afterEach(() => { vi.restoreAllMocks(); });

describe("session detection matrix", () => {
  for (const [, s] of Object.entries(SESSIONS)) {
    it(`${s.label} → market ${s.open ? "OPEN" : "CLOSED"}`, () => {
      mockNyClock(s.clock);
      expect(utils.isNyRegularMarketOpen()).toBe(s.open);
    });
  }
});

describe("getHeadlinePrice anchors", () => {
  it("RTH: fresh live tick wins over the snapshot close", () => {
    mockNyClock(SESSIONS.rth.clock);
    expect(utils.getHeadlinePrice(freshTicker())).toBe(601.5);
  });

  for (const key of ["preMarket", "afterHours", "weekend", "holidayRthHours", "earlyCloseAfternoon"]) {
    it(`${SESSIONS[key].label}: today's RTH close, never the extended print`, () => {
      mockNyClock(SESSIONS[key].clock);
      // _live_price may carry an extended print outside RTH — headline must
      // stay on the locked RTH close.
      expect(utils.getHeadlinePrice(freshTicker())).toBe(600.0);
    });
  }
});

describe("getDailyChange anchors (always vs prev close)", () => {
  it("RTH: live price vs prev close, marketOpen=true", () => {
    mockNyClock(SESSIONS.rth.clock);
    const dc = utils.getDailyChange(freshTicker());
    expect(dc.marketOpen).toBe(true);
    expect(dc.dayChg).toBeCloseTo(601.5 - 594.0, 2);
    expect(dc.dayPct).toBeCloseTo(((601.5 - 594.0) / 594.0) * 100, 1);
  });

  for (const key of ["afterHours", "weekend", "holidayRthHours"]) {
    it(`${SESSIONS[key].label}: RTH close vs prev close, marketOpen=false`, () => {
      mockNyClock(SESSIONS[key].clock);
      const dc = utils.getDailyChange(freshTicker());
      expect(dc.marketOpen).toBe(false);
      expect(dc.dayChg).toBeCloseTo(600.0 - 594.0, 2);
      expect(dc.dayPct).toBeCloseTo(((600.0 - 594.0) / 594.0) * 100, 1);
    });
  }
});

describe("getExtChange session gating (EXT row anchor = today's RTH close)", () => {
  const withAh = () => oohTicker({ _ah_price: 603.0, _ah_change_pct: 0.5, _ah_change: 3.0 });

  it("RTH: always suppressed", () => {
    mockNyClock(SESSIONS.rth.clock);
    expect(utils.getExtChange(withAh())).toBeNull();
  });

  it("early-close morning (still open): suppressed", () => {
    mockNyClock(SESSIONS.earlyCloseMorning.clock);
    expect(utils.getExtChange(withAh())).toBeNull();
  });

  for (const key of ["preMarket", "afterHours", "holidayRthHours", "earlyCloseAfternoon"]) {
    it(`${SESSIONS[key].label}: EXT derived from print vs RTH close`, () => {
      mockNyClock(SESSIONS[key].clock);
      const ext = utils.getExtChange(withAh());
      expect(ext).not.toBeNull();
      expect(ext.price).toBe(603.0);
      expect(ext.pct).toBeCloseTo(((603.0 - 600.0) / 600.0) * 100, 1);
    });
  }

  it("crypto never shows an EXT row (24/7 market)", () => {
    mockNyClock(SESSIONS.afterHours.clock);
    expect(utils.getExtChange(freshTicker({ ticker: "BTCUSD", _ah_price: 603.0 }))).toBeNull();
  });
});

describe("price-feed freshness window follows the session", () => {
  it("RTH: 10-minute receipt window (30-min-old quote is NOT fresh)", () => {
    mockNyClock(SESSIONS.rth.clock);
    const old = Date.now() - 30 * 60 * 1000;
    expect(utils.isPriceFeedFresh({ _quote_receipt_ts: old })).toBe(false);
  });

  it("holiday: relaxed 26h window (30-min-old quote IS fresh)", () => {
    // Pre-fix, the holiday counted as RTH → every quote failed the 10-min
    // window → the whole UI rendered stale-flagged on Jul 3.
    mockNyClock(SESSIONS.holidayRthHours.clock);
    const old = Date.now() - 30 * 60 * 1000;
    expect(utils.isPriceFeedFresh({ _quote_receipt_ts: old })).toBe(true);
  });
});
