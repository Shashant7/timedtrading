import { describe, it, expect } from "vitest";
import {
  detectTtCloudPivot,
  buildCloudPivotPaperQueueProposal,
  stampTtCloudPivotThinSlice,
  cloudPivotPaperSizeMult,
  evaluateTtCloudPivotExit,
  isTtCloudPivotTrade,
  resolveCloudPivotSession,
  resolveCloudMagnet,
  inspectTtCloudPivot,
  buildCloudPivotDesk,
  cloudDeskPlanCopy,
  buildCloudSessionPlan,
  annotateCloudPivotLeaderFollows,
  cloudPivotFollowersOf,
  CLOUD_PIVOT_FAMILY,
} from "./tt-cloud-pivot.js";

/** Wed 2026-07-15 11:15 ET ≈ midday curl window. */
const MIDDAY_TS = Date.parse("2026-07-15T15:15:00Z");
/** Wed 2026-07-15 09:40 ET ≈ open (still in noise if end=45). */
const OPEN_TS = Date.parse("2026-07-15T13:40:00Z");
/** Wed 2026-07-15 10:15 ET ≈ ten_am. */
const TEN_AM_TS = Date.parse("2026-07-15T14:15:00Z");

function payload(overrides = {}) {
  return {
    kanban_stage: "setup_watch",
    ts: MIDDAY_TS,
    confluence_mode: "RIDE",
    tf_tech: {
      "10": {
        ripster: {
          c5_12: {
            bull: true, bear: false, above: false, inCloud: true,
            crossUp: true, crossDn: false, fastSlope: 0.2,
          },
          c34_50: { bull: true, bear: false, above: true },
          c8_9: { bull: true, inCloud: true, fastSlope: 0.1 },
        },
      },
      "1H": {
        ripster: {
          c34_50: { bull: true, bear: false, above: true },
        },
      },
    },
    ...overrides,
  };
}

describe("tt_cloud_pivot", () => {
  it("resolves midday session", () => {
    expect(resolveCloudPivotSession(MIDDAY_TS)).toBe("midday_curl");
    expect(resolveCloudPivotSession(TEN_AM_TS)).toBe("ten_am");
  });

  it("detects midday 5/12 cross-up curl", () => {
    const d = detectTtCloudPivot(payload(), {}, { asOfTs: MIDDAY_TS });
    expect(d?.fires).toBe(true);
    expect(d.direction).toBe("LONG");
    expect(d.session).toBe("midday_curl");
    expect(d.family).toBe(CLOUD_PIVOT_FAMILY);
  });

  it("open window requires a cross", () => {
    const noCross = payload({
      ts: OPEN_TS,
      tf_tech: {
        "10": {
          ripster: {
            c5_12: {
              bull: true, inCloud: true, crossUp: false, crossDn: false, fastSlope: 0.1,
            },
            c34_50: { bull: true, above: true },
          },
        },
        "1H": { ripster: { c34_50: { bull: true, above: true } } },
      },
    });
    expect(detectTtCloudPivot(noCross, {}, { asOfTs: OPEN_TS })).toBeNull();
  });

  it("builds paper Queued proposal", () => {
    const p = buildCloudPivotPaperQueueProposal(payload(), {});
    expect(p?.family).toBe(CLOUD_PIVOT_FAMILY);
    expect(p.paper).toBe(true);
    expect(p.size_mult).toBe(0.1);
  });

  it("does not override confirm-stack proposal", () => {
    const out = stampTtCloudPivotThinSlice({
      ...payload(),
      _sequence_queue_proposal: {
        family: "confirm_stack_ema21", paper: true, state: "queued",
      },
    }, {});
    expect(out._sequence_queue_proposal.family).toBe("confirm_stack_ema21");
    expect(out.tt_cloud_pivot).toBe(true);
  });

  it("overrides momentum_continuation proposal", () => {
    const out = stampTtCloudPivotThinSlice({
      ...payload(),
      _sequence_queue_proposal: {
        family: "momentum_continuation", paper: true, state: "queued",
      },
    }, {});
    expect(out._sequence_queue_proposal.family).toBe(CLOUD_PIVOT_FAMILY);
  });

  it("cloudPivotPaperSizeMult returns 0.1", () => {
    expect(cloudPivotPaperSizeMult({
      _sequence_queue_proposal: { paper: true, family: CLOUD_PIVOT_FAMILY, size_mult: 0.1 },
    }, {})).toBe(0.1);
  });

  it("exit on 5/12 loss after debounce", () => {
    const td = payload();
    const pos = {
      slice_family: CLOUD_PIVOT_FAMILY,
      direction: "LONG",
      tt_cloud_pivot_pending_5_12: 1,
    };
    // Flip cloud to lost
    td.tf_tech["10"].ripster.c5_12 = {
      bull: false, bear: true, below: true, crossDn: true, crossUp: false,
    };
    const pending = evaluateTtCloudPivotExit({
      tickerData: td,
      openPosition: { ...pos, tt_cloud_pivot_pending_5_12: 0 },
      direction: "LONG",
      pnlPct: 1.2,
      positionAgeMin: 20,
      trimmedPct: 0,
    });
    expect(pending?.reason).toBe("tt_cloud_pivot_5_12_pending");

    const trim = evaluateTtCloudPivotExit({
      tickerData: td,
      openPosition: { ...pos, tt_cloud_pivot_pending_5_12: 1 },
      direction: "LONG",
      pnlPct: 1.2,
      positionAgeMin: 20,
      trimmedPct: 0,
    });
    expect(trim?.stage).toBe("trim");
    expect(trim?.reason).toBe("tt_cloud_pivot_5_12_close_trim");
  });

  it("does not treat a canonical core path as a Cloud Pivot trade", () => {
    expect(isTtCloudPivotTrade({
      entry_path: "tt_n_test_support",
      slice_family: CLOUD_PIVOT_FAMILY,
    })).toBe(false);
    expect(isTtCloudPivotTrade({
      slice_family: CLOUD_PIVOT_FAMILY,
      __tradeRef: { entry_path: "tt_ath_breakout" },
    })).toBe(false);
    expect(isTtCloudPivotTrade({
      setup_name: "Support Bounce",
      slice_family: CLOUD_PIVOT_FAMILY,
    })).toBe(false);
    expect(evaluateTtCloudPivotExit({
      tickerData: payload(),
      openPosition: {
        entry_path: "tt_ath_breakout",
        slice_family: CLOUD_PIVOT_FAMILY,
        direction: "LONG",
        tt_cloud_pivot_pending_5_12: 1,
      },
      direction: "LONG",
      pnlPct: -0.5,
      positionAgeMin: 40,
      trimmedPct: 0,
    })).toBeNull();
  });

  it("stamps next 1H 34/50 lo as the long magnet", () => {
    const p = payload({
      price: 100,
      tf_tech: {
        "10": {
          ripster: {
            c5_12: {
              bull: true, bear: false, above: false, inCloud: true,
              crossUp: true, crossDn: false, fastSlope: 0.2,
            },
            c34_50: { bull: false, bear: true, below: true, lo: 96, hi: 98 },
          },
        },
        "1H": {
          ripster: {
            c34_50: { bull: true, bear: false, above: false, lo: 102, hi: 104, fastSlope: 0.1 },
            c72_89: { bull: true, lo: 108, hi: 111 },
          },
        },
      },
    });
    const mag = resolveCloudMagnet(p, "LONG", 100);
    expect(mag?.px).toBe(102);
    expect(mag?.label).toBe("1H_34_50");
    expect(mag?.ahead).toBe(true);
    const d = detectTtCloudPivot(p, {}, { asOfTs: MIDDAY_TS });
    expect(d?.fires).toBe(true);
    expect(d.reasons).toContain("mixed_cloud_curl");
    expect(d.cloud_magnet?.px).toBe(102);
  });

  it("allows mixed-cloud 5/12 curl when 1H magnet is ahead", () => {
    const p = payload({
      ts: TEN_AM_TS,
      price: 50,
      tf_tech: {
        "10": {
          ripster: {
            c5_12: {
              bull: true, inCloud: true, crossUp: true, crossDn: false, fastSlope: 0.2,
            },
            c34_50: { bull: false, bear: true, below: true, lo: 46, hi: 48 },
            c8_9: { bull: true, crossUp: true },
          },
        },
        "1H": {
          ripster: {
            c34_50: {
              bull: false, bear: true, below: true, lo: 52, hi: 54, fastSlope: -0.05,
            },
          },
        },
      },
    });
    const d = detectTtCloudPivot(p, {}, { asOfTs: TEN_AM_TS });
    expect(d?.fires).toBe(true);
    expect(d.reasons).toContain("mixed_cloud_curl");
  });

  it("vetoes when 1H is sloping against and no magnet is ahead", () => {
    const p = payload({
      price: 120,
      tf_tech: {
        "10": {
          ripster: {
            c5_12: {
              bull: true, inCloud: true, crossUp: true, crossDn: false, fastSlope: 0.2,
            },
            c34_50: { bull: false, bear: true, below: true },
          },
        },
        "1H": {
          ripster: {
            c34_50: {
              bull: false, bear: true, below: true, lo: 100, hi: 105, fastSlope: -0.4,
            },
          },
        },
      },
    });
    expect(detectTtCloudPivot(p, {}, { asOfTs: MIDDAY_TS })).toBeNull();
  });

  it("gates catalyst names with a long-over if/then", () => {
    const blocked = payload({
      price: 98,
      days_to_earnings: 1,
      pm_high: 100,
      tf_tech: {
        "10": payload().tf_tech["10"],
        "1H": {
          ripster: {
            c34_50: { bull: true, above: true, lo: 97, hi: 99 },
          },
        },
      },
    });
    expect(detectTtCloudPivot(blocked, {}, { asOfTs: MIDDAY_TS })).toBeNull();
    const plan = buildCloudSessionPlan(blocked, "LONG");
    expect(plan?.long_over).toBe(100);

    const allowed = payload({
      ...blocked,
      price: 100.2,
    });
    const d = detectTtCloudPivot(allowed, {}, { asOfTs: MIDDAY_TS });
    expect(d?.fires).toBe(true);
    expect(d.session_plan?.long_over).toBe(100);
    expect(d.reasons).toContain("catalyst_earnings");
  });

  it("does not apply if/then when there is no catalyst", () => {
    const p = payload({ price: 10, pm_high: 50 });
    expect(buildCloudSessionPlan(p, "LONG")).toBeNull();
    expect(detectTtCloudPivot(p, {}, { asOfTs: MIDDAY_TS })?.fires).toBe(true);
  });

  it("keeps Cloud Pivot eligible on day2 when 1H 34/50 still holds", () => {
    const afterMidday = Date.parse("2026-07-15T18:10:00Z"); // 14:10 ET
    expect(resolveCloudPivotSession(afterMidday)).toBeNull();
    const p = payload({
      ts: afterMidday,
      price: 80,
      earnings_dte: -1,
      tf_tech: {
        "10": payload().tf_tech["10"],
        "1H": {
          ripster: {
            c34_50: { bull: true, above: true, lo: 78, hi: 82, fastSlope: 0.05 },
          },
        },
      },
    });
    const d = detectTtCloudPivot(p, {}, { asOfTs: afterMidday });
    expect(d?.fires).toBe(true);
    expect(d.session).toBe("day2_curl");
  });

  it("trims when price tags the 1H magnet", () => {
    const td = payload({
      price: 101.90,
      atr: 1,
      tf_tech: {
        "10": {
          ripster: {
            c5_12: {
              bull: true, bear: false, above: true, inCloud: false,
              crossUp: false, crossDn: false, fastSlope: 0.1, lo: 99, hi: 100.2,
            },
            c34_50: { bull: true, above: true, lo: 97, hi: 98 },
          },
        },
        "1H": {
          ripster: {
            c34_50: { bull: true, above: false, lo: 102, hi: 104, fastSlope: 0.1 },
          },
        },
      },
    });
    const trim = evaluateTtCloudPivotExit({
      tickerData: td,
      openPosition: { slice_family: CLOUD_PIVOT_FAMILY, direction: "LONG" },
      direction: "LONG",
      currentPrice: 101.90,
      pnlPct: 1.1,
      positionAgeMin: 20,
      trimmedPct: 0,
    });
    expect(trim?.stage).toBe("trim");
    expect(trim?.reason).toBe("tt_cloud_pivot_magnet_tag_trim");
  });

  it("trails the stop to the held 5/12 after MFE", () => {
    const td = payload({
      price: 105,
      tf_tech: {
        "10": {
          ripster: {
            c5_12: {
              bull: true, bear: false, above: true, inCloud: false,
              crossUp: false, crossDn: false, fastSlope: 0.2, lo: 101.5, hi: 102.4,
            },
            c34_50: { bull: true, above: true, lo: 98, hi: 99.5 },
          },
        },
        "1H": {
          ripster: {
            c34_50: { bull: true, above: true, lo: 110, hi: 112 },
          },
        },
      },
    });
    const pos = {
      slice_family: CLOUD_PIVOT_FAMILY,
      direction: "LONG",
      sl: 96,
      maxFavorableExcursion: 0.9,
    };
    const trail = evaluateTtCloudPivotExit({
      tickerData: td,
      openPosition: pos,
      direction: "LONG",
      currentPrice: 105,
      pnlPct: 0.8,
      positionAgeMin: 20,
      trimmedPct: 0,
      mfePct: 0.9,
    });
    expect(trail?.stage).toBe("defend");
    expect(trail?.reason).toBe("tt_cloud_pivot_ribbon_trail");
    expect(trail?.metadata?.trail_px).toBe(101.5);
    expect(pos.tt_cloud_pivot_trail_px).toBe(101.5);
  });

  it("fans BTC 10m curls onto crypto-proxy followers", () => {
    expect(cloudPivotFollowersOf("BTCUSD")).toEqual(
      expect.arrayContaining(["SPY", "QQQ", "COIN", "MSTR"]),
    );
    expect(cloudPivotFollowersOf("SPY")).not.toContain("BTCUSD");
    const curl = {
      ripster: {
        c5_12: {
          bull: true, inCloud: true, crossUp: true, crossDn: false, fastSlope: 0.3,
        },
        c34_50: { bull: true, above: true },
      },
    };
    const rows = [
      { sym: "BTCUSD", t: { tf_tech: { "10": curl } } },
      { sym: "COIN", t: { tf_tech: { "10": curl } } },
      { sym: "AAPL", t: { tf_tech: { "10": curl } } },
    ];
    annotateCloudPivotLeaderFollows(rows);
    expect(rows[0].t._cloud_leader?.role).toBe("leader");
    expect(rows[1].t._cloud_leader_follow?.leader).toBe("BTCUSD");
    expect(rows[2].t._cloud_leader_follow).toBeUndefined();
  });

  it("uses leader_curl session after midday when a leader follow is stamped", () => {
    const afterMidday = Date.parse("2026-07-15T18:10:00Z");
    const p = payload({
      ts: afterMidday,
      price: 80,
      _cloud_leader_follow: { leader: "BTCUSD", direction: "LONG", trigger: "5_12_cross_up" },
    });
    const d = detectTtCloudPivot(p, {}, { asOfTs: afterMidday });
    expect(d?.fires).toBe(true);
    expect(d.session).toBe("leader_curl");
    expect(d.reasons).toContain("leader_follow_btcusd");
  });

  it("inspects clouds on a weekend without requiring a session fire", () => {
    const saturday = Date.parse("2026-08-22T16:00:00Z");
    expect(resolveCloudPivotSession(saturday)).toBeNull();
    const p = payload({
      ts: saturday,
      price: 100,
      tt_cloud_pivot: true,
      tf_tech: {
        "10": payload().tf_tech["10"],
        "1H": {
          ripster: {
            c34_50: { bull: true, above: false, lo: 102, hi: 104, fastSlope: 0.1 },
          },
        },
      },
    });
    expect(detectTtCloudPivot(p, {}, { asOfTs: saturday })).toBeNull();
    const insp = inspectTtCloudPivot(p);
    expect(insp?.curl?.direction).toBe("LONG");
    expect(insp.magnet?.px).toBe(102);
    const desk = buildCloudPivotDesk([{ sym: "NVDA", t: p }], { asOfTs: saturday });
    expect(desk.watching[0].ticker).toBe("NVDA");
    expect(desk.watching[0].role).toBe("fire");
    expect(desk.watching[0].why).toContain("fires");
  });

  it("ranks a BTC leader curl onto COIN on the desk", () => {
    const curl = {
      ripster: {
        c5_12: {
          bull: true, inCloud: true, crossUp: true, crossDn: false, fastSlope: 0.3,
        },
        c34_50: { bull: true, above: true, lo: 90, hi: 92 },
      },
    };
    const desk = buildCloudPivotDesk([
      { sym: "BTCUSD", t: { price: 100000, tf_tech: { "10": curl, "1H": { ripster: { c34_50: { bull: true, lo: 101000, hi: 102000 } } } } } },
      { sym: "COIN", t: { price: 280, tf_tech: { "10": curl, "1H": { ripster: { c34_50: { bull: true, lo: 290, hi: 300 } } } } } },
    ], { skipDetect: true, minScore: 20 });
    expect(desk.leaders.map((x) => x.ticker)).toEqual(expect.arrayContaining(["BTCUSD", "COIN"]));
    expect(desk.watching.find((x) => x.ticker === "COIN")?.leader_follow?.leader).toBe("BTCUSD");
  });
});

describe("cloudDeskPlanCopy", () => {
  it("writes FIRE as a paper BUY punchline", () => {
    const copy = cloudDeskPlanCopy({
      ticker: "BTCUSD",
      role: "fire",
      direction: "LONG",
      magnet: { px: 63474.96, label: "1h_34_50" },
      session: "midday",
    });
    expect(copy.action).toBe("BUY");
    expect(copy.punch).toBe("BUY on BTCUSD — Cloud Pivot fire, paper size toward $63474.96");
    expect(copy.scan).toContain("Paper 0.1×");
    expect(copy.scan).toContain("magnet $63474.96");
    expect(copy.scan).toContain("midday");
  });

  it("keeps STALK / FOLLOW as WAIT", () => {
    const stalk = cloudDeskPlanCopy({
      ticker: "QQQ",
      role: "stalk",
      direction: "SHORT",
      magnet: { px: 727.84 },
    });
    expect(stalk.action).toBe("WAIT");
    expect(stalk.punch).toBe("WAIT on QQQ — magnet stalk toward $727.84");
    const follow = cloudDeskPlanCopy({
      ticker: "COIN",
      role: "follow",
      direction: "LONG",
      leader_follow: { leader: "BTCUSD" },
      magnet: { px: 290 },
    });
    expect(follow.action).toBe("WAIT");
    expect(follow.punch).toContain("follow BTCUSD");
    expect(follow.scan).toContain("Watch only");
  });
});
