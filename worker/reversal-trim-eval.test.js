import { describe, it, expect } from "vitest";
import {
  updateReversalTrimHistory,
  computeReversalTrimScorecard,
} from "./reversal-trim-eval.js";

const advisory = (over = {}) => ({
  ticker: "NVDA",
  trade_id: "t1",
  direction: "LONG",
  pnl_pct: 8,
  trimmed_pct: 0,
  suggested_trim_pct: 0.33,
  strength: "strong",
  reasons: ["overlay_trim_winners", "fsd_risk_off"],
  price: 108,
  entry_price: 100,
  ...over,
});

describe("updateReversalTrimHistory", () => {
  it("records the FIRST advisory per trade and tracks the peak afterwards", () => {
    const r1 = updateReversalTrimHistory({ entries: {} }, { advisories: [advisory()] }, 1000);
    expect(r1.changed).toBe(true);
    expect(r1.history.entries.t1.advisory_pnl_pct).toBe(8);
    expect(r1.history.entries.t1.first_ts).toBe(1000);

    // Later tick at higher pnl: advisory_pnl stays anchored at FIRST, peak updates.
    const r2 = updateReversalTrimHistory(r1.history, { advisories: [advisory({ pnl_pct: 11 })] }, 200000);
    expect(r2.history.entries.t1.advisory_pnl_pct).toBe(8);
    expect(r2.history.entries.t1.peak_pnl_pct).toBe(11);
  });

  it("ignores advisories without a trade_id and caps history size", () => {
    const noId = updateReversalTrimHistory({ entries: {} }, { advisories: [advisory({ trade_id: null })] }, 1);
    expect(Object.keys(noId.history.entries)).toHaveLength(0);

    const many = { advisories: Array.from({ length: 320 }, (_, i) => advisory({ trade_id: `t${i}` })) };
    const capped = updateReversalTrimHistory({ entries: {} }, many, 1);
    expect(Object.keys(capped.history.entries).length).toBeLessThanOrEqual(300);
  });
});

describe("computeReversalTrimScorecard", () => {
  const histWith = (recs) => ({ entries: Object.fromEntries(recs.map((r) => [r.trade_id, r])) });
  const rec = (id, advisoryPnl, suggested = 0.25) => ({
    trade_id: id, ticker: id.toUpperCase(), direction: "LONG",
    first_ts: 1, last_seen_ts: 2, advisory_pnl_pct: advisoryPnl, peak_pnl_pct: advisoryPnl,
    suggested_trim_pct: suggested, strength: "standard", price: 100, entry_price: 90, outcome: null,
  });

  it("scores a saved drawdown positively and a cut runner negatively", () => {
    const hist = histWith([rec("a", 8, 0.33), rec("b", 4)]);
    const closed = {
      a: { trade_id: "a", status: "LOSS", pnl_pct: 1, exit_ts: 99 },   // gave back 7 → advisor saved
      b: { trade_id: "b", status: "WIN", pnl_pct: 12, exit_ts: 99 },   // kept running → advisor would have hurt
    };
    const { history, scorecard } = computeReversalTrimScorecard(hist, closed, 5);
    expect(history.entries.a.outcome.saved_pct).toBe(7);
    expect(history.entries.a.outcome.weighted_saved_pct).toBeCloseTo(2.31, 2);
    expect(history.entries.b.outcome.saved_pct).toBe(-8);
    expect(scorecard.evaluated).toBe(2);
    expect(scorecard.helped).toBe(1);
    expect(scorecard.hurt).toBe(1);
    expect(scorecard.verdict).toBe("INSUFFICIENT_SAMPLE"); // < 20 evaluated
  });

  it("leaves open trades pending and derives pnl from prices when pnl_pct is missing", () => {
    const hist = histWith([rec("open1", 5), rec("px1", 6)]);
    const closed = {
      open1: { trade_id: "open1", status: "OPEN" },
      px1: { trade_id: "px1", status: "WIN", entry_price: 100, exit_price: 103, direction: "LONG", exit_ts: 9 },
    };
    const { history, scorecard } = computeReversalTrimScorecard(hist, closed, 5);
    expect(history.entries.open1.outcome).toBe(null);
    expect(history.entries.px1.outcome.exit_pnl_pct).toBe(3);
    expect(history.entries.px1.outcome.saved_pct).toBe(3);
    expect(scorecard.pending).toBe(1);
  });

  it("supports enforcement only with >=20 evaluated, positive weighted savings, hurt < 1/3", () => {
    const recs = [];
    const closed = {};
    for (let i = 0; i < 24; i++) {
      const id = `t${i}`;
      recs.push(rec(id, 6));
      // 20 saved (+4 each), 4 hurt (-2 each) → hurt ratio 1/6, weighted avg positive
      closed[id] = { trade_id: id, status: "LOSS", pnl_pct: i < 20 ? 2 : 8, exit_ts: 9 };
    }
    const { scorecard } = computeReversalTrimScorecard(histWith(recs), closed, 5);
    expect(scorecard.evaluated).toBe(24);
    expect(scorecard.verdict).toBe("ENFORCEMENT_SUPPORTED");
  });
});
