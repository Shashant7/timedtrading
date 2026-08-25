import { describe, it, expect } from "vitest";
import {
  passesValueBottomGates,
  scoreValueBottom,
  rankValueBottoms,
  valueBottomToSignal,
  buildValueBottomsPayload,
  VALUE_BOTTOM_HORIZON_DAYS,
} from "./value-bottoms.js";

function intuitLike(overrides = {}) {
  return {
    ticker: "INTU",
    score: 72,
    stage: "accumulate",
    timing_primary: "BOTTOM",
    timing_playbook: "TIME_BOTTOM",
    fairValue: {
      fair_value: 720,
      fv_premium_pct: -18,
      fv_class: "discount",
      quality_grade: "A",
      growth_detected: true,
    },
    accumZone: {
      inZone: true,
      zoneType: "weekly_oversold_monthly_intact",
      confidence: 70,
      signals: ["weekly_oversold_monthly_intact", "phase_accumulation"],
    },
    thesisInvalidationPrice: 580,
    compounder: { dip_buy: false },
    ...overrides,
  };
}

describe("passesValueBottomGates", () => {
  it("accepts discount + quality + timing bottom", () => {
    expect(passesValueBottomGates(intuitLike())).toBe(true);
  });

  it("rejects premium valuation", () => {
    expect(passesValueBottomGates(intuitLike({
      fairValue: { fair_value: 500, fv_premium_pct: 20, fv_class: "premium", quality_grade: "A" },
    }))).toBe(false);
  });

  it("rejects bare momentum_runner without bottom timing", () => {
    expect(passesValueBottomGates(intuitLike({
      timing_primary: null,
      timing_playbook: null,
      accumZone: { inZone: true, zoneType: "momentum_runner", confidence: 80, signals: ["mr"] },
    }))).toBe(false);
  });

  it("rejects weak quality grades", () => {
    expect(passesValueBottomGates(intuitLike({
      fairValue: { fair_value: 720, fv_premium_pct: -18, fv_class: "discount", quality_grade: "D" },
    }))).toBe(false);
  });
});

describe("scoreValueBottom + rankValueBottoms", () => {
  it("scores INTU-like rows into the mid/high band", () => {
    const s = scoreValueBottom(intuitLike());
    expect(s).not.toBeNull();
    expect(s.score).toBeGreaterThanOrEqual(50);
    expect(s.parts.value).toBeGreaterThan(0);
    expect(s.parts.bottom).toBeGreaterThan(0);
  });

  it("ranks deeper discounts ahead when scores tie on other axes", () => {
    const rows = rankValueBottoms([
      intuitLike({ ticker: "ACN", fairValue: { fair_value: 400, fv_premium_pct: -12, fv_class: "discount", quality_grade: "B" } }),
      intuitLike({ ticker: "INTU", fairValue: { fair_value: 720, fv_premium_pct: -28, fv_class: "discount", quality_grade: "A", growth_detected: true } }),
    ], { priceMap: { INTU: { p: 520 }, ACN: { p: 350 } } });
    expect(rows[0].ticker).toBe("INTU");
    expect(rows[0].price).toBe(520);
    expect(rows[0].target_price).toBe(720);
    expect(rows[0].stop_price).toBe(580);
  });
});

describe("valueBottomToSignal", () => {
  it("builds an idempotent investor-desk ledger row", () => {
    const ranked = rankValueBottoms([intuitLike()], { priceMap: { INTU: { p: 520 } }, nowMs: Date.parse("2026-08-25T16:00:00Z") })[0];
    const sig = valueBottomToSignal(ranked, { ymd: "2026-08-25", published_at: Date.parse("2026-08-25T16:00:00Z") });
    expect(sig.signal_id).toBe("valuebottom:2026-08-25:INTU");
    expect(sig.source).toBe("value_bottom");
    expect(sig.desk).toBe("investor");
    expect(sig.direction).toBe("LONG");
    expect(sig.horizon_days).toBe(VALUE_BOTTOM_HORIZON_DAYS);
    expect(sig.entry_price).toBe(520);
    expect(sig.target_price).toBe(720);
    expect(sig.stop_price).toBe(580);
  });

  it("buildValueBottomsPayload wraps holdings", () => {
    const payload = buildValueBottomsPayload([{ ticker: "INTU" }], { computedAt: 1, ymd: "2026-08-25" });
    expect(payload.ok).toBe(true);
    expect(payload.count).toBe(1);
    expect(payload.ymd).toBe("2026-08-25");
  });
});
