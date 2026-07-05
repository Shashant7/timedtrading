// worker/rotation-shadow.test.js — C4: overlay + journey → would-be actions.

import { describe, it, expect } from "vitest";
import {
  overlayStanceFor,
  computeShadowActionForPosition,
  computeRotationShadow,
} from "./rotation-shadow.js";

const HOOKS = {
  getSectorForTicker: (sym) => ({ NVDA: "Technology", AMD: "Technology", XOM: "Energy", MSFT: "Technology" }[sym] || null),
  getThemesForTicker: (sym) => ({ NVDA: ["Semiconductors", "AI"], AMD: ["Semiconductors"], MSFT: ["Software", "Mag 7"] }[sym] || []),
};

function overlay(overrides = {}) {
  return {
    proposal_id: "prop-semis-1",
    tactical_overlay: "Semis stalling; rotate into Mag 7 and software",
    theme_notes: [{ theme: "Semiconductors", tactical_note: "stalling, expect profit taking, further weakness ahead" }],
    sector_notes: [],
    sector_stance_changes: [],
    theme_stance_changes: [],
    tactical_signals: [],
    ...overrides,
  };
}

function latestWith(direction, price = 100) {
  return {
    price, _live_price: price,
    _journey: { features: { direction } },
  };
}

describe("overlayStanceFor", () => {
  it("explicit stance changes win", () => {
    const ov = overlay({ theme_stance_changes: [{ theme: "Semiconductors", new_stance: "underweight" }] });
    expect(overlayStanceFor(ov, "Semiconductors").stance).toBe("underweight");
  });

  it("bearish tactical notes register as bearish_note", () => {
    expect(overlayStanceFor(overlay(), "Semiconductors").stance).toBe("bearish_note");
  });

  it("unmentioned names are none; benign notes are none", () => {
    expect(overlayStanceFor(overlay(), "Energy").stance).toBe("none");
    const benign = overlay({ theme_notes: [{ theme: "Software", tactical_note: "constructive setup, leadership broadening" }] });
    expect(overlayStanceFor(benign, "Software").stance).toBe("none");
  });
});

describe("computeShadowActionForPosition — the decision matrix", () => {
  const basePos = { ticker: "NVDA", lane: "trader", direction: "LONG", entryPrice: 100 };

  it("deteriorating + in profit → TIGHTEN_SL_PROFIT_LOCK (high)", () => {
    const act = computeShadowActionForPosition(basePos, latestWith("deteriorating", 120), overlay(), HOOKS);
    expect(act.action).toBe("TIGHTEN_SL_PROFIT_LOCK");
    expect(act.urgency).toBe("high");
    expect(act.matched.name).toBe("Semiconductors");
    expect(act.pnl_pct).toBe(20);
  });

  it("deteriorating + under BE → TRIM_OR_EXIT_REVIEW (high)", () => {
    const act = computeShadowActionForPosition(basePos, latestWith("deteriorating", 95), overlay(), HOOKS);
    expect(act.action).toBe("TRIM_OR_EXIT_REVIEW");
  });

  it("improving + in profit → TIGHTEN_SL_BREAKEVEN (medium)", () => {
    const act = computeShadowActionForPosition(basePos, latestWith("improving", 115), overlay(), HOOKS);
    expect(act.action).toBe("TIGHTEN_SL_BREAKEVEN");
    expect(act.urgency).toBe("medium");
  });

  it("flat + under BE → investor HEDGE_REVIEW / trader WATCH_CLOSE", () => {
    const inv = computeShadowActionForPosition({ ...basePos, lane: "investor" }, latestWith("flat", 98), overlay(), HOOKS);
    expect(inv.action).toBe("HEDGE_REVIEW");
    const trd = computeShadowActionForPosition(basePos, latestWith("flat", 98), overlay(), HOOKS);
    expect(trd.action).toBe("WATCH_CLOSE");
  });

  it("position outside the flagged sector/theme → no action", () => {
    const act = computeShadowActionForPosition({ ...basePos, ticker: "XOM" }, latestWith("deteriorating", 90), overlay(), HOOKS);
    expect(act).toBeNull();
  });

  it("SHORT aligned with the bearish call → no action", () => {
    const act = computeShadowActionForPosition({ ...basePos, direction: "SHORT" }, latestWith("deteriorating", 90), overlay(), HOOKS);
    expect(act).toBeNull();
  });

  it("sector underweight stance also triggers (scope=sector)", () => {
    const ov = overlay({
      theme_notes: [],
      sector_stance_changes: [{ sector: "Technology", new_stance: "underweight", rationale_short: "rate risk" }],
    });
    const act = computeShadowActionForPosition(basePos, latestWith("flat", 110), ov, HOOKS);
    expect(act.action).toBe("TIGHTEN_SL_BREAKEVEN");
    expect(act.matched).toEqual({ scope: "sector", name: "Technology", stance: "underweight", source: "sector_stance" });
  });
});

describe("computeRotationShadow — full pass", () => {
  it("acts on flagged positions only; MSFT (software) untouched by a semis call", () => {
    const positions = [
      { ticker: "NVDA", lane: "trader", direction: "LONG", entryPrice: 100 },
      { ticker: "AMD", lane: "investor", direction: "LONG", entryPrice: 200 },
      { ticker: "MSFT", lane: "investor", direction: "LONG", entryPrice: 400 },
    ];
    const latestBySym = {
      NVDA: latestWith("deteriorating", 118),
      AMD: latestWith("flat", 190),
      MSFT: latestWith("improving", 460),
    };
    const { actions, overlay_ref } = computeRotationShadow(positions, latestBySym, overlay(), Date.now(), HOOKS);
    expect(overlay_ref).toBe("prop-semis-1");
    expect(actions.map((a) => `${a.ticker}:${a.action}`)).toEqual([
      "NVDA:TIGHTEN_SL_PROFIT_LOCK",
      "AMD:HEDGE_REVIEW",
    ]);
  });

  it("no overlay → no actions", () => {
    expect(computeRotationShadow([{ ticker: "NVDA" }], {}, null).actions).toEqual([]);
  });
});
