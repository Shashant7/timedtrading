// Ticker Context Ledger — Phase 0 (context-first scoring plan).
import { describe, it, expect } from "vitest";
import {
  buildPositionEventFacts,
  detectStructuralTestFacts,
  buildMoveFacts,
  deriveStructuralAnchors,
  rollupTickerContext,
  dedupeCandles,
  contextFactId,
} from "./context-ledger.js";
import { computeOptimalWindow } from "./discovery/optimal-window.js";

const DAY = 86400000;
const WEEK = 7 * DAY;

describe("buildPositionEventFacts (CAT history)", () => {
  const facts = buildPositionEventFacts({
    ticker: "CAT",
    investorLots: [
      { id: "lot-CAT-auto-1782309789719", position_id: "inv-CAT-auto-1782309789719", action: "BUY", shares: 7.086, price: 987.85, ts: 1782309789719, reason: "auto_entry_accumulate" },
      { id: "lot-CAT-invalidation-1783436619036", position_id: "inv-CAT-auto-1782309789719", action: "SELL", shares: 7.086, price: 917.31, ts: 1783436619036, reason: "PRIMARY_INVALIDATION_BREACH" },
    ],
    investorPositions: [
      { id: "inv-CAT-auto-1782309789719", avg_entry: 987.85, status: "CLOSED" },
    ],
  });

  it("emits entry and exit facts with pnl on the sell", () => {
    expect(facts).toHaveLength(2);
    const exit = facts.find((f) => f.payload.event === "EXIT");
    expect(exit.payload.reason).toBe("PRIMARY_INVALIDATION_BREACH");
    expect(exit.payload.pnl_pct).toBeCloseTo(-7.14, 1);
    expect(exit.ts).toBe(1783436619036);
  });

  it("fact ids are deterministic (idempotent backfill)", () => {
    expect(facts[0].fact_id).toBe(contextFactId("CAT", "position_event", "lot:lot-CAT-auto-1782309789719"));
  });
});

describe("detectStructuralTestFacts", () => {
  // Synthetic weekly series: uptrend, one test bar that dips to the EMA21
  // area and closes back above (held).
  function weeklyUptrend({ testAtIdx, closeBelow = false, weeks = 60 } = {}) {
    const bars = [];
    let px = 100;
    for (let i = 0; i < weeks; i++) {
      px *= 1.01;
      let o = px, h = px * 1.02, l = px * 0.99, c = px * 1.005;
      if (i === testAtIdx) {
        l = closeBelow ? px * 0.87 : px * 0.90;   // deep dip toward the EMA21
        c = closeBelow ? px * 0.88 : px * 1.0;    // close below the level or reclaim
      }
      bars.push({ ts: Date.UTC(2026, 0, 5) + i * WEEK, o, h, l, c });
    }
    return bars;
  }

  it("finds a held weekly EMA21 test when the dip closes back above", () => {
    const w = weeklyUptrend({ testAtIdx: 55 });
    const facts = detectStructuralTestFacts({ ticker: "CAT", weeklyCandles: w, dailyCandles: [] });
    const held = facts.filter((f) => f.payload.anchor === "W_EMA21" && f.payload.resolution === "held");
    expect(held.length).toBeGreaterThanOrEqual(1);
  });

  it("marks failed when closes stay below through the resolve window", () => {
    const w = weeklyUptrend({ testAtIdx: 50, closeBelow: true });
    // Keep the following closes below the dip level
    for (let i = 51; i < w.length; i++) { w[i].c = w[50].c * 0.98; w[i].l = w[i].c * 0.99; w[i].h = w[i].c * 1.01; w[i].o = w[i].c; }
    const facts = detectStructuralTestFacts({ ticker: "X", weeklyCandles: w, dailyCandles: [] });
    const evt = facts.find((f) => f.payload.anchor === "W_EMA21" && f.ts === w[50].ts);
    expect(evt).toBeTruthy();
    expect(["failed", "pending"]).toContain(evt.payload.resolution);
    expect(evt.payload.resolution).toBe("failed");
  });
});

describe("deriveStructuralAnchors", () => {
  const now = Date.now();
  const test = (anchor, resolution, daysAgo) => ({
    kind: "structural_test",
    ts: now - daysAgo * DAY,
    payload: { anchor, resolution },
  });

  it("earns respect after 2 held tests with no fails", () => {
    const anchors = deriveStructuralAnchors([
      test("W_EMA21", "held", 40),
      test("W_EMA21", "held", 10),
    ], { now });
    expect(anchors.W_EMA21.respect).toBe(true);
    expect(anchors.W_EMA21.held).toBe(2);
  });

  it("no respect when a test failed in the window", () => {
    const anchors = deriveStructuralAnchors([
      test("W_EMA21", "held", 40),
      test("W_EMA21", "failed", 20),
      test("W_EMA21", "held", 10),
    ], { now });
    expect(anchors.W_EMA21.respect).toBe(false);
  });

  it("ignores tests outside the lookback", () => {
    const anchors = deriveStructuralAnchors([
      test("D_EMA21", "held", 300),
      test("D_EMA21", "held", 10),
    ], { now });
    expect(anchors.D_EMA21.tested).toBe(1);
    expect(anchors.D_EMA21.respect).toBe(false);
  });
});

describe("computeOptimalWindow", () => {
  it("defaults with a thin sample", () => {
    const w = computeOptimalWindow([{ duration_days: 5 }]);
    expect(w.window_days).toBe(30);
    expect(w.sample_n).toBe(1);
  });

  it("scales to 2x median duration + lead-in, clamped 10-60", () => {
    const w = computeOptimalWindow([5, 10, 12, 15, 20].map((d) => ({ duration_days: d })));
    expect(w.median_duration_days).toBe(12);
    expect(w.window_days).toBe(30); // 24 + 6 lead-in
    const fast = computeOptimalWindow([2, 2, 3, 3, 4].map((d) => ({ duration_days: d })));
    expect(fast.window_days).toBe(10); // clamped at min? 6+2=8 → 10
    const slow = computeOptimalWindow([40, 45, 50].map((d) => ({ duration_days: d })));
    expect(slow.window_days).toBe(60); // clamped at max
  });
});

describe("rollupTickerContext", () => {
  it("stays compact and carries the last exit reason", () => {
    const now = Date.now();
    const facts = [
      { kind: "position_event", ts: now - 30 * DAY, payload: { lane: "investor", event: "ENTRY", price: 987.85 } },
      { kind: "position_event", ts: now - 20 * DAY, payload: { lane: "investor", event: "EXIT", price: 917.31, reason: "PRIMARY_INVALIDATION_BREACH", pnl_pct: -7.14 } },
      { kind: "structural_test", ts: now - 3 * DAY, payload: { anchor: "W_EMA21", level: 808, resolution: "held" } },
      { kind: "structural_test", ts: now - 40 * DAY, payload: { anchor: "W_EMA21", level: 850, resolution: "held" } },
      { kind: "move", ts: now - 10 * DAY, payload: { move_pct: -12.5, days: 5 } },
    ];
    const r = rollupTickerContext({ ticker: "CAT", facts, windowDays: 30, now });
    expect(r.last_exit.reason).toBe("PRIMARY_INVALIDATION_BREACH");
    expect(r.anchors.W_EMA21.respect).toBe(true);
    expect(r.moves.n).toBe(1);
    expect(JSON.stringify(r).length).toBeLessThan(4000);
  });
});

describe("dedupeCandles", () => {
  it("keeps one row per NY week, latest ts wins", () => {
    const rows = [
      { ts: 1785715200000, c: 876.53998 },   // same week, earlier ts
      { ts: 1785729600000, c: 876.54 },      // same week, later ts
      { ts: 1785110400000, c: 814.81 },
    ];
    const out = dedupeCandles(rows, "W");
    expect(out).toHaveLength(2);
    expect(out[1].c).toBe(876.54);
  });
});

describe("buildMoveFacts", () => {
  it("emits weekly move facts >= minPct", () => {
    // one week of dailies falling 10%
    const base = Date.UTC(2026, 6, 27); // a Monday
    const dailies = [0, 1, 2, 3, 4].map((i) => ({
      ts: base + i * DAY, o: 100 - i * 2.5, h: 101 - i * 2.5, l: 98 - i * 2.5, c: 100 - (i + 1) * 2.5,
    }));
    const facts = buildMoveFacts("X", dailies, { minPct: 8 });
    expect(facts.length).toBe(1);
    expect(facts[0].payload.direction).toBe("SHORT");
  });
});
