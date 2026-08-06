// Tests for the context-first Phase 1 shadow pipeline:
// frame digest (worker/frames.js) + armed playbooks (worker/playbooks.js).
// The CAT Weekly-Breakout-Retest miss (2026-08-05) is the reference fixture.
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

function catPayload(price, weekLow) {
  return {
    ticker: "CAT",
    _live_price: price,
    week_low: weekLow,
    day_low: price * 0.99,
    st_support: { W: 810 },
    weekly_bundle: { ema21: 808 },
    tf_tech: {
      W: { low: weekLow, ema: { ema21: 808 } },
      D: { low: price * 0.99, ema: { ema21: 850 } },
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

// ── frames.js ────────────────────────────────────────────────────────────────

describe("classifyAnchorState", () => {
  const base = { level: 808, bandPct: 3.5, approachPct: 8 };

  it("approaching: above the level inside the approach zone, no touch", () => {
    const r = classifyAnchorState({ ...base, price: 860, low: 850 });
    expect(r.state).toBe("approaching");
  });

  it("testing: low touched the band, price still inside it", () => {
    const r = classifyAnchorState({ ...base, price: 815, low: 804.57 });
    expect(r.state).toBe("testing");
    expect(r.touched).toBe(true);
  });

  it("reclaiming: low touched, price bounced back above the band", () => {
    const r = classifyAnchorState({ ...base, price: 876.54, low: 804.57 });
    expect(r.state).toBe("reclaiming");
  });

  it("below: price under the level beyond the band", () => {
    const r = classifyAnchorState({ ...base, price: 750, low: 745 });
    expect(r.state).toBe("below");
  });

  it("above: comfortably above with no touch", () => {
    const r = classifyAnchorState({ ...base, price: 950, low: 930 });
    expect(r.state).toBe("above");
  });
});

describe("buildFrameDigest (CAT)", () => {
  it("resolves anchor levels from payload fields", () => {
    const levels = resolveAnchorLevels(catPayload(876.54, 804.57));
    expect(levels.W_EMA21).toBe(808);
    expect(levels.W_ST).toBe(810);
    expect(levels.D_EMA21).toBe(850);
  });

  it("stamps anchors with ledger memory and journey slope", () => {
    const fd = buildFrameDigest({ td: catPayload(876.54, 804.57), context: catContext, now: NOW });
    expect(fd.anchors.W_EMA21.state).toBe("reclaiming");
    expect(fd.anchors.W_EMA21.respect).toBe(true);
    expect(fd.anchors.W_ST.state).toBe("reclaiming");
    expect(fd.anchors.D_EMA21.respect).toBe(false);
    expect(fd.score_slope_1h).toBe(0.4);
    expect(fd.last_exit_days).toBe(20);
    expect(fd.last_exit_pnl_pct).toBe(12.4);
    expect(fd.median_move_pct).toBe(9.5);
  });

  it("filters recent tests to the optimal window", () => {
    const fd = buildFrameDigest({ td: catPayload(876.54, 804.57), context: catContext, now: NOW });
    // 45-day-old W_ST test falls outside the 30-day window.
    expect(fd.recent_tests).toHaveLength(1);
    expect(fd.recent_tests[0].anchor).toBe("W_EMA21");
    expect(fd.recent_tests[0].resolution).toBe("held");
  });

  it("survives missing context (no anchors memory)", () => {
    const fd = buildFrameDigest({ td: catPayload(860, 850), context: null, now: NOW });
    expect(fd.anchors.W_EMA21.state).toBe("approaching");
    expect(fd.anchors.W_EMA21.respect).toBe(false);
  });
});

// ── playbooks.js ─────────────────────────────────────────────────────────────

function framesFor(price, weekLow, context = catContext) {
  return buildFrameDigest({ td: catPayload(price, weekLow), context, now: NOW });
}

describe("updateArmedPlaybooks (CAT weekly breakout retest)", () => {
  it("arms on approach of a respected weekly anchor, with confluence", () => {
    const { armed, events } = updateArmedPlaybooks({
      frames: framesFor(860, 850), prior: [], now: NOW,
    });
    const wb = armed.find((a) => a.playbook === "weekly_breakout_retest");
    expect(wb).toBeTruthy();
    expect(wb.status).toBe("armed");
    expect(wb.confluence).toBe(true);
    expect(wb.confidence).toBeGreaterThanOrEqual(80);
    expect(events).toHaveLength(0);
  });

  it("triggers a previously armed playbook when the anchor reclaims", () => {
    const cycle1 = updateArmedPlaybooks({ frames: framesFor(860, 850), prior: [], now: NOW - DAY });
    const cycle2 = updateArmedPlaybooks({
      frames: framesFor(876.54, 804.57), prior: cycle1.armed, now: NOW,
    });
    const wb = cycle2.armed.find((a) => a.playbook === "weekly_breakout_retest");
    expect(wb.status).toBe("triggered");
    expect(wb.trigger_price).toBe(876.54);
    const ev = cycle2.events.find((e) => e.playbook === "weekly_breakout_retest");
    expect(ev.kind).toBe("triggered");
    expect(ev.price).toBe(876.54);
  });

  it("arms AND triggers on the same cycle for a fast bounce (the CAT miss)", () => {
    const { armed, events } = updateArmedPlaybooks({
      frames: framesFor(876.54, 804.57), prior: [], now: NOW,
    });
    const wb = armed.find((a) => a.playbook === "weekly_breakout_retest");
    expect(wb.status).toBe("triggered");
    expect(events.some((e) => e.kind === "triggered" && e.playbook === "weekly_breakout_retest")).toBe(true);
  });

  it("does not re-arm during cooldown, re-arms after it lapses", () => {
    const t0 = updateArmedPlaybooks({ frames: framesFor(876.54, 804.57), prior: [], now: NOW });
    // 1 day later — still cooling down, no new arm, no duplicate event.
    const t1 = updateArmedPlaybooks({
      frames: framesFor(876.54, 804.57), prior: t0.armed, now: NOW + DAY,
    });
    expect(t1.events).toHaveLength(0);
    expect(t1.armed.filter((a) => a.playbook === "weekly_breakout_retest")).toHaveLength(1);
    expect(t1.armed[0].status).toBe("triggered");
    // 6 days later — cooldown (5d) lapsed, dormant entry dropped, re-armable.
    const t2 = updateArmedPlaybooks({
      frames: framesFor(876.54, 804.57), prior: t1.armed, now: NOW + 6 * DAY,
    });
    const wb = t2.armed.find((a) => a.playbook === "weekly_breakout_retest");
    expect(wb).toBeTruthy();
  });

  it("invalidates when price loses the anchor deeply", () => {
    const armedCycle = updateArmedPlaybooks({ frames: framesFor(860, 850), prior: [], now: NOW - DAY });
    const { armed, events } = updateArmedPlaybooks({
      frames: framesFor(750, 745), prior: armedCycle.armed, now: NOW,
    });
    const wb = armed.find((a) => a.playbook === "weekly_breakout_retest");
    expect(wb.status).toBe("invalidated");
    expect(events.some((e) => e.kind === "invalidated")).toBe(true);
  });

  it("expires an armed playbook past its TTL", () => {
    const armedCycle = updateArmedPlaybooks({ frames: framesFor(860, 850), prior: [], now: NOW });
    const ttlMs = PLAYBOOK_DEFS.weekly_breakout_retest.ttlDays * DAY;
    const { armed, events } = updateArmedPlaybooks({
      frames: framesFor(862, 852), prior: armedCycle.armed, now: NOW + ttlMs + DAY,
    });
    const wb = armed.find((a) => a.playbook === "weekly_breakout_retest");
    expect(wb.status).toBe("expired");
    expect(events).toHaveLength(0);
  });

  it("does not arm without ledger memory", () => {
    const noMemory = {
      ...catContext,
      anchors: { W_EMA21: { tested: 1, held: 0, failed: 1, respect: false } },
    };
    const { armed } = updateArmedPlaybooks({
      frames: framesFor(860, 850, noMemory), prior: [], now: NOW,
    });
    expect(armed.find((a) => a.playbook === "weekly_breakout_retest")).toBeUndefined();
  });

  it("daily_ema21_reclaim requires the respect flag", () => {
    // D_EMA21 at 850, price approaching, but respect=false in CAT context.
    const { armed } = updateArmedPlaybooks({
      frames: framesFor(876.54, 870), prior: [], now: NOW,
    });
    expect(armed.find((a) => a.playbook === "daily_ema21_reclaim")).toBeUndefined();
    // Grant respect → arms.
    const respectCtx = {
      ...catContext,
      anchors: { ...catContext.anchors, D_EMA21: { tested: 4, held: 3, failed: 0, respect: true } },
    };
    const r2 = updateArmedPlaybooks({
      frames: framesFor(876.54, 870, respectCtx), prior: [], now: NOW,
    });
    expect(r2.armed.find((a) => a.playbook === "daily_ema21_reclaim")).toBeTruthy();
  });
});
