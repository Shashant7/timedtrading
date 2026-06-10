// worker/theme-tilt.test.js
//
// Coverage for the CRO theme-tilt overlay (worker/theme-tilt.js) —
// the bounded, direction-aware boost that finally lets "memory stocks
// are running" influence live viewport ranking.

import { describe, it, expect } from "vitest";
import {
  themeObservedScore,
  computeThemeTiltMap,
  loadThemeTiltMap,
  _resetThemeTiltCacheForTests,
  OBSERVED_MAX,
  TOTAL_MAX,
} from "./theme-tilt.js";

describe("themeObservedScore", () => {
  it("scores a hot theme positive (broad 5d strength + all-bid)", () => {
    const s = themeObservedScore({
      breadth_5d_up_gt_5pct: 80, breadth_5d_dn_gt_5pct: 0, all_bid_today: true,
    });
    // (80-0)/100*3 = 2.4, +1 all-bid = 3.4
    expect(s).toBe(3.4);
  });

  it("scores a cold theme negative and clamps at ±OBSERVED_MAX", () => {
    const s = themeObservedScore({
      breadth_5d_up_gt_5pct: 0, breadth_5d_dn_gt_5pct: 100, all_offered_today: true,
    });
    expect(s).toBe(-OBSERVED_MAX); // raw -4 clamps at -4
  });

  it("returns 0 for missing/flat input", () => {
    expect(themeObservedScore(null)).toBe(0);
    expect(themeObservedScore({ breadth_5d_up_gt_5pct: 10, breadth_5d_dn_gt_5pct: 10 })).toBe(0.0);
  });
});

describe("computeThemeTiltMap", () => {
  const snapshot = {
    computed_at: 1781000000000,
    theme_breadth: [
      // ai_infra_memory running hot → MU/WDC/STX... get positive tilt
      { theme: "ai_infra_memory", breadth_5d_up_gt_5pct: 80, breadth_5d_dn_gt_5pct: 0, all_bid_today: true },
      // crypto_miners getting sold → negative tilt
      { theme: "crypto_miners", breadth_5d_up_gt_5pct: 0, breadth_5d_dn_gt_5pct: 70, all_offered_today: true },
      // flat theme → no tilt emitted
      { theme: "defense", breadth_5d_up_gt_5pct: 20, breadth_5d_dn_gt_5pct: 20 },
    ],
  };

  it("tilts members of hot/cold themes and skips flat themes", () => {
    const map = computeThemeTiltMap({ rotationSnapshot: snapshot });
    expect(map.enabled).toBe(true);
    expect(map.by_ticker.MU).toBeTruthy();
    expect(map.by_ticker.MU.tilt).toBeGreaterThan(0);
    expect(map.by_ticker.MU.theme).toBe("ai_infra_memory");
    expect(map.by_ticker.RIOT).toBeTruthy();
    expect(map.by_ticker.RIOT.tilt).toBeLessThan(0);
    // Flat theme members get no entry (LMT is only in defense).
    expect(map.by_ticker.LMT).toBeUndefined();
    expect(map.tickers_tilted).toBeGreaterThan(0);
  });

  it("APLD rides the ai_infra_compute theme (operator example)", () => {
    const map = computeThemeTiltMap({
      rotationSnapshot: {
        theme_breadth: [
          { theme: "ai_infra_compute", breadth_5d_up_gt_5pct: 70, breadth_5d_dn_gt_5pct: 5, all_bid_today: true },
        ],
      },
    });
    expect(map.by_ticker.APLD).toBeTruthy();
    expect(map.by_ticker.APLD.tilt).toBeGreaterThan(0);
    expect(map.by_ticker.APLD.theme).toBe("ai_infra_compute");
  });

  it("a multi-theme ticker takes its strongest theme, not a stack", () => {
    // CRWD is in ai_software AND cybersecurity.
    const map = computeThemeTiltMap({
      rotationSnapshot: {
        theme_breadth: [
          { theme: "ai_software", breadth_5d_up_gt_5pct: 40, breadth_5d_dn_gt_5pct: 0 },          // 1.2
          { theme: "cybersecurity", breadth_5d_up_gt_5pct: 90, breadth_5d_dn_gt_5pct: 0, all_bid_today: true }, // 3.7
        ],
      },
    });
    expect(map.by_ticker.CRWD.theme).toBe("cybersecurity");
    expect(map.by_ticker.CRWD.observed).toBe(3.7);
  });

  it("total tilt clamps at ±TOTAL_MAX", () => {
    const map = computeThemeTiltMap({ rotationSnapshot: snapshot });
    for (const entry of Object.values(map.by_ticker)) {
      expect(Math.abs(entry.tilt)).toBeLessThanOrEqual(TOTAL_MAX);
    }
  });

  it("carries the enabled flag through (gate off = shadow mode)", () => {
    const map = computeThemeTiltMap({ rotationSnapshot: snapshot, enabled: false });
    expect(map.enabled).toBe(false);
    // Map still computed — shadow logging needs it.
    expect(map.tickers_tilted).toBeGreaterThan(0);
  });

  it("empty snapshot → empty map, no throw", () => {
    const map = computeThemeTiltMap({ rotationSnapshot: null });
    expect(map.tickers_tilted).toBe(0);
    expect(map.by_ticker).toEqual({});
  });
});

describe("loadThemeTiltMap", () => {
  function makeEnv({ snapshot = null, gateValue = undefined } = {}) {
    return {
      KV_TIMED: {
        async get(k) {
          return k === "timed:cro:rotation-snapshot" && snapshot ? JSON.stringify(snapshot) : null;
        },
      },
      DB: {
        prepare() {
          return {
            bind() {
              return {
                async first() {
                  return gateValue === undefined ? null : { config_value: gateValue };
                },
              };
            },
          };
        },
      },
    };
  }

  it("defaults the gate ON when no model_config row exists", async () => {
    _resetThemeTiltCacheForTests();
    const map = await loadThemeTiltMap(makeEnv({
      snapshot: { theme_breadth: [{ theme: "ai_infra_memory", breadth_5d_up_gt_5pct: 80, breadth_5d_dn_gt_5pct: 0 }] },
    }));
    expect(map.enabled).toBe(true);
    expect(map.by_ticker.MU).toBeTruthy();
  });

  it("respects the model_config kill switch", async () => {
    _resetThemeTiltCacheForTests();
    const map = await loadThemeTiltMap(makeEnv({
      snapshot: { theme_breadth: [{ theme: "ai_infra_memory", breadth_5d_up_gt_5pct: 80, breadth_5d_dn_gt_5pct: 0 }] },
      gateValue: "false",
    }));
    expect(map.enabled).toBe(false);
  });

  it("fails soft to an empty enabled map without KV", async () => {
    _resetThemeTiltCacheForTests();
    const map = await loadThemeTiltMap({});
    expect(map.enabled).toBe(true);
    expect(map.tickers_tilted).toBe(0);
  });
});
