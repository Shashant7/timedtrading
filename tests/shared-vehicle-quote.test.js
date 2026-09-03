// @vitest-environment jsdom

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

function loadVehicleQuote() {
  const src = readFileSync(join(process.cwd(), "react-app/shared-vehicle-quote.js"), "utf8");
  // eslint-disable-next-line no-eval
  eval(src);
  return globalThis.TimedVehicleQuote;
}

describe("TimedVehicleQuote", () => {
  let VQ;

  beforeAll(() => {
    VQ = loadVehicleQuote();
  });

  const qqqCall = {
    instrument: "option",
    _paper_lane: "index_day_trade",
    _vehicle_label: "QQQ 722C Sep 4",
    direction: "LONG",
    entry_premium: 1.09,
    entry_price: 1.09,
    last_premium: 1.33,
    mark_price: 1.33,
    current_price: 1.33,
    stop_premium: 0.55,
    sl: 0.55,
    trim_premium: 1.64,
    exit_premium: 2.18,
    tp: 2.18,
    tpArray: [1.64, 2.18],
  };

  it("detects option vehicles from paper lane and contract chip", () => {
    expect(VQ.isOptionVehicle({ _paper_lane: "index_day_trade" }, null)).toBe(true);
    expect(VQ.isOptionVehicle({ _vehicle_label: "SPY 777C Sep 4" }, { instrument: "option" })).toBe(true);
    expect(VQ.isOptionVehicle({ ticker: "QQQ" }, { instrument: "letf" })).toBe(false);
  });

  it("quotes live premium, not the underlying", () => {
    const q = VQ.optionQuote({ ticker: "QQQ", price: 572.4, close: 570.1 }, qqqCall);
    expect(q.price).toBeCloseTo(1.33, 2);
    expect(q.dayPct).toBeCloseTo(((1.33 - 1.09) / 1.09) * 100, 2);
    expect(q.extLine).toBeNull();
    expect(q.kind).toBe("option");
  });

  it("moves the POSITION dot with live premium vs entry and targets", () => {
    const bar = VQ.optionProgressBar(qqqCall, 1.33);
    expect(bar).toBeTruthy();
    expect(bar.ep).toBeCloseTo(1.09, 2);
    expect(bar.pnlPct).toBeGreaterThan(20);
    expect(bar.curX).toBeGreaterThan(bar.xPct(1.09));
    expect(bar.curX).toBeLessThan(bar.xPct(1.64));
    const labels = bar.ticks.map((t) => t.label);
    expect(labels).toContain("E");
    expect(labels).toContain("SL");
    expect(labels).toContain("T1");
    expect(labels).toContain("T2");
  });

  it("drops underlying SL/TP leaked onto a premium book", () => {
    const bar = VQ.optionProgressBar({
      ...qqqCall,
      sl: 548.2,
      tp: 590,
      tpArray: [590],
      stop_premium: 0.55,
      trim_premium: 1.64,
      exit_premium: 2.18,
    }, 1.33);
    expect(bar.ticks.every((t) => t.px < 10)).toBe(true);
    expect(bar.ticks.some((t) => t.label === "T1")).toBe(true);
  });

  it("treats puts as long premium (mark up is a gain)", () => {
    const put = {
      ...qqqCall,
      direction: "SHORT",
      flavor: "put",
      _vehicle_label: "QQQ 700P Sep 4",
      mark_price: 1.40,
      last_premium: 1.40,
    };
    const q = VQ.optionQuote({ ticker: "QQQ" }, put);
    expect(q.dayPct).toBeGreaterThan(0);
    const bar = VQ.optionProgressBar(put, 1.40);
    expect(bar.pnlPct).toBeGreaterThan(0);
    expect(bar.ticks.some((t) => t.label.startsWith("T"))).toBe(true);
  });

  it("prefers the paper book over an equity row for the same underlying", () => {
    const paper = { ...qqqCall };
    const equity = { ticker: "QQQ", entry_price: 548, instrument: "equity" };
    const picked = VQ.pickOpenTrade({ _paper_lane: "index_day_trade", _openTrade: paper }, equity);
    expect(picked).toBe(paper);
  });
});
