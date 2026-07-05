// worker/verdict.test.js — Phase D2: the three-questions answer contract.

import { describe, it, expect } from "vitest";
import { buildTraderVerdict, buildInvestorVerdict, buildVerdictGuide, rankBuyCandidates } from "./verdict.js";

function payload(overrides = {}) {
  return {
    ticker: "NVDA",
    price: 200, _live_price: 201,
    state: "HTF_BULL_LTF_PULLBACK",
    kanban_stage: "watch",
    rank: 12, score: 78,
    sl: 188, tp_trim: 225, tp_exit: 240,
    _journey: { features: { direction: "improving", score_slope_1h: 2.4, time_in_stage_min: 95, cell: "Bp|D0|C1|P1" } },
    ...overrides,
  };
}

describe("buildTraderVerdict — question 2 (should I buy THIS ticker?)", () => {
  it("enter stage → BUY now with price/stop/target and why", () => {
    const v = buildTraderVerdict(payload({ kanban_stage: "enter" }));
    expect(v.verdict).toBe("BUY");
    expect(v.timing).toBe("now");
    expect(v.entry_price).toBe(201);
    expect(v.stop).toBe(188);
    expect(v.target).toBe(225);
    expect(v.why).toContain("entry lane");
    expect(v.lane).toBe("trader");
  });

  it("watch + improving journey → SETUP_FORMING on confirmation", () => {
    const v = buildTraderVerdict(payload());
    expect(v.verdict).toBe("SETUP_FORMING");
    expect(v.timing).toBe("on confirmation");
    expect(v.why).toContain("journey improving");
  });

  it("nothing actionable → WAIT with what-would-change-it", () => {
    const v = buildTraderVerdict(payload({
      kanban_stage: "avoid",
      _journey: { features: { direction: "deteriorating", score_slope_1h: -3 } },
    }));
    expect(v.verdict).toBe("WAIT");
    expect(v.why).toContain("journey must turn");
    expect(v.why).toContain("stage must reach enter");
  });
});

describe("buildTraderVerdict — question 3 (should I sell THIS ticker?)", () => {
  const openTrade = { direction: "LONG", entryPrice: 180, sl: 172 };

  it("exit lane → SELL now", () => {
    const v = buildTraderVerdict(payload({ kanban_stage: "exit" }), openTrade);
    expect(v.verdict).toBe("SELL");
    expect(v.timing).toBe("now");
    expect(v.pnl_pct).toBeCloseTo(((201 - 180) / 180) * 100, 1);
  });

  it("defend lane or deteriorating journey → TIGHTEN", () => {
    const v1 = buildTraderVerdict(payload({ kanban_stage: "defend" }), openTrade);
    expect(v1.verdict).toBe("TIGHTEN");
    const v2 = buildTraderVerdict(payload({
      kanban_stage: "neutral",
      _journey: { features: { direction: "deteriorating", score_slope_1h: -2 } },
    }), openTrade);
    expect(v2.verdict).toBe("TIGHTEN");
    expect(v2.why).toContain("deteriorating");
  });

  it("plan intact → HOLD with position economics", () => {
    const v = buildTraderVerdict(payload({ kanban_stage: "neutral" }), openTrade);
    expect(v.verdict).toBe("HOLD");
    expect(v.entry_price).toBe(180);
    expect(v.stop).toBe(172);
  });
});

describe("buildInvestorVerdict — lane separation", () => {
  it("accumulate zone, not owned → BUY scale-in", () => {
    const v = buildInvestorVerdict(payload(), { stage: "accumulate", score: 71 });
    expect(v.verdict).toBe("BUY");
    expect(v.timing).toBe("scale in");
    expect(v.lane).toBe("investor");
  });

  it("owned + reduce zone → SELL; owned + healthy → HOLD", () => {
    const pos = { avg_entry: 150 };
    expect(buildInvestorVerdict(payload(), { stage: "reduce" }, pos).verdict).toBe("SELL");
    const hold = buildInvestorVerdict(payload(), { stage: "hold" }, pos);
    expect(hold.verdict).toBe("HOLD");
    expect(hold.pnl_pct).toBeCloseTo(((201 - 150) / 150) * 100, 1);
  });

  it("no investor data at all → null (ticker is trader-only)", () => {
    expect(buildInvestorVerdict(payload(), null, null)).toBeNull();
  });

  it("payload investor_stage fallback when scores row missing", () => {
    const v = buildInvestorVerdict(payload({ investor_stage: "accumulate", investor_score: 64 }), null, null);
    expect(v.verdict).toBe("BUY");
    expect(v.why).toContain("accumulate");
  });
});

describe("buildVerdictGuide — cross-lane narrative", () => {
  it("trader WAIT + bearish + investor BUY → diverge guide with early-entry note", () => {
    const trader = buildTraderVerdict(payload({
      state: "HTF_BEAR_LTF_BEAR",
      kanban_stage: "watch",
      _journey: { features: { direction: "flat", score_slope_1h: 0 } },
    }));
    const investor = buildInvestorVerdict(payload({ investor_stage: "accumulate", investor_score: 64 }), null, null);
    const guide = buildVerdictGuide(trader, investor, payload({
      state: "HTF_BEAR_LTF_BEAR",
      timing_overlay: { posture: "RISK_OFF", warnings: ["macro_risk_off"] },
    }));
    expect(guide.diverge).toBe(true);
    expect(guide.headline).toContain("diverge");
    expect(guide.narrative).toContain("accumulate");
    expect(guide.model_not_entered).toBeTruthy();
    expect(guide.early_entry).toContain("buy zone");
  });
});

describe("rankBuyCandidates — question 1 (what should I buy right now?)", () => {
  it("BUY beats SETUP_FORMING; improving journey and better rank break ties", () => {
    const rows = [
      { ticker: "AAA", trader: { verdict: "SETUP_FORMING", journey: { direction: "improving" }, rank: 5 } },
      { ticker: "BBB", trader: { verdict: "BUY", journey: { direction: "improving" }, rank: 40 } },
      { ticker: "CCC", trader: { verdict: "WAIT" } },
      { ticker: "DDD", trader: { verdict: "BUY", journey: { direction: "flat" }, rank: 3 } },
    ];
    const ranked = rankBuyCandidates(rows, 3);
    expect(ranked.map((r) => r.ticker)).toEqual(["BBB", "DDD", "AAA"]);
  });

  it("nothing actionable → empty answer, never a filler pick", () => {
    expect(rankBuyCandidates([{ ticker: "X", trader: { verdict: "WAIT" } }])).toEqual([]);
  });
});
