import { describe, it, expect } from "vitest";
import {
  compactTfTech,
  compactResearchRefs,
  compactTechnicalRefs,
  buildTraderActionProvenance,
  enrichDecisionInputs,
} from "./action-provenance.js";

const xlreTicker = {
  ticker: "XLRE",
  rank: 86,
  rr: 2.4,
  state: "LONG",
  direction: "LONG",
  setupName: "Pullback Resume",
  setupGrade: "A",
  __entry_path: "confirm_stack_ema21",
  kanban_stage: "BOUGHT",
  __conviction_tier: "A",
  regime_class: "risk_on",
  price: 41.2,
  sl: 39.8,
  tp: 43.1,
  flags: { st_flip_bull: true, sq30_release: true },
  tf_tech: {
    "30": { bias: "bull", rsi: { rsi: 42 }, supertrend: { direction: "up" }, ema21: 40.5 },
    D: { bias: "bull", rsi: { value: 55 }, st: { direction: "up" }, ema: { ema21: 40.1 } },
  },
  _compounder: {
    tier: "growth_strong",
    eligible: true,
    dip_buy: true,
    dip_signals: ["weekly_pullback_monthly_intact", "intraday_pullback"],
    boost: 5,
  },
  _fair_value: {
    fair_value: 48,
    fv_premium_pct: -14.2,
    fv_class: "discount",
    quality_grade: "A",
  },
  _business_character: {
    archetype: "growth_compounder",
    quality_grade: "A",
    compounder_tier: "growth_strong",
    technical_lens: { pullback_means: "buy_the_dip", summary: "Quality pullback" },
  },
  fsd_alignment: {
    vintage: "2026-07-20",
    stance: "overweight",
    on_thesis: true,
    tactical_matches: [{ signal: "REITs bounce", direction: "long", via: "theme" }],
  },
  sector: "Real Estate",
  __learning_policy: { source: "edge_scorecard", match: "pullback", recommend: "size_up" },
};

describe("compactTfTech", () => {
  it("summarizes bias/rsi/st/ema21 for key TFs", () => {
    const tf = compactTfTech(xlreTicker);
    expect(tf["30"].rsi).toBe(42);
    expect(tf["30"].st).toBe("up");
    expect(tf.D.ema21).toBe(40.1);
  });
});

describe("compactResearchRefs", () => {
  it("captures compounder + FV + character + FSD for calibration", () => {
    const r = compactResearchRefs(xlreTicker);
    expect(r.compounder.dip_buy).toBe(true);
    expect(r.compounder.dip_signals).toContain("intraday_pullback");
    expect(r.fair_value.fv_class).toBe("discount");
    expect(r.business_character.archetype).toBe("growth_compounder");
    expect(r.fsd_alignment.on_thesis).toBe(true);
    expect(r.sector).toBe("Real Estate");
  });
});

describe("buildTraderActionProvenance", () => {
  it("builds ENTRY provenance with technical + research refs", () => {
    const inputs = buildTraderActionProvenance({
      event: {
        type: "ENTRY",
        price: 41.2,
        rank: 86,
        rr: 2.4,
        setup_name: "Pullback Resume",
        setup_grade: "A",
        direction: "LONG",
        thesis: "Pullback Resume + Fresh ST Flip",
        KANBAN_IN_REVIEW: false,
      },
      tickerData: xlreTicker,
      trade: { id: "XLRE-1", sl: 39.8, tp: 43.1, direction: "LONG" },
    });
    expect(inputs.engine).toBe("trader");
    expect(inputs.provenance_v).toBe(1);
    expect(inputs.why.type).toBe("ENTRY");
    expect(inputs.why.thesis).toMatch(/Pullback Resume/);
    expect(inputs.technical.entry_path).toBe("confirm_stack_ema21");
    expect(inputs.technical.tf_tech["30"].rsi).toBe(42);
    expect(inputs.technical.conviction_tier).toBe("A");
    expect(inputs.research.compounder.tier).toBe("growth_strong");
    expect(inputs.research.fair_value.fair_value).toBe(48);
    expect(inputs.event.rank).toBe(86);
  });

  it("builds TRIM/EXIT why fields from event reasons", () => {
    const trim = buildTraderActionProvenance({
      event: {
        type: "TRIM",
        reason: "TP_TRIM",
        exitCategory: "PROFIT_MANAGEMENT",
        trimPct: 0.4,
        price: 42.5,
      },
      tickerData: xlreTicker,
    });
    expect(trim.why.type).toBe("TRIM");
    expect(trim.why.reason).toBe("TP_TRIM");
    expect(trim.why.exit_category).toBe("PROFIT_MANAGEMENT");
    expect(trim.research.fsd_alignment.stance).toBe("overweight");
  });
});

describe("enrichDecisionInputs", () => {
  it("merges DEFEND base inputs with technical + research without dropping keys", () => {
    const enriched = enrichDecisionInputs(
      {
        pnl_pct: 3.2,
        old_sl: 39.8,
        new_sl: 40.5,
        defend_reason: "trail_cloud",
        protection_stage: "lock_1r",
      },
      {
        eventType: "DEFEND",
        reason: "TRAIL_CLOUD",
        tickerData: xlreTicker,
        trade: { id: "XLRE-1", sl: 40.5, direction: "LONG" },
      },
    );
    expect(enriched.pnl_pct).toBe(3.2);
    expect(enriched.new_sl).toBe(40.5);
    expect(enriched.why.defend_reason).toBe("trail_cloud");
    expect(enriched.technical.rank).toBe(86);
    expect(enriched.research.compounder.dip_buy).toBe(true);
    expect(enriched.provenance_v).toBe(1);
  });

  it("still returns event-core why when tickerData is missing", () => {
    const inputs = buildTraderActionProvenance({
      event: { type: "EXIT", reason: "SL", price: 39.5 },
    });
    expect(inputs.why.reason).toBe("SL");
    expect(inputs.technical).toBeNull();
    expect(inputs.research).toBeNull();
  });
});

describe("compactTechnicalRefs", () => {
  it("includes learning policy and flags when present", () => {
    const tech = compactTechnicalRefs(xlreTicker, { sl: 39.8 });
    expect(tech.flags.st_flip_bull).toBe(true);
    expect(tech.learning_policy.recommend).toBe("size_up");
    expect(tech.sl).toBe(39.8);
  });
});
