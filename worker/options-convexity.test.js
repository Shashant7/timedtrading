// worker/options-convexity.test.js
import { describe, it, expect } from "vitest";
import {
  playClassFromArchetype,
  extractConvexityPlayFromLadder,
  isConvexityPlayActionable,
  toConvexityCard,
  rankConvexityCards,
  convexityFreshTtlMs,
} from "./options-convexity.js";
import {
  shouldActivateLotto,
  shouldActivateEarningsPrepLotto,
  detectMomentumInMotion,
  pickLottoExpiration,
  lookupLETF,
  buildOptionsLadder,
} from "./options-plays.js";

describe("playClassFromArchetype", () => {
  it("maps lotto and moonshot archetypes", () => {
    expect(playClassFromArchetype("lotto_call")).toBe("lotto");
    expect(playClassFromArchetype("moonshot_put")).toBe("moonshot");
    expect(playClassFromArchetype("long_call")).toBe(null);
  });
});

describe("extractConvexityPlayFromLadder", () => {
  it("prefers moonshot over lotto", () => {
    const ladder = {
      ladder: [
        { archetype: "lotto_call", _lotto_active: true },
        { archetype: "moonshot_call", _moonshot_active: true },
      ],
    };
    const ex = extractConvexityPlayFromLadder(ladder);
    expect(ex.play_class).toBe("moonshot");
  });
});

describe("shouldActivateLotto", () => {
  it("activates on READY with compression timing", () => {
    const r = shouldActivateLotto({
      profile: "speculator",
      confluence: {
        mode: "READY",
        side: "LONG",
        timing: { call_opportunity: true },
      },
      contract: { price: 100, sl: 95, direction: "LONG" },
    });
    expect(r.activate).toBe(true);
  });

  it("rejects READY without floor or timing", () => {
    const r = shouldActivateLotto({
      profile: "speculator",
      confluence: { mode: "READY", side: "LONG", timing: {} },
      contract: { price: 90, sl: 95, direction: "LONG" },
    });
    expect(r.activate).toBe(false);
  });
});

describe("shouldActivateEarningsPrepLotto", () => {
  it("activates on READY with floor into a 1–5d earnings window", () => {
    const r = shouldActivateEarningsPrepLotto({
      profile: "speculator",
      confluence: { mode: "READY", side: "LONG", timing: {} },
      contract: { price: 100, sl: 95, direction: "LONG", earnings_dte: 3 },
      tickerData: { state: "HTF_BULL_LTF_PULLBACK" },
    });
    expect(r.activate).toBe(true);
    expect(r.earnings_prep).toBe(true);
    expect(r.earnings_dte).toBe(3);
  });

  it("allows WAIT when floor is held (pre-catalyst hesitation)", () => {
    const r = shouldActivateEarningsPrepLotto({
      profile: "speculator",
      confluence: { mode: "WAIT", side: "LONG", timing: {} },
      contract: { price: 100, sl: 95, direction: "LONG", earnings_dte: 2 },
    });
    expect(r.activate).toBe(true);
  });

  it("rejects outside earnings window", () => {
    const r = shouldActivateEarningsPrepLotto({
      profile: "speculator",
      confluence: { mode: "READY", side: "LONG", timing: { call_opportunity: true } },
      contract: { price: 100, sl: 95, direction: "LONG", earnings_dte: 12 },
    });
    expect(r.activate).toBe(false);
  });
});

describe("detectMomentumInMotion — reclaim override", () => {
  it("allows decisive day reclaim against a 5d pullback", () => {
    const m = detectMomentumInMotion({
      day_change_pct: 4.5,
      fiveDayChangePct: -6,
    });
    expect(m.in_motion).toBe(true);
    expect(m.direction).toBe("LONG");
    expect(m.reclaim_override).toBe(true);
  });

  it("still rejects mild day/5d disagree", () => {
    const m = detectMomentumInMotion({
      day_change_pct: 3.2,
      fiveDayChangePct: -5.5,
    });
    expect(m.in_motion).toBe(false);
    expect(m.reason).toMatch(/whipsaw/);
  });
});

describe("lookupLETF AEHR", () => {
  it("maps AEHR → AEHG", () => {
    expect(lookupLETF("AEHR")?.long).toBe("AEHG");
  });
});

describe("buildOptionsLadder — earnings prep lotto under WAIT", () => {
  it("surfaces advisory lotto when earnings are near and floor held", () => {
    const ladder = buildOptionsLadder({
      ticker: "AEHR",
      price: 30,
      direction: "LONG",
      sl: 27,
      tp1: 36,
      atr_pct: 0.05,
      mode: "trader",
      stage: "swing",
      earnings_dte: 2,
    }, {
      profile: "speculator",
      confluence: { mode: "WAIT", side: "LONG", timing: {} },
      tickerData: { ticker: "AEHR", earnings_dte: 2, state: "HTF_BULL_LTF_PULLBACK" },
    });
    const lotto = (ladder.ladder || []).find((p) => p._lotto_active);
    expect(lotto).toBeTruthy();
    expect(lotto._earnings_prep).toBe(true);
  });
});

describe("isConvexityPlayActionable", () => {
  const basePlay = {
    archetype: "lotto_call",
    expiration: { dte: 1 },
    strikes: { primary: 101 },
    max_loss_usd: 50,
    premium: { mid: 0.5 },
  };

  it("passes aligned lotto with valid strike drift", () => {
    expect(isConvexityPlayActionable({
      play: basePlay,
      play_class: "lotto",
      confluence: { mode: "RIDE", side: "LONG", timing: { call_opportunity: true } },
      contract: { direction: "LONG", sl: 98, atr_pct: 0.02 },
      spot: 100,
      chain_status: "not_attempted",
      as_of_ms: Date.now(),
    })).toBe(true);
  });

  it("fails direction mismatch", () => {
    expect(isConvexityPlayActionable({
      play: basePlay,
      play_class: "lotto",
      confluence: { mode: "RIDE", side: "SHORT" },
      contract: { direction: "SHORT", sl: 105 },
      spot: 100,
      as_of_ms: Date.now(),
    })).toBe(false);
  });

  it("allows WAIT earnings-prep lotto when floor is held", () => {
    expect(isConvexityPlayActionable({
      play: { ...basePlay, _earnings_prep: true },
      play_class: "lotto",
      confluence: { mode: "WAIT", side: "LONG" },
      contract: { direction: "LONG", sl: 98, atr_pct: 0.03 },
      spot: 100,
      as_of_ms: Date.now(),
    })).toBe(true);
  });
});

describe("rankConvexityCards", () => {
  it("ranks moonshot before lotto", () => {
    const ranked = rankConvexityCards([
      { play_class: "lotto", confluence_score: 90 },
      { play_class: "moonshot", confluence_score: 40 },
    ]);
    expect(ranked[0].play_class).toBe("moonshot");
  });

  it("ranks earnings-prep lotto ahead of generic lotto", () => {
    const ranked = rankConvexityCards([
      { play_class: "lotto", confluence_score: 80, earnings_prep: false },
      { play_class: "lotto", confluence_score: 50, earnings_prep: true },
    ]);
    expect(ranked[0].earnings_prep).toBe(true);
  });
});

describe("pickLottoExpiration", () => {
  it("uses day trade picker for SPY", () => {
    const exp = pickLottoExpiration("SPY");
    expect(exp.dte === 0 || exp.dte === 1).toBe(true);
  });
});

describe("convexityFreshTtlMs", () => {
  it("uses shorter TTL for 0-1 DTE", () => {
    expect(convexityFreshTtlMs(0)).toBeLessThan(convexityFreshTtlMs(7));
  });
});

describe("toConvexityCard", () => {
  it("builds API card shape", () => {
    const card = toConvexityCard({
      ticker: "AMD",
      play: {
        archetype: "moonshot_call",
        strikes: { primary: 170 },
        expiration: { dte: 7, label: "7DTE" },
        max_loss_usd: 200,
        multi_bagger_targets: { "3x_underlying_at": 180 },
        label: "Moonshot",
      },
      play_class: "moonshot",
      confluence: { mode: "RIDE", score: 72 },
      contract: { sl: 160 },
      spot: 165,
      as_of_ms: Date.now(),
    });
    expect(card.ticker).toBe("AMD");
    expect(card.play_class).toBe("moonshot");
    expect(card.stop_level).toBe(160);
  });

  it("flags earnings_prep on cards", () => {
    const card = toConvexityCard({
      ticker: "AEHR",
      play: {
        archetype: "lotto_call",
        _earnings_prep: true,
        strikes: { primary: 32 },
        expiration: { dte: 2 },
        max_loss_usd: 50,
        label: "Earnings Prep Lotto",
      },
      play_class: "lotto",
      confluence: { mode: "WAIT", score: 40 },
      contract: { sl: 27 },
      spot: 30,
      as_of_ms: Date.now(),
    });
    expect(card.earnings_prep).toBe(true);
    expect(card.rationale_short).toMatch(/Earnings-prep/i);
  });
});
