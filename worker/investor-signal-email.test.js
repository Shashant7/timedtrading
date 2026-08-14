import { describe, it, expect } from "vitest";
import { buildInvestorSignalEmailBody } from "./email.js";
import { buildInvestorSignalContext } from "./investor.js";

const meta = {
  subjectBase: "ANET — Long Term BOUGHT (new position)",
  headline: "Long Term BOUGHT — new position",
  lede: "The Long Term book <strong>opened</strong> <strong>ANET</strong>.",
};
const action = { verb: "MODEL · BOUGHT", one_liner: "Model opened a starter position.", color: "#38F2A1" };

function buildOpen(extra = {}) {
  return buildInvestorSignalEmailBody({
    type: "position_open",
    meta,
    action,
    baseUrl: "https://timed-trading.com",
    chartImgHtml: "<div id='chart'></div>",
    chartUrl: "https://timed-trading.com/timed/chart-image?ticker=ANET",
    data: {
      ticker: "ANET",
      shares: 35.1105,
      price: 199.37,
      value: 7000,
      reason: "auto_entry_accumulate",
      reasonLabel: "New starter position — accumulate stage (portfolio rebalance)",
      stage: "accumulate",
      score: 78,
      cio_reasoning: "On-thesis within AI infrastructure; HMM is high-confidence BULL_TREND.",
      sizing_pct: 7,
      per_thousand: 70,
      invalidation_price: 172.5,
      invalidation_label: "monthly supertrend",
      target_price: 240,
      thesis: "Datacenter networking compounder.",
      thesis_invalidation: ["Monthly SuperTrend flips bearish"],
      regime: {
        hmm_state: "BULL_TREND",
        hmm_confidence: 0.91,
        markov_next_state: "HTF_BULL_LTF_BULL",
        markov_next_prob: 0.72,
      },
      technicals: ["Monthly: SuperTrend bullish · RSI 61"],
      ...extra,
    },
  });
}

describe("buildInvestorSignalEmailBody", () => {
  it("renders the same sections the Short Term email uses", () => {
    const { bodyHtml } = buildOpen();
    for (const section of ["Position", "Setup &amp; Thesis", "Signal Quality", "Technical Read", "AI CIO Guidance"]) {
      expect(bodyHtml).toContain(section);
    }
  });

  it("states ticker, horizon, entry price and share count", () => {
    const { bodyHtml } = buildOpen();
    expect(bodyHtml).toContain("Long Term Signal");
    expect(bodyHtml).toContain("ANET");
    expect(bodyHtml).toContain("$199.37");
    expect(bodyHtml).toContain("35.1105");
    expect(bodyHtml).toContain("$7,000");
  });

  it("shows the invalidation floor and fair-value target as stop/target", () => {
    const { bodyHtml } = buildOpen();
    expect(bodyHtml).toContain("Invalidation floor");
    expect(bodyHtml).toContain("$172.50");
    expect(bodyHtml).toContain("Fair-value target");
    expect(bodyHtml).toContain("$240.00");
  });

  it("surfaces HMM and Markov commentary", () => {
    const { bodyHtml } = buildOpen();
    expect(bodyHtml).toContain("HMM latent regime");
    expect(bodyHtml).toContain("BULL TREND");
    expect(bodyHtml).toContain("91% posterior");
    expect(bodyHtml).toContain("Markov next bar");
  });

  it("explains the reason in words rather than a raw key", () => {
    const { bodyHtml } = buildOpen();
    expect(bodyHtml).toContain("Why The Model Bought");
    expect(bodyHtml).toContain("New starter position");
  });

  it("includes sizing guidance so any account can scale the trade", () => {
    const { bodyHtml } = buildOpen();
    expect(bodyHtml).toContain("7.0% of the long-horizon book");
    expect(bodyHtml).toContain("$70 per $1k");
  });

  it("renders an options play when one is attached", () => {
    const { bodyHtml } = buildOpen({
      options_play: { headline: "LEAP call", lines: ["BUY 1x CALL $200 exp 2027-01-15"], archetype: "leap_call" },
    });
    expect(bodyHtml).toContain("Options Play (LEAP · Long Term)");
  });

  it("builds a plain-text alternative covering the same sections", () => {
    const { text } = buildOpen();
    expect(text).toContain("Position:");
    expect(text).toContain("Technical Read:");
    expect(text).toContain("AI CIO guidance:");
    expect(text).not.toMatch(/<[a-z]+/i);
  });

  it("switches to sell language on a trim", () => {
    const { bodyHtml } = buildInvestorSignalEmailBody({
      type: "position_trim",
      meta: { ...meta, headline: "Long Term TRIMMED — partial reduce" },
      action: { verb: "MODEL · TRIMMED", one_liner: "Model reduced size.", color: "#f59e0b" },
      baseUrl: "https://timed-trading.com",
      chartImgHtml: "",
      data: {
        ticker: "IWM", shares: 4, price: 250, pnl: 120.5, remaining: 6,
        reason: "exhaustion_lock_in", reasonLabel: "Exhaustion lock-in (20% profit trim)",
      },
    });
    expect(bodyHtml).toContain("Exit price");
    expect(bodyHtml).toContain("Shares sold");
    expect(bodyHtml).toContain("Why The Model Reduced");
    expect(bodyHtml).toContain("Total after action");
  });
});

describe("buildInvestorSignalContext", () => {
  const tickerData = {
    state: "HTF_BULL_LTF_BULL",
    latent_regime: { state: "BULL_TREND", posterior: { BULL_TREND: 0.88, CHOP: 0.1, BEAR_TREND: 0.02 } },
    regime_forecast: {
      p_next: { HTF_BULL_LTF_BULL: 0.74, HTF_BULL_LTF_PULLBACK: 0.2 },
      p_1d: { HTF_BULL_LTF_BULL: 0.6, HTF_BEAR_LTF_BEAR: 0.1 },
    },
    tf_tech: {
      M: { stDir: -1, rsi: 64 },
      W: { stDir: -1, stSlopeUp: true },
    },
  };
  const scoreRow = {
    stage: "accumulate",
    score: 78,
    rsRank: 91,
    thesis: "Networking compounder",
    thesisInvalidation: ["Monthly SuperTrend flips bearish"],
    thesisInvalidationPrice: 172.5,
    fairValue: { fair_value: 240, fv_class: "undervalued", quality_grade: "A" },
    components: { weeklyTrend: 15, monthlyTrend: 20, relativeStrength: 5 },
  };

  it("extracts HMM state with posterior confidence", () => {
    const ctx = buildInvestorSignalContext({ tickerData, scoreRow });
    expect(ctx.regime.hmm_state).toBe("BULL_TREND");
    expect(ctx.regime.hmm_confidence).toBeCloseTo(0.88, 3);
  });

  it("picks the most probable Markov next state", () => {
    const ctx = buildInvestorSignalContext({ tickerData, scoreRow });
    expect(ctx.regime.markov_next_state).toBe("HTF_BULL_LTF_BULL");
    expect(ctx.regime.markov_next_prob).toBeCloseTo(0.74, 3);
  });

  it("renders a per-timeframe technical read", () => {
    const ctx = buildInvestorSignalContext({ tickerData, scoreRow });
    expect(ctx.technicals.join(" | ")).toContain("Monthly: SuperTrend bullish");
    expect(ctx.technicals.join(" | ")).toContain("RSI 64");
    expect(ctx.technicals.join(" | ")).toContain("Weekly:");
  });

  it("computes sizing as a percent of the book plus a per-$1k hint", () => {
    const ctx = buildInvestorSignalContext({ tickerData, scoreRow, value: 7000, capital: 100000 });
    expect(ctx.sizing_pct).toBeCloseTo(7, 5);
    expect(ctx.per_thousand).toBeCloseTo(70, 5);
  });

  it("carries the invalidation floor and fair-value target", () => {
    const ctx = buildInvestorSignalContext({ tickerData, scoreRow });
    expect(ctx.invalidation_price).toBe(172.5);
    expect(ctx.target_price).toBe(240);
    expect(ctx.thesis_invalidation).toEqual(["Monthly SuperTrend flips bearish"]);
  });

  it("returns null regime when the snapshot has no regime data", () => {
    const ctx = buildInvestorSignalContext({ tickerData: { tf_tech: {} }, scoreRow: null });
    expect(ctx.regime).toBeNull();
    expect(ctx.technicals).toEqual([]);
  });

  it("parses a JSON-serialized thesis invalidation list off a position row", () => {
    const ctx = buildInvestorSignalContext({
      scoreRow: { thesis_invalidation: JSON.stringify(["Weekly trend flips"]) },
    });
    expect(ctx.thesis_invalidation).toEqual(["Weekly trend flips"]);
  });
});
