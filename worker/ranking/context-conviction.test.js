import { describe, expect, it } from "vitest";
import { computeConvictionScore } from "../focus-tier.js";
import { inferSide } from "../pipeline/trade-context.js";
import { admitSetupGrade, evaluateSetupGrade } from "../pipeline/setup-grade.js";
import { computeCandidateScore, stampTechnicalRank } from "./candidate-rank.js";
import {
  CONTEXT_CONVICTION_CAP,
  newsLooksLikeIndexInclusion,
  scoreContextConviction,
} from "./context-conviction.js";
import { playStructureAligned, resolvePlaySide } from "./play-side.js";

/** Live-shaped BE 2026-09-10: HTF_BEAR, quality-A compounder, Cloud Pivot LONG. */
function beLiveShaped(overrides = {}) {
  return {
    ticker: "BE",
    state: "HTF_BEAR_LTF_BEAR",
    htf_score: -2.5,
    ltf_score: -4.3,
    rank: 51,
    price: 220,
    volatility_atr_pct: 2.5,
    _ticker_type: "growth",
    _fair_value: {
      quality_grade: "A",
      quality_score: 70,
      growth_detected: true,
      tilt: 1,
      tilt_enabled: true,
      stale: false,
    },
    _compounder: { tier: "growth_elite", eligible: true },
    _fv_tilt: -1,
    _officer_tilt: -1,
    _sector_rating: "overweight",
    _cloud_pivot_detect: { fires: true, direction: "LONG" },
    st_hold_setup: { best: { held: true, quality: "high", sideLabel: "LONG" } },
    rvol_map: { "30": { vr: 0.58 } },
    daily_structure: {
      e21: 210, e48: 200, e200: 160, pct_above_e21: 4,
      bull_stack: false, bear_stack: false,
    },
    ...overrides,
  };
}

function convictionOf(tickerData, ctx = {}) {
  return computeConvictionScore({
    tickerData,
    ctx,
    historyStats: null,
    ttSelected: new Set(),
    currentGrannyEtfHoldings: null,
    currentUpticks: null,
  });
}

describe("resolvePlaySide", () => {
  it("uses an armed Cloud Pivot over HTF sign", () => {
    expect(resolvePlaySide(beLiveShaped())).toBe("LONG");
    expect(playStructureAligned(beLiveShaped(), "LONG")).toBe(true);
    expect(playStructureAligned(beLiveShaped(), "SHORT")).toBe(false);
  });

  it("falls back to a held high-quality weekly ST hold", () => {
    expect(resolvePlaySide({
      st_hold_setup: { best: { held: true, quality: "high", sideLabel: "SHORT" } },
    })).toBe("SHORT");
    expect(resolvePlaySide({
      st_hold_setup: { best: { held: true, tested: true, sideLabel: "LONG" } },
    })).toBe("LONG");
    expect(resolvePlaySide({
      st_hold_setup: { best: { held: true, quality: "low", sideLabel: "LONG" } },
    })).toBeNull();
  });

  it("returns null when no play is armed", () => {
    expect(resolvePlaySide({ htf_score: -20, state: "HTF_BEAR_LTF_BEAR" })).toBeNull();
    expect(resolvePlaySide({ _cloud_pivot_detect: { fires: false, direction: "LONG" } })).toBeNull();
  });
});

describe("scoreContextConviction", () => {
  it("credits quality-A compounder + theme membership for a LONG play", () => {
    const ctx = scoreContextConviction(beLiveShaped(), "LONG");
    expect(ctx.parts).toMatchObject({
      quality: 8,
      growth: 2,
      compounder: 4,
      theme_member: 4,
      value_tilt: 1,
      sentiment: 0,
    });
    expect(ctx.themes).toContain("ai_infra_energy");
    expect(ctx.raw_pts).toBe(19);
    expect(ctx.pts).toBe(CONTEXT_CONVICTION_CAP);
  });

  it("does not reward fading a quality compounder", () => {
    const ctx = scoreContextConviction(beLiveShaped(), "SHORT");
    expect(ctx.parts.quality).toBe(-4);
    expect(ctx.parts.theme_member).toBe(0);
    expect(ctx.parts.value_tilt).toBe(-1);
    expect(ctx.pts).toBe(-5);
  });

  it("treats missing news and stale FV as zero, not a pass", () => {
    expect(scoreContextConviction({ ticker: "XYZ" }, "LONG").pts).toBe(0);
    const stale = scoreContextConviction({
      ticker: "BE",
      _fair_value: { quality_grade: "A", growth_detected: true, tilt: 1, stale: true },
      _compounder: { tier: "growth_elite", eligible: true },
    }, "LONG");
    expect(stale.parts.quality).toBe(0);
    expect(stale.parts.growth).toBeUndefined();
    expect(stale.parts.compounder).toBeUndefined();
    expect(stale.parts.theme_member).toBe(4);
    expect(stale.parts.value_tilt).toBe(0);
    expect(stale.pts).toBe(4);
  });

  it("applies bullish sentiment and S&P-inclusion headlines when news is stamped", () => {
    const news = {
      has_data: true,
      dominant_sentiment: "bullish",
      bullish_catalyst_count: 1,
      top_catalyst: { headline: "Bloom Energy added to the S&P 500" },
    };
    expect(newsLooksLikeIndexInclusion(news)).toBe(true);
    const ctx = scoreContextConviction({
      ticker: "XYZ",
      _news_summary: news,
    }, "LONG");
    expect(ctx.parts.sentiment).toBe(8);
    expect(ctx.parts.index_inclusion).toBe(6);
    expect(ctx.pts).toBe(14);
  });
});

describe("BE live-shaped payload", () => {
  it("infers LONG from Cloud Pivot instead of the HTF_BEAR substring", () => {
    expect(inferSide(beLiveShaped(), "HTF_BEAR_LTF_BEAR")).toBe("LONG");
    expect(inferSide({ ticker: "BE", htf_score: -2.5, state: "HTF_BEAR_LTF_BEAR" }, "HTF_BEAR_LTF_BEAR")).toBe("SHORT");
  });

  it("grades the LONG play at 8/10 (structure+macro+value+officer) and admits Cloud Pivot", () => {
    const d = beLiveShaped();
    const g = evaluateSetupGrade(d, { side: "LONG" });
    expect(g.score).toBe(8);
    expect(g.parts.find((p) => p.id === "structure")).toMatchObject({ points: 2, detail: "armed_play" });
    expect(g.parts.find((p) => p.id === "tape").points).toBe(0);
    expect(g.parts.find((p) => p.id === "macro")).toMatchObject({ points: 2, detail: "theme_member_quality" });
    expect(g.parts.find((p) => p.id === "value")).toMatchObject({ points: 2, source: "fair_value_unsigned" });
    expect(g.parts.find((p) => p.id === "officer").points).toBe(2);
    const admitted = admitSetupGrade(d, { side: "LONG", path: "tt_cloud_pivot_long" });
    expect(admitted.allow).toBe(true);
    expect(admitted.score).toBe(8);
  });

  it("does not pass the same payload as a SHORT fade", () => {
    const d = beLiveShaped();
    const g = evaluateSetupGrade(d, { side: "SHORT" });
    expect(g.parts.find((p) => p.id === "structure").points).toBe(2);
    expect(g.parts.find((p) => p.id === "macro").points).toBe(0);
    expect(g.parts.find((p) => p.id === "value").points).toBe(0);
    expect(g.score).toBeLessThan(6);
    expect(admitSetupGrade(d, { side: "SHORT", path: "tt_cloud_pivot_long" }).allow).toBe(false);
  });

  it("adds context points to conviction and can clear the 80 floor from a 65 tape", () => {
    const tape = beLiveShaped({
      _fair_value: undefined,
      _compounder: undefined,
    });
    delete tape._fair_value;
    delete tape._compounder;
    const technical = convictionOf(tape, { direction: "LONG", sectorRating: "overweight" });
    const full = convictionOf(beLiveShaped(), { direction: "LONG", sectorRating: "overweight" });
    expect(full.breakdown.context.pts).toBe(CONTEXT_CONVICTION_CAP);
    expect(full.score).toBe(technical.score + CONTEXT_CONVICTION_CAP);
    expect(technical.score).toBeLessThan(80);
    expect(full.score).toBeGreaterThanOrEqual(80);
    expect(full.tier).not.toBe("C");
  });

  it("signs rank overlays to the Cloud Pivot play, not HTF_BEAR", () => {
    const play = beLiveShaped();
    play.rank = stampTechnicalRank(play, 70, "v1");
    expect(computeCandidateScore(play, {
      themeMap: { enabled: true, by_ticker: { BE: { tilt: 6, theme: "ai_infra_energy" } } },
    })).toBe(77);
    expect(play._fv_tilt).toBe(1);
    expect(play._theme_tilt).toBe(6);

    const fade = { ticker: "BE", htf_score: -20 };
    fade.rank = stampTechnicalRank(fade, 70, "v1");
    expect(computeCandidateScore(fade, {
      themeMap: { enabled: true, by_ticker: { BE: { tilt: 6, theme: "ai_infra_energy" } } },
    })).toBe(64);
  });
});
