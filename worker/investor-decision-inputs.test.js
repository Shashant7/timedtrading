// Pins investor decision provenance for the self-calibrating loop.

import { describe, it, expect } from "vitest";
import {
  buildInvestorDecisionInputs,
  compactInvestorScoreProvenance,
  extractInvestorTfSignalMap,
  enrichInvestorDecisionInputsWithTickerData,
} from "./investor.js";

const cfScoreRow = {
  stage: "accumulate",
  stageReason: "compounder_dip_buy:growth_strong:weekly_pullback_monthly_intact|intraday_pullback",
  score: 64,
  components: { weeklyTrend: 13, monthlyTrend: 20 },
  accumZone: { zoneType: "momentum_runner_exhausted", inZone: true },
  fsd: { isPick: true, tier: "strong", etfs: ["GRNY", "GRNI"] },
  compounder: {
    tier: "growth_strong",
    eligible: true,
    dip_buy: true,
    dip_signals: ["weekly_pullback_monthly_intact", "intraday_pullback"],
    why_hold: ["Revenue expanding ~19% YoY"],
    boost: 5,
  },
  fairValue: { fair_value: 147.62, fv_class: "discount", quality_grade: "A" },
  thesis: "CF: Monthly uptrend. Above Weekly EMA(200).",
  thesisInvalidation: ["Monthly SuperTrend flips bearish"],
  primaryInvalidation: { price: 120.7, label: "Weekly ATR support" },
  thesisInvalidationPrice: 120.7,
  rsRank: 64,
  sector: "Basic Materials",
  timing_primary: "TOP",
  timing_playbook: "TIME_TOP",
  actionTier: "act_now",
  simEligible: true,
};

describe("compactInvestorScoreProvenance", () => {
  it("captures CF-shaped compounder dip + FV + thesis for calibration", () => {
    const p = compactInvestorScoreProvenance(cfScoreRow);
    expect(p.compounder.tier).toBe("growth_strong");
    expect(p.compounder.dip_buy).toBe(true);
    expect(p.compounder.dip_signals).toContain("weekly_pullback_monthly_intact");
    expect(p.fair_value.fv_class).toBe("discount");
    expect(p.thesis).toMatch(/Monthly uptrend/);
    expect(p.fsd.isPick).toBe(true);
    expect(p.rs_rank).toBe(64);
  });
});

describe("buildInvestorDecisionInputs", () => {
  it("auto-fills provenance from scoreRow on ENTRY", () => {
    const inputs = buildInvestorDecisionInputs({
      action: "BUY",
      event: "ENTRY",
      ticker: "CF",
      ts: 1784134955515,
      price: 115.9,
      shares: 43.14,
      lotId: "lot-CF-auto-1",
      positionId: "inv-CF-auto-1",
      reason: "auto_entry_accumulate",
      scoreRow: cfScoreRow,
      marketHealth: 81,
      autoRebalance: { kind: "new_open", target_pct: 0.05 },
      cioReasoning: "Quality compounder dip — proceed",
    });
    expect(inputs.stage_reason).toMatch(/compounder_dip_buy/);
    expect(inputs.compounder.dip_signals).toContain("intraday_pullback");
    expect(inputs.fair_value.fair_value).toBe(147.62);
    expect(inputs.thesis_invalidation_price).toBe(120.7);
    expect(inputs.timing_primary).toBe("TOP");
    expect(inputs.cio_reasoning).toMatch(/Quality compounder/);
    expect(inputs.dip_buy).toBe(true);
  });

  it("stamps TF grid from tickerData for Trade Autopsy", () => {
    const tickerData = {
      tf_tech: {
        "4H": { stDir: 1, stBull: true, stSlopeUp: true, ema5above48: true, rsi: 55 },
        D: { stDir: 1, stBull: true, emaCross13_48_up: true },
        "15": { stDir: -1, ema5above48: false },
      },
    };
    const inputs = buildInvestorDecisionInputs({
      action: "BUY",
      event: "ENTRY",
      ticker: "NBIS",
      ts: 1784134955515,
      price: 100,
      shares: 10,
      positionId: "inv-NBIS-auto-1",
      reason: "auto_entry_accumulate",
      scoreRow: cfScoreRow,
      tickerData,
    });
    expect(inputs.tf["4H"].signals.supertrend).toBe(1);
    expect(inputs.tf.D.signals.ema_cross).toBe(1);
    expect(inputs.tf["15m"].signals.supertrend).toBe(1); // Pine stDir -1 → bull
    expect(inputs.h4_timing).toBeTruthy();
  });
});

describe("extractInvestorTfSignalMap / enrich", () => {
  it("maps tf_tech into Autopsy signal shape (Pine stDir)", () => {
    const tf = extractInvestorTfSignalMap({
      tf_tech: {
        "240": { stDir: -1, ema5above48: true }, // Pine bull
        W: { stDir: 1 }, // Pine bear
      },
    });
    expect(tf["4H"].signals.supertrend).toBe(1);
    expect(tf.W.signals.supertrend).toBe(-1);
  });

  it("enriches missing tf/h4 without overwriting existing", () => {
    const base = { ticker: "NBIS", score: 70, tf: { D: { signals: { ema_cross: 1 } } } };
    const next = enrichInvestorDecisionInputsWithTickerData(base, {
      tf_tech: {
        "4H": { stDir: 1, stBull: true, stSlopeUp: true },
        D: { stDir: 1, ema5above48: false },
      },
    });
    expect(next.tf.D.signals.ema_cross).toBe(1); // preserved
    expect(next.h4_timing).toBeTruthy();
  });
});
