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
  pickLottoExpiration,
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
});

describe("rankConvexityCards", () => {
  it("ranks moonshot before lotto", () => {
    const ranked = rankConvexityCards([
      { play_class: "lotto", confluence_score: 90 },
      { play_class: "moonshot", confluence_score: 40 },
    ]);
    expect(ranked[0].play_class).toBe("moonshot");
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
});
