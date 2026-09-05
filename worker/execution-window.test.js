import { describe, it, expect } from "vitest";
import { shareLaneExecutionWindow, peakGivebackFloor } from "./execution-window.js";
import { classifyIndexTrendPaperEvent } from "./index-trend-paper.js";

// 2026-09-04 is a Friday (EDT, UTC-4).
const ET = (h, m) => Date.UTC(2026, 8, 4, h + 4, m, 0);

describe("shareLaneExecutionWindow", () => {
  it("blocks entries on the open print and after 15:30, allows mid-session", () => {
    expect(shareLaneExecutionWindow(ET(9, 30)).can_enter).toBe(false);
    expect(shareLaneExecutionWindow(ET(9, 44)).can_enter).toBe(false);
    expect(shareLaneExecutionWindow(ET(9, 45)).can_enter).toBe(true);
    expect(shareLaneExecutionWindow(ET(15, 29)).can_enter).toBe(true);
    expect(shareLaneExecutionWindow(ET(15, 30)).can_enter).toBe(false);
  });

  it("profit management is RTH only (not 09:30, not 19:01)", () => {
    expect(shareLaneExecutionWindow(ET(9, 30)).can_reduce).toBe(false);
    expect(shareLaneExecutionWindow(ET(9, 31)).can_reduce).toBe(true);
    expect(shareLaneExecutionWindow(ET(15, 59)).can_reduce).toBe(true);
    const w = shareLaneExecutionWindow(ET(19, 1));
    expect(w.can_reduce).toBe(false);
    expect(w.blocked_reason).toBe("broker_closed");
    expect(shareLaneExecutionWindow(ET(17, 0)).blocked_reason).toBe("outside_rth");
  });

  it("hard stops follow the broker window (PM through 19:00 ET)", () => {
    expect(shareLaneExecutionWindow(ET(4, 0)).can_stop).toBe(true);
    expect(shareLaneExecutionWindow(ET(18, 59)).can_stop).toBe(true);
    expect(shareLaneExecutionWindow(ET(19, 0)).can_stop).toBe(false);
    expect(shareLaneExecutionWindow(ET(3, 59)).can_stop).toBe(false);
  });

  it("ratchet bookkeeping only on RTH prints", () => {
    expect(shareLaneExecutionWindow(ET(12, 0)).can_ratchet).toBe(true);
    expect(shareLaneExecutionWindow(ET(16, 30)).can_ratchet).toBe(false);
  });

  it("weekend is fully closed", () => {
    const sat = Date.UTC(2026, 8, 5, 16, 0, 0);
    const w = shareLaneExecutionWindow(sat);
    expect(w.can_enter).toBe(false);
    expect(w.can_reduce).toBe(false);
    expect(w.can_stop).toBe(false);
  });
});

describe("peakGivebackFloor", () => {
  it("earns protection at +1R and tightens with the peak", () => {
    expect(peakGivebackFloor(0.9)).toBeNull();
    expect(peakGivebackFloor(1.0)).toBe(0.2);
    expect(peakGivebackFloor(1.5)).toBe(0.75);
    expect(peakGivebackFloor(2.0)).toBe(1.2);
    expect(peakGivebackFloor(3.0)).toBe(2.1);
  });
});

describe("index-trend lane obeys the share execution window", () => {
  // UDOW W36 fixture: DIA entry 455.20, stop 448.40 (1R = 6.80).
  const mgmt = {
    stop_underlying: 448.4,
    target_underlying: 475,
    trim_ladder: [
      { at_r: 1, size: 0.25 },
      { at_r: 2, size: 0.25 },
      { trail_remainder: true },
    ],
  };
  const book = {
    status: "trimmed",
    direction: "LONG",
    entry_underlying_price: 455.2,
    entry_letf_price: 71.96,
    stop_underlying: 448.4,
    shares: 27,
    shares_remaining: 20,
    trims_fired: [1],
    peak_underlying_r: 1.5,
  };

  it("does not BUY on the 09:30 open print", () => {
    const d = classifyIndexTrendPaperEvent({
      book: null, letfPrice: 71.96, underlyingPrice: 455.2, management: mgmt,
      direction: "LONG", activate: true, now: ET(9, 30), shares: 27,
    });
    expect(d.event).toBeNull();
    expect(d.reason).toMatch(/^entry_window:/);
    const ok = classifyIndexTrendPaperEvent({
      book: null, letfPrice: 71.96, underlyingPrice: 455.2, management: mgmt,
      direction: "LONG", activate: true, now: ET(9, 50), shares: 27,
    });
    expect(ok.event).toBe("BUY");
  });

  it("does not close a trail EXIT at 7:01 PM ET; keeps the book open", () => {
    // r = (458.9 - 455.2) / 6.8 = 0.54 — under the 0.75 floor for peak 1.5.
    const d = classifyIndexTrendPaperEvent({
      book, letfPrice: 73.25, underlyingPrice: 458.9, management: mgmt,
      direction: "LONG", activate: false, now: ET(19, 1),
    });
    expect(d.event).toBeNull();
    expect(d.nextBook.status).toBe("trimmed");
    expect(d.reason).toMatch(/^reduce_window:/);
  });

  it("fires the same giveback EXIT on the first RTH tick after 09:30", () => {
    const d = classifyIndexTrendPaperEvent({
      book, letfPrice: 73.25, underlyingPrice: 458.9, management: mgmt,
      direction: "LONG", activate: false, now: ET(9, 31),
    });
    expect(d.event).toBe("EXIT");
    expect(d.reason).toBe("trail_giveback");
    expect(d.nextBook.giveback_floor_r).toBe(0.75);
  });

  it("protects a +1R winner from going red even before the +2R trim", () => {
    const b = { ...book, peak_underlying_r: 1.1, trims_fired: [1] };
    // r = 0.1 < 0.2 floor
    const d = classifyIndexTrendPaperEvent({
      book: b, letfPrice: 72.2, underlyingPrice: 455.88, management: mgmt,
      direction: "LONG", activate: false, now: ET(11, 0),
    });
    expect(d.event).toBe("EXIT");
    expect(d.reason).toBe("trail_giveback");
  });

  it("does not arm the peak on an after-hours spike", () => {
    const b = { ...book, peak_underlying_r: 1.0 };
    const d = classifyIndexTrendPaperEvent({
      book: b, letfPrice: 76, underlyingPrice: 470, management: mgmt,
      direction: "LONG", activate: false, now: ET(17, 30),
    });
    expect(d.event).toBeNull();
    expect(d.nextBook.peak_underlying_r).toBe(1.0);
  });

  it("defers a hard stop past 19:00 ET but fires it at 16:30 ET", () => {
    const late = classifyIndexTrendPaperEvent({
      book, letfPrice: 69, underlyingPrice: 447, management: mgmt,
      direction: "LONG", activate: false, now: ET(19, 30),
    });
    expect(late.event).toBeNull();
    expect(late.reason).toMatch(/^stop_deferred:/);
    const ah = classifyIndexTrendPaperEvent({
      book, letfPrice: 69, underlyingPrice: 447, management: mgmt,
      direction: "LONG", activate: false, now: ET(16, 30),
    });
    expect(ah.event).toBe("STOP");
  });
});
