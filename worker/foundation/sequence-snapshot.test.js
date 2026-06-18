import { describe, expect, it } from "vitest";
import {
  buildSequenceTrailSnapshot,
  serializeSequenceTrailSnapshot,
  SEQUENCE_SNAPSHOT_VERSION,
} from "./sequence-snapshot.js";

describe("sequence trail snapshot", () => {
  it("retains td_sequential and tf_tech fields needed for event derivation", () => {
    const payload = {
      ticker: "SPY",
      ts: 1781784431476,
      price: 580.5,
      phase_pct: 72,
      td_sequential: {
        per_tf: {
          D: { bullish_prep_count: 8, td9_bearish: true },
        },
      },
      tf_tech: {
        D: {
          rsi: { r5: 74 },
          saty: { v: 65, l: { distrib: true } },
          ema: { ema21: 575, ema200: 560, priceAboveEma21: true },
          stDir: 1,
          stSlope: 0.02,
          pdz: { zone: "premium_approach" },
        },
      },
      flags: { st_flip: false },
    };
    const snap = buildSequenceTrailSnapshot(payload);
    expect(snap._sequence_snapshot_v).toBe(SEQUENCE_SNAPSHOT_VERSION);
    expect(snap.td_sequential.per_tf.D.td9_bearish).toBe(true);
    expect(snap.tf_tech.D.rsi.r5).toBe(74);
    expect(snap.tf_tech.D.ema.ema21).toBe(575);
  });

  it("serializes when SETUP_EVENTS_WRITE is enabled", () => {
    const json = serializeSequenceTrailSnapshot({ ticker: "SPY", ts: 1, price: 1, tf_tech: { D: { rsi: { r5: 50 } } } }, { SETUP_EVENTS_WRITE: "1" });
    expect(json).toBeTruthy();
    expect(JSON.parse(json).ticker).toBe("SPY");
  });

  it("serializes with force even when env gate is off", () => {
    const json = serializeSequenceTrailSnapshot(
      { ticker: "SPY", ts: 1, price: 1, tf_tech: { D: { rsi: { r5: 50 } } } },
      {},
      32768,
      { force: true },
    );
    expect(json).toBeTruthy();
    expect(JSON.parse(json)._snapshot_kind).toBe("sequence_trail");
  });
});
