import { describe, it, expect } from "vitest";
import {
  detectTtCloudPivot,
  buildCloudPivotPaperQueueProposal,
  stampTtCloudPivotThinSlice,
  cloudPivotPaperSizeMult,
  evaluateTtCloudPivotExit,
  resolveCloudPivotSession,
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
});
