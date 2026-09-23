import { describe, it, expect } from "vitest";
import {
  detectTtCloudPivot,
  earlyRthFakeoutBlocksCloudPivot,
  openCloudPivotIsChase,
  buildCloudPivotPaperQueueProposal,
  stampTtCloudPivotThinSlice,
  cloudPivotPaperSizeMult,
  evaluateTtCloudPivotExit,
  isTtCloudPivotTrade,
  resolveCloudPivotSession,
  resolveCloudMagnet,
  inspectTtCloudPivot,
  buildCloudPivotDesk,
  classifyCloudMagnet,
  cloudMagnetCoverLine,
  resolveDeskCovers,
  cloudDeskPlanCopy,
  buildCloudSessionPlan,
  annotateCloudPivotLeaderFollows,
  cloudPivotFollowersOf,
  CLOUD_PIVOT_FAMILY,
  cloudPivotKeepFrac,
  cloudPivotConviction,
} from "./tt-cloud-pivot.js";

/** Wed 2026-07-15 11:15 ET ≈ midday curl window. */
const MIDDAY_TS = Date.parse("2026-07-15T15:15:00Z");
/** Wed 2026-07-15 09:33 ET ≈ open, inside forming first 10m bar. */
const OPEN_EARLY_TS = Date.parse("2026-07-15T13:33:00Z");
/** Wed 2026-07-15 09:40 ET ≈ first 10m bar closed. */
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

  it("blocks open window before first 10m bar closes", () => {
    const earlyCross = payload({
      ts: OPEN_EARLY_TS,
      tf_tech: {
        "10": {
          ripster: {
            c5_12: {
              bull: true, inCloud: true, crossUp: true, crossDn: false, fastSlope: 0.2,
            },
            c34_50: { bull: true, above: true },
          },
        },
        "1H": { ripster: { c34_50: { bull: true, above: true } } },
      },
    });
    expect(detectTtCloudPivot(earlyCross, {}, { asOfTs: OPEN_EARLY_TS })).toBeNull();
    expect(earlyRthFakeoutBlocksCloudPivot(9 * 60 + 33, "open", {})).toBe(true);
    expect(earlyRthFakeoutBlocksCloudPivot(9 * 60 + 40, "open", {})).toBe(false);
  });

  it("open window blocks extended chase above 5/12 cloud", () => {
    const chase = payload({
      ts: OPEN_TS,
      tf_tech: {
        "10": {
          ripster: {
            c5_12: {
              bull: true, above: true, inCloud: false,
              crossUp: true, crossDn: false, fastSlope: 0.3,
              distToCloudPct: 0.012,
            },
            c34_50: { bull: true, above: true },
          },
        },
        "1H": { ripster: { c34_50: { bull: true, above: true } } },
      },
    });
    expect(detectTtCloudPivot(chase, {}, { asOfTs: OPEN_TS })).toBeNull();
    expect(openCloudPivotIsChase("LONG", chase.tf_tech["10"].ripster.c5_12, "5_12_cross_up", {})).toBe(true);
  });

  it("open window allows in-cloud curl pullback", () => {
    const curl = payload({
      ts: OPEN_TS,
      tf_tech: {
        "10": {
          ripster: {
            c5_12: {
              bull: true, inCloud: true, above: false,
              crossUp: true, crossDn: false, fastSlope: 0.15,
              distToCloudPct: 0,
            },
            c34_50: { bull: true, above: true },
          },
        },
        "1H": { ripster: { c34_50: { bull: true, above: true } } },
      },
    });
    const d = detectTtCloudPivot(curl, {}, { asOfTs: OPEN_TS });
    expect(d?.fires).toBe(true);
    expect(d?.direction).toBe("LONG");
    expect(d?.trigger).toBe("5_12_cross_up");
    expect(openCloudPivotIsChase("LONG", curl.tf_tech["10"].ripster.c5_12, "5_12_cross_up", {})).toBe(false);
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

  it("profit-lock trims a retraced winner while the 1H cloud still backs it", () => {
    // Healthy 5/12 (no cross-down) and no magnet lo/hi, so neither the 5/12
    // loss nor the magnet-tag fires. A +5% MFE run that retraced to +2% (past
    // the 60% keep floor of 3.0%) banks half; the 1H 34/50 is still bull so
    // the runner stays on to trail.
    const base = { tickerData: payload(), openPosition: { slice_family: CLOUD_PIVOT_FAMILY, direction: "LONG" }, direction: "LONG", currentPrice: 100, positionAgeMin: 20, trimmedPct: 0 };
    const res = evaluateTtCloudPivotExit({ ...base, pnlPct: 2, mfePct: 5 });
    expect(res?.reason).toBe("tt_cloud_pivot_profit_lock_trim");
    expect(res?.stage).toBe("trim");
    expect(res?.metadata?.keep_floor_pct).toBe(3);
    expect(res?.metadata?.keep_frac).toBe(0.6);
  });

  it("profit-lock exits in full when the 1H 34/50 has flipped against the trade", () => {
    const td = payload();
    td.tf_tech["1H"].ripster.c34_50 = { bull: false, bear: true, below: true };
    const res = evaluateTtCloudPivotExit({
      tickerData: td, openPosition: { slice_family: CLOUD_PIVOT_FAMILY, direction: "LONG" },
      direction: "LONG", currentPrice: 100, pnlPct: 2, mfePct: 5, positionAgeMin: 20, trimmedPct: 0,
    });
    expect(res?.reason).toBe("tt_cloud_pivot_profit_lock");
    expect(res?.stage).toBe("exit");
    expect(res?.metadata?.one_h_lost).toBe(true);
  });

  it("profit-lock runner (already trimmed) exits at 25% of peak and never red", () => {
    const base = { tickerData: payload(), openPosition: { slice_family: CLOUD_PIVOT_FAMILY, direction: "LONG" }, direction: "LONG", currentPrice: 100, positionAgeMin: 40, trimmedPct: 0.5, mfePct: 5 };
    // +2.0% on a +5% peak: above the 1.25% runner floor -> hold the runner.
    expect(evaluateTtCloudPivotExit({ ...base, pnlPct: 2 })?.reason).not.toBe("tt_cloud_pivot_profit_lock");
    const res = evaluateTtCloudPivotExit({ ...base, pnlPct: 1.1 });
    expect(res?.reason).toBe("tt_cloud_pivot_profit_lock");
    expect(res?.metadata?.runner).toBe(true);
    expect(res?.metadata?.runner_floor_pct).toBe(1.25);
  });

  it("keep fraction escalates with the peak", () => {
    expect(cloudPivotKeepFrac(1.5)).toBe(0.4);
    expect(cloudPivotKeepFrac(3)).toBe(0.5);
    expect(cloudPivotKeepFrac(6)).toBe(0.6);
    expect(cloudPivotKeepFrac(12)).toBe(0.7);
  });

  it("profit-lock holds a winner still near its peak", () => {
    const res = evaluateTtCloudPivotExit({
      tickerData: payload(), openPosition: { slice_family: CLOUD_PIVOT_FAMILY, direction: "LONG" },
      direction: "LONG", currentPrice: 100, pnlPct: 4.8, mfePct: 5, positionAgeMin: 20, trimmedPct: 0,
    });
    expect(res?.reason).not.toBe("tt_cloud_pivot_profit_lock");
  });

  it("profit-lock does not arm below the MFE threshold", () => {
    const res = evaluateTtCloudPivotExit({
      tickerData: payload(), openPosition: { slice_family: CLOUD_PIVOT_FAMILY, direction: "LONG" },
      direction: "LONG", currentPrice: 100, pnlPct: 0.1, mfePct: 0.8, positionAgeMin: 20, trimmedPct: 0,
    });
    expect(res?.reason).not.toBe("tt_cloud_pivot_profit_lock");
  });

  it("profit-lock is flag-gated and keep-fraction configurable", () => {
    const base = { tickerData: payload(), openPosition: { slice_family: CLOUD_PIVOT_FAMILY, direction: "LONG" }, direction: "LONG", currentPrice: 100, positionAgeMin: 20, trimmedPct: 0, mfePct: 5 };
    const off = evaluateTtCloudPivotExit({ ...base, pnlPct: 2, daCfg: { deep_audit_tt_cloud_pivot_profit_lock_enabled: "false" } });
    expect(off?.reason).not.toBe("tt_cloud_pivot_profit_lock");
    // flat keep 30% → floor 1.5%: pnl 2 holds, pnl 1.0 trims (1H intact).
    const hold = evaluateTtCloudPivotExit({ ...base, pnlPct: 2, daCfg: { deep_audit_tt_cloud_pivot_profit_lock_keep_frac: "0.3" } });
    expect(String(hold?.reason || "")).not.toContain("tt_cloud_pivot_profit_lock");
    const exit = evaluateTtCloudPivotExit({ ...base, pnlPct: 1.0, daCfg: { deep_audit_tt_cloud_pivot_profit_lock_keep_frac: "0.3" } });
    expect(exit?.reason).toBe("tt_cloud_pivot_profit_lock_trim");
    expect(exit?.metadata?.keep_floor_pct).toBe(1.5);
  });

  it("loss cap exits an unproven trade at the cap", () => {
    // EXPE long 2026-09-04: MFE 0.96%, never armed the lock, ran to -6.25%.
    const res = evaluateTtCloudPivotExit({
      tickerData: payload(), openPosition: { slice_family: CLOUD_PIVOT_FAMILY, direction: "LONG" },
      direction: "LONG", currentPrice: 100, pnlPct: -2.6, mfePct: 0.96,
      positionAgeMin: 200, trimmedPct: 0,
    });
    expect(res?.reason).toBe("tt_cloud_pivot_loss_cap");
    expect(res?.stage).toBe("exit");
    expect(res?.metadata?.loss_cap_pct).toBe(2.5);
    expect(res?.metadata?.unproven).toBe(true);
  });

  it("loss cap fires on a short leg too", () => {
    // BG short 2026-09-04: MFE 0.00%, ran to -6.15%.
    const td = payload();
    td.tf_tech["10"].ripster.c5_12 = { bull: false, bear: true, below: true, crossUp: false, crossDn: false };
    td.tf_tech["1H"].ripster.c34_50 = { bull: false, bear: true, below: true };
    const res = evaluateTtCloudPivotExit({
      tickerData: td, openPosition: { slice_family: CLOUD_PIVOT_FAMILY, direction: "SHORT" },
      direction: "SHORT", currentPrice: 100, pnlPct: -3, mfePct: 0,
      positionAgeMin: 200, trimmedPct: 0,
    });
    expect(res?.reason).toBe("tt_cloud_pivot_loss_cap");
  });

  it("loss cap does not wait on a 10m 5/12 print", () => {
    // The whole point: a missing ripster print used to return null before any
    // loss-side rule could run, which is how -6% drawdowns survived.
    const td = payload();
    td.tf_tech["10"].ripster.c5_12 = null;
    const res = evaluateTtCloudPivotExit({
      tickerData: td, openPosition: { slice_family: CLOUD_PIVOT_FAMILY, direction: "LONG" },
      direction: "LONG", currentPrice: 100, pnlPct: -4, mfePct: 0.1,
      positionAgeMin: 200, trimmedPct: 0,
    });
    expect(res?.reason).toBe("tt_cloud_pivot_loss_cap");
  });

  it("loss cap holds inside the cap and the working stop band", () => {
    const base = {
      tickerData: payload(), openPosition: { slice_family: CLOUD_PIVOT_FAMILY, direction: "LONG" },
      direction: "LONG", currentPrice: 100, mfePct: 0.5, positionAgeMin: 200, trimmedPct: 0,
    };
    // -2.3%: inside the cap, where the generic max_loss already works.
    expect(evaluateTtCloudPivotExit({ ...base, pnlPct: -2.3 })?.reason)
      .not.toBe("tt_cloud_pivot_loss_cap");
    expect(evaluateTtCloudPivotExit({ ...base, pnlPct: -2.5 })?.reason)
      .toBe("tt_cloud_pivot_loss_cap");
  });

  it("loss cap stands down once the trade proved itself", () => {
    const base = {
      tickerData: payload(), openPosition: { slice_family: CLOUD_PIVOT_FAMILY, direction: "LONG" },
      direction: "LONG", currentPrice: 100, pnlPct: -4, positionAgeMin: 200,
    };
    // RBLX long 2026-09-04 realized +$13.53 on a -4.37% whole-life drawdown:
    // it had already armed the lock and banked half. The cap must not cut it.
    expect(evaluateTtCloudPivotExit({ ...base, mfePct: 5.68, trimmedPct: 0.5 })?.reason)
      .not.toBe("tt_cloud_pivot_loss_cap");
    // Armed but not yet trimmed: the profit lock owns the exit, not the cap.
    expect(evaluateTtCloudPivotExit({ ...base, mfePct: 5.68, trimmedPct: 0 })?.reason)
      .not.toBe("tt_cloud_pivot_loss_cap");
  });

  it("loss cap is flag-gated and configurable", () => {
    const base = {
      tickerData: payload(), openPosition: { slice_family: CLOUD_PIVOT_FAMILY, direction: "LONG" },
      direction: "LONG", currentPrice: 100, pnlPct: -2.6, mfePct: 0.5,
      positionAgeMin: 200, trimmedPct: 0,
    };
    expect(evaluateTtCloudPivotExit({
      ...base, daCfg: { deep_audit_tt_cloud_pivot_loss_cap_enabled: "false" },
    })?.reason).not.toBe("tt_cloud_pivot_loss_cap");
    // Widen to 3%: -2.6% no longer breaches.
    expect(evaluateTtCloudPivotExit({
      ...base, daCfg: { deep_audit_tt_cloud_pivot_loss_cap_pct: "0.03" },
    })?.reason).not.toBe("tt_cloud_pivot_loss_cap");
    const tight = evaluateTtCloudPivotExit({
      ...base, pnlPct: -1.6, daCfg: { deep_audit_tt_cloud_pivot_loss_cap_pct: "0.015" },
    });
    expect(tight?.reason).toBe("tt_cloud_pivot_loss_cap");
    expect(tight?.metadata?.loss_cap_pct).toBe(1.5);
  });

  it("loss cap leaves the profit lock in charge of a peak giveback", () => {
    // A +5% run retraced to -4% must still read as a profit-lock event, not
    // a loss cap: ordering inside the evaluator matters.
    const res = evaluateTtCloudPivotExit({
      tickerData: payload(), openPosition: { slice_family: CLOUD_PIVOT_FAMILY, direction: "LONG" },
      direction: "LONG", currentPrice: 100, pnlPct: -4, mfePct: 5,
      positionAgeMin: 200, trimmedPct: 0,
    });
    expect(String(res?.reason || "")).toContain("profit_lock");
  });

  it("identifies the paper ticket even when the live card scores a different setup", () => {
    const tickerNow = { setup_name: "TT ATH Breakout", setupName: "TT ATH Breakout" };
    expect(isTtCloudPivotTrade({
      entry_path: "tt_cloud_pivot_long",
      setup_name: "TT Cloud Pivot",
    }, tickerNow)).toBe(true);
    expect(isTtCloudPivotTrade({
      __tradeRef: { entry_path: "tt_cloud_pivot_short", setup_name: "TT Cloud Pivot" },
    }, tickerNow)).toBe(true);
    expect(isTtCloudPivotTrade({}, tickerNow)).toBe(false);
    const res = evaluateTtCloudPivotExit({
      tickerData: { ...tickerNow },
      openPosition: {
        entry_path: "tt_cloud_pivot_long",
        setup_name: "TT Cloud Pivot",
        direction: "LONG",
        maxFavorableExcursion: 5.18,
      },
      direction: "LONG",
      currentPrice: 100,
      pnlPct: 1.69,
      mfePct: 5.18,
      positionAgeMin: 4000,
      trimmedPct: 0,
    });
    expect(res?.reason).toBe("tt_cloud_pivot_profit_lock_trim");
    expect(res?.metadata?.keep_floor_pct).toBe(3.11);
  });

  it("session lock banks a near-floor winner in the last 20 min of RTH", () => {
    const base = {
      tickerData: payload(),
      openPosition: { slice_family: CLOUD_PIVOT_FAMILY, direction: "LONG" },
      direction: "LONG",
      currentPrice: 100,
      positionAgeMin: 20,
      trimmedPct: 0,
      mfePct: 5,
    };
    // keep floor is 3.0%; +3.2% is still above it unless sessionLock slack (0.4) is on.
    expect(evaluateTtCloudPivotExit({ ...base, pnlPct: 3.2 })?.reason).not.toBe("tt_cloud_pivot_profit_lock_trim");
    const locked = evaluateTtCloudPivotExit({ ...base, pnlPct: 3.2, sessionLock: true });
    expect(locked?.reason).toBe("tt_cloud_pivot_profit_lock_trim");
    expect(locked?.metadata?.session_lock).toBe(true);
  });

  it("profit-lock fires without a 10m 5/12 print", () => {
    const res = evaluateTtCloudPivotExit({
      tickerData: { price: 100 },
      openPosition: { entry_path: "tt_cloud_pivot_long", direction: "LONG" },
      direction: "LONG",
      currentPrice: 100,
      pnlPct: 1.69,
      mfePct: 5.18,
      positionAgeMin: 4000,
      trimmedPct: 0,
    });
    expect(res?.reason).toBe("tt_cloud_pivot_profit_lock_trim");
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

describe("resolveDeskCovers", () => {
  it("keeps an ahead 1H magnet as next cover", () => {
    const pair = resolveDeskCovers(
      { monthly_bundle: { ema21: 110 }, tp_trim: 120 },
      "LONG",
      100,
      { px: 102, label: "1H_34_50" },
    );
    expect(pair.next?.px).toBe(102);
    expect(pair.next?.source).toBe("cloud");
    expect(pair.last).toBeNull();
  });

  it("picks the nearest rail level when the cloud magnet is behind", () => {
    const pair = resolveDeskCovers(
      {
        monthly_bundle: { ema21: 2518.87 },
        tp_trim: 2682.81,
        tf_tech: { W: { ema: { ema21: 2098.78 } } },
      },
      "LONG",
      2416.2,
      { px: 1885.13, label: "1H_34_50" },
    );
    expect(pair.last?.px).toBe(1885.13);
    expect(pair.next?.px).toBe(2518.87);
    expect(pair.next?.label).toBe("Monthly 21 EMA");
  });
});

describe("classifyCloudMagnet", () => {
  it("treats a LONG cover below price as behind, not the destination", () => {
    expect(classifyCloudMagnet("LONG", 76468, 63474.96)).toBe("behind");
    expect(classifyCloudMagnet("LONG", 100, 102)).toBe("ahead");
    expect(classifyCloudMagnet("SHORT", 713.44, 727.84)).toBe("behind");
    expect(classifyCloudMagnet("SHORT", 730, 727.84)).toBe("ahead");
  });
});

describe("cloudDeskPlanCopy", () => {
  it("keeps a weekend desk pick as WAIT, not ENTER", () => {
    const copy = cloudDeskPlanCopy({
      ticker: "BTCUSD",
      role: "fire",
      direction: "LONG",
      px: 76468,
      magnet: { px: 63474.96, label: "1h_34_50" },
      session: "midday",
    });
    expect(copy.action).toBe("WAIT");
    expect(copy.ticketNow).toBe(false);
    expect(copy.magnetRelation).toBe("behind");
    expect(copy.coverLine).toContain("last cover, already behind");
    expect(copy.punch).toBe("WAIT on BTCUSD — regular session is closed.");
    expect(copy.scan).toContain("midday");
    expect(copy.punch).not.toMatch(/toward|ENTER|FIRE/);
    expect(copy.leader).toBe("");
  });

  it("keeps WAIT in RTH when the cover is already tagged", () => {
    const copy = cloudDeskPlanCopy({
      ticker: "BTCUSD",
      role: "fire",
      direction: "LONG",
      px: 76468,
      magnet: { px: 63474.96, label: "1h_34_50" },
    }, { marketOpen: true });
    expect(copy.action).toBe("WAIT");
    expect(copy.ticketNow).toBe(false);
    expect(copy.punch).toMatch(/cover already tagged|regular session/i);
  });

  it("writes BUY only when the desk pick can open in RTH", () => {
    const copy = cloudDeskPlanCopy({
      ticker: "NVDA",
      role: "fire",
      direction: "LONG",
      px: 100,
      magnet: { px: 102, label: "1h_34_50" },
    }, { marketOpen: true });
    expect(copy.action).toBe("BUY");
    expect(copy.ticketNow).toBe(true);
    expect(copy.magnetRelation).toBe("ahead");
    expect(copy.coverLine).toBe("$102.00 next cover (1H 34/50)");
    expect(copy.punch).toContain("cover still ahead");
    expect(copy.punch).not.toMatch(/toward|ENTER|0\.1/);
  });

  it("uses Monthly 21 EMA as next cover when the 1H magnet is behind", () => {
    const copy = cloudDeskPlanCopy({
      ticker: "ETHUSD",
      role: "fire",
      direction: "LONG",
      px: 2416.2,
      magnet: { px: 1885.13, label: "1h_34_50" },
    }, {
      ticker: {
        monthly_bundle: { ema21: 2518.87 },
        tf_tech: { M: { ema21: 2518.87 }, W: { ema: { ema21: 2098.78 } } },
        tp_trim: 2682.81,
        tp_exit: 2783.05,
      },
    });
    expect(copy.nextCover?.px).toBe(2518.87);
    expect(copy.nextCover?.label).toBe("Monthly 21 EMA");
    expect(copy.lastCover?.px).toBe(1885.13);
    expect(copy.coverLine).toBe("$2518.87 next cover (Monthly 21 EMA)");
    expect(copy.lastLine).toContain("last cover, already behind");
    expect(copy.punch).not.toMatch(/toward|ENTER/);
  });

  it("keeps STALK as WAIT and never names a lead", () => {
    const stalk = cloudDeskPlanCopy({
      ticker: "QQQ",
      role: "stalk",
      direction: "SHORT",
      px: 713.44,
      magnet: { px: 727.84 },
    });
    expect(stalk.action).toBe("WAIT");
    expect(stalk.punch).toBe("WAIT on QQQ — 10m Cloud Desk SHORT. Not the index options lean.");
    expect(stalk.magnetRelation).toBe("behind");
    const follow = cloudDeskPlanCopy({
      ticker: "COIN",
      role: "follow",
      direction: "LONG",
      px: 280,
      leader_follow: { leader: "BTCUSD" },
      magnet: { px: 290 },
    });
    expect(follow.action).toBe("WAIT");
    expect(follow.leader).toBe("");
    expect(follow.punch).not.toMatch(/BTCUSD|lead|toward/i);
    expect(follow.scan).toContain("WAIT");
    expect(cloudMagnetCoverLine({ px: 290 }, "ahead")).toBe("$290.00 next cover");
  });
});

describe("cloud pivot conviction (entry budget ranking)", () => {
  const det = (over = {}) => ({
    fires: true, direction: "LONG",
    clouds: { c34_50_10: "LONG", c34_50_1h: "LONG" },
    ...over,
  });
  it("both 34/50 clouds aligned is the baseline convicted setup (2)", () => {
    expect(cloudPivotConviction(det())).toBe(2);
  });
  it("leader and a magnet ahead add, but a generic catalyst does not", () => {
    expect(cloudPivotConviction(det({
      leader_follow: { leader: "NVDA", direction: "LONG" },
      session_plan: { catalyst: "cpi" },
      cloud_magnet: { ahead: true },
    }))).toBe(3.5);
  });
  it.each(["earnings", "cpi", "event_risk"])("%s is not directional confirmation", catalyst => {
    for (const direction of ["LONG", "SHORT"]) {
      const weak = det({ direction, clouds: { c34_50_10: null, c34_50_1h: direction } });
      expect(cloudPivotConviction(weak)).toBe(1);
      expect(cloudPivotConviction({ ...weak, session_plan: { catalyst } })).toBe(1);
    }
  });
  it("a soft-opposed cloud subtracts and drops below the floor", () => {
    expect(cloudPivotConviction(det({ clouds: { c34_50_10: "SHORT", c34_50_1h: "LONG" } }))).toBe(0);
    expect(cloudPivotConviction(det({ clouds: { c34_50_10: null, c34_50_1h: "LONG" } }))).toBe(1);
  });
  it("proposal carries conviction", () => {
    const prop = buildCloudPivotPaperQueueProposal(payload());
    if (prop) expect(typeof prop.conviction).toBe("number");
  });

  // The leaders (BTC / ETH / SPY / QQQ) are the only market-wide read this
  // detector has. It used to be bonus-only: agreement added a point and
  // disagreement was not recorded at all, so a curl straight into the tape
  // scored the same as one with it.
  it("an opposing leader subtracts, mirroring the ticker's own clouds", () => {
    expect(cloudPivotConviction(det({
      leader_oppose: { leader: "SPY", leader_direction: "SHORT", direction: "LONG" },
    }))).toBe(1);
  });

  it("scores a leader the same magnitude either way", () => {
    const withLeader = cloudPivotConviction(det({ leader_follow: { leader: "SPY", direction: "LONG" } }));
    const against = cloudPivotConviction(det({
      leader_oppose: { leader: "SPY", leader_direction: "SHORT", direction: "LONG" },
    }));
    const neither = cloudPivotConviction(det());
    expect(withLeader - neither).toBe(1);
    expect(neither - against).toBe(1);
  });
});

describe("leader disagreement is recorded, not discarded", () => {
  const curl = (dir) => ({
    ripster: {
      c5_12: dir === "LONG"
        ? { bull: true, inCloud: true, crossUp: true, crossDn: false, fastSlope: 0.3 }
        : { bear: true, inCloud: true, crossUp: false, crossDn: true, fastSlope: -0.3 },
      c34_50: dir === "LONG" ? { bull: true, above: true } : { bear: true, below: true },
    },
  });

  it("stamps _cloud_leader_oppose on a follower curling against its leader", () => {
    const rows = [
      { sym: "BTCUSD", t: { tf_tech: { "10": curl("LONG") } } },
      { sym: "COIN", t: { tf_tech: { "10": curl("SHORT") } } },
      { sym: "MSTR", t: { tf_tech: { "10": curl("LONG") } } },
    ];
    annotateCloudPivotLeaderFollows(rows);
    expect(rows[1].t._cloud_leader_oppose?.leader).toBe("BTCUSD");
    expect(rows[1].t._cloud_leader_oppose?.leader_direction).toBe("LONG");
    expect(rows[1].t._cloud_leader_follow).toBeUndefined();
    // The agreeing follower is unaffected.
    expect(rows[2].t._cloud_leader_follow?.leader).toBe("BTCUSD");
    expect(rows[2].t._cloud_leader_oppose).toBeUndefined();
  });

  it("carries the disagreement onto the detection and its reasons", () => {
    const afterMidday = Date.parse("2026-07-15T18:10:00Z");
    const p = payload({
      ts: afterMidday,
      price: 80,
      _cloud_leader_follow: { leader: "BTCUSD", direction: "LONG", trigger: "5_12_cross_up" },
      _cloud_leader_oppose: { leader: "SPY", leader_direction: "SHORT", direction: "LONG" },
    });
    const d = detectTtCloudPivot(p, {}, { asOfTs: afterMidday });
    expect(d?.fires).toBe(true);
    expect(d.leader_oppose?.leader).toBe("SPY");
    expect(d.reasons).toContain("leader_oppose_spy");
  });
});
