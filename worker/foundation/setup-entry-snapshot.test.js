import { describe, expect, it } from "vitest";
import {
  deriveLegacyEntryDiagnostics,
  inferStaticEventsFromSnapshot,
  inferStaticStageFromEvents,
  parseRankTraceJson,
  snapshotFromRankTrace,
} from "./setup-entry-snapshot.js";
import {
  eventsFromSnapshotPair,
  setupEventToDbBind,
  setupEventsWriteEnabled,
} from "./setup-events-store.js";
import { mockSetupEvent } from "./setup-events.js";

describe("setup entry snapshot (Tier 1 legacy)", () => {
  it("builds snapshot from rank_trace setup_snapshot", () => {
    const rt = {
      ts: 2000,
      state: "HTF_BULL_LTF_PULLBACK",
      setup_snapshot: {
        state: "HTF_BULL_LTF_PULLBACK",
        td_seq: { D: { bull_prep: 8, td9_bull: true } },
        pdz: { D: "discount" },
        rsi: { D: 28 },
      },
    };
    const snap = snapshotFromRankTrace(rt, { ticker: "USO", entry_ts: 2000 });
    expect(snap.ticker).toBe("USO");
    expect(snap.td_sequential.per_tf.D.bullish_prep_count).toBe(8);
    expect(snap._analysis_mode).toBe("legacy_entry_snapshot");
  });

  it("infers static LONG events from entry snapshot", () => {
    const snap = snapshotFromRankTrace({
      ts: 2000,
      setup_snapshot: {
        td_seq: { D: { bull_prep: 8, td9_bull: true } },
        pdz: { D: "discount_approach" },
        rsi: { D: 25 },
      },
    }, { ticker: "USO", entry_ts: 2000 });
    const events = inferStaticEventsFromSnapshot(snap, "LONG");
    const types = new Set(events.map((e) => e.event_type));
    expect(types.has("td_setup_progress")).toBe(true);
    expect(types.has("td9_complete")).toBe(true);
    expect(types.has("pdz_discount_entered")).toBe(true);
    expect(types.has("rsi_extreme_entered")).toBe(true);
  });

  it("derives legacy entry diagnostics with static stage", () => {
    const trade = {
      ticker: "USO",
      direction: "LONG",
      entry_ts: 2000,
      status: "WIN",
      pnl_pct: 1.2,
      rank_trace_json: JSON.stringify({
        ts: 2000,
        setup_snapshot: {
          td_seq: { D: { bull_prep: 8, td9_bull: true } },
          pdz: { D: "discount" },
        },
      }),
    };
    const diag = deriveLegacyEntryDiagnostics(trade);
    expect(diag.ok).toBe(true);
    expect(diag.promotion_safe).toBe(false);
    expect(diag.event_count).toBeGreaterThan(0);
    expect(diag.static_stage.stage).toBeGreaterThanOrEqual(2);
  });

  it("parseRankTraceJson accepts object or string", () => {
    expect(parseRankTraceJson({ ts: 1 }).ts).toBe(1);
    expect(parseRankTraceJson(JSON.stringify({ ts: 2 })).ts).toBe(2);
  });
});

describe("setup events store (Tier 2B)", () => {
  it("respects SETUP_EVENTS_WRITE gate", () => {
    expect(setupEventsWriteEnabled({ SETUP_EVENTS_WRITE: "1" })).toBe(true);
    expect(setupEventsWriteEnabled({ SETUP_EVENTS_WRITE: "0" })).toBe(false);
    expect(setupEventsWriteEnabled({})).toBe(false);
  });

  it("derives events from snapshot pair", () => {
    const prev = {
      ticker: "SPY",
      ts: 1000,
      td_sequential: { per_tf: { D: { bullish_prep_count: 6 } } },
      tf_tech: { D: { pdz: { zone: "premium" }, rsi: { r5: 55 } } },
    };
    const cur = {
      ticker: "SPY",
      ts: 2000,
      td_sequential: { per_tf: { D: { bullish_prep_count: 7 } } },
      tf_tech: { D: { pdz: { zone: "discount" }, rsi: { r5: 28 } } },
    };
    const events = eventsFromSnapshotPair(prev, cur, { source: "test" });
    expect(events.length).toBeGreaterThan(0);
  });

  it("serializes event to D1 bind tuple", () => {
    const ev = mockSetupEvent({ ticker: "SPY", event_ts: 123 });
    const bind = setupEventToDbBind(ev);
    expect(bind[0]).toBe(ev.event_id);
    expect(bind[1]).toBe("SPY");
  });
});

describe("static stage inference", () => {
  it("maps LONG static events to stage bucket", () => {
    const events = [
      mockSetupEvent({ event_type: "td_setup_progress", direction: "LONG", event_ts: 1 }),
      mockSetupEvent({ event_type: "td9_complete", direction: "LONG", event_ts: 2 }),
      mockSetupEvent({ event_type: "pdz_discount_entered", direction: "LONG", event_ts: 3 }),
    ];
    const stage = inferStaticStageFromEvents(events, "LONG");
    expect(stage.stage).toBe(3);
    expect(stage.promotion_safe).toBe(false);
  });
});
