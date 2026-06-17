import { describe, expect, it } from "vitest";
import {
  createSetupEvent,
  filterSetupEvents,
  latestSetupEvent,
  mockSetupEvent,
  normalizeDirection,
  normalizeSetupEvents,
  setupEventId,
  validateSetupEvent,
} from "./setup-events.js";

describe("setup-events shadow contract", () => {
  it("normalizes trader vocabulary to sequence directions", () => {
    expect(normalizeDirection("bullish")).toBe("LONG");
    expect(normalizeDirection("bear")).toBe("SHORT");
    expect(normalizeDirection("neutral")).toBe("NEUTRAL");
    expect(normalizeDirection("nonsense")).toBeNull();
  });

  it("creates deterministic setup event ids", () => {
    const input = { ticker: "uso", tf: "D", event_type: "td9_complete", direction: "bull", event_ts: 123 };
    expect(setupEventId(input)).toBe("USO:D:td9_complete:LONG:123");
    expect(createSetupEvent(input)).toMatchObject({
      event_id: "USO:D:td9_complete:LONG:123",
      ticker: "USO",
      tf: "D",
      event_type: "td9_complete",
      direction: "LONG",
      event_ts: 123,
      source: "mock",
    });
  });

  it("validates known event types and rejects unknown types", () => {
    expect(validateSetupEvent(mockSetupEvent({ event_type: "phase_left_accumulation" })).ok).toBe(true);
    const bad = createSetupEvent({ ticker: "AAPL", tf: "D", event_ts: 1, event_type: "made_up", direction: "LONG" });
    const validation = validateSetupEvent(bad);
    expect(validation.ok).toBe(false);
    expect(validation.errors).toContain("unknown event_type:made_up");
  });

  it("normalizes, sorts, and dedupes event arrays", () => {
    const a = mockSetupEvent({ ticker: "AAPL", event_ts: 2, event_type: "td9_complete" });
    const b = mockSetupEvent({ ticker: "AAPL", event_ts: 1, event_type: "td_setup_progress" });
    const result = normalizeSetupEvents([a, b, a]);
    expect(result.ok).toBe(true);
    expect(result.events.map((ev) => ev.event_type)).toEqual(["td_setup_progress", "td9_complete"]);
  });

  it("filters and returns latest matching events", () => {
    const events = normalizeSetupEvents([
      mockSetupEvent({ ticker: "USO", event_ts: 1, event_type: "td_setup_progress", direction: "LONG" }),
      mockSetupEvent({ ticker: "USO", event_ts: 2, event_type: "td9_complete", direction: "LONG" }),
      mockSetupEvent({ ticker: "USO", event_ts: 3, event_type: "td9_complete", direction: "SHORT" }),
    ]).events;
    expect(filterSetupEvents(events, { ticker: "USO", direction: "LONG" })).toHaveLength(2);
    expect(latestSetupEvent(events, { eventTypes: ["td9_complete"] }).direction).toBe("SHORT");
    expect(latestSetupEvent(events, { direction: "LONG", eventTypes: ["td9_complete"] }).event_ts).toBe(2);
  });
});
