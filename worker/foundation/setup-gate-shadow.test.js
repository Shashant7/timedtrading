import { describe, expect, it } from "vitest";
import { mockSetupEvent } from "./setup-events.js";
import {
  deriveSetupGateShadowFromEvents,
  inferDirectionFromPayload,
  setupGateShadowEnabled,
} from "./setup-gate-shadow.js";

describe("setup gate shadow", () => {
  it("requires explicit SETUP_GATE_SHADOW", () => {
    expect(setupGateShadowEnabled({ SETUP_EVENTS_WRITE: "1" })).toBe(false);
    expect(setupGateShadowEnabled({ SETUP_GATE_SHADOW: "1" })).toBe(true);
    expect(setupGateShadowEnabled({ SETUP_GATE_SHADOW: "0" })).toBe(false);
  });

  it("evaluates stack_full_confirm and gate_runway_full from events", () => {
    const now = 10_000_000;
    const events = [
      mockSetupEvent({ event_type: "rsi_divergence_confirmed", direction: "LONG", event_ts: now - 5000 }),
      mockSetupEvent({ event_type: "td9_complete", direction: "LONG", event_ts: now - 4000 }),
      mockSetupEvent({ event_type: "supertrend_flip", direction: "LONG", event_ts: now - 3000 }),
      mockSetupEvent({ event_type: "squeeze_release", direction: "LONG", event_ts: now - 2000 }),
      mockSetupEvent({ event_type: "ema21_reclaim", direction: "LONG", event_ts: now - 1000 }),
    ];
    const fields = deriveSetupGateShadowFromEvents(events, { ticker: "SPY", ts: now, trigger_dir: "LONG" });
    expect(fields.setup_gate_shadow).toBe(true);
    expect(fields.setup_gates.stack_full_confirm.fires).toBe(true);
    expect(fields.setup_gates.gate_runway_full.fires).toBe(true);
    expect(fields.setup_gate_lookback_hours).toBe(120);
  });

  it("infers direction from trigger_dir", () => {
    expect(inferDirectionFromPayload({ trigger_dir: "SHORT" })).toBe("SHORT");
    expect(inferDirectionFromPayload({ state: "BULL" })).toBe("LONG");
  });
});
