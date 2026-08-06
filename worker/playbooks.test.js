// Tests for the context-first Phase 1 shadow pipeline:
// frame digest (worker/frames.js) + armed playbooks (worker/playbooks.js).
// The CAT Weekly-Breakout-Retest miss (2026-08-05) is the reference fixture.
// Revised after the 2026-08-06 day-1 shadow session: states are static,
// triggers are transitions, invalidation is a deep fixed level.
import { describe, it, expect } from "vitest";
import {
  buildFrameDigest,
  classifyAnchorState,
  resolveAnchorLevels,
} from "./frames.js";
import { updateArmedPlaybooks, PLAYBOOK_DEFS } from "./playbooks.js";

const DAY = 86400000;
const NOW = Date.UTC(2026, 7, 6, 14, 0, 0);

// ── CAT fixture ─────────────────────────────────────────────────────────────
// Weekly EMA21 ~808, Weekly ST ~810. The August week: low 804.57 tested both,
// price bounced to 876. Ledger memory says both weekly anchors have respect.

function catPayload(price) {
  return {
    ticker: "CAT",
    _live_price: price,
    st_support: { W: 810 },
    weekly_bundle: { ema21: 808 },
    tf_tech: {
      W: { ema: { ema21: 808 } },
      D: { ema: { ema21: 850 } },
    },
    _journey: {
      features: { score_slope_1h: 0.4, score_slope_1d: 1.1, direction: "improving" },
    },
  };
}

const catContext = {
  v: 1,
  ticker: "CAT",
  updated: NOW - 3600000,
  window_days: 30,
  leadin_days: 5,
  anchors: {
    W_EMA21: { tested: 3, held: 3, failed: 0, respect: true },
    W_ST: { tested: 2, held: 2, failed: 0, respect: true },
    D_EMA21: { tested: 4, held: 2, failed: 1, respect: false },
  },
  last_entry: { ts: NOW - 40 * DAY, lane: "investor", price: 700 },
  last_exit: { ts: NOW - 20 * DAY, lane: "investor", price: 820, pnl_pct: 12.4 },
  recent_tests: [
    { anchor: "W_EMA21", ts: NOW - 4 * DAY, level: 808, resolution: "held" },
    { anchor: "W_ST", ts: NOW - 45 * DAY, level: 790, resolution: "held" },
  ],
  moves: { n: 6, median_pct: 9.5 },
};

// Same context but with NO fresh ledger test (outside freshTestDays).
const staleTestContext = {
  ...catContext,
  recent_tests: [
    { anchor: "W_EMA21", ts: NOW - 25 * DAY, level: 808, resolution: "held" },
  ],
};

// ── frames.js ────────────────────────────────────────────────────────────────

describe("classifyAnchorState (static states)", () => {
  const base = { level: 808, bandPct: 3.5, approachPct: 8 };

  it("approaching: above the level inside the approach zone", () => {
    expect(classifyAnchorState({ ...base, price: 860 }).state).toBe("approaching");
  });

  it("testing: price inside the band around the level (above or below)", () => {
    expect(classifyAnchorState({ ...base, price: 815 }).state).toBe("testing");
    expect(classifyAnchorState({ ...base, price: 790 }).state).toBe("testing");
  });

  it("above: past the approach zone", () => {
    expect(classifyAnchorState({ ...base, price: 876.54 }).state).toBe("above");
    expect(classifyAnchorState({ ...base, price: 950 }).state).toBe("above");
  });

  it("below: under the level beyond the band", () => {
    expect(classifyAnchorState({ ...base, price: 750 }).state).toBe("below");
  });
});

describe("buildFrameDigest (CAT)", () => {
  it("resolves anchor levels from payload fields", () => {
    const levels = resolveAnchorLevels(catPayload(876.54));
    expect(levels.W_EMA21).toBe(808);
    expect(levels.W_ST).toBe(810);
    expect(levels.D_EMA21).toBe(850);
  });

  it("stamps anchors with ledger memory and journey slope", () => {
    const fd = buildFrameDigest({ td: catPayload(876.54), context: catContext, now: NOW });
    expect(fd.anchors.W_EMA21.state).toBe("above");
    expect(fd.anchors.W_EMA21.respect).toBe(true);
    expect(fd.anchors.D_EMA21.state).toBe("approaching");
    expect(fd.anchors.D_EMA21.respect).toBe(false);
    expect(fd.score_slope_1h).toBe(0.4);
    expect(fd.last_exit_days).toBe(20);
    expect(fd.last_exit_pnl_pct).toBe(12.4);
    expect(fd.median_move_pct).toBe(9.5);
  });

  it("filters recent tests to the optimal window", () => {
    const fd = buildFrameDigest({ td: catPayload(876.54), context: catContext, now: NOW });
    // 45-day-old W_ST test falls outside the 30-day window.
    expect(fd.recent_tests).toHaveLength(1);
    expect(fd.recent_tests[0].anchor).toBe("W_EMA21");
    expect(fd.recent_tests[0].resolution).toBe("held");
  });

  it("survives missing context (no anchors memory)", () => {
    const fd = buildFrameDigest({ td: catPayload(860), context: null, now: NOW });
    expect(fd.anchors.W_EMA21.state).toBe("approaching");
    expect(fd.anchors.W_EMA21.respect).toBe(false);
  });
});

// ── playbooks.js ─────────────────────────────────────────────────────────────

function framesFor(price, context = catContext) {
  return buildFrameDigest({ td: catPayload(price), context, now: NOW });
}

describe("updateArmedPlaybooks (CAT weekly breakout retest)", () => {
  it("arms on approach of a respected weekly anchor, with confluence", () => {
    const { armed, events } = updateArmedPlaybooks({
      frames: framesFor(860, staleTestContext), prior: [], now: NOW,
    });
    const wb = armed.find((a) => a.playbook === "weekly_breakout_retest");
    expect(wb).toBeTruthy();
    expect(wb.status).toBe("armed");
    expect(wb.confluence).toBe(true);
    expect(wb.confidence).toBeGreaterThanOrEqual(80);
    expect(wb.invalidation_level).toBeCloseTo(808 * 0.92, 1);
    expect(events).toHaveLength(0);
  });

  it("triggers on the reclaim TRANSITION (testing → approaching)", () => {
    const c1 = updateArmedPlaybooks({ frames: framesFor(815, staleTestContext), prior: [], now: NOW - DAY });
    expect(c1.armed.find((a) => a.playbook === "weekly_breakout_retest").last_state).toBe("testing");
    const c2 = updateArmedPlaybooks({
      frames: framesFor(850, staleTestContext), prior: c1.armed, now: NOW,
    });
    const wb = c2.armed.find((a) => a.playbook === "weekly_breakout_retest");
    expect(wb.status).toBe("triggered");
    expect(wb.trigger_price).toBe(850);
    const ev = c2.events.find((e) => e.playbook === "weekly_breakout_retest");
    expect(ev.kind).toBe("triggered");
    expect(ev.armed_ts).toBe(NOW - DAY);
  });

  it("a routine band breach does NOT invalidate; the later reclaim triggers", () => {
    // Arm at approach → dip to -4.7% (state testing, above the deep
    // invalidation level) → reclaim. Day-1 bug: this dip stood the
    // playbook down; it is exactly the dip a retest play waits through.
    const c1 = updateArmedPlaybooks({ frames: framesFor(860, staleTestContext), prior: [], now: NOW - 2 * DAY });
    const c2 = updateArmedPlaybooks({ frames: framesFor(770, staleTestContext), prior: c1.armed, now: NOW - DAY });
    const wb2 = c2.armed.find((a) => a.playbook === "weekly_breakout_retest");
    expect(wb2.status).toBe("armed");
    expect(c2.events).toHaveLength(0);
    const c3 = updateArmedPlaybooks({ frames: framesFor(850, staleTestContext), prior: c2.armed, now: NOW });
    const wb3 = c3.armed.find((a) => a.playbook === "weekly_breakout_retest");
    expect(wb3.status).toBe("triggered");
  });

  it("arms AND triggers same-cycle on a fast bounce with a fresh ledger test (the CAT miss)", () => {
    // Price already above the band (876.54 ⇒ state above) + a held
    // W_EMA21 test 4 days ago in the ledger ⇒ immediate trigger.
    const { armed, events } = updateArmedPlaybooks({
      frames: framesFor(876.54, catContext), prior: [], now: NOW,
    });
    const wb = armed.find((a) => a.playbook === "weekly_breakout_retest");
    expect(wb.status).toBe("triggered");
    expect(events.some((e) => e.kind === "triggered" && e.playbook === "weekly_breakout_retest")).toBe(true);
  });

  it("no immediate trigger without a fresh ledger test", () => {
    const { armed } = updateArmedPlaybooks({
      frames: framesFor(876.54, staleTestContext), prior: [], now: NOW,
    });
    // State "above" is not an arm state and the ledger test is 25d old.
    expect(armed.find((a) => a.playbook === "weekly_breakout_retest")).toBeUndefined();
  });

  it("does not re-arm during cooldown, re-arms after it lapses", () => {
    const t0 = updateArmedPlaybooks({ frames: framesFor(876.54, catContext), prior: [], now: NOW });
    const t1 = updateArmedPlaybooks({
      frames: framesFor(876.54, catContext), prior: t0.armed, now: NOW + DAY,
    });
    expect(t1.events).toHaveLength(0);
    expect(t1.armed.filter((a) => a.playbook === "weekly_breakout_retest")).toHaveLength(1);
    expect(t1.armed[0].status).toBe("triggered");
    // 6 days later — cooldown (5d) lapsed, dormant entry dropped, re-armable.
    // (stale-test context: otherwise the still-fresh ledger test would
    // legitimately arm-and-trigger again on the same cycle)
    const t2 = updateArmedPlaybooks({
      frames: framesFor(860, staleTestContext), prior: t1.armed, now: NOW + 6 * DAY,
    });
    const wb = t2.armed.find((a) => a.playbook === "weekly_breakout_retest");
    expect(wb).toBeTruthy();
    expect(wb.status).toBe("armed");
  });

  it("invalidates only below the DEEP level (−8% weekly)", () => {
    const armedCycle = updateArmedPlaybooks({ frames: framesFor(860, staleTestContext), prior: [], now: NOW - DAY });
    // −5.4% (state below) but ABOVE 743.36 ⇒ still armed.
    const mild = updateArmedPlaybooks({
      frames: framesFor(764, staleTestContext), prior: armedCycle.armed, now: NOW,
    });
    expect(mild.armed.find((a) => a.playbook === "weekly_breakout_retest").status).toBe("armed");
    expect(mild.events).toHaveLength(0);
    // 740 < 808×0.92 = 743.36 ⇒ invalidated.
    const deep = updateArmedPlaybooks({
      frames: framesFor(740, staleTestContext), prior: armedCycle.armed, now: NOW,
    });
    expect(deep.armed.find((a) => a.playbook === "weekly_breakout_retest").status).toBe("invalidated");
    expect(deep.events.some((e) => e.kind === "invalidated")).toBe(true);
  });

  it("expires an armed playbook past its TTL", () => {
    const armedCycle = updateArmedPlaybooks({ frames: framesFor(860, staleTestContext), prior: [], now: NOW });
    const ttlMs = PLAYBOOK_DEFS.weekly_breakout_retest.ttlDays * DAY;
    const { armed, events } = updateArmedPlaybooks({
      frames: framesFor(862, staleTestContext), prior: armedCycle.armed, now: NOW + ttlMs + DAY,
    });
    expect(armed.find((a) => a.playbook === "weekly_breakout_retest").status).toBe("expired");
    expect(events).toHaveLength(0);
  });

  it("does not arm without ledger memory", () => {
    const noMemory = {
      ...staleTestContext,
      anchors: { W_EMA21: { tested: 1, held: 0, failed: 1, respect: false } },
    };
    const { armed } = updateArmedPlaybooks({
      frames: framesFor(860, noMemory), prior: [], now: NOW,
    });
    expect(armed.find((a) => a.playbook === "weekly_breakout_retest")).toBeUndefined();
  });

  it("daily_ema21_reclaim requires the respect flag", () => {
    // D_EMA21 at 850, price 876.54 ⇒ approaching, but respect=false.
    const { armed } = updateArmedPlaybooks({
      frames: framesFor(876.54, staleTestContext), prior: [], now: NOW,
    });
    expect(armed.find((a) => a.playbook === "daily_ema21_reclaim")).toBeUndefined();
    const respectCtx = {
      ...staleTestContext,
      anchors: { ...staleTestContext.anchors, D_EMA21: { tested: 4, held: 3, failed: 0, respect: true } },
    };
    const r2 = updateArmedPlaybooks({
      frames: framesFor(876.54, respectCtx), prior: [], now: NOW,
    });
    const db = r2.armed.find((a) => a.playbook === "daily_ema21_reclaim");
    expect(db).toBeTruthy();
    expect(db.status).toBe("armed");
    expect(db.invalidation_level).toBeCloseTo(850 * 0.94, 1);
  });

  it("daily reclaim armed below does not instantly invalidate (day-1 flood)", () => {
    // Price 810 vs D EMA21 850 ⇒ −4.7% ⇒ state below; arm state allows it,
    // and 810 > 799 (−6% invalidation) so it must STAY armed next cycle.
    const respectCtx = {
      ...staleTestContext,
      anchors: { ...staleTestContext.anchors, D_EMA21: { tested: 4, held: 3, failed: 0, respect: true } },
    };
    const c1 = updateArmedPlaybooks({ frames: framesFor(810, respectCtx), prior: [], now: NOW - DAY });
    const db1 = c1.armed.find((a) => a.playbook === "daily_ema21_reclaim");
    expect(db1.status).toBe("armed");
    expect(db1.armed_state).toBe("below");
    const c2 = updateArmedPlaybooks({ frames: framesFor(810, respectCtx), prior: c1.armed, now: NOW });
    expect(c2.armed.find((a) => a.playbook === "daily_ema21_reclaim").status).toBe("armed");
    expect(c2.events).toHaveLength(0);
    // Reclaim: 810 → 880 (+3.5% above the daily EMA ⇒ approaching) triggers.
    const c3 = updateArmedPlaybooks({ frames: framesFor(880, respectCtx), prior: c2.armed, now: NOW + DAY });
    expect(c3.armed.find((a) => a.playbook === "daily_ema21_reclaim").status).toBe("triggered");
  });
});
