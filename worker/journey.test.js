// worker/journey.test.js — snapshot-chain contract (Phase C1+C2).

import { describe, it, expect } from "vitest";
import {
  buildKeyframe,
  shouldAppendKeyframe,
  computeJourneyFeatures,
  updateJourney,
  persistKeyframes,
  readKeyframes,
  purgeOldKeyframes,
  KEYFRAME_RETENTION_MS,
} from "./journey.js";

const T0 = Date.parse("2026-07-06T13:35:00Z");
const MIN = 60 * 1000;

function payload(overrides = {}) {
  return {
    ticker: "SPY",
    price: 600, _live_price: 600.5,
    score: 72, rank: 72,
    htf_score: 18.4, ltf_score: 6.2,
    state: "HTF_BULL_LTF_BULL",
    kanban_stage: "watch",
    phase_pct: 0.31, completion: 0.42,
    _freshness: { grade: "FRESH", enforced: true },
    ...overrides,
  };
}

describe("buildKeyframe", () => {
  it("captures the compact frame incl. the trajectory cell", () => {
    const kf = buildKeyframe(payload(), T0);
    expect(kf.t).toBe(T0);
    expect(kf.px).toBe(600.5);
    expect(kf.sc).toBe(72);
    expect(kf.st).toBe("HTF_BULL_LTF_BULL");
    expect(kf.kb).toBe("watch");
    // Same vocabulary as trade trajectories: state|decile|completion|phase
    expect(kf.cell).toMatch(/^B\|D\d\|C\d\|P\d$/);
    expect(kf.fg).toBe("FRESH");
  });

  it("neutral states still produce a cell (skipNeutral=false)", () => {
    const kf = buildKeyframe(payload({ state: "NEUTRAL" }), T0);
    expect(kf.cell).toMatch(/^N\|/);
  });
});

describe("shouldAppendKeyframe", () => {
  const base = () => buildKeyframe(payload(), T0);

  it("always appends the first frame", () => {
    expect(shouldAppendKeyframe(null, base())).toBe(true);
  });

  it("suppresses a no-change tick inside the heartbeat window", () => {
    const next = buildKeyframe(payload(), T0 + 5 * MIN);
    expect(shouldAppendKeyframe(base(), next)).toBe(false);
  });

  it("appends on the 30-min heartbeat even without change", () => {
    const next = buildKeyframe(payload(), T0 + 31 * MIN);
    expect(shouldAppendKeyframe(base(), next)).toBe(true);
  });

  it("appends on stage / state / cell change and score jumps >= 5", () => {
    expect(shouldAppendKeyframe(base(), buildKeyframe(payload({ kanban_stage: "enter" }), T0 + 5 * MIN))).toBe(true);
    expect(shouldAppendKeyframe(base(), buildKeyframe(payload({ state: "HTF_BULL_LTF_PULLBACK" }), T0 + 5 * MIN))).toBe(true);
    expect(shouldAppendKeyframe(base(), buildKeyframe(payload({ score: 78 }), T0 + 5 * MIN))).toBe(true);
    expect(shouldAppendKeyframe(base(), buildKeyframe(payload({ score: 74 }), T0 + 5 * MIN))).toBe(false);
  });
});

describe("updateJourney + computeJourneyFeatures", () => {
  it("builds the chain, caps the ring, and derives slope/direction", () => {
    let journey = null;
    let appendedCount = 0;
    // Score climbs 60 → 84 over 2 hours (a keyframe every 30 min heartbeat).
    for (let i = 0; i <= 4; i++) {
      const res = updateJourney(journey, payload({ score: 60 + i * 6 }), T0 + i * 30 * MIN);
      journey = res.journey;
      if (res.appended) appendedCount++;
    }
    expect(appendedCount).toBe(5); // every frame appended (score jumps 6 >= 5)
    expect(journey.recent.length).toBe(5);
    const f = journey.features;
    expect(f.direction).toBe("improving");
    expect(f.score_slope_1h).toBeGreaterThan(5); // ~12 points/hour
    expect(f.stage).toBe("watch");
    expect(f.keyframes).toBe(5);
  });

  it("tracks stage dwell + corridor transitions", () => {
    let journey = null;
    journey = updateJourney(journey, payload(), T0).journey;
    // Stage flips watch→enter AND rank jumps into the top decile → new cell.
    journey = updateJourney(journey, payload({ kanban_stage: "enter", score: 90, rank: 5 }), T0 + 10 * MIN).journey;
    const res = updateJourney(journey, payload({ kanban_stage: "enter", score: 90, rank: 5 }), T0 + 40 * MIN);
    const f = res.journey.features;
    expect(f.stage).toBe("enter");
    expect(f.stage_changed_at).toBe(T0 + 10 * MIN);
    expect(f.time_in_stage_min).toBe(30);
    expect(f.cell_transitions).toBeGreaterThanOrEqual(1);
    expect(f.cell_path[f.cell_path.length - 1].cell).toBe(res.journey.recent[res.journey.recent.length - 1].cell);
  });

  it("no-change tick refreshes features without appending", () => {
    const first = updateJourney(null, payload(), T0);
    const second = updateJourney(first.journey, payload(), T0 + 5 * MIN);
    expect(second.appended).toBeNull();
    expect(second.journey.recent.length).toBe(1);
  });

  it("deteriorating run flags direction", () => {
    let journey = null;
    for (let i = 0; i <= 3; i++) {
      journey = updateJourney(journey, payload({ score: 80 - i * 8 }), T0 + i * 30 * MIN).journey;
    }
    expect(journey.features.direction).toBe("deteriorating");
    expect(journey.features.score_slope_1h).toBeLessThan(0);
  });
});

describe("D1 keyframe store", () => {
  function mockDb() {
    const rows = new Map(); // key ticker|ts
    return {
      rows,
      prepare(sql) {
        return {
          bind(...args) {
            return {
              sql, args,
              async run() {
                if (/^DELETE/i.test(sql.trim())) {
                  const cutoff = args[0];
                  let changes = 0;
                  for (const [k, v] of rows) {
                    if (v.ts < cutoff) { rows.delete(k); changes++; }
                  }
                  return { meta: { changes } };
                }
                return { meta: { changes: 0 } };
              },
              async all() {
                const [sym, sinceMs, limit] = args;
                const out = [...rows.values()]
                  .filter((r) => r.ticker === sym && r.ts >= sinceMs)
                  .sort((a, b) => a.ts - b.ts)
                  .slice(-limit);
                return { results: out };
              },
            };
          },
        };
      },
      async batch(stmts) {
        for (const s of stmts) {
          if (/^CREATE/i.test(s.sql?.trim?.() || "CREATE")) continue;
          if (s.args) {
            const [ticker, ts, score] = s.args;
            rows.set(`${ticker}|${ts}`, { ticker, ts, score });
          }
        }
      },
    };
  }

  it("persists, reads back ascending, and purges by retention", async () => {
    const db = mockDb();
    const env = { DB: db };
    const kf = (t, sc) => ({ ...buildKeyframe(payload({ score: sc }), t) });
    const res = await persistKeyframes(env, [
      { ticker: "SPY", kf: kf(T0, 60) },
      { ticker: "SPY", kf: kf(T0 + 30 * MIN, 66) },
      { ticker: "SPY", kf: kf(T0 - KEYFRAME_RETENTION_MS - 1000, 50) }, // ancient
    ]);
    expect(res.inserted).toBe(3);

    const read = await readKeyframes(env, "SPY", { limit: 10 });
    expect(read.length).toBe(3);
    expect(read[0].ts).toBeLessThan(read[2].ts);

    const purged = await purgeOldKeyframes(env, T0 + 60 * MIN);
    expect(purged.deleted).toBe(1);
    expect((await readKeyframes(env, "SPY", { limit: 10 })).length).toBe(2);
  });
});
