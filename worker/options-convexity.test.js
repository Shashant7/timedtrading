// worker/options-convexity.test.js
import { describe, it, expect } from "vitest";
import {
  playClassFromArchetype,
  extractConvexityPlayFromLadder,
  isConvexityPlayActionable,
  toConvexityCard,
  rankConvexityCards,
  convexityFreshTtlMs,
  convexityPlanCopy,
  formatConvexityExpShort,
  buildConvexityShotReason,
} from "./options-convexity.js";
import {
  shouldActivateLotto,
  shouldActivateEarningsPrepLotto,
  isFirstRth4hForming,
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

  it("allows same-day AMC FADE as a put, WAIT while the first 4H is open", () => {
    const beforeClose = Date.parse("2026-08-25T11:00:00-04:00");
    const r = shouldActivateEarningsPrepLotto({
      profile: "speculator",
      confluence: {
        mode: "FADE",
        side: "SHORT",
        timing: { put_opportunity: true },
      },
      contract: {
        price: 670,
        sl: 685,
        direction: "SHORT",
        earnings_dte: 0,
        earnings_hour: "amc",
      },
      tickerData: { state: "HTF_BULL_LTF_PULLBACK", earnings_hour: "amc" },
      now: beforeClose,
    });
    expect(r.activate).toBe(true);
    expect(r.side).toBe("SHORT");
    expect(r.earnings_session).toBe("AMC");
    expect(r.h4_close_pending).toBe(true);
  });

  it("rejects same-day BMO — the print already landed", () => {
    const r = shouldActivateEarningsPrepLotto({
      profile: "speculator",
      confluence: { mode: "READY", side: "LONG", timing: { call_opportunity: true } },
      contract: { price: 100, sl: 95, direction: "LONG", earnings_dte: 0, earnings_hour: "bmo" },
      now: Date.parse("2026-08-25T11:00:00-04:00"),
    });
    expect(r.activate).toBe(false);
    expect(r.reason).toBe("earnings_dte_out_of_window");
  });

  it("clears the 4H pending flag after the 1:30 PM ET close", () => {
    const afterClose = Date.parse("2026-08-25T13:45:00-04:00");
    const r = shouldActivateEarningsPrepLotto({
      profile: "speculator",
      confluence: {
        mode: "FADE",
        side: "SHORT",
        timing: { put_opportunity: true },
      },
      contract: {
        price: 670,
        sl: 685,
        direction: "SHORT",
        earnings_dte: 0,
        earnings_hour: "amc",
      },
      now: afterClose,
    });
    expect(r.activate).toBe(true);
    expect(r.h4_close_pending).toBe(false);
  });
});

describe("isFirstRth4hForming", () => {
  it("is true before the 13:30 ET close and false after", () => {
    expect(isFirstRth4hForming(Date.parse("2026-08-25T11:00:00-04:00"))).toBe(true);
    expect(isFirstRth4hForming(Date.parse("2026-08-25T13:29:00-04:00"))).toBe(true);
    expect(isFirstRth4hForming(Date.parse("2026-08-25T13:30:00-04:00"))).toBe(false);
    expect(isFirstRth4hForming(Date.parse("2026-08-25T15:00:00-04:00"))).toBe(false);
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
  it("surfaces a same-day AMC FADE put and waits on the open 4H", () => {
    const now = Date.parse("2026-08-25T11:00:00-04:00");
    const ladder = buildOptionsLadder({
      ticker: "INTU",
      price: 670,
      direction: "SHORT",
      sl: 685,
      tp1: 640,
      atr_pct: 0.03,
      mode: "trader",
      stage: "swing",
      earnings_dte: 0,
      earnings_hour: "amc",
    }, {
      profile: "speculator",
      now,
      confluence: {
        mode: "FADE",
        side: "SHORT",
        timing: { put_opportunity: true },
      },
      tickerData: {
        ticker: "INTU",
        earnings_dte: 0,
        earnings_hour: "amc",
        state: "HTF_BULL_LTF_PULLBACK",
      },
    });
    const lotto = (ladder.ladder || []).find((p) => p._lotto_active);
    expect(lotto).toBeTruthy();
    expect(lotto._earnings_prep).toBe(true);
    expect(lotto._h4_close_pending).toBe(true);
    expect(lotto.archetype).toBe("lotto_put");
    expect(lotto.expiration?.dte).toBeGreaterThanOrEqual(1);
  });

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

  it("allows FADE earnings-prep put when timing leans short", () => {
    expect(isConvexityPlayActionable({
      play: {
        ...basePlay,
        archetype: "lotto_put",
        _earnings_prep: true,
        _h4_close_pending: true,
        strikes: { primary: 660 },
      },
      play_class: "lotto",
      confluence: {
        mode: "FADE",
        side: "SHORT",
        timing: { put_opportunity: true },
      },
      contract: { direction: "SHORT", sl: 685, atr_pct: 0.03 },
      spot: 670,
      as_of_ms: Date.now(),
    })).toBe(true);
  });

  it("rejects 0 DTE on the convexity strip", () => {
    expect(isConvexityPlayActionable({
      play: { ...basePlay, expiration: { dte: 0, iso: "2026-08-25" } },
      play_class: "lotto",
      confluence: { mode: "RIDE", side: "LONG", timing: { call_opportunity: true } },
      contract: { direction: "LONG", sl: 98, atr_pct: 0.02 },
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

  it("snaps single-name lotto to the next Friday, never 0 DTE", () => {
    const tue = Date.parse("2026-08-25T13:17:00-04:00");
    const exp = pickLottoExpiration("CVX", tue);
    expect(exp.dte).toBeGreaterThanOrEqual(1);
    expect(exp.iso).toBe("2026-08-28");
    expect(exp.dte).toBe(3);
  });

  it("rolls Friday same-day to the next weekly", () => {
    const fri = Date.parse("2026-08-28T10:00:00-04:00");
    const exp = pickLottoExpiration("CVX", fri);
    expect(exp.iso).toBe("2026-09-04");
    expect(exp.dte).toBeGreaterThanOrEqual(1);
  });
});

describe("buildConvexityShotReason", () => {
  it("prefers the earnings catalyst", () => {
    expect(buildConvexityShotReason({
      play: { archetype: "lotto_call", _earnings_prep: true },
      earnings_play: { catalyst: "Earnings AMC Thu Aug 27 · 2d out" },
    })).toBe("Earnings AMC Thu Aug 27 · 2d out");
  });

  it("names floor + call compression on a READY long", () => {
    const why = buildConvexityShotReason({
      play: { archetype: "lotto_call" },
      play_class: "lotto",
      confluence: {
        mode: "READY",
        side: "LONG",
        timing: { call_opportunity: true },
        layers_agreeing: 5,
        st_hold: { held: true, tf: "1H" },
      },
      contract: { direction: "LONG", sl: 198 },
      spot: 203,
      themes: ["Energy"],
    });
    expect(why).toMatch(/READY/i);
    expect(why).toMatch(/floor held/i);
    expect(why).toMatch(/call compression/i);
    expect(why).toMatch(/1H SuperTrend held/);
    expect(why).toMatch(/Energy/);
  });

  it("names the 4H wait on same-day AMC", () => {
    expect(buildConvexityShotReason({
      play: { archetype: "lotto_put", _earnings_prep: true, _h4_close_pending: true },
      earnings_play: { catalyst: "Earnings AMC Tue Aug 25 · today" },
    })).toMatch(/4H still open/);
  });

  it("falls back when confluence is thin", () => {
    expect(buildConvexityShotReason({
      play: { archetype: "lotto_call" },
      play_class: "lotto",
    })).toMatch(/Direction, floor, and timing aligned/);
  });
});

describe("convexityFreshTtlMs", () => {
  it("uses shorter TTL for 0-1 DTE", () => {
    expect(convexityFreshTtlMs(0)).toBeLessThan(convexityFreshTtlMs(7));
  });
});

describe("convexityPlanCopy", () => {
  it("writes AXON lotto in day-trade punch/scan grammar", () => {
    const copy = convexityPlanCopy({
      ticker: "AXON",
      play_class: "lotto",
      direction: "LONG",
      strike: 640,
      expiration: { dte: 1, label: "Aug 24 (1DTE)", iso: "2026-08-24" },
      max_loss_usd: 126,
      top_target_underlying: 642.52,
      premium_mid: 1.26,
      confluence_mode: "DRIFT",
    });
    expect(copy.action).toBe("WAIT");
    expect(copy.flavor).toBe("call");
    expect(copy.punch).toBe("WAIT on AXON 640C Aug 24 (1DTE) — lotto call, premium may go to zero");
    expect(copy.scan).toContain("Risk $126");
    expect(copy.scan).toContain("3x+ @ $642.52");
    expect(copy.scan).toContain("Pay ≤ $1.26");
  });

  it("maps same-day AMC FADE to WAIT while the 4H is open, BUY after", () => {
    const pending = convexityPlanCopy({
      ticker: "INTU",
      play_class: "lotto",
      direction: "SHORT",
      strike: 660,
      expiration: { dte: 3, iso: "2026-08-28" },
      confluence_mode: "FADE",
      earnings_prep: true,
      h4_close_pending: true,
    });
    expect(pending.action).toBe("WAIT");
    expect(pending.flavor).toBe("put");
    expect(pending.punch).toContain("WAIT on INTU 660P");
    expect(pending.punch).toContain("earnings-prep lotto put");

    const after = convexityPlanCopy({
      ticker: "INTU",
      play_class: "lotto",
      direction: "SHORT",
      strike: 660,
      expiration: { dte: 3, iso: "2026-08-28" },
      confluence_mode: "FADE",
      earnings_prep: true,
      h4_close_pending: false,
    });
    expect(after.action).toBe("BUY");
    expect(after.punch).toContain("BUY on INTU 660P");
  });

  it("maps READY to BUY and moonshot put flavor", () => {
    const copy = convexityPlanCopy({
      ticker: "NVDA",
      play_class: "moonshot",
      direction: "SHORT",
      strike: 170,
      expiration: { dte: 7, iso: "2026-08-30" },
      confluence_mode: "READY",
    });
    expect(copy.action).toBe("BUY");
    expect(copy.flavor).toBe("put");
    expect(copy.punch).toContain("BUY on NVDA 170P");
    expect(copy.punch).toContain("moonshot put");
  });

  it("parses expiry labels without iso", () => {
    expect(formatConvexityExpShort({ label: "Aug 24 (1DTE)" })).toBe("Aug 24");
    expect(formatConvexityExpShort({ label: "7DTE" })).toBe("");
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
    expect(card.action).toBe("BUY");
    expect(card.headline).toContain("BUY on AMD 170C");
    expect(card.scan_line).toContain("Risk $200");
  });

  it("stamps h4_close_pending and WAIT on a same-day AMC fade", () => {
    const card = toConvexityCard({
      ticker: "INTU",
      play: {
        archetype: "lotto_put",
        _earnings_prep: true,
        _h4_close_pending: true,
        _earnings_session: "AMC",
        earnings_dte: 0,
        strikes: { primary: 660 },
        expiration: { dte: 3, iso: "2026-08-28" },
        max_loss_usd: 50,
      },
      play_class: "lotto",
      confluence: { mode: "FADE", side: "SHORT", score: 25 },
      contract: { sl: 685, direction: "SHORT" },
      spot: 670,
      as_of_ms: Date.now(),
    });
    expect(card.earnings_prep).toBe(true);
    expect(card.h4_close_pending).toBe(true);
    expect(card.action).toBe("WAIT");
    expect(card.direction).toBe("SHORT");
    expect(card.shot_reason).toMatch(/4H still open/);
    expect(card.rationale_short).toMatch(/1:30 PM ET/);
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
    expect(card.shot_reason).toMatch(/Earnings-prep|Earnings in/i);
  });

  it("stamps a shot_reason on a generic lotto", () => {
    const card = toConvexityCard({
      ticker: "CVX",
      play: {
        archetype: "lotto_call",
        strikes: { primary: 205 },
        expiration: { dte: 3, iso: "2026-08-28" },
        max_loss_usd: 91,
        multi_bagger_targets: { "3x_underlying_at": 206.82 },
      },
      play_class: "lotto",
      confluence: {
        mode: "READY",
        side: "LONG",
        score: 64,
        timing: { call_opportunity: true },
        layers_agreeing: 5,
      },
      contract: { sl: 198, direction: "LONG" },
      spot: 203,
      themes: ["Energy"],
      as_of_ms: Date.now(),
    });
    expect(card.shot_reason).toMatch(/READY/i);
    expect(card.shot_reason).toMatch(/floor held/i);
  });
});
