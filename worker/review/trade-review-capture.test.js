import { describe, it, expect } from "vitest";
import {
  findBigMove,
  computeExcursions,
  computeCapture,
  computeEntryGeometry,
} from "./trade-review-capture.js";
import { extractLegs, reviewIdFor, parseReviewId } from "./trade-review-legs.js";
import { levelsAreCoherent } from "./trade-review-context.js";

const DAY = 86_400_000;
const bar = (ts, o, h, l, c) => ({ ts, o, h, l, c });

describe("findBigMove", () => {
  it("finds the dominant drawup for a long", () => {
    const bars = [
      bar(1, 100, 101, 99, 100),
      bar(2, 100, 102, 95, 96),   // the low anchor
      bar(3, 96, 110, 96, 109),   // runs to 110 → 15.8% off 95
      bar(4, 109, 111, 105, 106),
    ];
    const mv = findBigMove(bars, "LONG");
    expect(mv.from_price).toBe(95);
    expect(mv.to_price).toBe(111);
    expect(mv.pct).toBeCloseTo(16.84, 1);
  });

  it("mirrors for a short (largest drawdown)", () => {
    const bars = [
      bar(1, 100, 105, 99, 100),
      bar(2, 100, 106, 98, 99),
      bar(3, 99, 100, 90, 91),
    ];
    const mv = findBigMove(bars, "SHORT");
    expect(mv.from_price).toBe(106);
    expect(mv.to_price).toBe(90);
    expect(mv.pct).toBeCloseTo(15.09, 1);
  });

  it("returns null without enough bars or without a positive swing", () => {
    expect(findBigMove([bar(1, 1, 1, 1, 1)], "LONG")).toBeNull();
    expect(findBigMove([], "LONG")).toBeNull();
  });
});

describe("computeExcursions", () => {
  const bars = [
    bar(1, 100, 102, 96, 97),   // -4% heat first
    bar(2, 97, 108, 97, 107),   // +8% payoff
    bar(3, 107, 108, 101, 102),
  ];

  it("measures MFE, MAE and the heat taken before the payoff", () => {
    const e = computeExcursions(bars, 100, "LONG");
    expect(e.mfe_pct).toBe(8);
    expect(e.mae_pct).toBe(-4);
    expect(e.heat_before_payoff_pct).toBe(-4);
    expect(e.mfe_ts).toBe(2);
  });

  it("reports no heat when the trade never went against the position", () => {
    const clean = [bar(1, 100, 104, 100, 103), bar(2, 103, 110, 102, 109)];
    expect(computeExcursions(clean, 100, "LONG").heat_before_payoff_pct).toBe(0);
  });

  it("inverts for shorts", () => {
    const e = computeExcursions(bars, 100, "SHORT");
    expect(e.mfe_pct).toBe(4);   // price fell to 96
    expect(e.mae_pct).toBe(-8);  // price rose to 108
  });
});

describe("computeCapture — the HALO archetype", () => {
  // Operator case: entered 77.93, exited 81, tape ran past 100 afterwards.
  const trade = {
    direction: "LONG",
    entry_price: 78,
    entry_ts: 10 * DAY,
    exit_price: 81,
    exit_ts: 12 * DAY,
    exit_reason: "ST_FLIP",
    pnl: 300,
    shares: 100,
  };
  const bars = [
    bar(10 * DAY, 78, 80, 77, 79),
    bar(11 * DAY, 79, 84, 78, 83),   // MFE while open = +7.7%
    bar(12 * DAY, 83, 84, 80, 81),
    bar(13 * DAY, 81, 92, 81, 91),
    bar(14 * DAY, 91, 100, 90, 99),  // the move we left on the table
  ];

  const cap = computeCapture({ trade, bars, lookaheadDays: 10 });

  it("splits in-trade excursions from what happened after the exit", () => {
    expect(cap.mfe_pct).toBeCloseTo(7.69, 1);
    expect(cap.realized_pct).toBeCloseTo(3.85, 1);
    expect(cap.post_exit_pct).toBeCloseTo(23.46, 1);
    expect(cap.post_exit_extreme_ts).toBe(14 * DAY);
  });

  it("scores capture against both the in-trade MFE and the whole move", () => {
    expect(cap.capture_ratio).toBeCloseTo(0.5, 1);
    expect(cap.big_move.pct).toBeCloseTo(29.87, 1); // 77 → 100
    expect(cap.big_move_capture_ratio).toBeCloseTo(0.129, 2);
  });

  it("keeps the engine's stored excursions alongside the tape's", () => {
    const withStored = computeCapture({
      trade: { ...trade, max_favorable_excursion: 12.5 },
      bars,
    });
    expect(withStored.stored_mfe_pct).toBe(12.5);
    expect(withStored.mfe_pct).toBeCloseTo(7.69, 1);
  });

  it("handles an open trade (no exit) without inventing an exit", () => {
    const open = computeCapture({
      trade: { ...trade, exit_price: null, exit_ts: null, pnl: null },
      bars,
    });
    expect(open.exit).toBeNull();
    expect(open.realized_pct).toBeNull();
    expect(open.capture_ratio).toBeNull();
    expect(open.bars_in_trade).toBe(5);
  });
});

describe("computeEntryGeometry", () => {
  it("computes stop/target distance, R:R and where in the bar we filled", () => {
    const g = computeEntryGeometry({
      entryPrice: 100,
      stopLoss: 96,
      takeProfit: 112,
      direction: "LONG",
      entryBar: bar(1, 97, 101, 96, 100),
    });
    // Risk and reward are both expressed on the entry basis: 4% risk,
    // 12% reward, 3R.
    expect(g.sl_distance_pct).toBe(4);
    expect(g.tp_distance_pct).toBe(12);
    expect(g.rr).toBe(3);
    expect(g.entry_in_bar_range).toBe(0.8); // bought near the top of the bar
  });

  it("flips bar position for shorts (1.0 = sold the low)", () => {
    const g = computeEntryGeometry({
      entryPrice: 96.5,
      stopLoss: 101,
      takeProfit: 90,
      direction: "SHORT",
      entryBar: bar(1, 100, 101, 96, 96.5),
    });
    expect(g.entry_in_bar_range).toBe(0.9);
    expect(g.sl_distance_pct).toBeCloseTo(4.66, 1);
  });

  it("returns nulls rather than guessing when the stop is missing", () => {
    const g = computeEntryGeometry({ entryPrice: 100, direction: "LONG" });
    expect(g.sl_distance_pct).toBeNull();
    expect(g.rr).toBeNull();
  });
});

describe("levelsAreCoherent", () => {
  it("accepts a long with the stop below and target above the fill", () => {
    expect(levelsAreCoherent({ direction: "LONG", entryPrice: 100, stopLoss: 96, takeProfit: 112 })).toBe(true);
  });

  it("rejects a long whose stop sits above the fill", () => {
    // The XLI case: positions fallback attributed a later position's levels
    // (stop 185.66 on a 181.68 long) and produced a -0.27 R:R.
    expect(levelsAreCoherent({ direction: "LONG", entryPrice: 181.68, stopLoss: 185.66, takeProfit: 182.77 })).toBe(false);
  });

  it("mirrors the check for shorts", () => {
    expect(levelsAreCoherent({ direction: "SHORT", entryPrice: 100, stopLoss: 104, takeProfit: 92 })).toBe(true);
    expect(levelsAreCoherent({ direction: "SHORT", entryPrice: 100, stopLoss: 96, takeProfit: 92 })).toBe(false);
  });

  it("accepts a stop with no target and vice versa", () => {
    expect(levelsAreCoherent({ direction: "LONG", entryPrice: 100, stopLoss: 96 })).toBe(true);
    expect(levelsAreCoherent({ direction: "LONG", entryPrice: 100, takeProfit: 112 })).toBe(true);
  });

  it("rejects when nothing is known", () => {
    expect(levelsAreCoherent({ direction: "LONG", entryPrice: 100 })).toBe(false);
    expect(levelsAreCoherent({ direction: "LONG", stopLoss: 96 })).toBe(false);
  });
});

describe("extractLegs", () => {
  const trade = {
    trade_id: "T1",
    status: "WIN",
    entry_ts: 100,
    entry_price: 10,
    trim_ts: 200,
    trim_price: 11,
    trimmed_pct: 0.5,
    exit_ts: 300,
    exit_price: 12,
    exit_reason: "TP",
    pnl: 20,
  };

  it("prefers the trade_events ledger", () => {
    const legs = extractLegs(trade, [
      { event_id: "e1", type: "ENTRY", ts: 100, price: 10, qty_pct_delta: 100 },
      { event_id: "e2", type: "TRIM", ts: 200, price: 11, qty_pct_delta: 50 },
      { event_id: "e3", type: "EXIT", ts: 300, price: 12, pnl_realized: 20 },
    ]);
    expect(legs.map((l) => l.leg_kind)).toEqual(["ENTRY", "TRIM", "EXIT"]);
    expect(legs.every((l) => l.synthesized === false)).toBe(true);
    expect(legs[1].qty_pct).toBe(50);
  });

  it("synthesizes legs from the trade row when events are missing", () => {
    const legs = extractLegs(trade, []);
    expect(legs.map((l) => l.leg_kind)).toEqual(["ENTRY", "TRIM", "EXIT"]);
    expect(legs.every((l) => l.synthesized === true)).toBe(true);
    // trimmed_pct stored as a fraction must surface as a percent
    expect(legs[1].qty_pct).toBe(50);
  });

  it("appends a synthesized exit when the event ledger lost it", () => {
    const legs = extractLegs(trade, [
      { event_id: "e1", type: "ENTRY", ts: 100, price: 10 },
    ]);
    expect(legs.map((l) => l.leg_kind)).toEqual(["ENTRY", "EXIT"]);
    expect(legs[1].synthesized).toBe(true);
    expect(legs[1].price).toBe(12);
  });

  it("does not fabricate an exit for an open trade", () => {
    const legs = extractLegs(
      { ...trade, status: "OPEN", exit_ts: null, exit_price: null },
      [{ event_id: "e1", type: "ENTRY", ts: 100, price: 10 }],
    );
    expect(legs.map((l) => l.leg_kind)).toEqual(["ENTRY"]);
  });

  it("numbers repeated trims so each gets its own review", () => {
    const legs = extractLegs(trade, [
      { event_id: "e1", type: "ENTRY", ts: 100, price: 10 },
      { event_id: "e2", type: "TRIM", ts: 200, price: 11 },
      { event_id: "e3", type: "TRIM", ts: 250, price: 11.5 },
      { event_id: "e4", type: "EXIT", ts: 300, price: 12 },
    ]);
    const trims = legs.filter((l) => l.leg_kind === "TRIM");
    expect(trims.map((t) => t.leg_seq)).toEqual([0, 1]);
  });

  it("folds scale-ins into the entry family, sequenced", () => {
    const legs = extractLegs(trade, [
      { event_id: "e1", type: "ENTRY", ts: 100, price: 10 },
      { event_id: "e2", type: "SCALE_IN", ts: 150, price: 10.5 },
    ]);
    const entries = legs.filter((l) => l.leg_kind === "ENTRY");
    expect(entries.map((e) => e.leg_seq)).toEqual([0, 1]);
    expect(entries[1].is_scale_in).toBe(true);
  });
});

describe("reviewIdFor / parseReviewId", () => {
  it("round-trips, including trade ids that contain separators", () => {
    const id = reviewIdFor("BRK-B-1782912602137-abc", "TRIM", 1);
    expect(parseReviewId(id)).toEqual({
      tradeId: "BRK-B-1782912602137-abc",
      legKind: "TRIM",
      legSeq: 1,
    });
  });

  it("rejects malformed ids", () => {
    expect(parseReviewId("nope")).toBeNull();
    expect(parseReviewId("")).toBeNull();
  });
});
