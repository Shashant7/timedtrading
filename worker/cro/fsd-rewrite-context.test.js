import { describe, it, expect } from "vitest";
import {
  payloadTimestampMs,
  pickFreshestPayload,
  overlayLivePrice,
  sanitizePlanLevels,
  buildFreshTickerContext,
  rewriteMetaNeedsRefresh,
  summarizeTickerForPrompt,
  LEVEL_DIVERGE_PCT,
} from "./fsd-rewrite-context.js";

describe("fsd-rewrite-context freshness", () => {
  it("picks the newest payload by timestamp", () => {
    const picked = pickFreshestPayload([
      { source: "snapshot", payload: { price: 374, sl: 373.15, tp: 338.33, ts: 1_000 }, ts: 1_000 },
      { source: "ticker_latest", payload: { price: 320.28, sl: 336.77, tp: 298.13, ingest_ts: 2_000 }, ts: 2_000 },
    ]);
    expect(picked.source).toBe("ticker_latest");
    expect(picked.payload.price).toBe(320.28);
  });

  it("overlays live timed:prices onto a scoring payload", () => {
    const out = overlayLivePrice(
      { price: 374, sl: 373.15, day_change_pct: 0.1 },
      { p: 320.28, dp: -14.2, t: 3_000 },
    );
    expect(out.price).toBe(320.28);
    expect(out._live_price).toBe(320.28);
    expect(out.day_change_pct).toBe(-14.2);
    expect(out.sl).toBe(373.15);
  });

  it("omits plan levels that diverge >12% from live price (TSLA gap case)", () => {
    const { payload, omitted, citeLevels } = sanitizePlanLevels(
      { price: 320.28, sl: 373.15, tp: 338.33, trigger_price: 373.5 },
      { livePx: 320.28, divergePct: LEVEL_DIVERGE_PCT },
    );
    expect(omitted).toEqual(expect.arrayContaining(["stop", "tp", "trigger"]));
    expect(payload.sl).toBeUndefined();
    expect(payload.tp).toBeUndefined();
    expect(payload.trigger_price).toBeUndefined();
    expect(citeLevels).toBe(false);
  });

  it("keeps coherent short-book levels near live price", () => {
    const { payload, citeLevels, omitted } = sanitizePlanLevels(
      { price: 320.28, sl: 336.77, tp: 298.13 },
      { livePx: 320.28 },
    );
    expect(omitted).toEqual([]);
    expect(citeLevels).toBe(true);
    expect(payload.sl).toBe(336.77);
    expect(payload.tp).toBe(298.13);
  });

  it("buildFreshTickerContext prefers live overlay and omits stale snapshot levels", () => {
    const { summary, meta } = buildFreshTickerContext("TSLA", {
      snapshotPayload: {
        price: 374,
        sl: 373.15,
        tp: 338.33,
        trigger_price: 373.5,
        state: "HTF_BEAR_LTF_BEAR",
        kanban_stage: "watch",
        ts: 1,
      },
      snapshotTs: 1,
      latestPayload: {
        price: 320.28,
        sl: 336.77,
        tp: 298.13,
        state: "HTF_BEAR_LTF_BEAR",
        kanban_stage: "watch",
        ingest_ts: 10_000,
      },
      latestTs: 10_000,
      priceRow: { p: 320.28, dp: -14.19, t: 11_000 },
    });
    expect(summary).toContain("TSLA:");
    expect(summary).toContain("px=$320.28");
    expect(summary).toContain("stop=336.77");
    expect(summary).toContain("tp=298.13");
    expect(summary).not.toContain("373.15");
    expect(summary).not.toContain("338.33");
    expect(meta.source).toBe("ticker_latest");
    expect(meta.citeLevels).toBe(true);
  });

  it("when only stale snapshot + live price exist, omits levels and warns LLM", () => {
    const { summary, meta } = buildFreshTickerContext("TSLA", {
      snapshotPayload: {
        price: 374,
        sl: 373.15,
        tp: 338.33,
        trigger_price: 373.5,
        state: "HTF_BEAR_LTF_BEAR",
        ts: 5_000,
      },
      snapshotTs: 5_000,
      priceRow: { p: 320.28, dp: -14.19, t: 11_000 },
    });
    expect(summary).toContain("px=$320.28");
    expect(summary).toMatch(/model levels omitted/i);
    expect(summary).not.toContain("373.15");
    expect(meta.citeLevels).toBe(false);
  });

  it("flags rewrite meta for refresh after 8% px drift", () => {
    expect(rewriteMetaNeedsRefresh({ px: 374 }, 320.28)).toBe(true);
    expect(rewriteMetaNeedsRefresh({ px: 320 }, 322)).toBe(false);
  });

  it("summarizeTickerForPrompt never emits omitted levels", () => {
    const line = summarizeTickerForPrompt("TSLA", {
      price: 320.28,
      state: "HTF_BEAR_LTF_BEAR",
      sl: 373.15, // should be ignored when citeLevels=false
    }, { citeLevels: false, omittedLevels: ["stop"], source: "snapshot" });
    expect(line).not.toContain("stop=");
    expect(line).toContain("stale vs live");
  });

  it("payloadTimestampMs normalizes seconds vs ms", () => {
    expect(payloadTimestampMs({ ts: 1_700_000_000 })).toBe(1_700_000_000_000);
    expect(payloadTimestampMs({ ingest_ts: 1_700_000_000_000 })).toBe(1_700_000_000_000);
  });
});
