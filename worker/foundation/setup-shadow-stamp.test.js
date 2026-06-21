import { describe, expect, it } from "vitest";
import { mockSetupEvent } from "./setup-events.js";
import {
  applySetupShadowFields,
  compactSequenceForPayload,
  deriveSetupShadowFromEvents,
  setupShadowStampEnabled,
} from "./setup-shadow-stamp.js";

describe("setup shadow stamp", () => {
  it("defaults stamp on when setup events write is enabled", () => {
    expect(setupShadowStampEnabled({ SETUP_EVENTS_WRITE: "1" })).toBe(true);
    expect(setupShadowStampEnabled({ SETUP_SHADOW_STAMP: "0", SETUP_EVENTS_WRITE: "1" })).toBe(false);
  });

  it("derives compact sequences from event ledger rows", () => {
    const events = [
      mockSetupEvent({ event_type: "td9_bearish", direction: "SHORT", event_ts: 1000 }),
      mockSetupEvent({ event_type: "pdz_premium_touch", direction: "SHORT", event_ts: 2000 }),
      mockSetupEvent({ event_type: "ema21_reject", direction: "SHORT", event_ts: 3000 }),
    ];
    const fields = deriveSetupShadowFromEvents(events, { ticker: "SPY", ts: 4000 }, { ticker: "SPY" });
    expect(fields?.setup_shadow).toBe(true);
    expect(Array.isArray(fields?.setup_sequences)).toBe(true);
    expect(fields?.setup_shadow_posture?.posture).toBeTruthy();
  });

  it("applies shadow fields onto payload without dropping existing keys", () => {
    const payload = { ticker: "SPY", price: 500, rank: 90 };
    const stamped = applySetupShadowFields(payload, {
      setup_shadow: true,
      setup_sequences: [compactSequenceForPayload({ sequence_type: "td_phase_mean_reversion_short", direction: "SHORT", stage: 3 })],
      setup_shadow_posture: { posture: "Short Mean Reversion", direction: "SHORT", stage: 3 },
      setup_shadow_event_count: 12,
      setup_shadow_as_of_ts: 123,
    });
    expect(stamped.rank).toBe(90);
    expect(stamped.setup_sequences).toHaveLength(1);
  });
});
